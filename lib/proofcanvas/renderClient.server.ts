import "server-only";

import { createHash } from "node:crypto";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { TextDecoder, TextEncoder } from "node:util";
import { compileManim, estimateManimTimelineDurationUpperBound } from "./compiler";
import { compareTimelineTimes } from "./frame";
import { PROOFCANVAS_PROJECT_MAX_BYTES, PROOFCANVAS_RENDER_SOURCE_MAX_BYTES, ProjectDocumentSchema, projectDurationSeconds, type ProjectDocument } from "./schema";

export type RenderQuality = "preview" | "production";
export type RenderJobStatus = "pending" | "running" | "succeeded" | "failed";

export interface RenderJob {
  id: string;
  quality: RenderQuality;
  sourceSha256: string;
  status: RenderJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: { code: string; message: string } | null;
  video: { sha256: string; bytes: number } | null;
}

export interface SubmitRenderRequest {
  project: ProjectDocument;
  shotId?: string;
  quality: RenderQuality;
}

export interface RenderVideo {
  body: ReadableStream<Uint8Array>;
  bytes: number;
  sourceSha256: string;
  videoSha256: string;
}

const MAX_PUBLIC_BODY_BYTES = PROOFCANVAS_PROJECT_MAX_BYTES;
const MAX_UPSTREAM_JSON_BYTES = 64 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
// Leave a ten-second envelope below the sidecar's 310-second decoded-output
// cap for frame-rate quantization across generated animation components.
export const MAX_SELECTED_RENDER_DURATION_SECONDS = 300;
export const UPSTREAM_JSON_TIMEOUT_MS = 12_000;
export const UPSTREAM_VIDEO_TIMEOUT_MS = 60_000;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

export class RenderClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RenderClientError";
  }
}

export function renderSourceBytes(source: string): Uint8Array {
  const sourceBytes = new TextEncoder().encode(source);
  if (sourceBytes.byteLength > PROOFCANVAS_RENDER_SOURCE_MAX_BYTES) {
    throw new RenderClientError(413, "source_too_large", "Generated source exceeds the renderer limit.");
  }
  return sourceBytes;
}

function configuration(): { origin: string; token: string } {
  const rawUrl = process.env.PROOFCANVAS_RENDER_URL;
  const token = process.env.PROOFCANVAS_RENDER_TOKEN;
  if (!rawUrl || !token || token.length < 32 || token.length > 256) {
    throw new RenderClientError(503, "render_unavailable", "ProofCanvas rendering is not configured.");
  }
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("unsafe renderer URL");
    }
    return { origin: url.origin, token };
  } catch {
    throw new RenderClientError(503, "render_unavailable", "ProofCanvas rendering is not configured.");
  }
}

function jobId(value: string): string {
  if (!JOB_ID_PATTERN.test(value)) {
    throw new RenderClientError(404, "job_not_found", "Render job was not found.");
  }
  return value;
}

type RendererFetch = {
  response: Response;
  release: () => void;
  abort: () => void;
};

async function fetchRenderer(path: string, init: RequestInit, timeoutMs = UPSTREAM_JSON_TIMEOUT_MS): Promise<RendererFetch> {
  const { origin, token } = configuration();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timeout);
  };
  try {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
    return {
      response,
      release,
      abort: () => {
        controller.abort();
        release();
      },
    };
  } catch {
    release();
    throw new RenderClientError(502, "renderer_error", "The isolated renderer could not be reached.");
  }
}

async function boundedResponseText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new RenderClientError(502, "renderer_error", "The isolated renderer returned an invalid response.");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RenderClientError(502, "renderer_error", "The isolated renderer returned an invalid response.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function boundedRendererStream(request: RendererFetch, expectedBytes: number): ReadableStream<Uint8Array> {
  const source = request.response.body;
  if (!source) throw upstreamError(502);
  const reader = source.getReader();
  let received = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    reader.releaseLock();
    request.release();
  };
  const fail = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    try { await reader.cancel(); } catch { /* the upstream is already unusable */ }
    request.abort();
    finish();
    controller.error(upstreamError(502));
  };
  return new NodeReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (received !== expectedBytes) return fail(controller);
          finish();
          controller.close();
          return;
        }
        received += value.byteLength;
        if (received > expectedBytes || received > MAX_VIDEO_BYTES) return fail(controller);
        controller.enqueue(value);
      } catch {
        await fail(controller);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally {
        request.abort();
        finish();
      }
    },
  }) as unknown as ReadableStream<Uint8Array>;
}

function upstreamError(status: number): RenderClientError {
  if (status === 404) return new RenderClientError(404, "job_not_found", "Render job was not found.");
  if (status === 409) return new RenderClientError(409, "video_unavailable", "Render video is not available yet.");
  if (status === 422) return new RenderClientError(422, "source_rejected", "Generated source failed the renderer policy.");
  if (status === 429) return new RenderClientError(429, "queue_full", "The renderer already has one running and one queued job.");
  if (status === 401 || status === 503) return new RenderClientError(503, "render_unavailable", "ProofCanvas rendering is not configured.");
  return new RenderClientError(502, "renderer_error", "The isolated renderer returned an invalid response.");
}

function parseJob(candidate: unknown): RenderJob {
  if (!candidate || typeof candidate !== "object") throw upstreamError(502);
  const job = candidate as Partial<RenderJob>;
  const nullableFinite = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));
  const validError = job.error === null || (
    !!job.error && typeof job.error === "object"
    && typeof job.error.code === "string" && job.error.code.length <= 80
    && typeof job.error.message === "string" && job.error.message.length <= 240
  );
  const validVideo = job.video === null || (
    !!job.video && typeof job.video === "object"
    && typeof job.video.sha256 === "string" && SHA_PATTERN.test(job.video.sha256)
    && Number.isSafeInteger(job.video.bytes) && job.video.bytes >= 32 && job.video.bytes <= MAX_VIDEO_BYTES
  );
  const pendingShape = job.status === "pending" && job.startedAt === null && job.completedAt === null && job.error === null && job.video === null;
  const runningShape = job.status === "running" && typeof job.startedAt === "number" && job.completedAt === null && job.error === null && job.video === null;
  const succeededShape = job.status === "succeeded" && typeof job.startedAt === "number" && typeof job.completedAt === "number" && job.error === null && job.video !== null;
  const failedShape = job.status === "failed" && typeof job.startedAt === "number" && typeof job.completedAt === "number" && job.error !== null && job.video === null;
  if (
    typeof job.id !== "string" || !JOB_ID_PATTERN.test(job.id)
    || !["preview", "production"].includes(String(job.quality))
    || typeof job.sourceSha256 !== "string" || !SHA_PATTERN.test(job.sourceSha256)
    || !["pending", "running", "succeeded", "failed"].includes(String(job.status))
    || typeof job.createdAt !== "number" || !Number.isFinite(job.createdAt)
    || typeof job.updatedAt !== "number" || !Number.isFinite(job.updatedAt)
    || !nullableFinite(job.startedAt) || !nullableFinite(job.completedAt)
    || !validError || !validVideo
    || !(pendingShape || runningShape || succeededShape || failedShape)
  ) {
    throw upstreamError(502);
  }
  return job as RenderJob;
}

async function responseJob(response: Response): Promise<RenderJob> {
  if (!response.ok) {
    await boundedResponseText(response, MAX_UPSTREAM_JSON_BYTES).catch(() => "");
    throw upstreamError(response.status);
  }
  try {
    const payload = JSON.parse(await boundedResponseText(response, MAX_UPSTREAM_JSON_BYTES)) as { ok?: unknown; job?: unknown };
    if (payload.ok !== true) throw upstreamError(502);
    return parseJob(payload.job);
  } catch (error) {
    if (error instanceof RenderClientError) throw error;
    throw upstreamError(502);
  }
}

export async function readBoundedJson(request: Request, limit = MAX_PUBLIC_BODY_BYTES): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
      throw new RenderClientError(413, "invalid_request", "Request body exceeds the ProofCanvas render limit.");
    }
  }
  let raw: string;
  try {
    raw = await boundedResponseText(request as unknown as Response, limit);
  } catch (error) {
    if (error instanceof RenderClientError && error.status === 502) {
      throw new RenderClientError(413, "invalid_request", "Request body exceeds the ProofCanvas render limit.");
    }
    if (error instanceof RenderClientError) throw error;
    throw new RenderClientError(400, "invalid_request", "Request body could not be read.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new RenderClientError(400, "invalid_request", "Request body must contain valid JSON.");
  }
}

export async function submitRender(input: SubmitRenderRequest): Promise<RenderJob> {
  let project: ProjectDocument;
  try {
    project = ProjectDocumentSchema.parse(input.project);
  } catch {
    throw new RenderClientError(400, "invalid_request", "Request project does not match the ProofCanvas schema.");
  }
  if (input.quality !== "preview" && input.quality !== "production") {
    throw new RenderClientError(400, "invalid_request", "Render quality is invalid.");
  }
  let compileProject = project;
  if (input.shotId !== undefined) {
    const shot = project.shots.find(({ id }) => id === input.shotId);
    if (!shot) throw new RenderClientError(400, "invalid_request", "Requested shot does not exist.");
    compileProject = ProjectDocumentSchema.parse({ ...project, shots: [shot] });
  }
  const selectedDuration = projectDurationSeconds(compileProject);
  const frameRate = input.quality === "preview" ? 15 : 30;
  const estimatedVideoDuration = estimateManimTimelineDurationUpperBound(compileProject, frameRate);
  if (
    compareTimelineTimes(selectedDuration, MAX_SELECTED_RENDER_DURATION_SECONDS) > 0
    || estimatedVideoDuration > MAX_SELECTED_RENDER_DURATION_SECONDS
  ) {
    throw new RenderClientError(
      422,
      "render_duration_exceeded",
      `Selected timeline exceeds the ${MAX_SELECTED_RENDER_DURATION_SECONDS}-second render limit.`,
    );
  }
  const compiled = compileManim(compileProject);
  if (compiled.diagnostics.some(({ severity }) => severity === "error")) {
    throw new RenderClientError(422, "compile_rejected", "Project could not be compiled for Manim.");
  }
  const sourceBytes = renderSourceBytes(compiled.python);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const request = await fetchRenderer("/v1/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: compiled.python, sourceSha256, quality: input.quality }),
  });
  let job: RenderJob;
  try {
    job = await responseJob(request.response);
  } finally {
    request.release();
  }
  if (job.sourceSha256 !== sourceSha256 || job.quality !== input.quality) throw upstreamError(502);
  return job;
}

export async function getRenderJob(id: string): Promise<RenderJob> {
  const request = await fetchRenderer(`/v1/render/${jobId(id)}`, { method: "GET" });
  try {
    return await responseJob(request.response);
  } finally {
    request.release();
  }
}

export async function fetchRenderVideo(id: string): Promise<RenderVideo> {
  const request = await fetchRenderer(`/v1/render/${jobId(id)}/video`, {
    method: "GET",
    headers: { Accept: "video/mp4" },
  }, UPSTREAM_VIDEO_TIMEOUT_MS);
  const response = request.response;
  if (!response.ok) {
    try {
      await boundedResponseText(response, MAX_UPSTREAM_JSON_BYTES).catch(() => "");
      throw upstreamError(response.status);
    } finally {
      request.release();
    }
  }
  const bytes = Number(response.headers.get("content-length"));
  const sourceSha256 = response.headers.get("x-proofcanvas-source-sha256") ?? "";
  const videoSha256 = response.headers.get("x-proofcanvas-video-sha256") ?? "";
  if (
    !response.body
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "video/mp4"
    || !Number.isSafeInteger(bytes) || bytes < 32 || bytes > MAX_VIDEO_BYTES
    || !SHA_PATTERN.test(sourceSha256) || !SHA_PATTERN.test(videoSha256)
  ) {
    await response.body?.cancel().catch(() => undefined);
    request.abort();
    throw upstreamError(502);
  }
  return { body: boundedRendererStream(request, bytes), bytes, sourceSha256, videoSha256 };
}
