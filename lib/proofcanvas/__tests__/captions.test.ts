import { timelineTickFor, timelineTimeForTick } from "../frame";
import {
  PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS,
  exportSrtCaptions,
  importSrtCaptions,
  importWebVttCaptions,
  projectSequenceCaptions,
  type CaptionExportResult,
  type CaptionImportResult,
  type CaptionInterchangeClip,
  type CaptionInterchangeErrorCode,
} from "../captions";

function requireImport(result: CaptionImportResult): Extract<CaptionImportResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.diagnostic.code}: ${result.diagnostic.message}`);
  expect(result).toMatchObject({ ok: true });
  return result;
}

function requireExport(result: CaptionExportResult): Extract<CaptionExportResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.diagnostic.code}: ${result.diagnostic.message}`);
  expect(result).toMatchObject({ ok: true });
  return result;
}

function expectFailure(result: CaptionImportResult | CaptionExportResult, code: CaptionInterchangeErrorCode): void {
  expect(result).toMatchObject({ ok: false, diagnostic: { code } });
}

function clip(start: number, end: number, text: string, id = "caption-one"): CaptionInterchangeClip {
  return { id, start, end, text, style: {} };
}

function srtTime(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

test("imports UTF-8 BOM SRT, normalizes CRLF, preserves cue line breaks, and allocates schema-safe deterministic IDs", () => {
  const body = [
    "1",
    "00:00:00,125 --> 00:00:01,250",
    "First line",
    "Second line",
    "",
    "2",
    "00:00:01,250 --> 00:00:02,000",
    "π is precise",
    "",
  ].join("\r\n");
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]);
  const imported = requireImport(importSrtCaptions(bytes));
  expect(imported).toMatchObject({
    format: "srt",
    clips: [
      { id: "caption-srt-1", start: 0.125, end: 1.25, text: "First line\nSecond line", style: {} },
      { id: "caption-srt-2", start: 1.25, end: 2, text: "π is precise", style: {} },
    ],
  });
  expect(timelineTickFor(imported.clips[0].start) % 100_000).toBe(0);
  expect(timelineTickFor(imported.clips[0].end) % 100_000).toBe(0);
});

test("exports canonical deterministic CRLF SRT and round-trips timing and line breaks without loss", () => {
  const clips = [
    clip(0, 1.125, "Alpha\nBeta", "caption-alpha"),
    clip(1.125, 2, "Gamma", "caption-gamma"),
  ];
  const first = requireExport(exportSrtCaptions(clips));
  const second = requireExport(exportSrtCaptions(clips));
  const expected = "1\r\n00:00:00,000 --> 00:00:01,125\r\nAlpha\r\nBeta\r\n\r\n"
    + "2\r\n00:00:01,125 --> 00:00:02,000\r\nGamma\r\n\r\n";
  expect(first).toEqual({ ok: true, format: "srt", text: expected, cueCount: 2 });
  expect(second.text).toBe(first.text);
  expect(first.text).not.toMatch(/(?<!\r)\n/);

  const roundTrip = requireImport(importSrtCaptions(first.text, { idPrefix: "roundtrip" }));
  expect(roundTrip.clips.map(({ start, end, text }) => ({ start, end, text }))).toEqual(
    clips.map(({ start, end, text }) => ({ start, end, text })),
  );
});

test("exports later-shot captions at cumulative project time without changing stable cue IDs", () => {
  const clips = projectSequenceCaptions([
    { duration: 2, captionClips: [clip(0.5, 1, "First shot", "caption-first-shot")] },
    { duration: 3, captionClips: [clip(0.25, 0.75, "Second shot", "caption-second-shot")] },
  ]);
  expect(clips).toEqual([
    clip(0.5, 1, "First shot", "caption-first-shot"),
    clip(2.25, 2.75, "Second shot", "caption-second-shot"),
  ]);
  expect(requireExport(exportSrtCaptions(clips)).text).toContain("00:00:02,250 --> 00:00:02,750");
});

test("imports straightforward WebVTT identifiers and the explicit safely-ignored setting allowlist", () => {
  const source = [
    "WEBVTT",
    "",
    "opening_cue",
    "00:00.000 --> 00:01.500 line:90% position:50% size:80% align:center",
    "Opening line",
    "",
    "second-cue",
    "00:00:01.500 --> 00:00:02.000 vertical:rl",
    "Second\nline",
  ].join("\n");
  const imported = requireImport(importWebVttCaptions(source));
  expect(imported).toMatchObject({
    format: "vtt",
    clips: [
      { id: "caption-vtt-1", start: 0, end: 1.5, text: "Opening line" },
      { id: "caption-vtt-2", start: 1.5, end: 2, text: "Second\nline" },
    ],
  });
});

test.each([
  ["bad header", "WEBVTT caption\n\n00:00:00.000 --> 00:00:01.000\nText", "malformed_header"],
  ["header metadata", "WEBVTT\nKind: captions\n\n00:00:00.000 --> 00:00:01.000\nText", "malformed_header"],
  ["NOTE block", "WEBVTT\n\nNOTE hidden\nmetadata", "unsupported_vtt_metadata"],
  ["unknown setting", "WEBVTT\n\n00:00:00.000 --> 00:00:01.000 region:main\nText", "unsupported_vtt_setting"],
  ["bad percentage", "WEBVTT\n\n00:00:00.000 --> 00:00:01.000 line:101%\nText", "unsupported_vtt_setting"],
  ["duplicate setting", "WEBVTT\n\n00:00:00.000 --> 00:00:01.000 align:start align:end\nText", "unsupported_vtt_setting"],
  ["bad identifier", "WEBVTT\n\nbad identifier\n00:00:00.000 --> 00:00:01.000\nText", "invalid_identifier"],
  ["duplicate identifier", "WEBVTT\n\ncue\n00:00:00.000 --> 00:00:01.000\nA\n\ncue\n00:00:01.000 --> 00:00:02.000\nB", "duplicate_identifier"],
] as const)("rejects unsupported or ambiguous WebVTT structure: %s", (_label, source, code) => {
  expectFailure(importWebVttCaptions(source), code);
});

test.each([
  ["numbering gap", "2\n00:00:00,000 --> 00:00:01,000\nText", "malformed_sequence"],
  ["noncanonical time", "1\n0:00:00,000 --> 00:00:01,000\nText", "malformed_timing"],
  ["invalid minute", "1\n00:60:00,000 --> 01:01:00,000\nText", "malformed_timing"],
  ["zero span", "1\n00:00:01,000 --> 00:00:01,000\nText", "zero_span"],
  ["reversed span", "1\n00:00:02,000 --> 00:00:01,000\nText", "non_increasing"],
  ["out of range", "1\n00:00:00,000 --> 02:00:00,001\nText", "out_of_range"],
  ["duplicate start", "1\n00:00:00,000 --> 00:00:01,000\nA\n\n2\n00:00:00,000 --> 00:00:02,000\nB", "duplicate_time"],
  ["overlap", "1\n00:00:00,000 --> 00:00:01,500\nA\n\n2\n00:00:01,000 --> 00:00:02,000\nB", "overlapping"],
  ["non-increasing cues", "1\n00:00:02,000 --> 00:00:03,000\nA\n\n2\n00:00:01,000 --> 00:00:01,500\nB", "non_increasing"],
] as const)("rejects malformed or ambiguous SRT timing: %s", (_label, source, code) => {
  expectFailure(importSrtCaptions(source), code);
});

test("rejects markup, Unicode controls, NULs, misplaced BOMs, lone CR, and invalid UTF-8 without throwing", () => {
  expectFailure(importSrtCaptions("1\n00:00:00,000 --> 00:00:01,000\n<b>styled</b>"), "forbidden_markup");
  expectFailure(importSrtCaptions("1\n00:00:00,000 --> 00:00:01,000\nvoice\u202eoverride"), "forbidden_control");
  expectFailure(importSrtCaptions("1\0\n00:00:00,000 --> 00:00:01,000\nText"), "forbidden_control");
  expectFailure(importSrtCaptions("1\n00:00:00,000 --> 00:00:01,000\nmid\ufeffbom"), "invalid_bom");
  expectFailure(importSrtCaptions("\ufeff\ufeff1\n00:00:00,000 --> 00:00:01,000\nText"), "invalid_bom");
  expectFailure(importSrtCaptions("1\r00:00:00,000 --> 00:00:01,000\rText"), "invalid_newline");
  expectFailure(importSrtCaptions(Buffer.from([0xff, 0xfe, 0x00, 0x00])), "invalid_utf8");
  expect(() => importSrtCaptions(undefined as unknown as string)).not.toThrow();
  expectFailure(importSrtCaptions(undefined as unknown as string), "invalid_input");
});

test("enforces byte, line, cue-line, cue-text, and cue-count bounds", () => {
  expectFailure(importSrtCaptions(Buffer.alloc(PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxInputBytes + 1, 0x61)), "input_too_large");
  expectFailure(importSrtCaptions("x\n".repeat(PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxLines)), "too_many_lines");
  expectFailure(importSrtCaptions(`1\n00:00:00,000 --> 00:00:01,000\n${"a".repeat(PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxLineChars + 1)}`), "line_too_long");
  expectFailure(importSrtCaptions(`1\n00:00:00,000 --> 00:00:01,000\n${Array.from({ length: PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCueLines + 1 }, () => "line").join("\n")}`), "too_many_cue_lines");
  expectFailure(importSrtCaptions(`1\n00:00:00,000 --> 00:00:01,000\n${Array.from({ length: 5 }, () => "x".repeat(900)).join("\n")}`), "cue_text_too_long");

  const cues = Array.from({ length: PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCues + 1 }, (_, index) => {
    const start = index * 2;
    return `${index + 1}\n${srtTime(start)} --> ${srtTime(start + 1)}\nx`;
  }).join("\n\n");
  expectFailure(importSrtCaptions(cues), "too_many_cues");

  const excessiveTotalText = Array.from({ length: PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCues }, (_, index) => {
    const start = index * 2;
    return `${index + 1}\n${srtTime(start)} --> ${srtTime(start + 1)}\n${"a".repeat(512)}\n${"b".repeat(512)}`;
  }).join("\n\n");
  expectFailure(importSrtCaptions(excessiveTotalText), "total_text_too_large");
});

test("supports injected deterministic IDs and diagnoses allocator failures, invalid IDs, and collisions", () => {
  const source = "1\n00:00:00,000 --> 00:00:01,000\nA\n\n2\n00:00:01,000 --> 00:00:02,000\nB";
  const imported = requireImport(importSrtCaptions(source, { allocateId: ({ index }) => `manual-caption-${index + 1}` }));
  expect(imported.clips.map(({ id }) => id)).toEqual(["manual-caption-1", "manual-caption-2"]);
  expectFailure(importSrtCaptions(source, { allocateId: () => "same-id" }), "duplicate_id");
  expectFailure(importSrtCaptions(source, { allocateId: () => "bad id" }), "invalid_id");
  expectFailure(importSrtCaptions(source, { allocateId: () => { throw new Error("boom"); } }), "id_allocator_failed");
});

test("exports millisecond-aligned timeline ticks exactly and refuses tick or frame precision loss", () => {
  expect(requireExport(exportSrtCaptions([clip(0.001, 0.002, "Exact")])).text).toContain("00:00:00,001 --> 00:00:00,002");
  expectFailure(exportSrtCaptions([clip(timelineTimeForTick(1), 0.001, "Ten nanoseconds")]), "precision_loss");
  const frameAlignedButNotMillisecond = timelineTimeForTick(timelineTickFor(1 / 30));
  expectFailure(exportSrtCaptions([clip(0, frameAlignedButNotMillisecond, "One frame")]), "precision_loss");
  expectFailure(exportSrtCaptions([clip(0.001000001, 0.002, "Binary dust")]), "precision_loss");
});

test("rejects overlapping or structurally invalid CaptionClip arrays on export", () => {
  expectFailure(exportSrtCaptions([
    clip(0, 2, "A", "caption-a"),
    clip(1, 3, "B", "caption-b"),
  ]), "overlapping");
  expectFailure(exportSrtCaptions([{ ...clip(0, 1, "A"), id: "bad id" }]), "invalid_clip");
  expectFailure(exportSrtCaptions([clip(0, 1, "<v Speaker>voice")]), "forbidden_markup");
  expectFailure(exportSrtCaptions([
    clip(0, 1, "A", "caption-duplicate"),
    clip(1, 2, "B", "caption-duplicate"),
  ]), "duplicate_id");
});
