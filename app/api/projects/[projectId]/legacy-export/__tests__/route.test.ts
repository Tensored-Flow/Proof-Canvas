/** @jest-environment node */

jest.mock("next/server", () => ({
  NextResponse: {
    json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: init.headers });
    },
  },
}));

jest.mock("@/lib/proofcanvas/auth.server", () => {
  class ProofCanvasAuthError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  return { ProofCanvasAuthError, authenticateRequest: jest.fn() };
});

jest.mock("@/lib/proofcanvas/repository.server", () => {
  class ProjectRepositoryError extends Error {
    constructor(public status: number, public code: string, message: string, public currentRevision?: number) { super(message); }
  }
  const legacyRecoveryDocument = jest.fn();
  return {
    ProjectRepositoryError,
    projectRepository: jest.fn(() => ({ legacyRecoveryDocument })),
    __mockLegacyRecoveryDocument: legacyRecoveryDocument,
  };
});

import { createHash } from "node:crypto";
import { ProofCanvasAuthError, authenticateRequest } from "@/lib/proofcanvas/auth.server";
import { GET } from "../route";

const { __mockLegacyRecoveryDocument: legacyRecoveryDocument } = jest.requireMock("@/lib/proofcanvas/repository.server") as {
  __mockLegacyRecoveryDocument: jest.Mock;
};

const context = { params: Promise.resolve({ projectId: "project-111111111111111111111111" }) };

beforeEach(() => jest.clearAllMocks());

test("streams authenticated archived UTF-8 bytes exactly with recovery headers", async () => {
  const exact = "{\n  \"schemaVersion\": 2,\n  \"title\": \"π proof\"\n}\n";
  const sha256 = createHash("sha256").update(exact, "utf8").digest("hex");
  legacyRecoveryDocument.mockReturnValue({
    ownerType: "project",
    ownerId: "project-111111111111111111111111",
    projectId: "project-111111111111111111111111",
    sha256,
    reason: "test",
    documentJson: exact,
  });
  const response = await GET(new Request("http://localhost/api/projects/project-111111111111111111111111/legacy-export"), context);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(exact, "utf8"));
  expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(exact, "utf8")));
  expect(response.headers.get("x-proofcanvas-document-sha256")).toBe(sha256);
  expect(response.headers.get("content-disposition")).toContain("schema-v2-exact.json");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(legacyRecoveryDocument).toHaveBeenCalledWith({ projectId: "project-111111111111111111111111" });
});

test("authenticates before reading an archive and forwards checkpoint identity", async () => {
  (authenticateRequest as jest.Mock).mockImplementationOnce(() => { throw new ProofCanvasAuthError(401, "unauthorized", "Login required"); });
  const denied = await GET(new Request("http://localhost/api/projects/project-111111111111111111111111/legacy-export?checkpointId=checkpoint-222222222222222222222222"), context);
  expect(denied.status).toBe(401);
  expect(legacyRecoveryDocument).not.toHaveBeenCalled();

  legacyRecoveryDocument.mockReturnValue({
    ownerType: "checkpoint",
    ownerId: "checkpoint-222222222222222222222222",
    projectId: "project-111111111111111111111111",
    sha256: "a".repeat(64),
    reason: "test",
    documentJson: "{}\n",
  });
  await GET(new Request("http://localhost/api/projects/project-111111111111111111111111/legacy-export?checkpointId=checkpoint-222222222222222222222222"), context);
  expect(legacyRecoveryDocument).toHaveBeenCalledWith({
    projectId: "project-111111111111111111111111",
    checkpointId: "checkpoint-222222222222222222222222",
  });
});
