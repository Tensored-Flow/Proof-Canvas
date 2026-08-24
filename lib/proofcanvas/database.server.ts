import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalProjectJson, parseProjectDocument, type ProjectDocument } from "./schema";

export const DATABASE_FILENAME = "proofcanvas.sqlite3";
export const INSTANCE_LEASE_FILENAME = ".proofcanvas-instance-lease.sqlite3";
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

type SqliteDatabase = Database.Database;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [{
  version: 1,
  name: "private-owner-project-store",
  sql: `
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
      csrf_hash TEXT NOT NULL CHECK(length(csrf_hash) = 64),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      CHECK(expires_at > created_at)
    ) STRICT;

    CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
      document_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      shot_count INTEGER NOT NULL CHECK(shot_count >= 1),
      object_count INTEGER NOT NULL CHECK(object_count >= 0),
      duration_seconds REAL NOT NULL CHECK(duration_seconds > 0),
      thumbnail_mime TEXT,
      thumbnail_sha256 TEXT CHECK(thumbnail_sha256 IS NULL OR length(thumbnail_sha256) = 64),
      thumbnail_bytes INTEGER CHECK(thumbnail_bytes IS NULL OR thumbnail_bytes >= 0),
      thumbnail_width INTEGER CHECK(thumbnail_width IS NULL OR thumbnail_width > 0),
      thumbnail_height INTEGER CHECK(thumbnail_height IS NULL OR thumbnail_height > 0),
      thumbnail_updated_at TEXT,
      CHECK((deleted_at IS NULL) OR length(deleted_at) >= 20),
      CHECK((thumbnail_mime IS NULL AND thumbnail_sha256 IS NULL AND thumbnail_bytes IS NULL AND thumbnail_width IS NULL AND thumbnail_height IS NULL AND thumbnail_updated_at IS NULL)
        OR (thumbnail_mime IS NOT NULL AND thumbnail_sha256 IS NOT NULL AND thumbnail_bytes IS NOT NULL AND thumbnail_width IS NOT NULL AND thumbnail_height IS NOT NULL AND thumbnail_updated_at IS NOT NULL))
    ) STRICT;

    CREATE INDEX projects_active_updated_idx ON projects(deleted_at, updated_at DESC, id);

    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX checkpoints_project_created_idx ON checkpoints(project_id, created_at DESC, id);

    CREATE TABLE project_mutations (
      mutation_id TEXT PRIMARY KEY CHECK(length(mutation_id) BETWEEN 16 AND 128),
      project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 40),
      request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX project_mutations_project_created_idx ON project_mutations(project_id, created_at DESC);

    CREATE TABLE auth_rate_limits (
      bucket TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      failures INTEGER NOT NULL CHECK(failures >= 0),
      blocked_until INTEGER NOT NULL CHECK(blocked_until >= 0)
    ) STRICT;
  `,
}];

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL CHECK(length(checksum) = 64),
    applied_at TEXT NOT NULL
  ) STRICT;
`;

function checksum(migration: Migration): string {
  return createHash("sha256").update(`${migration.version}\n${migration.name}\n${migration.sql}`, "utf8").digest("hex");
}

export function proofCanvasDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PROOFCANVAS_DATA_DIR?.trim();
  if (environment.NODE_ENV === "production" && !configured) {
    throw new Error("PROOFCANVAS_DATA_DIR is required in production and must point at persistent storage");
  }
  const candidate = configured || join(process.cwd(), ".proofcanvas-data");
  return isAbsolute(candidate) ? resolve(candidate) : resolve(process.cwd(), candidate);
}

export function proofCanvasDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(proofCanvasDataDirectory(environment), DATABASE_FILENAME);
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function configureConnection(database: SqliteDatabase): void {
  database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  database.pragma("foreign_keys = ON");
  database.pragma("synchronous = FULL");
  database.pragma("trusted_schema = OFF");
}

function migrate(database: SqliteDatabase): void {
  database.exec(MIGRATION_TABLE_SQL);
  const applied = database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string; checksum: string }>;
  const known = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) throw new Error(`Database schema version ${row.version} is newer than this ProofCanvas build`);
    if (row.name !== migration.name || row.checksum !== checksum(migration)) {
      throw new Error(`Database migration ${row.version} checksum does not match this ProofCanvas build`);
    }
  }
  const appliedVersions = new Set(applied.map(({ version }) => version));
  const applyPending = database.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
        .run(migration.version, migration.name, checksum(migration), new Date().toISOString());
    }
  });
  applyPending.immediate();
  const latest = (database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version;
  if (latest !== MIGRATIONS.at(-1)?.version) throw new Error("ProofCanvas database migrations did not reach the expected version");
}

export interface OpenDatabaseOptions {
  path?: string;
  readonly?: boolean;
  migrate?: boolean;
}

const writableRegistryKey = Symbol.for("proofcanvas.database.writable-registry");
type GlobalWithWritableRegistry = typeof globalThis & { [writableRegistryKey]?: Map<string, Set<SqliteDatabase>> };
const directoryLeaseKey = Symbol.for("proofcanvas.database.directory-leases");
type WritableLease = { mode: "writable"; lease: InstanceLease; connections: Set<SqliteDatabase> };
type MaintenanceLease = { mode: "maintenance"; lease: InstanceLease };
type DirectoryLease = WritableLease | MaintenanceLease;
type GlobalWithDirectoryLeases = typeof globalThis & { [directoryLeaseKey]?: Map<string, DirectoryLease> };

function writableRegistry(): Map<string, Set<SqliteDatabase>> {
  const globals = globalThis as GlobalWithWritableRegistry;
  if (!globals[writableRegistryKey]) globals[writableRegistryKey] = new Map();
  return globals[writableRegistryKey]!;
}

function directoryLeases(): Map<string, DirectoryLease> {
  const globals = globalThis as GlobalWithDirectoryLeases;
  if (!globals[directoryLeaseKey]) globals[directoryLeaseKey] = new Map();
  return globals[directoryLeaseKey]!;
}

function canonicalDirectory(directory: string): string {
  return realpathSync(resolve(directory));
}

export interface CanonicalDatabaseTarget {
  path: string;
  directory: string;
  keys: readonly string[];
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function databaseFileKeys(path: string): string[] {
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error("ProofCanvas database target must be a regular file");
  if (stats.nlink !== 1) throw new Error("ProofCanvas database hard links are unsupported");
  return [`path:${path}`, `inode:${String(stats.dev)}:${String(stats.ino)}`];
}

export function canonicalProofCanvasDatabaseTarget(path: string, createParent = false): CanonicalDatabaseTarget {
  const requested = resolve(path);
  let entry: ReturnType<typeof lstatSync> | undefined;
  try {
    entry = lstatSync(requested);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (entry) {
    const canonicalPath = realpathSync(requested);
    return { path: canonicalPath, directory: dirname(canonicalPath), keys: databaseFileKeys(canonicalPath) };
  }
  if (createParent) ensurePrivateDirectory(dirname(requested));
  const directory = canonicalDirectory(dirname(requested));
  const canonicalPath = join(directory, basename(requested));
  return { path: canonicalPath, directory, keys: [`path:${canonicalPath}`] };
}

function assertLeaseFileSafe(path: string): void {
  let entry: ReturnType<typeof lstatSync> | undefined;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (!entry) return;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error("ProofCanvas instance lease must be a single-link regular file in the canonical data directory");
  }
}

export interface InstanceLease {
  readonly directory: string;
  readonly path: string;
  readonly database: SqliteDatabase;
}

function leaseUnavailable(error: unknown): boolean {
  return errorCode(error) === "SQLITE_BUSY" || errorCode(error) === "SQLITE_LOCKED";
}

function acquireRawInstanceLease(dataDirectory: string): InstanceLease {
  ensurePrivateDirectory(dataDirectory);
  const directory = canonicalDirectory(dataDirectory);
  const path = join(directory, INSTANCE_LEASE_FILENAME);
  assertLeaseFileSafe(path);
  let database: SqliteDatabase | undefined;
  try {
    database = new Database(path);
    database.pragma("busy_timeout = 0");
    database.pragma("trusted_schema = OFF");
    database.pragma("synchronous = FULL");
    database.pragma("locking_mode = NORMAL");
    database.pragma("journal_mode = DELETE");
    database.exec(`CREATE TABLE IF NOT EXISTS lease_guard (
      id INTEGER PRIMARY KEY CHECK(id = 1)
    ) STRICT`);
    database.prepare("INSERT OR IGNORE INTO lease_guard(id) VALUES (1)").run();
    chmodSync(path, 0o600);
    assertLeaseFileSafe(path);
    database.exec("BEGIN EXCLUSIVE");
    return { directory, path, database };
  } catch (error) {
    try { if (database?.open) database.close(); } catch { /* The original lease-acquisition error is authoritative. */ }
    if (leaseUnavailable(error)) throw new Error("Another ProofCanvas process owns the canonical data-directory lease", { cause: error });
    throw error;
  }
}

export function releaseInstanceLease(lease: InstanceLease): void {
  const state = directoryLeases().get(lease.directory);
  if (!state || state.mode !== "maintenance" || state.lease !== lease) {
    throw new Error("ProofCanvas maintenance lease is not the active lease for its canonical data directory");
  }
  try {
    releaseRawInstanceLease(lease);
  } finally {
    if (!lease.database.open) directoryLeases().delete(lease.directory);
  }
}

function releaseRawInstanceLease(lease: InstanceLease): void {
  const errors: unknown[] = [];
  if (lease.database.open && lease.database.inTransaction) {
    try { lease.database.exec("ROLLBACK"); } catch (error) { errors.push(error); }
  }
  if (lease.database.open) {
    try { lease.database.close(); } catch (error) { errors.push(error); }
  }
  if (lease.database.open) errors.push(new Error("ProofCanvas instance lease connection remained open"));
  if (errors.length) throw new AggregateError(errors, "ProofCanvas instance lease could not be released cleanly");
}

export function acquireInstanceLease(dataDirectory: string): InstanceLease {
  ensurePrivateDirectory(dataDirectory);
  const directory = canonicalDirectory(dataDirectory);
  if (directoryLeases().has(directory)) {
    throw new Error("ProofCanvas maintenance requires exclusive ownership of the canonical data directory");
  }
  const lease = acquireRawInstanceLease(directory);
  directoryLeases().set(directory, { mode: "maintenance", lease });
  return lease;
}

function acquireWritableLease(directory: string): { key: string; lease: WritableLease } {
  const key = canonicalDirectory(directory);
  const existing = directoryLeases().get(key);
  if (existing) {
    if (existing.mode !== "writable") {
      throw new Error("ProofCanvas maintenance owns the canonical data directory");
    }
    if (!existing.lease.database.open || !existing.lease.database.inTransaction) {
      throw new Error("ProofCanvas writable lease invariant was lost while database handles remain registered");
    }
    return { key, lease: existing };
  }
  const lease: WritableLease = { mode: "writable", lease: acquireRawInstanceLease(key), connections: new Set<SqliteDatabase>() };
  directoryLeases().set(key, lease);
  return { key, lease };
}

function releaseUnusedWritableLease(key: string, lease: WritableLease): void {
  if (lease.connections.size > 0 || directoryLeases().get(key) !== lease) return;
  try {
    releaseRawInstanceLease(lease.lease);
  } finally {
    if (!lease.lease.database.open) directoryLeases().delete(key);
  }
}

function registerWritableDatabase(target: CanonicalDatabaseTarget, database: SqliteDatabase, leaseKey: string, lease: WritableLease): void {
  for (const key of target.keys) {
    const connections = writableRegistry().get(key) ?? new Set<SqliteDatabase>();
    connections.add(database);
    writableRegistry().set(key, connections);
  }
  lease.connections.add(database);
  const close = database.close.bind(database);
  database.close = () => {
    const wasOpen = database.open;
    try {
      close();
    } finally {
      if (wasOpen && !database.open) {
        for (const key of target.keys) {
          const connections = writableRegistry().get(key);
          connections?.delete(database);
          if (connections?.size === 0) writableRegistry().delete(key);
        }
        lease.connections.delete(database);
        releaseUnusedWritableLease(leaseKey, lease);
      }
    }
    return database;
  };
}

export function assertNoOpenWritableProofCanvasDatabase(path: string): void {
  const target = canonicalProofCanvasDatabaseTarget(path);
  const connections = new Set<SqliteDatabase>();
  for (const key of target.keys) {
    for (const database of writableRegistry().get(key) ?? []) connections.add(database);
  }
  for (const database of connections) {
    if (database.open) throw new Error("Refusing to restore while a supported writable connection to the target database is open");
  }
}

export function openProofCanvasDatabase(options: OpenDatabaseOptions = {}): SqliteDatabase {
  const target = canonicalProofCanvasDatabaseTarget(options.path ?? proofCanvasDatabasePath(), !options.readonly);
  let writableLease: { key: string; lease: WritableLease } | undefined;
  if (!options.readonly) {
    ensurePrivateDirectory(target.directory);
    writableLease = acquireWritableLease(target.directory);
  }
  let database: SqliteDatabase | undefined;
  try {
    database = new Database(target.path, options.readonly ? { readonly: true, fileMustExist: true } : undefined);
    configureConnection(database);
    if (!options.readonly) {
      database.pragma("journal_mode = WAL");
      if (options.migrate !== false) migrate(database);
      chmodSync(target.path, 0o600);
      const openedTarget = canonicalProofCanvasDatabaseTarget(target.path);
      registerWritableDatabase(openedTarget, database, writableLease!.key, writableLease!.lease);
    }
    return database;
  } catch (error) {
    if (database?.open) database.close();
    if (writableLease) releaseUnusedWritableLease(writableLease.key, writableLease.lease);
    throw error;
  }
}

export function openProofCanvasDatabaseWithMaintenanceLease(path: string, lease: InstanceLease): SqliteDatabase {
  const target = canonicalProofCanvasDatabaseTarget(path);
  const registered = directoryLeases().get(target.directory);
  if (
    target.directory !== lease.directory
    || registered?.mode !== "maintenance"
    || registered.lease !== lease
    || !lease.database.open
    || !lease.database.inTransaction
  ) throw new Error("ProofCanvas maintenance database requires the active canonical data-directory lease");
  const database = new Database(target.path);
  try {
    configureConnection(database);
    database.pragma("journal_mode = WAL");
    chmodSync(target.path, 0o600);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

interface DatabaseSingleton {
  database: SqliteDatabase;
  path: string;
}

const singletonKey = Symbol.for("proofcanvas.database.singleton");
type GlobalWithDatabase = typeof globalThis & { [singletonKey]?: DatabaseSingleton };

export function proofCanvasDatabase(): SqliteDatabase {
  const globals = globalThis as GlobalWithDatabase;
  const path = proofCanvasDatabasePath();
  if (globals[singletonKey]) {
    if (globals[singletonKey]!.path !== path) throw new Error("PROOFCANVAS_DATA_DIR changed after the database was opened");
    return globals[singletonKey]!.database;
  }
  const database = openProofCanvasDatabase({ path });
  globals[singletonKey] = { database, path };
  return database;
}

export function closeProofCanvasDatabase(): void {
  const globals = globalThis as GlobalWithDatabase;
  const singleton = globals[singletonKey];
  if (!singleton) return;
  if (singleton.database.open) singleton.database.close();
  delete globals[singletonKey];
}

export function databaseMigrationManifest(): ReadonlyArray<{ version: number; name: string; checksum: string }> {
  return MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name, checksum: checksum(migration) }));
}

interface SchemaCatalogRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

interface PersistedProjectRow {
  id: string;
  title: string;
  document_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  shot_count: number;
  object_count: number;
  duration_seconds: number;
  thumbnail_mime: string | null;
  thumbnail_sha256: string | null;
  thumbnail_bytes: number | null;
  thumbnail_width: number | null;
  thumbnail_height: number | null;
  thumbnail_updated_at: string | null;
}

interface PersistedCheckpointRow {
  id: string;
  project_id: string;
  revision: number;
  label: string;
  document_json: string;
  created_at: string;
}

let expectedSchemaCatalogCache: SchemaCatalogRow[] | undefined;

function canonicalSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function schemaCatalog(database: SqliteDatabase): SchemaCatalogRow[] {
  return (database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name`).all() as SchemaCatalogRow[])
    .map((row) => ({ ...row, sql: canonicalSchemaSql(row.sql) }));
}

function expectedSchemaCatalog(): SchemaCatalogRow[] {
  if (expectedSchemaCatalogCache) return expectedSchemaCatalogCache;
  const reference = new Database(":memory:");
  try {
    configureConnection(reference);
    reference.exec(MIGRATION_TABLE_SQL);
    for (const migration of MIGRATIONS) reference.exec(migration.sql);
    expectedSchemaCatalogCache = schemaCatalog(reference);
    return expectedSchemaCatalogCache;
  } finally {
    reference.close();
  }
}

function persistenceFailure(detail: string): never {
  throw new Error(`ProofCanvas persistence integrity failed: ${detail}`);
}

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    persistenceFailure(`${field} is not a canonical UTC timestamp`);
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) persistenceFailure(`${field} is not a positive integer`);
}

function assertCanonicalDocument(raw: string, field: string): ProjectDocument {
  let document: ProjectDocument;
  try {
    document = parseProjectDocument(raw);
  } catch {
    return persistenceFailure(`${field} is not a valid ProjectDocument`);
  }
  if (canonicalProjectJson(document) !== raw) persistenceFailure(`${field} is not canonical JSON`);
  return document;
}

function assertThumbnail(row: PersistedProjectRow): void {
  const values = [
    row.thumbnail_mime,
    row.thumbnail_sha256,
    row.thumbnail_bytes,
    row.thumbnail_width,
    row.thumbnail_height,
    row.thumbnail_updated_at,
  ];
  if (values.every((value) => value === null)) return;
  if (values.some((value) => value === null)) persistenceFailure(`project ${row.id} has partial thumbnail metadata`);
  if (!["image/png", "image/jpeg", "image/webp"].includes(row.thumbnail_mime!)) persistenceFailure(`project ${row.id} has an invalid thumbnail MIME type`);
  if (!/^[a-f0-9]{64}$/.test(row.thumbnail_sha256!)) persistenceFailure(`project ${row.id} has an invalid thumbnail hash`);
  if (!Number.isSafeInteger(row.thumbnail_bytes) || row.thumbnail_bytes! < 0 || row.thumbnail_bytes! > 16 * 1024 * 1024) persistenceFailure(`project ${row.id} has invalid thumbnail bytes`);
  if (!Number.isSafeInteger(row.thumbnail_width) || row.thumbnail_width! < 1 || row.thumbnail_width! > 8_192) persistenceFailure(`project ${row.id} has invalid thumbnail width`);
  if (!Number.isSafeInteger(row.thumbnail_height) || row.thumbnail_height! < 1 || row.thumbnail_height! > 8_192) persistenceFailure(`project ${row.id} has invalid thumbnail height`);
  assertIsoTimestamp(row.thumbnail_updated_at, `project ${row.id} thumbnail_updated_at`);
}

function assertProjectRow(row: PersistedProjectRow): ProjectDocument {
  if (!/^project-[a-f0-9]{24}$/.test(row.id)) persistenceFailure(`project row has invalid id ${row.id}`);
  assertPositiveInteger(row.revision, `project ${row.id} revision`);
  assertIsoTimestamp(row.created_at, `project ${row.id} created_at`);
  assertIsoTimestamp(row.updated_at, `project ${row.id} updated_at`);
  if (row.deleted_at !== null) {
    assertIsoTimestamp(row.deleted_at, `project ${row.id} deleted_at`);
    if (row.deleted_at !== row.updated_at) persistenceFailure(`project ${row.id} deletion timestamp diverges from its update timestamp`);
  }
  const document = assertCanonicalDocument(row.document_json, `project ${row.id} document_json`);
  if (
    document.metadata.id !== row.id
    || document.metadata.title !== row.title
    || document.metadata.createdAt !== row.created_at
    || document.metadata.updatedAt !== row.updated_at
  ) persistenceFailure(`project ${row.id} row metadata diverges from its document`);
  const objectCount = document.shots.reduce((sum, shot) => sum + shot.objects.length, 0);
  const durationSeconds = document.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (row.shot_count !== document.shots.length || row.object_count !== objectCount || row.duration_seconds !== durationSeconds) {
    persistenceFailure(`project ${row.id} derived counters diverge from its document`);
  }
  assertThumbnail(row);
  return document;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) persistenceFailure(`${field} has unexpected fields`);
}

function assertProofCanvasPersistenceStructure(database: SqliteDatabase, check: "quick" | "full"): void {
  if (check === "full") {
    const integrity = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") persistenceFailure("SQLite integrity_check failed");
  } else {
    const quick = database.pragma("quick_check(1)") as Array<{ quick_check: string }>;
    if (quick.length !== 1 || quick[0]?.quick_check !== "ok") persistenceFailure("SQLite quick_check failed");
  }
  if ((database.pragma("foreign_key_check") as unknown[]).length) persistenceFailure("SQLite foreign-key check failed");
  if (JSON.stringify(schemaCatalog(database)) !== JSON.stringify(expectedSchemaCatalog())) persistenceFailure("schema catalog does not match this build");

  const applied = database.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string; checksum: string; applied_at: string }>;
  if (JSON.stringify(applied.map(({ applied_at: _appliedAt, ...row }) => row)) !== JSON.stringify(databaseMigrationManifest())) {
    persistenceFailure("migration manifest does not match this build");
  }
  for (const row of applied) assertIsoTimestamp(row.applied_at, `migration ${row.version} applied_at`);
}

function assertProofCanvasPersistenceRows(database: SqliteDatabase): void {
  const projectRows = database.prepare("SELECT * FROM projects ORDER BY id").all() as PersistedProjectRow[];
  const projects = new Map(projectRows.map((row) => [row.id, { row, document: assertProjectRow(row) }]));
  const checkpointRows = database.prepare("SELECT id, project_id, revision, label, document_json, created_at FROM checkpoints ORDER BY id").all() as PersistedCheckpointRow[];
  const checkpoints = new Map<string, PersistedCheckpointRow>();
  for (const row of checkpointRows) {
    if (!/^checkpoint-[a-f0-9]{24}$/.test(row.id)) persistenceFailure(`checkpoint row has invalid id ${row.id}`);
    const project = projects.get(row.project_id);
    if (!project) persistenceFailure(`checkpoint ${row.id} references a missing project`);
    assertPositiveInteger(row.revision, `checkpoint ${row.id} revision`);
    if (row.revision > project.row.revision) persistenceFailure(`checkpoint ${row.id} is newer than its project`);
    if (typeof row.label !== "string" || row.label.length < 1 || row.label.length > 120) persistenceFailure(`checkpoint ${row.id} has an invalid label`);
    assertIsoTimestamp(row.created_at, `checkpoint ${row.id} created_at`);
    const document = assertCanonicalDocument(row.document_json, `checkpoint ${row.id} document_json`);
    if (document.metadata.id !== row.project_id || document.metadata.createdAt !== project.row.created_at) {
      persistenceFailure(`checkpoint ${row.id} metadata diverges from its project`);
    }
    checkpoints.set(row.id, row);
  }

  const mutations = database.prepare("SELECT mutation_id, project_id, action, request_hash, response_json, created_at FROM project_mutations ORDER BY mutation_id").all() as Array<{
    mutation_id: string;
    project_id: string | null;
    action: string;
    request_hash: string;
    response_json: string;
    created_at: string;
  }>;
  const receiptFields: Record<string, readonly string[]> = {
    create: ["projectId", "revision", "updatedAt"],
    save: ["projectId", "revision", "updatedAt"],
    rename: ["projectId", "revision", "updatedAt"],
    duplicate: ["projectId", "revision", "updatedAt"],
    delete: ["projectId", "revision", "updatedAt", "deletedAt"],
    checkpoint: ["projectId", "revision", "updatedAt", "checkpointId"],
    recover: ["projectId", "revision", "updatedAt", "checkpointId", "preRestoreCheckpointId"],
  };
  const projectReceipts = new Map<string, Array<{ action: string; revision: number; updatedAt: string }>>();
  for (const row of mutations) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(row.mutation_id)) persistenceFailure(`mutation has invalid id ${row.mutation_id}`);
    if (!row.project_id || !projects.has(row.project_id)) persistenceFailure(`mutation ${row.mutation_id} references a missing project`);
    if (!/^[a-f0-9]{64}$/.test(row.request_hash)) persistenceFailure(`mutation ${row.mutation_id} has an invalid request hash`);
    assertIsoTimestamp(row.created_at, `mutation ${row.mutation_id} created_at`);
    const fields = receiptFields[row.action];
    if (!fields) persistenceFailure(`mutation ${row.mutation_id} has an invalid action`);
    let receipt: unknown;
    try { receipt = JSON.parse(row.response_json); } catch { persistenceFailure(`mutation ${row.mutation_id} has invalid response JSON`); }
    if (!plainRecord(receipt)) persistenceFailure(`mutation ${row.mutation_id} response is not an object`);
    if (JSON.stringify(receipt) !== row.response_json) persistenceFailure(`mutation ${row.mutation_id} response JSON is not canonical`);
    assertExactKeys(receipt, fields, `mutation ${row.mutation_id} response`);
    if (typeof receipt.projectId !== "string" || !projects.has(receipt.projectId)) persistenceFailure(`mutation ${row.mutation_id} response references a missing project`);
    if (row.action !== "duplicate" && receipt.projectId !== row.project_id) persistenceFailure(`mutation ${row.mutation_id} response project diverges from its row`);
    assertPositiveInteger(receipt.revision, `mutation ${row.mutation_id} response revision`);
    if (receipt.revision > projects.get(receipt.projectId)!.row.revision) persistenceFailure(`mutation ${row.mutation_id} response revision is newer than its project`);
    assertIsoTimestamp(receipt.updatedAt, `mutation ${row.mutation_id} response updatedAt`);
    if (receipt.updatedAt !== row.created_at) persistenceFailure(`mutation ${row.mutation_id} receipt timestamp diverges from its row`);
    const receipts = projectReceipts.get(receipt.projectId) ?? [];
    receipts.push({ action: row.action, revision: receipt.revision, updatedAt: receipt.updatedAt });
    projectReceipts.set(receipt.projectId, receipts);
    if (row.action === "create" || row.action === "duplicate") {
      if (receipt.revision !== 1) persistenceFailure(`mutation ${row.mutation_id} creation receipt is not revision one`);
    }
    if (row.action === "delete") {
      assertIsoTimestamp(receipt.deletedAt, `mutation ${row.mutation_id} response deletedAt`);
      if (projects.get(receipt.projectId)!.row.deleted_at !== receipt.deletedAt) persistenceFailure(`mutation ${row.mutation_id} delete receipt diverges from its project`);
    }
    for (const field of ["checkpointId", "preRestoreCheckpointId"] as const) {
      if (!(field in receipt)) continue;
      const checkpointId = receipt[field];
      if (typeof checkpointId !== "string" || checkpoints.get(checkpointId)?.project_id !== row.project_id) {
        persistenceFailure(`mutation ${row.mutation_id} has an invalid ${field}`);
      }
    }
  }

  for (const { row } of projects.values()) {
    const receipts = projectReceipts.get(row.id)?.sort((left, right) => left.revision - right.revision) ?? [];
    if (receipts.length !== row.revision) persistenceFailure(`project ${row.id} mutation history does not cover every revision`);
    for (const [index, receipt] of receipts.entries()) {
      if (receipt.revision !== index + 1) persistenceFailure(`project ${row.id} mutation revisions are not contiguous`);
    }
    const first = receipts[0];
    const latest = receipts.at(-1);
    if (!first || !["create", "duplicate"].includes(first.action) || first.updatedAt !== row.created_at) {
      persistenceFailure(`project ${row.id} creation receipt diverges from its row`);
    }
    if (!latest || latest.updatedAt !== row.updated_at) persistenceFailure(`project ${row.id} latest mutation receipt diverges from its row`);
    if ((row.deleted_at === null) === (latest.action === "delete")) persistenceFailure(`project ${row.id} deletion state diverges from its mutation history`);
  }

  const sessions = database.prepare("SELECT token_hash, csrf_hash, created_at, expires_at, last_seen_at FROM sessions").all() as Array<Record<string, unknown>>;
  for (const row of sessions) {
    if (typeof row.token_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.token_hash)) persistenceFailure("session has an invalid token hash");
    if (typeof row.csrf_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.csrf_hash)) persistenceFailure("session has an invalid CSRF hash");
    if (![row.created_at, row.expires_at, row.last_seen_at].every((value) => Number.isSafeInteger(value))) persistenceFailure("session has invalid timestamps");
    if (
      (row.expires_at as number) <= (row.created_at as number)
      || (row.last_seen_at as number) < (row.created_at as number)
      || (row.last_seen_at as number) >= (row.expires_at as number)
    ) persistenceFailure("session timestamp ordering is invalid");
  }
  const rateLimits = database.prepare("SELECT bucket, window_started_at, failures, blocked_until FROM auth_rate_limits").all() as Array<Record<string, unknown>>;
  for (const row of rateLimits) {
    if (row.bucket !== "owner-login") persistenceFailure("auth rate limit has an unknown bucket");
    if (!Number.isSafeInteger(row.window_started_at) || !Number.isSafeInteger(row.failures) || !Number.isSafeInteger(row.blocked_until)) persistenceFailure("auth rate limit has invalid values");
    if ((row.window_started_at as number) < 0 || (row.blocked_until as number) < 0) persistenceFailure("auth rate limit has invalid timestamps");
    if ((row.failures as number) < 1 || (row.failures as number) > LOGIN_RATE_MAX_FAILURES_FOR_INTEGRITY) persistenceFailure("auth rate limit failures exceed policy");
    if ((row.failures as number) < LOGIN_RATE_MAX_FAILURES_FOR_INTEGRITY && row.blocked_until !== 0) persistenceFailure("auth rate limit blocks below its threshold");
    if ((row.failures as number) === LOGIN_RATE_MAX_FAILURES_FOR_INTEGRITY && (row.blocked_until as number) <= (row.window_started_at as number)) {
      persistenceFailure("auth rate limit threshold has an invalid block window");
    }
  }
}

const LOGIN_RATE_MAX_FAILURES_FOR_INTEGRITY = 10;
const readinessDeepValidation = new WeakSet<SqliteDatabase>();

export function assertProofCanvasPersistenceIntegrity(database: SqliteDatabase): void {
  assertProofCanvasPersistenceStructure(database, "full");
  assertProofCanvasPersistenceRows(database);
}

export function assertProofCanvasDatabaseReady(database = proofCanvasDatabase()): void {
  // Health probes run frequently. Structural checks remain exact on every call,
  // while the complete repository scan runs once for each opened connection.
  // Supported writes pass through the validating repository; backup/restore
  // always perform an uncached full scan.
  assertProofCanvasPersistenceStructure(database, "quick");
  if (!readinessDeepValidation.has(database)) {
    assertProofCanvasPersistenceRows(database);
    readinessDeepValidation.add(database);
  }
}
