import "server-only";

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  AssetContentError,
  PROOFCANVAS_ASSET_CONTENT_LIMITS,
  canonicalAssetFilename,
  validateAssetContent,
  type ValidatedAssetContent,
} from "@/lib/proofcanvas/assetContent.server";
import {
  PROOFCANVAS_PROJECT_PACKAGE_FORMAT,
  PROOFCANVAS_PROJECT_PACKAGE_LIMITS,
  PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE,
  PROOFCANVAS_PROJECT_PACKAGE_VERSION,
  ProjectPackageError,
  ProjectPackageManifestSchema,
  canonicalProjectPackageManifestJson,
  projectPackageAssetPath,
  type ProjectPackageManifest,
} from "@/lib/proofcanvas/projectPackage";
import {
  AssetMetadataSchema,
  PROJECT_SCHEMA_VERSION,
  canonicalProjectJson,
  parseProjectDocument,
  type AssetMetadata,
  type ProjectDocument,
} from "@/lib/proofcanvas/schema";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_VERSION_MADE_BY_UNIX = (3 << 8) | ZIP_VERSION;
const ZIP_STORE_METHOD = 0;
const ZIP_FLAGS = 0;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE_1980_01_01 = (1 << 5) | 1;
const ZIP_REGULAR_0600_EXTERNAL_ATTRIBUTES = (0o100600 << 16) >>> 0;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ProjectPackageAssetByteRecord {
  assetId: string;
  contentBytes: Uint8Array;
}

export interface ProjectPackageAssetByteSource {
  /** The complete set of IDs the loader can return. Extra and missing IDs are rejected before allocation. */
  assetIds: readonly string[];
  /** Called exactly once for each project asset ID. */
  load: (asset: AssetMetadata) => Uint8Array | undefined;
}

export interface BuildProjectPackageInput {
  project: ProjectDocument;
  sourceRevision: number;
  assets: readonly ProjectPackageAssetByteRecord[] | ProjectPackageAssetByteSource;
}

export interface BuiltProjectPackage {
  bytes: Uint8Array;
  manifest: ProjectPackageManifest;
  sha256: string;
}

export interface ParsedProjectPackageAsset {
  assetId: string;
  metadata: AssetMetadata;
  contentBytes: Uint8Array;
  /** Full decoded authority; duration intentionally retains exact media time. */
  validatedContent: ValidatedAssetContent;
}

export interface ParsedProjectPackage {
  project: ProjectDocument;
  sourceRevision: number;
  manifest: ProjectPackageManifest;
  assets: readonly ParsedProjectPackageAsset[];
  sha256: string;
}

/**
 * Builds a byte-stable in-memory package. The returned archive and caller-owned
 * input coexist in memory. A callback source permits callers to hold only one
 * source asset at a time; validation creates one temporary authoritative copy,
 * which is copied directly into the already allocated archive and then released.
 */
export function buildProjectPackage(input: BuildProjectPackageInput): BuiltProjectPackage {
  try {
    return buildProjectPackageUnchecked(input);
  } catch (error) {
    if (error instanceof ProjectPackageError) throw error;
    throw new ProjectPackageError(
      "invalid_input",
      "The project package build input is malformed.",
      undefined,
      { cause: error },
    );
  }
}

/**
 * Parses an archive already resident in memory; it never extracts to disk.
 * At peak, the bounded archive coexists with one retained validated copy per
 * unique blob (at most 128 MiB aggregate) plus one temporary validator copy.
 * Asset IDs that share a blob share the same returned Uint8Array instance.
 */
export function parseProjectPackage(input: Uint8Array): ParsedProjectPackage {
  try {
    return parseProjectPackageUnchecked(input);
  } catch (error) {
    if (error instanceof ProjectPackageError) throw error;
    throw new ProjectPackageError(
      "invalid_archive",
      "The project package is malformed.",
      undefined,
      { cause: error },
    );
  }
}

interface PlannedEntry {
  name: string;
  nameBytes: Buffer;
  size: number;
  fixedData?: Buffer;
  assets?: AssetMetadata[];
  localOffset: number;
}

interface WrittenEntry {
  name: string;
  nameBytes: Buffer;
  size: number;
  crc32: number;
  localOffset: number;
}

function buildProjectPackageUnchecked(input: BuildProjectPackageInput): BuiltProjectPackage {
  if (!input || typeof input !== "object") {
    packageError("invalid_input", "Project package build input must be an object.");
  }

  let project: ProjectDocument;
  try {
    project = parseProjectDocument(input.project);
  } catch (error) {
    packageError("invalid_project", "Project package input is not a valid ProjectDocument.", undefined, error);
  }
  assertPortableAssetReferences(project);

  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision <= 0) {
    packageError("invalid_source_revision", "Source revision must be a positive safe integer.");
  }

  if (
    PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxAssetBytes !==
      PROOFCANVAS_ASSET_CONTENT_LIMITS.maxItemBytes ||
    PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxAssetAggregateBytes !==
      PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAggregateBytes
  ) {
    packageError("invalid_input", "Package and asset-content byte authorities disagree.");
  }

  const loadAsset = normalizeAssetSource(input.assets, project.assets);
  const sortedAssets = [...project.assets].sort((left, right) => compareAscii(left.id, right.id));
  const groupsByPath = new Map<string, AssetMetadata[]>();

  for (const asset of sortedAssets) {
    const path = projectPackageAssetPath(asset);
    const group = groupsByPath.get(path);
    if (group) group.push(asset);
    else groupsByPath.set(path, [asset]);
  }
  assertUniquePackageBlobMetadata(groupsByPath);

  const uniqueAssetPaths = [...groupsByPath.keys()].sort(compareAscii);
  let assetAggregateBytes = 0;
  for (const path of uniqueAssetPaths) {
    const group = groupsByPath.get(path)!;
    const expectedSize = group[0].size;
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      packageError("invalid_asset_metadata", `Asset ${group[0].id} has an invalid byte size.`);
    }
    if (expectedSize > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxAssetBytes) {
      packageError("entry_too_large", `Asset entry ${path} exceeds the per-entry byte limit.`);
    }
    for (const asset of group) {
      if (asset.size !== expectedSize) {
        packageError(
          "asset_metadata_mismatch",
          `Assets sharing ${path} disagree about the blob size.`,
        );
      }
    }
    assetAggregateBytes = checkedAdd(
      assetAggregateBytes,
      expectedSize,
      PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxAssetAggregateBytes,
      "aggregate_too_large",
      "Package asset bytes exceed the aggregate byte limit.",
    );
  }

  const projectBytes = Buffer.from(canonicalProjectJson(project), "utf8");
  if (projectBytes.length > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxProjectBytes) {
    packageError("entry_too_large", "Canonical project JSON exceeds the package project limit.");
  }
  const projectSha256 = sha256(projectBytes);
  const manifest: ProjectPackageManifest = {
    assets: sortedAssets.map((asset) => ({
      id: asset.id,
      path: projectPackageAssetPath(asset),
    })),
    format: PROOFCANVAS_PROJECT_PACKAGE_FORMAT,
    packageVersion: PROOFCANVAS_PROJECT_PACKAGE_VERSION,
    project: {
      bytes: projectBytes.length,
      path: "project.json",
      schemaVersion: PROJECT_SCHEMA_VERSION,
      sha256: projectSha256,
    },
    source: {
      projectId: project.metadata.id,
      revision: input.sourceRevision,
    },
  };
  const manifestBytes = Buffer.from(canonicalProjectPackageManifestJson(manifest), "utf8");
  if (manifestBytes.length > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxManifestBytes) {
    packageError("entry_too_large", "Canonical package manifest exceeds its byte limit.");
  }
  const mimetypeBytes = Buffer.from(PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE, "ascii");

  const entries: PlannedEntry[] = [
    planEntry("mimetype", mimetypeBytes.length, 0, mimetypeBytes),
    planEntry("manifest.json", manifestBytes.length, 0, manifestBytes),
    planEntry("project.json", projectBytes.length, 0, projectBytes),
  ];
  for (const path of uniqueAssetPaths) {
    const group = groupsByPath.get(path)!;
    entries.push(planEntry(path, group[0].size, 0, undefined, group));
  }

  if (entries.length > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxEntries) {
    packageError("entry_limit_exceeded", "Project package contains too many entries.");
  }

  let localBytes = 0;
  let centralBytes = 0;
  for (const entry of entries) {
    entry.localOffset = localBytes;
    localBytes = checkedAdd(
      localBytes,
      LOCAL_HEADER_BYTES + entry.nameBytes.length + entry.size,
      PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxArchiveBytes,
      "archive_too_large",
      "Project package exceeds the archive byte limit.",
    );
    centralBytes = checkedAdd(
      centralBytes,
      CENTRAL_HEADER_BYTES + entry.nameBytes.length,
      PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxCentralDirectoryBytes,
      "entry_limit_exceeded",
      "Project package central directory exceeds its byte limit.",
    );
  }
  const totalBytes = checkedAdd(
    checkedAdd(
      localBytes,
      centralBytes,
      PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxArchiveBytes,
      "archive_too_large",
      "Project package exceeds the archive byte limit.",
    ),
    EOCD_BYTES,
    PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxArchiveBytes,
    "archive_too_large",
    "Project package exceeds the archive byte limit.",
  );

  let output: Buffer;
  try {
    output = Buffer.allocUnsafe(totalBytes);
  } catch (error) {
    packageError("allocation_failed", "Unable to allocate the bounded package buffer.", undefined, error);
  }

  const written: WrittenEntry[] = [];
  let cursor = 0;
  let admittedUniqueBytes = 0;
  for (const entry of entries) {
    let content: Uint8Array;
    let crc: number;

    if (entry.fixedData) {
      content = entry.fixedData;
      crc = crc32(content);
    } else {
      const group = entry.assets!;
      const first = validatePackageAsset(group[0], loadAsset(group[0]), admittedUniqueBytes);
      content = first.contentBytes;
      crc = crc32(content);
      admittedUniqueBytes += content.byteLength;

      for (let index = 1; index < group.length; index += 1) {
        const duplicateBytes = loadAsset(group[index]);
        assertPackageAssetMetadata(group[index], first);
        if (!bytesEqual(content, duplicateBytes)) {
          packageError(
            "asset_metadata_mismatch",
            `Assets sharing ${entry.name} do not contain identical bytes.`,
          );
        }
      }
    }

    if (content.byteLength !== entry.size) {
      packageError("asset_metadata_mismatch", `Entry ${entry.name} does not match its declared size.`);
    }
    writeLocalHeader(output, cursor, entry, crc);
    const dataStart = cursor + LOCAL_HEADER_BYTES + entry.nameBytes.length;
    output.set(content, dataStart);
    written.push({
      name: entry.name,
      nameBytes: entry.nameBytes,
      size: entry.size,
      crc32: crc,
      localOffset: entry.localOffset,
    });
    cursor = dataStart + entry.size;
  }

  if (cursor !== localBytes) {
    packageError("invalid_input", "Internal package layout calculation disagrees with written bytes.");
  }
  for (const entry of written) {
    writeCentralHeader(output, cursor, entry);
    cursor += CENTRAL_HEADER_BYTES + entry.nameBytes.length;
  }
  writeEndOfCentralDirectory(output, cursor, written.length, centralBytes, localBytes);
  cursor += EOCD_BYTES;
  if (cursor !== output.length) {
    packageError("invalid_input", "Internal package length calculation disagrees with written bytes.");
  }

  return {
    bytes: output,
    manifest,
    sha256: sha256(output),
  };
}

function planEntry(
  name: string,
  size: number,
  localOffset: number,
  fixedData?: Buffer,
  assets?: AssetMetadata[],
): PlannedEntry {
  const nameBytes = encodeEntryName(name);
  return { name, nameBytes, size, fixedData, assets, localOffset };
}

function normalizeAssetSource(
  source: BuildProjectPackageInput["assets"],
  projectAssets: readonly AssetMetadata[],
): (asset: AssetMetadata) => Uint8Array {
  let assetIds: readonly string[];
  let loader: (asset: AssetMetadata) => Uint8Array | undefined;

  if (Array.isArray(source)) {
    const records = new Map<string, Uint8Array>();
    for (const record of source as readonly ProjectPackageAssetByteRecord[]) {
      if (!record || typeof record.assetId !== "string") {
        packageError("invalid_input", "Every asset byte record must have an assetId.");
      }
      if (records.has(record.assetId)) {
        packageError("asset_duplicate", `Asset bytes were supplied more than once for ${record.assetId}.`);
      }
      records.set(record.assetId, record.contentBytes);
    }
    assetIds = [...records.keys()];
    loader = (asset) => records.get(asset.id);
  } else if (source && typeof source === "object") {
    const callbackSource = source as ProjectPackageAssetByteSource;
    if (!Array.isArray(callbackSource.assetIds) || typeof callbackSource.load !== "function") {
      packageError("invalid_input", "Asset bytes must be exact records or a declared callback source.");
    }
    assetIds = callbackSource.assetIds;
    loader = callbackSource.load;
  } else {
    packageError("invalid_input", "Asset bytes must be exact records or a declared callback source.");
  }

  const available = new Set<string>();
  for (const id of assetIds) {
    if (typeof id !== "string") packageError("invalid_input", "Asset source IDs must be strings.");
    if (available.has(id)) packageError("asset_duplicate", `Asset source ID ${id} is duplicated.`);
    available.add(id);
  }
  const expected = new Set(projectAssets.map((asset) => asset.id));
  for (const id of available) {
    if (!expected.has(id)) packageError("asset_unexpected", `Asset bytes were supplied for unknown ID ${id}.`);
  }
  for (const id of expected) {
    if (!available.has(id)) packageError("asset_missing", `Asset bytes are missing for ${id}.`);
  }

  return (asset) => {
    let bytes: Uint8Array | undefined;
    try {
      bytes = loader(asset);
    } catch (error) {
      packageError("asset_content_invalid", `Asset source failed while loading ${asset.id}.`, { assetId: asset.id }, error);
    }
    if (bytes === undefined) packageError("asset_missing", `Asset source returned no bytes for ${asset.id}.`);
    if (!isUint8Array(bytes)) {
      packageError("asset_content_invalid", `Asset source returned invalid bytes for ${asset.id}.`);
    }
    return bytes;
  };
}

function validatePackageAsset(
  metadata: AssetMetadata,
  bytes: Uint8Array,
  aggregateBytesBefore: number,
): ValidatedAssetContent {
  let validated: ValidatedAssetContent;
  try {
    validated = validateAssetContent({
      filename: metadata.filename,
      bytes,
      declaredSize: metadata.size,
      claimedMimeType: metadata.mimeType,
      expectedSha256: metadata.sha256,
      aggregateBytesBefore,
    });
  } catch (error) {
    if (error instanceof AssetContentError) {
      packageError(
        error.code === "aggregate_too_large" ? "aggregate_too_large" : "asset_content_invalid",
        `Asset ${metadata.id} failed content validation: ${error.message}`,
        { assetContentCode: error.code, assetId: metadata.id },
        error,
      );
    }
    packageError(
      "asset_content_invalid",
      `Asset ${metadata.id} failed content validation.`,
      { assetId: metadata.id },
      error,
    );
  }

  assertPackageAssetMetadata(metadata, validated);
  return validated;
}

/** Bind a project-local ID/filename/provenance tuple to one fully decoded blob. */
function assertPackageAssetMetadata(
  metadata: AssetMetadata,
  validated: ValidatedAssetContent,
): void {
  let canonicalFilename: string;
  try {
    canonicalFilename = canonicalAssetFilename(metadata.filename, validated.mimeType);
  } catch (error) {
    packageError(
      "asset_metadata_mismatch",
      `Asset ${metadata.id} filename is not canonical for its content type.`,
      { assetId: metadata.id, field: "filename" },
      error,
    );
  }
  if (canonicalFilename !== metadata.filename) {
    packageError(
      "asset_metadata_mismatch",
      `Asset ${metadata.id} filename does not match authoritative content.`,
      { assetId: metadata.id, field: "filename" },
    );
  }

  const exactFields = ["mimeType", "size", "sha256", "width", "height"] as const;
  for (const field of exactFields) {
    if (!Object.is(validated[field], metadata[field])) {
      packageError(
        "asset_metadata_mismatch",
        `Asset ${metadata.id} ${field} does not match authoritative content.`,
        { assetId: metadata.id, field },
      );
    }
  }

  const canonicalAuthority = AssetMetadataSchema.safeParse({
    id: metadata.id,
    filename: metadata.filename,
    mimeType: validated.mimeType,
    size: validated.size,
    sha256: validated.sha256,
    width: validated.width,
    height: validated.height,
    duration: validated.duration,
    provenance: metadata.provenance,
  });
  if (!canonicalAuthority.success) {
    packageError(
      "asset_content_invalid",
      `Asset ${metadata.id} content authority cannot bind canonical asset metadata.`,
      { assetId: metadata.id, issues: canonicalAuthority.error.issues },
      canonicalAuthority.error,
    );
  }
  if (!Object.is(canonicalAuthority.data.duration, metadata.duration)) {
    packageError(
      "asset_metadata_mismatch",
      `Asset ${metadata.id} duration does not match frame-canonical content authority.`,
      { assetId: metadata.id, field: "duration" },
    );
  }
}

function assertPortableAssetReferences(project: ProjectDocument): void {
  for (const shot of project.shots) {
    for (const object of shot.objects) {
      if (object.type === "image" || object.type === "svg") {
        const assetId = object.properties.assetId;
        const source = object.properties.source;
        if (!source) continue;
        packageError(
          "legacy_asset_source",
          assetId
            ? `Object ${object.id} retains a legacy source alongside its assetId and cannot be packaged.`
            : `Object ${object.id} uses a legacy source without an assetId and cannot be packaged.`,
          { assetId, objectId: object.id, shotId: shot.id },
        );
      }
    }
  }
}

/**
 * A content-addressed entry is decoded once, so all IDs on that path must agree
 * on blob-derived fields before allocation. The aggregate pixel bound prevents
 * many tiny, highly compressed images from becoming a package CPU bomb.
 */
function assertUniquePackageBlobMetadata(groups: ReadonlyMap<string, readonly AssetMetadata[]>): void {
  let decodedImageBytes = 0;
  const blobFields = ["mimeType", "size", "sha256", "width", "height", "duration"] as const;
  for (const [path, assets] of groups) {
    const first = assets[0];
    if (!first) packageError("invalid_asset_metadata", `Asset entry ${path} has no metadata authority.`);
    for (let index = 1; index < assets.length; index += 1) {
      for (const field of blobFields) {
        if (!Object.is(assets[index][field], first[field])) {
          packageError(
            "asset_metadata_mismatch",
            `Assets sharing ${path} disagree about ${field}.`,
            { assetId: assets[index].id, field },
          );
        }
      }
    }
    if (first.mimeType.startsWith("image/")) {
      if (!first.width || !first.height) {
        packageError("invalid_asset_metadata", `Image entry ${path} has no bounded dimensions.`);
      }
      const decodedBytes = first.width * first.height * 4;
      decodedImageBytes = checkedAdd(
        decodedImageBytes,
        decodedBytes,
        PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxDecodedImageAggregateBytes,
        "aggregate_too_large",
        "Package image pixels exceed the aggregate decoded-image limit.",
      );
    }
  }
}

function writeLocalHeader(output: Buffer, offset: number, entry: PlannedEntry, crc: number): void {
  output.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, offset);
  output.writeUInt16LE(ZIP_VERSION, offset + 4);
  output.writeUInt16LE(ZIP_FLAGS, offset + 6);
  output.writeUInt16LE(ZIP_STORE_METHOD, offset + 8);
  output.writeUInt16LE(ZIP_DOS_TIME, offset + 10);
  output.writeUInt16LE(ZIP_DOS_DATE_1980_01_01, offset + 12);
  output.writeUInt32LE(crc, offset + 14);
  output.writeUInt32LE(entry.size, offset + 18);
  output.writeUInt32LE(entry.size, offset + 22);
  output.writeUInt16LE(entry.nameBytes.length, offset + 26);
  output.writeUInt16LE(0, offset + 28);
  output.set(entry.nameBytes, offset + LOCAL_HEADER_BYTES);
}

function writeCentralHeader(output: Buffer, offset: number, entry: WrittenEntry): void {
  output.writeUInt32LE(CENTRAL_FILE_HEADER_SIGNATURE, offset);
  output.writeUInt16LE(ZIP_VERSION_MADE_BY_UNIX, offset + 4);
  output.writeUInt16LE(ZIP_VERSION, offset + 6);
  output.writeUInt16LE(ZIP_FLAGS, offset + 8);
  output.writeUInt16LE(ZIP_STORE_METHOD, offset + 10);
  output.writeUInt16LE(ZIP_DOS_TIME, offset + 12);
  output.writeUInt16LE(ZIP_DOS_DATE_1980_01_01, offset + 14);
  output.writeUInt32LE(entry.crc32, offset + 16);
  output.writeUInt32LE(entry.size, offset + 20);
  output.writeUInt32LE(entry.size, offset + 24);
  output.writeUInt16LE(entry.nameBytes.length, offset + 28);
  output.writeUInt16LE(0, offset + 30);
  output.writeUInt16LE(0, offset + 32);
  output.writeUInt16LE(0, offset + 34);
  output.writeUInt16LE(0, offset + 36);
  output.writeUInt32LE(ZIP_REGULAR_0600_EXTERNAL_ATTRIBUTES, offset + 38);
  output.writeUInt32LE(entry.localOffset, offset + 42);
  output.set(entry.nameBytes, offset + CENTRAL_HEADER_BYTES);
}

function writeEndOfCentralDirectory(
  output: Buffer,
  offset: number,
  entryCount: number,
  centralBytes: number,
  centralOffset: number,
): void {
  output.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, offset);
  output.writeUInt16LE(0, offset + 4);
  output.writeUInt16LE(0, offset + 6);
  output.writeUInt16LE(entryCount, offset + 8);
  output.writeUInt16LE(entryCount, offset + 10);
  output.writeUInt32LE(centralBytes, offset + 12);
  output.writeUInt32LE(centralOffset, offset + 16);
  output.writeUInt16LE(0, offset + 20);
}

interface CentralEntry {
  name: string;
  nameBytes: Buffer;
  crc32: number;
  size: number;
  localOffset: number;
}

interface LocatedEntry extends CentralEntry {
  dataStart: number;
  dataEnd: number;
}

function parseProjectPackageUnchecked(input: Uint8Array): ParsedProjectPackage {
  if (!isUint8Array(input)) packageError("invalid_input", "Package input must be a Uint8Array.");
  if (input.byteLength > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
    packageError("archive_too_large", "Project package exceeds the absolute archive byte limit.");
  }
  if (input.byteLength < EOCD_BYTES) packageError("invalid_archive", "Project package is shorter than a ZIP EOCD.");
  const archive = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const eocdOffset = archive.length - EOCD_BYTES;
  if (readU32(archive, eocdOffset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
    packageError("invalid_archive", "ZIP EOCD must be the final 22 bytes of the package.");
  }

  const diskNumber = readU16(archive, eocdOffset + 4);
  const centralDisk = readU16(archive, eocdOffset + 6);
  const diskEntryCount = readU16(archive, eocdOffset + 8);
  const entryCount = readU16(archive, eocdOffset + 10);
  const centralBytes = readU32(archive, eocdOffset + 12);
  const centralOffset = readU32(archive, eocdOffset + 16);
  const commentBytes = readU16(archive, eocdOffset + 20);

  if (entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    packageError("zip64_unsupported", "ZIP64 packages are not accepted.");
  }
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntryCount !== entryCount) {
    packageError("multidisk_unsupported", "Multidisk ZIP packages are not accepted.");
  }
  if (commentBytes !== 0) packageError("invalid_archive", "ZIP comments are not accepted.");
  if (entryCount > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxEntries) {
    packageError("entry_limit_exceeded", "Project package contains too many entries.");
  }
  if (centralBytes > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxCentralDirectoryBytes) {
    packageError("entry_limit_exceeded", "ZIP central directory exceeds its byte limit.");
  }
  if (centralOffset > eocdOffset || centralBytes !== eocdOffset - centralOffset) {
    packageError("invalid_archive", "ZIP central directory does not exactly precede the EOCD.");
  }

  const centralEntries: CentralEntry[] = [];
  const exactNames = new Set<string>();
  const normalizedNames = new Map<string, string>();
  let centralCursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    ensureRange(archive, centralCursor, CENTRAL_HEADER_BYTES, centralOffset + centralBytes);
    if (readU32(archive, centralCursor) !== CENTRAL_FILE_HEADER_SIGNATURE) {
      packageError("invalid_archive", `Central entry ${index} has an invalid signature.`);
    }
    const versionMadeBy = readU16(archive, centralCursor + 4);
    const versionNeeded = readU16(archive, centralCursor + 6);
    const flags = readU16(archive, centralCursor + 8);
    const method = readU16(archive, centralCursor + 10);
    const dosTime = readU16(archive, centralCursor + 12);
    const dosDate = readU16(archive, centralCursor + 14);
    const crc = readU32(archive, centralCursor + 16);
    const compressedSize = readU32(archive, centralCursor + 20);
    const uncompressedSize = readU32(archive, centralCursor + 24);
    const nameLength = readU16(archive, centralCursor + 28);
    const extraLength = readU16(archive, centralCursor + 30);
    const entryCommentLength = readU16(archive, centralCursor + 32);
    const startDisk = readU16(archive, centralCursor + 34);
    const internalAttributes = readU16(archive, centralCursor + 36);
    const externalAttributes = readU32(archive, centralCursor + 38);
    const localOffset = readU32(archive, centralCursor + 42);

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      packageError("zip64_unsupported", "ZIP64 entry fields are not accepted.");
    }
    if ((flags & 1) !== 0) packageError("encrypted_entry", "Encrypted ZIP entries are not accepted.");
    if (method !== ZIP_STORE_METHOD) {
      packageError("unsupported_compression", "Only uncompressed STORE entries are accepted.");
    }
    if (compressedSize !== uncompressedSize) {
      packageError("invalid_archive", "STORE entry compressed and uncompressed sizes must match.");
    }
    if (
      versionMadeBy !== ZIP_VERSION_MADE_BY_UNIX ||
      versionNeeded !== ZIP_VERSION ||
      flags !== ZIP_FLAGS ||
      dosTime !== ZIP_DOS_TIME ||
      dosDate !== ZIP_DOS_DATE_1980_01_01 ||
      extraLength !== 0 ||
      entryCommentLength !== 0 ||
      startDisk !== 0 ||
      internalAttributes !== 0
    ) {
      packageError("invalid_archive", "ZIP entry metadata is not in canonical ProofCanvas form.");
    }
    if (externalAttributes !== ZIP_REGULAR_0600_EXTERNAL_ATTRIBUTES) {
      packageError("unsafe_entry_type", "ZIP entries must be non-executable regular 0600 files.");
    }
    if (
      nameLength === 0 ||
      nameLength > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxEntryPathBytes
    ) {
      packageError("unsafe_entry_path", "ZIP entry path length is outside the package limit.");
    }
    ensureRange(
      archive,
      centralCursor + CENTRAL_HEADER_BYTES,
      nameLength,
      centralOffset + centralBytes,
    );
    const nameBytes = archive.subarray(
      centralCursor + CENTRAL_HEADER_BYTES,
      centralCursor + CENTRAL_HEADER_BYTES + nameLength,
    );
    const name = decodeEntryName(nameBytes);
    assertSafeEntryName(name);
    if (exactNames.has(name)) packageError("duplicate_entry", `ZIP entry ${name} is duplicated.`);
    exactNames.add(name);
    const normalized = name.normalize("NFKC").toLocaleLowerCase("en-US");
    const collision = normalizedNames.get(normalized);
    if (collision !== undefined && collision !== name) {
      packageError("case_collision", `ZIP entries ${collision} and ${name} collide after normalization.`);
    }
    normalizedNames.set(normalized, name);
    centralEntries.push({ name, nameBytes, crc32: crc, size: uncompressedSize, localOffset });
    centralCursor += CENTRAL_HEADER_BYTES + nameLength;
  }
  if (centralCursor !== centralOffset + centralBytes) {
    packageError("invalid_archive", "ZIP central directory length or entry count is inconsistent.");
  }

  assertCanonicalEntryNames(centralEntries);
  enforceEntrySizeLimits(centralEntries);

  const locatedEntries: LocatedEntry[] = [];
  let expectedLocalOffset = 0;
  for (const [index, entry] of centralEntries.entries()) {
    if (entry.localOffset !== expectedLocalOffset) {
      packageError("invalid_archive", "ZIP local entries contain a prefix, gap, overlap, or reordered offset.");
    }
    ensureRange(archive, entry.localOffset, LOCAL_HEADER_BYTES, centralOffset);
    if (readU32(archive, entry.localOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      packageError("invalid_archive", `Local entry ${index} has an invalid signature.`);
    }
    const versionNeeded = readU16(archive, entry.localOffset + 4);
    const flags = readU16(archive, entry.localOffset + 6);
    const method = readU16(archive, entry.localOffset + 8);
    const dosTime = readU16(archive, entry.localOffset + 10);
    const dosDate = readU16(archive, entry.localOffset + 12);
    const localCrc = readU32(archive, entry.localOffset + 14);
    const compressedSize = readU32(archive, entry.localOffset + 18);
    const uncompressedSize = readU32(archive, entry.localOffset + 22);
    const nameLength = readU16(archive, entry.localOffset + 26);
    const extraLength = readU16(archive, entry.localOffset + 28);

    if ((flags & 1) !== 0) packageError("encrypted_entry", "Encrypted ZIP entries are not accepted.");
    if (method !== ZIP_STORE_METHOD) {
      packageError("unsupported_compression", "Only uncompressed STORE entries are accepted.");
    }
    if (
      versionNeeded !== ZIP_VERSION ||
      flags !== ZIP_FLAGS ||
      dosTime !== ZIP_DOS_TIME ||
      dosDate !== ZIP_DOS_DATE_1980_01_01 ||
      localCrc !== entry.crc32 ||
      compressedSize !== entry.size ||
      uncompressedSize !== entry.size ||
      nameLength !== entry.nameBytes.length ||
      extraLength !== 0
    ) {
      packageError("invalid_archive", "Local and central ZIP metadata do not match exactly.");
    }
    ensureRange(archive, entry.localOffset + LOCAL_HEADER_BYTES, nameLength, centralOffset);
    const localName = archive.subarray(
      entry.localOffset + LOCAL_HEADER_BYTES,
      entry.localOffset + LOCAL_HEADER_BYTES + nameLength,
    );
    if (!bytesEqual(localName, entry.nameBytes)) {
      packageError("invalid_archive", "Local and central ZIP entry names do not match exactly.");
    }
    const dataStart = entry.localOffset + LOCAL_HEADER_BYTES + nameLength;
    const dataEnd = dataStart + entry.size;
    ensureRange(archive, dataStart, entry.size, centralOffset);
    locatedEntries.push({ ...entry, dataStart, dataEnd });
    expectedLocalOffset = dataEnd;
  }
  if (expectedLocalOffset !== centralOffset) {
    packageError("invalid_archive", "ZIP local entries do not end exactly at the central directory.");
  }

  for (const entry of locatedEntries) {
    const content = archive.subarray(entry.dataStart, entry.dataEnd);
    if (crc32(content) !== entry.crc32) {
      packageError("crc_mismatch", `ZIP entry ${entry.name} failed CRC-32 validation.`);
    }
  }

  const mimetypeEntry = locatedEntries[0];
  const expectedMimetype = Buffer.from(PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE, "ascii");
  if (!bytesEqual(archive.subarray(mimetypeEntry.dataStart, mimetypeEntry.dataEnd), expectedMimetype)) {
    packageError("invalid_archive", "The first entry is not the exact ProofCanvas package media type.");
  }

  const manifestEntry = locatedEntries[1];
  const manifestBytes = archive.subarray(manifestEntry.dataStart, manifestEntry.dataEnd);
  const manifest = parseManifest(manifestBytes);
  const projectEntry = locatedEntries[2];
  const projectBytes = archive.subarray(projectEntry.dataStart, projectEntry.dataEnd);

  if (manifest.project.bytes !== projectBytes.length) {
    packageError("project_size_mismatch", "Manifest project byte length does not match project.json.");
  }
  if (sha256(projectBytes) !== manifest.project.sha256) {
    packageError("project_hash_mismatch", "Manifest project SHA-256 does not match project.json.");
  }
  const project = parseCanonicalProject(projectBytes);
  assertPortableAssetReferences(project);
  if (manifest.source.projectId !== project.metadata.id) {
    packageError("invalid_manifest", "Manifest source project ID does not match project metadata.");
  }

  const projectAssetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  if (manifest.assets.length !== project.assets.length) {
    packageError("invalid_manifest", "Manifest asset IDs do not exactly match the project assets.");
  }
  const groups = new Map<string, AssetMetadata[]>();
  for (const manifestAsset of manifest.assets) {
    const metadata = projectAssetsById.get(manifestAsset.id);
    if (!metadata) packageError("invalid_manifest", `Manifest references unknown asset ${manifestAsset.id}.`);
    const expectedPath = projectPackageAssetPath(metadata);
    if (manifestAsset.path !== expectedPath) {
      packageError("invalid_manifest", `Manifest path for ${manifestAsset.id} is not content-derived.`);
    }
    const group = groups.get(expectedPath);
    if (group) group.push(metadata);
    else groups.set(expectedPath, [metadata]);
  }
  for (const asset of project.assets) {
    if (!manifest.assets.some((manifestAsset) => manifestAsset.id === asset.id)) {
      packageError("invalid_manifest", `Manifest is missing project asset ${asset.id}.`);
    }
  }
  assertUniquePackageBlobMetadata(groups);

  const expectedAssetPaths = [...groups.keys()].sort(compareAscii);
  const actualAssetPaths = locatedEntries.slice(3).map((entry) => entry.name);
  const expectedPathSet = new Set(expectedAssetPaths);
  const actualPathSet = new Set(actualAssetPaths);
  for (const path of actualAssetPaths) {
    if (!expectedPathSet.has(path)) packageError("unexpected_entry", `Unexpected asset entry ${path}.`);
  }
  for (const path of expectedAssetPaths) {
    if (!actualPathSet.has(path)) packageError("missing_entry", `Missing asset entry ${path}.`);
  }
  if (!arraysEqual(expectedAssetPaths, actualAssetPaths)) {
    packageError("invalid_entry_order", "Asset entries are not in canonical path order.");
  }

  const entriesByName = new Map(locatedEntries.map((entry) => [entry.name, entry]));
  const retainedContentByPath = new Map<string, ValidatedAssetContent>();
  let admittedBytes = 0;
  for (const path of expectedAssetPaths) {
    const entry = entriesByName.get(path)!;
    const rawBytes = archive.subarray(entry.dataStart, entry.dataEnd);
    const assets = groups.get(path)!;
    for (const asset of assets) {
      if (asset.size !== rawBytes.length) {
        packageError(
          "asset_metadata_mismatch",
          `Asset ${asset.id} size does not match archive entry ${path}.`,
        );
      }
    }
    const validated = validatePackageAsset(assets[0], rawBytes, admittedBytes);
    for (let index = 1; index < assets.length; index += 1) {
      assertPackageAssetMetadata(assets[index], validated);
    }
    retainedContentByPath.set(path, validated);
    admittedBytes += rawBytes.length;
  }

  const parsedAssets = manifest.assets.map((manifestAsset) => {
    const metadata = projectAssetsById.get(manifestAsset.id)!;
    const shared = retainedContentByPath.get(manifestAsset.path)!;
    return {
      assetId: manifestAsset.id,
      metadata,
      contentBytes: shared.contentBytes,
      validatedContent: { ...shared, filename: metadata.filename },
    };
  });

  return {
    project,
    sourceRevision: manifest.source.revision,
    manifest,
    assets: parsedAssets,
    sha256: sha256(archive),
  };
}

function parseManifest(bytes: Buffer): ProjectPackageManifest {
  let decoded: string;
  let candidate: unknown;
  try {
    decoded = UTF8_DECODER.decode(bytes);
    candidate = JSON.parse(decoded) as unknown;
  } catch (error) {
    packageError("invalid_manifest", "manifest.json must be valid UTF-8 JSON.", undefined, error);
  }
  const parsed = ProjectPackageManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    packageError(
      "invalid_manifest",
      "manifest.json does not satisfy the strict package schema.",
      { issues: parsed.error.issues },
      parsed.error,
    );
  }
  const canonical = Buffer.from(canonicalProjectPackageManifestJson(parsed.data), "utf8");
  if (!bytesEqual(bytes, canonical)) {
    packageError("manifest_not_canonical", "manifest.json bytes are not canonical.");
  }
  return parsed.data;
}

function parseCanonicalProject(bytes: Buffer): ProjectDocument {
  let decoded: string;
  let candidate: unknown;
  let project: ProjectDocument;
  try {
    decoded = UTF8_DECODER.decode(bytes);
    candidate = JSON.parse(decoded) as unknown;
    project = parseProjectDocument(candidate);
  } catch (error) {
    packageError("invalid_project", "project.json must be a valid canonical ProjectDocument.", undefined, error);
  }
  const canonical = Buffer.from(canonicalProjectJson(project), "utf8");
  if (!bytesEqual(bytes, canonical)) {
    packageError("project_not_canonical", "project.json bytes are not canonical.");
  }
  return project;
}

function assertCanonicalEntryNames(entries: readonly CentralEntry[]): void {
  const required = ["mimetype", "manifest.json", "project.json"];
  if (entries.length < required.length) packageError("missing_entry", "Package is missing required entries.");
  for (let index = 0; index < required.length; index += 1) {
    if (entries[index].name !== required[index]) {
      packageError("invalid_entry_order", `Entry ${index} must be ${required[index]}.`);
    }
  }
  let previous: string | undefined;
  for (const entry of entries.slice(3)) {
    if (!/^assets\/[a-f0-9]{64}\.(?:jpg|m4a|mp3|png|svg|wav|webp)$/.test(entry.name)) {
      packageError("unexpected_entry", `Package entry ${entry.name} is not a canonical asset path.`);
    }
    if (previous !== undefined && compareAscii(previous, entry.name) >= 0) {
      packageError("invalid_entry_order", "Asset entries must be strictly sorted by path.");
    }
    previous = entry.name;
  }
}

function enforceEntrySizeLimits(entries: readonly CentralEntry[]): void {
  const expectedMimetypeBytes = Buffer.byteLength(PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE, "ascii");
  if (entries[0].size !== expectedMimetypeBytes) {
    packageError("invalid_archive", "mimetype entry has an invalid byte length.");
  }
  if (entries[1].size > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxManifestBytes) {
    packageError("entry_too_large", "manifest.json exceeds its byte limit.");
  }
  if (entries[2].size > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxProjectBytes) {
    packageError("entry_too_large", "project.json exceeds its byte limit.");
  }
  let aggregate = 0;
  for (const entry of entries.slice(3)) {
    if (entry.size === 0 || entry.size > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxAssetBytes) {
      packageError("entry_too_large", `Asset entry ${entry.name} exceeds its byte limit.`);
    }
    aggregate = checkedAdd(
      aggregate,
      entry.size,
      PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxAssetAggregateBytes,
      "aggregate_too_large",
      "Package asset entries exceed the aggregate byte limit.",
    );
  }
}

function encodeEntryName(name: string): Buffer {
  assertSafeEntryName(name);
  const bytes = Buffer.from(name, "ascii");
  if (
    bytes.length === 0 ||
    bytes.length > PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxEntryPathBytes ||
    bytes.toString("ascii") !== name
  ) {
    packageError("unsafe_entry_path", "Package entry names must be bounded ASCII paths.");
  }
  return bytes;
}

function decodeEntryName(bytes: Buffer): string {
  for (const byte of bytes) {
    if (byte < 0x21 || byte > 0x7e) {
      packageError("unsafe_entry_path", "Package entry names must contain printable ASCII only.");
    }
  }
  return bytes.toString("ascii");
}

function assertSafeEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.includes("%") ||
    /^[a-zA-Z]:/.test(name) ||
    name.normalize("NFKC") !== name
  ) {
    packageError("unsafe_entry_path", `Unsafe package entry path ${JSON.stringify(name)}.`);
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    packageError("unsafe_entry_path", `Unsafe package entry path ${JSON.stringify(name)}.`);
  }
}

function ensureRange(buffer: Buffer, offset: number, length: number, end = buffer.length): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    end < 0 ||
    offset > end ||
    length > end - offset ||
    end > buffer.length
  ) {
    packageError("invalid_archive", "ZIP structure points outside its bounded archive region.");
  }
}

function readU16(buffer: Buffer, offset: number): number {
  ensureRange(buffer, offset, 2);
  return buffer.readUInt16LE(offset);
}

function readU32(buffer: Buffer, offset: number): number {
  ensureRange(buffer, offset, 4);
  return buffer.readUInt32LE(offset);
}

function checkedAdd(
  left: number,
  right: number,
  maximum: number,
  code: "aggregate_too_large" | "archive_too_large" | "entry_limit_exceeded",
  message: string,
): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    left > maximum ||
    right > maximum - left
  ) {
    packageError(code, message);
  }
  return left + right;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  if (left === right || (
    left.buffer === right.buffer
    && left.byteOffset === right.byteOffset
    && left.byteLength === right.byteLength
  )) return true;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isUint8Array(value: unknown): value is Uint8Array {
  return Buffer.isBuffer(value) || (
    value !== null &&
    typeof value === "object" &&
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packageError(
  code: ProjectPackageError["code"],
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): never {
  throw new ProjectPackageError(code, message, details, { cause });
}
