import { authenticateRequest, authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import {
  PROOFCANVAS_ASSET_CONTENT_LIMITS,
  sanitizeAssetFilename,
  validateAssetContent,
} from "@/lib/proofcanvas/assetContent.server";
import {
  ASSET_FILENAME_HEADER,
  EXPECTED_REVISION_HEADER,
  MUTATION_ID_HEADER,
  ProofCanvasHttpError,
  acquireAssetUploadAdmission,
  jsonNoStore,
  readBinaryRequest,
  routeFailure,
} from "@/lib/proofcanvas/http.server";
import { projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

function requiredHeader(request: Request, name: string, maximumLength: number): string {
  const value = request.headers.get(name);
  if (!value || value.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProofCanvasHttpError(400, "invalid_request", `Header ${name} is missing or invalid`);
  }
  return value;
}

function uploadMetadata(request: Request): {
  filename: string;
  expectedRevision: number;
  mutationId: string;
  claimedMimeType?: string;
} {
  if (
    request.headers.has("content-encoding")
    || request.headers.has("content-range")
    || request.headers.has("transfer-encoding")
  ) {
    throw new ProofCanvasHttpError(400, "invalid_request", "Encoded, ranged, or transfer-framed asset uploads are not accepted");
  }
  const encodedFilename = requiredHeader(request, ASSET_FILENAME_HEADER, 4_096);
  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    throw new ProofCanvasHttpError(400, "invalid_request", "Asset filename header is not canonical URI encoding");
  }
  if (encodeURIComponent(filename) !== encodedFilename) {
    throw new ProofCanvasHttpError(400, "invalid_request", "Asset filename header is not canonical URI encoding");
  }
  // Reject traversal-shaped and overlong names before admitting or reading a
  // potentially large body. validateAssetContent repeats this boundary check
  // and derives the authoritative extension after sniffing the bytes.
  sanitizeAssetFilename(filename);
  const revisionText = requiredHeader(request, EXPECTED_REVISION_HEADER, 16);
  if (!/^[1-9][0-9]*$/.test(revisionText)) throw new ProofCanvasHttpError(400, "invalid_request", "Expected revision header is invalid");
  const expectedRevision = Number(revisionText);
  if (!Number.isSafeInteger(expectedRevision)) throw new ProofCanvasHttpError(400, "invalid_request", "Expected revision header is invalid");
  const mutationId = requiredHeader(request, MUTATION_ID_HEADER, 128);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(mutationId)) throw new ProofCanvasHttpError(400, "invalid_request", "Mutation ID header is invalid");
  const contentType = requiredHeader(request, "content-type", 128);
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return {
    filename,
    expectedRevision,
    mutationId,
    ...(mediaType === "application/octet-stream" ? {} : { claimedMimeType: contentType }),
  };
}

export async function GET(request: Request, context: Context) {
  try {
    authenticateRequest(request);
    const { projectId } = await context.params;
    const assets = projectRepository().listProjectAssets(projectId).map((asset) => ({
      ...asset,
      contentUrl: `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}`,
    }));
    return jsonNoStore({ ok: true, assets });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function POST(request: Request, context: Context) {
  let releaseAdmission: (() => void) | undefined;
  try {
    authorizeStateChangingRequest(request);
    const { projectId } = await context.params;
    const metadata = uploadMetadata(request);
    releaseAdmission = acquireAssetUploadAdmission();
    const bytes = await readBinaryRequest(request, PROOFCANVAS_ASSET_CONTENT_LIMITS.maxItemBytes);
    const content = validateAssetContent({
      filename: metadata.filename,
      bytes,
      declaredSize: bytes.byteLength,
      claimedMimeType: metadata.claimedMimeType,
    });
    const result = projectRepository().uploadProjectAsset({
      projectId,
      expectedRevision: metadata.expectedRevision,
      mutationId: metadata.mutationId,
      content,
    });
    return jsonNoStore({ ok: true, asset: result.value.asset, project: {
      projectId: result.value.projectId,
      revision: result.value.revision,
      updatedAt: result.value.updatedAt,
    }, replayed: result.replayed }, 201);
  } catch (error) {
    return routeFailure(error);
  } finally {
    releaseAdmission?.();
  }
}
