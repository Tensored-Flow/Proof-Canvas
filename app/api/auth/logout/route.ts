import { NextResponse } from "next/server";
import {
  authorizeStateChangingRequest,
  csrfCookieName,
  csrfCookieOptions,
  proofCanvasAuthConfiguration,
  revokeSession,
  sessionCookieName,
  sessionCookieOptions,
} from "@/lib/proofcanvas/auth.server";
import { proofCanvasDatabase } from "@/lib/proofcanvas/database.server";
import { NO_STORE_HEADERS, routeFailure } from "@/lib/proofcanvas/http.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const configuration = proofCanvasAuthConfiguration();
    const database = proofCanvasDatabase();
    const session = authorizeStateChangingRequest(request, database, configuration);
    revokeSession(session, database);
    const response = NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
    response.cookies.set(sessionCookieName(), "", { ...sessionCookieOptions(configuration), maxAge: 0 });
    response.cookies.set(csrfCookieName(), "", { ...csrfCookieOptions(configuration), maxAge: 0 });
    return response;
  } catch (error) {
    return routeFailure(error);
  }
}
