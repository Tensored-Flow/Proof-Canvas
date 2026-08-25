import type Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { proofCanvasDatabase } from "./database.server";
import {
  ProjectDocumentSchema,
  canonicalProjectJson,
  cloneSerializable,
  parseProjectDocument,
  projectDurationSeconds,
  type ProjectDocument,
} from "./schema";
import { projectAuthoringIssue, projectAuthoringTransitionIssue } from "./authoringPolicy";
import { createProjectTemplate, type ProjectTemplateKind } from "./templates";
import { canonicalTimelineTime } from "./frame";

export const PROJECT_LIST_LIMIT = 500;
export const CHECKPOINT_LIST_LIMIT = 100;

const ProjectIdSchema = z.string().regex(/^project-[a-f0-9]{24}$/).max(96);
const MutationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const TitleSchema = z.string().trim().min(1).max(160);
const CheckpointLabelSchema = z.string().trim().min(1).max(120);

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
    public readonly code: "project_not_found" | "project_recovery_required" | "revision_conflict" | "idempotency_conflict" | "invalid_project" | "repository_corrupt",
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

interface RepositoryOptions {
  now?: () => Date;
  randomId?: (prefix: "project" | "checkpoint") => string;
}

function defaultRandomId(prefix: "project" | "checkpoint"): string {
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
  private readonly randomId: (prefix: "project" | "checkpoint") => string;

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

  listProjects(): ProjectSummary[] {
    const rows = this.database.prepare(`SELECT
      id, title, revision, created_at, updated_at, deleted_at, shot_count, object_count, duration_seconds, document_state,
      thumbnail_mime, thumbnail_sha256, thumbnail_bytes, thumbnail_width, thumbnail_height, thumbnail_updated_at
      FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC, id LIMIT ?`)
      .all(PROJECT_LIST_LIMIT) as ProjectSummaryRow[];
    return rows.map(summaryFromMetadataRow);
  }

  getProject(projectId: string): DurableProject {
    return durableFromRow(this.readyActiveRow(projectId));
  }

  createProject(input: { kind: ProjectTemplateKind; title: string; mutationId: string }): IdempotentResult<MutationReceipt> {
    const mutationId = parseMutationId(input.mutationId);
    const title = TitleSchema.parse(input.title);
    if (input.kind !== "blank" && input.kind !== "sample") throw new ProjectRepositoryError(400, "invalid_project", "Unknown project template");
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
      const authoringIssue = projectAuthoringTransitionIssue(durableFromRow(row).document, supplied);
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
