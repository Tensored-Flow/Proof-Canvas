/** @jest-environment node */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CSRF_HEADER,
  LOGIN_KDF_CONCURRENCY,
  LOGIN_RATE_MAX_FAILURES,
  ProofCanvasAuthError,
  SESSION_MAX_AGE_SECONDS,
  assertBootstrapCsrf,
  assertExactOrigin,
  authenticateRequest,
  authenticateSessionToken,
  authorizeStateChangingRequest,
  csrfCookieName,
  csrfCookieOptions,
  issueSession,
  proofCanvasAuthConfiguration,
  reserveOwnerLoginAdmission,
  revokeSession,
  sessionCookieName,
  sessionCookieOptions,
  stableSessionCsrf,
  verifyOwnerLogin,
} from "../auth.server";
import { MIN_PASSWORD_BYTES, hashOwnerPassword, verifyOwnerPassword } from "../credentials";
import { openProofCanvasDatabase } from "../database.server";

const directories: string[] = [];
const ORIGINAL_ENV = { ...process.env };

function environment(passwordHash: string, production = false): NodeJS.ProcessEnv {
  return {
    ...ORIGINAL_ENV,
    NODE_ENV: production ? "production" : "test",
    PROOFCANVAS_APP_ORIGIN: production ? "https://proofcanvas.example" : "http://127.0.0.1:3000",
    PROOFCANVAS_OWNER_PASSWORD_HASH: passwordHash,
    PROOFCANVAS_SESSION_SECRET: "ab".repeat(32),
  };
}

function database() {
  const directory = mkdtempSync(join(tmpdir(), "proofcanvas-auth-test-"));
  directories.push(directory);
  return openProofCanvasDatabase({ path: join(directory, "auth.sqlite3") });
}

function request(configuration: ReturnType<typeof proofCanvasAuthConfiguration>, sessionToken: string, csrfToken: string, overrides: Record<string, string> = {}) {
  return new Request(`${configuration.appOrigin}/api/projects`, {
    method: "POST",
    headers: {
      Origin: configuration.appOrigin,
      Cookie: `${sessionCookieName()}=${sessionToken}; ${csrfCookieName()}=${csrfToken}`,
      [CSRF_HEADER]: csrfToken,
      ...overrides,
    },
  });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("formats deterministic scrypt credentials and verifies equal-length digests in constant-time comparison", async () => {
  const salt = Buffer.alloc(16, 7);
  const encoded = await hashOwnerPassword("correct horse battery staple", salt);
  expect(encoded).toMatch(/^scrypt\$32768\$8\$1\$/);
  expect(await verifyOwnerPassword("correct horse battery staple", encoded)).toBe(true);
  expect(await verifyOwnerPassword("wrong horse battery staple", encoded)).toBe(false);
});

test("refuses owner passwords below the documented UTF-8 minimum", async () => {
  expect(MIN_PASSWORD_BYTES).toBe(16);
  await expect(hashOwnerPassword("too short", Buffer.alloc(16, 2))).rejects.toThrow(/16–1024 UTF-8 bytes/);
});

test("requires a canonical origin, valid scrypt hash, and independent 32-byte session secret", async () => {
  const hash = await hashOwnerPassword("owner password phrase", Buffer.alloc(16, 3));
  expect(proofCanvasAuthConfiguration(environment(hash))).toMatchObject({ appOrigin: "http://127.0.0.1:3000", secureCookies: false });
  expect(() => proofCanvasAuthConfiguration({ ...environment(hash), PROOFCANVAS_APP_ORIGIN: "http://127.0.0.1:3000/" }))
    .toThrow(expect.objectContaining({ code: "auth_unavailable", status: 503 }));
  expect(() => proofCanvasAuthConfiguration({ ...environment(hash), PROOFCANVAS_SESSION_SECRET: "too-short" }))
    .toThrow(expect.objectContaining({ code: "auth_unavailable" }));
  expect(() => proofCanvasAuthConfiguration({ ...environment(hash), PROOFCANVAS_SESSION_SECRET: "x".repeat(64) }))
    .toThrow(expect.objectContaining({ code: "auth_unavailable" }));
  expect(() => proofCanvasAuthConfiguration({ ...environment(hash, true), PROOFCANVAS_APP_ORIGIN: "http://proofcanvas.example" }))
    .toThrow(expect.objectContaining({ code: "auth_unavailable" }));
});

test("issues an opaque HMAC session, stores only hashes, authenticates, expires, and revokes it", async () => {
  const hash = await hashOwnerPassword("owner password phrase", Buffer.alloc(16, 4));
  process.env = environment(hash);
  const configuration = proofCanvasAuthConfiguration();
  const connection = database();
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  const issued = issueSession(connection, configuration, now);
  expect(issued.token).toMatch(/^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  expect(issued.expiresAt - now).toBe(SESSION_MAX_AGE_SECONDS * 1_000);
  const stored = connection.prepare("SELECT token_hash, csrf_hash FROM sessions").get() as { token_hash: string; csrf_hash: string };
  expect(stored.token_hash).toBe(createHash("sha256").update(issued.token).digest("hex"));
  expect(stored.csrf_hash).toBe(createHash("sha256").update(issued.csrfToken).digest("hex"));
  expect(JSON.stringify(stored)).not.toContain(issued.token);
  expect(authenticateSessionToken(issued.token, connection, configuration, now + 1)).toMatchObject({ tokenHash: stored.token_hash });
  const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith("a") ? "b" : "a"}`;
  expect(() => authenticateSessionToken(tampered, connection, configuration, now + 1)).toThrow(expect.objectContaining({ code: "unauthorized" }));
  expect(() => authenticateSessionToken(issued.token, connection, configuration, issued.expiresAt)).toThrow(expect.objectContaining({ code: "unauthorized" }));

  const replacement = issueSession(connection, configuration, now + 5);
  const session = authenticateSessionToken(replacement.token, connection, configuration, now + 6);
  revokeSession(session, connection);
  expect(() => authenticateSessionToken(replacement.token, connection, configuration, now + 7)).toThrow(expect.objectContaining({ code: "unauthorized" }));
  connection.close();
});

test("recovers one deterministic CSRF token without mutating the authenticated session row", async () => {
  const hash = await hashOwnerPassword("owner password phrase", Buffer.alloc(16, 10));
  process.env = environment(hash);
  const configuration = proofCanvasAuthConfiguration();
  const connection = database();
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  const issued = issueSession(connection, configuration, now);
  const sessionOnly = new Request(`${configuration.appOrigin}/api/auth/session`, {
    headers: { Cookie: `${sessionCookieName()}=${issued.token}` },
  });
  const before = connection.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(issued.tokenHash);
  const beforeChanges = connection.prepare("SELECT total_changes() AS changes").get();
  const firstSession = authenticateSessionToken(issued.token, connection, configuration, now + 6 * 60_000);
  const secondSession = authenticateSessionToken(issued.token, connection, configuration, now + 6 * 60_000);
  const first = stableSessionCsrf(sessionOnly, firstSession);
  const second = stableSessionCsrf(sessionOnly, secondSession);
  expect(first).toBe(issued.csrfToken);
  expect(second).toBe(first);
  expect(connection.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(issued.tokenHash)).toEqual(before);
  expect(connection.prepare("SELECT total_changes() AS changes").get()).toEqual(beforeChanges);
  connection.close();
});

test("enforces exact Origin and session-bound double-submit CSRF after authentication", async () => {
  const hash = await hashOwnerPassword("owner password phrase", Buffer.alloc(16, 5));
  process.env = environment(hash);
  const configuration = proofCanvasAuthConfiguration();
  const connection = database();
  const issued = issueSession(connection, configuration);
  const valid = request(configuration, issued.token, issued.csrfToken);
  expect(authorizeStateChangingRequest(valid, connection, configuration)).toMatchObject({ tokenHash: issued.tokenHash });
  expect(authenticateRequest(valid, connection, configuration)).toMatchObject({ tokenHash: issued.tokenHash });
  expect(() => assertExactOrigin(request(configuration, issued.token, issued.csrfToken, { Origin: "http://localhost:3000" }), configuration))
    .toThrow(expect.objectContaining({ code: "invalid_origin", status: 403 }));
  expect(() => authorizeStateChangingRequest(request(configuration, issued.token, issued.csrfToken, { [CSRF_HEADER]: "A".repeat(43) }), connection, configuration))
    .toThrow(expect.objectContaining({ code: "invalid_csrf", status: 403 }));
  const other = issueSession(connection, configuration);
  expect(() => authorizeStateChangingRequest(request(configuration, issued.token, other.csrfToken), connection, configuration))
    .toThrow(expect.objectContaining({ code: "invalid_csrf" }));
  connection.close();
});

test("requires exact Origin and a matching bootstrap token before login and rate-limits repeated failures", async () => {
  const hash = await hashOwnerPassword("owner password phrase", Buffer.alloc(16, 6));
  process.env = environment(hash);
  const configuration = proofCanvasAuthConfiguration();
  const bootstrap = "B".repeat(43);
  const bootstrapRequest = new Request(`${configuration.appOrigin}/api/auth/login`, {
    method: "POST",
    headers: { Origin: configuration.appOrigin, Cookie: `${csrfCookieName()}=${bootstrap}`, [CSRF_HEADER]: bootstrap },
  });
  expect(() => assertBootstrapCsrf(bootstrapRequest)).not.toThrow();
  expect(() => assertBootstrapCsrf(new Request(`${configuration.appOrigin}/api/auth/login`, { method: "POST", headers: { Origin: configuration.appOrigin } })))
    .toThrow(expect.objectContaining({ code: "invalid_csrf" }));
  const connection = database();
  expect(await verifyOwnerLogin("owner password phrase", connection, configuration)).toBe(true);
  expect(await verifyOwnerLogin("wrong password phrase", connection, configuration)).toBe(false);
  connection.prepare("UPDATE auth_rate_limits SET failures = 10, blocked_until = ? WHERE bucket = 'owner-login'").run(Date.now() + 60_000);
  await expect(verifyOwnerLogin("owner password phrase", connection, configuration)).rejects.toEqual(expect.objectContaining({ code: "rate_limited", status: 429 }));
  connection.close();
});

test("atomically reserves the global attempt budget across connections", () => {
  const connection = database();
  const second = openProofCanvasDatabase({ path: connection.name });
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  const outcomes = Array.from({ length: LOGIN_RATE_MAX_FAILURES + 2 }, (_, index) => {
    try {
      reserveOwnerLoginAdmission(index % 2 ? second : connection, now);
      return "admitted";
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: "rate_limited", status: 429 }));
      return "rejected";
    }
  });
  expect(outcomes.filter((outcome) => outcome === "admitted")).toHaveLength(LOGIN_RATE_MAX_FAILURES);
  expect(outcomes.filter((outcome) => outcome === "rejected")).toHaveLength(2);
  expect(connection.prepare("SELECT failures FROM auth_rate_limits WHERE bucket = 'owner-login'").get())
    .toEqual({ failures: LOGIN_RATE_MAX_FAILURES });
  second.close();
  connection.close();
});

test("rejects a concurrent login burst instead of queueing unbounded scrypt work", async () => {
  const hash = await hashOwnerPassword("owner password phrase", Buffer.alloc(16, 9));
  process.env = environment(hash);
  const configuration = proofCanvasAuthConfiguration();
  const connection = database();
  const outcomes = await Promise.allSettled(Array.from(
    { length: LOGIN_KDF_CONCURRENCY + 10 },
    () => verifyOwnerLogin("incorrect password phrase", connection, configuration),
  ));
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(LOGIN_KDF_CONCURRENCY);
  expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(10);
  for (const outcome of outcomes.filter((candidate) => candidate.status === "rejected")) {
    expect((outcome as PromiseRejectedResult).reason)
      .toEqual(expect.objectContaining({ code: "rate_limited", status: 429, retryAfterSeconds: 1 }));
  }
  expect(connection.prepare("SELECT failures, blocked_until FROM auth_rate_limits WHERE bucket = 'owner-login'").get())
    .toEqual({ failures: LOGIN_KDF_CONCURRENCY, blocked_until: 0 });
  expect(await verifyOwnerLogin("owner password phrase", connection, configuration)).toBe(true);
  expect(connection.prepare("SELECT COUNT(*) AS count FROM auth_rate_limits").get()).toEqual({ count: 0 });
  connection.close();
});

test("uses Strict, Path=/, bounded Max-Age cookies and Secure production names", async () => {
  const hash = await hashOwnerPassword("owner password phrase", Buffer.alloc(16, 8));
  const development = proofCanvasAuthConfiguration(environment(hash));
  expect(sessionCookieOptions(development)).toEqual(expect.objectContaining({ httpOnly: true, secure: false, sameSite: "strict", path: "/", maxAge: 43_200 }));
  expect(csrfCookieOptions(development)).toEqual(expect.objectContaining({ httpOnly: false, sameSite: "strict", path: "/", maxAge: 43_200 }));
  process.env = environment(hash, true);
  expect(sessionCookieName()).toBe("__Host-proofcanvas-session");
  expect(csrfCookieName()).toBe("__Host-proofcanvas-csrf");
  expect(sessionCookieOptions(proofCanvasAuthConfiguration())).toEqual(expect.objectContaining({ secure: true }));
});
