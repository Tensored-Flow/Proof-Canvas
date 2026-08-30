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
    listProjectAssets: jest.fn(),
    getProjectAsset: jest.fn(),
    uploadProjectAsset: jest.fn(),
    deleteProjectAsset: jest.fn(),
  };
  return {
    ProjectRepositoryError,
    projectRepository: jest.fn(() => repository),
    __mockAssetRepository: repository,
  };
});

import { createHash } from "node:crypto";
import { ProofCanvasAuthError, authenticateRequest, authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import { ProjectRepositoryError } from "@/lib/proofcanvas/repository.server";
import { PROOFCANVAS_ASSET_CONTENT_LIMITS } from "@/lib/proofcanvas/assetContent.server";
import {
  ASSET_FILENAME_HEADER,
  EXPECTED_REVISION_HEADER,
  MUTATION_ID_HEADER,
  acquireAssetUploadAdmission,
} from "@/lib/proofcanvas/http.server";
import { GET as LIST, POST } from "../route";
import { DELETE, GET as READ } from "../[assetId]/route";

const { __mockAssetRepository: repository } = jest.requireMock("@/lib/proofcanvas/repository.server") as {
  __mockAssetRepository: {
    listProjectAssets: jest.Mock;
    getProjectAsset: jest.Mock;
    uploadProjectAsset: jest.Mock;
    deleteProjectAsset: jest.Mock;
  };
};

const PROJECT_ID = "project-111111111111111111111111";
const OTHER_PROJECT_ID = "project-222222222222222222222222";
const ASSET_ID = "asset-333333333333333333333333";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_SHA256 = createHash("sha256").update(PNG).digest("hex");
const JPEG = Buffer.from(
  "/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AFZGiJ//2Q==",
  "base64",
);
const WEBP = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAEAfQ43IUtYCBiOh/AAA=", "base64");
const PNG_ASSET = {
  id: ASSET_ID,
  filename: "dot.png",
  mimeType: "image/png" as const,
  size: PNG.length,
  sha256: PNG_SHA256,
  width: 1,
  height: 1,
  provenance: "uploaded" as const,
};
const collectionContext = (projectId = PROJECT_ID) => ({ params: Promise.resolve({ projectId }) });
const itemContext = (projectId = PROJECT_ID, assetId = ASSET_ID) => ({ params: Promise.resolve({ projectId, assetId }) });

function uploadRequest(
  bytes: Uint8Array = PNG,
  headers: Record<string, string | null> = {},
): Request {
  const requestHeaders = new Headers({
    "content-type": "image/png",
    "content-length": String(bytes.byteLength),
    [ASSET_FILENAME_HEADER]: encodeURIComponent("dot.png"),
    [EXPECTED_REVISION_HEADER]: "1",
    [MUTATION_ID_HEADER]: "mutation-upload-route-png",
  });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) requestHeaders.delete(name);
    else requestHeaders.set(name, value);
  }
  return new Request(`http://localhost/api/projects/${PROJECT_ID}/assets`, {
    method: "POST",
    headers: requestHeaders,
    body: Uint8Array.from(bytes),
  });
}

function decodedImageUploadRequest(
  bytes: Uint8Array,
  mimeType: "image/jpeg" | "image/webp",
  filename: string,
  mutationId: string,
): Request {
  return new Request(`http://localhost/api/projects/${PROJECT_ID}/assets`, {
    method: "POST",
    headers: {
      "content-type": mimeType,
      "content-length": String(bytes.byteLength),
      [ASSET_FILENAME_HEADER]: encodeURIComponent(filename),
      [EXPECTED_REVISION_HEADER]: "1",
      [MUTATION_ID_HEADER]: mutationId,
    },
    body: Uint8Array.from(bytes),
  });
}

beforeEach(() => jest.clearAllMocks());

test("lists only authenticated project-scoped metadata with no-store content URLs", async () => {
  repository.listProjectAssets.mockReturnValue([{ ...PNG_ASSET, available: true }]);
  const response = await LIST(new Request(`http://localhost/api/projects/${PROJECT_ID}/assets`), collectionContext());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    assets: [{
      ...PNG_ASSET,
      available: true,
      contentUrl: `/api/projects/${PROJECT_ID}/assets/${ASSET_ID}`,
    }],
  });
  expect(authenticateRequest).toHaveBeenCalledTimes(1);
  expect(repository.listProjectAssets).toHaveBeenCalledWith(PROJECT_ID);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

test("authenticates and authorizes before touching repository or upload body", async () => {
  (authenticateRequest as jest.Mock).mockImplementationOnce(() => {
    throw new ProofCanvasAuthError(401, "unauthorized", "Login required");
  });
  const deniedList = await LIST(new Request(`http://localhost/api/projects/${PROJECT_ID}/assets`), collectionContext());
  expect(deniedList.status).toBe(401);
  expect(repository.listProjectAssets).not.toHaveBeenCalled();

  let bodyReads = 0;
  const request = {
    headers: uploadRequest().headers,
    body: { getReader() { bodyReads += 1; throw new Error("body must not be read"); } },
  } as unknown as Request;
  (authorizeStateChangingRequest as jest.Mock).mockImplementationOnce(() => {
    throw new ProofCanvasAuthError(403, "invalid_origin", "Invalid origin");
  });
  const deniedUpload = await POST(request, collectionContext());
  expect(deniedUpload.status).toBe(403);
  expect(bodyReads).toBe(0);
  expect(repository.uploadProjectAsset).not.toHaveBeenCalled();
});

test("admits an exact raw upload and returns revision and replay authority", async () => {
  repository.uploadProjectAsset.mockReturnValue({
    replayed: false,
    value: { projectId: PROJECT_ID, revision: 2, updatedAt: "2026-08-26T12:00:00.000Z", asset: PNG_ASSET },
  });
  const response = await POST(uploadRequest(), collectionContext());
  expect(response.status).toBe(201);
  expect(authorizeStateChangingRequest).toHaveBeenCalledTimes(1);
  expect(repository.uploadProjectAsset).toHaveBeenCalledWith(expect.objectContaining({
    projectId: PROJECT_ID,
    expectedRevision: 1,
    mutationId: "mutation-upload-route-png",
    content: expect.objectContaining({
      filename: "dot.png",
      mimeType: "image/png",
      size: PNG.length,
      sha256: PNG_SHA256,
      width: 1,
      height: 1,
    }),
  }));
  expect(await response.json()).toEqual({
    ok: true,
    asset: PNG_ASSET,
    project: { projectId: PROJECT_ID, revision: 2, updatedAt: "2026-08-26T12:00:00.000Z" },
    replayed: false,
  });
});

test.each([
  ["JPEG", JPEG, "image/jpeg", "photo.jpeg", "photo.jpg", "mutation-upload-route-jpeg"],
  ["WebP", WEBP, "image/webp", "diagram.png", "diagram.webp", "mutation-upload-route-webp"],
] as const)("fully validates, uploads, and serves project-local %s bytes", async (
  _label,
  bytes,
  mimeType,
  inputFilename,
  storedFilename,
  mutationId,
) => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const asset = {
    id: ASSET_ID,
    filename: storedFilename,
    mimeType,
    size: bytes.length,
    sha256,
    width: 3,
    height: 2,
    provenance: "uploaded" as const,
  };
  repository.uploadProjectAsset.mockReturnValue({
    replayed: false,
    value: { projectId: PROJECT_ID, revision: 2, updatedAt: "2026-08-26T12:00:00.000Z", asset },
  });
  const uploadResponse = await POST(
    decodedImageUploadRequest(bytes, mimeType, inputFilename, mutationId),
    collectionContext(),
  );
  expect(uploadResponse.status).toBe(201);
  expect(repository.uploadProjectAsset).toHaveBeenCalledWith(expect.objectContaining({
    projectId: PROJECT_ID,
    content: expect.objectContaining({
      filename: storedFilename,
      mimeType,
      size: bytes.length,
      sha256,
      width: 3,
      height: 2,
    }),
  }));

  repository.getProjectAsset.mockReturnValue({ asset, bytes: Buffer.from(bytes) });
  const readResponse = await READ(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/assets/${ASSET_ID}`),
    itemContext(),
  );
  expect(readResponse.status).toBe(200);
  expect(Buffer.from(await readResponse.arrayBuffer())).toEqual(bytes);
  expect(readResponse.headers.get("content-type")).toBe(mimeType);
  expect(readResponse.headers.get("content-length")).toBe(String(bytes.length));
  expect(readResponse.headers.get("content-disposition")).toBe(`inline; filename="${storedFilename}"`);
  expect(readResponse.headers.get("x-content-type-options")).toBe("nosniff");
  expect(readResponse.headers.get("cross-origin-resource-policy")).toBe("same-origin");
});

test("admits only one in-process upload body at a time and releases capacity deterministically", async () => {
  const release = acquireAssetUploadAdmission();
  try {
    const busy = await POST(uploadRequest(), collectionContext());
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual(expect.objectContaining({ code: "upload_busy" }));
    expect(repository.uploadProjectAsset).not.toHaveBeenCalled();
  } finally {
    release();
    release();
  }
  repository.uploadProjectAsset.mockReturnValue({
    replayed: false,
    value: { projectId: PROJECT_ID, revision: 2, updatedAt: "2026-08-26T12:00:00.000Z", asset: PNG_ASSET },
  });
  expect((await POST(uploadRequest(), collectionContext())).status).toBe(201);
});

test("rejects absent, oversized, mismatched, noncanonical, traversal, and MIME-conflicting uploads", async () => {
  const missingLength = uploadRequest(PNG, { "content-length": null });
  expect((await POST(missingLength, collectionContext())).status).toBe(411);

  const oversized = uploadRequest(PNG, { "content-length": String(PROOFCANVAS_ASSET_CONTENT_LIMITS.maxItemBytes + 1) });
  expect((await POST(oversized, collectionContext())).status).toBe(413);

  const short = uploadRequest(PNG, { "content-length": String(PNG.length + 1) });
  const shortResponse = await POST(short, collectionContext());
  expect(shortResponse.status).toBe(400);
  expect(await shortResponse.json()).toEqual(expect.objectContaining({ code: "content_length_mismatch" }));

  const noncanonical = uploadRequest(PNG, { [ASSET_FILENAME_HEADER]: "%64ot.png" });
  expect((await POST(noncanonical, collectionContext())).status).toBe(400);

  const encoded = uploadRequest(PNG, { "content-encoding": "gzip" });
  expect((await POST(encoded, collectionContext())).status).toBe(400);

  let traversalBodyReads = 0;
  const traversalHeaders = uploadRequest(PNG, { [ASSET_FILENAME_HEADER]: "..%2Fsecret.png" }).headers;
  const traversal = {
    headers: traversalHeaders,
    get body() {
      traversalBodyReads += 1;
      throw new Error("unsafe filename must fail before body access");
    },
  } as unknown as Request;
  const traversalResponse = await POST(traversal, collectionContext());
  expect(traversalResponse.status).toBe(400);
  expect(await traversalResponse.json()).toEqual(expect.objectContaining({ code: "invalid_filename" }));
  expect(traversalBodyReads).toBe(0);

  const mismatch = uploadRequest(PNG, { "content-type": "image/jpeg" });
  const mismatchResponse = await POST(mismatch, collectionContext());
  expect(mismatchResponse.status).toBe(415);
  expect(await mismatchResponse.json()).toEqual(expect.objectContaining({ code: "mime_mismatch" }));
  expect(repository.uploadProjectAsset).not.toHaveBeenCalled();
});

test("serves authenticated project-scoped bytes with hardened headers", async () => {
  repository.getProjectAsset.mockReturnValue({ asset: PNG_ASSET, bytes: Buffer.from(PNG) });
  const response = await READ(new Request(`http://localhost/api/projects/${PROJECT_ID}/assets/${ASSET_ID}`), itemContext());
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
  expect(repository.getProjectAsset).toHaveBeenCalledWith({ projectId: PROJECT_ID, assetId: ASSET_ID });
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("content-length")).toBe(String(PNG.length));
  expect(response.headers.get("content-disposition")).toBe('inline; filename="dot.png"');
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("etag")).toBe(`"sha256-${PNG_SHA256}"`);
  expect(response.headers.get("content-security-policy")).toBeNull();
});

test("adds a sandboxed CSP for SVG and maps cross-project denial without leaking storage internals", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>', "utf8");
  repository.getProjectAsset.mockReturnValueOnce({
    asset: { ...PNG_ASSET, filename: "safe.svg", mimeType: "image/svg+xml", size: svg.length },
    bytes: svg,
  });
  const svgResponse = await READ(new Request(`http://localhost/api/projects/${PROJECT_ID}/assets/${ASSET_ID}`), itemContext());
  expect(svgResponse.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");

  repository.getProjectAsset.mockImplementationOnce(() => {
    throw new ProjectRepositoryError(404, "asset_not_found", "Asset was not found");
  });
  const denied = await READ(
    new Request(`http://localhost/api/projects/${OTHER_PROJECT_ID}/assets/${ASSET_ID}`),
    itemContext(OTHER_PROJECT_ID),
  );
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ ok: false, code: "asset_not_found", message: "Asset was not found" });
  expect(repository.getProjectAsset).toHaveBeenLastCalledWith({ projectId: OTHER_PROJECT_ID, assetId: ASSET_ID });

  repository.getProjectAsset.mockImplementationOnce(() => {
    throw new ProjectRepositoryError(500, "repository_corrupt", "secret sqlite path");
  });
  const corrupt = await READ(new Request(`http://localhost/api/projects/${PROJECT_ID}/assets/${ASSET_ID}`), itemContext());
  expect(corrupt.status).toBe(500);
  expect(JSON.stringify(await corrupt.json())).not.toContain("secret sqlite path");
});

test("deletes through owner authorization and maps in-use refusal", async () => {
  repository.deleteProjectAsset.mockReturnValueOnce({
    replayed: false,
    value: { projectId: PROJECT_ID, revision: 3, updatedAt: "2026-08-26T12:01:00.000Z", assetId: ASSET_ID },
  });
  const deleteRequest = () => new Request(`http://localhost/api/projects/${PROJECT_ID}/assets/${ASSET_ID}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 2, mutationId: "mutation-delete-route-asset" }),
  });
  const response = await DELETE(deleteRequest(), itemContext());
  expect(response.status).toBe(200);
  expect(authorizeStateChangingRequest).toHaveBeenCalledTimes(1);
  expect(repository.deleteProjectAsset).toHaveBeenCalledWith({
    projectId: PROJECT_ID,
    assetId: ASSET_ID,
    expectedRevision: 2,
    mutationId: "mutation-delete-route-asset",
  });

  repository.deleteProjectAsset.mockImplementationOnce(() => {
    throw new ProjectRepositoryError(409, "asset_in_use", "Asset is used by an object");
  });
  const refused = await DELETE(deleteRequest(), itemContext());
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual(expect.objectContaining({ code: "asset_in_use" }));
});
