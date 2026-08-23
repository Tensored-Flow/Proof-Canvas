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
import { PROOFCANVAS_SCHEMA_LIMITS, cloneSerializable } from "@/lib/proofcanvas/schema";
import { POST } from "../route";

const {
  __mockResponsesParse: mockResponsesParse,
  __mockOpenAiConstructor: mockOpenAiConstructor,
} = jest.requireMock("openai") as {
  __mockResponsesParse: jest.Mock;
  __mockOpenAiConstructor: jest.Mock;
};

const ORIGINAL_ENV = { ...process.env };

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
    project: createCantorDemoProject(),
    shotId: "shot-cantor-construction",
    selectedObjectIds: ["object-title"],
    instruction: "Move this title left.",
  };
}

beforeEach(() => {
  mockResponsesParse.mockReset();
  mockOpenAiConstructor.mockClear();
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

test("rejects a structurally oversized project before calling OpenAI", async () => {
  setProviderEnvironment(true);
  const body = validBody();
  const style = body.project.styles[0];
  body.project.styles = Array.from(
    { length: PROOFCANVAS_SCHEMA_LIMITS.styles + 1 },
    (_, index) => ({ ...cloneSerializable(style), id: `style-api-limit-${index}` }),
  );

  const response = await POST(request(body));

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, code: "invalid_request" });
  expect(mockOpenAiConstructor).not.toHaveBeenCalled();
  expect(mockResponsesParse).not.toHaveBeenCalled();
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
});

test("maps inherited-lock provider output to a fail-closed response", async () => {
  setProviderEnvironment(true);
  const body = validBody();
  body.project.shots[0].objects.find(({ id }) => id === "object-interval-diagram")!.locked = true;
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
