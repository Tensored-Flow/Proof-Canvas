import type { z } from "zod";

import {
  CaptionClipSchema,
  PROOFCANVAS_SCHEMA_LIMITS,
  PROOFCANVAS_TEXT_MAX_CHARS,
  type Shot,
} from "./schema";
import {
  PROOFCANVAS_TIMELINE_MAX_SECONDS,
  PROOFCANVAS_TIMELINE_TICKS_PER_SECOND,
  addTimelineTimes,
  isCanonicalTimelineTime,
  timelineTickFor,
  timelineTimeForTick,
} from "./frame";

export const PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS = Object.freeze({
  maxInputBytes: 512 * 1024,
  maxCues: PROOFCANVAS_SCHEMA_LIMITS.captionClipsPerShot,
  maxLines: 4_096,
  maxLineChars: 1_024,
  maxCueLines: 8,
  maxCueTextChars: PROOFCANVAS_TEXT_MAX_CHARS,
  maxTotalTextChars: 256 * 1024,
  maxIdentifierChars: 64,
});

export const PROOFCANVAS_IGNORED_WEBVTT_SETTINGS = Object.freeze([
  "align",
  "line",
  "position",
  "size",
  "vertical",
] as const);

export type CaptionInterchangeClip = z.infer<typeof CaptionClipSchema>;
export type CaptionInterchangeFormat = "srt" | "vtt";

/**
 * Lift shot-local caption timing onto the ordered project sequence without
 * rounding or changing stable cue IDs. SRT is a project export, so later-shot
 * cues must not restart at 00:00:00.
 */
export function projectSequenceCaptions(
  shots: readonly Pick<Shot, "duration" | "captionClips">[],
): CaptionInterchangeClip[] {
  let offset = 0;
  const result: CaptionInterchangeClip[] = [];
  for (const shot of shots) {
    for (const clip of shot.captionClips) result.push({
      ...clip,
      start: addTimelineTimes(offset, clip.start),
      end: addTimelineTimes(offset, clip.end),
    });
    offset = addTimelineTimes(offset, shot.duration);
  }
  return result;
}

export type CaptionInterchangeErrorCode =
  | "invalid_input"
  | "input_too_large"
  | "invalid_utf8"
  | "invalid_bom"
  | "invalid_newline"
  | "too_many_lines"
  | "line_too_long"
  | "too_many_cues"
  | "too_many_cue_lines"
  | "cue_text_too_long"
  | "total_text_too_large"
  | "malformed_header"
  | "malformed_sequence"
  | "malformed_timing"
  | "out_of_range"
  | "zero_span"
  | "duplicate_time"
  | "non_increasing"
  | "overlapping"
  | "empty_text"
  | "forbidden_markup"
  | "forbidden_control"
  | "unsupported_vtt_metadata"
  | "unsupported_vtt_setting"
  | "invalid_identifier"
  | "duplicate_identifier"
  | "invalid_id"
  | "duplicate_id"
  | "id_allocator_failed"
  | "invalid_clip"
  | "precision_loss"
  | "internal_error";

export interface CaptionInterchangeDiagnostic {
  code: CaptionInterchangeErrorCode;
  message: string;
  cue?: number;
  line?: number;
}

type CaptionFailure = { ok: false; diagnostic: CaptionInterchangeDiagnostic };

export type CaptionImportResult =
  | { ok: true; format: CaptionInterchangeFormat; clips: CaptionInterchangeClip[] }
  | CaptionFailure;

export type CaptionExportResult =
  | { ok: true; format: "srt"; text: string; cueCount: number }
  | CaptionFailure;

export interface CaptionIdContext {
  format: CaptionInterchangeFormat;
  index: number;
  start: number;
  end: number;
  text: string;
}

export type CaptionIdAllocator = (context: CaptionIdContext) => string;

export interface CaptionImportOptions {
  idPrefix?: string;
  allocateId?: CaptionIdAllocator;
}

type ParsedCue = { startMs: number; endMs: number; text: string; line: number };

class CaptionAuthorityError extends Error {
  constructor(public readonly diagnostic: CaptionInterchangeDiagnostic) {
    super(diagnostic.message);
    this.name = "CaptionAuthorityError";
  }
}

function fail(code: CaptionInterchangeErrorCode, message: string, detail: Pick<CaptionInterchangeDiagnostic, "cue" | "line"> = {}): never {
  throw new CaptionAuthorityError({ code, message, ...detail });
}

function boundary<T>(action: () => T): T | CaptionFailure {
  try {
    return action();
  } catch (error) {
    if (error instanceof CaptionAuthorityError) return { ok: false, diagnostic: error.diagnostic };
    return { ok: false, diagnostic: { code: "internal_error", message: "Caption interchange failed at its bounded authority boundary." } };
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function utf8ByteLengthAtMost(value: string, maximum: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
  const parts: string[] = [];
  let units: number[] = [];
  const push = (unit: number) => {
    units.push(unit);
    if (units.length >= 8_192) {
      parts.push(String.fromCharCode(...units));
      units = [];
    }
  };
  const continuation = (index: number): number => {
    const byte = bytes[index];
    if (byte === undefined || (byte & 0xc0) !== 0x80) fail("invalid_utf8", "Caption bytes must be valid UTF-8.");
    return byte;
  };

  for (let index = 0; index < bytes.length; index += 1) {
    const first = bytes[index];
    if (first <= 0x7f) {
      push(first);
      continue;
    }
    if (first >= 0xc2 && first <= 0xdf) {
      const second = continuation(index + 1);
      push(((first & 0x1f) << 6) | (second & 0x3f));
      index += 1;
      continue;
    }
    if (first >= 0xe0 && first <= 0xef) {
      const second = continuation(index + 1);
      const third = continuation(index + 2);
      if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second >= 0xa0)) {
        fail("invalid_utf8", "Caption bytes must not contain overlong or surrogate UTF-8 sequences.");
      }
      push(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f));
      index += 2;
      continue;
    }
    if (first >= 0xf0 && first <= 0xf4) {
      const second = continuation(index + 1);
      const third = continuation(index + 2);
      const fourth = continuation(index + 3);
      if ((first === 0xf0 && second < 0x90) || (first === 0xf4 && second >= 0x90)) {
        fail("invalid_utf8", "Caption bytes contain an out-of-range UTF-8 sequence.");
      }
      const point = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      const scalar = point - 0x10000;
      push(0xd800 + (scalar >>> 10));
      push(0xdc00 + (scalar & 0x3ff));
      index += 3;
      continue;
    }
    fail("invalid_utf8", "Caption bytes must be valid UTF-8.");
  }
  if (units.length > 0) parts.push(String.fromCharCode(...units));
  return parts.join("");
}

function decodeInput(input: string | Uint8Array): string[] {
  let source: string;
  if (typeof input === "string") {
    if (hasUnpairedSurrogate(input)) fail("invalid_utf8", "Caption text contains an unpaired UTF-16 surrogate.");
    if (utf8ByteLengthAtMost(input, PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxInputBytes) > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxInputBytes) {
      fail("input_too_large", `Caption input may contain at most ${PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxInputBytes} UTF-8 bytes.`);
    }
    source = input;
  } else if (input !== null && typeof input === "object" && Object.prototype.toString.call(input) === "[object Uint8Array]") {
    if (input.byteLength > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxInputBytes) {
      fail("input_too_large", `Caption input may contain at most ${PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxInputBytes} UTF-8 bytes.`);
    }
    let byteCopy: Uint8Array;
    try {
      byteCopy = Uint8Array.from(input);
    } catch {
      fail("invalid_input", "Caption byte input must be a readable Uint8Array.");
    }
    source = decodeUtf8(byteCopy);
  } else {
    fail("invalid_input", "Caption input must be a string or Uint8Array.");
  }

  if (source.startsWith("\ufeff")) source = source.slice(1);
  if (source.includes("\ufeff") || source.includes("\ufffe")) fail("invalid_bom", "A UTF-8 BOM is permitted only once at the start of caption input.");
  source = source.replace(/\r\n/g, "\n");
  if (source.includes("\r")) fail("invalid_newline", "Caption input must use LF or CRLF line endings, not lone carriage returns.");

  const lines = source.split("\n");
  if (lines.length > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxLines) {
    fail("too_many_lines", `Caption input may contain at most ${PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxLines} lines.`);
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].length > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxLineChars) {
      fail("line_too_long", `Caption lines may contain at most ${PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxLineChars} characters.`, { line: index + 1 });
    }
    if (/[\p{Cc}\p{Cf}]/u.test(lines[index])) {
      fail("forbidden_control", "Caption input contains a control or formatting character.", { line: index + 1 });
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseTime(value: string, separator: "," | ".", cue: number, line: number): number {
  const escapedSeparator = separator === "." ? "\\." : separator;
  const match = new RegExp(`^(\\d{2}):([0-5]\\d):([0-5]\\d)${escapedSeparator}(\\d{3})$`).exec(value);
  if (!match) fail("malformed_timing", `Caption time must use HH:MM:SS${separator}mmm.`, { cue, line });
  const milliseconds = Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1_000 + Number(match[4]);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > PROOFCANVAS_TIMELINE_MAX_SECONDS * 1_000) {
    fail("out_of_range", `Caption time may not exceed ${PROOFCANVAS_TIMELINE_MAX_SECONDS} seconds.`, { cue, line });
  }
  return milliseconds;
}

function parseSrtTiming(line: string, cue: number, lineNumber: number): { startMs: number; endMs: number } {
  const match = /^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/.exec(line);
  if (!match) fail("malformed_timing", "SRT timing must be exactly HH:MM:SS,mmm --> HH:MM:SS,mmm.", { cue, line: lineNumber });
  return {
    startMs: parseTime(match[1], ",", cue, lineNumber),
    endMs: parseTime(match[2], ",", cue, lineNumber),
  };
}

function parseVttTime(value: string, cue: number, line: number): number {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  if (!match) fail("malformed_timing", "WebVTT time must use MM:SS.mmm or HH:MM:SS.mmm.", { cue, line });
  const milliseconds = Number(match[1] ?? 0) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1_000 + Number(match[4]);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > PROOFCANVAS_TIMELINE_MAX_SECONDS * 1_000) {
    fail("out_of_range", `Caption time may not exceed ${PROOFCANVAS_TIMELINE_MAX_SECONDS} seconds.`, { cue, line });
  }
  return milliseconds;
}

function validateVttSettings(raw: string, cue: number, line: number): void {
  if (!raw) return;
  const seen = new Set<string>();
  for (const token of raw.split(" ")) {
    if (!token) fail("unsupported_vtt_setting", "WebVTT settings must be separated by one ASCII space.", { cue, line });
    const separator = token.indexOf(":");
    const name = separator < 0 ? "" : token.slice(0, separator);
    const value = separator < 0 ? "" : token.slice(separator + 1);
    if (!(PROOFCANVAS_IGNORED_WEBVTT_SETTINGS as readonly string[]).includes(name) || seen.has(name)) {
      fail("unsupported_vtt_setting", `WebVTT setting ${name || token} is unsupported or duplicated.`, { cue, line });
    }
    const percentage = /^(?:0|[1-9]\d?|100)%$/;
    const valid = name === "align" ? /^(?:start|center|end|left|right)$/.test(value)
      : name === "vertical" ? /^(?:rl|lr)$/.test(value)
        : percentage.test(value);
    if (!valid) fail("unsupported_vtt_setting", `WebVTT setting ${name} has an unsupported value.`, { cue, line });
    seen.add(name);
  }
}

function parseVttTiming(line: string, cue: number, lineNumber: number): { startMs: number; endMs: number } {
  const match = /^(\S+) --> (\S+)(?: (.*))?$/.exec(line);
  if (!match) fail("malformed_timing", "WebVTT timing must use standard millisecond timestamps with allowlisted settings.", { cue, line: lineNumber });
  validateVttSettings(match[3] ?? "", cue, lineNumber);
  return {
    startMs: parseVttTime(match[1], cue, lineNumber),
    endMs: parseVttTime(match[2], cue, lineNumber),
  };
}

function validateCueText(lines: readonly string[], cue: number, firstLine: number): string {
  if (lines.length === 0 || lines.every((line) => line.trim().length === 0)) fail("empty_text", "A caption cue must contain text.", { cue, line: firstLine });
  if (lines.length > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCueLines) {
    fail("too_many_cue_lines", `A caption cue may contain at most ${PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCueLines} lines.`, { cue, line: firstLine });
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (/[<>]/u.test(lines[index])) fail("forbidden_markup", "Caption cue markup and tags are not accepted.", { cue, line: firstLine + index });
    if (/[\p{Cc}\p{Cf}]/u.test(lines[index])) fail("forbidden_control", "Caption cue text contains a control or formatting character.", { cue, line: firstLine + index });
  }
  const text = lines.join("\n");
  if (text.length > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCueTextChars) {
    fail("cue_text_too_long", `A caption cue may contain at most ${PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCueTextChars} characters.`, { cue, line: firstLine });
  }
  return text;
}

function validateCueSequence(cues: readonly ParsedCue[]): void {
  const spans = new Set<string>();
  let totalTextChars = 0;
  for (let index = 0; index < cues.length; index += 1) {
    const cueNumber = index + 1;
    const cue = cues[index];
    if (cue.endMs === cue.startMs) fail("zero_span", "Caption cue end must be after its start.", { cue: cueNumber, line: cue.line });
    if (cue.endMs < cue.startMs) fail("non_increasing", "Caption cue end must be after its start.", { cue: cueNumber, line: cue.line });
    const span = `${cue.startMs}:${cue.endMs}`;
    if (spans.has(span) || (index > 0 && cue.startMs === cues[index - 1].startMs)) {
      fail("duplicate_time", "Caption cues may not have duplicate or ambiguous start times.", { cue: cueNumber, line: cue.line });
    }
    if (index > 0 && cue.startMs < cues[index - 1].startMs) {
      fail("non_increasing", "Caption cues must be ordered by strictly increasing start time.", { cue: cueNumber, line: cue.line });
    }
    if (index > 0 && cue.startMs < cues[index - 1].endMs) {
      fail("overlapping", "Caption cues may not overlap.", { cue: cueNumber, line: cue.line });
    }
    spans.add(span);
    totalTextChars += cue.text.length;
    if (totalTextChars > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxTotalTextChars) {
      fail("total_text_too_large", `Caption cue text may contain at most ${PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxTotalTextChars} characters in total.`, { cue: cueNumber });
    }
  }
}

function srtCues(lines: readonly string[]): ParsedCue[] {
  const cues: ParsedCue[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const cueNumber = cues.length + 1;
    if (cueNumber > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCues) fail("too_many_cues", `Caption input may contain at most ${PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCues} cues.`, { cue: cueNumber });
    if (lines[cursor] !== String(cueNumber)) fail("malformed_sequence", "SRT cue numbers must begin at 1 and increase by exactly one without leading zeroes.", { cue: cueNumber, line: cursor + 1 });
    const timingLine = cursor + 1;
    if (timingLine >= lines.length) fail("malformed_timing", "SRT cue is missing its timing line.", { cue: cueNumber, line: timingLine + 1 });
    const timing = parseSrtTiming(lines[timingLine], cueNumber, timingLine + 1);
    cursor += 2;
    const textStart = cursor;
    while (cursor < lines.length && lines[cursor] !== "") cursor += 1;
    const text = validateCueText(lines.slice(textStart, cursor), cueNumber, textStart + 1);
    cues.push({ ...timing, text, line: timingLine + 1 });
    while (cursor < lines.length && lines[cursor] === "") cursor += 1;
  }
  if (cues.length === 0) fail("malformed_header", "SRT input must contain at least one cue.");
  validateCueSequence(cues);
  return cues;
}

function webVttCues(lines: readonly string[]): ParsedCue[] {
  if (lines[0] !== "WEBVTT") fail("malformed_header", "WebVTT input must begin with the exact WEBVTT header.", { line: 1 });
  if (lines.length < 2 || lines[1] !== "") fail("malformed_header", "The WEBVTT header must be followed by a blank line.", { line: 2 });
  const cues: ParsedCue[] = [];
  const identifiers = new Set<string>();
  let cursor = 2;
  while (cursor < lines.length) {
    while (cursor < lines.length && lines[cursor] === "") cursor += 1;
    if (cursor >= lines.length) break;
    const cueNumber = cues.length + 1;
    if (cueNumber > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCues) fail("too_many_cues", `Caption input may contain at most ${PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCues} cues.`, { cue: cueNumber });
    if (/^(?:NOTE|STYLE|REGION)(?: |$)/.test(lines[cursor])) {
      fail("unsupported_vtt_metadata", "WebVTT NOTE, STYLE, and REGION blocks are not accepted.", { cue: cueNumber, line: cursor + 1 });
    }
    let identifier: string | null = null;
    if (!lines[cursor].includes(" --> ")) {
      identifier = lines[cursor];
      if (identifier.length > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxIdentifierChars
        || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(identifier)) {
        fail("invalid_identifier", "WebVTT cue identifiers must use the bounded ASCII identifier subset.", { cue: cueNumber, line: cursor + 1 });
      }
      if (identifiers.has(identifier)) fail("duplicate_identifier", "WebVTT cue identifiers must be unique.", { cue: cueNumber, line: cursor + 1 });
      identifiers.add(identifier);
      cursor += 1;
    }
    if (cursor >= lines.length) fail("malformed_timing", "WebVTT cue is missing its timing line.", { cue: cueNumber, line: cursor + 1 });
    const timingLine = cursor;
    const timing = parseVttTiming(lines[cursor], cueNumber, cursor + 1);
    cursor += 1;
    const textStart = cursor;
    while (cursor < lines.length && lines[cursor] !== "") cursor += 1;
    const text = validateCueText(lines.slice(textStart, cursor), cueNumber, textStart + 1);
    cues.push({ ...timing, text, line: timingLine + 1 });
  }
  validateCueSequence(cues);
  return cues;
}

function clipsForCues(format: CaptionInterchangeFormat, cues: readonly ParsedCue[], options: CaptionImportOptions): CaptionInterchangeClip[] {
  const ids = new Set<string>();
  const prefix = options.idPrefix ?? `caption-${format}`;
  return cues.map((cue, index) => {
    const start = timelineTimeForTick(cue.startMs * (PROOFCANVAS_TIMELINE_TICKS_PER_SECOND / 1_000));
    const end = timelineTimeForTick(cue.endMs * (PROOFCANVAS_TIMELINE_TICKS_PER_SECOND / 1_000));
    let id: unknown;
    if (options.allocateId) {
      try {
        id = options.allocateId({ format, index, start, end, text: cue.text });
      } catch {
        fail("id_allocator_failed", "The caption ID allocator threw an exception.", { cue: index + 1 });
      }
    } else {
      id = `${prefix}-${index + 1}`;
    }
    if (typeof id !== "string") fail("invalid_id", "The caption ID allocator must return a schema-valid string ID.", { cue: index + 1 });
    if (ids.has(id)) fail("duplicate_id", "Caption IDs must be unique within an import.", { cue: index + 1 });
    const parsed = CaptionClipSchema.safeParse({ id, start, end, text: cue.text, style: {} });
    if (!parsed.success) fail("invalid_id", "Imported caption data did not satisfy the canonical CaptionClip schema.", { cue: index + 1 });
    ids.add(id);
    return parsed.data;
  });
}

export function importSrtCaptions(input: string | Uint8Array, options: CaptionImportOptions = {}): CaptionImportResult {
  const result = boundary(() => {
    const clips = clipsForCues("srt", srtCues(decodeInput(input)), options);
    return { ok: true as const, format: "srt" as const, clips };
  });
  return result;
}

export function importWebVttCaptions(input: string | Uint8Array, options: CaptionImportOptions = {}): CaptionImportResult {
  const result = boundary(() => {
    const clips = clipsForCues("vtt", webVttCues(decodeInput(input)), options);
    return { ok: true as const, format: "vtt" as const, clips };
  });
  return result;
}

function normalizedExportText(text: string, cue: number): string {
  if (hasUnpairedSurrogate(text)) fail("invalid_utf8", "Caption clip text contains an unpaired UTF-16 surrogate.", { cue });
  let normalized = text.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) fail("invalid_newline", "Caption clip text must use LF or CRLF line endings.", { cue });
  if (normalized.endsWith("\n") || normalized.startsWith("\n") || normalized.includes("\n\n")) {
    fail("empty_text", "Caption clip text may not contain leading, trailing, or empty lines.", { cue });
  }
  normalized = validateCueText(normalized.split("\n"), cue, 1);
  return normalized;
}

function exactMilliseconds(time: number, cue: number): number {
  if (!isCanonicalTimelineTime(time)) fail("precision_loss", "SRT export requires canonical timeline times exactly aligned to milliseconds.", { cue });
  let tick: number;
  try {
    tick = timelineTickFor(time);
  } catch {
    fail("out_of_range", "Caption time is outside the authored timeline range.", { cue });
  }
  const ticksPerMillisecond = PROOFCANVAS_TIMELINE_TICKS_PER_SECOND / 1_000;
  if (tick % ticksPerMillisecond !== 0) fail("precision_loss", "SRT export refuses non-millisecond-aligned caption times instead of rounding.", { cue });
  return tick / ticksPerMillisecond;
}

function formatSrtTime(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function exportSrtCaptions(clips: readonly CaptionInterchangeClip[]): CaptionExportResult {
  const result = boundary(() => {
    if (!Array.isArray(clips)) fail("invalid_input", "SRT export requires an array of CaptionClip values.");
    if (clips.length > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCues) fail("too_many_cues", `SRT export may contain at most ${PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxCues} cues.`);
    const cues: ParsedCue[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < clips.length; index += 1) {
      const cue = index + 1;
      if (!isCanonicalTimelineTime(clips[index].start) || !isCanonicalTimelineTime(clips[index].end)) {
        fail("precision_loss", "SRT export requires canonical timeline times exactly aligned to milliseconds.", { cue });
      }
      const parsed = CaptionClipSchema.safeParse(clips[index]);
      if (!parsed.success) fail("invalid_clip", "SRT export accepts only canonical CaptionClip values.", { cue });
      if (ids.has(parsed.data.id)) fail("duplicate_id", "CaptionClip IDs must be unique within an export.", { cue });
      ids.add(parsed.data.id);
      const text = normalizedExportText(parsed.data.text, cue);
      cues.push({
        startMs: exactMilliseconds(parsed.data.start, cue),
        endMs: exactMilliseconds(parsed.data.end, cue),
        text,
        line: cue,
      });
    }
    validateCueSequence(cues);
    const blocks = cues.map((cue, index) => [
      String(index + 1),
      `${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}`,
      ...cue.text.split("\n"),
    ].join("\r\n"));
    const text = blocks.length === 0 ? "" : `${blocks.join("\r\n\r\n")}\r\n\r\n`;
    if (utf8ByteLengthAtMost(text, PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxInputBytes) > PROOFCANVAS_CAPTION_INTERCHANGE_LIMITS.maxInputBytes) {
      fail("input_too_large", "Canonical SRT output exceeds the caption interchange byte budget.");
    }
    return { ok: true as const, format: "srt" as const, text, cueCount: cues.length };
  });
  return result;
}
