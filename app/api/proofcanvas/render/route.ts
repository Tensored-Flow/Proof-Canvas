import { NextResponse } from "next/server";
import { authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import { routeFailure } from "@/lib/proofcanvas/http.server";
import {
  RenderClientError,
  readBoundedJson,
  submitRender,
  type RenderQuality,
} from "@/lib/proofcanvas/renderClient.server";
import { ProjectRepositoryError, projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const RESPONSE_HEADERS = { "Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };

function json(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

function failure(error: unknown) {
  if (error instanceof RenderClientError) {
    return json({ ok: false, code: error.code, message: error.message }, error.status);
  }
  if (error instanceof ProjectRepositoryError) return routeFailure(error);
  return json({ ok: false, code: "renderer_error", message: "ProofCanvas rendering could not complete the request." }, 500);
}

function rendererConfigured(): boolean {
  const rawUrl = process.env.PROOFCANVAS_RENDER_URL;
  const token = process.env.PROOFCANVAS_RENDER_TOKEN;
  if (!rawUrl || !token || token.length < 32 || token.length > 256) return false;
  try {
    const url = new URL(rawUrl);
    return /^https?:$/.test(url.protocol)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname === "/";
  } catch {
    return false;
  }
}

function parseEnvelope(candidate: unknown): { projectId: string; revision: number; shotId?: string; quality: RenderQuality } {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new RenderClientError(400, "invalid_request", "Request body does not match the ProofCanvas render schema.");
  }
  const body = candidate as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.some((key) => !["projectId", "quality", "revision", "shotId"].includes(key)) || !keys.includes("projectId") || !keys.includes("revision") || !keys.includes("quality")) {
    throw new RenderClientError(400, "invalid_request", "Request body does not match the ProofCanvas render schema.");
  }
  if (body.quality !== "preview" && body.quality !== "production") {
    throw new RenderClientError(400, "invalid_request", "Request body does not match the ProofCanvas render schema.");
  }
  if (typeof body.projectId !== "string" || !/^project-[a-f0-9]{24}$/.test(body.projectId)) {
    throw new RenderClientError(400, "invalid_request", "Request body does not match the ProofCanvas render schema.");
  }
  if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) {
    throw new RenderClientError(400, "invalid_request", "Request body does not match the ProofCanvas render schema.");
  }
  if (body.shotId !== undefined && (typeof body.shotId !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,95}$/.test(body.shotId))) {
    throw new RenderClientError(400, "invalid_request", "Request body does not match the ProofCanvas render schema.");
  }
  return { projectId: body.projectId, revision: body.revision as number, quality: body.quality, ...(body.shotId ? { shotId: body.shotId } : {}) };
}

export async function POST(request: Request) {
  try {
    // Authentication must precede renderer configuration and body work.
    authorizeStateChangingRequest(request);
  } catch (error) {
    return routeFailure(error);
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return json({ ok: false, code: "invalid_request", message: "Content-Type must be application/json." }, 415);
  }
  // Match the server client configuration gate before reading or validating a
  // potentially expensive public request body.
  if (!rendererConfigured()) {
    return json({ ok: false, code: "render_unavailable", message: "ProofCanvas rendering is not configured." }, 503);
  }
  try {
    const envelope = parseEnvelope(await readBoundedJson(request));
    const durable = projectRepository().getProject(envelope.projectId);
    if (durable.revision !== envelope.revision) {
      throw new ProjectRepositoryError(409, "revision_conflict", "Project changed since this revision was loaded", durable.revision);
    }
    const job = await submitRender({ project: durable.document, quality: envelope.quality, ...(envelope.shotId ? { shotId: envelope.shotId } : {}) });
    return json({ ok: true, projectId: durable.id, revision: durable.revision, job }, 202);
  } catch (error) {
    return failure(error);
  }
}
