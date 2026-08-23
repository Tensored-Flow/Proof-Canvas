import { NextResponse } from "next/server";
import { RenderClientError, getRenderJob } from "@/lib/proofcanvas/renderClient.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

function json(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" },
  });
}

export async function GET(_: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    return json({ ok: true, job: await getRenderJob(jobId) });
  } catch (error) {
    if (error instanceof RenderClientError) return json({ ok: false, code: error.code, message: error.message }, error.status);
    return json({ ok: false, code: "renderer_error", message: "ProofCanvas rendering could not complete the request." }, 500);
  }
}
