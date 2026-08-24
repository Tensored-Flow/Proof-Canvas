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
  return {
    ProjectRepositoryError,
    projectRepository: jest.fn(() => ({ getProject })),
    __mockGetProject: getProject,
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
    submitRender: jest.fn(),
    getRenderJob: jest.fn(),
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
  getRenderJob,
  readBoundedJson,
  submitRender,
} from "@/lib/proofcanvas/renderClient.server";
import { GET as GET_STATUS } from "../[jobId]/route";
import { POST } from "../route";

const { __mockGetProject: mockGetProject } = jest.requireMock("@/lib/proofcanvas/repository.server") as {
  __mockGetProject: jest.Mock;
};

const job = {
  id: "abcdefghijklmnopqrstuvwx",
  quality: "preview" as const,
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
  process.env.PROOFCANVAS_RENDER_URL = "http://renderer.example:8080";
  process.env.PROOFCANVAS_RENDER_TOKEN = TOKEN;
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
  expect(submitRender).toHaveBeenCalledWith({ project, shotId: body.shotId, quality: body.quality });
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
