/** @jest-environment node */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
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
import { canonicalProjectJson, cloneSerializable } from "../schema";

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
  expect(first.database.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(first.database.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(first.database.pragma("synchronous", { simple: true })).toBe(2);
  expect(first.database.pragma("busy_timeout", { simple: true })).toBe(5_000);
  expect(first.database.pragma("trusted_schema", { simple: true })).toBe(0);
  expect(first.database.prepare("SELECT strict FROM pragma_table_list WHERE name = 'projects'").get()).toEqual({ strict: 1 });
  expect(first.database.prepare("SELECT version, name, checksum FROM schema_migrations").all()).toEqual(databaseMigrationManifest());
  first.database.close();

  const reopened = openProofCanvasDatabase({ path: first.path });
  expect(reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
  reopened.close();
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
