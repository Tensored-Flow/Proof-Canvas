import { jsonNoStore } from "@/lib/proofcanvas/http.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  return jsonNoStore({ status: "live" });
}
