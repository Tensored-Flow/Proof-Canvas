import { NextResponse } from "next/server";
import {
  ProofCanvasAuthError,
  authenticateRequest,
  csrfCookieName,
  csrfCookieOptions,
  newCsrfToken,
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
    let token: string;
    try {
      token = stableSessionCsrf(request, authenticateRequest(request, database, configuration));
    } catch (error) {
      if (!(error instanceof ProofCanvasAuthError) || error.code !== "unauthorized") throw error;
      token = newCsrfToken();
    }
    const response = NextResponse.json({ ok: true, csrfToken: token }, { headers: NO_STORE_HEADERS });
    response.cookies.set(csrfCookieName(), token, csrfCookieOptions(configuration));
    return response;
  } catch (error) {
    return routeFailure(error);
  }
}
