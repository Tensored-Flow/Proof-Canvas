import { TextDecoder } from "node:util";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ProofCanvasAuthError } from "./auth.server";
import { ProjectRepositoryError } from "./repository.server";
import { AssetContentError } from "./assetContent.server";
import { ProjectPackageError } from "./projectPackage";

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

export const ASSET_FILENAME_HEADER = "x-proofcanvas-asset-filename";
export const EXPECTED_REVISION_HEADER = "x-proofcanvas-expected-revision";
export const MUTATION_ID_HEADER = "x-proofcanvas-mutation-id";
export const PACKAGE_MUTATION_ID_HEADER = MUTATION_ID_HEADER;

export class ProofCanvasHttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ProofCanvasHttpError";
  }
}

export function jsonNoStore(body: object, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function declaredBodyTooLarge(request: Request, maximumBytes: number): boolean {
  const header = request.headers.get("content-length");
  if (header === null) return false;
  const length = Number(header);
  return !Number.isSafeInteger(length) || length < 0 || length > maximumBytes;
}

export async function readJsonRequest(request: Request, maximumBytes: number): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") throw new ProofCanvasHttpError(415, "invalid_request", "Content-Type must be application/json");
  if (declaredBodyTooLarge(request, maximumBytes)) throw new ProofCanvasHttpError(413, "request_too_large", "Request body is too large");
  if (!request.body) throw new ProofCanvasHttpError(400, "invalid_request", "Request body must contain JSON");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProofCanvasHttpError(413, "request_too_large", "Request body is too large");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    if (error instanceof ProofCanvasHttpError) throw error;
    throw new ProofCanvasHttpError(400, "invalid_request", "Request body could not be read as UTF-8");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(chunks.join(""));
  } catch {
    throw new ProofCanvasHttpError(400, "invalid_request", "Request body must contain valid JSON");
  }
}

export async function readBinaryRequest(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const header = request.headers.get("content-length");
  if (header === null) throw new ProofCanvasHttpError(411, "content_length_required", "Content-Length is required for asset uploads");
  if (!/^(?:0|[1-9][0-9]*)$/.test(header)) throw new ProofCanvasHttpError(400, "invalid_request", "Content-Length must be a canonical non-negative integer");
  const declaredLength = Number(header);
  if (!Number.isSafeInteger(declaredLength)) throw new ProofCanvasHttpError(400, "invalid_request", "Content-Length is outside the supported range");
  if (declaredLength <= 0) throw new ProofCanvasHttpError(400, "invalid_request", "Asset upload must contain at least one byte");
  if (declaredLength > maximumBytes) throw new ProofCanvasHttpError(413, "request_too_large", "Request body is too large");
  if (!request.body) throw new ProofCanvasHttpError(400, "invalid_request", "Asset upload body is missing");
  const target = new Uint8Array(declaredLength);
  const reader = request.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > declaredLength - offset) {
        await reader.cancel().catch(() => undefined);
        throw new ProofCanvasHttpError(400, "content_length_mismatch", "Asset upload bytes do not match Content-Length");
      }
      target.set(value, offset);
      offset += value.byteLength;
    }
  } catch (error) {
    if (error instanceof ProofCanvasHttpError) throw error;
    throw new ProofCanvasHttpError(400, "invalid_request", "Asset upload body could not be read");
  } finally {
    reader.releaseLock();
  }
  if (offset !== declaredLength) throw new ProofCanvasHttpError(400, "content_length_mismatch", "Asset upload bytes do not match Content-Length");
  return target;
}

const assetUploadAdmissionKey = Symbol.for("proofcanvas.http.asset-upload-admission");
type GlobalWithAssetUploadAdmission = typeof globalThis & { [assetUploadAdmissionKey]?: { active: number } };

function acquireAssetByteAdmission(code: "upload_busy" | "package_busy", message: string): () => void {
  const globals = globalThis as GlobalWithAssetUploadAdmission;
  const state = globals[assetUploadAdmissionKey] ?? { active: 0 };
  globals[assetUploadAdmissionKey] = state;
  if (state.active >= 1) throw new ProofCanvasHttpError(429, code, message);
  state.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
  };
}

export function acquireAssetUploadAdmission(): () => void {
  return acquireAssetByteAdmission("upload_busy", "Another asset upload or package import is being validated; retry shortly");
}

export function acquireProjectPackageAdmission(): () => void {
  return acquireAssetByteAdmission("package_busy", "Another asset upload or package import is being validated; retry shortly");
}

export function routeFailure(error: unknown): NextResponse {
  if (error instanceof ProofCanvasAuthError) {
    const headers = error.code === "rate_limited"
      ? { ...NO_STORE_HEADERS, "Retry-After": String(error.retryAfterSeconds ?? 900) }
      : NO_STORE_HEADERS;
    return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status: error.status, headers });
  }
  if (error instanceof ProjectRepositoryError) {
    const message = error.status >= 500 ? "ProofCanvas durable storage could not complete the request" : error.message;
    return NextResponse.json({
      ok: false,
      code: error.code,
      message,
      ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
    }, { status: error.status, headers: NO_STORE_HEADERS });
  }
  if (error instanceof AssetContentError) {
    const status = error.code === "item_too_large" || error.code === "aggregate_too_large"
      ? 413
      : error.code === "unsupported_type" || error.code === "mime_mismatch"
        ? 415
        : 400;
    return jsonNoStore({ ok: false, code: error.code, message: error.message }, status);
  }
  if (error instanceof ProjectPackageError) {
    const status = ["aggregate_too_large", "allocation_failed", "archive_too_large", "entry_too_large"]
      .includes(error.code) ? 413 : 400;
    return jsonNoStore({ ok: false, code: error.code, message: error.message }, status);
  }
  if (error instanceof ProofCanvasHttpError) {
    return jsonNoStore({ ok: false, code: error.code, message: error.message }, error.status);
  }
  if (error instanceof z.ZodError) {
    return jsonNoStore({ ok: false, code: "invalid_request", message: "Request body does not match the expected schema" }, 400);
  }
  return jsonNoStore({ ok: false, code: "internal_error", message: "ProofCanvas could not complete the request" }, 500);
}
