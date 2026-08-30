import { authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import {
  ProofCanvasHttpError,
  PACKAGE_MUTATION_ID_HEADER,
  acquireProjectPackageAdmission,
  jsonNoStore,
  readBinaryRequest,
  routeFailure,
} from "@/lib/proofcanvas/http.server";
import { PROOFCANVAS_PROJECT_PACKAGE_LIMITS, PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE } from "@/lib/proofcanvas/projectPackage";
import { projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

function importMutationId(request: Request): string {
  if (
    request.headers.has("content-encoding")
    || request.headers.has("content-range")
    || request.headers.has("transfer-encoding")
  ) throw new ProofCanvasHttpError(400, "invalid_request", "Encoded, ranged, or transfer-framed package imports are not accepted");
  const contentType = request.headers.get("content-type");
  if (contentType?.trim().toLowerCase() !== PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE) {
    throw new ProofCanvasHttpError(415, "invalid_request", `Content-Type must be ${PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE}`);
  }
  const mutationId = request.headers.get(PACKAGE_MUTATION_ID_HEADER);
  if (!mutationId || !/^[A-Za-z0-9_-]{16,128}$/.test(mutationId)) {
    throw new ProofCanvasHttpError(400, "invalid_request", `Header ${PACKAGE_MUTATION_ID_HEADER} is missing or invalid`);
  }
  return mutationId;
}

export async function POST(request: Request) {
  let releaseAdmission: (() => void) | undefined;
  try {
    authorizeStateChangingRequest(request);
    const mutationId = importMutationId(request);
    releaseAdmission = acquireProjectPackageAdmission();
    const archiveBytes = await readBinaryRequest(request, PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxArchiveBytes);
    const result = projectRepository().importProjectPackage({ mutationId, archiveBytes });
    const value = result.value;
    return jsonNoStore({
      ok: true,
      project: {
        projectId: value.projectId,
        revision: value.revision,
        updatedAt: value.updatedAt,
        url: `/projects/${encodeURIComponent(value.projectId)}`,
      },
      source: {
        projectId: value.sourceProjectId,
        revision: value.sourceRevision,
      },
      package: { sha256: value.packageSha256 },
      replayed: result.replayed,
    }, 201);
  } catch (error) {
    return routeFailure(error);
  } finally {
    releaseAdmission?.();
  }
}
