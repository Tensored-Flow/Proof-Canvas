import { RenderClientError, fetchRenderVideo } from "@/lib/proofcanvas/renderClient.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const FAILURE_HEADERS = { "Cache-Control": "no-store, max-age=0", "Content-Type": "application/json", "X-Robots-Tag": "noindex, nofollow" };

function failure(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ ok: false, code, message }), { status, headers: FAILURE_HEADERS });
}

export async function GET(_: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const video = await fetchRenderVideo(jobId);
    return new Response(video.body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `inline; filename="proofcanvas-${jobId}.mp4"`,
        "Content-Length": String(video.bytes),
        "Content-Type": "video/mp4",
        "X-ProofCanvas-Source-SHA256": video.sourceSha256,
        "X-ProofCanvas-Video-SHA256": video.videoSha256,
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    if (error instanceof RenderClientError) return failure(error.status, error.code, error.message);
    return failure(500, "renderer_error", "ProofCanvas rendering could not complete the request.");
  }
}
