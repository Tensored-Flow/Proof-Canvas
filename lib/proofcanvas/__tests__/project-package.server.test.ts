jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("../assetContent.server", () => {
  const actual = jest.requireActual<typeof import("../assetContent.server")>("../assetContent.server");
  return { ...actual, validateAssetContent: jest.fn(actual.validateAssetContent) };
});

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import { validateAssetContent } from "../assetContent.server";
import { createCantorDemoProject } from "../demo";
import {
  PROOFCANVAS_PROJECT_PACKAGE_LIMITS,
  PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE,
  ProjectPackageError,
} from "../projectPackage";
import {
  buildProjectPackage,
  parseProjectPackage,
  type ProjectPackageAssetByteRecord,
} from "../projectPackage.server";
import {
  ProjectDocumentSchema,
  cloneSerializable,
  type AssetMetadata,
  type ProjectDocument,
  type SceneObject,
} from "../schema";

const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_BYTES = 22;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function png(width = 2, height = 2): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const decoded = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(decoded)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function riffChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

function wav(sampleCount: number, sampleRate = 8_000): Buffer {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(sampleRate, 8);
  format.writeUInt16LE(1, 12);
  format.writeUInt16LE(8, 14);
  const body = Buffer.concat([
    Buffer.from("WAVE", "ascii"),
    riffChunk("fmt ", format),
    riffChunk("data", Buffer.alloc(sampleCount, 0x80)),
  ]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

interface Fixture {
  project: ProjectDocument;
  records: ProjectPackageAssetByteRecord[];
}

function fixture(assetCount = 1, deduplicate = false, referenceAssets = true): Fixture {
  const project = cloneSerializable(createCantorDemoProject());
  const records: ProjectPackageAssetByteRecord[] = [];
  project.assets = [];

  for (let index = 0; index < assetCount; index += 1) {
    const contentBytes = deduplicate ? png(2, 2) : png(2 + index, 2);
    const validated = validateAssetContent({
      filename: `diagram-${index}.png`,
      bytes: contentBytes,
      claimedMimeType: "image/png",
    });
    const metadata: AssetMetadata = {
      id: `asset-package-${index}`,
      filename: validated.filename,
      mimeType: validated.mimeType,
      size: validated.size,
      sha256: validated.sha256,
      width: validated.width,
      height: validated.height,
      provenance: "uploaded",
    };
    const object: SceneObject = {
      id: `object-package-${index}`,
      type: "image",
      name: `Package image ${index}`,
      locked: false,
      visible: true,
      transform: {
        x: 100 + index * 20,
        y: 100,
        width: validated.width,
        height: validated.height,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
      },
      style: {},
      properties: { assetId: metadata.id },
    };
    project.assets.push(metadata);
    if (referenceAssets) project.shots[0].objects.push(object);
    records.push({ assetId: metadata.id, contentBytes });
  }

  return { project: ProjectDocumentSchema.parse(project), records };
}

interface ZipEntryLocation {
  name: string;
  centralOffset: number;
  localOffset: number;
  dataStart: number;
  size: number;
}

function zipEntries(bytes: Uint8Array): ZipEntryLocation[] {
  const archive = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = archive.length - EOCD_BYTES;
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries: ZipEntryLocation[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(CENTRAL_SIGNATURE);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("ascii");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    entries.push({
      name,
      centralOffset: cursor,
      localOffset,
      dataStart: localOffset + 30 + localNameLength + localExtraLength,
      size,
    });
    cursor += 46 + nameLength;
  }
  return entries;
}

function refreshEntryCrc(archive: Buffer, entry: ZipEntryLocation): void {
  const crc = crc32(archive.subarray(entry.dataStart, entry.dataStart + entry.size));
  archive.writeUInt32LE(crc, entry.localOffset + 14);
  archive.writeUInt32LE(crc, entry.centralOffset + 16);
}

function mutatePackage(bytes: Uint8Array, mutate: (archive: Buffer, entries: ZipEntryLocation[]) => void): Buffer {
  const archive = Buffer.from(bytes);
  mutate(archive, zipEntries(archive));
  return archive;
}

function expectPackageCode(action: () => unknown, code: ProjectPackageError["code"]): void {
  try {
    action();
    throw new Error(`Expected package error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectPackageError);
    expect(error).toMatchObject({ code });
  }
}

test("builds deterministic canonical STORE bytes and round-trips across a fresh buffer", () => {
  const { project, records } = fixture(2);
  const first = buildProjectPackage({ project, sourceRevision: 9, assets: records });
  const second = buildProjectPackage({ project, sourceRevision: 9, assets: [...records].reverse() });
  const callback = buildProjectPackage({
    project,
    sourceRevision: 9,
    assets: {
      assetIds: records.map(({ assetId }) => assetId).reverse(),
      load: ({ id }) => records.find(({ assetId }) => assetId === id)?.contentBytes,
    },
  });

  expect(Buffer.from(second.bytes)).toEqual(Buffer.from(first.bytes));
  expect(Buffer.from(callback.bytes)).toEqual(Buffer.from(first.bytes));
  expect(first.sha256).toBe(createHash("sha256").update(first.bytes).digest("hex"));

  const restartedBytes = Uint8Array.from(first.bytes);
  const parsed = parseProjectPackage(restartedBytes);
  expect(parsed.project).toEqual(project);
  expect(parsed.sourceRevision).toBe(9);
  expect(parsed.assets.map(({ assetId }) => assetId)).toEqual(records.map(({ assetId }) => assetId));
  expect(parsed.assets.map(({ contentBytes }) => Buffer.from(contentBytes)))
    .toEqual(records.map(({ contentBytes }) => Buffer.from(contentBytes)));

  const rebuilt = buildProjectPackage({
    project: parsed.project,
    sourceRevision: parsed.sourceRevision,
    assets: parsed.assets,
  });
  expect(Buffer.from(rebuilt.bytes)).toEqual(Buffer.from(first.bytes));
});

test("writes exact canonical entry order, timestamps, permissions, and zero optional ZIP fields", () => {
  const coherent = fixture(2);
  const archive = Buffer.from(buildProjectPackage({ ...coherent, sourceRevision: 1, assets: coherent.records }).bytes);
  const entries = zipEntries(archive);
  expect(entries.map(({ name }) => name)).toEqual([
    "mimetype",
    "manifest.json",
    "project.json",
    ...entries.slice(3).map(({ name }) => name).sort(),
  ]);
  expect(entries[0].localOffset).toBe(0);
  expect(archive.subarray(entries[0].dataStart, entries[0].dataStart + entries[0].size).toString("ascii"))
    .toBe(PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE);

  for (const entry of entries) {
    expect(archive.readUInt16LE(entry.localOffset + 4)).toBe(20);
    expect(archive.readUInt16LE(entry.localOffset + 6)).toBe(0);
    expect(archive.readUInt16LE(entry.localOffset + 8)).toBe(0);
    expect(archive.readUInt16LE(entry.localOffset + 10)).toBe(0);
    expect(archive.readUInt16LE(entry.localOffset + 12)).toBe(33);
    expect(archive.readUInt16LE(entry.localOffset + 28)).toBe(0);
    expect(archive.readUInt16LE(entry.centralOffset + 4)).toBe(0x0314);
    expect(archive.readUInt16LE(entry.centralOffset + 8)).toBe(0);
    expect(archive.readUInt16LE(entry.centralOffset + 10)).toBe(0);
    expect(archive.readUInt16LE(entry.centralOffset + 12)).toBe(0);
    expect(archive.readUInt16LE(entry.centralOffset + 14)).toBe(33);
    expect(archive.readUInt16LE(entry.centralOffset + 30)).toBe(0);
    expect(archive.readUInt16LE(entry.centralOffset + 32)).toBe(0);
    expect(archive.readUInt32LE(entry.centralOffset + 38)).toBe((0o100600 << 16) >>> 0);
  }
  expect(archive.length).toBeGreaterThan(0);
});

test("deduplicates identical blobs while binding every asset ID", () => {
  const { project, records } = fixture(2, true);
  const built = buildProjectPackage({ project, sourceRevision: 3, assets: records });
  expect(zipEntries(built.bytes).filter(({ name }) => name.startsWith("assets/"))).toHaveLength(1);
  expect(built.manifest.assets[0].path).toBe(built.manifest.assets[1].path);
  const parsed = parseProjectPackage(built.bytes);
  expect(parsed.assets).toHaveLength(2);
  expect(parsed.assets[0].contentBytes).toBe(parsed.assets[1].contentBytes);
});

test("fully decodes one unique blob once while binding the maximum 256 project-local asset tuples", () => {
  const { project, records } = fixture(256, true, false);
  const validator = validateAssetContent as jest.MockedFunction<typeof validateAssetContent>;
  validator.mockClear();
  const built = buildProjectPackage({ project, sourceRevision: 3, assets: records });
  expect(validator).toHaveBeenCalledTimes(1);
  expect(zipEntries(built.bytes).filter(({ name }) => name.startsWith("assets/"))).toHaveLength(1);

  validator.mockClear();
  const parsed = parseProjectPackage(built.bytes);
  expect(validator).toHaveBeenCalledTimes(1);
  expect(parsed.assets).toHaveLength(256);
  expect(new Set(parsed.assets.map(({ contentBytes }) => contentBytes)).size).toBe(1);
});

test("admits the exact aggregate decoded-image boundary and rejects the next unique image before decode", () => {
  const exact = fixture(2);
  for (const asset of exact.project.assets) {
    asset.width = 8_192;
    asset.height = 8_192;
  }
  // The synthetic metadata reaches content validation, proving the 512 MiB
  // aggregate boundary itself was admitted exactly.
  expectPackageCode(
    () => buildProjectPackage({ ...exact, sourceRevision: 1, assets: exact.records }),
    "asset_metadata_mismatch",
  );

  const exceeded = fixture(3);
  for (const asset of exceeded.project.assets) {
    asset.width = 8_192;
    asset.height = 8_192;
  }
  const validator = validateAssetContent as jest.MockedFunction<typeof validateAssetContent>;
  validator.mockClear();
  expectPackageCode(
    () => buildProjectPackage({ ...exceeded, sourceRevision: 1, assets: exceeded.records }),
    "aggregate_too_large",
  );
  expect(validator).not.toHaveBeenCalled();
});

test("round-trips an asset-free project with exactly the three authority entries", () => {
  const project = ProjectDocumentSchema.parse(createCantorDemoProject());
  const built = buildProjectPackage({ project, sourceRevision: 2, assets: [] });
  expect(zipEntries(built.bytes).map(({ name }) => name)).toEqual([
    "mimetype",
    "manifest.json",
    "project.json",
  ]);
  expect(parseProjectPackage(built.bytes)).toMatchObject({
    project,
    sourceRevision: 2,
    assets: [],
  });
});

test("round-trips non-frame-aligned decoded audio through canonical asset duration metadata", () => {
  // 1001 / 44100 cannot be represented exactly on ProofCanvas's 10 ns timeline grid.
  const contentBytes = wav(1_001, 44_100);
  const validated = validateAssetContent({
    filename: "non-frame-aligned.wav",
    bytes: contentBytes,
    claimedMimeType: "audio/wav",
  });
  expect(validated.duration).toBe(1_001 / 44_100);

  const candidate = cloneSerializable(createCantorDemoProject());
  candidate.assets = [{
    id: "asset-non-frame-audio",
    filename: validated.filename,
    mimeType: validated.mimeType,
    size: validated.size,
    sha256: validated.sha256,
    duration: validated.duration,
    provenance: "uploaded",
  }];
  const project = ProjectDocumentSchema.parse(candidate);
  expect(project.assets[0].duration).not.toBe(validated.duration);
  const records = [{ assetId: project.assets[0].id, contentBytes }];

  const built = buildProjectPackage({ project, sourceRevision: 4, assets: records });
  const parsed = parseProjectPackage(Uint8Array.from(built.bytes));
  expect(parsed.project.assets[0].duration).toBe(project.assets[0].duration);
  expect(Buffer.from(parsed.assets[0].contentBytes)).toEqual(contentBytes);

  const rebuilt = buildProjectPackage({
    project: parsed.project,
    sourceRevision: parsed.sourceRevision,
    assets: parsed.assets,
  });
  expect(Buffer.from(rebuilt.bytes)).toEqual(Buffer.from(built.bytes));
});

test("refuses missing, extra, duplicate, wrong, and metadata-inconsistent asset content", () => {
  const { project, records } = fixture();
  expectPackageCode(
    () => buildProjectPackage({ project, sourceRevision: 1, assets: [] }),
    "asset_missing",
  );
  expectPackageCode(
    () => buildProjectPackage({
      project,
      sourceRevision: 1,
      assets: [...records, { assetId: "asset-extra", contentBytes: png() }],
    }),
    "asset_unexpected",
  );
  expectPackageCode(
    () => buildProjectPackage({ project, sourceRevision: 1, assets: [records[0], records[0]] }),
    "asset_duplicate",
  );
  const wrong = Buffer.from(records[0].contentBytes);
  wrong[wrong.length - 1] ^= 1;
  expectPackageCode(
    () => buildProjectPackage({
      project,
      sourceRevision: 1,
      assets: [{ assetId: records[0].assetId, contentBytes: wrong }],
    }),
    "asset_content_invalid",
  );

  const dimensions = cloneSerializable(project);
  dimensions.assets[0].width = dimensions.assets[0].width! + 1;
  const validButFalseMetadata = ProjectDocumentSchema.parse(dimensions);
  expectPackageCode(
    () => buildProjectPackage({ project: validButFalseMetadata, sourceRevision: 1, assets: records }),
    "asset_metadata_mismatch",
  );
});

test("refuses legacy media sources, including source-only objects", () => {
  const project = cloneSerializable(createCantorDemoProject());
  project.shots[0].objects.push({
    id: "object-legacy-package",
    type: "image",
    name: "Legacy package image",
    locked: false,
    visible: true,
    transform: { x: 100, y: 100, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: { source: "/proofcanvas/assets/editorial-mark.svg" },
  });
  const parsed = ProjectDocumentSchema.parse(project);
  expectPackageCode(
    () => buildProjectPackage({ project: parsed, sourceRevision: 1, assets: [] }),
    "legacy_asset_source",
  );

  const current = fixture();
  current.project.shots[0].objects.find(({ id }) => id === "object-package-0")!.properties.source =
    "/proofcanvas/assets/editorial-mark.svg";
  expectPackageCode(
    () => buildProjectPackage({
      project: ProjectDocumentSchema.parse(current.project),
      sourceRevision: 1,
      assets: current.records,
    }),
    "legacy_asset_source",
  );
});

test.each([
  ["deflate", "unsupported_compression", (archive: Buffer, entries: ZipEntryLocation[]) => archive.writeUInt16LE(8, entries[0].centralOffset + 10)],
  ["encryption", "encrypted_entry", (archive: Buffer, entries: ZipEntryLocation[]) => archive.writeUInt16LE(1, entries[0].centralOffset + 8)],
  ["symlink or noncanonical mode", "unsafe_entry_type", (archive: Buffer, entries: ZipEntryLocation[]) => archive.writeUInt32LE((0o120777 << 16) >>> 0, entries[0].centralOffset + 38)],
  ["local header disagreement", "unsupported_compression", (archive: Buffer, entries: ZipEntryLocation[]) => archive.writeUInt16LE(8, entries[0].localOffset + 8)],
] as const)("rejects %s ZIP metadata", (_label, code, mutate) => {
  const current = fixture();
  const built = buildProjectPackage({ ...current, sourceRevision: 1, assets: current.records });
  const malformed = mutatePackage(built.bytes, mutate);
  expectPackageCode(() => parseProjectPackage(malformed), code);
});

test("rejects prefixes, trailing bytes, gaps, CRC corruption, and altered mimetype bytes", () => {
  const current = fixture();
  const built = buildProjectPackage({ ...current, sourceRevision: 1, assets: current.records });
  expectPackageCode(() => parseProjectPackage(Buffer.concat([Buffer.from([0]), Buffer.from(built.bytes)])), "invalid_archive");
  expectPackageCode(() => parseProjectPackage(Buffer.concat([Buffer.from(built.bytes), Buffer.from([0])])), "invalid_archive");

  const gap = mutatePackage(built.bytes, (archive, entries) => {
    archive.writeUInt32LE(entries[1].localOffset + 1, entries[1].centralOffset + 42);
  });
  expectPackageCode(() => parseProjectPackage(gap), "invalid_archive");

  const corrupt = mutatePackage(built.bytes, (archive, entries) => {
    const asset = entries[3];
    archive[asset.dataStart + 10] ^= 1;
  });
  expectPackageCode(() => parseProjectPackage(corrupt), "crc_mismatch");

  const mimetype = mutatePackage(built.bytes, (archive, entries) => {
    archive[entries[0].dataStart] = "x".charCodeAt(0);
    refreshEntryCrc(archive, entries[0]);
  });
  expectPackageCode(() => parseProjectPackage(mimetype), "invalid_archive");
});

test("rejects traversal-shaped, duplicate, and NFKC-case-colliding central names", () => {
  const one = fixture();
  const oneBuilt = buildProjectPackage({ ...one, sourceRevision: 1, assets: one.records });
  const traversal = mutatePackage(oneBuilt.bytes, (archive, entries) => {
    const asset = entries[3];
    archive.write("%2e%2e/", asset.centralOffset + 46, "ascii");
  });
  expectPackageCode(() => parseProjectPackage(traversal), "unsafe_entry_path");

  const two = fixture(2);
  const twoBuilt = buildProjectPackage({ ...two, sourceRevision: 1, assets: two.records });
  const duplicate = mutatePackage(twoBuilt.bytes, (archive, entries) => {
    const first = entries[3];
    const second = entries[4];
    archive.copy(archive, second.centralOffset + 46, first.centralOffset + 46, first.centralOffset + 46 + first.name.length);
  });
  expectPackageCode(() => parseProjectPackage(duplicate), "duplicate_entry");

  const collision = mutatePackage(twoBuilt.bytes, (archive, entries) => {
    const first = entries[3];
    const second = entries[4];
    archive.copy(archive, second.centralOffset + 46, first.centralOffset + 46, first.centralOffset + 46 + first.name.length);
    archive[second.centralOffset + 46] = "A".charCodeAt(0);
  });
  expectPackageCode(() => parseProjectPackage(collision), "case_collision");
});

test("rejects noncanonical and recursively invalid manifests with typed diagnostics", () => {
  const current = fixture();
  const built = buildProjectPackage({ ...current, sourceRevision: 1, assets: current.records });
  const noncanonical = mutatePackage(built.bytes, (archive, entries) => {
    const manifest = entries[1];
    archive[manifest.dataStart + manifest.size - 1] = " ".charCodeAt(0);
    refreshEntryCrc(archive, manifest);
  });
  expectPackageCode(() => parseProjectPackage(noncanonical), "manifest_not_canonical");

  const invalid = mutatePackage(built.bytes, (archive, entries) => {
    const manifest = entries[1];
    const data = archive.subarray(manifest.dataStart, manifest.dataStart + manifest.size);
    const pathKey = data.indexOf(Buffer.from("\"path\"", "ascii"));
    expect(pathKey).toBeGreaterThanOrEqual(0);
    data[pathKey + 1] = "x".charCodeAt(0);
    refreshEntryCrc(archive, manifest);
  });
  expectPackageCode(() => parseProjectPackage(invalid), "invalid_manifest");
});

test("checks project hash before accepting canonical ProjectDocument bytes", () => {
  const current = fixture();
  const built = buildProjectPackage({ ...current, sourceRevision: 1, assets: current.records });
  const hashMismatch = mutatePackage(built.bytes, (archive, entries) => {
    const project = entries[2];
    archive[project.dataStart + project.size - 1] = " ".charCodeAt(0);
    refreshEntryCrc(archive, project);
  });
  expectPackageCode(() => parseProjectPackage(hashMismatch), "project_hash_mismatch");

  const noncanonical = mutatePackage(built.bytes, (archive, entries) => {
    const manifest = entries[1];
    const project = entries[2];
    archive[project.dataStart + project.size - 1] = " ".charCodeAt(0);
    refreshEntryCrc(archive, project);
    const newHash = createHash("sha256")
      .update(archive.subarray(project.dataStart, project.dataStart + project.size))
      .digest("hex");
    const manifestData = archive.subarray(manifest.dataStart, manifest.dataStart + manifest.size);
    const oldHashOffset = manifestData.indexOf(Buffer.from(built.manifest.project.sha256, "ascii"));
    expect(oldHashOffset).toBeGreaterThanOrEqual(0);
    manifestData.write(newHash, oldHashOffset, "ascii");
    refreshEntryCrc(archive, manifest);
  });
  expectPackageCode(() => parseProjectPackage(noncanonical), "project_not_canonical");
});

test("applies entry, central-directory, item, and aggregate header bounds before payload walking", () => {
  const current = fixture();
  const built = buildProjectPackage({ ...current, sourceRevision: 1, assets: current.records });
  const tooMany = Buffer.from(built.bytes);
  const tooManyEocd = tooMany.length - EOCD_BYTES;
  tooMany.writeUInt16LE(PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxEntries + 1, tooManyEocd + 8);
  tooMany.writeUInt16LE(PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxEntries + 1, tooManyEocd + 10);
  expectPackageCode(() => parseProjectPackage(tooMany), "entry_limit_exceeded");

  const zip64 = Buffer.from(built.bytes);
  const zip64Eocd = zip64.length - EOCD_BYTES;
  zip64.writeUInt16LE(0xffff, zip64Eocd + 8);
  zip64.writeUInt16LE(0xffff, zip64Eocd + 10);
  expectPackageCode(() => parseProjectPackage(zip64), "zip64_unsupported");

  const central = Buffer.from(built.bytes);
  central.writeUInt32LE(PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxCentralDirectoryBytes + 1, central.length - 10);
  expectPackageCode(() => parseProjectPackage(central), "entry_limit_exceeded");

  const item = mutatePackage(built.bytes, (archive, entries) => {
    const asset = entries[3];
    archive.writeUInt32LE(PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxAssetBytes + 1, asset.centralOffset + 20);
    archive.writeUInt32LE(PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxAssetBytes + 1, asset.centralOffset + 24);
  });
  expectPackageCode(() => parseProjectPackage(item), "entry_too_large");

  const five = fixture(5);
  const fiveBuilt = buildProjectPackage({ ...five, sourceRevision: 1, assets: five.records });
  const aggregate = mutatePackage(fiveBuilt.bytes, (archive, entries) => {
    for (const asset of entries.slice(3)) {
      archive.writeUInt32LE(PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxAssetBytes, asset.centralOffset + 20);
      archive.writeUInt32LE(PROOFCANVAS_PROJECT_PACKAGE_LIMITS.maxAssetBytes, asset.centralOffset + 24);
    }
  });
  expectPackageCode(() => parseProjectPackage(aggregate), "aggregate_too_large");
});

test("maps malformed runtime values and truncated archives to typed package diagnostics", () => {
  for (const candidate of [null, {}, "zip", new DataView(new ArrayBuffer(32))]) {
    try {
      parseProjectPackage(candidate as unknown as Uint8Array);
      throw new Error("Expected malformed input to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectPackageError);
    }
  }

  const current = fixture();
  const built = buildProjectPackage({ ...current, sourceRevision: 1, assets: current.records });
  for (const length of [0, 1, 21, 22, 30, Math.floor(built.bytes.length / 2), built.bytes.length - 1]) {
    try {
      parseProjectPackage(built.bytes.subarray(0, length));
      throw new Error(`Expected truncation at ${length} bytes to fail`);
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectPackageError);
    }
  }
});
