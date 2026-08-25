/** @jest-environment node */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSRF_HEADER, csrfCookieName, sessionCookieName } from "@/lib/proofcanvas/auth.server";
import { hashOwnerPassword } from "@/lib/proofcanvas/credentials";
import { closeProofCanvasDatabase, proofCanvasDatabase } from "@/lib/proofcanvas/database.server";
import { GET as csrfGet } from "../auth/csrf/route";
import { POST as loginPost } from "../auth/login/route";
import { POST as logoutPost } from "../auth/logout/route";
import { GET as sessionGet } from "../auth/session/route";
import { GET as projectsGet, POST as projectsPost } from "../projects/route";
import {
  DELETE as projectDelete,
  GET as projectGet,
  PUT as projectPut,
} from "../projects/[projectId]/route";
import { POST as duplicatePost } from "../projects/[projectId]/duplicate/route";
import { POST as checkpointPost } from "../projects/[projectId]/checkpoints/route";
import { POST as recoverPost } from "../projects/[projectId]/recover/route";

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = "http://127.0.0.1:3419";
const PASSWORD = "correct horse battery canvas";
let directory = "";

function cookiesFrom(response: Response): Record<string, string> {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  return Object.fromEntries(values.map((value) => {
    const [pair] = value.split(";", 1);
    const separator = pair.indexOf("=");
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
}

function request(
  path: string,
  method: string,
  body?: unknown,
  cookies: Record<string, string> = {},
  csrfToken?: string,
  origin = ORIGIN,
): Request {
  const headers = new Headers();
  if (Object.keys(cookies).length) headers.set("cookie", cookieHeader(cookies));
  if (body !== undefined) headers.set("content-type", "application/json");
  if (csrfToken) headers.set(CSRF_HEADER, csrfToken);
  if (origin) headers.set("origin", origin);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function context(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "proofcanvas-api-integration-"));
  process.env.PROOFCANVAS_DATA_DIR = directory;
  process.env.PROOFCANVAS_APP_ORIGIN = ORIGIN;
  process.env.PROOFCANVAS_OWNER_PASSWORD_HASH = await hashOwnerPassword(PASSWORD, Buffer.alloc(16, 11));
  process.env.PROOFCANVAS_SESSION_SECRET = "89".repeat(32);
});

afterAll(() => {
  closeProofCanvasDatabase();
  process.env = ORIGINAL_ENV;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("authenticated API journey enforces origin, CSRF, CAS, idempotency, recovery, soft delete, and revocation", async () => {
  const unauthenticated = await projectsGet(request("/api/projects", "GET"));
  expect(unauthenticated.status).toBe(401);

  const bootstrapResponse = await csrfGet(request("/api/auth/csrf", "GET", undefined, {}, undefined, ""));
  expect(bootstrapResponse.status).toBe(200);
  const bootstrapPayload = await bootstrapResponse.json() as { csrfToken: string };
  const bootstrapCookies = cookiesFrom(bootstrapResponse);
  expect(bootstrapCookies[csrfCookieName()]).toBe(bootstrapPayload.csrfToken);

  const wrongOrigin = await loginPost(request(
    "/api/auth/login",
    "POST",
    { password: PASSWORD },
    bootstrapCookies,
    bootstrapPayload.csrfToken,
    "http://evil.example",
  ));
  expect(wrongOrigin.status).toBe(403);
  expect(await wrongOrigin.json()).toMatchObject({ code: "invalid_origin" });

  const weakPassword = await loginPost(request(
    "/api/auth/login",
    "POST",
    { password: "too short" },
    bootstrapCookies,
    bootstrapPayload.csrfToken,
  ));
  expect(weakPassword.status).toBe(401);
  expect(await weakPassword.json()).toMatchObject({ code: "invalid_credentials" });

  const loginResponse = await loginPost(request(
    "/api/auth/login",
    "POST",
    { password: PASSWORD },
    bootstrapCookies,
    bootstrapPayload.csrfToken,
  ));
  expect(loginResponse.status).toBe(200);
  const authCookies = cookiesFrom(loginResponse);
  expect(authCookies[sessionCookieName()]).toMatch(/^v1\./);
  expect(authCookies[csrfCookieName()]).toHaveLength(43);
  const csrfToken = authCookies[csrfCookieName()];

  const sessionResponse = await sessionGet(request("/api/auth/session", "GET", undefined, authCookies, undefined, ""));
  expect(sessionResponse.status).toBe(200);
  expect(await sessionResponse.json()).toEqual({ ok: true, csrfToken });
  expect(cookiesFrom(sessionResponse)[csrfCookieName()]).toBe(csrfToken);
  const authenticatedCsrfResponse = await csrfGet(request("/api/auth/csrf", "GET", undefined, authCookies, undefined, ""));
  expect(authenticatedCsrfResponse.status).toBe(200);
  expect(await authenticatedCsrfResponse.json()).toEqual({ ok: true, csrfToken });

  const sessionOnlyCookies = { [sessionCookieName()]: authCookies[sessionCookieName()] };
  const connection = proofCanvasDatabase();
  const sessionRowBefore = connection.prepare("SELECT * FROM sessions").get();
  const changesBefore = connection.prepare("SELECT total_changes() AS changes").get();
  const recoveredResponses = await Promise.all([
    sessionGet(request("/api/auth/session", "GET", undefined, sessionOnlyCookies, undefined, "")),
    sessionGet(request("/api/auth/session", "GET", undefined, sessionOnlyCookies, undefined, "")),
    csrfGet(request("/api/auth/csrf", "GET", undefined, sessionOnlyCookies, undefined, "")),
    csrfGet(request("/api/auth/csrf", "GET", undefined, sessionOnlyCookies, undefined, "")),
  ]);
  const recoveredPayloads = await Promise.all(recoveredResponses.map((response) => response.json() as Promise<{ csrfToken: string }>));
  expect(recoveredResponses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
  expect(recoveredPayloads.map(({ csrfToken: token }) => token)).toEqual([csrfToken, csrfToken, csrfToken, csrfToken]);
  expect(recoveredResponses.map((response) => cookiesFrom(response)[csrfCookieName()])).toEqual([csrfToken, csrfToken, csrfToken, csrfToken]);
  expect(connection.prepare("SELECT * FROM sessions").get()).toEqual(sessionRowBefore);
  expect(connection.prepare("SELECT total_changes() AS changes").get()).toEqual(changesBefore);
  const recoveredPair = { ...sessionOnlyCookies, ...cookiesFrom(recoveredResponses[0]) };
  const recoveredAuthorization = await projectsPost(request("/api/projects", "POST", {}, recoveredPair, recoveredPayloads[0].csrfToken));
  expect(recoveredAuthorization.status).toBe(400);
  expect(await recoveredAuthorization.json()).toMatchObject({ code: "invalid_request" });

  const missingCsrf = await projectsPost(request(
    "/api/projects",
    "POST",
    { kind: "blank", title: "Rejected", mutationId: "api-create-rejected-0001" },
    authCookies,
  ));
  expect(missingCsrf.status).toBe(403);

  const createBody = { kind: "sample", title: "Durable proof", mutationId: "api-create-project-0001" };
  const createdResponse = await projectsPost(request("/api/projects", "POST", createBody, authCookies, csrfToken));
  expect(createdResponse.status).toBe(201);
  const createdPayload = await createdResponse.json() as { project: { projectId: string; revision: number }; replayed: boolean };
  expect(createdPayload).toMatchObject({ project: { revision: 1 }, replayed: false });
  const projectId = createdPayload.project.projectId;

  const replayedCreate = await projectsPost(request("/api/projects", "POST", createBody, authCookies, csrfToken));
  expect(replayedCreate.status).toBe(201);
  expect(await replayedCreate.json()).toMatchObject({ project: { projectId, revision: 1 }, replayed: true });

  const loadedResponse = await projectGet(request(`/api/projects/${projectId}`, "GET", undefined, authCookies), context(projectId));
  expect(loadedResponse.status).toBe(200);
  const loadedPayload = await loadedResponse.json() as { project: { revision: number; document: Record<string, any> } };
  const edited = structuredClone(loadedPayload.project.document);
  edited.metadata.title = "Durable proof edited";
  const unsupportedAuthoring = structuredClone(loadedPayload.project.document);
  unsupportedAuthoring.shots[0].animations.find((animation: { id: string }) => animation.id === "animation-limit-emphasis").easing = "editorial";
  const unsupportedResponse = await projectPut(request(`/api/projects/${projectId}`, "PUT", {
    expectedRevision: 1,
    mutationId: "api-reject-unsupported-01",
    document: unsupportedAuthoring,
  }, authCookies, csrfToken), context(projectId));
  expect(unsupportedResponse.status).toBe(400);
  expect(await unsupportedResponse.json()).toMatchObject({ code: "invalid_project" });
  const extremeTimeline = structuredClone(loadedPayload.project.document);
  extremeTimeline.shots[0].duration = Number.MAX_VALUE;
  const extremeResponse = await projectPut(request(`/api/projects/${projectId}`, "PUT", {
    expectedRevision: 1,
    mutationId: "api-save-extreme-time-01",
    document: extremeTimeline,
  }, authCookies, csrfToken), context(projectId));
  expect(extremeResponse.status).toBe(400);
  expect(await extremeResponse.json()).toMatchObject({ code: "invalid_request" });
  const saveBody = {
    expectedRevision: 1,
    mutationId: "api-save-project-000001",
    document: edited,
  };
  const saved = await projectPut(request(`/api/projects/${projectId}`, "PUT", saveBody, authCookies, csrfToken), context(projectId));
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ project: { revision: 2 }, replayed: false });

  const retried = await projectPut(request(`/api/projects/${projectId}`, "PUT", saveBody, authCookies, csrfToken), context(projectId));
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ project: { revision: 2 }, replayed: true });

  const changedReuse = structuredClone(saveBody);
  changedReuse.document.metadata.title = "Different reuse";
  const idempotencyConflict = await projectPut(request(`/api/projects/${projectId}`, "PUT", changedReuse, authCookies, csrfToken), context(projectId));
  expect(idempotencyConflict.status).toBe(409);
  expect(await idempotencyConflict.json()).toMatchObject({ code: "idempotency_conflict" });

  const stale = await projectPut(request(`/api/projects/${projectId}`, "PUT", {
    ...saveBody,
    mutationId: "api-save-stale-00000001",
  }, authCookies, csrfToken), context(projectId));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "revision_conflict", currentRevision: 2 });

  const checkpointResponse = await checkpointPost(request(`/api/projects/${projectId}/checkpoints`, "POST", {
    expectedRevision: 2,
    mutationId: "api-checkpoint-00000001",
    label: "Before another edit",
  }, authCookies, csrfToken), context(projectId));
  expect(checkpointResponse.status).toBe(201);
  const checkpointPayload = await checkpointResponse.json() as { checkpoint: { checkpointId: string; revision: number } };
  expect(checkpointPayload.checkpoint.revision).toBe(3);

  const loadedAtThree = await projectGet(request(`/api/projects/${projectId}`, "GET", undefined, authCookies), context(projectId));
  const atThree = await loadedAtThree.json() as { project: { document: Record<string, any> } };
  const secondEdit = structuredClone(atThree.project.document);
  secondEdit.metadata.title = "After checkpoint";
  const savedAgain = await projectPut(request(`/api/projects/${projectId}`, "PUT", {
    expectedRevision: 3,
    mutationId: "api-save-project-000002",
    document: secondEdit,
  }, authCookies, csrfToken), context(projectId));
  expect(savedAgain.status).toBe(200);
  expect(await savedAgain.json()).toMatchObject({ project: { revision: 4 } });

  const recovered = await recoverPost(request(`/api/projects/${projectId}/recover`, "POST", {
    checkpointId: checkpointPayload.checkpoint.checkpointId,
    expectedRevision: 4,
    mutationId: "api-recover-0000000001",
  }, authCookies, csrfToken), context(projectId));
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ recovery: { revision: 5, preRestoreCheckpointId: expect.any(String) } });

  const duplicate = await duplicatePost(request(`/api/projects/${projectId}/duplicate`, "POST", {
    expectedRevision: 5,
    mutationId: "api-duplicate-00000001",
    title: "Durable proof copy",
  }, authCookies, csrfToken), context(projectId));
  expect(duplicate.status).toBe(201);
  const duplicatePayload = await duplicate.json() as { project: { projectId: string; revision: number } };
  expect(duplicatePayload.project).toMatchObject({ revision: 1 });
  expect(duplicatePayload.project.projectId).not.toBe(projectId);

  const deleted = await projectDelete(request(`/api/projects/${projectId}`, "DELETE", {
    expectedRevision: 5,
    mutationId: "api-delete-project-0001",
  }, authCookies, csrfToken), context(projectId));
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toMatchObject({ project: { revision: 6, deletedAt: expect.any(String) } });

  const deletedRead = await projectGet(request(`/api/projects/${projectId}`, "GET", undefined, authCookies), context(projectId));
  expect(deletedRead.status).toBe(404);
  const listed = await projectsGet(request("/api/projects", "GET", undefined, authCookies));
  expect(await listed.json()).toMatchObject({ projects: [{ id: duplicatePayload.project.projectId }] });

  const logout = await logoutPost(request("/api/auth/logout", "POST", undefined, authCookies, csrfToken));
  expect(logout.status).toBe(200);
  const afterLogout = await projectsGet(request("/api/projects", "GET", undefined, authCookies));
  expect(afterLogout.status).toBe(401);
});
