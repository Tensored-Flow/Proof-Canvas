import type Database from "better-sqlite3";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { proofCanvasDatabase } from "./database.server";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_BYTES, parseOwnerPasswordHash, verifyOwnerPassword } from "./credentials";

export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const CSRF_HEADER = "x-proofcanvas-csrf";
export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1_000;
export const LOGIN_RATE_MAX_FAILURES = 10;
export const LOGIN_KDF_CONCURRENCY = 2;

const TOKEN_RANDOM_BYTES = 32;
const CSRF_RANDOM_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AuthConfiguration {
  appOrigin: string;
  ownerPasswordHash: string;
  sessionSecret: Buffer;
  secureCookies: boolean;
}

export interface AuthenticatedSession {
  tokenHash: string;
  csrfHash: string;
  csrfToken: string;
  expiresAt: number;
}

export interface IssuedSession extends AuthenticatedSession {
  token: string;
}

export class ProofCanvasAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "auth_unavailable" | "unauthorized" | "invalid_origin" | "invalid_csrf" | "invalid_credentials" | "rate_limited",
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProofCanvasAuthError";
  }
}

const kdfAdmissionKey = Symbol.for("proofcanvas.auth.kdf-admission");
type GlobalWithKdfAdmission = typeof globalThis & { [kdfAdmissionKey]?: { active: number } };

function acquireKdfAdmission(): () => void {
  const globals = globalThis as GlobalWithKdfAdmission;
  const state = globals[kdfAdmissionKey] ?? { active: 0 };
  globals[kdfAdmissionKey] = state;
  if (state.active >= LOGIN_KDF_CONCURRENCY) {
    throw new ProofCanvasAuthError(429, "rate_limited", "Login verification is busy; retry shortly", 1);
  }
  state.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
  };
}

function secretBytes(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64url");
    if (decoded.length === 32 && decoded.toString("base64url") === trimmed) return decoded;
  }
  throw new Error("session secret must be canonical hex or base64url");
}

export function proofCanvasAuthConfiguration(environment: NodeJS.ProcessEnv = process.env): AuthConfiguration {
  const appOriginValue = environment.PROOFCANVAS_APP_ORIGIN?.trim();
  const passwordHash = environment.PROOFCANVAS_OWNER_PASSWORD_HASH?.trim();
  const sessionSecretValue = environment.PROOFCANVAS_SESSION_SECRET?.trim();
  try {
    if (!appOriginValue) throw new Error("missing origin");
    const url = new URL(appOriginValue);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || appOriginValue !== url.origin) {
      throw new Error("invalid origin");
    }
    if (environment.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("production origin must use HTTPS");
    if (!passwordHash) throw new Error("missing password hash");
    parseOwnerPasswordHash(passwordHash);
    if (!sessionSecretValue) throw new Error("missing session secret");
    const sessionSecret = secretBytes(sessionSecretValue);
    if (sessionSecret.length !== 32) throw new Error("invalid session secret length");
    if (sessionSecretValue === passwordHash) throw new Error("session secret must be independent");
    return {
      appOrigin: url.origin,
      ownerPasswordHash: passwordHash,
      sessionSecret,
      secureCookies: environment.NODE_ENV === "production",
    };
  } catch {
    throw new ProofCanvasAuthError(503, "auth_unavailable", "ProofCanvas owner authentication is not configured safely");
  }
}

export function sessionCookieName(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.NODE_ENV === "production" ? "__Host-proofcanvas-session" : "proofcanvas-session";
}

export function csrfCookieName(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.NODE_ENV === "production" ? "__Host-proofcanvas-csrf" : "proofcanvas-csrf";
}

export function sessionCookieOptions(configuration = proofCanvasAuthConfiguration()) {
  return {
    httpOnly: true,
    secure: configuration.secureCookies,
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function csrfCookieOptions(configuration = proofCanvasAuthConfiguration()) {
  return {
    httpOnly: false,
    secure: configuration.secureCookies,
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, Buffer.alloc(leftBuffer.length));
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(request: Request, name: string): string | undefined {
  const raw = request.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function signedSessionToken(configuration: AuthConfiguration): string {
  const opaque = randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  const prefix = `v1.${opaque}`;
  const signature = createHmac("sha256", configuration.sessionSecret).update(prefix, "utf8").digest("base64url");
  return `${prefix}.${signature}`;
}

function sessionTokenSignatureValid(token: string, configuration: AuthConfiguration): boolean {
  const match = SESSION_TOKEN_PATTERN.exec(token);
  if (!match) return false;
  const expected = createHmac("sha256", configuration.sessionSecret).update(`v1.${match[1]}`, "utf8").digest("base64url");
  return constantTimeText(match[2], expected);
}

export function csrfTokenForSession(token: string, configuration = proofCanvasAuthConfiguration()): string {
  return createHmac("sha256", configuration.sessionSecret)
    .update("proofcanvas-session-csrf-v1\0", "utf8")
    .update(token, "utf8")
    .digest("base64url");
}

export function newCsrfToken(): string {
  return randomBytes(CSRF_RANDOM_BYTES).toString("base64url");
}

export function assertExactOrigin(request: Request, configuration = proofCanvasAuthConfiguration()): void {
  const origin = request.headers.get("origin");
  if (!origin || !constantTimeText(origin, configuration.appOrigin)) {
    throw new ProofCanvasAuthError(403, "invalid_origin", "Request origin was not accepted");
  }
}

export function assertBootstrapCsrf(request: Request): void {
  const cookie = cookieValue(request, csrfCookieName());
  const header = request.headers.get(CSRF_HEADER);
  if (!cookie || !header || !CSRF_TOKEN_PATTERN.test(cookie) || !CSRF_TOKEN_PATTERN.test(header) || !constantTimeText(cookie, header)) {
    throw new ProofCanvasAuthError(403, "invalid_csrf", "CSRF validation failed");
  }
}

export function authenticateSessionToken(
  token: string | undefined,
  database: Database.Database = proofCanvasDatabase(),
  configuration = proofCanvasAuthConfiguration(),
  now = Date.now(),
): AuthenticatedSession {
  if (!token || !sessionTokenSignatureValid(token, configuration)) {
    throw new ProofCanvasAuthError(401, "unauthorized", "Authentication is required");
  }
  const tokenHash = sha256(token);
  const csrfToken = csrfTokenForSession(token, configuration);
  const csrfHash = sha256(csrfToken);
  const row = database.prepare("SELECT token_hash, csrf_hash, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .get(tokenHash, now) as { token_hash: string; csrf_hash: string; expires_at: number } | undefined;
  if (!row || !constantTimeText(row.csrf_hash, csrfHash)) throw new ProofCanvasAuthError(401, "unauthorized", "Authentication is required");
  return { tokenHash: row.token_hash, csrfHash: row.csrf_hash, csrfToken, expiresAt: row.expires_at };
}

export function authenticateRequest(
  request: Request,
  database: Database.Database = proofCanvasDatabase(),
  configuration = proofCanvasAuthConfiguration(),
): AuthenticatedSession {
  return authenticateSessionToken(cookieValue(request, sessionCookieName()), database, configuration);
}

export function assertSessionCsrf(
  request: Request,
  session: AuthenticatedSession,
): void {
  const cookie = cookieValue(request, csrfCookieName());
  const header = request.headers.get(CSRF_HEADER);
  if (!cookie || !header || !CSRF_TOKEN_PATTERN.test(cookie) || !CSRF_TOKEN_PATTERN.test(header) || !constantTimeText(cookie, header)) {
    throw new ProofCanvasAuthError(403, "invalid_csrf", "CSRF validation failed");
  }
  if (!constantTimeText(sha256(cookie), session.csrfHash)) {
    throw new ProofCanvasAuthError(403, "invalid_csrf", "CSRF validation failed");
  }
}

export function authorizeStateChangingRequest(
  request: Request,
  database: Database.Database = proofCanvasDatabase(),
  configuration = proofCanvasAuthConfiguration(),
): AuthenticatedSession {
  const session = authenticateRequest(request, database, configuration);
  assertExactOrigin(request, configuration);
  assertSessionCsrf(request, session);
  return session;
}

export async function authenticatedPageSession(
  database: Database.Database = proofCanvasDatabase(),
  configuration = proofCanvasAuthConfiguration(),
): Promise<{ session: AuthenticatedSession; csrfToken: string | null }> {
  const store = await cookies();
  const session = authenticateSessionToken(store.get(sessionCookieName())?.value, database, configuration);
  const csrfToken = store.get(csrfCookieName())?.value;
  return {
    session,
    csrfToken: csrfToken && CSRF_TOKEN_PATTERN.test(csrfToken) && constantTimeText(sha256(csrfToken), session.csrfHash) ? csrfToken : null,
  };
}

export function issueSession(
  database: Database.Database = proofCanvasDatabase(),
  configuration = proofCanvasAuthConfiguration(),
  now = Date.now(),
): IssuedSession {
  const token = signedSessionToken(configuration);
  const csrfToken = csrfTokenForSession(token, configuration);
  const tokenHash = sha256(token);
  const csrfHash = sha256(csrfToken);
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1_000;
  database.transaction(() => {
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    database.prepare("INSERT INTO sessions(token_hash, csrf_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(tokenHash, csrfHash, now, expiresAt, now);
  }).immediate();
  return { token, csrfToken, tokenHash, csrfHash, expiresAt };
}

export function stableSessionCsrf(
  request: Request,
  session: AuthenticatedSession,
): string {
  const existing = cookieValue(request, csrfCookieName());
  if (existing && CSRF_TOKEN_PATTERN.test(existing) && constantTimeText(sha256(existing), session.csrfHash)) {
    return existing;
  }
  return session.csrfToken;
}

export function revokeSession(session: AuthenticatedSession, database: Database.Database = proofCanvasDatabase()): void {
  database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.tokenHash);
}

export function loginRateLimit(database: Database.Database = proofCanvasDatabase(), now = Date.now()): { blocked: boolean; retryAfterSeconds: number } {
  const row = database.prepare("SELECT window_started_at, failures, blocked_until FROM auth_rate_limits WHERE bucket = 'owner-login'")
    .get() as { window_started_at: number; failures: number; blocked_until: number } | undefined;
  if (!row || row.blocked_until <= now) return { blocked: false, retryAfterSeconds: 0 };
  return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((row.blocked_until - now) / 1_000)) };
}

export function reserveOwnerLoginAdmission(database: Database.Database = proofCanvasDatabase(), now = Date.now()): void {
  database.transaction(() => {
    const row = database.prepare("SELECT window_started_at, failures FROM auth_rate_limits WHERE bucket = 'owner-login'")
      .get() as { window_started_at: number; failures: number } | undefined;
    const limit = loginRateLimit(database, now);
    if (limit.blocked) {
      throw new ProofCanvasAuthError(429, "rate_limited", "Too many failed login attempts; try again later", limit.retryAfterSeconds);
    }
    const inWindow = row && now - row.window_started_at < LOGIN_RATE_WINDOW_MS;
    const failures = inWindow ? row.failures + 1 : 1;
    const windowStartedAt = inWindow ? row.window_started_at : now;
    const blockedUntil = failures >= LOGIN_RATE_MAX_FAILURES ? now + LOGIN_RATE_WINDOW_MS : 0;
    database.prepare(`INSERT INTO auth_rate_limits(bucket, window_started_at, failures, blocked_until)
      VALUES ('owner-login', ?, ?, ?)
      ON CONFLICT(bucket) DO UPDATE SET window_started_at = excluded.window_started_at, failures = excluded.failures, blocked_until = excluded.blocked_until`)
      .run(windowStartedAt, failures, blockedUntil);
  }).immediate();
}

export async function verifyOwnerLogin(
  password: string,
  database: Database.Database = proofCanvasDatabase(),
  configuration = proofCanvasAuthConfiguration(),
  now = Date.now(),
): Promise<boolean> {
  const releaseKdf = acquireKdfAdmission();
  try {
    reserveOwnerLoginAdmission(database, now);
    const passwordBytes = Buffer.byteLength(password, "utf8");
    if (passwordBytes < MIN_PASSWORD_BYTES || passwordBytes > MAX_PASSWORD_BYTES) return false;
    const valid = await verifyOwnerPassword(password, configuration.ownerPasswordHash);
    if (valid) database.prepare("DELETE FROM auth_rate_limits WHERE bucket = 'owner-login'").run();
    return valid;
  } finally {
    releaseKdf();
  }
}
