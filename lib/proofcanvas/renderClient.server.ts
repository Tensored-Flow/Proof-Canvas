import "server-only";

import { createHash } from "node:crypto";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { TextDecoder, TextEncoder } from "node:util";
import { compileManim, estimateManimTimelineDurationUpperBound, type CompilerAssetDescriptor } from "./compiler";
import { validateAssetContent } from "./assetContent.server";
import { compareTimelineTimes } from "./frame";
import {
  PROOFCANVAS_PROJECT_MAX_BYTES,
  PROOFCANVAS_RENDER_SOURCE_MAX_BYTES,
  ProjectDocumentSchema,
  projectDurationSeconds,
  type AssetMetadata,
  type ProjectDocument,
} from "./schema";

export type RenderQuality = "preview" | "production";
export type RenderJobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface RenderOutputProfile {
  width: number;
  height: number;
  fps: 15 | 24 | 30 | 60;
  expectedDurationSeconds: number;
}

export interface RenderJob {
  id: string;
  quality: RenderQuality;
  output: RenderOutputProfile;
  sourceSha256: string;
  status: RenderJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: { code: string; message: string } | null;
  video: {
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    fps: number;
    durationSeconds: number;
    videoCodec: "h264";
    audioCodec: "aac" | null;
    videoStreams: 1;
    audioStreams: 0 | 1;
    decodedFrames: number;
    decodedAudioSamples: number;
  } | null;
}

export interface SubmitRenderRequest {
  project: ProjectDocument;
  shotId?: string;
  quality: RenderQuality;
  assets?: readonly RenderAssetInput[];
}

export interface RenderAssetInput {
  asset: AssetMetadata;
  bytes: Uint8Array;
}

export interface RenderVideo {
  body: ReadableStream<Uint8Array>;
  bytes: number;
  sourceSha256: string;
  videoSha256: string;
}

export interface RenderStill {
  body: ReadableStream<Uint8Array>;
  bytes: number;
  sourceSha256: string;
  stillSha256: string;
  timeSeconds: number;
}

const MAX_PUBLIC_BODY_BYTES = PROOFCANVAS_PROJECT_MAX_BYTES;
const MAX_UPSTREAM_JSON_BYTES = 64 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const MAX_STILL_BYTES = 16 * 1024 * 1024;
export const MAX_RENDER_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_RENDER_ASSETS = 64;
export const MAX_RENDER_AUDIO_CLIPS = 64;
export const MAX_RENDER_AUDIO_KEYFRAMES = 2_048;
const MAX_RENDER_REQUEST_BODY_BYTES = 174 * 1024 * 1024;
// Leave a ten-second envelope below the sidecar's 310-second decoded-output
// cap for frame-rate quantization across generated animation components.
export const MAX_SELECTED_RENDER_DURATION_SECONDS = 300;
export const UPSTREAM_JSON_TIMEOUT_MS = 12_000;
export const UPSTREAM_VIDEO_TIMEOUT_MS = 60_000;
export const UPSTREAM_SUBMIT_TIMEOUT_MS = 60_000;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const RENDER_ASSET_PATH_PATTERN = /^assets\/[0-9a-f]{64}\.(?:png|jpg|webp|svg|wav|mp3)$/;

interface EncodedRenderAsset {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml" | "audio/wav" | "audio/mpeg";
  sha256: string;
  bytes: number;
  contentBase64: string;
}

interface RenderAudioKeyframe {
  time: number;
  value: number;
  interpolation: "hold" | "linear";
}

interface RenderAudioClip {
  assetPath: string;
  start: number;
  duration: number;
  sourceStart: number;
  sourceEnd: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  keyframes: RenderAudioKeyframe[];
}

interface PreparedRenderMedia {
  assets: EncodedRenderAsset[];
  compilerAssets: ReadonlyMap<string, CompilerAssetDescriptor>;
  audio: { durationSeconds: number; clips: RenderAudioClip[] };
}

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
    && job.video.width === job.output?.width && job.video.height === job.output?.height
    && job.video.fps === job.output?.fps
    && typeof job.video.durationSeconds === "number" && Number.isFinite(job.video.durationSeconds)
    && job.video.durationSeconds > 0 && job.video.durationSeconds <= 310
    && job.video.videoCodec === "h264"
    && (job.video.audioCodec === null || job.video.audioCodec === "aac")
    && job.video.videoStreams === 1
    && job.video.audioStreams === (job.video.audioCodec === "aac" ? 1 : 0)
    && Number.isSafeInteger(job.video.decodedFrames) && job.video.decodedFrames > 0
    && Number.isSafeInteger(job.video.decodedAudioSamples) && job.video.decodedAudioSamples >= 0
    && Math.abs(job.video.decodedFrames - Math.round((job.output?.expectedDurationSeconds ?? 0) * job.video.fps)) <= 1
    && Math.abs(job.video.durationSeconds - job.video.decodedFrames / job.video.fps) < 1e-6
  );
  const validOutput = !!job.output
    && typeof job.output === "object"
    && Number.isInteger(job.output.width) && job.output.width >= 240 && job.output.width <= 1920
    && Number.isInteger(job.output.height) && job.output.height >= 240 && job.output.height <= 1920
    && job.output.width * job.output.height <= 1920 * 1080
    && [15, 24, 30, 60].includes(job.output.fps)
    && typeof job.output.expectedDurationSeconds === "number"
    && Number.isFinite(job.output.expectedDurationSeconds)
    && job.output.expectedDurationSeconds > 0
    && job.output.expectedDurationSeconds <= 310
    && Math.abs(job.output.expectedDurationSeconds * job.output.fps - Math.round(job.output.expectedDurationSeconds * job.output.fps)) < 1e-6;
  const pendingShape = job.status === "pending" && job.startedAt === null && job.completedAt === null && job.error === null && job.video === null;
  const runningShape = job.status === "running" && typeof job.startedAt === "number" && job.completedAt === null && job.error === null && job.video === null;
  const succeededShape = job.status === "succeeded" && typeof job.startedAt === "number" && typeof job.completedAt === "number" && job.error === null && job.video !== null;
  const failedShape = job.status === "failed" && typeof job.startedAt === "number" && typeof job.completedAt === "number" && job.error !== null && job.video === null;
  const cancelledShape = job.status === "cancelled" && typeof job.completedAt === "number" && job.error?.code === "render-cancelled" && job.video === null;
  if (
    typeof job.id !== "string" || !JOB_ID_PATTERN.test(job.id)
    || !["preview", "production"].includes(String(job.quality))
    || typeof job.sourceSha256 !== "string" || !SHA_PATTERN.test(job.sourceSha256)
    || !["pending", "running", "succeeded", "failed", "cancelled"].includes(String(job.status))
    || typeof job.createdAt !== "number" || !Number.isFinite(job.createdAt)
    || typeof job.updatedAt !== "number" || !Number.isFinite(job.updatedAt)
    || !nullableFinite(job.startedAt) || !nullableFinite(job.completedAt)
    || !validError || !validVideo || !validOutput
    || !(pendingShape || runningShape || succeededShape || failedShape || cancelledShape)
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

function renderAssetExtension(mimeType: EncodedRenderAsset["mimeType"]): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType === "audio/wav") return "wav";
  return "mp3";
}

function selectedProject(project: ProjectDocument, shotId?: string): ProjectDocument {
  if (shotId === undefined) return project;
  const shot = project.shots.find(({ id }) => id === shotId);
  if (!shot) throw new RenderClientError(400, "invalid_request", "Requested shot does not exist.");
  return ProjectDocumentSchema.parse({ ...project, shots: [shot] });
}

function sameAssetMetadata(left: AssetMetadata, right: AssetMetadata): boolean {
  return left.id === right.id
    && left.filename === right.filename
    && left.mimeType === right.mimeType
    && left.size === right.size
    && left.sha256 === right.sha256
    && left.width === right.width
    && left.height === right.height
    && left.duration === right.duration
    && left.provenance === right.provenance;
}

/** Exact project-local asset IDs needed by one render selection. */
export function referencedRenderAssetIds(project: ProjectDocument, shotId?: string): string[] {
  const selected = selectedProject(ProjectDocumentSchema.parse(project), shotId);
  const ids = new Set<string>();
  for (const shot of selected.shots) {
    for (const object of shot.objects) {
      if ((object.type === "image" || object.type === "svg") && typeof object.properties.assetId === "string") {
        ids.add(object.properties.assetId);
      }
    }
    const hasSolo = shot.audioClips.some(({ solo, muted }) => solo && !muted);
    for (const clip of shot.audioClips) {
      if (!clip.muted && (!hasSolo || clip.solo)) ids.add(clip.assetId);
    }
  }
  return [...ids].sort();
}

function prepareRenderMedia(project: ProjectDocument, inputs: readonly RenderAssetInput[]): PreparedRenderMedia {
  const requiredIds = referencedRenderAssetIds(project);
  if (requiredIds.length > MAX_RENDER_ASSETS) {
    throw new RenderClientError(422, "render_asset_limit_exceeded", `A render may reference at most ${MAX_RENDER_ASSETS} trusted assets.`);
  }
  const metadataById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const suppliedById = new Map<string, RenderAssetInput>();
  for (const input of inputs) {
    if (suppliedById.has(input.asset.id)) throw new RenderClientError(400, "invalid_request", "Render assets contain a duplicate asset ID.");
    suppliedById.set(input.asset.id, input);
  }

  const compilerAssets = new Map<string, CompilerAssetDescriptor>();
  const encodedByPath = new Map<string, EncodedRenderAsset>();
  let aggregateBytes = 0;
  for (const assetId of requiredIds) {
    const expected = metadataById.get(assetId);
    const supplied = suppliedById.get(assetId);
    if (!expected || !supplied) {
      throw new RenderClientError(422, "asset_content_missing", `Trusted content for asset ${assetId} is not available.`);
    }
    if (!sameAssetMetadata(supplied.asset, expected)) {
      throw new RenderClientError(422, "asset_metadata_mismatch", `Trusted content metadata for asset ${assetId} does not match the project.`);
    }
    let validated: ReturnType<typeof validateAssetContent>;
    try {
      validated = validateAssetContent({
        filename: expected.filename,
        bytes: supplied.bytes,
        declaredSize: expected.size,
        claimedMimeType: expected.mimeType,
        expectedSha256: expected.sha256,
      });
    } catch {
      throw new RenderClientError(422, "asset_content_invalid", `Trusted content for asset ${assetId} failed validation.`);
    }
    const durationMatches = expected.duration === undefined
      ? validated.duration === undefined
      : validated.duration !== undefined && Math.abs(expected.duration - validated.duration) <= 1e-8;
    if (
      validated.filename !== expected.filename
      || validated.width !== expected.width
      || validated.height !== expected.height
      || !durationMatches
    ) {
      throw new RenderClientError(422, "asset_metadata_mismatch", `Validated content metadata for asset ${assetId} does not match the project.`);
    }
    if (!["image/png", "image/jpeg", "image/webp", "image/svg+xml", "audio/wav", "audio/mpeg"].includes(validated.mimeType)) {
      throw new RenderClientError(422, "asset_type_unsupported", `Asset ${assetId} uses a media type that the renderer cannot safely decode.`);
    }
    const mimeType = validated.mimeType as EncodedRenderAsset["mimeType"];
    const path = `assets/${validated.sha256}.${renderAssetExtension(mimeType)}`;
    if (!RENDER_ASSET_PATH_PATTERN.test(path)) throw new RenderClientError(500, "renderer_error", "A trusted render asset path could not be derived.");
    const encoded: EncodedRenderAsset = {
      path,
      mimeType,
      sha256: validated.sha256,
      bytes: validated.size,
      contentBase64: Buffer.from(validated.contentBytes).toString("base64"),
    };
    const existing = encodedByPath.get(path);
    if (existing && (existing.mimeType !== encoded.mimeType || existing.bytes !== encoded.bytes || existing.contentBase64 !== encoded.contentBase64)) {
      throw new RenderClientError(422, "asset_content_invalid", "Hash-addressed render assets disagree.");
    }
    if (!existing) {
      aggregateBytes += validated.size;
      if (aggregateBytes > MAX_RENDER_ASSET_BYTES) {
        throw new RenderClientError(422, "render_asset_limit_exceeded", `Render assets exceed the ${MAX_RENDER_ASSET_BYTES}-byte transport limit.`);
      }
    }
    encodedByPath.set(path, encoded);
    if (["image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(mimeType)) {
      if (!validated.width || !validated.height) throw new RenderClientError(422, "asset_content_invalid", `Image asset ${assetId} has no validated dimensions.`);
      compilerAssets.set(assetId, {
        path,
        mimeType: mimeType as CompilerAssetDescriptor["mimeType"],
        width: validated.width,
        height: validated.height,
      });
    }
  }

  const clips: RenderAudioClip[] = [];
  let keyframeCount = 0;
  let shotOffset = 0;
  for (const shot of project.shots) {
    const hasSolo = shot.audioClips.some(({ solo, muted }) => solo && !muted);
    for (const clip of shot.audioClips.slice().sort((left, right) => left.id.localeCompare(right.id))) {
      if (clip.muted || (hasSolo && !clip.solo)) continue;
      if (clips.length >= MAX_RENDER_AUDIO_CLIPS) {
        throw new RenderClientError(422, "render_audio_limit_exceeded", `A render may mix at most ${MAX_RENDER_AUDIO_CLIPS} audible clips.`);
      }
      const asset = metadataById.get(clip.assetId);
      const encoded = asset ? encodedByPath.get(`assets/${asset.sha256}.${asset.mimeType === "audio/wav" ? "wav" : "mp3"}`) : undefined;
      if (!asset || !encoded || (asset.mimeType !== "audio/wav" && asset.mimeType !== "audio/mpeg")) {
        throw new RenderClientError(422, "asset_type_unsupported", `Audio clip ${clip.id} does not reference a supported trusted audio asset.`);
      }
      const sourceSpan = clip.sourceEnd - clip.sourceStart;
      const playbackRate = sourceSpan / clip.duration;
      if (clip.duration < 0.01 || sourceSpan < 0.01 || playbackRate < 1 / 16 || playbackRate > 16) {
        throw new RenderClientError(422, "render_audio_rate_unsupported", `Audio clip ${clip.id} exceeds the safe renderer playback-rate envelope.`);
      }
      const track = shot.propertyTracks.find((candidate) => candidate.target.kind === "audio" && candidate.target.audioClipId === clip.id && candidate.property === "volume");
      const keyframes: RenderAudioKeyframe[] = [];
      for (const keyframe of track?.keyframes ?? []) {
        if (typeof keyframe.value !== "number" || (keyframe.interpolation.kind !== "hold" && keyframe.interpolation.kind !== "linear")) {
          throw new RenderClientError(422, "render_audio_interpolation_unsupported", `Audio clip ${clip.id} uses a volume interpolation that is not in the safe mux dialect.`);
        }
        keyframes.push({ time: keyframe.time - clip.start, value: keyframe.value, interpolation: keyframe.interpolation.kind });
        keyframeCount += 1;
        if (keyframeCount > MAX_RENDER_AUDIO_KEYFRAMES) {
          throw new RenderClientError(422, "render_audio_limit_exceeded", `A render may transport at most ${MAX_RENDER_AUDIO_KEYFRAMES} audio keyframes.`);
        }
      }
      clips.push({
        assetPath: encoded.path,
        start: shotOffset + clip.start,
        duration: clip.duration,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        volume: clip.volume,
        fadeIn: clip.fadeIn ?? 0,
        fadeOut: clip.fadeOut ?? 0,
        keyframes,
      });
    }
    shotOffset += shot.duration;
  }
  return {
    assets: [...encodedByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    compilerAssets,
    audio: { durationSeconds: projectDurationSeconds(project), clips },
  };
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
  const compileProject = selectedProject(project, input.shotId);
  const selectedDuration = projectDurationSeconds(compileProject);
  const frameRate = compileProject.settings.frameRate;
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
  const media = prepareRenderMedia(compileProject, input.assets ?? []);
  const compiled = compileManim(compileProject, { assetsById: media.compilerAssets, audioTransport: true });
  if (compiled.diagnostics.some(({ severity }) => severity === "error")) {
    throw new RenderClientError(422, "compile_rejected", "Project could not be compiled for Manim.");
  }
  const sourceBytes = renderSourceBytes(compiled.python);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const output: RenderOutputProfile = {
    width: compileProject.settings.resolution.width,
    height: compileProject.settings.resolution.height,
    fps: compileProject.settings.frameRate,
    expectedDurationSeconds: estimatedVideoDuration,
  };
  const body = JSON.stringify({ source: compiled.python, sourceSha256, quality: input.quality, output, assets: media.assets, audio: media.audio });
  if (Buffer.byteLength(body, "utf8") > MAX_RENDER_REQUEST_BODY_BYTES) {
    throw new RenderClientError(413, "render_asset_limit_exceeded", "Encoded render request exceeds the private renderer limit.");
  }
  const request = await fetchRenderer("/v1/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }, UPSTREAM_SUBMIT_TIMEOUT_MS);
  let job: RenderJob;
  try {
    job = await responseJob(request.response);
  } finally {
    request.release();
  }
  if (
    job.sourceSha256 !== sourceSha256
    || job.quality !== input.quality
    || job.output.width !== output.width
    || job.output.height !== output.height
    || job.output.fps !== output.fps
    || Math.abs(job.output.expectedDurationSeconds - output.expectedDurationSeconds) > 1e-9
  ) throw upstreamError(502);
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

export async function cancelRenderJob(id: string): Promise<RenderJob> {
  const request = await fetchRenderer(`/v1/render/${jobId(id)}`, { method: "DELETE" });
  try {
    if (request.response.status === 409) {
      await boundedResponseText(request.response, MAX_UPSTREAM_JSON_BYTES).catch(() => "");
      throw new RenderClientError(409, "render_not_cancellable", "Completed render jobs cannot be cancelled.");
    }
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

export async function fetchRenderStill(id: string, timeSeconds: number): Promise<RenderStill> {
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > MAX_SELECTED_RENDER_DURATION_SECONDS) {
    throw new RenderClientError(400, "invalid_still_time", "Still export time is invalid.");
  }
  const canonicalTime = Number(timeSeconds.toFixed(8));
  const request = await fetchRenderer(`/v1/render/${jobId(id)}/still?time=${canonicalTime}`, {
    method: "GET",
    headers: { Accept: "image/png" },
  }, UPSTREAM_VIDEO_TIMEOUT_MS);
  const response = request.response;
  if (!response.ok) {
    try {
      await boundedResponseText(response, MAX_UPSTREAM_JSON_BYTES).catch(() => "");
      if (response.status === 409) throw new RenderClientError(409, "still_unavailable", "A decoded still is unavailable at that time.");
      throw upstreamError(response.status);
    } finally {
      request.release();
    }
  }
  const bytes = Number(response.headers.get("content-length"));
  const sourceSha256 = response.headers.get("x-proofcanvas-source-sha256") ?? "";
  const stillSha256 = response.headers.get("x-proofcanvas-still-sha256") ?? "";
  const actualTime = Number(response.headers.get("x-proofcanvas-still-time"));
  if (
    !response.body
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "image/png"
    || !Number.isSafeInteger(bytes) || bytes < 32 || bytes > MAX_STILL_BYTES
    || !SHA_PATTERN.test(sourceSha256) || !SHA_PATTERN.test(stillSha256)
    || !Number.isFinite(actualTime) || actualTime < 0 || actualTime > MAX_SELECTED_RENDER_DURATION_SECONDS
  ) {
    await response.body?.cancel().catch(() => undefined);
    request.abort();
    throw upstreamError(502);
  }
  return { body: boundedRendererStream(request, bytes), bytes, sourceSha256, stillSha256, timeSeconds: actualTime };
}
