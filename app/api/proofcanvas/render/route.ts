import { NextResponse } from "next/server";
import {
  RenderClientError,
  readBoundedJson,
  submitRender,
  type RenderQuality,
} from "@/lib/proofcanvas/renderClient.server";
import type { ProjectDocument } from "@/lib/proofcanvas/schema";

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

function parseEnvelope(candidate: unknown): { project: ProjectDocument; shotId?: string; quality: RenderQuality } {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new RenderClientError(400, "invalid_request", "Request body does not match the ProofCanvas render schema.");
  }
  const body = candidate as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.some((key) => !["project", "quality", "shotId"].includes(key)) || !keys.includes("project") || !keys.includes("quality")) {
    throw new RenderClientError(400, "invalid_request", "Request body does not match the ProofCanvas render schema.");
  }
  if (body.quality !== "preview" && body.quality !== "production") {
    throw new RenderClientError(400, "invalid_request", "Request body does not match the ProofCanvas render schema.");
  }
  if (body.shotId !== undefined && (typeof body.shotId !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,95}$/.test(body.shotId))) {
    throw new RenderClientError(400, "invalid_request", "Request body does not match the ProofCanvas render schema.");
  }
  return { project: body.project as ProjectDocument, quality: body.quality, ...(body.shotId ? { shotId: body.shotId } : {}) };
}

export async function POST(request: Request) {
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
    const job = await submitRender(parseEnvelope(await readBoundedJson(request)));
    return json({ ok: true, job }, 202);
  } catch (error) {
    return failure(error);
  }
}
