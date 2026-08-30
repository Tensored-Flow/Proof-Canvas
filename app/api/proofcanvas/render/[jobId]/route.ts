import { NextResponse } from "next/server";
import { authenticateRequest, authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import { routeFailure } from "@/lib/proofcanvas/http.server";
import { RenderClientError, cancelRenderJob, getRenderJob } from "@/lib/proofcanvas/renderClient.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

function json(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" },
  });
}

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    authenticateRequest(request);
    const { jobId } = await context.params;
    return json({ ok: true, job: await getRenderJob(jobId) });
  } catch (error) {
    if (error instanceof RenderClientError) return json({ ok: false, code: error.code, message: error.message }, error.status);
    return routeFailure(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    authorizeStateChangingRequest(request);
    const { jobId } = await context.params;
    return json({ ok: true, job: await cancelRenderJob(jobId) });
  } catch (error) {
    if (error instanceof RenderClientError) return json({ ok: false, code: error.code, message: error.message }, error.status);
    return routeFailure(error);
  }
}
