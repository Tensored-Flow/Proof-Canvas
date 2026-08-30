import { authenticateRequest } from "@/lib/proofcanvas/auth.server";
import { routeFailure } from "@/lib/proofcanvas/http.server";
import { RenderClientError, fetchRenderStill } from "@/lib/proofcanvas/renderClient.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const FAILURE_HEADERS = { "Cache-Control": "no-store, max-age=0", "Content-Type": "application/json", "X-Robots-Tag": "noindex, nofollow" };

function failure(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ ok: false, code, message }), { status, headers: FAILURE_HEADERS });
}

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    authenticateRequest(request);
    const { jobId } = await context.params;
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has("time")) {
      throw new RenderClientError(400, "invalid_still_time", "Still export requires exactly one time value.");
    }
    const still = await fetchRenderStill(jobId, Number(url.searchParams.get("time")));
    return new Response(still.body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `inline; filename="proofcanvas-${jobId}-${still.timeSeconds.toFixed(3)}s.png"`,
        "Content-Length": String(still.bytes),
        "Content-Type": "image/png",
        "X-ProofCanvas-Source-SHA256": still.sourceSha256,
        "X-ProofCanvas-Still-SHA256": still.stillSha256,
        "X-ProofCanvas-Still-Time": String(still.timeSeconds),
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    if (error instanceof RenderClientError) return failure(error.status, error.code, error.message);
    return routeFailure(error);
  }
}
