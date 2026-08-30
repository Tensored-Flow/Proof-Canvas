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
    ) { super(message); }
  }
  const repository = {
    exportProjectPackage: jest.fn(),
    importProjectPackage: jest.fn(),
  };
  return {
    ProjectRepositoryError,
    projectRepository: jest.fn(() => repository),
    __mockPackageRepository: repository,
  };
});

import { ProofCanvasAuthError, authenticateRequest, authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import { PACKAGE_MUTATION_ID_HEADER, acquireAssetUploadAdmission } from "@/lib/proofcanvas/http.server";
import { PROOFCANVAS_PROJECT_PACKAGE_LIMITS, PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE, ProjectPackageError } from "@/lib/proofcanvas/projectPackage";
import { GET as EXPORT } from "../../[projectId]/package/route";
import { POST as IMPORT } from "../route";

const { __mockPackageRepository: repository } = jest.requireMock("@/lib/proofcanvas/repository.server") as {
  __mockPackageRepository: {
    exportProjectPackage: jest.Mock;
    importProjectPackage: jest.Mock;
  };
};

const SOURCE_ID = "project-111111111111111111111111";
const IMPORTED_ID = "project-222222222222222222222222";
const PACKAGE_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const PACKAGE_SHA = "a".repeat(64);
const exportContext = { params: Promise.resolve({ projectId: SOURCE_ID }) };

function importRequest(
  bytes: Uint8Array = PACKAGE_BYTES,
  overrides: Record<string, string | null> = {},
): Request {
  const headers = new Headers({
    "content-type": PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE,
    "content-length": String(bytes.byteLength),
    [PACKAGE_MUTATION_ID_HEADER]: "mutation-import-route-package",
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request("http://localhost/api/projects/import", {
    method: "POST",
    headers,
    body: Uint8Array.from(bytes),
  });
}

beforeEach(() => jest.clearAllMocks());

test("exports the authenticated current package with exact attachment and audit headers", async () => {
  repository.exportProjectPackage.mockReturnValue({
    bytes: PACKAGE_BYTES,
    sha256: PACKAGE_SHA,
    manifest: { source: { projectId: SOURCE_ID, revision: 7 } },
  });
  const response = await EXPORT(new Request(`http://localhost/api/projects/${SOURCE_ID}/package`), exportContext);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(PACKAGE_BYTES);
  expect(authenticateRequest).toHaveBeenCalledTimes(1);
  expect(repository.exportProjectPackage).toHaveBeenCalledWith(SOURCE_ID);
  expect(response.headers.get("content-type")).toBe(PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE);
  expect(response.headers.get("content-length")).toBe(String(PACKAGE_BYTES.length));
  expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${SOURCE_ID}.proofcanvas"`);
  expect(response.headers.get("x-proofcanvas-package-sha256")).toBe(PACKAGE_SHA);
  expect(response.headers.get("x-proofcanvas-source-revision")).toBe("7");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
});

test("authenticates export and authorizes import before repository or body access", async () => {
  (authenticateRequest as jest.Mock).mockImplementationOnce(() => {
    throw new ProofCanvasAuthError(401, "unauthorized", "Login required");
  });
  expect((await EXPORT(new Request(`http://localhost/api/projects/${SOURCE_ID}/package`), exportContext)).status).toBe(401);
  expect(repository.exportProjectPackage).not.toHaveBeenCalled();

  let bodyReads = 0;
  const deniedRequest = {
    headers: importRequest().headers,
    body: { getReader() { bodyReads += 1; throw new Error("body must not be read"); } },
  } as unknown as Request;
  (authorizeStateChangingRequest as jest.Mock).mockImplementationOnce(() => {
    throw new ProofCanvasAuthError(403, "invalid_csrf", "Invalid CSRF");
  });
  expect((await IMPORT(deniedRequest)).status).toBe(403);
  expect(bodyReads).toBe(0);
  expect(repository.importProjectPackage).not.toHaveBeenCalled();
});

test("imports one exact bounded archive and returns a fresh durable project URL with source audit", async () => {
  repository.importProjectPackage.mockReturnValue({
    replayed: false,
    value: {
      projectId: IMPORTED_ID,
      revision: 1,
      updatedAt: "2026-08-26T13:00:00.000Z",
      sourceProjectId: SOURCE_ID,
      sourceRevision: 7,
      packageSha256: PACKAGE_SHA,
    },
  });
  const response = await IMPORT(importRequest());
  expect(response.status).toBe(201);
  expect(authorizeStateChangingRequest).toHaveBeenCalledTimes(1);
  expect(repository.importProjectPackage).toHaveBeenCalledWith({
    mutationId: "mutation-import-route-package",
    archiveBytes: expect.any(Uint8Array),
  });
  expect(Buffer.from(repository.importProjectPackage.mock.calls[0][0].archiveBytes)).toEqual(PACKAGE_BYTES);
  expect(await response.json()).toEqual({
    ok: true,
    project: {
      projectId: IMPORTED_ID,
      revision: 1,
      updatedAt: "2026-08-26T13:00:00.000Z",
      url: `/projects/${IMPORTED_ID}`,
    },
    source: { projectId: SOURCE_ID, revision: 7 },
    package: { sha256: PACKAGE_SHA },
    replayed: false,
  });
});

test("rejects unsafe framing, wrong media type, missing length, mismatch, and oversize before import", async () => {
  expect((await IMPORT(importRequest(PACKAGE_BYTES, { "content-type": "application/zip" }))).status).toBe(415);
  expect((await IMPORT(importRequest(PACKAGE_BYTES, { "content-encoding": "gzip" }))).status).toBe(400);
  expect((await IMPORT(importRequest(PACKAGE_BYTES, { "content-length": null }))).status).toBe(411);
  expect((await IMPORT(importRequest(PACKAGE_BYTES, { "content-length": String(PACKAGE_BYTES.length + 1) }))).status).toBe(400);
  expect((await IMPORT(importRequest(PACKAGE_BYTES, {
    "content-length": String(PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxArchiveBytes + 1),
  }))).status).toBe(413);
  expect(repository.importProjectPackage).not.toHaveBeenCalled();
});

test("shares one binary-validation admission and maps typed package errors without details", async () => {
  const release = acquireAssetUploadAdmission();
  try {
    const busy = await IMPORT(importRequest());
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual(expect.objectContaining({ code: "package_busy" }));
  } finally {
    release();
  }

  repository.importProjectPackage.mockImplementationOnce(() => {
    throw new ProjectPackageError("crc_mismatch", "ZIP entry failed CRC validation", { privateOffset: 42 });
  });
  const invalid = await IMPORT(importRequest());
  expect(invalid.status).toBe(400);
  const body = await invalid.json();
  expect(body).toEqual({ ok: false, code: "crc_mismatch", message: "ZIP entry failed CRC validation" });
  expect(JSON.stringify(body)).not.toContain("privateOffset");
});
