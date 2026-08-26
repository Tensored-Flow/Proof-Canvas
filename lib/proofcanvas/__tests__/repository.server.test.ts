/** @jest-environment node */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ProofCanvasRestoreCommittedError,
  committedRestoreStatus,
  createOnlineBackup,
  restoreOfflineBackup,
  validateProofCanvasBackup,
} from "../backup.server";
import {
  assertProofCanvasDatabaseReady,
  assertProofCanvasPersistenceIntegrity,
  databaseMigrationManifest,
  INSTANCE_LEASE_FILENAME,
  openProofCanvasDatabase,
} from "../database.server";
import { ProjectRepositoryError, SqliteProjectRepository } from "../repository.server";
import { PROOFCANVAS_PROJECT_MAX_BYTES, ProjectDocumentSchema, canonicalProjectJson, cloneSerializable } from "../schema";

const temporaryDirectories: string[] = [];
const leaseWorkers: LeaseWorker[] = [];
const BACKUP_SNAPSHOT_PREFIX = "proofcanvas-backup-snapshot-";

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "proofcanvas-repository-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function privateBackupSnapshotDirectories(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(BACKUP_SNAPSHOT_PREFIX)).sort();
}

function harness(directory = temporaryDirectory()) {
  const path = join(directory, "proofcanvas.sqlite3");
  const database = openProofCanvasDatabase({ path });
  let clock = Date.parse("2026-08-24T12:00:00.000Z");
  let ids = 0;
  const repository = new SqliteProjectRepository(database, {
    now: () => new Date(clock += 1_000),
    randomId: (prefix) => `${prefix}-${(++ids).toString(16).padStart(24, "0")}`,
  });
  return { directory, path, database, repository };
}

function canonicalLegacyJson(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.keys(candidate as Record<string, unknown>).sort().map((key) => [key, canonical((candidate as Record<string, unknown>)[key])]));
    }
    return candidate;
  };
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function schemaV2Json(document: unknown, mutate?: (candidate: Record<string, unknown>) => void): string {
  const candidate = cloneSerializable(document) as Record<string, unknown>;
  candidate.schemaVersion = 2;
  mutate?.(candidate);
  return canonicalLegacyJson(candidate);
}

function schemaV3Json(document: unknown, mutate?: (candidate: Record<string, unknown>) => void): string {
  const candidate = cloneSerializable(document) as Record<string, unknown>;
  candidate.schemaVersion = 3;
  mutate?.(candidate);
  return canonicalLegacyJson(candidate);
}

function downgradeDatabaseSchemaToV1(database: Database.Database): void {
  database.exec(`
    DROP TRIGGER legacy_document_archive_no_update;
    DROP TRIGGER legacy_document_archive_no_delete;
    DROP TABLE legacy_document_archive;
    ALTER TABLE checkpoints DROP COLUMN document_state;
    ALTER TABLE projects DROP COLUMN document_state;
    DELETE FROM schema_migrations WHERE version >= 2;
  `);
}

function downgradeDatabaseSchemaToV2(database: Database.Database): void {
  database.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
}

interface LeaseWorker {
  child: ChildProcessWithoutNullStreams;
  reportedPid?: number;
  holding: boolean;
  send(command: "acquire" | "release"): void;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  stderr(): string;
}

function leaseWorker(path: string): LeaseWorker {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { openProofCanvasDatabase } from "./lib/proofcanvas/database.server.ts";
    const workerPid = process.pid;
    let database;
    let attempted = false;
    const close = () => { if (database?.open) database.close(); };
    const finish = () => { close(); process.exit(0); };
    process.on("SIGTERM", finish);
    process.on("SIGINT", finish);
    process.stdin.setEncoding("utf8");
    let buffered = "";
    process.stdin.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\\n")) >= 0) {
        const command = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (command === "acquire" && !attempted) {
          attempted = true;
          try {
            const path = process.env.PROBE_DATABASE_PATH;
            if (!path) throw new Error("PROBE_DATABASE_PATH is required");
            database = openProofCanvasDatabase({ path });
            process.stdout.write("held:" + workerPid + "\\n");
          } catch (error) {
            process.stdout.write("rejected:" + workerPid + ":" + (error instanceof Error ? error.message : String(error)) + "\\n");
            process.stdin.pause();
            setImmediate(() => process.exit(2));
          }
        } else if (command === "release") {
          close();
          process.stdout.write("released:" + workerPid + "\\n");
          process.exit(0);
        }
      }
    });
    process.stdout.write("armed:" + workerPid + "\\n");
  `], {
    cwd: process.cwd(),
    env: { ...process.env, PROBE_DATABASE_PATH: path },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffered = "";
  const lines: string[] = [];
  const waiters: Array<{
    pattern: RegExp;
    resolve: (line: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout.on("data", (chunk) => {
    buffered += String(chunk);
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const waiterIndex = waiters.findIndex(({ pattern }) => pattern.test(line));
      if (waiterIndex >= 0) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(line);
      } else {
        lines.push(line);
      }
    }
  });
  child.once("close", (code, signal) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(`Lease worker exited (${String(code)}/${String(signal)}): ${stderr}`));
    }
  });
  const worker: LeaseWorker = {
    child,
    holding: false,
    send(command) { child.stdin.write(`${command}\n`); },
    waitFor(pattern, timeoutMs = 10_000) {
      const lineIndex = lines.findIndex((line) => pattern.test(line));
      if (lineIndex >= 0) return Promise.resolve(lines.splice(lineIndex, 1)[0]);
      return new Promise<string>((resolvePromise, reject) => {
        const waiter = {
          pattern,
          resolve: resolvePromise,
          reject,
          timeout: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for ${String(pattern)} from lease worker: ${stderr}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    stderr: () => stderr,
  };
  leaseWorkers.push(worker);
  return worker;
}

type LeaseWorkerEvent = "armed" | "held" | "rejected" | "released";

function parseLeaseWorkerEvent(worker: LeaseWorker, line: string): { event: LeaseWorkerEvent; pid: number; detail: string } {
  const [event, pidText, ...detail] = line.split(":");
  if (!["armed", "held", "rejected", "released"].includes(event)) throw new Error(`Unexpected lease worker event: ${line}`);
  const pid = Number(pidText);
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  expect(pid).toBe(worker.child.pid);
  if (worker.reportedPid === undefined) worker.reportedPid = pid;
  expect(pid).toBe(worker.reportedPid);
  worker.holding = event === "held" ? true : event === "released" || event === "rejected" ? false : worker.holding;
  return { event: event as LeaseWorkerEvent, pid, detail: detail.join(":") };
}

async function waitForLeaseWorkerEvent(worker: LeaseWorker, event: LeaseWorkerEvent): Promise<{ event: LeaseWorkerEvent; pid: number; detail: string }> {
  const line = await worker.waitFor(new RegExp(`^${event}:\\d+(?::.*)?$`));
  return parseLeaseWorkerEvent(worker, line);
}

async function armLeaseWorker(worker: LeaseWorker): Promise<number> {
  return (await waitForLeaseWorkerEvent(worker, "armed")).pid;
}

async function waitForLeaseWorkerOutcome(worker: LeaseWorker): Promise<{ event: "held" | "rejected"; pid: number; detail: string }> {
  const line = await worker.waitFor(/^(?:held|rejected):\d+(?::.*)?$/);
  return parseLeaseWorkerEvent(worker, line) as { event: "held" | "rejected"; pid: number; detail: string };
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.off("exit", exited);
      resolvePromise(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    child.once("exit", exited);
  });
}

async function stopLeaseWorker(worker: LeaseWorker, graceful = true): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  if (graceful && worker.holding && worker.child.stdin.writable) worker.send("release");
  else worker.child.kill("SIGTERM");
  if (await waitForExit(worker.child)) return;
  worker.child.kill("SIGKILL");
  if (!await waitForExit(worker.child)) throw new Error(`Lease worker could not be terminated: ${worker.stderr()}`);
}

afterEach(async () => {
  for (const worker of leaseWorkers.splice(0)) await stopLeaseWorker(worker);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("runs checksummed STRICT migrations and required durability pragmas on reopen", () => {
  const first = harness();
  expect(databaseMigrationManifest()).toEqual([
    { version: 1, name: "private-owner-project-store", checksum: "313de39642d6ae4c4df0a2f1ab06366ee1c236ce8468c69eaae0cd3f8e2f4c9d" },
    { version: 2, name: "loss-aware-v3-timeline-and-recovery-archive", checksum: "2f7cdbbadcd1b0c22e948b0c0111b9bf6756b8c054554b21e209f7add91fe348" },
    { version: 3, name: "v4-native-shapes-and-target-sets", checksum: "606fc320ece7945f18f960c596205be2ceef744e191af0539fcda785a306d292" },
  ]);
  expect(first.database.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(first.database.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(first.database.pragma("synchronous", { simple: true })).toBe(2);
  expect(first.database.pragma("busy_timeout", { simple: true })).toBe(5_000);
  expect(first.database.pragma("trusted_schema", { simple: true })).toBe(0);
  expect(first.database.prepare("SELECT strict FROM pragma_table_list WHERE name = 'projects'").get()).toEqual({ strict: 1 });
  expect(first.database.prepare("SELECT version, name, checksum FROM schema_migrations").all()).toEqual(databaseMigrationManifest());
  expect(() => first.database.prepare(`INSERT INTO legacy_document_archive(
    owner_type, owner_id, project_id, schema_version, document_json, document_sha256,
    migration_status, reason, archived_at
  ) VALUES ('project', ?, ?, 2, '{}', ?, 'migrated', 'forged', ?)`)
    .run("project-ffffffffffffffffffffffff", "project-ffffffffffffffffffffffff", "f".repeat(64), new Date().toISOString()))
    .toThrow(/sealed after migration/);
  first.database.close();

  const reopened = openProofCanvasDatabase({ path: first.path });
  expect(reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 3 });
  reopened.close();
});

test("accepts unique-target canonical V3 rows in historical migration 2 before advancing them to V4", () => {
  const first = harness();
  const created = first.repository.createProject({ kind: "sample", title: "Already V3", mutationId: "mutation-create-already-v3" });
  const checkpoint = first.repository.createCheckpoint({
    projectId: created.value.projectId,
    expectedRevision: created.value.revision,
    mutationId: "mutation-checkpoint-already-v3",
    label: "Canonical V3",
  });
  const projectRow = first.database.prepare("SELECT document_json FROM projects WHERE id = ?").get(created.value.projectId) as { document_json: string };
  const checkpointRow = first.database.prepare("SELECT document_json FROM checkpoints WHERE id = ?").get(checkpoint.value.checkpointId) as { document_json: string };
  const expectedProjectV4 = projectRow.document_json;
  const expectedCheckpointV4 = checkpointRow.document_json;
  first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?")
    .run(schemaV3Json(JSON.parse(projectRow.document_json)), created.value.projectId);
  first.database.prepare("UPDATE checkpoints SET document_json = ? WHERE id = ?")
    .run(schemaV3Json(JSON.parse(checkpointRow.document_json)), checkpoint.value.checkpointId);
  downgradeDatabaseSchemaToV1(first.database);
  first.database.close();

  const reopened = openProofCanvasDatabase({ path: first.path });
  expect(reopened.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  expect((reopened.prepare("SELECT document_json FROM projects WHERE id = ?").get(created.value.projectId) as { document_json: string }).document_json)
    .toBe(expectedProjectV4);
  expect((reopened.prepare("SELECT document_json FROM checkpoints WHERE id = ?").get(checkpoint.value.checkpointId) as { document_json: string }).document_json)
    .toBe(expectedCheckpointV4);
  expect(reopened.prepare("SELECT COUNT(*) AS count FROM legacy_document_archive").get()).toEqual({ count: 0 });
  expect(() => assertProofCanvasPersistenceIntegrity(reopened)).not.toThrow();
  reopened.close();
});

test("migration 3 advances ready canonical V3 JSON and leaves canonical V4 JSON unchanged", () => {
  const first = harness();
  const v3Created = first.repository.createProject({ kind: "sample", title: "Rewrite V3", mutationId: "mutation-create-rewrite-v3" });
  const v3Checkpoint = first.repository.createCheckpoint({
    projectId: v3Created.value.projectId,
    expectedRevision: v3Created.value.revision,
    mutationId: "mutation-checkpoint-rewrite-v3",
    label: "Rewrite V3",
  });
  const v4Created = first.repository.createProject({ kind: "blank", title: "Keep V4", mutationId: "mutation-create-keep-v4" });
  const v3ProjectRow = first.database.prepare("SELECT document_json FROM projects WHERE id = ?").get(v3Created.value.projectId) as { document_json: string };
  const v3CheckpointRow = first.database.prepare("SELECT document_json FROM checkpoints WHERE id = ?").get(v3Checkpoint.value.checkpointId) as { document_json: string };
  const v4ProjectRow = first.database.prepare("SELECT document_json FROM projects WHERE id = ?").get(v4Created.value.projectId) as { document_json: string };
  first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?")
    .run(schemaV3Json(JSON.parse(v3ProjectRow.document_json)), v3Created.value.projectId);
  first.database.prepare("UPDATE checkpoints SET document_json = ? WHERE id = ?")
    .run(schemaV3Json(JSON.parse(v3CheckpointRow.document_json)), v3Checkpoint.value.checkpointId);
  downgradeDatabaseSchemaToV2(first.database);
  first.database.close();

  const reopened = openProofCanvasDatabase({ path: first.path });
  expect((reopened.prepare("SELECT document_json FROM projects WHERE id = ?").get(v3Created.value.projectId) as { document_json: string }).document_json)
    .toBe(v3ProjectRow.document_json);
  expect((reopened.prepare("SELECT document_json FROM checkpoints WHERE id = ?").get(v3Checkpoint.value.checkpointId) as { document_json: string }).document_json)
    .toBe(v3CheckpointRow.document_json);
  expect((reopened.prepare("SELECT document_json FROM projects WHERE id = ?").get(v4Created.value.projectId) as { document_json: string }).document_json)
    .toBe(v4ProjectRow.document_json);
  expect(() => assertProofCanvasPersistenceIntegrity(reopened)).not.toThrow();
  reopened.close();
});

test("migration 3 stably deduplicates ready V3 animation targets in projects and checkpoints", () => {
  const first = harness();
  const created = first.repository.createProject({ kind: "sample", title: "V3 target set", mutationId: "mutation-create-v3-target-set" });
  const checkpoint = first.repository.createCheckpoint({
    projectId: created.value.projectId,
    expectedRevision: created.value.revision,
    mutationId: "mutation-checkpoint-v3-target-set",
    label: "V3 target set",
  });
  const projectRow = first.database.prepare("SELECT document_json FROM projects WHERE id = ?").get(created.value.projectId) as { document_json: string };
  const checkpointRow = first.database.prepare("SELECT document_json FROM checkpoints WHERE id = ?").get(checkpoint.value.checkpointId) as { document_json: string };
  const withRepeatedFirstTarget = (candidate: Record<string, unknown>) => {
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    const animation = (shot.animations as Array<Record<string, unknown>>)[0];
    const firstTarget = (animation.targetIds as string[])[0];
    animation.targetIds = [firstTarget, firstTarget, firstTarget];
  };
  const projectV3 = schemaV3Json(JSON.parse(projectRow.document_json), withRepeatedFirstTarget);
  const checkpointV3 = schemaV3Json(JSON.parse(checkpointRow.document_json), withRepeatedFirstTarget);
  first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(projectV3, created.value.projectId);
  first.database.prepare("UPDATE checkpoints SET document_json = ? WHERE id = ?").run(checkpointV3, checkpoint.value.checkpointId);
  downgradeDatabaseSchemaToV2(first.database);
  first.database.close();

  const reopened = openProofCanvasDatabase({ path: first.path });
  expect((reopened.prepare("SELECT document_json FROM projects WHERE id = ?").get(created.value.projectId) as { document_json: string }).document_json)
    .toBe(projectRow.document_json);
  expect((reopened.prepare("SELECT document_json FROM checkpoints WHERE id = ?").get(checkpoint.value.checkpointId) as { document_json: string }).document_json)
    .toBe(checkpointRow.document_json);
  expect(() => assertProofCanvasPersistenceIntegrity(reopened)).not.toThrow();
  reopened.close();
});

test("rejects a schema-v4-only native shape falsely labeled as canonical V3", () => {
  const first = harness();
  const created = first.repository.createProject({ kind: "sample", title: "False V3 shape", mutationId: "mutation-create-false-v3" });
  const projectRow = first.database.prepare("SELECT document_json FROM projects WHERE id = ?").get(created.value.projectId) as { document_json: string };
  const falseV3 = schemaV3Json(JSON.parse(projectRow.document_json), (candidate) => {
    const object = ((candidate.shots as Array<Record<string, unknown>>)[0].objects as Array<Record<string, unknown>>)[3];
    object.type = "ellipse";
    object.properties = { shape: { kind: "ellipse" } };
  });
  first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(falseV3, created.value.projectId);
  downgradeDatabaseSchemaToV2(first.database);
  first.database.close();

  expect(() => openProofCanvasDatabase({ path: first.path })).toThrow(/valid schema-v3|schema-v4 object type ellipse/);
  const raw = new Database(first.path, { readonly: true });
  expect(raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }]);
  expect((raw.prepare("SELECT document_json FROM projects WHERE id = ?").get(created.value.projectId) as { document_json: string }).document_json).toBe(falseV3);
  raw.close();
});

test("rolls back migration 3 atomically when any ready V3 row is noncanonical", () => {
  const first = harness();
  const validCreated = first.repository.createProject({ kind: "blank", title: "Valid V3", mutationId: "mutation-create-valid-v3" });
  const invalidCreated = first.repository.createProject({ kind: "blank", title: "Invalid V3", mutationId: "mutation-create-invalid-v3-json" });
  const validV4 = first.database.prepare("SELECT document_json FROM projects WHERE id = ?").get(validCreated.value.projectId) as { document_json: string };
  const invalidV4 = first.database.prepare("SELECT document_json FROM projects WHERE id = ?").get(invalidCreated.value.projectId) as { document_json: string };
  const validV3 = schemaV3Json(JSON.parse(validV4.document_json));
  const invalidV3 = JSON.stringify(JSON.parse(schemaV3Json(JSON.parse(invalidV4.document_json))));
  first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(validV3, validCreated.value.projectId);
  first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(invalidV3, invalidCreated.value.projectId);
  downgradeDatabaseSchemaToV2(first.database);
  first.database.close();

  expect(() => openProofCanvasDatabase({ path: first.path })).toThrow(/schema-v3 JSON is not canonical/);
  const raw = new Database(first.path, { readonly: true });
  expect(raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }]);
  expect((raw.prepare("SELECT document_json FROM projects WHERE id = ?").get(validCreated.value.projectId) as { document_json: string }).document_json).toBe(validV3);
  expect((raw.prepare("SELECT document_json FROM projects WHERE id = ?").get(invalidCreated.value.projectId) as { document_json: string }).document_json).toBe(invalidV3);
  raw.close();
});

test("migrates V2 duplicate target sets while preserving exact immutable project and checkpoint archives", () => {
  const first = harness();
  const created = first.repository.createProject({ kind: "sample", title: "V2 target set", mutationId: "mutation-create-v2-target-set" });
  const checkpoint = first.repository.createCheckpoint({
    projectId: created.value.projectId,
    expectedRevision: created.value.revision,
    mutationId: "mutation-checkpoint-v2-target-set",
    label: "V2 target set",
  });
  const projectRow = first.database.prepare("SELECT document_json FROM projects WHERE id = ?").get(created.value.projectId) as { document_json: string };
  const checkpointRow = first.database.prepare("SELECT document_json FROM checkpoints WHERE id = ?").get(checkpoint.value.checkpointId) as { document_json: string };
  const withRepeatedFirstTarget = (candidate: Record<string, unknown>) => {
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    const animation = (shot.animations as Array<Record<string, unknown>>)[0];
    const firstTarget = (animation.targetIds as string[])[0];
    animation.targetIds = [firstTarget, firstTarget];
  };
  const projectV2 = schemaV2Json(JSON.parse(projectRow.document_json), withRepeatedFirstTarget);
  const checkpointV2 = schemaV2Json(JSON.parse(checkpointRow.document_json), withRepeatedFirstTarget);
  first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(projectV2, created.value.projectId);
  first.database.prepare("UPDATE checkpoints SET document_json = ? WHERE id = ?").run(checkpointV2, checkpoint.value.checkpointId);
  downgradeDatabaseSchemaToV1(first.database);
  first.database.close();

  const reopened = openProofCanvasDatabase({ path: first.path });
  expect((reopened.prepare("SELECT document_json FROM projects WHERE id = ?").get(created.value.projectId) as { document_json: string }).document_json)
    .toBe(projectRow.document_json);
  expect((reopened.prepare("SELECT document_json FROM checkpoints WHERE id = ?").get(checkpoint.value.checkpointId) as { document_json: string }).document_json)
    .toBe(checkpointRow.document_json);
  const archives = reopened.prepare(`SELECT owner_type, owner_id, document_json, document_sha256, migration_status
    FROM legacy_document_archive WHERE project_id = ? ORDER BY owner_type, owner_id`).all(created.value.projectId) as Array<{
      owner_type: "project" | "checkpoint";
      owner_id: string;
      document_json: string;
      document_sha256: string;
      migration_status: string;
    }>;
  expect(archives).toEqual([
    {
      owner_type: "checkpoint",
      owner_id: checkpoint.value.checkpointId,
      document_json: checkpointV2,
      document_sha256: createHash("sha256").update(checkpointV2, "utf8").digest("hex"),
      migration_status: "migrated",
    },
    {
      owner_type: "project",
      owner_id: created.value.projectId,
      document_json: projectV2,
      document_sha256: createHash("sha256").update(projectV2, "utf8").digest("hex"),
      migration_status: "migrated",
    },
  ]);
  expect(() => reopened.prepare("UPDATE legacy_document_archive SET reason = 'changed' WHERE project_id = ?").run(created.value.projectId))
    .toThrow(/immutable/);
  expect(() => assertProofCanvasPersistenceIntegrity(reopened)).not.toThrow();
  reopened.close();
});

test("migrates lossless V2 rows and independently quarantines lossy projects and checkpoints with exact archives", () => {
  const first = harness();
  const readyCreated = first.repository.createProject({ kind: "blank", title: "Lossless V2", mutationId: "mutation-create-v2-ready" });
  const ready = first.repository.getProject(readyCreated.value.projectId);
  const readyCheckpoint = first.repository.createCheckpoint({
    projectId: ready.id,
    expectedRevision: ready.revision,
    mutationId: "mutation-checkpoint-v2-ready",
    label: "Legacy checkpoint",
  });
  const readyAfterCheckpoint = first.repository.getProject(ready.id);
  const readyDuplicateReceipt = first.repository.duplicateProject({
    projectId: ready.id,
    expectedRevision: readyAfterCheckpoint.revision,
    mutationId: "mutation-duplicate-v2-ready",
    title: "Loss-prone duplicate",
  });
  const readyDuplicate = first.repository.getProject(readyDuplicateReceipt.value.projectId);
  const blockedCreated = first.repository.createProject({ kind: "blank", title: "Blocked V2", mutationId: "mutation-create-v2-blocked" });
  const renamedBlocked = first.repository.renameProject({
    projectId: blockedCreated.value.projectId,
    expectedRevision: blockedCreated.value.revision,
    mutationId: "mutation-rename-v2-blocked",
    title: "Blocked legacy V2",
  });
  const blocked = first.repository.getProject(blockedCreated.value.projectId);

  const readyRaw = schemaV2Json(readyAfterCheckpoint.document, (candidate) => {
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    shot.duration = 5.000000004;
  });
  const blockedRaw = schemaV2Json(blocked.document, (candidate) => {
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    shot.markers = [
      { id: "marker-legacy-a", time: 1, name: "A", color: "#315866" },
      { id: "marker-legacy-b", time: 1.000000001, name: "B", color: "#71402d" },
    ];
  });
  const checkpointRow = first.database.prepare("SELECT document_json FROM checkpoints WHERE id = ?").get(readyCheckpoint.value.checkpointId) as { document_json: string };
  const blockedCheckpointRaw = schemaV2Json(JSON.parse(checkpointRow.document_json), (candidate) => {
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    shot.markers = [
      { id: "marker-checkpoint-a", time: 2, name: "A", color: "#315866" },
      { id: "marker-checkpoint-b", time: 2.000000001, name: "B", color: "#71402d" },
    ];
  });
  const duplicateBlockedRaw = schemaV2Json(readyDuplicate.document, (candidate) => {
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    shot.markers = [
      { id: "marker-duplicate-a", time: 3, name: "A", color: "#315866" },
      { id: "marker-duplicate-b", time: 3.000000001, name: "B", color: "#71402d" },
    ];
  });
  first.database.prepare("UPDATE projects SET document_json = ?, duration_seconds = ? WHERE id = ?").run(readyRaw, 5.000000004, ready.id);
  first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(blockedRaw, blocked.id);
  first.database.prepare("UPDATE checkpoints SET document_json = ? WHERE id = ?").run(blockedCheckpointRaw, readyCheckpoint.value.checkpointId);
  first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(duplicateBlockedRaw, readyDuplicate.id);
  downgradeDatabaseSchemaToV1(first.database);
  first.database.close();

  const reopened = openProofCanvasDatabase({ path: first.path });
  const repository = new SqliteProjectRepository(reopened);
  expect(reopened.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  expect(repository.getProject(ready.id).document.schemaVersion).toBe(4);
  const exactArchives = new Map((reopened.prepare(`SELECT owner_type, owner_id, document_json, migration_status, reason
    FROM legacy_document_archive ORDER BY owner_type, owner_id`).all() as Array<{
      owner_type: "project" | "checkpoint";
      owner_id: string;
      document_json: string;
      migration_status: "migrated" | "recovery-required";
      reason: string;
    }>).map((row) => [`${row.owner_type}:${row.owner_id}`, row]));
  expect(exactArchives.size).toBe(4);
  expect(exactArchives.get(`project:${ready.id}`)).toMatchObject({
    document_json: readyRaw,
    migration_status: "migrated",
    reason: "Lossless schema-v2 to schema-v3 fixed-tick migration",
  });
  expect(exactArchives.get(`project:${blocked.id}`)?.document_json).toBe(blockedRaw);
  expect(exactArchives.get(`project:${readyDuplicate.id}`)?.document_json).toBe(duplicateBlockedRaw);
  expect(exactArchives.get(`checkpoint:${readyCheckpoint.value.checkpointId}`)?.document_json).toBe(blockedCheckpointRaw);
  expect(repository.getProject(ready.id).durationSeconds).toBe(5);
  expect(repository.listProjects()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: ready.id, recoveryRequired: false, durationSeconds: 5 }),
    expect.objectContaining({ id: blocked.id, recoveryRequired: true }),
  ]));
  expect(() => repository.getProject(blocked.id)).toThrow(expect.objectContaining({ code: "project_recovery_required" }));
  expect(repository.listCheckpoints(ready.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: readyCheckpoint.value.checkpointId, recoveryRequired: true }),
  ]));
  expect(() => repository.recoverCheckpoint({
    projectId: ready.id,
    checkpointId: readyCheckpoint.value.checkpointId,
    expectedRevision: readyCheckpoint.value.revision,
    mutationId: "mutation-recover-blocked-checkpoint",
  })).toThrow(expect.objectContaining({ code: "project_recovery_required" }));
  expect(() => repository.createCheckpoint({
    projectId: ready.id,
    expectedRevision: ready.revision,
    mutationId: "mutation-checkpoint-v2-ready",
    label: "Legacy checkpoint",
  })).toThrow(expect.objectContaining({ code: "project_recovery_required" }));
  expect(() => repository.duplicateProject({
    projectId: ready.id,
    expectedRevision: readyAfterCheckpoint.revision,
    mutationId: "mutation-duplicate-v2-ready",
    title: "Loss-prone duplicate",
  })).toThrow(expect.objectContaining({ code: "project_recovery_required" }));

  const projectRecovery = repository.legacyRecoveryDocument({ projectId: blocked.id });
  expect(projectRecovery.documentJson).toBe(blockedRaw);
  expect(projectRecovery.sha256).toBe(createHash("sha256").update(blockedRaw, "utf8").digest("hex"));
  const checkpointRecovery = repository.legacyRecoveryDocument({ projectId: ready.id, checkpointId: readyCheckpoint.value.checkpointId });
  expect(checkpointRecovery.documentJson).toBe(blockedCheckpointRaw);
  expect(() => repository.renameProject({
    projectId: blocked.id,
    expectedRevision: blockedCreated.value.revision,
    mutationId: "mutation-rename-v2-blocked",
    title: "Blocked legacy V2",
  })).toThrow(expect.objectContaining({ code: "project_recovery_required" }));
  expect(() => repository.createProject({
    kind: "blank",
    title: "Blocked V2",
    mutationId: "mutation-create-v2-blocked",
  })).toThrow(expect.objectContaining({ code: "project_recovery_required" }));

  expect(() => reopened.prepare("UPDATE legacy_document_archive SET reason = 'tampered' WHERE owner_id = ?").run(blocked.id)).toThrow(/immutable/);
  expect(() => reopened.prepare("DELETE FROM legacy_document_archive WHERE owner_id = ?").run(blocked.id)).toThrow(/immutable/);
  const renamedReady = repository.renameProject({
    projectId: ready.id,
    expectedRevision: readyCheckpoint.value.revision,
    mutationId: "mutation-rename-migrated-ready",
    title: "Migrated and editable",
  });
  expect(renamedReady.value.revision).toBe(readyCheckpoint.value.revision + 1);
  expect(() => assertProofCanvasPersistenceIntegrity(reopened)).not.toThrow();
  repository.deleteProject({
    projectId: ready.id,
    expectedRevision: renamedReady.value.revision,
    mutationId: "mutation-delete-ready-with-archive",
  });
  expect(() => repository.getProject(ready.id)).toThrow(expect.objectContaining({ code: "project_not_found" }));
  expect(repository.legacyRecoveryDocument({ projectId: ready.id, checkpointId: readyCheckpoint.value.checkpointId }).documentJson).toBe(blockedCheckpointRaw);
  expect(() => assertProofCanvasPersistenceIntegrity(reopened)).not.toThrow();
  reopened.close();
  expect(renamedBlocked.value.revision).toBe(2);
});

test("rolls back V3 migration for noncanonical or baseline-invalid V2 rows", () => {
  for (const defect of ["missing-default", "overlap"] as const) {
    const first = harness();
    const created = first.repository.createProject({ kind: "sample", title: `Invalid ${defect}`, mutationId: `mutation-create-invalid-${defect}` });
    const durable = first.repository.getProject(created.value.projectId);
    const raw = schemaV2Json(durable.document, (candidate) => {
      const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
      if (defect === "missing-default") delete shot.propertyTracks;
      else {
        const animations = shot.animations as Array<Record<string, unknown>>;
        animations.push({ ...cloneSerializable(animations[0]), id: "animation-invalid-overlap" });
      }
    });
    first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(raw, durable.id);
    downgradeDatabaseSchemaToV1(first.database);
    first.database.close();
    expect(() => openProofCanvasDatabase({ path: first.path })).toThrow(/canonical|valid schema-v2|frozen schema-v2|overlap|redundant/);
    const rawDatabase = new Database(first.path, { readonly: true });
    expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    expect((rawDatabase.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).some(({ name }) => name === "document_state")).toBe(false);
    rawDatabase.close();
  }
});

test("atomically rejects schema-v2 rows whose metadata, counters, or checkpoint binding diverge", () => {
  for (const defect of [
    "project-id", "project-title", "project-created", "project-updated", "counter",
    "checkpoint-project", "checkpoint-created", "checkpoint-id",
  ] as const) {
    const first = harness();
    const created = first.repository.createProject({ kind: "sample", title: `Binding ${defect}`, mutationId: `mutation-create-binding-${defect}` });
    const durable = first.repository.getProject(created.value.projectId);
    let checkpointId: string | undefined;
    if (defect.startsWith("checkpoint")) {
      checkpointId = first.repository.createCheckpoint({
        projectId: durable.id,
        expectedRevision: durable.revision,
        mutationId: `mutation-checkpoint-${defect}`,
        label: "Binding probe",
      }).value.checkpointId;
    }
    if (defect.startsWith("project-")) {
      const raw = schemaV2Json(first.repository.getProject(durable.id).document, (candidate) => {
        const metadata = candidate.metadata as Record<string, unknown>;
        if (defect === "project-id") metadata.id = "project-ffffffffffffffffffffffff";
        else if (defect === "project-title") metadata.title = "Divergent document title";
        else if (defect === "project-created") metadata.createdAt = "2026-08-23T00:00:00.000Z";
        else metadata.updatedAt = "2026-08-23T00:00:00.000Z";
      });
      first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(raw, durable.id);
    } else if (defect === "counter") {
      const raw = schemaV2Json(first.repository.getProject(durable.id).document);
      first.database.prepare("UPDATE projects SET document_json = ?, shot_count = shot_count + 1 WHERE id = ?").run(raw, durable.id);
    } else {
      const project = first.database.prepare("SELECT document_json FROM projects WHERE id = ?").get(durable.id) as { document_json: string };
      first.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?")
        .run(schemaV3Json(JSON.parse(project.document_json)), durable.id);
      const checkpoint = first.database.prepare("SELECT document_json FROM checkpoints WHERE id = ?").get(checkpointId) as { document_json: string };
      const raw = schemaV2Json(JSON.parse(checkpoint.document_json), (candidate) => {
        const metadata = candidate.metadata as Record<string, unknown>;
        if (defect === "checkpoint-project") metadata.id = "project-ffffffffffffffffffffffff";
        else if (defect === "checkpoint-created") metadata.createdAt = "2026-08-23T00:00:00.000Z";
      });
      first.database.prepare("UPDATE checkpoints SET document_json = ? WHERE id = ?").run(raw, checkpointId);
      if (defect === "checkpoint-id") first.database.prepare("UPDATE checkpoints SET id = 'bogus' WHERE id = ?").run(checkpointId);
    }
    downgradeDatabaseSchemaToV1(first.database);
    first.database.close();

    expect(() => openProofCanvasDatabase({ path: first.path })).toThrow(/metadata|counter|checkpoint|integrity|invalid id/i);
    const rawDatabase = new Database(first.path, { readonly: true });
    expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    expect((rawDatabase.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).some(({ name }) => name === "document_state")).toBe(false);
    expect(() => rawDatabase.prepare("SELECT * FROM legacy_document_archive").all()).toThrow(/no such table/);
    rawDatabase.close();
  }
});

test("rolls back migration before oversized V2 bytes can be laundered by tick normalization", () => {
  const first = harness();
  const created = first.repository.createProject({ kind: "sample", title: "Oversized legacy", mutationId: "mutation-create-oversized-v2" });
  const durable = first.repository.getProject(created.value.projectId);
  const candidate = cloneSerializable(durable.document) as unknown as Record<string, unknown>;
  candidate.schemaVersion = 2;
  const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
  shot.duration = 21.000000004;
  const object = (shot.objects as Array<Record<string, unknown>>)[0];
  (object.properties as Record<string, unknown>).migrationPadding = "";
  const emptyBytes = Buffer.byteLength(canonicalLegacyJson(candidate), "utf8");
  (object.properties as Record<string, unknown>).migrationPadding = "x".repeat(PROOFCANVAS_PROJECT_MAX_BYTES + 5 - emptyBytes);
  const raw = canonicalLegacyJson(candidate);
  expect(Buffer.byteLength(raw, "utf8")).toBe(PROOFCANVAS_PROJECT_MAX_BYTES + 5);
  first.database.prepare("UPDATE projects SET document_json = ?, duration_seconds = ? WHERE id = ?").run(raw, 28.000000004, durable.id);
  downgradeDatabaseSchemaToV1(first.database);
  first.database.close();

  expect(() => openProofCanvasDatabase({ path: first.path })).toThrow(/UTF-8 bytes/);
  const rawDatabase = new Database(first.path, { readonly: true });
  expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
  expect((rawDatabase.prepare("SELECT document_json FROM projects WHERE id = ?").get(durable.id) as { document_json: string }).document_json).toBe(raw);
  rawDatabase.close();
});

test("fails closed on an unknown newer migration and a changed known checksum", () => {
  const newer = harness();
  newer.database.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (999, 'future', ?, ?)")
    .run("f".repeat(64), new Date().toISOString());
  newer.database.close();
  expect(() => openProofCanvasDatabase({ path: newer.path })).toThrow(/newer than this ProofCanvas build/);

  const changed = harness();
  changed.database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("0".repeat(64));
  changed.database.close();
  expect(() => openProofCanvasDatabase({ path: changed.path })).toThrow(/checksum does not match/);
});

test("creates revision one and makes CAS saves idempotent across two connections", () => {
  const first = harness();
  const created = first.repository.createProject({ kind: "blank", title: "Topology", mutationId: "mutation-create-topology-001" });
  expect(created).toMatchObject({ replayed: false, value: { revision: 1 } });
  expect(first.repository.createProject({ kind: "blank", title: "Topology", mutationId: "mutation-create-topology-001" })).toEqual({ ...created, replayed: true });
  expect(() => first.repository.createProject({ kind: "sample", title: "Topology", mutationId: "mutation-create-topology-001" }))
    .toThrow(expect.objectContaining({ code: "idempotency_conflict", status: 409 }));

  const secondDatabase = openProofCanvasDatabase({ path: first.path });
  const second = new SqliteProjectRepository(secondDatabase);
  const initial = first.repository.getProject(created.value.projectId);
  const edited = cloneSerializable(initial.document);
  edited.metadata.title = "Topology revised";
  const saved = first.repository.saveProject({ projectId: initial.id, expectedRevision: 1, mutationId: "mutation-save-topology-0001", document: edited });
  expect(saved.value.revision).toBe(2);
  expect(first.repository.saveProject({ projectId: initial.id, expectedRevision: 1, mutationId: "mutation-save-topology-0001", document: edited })).toEqual({ ...saved, replayed: true });
  expect(() => second.saveProject({ projectId: initial.id, expectedRevision: 1, mutationId: "mutation-second-writer-001", document: edited }))
    .toThrow(expect.objectContaining({ code: "revision_conflict", status: 409, currentRevision: 2 }));
  expect(() => first.repository.saveProject({ projectId: initial.id, expectedRevision: 2, mutationId: "mutation-save-topology-0001", document: edited }))
    .toThrow(expect.objectContaining({ code: "idempotency_conflict", status: 409 }));
  secondDatabase.close();
  first.database.close();
});

test("persists derived dashboard metadata and validates documents only when reading the document", () => {
  const { database, repository } = harness();
  const created = repository.createProject({ kind: "sample", title: "Cantor", mutationId: "mutation-create-sample-0001" });
  expect(repository.listProjects()).toEqual([expect.objectContaining({
    id: created.value.projectId,
    revision: 1,
    shotCount: 2,
    objectCount: 32,
    durationSeconds: 28,
    thumbnail: null,
  })]);
  database.prepare("UPDATE projects SET document_json = 'not-json' WHERE id = ?").run(created.value.projectId);
  expect(repository.listProjects()).toHaveLength(1);
  expect(() => repository.getProject(created.value.projectId)).toThrow(expect.objectContaining({ code: "repository_corrupt" }));
  database.close();
});

test("persists canonical tick sums through save, list, duplicate, checkpoint recovery, and integrity", () => {
  const { database, repository } = harness();
  const created = repository.createProject({ kind: "blank", title: "Tick aggregate", mutationId: "mutation-create-tick-sum-01" });
  const initial = repository.getProject(created.value.projectId);
  const document = cloneSerializable(initial.document);
  const firstShot = cloneSerializable(document.shots[0]);
  const secondShot = cloneSerializable(document.shots[0]);
  for (const shot of [firstShot, secondShot]) {
    shot.objects = [];
    shot.animations = [];
    shot.propertyTracks = [];
    shot.audioClips = [];
    shot.captionClips = [];
    shot.markers = [];
  }
  firstShot.id = "shot-tick-sum-a";
  firstShot.name = "Tick sum A";
  firstShot.duration = 0.1;
  secondShot.id = "shot-tick-sum-b";
  secondShot.name = "Tick sum B";
  secondShot.duration = 0.2;
  document.shots = [firstShot, secondShot];
  const saved = repository.saveProject({
    projectId: initial.id,
    expectedRevision: 1,
    mutationId: "mutation-save-tick-sum-001",
    document,
  });
  expect(saved.value.revision).toBe(2);
  expect(repository.getProject(initial.id).durationSeconds).toBe(0.3);
  expect(repository.listProjects().find(({ id }) => id === initial.id)?.durationSeconds).toBe(0.3);
  expect((database.prepare("SELECT duration_seconds FROM projects WHERE id = ?").get(initial.id) as { duration_seconds: number }).duration_seconds).toBe(0.3);
  database.prepare("UPDATE projects SET duration_seconds = ? WHERE id = ?").run(0.1 + 0.2, initial.id);
  expect((database.prepare("SELECT duration_seconds FROM projects WHERE id = ?").get(initial.id) as { duration_seconds: number }).duration_seconds).toBe(0.30000000000000004);
  expect(repository.getProject(initial.id).durationSeconds).toBe(0.3);
  expect(repository.listProjects().find(({ id }) => id === initial.id)?.durationSeconds).toBe(0.3);
  expect(() => assertProofCanvasPersistenceIntegrity(database)).not.toThrow();

  const duplicated = repository.duplicateProject({
    projectId: initial.id,
    expectedRevision: 2,
    mutationId: "mutation-duplicate-tick-sum",
  });
  expect(repository.getProject(duplicated.value.projectId).durationSeconds).toBe(0.3);

  const checkpoint = repository.createCheckpoint({
    projectId: initial.id,
    expectedRevision: 2,
    mutationId: "mutation-checkpoint-tick-sum",
    label: "Canonical 0.3 seconds",
  });
  const changed = cloneSerializable(repository.getProject(initial.id).document);
  changed.shots[0].duration = 0.2;
  changed.shots[1].duration = 0.2;
  const changedSave = repository.saveProject({
    projectId: initial.id,
    expectedRevision: checkpoint.value.revision,
    mutationId: "mutation-change-tick-sum-01",
    document: changed,
  });
  expect(repository.getProject(initial.id).durationSeconds).toBe(0.4);
  expect((database.prepare("SELECT duration_seconds FROM projects WHERE id = ?").get(initial.id) as { duration_seconds: number }).duration_seconds).toBe(0.4);
  repository.recoverCheckpoint({
    projectId: initial.id,
    checkpointId: checkpoint.value.checkpointId,
    expectedRevision: changedSave.value.revision,
    mutationId: "mutation-recover-tick-sum-1",
  });
  expect(repository.getProject(initial.id).durationSeconds).toBe(0.3);
  expect((database.prepare("SELECT duration_seconds FROM projects WHERE id = ?").get(initial.id) as { duration_seconds: number }).duration_seconds).toBe(0.3);
  expect(() => assertProofCanvasPersistenceIntegrity(database)).not.toThrow();

  const extreme = cloneSerializable(repository.getProject(initial.id).document);
  extreme.shots[0].duration = Number.MAX_VALUE;
  expect(() => repository.saveProject({
    projectId: initial.id,
    expectedRevision: repository.getProject(initial.id).revision,
    mutationId: "mutation-reject-extreme-timeline",
    document: extreme,
  })).toThrow(expect.objectContaining({ status: 400, code: "invalid_project" }));
  database.close();
});

test("physically rewrites canonical duration counters on every existing-row mutation", () => {
  const { database, repository } = harness();
  const created = repository.createProject({ kind: "blank", title: "Mutation counters", mutationId: "mutation-create-counter-path" });
  const durable = repository.getProject(created.value.projectId);
  const document = cloneSerializable(durable.document);
  const second = cloneSerializable(document.shots[0]);
  document.shots[0].id = "shot-counter-a";
  document.shots[0].duration = 0.1;
  second.id = "shot-counter-b";
  second.duration = 0.2;
  document.shots.push(second);
  const saved = repository.saveProject({ projectId: durable.id, expectedRevision: 1, mutationId: "mutation-save-counter-path", document });
  const rawDuration = () => (database.prepare("SELECT duration_seconds FROM projects WHERE id = ?").get(durable.id) as { duration_seconds: number }).duration_seconds;
  expect(rawDuration()).toBe(0.3);

  database.prepare("UPDATE projects SET duration_seconds = ? WHERE id = ?").run(0.1 + 0.2, durable.id);
  const renamed = repository.renameProject({ projectId: durable.id, expectedRevision: saved.value.revision, mutationId: "mutation-rename-counter-path", title: "Renamed counters" });
  expect(rawDuration()).toBe(0.3);

  database.prepare("UPDATE projects SET duration_seconds = ? WHERE id = ?").run(0.1 + 0.2, durable.id);
  const checkpoint = repository.createCheckpoint({ projectId: durable.id, expectedRevision: renamed.value.revision, mutationId: "mutation-checkpoint-counter-path", label: "Counter checkpoint" });
  expect(rawDuration()).toBe(0.3);

  database.prepare("UPDATE projects SET duration_seconds = ? WHERE id = ?").run(0.1 + 0.2, durable.id);
  repository.deleteProject({ projectId: durable.id, expectedRevision: checkpoint.value.revision, mutationId: "mutation-delete-counter-path" });
  expect(rawDuration()).toBe(0.3);
  expect(() => assertProofCanvasPersistenceIntegrity(database)).not.toThrow();
  database.close();
});

test("preserves legacy V2 easing in checkpoints but blocks copying or reintroducing it after repair", () => {
  const source = harness();
  const created = source.repository.createProject({ kind: "sample", title: "Legacy V2 easing", mutationId: "mutation-create-legacy-v2-easing" });
  const initialV3 = source.repository.getProject(created.value.projectId);
  const emphasisId = "animation-limit-emphasis";
  const legacyRaw = schemaV2Json(initialV3.document, (candidate) => {
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    const emphasis = (shot.animations as Array<Record<string, unknown>>).find(({ id }) => id === emphasisId)!;
    emphasis.easing = "editorial";
  });
  source.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(legacyRaw, initialV3.id);
  downgradeDatabaseSchemaToV1(source.database);
  source.database.close();

  const database = openProofCanvasDatabase({ path: source.path });
  const repository = new SqliteProjectRepository(database);
  const initial = repository.getProject(initialV3.id);
  expect(initial.document.shots[0].animations.find(({ id }) => id === emphasisId)?.easing).toBe("editorial");
  expect(() => repository.duplicateProject({
    projectId: initial.id,
    expectedRevision: initial.revision,
    mutationId: "mutation-preserve-legacy-duplicate",
  })).toThrow(expect.objectContaining({ status: 400, code: "invalid_project", message: expect.stringContaining("Repair renderer-rejected authority") }));
  const checkpoint = repository.createCheckpoint({
    projectId: initial.id,
    expectedRevision: initial.revision,
    mutationId: "mutation-checkpoint-legacy-v2-easing",
    label: "Persisted V2 easing",
  });

  const illegalMutation = cloneSerializable(repository.getProject(initial.id).document);
  illegalMutation.shots[0].animations.find(({ id }) => id === emphasisId)!.duration = 1;
  expect(() => repository.saveProject({
    projectId: initial.id,
    expectedRevision: checkpoint.value.revision,
    mutationId: "mutation-reject-legacy-edit-01",
    document: illegalMutation,
  })).toThrow(expect.objectContaining({ status: 400, code: "invalid_project" }));

  const newlyUnsupported = cloneSerializable(repository.getProject(initial.id).document);
  const supportedWrite = newlyUnsupported.shots[0].animations.find(({ id }) => id === "animation-title-write")!;
  supportedWrite.easing = "there-and-back";
  expect(() => repository.saveProject({
    projectId: initial.id,
    expectedRevision: checkpoint.value.revision,
    mutationId: "mutation-reject-new-unsupported",
    document: newlyUnsupported,
  })).toThrow(expect.objectContaining({ status: 400, code: "invalid_project" }));

  const unrelated = cloneSerializable(repository.getProject(initial.id).document);
  unrelated.shots[0].objects.find(({ id }) => id === "object-title")!.name = "Unrelated autosave remains allowed";
  const unrelatedSave = repository.saveProject({
    projectId: initial.id,
    expectedRevision: checkpoint.value.revision,
    mutationId: "mutation-save-unrelated-legacy",
    document: unrelated,
  });
  const repaired = cloneSerializable(repository.getProject(initial.id).document);
  repaired.shots[0].animations.find(({ id }) => id === emphasisId)!.easing = "there-and-back";
  const repairedSave = repository.saveProject({
    projectId: initial.id,
    expectedRevision: unrelatedSave.value.revision,
    mutationId: "mutation-repair-legacy-v2-easing",
    document: repaired,
  });
  expect(() => repository.recoverCheckpoint({
    projectId: initial.id,
    checkpointId: checkpoint.value.checkpointId,
    expectedRevision: repairedSave.value.revision,
    mutationId: "mutation-recover-legacy-v2-easing",
  })).toThrow(expect.objectContaining({ status: 400, code: "invalid_project" }));
  expect(repository.getProject(initial.id).document.shots[0].animations.find(({ id }) => id === emphasisId)?.easing).toBe("there-and-back");

  const removed = cloneSerializable(repository.getProject(initial.id).document);
  removed.shots[0].animations = removed.shots[0].animations.filter(({ id }) => id !== emphasisId);
  expect(() => repository.saveProject({
    projectId: initial.id,
    expectedRevision: repository.getProject(initial.id).revision,
    mutationId: "mutation-delete-legacy-animation",
    document: removed,
  })).not.toThrow();
  expect(() => assertProofCanvasPersistenceIntegrity(database)).not.toThrow();
  database.close();
});

test("full-document save and duplicate ingress guard compiler-invalid timeline authority", () => {
  const source = harness();
  const created = source.repository.createProject({ kind: "sample", title: "Timeline transition", mutationId: "mutation-create-timeline-policy" });
  const initial = source.repository.getProject(created.value.projectId);
  const legacyCandidate = cloneSerializable(initial.document);
  const shot = legacyCandidate.shots[0];
  const object = shot.objects.find(({ id }) => id === "object-title")!;
  delete object.parentId;
  object.lifetime = { start: 0, end: 8 };
  shot.duration = 8;
  shot.objects = [object];
  shot.animations = [{ id: "animation-repository-policy", type: "move", targetIds: [object.id], start: 1, duration: 1, easing: "linear", properties: { deltaX: 20 } }];
  shot.propertyTracks = [{
    id: "track-repository-policy-x",
    target: { kind: "object", objectId: object.id },
    property: "x",
    keyframes: [
      { id: "keyframe-repository-policy-a", time: 0, value: 100, interpolation: { kind: "hold" } },
      { id: "keyframe-repository-policy-b", time: 4, value: 300, interpolation: { kind: "linear" } },
    ],
  }];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  legacyCandidate.shots = [shot];
  const legacy = ProjectDocumentSchema.parse(legacyCandidate);
  source.database.prepare("UPDATE projects SET document_json = ?, shot_count = ?, object_count = ?, duration_seconds = ? WHERE id = ?")
    .run(canonicalProjectJson(legacy), 1, 1, 8, initial.id);

  const durableLegacy = source.repository.getProject(initial.id);
  expect(() => source.repository.duplicateProject({
    projectId: initial.id,
    expectedRevision: durableLegacy.revision,
    mutationId: "mutation-copy-timeline-policy",
  })).toThrow(expect.objectContaining({ status: 400, code: "invalid_project", message: expect.stringContaining("TRACK_SEMANTIC_COLLISION") }));

  const unrelated = cloneSerializable(durableLegacy.document);
  unrelated.shots[0].objects[0].name = "Unrelated repository edit";
  const unrelatedSave = source.repository.saveProject({
    projectId: initial.id,
    expectedRevision: durableLegacy.revision,
    mutationId: "mutation-save-timeline-unrelated",
    document: unrelated,
  });

  const modified = cloneSerializable(source.repository.getProject(initial.id).document);
  modified.shots[0].propertyTracks[0].keyframes[0].value = 101;
  expect(() => source.repository.saveProject({
    projectId: initial.id,
    expectedRevision: unrelatedSave.value.revision,
    mutationId: "mutation-save-timeline-modified",
    document: modified,
  })).toThrow(expect.objectContaining({
    status: 400,
    code: "invalid_project",
    message: expect.stringMatching(/TRACK_SEMANTIC_COLLISION.*track track-repository-policy-x.*animation animation-repository-policy/),
  }));

  const repaired = cloneSerializable(source.repository.getProject(initial.id).document);
  repaired.shots[0].propertyTracks = [];
  const repairedSave = source.repository.saveProject({
    projectId: initial.id,
    expectedRevision: unrelatedSave.value.revision,
    mutationId: "mutation-save-timeline-repaired",
    document: repaired,
  });
  const introduced = cloneSerializable(source.repository.getProject(initial.id).document);
  introduced.shots[0].propertyTracks = cloneSerializable(legacy.shots[0].propertyTracks);
  expect(() => source.repository.saveProject({
    projectId: initial.id,
    expectedRevision: repairedSave.value.revision,
    mutationId: "mutation-save-timeline-introduced",
    document: introduced,
  })).toThrow(expect.objectContaining({ status: 400, code: "invalid_project", message: expect.stringContaining("introduce renderer-rejected TRACK_SEMANTIC_COLLISION") }));
  source.database.close();
});

test("rejects recovery replay when its pre-restore checkpoint was independently quarantined", () => {
  const source = harness();
  const created = source.repository.createProject({ kind: "blank", title: "Recovery replay", mutationId: "mutation-create-recover-replay" });
  const initial = source.repository.getProject(created.value.projectId);
  const checkpoint = source.repository.createCheckpoint({
    projectId: initial.id,
    expectedRevision: initial.revision,
    mutationId: "mutation-checkpoint-recover-replay",
    label: "Replay source",
  });
  const changed = cloneSerializable(source.repository.getProject(initial.id).document);
  changed.shots[0].name = "Changed before recovery";
  const saved = source.repository.saveProject({
    projectId: initial.id,
    expectedRevision: checkpoint.value.revision,
    mutationId: "mutation-save-recover-replay",
    document: changed,
  });
  const recovered = source.repository.recoverCheckpoint({
    projectId: initial.id,
    checkpointId: checkpoint.value.checkpointId,
    expectedRevision: saved.value.revision,
    mutationId: "mutation-recover-replay-001",
  });
  const current = source.repository.getProject(initial.id);
  source.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(schemaV2Json(current.document), initial.id);
  const checkpointRows = source.database.prepare("SELECT id, document_json FROM checkpoints WHERE project_id = ?").all(initial.id) as Array<{ id: string; document_json: string }>;
  for (const row of checkpointRows) {
    const raw = schemaV2Json(JSON.parse(row.document_json), row.id === recovered.value.preRestoreCheckpointId ? (candidate) => {
      const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
      shot.markers = [
        { id: "marker-replay-a", time: 1, name: "A", color: "#315866" },
        { id: "marker-replay-b", time: 1.000000001, name: "B", color: "#71402d" },
      ];
    } : undefined);
    source.database.prepare("UPDATE checkpoints SET document_json = ? WHERE id = ?").run(raw, row.id);
  }
  downgradeDatabaseSchemaToV1(source.database);
  source.database.close();

  const database = openProofCanvasDatabase({ path: source.path });
  const repository = new SqliteProjectRepository(database);
  expect(repository.listCheckpoints(initial.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: recovered.value.preRestoreCheckpointId, recoveryRequired: true }),
    expect.objectContaining({ id: checkpoint.value.checkpointId, recoveryRequired: false }),
  ]));
  expect(() => repository.recoverCheckpoint({
    projectId: initial.id,
    checkpointId: checkpoint.value.checkpointId,
    expectedRevision: saved.value.revision,
    mutationId: "mutation-recover-replay-001",
  })).toThrow(expect.objectContaining({ code: "project_recovery_required" }));
  database.close();
});

test("duplicates identity/title/timestamps only and soft-deletes with CAS", () => {
  const { database, repository } = harness();
  const created = repository.createProject({ kind: "sample", title: "Original", mutationId: "mutation-create-original-01" });
  const source = repository.getProject(created.value.projectId);
  const duplicate = repository.duplicateProject({ projectId: source.id, expectedRevision: 1, mutationId: "mutation-duplicate-original", title: "Independent copy" });
  const copy = repository.getProject(duplicate.value.projectId);
  expect(copy.revision).toBe(1);
  expect(copy.id).not.toBe(source.id);
  const sourceProjection = cloneSerializable(source.document) as Record<string, unknown>;
  const copyProjection = cloneSerializable(copy.document) as Record<string, unknown>;
  delete sourceProjection.metadata;
  delete copyProjection.metadata;
  expect(copyProjection).toEqual(sourceProjection);
  expect(copy.document.metadata).toEqual(expect.objectContaining({ id: copy.id, title: "Independent copy" }));
  expect(copy.createdAt).not.toBe(source.createdAt);

  const deleted = repository.deleteProject({ projectId: source.id, expectedRevision: 1, mutationId: "mutation-delete-original-01" });
  expect(deleted.value.revision).toBe(2);
  expect(repository.listProjects().map(({ id }) => id)).toEqual([copy.id]);
  expect(() => repository.getProject(source.id)).toThrow(expect.objectContaining({ code: "project_not_found" }));
  expect(repository.deleteProject({ projectId: source.id, expectedRevision: 1, mutationId: "mutation-delete-original-01" })).toEqual({ ...deleted, replayed: true });
  database.close();
});

test("checkpoints advance revision and recovery snapshots current state before restoring at a higher revision", () => {
  const { database, repository } = harness();
  const created = repository.createProject({ kind: "blank", title: "First", mutationId: "mutation-create-recovery-01" });
  const first = repository.getProject(created.value.projectId);
  const secondDocument = cloneSerializable(first.document);
  secondDocument.metadata.title = "Second";
  const second = repository.saveProject({ projectId: first.id, expectedRevision: 1, mutationId: "mutation-save-second-0001", document: secondDocument });
  const checkpoint = repository.createCheckpoint({ projectId: first.id, expectedRevision: second.value.revision, mutationId: "mutation-checkpoint-second", label: "Second state" });
  expect(checkpoint.value.revision).toBe(3);
  const thirdDocument = cloneSerializable(repository.getProject(first.id).document);
  thirdDocument.metadata.title = "Third";
  const third = repository.saveProject({ projectId: first.id, expectedRevision: 3, mutationId: "mutation-save-third-00001", document: thirdDocument });
  const recovery = repository.recoverCheckpoint({ projectId: first.id, checkpointId: checkpoint.value.checkpointId, expectedRevision: third.value.revision, mutationId: "mutation-recover-second-01" });
  expect(recovery.value.revision).toBe(5);
  expect(repository.getProject(first.id).title).toBe("Second");
  const checkpoints = repository.listCheckpoints(first.id);
  expect(checkpoints.map(({ id }) => id)).toEqual(expect.arrayContaining([checkpoint.value.checkpointId, recovery.value.preRestoreCheckpointId]));
  const preRestore = database.prepare("SELECT document_json, revision FROM checkpoints WHERE id = ?").get(recovery.value.preRestoreCheckpointId) as { document_json: string; revision: number };
  expect(preRestore.revision).toBe(4);
  expect(JSON.parse(preRestore.document_json).metadata.title).toBe("Third");
  expect(() => assertProofCanvasPersistenceIntegrity(database)).not.toThrow();
  database.close();
});

test("durable whole-document commits reject new invalid graphs while preserving legacy repairability", () => {
  const { database, repository } = harness();
  const created = repository.createProject({ kind: "blank", title: "Graph authority", mutationId: "mutation-create-graph-authority" });
  const first = repository.getProject(created.value.projectId);
  const withGraph = cloneSerializable(first.document);
  withGraph.shots[0].objects.push({
    id: "object-durable-graph",
    type: "graph",
    name: "Durable graph",
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 240, height: 140, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: { expression: { kind: "variable" }, xMin: -2, xMax: 2 },
  });
  const valid = repository.saveProject({
    projectId: first.id,
    expectedRevision: first.revision,
    mutationId: "mutation-save-valid-graph-authority",
    document: withGraph,
  });

  const invalid = cloneSerializable(repository.getProject(first.id).document);
  invalid.shots[0].objects[0].properties.expression = {
    kind: "divide",
    left: { kind: "constant", value: 1 },
    right: { kind: "constant", value: 0 },
  };
  expect(() => repository.saveProject({
    projectId: first.id,
    expectedRevision: valid.value.revision,
    mutationId: "mutation-save-invalid-graph-authority",
    document: invalid,
  })).toThrow(expect.objectContaining({ code: "invalid_project" }));

  // Simulate a schema-v3 graph document stored before semantic graph truth was
  // introduced. Parsing stays lossless; only monotonic authoring is enforced.
  database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(canonicalProjectJson(invalid), first.id);
  const legacy = repository.getProject(first.id);
  expect(() => repository.duplicateProject({
    projectId: first.id,
    expectedRevision: legacy.revision,
    mutationId: "mutation-duplicate-invalid-graph",
  })).toThrow(expect.objectContaining({ status: 400, code: "invalid_project", message: expect.stringContaining("GRAPH_CONSTANT_DIVISION_BY_ZERO") }));
  const checkpoint = repository.createCheckpoint({
    projectId: first.id,
    expectedRevision: legacy.revision,
    mutationId: "mutation-checkpoint-invalid-graph",
    label: "Legacy invalid graph",
  });
  const unrelated = cloneSerializable(legacy.document);
  unrelated.metadata.title = "Legacy graph renamed";
  const renamed = repository.saveProject({
    projectId: first.id,
    expectedRevision: checkpoint.value.revision,
    mutationId: "mutation-save-legacy-graph-rename",
    document: unrelated,
  });
  expect(renamed.value.revision).toBe(checkpoint.value.revision + 1);

  const repaired = cloneSerializable(repository.getProject(first.id).document);
  repaired.shots[0].objects[0].properties.expression = { kind: "variable" };
  const repairedSave = repository.saveProject({
    projectId: first.id,
    expectedRevision: renamed.value.revision,
    mutationId: "mutation-save-legacy-graph-repair",
    document: repaired,
  });
  expect(() => repository.recoverCheckpoint({
    projectId: first.id,
    checkpointId: checkpoint.value.checkpointId,
    expectedRevision: repairedSave.value.revision,
    mutationId: "mutation-recover-invalid-graph",
  })).toThrow(expect.objectContaining({
    status: 400,
    code: "invalid_project",
    message: expect.stringContaining("introduce renderer-rejected GRAPH_CONSTANT_DIVISION_BY_ZERO"),
  }));
  expect(repository.getProject(first.id).document.shots[0].objects[0].properties.expression).toEqual({ kind: "variable" });
  database.close();
});

test("central integrity validation rejects row divergence, invalid checkpoints, and invalid mutation receipts", async () => {
  const divergent = harness();
  const divergentProject = divergent.repository.createProject({ kind: "blank", title: "Divergent", mutationId: "mutation-create-divergent-1" });
  divergent.database.prepare("UPDATE projects SET shot_count = shot_count + 1 WHERE id = ?").run(divergentProject.value.projectId);
  expect(() => assertProofCanvasDatabaseReady(divergent.database)).toThrow(/derived counters diverge/);
  await expect(createOnlineBackup({ database: divergent.database, dataDirectory: divergent.directory })).rejects.toThrow(/derived counters diverge/);
  divergent.database.close();

  const checkpoint = harness();
  const checkpointProject = checkpoint.repository.createProject({ kind: "blank", title: "Checkpoint", mutationId: "mutation-create-checkpoint-x" });
  checkpoint.repository.createCheckpoint({ projectId: checkpointProject.value.projectId, expectedRevision: 1, mutationId: "mutation-checkpoint-corrupt", label: "Good first" });
  checkpoint.database.prepare("UPDATE checkpoints SET document_json = 'not-json'").run();
  expect(() => assertProofCanvasPersistenceIntegrity(checkpoint.database)).toThrow(/checkpoint .* is not a valid ProjectDocument/);
  checkpoint.database.close();

  const mutation = harness();
  mutation.repository.createProject({ kind: "blank", title: "Receipt", mutationId: "mutation-create-receipt-001" });
  mutation.database.prepare("UPDATE project_mutations SET response_json = '{}'").run();
  expect(() => assertProofCanvasPersistenceIntegrity(mutation.database)).toThrow(/response has unexpected fields/);
  mutation.database.close();

  const deceptiveReceipt = harness();
  deceptiveReceipt.repository.createProject({ kind: "blank", title: "Deceptive receipt", mutationId: "mutation-deceptive-receipt-1" });
  const stored = deceptiveReceipt.database.prepare("SELECT response_json FROM project_mutations").get() as { response_json: string };
  const changedReceipt = JSON.parse(stored.response_json) as { updatedAt: string };
  changedReceipt.updatedAt = "2026-08-24T12:00:59.000Z";
  deceptiveReceipt.database.prepare("UPDATE project_mutations SET response_json = ?").run(JSON.stringify(changedReceipt));
  expect(() => assertProofCanvasPersistenceIntegrity(deceptiveReceipt.database)).toThrow(/receipt timestamp diverges/);
  deceptiveReceipt.database.close();
});

test("readiness fails closed when a required table or index is dropped", () => {
  const missingIndex = harness();
  expect(() => assertProofCanvasDatabaseReady(missingIndex.database)).not.toThrow();
  missingIndex.database.exec("DROP INDEX sessions_expires_at_idx");
  expect(() => assertProofCanvasDatabaseReady(missingIndex.database)).toThrow(/schema catalog/);
  missingIndex.database.close();

  const missingTable = harness();
  expect(() => assertProofCanvasDatabaseReady(missingTable.database)).not.toThrow();
  missingTable.database.exec("DROP TABLE checkpoints");
  expect(() => assertProofCanvasDatabaseReady(missingTable.database)).toThrow(/schema catalog/);
  missingTable.database.close();
});

test("creates a validated online backup and restores it only while the destination is offline", async () => {
  const source = harness();
  const created = source.repository.createProject({ kind: "blank", title: "Backed up", mutationId: "mutation-create-backup-0001" });
  const onlineReader = openProofCanvasDatabase({ path: source.path, readonly: true });
  const backup = await createOnlineBackup({ database: onlineReader, dataDirectory: source.directory, now: new Date("2026-08-24T13:00:00.000Z") });
  onlineReader.close();
  expect(backup.bytes).toBeGreaterThan(0);
  expect(backup.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(() => validateProofCanvasBackup(backup.path)).not.toThrow();
  source.database.close();

  const destination = temporaryDirectory();
  const restored = restoreOfflineBackup(backup.path, { dataDirectory: destination, now: new Date("2026-08-24T14:00:00.000Z") });
  expect(restored.previousPath).toBeNull();
  const restoredDatabase = openProofCanvasDatabase({ path: restored.restoredPath });
  expect(new SqliteProjectRepository(restoredDatabase).getProject(created.value.projectId).title).toBe("Backed up");
  restoredDatabase.close();
});

test("validates standalone backups from readonly storage without changing source files or sidecars", async () => {
  const source = harness();
  source.repository.createProject({ kind: "blank", title: "Readonly backup", mutationId: "mutation-create-readonly-backup" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  source.database.close();

  const readonlyDirectory = temporaryDirectory();
  const valid = join(readonlyDirectory, "valid.sqlite3");
  const invalid = join(readonlyDirectory, "invalid.sqlite3");
  copyFileSync(backup.path, valid);
  writeFileSync(invalid, "not a SQLite database", { mode: 0o400 });
  chmodSync(valid, 0o400);
  chmodSync(readonlyDirectory, 0o500);
  const before = readdirSync(readonlyDirectory).sort();
  try {
    expect(() => validateProofCanvasBackup(valid)).not.toThrow();
    expect(() => validateProofCanvasBackup(invalid)).toThrow();
    expect(readdirSync(readonlyDirectory).sort()).toEqual(before);
    for (const candidate of [valid, invalid]) {
      expect(existsSync(`${candidate}-wal`)).toBe(false);
      expect(existsSync(`${candidate}-shm`)).toBe(false);
      expect(existsSync(`${candidate}-journal`)).toBe(false);
    }
  } finally {
    chmodSync(readonlyDirectory, 0o700);
    chmodSync(valid, 0o600);
    chmodSync(invalid, 0o600);
  }
});

test("upgrades an old backup only on the private snapshot before validation and restore", () => {
  const source = harness();
  const created = source.repository.createProject({ kind: "blank", title: "Old backup", mutationId: "mutation-create-old-backup" });
  const durable = source.repository.getProject(created.value.projectId);
  const legacyRaw = schemaV2Json(durable.document, (candidate) => {
    ((candidate.shots as Array<Record<string, unknown>>)[0]).duration = 5.000000004;
  });
  source.database.prepare("UPDATE projects SET document_json = ?, duration_seconds = ? WHERE id = ?").run(legacyRaw, 5.000000004, durable.id);
  downgradeDatabaseSchemaToV1(source.database);
  source.database.close();
  const beforeStats = statSync(source.path);
  const beforeHash = createHash("sha256").update(readFileSync(source.path)).digest("hex");
  const beforeListing = readdirSync(source.directory).sort();

  expect(() => validateProofCanvasBackup(source.path)).not.toThrow();
  const afterStats = statSync(source.path);
  expect(createHash("sha256").update(readFileSync(source.path)).digest("hex")).toBe(beforeHash);
  expect(afterStats.ino).toBe(beforeStats.ino);
  expect(afterStats.mode).toBe(beforeStats.mode);
  expect(afterStats.mtimeMs).toBe(beforeStats.mtimeMs);
  expect(readdirSync(source.directory).sort()).toEqual(beforeListing);

  const destination = temporaryDirectory();
  restoreOfflineBackup(source.path, { dataDirectory: destination });
  const restored = openProofCanvasDatabase({ path: join(destination, "proofcanvas.sqlite3") });
  expect(new SqliteProjectRepository(restored).getProject(durable.id).document.schemaVersion).toBe(4);
  expect(() => assertProofCanvasPersistenceIntegrity(restored)).not.toThrow();
  restored.close();
  expect(createHash("sha256").update(readFileSync(source.path)).digest("hex")).toBe(beforeHash);
  expect(readdirSync(source.directory).sort()).toEqual(beforeListing);
});

test("privately upgrades a loss-prone old backup while preserving its exact recovery bytes", () => {
  const source = harness();
  const created = source.repository.createProject({ kind: "blank", title: "Loss-prone backup", mutationId: "mutation-create-lossy-backup" });
  const durable = source.repository.getProject(created.value.projectId);
  const legacyRaw = schemaV2Json(durable.document, (candidate) => {
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    shot.markers = [
      { id: "marker-backup-collapse-a", time: 1, name: "A", color: "#315866" },
      { id: "marker-backup-collapse-b", time: 1.000000001, name: "B", color: "#71402d" },
    ];
  });
  source.database.prepare("UPDATE projects SET document_json = ? WHERE id = ?").run(legacyRaw, durable.id);
  downgradeDatabaseSchemaToV1(source.database);
  source.database.close();
  const beforeBytes = readFileSync(source.path);
  const beforeStats = statSync(source.path);

  expect(() => validateProofCanvasBackup(source.path)).not.toThrow();
  expect(readFileSync(source.path)).toEqual(beforeBytes);
  expect(statSync(source.path).ino).toBe(beforeStats.ino);
  expect(statSync(source.path).mode).toBe(beforeStats.mode);
  expect(statSync(source.path).mtimeMs).toBe(beforeStats.mtimeMs);

  const destination = temporaryDirectory();
  restoreOfflineBackup(source.path, { dataDirectory: destination });
  const restored = openProofCanvasDatabase({ path: join(destination, "proofcanvas.sqlite3") });
  const repository = new SqliteProjectRepository(restored);
  expect(repository.listProjects()).toEqual([expect.objectContaining({ id: durable.id, recoveryRequired: true })]);
  expect(repository.legacyRecoveryDocument({ projectId: durable.id }).documentJson).toBe(legacyRaw);
  expect(() => repository.getProject(durable.id)).toThrow(expect.objectContaining({ code: "project_recovery_required" }));
  expect(() => assertProofCanvasPersistenceIntegrity(restored)).not.toThrow();
  restored.close();
  expect(readFileSync(source.path)).toEqual(beforeBytes);
});

test("invalid restore input leaves a preexisting target directory mode and listing untouched", () => {
  const sourceDirectory = temporaryDirectory();
  const invalidSource = join(sourceDirectory, "invalid.sqlite3");
  writeFileSync(invalidSource, "not a SQLite database", { mode: 0o600 });
  const destinationDirectory = temporaryDirectory();
  writeFileSync(join(destinationDirectory, "sentinel.txt"), "keep me", { mode: 0o600 });
  chmodSync(destinationDirectory, 0o750);
  const beforeMode = statSync(destinationDirectory).mode & 0o777;
  const beforeListing = readdirSync(destinationDirectory).sort();
  const beforeSnapshots = privateBackupSnapshotDirectories();
  try {
    expect(() => restoreOfflineBackup(invalidSource, { dataDirectory: destinationDirectory })).toThrow();
    expect(statSync(destinationDirectory).mode & 0o777).toBe(beforeMode);
    expect(readdirSync(destinationDirectory).sort()).toEqual(beforeListing);
    expect(privateBackupSnapshotDirectories()).toEqual(beforeSnapshots);
  } finally {
    chmodSync(destinationDirectory, 0o700);
  }
});

test("publishes the validated immutable snapshot even when the source symlink is retargeted afterward", async () => {
  const first = harness();
  const firstProject = first.repository.createProject({ kind: "blank", title: "First source", mutationId: "mutation-create-snapshot-first" });
  const firstBackup = await createOnlineBackup({ database: first.database, dataDirectory: first.directory });
  first.database.close();
  const second = harness();
  second.repository.createProject({ kind: "blank", title: "Second source", mutationId: "mutation-create-snapshot-second" });
  const secondBackup = await createOnlineBackup({ database: second.database, dataDirectory: second.directory });
  second.database.close();
  const sourceAliasDirectory = temporaryDirectory();
  const sourceAlias = join(sourceAliasDirectory, "selected.sqlite3");
  symlinkSync(firstBackup.path, sourceAlias);
  const destinationDirectory = temporaryDirectory();
  const beforeDestinationMode = statSync(destinationDirectory).mode & 0o777;
  const beforeDestinationListing = readdirSync(destinationDirectory).sort();
  const beforeSnapshots = privateBackupSnapshotDirectories();

  const restored = restoreOfflineBackup(sourceAlias, {
    dataDirectory: destinationDirectory,
    __testFault(boundary) {
      if (boundary !== "source-snapshotted") return;
      expect(statSync(destinationDirectory).mode & 0o777).toBe(beforeDestinationMode);
      expect(readdirSync(destinationDirectory).sort()).toEqual(beforeDestinationListing);
      const snapshots = privateBackupSnapshotDirectories().filter((name) => !beforeSnapshots.includes(name));
      expect(snapshots).toHaveLength(1);
      const snapshotDirectory = join(tmpdir(), snapshots[0]);
      expect(statSync(snapshotDirectory).mode & 0o777).toBe(0o500);
      expect(statSync(join(snapshotDirectory, "proofcanvas.sqlite3")).mode & 0o777).toBe(0o400);
      rmSync(sourceAlias);
      symlinkSync(secondBackup.path, sourceAlias);
    },
  });

  const installed = openProofCanvasDatabase({ path: restored.restoredPath });
  expect(new SqliteProjectRepository(installed).getProject(firstProject.value.projectId).title).toBe("First source");
  installed.close();
  expect(privateBackupSnapshotDirectories()).toEqual(beforeSnapshots);
  expect(readdirSync(destinationDirectory).filter((name) => name.startsWith(".restore-") || name.startsWith(".pre-restore-"))).toEqual([]);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    expect(existsSync(`${restored.restoredPath}${suffix}`)).toBe(false);
  }
});

test("offline restore refuses every supported writable destination connection until the final close", async () => {
  const source = harness();
  source.repository.createProject({ kind: "blank", title: "Backup", mutationId: "mutation-create-active-0001" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  const destination = harness();
  const secondDestination = openProofCanvasDatabase({ path: destination.path });
  expect(() => restoreOfflineBackup(backup.path, { dataDirectory: destination.directory })).toThrow(/writable connection .* is open/);
  destination.database.close();
  expect(() => restoreOfflineBackup(backup.path, { dataDirectory: destination.directory })).toThrow(/writable connection .* is open/);
  secondDestination.close();
  expect(restoreOfflineBackup(backup.path, { dataDirectory: destination.directory }).restoredPath).toBe(destination.path);
  source.database.close();
});

test("offline restore recognizes a supported writable target opened through a symlink alias", async () => {
  const source = harness();
  source.repository.createProject({ kind: "blank", title: "Backup", mutationId: "mutation-create-alias-src-01" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  const destination = harness();
  destination.database.close();
  const aliasDirectory = temporaryDirectory();
  const aliasPath = join(aliasDirectory, "database-alias.sqlite3");
  symlinkSync(destination.path, aliasPath);
  const aliasedConnection = openProofCanvasDatabase({ path: aliasPath });
  try {
    expect(() => restoreOfflineBackup(backup.path, { dataDirectory: destination.directory }))
      .toThrow(/writable connection .* is open/);
  } finally {
    aliasedConnection.close();
    source.database.close();
  }
});

test("offline restore recognizes a supported writable target opened through a relative alias", async () => {
  const source = harness();
  source.repository.createProject({ kind: "blank", title: "Backup", mutationId: "mutation-create-relative-src" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  const destination = harness();
  destination.database.close();
  const relativeConnection = openProofCanvasDatabase({ path: relative(process.cwd(), destination.path) });
  try {
    expect(() => restoreOfflineBackup(backup.path, { dataDirectory: destination.directory }))
      .toThrow(/writable connection .* is open/);
  } finally {
    relativeConnection.close();
    source.database.close();
  }
});

test("offline restore refuses a supported writable target held by another process", async () => {
  const source = harness();
  source.repository.createProject({ kind: "blank", title: "Backup", mutationId: "mutation-create-child-src-01" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  const destination = harness();
  destination.database.close();
  const worker = leaseWorker(destination.path);
  await armLeaseWorker(worker);
  worker.send("acquire");
  expect((await waitForLeaseWorkerEvent(worker, "held")).event).toBe("held");
  try {
    expect(() => restoreOfflineBackup(backup.path, { dataDirectory: destination.directory }))
      .toThrow(/canonical data-directory lease/);
  } finally {
    await stopLeaseWorker(worker);
    source.database.close();
  }
});

test("publishes one persistent lease under a synchronized fresh-process race and recovers after SIGKILL", async () => {
  const directory = temporaryDirectory();
  const path = join(directory, "proofcanvas.sqlite3");
  const first = leaseWorker(path);
  const second = leaseWorker(path);
  await Promise.all([armLeaseWorker(first), armLeaseWorker(second)]);
  const firstOutcome = waitForLeaseWorkerOutcome(first);
  const secondOutcome = waitForLeaseWorkerOutcome(second);
  first.send("acquire");
  second.send("acquire");
  const outcomes = await Promise.all([firstOutcome, secondOutcome]);
  expect(outcomes.filter(({ event }) => event === "held")).toHaveLength(1);
  expect(outcomes.filter(({ event }) => event === "rejected")).toHaveLength(1);
  expect(outcomes.find(({ event }) => event === "rejected")?.detail).toMatch(/canonical data-directory lease/);

  const winner = outcomes[0].event === "held" ? first : second;
  const loser = winner === first ? second : first;
  await stopLeaseWorker(loser);
  const leasePath = join(directory, INSTANCE_LEASE_FILENAME);
  const leaseIdentity = statSync(leasePath);
  expect(winner.reportedPid).toBe(winner.child.pid);
  try {
    expect(winner.child.kill("SIGKILL")).toBe(true);
    expect(await waitForExit(winner.child)).toBe(true);
    expect(winner.child.signalCode).toBe("SIGKILL");
  } finally {
    await stopLeaseWorker(winner, false);
  }

  const restarted = leaseWorker(path);
  try {
    await armLeaseWorker(restarted);
    restarted.send("acquire");
    expect((await waitForLeaseWorkerEvent(restarted, "held")).event).toBe("held");
    const restartedIdentity = statSync(leasePath);
    expect({ dev: restartedIdentity.dev, ino: restartedIdentity.ino })
      .toEqual({ dev: leaseIdentity.dev, ino: leaseIdentity.ino });
  } finally {
    await stopLeaseWorker(restarted);
  }
});

test("canonicalizes a cross-process file-symlink target to the real directory lease", async () => {
  const source = harness();
  source.repository.createProject({ kind: "blank", title: "Backup", mutationId: "mutation-create-xproc-alias" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  const destination = harness();
  destination.database.close();
  const aliasDirectory = temporaryDirectory();
  const aliasPath = join(aliasDirectory, "aliased.sqlite3");
  symlinkSync(destination.path, aliasPath);
  const worker = leaseWorker(aliasPath);
  try {
    await armLeaseWorker(worker);
    worker.send("acquire");
    expect((await waitForLeaseWorkerEvent(worker, "held")).event).toBe("held");
    expect(existsSync(join(destination.directory, INSTANCE_LEASE_FILENAME))).toBe(true);
    expect(existsSync(join(aliasDirectory, INSTANCE_LEASE_FILENAME))).toBe(false);
    expect(() => restoreOfflineBackup(backup.path, { dataDirectory: destination.directory }))
      .toThrow(/canonical data-directory lease/);
  } finally {
    await stopLeaseWorker(worker);
    source.database.close();
  }
});

test("holds the shared directory lease until the final same-process writer closes", async () => {
  const destination = harness();
  const second = openProofCanvasDatabase({ path: destination.path });
  const rejectedWhileBoth = leaseWorker(destination.path);
  await armLeaseWorker(rejectedWhileBoth);
  rejectedWhileBoth.send("acquire");
  expect((await waitForLeaseWorkerEvent(rejectedWhileBoth, "rejected")).detail).toMatch(/canonical data-directory lease/);
  await stopLeaseWorker(rejectedWhileBoth);

  destination.database.close();
  const rejectedAfterFirstClose = leaseWorker(destination.path);
  await armLeaseWorker(rejectedAfterFirstClose);
  rejectedAfterFirstClose.send("acquire");
  expect((await waitForLeaseWorkerEvent(rejectedAfterFirstClose, "rejected")).detail).toMatch(/canonical data-directory lease/);
  await stopLeaseWorker(rejectedAfterFirstClose);

  second.close();
  const admittedAfterFinalClose = leaseWorker(destination.path);
  try {
    await armLeaseWorker(admittedAfterFinalClose);
    admittedAfterFinalClose.send("acquire");
    expect((await waitForLeaseWorkerEvent(admittedAfterFinalClose, "held")).event).toBe("held");
  } finally {
    await stopLeaseWorker(admittedAfterFinalClose);
  }
});

test("rejects supported writable and restore targets that have hardlink aliases", async () => {
  const source = harness();
  source.repository.createProject({ kind: "blank", title: "Backup", mutationId: "mutation-create-hardlink-src" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  const destination = harness();
  destination.database.close();
  const hardlink = join(temporaryDirectory(), "proofcanvas-hardlink.sqlite3");
  linkSync(destination.path, hardlink);
  expect(() => openProofCanvasDatabase({ path: destination.path })).toThrow(/hard links are unsupported/);
  expect(() => openProofCanvasDatabase({ path: hardlink })).toThrow(/hard links are unsupported/);
  expect(() => restoreOfflineBackup(backup.path, { dataDirectory: destination.directory }))
    .toThrow(/hard links are unsupported/);
  source.database.close();
});

test("keeps the maintenance lease through staged validation and leaves no application staging artifacts", async () => {
  const source = harness();
  const sourceProject = source.repository.createProject({ kind: "blank", title: "Maintenance source", mutationId: "mutation-create-maintenance-src" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  source.database.close();
  const destination = harness();
  destination.repository.createProject({ kind: "blank", title: "Maintenance destination", mutationId: "mutation-create-maintenance-dst" });
  destination.database.close();
  let crossProcessProbe = "";

  const receipt = restoreOfflineBackup(backup.path, {
    dataDirectory: destination.directory,
    __testFault(boundary) {
      if (boundary !== "staged-validated") return;
      expect(() => openProofCanvasDatabase({ path: destination.path })).toThrow(/maintenance owns/);
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
        import { openProofCanvasDatabase } from "./lib/proofcanvas/database.server.ts";
        const workerPid = process.pid;
        try {
          const path = process.env.PROBE_DATABASE_PATH;
          if (!path) throw new Error("PROBE_DATABASE_PATH is required");
          const database = openProofCanvasDatabase({ path });
          database.close();
          process.stdout.write("opened:" + workerPid);
        } catch (error) {
          process.stdout.write("rejected:" + workerPid + ":" + (error instanceof Error ? error.message : String(error)));
        }
      `], {
        cwd: process.cwd(),
        env: { ...process.env, PROBE_DATABASE_PATH: destination.path },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      crossProcessProbe = result.stdout;
      const [, reportedPid, detail] = /^rejected:(\d+):(.*)$/.exec(crossProcessProbe) ?? [];
      expect(Number(reportedPid)).toBe(result.pid);
      expect(detail).toMatch(/canonical data-directory lease/);
    },
  });
  expect(receipt.restoredPath).toBe(destination.path);
  expect(crossProcessProbe).toMatch(/^rejected:\d+:/);
  expect(readdirSync(destination.directory).filter((name) => name.startsWith(".restore-") || name.startsWith(".pre-restore-"))).toEqual([]);
  const backupArtifacts = readdirSync(join(destination.directory, "backups"));
  expect(backupArtifacts.some((name) => name.startsWith(".pre-restore-") || name.includes(".partial"))).toBe(false);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    expect(existsSync(`${destination.path}${suffix}`)).toBe(false);
  }
  const installed = openProofCanvasDatabase({ path: destination.path });
  expect(new SqliteProjectRepository(installed).getProject(sourceProject.value.projectId).title).toBe("Maintenance source");
  installed.close();
});

test("offline restore rejects a symlink to the live target as its source", () => {
  const destination = harness();
  destination.repository.createProject({ kind: "blank", title: "Live", mutationId: "mutation-create-live-alias-1" });
  destination.database.close();
  const alias = join(temporaryDirectory(), "live-alias.sqlite3");
  symlinkSync(destination.path, alias);
  expect(() => restoreOfflineBackup(alias, { dataDirectory: destination.directory }))
    .toThrow(/source must not be the live/);
});

test("offline restore rejects a hardlink to the live target before target maintenance", () => {
  const destination = harness();
  destination.repository.createProject({ kind: "blank", title: "Live", mutationId: "mutation-create-live-hardlink" });
  destination.database.close();
  const alias = join(temporaryDirectory(), "live-hardlink.sqlite3");
  linkSync(destination.path, alias);
  expect(() => restoreOfflineBackup(alias, { dataDirectory: destination.directory }))
    .toThrow(/source must not be the live/);
});

test("restore failure before atomic replacement leaves the live target and a verified old copy", async () => {
  const source = harness();
  source.repository.createProject({ kind: "blank", title: "Source", mutationId: "mutation-create-source-0001" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  source.database.close();
  const destination = harness();
  const oldProject = destination.repository.createProject({ kind: "blank", title: "Destination", mutationId: "mutation-create-dest-00001" });
  destination.database.close();
  expect(() => restoreOfflineBackup(backup.path, {
    dataDirectory: destination.directory,
    now: new Date("2026-08-24T15:00:00.000Z"),
    __testFault(boundary) {
      if (boundary === "before-atomic-replace") {
        expect(existsSync(destination.path)).toBe(true);
        throw new Error("injected before replace");
      }
    },
  })).toThrow(/injected before replace/);
  const stillOld = openProofCanvasDatabase({ path: destination.path });
  expect(new SqliteProjectRepository(stillOld).getProject(oldProject.value.projectId).title).toBe("Destination");
  stillOld.close();
  const oldCopies = readdirSync(join(destination.directory, "backups")).filter((name) => name.startsWith("pre-restore-") && name.endsWith(".sqlite3"));
  expect(oldCopies).toHaveLength(1);
  expect(() => validateProofCanvasBackup(join(destination.directory, "backups", oldCopies[0]))).not.toThrow();
});

test("restore failure after atomic replacement leaves the new target and verified old copy", async () => {
  const source = harness();
  const sourceProject = source.repository.createProject({ kind: "blank", title: "Source", mutationId: "mutation-create-source-0002" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  source.database.close();
  const destination = harness();
  const oldProject = destination.repository.createProject({ kind: "blank", title: "Destination", mutationId: "mutation-create-dest-00002" });
  destination.database.close();
  let committedError: unknown;
  try {
    restoreOfflineBackup(backup.path, {
      dataDirectory: destination.directory,
      now: new Date("2026-08-24T16:00:00.000Z"),
      __testFault(boundary) {
        if (boundary === "after-atomic-replace") throw new Error("injected after replace");
      },
    });
  } catch (error) {
    committedError = error;
  }
  expect(committedError).toBeInstanceOf(ProofCanvasRestoreCommittedError);
  expect(committedError).toMatchObject({
    committed: true,
    durability: "uncertain",
    previousPath: expect.stringContaining("pre-restore-"),
    cause: expect.objectContaining({ message: "injected after replace" }),
  });
  expect(committedRestoreStatus(committedError)).toEqual({
    error: "restore_committed_durability_uncertain",
    committed: true,
    durability: "uncertain",
    previousPath: expect.stringContaining("pre-restore-"),
  });
  const installed = openProofCanvasDatabase({ path: destination.path });
  expect(new SqliteProjectRepository(installed).getProject(sourceProject.value.projectId).title).toBe("Source");
  installed.close();
  const oldCopies = readdirSync(join(destination.directory, "backups")).filter((name) => name.startsWith("pre-restore-") && name.endsWith(".sqlite3"));
  expect(oldCopies).toHaveLength(1);
  const oldCopyPath = join(destination.directory, "backups", oldCopies[0]);
  expect(() => validateProofCanvasBackup(oldCopyPath)).not.toThrow();
  const oldCopy = openProofCanvasDatabase({ path: oldCopyPath });
  expect(new SqliteProjectRepository(oldCopy).getProject(oldProject.value.projectId).title).toBe("Destination");
  oldCopy.close();
});

test("reports a post-publication finalizer failure as committed and durable, then releases maintenance", async () => {
  const source = harness();
  const sourceProject = source.repository.createProject({ kind: "blank", title: "Finalized source", mutationId: "mutation-create-finalizer-src" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  source.database.close();
  const destination = harness();
  destination.repository.createProject({ kind: "blank", title: "Old destination", mutationId: "mutation-create-finalizer-dst" });
  destination.database.close();

  let committedError: unknown;
  try {
    restoreOfflineBackup(backup.path, {
      dataDirectory: destination.directory,
      __testFault(boundary) {
        if (boundary === "finalize") throw new Error("injected finalizer failure");
      },
    });
  } catch (error) {
    committedError = error;
  }
  expect(committedError).toBeInstanceOf(ProofCanvasRestoreCommittedError);
  expect(committedError).toMatchObject({
    committed: true,
    durability: "durable",
    previousPath: expect.stringContaining("pre-restore-"),
    cause: expect.objectContaining({ message: "injected finalizer failure" }),
  });
  expect(committedRestoreStatus(committedError)).toEqual({
    error: "restore_committed_cleanup_failed",
    committed: true,
    durability: "durable",
    previousPath: expect.stringContaining("pre-restore-"),
  });
  const installed = openProofCanvasDatabase({ path: destination.path });
  expect(new SqliteProjectRepository(installed).getProject(sourceProject.value.projectId).title).toBe("Finalized source");
  installed.close();
});

test("restore refuses a corrupt live target instead of publishing an unverifiable pre-restore copy", async () => {
  const source = harness();
  source.repository.createProject({ kind: "blank", title: "Source", mutationId: "mutation-create-corrupt-src-1" });
  const backup = await createOnlineBackup({ database: source.database, dataDirectory: source.directory });
  source.database.close();
  const destination = harness();
  destination.repository.createProject({ kind: "blank", title: "Corrupt target", mutationId: "mutation-create-corrupt-dst-1" });
  destination.database.prepare("UPDATE project_mutations SET response_json = '{}'").run();
  destination.database.close();

  expect(() => restoreOfflineBackup(backup.path, { dataDirectory: destination.directory }))
    .toThrow(/response has unexpected fields/);
  expect(existsSync(destination.path)).toBe(true);
  expect(readdirSync(join(destination.directory, "backups")).filter((name) => name.startsWith("pre-restore-")).length).toBe(0);
  const unchanged = openProofCanvasDatabase({ path: destination.path });
  expect(() => assertProofCanvasPersistenceIntegrity(unchanged)).toThrow(/response has unexpected fields/);
  unchanged.close();
});
