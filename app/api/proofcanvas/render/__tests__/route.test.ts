/** @jest-environment node */

jest.mock("next/server", () => ({
  NextResponse: {
    json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      const normalized = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
      return {
        status: init.status ?? 200,
        headers: { get: (name: string) => normalized[name.toLowerCase()] ?? null },
        async json() { return body; },
      };
    },
  },
}));

jest.mock("@/lib/proofcanvas/auth.server", () => {
  class ProofCanvasAuthError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  }
  return {
    ProofCanvasAuthError,
    authenticateRequest: jest.fn(),
    authorizeStateChangingRequest: jest.fn(),
  };
});

jest.mock("@/lib/proofcanvas/repository.server", () => {
  class ProjectRepositoryError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
      public currentRevision?: number,
    ) {
      super(message);
    }
  }
  const getProject = jest.fn();
  const getProjectAsset = jest.fn();
  return {
    ProjectRepositoryError,
    projectRepository: jest.fn(() => ({ getProject, getProjectAsset })),
    __mockGetProject: getProject,
    __mockGetProjectAsset: getProjectAsset,
  };
});

jest.mock("@/lib/proofcanvas/renderClient.server", () => {
  class RenderClientError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  }
  return {
    RenderClientError,
    readBoundedJson: jest.fn(),
    referencedRenderAssetIds: jest.fn(() => []),
    submitRender: jest.fn(),
    getRenderJob: jest.fn(),
    cancelRenderJob: jest.fn(),
    fetchRenderStill: jest.fn(),
  };
});

import { createCantorDemoProject } from "@/lib/proofcanvas/demo";
import {
  ProofCanvasAuthError,
  authenticateRequest,
  authorizeStateChangingRequest,
} from "@/lib/proofcanvas/auth.server";
import {
  RenderClientError,
  cancelRenderJob,
  fetchRenderStill,
  getRenderJob,
  readBoundedJson,
  submitRender,
} from "@/lib/proofcanvas/renderClient.server";
import { DELETE as DELETE_JOB, GET as GET_STATUS } from "../[jobId]/route";
import { GET as GET_STILL } from "../[jobId]/still/route";
import { POST } from "../route";

const { __mockGetProject: mockGetProject, __mockGetProjectAsset: mockGetProjectAsset } = jest.requireMock("@/lib/proofcanvas/repository.server") as {
  __mockGetProject: jest.Mock;
  __mockGetProjectAsset: jest.Mock;
};
const { referencedRenderAssetIds: mockReferencedRenderAssetIds } = jest.requireMock("@/lib/proofcanvas/renderClient.server") as {
  referencedRenderAssetIds: jest.Mock;
};

const job = {
  id: "abcdefghijklmnopqrstuvwx",
  quality: "preview" as const,
  output: { width: 1280, height: 720, fps: 30 as const, expectedDurationSeconds: 1 },
  sourceSha256: "a".repeat(64),
  status: "pending" as const,
  createdAt: 1000,
  updatedAt: 1000,
  startedAt: null,
  completedAt: null,
  error: null,
  video: null,
};

const ORIGINAL_ENV = { ...process.env };
const TOKEN = "proofcanvas-render-route-test-token-long-enough";
const PROJECT_ID = "project-0123456789abcdef01234567";
const REVISION = 7;
const project = createCantorDemoProject();

function durableProject(revision = REVISION) {
  return {
    id: PROJECT_ID,
    title: project.metadata.title,
    revision,
    createdAt: project.metadata.createdAt,
    updatedAt: project.metadata.updatedAt,
    thumbnail: null,
    shotCount: project.shots.length,
    objectCount: project.shots.reduce((sum, shot) => sum + shot.objects.length, 0),
    durationSeconds: project.shots.reduce((sum, shot) => sum + shot.duration, 0),
    document: project,
  };
}

function request(contentType = "application/json") {
  return {
    headers: { get: (name: string) => name.toLowerCase() === "content-type" ? contentType : null },
  } as unknown as Request;
}

beforeEach(() => {
  jest.clearAllMocks();
  (authorizeStateChangingRequest as jest.Mock).mockReturnValue({ tokenHash: "session" });
  (authenticateRequest as jest.Mock).mockReturnValue({ tokenHash: "session" });
  mockGetProject.mockReturnValue(durableProject());
  mockReferencedRenderAssetIds.mockReturnValue([]);
  process.env.PROOFCANVAS_RENDER_URL = "http://renderer.example:8080";
  process.env.PROOFCANVAS_RENDER_TOKEN = TOKEN;
});

test("POST resolves only the selected render's project-scoped trusted assets", async () => {
  const body = { projectId: PROJECT_ID, revision: REVISION, shotId: "shot-cantor-construction", quality: "preview" };
  const asset = { asset: { id: "asset-render-one" }, bytes: Buffer.from("trusted") };
  (readBoundedJson as jest.Mock).mockResolvedValue(body);
  mockReferencedRenderAssetIds.mockReturnValue(["asset-render-one"]);
  mockGetProjectAsset.mockReturnValue(asset);
  (submitRender as jest.Mock).mockResolvedValue(job);

  const response = await POST(request());

  expect(response.status).toBe(202);
  expect(mockReferencedRenderAssetIds).toHaveBeenCalledWith(project, body.shotId);
  expect(mockGetProjectAsset).toHaveBeenCalledWith({ projectId: PROJECT_ID, assetId: "asset-render-one" });
  expect(submitRender).toHaveBeenCalledWith({ project, assets: [asset], shotId: body.shotId, quality: body.quality });
});

test("DELETE authorizes and forwards bounded cancellation", async () => {
  const cancelled = { ...job, status: "cancelled", completedAt: 1001, error: { code: "render-cancelled", message: "Render was cancelled." } };
  (cancelRenderJob as jest.Mock).mockResolvedValue(cancelled);
  const response = await DELETE_JOB(request(), { params: Promise.resolve({ jobId: job.id }) });
  expect(response.status).toBe(200);
  expect(authorizeStateChangingRequest).toHaveBeenCalled();
  expect(cancelRenderJob).toHaveBeenCalledWith(job.id);
  expect(await response.json()).toEqual({ ok: true, job: cancelled });
});

test("still GET authenticates and preserves the exact hash-bound PNG receipt", async () => {
  const bytes = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), Buffer.alloc(56, 7)]);
  (fetchRenderStill as jest.Mock).mockResolvedValue({
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    bytes: bytes.byteLength,
    sourceSha256: "a".repeat(64),
    stillSha256: "b".repeat(64),
    timeSeconds: 0.46666667,
  });

  const response = await GET_STILL(
    new Request(`https://proofcanvas.test/api/proofcanvas/render/${job.id}/still?time=0.5`),
    { params: Promise.resolve({ jobId: job.id }) },
  );

  expect(response.status).toBe(200);
  expect(authenticateRequest).toHaveBeenCalledTimes(1);
  expect(fetchRenderStill).toHaveBeenCalledWith(job.id, 0.5);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
  expect(response.headers.get("x-proofcanvas-source-sha256")).toBe("a".repeat(64));
  expect(response.headers.get("x-proofcanvas-still-sha256")).toBe("b".repeat(64));
  expect(response.headers.get("x-proofcanvas-still-time")).toBe("0.46666667");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

test("still GET rejects ambiguous query parameters before renderer access", async () => {
  const response = await GET_STILL(
    new Request(`https://proofcanvas.test/api/proofcanvas/render/${job.id}/still?time=0.5&extra=1`),
    { params: Promise.resolve({ jobId: job.id }) },
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, code: "invalid_still_time" });
  expect(fetchRenderStill).not.toHaveBeenCalled();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

test("POST accepts the strict public envelope and returns an asynchronous job", async () => {
  const body = { projectId: PROJECT_ID, revision: REVISION, shotId: "shot-cantor-construction", quality: "preview" };
  (readBoundedJson as jest.Mock).mockResolvedValue(body);
  (submitRender as jest.Mock).mockResolvedValue(job);

  const response = await POST(request());

  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({ ok: true, projectId: PROJECT_ID, revision: REVISION, job });
  expect(submitRender).toHaveBeenCalledWith({ project, assets: [], shotId: body.shotId, quality: body.quality });
  expect(mockGetProject).toHaveBeenCalledWith(PROJECT_ID);
});

test("POST rejects extra public fields before compiling", async () => {
  (readBoundedJson as jest.Mock).mockResolvedValue({
    projectId: PROJECT_ID,
    revision: REVISION,
    quality: "preview",
    source: "arbitrary Python",
  });

  const response = await POST(request());

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, code: "invalid_request" });
  expect(submitRender).not.toHaveBeenCalled();
});

test("POST preserves the typed render-duration admission error", async () => {
  const body = { projectId: PROJECT_ID, revision: REVISION, quality: "preview" };
  (readBoundedJson as jest.Mock).mockResolvedValue(body);
  (submitRender as jest.Mock).mockRejectedValue(new RenderClientError(
    422,
    "render_duration_exceeded",
    "Selected timeline exceeds the 300-second render limit.",
  ));

  const response = await POST(request());

  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
    ok: false,
    code: "render_duration_exceeded",
    message: "Selected timeline exceeds the 300-second render limit.",
  });
});

test("POST returns render_unavailable without reading an unconfigured request body", async () => {
  delete process.env.PROOFCANVAS_RENDER_URL;

  const response = await POST(request());

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    ok: false,
    code: "render_unavailable",
    message: "ProofCanvas rendering is not configured.",
  });
  expect(readBoundedJson).not.toHaveBeenCalled();
  expect(submitRender).not.toHaveBeenCalled();
});

test("POST authenticates before renderer configuration or body work", async () => {
  (authorizeStateChangingRequest as jest.Mock).mockImplementation(() => {
    throw new ProofCanvasAuthError(401, "unauthenticated", "Authentication is required");
  });
  delete process.env.PROOFCANVAS_RENDER_URL;

  const response = await POST(request());

  expect(response.status).toBe(401);
  expect(readBoundedJson).not.toHaveBeenCalled();
  expect(mockGetProject).not.toHaveBeenCalled();
});

test("POST rejects stale durable revisions before submitting", async () => {
  (readBoundedJson as jest.Mock).mockResolvedValue({ projectId: PROJECT_ID, revision: REVISION, quality: "preview" });
  mockGetProject.mockReturnValue(durableProject(REVISION + 1));

  const response = await POST(request());

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "revision_conflict", currentRevision: REVISION + 1 });
  expect(submitRender).not.toHaveBeenCalled();
});

test("status GET relays typed job state without caching", async () => {
  (getRenderJob as jest.Mock).mockResolvedValue({ ...job, status: "running", startedAt: 1001 });

  const response = await GET_STATUS(request(), { params: Promise.resolve({ jobId: job.id }) });

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({ ok: true, job: { id: job.id, status: "running" } });
  expect(authenticateRequest).toHaveBeenCalledTimes(1);
});

test("status GET preserves a typed not-found boundary", async () => {
  (getRenderJob as jest.Mock).mockRejectedValue(new RenderClientError(404, "job_not_found", "Render job was not found."));

  const response = await GET_STATUS(request(), { params: Promise.resolve({ jobId: "bad" }) });

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ ok: false, code: "job_not_found", message: "Render job was not found." });
});
