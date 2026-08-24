jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("openai", () => {
  const responsesParse = jest.fn();
  const constructor = jest.fn().mockImplementation(() => ({
    responses: { parse: responsesParse },
  }));
  return {
    __esModule: true,
    default: constructor,
    __mockResponsesParse: responsesParse,
    __mockOpenAiConstructor: constructor,
  };
});

jest.mock("@/lib/proofcanvas/auth.server", () => {
  class ProofCanvasAuthError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  }
  return {
    ProofCanvasAuthError,
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

jest.mock("next/server", () => ({
  NextResponse: {
    json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      const headers = Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      return {
        status: init.status ?? 200,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        async json() { return body; },
      };
    },
  },
}));

import { createCantorDemoProject } from "@/lib/proofcanvas/demo";
import { ProofCanvasAuthError, authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import { POST } from "../route";

const {
  __mockResponsesParse: mockResponsesParse,
  __mockOpenAiConstructor: mockOpenAiConstructor,
} = jest.requireMock("openai") as {
  __mockResponsesParse: jest.Mock;
  __mockOpenAiConstructor: jest.Mock;
};
const { __mockGetProject: mockGetProject } = jest.requireMock("@/lib/proofcanvas/repository.server") as {
  __mockGetProject: jest.Mock;
};

const ORIGINAL_ENV = { ...process.env };
const PROJECT_ID = "project-0123456789abcdef01234567";
const REVISION = 7;

function durableProject(document = createCantorDemoProject(), revision = REVISION) {
  return {
    id: PROJECT_ID,
    title: document.metadata.title,
    revision,
    createdAt: document.metadata.createdAt,
    updatedAt: document.metadata.updatedAt,
    thumbnail: null,
    shotCount: document.shots.length,
    objectCount: document.shots.reduce((sum, shot) => sum + shot.objects.length, 0),
    durationSeconds: document.shots.reduce((sum, shot) => sum + shot.duration, 0),
    document,
  };
}

function setProviderEnvironment(available: boolean) {
  if (available) {
    process.env.OPENAI_API_KEY = "server-only-test-key";
    process.env.PROOFCANVAS_OPENAI_MODEL = "test-model-from-env";
  } else {
    delete process.env.OPENAI_API_KEY;
    delete process.env.PROOFCANVAS_OPENAI_MODEL;
  }
}

function request(body: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const normalized = {
    "content-type": "application/json",
    ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
  };
  const bytes = Buffer.from(raw, "utf8");
  return {
    headers: { get: (name: string) => normalized[name.toLowerCase() as keyof typeof normalized] ?? null },
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() { sent = true; },
          releaseLock() {},
        };
      },
    },
  } as unknown as Request;
}

function validBody() {
  return {
    projectId: PROJECT_ID,
    revision: REVISION,
    shotId: "shot-cantor-construction",
    selectedObjectIds: ["object-title"],
    instruction: "Move this title left.",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResponsesParse.mockReset();
  mockOpenAiConstructor.mockClear();
  (authorizeStateChangingRequest as jest.Mock).mockReturnValue({ tokenHash: "session" });
  mockGetProject.mockReturnValue(durableProject());
  setProviderEnvironment(false);
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

test("rejects malformed request bodies before provider resolution", async () => {
  setProviderEnvironment(true);
  const response = await POST(request({ ...validBody(), unexpected: true }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, code: "invalid_request" });
  expect(mockOpenAiConstructor).not.toHaveBeenCalled();
});

test("rejects caller-supplied project data instead of trusting it", async () => {
  setProviderEnvironment(true);
  const response = await POST(request({ ...validBody(), project: createCantorDemoProject() }));

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, code: "invalid_request" });
  expect(mockGetProject).not.toHaveBeenCalled();
  expect(mockOpenAiConstructor).not.toHaveBeenCalled();
  expect(mockResponsesParse).not.toHaveBeenCalled();
});

test("authenticates before provider configuration or request-body work", async () => {
  let bodyRead = false;
  (authorizeStateChangingRequest as jest.Mock).mockImplementation(() => {
    throw new ProofCanvasAuthError(401, "unauthenticated", "Authentication is required");
  });
  const unauthenticated = {
    headers: { get: () => null },
    body: {
      getReader() {
        bodyRead = true;
        throw new Error("body must not be read");
      },
    },
  } as unknown as Request;

  const response = await POST(unauthenticated);

  expect(response.status).toBe(401);
  expect(bodyRead).toBe(false);
  expect(mockOpenAiConstructor).not.toHaveBeenCalled();
  expect(mockGetProject).not.toHaveBeenCalled();
});

test("returns typed provider_unavailable without key and model configuration", async () => {
  const response = await POST(request(validBody()));
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({
    ok: false,
    code: "provider_unavailable",
    message: "OpenAI editing is not configured; use the labelled deterministic demo interpreter.",
  });
  expect(mockOpenAiConstructor).not.toHaveBeenCalled();
});

test("returns provider_unavailable without reading an unavailable endpoint body", async () => {
  let bodyRead = false;
  const unavailableRequest = {
    headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null },
    body: {
      getReader() {
        bodyRead = true;
        throw new Error("body must not be read");
      },
    },
  } as unknown as Request;

  const response = await POST(unavailableRequest);

  expect(response.status).toBe(503);
  expect(bodyRead).toBe(false);
  expect(mockOpenAiConstructor).not.toHaveBeenCalled();
});

test("returns a validated configured-provider proposal from mocked OpenAI", async () => {
  setProviderEnvironment(true);
  mockResponsesParse.mockResolvedValue({
    output_parsed: {
      intention: "Move the title left.",
      summary: ["Move title."],
      operations: [{
        type: "update-object",
        objectId: "object-title",
        patch: [{ field: "transform.x", value: 190 }],
      }],
    },
  });

  const response = await POST(request(validBody()));
  const payload = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(payload).toMatchObject({
    ok: true,
    provider: "configured-provider",
    demoMode: false,
    operations: [{ type: "update-object", objectId: "object-title", patch: { transform: { x: 190 } } }],
  });
  expect(JSON.stringify(payload)).not.toContain("server-only-test-key");
  expect(mockOpenAiConstructor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "server-only-test-key" }));
  expect(mockResponsesParse).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model-from-env", store: false }));
  expect(mockGetProject).toHaveBeenCalledWith(PROJECT_ID);
});

test("maps inherited-lock provider output to a fail-closed response", async () => {
  setProviderEnvironment(true);
  const project = createCantorDemoProject();
  project.shots[0].objects.find(({ id }) => id === "object-interval-diagram")!.locked = true;
  mockGetProject.mockReturnValue(durableProject(project));
  const body = validBody();
  body.selectedObjectIds = ["object-interval-left-1"];
  mockResponsesParse.mockResolvedValue({
    output_parsed: {
      intention: "Move a child.",
      summary: ["Move a child."],
      operations: [{
        type: "update-object",
        objectId: "object-interval-left-1",
        patch: [{ field: "transform.x", value: 330 }],
      }],
    },
  });

  const response = await POST(request(body));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ ok: false, code: "invalid_provider_output" });
});

test("rejects a stale durable revision before invoking the provider", async () => {
  setProviderEnvironment(true);
  mockGetProject.mockReturnValue(durableProject(createCantorDemoProject(), REVISION + 1));

  const response = await POST(request(validBody()));

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    ok: false,
    code: "revision_conflict",
    currentRevision: REVISION + 1,
  });
  expect(mockOpenAiConstructor).not.toHaveBeenCalled();
});

test("rejects declared oversized bodies without reading or calling OpenAI", async () => {
  setProviderEnvironment(true);
  const response = await POST(request(validBody(), { "content-length": String(192 * 1024 + 1) }));
  expect(response.status).toBe(413);
  expect(mockOpenAiConstructor).not.toHaveBeenCalled();
});

test("stream-bounds an oversized body without a content-length declaration", async () => {
  setProviderEnvironment(true);
  const raw = JSON.stringify(validBody()) + " ".repeat(192 * 1024);
  const oversized = request(raw);

  const response = await POST(oversized);

  expect(response.status).toBe(413);
  expect(mockOpenAiConstructor).not.toHaveBeenCalled();
});
