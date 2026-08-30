import { z } from "zod";

import {
  PROJECT_SCHEMA_VERSION,
  PROOFCANVAS_PROJECT_MAX_BYTES,
  PROOFCANVAS_SCHEMA_LIMITS,
  type AssetMetadata,
} from "@/lib/proofcanvas/schema";

export const PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE =
  "application/vnd.proofcanvas.package+zip" as const;
export const PROOFCANVAS_PROJECT_PACKAGE_EXTENSION = ".proofcanvas" as const;
export const PROOFCANVAS_PROJECT_PACKAGE_FORMAT = "proofcanvas-package" as const;
export const PROOFCANVAS_PROJECT_PACKAGE_VERSION = 1 as const;

export const PROOFCANVAS_PROJECT_PACKAGE_LIMITS = Object.freeze({
  // 128 MiB of unique assets plus canonical project/manifest/ZIP overhead.
  maxArchiveBytes: 132 * 1024 * 1024,
  maxEntries: 3 + PROOFCANVAS_SCHEMA_LIMITS.assets,
  maxCentralDirectoryBytes: 128 * 1024,
  maxEntryPathBytes: 96,
  maxManifestBytes: 256 * 1024,
  maxProjectBytes: PROOFCANVAS_PROJECT_MAX_BYTES,
  maxAssetBytes: 64 * 1024 * 1024,
  maxAssetAggregateBytes: 128 * 1024 * 1024,
  maxDecodedImageAggregateBytes: 512 * 1024 * 1024,
} as const);

const PackageIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const AssetPathSchema = z
  .string()
  .max(PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxEntryPathBytes)
  .regex(/^assets\/[a-f0-9]{64}\.(?:jpg|m4a|mp3|png|svg|wav|webp)$/);

export const ProjectPackageManifestAssetSchema = z
  .object({
    id: PackageIdSchema,
    path: AssetPathSchema,
  })
  .strict();

export const ProjectPackageManifestSchema = z
  .object({
    assets: z.array(ProjectPackageManifestAssetSchema).max(PROOFCANVAS_SCHEMA_LIMITS.assets),
    format: z.literal(PROOFCANVAS_PROJECT_PACKAGE_FORMAT),
    packageVersion: z.literal(PROOFCANVAS_PROJECT_PACKAGE_VERSION),
    project: z
      .object({
        bytes: z.number().int().positive().max(PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxProjectBytes),
        path: z.literal("project.json"),
        schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
        sha256: Sha256Schema,
      })
      .strict(),
    source: z
      .object({
        projectId: PackageIdSchema,
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    let previousId: string | undefined;

    for (const [index, asset] of manifest.assets.entries()) {
      if (ids.has(asset.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate package asset id ${asset.id}.`,
          path: ["assets", index, "id"],
        });
      }
      ids.add(asset.id);

      if (previousId !== undefined && compareAscii(previousId, asset.id) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Package assets must be strictly sorted by id.",
          path: ["assets", index, "id"],
        });
      }
      previousId = asset.id;
    }
  });

export type ProjectPackageManifest = z.infer<typeof ProjectPackageManifestSchema>;

export type ProjectPackageErrorCode =
  | "aggregate_too_large"
  | "allocation_failed"
  | "archive_too_large"
  | "asset_content_invalid"
  | "asset_duplicate"
  | "asset_metadata_mismatch"
  | "asset_missing"
  | "asset_unexpected"
  | "case_collision"
  | "crc_mismatch"
  | "duplicate_entry"
  | "encrypted_entry"
  | "entry_limit_exceeded"
  | "entry_too_large"
  | "invalid_archive"
  | "invalid_asset_metadata"
  | "invalid_entry_order"
  | "invalid_input"
  | "invalid_manifest"
  | "invalid_project"
  | "invalid_source_revision"
  | "legacy_asset_source"
  | "manifest_not_canonical"
  | "missing_entry"
  | "multidisk_unsupported"
  | "project_hash_mismatch"
  | "project_not_canonical"
  | "project_size_mismatch"
  | "unexpected_entry"
  | "unsafe_entry_path"
  | "unsafe_entry_type"
  | "unsupported_compression"
  | "zip64_unsupported";

export class ProjectPackageError extends Error {
  readonly code: ProjectPackageErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ProjectPackageErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectPackageError";
    this.code = code;
    this.details = details;
  }
}

const ASSET_EXTENSION_BY_MIME = Object.freeze({
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
} satisfies Record<AssetMetadata["mimeType"], string>);

export function projectPackageAssetPath(
  asset: Pick<AssetMetadata, "mimeType" | "sha256">,
): string {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new ProjectPackageError(
      "invalid_asset_metadata",
      "Asset SHA-256 must be 64 lowercase hexadecimal characters.",
    );
  }

  const extension = ASSET_EXTENSION_BY_MIME[asset.mimeType];
  if (!extension) {
    throw new ProjectPackageError(
      "invalid_asset_metadata",
      `Unsupported package asset MIME type ${String(asset.mimeType)}.`,
    );
  }

  return `assets/${asset.sha256}.${extension}`;
}

export function canonicalProjectPackageManifestJson(manifest: ProjectPackageManifest): string {
  const parsed = ProjectPackageManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new ProjectPackageError(
      "invalid_manifest",
      "Project package manifest does not satisfy the strict manifest schema.",
      { issues: parsed.error.issues },
      { cause: parsed.error },
    );
  }

  return `${JSON.stringify(sortJsonValue(parsed.data), null, 2)}\n`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareAscii)) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
