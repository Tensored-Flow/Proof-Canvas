import "server-only";

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { Worker } from "node:worker_threads";
import { inflateSync } from "node:zlib";

export const PROOFCANVAS_ASSET_CONTENT_LIMITS = Object.freeze({
  maxFilenameInputBytes: 1_024,
  maxFilenameBytes: 240,
  maxImageBytes: 32 * 1024 * 1024,
  maxSvgBytes: 2 * 1024 * 1024,
  maxAudioBytes: 64 * 1024 * 1024,
  maxItemBytes: 64 * 1024 * 1024,
  maxAggregateBytes: 128 * 1024 * 1024,
  maxImageDimension: 16_384,
  maxImagePixels: 64 * 1024 * 1024,
  maxDecodedImageBytes: 256 * 1024 * 1024,
  maxAudioDurationSeconds: 7_200,
  maxSvgElements: 10_000,
  maxSvgDepth: 64,
  maxPngChunks: 4_096,
  maxPngAncillaryBytes: 256 * 1024,
  maxPngTextBytes: 64 * 1024,
  maxJpegMarkers: 4_096,
  maxJpegMetadataBytes: 2 * 1024 * 1024,
  maxWebpChunks: 64,
  maxWebpMetadataBytes: 2 * 1024 * 1024,
  maxImageDecodeMilliseconds: 15_000,
  maxRiffChunks: 4_096,
  maxWavAncillaryBytes: 1024 * 1024,
  maxMp3Id3Bytes: 1024 * 1024,
  maxMp3Id3Frames: 4_096,
  maxMp3AudioFrames: 1_000_000,
  maxMp4Boxes: 50_000,
  maxMp4Depth: 12,
});

export type ProofCanvasAssetMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/svg+xml"
  | "audio/wav"
  | "audio/mpeg"
  | "audio/mp4";

export type AssetContentErrorCode =
  | "invalid_input"
  | "invalid_filename"
  | "item_too_large"
  | "aggregate_too_large"
  | "declared_size_mismatch"
  | "unsupported_type"
  | "mime_mismatch"
  | "malformed_content"
  | "unsafe_svg"
  | "dimensions_limit"
  | "duration_limit"
  | "invalid_hash"
  | "hash_mismatch";

export class AssetContentError extends Error {
  constructor(
    public readonly code: AssetContentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AssetContentError";
  }
}

export interface ValidateAssetContentInput {
  filename: string;
  bytes: Uint8Array;
  /** The transport-declared length, when one exists. It must equal the bytes supplied. */
  declaredSize?: number;
  /** A client hint only. Content remains authoritative and a disagreement is rejected. */
  claimedMimeType?: string;
  /** A manifest hash, when validating an import. */
  expectedSha256?: string;
  /** Already-admitted bytes for the same project/package. */
  aggregateBytesBefore?: number;
}

export interface ValidatedAssetContent {
  filename: string;
  mimeType: ProofCanvasAssetMimeType;
  size: number;
  sha256: string;
  width?: number;
  height?: number;
  duration?: number;
  /** A copy of the exact bytes covered by size and sha256. */
  contentBytes: Uint8Array;
}

type ParsedContent = {
  mimeType: ProofCanvasAssetMimeType;
  width?: number;
  height?: number;
  duration?: number;
  /** Container-declared alpha, when the format has an authoritative flag. */
  hasAlpha?: boolean;
};

function assetError(code: AssetContentErrorCode, message: string): never {
  throw new AssetContentError(code, message);
}

function isSafeByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Performs the cheap admission check that an HTTP/archive reader can run before
 * allocating an asset body. Validation is repeated against actual bytes later.
 */
export function assertAssetByteBudget(declaredSize: number, aggregateBytesBefore = 0): void {
  if (!isSafeByteCount(declaredSize) || !isSafeByteCount(aggregateBytesBefore)) {
    assetError("invalid_input", "Asset byte counts must be non-negative safe integers.");
  }
  if (declaredSize <= 0) assetError("invalid_input", "An asset must contain at least one byte.");
  if (declaredSize > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxItemBytes) {
    assetError("item_too_large", `An asset may contain at most ${PROOFCANVAS_ASSET_CONTENT_LIMITS.maxItemBytes} bytes.`);
  }
  if (aggregateBytesBefore > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAggregateBytes
    || declaredSize > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAggregateBytes - aggregateBytesBefore) {
    assetError("aggregate_too_large", `Project assets may contain at most ${PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAggregateBytes} bytes in aggregate.`);
  }
}

const PATH_LIKE_CHARACTERS = /[\\/\u2044\u2215\u29f8\uff0f\uff3c]/u;
const ENCODED_PATH_FRAGMENT = /%(?:2e|2f|5c)/i;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Produces one portable basename. Traversal-shaped input is refused rather
 * than repaired, so a later ZIP/storage layer never has to infer intent.
 */
export function sanitizeAssetFilename(input: string): string {
  if (typeof input !== "string") assetError("invalid_filename", "Asset filename must be a string.");
  const inputBytes = Buffer.byteLength(input, "utf8");
  if (inputBytes === 0 || inputBytes > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxFilenameInputBytes) {
    assetError("invalid_filename", "Asset filename is empty or exceeds the input limit.");
  }
  const normalized = input.normalize("NFKC");
  if (PATH_LIKE_CHARACTERS.test(normalized)
    || ENCODED_PATH_FRAGMENT.test(normalized)
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes(":")
    || normalized === "."
    || normalized === ".."
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    assetError("invalid_filename", "Asset filename must be a plain basename without traversal or control characters.");
  }

  let safe = normalized
    .trim()
    .replace(/[()[\]{}]+/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/[ ]+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[. _-]+|[. _-]+$/g, "");
  if (!safe) safe = "asset";
  if (WINDOWS_RESERVED_BASENAME.test(safe)) safe = `asset-${safe}`;

  while (Buffer.byteLength(safe, "utf8") > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxFilenameBytes) {
    safe = safe.slice(0, -1).replace(/[. _-]+$/g, "");
  }
  if (!safe) safe = "asset";
  return safe;
}

const MIME_ALIASES = new Map<string, ProofCanvasAssetMimeType>([
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"],
  ["image/webp", "image/webp"],
  ["image/svg+xml", "image/svg+xml"],
  ["image/svg", "image/svg+xml"],
  ["audio/wav", "audio/wav"],
  ["audio/x-wav", "audio/wav"],
  ["audio/wave", "audio/wav"],
  ["audio/mpeg", "audio/mpeg"],
  ["audio/mp3", "audio/mpeg"],
  ["audio/mp4", "audio/mp4"],
  ["audio/m4a", "audio/mp4"],
  ["audio/x-m4a", "audio/mp4"],
]);

const MIME_EXTENSION: Record<ProofCanvasAssetMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "audio/wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
};

function normalizedClaim(value: string): ProofCanvasAssetMimeType | null {
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return MIME_ALIASES.get(mediaType) ?? null;
}

export function canonicalAssetFilename(input: string, mimeType: ProofCanvasAssetMimeType): string {
  const safe = sanitizeAssetFilename(input);
  const finalDot = safe.lastIndexOf(".");
  const base = finalDot > 0 && safe.length - finalDot <= 12 ? safe.slice(0, finalDot) : safe;
  const extension = MIME_EXTENSION[mimeType];
  const maxBaseBytes = PROOFCANVAS_ASSET_CONTENT_LIMITS.maxFilenameBytes - extension.length;
  let bounded = base || "asset";
  while (Buffer.byteLength(bounded, "utf8") > maxBaseBytes) bounded = bounded.slice(0, -1);
  bounded = bounded.replace(/[. _-]+$/g, "") || "asset";
  return `${bounded}${extension}`;
}

function ensureDimensions(width: number, height: number): void {
  const { maxImageDimension, maxImagePixels } = PROOFCANVAS_ASSET_CONTENT_LIMITS;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width > maxImageDimension || height > maxImageDimension || width > Math.floor(maxImagePixels / height)) {
    assetError("dimensions_limit", `Asset dimensions must be positive integers no larger than ${maxImageDimension} per side and ${maxImagePixels} pixels in total.`);
  }
}

function ascii(buffer: Buffer, start: number, length: number): string {
  return buffer.toString("ascii", start, start + length);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(buffer: Buffer): ParsedContent {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    assetError("malformed_content", "PNG signature is invalid.");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawPalette = false;
  let sawData = false;
  let dataEnded = false;
  let sawEnd = false;
  let colorType = -1;
  let bitDepth = 0;
  let interlace = 0;
  let paletteEntries = 0;
  let chunkCount = 0;
  let ancillaryBytes = 0;
  const compressedParts: Buffer[] = [];
  const singletonAncillary = new Set<string>();
  const compressedAncillary = new Set(["iCCP", "iTXt", "zTXt"]);
  const animationChunks = new Set(["acTL", "fcTL", "fdAT"]);
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) assetError("malformed_content", "PNG chunk header is truncated.");
    chunkCount += 1;
    if (chunkCount > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxPngChunks) assetError("malformed_content", "PNG contains too many chunks.");
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(dataEnd) || chunkEnd > buffer.length) assetError("malformed_content", "PNG chunk length exceeds the file.");
    const type = ascii(buffer, typeStart, 4);
    if (!/^[A-Za-z]{4}$/.test(type) || (buffer[typeStart + 2] & 0x20) !== 0) assetError("malformed_content", "PNG chunk type is invalid.");
    if (crc32(buffer, typeStart, dataEnd) !== buffer.readUInt32BE(dataEnd)) assetError("malformed_content", `PNG ${type} CRC is invalid.`);
    if (!sawHeader && type !== "IHDR") assetError("malformed_content", "PNG IHDR must be the first chunk.");
    if (sawEnd) assetError("malformed_content", "PNG contains data after IEND.");

    if (type === "IHDR") {
      if (sawHeader || length !== 13) assetError("malformed_content", "PNG must contain one 13-byte IHDR.");
      sawHeader = true;
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      const validDepths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!validDepths[colorType]?.includes(bitDepth)
        || buffer[dataStart + 10] !== 0 || buffer[dataStart + 11] !== 0 || ![0, 1].includes(buffer[dataStart + 12])) {
        assetError("malformed_content", "PNG IHDR encoding fields are unsupported or invalid.");
      }
      interlace = buffer[dataStart + 12];
      ensureDimensions(width, height);
    } else if (type === "PLTE") {
      if (sawPalette || sawData || colorType === 0 || colorType === 4 || length === 0 || length > 768 || length % 3 !== 0) {
        assetError("malformed_content", "PNG palette is invalid or misplaced.");
      }
      sawPalette = true;
      paletteEntries = length / 3;
      if (colorType === 3 && paletteEntries > 2 ** bitDepth) assetError("malformed_content", "PNG palette exceeds the indexed bit-depth capacity.");
    } else if (type === "IDAT") {
      if (dataEnded || length === 0 || (colorType === 3 && !sawPalette)) assetError("malformed_content", "PNG image data is invalid or non-contiguous.");
      sawData = true;
      compressedParts.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0 || !sawData) assetError("malformed_content", "PNG IEND is invalid or image data is missing.");
      sawEnd = true;
    } else {
      if (sawData) dataEnded = true;
      if ((buffer[typeStart] & 0x20) === 0) assetError("malformed_content", `PNG contains unsupported critical chunk ${type}.`);
      if (animationChunks.has(type)) assetError("malformed_content", "Animated PNG is outside the supported still-image boundary.");
      if (compressedAncillary.has(type)) assetError("malformed_content", `Compressed PNG metadata chunk ${type} is not accepted.`);
      ancillaryBytes += length;
      if (ancillaryBytes > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxPngAncillaryBytes) {
        assetError("malformed_content", "PNG ancillary metadata exceeds its byte budget.");
      }
      if (type === "tEXt") {
        const separator = buffer.indexOf(0, dataStart);
        if (length === 0 || length > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxPngTextBytes
          || separator <= dataStart || separator > dataStart + 79 || separator >= dataEnd) {
          assetError("malformed_content", "PNG text metadata is malformed or oversized.");
        }
      } else if (type === "tRNS") {
        const validLength = colorType === 0 ? length === 2
          : colorType === 2 ? length === 6
            : colorType === 3 ? sawPalette && length > 0 && length <= paletteEntries
              : false;
        if (sawData || !validLength || singletonAncillary.has(type)) assetError("malformed_content", "PNG transparency metadata is invalid, duplicated, or misplaced.");
        singletonAncillary.add(type);
      } else {
        const fixedLengths: Record<string, number> = { cHRM: 32, gAMA: 4, pHYs: 9, sRGB: 1, tIME: 7 };
        const expectedLength = fixedLengths[type];
        if (expectedLength === undefined || length !== expectedLength || singletonAncillary.has(type)) {
          assetError("malformed_content", `PNG ancillary chunk ${type} is unsupported, duplicated, or malformed.`);
        }
        if (((type === "cHRM" || type === "gAMA" || type === "sRGB") && (sawPalette || sawData))
          || (type === "pHYs" && sawData)) {
          assetError("malformed_content", `PNG ancillary chunk ${type} is misplaced.`);
        }
        if ((type === "gAMA" && buffer.readUInt32BE(dataStart) === 0)
          || (type === "sRGB" && buffer[dataStart] > 3)
          || (type === "pHYs" && buffer[dataStart + 8] > 1)) {
          assetError("malformed_content", `PNG ancillary chunk ${type} contains invalid values.`);
        }
        singletonAncillary.add(type);
      }
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawData || !sawEnd || offset !== buffer.length) assetError("malformed_content", "PNG is incomplete.");

  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bitsPerPixel = channels[colorType] * bitDepth;
  const passes = interlace === 0
    ? [{ x: 0, y: 0, dx: 1, dy: 1 }]
    : [
      { x: 0, y: 0, dx: 8, dy: 8 }, { x: 4, y: 0, dx: 8, dy: 8 },
      { x: 0, y: 4, dx: 4, dy: 8 }, { x: 2, y: 0, dx: 4, dy: 4 },
      { x: 0, y: 2, dx: 2, dy: 4 }, { x: 1, y: 0, dx: 2, dy: 2 },
      { x: 0, y: 1, dx: 1, dy: 2 },
    ];
  const layouts = passes.map((pass) => {
    const passWidth = width <= pass.x ? 0 : Math.ceil((width - pass.x) / pass.dx);
    const passHeight = height <= pass.y ? 0 : Math.ceil((height - pass.y) / pass.dy);
    return { rowBytes: Math.ceil(passWidth * bitsPerPixel / 8), rows: passWidth === 0 ? 0 : passHeight };
  });
  const decodedBytes = layouts.reduce((total, layout) => total + layout.rows * (layout.rowBytes + 1), 0);
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes <= 0 || decodedBytes > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxDecodedImageBytes) {
    assetError("dimensions_limit", `Decoded PNG scanlines may contain at most ${PROOFCANVAS_ASSET_CONTENT_LIMITS.maxDecodedImageBytes} bytes.`);
  }
  let inflated: Buffer;
  try {
    const compressed = Buffer.concat(compressedParts);
    // Node 24 supports `info`; the pinned @types/node 20 overload omits it.
    const result = inflateSync(compressed, { info: true, maxOutputLength: decodedBytes + 1 } as Parameters<typeof inflateSync>[1]) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (result.engine.bytesWritten !== compressed.length) assetError("malformed_content", "PNG image data contains a trailing compressed polyglot.");
    inflated = result.buffer;
  } catch (error) {
    if (error instanceof AssetContentError) throw error;
    assetError("malformed_content", "PNG image data is truncated, invalid, or exceeds its decoded bounds.");
  }
  if (inflated.length !== decodedBytes) assetError("malformed_content", "PNG decoded scanline length disagrees with IHDR dimensions.");
  let decodedOffset = 0;
  for (const layout of layouts) {
    for (let row = 0; row < layout.rows; row += 1) {
      if (inflated[decodedOffset] > 4) assetError("malformed_content", "PNG scanline filter is invalid.");
      decodedOffset += layout.rowBytes + 1;
    }
  }
  return { mimeType: "image/png", width, height };
}

function validateJpegQuantizationTables(buffer: Buffer, start: number, end: number): void {
  let offset = start;
  let tables = 0;
  while (offset < end) {
    const descriptor = buffer[offset];
    const precision = descriptor >>> 4;
    const tableId = descriptor & 0x0f;
    if (precision > 1 || tableId > 3) assetError("malformed_content", "JPEG quantization table descriptor is invalid.");
    const valueBytes = precision === 0 ? 1 : 2;
    const tableEnd = offset + 1 + 64 * valueBytes;
    if (tableEnd > end) assetError("malformed_content", "JPEG quantization table is truncated.");
    for (let valueOffset = offset + 1; valueOffset < tableEnd; valueOffset += valueBytes) {
      const value = valueBytes === 1 ? buffer[valueOffset] : buffer.readUInt16BE(valueOffset);
      if (value === 0) assetError("malformed_content", "JPEG quantization values must be non-zero.");
    }
    tables += 1;
    offset = tableEnd;
  }
  if (tables === 0 || offset !== end) assetError("malformed_content", "JPEG quantization table segment is empty or malformed.");
}

function validateJpegHuffmanTables(buffer: Buffer, start: number, end: number): void {
  let offset = start;
  let tables = 0;
  while (offset < end) {
    if (offset + 17 > end) assetError("malformed_content", "JPEG Huffman table header is truncated.");
    const descriptor = buffer[offset];
    const tableClass = descriptor >>> 4;
    const tableId = descriptor & 0x0f;
    if (tableClass > 1 || tableId > 3) assetError("malformed_content", "JPEG Huffman table descriptor is invalid.");
    let symbols = 0;
    let availableCodes = 1;
    for (let bitLength = 1; bitLength <= 16; bitLength += 1) {
      const count = buffer[offset + bitLength];
      symbols += count;
      availableCodes = availableCodes * 2 - count;
      if (availableCodes < 0) assetError("malformed_content", "JPEG Huffman code lengths are oversubscribed.");
    }
    if (symbols === 0 || symbols > 256 || offset + 17 + symbols > end) {
      assetError("malformed_content", "JPEG Huffman symbols are empty or truncated.");
    }
    const symbolsStart = offset + 17;
    for (let index = 0; index < symbols; index += 1) {
      const symbol = buffer[symbolsStart + index];
      if (tableClass === 0 && symbol > 15) assetError("malformed_content", "JPEG DC Huffman symbol is invalid.");
      if (tableClass === 1 && (symbol & 0x0f) === 0 && symbol !== 0x00 && symbol !== 0xf0) {
        assetError("malformed_content", "JPEG AC Huffman symbol is invalid.");
      }
      if (tableClass === 1 && (symbol & 0x0f) > 10) assetError("malformed_content", "JPEG AC coefficient magnitude is unsupported.");
    }
    tables += 1;
    offset += 17 + symbols;
  }
  if (tables === 0 || offset !== end) assetError("malformed_content", "JPEG Huffman table segment is empty or malformed.");
}

function parseJpeg(buffer: Buffer): ParsedContent {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) assetError("malformed_content", "JPEG SOI marker is invalid.");
  let offset = 2;
  let pendingMarker: number | null = null;
  let width = 0;
  let height = 0;
  let frameMarker = 0;
  let frameComponents = new Set<number>();
  let sawScan = false;
  let markerCount = 0;
  let metadataBytes = 0;
  while (offset <= buffer.length) {
    let marker: number;
    if (pendingMarker !== null) {
      marker = pendingMarker;
      pendingMarker = null;
    } else {
      if (offset >= buffer.length || buffer[offset] !== 0xff) assetError("malformed_content", "JPEG marker framing is invalid.");
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length || buffer[offset] === 0x00) assetError("malformed_content", "JPEG marker is truncated or stuffed outside scan data.");
      marker = buffer[offset];
      offset += 1;
    }
    markerCount += 1;
    if (markerCount > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxJpegMarkers) {
      assetError("malformed_content", "JPEG contains too many markers.");
    }

    if (marker === 0xd9) {
      if (frameMarker === 0 || !sawScan || offset !== buffer.length) assetError("malformed_content", "JPEG is incomplete or contains trailing data.");
      return { mimeType: "image/jpeg", width, height };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      assetError("malformed_content", "JPEG contains an unexpected standalone marker.");
    }
    if (offset + 2 > buffer.length) assetError("malformed_content", "JPEG segment length is truncated.");
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) assetError("malformed_content", "JPEG segment length exceeds the file.");
    const dataStart = offset + 2;
    const dataEnd = offset + segmentLength;

    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frameMarker !== 0 || segmentLength < 11 || buffer[dataStart] !== 8) assetError("malformed_content", "JPEG frame header is invalid or unsupported.");
      height = buffer.readUInt16BE(dataStart + 1);
      width = buffer.readUInt16BE(dataStart + 3);
      const components = buffer[dataStart + 5];
      if (components < 1 || components > 4 || segmentLength !== 8 + 3 * components) assetError("malformed_content", "JPEG frame component table is invalid.");
      const componentIds = new Set<number>();
      let samplingBlocks = 0;
      for (let index = 0; index < components; index += 1) {
        const componentOffset = dataStart + 6 + 3 * index;
        const componentId = buffer[componentOffset];
        const horizontalSampling = buffer[componentOffset + 1] >>> 4;
        const verticalSampling = buffer[componentOffset + 1] & 0x0f;
        const quantizationTable = buffer[componentOffset + 2];
        if (componentIds.has(componentId) || horizontalSampling < 1 || horizontalSampling > 4
          || verticalSampling < 1 || verticalSampling > 4 || quantizationTable > 3) {
          assetError("malformed_content", "JPEG frame component descriptor is invalid.");
        }
        componentIds.add(componentId);
        samplingBlocks += horizontalSampling * verticalSampling;
      }
      if (samplingBlocks > 10) assetError("malformed_content", "JPEG frame sampling factors exceed the supported MCU bound.");
      ensureDimensions(width, height);
      frameMarker = marker;
      frameComponents = componentIds;
    } else if ([0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf].includes(marker)) {
      assetError("malformed_content", "JPEG coding mode is not in the supported Huffman baseline/progressive subset.");
    } else if (marker === 0xda) {
      if (frameMarker === 0 || segmentLength < 8) assetError("malformed_content", "JPEG scan appears before a valid frame.");
      const components = buffer[dataStart];
      if (components < 1 || components > frameComponents.size || segmentLength !== 6 + 2 * components) {
        assetError("malformed_content", "JPEG scan component table is invalid.");
      }
      const scanComponents = new Set<number>();
      for (let index = 0; index < components; index += 1) {
        const componentId = buffer[dataStart + 1 + 2 * index];
        const huffmanSelectors = buffer[dataStart + 2 + 2 * index];
        if (!frameComponents.has(componentId) || scanComponents.has(componentId)
          || (huffmanSelectors >>> 4) > 3 || (huffmanSelectors & 0x0f) > 3) {
          assetError("malformed_content", "JPEG scan component descriptor is invalid.");
        }
        scanComponents.add(componentId);
      }
      const spectralStart = buffer[dataEnd - 3];
      const spectralEnd = buffer[dataEnd - 2];
      const successive = buffer[dataEnd - 1];
      const successiveHigh = successive >>> 4;
      const successiveLow = successive & 0x0f;
      if (frameMarker === 0xc2) {
        if (spectralStart > spectralEnd || spectralEnd > 63
          || (spectralStart === 0 && spectralEnd !== 0)
          || (spectralStart > 0 && components !== 1)
          || successiveHigh > 13 || successiveLow > 13
          || (successiveHigh !== 0 && successiveHigh !== successiveLow + 1)) {
          assetError("malformed_content", "JPEG progressive scan parameters are invalid.");
        }
      } else if (spectralStart !== 0 || spectralEnd !== 63 || successive !== 0) {
        assetError("malformed_content", "JPEG sequential scan parameters are invalid.");
      }
      sawScan = true;
      offset = dataEnd;
      let entropyBytes = 0;
      let foundMarker = false;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) {
          entropyBytes += 1;
          offset += 1;
          continue;
        }
        while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
        if (offset >= buffer.length) assetError("malformed_content", "JPEG entropy data is truncated.");
        const candidate = buffer[offset];
        offset += 1;
        if (candidate === 0x00) {
          entropyBytes += 1;
          continue;
        }
        if (candidate >= 0xd0 && candidate <= 0xd7) continue;
        pendingMarker = candidate;
        foundMarker = true;
        break;
      }
      if (!foundMarker || entropyBytes === 0) assetError("malformed_content", "JPEG scan has no complete entropy payload or terminating marker.");
      continue;
    } else {
      const allowed = marker === 0xc4 || marker === 0xdb || marker === 0xdd || marker === 0xfe || (marker >= 0xe0 && marker <= 0xef);
      if (!allowed) assetError("malformed_content", `JPEG marker 0x${marker.toString(16)} is unsupported.`);
      if (marker === 0xc4) validateJpegHuffmanTables(buffer, dataStart, dataEnd);
      if (marker === 0xdb) validateJpegQuantizationTables(buffer, dataStart, dataEnd);
      if (marker === 0xdd && segmentLength !== 4) assetError("malformed_content", "JPEG restart interval is malformed.");
      if (marker === 0xfe || (marker >= 0xe0 && marker <= 0xef)) {
        metadataBytes += segmentLength - 2;
        if (metadataBytes > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxJpegMetadataBytes) {
          assetError("malformed_content", "JPEG metadata exceeds the supported bound.");
        }
      }
    }
    offset = dataEnd;
  }
  assetError("malformed_content", "JPEG has no EOI marker.");
}

type ParsedWebpDimensions = { width: number; height: number };

function parseWebpDimensions(type: string, buffer: Buffer, start: number, length: number): ParsedWebpDimensions {
  if (type === "VP8 ") {
    if (length < 11 || buffer[start + 3] !== 0x9d || buffer[start + 4] !== 0x01 || buffer[start + 5] !== 0x2a) {
      assetError("malformed_content", "WebP VP8 key-frame header is truncated or invalid.");
    }
    const frameTag = buffer[start] | (buffer[start + 1] << 8) | (buffer[start + 2] << 16);
    const firstPartitionBytes = frameTag >>> 5;
    const version = (frameTag >>> 1) & 0x07;
    if ((frameTag & 1) !== 0 || version > 3 || (frameTag & 0x10) === 0
      || firstPartitionBytes === 0 || 10 + firstPartitionBytes > length) {
      assetError("malformed_content", "WebP VP8 frame partition is invalid.");
    }
    return { width: buffer.readUInt16LE(start + 6) & 0x3fff, height: buffer.readUInt16LE(start + 8) & 0x3fff };
  }
  if (type === "VP8L") {
    if (length < 6 || buffer[start] !== 0x2f) assetError("malformed_content", "WebP lossless header is truncated or invalid.");
    const bits = buffer.readUInt32LE(start + 1);
    if ((bits >>> 29) !== 0) assetError("malformed_content", "WebP lossless version bits are unsupported.");
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >>> 14) & 0x3fff),
    };
  }
  assetError("malformed_content", "WebP image chunk is unsupported.");
}

function parseWebp(buffer: Buffer): ParsedContent {
  if (buffer.length < 20 || ascii(buffer, 0, 4) !== "RIFF" || ascii(buffer, 8, 4) !== "WEBP") {
    assetError("malformed_content", "WebP RIFF signature is invalid.");
  }
  if (buffer.readUInt32LE(4) !== buffer.length - 8) assetError("malformed_content", "WebP RIFF length does not match the file.");
  let offset = 12;
  let width = 0;
  let height = 0;
  let imageChunks = 0;
  let sawExtended = false;
  let extendedDimensions: { width: number; height: number } | null = null;
  let extendedFlags = 0;
  let chunkIndex = 0;
  let metadataBytes = 0;
  let sawIcc = false;
  let sawAlpha = false;
  let sawExif = false;
  let sawXmp = false;
  let imageType = "";
  let alphaCompression = -1;
  let alphaPayloadBytes = 0;
  const allowedChunks = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ICCP", "EXIF", "XMP "]);
  while (offset < buffer.length) {
    chunkIndex += 1;
    if (chunkIndex > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxWebpChunks) assetError("malformed_content", "WebP contains too many chunks.");
    if (offset + 8 > buffer.length) assetError("malformed_content", "WebP chunk header is truncated.");
    const type = ascii(buffer, offset, 4);
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length & 1);
    if (!allowedChunks.has(type) || dataEnd < dataStart || paddedEnd > buffer.length) assetError("malformed_content", "WebP contains an unsupported or truncated chunk.");
    if ((length & 1) !== 0 && buffer[dataEnd] !== 0) assetError("malformed_content", "WebP chunk padding is non-zero.");
    if (type === "VP8X") {
      if (sawExtended || chunkIndex !== 1 || length !== 10) assetError("malformed_content", "WebP extended header is duplicated, misplaced, or malformed.");
      const flags = buffer[dataStart];
      if ((flags & 0xc3) !== 0 || buffer[dataStart + 1] !== 0 || buffer[dataStart + 2] !== 0 || buffer[dataStart + 3] !== 0) {
        assetError("malformed_content", "Animated or reserved WebP extensions are not supported.");
      }
      extendedDimensions = {
        width: 1 + buffer.readUIntLE(dataStart + 4, 3),
        height: 1 + buffer.readUIntLE(dataStart + 7, 3),
      };
      ensureDimensions(extendedDimensions.width, extendedDimensions.height);
      extendedFlags = flags;
      sawExtended = true;
    } else if (type === "VP8 " || type === "VP8L") {
      imageChunks += 1;
      if (imageChunks > 1) assetError("malformed_content", "WebP must contain exactly one image bitstream.");
      if (!sawExtended && chunkIndex !== 1) assetError("malformed_content", "Simple WebP must contain only its image bitstream.");
      if (type === "VP8L" && sawAlpha) assetError("malformed_content", "WebP lossless images cannot use a separate alpha chunk.");
      ({ width, height } = parseWebpDimensions(type, buffer, dataStart, length));
      imageType = type;
      ensureDimensions(width, height);
    } else if (type === "ICCP") {
      if (!sawExtended || sawIcc || sawAlpha || imageChunks !== 0 || length === 0) {
        assetError("malformed_content", "WebP ICC profile is duplicated, misplaced, or empty.");
      }
      sawIcc = true;
      metadataBytes += length;
    } else if (type === "ALPH") {
      if (!sawExtended || sawAlpha || imageChunks !== 0 || length < 2) {
        assetError("malformed_content", "WebP alpha chunk is duplicated, misplaced, or truncated.");
      }
      const alphaHeader = buffer[dataStart];
      const preprocessing = (alphaHeader >>> 4) & 0x03;
      alphaCompression = alphaHeader & 0x03;
      if ((alphaHeader & 0xc0) !== 0 || preprocessing > 1 || alphaCompression > 1) {
        assetError("malformed_content", "WebP alpha chunk uses reserved compression or preprocessing bits.");
      }
      alphaPayloadBytes = length - 1;
      sawAlpha = true;
    } else if (type === "EXIF") {
      if (!sawExtended || imageChunks !== 1 || sawExif || sawXmp || length === 0) {
        assetError("malformed_content", "WebP EXIF metadata is duplicated, misplaced, or empty.");
      }
      sawExif = true;
      metadataBytes += length;
    } else if (type === "XMP ") {
      if (!sawExtended || imageChunks !== 1 || sawXmp || length === 0) {
        assetError("malformed_content", "WebP XMP metadata is duplicated, misplaced, or empty.");
      }
      sawXmp = true;
      metadataBytes += length;
    }
    if (metadataBytes > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxWebpMetadataBytes) {
      assetError("malformed_content", "WebP metadata exceeds the supported bound.");
    }
    offset = paddedEnd;
  }
  if (offset !== buffer.length || imageChunks !== 1) assetError("malformed_content", "WebP image bitstream is missing or incomplete.");
  if (sawExtended && (extendedDimensions?.width !== width || extendedDimensions.height !== height)) {
    assetError("malformed_content", "WebP canvas and bitstream dimensions disagree.");
  }
  if (!sawExtended && chunkIndex !== 1) assetError("malformed_content", "Simple WebP contains extension chunks without VP8X.");
  if (sawExtended) {
    const flagIcc = (extendedFlags & 0x20) !== 0;
    const flagAlpha = (extendedFlags & 0x10) !== 0;
    const flagExif = (extendedFlags & 0x08) !== 0;
    const flagXmp = (extendedFlags & 0x04) !== 0;
    // VP8L's alpha-is-used bit is only a hint; the decoder below is the
    // authority for matching an extended VP8X alpha flag to actual pixels.
    const alphaChunksMatch = imageType === "VP8L" || flagAlpha === sawAlpha;
    if (flagIcc !== sawIcc || !alphaChunksMatch || flagExif !== sawExif || flagXmp !== sawXmp) {
      assetError("malformed_content", "WebP extension flags do not match the chunks or image bitstream.");
    }
    if (sawAlpha && alphaCompression === 0 && alphaPayloadBytes !== width * height) {
      assetError("malformed_content", "Uncompressed WebP alpha bytes disagree with the image dimensions.");
    }
  }
  return {
    mimeType: "image/webp",
    width,
    height,
    ...(sawExtended ? { hasAlpha: (extendedFlags & 0x10) !== 0 } : {}),
  };
}

const SVG_ALLOWED_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  svg: new Set(["xmlns", "width", "height", "viewBox", "preserveAspectRatio", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule"]),
  g: new Set(["transform", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule"]),
  path: new Set(["d", "transform", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule"]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry", "transform", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity"]),
  circle: new Set(["cx", "cy", "r", "transform", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity"]),
  ellipse: new Set(["cx", "cy", "rx", "ry", "transform", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity"]),
  line: new Set(["x1", "y1", "x2", "y2", "transform", "fill", "stroke", "stroke-width", "opacity", "stroke-opacity", "stroke-linecap"]),
  polyline: new Set(["points", "transform", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "fill-rule"]),
  polygon: new Set(["points", "transform", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "fill-rule"]),
};

const SVG_NUMERIC_ATTRIBUTES = new Set(["x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "stroke-width"]);
const SVG_OPACITY_ATTRIBUTES = new Set(["opacity", "fill-opacity", "stroke-opacity"]);
const SVG_COLOR_ATTRIBUTES = new Set(["fill", "stroke"]);
const SVG_SAFE_COLORS = new Set(["none", "transparent", "currentColor", "black", "white", "red", "green", "blue", "gray", "grey"]);
const SVG_NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const SVG_NUMBER_RE = new RegExp(`^${SVG_NUMBER}$`);

function finiteSvgNumbers(value: string): number[] {
  const tokens = value.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.some((token) => !SVG_NUMBER_RE.test(token))) assetError("unsafe_svg", "SVG contains an invalid numeric list.");
  const values = tokens.map(Number);
  if (values.some((number) => !Number.isFinite(number) || Math.abs(number) > 10_000_000)) assetError("unsafe_svg", "SVG numeric values exceed the safe range.");
  return values;
}

function validateSvgTransform(value: string): void {
  const operation = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*/gy;
  let offset = 0;
  let count = 0;
  while (offset < value.length) {
    operation.lastIndex = offset;
    const match = operation.exec(value);
    if (!match || match.index !== offset) assetError("unsafe_svg", "SVG transform is outside the safe transform subset.");
    const args = finiteSvgNumbers(match[2]);
    const expected: Record<string, readonly number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
    if (!expected[match[1]].includes(args.length)) assetError("unsafe_svg", "SVG transform has an invalid argument count.");
    offset = operation.lastIndex;
    count += 1;
    if (count > 32) assetError("unsafe_svg", "SVG contains too many transform operations.");
  }
  if (count === 0) assetError("unsafe_svg", "SVG transform is empty.");
}

function validateSvgAttribute(name: string, value: string): void {
  if (value.length > 8_192 || /[<>&`\u0000-\u001f\u007f]/u.test(value)) assetError("unsafe_svg", "SVG attribute value is unsafe or too long.");
  if (SVG_NUMERIC_ATTRIBUTES.has(name)) {
    const numbers = finiteSvgNumbers(value.replace(/px$/i, ""));
    if (numbers.length !== 1) assetError("unsafe_svg", "SVG numeric attribute must contain one value.");
  } else if (SVG_OPACITY_ATTRIBUTES.has(name)) {
    const numbers = finiteSvgNumbers(value);
    if (numbers.length !== 1 || numbers[0] < 0 || numbers[0] > 1) assetError("unsafe_svg", "SVG opacity is outside 0–1.");
  } else if (SVG_COLOR_ATTRIBUTES.has(name)) {
    if (!SVG_SAFE_COLORS.has(value) && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) assetError("unsafe_svg", "SVG color is outside the safe literal subset.");
  } else if (name === "d") {
    if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(value) || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(value)) assetError("unsafe_svg", "SVG path data is outside the safe path subset.");
    const numbers = value.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
    if (numbers.some((number) => !Number.isFinite(number) || Math.abs(number) > 10_000_000)) assetError("unsafe_svg", "SVG path coordinates exceed the safe range.");
  } else if (name === "points") {
    const numbers = finiteSvgNumbers(value);
    if (numbers.length < 4 || numbers.length % 2 !== 0) assetError("unsafe_svg", "SVG points must contain coordinate pairs.");
  } else if (name === "transform") {
    validateSvgTransform(value);
  } else if (name === "viewBox") {
    const numbers = finiteSvgNumbers(value);
    if (numbers.length !== 4 || numbers[2] <= 0 || numbers[3] <= 0) assetError("unsafe_svg", "SVG viewBox is invalid.");
  } else if (name === "xmlns") {
    if (value !== "http://www.w3.org/2000/svg") assetError("unsafe_svg", "SVG namespace is invalid.");
  } else if (name === "preserveAspectRatio") {
    if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/.test(value)) assetError("unsafe_svg", "SVG aspect-ratio policy is invalid.");
  } else if (name === "stroke-linecap") {
    if (!/^(?:butt|round|square)$/.test(value)) assetError("unsafe_svg", "SVG line cap is invalid.");
  } else if (name === "stroke-linejoin") {
    if (!/^(?:miter|round|bevel)$/.test(value)) assetError("unsafe_svg", "SVG line join is invalid.");
  } else if (name === "fill-rule" || name === "clip-rule") {
    if (!/^(?:nonzero|evenodd)$/.test(value)) assetError("unsafe_svg", "SVG fill rule is invalid.");
  }
}

function parseSvg(buffer: Buffer): ParsedContent {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    assetError("unsafe_svg", "SVG must be valid UTF-8.");
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  if (/[^\u0009\u000a\u000d\u0020-\uffff]/u.test(source)) assetError("unsafe_svg", "SVG contains forbidden control characters.");
  if (source.includes("<!") || source.includes("<?") || source.includes("&")) assetError("unsafe_svg", "SVG declarations, entities, and processing instructions are forbidden.");

  const stack: string[] = [];
  let cursor = 0;
  let elements = 0;
  let drawables = 0;
  let rootAttributes: Map<string, string> | null = null;
  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) {
      if (source.slice(cursor).trim()) assetError("unsafe_svg", "SVG text nodes are outside the safe subset.");
      break;
    }
    if (source.slice(cursor, open).trim()) assetError("unsafe_svg", "SVG text nodes are outside the safe subset.");
    let close = open + 1;
    let quote = "";
    for (; close < source.length; close += 1) {
      const character = source[close];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (close >= source.length || quote) assetError("unsafe_svg", "SVG tag is truncated.");
    let token = source.slice(open + 1, close).trim();
    cursor = close + 1;
    if (!token) assetError("unsafe_svg", "SVG contains an empty tag.");

    if (token.startsWith("/")) {
      const closingName = token.slice(1).trim();
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(closingName) || stack.pop() !== closingName) assetError("unsafe_svg", "SVG tags are not properly nested.");
      continue;
    }
    const selfClosing = token.endsWith("/");
    if (selfClosing) token = token.slice(0, -1).trimEnd();
    const nameMatch = /^([A-Za-z][A-Za-z0-9-]*)/.exec(token);
    if (!nameMatch) assetError("unsafe_svg", "SVG element name is invalid.");
    const name = nameMatch[1];
    const allowed = SVG_ALLOWED_ATTRIBUTES[name];
    if (!allowed) assetError("unsafe_svg", `SVG element <${name}> is outside the safe subset.`);
    if (elements === 0 && name !== "svg") assetError("unsafe_svg", "SVG root element must be <svg>.");
    if (elements > 0 && stack.length === 0) assetError("unsafe_svg", "SVG must contain exactly one root element.");
    elements += 1;
    if (elements > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxSvgElements) assetError("unsafe_svg", "SVG contains too many elements.");
    if (name !== "svg" && name !== "g") drawables += 1;

    const attributes = new Map<string, string>();
    let rest = token.slice(name.length);
    while (rest.trim().length > 0) {
      const match = /^\s+([A-Za-z][A-Za-z0-9-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(rest);
      if (!match) assetError("unsafe_svg", "SVG attributes must be unique, quoted safe-subset attributes.");
      const attributeName = match[1];
      const value = match[3] ?? match[4] ?? "";
      if (!allowed.has(attributeName) || attributeName.includes(":") || /^on/i.test(attributeName) || attributes.has(attributeName)) {
        assetError("unsafe_svg", `SVG attribute ${attributeName} is forbidden, misplaced, or duplicated.`);
      }
      validateSvgAttribute(attributeName, value);
      attributes.set(attributeName, value);
      rest = rest.slice(match[0].length);
    }
    if (name === "svg") {
      if (rootAttributes !== null || stack.length !== 0 || !attributes.has("xmlns")) assetError("unsafe_svg", "SVG root or namespace is invalid.");
      rootAttributes = attributes;
    }
    if (!selfClosing) {
      stack.push(name);
      if (stack.length > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxSvgDepth) assetError("unsafe_svg", "SVG nesting is too deep.");
    }
  }
  if (stack.length !== 0 || rootAttributes === null || drawables === 0) assetError("unsafe_svg", "SVG is empty or has unclosed tags.");

  const rawWidth = rootAttributes.get("width")?.replace(/px$/i, "");
  const rawHeight = rootAttributes.get("height")?.replace(/px$/i, "");
  if ((rawWidth === undefined) !== (rawHeight === undefined)) assetError("unsafe_svg", "SVG width and height must be supplied together.");
  let width: number;
  let height: number;
  if (rawWidth !== undefined && rawHeight !== undefined) {
    width = Number(rawWidth);
    height = Number(rawHeight);
  } else {
    const viewBox = rootAttributes.get("viewBox");
    if (!viewBox) assetError("unsafe_svg", "SVG needs integer width/height or an integer-sized viewBox.");
    const values = finiteSvgNumbers(viewBox);
    width = values[2];
    height = values[3];
  }
  ensureDimensions(width, height);
  return { mimeType: "image/svg+xml", width, height };
}

function parseWav(buffer: Buffer): ParsedContent {
  if (buffer.length < 44 || ascii(buffer, 0, 4) !== "RIFF" || ascii(buffer, 8, 4) !== "WAVE") assetError("malformed_content", "WAV RIFF signature is invalid.");
  if (buffer.readUInt32LE(4) !== buffer.length - 8) assetError("malformed_content", "WAV RIFF length does not match the file.");
  let offset = 12;
  let format: { byteRate: number; blockAlign: number } | null = null;
  let dataBytes: number | null = null;
  let chunkCount = 0;
  let ancillaryBytes = 0;
  const allowedAncillary = new Set(["LIST", "JUNK", "PAD ", "fact", "bext"]);
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) assetError("malformed_content", "WAV chunk header is truncated.");
    chunkCount += 1;
    if (chunkCount > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxRiffChunks) assetError("malformed_content", "WAV contains too many chunks.");
    const type = ascii(buffer, offset, 4);
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length & 1);
    if (dataEnd < dataStart || paddedEnd > buffer.length) assetError("malformed_content", "WAV chunk exceeds the file.");
    if ((length & 1) !== 0 && buffer[dataEnd] !== 0) assetError("malformed_content", "WAV chunk padding is non-zero.");
    if (type === "fmt ") {
      if (format !== null || length !== 16) assetError("malformed_content", "WAV must contain one canonical 16-byte fmt chunk.");
      const audioFormat = buffer.readUInt16LE(dataStart);
      const channels = buffer.readUInt16LE(dataStart + 2);
      const sampleRate = buffer.readUInt32LE(dataStart + 4);
      const byteRate = buffer.readUInt32LE(dataStart + 8);
      const blockAlign = buffer.readUInt16LE(dataStart + 12);
      const bitsPerSample = buffer.readUInt16LE(dataStart + 14);
      const validBits = audioFormat === 1 ? [8, 16, 24, 32] : audioFormat === 3 ? [32, 64] : [];
      const expectedBlockAlign = channels * bitsPerSample / 8;
      if (!validBits.includes(bitsPerSample) || channels < 1 || channels > 8 || sampleRate < 8_000 || sampleRate > 192_000
        || !Number.isSafeInteger(expectedBlockAlign) || blockAlign !== expectedBlockAlign || byteRate !== sampleRate * blockAlign) {
        assetError("malformed_content", "WAV format is unsupported or internally inconsistent.");
      }
      format = { byteRate, blockAlign };
    } else if (type === "data") {
      if (dataBytes !== null || length === 0) assetError("malformed_content", "WAV must contain one non-empty data chunk.");
      dataBytes = length;
    } else if (!allowedAncillary.has(type)) {
      assetError("malformed_content", `WAV chunk ${type} is outside the supported subset.`);
    } else {
      ancillaryBytes += length;
      if (ancillaryBytes > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxWavAncillaryBytes) {
        assetError("malformed_content", "WAV ancillary metadata exceeds its byte budget.");
      }
    }
    offset = paddedEnd;
  }
  if (offset !== buffer.length || format === null || dataBytes === null || dataBytes % format.blockAlign !== 0) assetError("malformed_content", "WAV is incomplete or sample data is misaligned.");
  const duration = dataBytes / format.byteRate;
  if (!Number.isFinite(duration) || duration <= 0 || duration > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAudioDurationSeconds) {
    assetError("duration_limit", `Audio duration may not exceed ${PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAudioDurationSeconds} seconds.`);
  }
  return { mimeType: "audio/wav", duration };
}

const MP3_BITRATES: Record<string, readonly number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function synchsafe(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length || [0, 1, 2, 3].some((index) => (buffer[offset + index] & 0x80) !== 0)) assetError("malformed_content", "ID3 synchsafe length is invalid.");
  return (buffer[offset] << 21) | (buffer[offset + 1] << 14) | (buffer[offset + 2] << 7) | buffer[offset + 3];
}

function skipId3v2(buffer: Buffer): number {
  if (ascii(buffer, 0, 3) !== "ID3") return 0;
  if (buffer.length < 10 || ![3, 4].includes(buffer[3]) || buffer[4] === 0xff || buffer[5] !== 0) {
    assetError("malformed_content", "Only simple ID3v2.3/v2.4 metadata is supported.");
  }
  const tagBytes = synchsafe(buffer, 6);
  if (tagBytes > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxMp3Id3Bytes || 10 + tagBytes > buffer.length) assetError("malformed_content", "ID3 metadata is oversized or truncated.");
  let offset = 10;
  const end = 10 + tagBytes;
  let frameCount = 0;
  while (offset < end) {
    if (buffer[offset] === 0) {
      if (buffer.subarray(offset, end).some((byte) => byte !== 0)) assetError("malformed_content", "ID3 padding is malformed.");
      return end;
    }
    if (offset + 10 > end) assetError("malformed_content", "ID3 frame header is truncated.");
    frameCount += 1;
    if (frameCount > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxMp3Id3Frames) assetError("malformed_content", "ID3 metadata contains too many frames.");
    const id = ascii(buffer, offset, 4);
    if (!/^(?:T[A-Z0-9]{3}|COMM)$/.test(id)) assetError("malformed_content", `ID3 frame ${id} is outside the safe metadata subset.`);
    const length = buffer[3] === 4 ? synchsafe(buffer, offset + 4) : buffer.readUInt32BE(offset + 4);
    if (length <= 0 || buffer[offset + 8] !== 0 || buffer[offset + 9] !== 0 || offset + 10 + length > end) {
      assetError("malformed_content", "ID3 frame is empty, flagged, or truncated.");
    }
    offset += 10 + length;
  }
  return end;
}

function parseMp3(buffer: Buffer): ParsedContent {
  let offset = skipId3v2(buffer);
  const frameEnd = buffer.length >= offset + 128 && ascii(buffer, buffer.length - 128, 3) === "TAG" ? buffer.length - 128 : buffer.length;
  let frames = 0;
  let totalSamples = 0;
  let streamSampleRate = 0;
  let streamKey = "";
  while (offset < frameEnd) {
    if (offset + 4 > frameEnd) assetError("malformed_content", "MP3 frame header is truncated.");
    const header = buffer.readUInt32BE(offset);
    if ((header >>> 21) !== 0x7ff) assetError("malformed_content", "MP3 frame sync is invalid.");
    const versionBits = (header >>> 19) & 0x3;
    const layerBits = (header >>> 17) & 0x3;
    const bitrateIndex = (header >>> 12) & 0xf;
    const sampleRateIndex = (header >>> 10) & 0x3;
    const padding = (header >>> 9) & 1;
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3 || (header & 0x3) === 2) {
      assetError("malformed_content", "MP3 frame header contains reserved values.");
    }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    const rateBase = [44_100, 48_000, 32_000][sampleRateIndex];
    const sampleRate = version === 1 ? rateBase : version === 2 ? rateBase / 2 : rateBase / 4;
    const tableVersion = version === 1 ? 1 : 2;
    const bitrate = MP3_BITRATES[`${tableVersion}-${layer}`][bitrateIndex] * 1_000;
    const frameLength = layer === 1
      ? Math.floor(12 * bitrate / sampleRate + padding) * 4
      : Math.floor((layer === 3 && version !== 1 ? 72 : 144) * bitrate / sampleRate + padding);
    if (frameLength < 24 || offset + frameLength > frameEnd) assetError("malformed_content", "MP3 frame length exceeds the stream.");
    const nextKey = `${version}-${layer}-${sampleRate}`;
    if (streamKey && nextKey !== streamKey) assetError("malformed_content", "MP3 stream parameters change between frames.");
    streamKey = nextKey;
    frames += 1;
    if (frames > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxMp3AudioFrames) assetError("malformed_content", "MP3 contains too many audio frames.");
    const samplesPerFrame = layer === 1 ? 384 : layer === 2 || version === 1 ? 1_152 : 576;
    totalSamples += samplesPerFrame;
    streamSampleRate = sampleRate;
    const duration = totalSamples / streamSampleRate;
    if (!Number.isFinite(duration) || duration > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAudioDurationSeconds) {
      assetError("duration_limit", `Audio duration may not exceed ${PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAudioDurationSeconds} seconds.`);
    }
    offset += frameLength;
  }
  if (offset !== frameEnd || frames < 2) assetError("malformed_content", "MP3 must contain at least two complete consecutive frames.");
  const duration = totalSamples / streamSampleRate;
  if (!Number.isFinite(duration) || duration <= 0) assetError("malformed_content", "MP3 duration could not be derived from its frames.");
  return { mimeType: "audio/mpeg", duration };
}

type IsoBox = { type: string; dataStart: number; end: number };

function readIsoBoxes(buffer: Buffer, start: number, end: number, state: { count: number }, depth: number): IsoBox[] {
  if (depth > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxMp4Depth) assetError("malformed_content", "MP4 box nesting is too deep.");
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) assetError("malformed_content", "MP4 box header is truncated.");
    let size = buffer.readUInt32BE(offset);
    const type = ascii(buffer, offset + 4, 4);
    let headerBytes = 8;
    if (!/^[A-Za-z0-9 ]{4}$/.test(type)) assetError("malformed_content", "MP4 box type is invalid.");
    if (size === 0) assetError("malformed_content", "Open-ended MP4 boxes are not accepted.");
    if (size === 1) {
      if (offset + 16 > end) assetError("malformed_content", "Extended MP4 box header is truncated.");
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) assetError("malformed_content", "MP4 box length exceeds the safe integer range.");
      size = Number(extended);
      headerBytes = 16;
    }
    if (size < headerBytes || offset + size > end) assetError("malformed_content", "MP4 box length exceeds its container.");
    state.count += 1;
    if (state.count > PROOFCANVAS_ASSET_CONTENT_LIMITS.maxMp4Boxes) assetError("malformed_content", "MP4 contains too many boxes.");
    boxes.push({ type, dataStart: offset + headerBytes, end: offset + size });
    offset += size;
  }
  if (offset !== end) assetError("malformed_content", "MP4 boxes do not exactly fill their container.");
  return boxes;
}

function onlyBox(boxes: readonly IsoBox[], type: string, required = true): IsoBox | null {
  const matches = boxes.filter((box) => box.type === type);
  if (matches.length > 1 || (required && matches.length !== 1)) assetError("malformed_content", `MP4 requires exactly one ${type} box in this container.`);
  return matches[0] ?? null;
}

function validateMp4AudioTrack(buffer: Buffer, trak: IsoBox, state: { count: number }): void {
  const trakBoxes = readIsoBoxes(buffer, trak.dataStart, trak.end, state, 1);
  const mdia = onlyBox(trakBoxes, "mdia")!;
  const mdiaBoxes = readIsoBoxes(buffer, mdia.dataStart, mdia.end, state, 2);
  const hdlr = onlyBox(mdiaBoxes, "hdlr")!;
  if (hdlr.end - hdlr.dataStart < 12 || buffer[hdlr.dataStart] !== 0 || buffer.readUIntBE(hdlr.dataStart + 1, 3) !== 0) {
    assetError("malformed_content", "MP4 media handler is malformed.");
  }
  if (ascii(buffer, hdlr.dataStart + 8, 4) !== "soun") assetError("malformed_content", "MP4 contains a non-audio media track.");
  const minf = onlyBox(mdiaBoxes, "minf")!;
  const minfBoxes = readIsoBoxes(buffer, minf.dataStart, minf.end, state, 3);
  const stbl = onlyBox(minfBoxes, "stbl")!;
  const stblBoxes = readIsoBoxes(buffer, stbl.dataStart, stbl.end, state, 4);
  const stsd = onlyBox(stblBoxes, "stsd")!;
  if (stsd.end - stsd.dataStart < 8 || buffer[stsd.dataStart] !== 0 || buffer.readUIntBE(stsd.dataStart + 1, 3) !== 0) {
    assetError("malformed_content", "MP4 sample-description header is malformed.");
  }
  const entryCount = buffer.readUInt32BE(stsd.dataStart + 4);
  const entries = readIsoBoxes(buffer, stsd.dataStart + 8, stsd.end, state, 5);
  if (entryCount < 1 || entryCount !== entries.length) assetError("malformed_content", "MP4 sample-description count is invalid.");
  for (const entry of entries) {
    if (entry.type !== "mp4a" && entry.type !== "alac") assetError("malformed_content", `MP4 audio codec ${entry.type} is outside the supported M4A subset.`);
    if (entry.end - entry.dataStart < 28) assetError("malformed_content", "MP4 audio sample entry is truncated.");
    const version = buffer.readUInt16BE(entry.dataStart + 8);
    const channels = buffer.readUInt16BE(entry.dataStart + 16);
    const sampleSize = buffer.readUInt16BE(entry.dataStart + 18);
    const sampleRate = buffer.readUInt32BE(entry.dataStart + 24) / 65_536;
    if (version !== 0 || channels < 1 || channels > 8 || sampleSize < 8 || sampleSize > 32
      || !Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
      assetError("malformed_content", "MP4 audio sample entry parameters are unsupported.");
    }
  }
}

function parseMp4Audio(buffer: Buffer): ParsedContent {
  const state = { count: 0 };
  const boxes = readIsoBoxes(buffer, 0, buffer.length, state, 0);
  if (boxes[0]?.type !== "ftyp") assetError("malformed_content", "MP4 ftyp must be the first box.");
  const ftyp = onlyBox(boxes, "ftyp")!;
  if (ftyp.end - ftyp.dataStart < 8 || (ftyp.end - ftyp.dataStart) % 4 !== 0) assetError("malformed_content", "MP4 compatible-brand table is malformed.");
  const brands: string[] = [];
  brands.push(ascii(buffer, ftyp.dataStart, 4));
  for (let offset = ftyp.dataStart + 8; offset < ftyp.end; offset += 4) brands.push(ascii(buffer, offset, 4));
  if (!brands.some((brand) => ["M4A ", "M4B ", "isom", "mp41", "mp42"].includes(brand))) {
    assetError("malformed_content", "MP4 brands do not identify a supported audio container.");
  }
  const allowedTopLevel = new Set(["ftyp", "free", "skip", "wide", "mdat", "moov"]);
  if (boxes.some((box) => !allowedTopLevel.has(box.type))) assetError("malformed_content", "Fragmented or unknown MP4 top-level boxes are not supported.");
  const moov = onlyBox(boxes, "moov")!;
  const mediaData = boxes.filter((box) => box.type === "mdat");
  if (mediaData.length < 1 || mediaData.some((box) => box.end <= box.dataStart)) assetError("malformed_content", "MP4 media data is missing or empty.");
  const moovBoxes = readIsoBoxes(buffer, moov.dataStart, moov.end, state, 1);
  const tracks = moovBoxes.filter((box) => box.type === "trak");
  if (tracks.length < 1 || tracks.length > 16) assetError("malformed_content", "MP4 must contain between one and sixteen audio tracks.");
  for (const track of tracks) validateMp4AudioTrack(buffer, track, state);
  return { mimeType: "audio/mp4" };
}

function looksLikeSvg(buffer: Buffer): boolean {
  const prefix = buffer.subarray(0, Math.min(buffer.length, 256)).toString("utf8").replace(/^\ufeff/, "").trimStart();
  return prefix.startsWith("<");
}

type SniffedContent = ProofCanvasAssetMimeType | "unknown";

function sniffContent(buffer: Buffer): SniffedContent {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WEBP") return "image/webp";
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WAVE") return "audio/wav";
  if (buffer.length >= 8 && ascii(buffer, 4, 4) === "ftyp") return "audio/mp4";
  if ((buffer.length >= 3 && ascii(buffer, 0, 3) === "ID3")
    || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (looksLikeSvg(buffer)) return "image/svg+xml";
  return "unknown";
}

const IMAGE_DECODER_WORKER_SOURCE = String.raw`
  const { parentPort } = require("node:worker_threads");
  let sharp = null;
  try {
    sharp = require("sharp");
    sharp.cache(false);
    sharp.concurrency(1);
  } catch {}

  parentPort.on("message", async (message) => {
    const control = new Int32Array(message.control);
    const result = new Int32Array(message.result);
    let status = sharp ? -1 : -2;
    try {
      if (!sharp) throw new Error("decoder unavailable");
      const bytes = Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength);
      const pipeline = sharp(bytes, {
        animated: false,
        failOn: "warning",
        limitInputPixels: message.maxPixels,
        sequentialRead: true,
      });
      const metadata = await pipeline.metadata();
      if (metadata.format !== message.expectedFormat
        || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)
        || metadata.width <= 0 || metadata.height <= 0
        || metadata.width > message.maxDimension || metadata.height > message.maxDimension
        || metadata.width > Math.floor(message.maxPixels / metadata.height)
        || (metadata.pages ?? 1) !== 1
        || (metadata.orientation !== undefined && metadata.orientation !== 1)) {
        throw new Error("decoded metadata is outside policy");
      }
      const decoded = await pipeline.clone().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const expectedBytes = metadata.width * metadata.height * 4;
      if (decoded.info.width !== metadata.width || decoded.info.height !== metadata.height
        || decoded.info.channels !== 4 || decoded.data.byteLength !== expectedBytes
        || expectedBytes > message.maxDecodedBytes) {
        throw new Error("decoded pixels are outside policy");
      }
      result[0] = metadata.width;
      result[1] = metadata.height;
      result[2] = decoded.info.channels;
      result[3] = decoded.data.byteLength;
      result[4] = metadata.hasAlpha ? 1 : 0;
      status = 1;
    } catch {}
    Atomics.store(control, 0, status);
    Atomics.notify(control, 0);
  });
`;

type ImageDecoderWorkerState = { worker?: Worker };
type GlobalWithImageDecoderWorker = typeof globalThis & { __proofCanvasImageDecoderWorker?: ImageDecoderWorkerState };

function imageDecoderWorkerState(): ImageDecoderWorkerState {
  const globals = globalThis as GlobalWithImageDecoderWorker;
  globals.__proofCanvasImageDecoderWorker ??= {};
  return globals.__proofCanvasImageDecoderWorker;
}

function retireImageDecoderWorker(worker: Worker): void {
  const state = imageDecoderWorkerState();
  if (state.worker === worker) state.worker = undefined;
  void worker.terminate();
}

function getImageDecoderWorker(): Worker {
  const state = imageDecoderWorkerState();
  if (state.worker) return state.worker;
  const worker = new Worker(IMAGE_DECODER_WORKER_SOURCE, {
    eval: true,
    // The constant CommonJS worker needs none of the parent process's tsx,
    // test-runner, inspector, or stdin module flags.
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
  });
  worker.on("error", () => {
    if (state.worker === worker) state.worker = undefined;
  });
  worker.on("exit", () => {
    if (state.worker === worker) state.worker = undefined;
  });
  worker.unref();
  state.worker = worker;
  return worker;
}

/**
 * Sharp's decoder is asynchronous, while repository writes and startup
 * integrity checks intentionally expose a synchronous validation boundary.
 * Decode in one persistent, unref'd worker and synchronize through a tiny
 * SharedArrayBuffer. Only one upload/import body is admitted at a time, pixel
 * output is bounded, and a stuck/native decoder is retired after the deadline.
 */
function assertFullyDecodedImage(buffer: Buffer, parsed: ParsedContent): void {
  const expectedFormat = parsed.mimeType === "image/jpeg" ? "jpeg" : parsed.mimeType === "image/webp" ? "webp" : null;
  if (!expectedFormat || parsed.width === undefined || parsed.height === undefined) {
    assetError("malformed_content", "Decoded image validation requires authoritative dimensions.");
  }
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const result = new Int32Array(new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT));
  const worker = getImageDecoderWorker();
  try {
    worker.postMessage({
      bytes: Uint8Array.from(buffer),
      control: control.buffer,
      result: result.buffer,
      expectedFormat,
      maxDimension: PROOFCANVAS_ASSET_CONTENT_LIMITS.maxImageDimension,
      maxPixels: PROOFCANVAS_ASSET_CONTENT_LIMITS.maxImagePixels,
      maxDecodedBytes: PROOFCANVAS_ASSET_CONTENT_LIMITS.maxDecodedImageBytes,
    });
  } catch {
    retireImageDecoderWorker(worker);
    assetError("unsupported_type", "The trusted JPEG/WebP decoder is unavailable.");
  }
  const waitResult = Atomics.wait(
    control,
    0,
    0,
    PROOFCANVAS_ASSET_CONTENT_LIMITS.maxImageDecodeMilliseconds,
  );
  if (waitResult === "timed-out") {
    retireImageDecoderWorker(worker);
    assetError("malformed_content", "JPEG/WebP pixel decoding exceeded the bounded validation deadline.");
  }
  if (Atomics.load(control, 0) === -2) {
    retireImageDecoderWorker(worker);
    assetError("unsupported_type", "The trusted JPEG/WebP decoder is unavailable.");
  }
  if (Atomics.load(control, 0) !== 1
    || result[0] !== parsed.width || result[1] !== parsed.height
    || result[2] !== 4 || result[3] !== parsed.width * parsed.height * 4
    || (parsed.hasAlpha !== undefined && result[4] !== (parsed.hasAlpha ? 1 : 0))) {
    assetError("malformed_content", "JPEG/WebP compressed pixels are invalid or disagree with their container metadata.");
  }
}

function parseContent(buffer: Buffer, sniffed: SniffedContent): ParsedContent {
  if (sniffed === "image/png") return parsePng(buffer);
  if (sniffed === "image/jpeg") {
    const parsed = parseJpeg(buffer);
    assertFullyDecodedImage(buffer, parsed);
    return parsed;
  }
  if (sniffed === "image/webp") {
    const parsed = parseWebp(buffer);
    assertFullyDecodedImage(buffer, parsed);
    return parsed;
  }
  if (sniffed === "image/svg+xml") return parseSvg(buffer);
  if (sniffed === "audio/wav") return parseWav(buffer);
  if (sniffed === "audio/mpeg") return parseMp3(buffer);
  if (sniffed === "audio/mp4") {
    assetError("unsupported_type", "audio/mp4 remains unsupported until browser, validator, and renderer duration semantics are reliable end to end.");
  }
  assetError("unsupported_type", "Asset bytes do not match a supported image, SVG, or audio type.");
}

function perTypeByteLimit(mimeType: ProofCanvasAssetMimeType): number {
  if (mimeType === "image/svg+xml") return PROOFCANVAS_ASSET_CONTENT_LIMITS.maxSvgBytes;
  if (mimeType.startsWith("image/")) return PROOFCANVAS_ASSET_CONTENT_LIMITS.maxImageBytes;
  return PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAudioBytes;
}

function assertSniffedByteLimit(sniffed: SniffedContent, byteLength: number): void {
  if (sniffed === "unknown") return;
  const limit = perTypeByteLimit(sniffed);
  if (byteLength > limit) assetError("item_too_large", `${sniffed} assets may contain at most ${limit} bytes.`);
}

export function validateAssetContent(input: ValidateAssetContentInput): ValidatedAssetContent {
  const bytesAreUint8 = input && typeof input === "object" && input.bytes !== undefined
    && (Buffer.isBuffer(input.bytes)
      || (ArrayBuffer.isView(input.bytes) && Object.prototype.toString.call(input.bytes) === "[object Uint8Array]"));
  if (!bytesAreUint8) assetError("invalid_input", "Asset validation requires a Uint8Array body.");
  const aggregateBytesBefore = input.aggregateBytesBefore ?? 0;
  if (input.declaredSize !== undefined) assertAssetByteBudget(input.declaredSize, aggregateBytesBefore);
  assertAssetByteBudget(input.bytes.byteLength, aggregateBytesBefore);
  if (input.declaredSize !== undefined && input.declaredSize !== input.bytes.byteLength) {
    assetError("declared_size_mismatch", "Declared asset length does not match the supplied bytes.");
  }

  // Sniff a bounded copy so recognizable small-cap types fail before a full-body
  // copy or parser walk. The authoritative copy is sniffed and capped again.
  const prefix = Buffer.from(input.bytes.subarray(0, Math.min(input.bytes.byteLength, 256)));
  assertSniffedByteLimit(sniffContent(prefix), input.bytes.byteLength);
  const contentBytes = Buffer.from(input.bytes);
  const sniffed = sniffContent(contentBytes);
  assertSniffedByteLimit(sniffed, contentBytes.byteLength);
  const parsed = parseContent(contentBytes, sniffed);
  if (input.claimedMimeType !== undefined) {
    if (typeof input.claimedMimeType !== "string") assetError("mime_mismatch", "Claimed MIME type is invalid.");
    const claim = normalizedClaim(input.claimedMimeType);
    if (claim === null || claim !== parsed.mimeType) assetError("mime_mismatch", `Asset content is ${parsed.mimeType}, not the claimed MIME type.`);
  }

  const sha256 = createHash("sha256").update(contentBytes).digest("hex");
  if (input.expectedSha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(input.expectedSha256)) assetError("invalid_hash", "Expected asset SHA-256 must be 64 lowercase hexadecimal characters.");
    if (input.expectedSha256 !== sha256) assetError("hash_mismatch", "Asset bytes do not match the expected SHA-256.");
  }
  return {
    filename: canonicalAssetFilename(input.filename, parsed.mimeType),
    mimeType: parsed.mimeType,
    size: contentBytes.byteLength,
    sha256,
    ...(parsed.width === undefined ? {} : { width: parsed.width }),
    ...(parsed.height === undefined ? {} : { height: parsed.height }),
    ...(parsed.duration === undefined ? {} : { duration: parsed.duration }),
    contentBytes,
  };
}
