jest.mock("server-only", () => ({}), { virtual: true });

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { AssetMetadataSchema } from "../schema";
import {
  AssetContentError,
  PROOFCANVAS_ASSET_CONTENT_LIMITS,
  assertAssetByteBudget,
  sanitizeAssetFilename,
  validateAssetContent,
} from "../assetContent.server";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AssetContentError);
    expect(error).toMatchObject({ code });
  }
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

const REAL_JPEG = Buffer.from(
  "/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AFZGiJ//2Q==",
  "base64",
);
const REAL_PROGRESSIVE_JPEG = Buffer.from(
  "/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wgARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABf/EABUBAQEAAAAAAAAAAAAAAAAAAAUH/9oADAMBAAIQAxAAAAFVGIf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP8A/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=",
  "base64",
);
const REAL_WEBP = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAEAfQ43IUtYCBiOh/AAA=", "base64");
const REAL_LOSSY_WEBP = Buffer.from(
  "UklGRjwAAABXRUJQVlA4IDAAAADwAQCdASoDAAIAAUAmJaACdLoB+AAETAAA/vIiX/3ZP9sn+2T/3jP/lKvBY3N8AAA=",
  "base64",
);
const REAL_ALPHA_WEBP = Buffer.from(
  "UklGRl4AAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAQgICAgICAAFZQOCAwAAAA8AEAnQEqAwACAAFAJiWgAnS6AfgABEwAAP7yIl/92T/bJ/tk/94z/5SrwWNzfAAA",
  "base64",
);

function crc32(bytes: Buffer): number {
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

function png(width = 320, height = 180): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const decodedBytes = height * (1 + width * 4);
  const decoded = decodedBytes <= 4 * 1024 * 1024 ? Buffer.alloc(decodedBytes) : Buffer.from([0]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(decoded)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpeg(width = 320, height = 180): Buffer {
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b,
    0x08, height >>> 8, height & 0xff, width >>> 8, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
  const sos = Buffer.from([
    0xff, 0xda, 0x00, 0x08,
    0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    sos,
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function riff(kind: "WEBP" | "WAVE", chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from(kind, "ascii"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function riffChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

function webpLossless(width = 320, height = 180): Buffer {
  const data = Buffer.alloc(6);
  data[0] = 0x2f;
  data.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  data[5] = 0;
  return riff("WEBP", [riffChunk("VP8L", data)]);
}

function wav(dataBytes = 16_000, sampleRate = 8_000, channels = 1, bits = 8): Buffer {
  const format = Buffer.alloc(16);
  const blockAlign = channels * bits / 8;
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(channels, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(sampleRate * blockAlign, 8);
  format.writeUInt16LE(blockAlign, 12);
  format.writeUInt16LE(bits, 14);
  return riff("WAVE", [riffChunk("fmt ", format), riffChunk("data", Buffer.alloc(dataBytes, 0x80))]);
}

function mp3(frames = 2): Buffer {
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz: floor(144*128000/44100)=417 bytes.
  const frame = Buffer.alloc(417);
  frame.writeUInt32BE(0xfffb9000, 0);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

function mpeg2Layer3Duration(seconds: number): Buffer {
  // MPEG-2 Layer III, 8 kbps, 16 kHz: 576 samples and 36 bytes per frame.
  const samplesPerFrame = 576;
  const sampleRate = 16_000;
  const frameBytes = 36;
  const frames = Math.ceil(seconds * sampleRate / samplesPerFrame);
  const bytes = Buffer.alloc(frames * frameBytes);
  for (let offset = 0; offset < bytes.length; offset += frameBytes) bytes.writeUInt32BE(0xfff31800, offset);
  return bytes;
}

function isoBox(type: string, ...parts: Buffer[]): Buffer {
  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function mp4Audio(handler = "soun", codec = "mp4a"): Buffer {
  const ftyp = isoBox("ftyp", Buffer.from("M4A \0\0\0\0M4A isom", "binary"));
  const hdlrPayload = Buffer.alloc(24);
  hdlrPayload.write(handler, 8, "ascii");
  const hdlr = isoBox("hdlr", hdlrPayload);
  const sampleEntry = Buffer.alloc(28);
  sampleEntry.writeUInt16BE(1, 6);
  sampleEntry.writeUInt16BE(2, 16);
  sampleEntry.writeUInt16BE(16, 18);
  sampleEntry.writeUInt32BE(44_100 * 65_536, 24);
  const count = Buffer.alloc(8);
  count.writeUInt32BE(1, 4);
  const stsd = isoBox("stsd", count, isoBox(codec, sampleEntry));
  const stbl = isoBox("stbl", stsd);
  const minf = isoBox("minf", stbl);
  const mdia = isoBox("mdia", hdlr, minf);
  const trak = isoBox("trak", mdia);
  const moov = isoBox("moov", trak);
  return Buffer.concat([ftyp, moov, isoBox("mdat", Buffer.alloc(32, 0x55))]);
}

test("publishes explicit per-item, aggregate, decode, duration, and parser complexity bounds", () => {
  expect(PROOFCANVAS_ASSET_CONTENT_LIMITS).toEqual(expect.objectContaining({
    maxImageBytes: 32 * 1024 * 1024,
    maxSvgBytes: 2 * 1024 * 1024,
    maxAudioBytes: 64 * 1024 * 1024,
    maxItemBytes: 64 * 1024 * 1024,
    maxAggregateBytes: 128 * 1024 * 1024,
    maxImageDimension: 16_384,
    maxImagePixels: 64 * 1024 * 1024,
    maxDecodedImageBytes: 256 * 1024 * 1024,
    maxAudioDurationSeconds: 7_200,
    maxPngChunks: 4_096,
    maxPngAncillaryBytes: 256 * 1024,
    maxJpegMarkers: 4_096,
    maxJpegMetadataBytes: 2 * 1024 * 1024,
    maxWebpChunks: 64,
    maxWebpMetadataBytes: 2 * 1024 * 1024,
    maxImageDecodeMilliseconds: 15_000,
    maxRiffChunks: 4_096,
    maxMp3AudioFrames: 1_000_000,
  }));
  expect(Object.isFrozen(PROOFCANVAS_ASSET_CONTENT_LIMITS)).toBe(true);
});

test("admission guard rejects invalid, empty, oversized-item, and overflowing aggregate declarations", () => {
  expect(() => assertAssetByteBudget(1, 0)).not.toThrow();
  expect(() => assertAssetByteBudget(PROOFCANVAS_ASSET_CONTENT_LIMITS.maxItemBytes, 0)).not.toThrow();
  expect(() => assertAssetByteBudget(1, PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAggregateBytes - 1)).not.toThrow();
  for (const size of [-1, 0, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expectCode(() => assertAssetByteBudget(size), "invalid_input");
  expectCode(() => assertAssetByteBudget(PROOFCANVAS_ASSET_CONTENT_LIMITS.maxItemBytes + 1), "item_too_large");
  expectCode(() => assertAssetByteBudget(2, PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAggregateBytes - 1), "aggregate_too_large");
  expectCode(() => assertAssetByteBudget(1, PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAggregateBytes + 1), "aggregate_too_large");
});

test("sniffs a recognizable type and applies its smaller byte cap before parsing", () => {
  const oversizedPng = Buffer.alloc(PROOFCANVAS_ASSET_CONTENT_LIMITS.maxImageBytes + 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedPng);
  expectCode(() => validateAssetContent({ filename: "oversized.png", bytes: oversizedPng }), "item_too_large");
});

test("sanitizes a portable basename but refuses traversal, absolute, encoded, drive, ADS, and control-shaped names", () => {
  expect(sanitizeAssetFilename("  lecture 01 (final) 🎬.PNG  ")).toBe("lecture_01_final_-.PNG");
  expect(sanitizeAssetFilename("CON.png")).toBe("asset-CON.png");
  for (const name of ["../secret.png", "..\\secret.png", "/tmp/a.png", "C:\\a.png", "note.png:payload", "%2e%2e%2fsecret", "a\0.png", ".", ".."]) {
    expectCode(() => sanitizeAssetFilename(name), "invalid_filename");
  }
});

test("derives PNG content authority, dimensions, canonical extension, immutable-copy boundary, and SHA binding", () => {
  const bytes = png(640, 360);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const result = validateAssetContent({
    filename: "frame.jpeg",
    bytes,
    declaredSize: bytes.length,
    claimedMimeType: "image/png; charset=binary",
    expectedSha256: hash,
  });
  expect(result).toMatchObject({ filename: "frame.png", mimeType: "image/png", size: bytes.length, sha256: hash, width: 640, height: 360 });
  bytes[0] = 0;
  expect(result.contentBytes[0]).toBe(137);
  expect(createHash("sha256").update(result.contentBytes).digest("hex")).toBe(result.sha256);
});

test("rejects PNG truncation, CRC corruption, declared chunk overflow, decompression-sized dimensions, and appended polyglot bytes", () => {
  const good = png();
  const badCrc = Buffer.from(good);
  badCrc[badCrc.length - 1] ^= 1;
  const declaredOverflow = Buffer.from(good.subarray(0, 24));
  declaredOverflow.writeUInt32BE(0xffffffff, 8);
  for (const candidate of [good.subarray(0, -1), badCrc, declaredOverflow, Buffer.concat([good, mp3()])]) {
    expectCode(() => validateAssetContent({ filename: "x.png", bytes: candidate }), "malformed_content");
  }
  expectCode(() => validateAssetContent({ filename: "huge.png", bytes: png(16_384, 16_384) }), "dimensions_limit");
});

test("bounds and fully consumes PNG decompression while validating decoded scanline filters", () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const wrap = (compressed: Buffer) => Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  for (const candidate of [
    wrap(Buffer.from([0x78, 0x9c, 0xff])),
    wrap(Buffer.concat([deflateSync(Buffer.alloc(5)), Buffer.from("polyglot")])),
    wrap(deflateSync(Buffer.from([5, 0, 0, 0, 0]))),
    wrap(deflateSync(Buffer.alloc(4))),
  ]) expectCode(() => validateAssetContent({ filename: "bad.png", bytes: candidate }), "malformed_content");
});

test("rejects APNG, compressed metadata, oversized ancillary metadata, and excessive PNG chunks", () => {
  const good = png(1, 1);
  const beforeIdat = good.indexOf(Buffer.from("IDAT")) - 4;
  const insert = (chunks: Buffer[]) => Buffer.concat([good.subarray(0, beforeIdat), ...chunks, good.subarray(beforeIdat)]);
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(1, 0);
  animationControl.writeUInt32BE(0, 4);
  for (const candidate of [
    insert([pngChunk("acTL", animationControl)]),
    insert([pngChunk("iCCP", Buffer.from("profile\0\0compressed"))]),
    insert([pngChunk("iTXt", Buffer.from("keyword\0\x01\0\0\0compressed"))]),
    insert([pngChunk("zTXt", Buffer.from("keyword\0\0compressed"))]),
    insert([pngChunk("tEXt", Buffer.alloc(PROOFCANVAS_ASSET_CONTENT_LIMITS.maxPngTextBytes + 1))]),
    insert(Array.from({ length: PROOFCANVAS_ASSET_CONTENT_LIMITS.maxPngChunks }, () => pngChunk("tEXt", Buffer.from("k\0v")))),
  ]) expectCode(() => validateAssetContent({ filename: "unsafe.png", bytes: candidate }), "malformed_content");
});

test.each([
  ["baseline JPEG", "photo.jpeg", "image/jpeg", REAL_JPEG, "photo.jpg"],
  ["progressive JPEG", "progressive.bin", "image/jpeg", REAL_PROGRESSIVE_JPEG, "progressive.jpg"],
  ["lossless WebP", "diagram.png", "image/webp", REAL_WEBP, "diagram.webp"],
  ["lossy WebP", "lossy.bin", "image/webp", REAL_LOSSY_WEBP, "lossy.webp"],
  ["extended-alpha WebP", "alpha.bin", "image/webp", REAL_ALPHA_WEBP, "alpha.webp"],
] as const)("content-sniffs and fully decodes a real %s", (_label, filename, mimeType, bytes, expectedFilename) => {
  const result = validateAssetContent({ filename, bytes, claimedMimeType: mimeType });
  expect(result).toMatchObject({
    filename: expectedFilename,
    mimeType,
    size: bytes.length,
    width: 3,
    height: 2,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(Buffer.from(result.contentBytes)).toEqual(bytes);
});

test("rejects plausible JPEG/WebP headers whose compressed pixels do not decode", () => {
  expectCode(() => validateAssetContent({ filename: "photo.jpg", bytes: jpeg(), claimedMimeType: "image/jpeg" }), "malformed_content");
  expectCode(() => validateAssetContent({ filename: "diagram.webp", bytes: webpLossless(), claimedMimeType: "image/webp" }), "malformed_content");
});

test("rejects JPEG trailing data and bounded metadata/marker abuse before trusted decode", () => {
  expectCode(() => validateAssetContent({ filename: "polyglot.jpg", bytes: Buffer.concat([REAL_JPEG, Buffer.from("polyglot")]) }), "malformed_content");
  const emptyAppMarker = Buffer.from([0xff, 0xe0, 0x00, 0x02]);
  const tooManyMarkers = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...Array.from({ length: PROOFCANVAS_ASSET_CONTENT_LIMITS.maxJpegMarkers + 1 }, () => emptyAppMarker),
    Buffer.from([0xff, 0xd9]),
  ]);
  expectCode(() => validateAssetContent({ filename: "markers.jpg", bytes: tooManyMarkers }), "malformed_content");
});

test("accepts only a conservative executable-free SVG subset and derives integer dimensions", () => {
  const bytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" fill="none"><g transform="translate(1, 2)"><path d="M 0 0 L 320 180 Z" stroke="#21c7a8" stroke-width="2"/><circle cx="20" cy="20" r="4" fill="white"/></g></svg>`);
  const result = validateAssetContent({ filename: "safe vector.js", bytes, claimedMimeType: "image/svg+xml; charset=utf-8" });
  expect(result).toMatchObject({ filename: "safe_vector.svg", mimeType: "image/svg+xml", width: 320, height: 180 });
  expect(Buffer.from(result.contentBytes).equals(bytes)).toBe(true);
});

test.each([
  ["doctype/entity expansion", `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg>`],
  ["XML processing instruction", `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg>`],
  ["script", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>`],
  ["event handler", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0L1 1" onload="alert(1)"/></svg>`],
  ["external reference", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="https://example.test/x.png"/></svg>`],
  ["CSS URL", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0L1 1" style="fill:url(https://example.test/x)"/></svg>`],
  ["foreign object", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><foreignObject><p>html</p></foreignObject></svg>`],
  ["use fragment", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><use href="#x"/></svg>`],
  ["text node", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g>unsafe text</g></svg>`],
  ["malformed nesting", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g><path d="M0 0L1 1"/></svg></g>`],
])("rejects unsafe SVG: %s", (_label, source) => {
  expectCode(() => validateAssetContent({ filename: "unsafe.svg", bytes: Buffer.from(source) }), "unsafe_svg");
});

test("rejects SVG fractional metadata dimensions that cannot bind the integer asset schema", () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1.5 1"><path d="M0 0L1 1"/></svg>`;
  expectCode(() => validateAssetContent({ filename: "fractional.svg", bytes: Buffer.from(source) }), "dimensions_limit");
});

test("rejects SVG decode bombs by bounded source bytes and raster-sized geometry before any downstream renderer", () => {
  const large = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0L1 1"/>${" ".repeat(PROOFCANVAS_ASSET_CONTENT_LIMITS.maxSvgBytes)}</svg>`;
  expectCode(() => validateAssetContent({ filename: "large.svg", bytes: Buffer.from(large) }), "item_too_large");
  const huge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16384 16384"><path d="M0 0L1 1"/></svg>`;
  expectCode(() => validateAssetContent({ filename: "huge.svg", bytes: Buffer.from(huge) }), "dimensions_limit");
});

test("derives exact PCM WAV duration and canonical audio metadata", () => {
  expect(validateAssetContent({ filename: "narration.bin", bytes: wav(), claimedMimeType: "audio/x-wav" })).toMatchObject({
    filename: "narration.wav", mimeType: "audio/wav", duration: 2, size: wav().length,
  });
});

test("rejects WAV length lies, inconsistent format rates, sample misalignment, unknown chunks, and appended bytes", () => {
  const badRate = Buffer.from(wav());
  badRate.writeUInt32LE(1, 28);
  const misaligned = wav(16_001, 8_000, 1, 16);
  const unknown = riff("WAVE", [riffChunk("fmt ", wav().subarray(20, 36)), riffChunk("EVIL", Buffer.from([1, 2])), riffChunk("data", Buffer.from([0x80]))]);
  const badRiffLength = Buffer.from(wav());
  badRiffLength.writeUInt32LE(0xffffffff, 4);
  for (const candidate of [wav().subarray(0, -1), badRate, misaligned, unknown, badRiffLength, Buffer.concat([wav(), mp3()])]) {
    expectCode(() => validateAssetContent({ filename: "x.wav", bytes: candidate }), "malformed_content");
  }
});

test("bounds WAV RIFF chunk scanning and ancillary metadata before accepting sample data", () => {
  const format = Buffer.from(wav().subarray(20, 36));
  const tooManyChunks = riff("WAVE", [
    riffChunk("fmt ", format),
    ...Array.from({ length: PROOFCANVAS_ASSET_CONTENT_LIMITS.maxRiffChunks }, () => riffChunk("JUNK", Buffer.alloc(0))),
    riffChunk("data", Buffer.from([0x80])),
  ]);
  const oversizedMetadata = riff("WAVE", [
    riffChunk("fmt ", format),
    riffChunk("LIST", Buffer.alloc(PROOFCANVAS_ASSET_CONTENT_LIMITS.maxWavAncillaryBytes + 1)),
    riffChunk("data", Buffer.from([0x80])),
  ]);
  for (const candidate of [tooManyChunks, oversizedMetadata]) {
    expectCode(() => validateAssetContent({ filename: "bounded.wav", bytes: candidate }), "malformed_content");
  }
});

test("derives MP3 duration only from a fully consumed stable MPEG frame stream", () => {
  expect(validateAssetContent({ filename: "lecture.wav", bytes: mp3(), claimedMimeType: "audio/mp3" })).toMatchObject({
    filename: "lecture.mp3", mimeType: "audio/mpeg", size: 834, duration: 2 * 1_152 / 44_100,
  });
});

test("rejects the reported 7201-second MP3 at the duration boundary", () => {
  expectCode(() => validateAssetContent({ filename: "too-long.mp3", bytes: mpeg2Layer3Duration(7_201) }), "duration_limit");
});

test("rejects MP3 false positives, one-frame truncation, reserved headers, unsafe ID3 embedding, and appended polyglots", () => {
  const reserved = Buffer.from(mp3());
  reserved[1] = 0xeb;
  const id3 = Buffer.alloc(20);
  id3.write("ID3", 0, "ascii");
  id3[3] = 4;
  id3.write("APIC", 10, "ascii");
  id3[17] = 1;
  for (const candidate of [mp3(1), reserved, Buffer.concat([id3, mp3()]), Buffer.concat([mp3(), png()]), Buffer.from([0xff, 0xfb, 0x90, 0x00])]) {
    expectCode(() => validateAssetContent({ filename: "x.mp3", bytes: candidate }), "malformed_content");
  }
});

test("fails closed on synthetic M4A boxes until decoder-backed validation and duration derivation exist", () => {
  expectCode(() => validateAssetContent({ filename: "voice.m4a", bytes: mp4Audio(), claimedMimeType: "audio/x-m4a" }), "unsupported_type");
});

test("content wins over filename and client MIME while unknown types fail closed", () => {
  expectCode(() => validateAssetContent({ filename: "looks-like.jpg", bytes: png(), claimedMimeType: "image/jpeg" }), "mime_mismatch");
  expectCode(() => validateAssetContent({ filename: "x.png", bytes: png(), claimedMimeType: "text/html" }), "mime_mismatch");
  expectCode(() => validateAssetContent({ filename: "x.bin", bytes: Buffer.from("not an asset") }), "unsupported_type");
});

test("validated authority fields bind the canonical project asset metadata schema without coercion", () => {
  for (const validated of [
    validateAssetContent({ filename: "image", bytes: png(32, 18) }),
    validateAssetContent({ filename: "audio", bytes: wav(8_000) }),
  ]) {
    const { contentBytes: _contentBytes, ...authority } = validated;
    expect(AssetMetadataSchema.parse({
      id: `asset-${validated.mimeType.startsWith("image/") ? "image" : "audio"}`,
      ...authority,
      provenance: "uploaded",
    })).toEqual(expect.objectContaining({ filename: validated.filename, size: validated.size, sha256: validated.sha256 }));
  }
});

test("binds declared and aggregate sizes before parsing and verifies a strict lowercase SHA-256", () => {
  const bytes = png();
  expectCode(() => validateAssetContent({ filename: "x.png", bytes, declaredSize: bytes.length + 1 }), "declared_size_mismatch");
  expectCode(() => validateAssetContent({ filename: "x.png", bytes, declaredSize: PROOFCANVAS_ASSET_CONTENT_LIMITS.maxItemBytes + 1 }), "item_too_large");
  expectCode(() => validateAssetContent({ filename: "x.png", bytes, aggregateBytesBefore: PROOFCANVAS_ASSET_CONTENT_LIMITS.maxAggregateBytes }), "aggregate_too_large");
  expectCode(() => validateAssetContent({ filename: "x.png", bytes, expectedSha256: "A".repeat(64) }), "invalid_hash");
  expectCode(() => validateAssetContent({ filename: "x.png", bytes, expectedSha256: "0".repeat(64) }), "hash_mismatch");
});
