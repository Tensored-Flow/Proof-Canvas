import { authenticateRequest } from "@/lib/proofcanvas/auth.server";
import { NO_STORE_HEADERS, routeFailure } from "@/lib/proofcanvas/http.server";
import { PROOFCANVAS_PROJECT_PACKAGE_EXTENSION, PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE } from "@/lib/proofcanvas/projectPackage";
import { projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    authenticateRequest(request);
    const { projectId } = await context.params;
    const built = projectRepository().exportProjectPackage(projectId);
    return new Response(built.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE,
        "Content-Length": String(built.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${projectId}${PROOFCANVAS_PROJECT_PACKAGE_EXTENSION}"`,
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-ProofCanvas-Package-Sha256": built.sha256,
        "X-ProofCanvas-Source-Revision": String(built.manifest.source.revision),
      },
    });
  } catch (error) {
    return routeFailure(error);
  }
}
