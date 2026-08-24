import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertBootstrapCsrf,
  assertExactOrigin,
  csrfCookieName,
  csrfCookieOptions,
  issueSession,
  proofCanvasAuthConfiguration,
  sessionCookieName,
  sessionCookieOptions,
  verifyOwnerLogin,
} from "@/lib/proofcanvas/auth.server";
import { proofCanvasDatabase } from "@/lib/proofcanvas/database.server";
import { NO_STORE_HEADERS, readJsonRequest, routeFailure } from "@/lib/proofcanvas/http.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const LoginSchema = z.object({ password: z.string().min(1).max(1_024) }).strict();

export async function POST(request: Request) {
  try {
    const configuration = proofCanvasAuthConfiguration();
    assertExactOrigin(request, configuration);
    assertBootstrapCsrf(request);
    const database = proofCanvasDatabase();
    const input = LoginSchema.parse(await readJsonRequest(request, 4 * 1_024));
    if (!await verifyOwnerLogin(input.password, database, configuration)) {
      return NextResponse.json({ ok: false, code: "invalid_credentials", message: "Password was not accepted" }, { status: 401, headers: NO_STORE_HEADERS });
    }
    const session = issueSession(database, configuration);
    const response = NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
    response.cookies.set(sessionCookieName(), session.token, sessionCookieOptions(configuration));
    response.cookies.set(csrfCookieName(), session.csrfToken, csrfCookieOptions(configuration));
    return response;
  } catch (error) {
    return routeFailure(error);
  }
}
