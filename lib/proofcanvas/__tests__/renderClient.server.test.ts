jest.mock("server-only", () => ({}), { virtual: true });

import { createCantorDemoProject } from "@/lib/proofcanvas/demo";
import { PROOFCANVAS_RENDER_SOURCE_MAX_BYTES, PROOFCANVAS_SCHEMA_LIMITS, ProjectDocumentSchema, cloneSerializable } from "@/lib/proofcanvas/schema";
import {
  MAX_SELECTED_RENDER_DURATION_SECONDS,
  RenderClientError,
  UPSTREAM_JSON_TIMEOUT_MS,
  UPSTREAM_VIDEO_TIMEOUT_MS,
  fetchRenderVideo,
  getRenderJob,
  readBoundedJson,
  renderSourceBytes,
  submitRender,
} from "@/lib/proofcanvas/renderClient.server";

test("source transport guard shares the compiler limit and rejects 524289 bytes before fetch", () => {
  expect(renderSourceBytes("x".repeat(PROOFCANVAS_RENDER_SOURCE_MAX_BYTES))).toHaveLength(PROOFCANVAS_RENDER_SOURCE_MAX_BYTES);
  expect(() => renderSourceBytes("x".repeat(PROOFCANVAS_RENDER_SOURCE_MAX_BYTES + 1))).toThrow(expect.objectContaining({ status: 413, code: "source_too_large" }));
  expect(global.fetch).not.toHaveBeenCalled();
});

test("fails closed on authored audio and audio tracks before renderer fetch", async () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  project.assets.push({ id: "asset-audio", filename: "tone.wav", mimeType: "audio/wav", size: 16, sha256: "a".repeat(64), duration: 2, provenance: "uploaded" });
  shot.audioClips.push({ id: "audio-clip", assetId: "asset-audio", name: "Tone", start: 0, duration: 2, sourceStart: 0, sourceEnd: 2, volume: 1, muted: false, solo: false });
  shot.propertyTracks.push({ id: "track-audio-volume", target: { kind: "audio", audioClipId: "audio-clip" }, property: "volume", keyframes: [
    { id: "keyframe-audio-a", time: 0, value: 1, interpolation: { kind: "linear" } },
    { id: "keyframe-audio-b", time: 2, value: 0.5, interpolation: { kind: "linear" } },
  ] });
  await expect(submitRender({ project: ProjectDocumentSchema.parse(project), quality: "preview" })).rejects.toEqual(expect.objectContaining({ status: 422, code: "compile_rejected" }));
  expect(global.fetch).not.toHaveBeenCalled();
});

test("fails closed on delayed initial property state before renderer fetch", async () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  const object = shot.objects.find(({ type }) => type !== "group")!;
  shot.propertyTracks = [{ id: "track-render-delayed", target: { kind: "object", objectId: object.id }, property: "x", keyframes: [
    { id: "keyframe-render-delayed-a", time: 1, value: object.transform.x, interpolation: { kind: "linear" } },
    { id: "keyframe-render-delayed-b", time: 2, value: object.transform.x + 10, interpolation: { kind: "linear" } },
  ] }];
  await expect(submitRender({ project: ProjectDocumentSchema.parse(project), quality: "preview" })).rejects.toEqual(expect.objectContaining({ status: 422, code: "compile_rejected" }));
  expect(global.fetch).not.toHaveBeenCalled();
});

const ORIGINAL_ENV = { ...process.env };
const TOKEN = "proofcanvas-next-test-token-that-is-long-enough";

function headers(values: Record<string, string>) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => normalized[name.toLowerCase()] ?? null };
}

function jsonResponse(status: number, body: unknown): Response {
  const bytes = Buffer.from(JSON.stringify(body), "utf-8");
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers({ "content-length": String(bytes.byteLength), "content-type": "application/json" }),
    body: {
      getReader: () => ({
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
        releaseLock() {},
      }),
    },
  } as unknown as Response;
}

beforeEach(() => {
  process.env.PROOFCANVAS_RENDER_URL = "http://renderer.example:8080";
  process.env.PROOFCANVAS_RENDER_TOKEN = TOKEN;
  global.fetch = jest.fn();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

test("compiles one requested shot locally and submits only generated source plus its SHA", async () => {
  (global.fetch as jest.Mock).mockImplementation(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    expect(payload).toEqual({
      source: expect.stringContaining("class GeneratedScene"),
      sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      quality: "preview",
    });
    expect(JSON.stringify(payload)).not.toContain("schemaVersion");
    expect(payload.source).toContain("The construction");
    expect(payload.source).not.toContain("The paradox");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", redirect: "error" });
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    return jsonResponse(202, {
      ok: true,
      job: {
        id: "abcdefghijklmnopqrstuvwx",
        quality: "preview",
        sourceSha256: payload.sourceSha256,
        status: "pending",
        createdAt: 1000,
        updatedAt: 1000,
        startedAt: null,
        completedAt: null,
        error: null,
        video: null,
      },
    });
  });

  const job = await submitRender({
    project: createCantorDemoProject(),
    shotId: "shot-cantor-construction",
    quality: "preview",
  });

  expect(job.status).toBe("pending");
  expect(global.fetch).toHaveBeenCalledWith("http://renderer.example:8080/v1/render", expect.any(Object));
});

test("returns a typed 503 before network access when renderer configuration is absent", async () => {
  delete process.env.PROOFCANVAS_RENDER_URL;

  await expect(getRenderJob("abcdefghijklmnopqrstuvwx")).rejects.toEqual(
    expect.objectContaining<Partial<RenderClientError>>({ status: 503, code: "render_unavailable" }),
  );
  expect(global.fetch).not.toHaveBeenCalled();
});

test("rejects a structurally oversized project before compiling or contacting the render queue", async () => {
  const project = cloneSerializable(createCantorDemoProject());
  const baseObject = project.shots[0].objects.find(({ id }) => id === "object-title")!;
  project.shots[0].objects = Array.from(
    { length: PROOFCANVAS_SCHEMA_LIMITS.objectsPerShot + 1 },
    (_, index) => ({ ...cloneSerializable(baseObject), id: `object-render-limit-${index}` }),
  );

  await expect(submitRender({ project, quality: "preview" })).rejects.toEqual(
    expect.objectContaining<Partial<RenderClientError>>({ status: 400, code: "invalid_request" }),
  );
  expect(global.fetch).not.toHaveBeenCalled();
});

test("rejects an overlong whole-project render but permits one selected shot", async () => {
  const project = cloneSerializable(createCantorDemoProject());
  project.shots[0].duration = 200;
  project.shots[1].duration = 200;

  await expect(submitRender({ project, quality: "preview" })).rejects.toEqual(
    expect.objectContaining<Partial<RenderClientError>>({
      status: 422,
      code: "render_duration_exceeded",
      message: `Selected timeline exceeds the ${MAX_SELECTED_RENDER_DURATION_SECONDS}-second render limit.`,
    }),
  );
  expect(global.fetch).not.toHaveBeenCalled();

  (global.fetch as jest.Mock).mockImplementation(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    return jsonResponse(202, {
      ok: true,
      job: {
        id: "abcdefghijklmnopqrstuvwx",
        quality: "preview",
        sourceSha256: payload.sourceSha256,
        status: "pending",
        createdAt: 1000,
        updatedAt: 1000,
        startedAt: null,
        completedAt: null,
        error: null,
        video: null,
      },
    });
  });

  await expect(submitRender({ project, shotId: project.shots[0].id, quality: "preview" })).resolves.toMatchObject({ status: "pending" });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("rejects aggregate-safe timelines whose sub-frame plays and waits exceed the decoded-video cap after quantization", async () => {
  const project = cloneSerializable(createCantorDemoProject());
  const template = project.shots[1];
  const templateObject = template.objects[0];
  project.shots = Array.from({ length: 8 }, (_, shotIndex) => {
    const object = {
      ...cloneSerializable(templateObject),
      id: `object-quantized-${shotIndex}`,
      name: `Quantized ${shotIndex}`,
    };
    return {
      ...cloneSerializable(template),
      id: `shot-quantized-${shotIndex}`,
      name: `Quantized ${shotIndex}`,
      duration: 37.5,
      objects: [object],
      animations: Array.from({ length: 125 }, (_, animationIndex) => ({
        id: `animation-quantized-${shotIndex}-${animationIndex}`,
        type: "move" as const,
        targetIds: [object.id],
        // A positive 1ms gap separates each 1ms play. Manim quantizes both
        // calls to at least one frame, so authored duration alone is unsafe.
        start: animationIndex * 0.002,
        duration: 0.001,
        easing: "linear" as const,
        properties: { deltaX: animationIndex % 2 === 0 ? 1 : -1 },
      })),
    };
  });
  expect(project.shots.reduce((total, shot) => total + shot.duration, 0)).toBe(MAX_SELECTED_RENDER_DURATION_SECONDS);

  await expect(submitRender({ project, quality: "preview" })).rejects.toEqual(
    expect.objectContaining<Partial<RenderClientError>>({ status: 422, code: "render_duration_exceeded" }),
  );
  expect(global.fetch).not.toHaveBeenCalled();
});

test("rejects frame-boundary durations using the exact rounded literals emitted to Manim", async () => {
  const project = cloneSerializable(createCantorDemoProject());
  const template = project.shots[1];
  const templateObject = template.objects[0];
  project.shots = Array.from({ length: 10 }, (_, shotIndex) => {
    const object = {
      ...cloneSerializable(templateObject),
      id: `object-frame-boundary-${shotIndex}`,
      name: `Frame boundary ${shotIndex}`,
    };
    return {
      ...cloneSerializable(template),
      id: `shot-frame-boundary-${shotIndex}`,
      name: `Frame boundary ${shotIndex}`,
      duration: 30,
      objects: [object],
      animations: Array.from({ length: 100 }, (_, animationIndex) => ({
        id: `animation-frame-boundary-${shotIndex}-${animationIndex}`,
        type: "move" as const,
        targetIds: [object.id],
        // Eight-decimal Python serialization rounds this just above one 30fps
        // frame, so Manim charges two frames for every authored one-frame play.
        start: animationIndex * (1 / 30 + 2e-9),
        duration: 1 / 30 + 2e-9,
        easing: "linear" as const,
        properties: { deltaX: animationIndex % 2 === 0 ? 1 : -1 },
      })),
    };
  });
  expect(project.shots.reduce((total, shot) => total + shot.duration, 0)).toBe(MAX_SELECTED_RENDER_DURATION_SECONDS);

  await expect(submitRender({ project, quality: "preview" })).rejects.toEqual(
    expect.objectContaining<Partial<RenderClientError>>({ status: 422, code: "render_duration_exceeded" }),
  );
  expect(global.fetch).not.toHaveBeenCalled();
});

test("rejects a declared oversized public body before reading its stream", async () => {
  let bodyRead = false;
  const request = {
    headers: headers({ "content-length": String(2 * 1024 * 1024 + 1) }),
    body: {
      getReader() {
        bodyRead = true;
        throw new Error("body must not be read");
      },
    },
  } as unknown as Request;

  await expect(readBoundedJson(request)).rejects.toEqual(
    expect.objectContaining<Partial<RenderClientError>>({ status: 413, code: "invalid_request" }),
  );
  expect(bodyRead).toBe(false);
});

test("stream-bounds an oversized public body without a content-length declaration", async () => {
  const bytes = Buffer.from(`{"padding":"${"x".repeat(2 * 1024 * 1024)}"}`, "utf8");
  let sent = false;
  const request = {
    headers: headers({ "content-type": "application/json" }),
    body: {
      getReader: () => ({
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
        async cancel() { sent = true; },
        releaseLock() {},
      }),
    },
  } as unknown as Request;

  await expect(readBoundedJson(request)).rejects.toEqual(
    expect.objectContaining<Partial<RenderClientError>>({ status: 413, code: "invalid_request" }),
  );
});

test("rejects inconsistent source metadata from the isolated service", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(202, {
    ok: true,
    job: {
      id: "abcdefghijklmnopqrstuvwx",
      quality: "preview",
      sourceSha256: "0".repeat(64),
      status: "pending",
      createdAt: 1000,
      updatedAt: 1000,
      startedAt: null,
      completedAt: null,
      error: null,
      video: null,
    },
  }));

  await expect(submitRender({ project: createCantorDemoProject(), quality: "preview" })).rejects.toEqual(
    expect.objectContaining<Partial<RenderClientError>>({ status: 502, code: "renderer_error" }),
  );
});

test("keeps the upstream deadline active while reading JSON response bodies", async () => {
  jest.useFakeTimers();
  try {
    (global.fetch as jest.Mock).mockImplementation(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        headers: headers({ "content-type": "application/json" }),
        body: {
          getReader: () => ({
            read: () => new Promise((_, reject) => {
              if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
              else signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
            }),
            releaseLock() {},
          }),
        },
      } as unknown as Response;
    });

    const expectation = expect(getRenderJob("abcdefghijklmnopqrstuvwx")).rejects.toEqual(
      expect.objectContaining<Partial<RenderClientError>>({ status: 502, code: "renderer_error" }),
    );
    await jest.advanceTimersByTimeAsync(UPSTREAM_JSON_TIMEOUT_MS + 1);
    await expectation;
  } finally {
    jest.useRealTimers();
  }
});

test("aborts a stalled video body after the bounded transfer deadline", async () => {
  jest.useFakeTimers();
  try {
    (global.fetch as jest.Mock).mockImplementation(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        headers: headers({
          "content-length": "32",
          "content-type": "video/mp4",
          "x-proofcanvas-source-sha256": "a".repeat(64),
          "x-proofcanvas-video-sha256": "b".repeat(64),
        }),
        body: {
          getReader: () => ({
            read: () => new Promise((_, reject) => {
              if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
              else signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
            }),
            async cancel() {},
            releaseLock() {},
          }),
        },
      } as unknown as Response;
    });

    const video = await fetchRenderVideo("abcdefghijklmnopqrstuvwx");
    const read = video.body.getReader().read();
    const expectation = expect(read).rejects.toEqual(
      expect.objectContaining<Partial<RenderClientError>>({ status: 502, code: "renderer_error" }),
    );
    await jest.advanceTimersByTimeAsync(UPSTREAM_VIDEO_TIMEOUT_MS + 1);
    await expectation;
  } finally {
    jest.useRealTimers();
  }
});

test.each([
  { name: "short", chunks: [new Uint8Array(16)] },
  { name: "oversized", chunks: [new Uint8Array(20), new Uint8Array(13)] },
])("rejects a $name video stream whose bytes do not equal the declared length", async ({ chunks }) => {
  const cancel = jest.fn();
  let index = 0;
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    status: 200,
    headers: headers({
      "content-length": "32",
      "content-type": "video/mp4",
      "x-proofcanvas-source-sha256": "a".repeat(64),
      "x-proofcanvas-video-sha256": "b".repeat(64),
    }),
    body: {
      getReader: () => ({
        async read() {
          const value = chunks[index++];
          return value ? { done: false, value } : { done: true, value: undefined };
        },
        cancel,
        releaseLock() {},
      }),
    },
  } as unknown as Response);

  const video = await fetchRenderVideo("abcdefghijklmnopqrstuvwx");
  const reader = video.body.getReader();
  const drain = async () => {
    while (!(await reader.read()).done) { /* consume until exact-length validation */ }
  };
  await expect(drain()).rejects.toEqual(
    expect.objectContaining<Partial<RenderClientError>>({ status: 502, code: "renderer_error" }),
  );
  expect(cancel).toHaveBeenCalled();
});
