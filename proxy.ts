import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/csrf", "/api/auth/login", "/api/health/live", "/api/health/ready"]);

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  const hasSessionCookie = Boolean(request.cookies.get("proofcanvas-session")?.value || request.cookies.get("__Host-proofcanvas-session")?.value);
  if (hasSessionCookie) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "Authentication is required" }, {
      status: 401,
      headers: { "Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" },
    });
  }
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
