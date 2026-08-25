import { keyframeSelection, type EditorKeyframeRef, type EditorSelection } from "./editorSelection";
import {
  PROOFCANVAS_TIMELINE_TICKS_PER_SECOND,
  compareTimelineTimes,
  frameToSeconds,
  secondsToFrameCeil,
  secondsToFrameFloor,
  timelineTickFor,
  timelineTimeForTick,
} from "./frame";
import { allocateId, collectProjectIds } from "./ids";
import { applyOperations } from "./operations";
import {
  SceneOperationSchema,
  cloneSerializable,
  type KeyframeInterpolation,
  type ProjectDocument,
  type PropertyKeyframe,
  type PropertyTrack,
  type PropertyTrackTarget,
  type SceneOperation,
  type Shot,
} from "./schema";
import { effectiveObjectLifetime, propertyTrackKey } from "./timeline";

export interface TimelineViewport {
  start: number;
  end: number;
  widthPx: number;
}

function viewportTicks(viewport: TimelineViewport): { start: number; end: number; span: number } {
  const start = timelineTickFor(viewport.start);
  const end = timelineTickFor(viewport.end);
  if (end <= start) throw new Error("Timeline viewport end must be after its start");
  if (!Number.isFinite(viewport.widthPx) || viewport.widthPx <= 0) throw new Error("Timeline viewport width must be positive");
  return { start, end, span: end - start };
}

/** Map canonical authored time to the viewport without introducing persisted float rounding. */
export function timelineTimeToX(time: number, viewport: TimelineViewport): number {
  const ticks = viewportTicks(viewport);
  return (timelineTickFor(time) - ticks.start) * viewport.widthPx / ticks.span;
}

/** Map a viewport position to the nearest canonical 10ns timeline tick. */
export function timelineXToTime(x: number, viewport: TimelineViewport, clamp = true): number {
  if (!Number.isFinite(x)) throw new Error("Timeline position must be finite");
  const ticks = viewportTicks(viewport);
  const boundedX = clamp ? Math.min(viewport.widthPx, Math.max(0, x)) : x;
  const tick = ticks.start + Math.round(boundedX * ticks.span / viewport.widthPx);
  return timelineTimeForTick(tick);
}

export interface TimelineRulerInterval {
  frameStep: number;
  /** Display estimate only; marks must be derived from absolute frame indices. */
  approximateSecondsPerMark: number;
  pixelSpacing: number;
}

export interface TimelineRulerMark {
  frameIndex: number;
  time: number;
  x: number;
}

/**
 * Choose the smallest stable frame-aligned interval that meets the requested
 * visual spacing. Whole-second "nice" intervals are included for readable
 * low-zoom rulers, while high zoom can always reach a single frame.
 */
export function chooseTimelineRulerInterval(
  viewport: TimelineViewport,
  frameRate: number,
  minimumPixelSpacing = 56,
): TimelineRulerInterval {
  if (!Number.isInteger(frameRate) || frameRate <= 0) throw new Error("Frame rate must be a positive integer");
  if (!Number.isFinite(minimumPixelSpacing) || minimumPixelSpacing <= 0) throw new Error("Minimum ruler spacing must be positive");
  const frameCandidates = new Set<number>([1, 2, 3, 5, 10, 15, 30]);
  for (const seconds of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1_800, 3_600, 7_200]) {
    frameCandidates.add(seconds * frameRate);
  }
  const candidates = [...frameCandidates].sort((left, right) => left - right);
  const pixelsPerTick = viewport.widthPx / viewportTicks(viewport).span;
  const chosen = candidates.find((frameStep) => (
    timelineTickFor(frameToSeconds(frameStep, frameRate)) * pixelsPerTick >= minimumPixelSpacing
  )) ?? candidates.at(-1)!;
  const approximateSecondsPerMark = chosen / frameRate;
  return {
    frameStep: chosen,
    approximateSecondsPerMark,
    pixelSpacing: timelineTickFor(frameToSeconds(chosen, frameRate)) * pixelsPerTick,
  };
}

/** Generate each mark from an absolute frame index so fractional frame ticks never accumulate. */
export function* iterateTimelineRulerMarks(
  viewport: TimelineViewport,
  frameRate: number,
  frameStep: number,
): Generator<TimelineRulerMark, void> {
  viewportTicks(viewport);
  if (!Number.isInteger(frameRate) || frameRate <= 0) throw new Error("Frame rate must be a positive integer");
  if (!Number.isInteger(frameStep) || frameStep <= 0) throw new Error("Ruler frame step must be a positive integer");
  const firstVisibleFrame = secondsToFrameCeil(viewport.start, frameRate);
  const lastVisibleFrame = secondsToFrameFloor(viewport.end, frameRate);
  const firstMarkFrame = Math.ceil(firstVisibleFrame / frameStep) * frameStep;
  for (let frameIndex = firstMarkFrame; frameIndex <= lastVisibleFrame; frameIndex += frameStep) {
    const time = frameToSeconds(frameIndex, frameRate);
    yield { frameIndex, time, x: timelineTimeToX(time, viewport) };
  }
}

function steppedFrameIndex(time: number, deltaFrames: number, frameRate: number): number {
  const floorFrame = secondsToFrameFloor(time, frameRate);
  const onFrame = compareTimelineTimes(frameToSeconds(floorFrame, frameRate), time) === 0;
  const adjacentFrame = deltaFrames > 0 ? secondsToFrameCeil(time, frameRate) : floorFrame;
  return adjacentFrame + (onFrame ? deltaFrames : deltaFrames - Math.sign(deltaFrames));
}

/** Step to the adjacent authored frame, then apply any remaining delta, clamped to the supplied range. */
export function stepTimelineFrame(
  time: number,
  deltaFrames: number,
  frameRate: number,
  range: Readonly<{ start: number; end: number }>,
): number {
  if (!Number.isInteger(deltaFrames)) throw new Error("Frame delta must be an integer");
  if (compareTimelineTimes(range.end, range.start) < 0) throw new Error("Frame range end must not precede its start");
  const minimumFrame = secondsToFrameCeil(range.start, frameRate);
  const maximumFrame = secondsToFrameFloor(range.end, frameRate);
  if (maximumFrame < minimumFrame) return timelineTimeForTick(timelineTickFor(range.start));
  const canonicalTime = timelineTimeForTick(timelineTickFor(time));
  if (deltaFrames === 0) {
    if (compareTimelineTimes(canonicalTime, range.start) < 0) return frameToSeconds(minimumFrame, frameRate);
    if (compareTimelineTimes(canonicalTime, range.end) > 0) return frameToSeconds(maximumFrame, frameRate);
    return canonicalTime;
  }
  const frame = Math.min(maximumFrame, Math.max(minimumFrame, steppedFrameIndex(canonicalTime, deltaFrames, frameRate)));
  return frameToSeconds(frame, frameRate);
}

export type TimelineSnapKind = "marker" | "keyframe" | "playhead" | "lifetime-edge" | "animation-edge" | "shot-edge" | "frame";

export interface TimelineSnapCandidate {
  id: string;
  kind: TimelineSnapKind;
  time: number;
}

export interface TimelineSnapResult {
  time: number;
  snapped: boolean;
  candidate?: TimelineSnapCandidate;
  distancePx?: number;
}

/** Stable priority is used only after exact pixel distance; earlier ticks and IDs break the remaining ties. */
export const TIMELINE_SNAP_PRIORITY: Readonly<Record<TimelineSnapKind, number>> = Object.freeze({
  marker: 0,
  keyframe: 1,
  playhead: 2,
  "lifetime-edge": 3,
  "animation-edge": 4,
  "shot-edge": 5,
  frame: 6,
});

export function snapTimelineTime(input: Readonly<{
  time: number;
  viewport: TimelineViewport;
  candidates: readonly TimelineSnapCandidate[];
  enabled?: boolean;
  thresholdPx?: number;
}>): TimelineSnapResult {
  const canonical = timelineTimeForTick(timelineTickFor(input.time));
  if (input.enabled === false) return { time: canonical, snapped: false };
  const threshold = input.thresholdPx ?? 6;
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Snap threshold must be nonnegative");
  const originTick = timelineTickFor(canonical);
  const ticks = viewportTicks(input.viewport);
  const ranked = input.candidates.map((candidate) => {
    const tick = timelineTickFor(candidate.time);
    return {
      candidate: { ...candidate, time: timelineTimeForTick(tick) },
      tick,
      distancePx: Math.abs(tick - originTick) * input.viewport.widthPx / ticks.span,
    };
  }).filter(({ tick, distancePx }) => tick >= ticks.start && tick <= ticks.end && distancePx <= threshold)
    .sort((left, right) => (
      left.distancePx - right.distancePx
      || TIMELINE_SNAP_PRIORITY[left.candidate.kind] - TIMELINE_SNAP_PRIORITY[right.candidate.kind]
      || left.tick - right.tick
      || left.candidate.id.localeCompare(right.candidate.id)
    ));
  const winner = ranked[0];
  return winner
    ? { time: winner.candidate.time, snapped: true, candidate: winner.candidate, distancePx: winner.distancePx }
    : { time: canonical, snapped: false };
}

export type TimelineDragKind = "keyframes" | "marker" | "lifetime" | "animation" | "shot";

export interface TimelineDragBase<Kind extends TimelineDragKind = TimelineDragKind> {
  kind: Kind;
  projectRevision: string;
  shotId: string;
  pointerStartX: number;
  viewport: TimelineViewport;
}

export type TimelineDragResolution =
  | Readonly<{ status: "active"; deltaTicks: number }>
  | Readonly<{ status: "cancelled"; reason: "project-revision-changed" | "shot-changed" }>;

/** Resolve pointer motion only while the canonical project and shot still match the drag base. */
export function resolveTimelineDrag(
  base: TimelineDragBase,
  current: Readonly<{ projectRevision: string; shotId: string; pointerX: number }>,
): TimelineDragResolution {
  if (current.projectRevision !== base.projectRevision) return { status: "cancelled", reason: "project-revision-changed" };
  if (current.shotId !== base.shotId) return { status: "cancelled", reason: "shot-changed" };
  return {
    status: "active",
    deltaTicks: timelineTickFor(timelineXToTime(current.pointerX, base.viewport, false))
      - timelineTickFor(timelineXToTime(base.pointerStartX, base.viewport, false)),
  };
}

export interface TimelineDiagnosticIntent {
  code:
    | "missing-shot"
    | "missing-track"
    | "missing-keyframe"
    | "duplicate-selection"
    | "collision"
    | "out-of-range"
    | "invalid-operation"
    | "nothing-to-change";
  message: string;
  trackId?: string;
  keyframeId?: string;
  conflictingKeyframeId?: string;
}

export type TimelineOperationIntent =
  | Readonly<{
    ok: true;
    operations: readonly SceneOperation[];
    selection: EditorSelection;
    label: string;
  }>
  | Readonly<{ ok: false; diagnostic: TimelineDiagnosticIntent }>;

function failure(diagnostic: TimelineDiagnosticIntent): TimelineOperationIntent {
  return { ok: false, diagnostic };
}

function shotFor(project: ProjectDocument, shotId: string): Shot | undefined {
  return project.shots.find(({ id }) => id === shotId);
}

function refKey(ref: EditorKeyframeRef): string {
  return `${ref.trackId}\u0000${ref.keyframeId}`;
}

type KeyframeEditorSelection = Extract<EditorSelection, { kind: "keyframes" }>;
export type TimelineKeyframeSelectionInput = readonly EditorKeyframeRef[] | KeyframeEditorSelection;

function sameRef(left: EditorKeyframeRef, right: EditorKeyframeRef): boolean {
  return left.trackId === right.trackId && left.keyframeId === right.keyframeId;
}

function isKeyframeEditorSelection(input: TimelineKeyframeSelectionInput): input is KeyframeEditorSelection {
  return !Array.isArray(input);
}

function futureKeyframeSelection(
  shotId: string,
  refs: readonly EditorKeyframeRef[],
  primary = refs.at(-1),
): EditorSelection {
  if (!refs.length) return { kind: "none", shotId };
  const resolvedPrimary = primary && refs.some((ref) => sameRef(ref, primary)) ? primary : refs.at(-1)!;
  return {
    kind: "keyframes",
    shotId,
    keyframes: [...refs.filter((ref) => !sameRef(ref, resolvedPrimary)), resolvedPrimary],
    primaryKeyframe: resolvedPrimary,
  };
}

function validateOperations(operations: readonly SceneOperation[]): TimelineDiagnosticIntent | undefined {
  for (const operation of operations) {
    const parsed = SceneOperationSchema.safeParse(operation);
    if (!parsed.success) return { code: "invalid-operation", message: parsed.error.issues[0]?.message ?? "Timeline operation is invalid" };
  }
  return undefined;
}

function preflightOperations(
  project: ProjectDocument,
  shotId: string,
  operations: readonly SceneOperation[],
): TimelineDiagnosticIntent | undefined {
  const invalid = validateOperations(operations);
  if (invalid) return invalid;
  try {
    applyOperations(project, shotId, operations);
    return undefined;
  } catch (error) {
    return { code: "invalid-operation", message: error instanceof Error ? error.message : "Timeline operation is invalid" };
  }
}

function targetRange(shot: Shot, track: PropertyTrack): { start: number; end: number } | undefined {
  if (track.target.kind === "object") return effectiveObjectLifetime(shot, track.target.objectId);
  if (track.target.kind === "audio") {
    const audioClipId = track.target.audioClipId;
    const clip = shot.audioClips.find(({ id }) => id === audioClipId);
    if (!clip) return undefined;
    return { start: clip.start, end: timelineTimeForTick(timelineTickFor(clip.start) + timelineTickFor(clip.duration)) };
  }
  return { start: 0, end: shot.duration };
}

function sortedUniqueRefs(refs: readonly EditorKeyframeRef[]): EditorKeyframeRef[] {
  return uniqueRefsInOrder(refs)
    .sort((left, right) => left.trackId.localeCompare(right.trackId) || left.keyframeId.localeCompare(right.keyframeId));
}

function uniqueRefsInOrder(refs: readonly EditorKeyframeRef[]): EditorKeyframeRef[] {
  const seen = new Set<string>();
  const result: EditorKeyframeRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...ref });
  }
  return result;
}

export function resolveUpsertKeyframe(
  project: ProjectDocument,
  shotId: string,
  input: Readonly<{
    target: PropertyTrackTarget;
    property: PropertyTrack["property"];
    time: number;
    value: PropertyKeyframe["value"];
    interpolation?: KeyframeInterpolation;
  }>,
): TimelineOperationIntent {
  const shot = shotFor(project, shotId);
  if (!shot) return failure({ code: "missing-shot", message: `Shot not found: ${shotId}` });
  let time: number;
  try {
    time = timelineTimeForTick(timelineTickFor(input.time));
  } catch (error) {
    return failure({ code: "invalid-operation", message: error instanceof Error ? error.message : "Keyframe time is invalid" });
  }
  const track = shot.propertyTracks.find((candidate) => propertyTrackKey(candidate) === propertyTrackKey({ target: input.target, property: input.property }));
  if (track) {
    const existing = track.keyframes.find((keyframe) => compareTimelineTimes(keyframe.time, time) === 0);
    if (existing) {
      const interpolation = cloneSerializable(input.interpolation ?? existing.interpolation);
      if (existing.value === input.value && JSON.stringify(existing.interpolation) === JSON.stringify(interpolation)) {
        return failure({ code: "nothing-to-change", message: `Keyframe ${existing.id} already has the requested value`, trackId: track.id, keyframeId: existing.id });
      }
      const operations: SceneOperation[] = [{ type: "update-keyframe", trackId: track.id, keyframeId: existing.id, patch: { value: input.value, interpolation } }];
      const invalid = preflightOperations(project, shotId, operations);
      return invalid ? failure(invalid) : {
        ok: true,
        operations,
        selection: futureKeyframeSelection(shotId, [{ trackId: track.id, keyframeId: existing.id }]),
        label: `Update ${input.property} keyframe`,
      };
    }
    const ids = collectProjectIds(project);
    const keyframeId = allocateId("keyframe", ids, `${track.id}-${timelineTickFor(time)}`);
    const interpolation = cloneSerializable(input.interpolation ?? { kind: "linear" as const });
    const operations: SceneOperation[] = [{
      type: "add-keyframe",
      trackId: track.id,
      keyframe: { id: keyframeId, time, value: input.value, interpolation },
    }];
    const invalid = preflightOperations(project, shotId, operations);
    return invalid ? failure(invalid) : {
      ok: true,
      operations,
      selection: futureKeyframeSelection(shotId, [{ trackId: track.id, keyframeId }]),
      label: `Add ${input.property} keyframe`,
    };
  }
  const ids = collectProjectIds(project);
  const target = input.target;
  const targetHint = target.kind === "object" ? target.objectId : target.kind === "audio" ? target.audioClipId : "camera";
  const trackId = allocateId("track", ids, `${targetHint}-${input.property}`);
  ids.add(trackId);
  const keyframeId = allocateId("keyframe", ids, `${trackId}-${timelineTickFor(time)}`);
  const interpolation = cloneSerializable(input.interpolation ?? { kind: "linear" as const });
  const operations: SceneOperation[] = [{
    type: "add-property-track",
    track: {
      id: trackId,
      target: cloneSerializable(input.target),
      property: input.property,
      keyframes: [{ id: keyframeId, time, value: input.value, interpolation }],
    },
  }];
  const invalid = preflightOperations(project, shotId, operations);
  return invalid ? failure(invalid) : {
    ok: true,
    operations,
    selection: futureKeyframeSelection(shotId, [{ trackId, keyframeId }]),
    label: `Create ${input.property} track`,
  };
}

export function resolveDeleteKeyframes(
  project: ProjectDocument,
  shotId: string,
  refs: readonly EditorKeyframeRef[],
): TimelineOperationIntent {
  const shot = shotFor(project, shotId);
  if (!shot) return failure({ code: "missing-shot", message: `Shot not found: ${shotId}` });
  const selected = sortedUniqueRefs(refs);
  if (!selected.length) return failure({ code: "nothing-to-change", message: "No keyframes are selected" });
  const selectedByTrack = new Map<string, Set<string>>();
  for (const ref of selected) {
    const track = shot.propertyTracks.find(({ id }) => id === ref.trackId);
    if (!track) return failure({ code: "missing-track", message: `Property track not found: ${ref.trackId}`, trackId: ref.trackId });
    if (!track.keyframes.some(({ id }) => id === ref.keyframeId)) {
      return failure({ code: "missing-keyframe", message: `Keyframe not found: ${ref.keyframeId}`, trackId: ref.trackId, keyframeId: ref.keyframeId });
    }
    const ids = selectedByTrack.get(ref.trackId) ?? new Set<string>();
    ids.add(ref.keyframeId);
    selectedByTrack.set(ref.trackId, ids);
  }
  const operations: SceneOperation[] = [];
  for (const [trackId, keyframeIds] of [...selectedByTrack].sort(([left], [right]) => left.localeCompare(right))) {
    const track = shot.propertyTracks.find(({ id }) => id === trackId)!;
    if (keyframeIds.size === track.keyframes.length) operations.push({ type: "delete-property-track", trackId });
    else for (const keyframe of track.keyframes.filter(({ id }) => keyframeIds.has(id))) {
      operations.push({ type: "delete-keyframe", trackId, keyframeId: keyframe.id });
    }
  }
  return {
    ok: true,
    operations,
    selection: { kind: "none", shotId },
    label: operations.length === 1 ? "Delete keyframe" : `Delete ${selected.length} keyframes`,
  };
}

function selectedKeyframes(
  shot: Shot,
  input: TimelineKeyframeSelectionInput,
  explicitPrimary?: EditorKeyframeRef,
): {
  selected?: Array<{ track: PropertyTrack; keyframe: PropertyKeyframe }>;
  selectionRefs?: EditorKeyframeRef[];
  primary?: EditorKeyframeRef;
  diagnostic?: TimelineDiagnosticIntent;
} {
  if (isKeyframeEditorSelection(input) && input.shotId !== shot.id) {
    return { diagnostic: { code: "missing-shot", message: `Keyframe selection belongs to shot ${input.shotId}, not ${shot.id}` } };
  }
  const refs = isKeyframeEditorSelection(input) ? input.keyframes : input;
  const uniqueRefs = uniqueRefsInOrder(refs);
  if (!uniqueRefs.length) return { diagnostic: { code: "nothing-to-change", message: "No keyframes are selected" } };
  const selected: Array<{ track: PropertyTrack; keyframe: PropertyKeyframe }> = [];
  for (const ref of uniqueRefs) {
    const track = shot.propertyTracks.find(({ id }) => id === ref.trackId);
    if (!track) return { diagnostic: { code: "missing-track", message: `Property track not found: ${ref.trackId}`, trackId: ref.trackId } };
    const keyframe = track.keyframes.find(({ id }) => id === ref.keyframeId);
    if (!keyframe) return { diagnostic: { code: "missing-keyframe", message: `Keyframe not found: ${ref.keyframeId}`, trackId: ref.trackId, keyframeId: ref.keyframeId } };
    selected.push({ track, keyframe });
  }
  const requestedPrimary = explicitPrimary ?? (isKeyframeEditorSelection(input) ? input.primaryKeyframe : uniqueRefs.at(-1));
  const primary = requestedPrimary && uniqueRefs.some((ref) => sameRef(ref, requestedPrimary)) ? requestedPrimary : uniqueRefs.at(-1)!;
  return {
    selected: selected.sort((left, right) => (
      left.track.id.localeCompare(right.track.id)
      || compareTimelineTimes(left.keyframe.time, right.keyframe.time)
      || left.keyframe.id.localeCompare(right.keyframe.id)
    )),
    selectionRefs: uniqueRefs,
    primary,
  };
}

function resolveDestinationTicks(
  shot: Shot,
  selected: readonly { track: PropertyTrack; keyframe: PropertyKeyframe }[],
  deltaTicks: number,
  vacateSelected = true,
): { destinations?: Map<string, number>; diagnostic?: TimelineDiagnosticIntent } {
  if (!Number.isSafeInteger(deltaTicks)) return { diagnostic: { code: "out-of-range", message: "Keyframe move delta must use safe canonical ticks" } };
  const selectedIds = vacateSelected
    ? new Set(selected.map(({ track, keyframe }) => refKey({ trackId: track.id, keyframeId: keyframe.id })))
    : new Set<string>();
  const destinations = new Map<string, number>();
  for (const { track, keyframe } of selected) {
    const tick = timelineTickFor(keyframe.time) + deltaTicks;
    let time: number;
    try {
      time = timelineTimeForTick(tick);
    } catch {
      return { diagnostic: { code: "out-of-range", message: `Keyframe ${keyframe.id} would leave the authored timeline`, trackId: track.id, keyframeId: keyframe.id } };
    }
    const range = targetRange(shot, track);
    if (!range || compareTimelineTimes(time, range.start) < 0 || compareTimelineTimes(time, range.end) > 0) {
      return { diagnostic: { code: "out-of-range", message: `Keyframe ${keyframe.id} would leave track ${track.id}'s target lifetime`, trackId: track.id, keyframeId: keyframe.id } };
    }
    const collision = track.keyframes.find((candidate) => (
      !selectedIds.has(refKey({ trackId: track.id, keyframeId: candidate.id }))
      && timelineTickFor(candidate.time) === tick
    ));
    if (collision) return {
      diagnostic: {
        code: "collision",
        message: `Keyframe ${keyframe.id} would collide with ${collision.id} on track ${track.id}`,
        trackId: track.id,
        keyframeId: keyframe.id,
        conflictingKeyframeId: collision.id,
      },
    };
    const destinationKey = `${track.id}\u0000${tick}`;
    const prior = destinations.get(destinationKey);
    if (prior !== undefined) return { diagnostic: { code: "collision", message: `Multiple selected keyframes would share tick ${tick} on track ${track.id}`, trackId: track.id } };
    destinations.set(destinationKey, tick);
  }
  return { destinations };
}

export function resolveMoveKeyframes(
  project: ProjectDocument,
  shotId: string,
  selection: TimelineKeyframeSelectionInput,
  deltaTicks: number,
  primary?: EditorKeyframeRef,
): TimelineOperationIntent {
  const shot = shotFor(project, shotId);
  if (!shot) return failure({ code: "missing-shot", message: `Shot not found: ${shotId}` });
  if (deltaTicks === 0) return failure({ code: "nothing-to-change", message: "Keyframe move has zero delta" });
  const resolved = selectedKeyframes(shot, selection, primary);
  if (resolved.diagnostic) return failure(resolved.diagnostic);
  const destinations = resolveDestinationTicks(shot, resolved.selected!, deltaTicks);
  if (destinations.diagnostic) return failure(destinations.diagnostic);
  const operations: SceneOperation[] = resolved.selected!.map(({ track, keyframe }) => ({
    type: "move-keyframe",
    trackId: track.id,
    keyframeId: keyframe.id,
    time: timelineTimeForTick(timelineTickFor(keyframe.time) + deltaTicks),
  }));
  const invalid = validateOperations(operations);
  return invalid ? failure(invalid) : {
    ok: true,
    operations,
    selection: keyframeSelection(shot, resolved.selectionRefs!, resolved.primary),
    label: operations.length === 1 ? "Move keyframe" : `Move ${operations.length} keyframes`,
  };
}

export interface TimelineKeyframeClipboardEntry {
  sourceTrackId: string;
  sourceKeyframeId: string;
  offsetTicks: number;
  value: PropertyKeyframe["value"];
  interpolation: KeyframeInterpolation;
}

export interface TimelineKeyframeClipboard {
  sourceShotId: string;
  primarySourceKeyframe: EditorKeyframeRef;
  entries: readonly TimelineKeyframeClipboardEntry[];
}

export function copyKeyframes(
  project: ProjectDocument,
  shotId: string,
  selection: TimelineKeyframeSelectionInput,
  primary?: EditorKeyframeRef,
): TimelineKeyframeClipboard | TimelineDiagnosticIntent {
  const shot = shotFor(project, shotId);
  if (!shot) return { code: "missing-shot", message: `Shot not found: ${shotId}` };
  const resolved = selectedKeyframes(shot, selection, primary);
  if (resolved.diagnostic) return resolved.diagnostic;
  const anchorTick = Math.min(...resolved.selected!.map(({ keyframe }) => timelineTickFor(keyframe.time)));
  return {
    sourceShotId: shotId,
    primarySourceKeyframe: resolved.primary!,
    entries: resolved.selected!.map(({ track, keyframe }) => ({
      sourceTrackId: track.id,
      sourceKeyframeId: keyframe.id,
      offsetTicks: timelineTickFor(keyframe.time) - anchorTick,
      value: keyframe.value,
      interpolation: cloneSerializable(keyframe.interpolation),
    })),
  };
}

function pasteDestinations(
  project: ProjectDocument,
  shot: Shot,
  clipboard: TimelineKeyframeClipboard,
  anchorTick: number,
  primarySource = clipboard.primarySourceKeyframe,
): TimelineOperationIntent {
  const ids = collectProjectIds(project);
  const operations: SceneOperation[] = [];
  const refs: EditorKeyframeRef[] = [];
  const refsBySource = new Map<string, EditorKeyframeRef>();
  const occupied = new Map(shot.propertyTracks.map((track) => [track.id, new Set(track.keyframes.map(({ time }) => timelineTickFor(time)))]));
  for (const entry of clipboard.entries) {
    const track = shot.propertyTracks.find(({ id }) => id === entry.sourceTrackId);
    if (!track) return failure({ code: "missing-track", message: `Paste target track not found: ${entry.sourceTrackId}`, trackId: entry.sourceTrackId });
    const tick = anchorTick + entry.offsetTicks;
    let time: number;
    try {
      time = timelineTimeForTick(tick);
    } catch {
      return failure({ code: "out-of-range", message: `Pasted keyframe from ${entry.sourceKeyframeId} would leave the authored timeline`, trackId: track.id, keyframeId: entry.sourceKeyframeId });
    }
    const range = targetRange(shot, track);
    if (!range || compareTimelineTimes(time, range.start) < 0 || compareTimelineTimes(time, range.end) > 0) {
      return failure({ code: "out-of-range", message: `Pasted keyframe from ${entry.sourceKeyframeId} would leave track ${track.id}'s target lifetime`, trackId: track.id, keyframeId: entry.sourceKeyframeId });
    }
    if (occupied.get(track.id)?.has(tick)) {
      const conflicting = track.keyframes.find((keyframe) => timelineTickFor(keyframe.time) === tick)!;
      return failure({ code: "collision", message: `Pasted keyframe would collide with ${conflicting.id} on track ${track.id}`, trackId: track.id, keyframeId: entry.sourceKeyframeId, conflictingKeyframeId: conflicting.id });
    }
    occupied.get(track.id)!.add(tick);
    const keyframeId = allocateId("keyframe", ids, `${track.id}-${tick}`);
    ids.add(keyframeId);
    operations.push({
      type: "add-keyframe",
      trackId: track.id,
      keyframe: { id: keyframeId, time, value: entry.value, interpolation: cloneSerializable(entry.interpolation) },
    });
    refs.push({ trackId: track.id, keyframeId });
    refsBySource.set(refKey({ trackId: entry.sourceTrackId, keyframeId: entry.sourceKeyframeId }), { trackId: track.id, keyframeId });
  }
  const invalid = validateOperations(operations);
  const mappedPrimary = refsBySource.get(refKey(primarySource));
  return invalid ? failure(invalid) : { ok: true, operations, selection: futureKeyframeSelection(shot.id, refs, mappedPrimary), label: operations.length === 1 ? "Paste keyframe" : `Paste ${operations.length} keyframes` };
}

export function resolvePasteKeyframes(
  project: ProjectDocument,
  shotId: string,
  clipboard: TimelineKeyframeClipboard,
  anchorTime: number,
  primarySource?: EditorKeyframeRef,
): TimelineOperationIntent {
  const shot = shotFor(project, shotId);
  if (!shot) return failure({ code: "missing-shot", message: `Shot not found: ${shotId}` });
  if (!clipboard.entries.length) return failure({ code: "nothing-to-change", message: "Keyframe clipboard is empty" });
  return pasteDestinations(project, shot, clipboard, timelineTickFor(anchorTime), primarySource);
}

export function resolveDuplicateKeyframes(
  project: ProjectDocument,
  shotId: string,
  selection: TimelineKeyframeSelectionInput,
  deltaTicks: number,
  primary?: EditorKeyframeRef,
): TimelineOperationIntent {
  const shot = shotFor(project, shotId);
  if (!shot) return failure({ code: "missing-shot", message: `Shot not found: ${shotId}` });
  if (deltaTicks === 0) return failure({ code: "collision", message: "Duplicated keyframes require a non-zero time delta" });
  const resolved = selectedKeyframes(shot, selection, primary);
  if (resolved.diagnostic) return failure(resolved.diagnostic);
  const destinations = resolveDestinationTicks(shot, resolved.selected!, deltaTicks, false);
  if (destinations.diagnostic) return failure(destinations.diagnostic);
  const ids = collectProjectIds(project);
  const refsAfter: EditorKeyframeRef[] = [];
  const refsBySource = new Map<string, EditorKeyframeRef>();
  const operations: SceneOperation[] = resolved.selected!.map(({ track, keyframe }) => {
    const time = timelineTimeForTick(timelineTickFor(keyframe.time) + deltaTicks);
    const duplicateId = allocateId("keyframe", ids, `${track.id}-${timelineTickFor(time)}`);
    ids.add(duplicateId);
    const duplicateRef = { trackId: track.id, keyframeId: duplicateId };
    refsAfter.push(duplicateRef);
    refsBySource.set(refKey({ trackId: track.id, keyframeId: keyframe.id }), duplicateRef);
    return { type: "duplicate-keyframe", trackId: track.id, keyframeId: keyframe.id, duplicateId, time };
  });
  const invalid = validateOperations(operations);
  return invalid ? failure(invalid) : {
    ok: true,
    operations,
    selection: futureKeyframeSelection(shotId, refsAfter, refsBySource.get(refKey(resolved.primary!))),
    label: operations.length === 1 ? "Duplicate keyframe" : `Duplicate ${operations.length} keyframes`,
  };
}

/** Convert an integer frame delta to the exact canonical tick delta used by authoring intents. */
export function timelineTicksForFrameDelta(time: number, deltaFrames: number, frameRate: number): number {
  if (!Number.isInteger(deltaFrames)) throw new Error("Frame delta must be an integer");
  const canonicalTime = timelineTimeForTick(timelineTickFor(time));
  if (deltaFrames === 0) return 0;
  return timelineTickFor(frameToSeconds(steppedFrameIndex(canonicalTime, deltaFrames, frameRate), frameRate))
    - timelineTickFor(canonicalTime);
}

export const TIMELINE_TICKS_PER_SECOND = PROOFCANVAS_TIMELINE_TICKS_PER_SECOND;
