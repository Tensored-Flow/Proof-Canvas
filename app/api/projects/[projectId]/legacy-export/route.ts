import { Buffer } from "node:buffer";
import { authenticateRequest } from "@/lib/proofcanvas/auth.server";
import { NO_STORE_HEADERS, routeFailure } from "@/lib/proofcanvas/http.server";
import { projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    authenticateRequest(request);
    const { projectId } = await context.params;
    const checkpointId = new URL(request.url).searchParams.get("checkpointId") ?? undefined;
    const recovery = projectRepository().legacyRecoveryDocument({ projectId, ...(checkpointId ? { checkpointId } : {}) });
    const filename = `${recovery.ownerType}-${recovery.ownerId}-schema-v2-exact.json`;
    const exactBytes = Buffer.from(recovery.documentJson, "utf8");
    return new Response(exactBytes, {
      status: 200,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(exactBytes.byteLength),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-ProofCanvas-Document-SHA256": recovery.sha256,
      },
    });
  } catch (error) {
    return routeFailure(error);
  }
}
