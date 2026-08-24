const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CSRF_COOKIE_NAMES = ["__Host-proofcanvas-csrf", "proofcanvas-csrf"] as const;

let sessionCsrfRequest: Promise<string> | null = null;

export function currentBrowserCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (CSRF_COOKIE_NAMES.includes(name as typeof CSRF_COOKIE_NAMES[number]) && CSRF_TOKEN_PATTERN.test(value)) return value;
  }
  return null;
}

export function ensureSessionCsrfToken(knownSessionToken?: string | null): Promise<string> {
  const current = currentBrowserCsrfToken();
  if (current && (knownSessionToken === undefined || current === knownSessionToken)) return Promise.resolve(current);
  if (sessionCsrfRequest) return sessionCsrfRequest;
  const request = fetch("/api/auth/session", { cache: "no-store" })
    .then(async (response) => {
      const payload: unknown = await response.json();
      const token = payload && typeof payload === "object" ? (payload as { csrfToken?: unknown }).csrfToken : undefined;
      if (!response.ok || typeof token !== "string" || !CSRF_TOKEN_PATTERN.test(token)) {
        const message = payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string"
          ? (payload as { message: string }).message
          : "Secure session could not be refreshed";
        throw new Error(message);
      }
      return token;
    });
  sessionCsrfRequest = request;
  void request.finally(() => {
    if (sessionCsrfRequest === request) sessionCsrfRequest = null;
  }).catch(() => undefined);
  return request;
}
