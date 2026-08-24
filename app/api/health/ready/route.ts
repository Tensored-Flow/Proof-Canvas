import { proofCanvasAuthConfiguration } from "@/lib/proofcanvas/auth.server";
import { assertProofCanvasDatabaseReady } from "@/lib/proofcanvas/database.server";
import { jsonNoStore } from "@/lib/proofcanvas/http.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  try {
    proofCanvasAuthConfiguration();
    assertProofCanvasDatabaseReady();
    return jsonNoStore({ status: "ready" });
  } catch {
    return jsonNoStore({ status: "not-ready" }, 503);
  }
}
