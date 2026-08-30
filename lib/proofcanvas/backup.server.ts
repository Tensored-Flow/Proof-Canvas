import type Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  DATABASE_FILENAME,
  acquireInstanceLease,
  assertNoOpenWritableProofCanvasDatabase,
  assertProofCanvasPersistenceIntegrity,
  canonicalProofCanvasDatabaseTarget,
  openProofCanvasDatabase,
  openProofCanvasDatabaseWithMaintenanceLease,
  proofCanvasDataDirectory,
  proofCanvasDatabase,
  releaseInstanceLease,
} from "./database.server";

export interface BackupReceipt {
  filename: string;
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export type RestoreBoundary = "source-snapshotted" | "staged-validated" | "pre-restore-published" | "before-atomic-replace" | "after-atomic-replace" | "finalize";

export class ProofCanvasRestoreCommittedError extends Error {
  readonly committed = true;

  constructor(
    message: string,
    public readonly previousPath: string | null,
    public readonly durability: "durable" | "uncertain",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProofCanvasRestoreCommittedError";
  }
}

export function committedRestoreStatus(error: unknown): {
  error: "restore_committed_cleanup_failed" | "restore_committed_durability_uncertain";
  committed: true;
  durability: "durable" | "uncertain";
  previousPath: string | null;
} | null {
  if (!(error instanceof ProofCanvasRestoreCommittedError)) return null;
  return {
    error: error.durability === "durable" ? "restore_committed_cleanup_failed" : "restore_committed_durability_uncertain",
    committed: error.committed,
    durability: error.durability,
    previousPath: error.previousPath,
  };
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function fileSha256Sync(path: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function removeSqliteSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

function pathsReferToSameFile(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true;
  try {
    const leftStats = statSync(left);
    const rightStats = statSync(right);
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
  } catch {
    return false;
  }
}

interface PrivateBackupSnapshot {
  directory: string;
  path: string;
  bytes: number;
  sha256: string;
}

function upgradeAndValidatePrivateBackupFile(path: string): void {
  let database: Database.Database | undefined;
  try {
    // The caller has already made a private copy. Writable migration is
    // intentionally confined to that copy so validating/restoring an older
    // backup never changes the source inode/link target, bytes, mode, mtime,
    // or SQLite sidecar/listing state (ordinary reads may update atime).
    database = openProofCanvasDatabase({ path });
    assertProofCanvasPersistenceIntegrity(database);
  } finally {
    if (database?.open) database.close();
  }
}

function removePrivateBackupSnapshot(snapshot: Pick<PrivateBackupSnapshot, "directory">): void {
  if (!existsSync(snapshot.directory)) return;
  const errors: unknown[] = [];
  try { chmodSync(snapshot.directory, 0o700); } catch (error) { errors.push(error); }
  try { rmSync(snapshot.directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (existsSync(snapshot.directory)) errors.push(new Error("Private ProofCanvas backup snapshot could not be removed"));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Private ProofCanvas backup snapshot cleanup failed");
}

function createValidatedPrivateBackupSnapshot(
  path: string,
  privateSnapshotRoot = tmpdir(),
  testObserver?: (snapshot: Readonly<PrivateBackupSnapshot>) => void,
): PrivateBackupSnapshot {
  if (testObserver && process.env.NODE_ENV !== "test") throw new Error("Backup snapshot observation is test-only");
  const regular = statSync(path, { throwIfNoEntry: true });
  if (!regular?.isFile()) throw new Error("ProofCanvas backup must be a regular file");
  mkdirSync(privateSnapshotRoot, { recursive: true, mode: 0o700 });
  const root = statSync(privateSnapshotRoot, { throwIfNoEntry: true });
  if (!root?.isDirectory()) throw new Error("ProofCanvas backup snapshot root must be a directory");
  const directory = mkdtempSync(join(resolve(privateSnapshotRoot), "proofcanvas-backup-snapshot-"));
  chmodSync(directory, 0o700);
  const privateCopy = join(directory, DATABASE_FILENAME);
  try {
    copyFileSync(path, privateCopy);
    chmodSync(privateCopy, 0o600);
    fsyncFile(privateCopy);
    upgradeAndValidatePrivateBackupFile(privateCopy);
    fsyncFile(privateCopy);
    const bytes = statSync(privateCopy).size;
    const sha256 = fileSha256Sync(privateCopy);
    chmodSync(privateCopy, 0o400);
    chmodSync(directory, 0o500);
    const snapshot = { directory, path: privateCopy, bytes, sha256 };
    testObserver?.(snapshot);
    return snapshot;
  } catch (error) {
    try {
      removePrivateBackupSnapshot({ directory });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "ProofCanvas backup validation and private snapshot cleanup failed");
    }
    throw error;
  }
}

function sanitizeStagedRestoreDatabase(path: string, lease: ReturnType<typeof acquireInstanceLease>): void {
  let database: Database.Database | undefined;
  try {
    database = openProofCanvasDatabaseWithMaintenanceLease(path, lease);
    database.transaction(() => {
      // A restored database may contain still-valid owner credentials from the
      // backup instant. Authentication state is installation/runtime state,
      // not owner project content, and must never be rolled back into service.
      database!.prepare("DELETE FROM sessions").run();
      database!.prepare("DELETE FROM auth_rate_limits").run();
      assertProofCanvasPersistenceIntegrity(database!);
    }).immediate();
    const checkpoint = database.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
    if (checkpoint.some(({ busy }) => busy !== 0)) throw new Error("Staged restore WAL could not be checkpointed");
    const journalMode = database.pragma("journal_mode = DELETE", { simple: true });
    if (journalMode !== "delete") throw new Error("Staged restore journal could not be consolidated");
  } finally {
    if (database?.open) database.close();
  }
  removeSqliteSidecars(path);
  fsyncFile(path);

  // Re-open the durable main file without writable sidecars so publication is
  // gated on the exact database inode that rename() will install.
  const durable = openProofCanvasDatabase({ path, readonly: true });
  try {
    assertProofCanvasPersistenceIntegrity(durable);
  } finally {
    durable.close();
  }
  fsyncFile(path);
}

export function validateProofCanvasBackup(path: string, options: {
  privateSnapshotRoot?: string;
  __testSnapshotObserver?: (snapshot: Readonly<PrivateBackupSnapshot>) => void;
} = {}): void {
  const snapshot = createValidatedPrivateBackupSnapshot(path, options.privateSnapshotRoot, options.__testSnapshotObserver);
  try {
    // Creation fully validates the exact immutable snapshot.
  } finally {
    removePrivateBackupSnapshot(snapshot);
  }
}

export async function createOnlineBackup(options: {
  database?: Database.Database;
  dataDirectory?: string;
  now?: Date;
  __testSnapshotObserver?: (snapshot: Readonly<PrivateBackupSnapshot>) => void;
} = {}): Promise<BackupReceipt> {
  const database = options.database ?? proofCanvasDatabase();
  const dataDirectory = resolve(options.dataDirectory ?? proofCanvasDataDirectory());
  const backupDirectory = join(dataDirectory, "backups");
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  const createdAt = (options.now ?? new Date()).toISOString();
  const filename = `proofcanvas-${safeTimestamp(new Date(createdAt))}-${randomBytes(4).toString("hex")}.sqlite3`;
  const destination = join(backupDirectory, filename);
  const temporary = join(backupDirectory, `.${filename}.partial`);
  try {
    await database.backup(temporary);
    // Production backups may legitimately be several GiB. Keep the private
    // migration/validation copy on the same provisioned local-locking volume
    // instead of depending on a small container /tmp filesystem.
    validateProofCanvasBackup(temporary, {
      privateSnapshotRoot: dataDirectory,
      __testSnapshotObserver: options.__testSnapshotObserver,
    });
    chmodSync(temporary, 0o600);
    fsyncFile(temporary);
    renameSync(temporary, destination);
    fsyncDirectory(backupDirectory);
    fsyncDirectory(dataDirectory);
    const stats = statSync(destination);
    return { filename, path: destination, bytes: stats.size, sha256: await fileSha256(destination), createdAt };
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Restore is intentionally offline. The CLI calls this only in its own process;
 * the canonical-directory SQLite lease rejects supported concurrent writers.
 */
export function restoreOfflineBackup(sourcePath: string, options: {
  dataDirectory?: string;
  privateSnapshotRoot?: string;
  now?: Date;
  __testFault?: (boundary: RestoreBoundary) => void;
} = {}): { restoredPath: string; previousPath: string | null } {
  const requestedDataDirectory = resolve(options.dataDirectory ?? proofCanvasDataDirectory());
  const requestedTarget = join(requestedDataDirectory, DATABASE_FILENAME);
  const source = resolve(sourcePath);
  if (options.__testFault && process.env.NODE_ENV !== "test") throw new Error("Restore fault injection is test-only");
  const fault = (boundary: RestoreBoundary) => options.__testFault?.(boundary);
  if (pathsReferToSameFile(source, requestedTarget)) throw new Error("Restore source must not be the live ProofCanvas database");
  const existingTarget = statSync(requestedTarget, { throwIfNoEntry: false });
  if (existingTarget && !existingTarget.isFile()) throw new Error("ProofCanvas database target must be a regular file");
  if (existingTarget && existingTarget.nlink !== 1) throw new Error("ProofCanvas database hard links are unsupported");
  const snapshot = createValidatedPrivateBackupSnapshot(source, options.privateSnapshotRoot);
  let dataDirectory = requestedDataDirectory;
  let target = requestedTarget;
  let lease: ReturnType<typeof acquireInstanceLease> | undefined;
  let staged: string | null = null;
  let preRestorePartial: string | null = null;
  let previousPath: string | null = null;
  let committed = false;
  let durable = false;
  let receipt: { restoredPath: string; previousPath: string | null } | undefined;
  let operationError: unknown;
  try {
    fault("source-snapshotted");
    mkdirSync(requestedDataDirectory, { recursive: true, mode: 0o700 });
    const canonicalTarget = canonicalProofCanvasDatabaseTarget(requestedTarget, true);
    dataDirectory = canonicalTarget.directory;
    target = canonicalTarget.path;
    assertNoOpenWritableProofCanvasDatabase(target);
    lease = acquireInstanceLease(dataDirectory);
    assertNoOpenWritableProofCanvasDatabase(target);
    staged = join(dataDirectory, `.restore-${randomBytes(8).toString("hex")}.sqlite3`);
    copyFileSync(snapshot.path, staged);
    chmodSync(staged, 0o600);
    fsyncFile(staged);
    if (statSync(staged).size !== snapshot.bytes || fileSha256Sync(staged) !== snapshot.sha256) {
      throw new Error("Staged restore does not match the validated private backup snapshot");
    }
    sanitizeStagedRestoreDatabase(staged, lease);
    fault("staged-validated");
    if (existsSync(target)) {
      const current = openProofCanvasDatabaseWithMaintenanceLease(target, lease);
      try {
        const checkpoint = current.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
        if (checkpoint.some(({ busy }) => busy !== 0)) throw new Error("Live database WAL could not be checkpointed for restore");
      } finally {
        current.close();
      }
      fsyncFile(target);
      rmSync(`${target}-wal`, { force: true });
      rmSync(`${target}-shm`, { force: true });
      rmSync(`${target}-journal`, { force: true });
      const backupDirectory = join(dataDirectory, "backups");
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      chmodSync(backupDirectory, 0o700);
      previousPath = join(backupDirectory, `pre-restore-${safeTimestamp(options.now ?? new Date())}-${randomBytes(4).toString("hex")}.sqlite3`);
      preRestorePartial = join(backupDirectory, `.pre-restore-${randomBytes(8).toString("hex")}.partial`);
      copyFileSync(target, preRestorePartial);
      chmodSync(preRestorePartial, 0o600);
      fsyncFile(preRestorePartial);
      if (statSync(target).size !== statSync(preRestorePartial).size || fileSha256Sync(target) !== fileSha256Sync(preRestorePartial)) {
        throw new Error("Pre-restore database copy could not be verified");
      }
      validateProofCanvasBackup(preRestorePartial, { privateSnapshotRoot: options.privateSnapshotRoot });
      renameSync(preRestorePartial, previousPath);
      preRestorePartial = null;
      fsyncDirectory(backupDirectory);
      fsyncDirectory(dataDirectory);
      fault("pre-restore-published");
    }
    fault("before-atomic-replace");
    if (previousPath && !existsSync(target)) throw new Error("Live database disappeared before atomic replacement");
    renameSync(staged, target);
    staged = null;
    committed = true;
    fault("after-atomic-replace");
    fsyncDirectory(dataDirectory);
    durable = true;
    receipt = { restoredPath: target, previousPath };
  } catch (error) {
    operationError = error;
  }
  const finalizerErrors: unknown[] = [];
  try { fault("finalize"); } catch (error) { finalizerErrors.push(error); }
  if (staged) {
    try {
      rmSync(staged, { force: true });
      removeSqliteSidecars(staged);
    } catch (error) { finalizerErrors.push(error); }
  }
  if (preRestorePartial) {
    try { rmSync(preRestorePartial, { force: true }); } catch (error) { finalizerErrors.push(error); }
  }
  if (lease) {
    try { releaseInstanceLease(lease); } catch (error) { finalizerErrors.push(error); }
  }
  try { removePrivateBackupSnapshot(snapshot); } catch (error) { finalizerErrors.push(error); }
  const failures = [...(operationError === undefined ? [] : [operationError]), ...finalizerErrors];
  const failure = failures.length > 1
    ? new AggregateError(failures, "ProofCanvas restore failed across operation and finalization boundaries")
    : failures[0];
  if (failure !== undefined) {
    if (committed) {
      throw new ProofCanvasRestoreCommittedError(
        durable
          ? "ProofCanvas restore was durably published, but final cleanup did not complete"
          : "ProofCanvas restore replaced the live database, but durable publication could not be confirmed",
        previousPath,
        durable ? "durable" : "uncertain",
        { cause: failure },
      );
    }
    throw failure;
  }
  return receipt!;
}

export function backupBasename(path: string): string {
  return basename(path);
}
