import type Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { PROOFCANVAS_ASSET_STORAGE_LIMITS, proofCanvasDatabase } from "./database.server";
import {
  AssetMetadataSchema,
  ProjectDocumentSchema,
  canonicalProjectJson,
  cloneSerializable,
  parseProjectDocument,
  projectDurationSeconds,
  type AssetMetadata,
  type ProjectDocument,
} from "./schema";
import { projectAuthoringIssue, projectAuthoringTransitionIssue } from "./authoringPolicy";
import { createProjectTemplate, type ProjectTemplateKind } from "./templates";
import { canonicalTimelineTime } from "./frame";
import {
  PROOFCANVAS_ASSET_CONTENT_LIMITS,
  validateAssetContent,
  type ProofCanvasAssetMimeType,
  type ValidatedAssetContent,
} from "./assetContent.server";
import { collectProjectIds } from "./ids";
import {
  buildProjectPackage,
  parseProjectPackage,
  type BuiltProjectPackage,
  type ParsedProjectPackage,
} from "./projectPackage.server";
import { ProjectPackageError } from "./projectPackage";
import { DETERMINISTIC_AUDIO_FIXTURE, createDeterministicAudioFixtureBytes } from "./demo";

export const PROJECT_LIST_LIMIT = 500;
export const CHECKPOINT_LIST_LIMIT = 100;

const ProjectIdSchema = z.string().regex(/^project-[a-f0-9]{24}$/).max(96);
const AssetIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/i).max(96);
const MutationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const TitleSchema = z.string().trim().min(1).max(160);
const CheckpointLabelSchema = z.string().trim().min(1).max(120);
const AssetUploadReceiptSchema = z.object({
  projectId: ProjectIdSchema,
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
  asset: AssetMetadataSchema,
}).strict();
const AssetDeleteReceiptSchema = z.object({
  projectId: ProjectIdSchema,
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
  assetId: AssetIdSchema,
}).strict();
const PackageImportReceiptSchema = z.object({
  projectId: ProjectIdSchema,
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
  sourceProjectId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  sourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const ThumbnailMetadataSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative().max(16 * 1024 * 1024),
  width: z.number().int().positive().max(8_192),
  height: z.number().int().positive().max(8_192),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export type ThumbnailMetadata = z.infer<typeof ThumbnailMetadataSchema>;

export class ProjectRepositoryError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | "project_not_found"
      | "project_recovery_required"
      | "revision_conflict"
      | "idempotency_conflict"
      | "invalid_project"
      | "repository_corrupt"
      | "asset_not_found"
      | "asset_in_use"
      | "asset_content_missing"
      | "asset_storage_limit",
    message: string,
    public readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "ProjectRepositoryError";
  }
}

export interface ProjectSummary {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  thumbnail: ThumbnailMetadata | null;
  shotCount: number;
  objectCount: number;
  durationSeconds: number;
  recoveryRequired: boolean;
}

export interface DurableProject extends ProjectSummary {
  document: ProjectDocument;
}

export interface ProjectCheckpoint {
  id: string;
  projectId: string;
  revision: number;
  label: string;
  createdAt: string;
  recoveryRequired: boolean;
}

export interface LegacyRecoveryDocument {
  ownerType: "project" | "checkpoint";
  ownerId: string;
  projectId: string;
  sha256: string;
  reason: string;
  documentJson: string;
}

export interface MutationReceipt {
  projectId: string;
  revision: number;
  updatedAt: string;
}

export interface DeleteReceipt extends MutationReceipt {
  deletedAt: string;
}

export interface CheckpointReceipt extends MutationReceipt {
  checkpointId: string;
}

export interface RecoveryReceipt extends MutationReceipt {
  checkpointId: string;
  preRestoreCheckpointId: string;
}

export interface AssetUploadReceipt extends MutationReceipt {
  asset: AssetMetadata;
}

export interface AssetDeleteReceipt extends MutationReceipt {
  assetId: string;
}

export interface PackageImportReceipt extends MutationReceipt {
  sourceProjectId: string;
  sourceRevision: number;
  packageSha256: string;
}

export interface ProjectAssetSummary extends AssetMetadata {
  available: boolean;
}

export interface ProjectAssetContent {
  asset: AssetMetadata;
  bytes: Buffer;
}

export interface IdempotentResult<T> {
  value: T;
  replayed: boolean;
}

export interface ProjectRepository {
  listProjects(): ProjectSummary[];
  getProject(projectId: string): DurableProject;
  createProject(input: { kind: ProjectTemplateKind; title: string; mutationId: string }): IdempotentResult<MutationReceipt>;
  saveProject(input: { projectId: string; expectedRevision: number; mutationId: string; document: ProjectDocument; thumbnail?: ThumbnailMetadata | null }): IdempotentResult<MutationReceipt>;
  renameProject(input: { projectId: string; expectedRevision: number; mutationId: string; title: string }): IdempotentResult<MutationReceipt>;
  duplicateProject(input: { projectId: string; expectedRevision: number; mutationId: string; title?: string }): IdempotentResult<MutationReceipt>;
  deleteProject(input: { projectId: string; expectedRevision: number; mutationId: string }): IdempotentResult<DeleteReceipt>;
  listCheckpoints(projectId: string): ProjectCheckpoint[];
  createCheckpoint(input: { projectId: string; expectedRevision: number; mutationId: string; label: string }): IdempotentResult<CheckpointReceipt>;
  recoverCheckpoint(input: { projectId: string; checkpointId: string; expectedRevision: number; mutationId: string }): IdempotentResult<RecoveryReceipt>;
  legacyRecoveryDocument(input: { projectId: string; checkpointId?: string }): LegacyRecoveryDocument;
  listProjectAssets(projectId: string): ProjectAssetSummary[];
  getProjectAsset(input: { projectId: string; assetId: string }): ProjectAssetContent;
  uploadProjectAsset(input: { projectId: string; expectedRevision: number; mutationId: string; content: ValidatedAssetContent }): IdempotentResult<AssetUploadReceipt>;
  deleteProjectAsset(input: { projectId: string; assetId: string; expectedRevision: number; mutationId: string }): IdempotentResult<AssetDeleteReceipt>;
  exportProjectPackage(projectId: string): BuiltProjectPackage;
  importProjectPackage(input: { mutationId: string; archiveBytes: Uint8Array }): IdempotentResult<PackageImportReceipt>;
}

interface ProjectRow {
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
  document_state: "ready" | "recovery-required";
}

type ProjectSummaryRow = Omit<ProjectRow, "document_json">;

interface MutationRow {
  action: string;
  request_hash: string;
  response_json: string;
}

interface AssetRefRow {
  project_id: string;
  asset_id: string;
  expected_sha256: string;
  blob_sha256: string | null;
  created_at: string;
}

interface AssetBlobMetadataRow {
  sha256: string;
  mime_type: ProofCanvasAssetMimeType;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  created_at: string;
}

interface AssetBlobRow extends AssetBlobMetadataRow {
  content: Buffer;
}

interface RepositoryOptions {
  now?: () => Date;
  randomId?: (prefix: "project" | "checkpoint" | "asset") => string;
}

function defaultRandomId(prefix: "project" | "checkpoint" | "asset"): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assertRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProjectRepositoryError(400, "invalid_project", "Expected revision must be a positive integer");
  return value;
}

function parseProjectId(value: string): string {
  const result = ProjectIdSchema.safeParse(value);
  if (!result.success) throw new ProjectRepositoryError(404, "project_not_found", "Project was not found");
  return result.data;
}

function parseMutationId(value: string): string {
  const result = MutationIdSchema.safeParse(value);
  if (!result.success) throw new ProjectRepositoryError(400, "invalid_project", "Mutation ID must contain 16–128 safe characters");
  return result.data;
}

function parseAssetId(value: string): string {
  const result = AssetIdSchema.safeParse(value);
  if (!result.success) throw new ProjectRepositoryError(404, "asset_not_found", "Asset was not found");
  return result.data;
}

function assetArraysEqual(left: readonly AssetMetadata[], right: readonly AssetMetadata[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assetMatchesBlob(asset: AssetMetadata, blob: AssetBlobMetadataRow): boolean {
  let canonicalBlobDuration: number | null = null;
  if (blob.duration_seconds !== null) {
    try {
      canonicalBlobDuration = canonicalTimelineTime(blob.duration_seconds);
    } catch {
      return false;
    }
  }
  return asset.sha256 === blob.sha256
    && asset.mimeType === blob.mime_type
    && asset.size === blob.byte_size
    && (asset.width ?? null) === blob.width
    && (asset.height ?? null) === blob.height
    && (asset.duration ?? null) === canonicalBlobDuration;
}

function assetMatchesValidatedContent(asset: AssetMetadata, content: ValidatedAssetContent): boolean {
  let canonicalContentDuration: number | null = null;
  if (content.duration !== undefined) {
    try {
      canonicalContentDuration = canonicalTimelineTime(content.duration);
    } catch {
      return false;
    }
  }
  return asset.filename === content.filename
    && asset.sha256 === content.sha256
    && asset.mimeType === content.mimeType
    && asset.size === content.size
    && (asset.width ?? null) === (content.width ?? null)
    && (asset.height ?? null) === (content.height ?? null)
    && (asset.duration ?? null) === canonicalContentDuration;
}

function validatedAssetAuthority(content: ValidatedAssetContent): Omit<ValidatedAssetContent, "contentBytes"> {
  const { contentBytes: _contentBytes, ...authority } = content;
  return authority;
}

function validatedBundledSampleContent(): ValidatedAssetContent {
  try {
    return validateAssetContent({
      filename: DETERMINISTIC_AUDIO_FIXTURE.metadata.filename,
      bytes: createDeterministicAudioFixtureBytes(),
      declaredSize: DETERMINISTIC_AUDIO_FIXTURE.metadata.size,
      claimedMimeType: DETERMINISTIC_AUDIO_FIXTURE.metadata.mimeType,
      expectedSha256: DETERMINISTIC_AUDIO_FIXTURE.metadata.sha256,
    });
  } catch {
    throw new ProjectRepositoryError(500, "repository_corrupt", "Bundled sample audio failed its deterministic content authority");
  }
}

function thumbnailFromRow(row: ProjectSummaryRow | ProjectRow): ThumbnailMetadata | null {
  if (row.thumbnail_mime === null) return null;
  const parsed = ThumbnailMetadataSchema.safeParse({
    mimeType: row.thumbnail_mime,
    sha256: row.thumbnail_sha256,
    bytes: row.thumbnail_bytes,
    width: row.thumbnail_width,
    height: row.thumbnail_height,
    updatedAt: row.thumbnail_updated_at,
  });
  if (!parsed.success) throw new ProjectRepositoryError(500, "repository_corrupt", "Stored project thumbnail metadata is invalid");
  return parsed.data;
}

function canonicalStoredDuration(value: number): number {
  try {
    const canonical = canonicalTimelineTime(value);
    if (canonical <= 0) throw new Error("duration must be positive");
    return canonical;
  } catch {
    throw new ProjectRepositoryError(500, "repository_corrupt", "Stored project duration is outside the authored timeline domain");
  }
}

function durableFromRow(row: ProjectRow): DurableProject {
  if (row.document_state === "recovery-required") {
    throw new ProjectRepositoryError(409, "project_recovery_required", "This schema-v2 project cannot be migrated losslessly; export its exact legacy JSON for recovery");
  }
  let document: ProjectDocument;
  try {
    document = parseProjectDocument(row.document_json);
  } catch {
    throw new ProjectRepositoryError(500, "repository_corrupt", "Stored project document is invalid");
  }
  if (
    document.metadata.id !== row.id
    || document.metadata.title !== row.title
    || document.metadata.createdAt !== row.created_at
    || document.metadata.updatedAt !== row.updated_at
  ) throw new ProjectRepositoryError(500, "repository_corrupt", "Stored project metadata does not match its repository row");
  const objectCount = document.shots.reduce((sum, shot) => sum + shot.objects.length, 0);
  const durationSeconds = projectDurationSeconds(document);
  if (row.shot_count !== document.shots.length || row.object_count !== objectCount || canonicalStoredDuration(row.duration_seconds) !== durationSeconds) {
    throw new ProjectRepositoryError(500, "repository_corrupt", "Stored project counters do not match its document");
  }
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    thumbnail: thumbnailFromRow(row),
    shotCount: document.shots.length,
    objectCount,
    durationSeconds,
    recoveryRequired: false,
    document,
  };
}

function summaryFromMetadataRow(row: ProjectSummaryRow): ProjectSummary {
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    thumbnail: thumbnailFromRow(row),
    shotCount: row.shot_count,
    objectCount: row.object_count,
    durationSeconds: canonicalStoredDuration(row.duration_seconds),
    recoveryRequired: row.document_state === "recovery-required",
  };
}

export class SqliteProjectRepository implements ProjectRepository {
  private readonly now: () => Date;
  private readonly randomId: (prefix: "project" | "checkpoint" | "asset") => string;

  constructor(private readonly database: Database.Database, options: RepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? defaultRandomId;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private activeRow(projectId: string): ProjectRow {
    const id = parseProjectId(projectId);
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL").get(id) as ProjectRow | undefined;
    if (!row) throw new ProjectRepositoryError(404, "project_not_found", "Project was not found");
    return row;
  }

  private readyActiveRow(projectId: string): ProjectRow {
    const row = this.activeRow(projectId);
    if (row.document_state === "recovery-required") {
      throw new ProjectRepositoryError(409, "project_recovery_required", "This schema-v2 project is read-only until its exact legacy JSON is recovered");
    }
    return row;
  }

  private assertProjectNotRecoveryRequired(projectId: string): void {
    const state = this.database.prepare("SELECT document_state FROM projects WHERE id = ?").get(projectId) as { document_state: "ready" | "recovery-required" } | undefined;
    if (state?.document_state === "recovery-required") {
      throw new ProjectRepositoryError(409, "project_recovery_required", "This schema-v2 project is read-only until its exact legacy JSON is recovered");
    }
  }

  private replay<T>(mutationId: string, action: string, hash: string): T | undefined {
    const row = this.database.prepare("SELECT action, request_hash, response_json FROM project_mutations WHERE mutation_id = ?").get(mutationId) as MutationRow | undefined;
    if (!row) return undefined;
    if (row.action !== action || row.request_hash !== hash) {
      throw new ProjectRepositoryError(409, "idempotency_conflict", "Mutation ID was already used for a different request");
    }
    try {
      const value = JSON.parse(row.response_json) as T;
      const receipt = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
      if (receipt) {
        if (typeof receipt.projectId === "string") {
          const project = this.database.prepare("SELECT document_state FROM projects WHERE id = ?").get(receipt.projectId) as { document_state: "ready" | "recovery-required" } | undefined;
          if (!project) throw new ProjectRepositoryError(500, "repository_corrupt", "Stored mutation receipt references a missing project");
          if (project.document_state === "recovery-required") {
            throw new ProjectRepositoryError(409, "project_recovery_required", "Stored mutation receipt references a schema-v2 project that requires exact recovery");
          }
        }
        for (const key of ["checkpointId", "preRestoreCheckpointId"] as const) {
          if (typeof receipt[key] !== "string") continue;
          const checkpoint = this.database.prepare("SELECT document_state FROM checkpoints WHERE id = ?").get(receipt[key]) as { document_state: "ready" | "recovery-required" } | undefined;
          if (!checkpoint) throw new ProjectRepositoryError(500, "repository_corrupt", "Stored mutation receipt references a missing checkpoint");
          if (checkpoint.document_state === "recovery-required") {
            throw new ProjectRepositoryError(409, "project_recovery_required", "Stored mutation receipt references a schema-v2 checkpoint that requires exact recovery");
          }
        }
      }
      return value;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(500, "repository_corrupt", "Stored mutation response is invalid");
    }
  }

  private recordMutation(projectId: string, mutationId: string, action: string, hash: string, value: unknown, now: string): void {
    this.database.prepare("INSERT INTO project_mutations(mutation_id, project_id, action, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(mutationId, projectId, action, hash, JSON.stringify(value), now);
  }

  private checkRevision(row: ProjectRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new ProjectRepositoryError(409, "revision_conflict", "Project changed since this revision was loaded", row.revision);
    }
  }

  private assetRefRow(projectId: string, asset: Pick<AssetMetadata, "id" | "sha256">): AssetRefRow | undefined {
    return this.database.prepare(`SELECT project_id, asset_id, expected_sha256, blob_sha256, created_at
      FROM project_asset_refs WHERE project_id = ? AND asset_id = ? AND expected_sha256 = ?`)
      .get(projectId, asset.id, asset.sha256) as AssetRefRow | undefined;
  }

  private assetBlobRow(sha256: string): AssetBlobRow | undefined {
    return this.database.prepare(`SELECT sha256, mime_type, byte_size, width, height, duration_seconds, content, created_at
      FROM asset_blobs WHERE sha256 = ?`).get(sha256) as AssetBlobRow | undefined;
  }

  private assetBlobMetadataRow(sha256: string): AssetBlobMetadataRow | undefined {
    return this.database.prepare(`SELECT sha256, mime_type, byte_size, width, height, duration_seconds, created_at
      FROM asset_blobs WHERE sha256 = ?`).get(sha256) as AssetBlobMetadataRow | undefined;
  }

  private assertAssetBindings(
    projectId: string,
    document: ProjectDocument,
    failure: "invalid_project" | "repository_corrupt" = "repository_corrupt",
  ): void {
    for (const asset of document.assets) {
      const ref = this.assetRefRow(projectId, asset);
      if (!ref) {
        throw new ProjectRepositoryError(
          failure === "repository_corrupt" ? 500 : 400,
          failure,
          failure === "repository_corrupt"
            ? "Stored project asset reference is missing"
            : `Asset ${asset.id} has no project-scoped content authority`,
        );
      }
      if (ref.blob_sha256 === null) continue;
      const blob = this.assetBlobMetadataRow(ref.blob_sha256);
      if (!blob || !assetMatchesBlob(asset, blob) || asset.size > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxItemBytes) {
        throw new ProjectRepositoryError(
          failure === "repository_corrupt" ? 500 : 400,
          failure,
          failure === "repository_corrupt"
            ? "Stored project asset metadata diverges from its content authority"
            : `Asset ${asset.id} metadata diverges from its validated content`,
        );
      }
    }
  }

  private allocateAssetId(projectId: string, document: ProjectDocument): string {
    const existing = collectProjectIds(document);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.randomId("asset");
      if (!AssetIdSchema.safeParse(candidate).success || existing.has(candidate)) continue;
      const retained = this.database.prepare(`SELECT 1 AS present FROM project_asset_refs
        WHERE project_id = ? AND asset_id = ? LIMIT 1`).get(projectId, candidate) as { present: 1 } | undefined;
      if (!retained) return candidate;
    }
    throw new ProjectRepositoryError(500, "repository_corrupt", "A fresh asset ID could not be allocated");
  }

  private allocateImportedProjectId(excludedIds: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.randomId("project");
      if (!ProjectIdSchema.safeParse(candidate).success || excludedIds.has(candidate)) continue;
      const existing = this.database.prepare("SELECT 1 AS present FROM projects WHERE id = ?").get(candidate) as { present: 1 } | undefined;
      if (!existing) return candidate;
    }
    throw new ProjectRepositoryError(500, "repository_corrupt", "A fresh imported project ID could not be allocated");
  }

  private assertAssetStorageCapacity(projectId: string, document: ProjectDocument, content: ValidatedAssetContent): void {
    if (document.assets.length >= 256) throw new ProjectRepositoryError(413, "asset_storage_limit", "Project asset count has reached its limit");
    const refs = this.database.prepare("SELECT COUNT(*) AS count FROM project_asset_refs WHERE project_id = ?")
      .get(projectId) as { count: number };
    if (!Number.isSafeInteger(refs.count) || refs.count >= PROOFCANVAS_ASSET_STORAGE_LIMITS.retainedRefsPerProject) {
      throw new ProjectRepositoryError(413, "asset_storage_limit", "Project retained asset-reference count has reached its limit");
    }

    const projectBytes = this.database.prepare(`SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM asset_blobs
      WHERE sha256 IN (SELECT DISTINCT blob_sha256 FROM project_asset_refs WHERE project_id = ? AND blob_sha256 IS NOT NULL)`)
      .get(projectId) as { bytes: number };
    const alreadyBound = this.database.prepare(`SELECT 1 AS present FROM project_asset_refs
      WHERE project_id = ? AND blob_sha256 = ? LIMIT 1`).get(projectId, content.sha256) as { present: 1 } | undefined;
    const nextProjectBytes = projectBytes.bytes + (alreadyBound ? 0 : content.size);
    if (!Number.isSafeInteger(nextProjectBytes) || nextProjectBytes > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAggregateBytes) {
      throw new ProjectRepositoryError(413, "asset_storage_limit", "Project retained asset bytes have reached their limit");
    }

    const existingBlob = this.database.prepare("SELECT 1 AS present FROM asset_blobs WHERE sha256 = ?").get(content.sha256) as { present: 1 } | undefined;
    if (!existingBlob) {
      const installation = this.database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM asset_blobs")
        .get() as { count: number; bytes: number };
      if (
        !Number.isSafeInteger(installation.count)
        || !Number.isSafeInteger(installation.bytes)
        || installation.count >= PROOFCANVAS_ASSET_STORAGE_LIMITS.blobsPerInstallation
        || installation.bytes > PROOFCANVAS_ASSET_STORAGE_LIMITS.blobBytesPerInstallation - content.size
      ) throw new ProjectRepositoryError(507, "asset_storage_limit", "ProofCanvas asset storage has reached its installation limit");
    }
  }

  private assertPackageStorageCapacity(contents: readonly ValidatedAssetContent[]): void {
    const unique = new Map(contents.map((content) => [content.sha256, content]));
    const projectBytes = [...unique.values()].reduce((sum, content) => sum + content.size, 0);
    if (!Number.isSafeInteger(projectBytes) || projectBytes > PROOFCANVAS_ASSET_STORAGE_LIMITS.blobBytesPerProject) {
      throw new ProjectRepositoryError(413, "asset_storage_limit", "Imported project asset bytes exceed the project limit");
    }
    const installation = this.database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM asset_blobs")
      .get() as { count: number; bytes: number };
    let newCount = 0;
    let newBytes = 0;
    for (const content of unique.values()) {
      const existing = this.database.prepare("SELECT 1 AS present FROM asset_blobs WHERE sha256 = ?").get(content.sha256) as { present: 1 } | undefined;
      if (existing) continue;
      newCount += 1;
      newBytes += content.size;
    }
    if (
      !Number.isSafeInteger(installation.count)
      || !Number.isSafeInteger(installation.bytes)
      || !Number.isSafeInteger(newBytes)
      || installation.count > PROOFCANVAS_ASSET_STORAGE_LIMITS.blobsPerInstallation - newCount
      || installation.bytes > PROOFCANVAS_ASSET_STORAGE_LIMITS.blobBytesPerInstallation - newBytes
    ) throw new ProjectRepositoryError(507, "asset_storage_limit", "ProofCanvas asset storage has reached its installation limit");
  }

  private insertOrVerifyAssetBlob(content: ValidatedAssetContent, now: string): void {
    this.database.prepare(`INSERT OR IGNORE INTO asset_blobs(
      sha256, mime_type, byte_size, width, height, duration_seconds, content, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        content.sha256,
        content.mimeType,
        content.size,
        content.width ?? null,
        content.height ?? null,
        content.duration ?? null,
        Buffer.from(content.contentBytes),
        now,
      );
    const blob = this.assetBlobRow(content.sha256);
    const bytes = Buffer.from(content.contentBytes);
    if (
      !blob
      || blob.mime_type !== content.mimeType
      || blob.byte_size !== content.size
      || blob.width !== (content.width ?? null)
      || blob.height !== (content.height ?? null)
      || blob.duration_seconds !== (content.duration ?? null)
      || !Buffer.isBuffer(blob.content)
      || blob.content.length !== bytes.length
      || !timingSafeEqual(blob.content, bytes)
    ) throw new ProjectRepositoryError(500, "repository_corrupt", "Content-addressed asset collision or corruption was detected");
  }

  private availableAssetBytes(projectId: string, asset: AssetMetadata): Buffer {
    const ref = this.assetRefRow(projectId, asset);
    if (!ref) throw new ProjectRepositoryError(500, "repository_corrupt", "Stored project asset reference is missing");
    if (ref.blob_sha256 === null) {
      throw new ProjectRepositoryError(409, "asset_content_missing", "Asset metadata was preserved, but trusted content bytes are not available");
    }
    const blob = this.assetBlobRow(ref.blob_sha256);
    if (!blob || !assetMatchesBlob(asset, blob)) throw new ProjectRepositoryError(500, "repository_corrupt", "Stored project asset content is invalid");
    try {
      const validated = validateAssetContent({
        filename: asset.filename,
        bytes: blob.content,
        declaredSize: blob.byte_size,
        claimedMimeType: blob.mime_type,
        expectedSha256: blob.sha256,
      });
      return Buffer.from(
        validated.contentBytes.buffer as ArrayBuffer,
        validated.contentBytes.byteOffset,
        validated.contentBytes.byteLength,
      );
    } catch {
      throw new ProjectRepositoryError(500, "repository_corrupt", "Stored project asset content is invalid");
    }
  }

  private validateParsedPackageAssets(parsed: ParsedProjectPackage): Array<{
    metadata: AssetMetadata;
    content: ValidatedAssetContent;
  }> {
    // parseProjectPackage has already fully decoded and copied each unique
    // content-addressed entry. Rebind every project-local tuple here while
    // hashing each unique retained buffer once; do not amplify an expensive
    // JPEG/WebP decode across many IDs that intentionally share one blob.
    const contentBySha256 = new Map<string, ValidatedAssetContent>();
    return parsed.assets.map((asset) => {
      if (asset.assetId !== asset.metadata.id) {
        throw new ProjectRepositoryError(400, "invalid_project", "Imported package asset identity diverges from its manifest");
      }
      let shared = contentBySha256.get(asset.metadata.sha256);
      if (!shared) {
        if (asset.validatedContent.contentBytes !== asset.contentBytes
          || asset.contentBytes.byteLength !== asset.metadata.size
          || createHash("sha256").update(asset.contentBytes).digest("hex") !== asset.metadata.sha256) {
          throw new ProjectRepositoryError(400, "invalid_project", "Imported package asset bytes diverge from their content authority");
        }
        shared = asset.validatedContent;
        contentBySha256.set(asset.metadata.sha256, shared);
      } else if (asset.contentBytes !== shared.contentBytes
        || asset.validatedContent.contentBytes !== shared.contentBytes
        || asset.validatedContent.mimeType !== shared.mimeType
        || asset.validatedContent.size !== shared.size
        || asset.validatedContent.sha256 !== shared.sha256
        || asset.validatedContent.width !== shared.width
        || asset.validatedContent.height !== shared.height
        || asset.validatedContent.duration !== shared.duration) {
        throw new ProjectRepositoryError(400, "invalid_project", "Imported package did not retain one authority per content hash");
      }
      const content: ValidatedAssetContent = { ...shared, filename: asset.metadata.filename };
      if (!assetMatchesValidatedContent(asset.metadata, content)) {
        throw new ProjectRepositoryError(400, "invalid_project", "Imported package asset metadata diverges from its content");
      }
      return {
        metadata: cloneSerializable(asset.metadata),
        content,
      };
    });
  }

  listProjects(): ProjectSummary[] {
    const rows = this.database.prepare(`SELECT
      id, title, revision, created_at, updated_at, deleted_at, shot_count, object_count, duration_seconds, document_state,
      thumbnail_mime, thumbnail_sha256, thumbnail_bytes, thumbnail_width, thumbnail_height, thumbnail_updated_at
      FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC, id LIMIT ?`)
      .all(PROJECT_LIST_LIMIT) as ProjectSummaryRow[];
    return rows.map(summaryFromMetadataRow);
  }

  getProject(projectId: string): DurableProject {
    const durable = durableFromRow(this.readyActiveRow(projectId));
    this.assertAssetBindings(durable.id, durable.document);
    return durable;
  }

  createProject(input: { kind: ProjectTemplateKind; title: string; mutationId: string }): IdempotentResult<MutationReceipt> {
    const mutationId = parseMutationId(input.mutationId);
    const title = TitleSchema.parse(input.title);
    if (input.kind !== "blank" && input.kind !== "sample") throw new ProjectRepositoryError(400, "invalid_project", "Unknown project template");
    // Generate and validate bundled bytes before acquiring SQLite's sole
    // writer lock. Publication of the project/blob/ref remains one transaction.
    const bundledSample = input.kind === "sample" ? validatedBundledSampleContent() : undefined;
    const hash = requestHash({ kind: input.kind, title });
    return this.database.transaction(() => {
      const replayed = this.replay<MutationReceipt>(mutationId, "create", hash);
      if (replayed) return { value: replayed, replayed: true };
      const now = this.isoNow();
      const projectId = parseProjectId(this.randomId("project"));
      const document = createProjectTemplate(input.kind, projectId, title, now);
      this.database.prepare(`INSERT INTO projects(
        id, title, document_json, revision, created_at, updated_at, deleted_at, shot_count, object_count, duration_seconds,
        thumbnail_mime, thumbnail_sha256, thumbnail_bytes, thumbnail_width, thumbnail_height, thumbnail_updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`)
        .run(
          projectId,
          title,
          canonicalProjectJson(document),
          now,
          now,
          document.shots.length,
          document.shots.reduce((sum, shot) => sum + shot.objects.length, 0),
          projectDurationSeconds(document),
        );
      if (input.kind === "sample") {
        const fixture = bundledSample!;
        const asset = document.assets.find(({ id }) => id === DETERMINISTIC_AUDIO_FIXTURE.metadata.id);
        if (
          document.assets.length !== 1
          || !asset
          || asset.provenance !== "bundled"
          || !assetMatchesValidatedContent(asset, fixture)
        ) throw new ProjectRepositoryError(500, "repository_corrupt", "Bundled sample asset authority diverges from its deterministic fixture");
        this.assertAssetStorageCapacity(projectId, document, fixture);
        this.insertOrVerifyAssetBlob(fixture, now);
        const insertedRef = this.database.prepare(`INSERT INTO project_asset_refs(
          project_id, asset_id, expected_sha256, blob_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?)`)
          .run(projectId, asset.id, asset.sha256, asset.sha256, now);
        if (insertedRef.changes !== 1) {
          throw new ProjectRepositoryError(500, "repository_corrupt", "Bundled sample asset reference could not be recorded");
        }
        this.assertAssetBindings(projectId, document);
      }
      const receipt = { projectId, revision: 1, updatedAt: now } satisfies MutationReceipt;
      this.recordMutation(projectId, mutationId, "create", hash, receipt, now);
      return { value: receipt, replayed: false };
    }).immediate();
  }

  saveProject(input: { projectId: string; expectedRevision: number; mutationId: string; document: ProjectDocument; thumbnail?: ThumbnailMetadata | null }): IdempotentResult<MutationReceipt> {
    const projectId = parseProjectId(input.projectId);
    const expectedRevision = assertRevision(input.expectedRevision);
    const mutationId = parseMutationId(input.mutationId);
    let supplied: ProjectDocument;
    try {
      supplied = ProjectDocumentSchema.parse(input.document);
    } catch {
      throw new ProjectRepositoryError(400, "invalid_project", "Project document did not pass validation");
    }
    if (supplied.metadata.id !== projectId) throw new ProjectRepositoryError(400, "invalid_project", "Project document identity does not match the route");
    const thumbnail = input.thumbnail === undefined ? undefined : input.thumbnail === null ? null : ThumbnailMetadataSchema.parse(input.thumbnail);
    const hash = requestHash({ projectId, expectedRevision, document: canonicalProjectJson(supplied), thumbnail });
    return this.database.transaction(() => {
      this.assertProjectNotRecoveryRequired(projectId);
      const replayed = this.replay<MutationReceipt>(mutationId, "save", hash);
      if (replayed) return { value: replayed, replayed: true };
      const row = this.readyActiveRow(projectId);
      this.checkRevision(row, expectedRevision);
      const previous = durableFromRow(row).document;
      this.assertAssetBindings(projectId, previous);
      if (!assetArraysEqual(previous.assets, supplied.assets)) {
        throw new ProjectRepositoryError(400, "invalid_project", "Project assets may be changed only through authenticated asset operations");
      }
      this.assertAssetBindings(projectId, supplied, "invalid_project");
      const authoringIssue = projectAuthoringTransitionIssue(previous, supplied);
      if (authoringIssue) throw new ProjectRepositoryError(400, "invalid_project", authoringIssue);
      const now = this.isoNow();
      const document = ProjectDocumentSchema.parse({
        ...cloneSerializable(supplied),
        metadata: { ...supplied.metadata, id: projectId, title: supplied.metadata.title.trim(), createdAt: row.created_at, updatedAt: now },
      });
      const nextRevision = row.revision + 1;
      const currentThumbnail = thumbnail === undefined ? thumbnailFromRow(row) : thumbnail;
      const changed = this.database.prepare(`UPDATE projects SET
        title = ?, document_json = ?, revision = ?, updated_at = ?,
        shot_count = ?, object_count = ?, duration_seconds = ?,
        thumbnail_mime = ?, thumbnail_sha256 = ?, thumbnail_bytes = ?, thumbnail_width = ?, thumbnail_height = ?, thumbnail_updated_at = ?
        WHERE id = ? AND deleted_at IS NULL AND revision = ?`)
        .run(
          document.metadata.title,
          canonicalProjectJson(document),
          nextRevision,
          now,
          document.shots.length,
          document.shots.reduce((sum, shot) => sum + shot.objects.length, 0),
          projectDurationSeconds(document),
          currentThumbnail?.mimeType ?? null,
          currentThumbnail?.sha256 ?? null,
          currentThumbnail?.bytes ?? null,
          currentThumbnail?.width ?? null,
          currentThumbnail?.height ?? null,
          currentThumbnail?.updatedAt ?? null,
          projectId,
          expectedRevision,
        );
      if (changed.changes !== 1) throw new ProjectRepositoryError(409, "revision_conflict", "Project changed while it was being saved");
      const receipt = { projectId, revision: nextRevision, updatedAt: now } satisfies MutationReceipt;
      this.recordMutation(projectId, mutationId, "save", hash, receipt, now);
      return { value: receipt, replayed: false };
    }).immediate();
  }

  renameProject(input: { projectId: string; expectedRevision: number; mutationId: string; title: string }): IdempotentResult<MutationReceipt> {
    const projectId = parseProjectId(input.projectId);
    const expectedRevision = assertRevision(input.expectedRevision);
    const mutationId = parseMutationId(input.mutationId);
    const title = TitleSchema.parse(input.title);
    const hash = requestHash({ projectId, expectedRevision, title });
    return this.database.transaction(() => {
      this.assertProjectNotRecoveryRequired(projectId);
      const replayed = this.replay<MutationReceipt>(mutationId, "rename", hash);
      if (replayed) return { value: replayed, replayed: true };
      const row = this.readyActiveRow(projectId);
      this.checkRevision(row, expectedRevision);
      const current = durableFromRow(row).document;
      this.assertAssetBindings(projectId, current);
      const now = this.isoNow();
      const document = ProjectDocumentSchema.parse({ ...cloneSerializable(current), metadata: { ...current.metadata, title, updatedAt: now } });
      const receipt = { projectId, revision: row.revision + 1, updatedAt: now } satisfies MutationReceipt;
      this.database.prepare("UPDATE projects SET title = ?, document_json = ?, revision = ?, updated_at = ?, duration_seconds = ? WHERE id = ? AND deleted_at IS NULL AND revision = ?")
        .run(title, canonicalProjectJson(document), receipt.revision, now, projectDurationSeconds(document), projectId, expectedRevision);
      this.recordMutation(projectId, mutationId, "rename", hash, receipt, now);
      return { value: receipt, replayed: false };
    }).immediate();
  }

  duplicateProject(input: { projectId: string; expectedRevision: number; mutationId: string; title?: string }): IdempotentResult<MutationReceipt> {
    const projectId = parseProjectId(input.projectId);
    const expectedRevision = assertRevision(input.expectedRevision);
    const mutationId = parseMutationId(input.mutationId);
    const requestedTitle = input.title === undefined ? undefined : TitleSchema.parse(input.title);
    const hash = requestHash({ projectId, expectedRevision, title: requestedTitle });
    return this.database.transaction(() => {
      this.assertProjectNotRecoveryRequired(projectId);
      const replayed = this.replay<MutationReceipt>(mutationId, "duplicate", hash);
      if (replayed) return { value: replayed, replayed: true };
      const source = this.readyActiveRow(projectId);
      this.checkRevision(source, expectedRevision);
      const sourceDocument = durableFromRow(source).document;
      this.assertAssetBindings(projectId, sourceDocument);
      const sourceIssue = projectAuthoringIssue(sourceDocument);
      if (sourceIssue) {
        throw new ProjectRepositoryError(400, "invalid_project", `Repair renderer-rejected authority before duplicating this project. ${sourceIssue}`);
      }
      const now = this.isoNow();
      const duplicateId = parseProjectId(this.randomId("project"));
      const title = requestedTitle ?? `${source.title} copy`.slice(0, 160);
      const document = ProjectDocumentSchema.parse({
        ...cloneSerializable(sourceDocument),
        metadata: { id: duplicateId, title, createdAt: now, updatedAt: now },
      });
      this.database.prepare(`INSERT INTO projects(
        id, title, document_json, revision, created_at, updated_at, deleted_at, shot_count, object_count, duration_seconds,
        thumbnail_mime, thumbnail_sha256, thumbnail_bytes, thumbnail_width, thumbnail_height, thumbnail_updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          duplicateId,
          title,
          canonicalProjectJson(document),
          now,
          now,
          document.shots.length,
          document.shots.reduce((sum, shot) => sum + shot.objects.length, 0),
          projectDurationSeconds(document),
          source.thumbnail_mime,
          source.thumbnail_sha256,
          source.thumbnail_bytes,
          source.thumbnail_width,
          source.thumbnail_height,
          source.thumbnail_updated_at,
        );
      const copyRef = this.database.prepare(`INSERT INTO project_asset_refs(
        project_id, asset_id, expected_sha256, blob_sha256, created_at
      ) SELECT ?, asset_id, expected_sha256, blob_sha256, ? FROM project_asset_refs
        WHERE project_id = ? AND asset_id = ? AND expected_sha256 = ?`);
      for (const asset of sourceDocument.assets) {
        const copied = copyRef.run(duplicateId, now, projectId, asset.id, asset.sha256);
        if (copied.changes !== 1) throw new ProjectRepositoryError(500, "repository_corrupt", "Project duplication could not preserve an asset reference");
      }
      const receipt = { projectId: duplicateId, revision: 1, updatedAt: now } satisfies MutationReceipt;
      this.recordMutation(projectId, mutationId, "duplicate", hash, receipt, now);
      return { value: receipt, replayed: false };
    }).immediate();
  }

  deleteProject(input: { projectId: string; expectedRevision: number; mutationId: string }): IdempotentResult<DeleteReceipt> {
    const projectId = parseProjectId(input.projectId);
    const expectedRevision = assertRevision(input.expectedRevision);
    const mutationId = parseMutationId(input.mutationId);
    const hash = requestHash({ projectId, expectedRevision });
    return this.database.transaction(() => {
      this.assertProjectNotRecoveryRequired(projectId);
      const replayed = this.replay<DeleteReceipt>(mutationId, "delete", hash);
      if (replayed) return { value: replayed, replayed: true };
      const row = this.readyActiveRow(projectId);
      this.checkRevision(row, expectedRevision);
      const now = this.isoNow();
      const current = durableFromRow(row).document;
      this.assertAssetBindings(projectId, current);
      const document = ProjectDocumentSchema.parse({
        ...cloneSerializable(current),
        metadata: { ...current.metadata, updatedAt: now },
      });
      const receipt = { projectId, revision: row.revision + 1, updatedAt: now, deletedAt: now } satisfies DeleteReceipt;
      const changed = this.database.prepare("UPDATE projects SET document_json = ?, revision = ?, updated_at = ?, deleted_at = ?, duration_seconds = ? WHERE id = ? AND deleted_at IS NULL AND revision = ?")
        .run(canonicalProjectJson(document), receipt.revision, now, now, projectDurationSeconds(document), projectId, expectedRevision);
      if (changed.changes !== 1) throw new ProjectRepositoryError(409, "revision_conflict", "Project changed while it was being deleted");
      this.recordMutation(projectId, mutationId, "delete", hash, receipt, now);
      return { value: receipt, replayed: false };
    }).immediate();
  }

  listCheckpoints(projectId: string): ProjectCheckpoint[] {
    const id = parseProjectId(projectId);
    this.activeRow(id);
    const rows = this.database.prepare("SELECT id, project_id, revision, label, document_json, created_at, document_state FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(id, CHECKPOINT_LIST_LIMIT) as Array<{ id: string; project_id: string; revision: number; label: string; document_json: string; created_at: string; document_state: "ready" | "recovery-required" }>;
    return rows.map((row) => {
      if (row.document_state === "ready") {
        try {
          parseProjectDocument(row.document_json);
        } catch {
          throw new ProjectRepositoryError(500, "repository_corrupt", "Stored checkpoint document is invalid");
        }
      }
      return { id: row.id, projectId: row.project_id, revision: row.revision, label: row.label, createdAt: row.created_at, recoveryRequired: row.document_state === "recovery-required" };
    });
  }

  createCheckpoint(input: { projectId: string; expectedRevision: number; mutationId: string; label: string }): IdempotentResult<CheckpointReceipt> {
    const projectId = parseProjectId(input.projectId);
    const expectedRevision = assertRevision(input.expectedRevision);
    const mutationId = parseMutationId(input.mutationId);
    const label = CheckpointLabelSchema.parse(input.label);
    const hash = requestHash({ projectId, expectedRevision, label });
    return this.database.transaction(() => {
      this.assertProjectNotRecoveryRequired(projectId);
      const replayed = this.replay<CheckpointReceipt>(mutationId, "checkpoint", hash);
      if (replayed) return { value: replayed, replayed: true };
      const row = this.readyActiveRow(projectId);
      this.checkRevision(row, expectedRevision);
      const current = durableFromRow(row).document;
      this.assertAssetBindings(projectId, current);
      const now = this.isoNow();
      const checkpointId = this.randomId("checkpoint");
      this.database.prepare("INSERT INTO checkpoints(id, project_id, revision, label, document_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(checkpointId, projectId, row.revision, label, canonicalProjectJson(current), now);
      const document = ProjectDocumentSchema.parse({ ...cloneSerializable(current), metadata: { ...current.metadata, updatedAt: now } });
      const receipt = { projectId, revision: row.revision + 1, updatedAt: now, checkpointId } satisfies CheckpointReceipt;
      this.database.prepare("UPDATE projects SET document_json = ?, revision = ?, updated_at = ?, duration_seconds = ? WHERE id = ? AND deleted_at IS NULL AND revision = ?")
        .run(canonicalProjectJson(document), receipt.revision, now, projectDurationSeconds(document), projectId, expectedRevision);
      this.recordMutation(projectId, mutationId, "checkpoint", hash, receipt, now);
      return { value: receipt, replayed: false };
    }).immediate();
  }

  recoverCheckpoint(input: { projectId: string; checkpointId: string; expectedRevision: number; mutationId: string }): IdempotentResult<RecoveryReceipt> {
    const projectId = parseProjectId(input.projectId);
    const expectedRevision = assertRevision(input.expectedRevision);
    const mutationId = parseMutationId(input.mutationId);
    const checkpointId = z.string().regex(/^checkpoint-[a-f0-9]{24}$/).parse(input.checkpointId);
    const hash = requestHash({ projectId, checkpointId, expectedRevision });
    return this.database.transaction(() => {
      this.assertProjectNotRecoveryRequired(projectId);
      const checkpointState = this.database.prepare("SELECT document_state FROM checkpoints WHERE id = ? AND project_id = ?").get(checkpointId, projectId) as { document_state: "ready" | "recovery-required" } | undefined;
      if (checkpointState?.document_state === "recovery-required") {
        throw new ProjectRepositoryError(409, "project_recovery_required", "This schema-v2 checkpoint cannot be recovered losslessly; export its exact legacy JSON instead");
      }
      const replayed = this.replay<RecoveryReceipt>(mutationId, "recover", hash);
      if (replayed) return { value: replayed, replayed: true };
      const row = this.readyActiveRow(projectId);
      this.checkRevision(row, expectedRevision);
      const current = durableFromRow(row).document;
      this.assertAssetBindings(projectId, current);
      const checkpoint = this.database.prepare("SELECT document_json, document_state FROM checkpoints WHERE id = ? AND project_id = ?").get(checkpointId, projectId) as { document_json: string; document_state: "ready" | "recovery-required" } | undefined;
      if (!checkpoint) throw new ProjectRepositoryError(404, "project_not_found", "Checkpoint was not found");
      if (checkpoint.document_state === "recovery-required") {
        throw new ProjectRepositoryError(409, "project_recovery_required", "This schema-v2 checkpoint cannot be recovered losslessly; export its exact legacy JSON instead");
      }
      let restored: ProjectDocument;
      try {
        restored = parseProjectDocument(checkpoint.document_json);
      } catch {
        throw new ProjectRepositoryError(500, "repository_corrupt", "Stored checkpoint document is invalid");
      }
      const now = this.isoNow();
      const document = ProjectDocumentSchema.parse({
        ...cloneSerializable(restored),
        metadata: { ...restored.metadata, id: projectId, createdAt: row.created_at, updatedAt: now },
      });
      this.assertAssetBindings(projectId, document);
      const authoringIssue = projectAuthoringTransitionIssue(current, document);
      if (authoringIssue) throw new ProjectRepositoryError(400, "invalid_project", authoringIssue);
      const preRestoreCheckpointId = this.randomId("checkpoint");
      this.database.prepare("INSERT INTO checkpoints(id, project_id, revision, label, document_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(preRestoreCheckpointId, projectId, row.revision, "Before checkpoint recovery", canonicalProjectJson(current), now);
      const receipt = {
        projectId,
        revision: row.revision + 1,
        updatedAt: now,
        checkpointId,
        preRestoreCheckpointId,
      } satisfies RecoveryReceipt;
      const changed = this.database.prepare("UPDATE projects SET title = ?, document_json = ?, revision = ?, updated_at = ?, shot_count = ?, object_count = ?, duration_seconds = ? WHERE id = ? AND deleted_at IS NULL AND revision = ?")
        .run(
          document.metadata.title,
          canonicalProjectJson(document),
          receipt.revision,
          now,
          document.shots.length,
          document.shots.reduce((sum, shot) => sum + shot.objects.length, 0),
          projectDurationSeconds(document),
          projectId,
          expectedRevision,
        );
      if (changed.changes !== 1) throw new ProjectRepositoryError(409, "revision_conflict", "Project changed while it was being recovered");
      this.recordMutation(projectId, mutationId, "recover", hash, receipt, now);
      return { value: receipt, replayed: false };
    }).immediate();
  }

  listProjectAssets(projectId: string): ProjectAssetSummary[] {
    const id = parseProjectId(projectId);
    const durable = durableFromRow(this.readyActiveRow(id));
    this.assertAssetBindings(id, durable.document);
    return durable.document.assets.map((asset) => ({
      ...cloneSerializable(asset),
      available: Boolean(this.assetRefRow(id, asset)?.blob_sha256),
    }));
  }

  getProjectAsset(input: { projectId: string; assetId: string }): ProjectAssetContent {
    const projectId = parseProjectId(input.projectId);
    const assetId = parseAssetId(input.assetId);
    const durable = durableFromRow(this.readyActiveRow(projectId));
    this.assertAssetBindings(projectId, durable.document);
    const asset = durable.document.assets.find(({ id }) => id === assetId);
    if (!asset) throw new ProjectRepositoryError(404, "asset_not_found", "Asset was not found");
    return { asset: cloneSerializable(asset), bytes: this.availableAssetBytes(projectId, asset) };
  }

  uploadProjectAsset(input: {
    projectId: string;
    expectedRevision: number;
    mutationId: string;
    content: ValidatedAssetContent;
  }): IdempotentResult<AssetUploadReceipt> {
    const projectId = parseProjectId(input.projectId);
    const expectedRevision = assertRevision(input.expectedRevision);
    const mutationId = parseMutationId(input.mutationId);
    const content = validateAssetContent({
      filename: input.content.filename,
      bytes: input.content.contentBytes,
      declaredSize: input.content.size,
      claimedMimeType: input.content.mimeType,
      expectedSha256: input.content.sha256,
    });
    const hash = requestHash({ projectId, expectedRevision, content: validatedAssetAuthority(content) });
    return this.database.transaction(() => {
      this.assertProjectNotRecoveryRequired(projectId);
      const replayed = this.replay<unknown>(mutationId, "asset-upload", hash);
      if (replayed) {
        const parsed = AssetUploadReceiptSchema.safeParse(replayed);
        if (!parsed.success || parsed.data.projectId !== projectId) {
          throw new ProjectRepositoryError(500, "repository_corrupt", "Stored asset-upload receipt is invalid");
        }
        const ref = this.assetRefRow(projectId, parsed.data.asset);
        const blob = ref?.blob_sha256 ? this.assetBlobMetadataRow(ref.blob_sha256) : undefined;
        if (!ref || ref.blob_sha256 !== parsed.data.asset.sha256 || !blob || !assetMatchesBlob(parsed.data.asset, blob)) {
          throw new ProjectRepositoryError(500, "repository_corrupt", "Stored asset-upload receipt has no content authority");
        }
        return { value: parsed.data, replayed: true };
      }
      const row = this.readyActiveRow(projectId);
      this.checkRevision(row, expectedRevision);
      const current = durableFromRow(row).document;
      this.assertAssetBindings(projectId, current);
      this.assertAssetStorageCapacity(projectId, current, content);
      const now = this.isoNow();
      const asset = AssetMetadataSchema.parse({
        id: this.allocateAssetId(projectId, current),
        ...validatedAssetAuthority(content),
        provenance: "uploaded",
      });
      this.insertOrVerifyAssetBlob(content, now);
      const insertedRef = this.database.prepare(`INSERT INTO project_asset_refs(
        project_id, asset_id, expected_sha256, blob_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?)`)
        .run(projectId, asset.id, asset.sha256, asset.sha256, now);
      if (insertedRef.changes !== 1) throw new ProjectRepositoryError(500, "repository_corrupt", "Asset reference could not be recorded");
      const document = ProjectDocumentSchema.parse({
        ...cloneSerializable(current),
        metadata: { ...current.metadata, updatedAt: now },
        assets: [...current.assets, asset],
      });
      this.assertAssetBindings(projectId, document);
      const authoringIssue = projectAuthoringTransitionIssue(current, document);
      if (authoringIssue) throw new ProjectRepositoryError(400, "invalid_project", authoringIssue);
      const receipt = {
        projectId,
        revision: row.revision + 1,
        updatedAt: now,
        asset,
      } satisfies AssetUploadReceipt;
      const changed = this.database.prepare(`UPDATE projects SET
        document_json = ?, revision = ?, updated_at = ?, duration_seconds = ?
        WHERE id = ? AND deleted_at IS NULL AND revision = ?`)
        .run(canonicalProjectJson(document), receipt.revision, now, projectDurationSeconds(document), projectId, expectedRevision);
      if (changed.changes !== 1) throw new ProjectRepositoryError(409, "revision_conflict", "Project changed while an asset was being uploaded");
      this.recordMutation(projectId, mutationId, "asset-upload", hash, receipt, now);
      return { value: receipt, replayed: false };
    }).immediate();
  }

  deleteProjectAsset(input: {
    projectId: string;
    assetId: string;
    expectedRevision: number;
    mutationId: string;
  }): IdempotentResult<AssetDeleteReceipt> {
    const projectId = parseProjectId(input.projectId);
    const assetId = parseAssetId(input.assetId);
    const expectedRevision = assertRevision(input.expectedRevision);
    const mutationId = parseMutationId(input.mutationId);
    const hash = requestHash({ projectId, assetId, expectedRevision });
    return this.database.transaction(() => {
      this.assertProjectNotRecoveryRequired(projectId);
      const replayed = this.replay<unknown>(mutationId, "asset-delete", hash);
      if (replayed) {
        const parsed = AssetDeleteReceiptSchema.safeParse(replayed);
        if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.assetId !== assetId) {
          throw new ProjectRepositoryError(500, "repository_corrupt", "Stored asset-delete receipt is invalid");
        }
        const retained = this.database.prepare(`SELECT 1 AS present FROM project_asset_refs
          WHERE project_id = ? AND asset_id = ? LIMIT 1`).get(projectId, assetId) as { present: 1 } | undefined;
        if (!retained) throw new ProjectRepositoryError(500, "repository_corrupt", "Stored asset-delete receipt has no retained content authority");
        return { value: parsed.data, replayed: true };
      }
      const row = this.readyActiveRow(projectId);
      this.checkRevision(row, expectedRevision);
      const current = durableFromRow(row).document;
      this.assertAssetBindings(projectId, current);
      const asset = current.assets.find(({ id }) => id === assetId);
      if (!asset) throw new ProjectRepositoryError(404, "asset_not_found", "Asset was not found");
      const visualReference = current.shots.flatMap((shot) => shot.objects.map((object) => ({ shot, object })))
        .find(({ object }) => object.properties.assetId === assetId);
      const audioReference = current.shots.flatMap((shot) => shot.audioClips.map((clip) => ({ shot, clip })))
        .find(({ clip }) => clip.assetId === assetId);
      if (visualReference || audioReference) {
        const location = visualReference
          ? `object ${visualReference.object.id} in shot ${visualReference.shot.id}`
          : `audio clip ${audioReference!.clip.id} in shot ${audioReference!.shot.id}`;
        throw new ProjectRepositoryError(409, "asset_in_use", `Remove the asset reference from ${location} before deleting the asset`);
      }
      const now = this.isoNow();
      const document = ProjectDocumentSchema.parse({
        ...cloneSerializable(current),
        metadata: { ...current.metadata, updatedAt: now },
        assets: current.assets.filter(({ id }) => id !== assetId),
      });
      this.assertAssetBindings(projectId, document);
      const authoringIssue = projectAuthoringTransitionIssue(current, document);
      if (authoringIssue) throw new ProjectRepositoryError(400, "invalid_project", authoringIssue);
      const receipt = { projectId, revision: row.revision + 1, updatedAt: now, assetId } satisfies AssetDeleteReceipt;
      const changed = this.database.prepare(`UPDATE projects SET
        document_json = ?, revision = ?, updated_at = ?, duration_seconds = ?
        WHERE id = ? AND deleted_at IS NULL AND revision = ?`)
        .run(canonicalProjectJson(document), receipt.revision, now, projectDurationSeconds(document), projectId, expectedRevision);
      if (changed.changes !== 1) throw new ProjectRepositoryError(409, "revision_conflict", "Project changed while an asset was being deleted");
      this.recordMutation(projectId, mutationId, "asset-delete", hash, receipt, now);
      return { value: receipt, replayed: false };
    }).immediate();
  }

  exportProjectPackage(projectId: string): BuiltProjectPackage {
    const id = parseProjectId(projectId);
    return this.database.transaction(() => {
      const durable = durableFromRow(this.readyActiveRow(id));
      this.assertAssetBindings(id, durable.document);
      if (durable.document.assets.some((asset) => this.assetRefRow(id, asset)?.blob_sha256 === null)) {
        throw new ProjectRepositoryError(409, "asset_content_missing", "Every project asset needs trusted content bytes before package export");
      }
      const bytesBySha256 = new Map<string, Buffer>();
      try {
        return buildProjectPackage({
          project: durable.document,
          sourceRevision: durable.revision,
          assets: {
            assetIds: durable.document.assets.map((asset) => asset.id),
            load: (asset) => {
              const cached = bytesBySha256.get(asset.sha256);
              if (cached) return cached;
              const bytes = this.availableAssetBytes(id, asset);
              bytesBySha256.set(asset.sha256, bytes);
              return bytes;
            },
          },
        });
      } catch (error) {
        if (error instanceof ProjectPackageError && error.code === "legacy_asset_source") {
          throw new ProjectRepositoryError(409, "invalid_project", "Replace legacy inline asset sources before exporting a portable project package");
        }
        throw new ProjectRepositoryError(500, "repository_corrupt", "Stored project could not be exported as a complete package");
      }
    }).deferred();
  }

  importProjectPackage(input: {
    mutationId: string;
    archiveBytes: Uint8Array;
  }): IdempotentResult<PackageImportReceipt> {
    const mutationId = parseMutationId(input.mutationId);
    // Parsing, canonical ZIP validation, content decoding, and byte authority
    // all complete before the writer transaction is admitted.
    const parsed = parseProjectPackage(input.archiveBytes);
    const sourceIssue = projectAuthoringIssue(parsed.project);
    if (sourceIssue) {
      throw new ProjectRepositoryError(400, "invalid_project", `Imported project is not authorable. ${sourceIssue}`);
    }
    const packageAssets = this.validateParsedPackageAssets(parsed);
    const hash = requestHash({ packageSha256: parsed.sha256 });
    const excludedIds = collectProjectIds(parsed.project);

    return this.database.transaction(() => {
      const replayed = this.replay<unknown>(mutationId, "package-import", hash);
      if (replayed) {
        const receipt = PackageImportReceiptSchema.safeParse(replayed);
        if (
          !receipt.success
          || receipt.data.sourceProjectId !== parsed.manifest.source.projectId
          || receipt.data.sourceRevision !== parsed.sourceRevision
          || receipt.data.packageSha256 !== parsed.sha256
        ) throw new ProjectRepositoryError(500, "repository_corrupt", "Stored package-import receipt is invalid");
        return { value: receipt.data, replayed: true };
      }

      this.assertPackageStorageCapacity(packageAssets.map(({ content }) => content));
      const now = this.isoNow();
      const projectId = this.allocateImportedProjectId(excludedIds);
      const document = ProjectDocumentSchema.parse({
        ...cloneSerializable(parsed.project),
        metadata: {
          ...parsed.project.metadata,
          id: projectId,
          createdAt: now,
          updatedAt: now,
        },
      });
      this.database.prepare(`INSERT INTO projects(
        id, title, document_json, revision, created_at, updated_at, deleted_at, shot_count, object_count, duration_seconds,
        thumbnail_mime, thumbnail_sha256, thumbnail_bytes, thumbnail_width, thumbnail_height, thumbnail_updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`)
        .run(
          projectId,
          document.metadata.title,
          canonicalProjectJson(document),
          now,
          now,
          document.shots.length,
          document.shots.reduce((sum, shot) => sum + shot.objects.length, 0),
          projectDurationSeconds(document),
        );
      const importedMetadata = new Map(document.assets.map((asset) => [asset.id, asset]));
      const insertedBlobs = new Set<string>();
      const insertRef = this.database.prepare(`INSERT INTO project_asset_refs(
        project_id, asset_id, expected_sha256, blob_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?)`);
      for (const { metadata, content } of packageAssets) {
        const stored = importedMetadata.get(metadata.id);
        if (!stored || JSON.stringify(stored) !== JSON.stringify(metadata) || !assetMatchesValidatedContent(stored, content)) {
          throw new ProjectRepositoryError(500, "repository_corrupt", "Imported project asset metadata changed during identity allocation");
        }
        if (!insertedBlobs.has(content.sha256)) {
          this.insertOrVerifyAssetBlob(content, now);
          insertedBlobs.add(content.sha256);
        }
        if (insertRef.run(projectId, stored.id, stored.sha256, stored.sha256, now).changes !== 1) {
          throw new ProjectRepositoryError(500, "repository_corrupt", "Imported project asset reference could not be recorded");
        }
      }
      this.assertAssetBindings(projectId, document);
      const receipt = {
        projectId,
        revision: 1,
        updatedAt: now,
        sourceProjectId: parsed.manifest.source.projectId,
        sourceRevision: parsed.sourceRevision,
        packageSha256: parsed.sha256,
      } satisfies PackageImportReceipt;
      this.recordMutation(projectId, mutationId, "package-import", hash, receipt, now);
      return { value: receipt, replayed: false };
    }).immediate();
  }

  legacyRecoveryDocument(input: { projectId: string; checkpointId?: string }): LegacyRecoveryDocument {
    const projectId = parseProjectId(input.projectId);
    // Exact legacy checkpoint export remains available by its authenticated,
    // unguessable URL even after the containing ready project is soft-deleted.
    // Normal project reads/listing continue to hide deleted projects.
    const projectExists = this.database.prepare("SELECT 1 AS present FROM projects WHERE id = ?").get(projectId) as { present: 1 } | undefined;
    if (!projectExists) throw new ProjectRepositoryError(404, "project_not_found", "Project was not found");
    const ownerType = input.checkpointId === undefined ? "project" : "checkpoint";
    const ownerId = input.checkpointId === undefined
      ? projectId
      : z.string().regex(/^checkpoint-[a-f0-9]{24}$/).parse(input.checkpointId);
    const row = this.database.prepare(`SELECT owner_type, owner_id, project_id, document_json, document_sha256, reason
      FROM legacy_document_archive
      WHERE owner_type = ? AND owner_id = ? AND project_id = ? AND migration_status = 'recovery-required'`)
      .get(ownerType, ownerId, projectId) as {
        owner_type: "project" | "checkpoint";
        owner_id: string;
        project_id: string;
        document_json: string;
        document_sha256: string;
        reason: string;
      } | undefined;
    if (!row) throw new ProjectRepositoryError(404, "project_not_found", "Legacy recovery document was not found");
    return {
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      projectId: row.project_id,
      sha256: row.document_sha256,
      reason: row.reason,
      documentJson: row.document_json,
    };
  }
}

const repositoryKey = Symbol.for("proofcanvas.project.repository");
type GlobalWithRepository = typeof globalThis & { [repositoryKey]?: SqliteProjectRepository };

export function projectRepository(): SqliteProjectRepository {
  const globals = globalThis as GlobalWithRepository;
  if (!globals[repositoryKey]) globals[repositoryKey] = new SqliteProjectRepository(proofCanvasDatabase());
  return globals[repositoryKey]!;
}
