import { NextResponse } from "next/server";
import {
  authenticateRequest,
  csrfCookieName,
  csrfCookieOptions,
  proofCanvasAuthConfiguration,
  stableSessionCsrf,
} from "@/lib/proofcanvas/auth.server";
import { proofCanvasDatabase } from "@/lib/proofcanvas/database.server";
import { NO_STORE_HEADERS, routeFailure } from "@/lib/proofcanvas/http.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const configuration = proofCanvasAuthConfiguration();
    const database = proofCanvasDatabase();
    const csrfToken = stableSessionCsrf(request, authenticateRequest(request, database, configuration));
    const response = NextResponse.json({ ok: true, csrfToken }, { headers: NO_STORE_HEADERS });
    response.cookies.set(csrfCookieName(), csrfToken, csrfCookieOptions(configuration));
    return response;
  } catch (error) {
    return routeFailure(error);
  }
}
