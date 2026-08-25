import { keyframeSelection, objectSelection, type EditorKeyframeRef, type EditorSelection } from "./editorSelection";
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
import {
  ManualSceneOperationSchema,
  applyOperations,
  effectiveLockOwner,
  type ManualSceneOperation,
} from "./operations";
import {
  cloneSerializable,
  type KeyframeInterpolation,
  type ObjectLifetime,
  type ProjectDocument,
  type PropertyKeyframe,
  type PropertyTrack,
  type PropertyTrackTarget,
  type Shot,
} from "./schema";
import { effectiveObjectLifetime, orderedPropertyTracks, propertyTrackKey } from "./timeline";

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
    | "missing-object"
    | "locked"
    | "dependent-out-of-range"
    | "duplicate-selection"
    | "collision"
    | "out-of-range"
    | "invalid-operation"
    | "nothing-to-change";
  message: string;
  trackId?: string;
  keyframeId?: string;
  objectId?: string;
  conflictingKeyframeId?: string;
}

export type TimelineOperationIntent =
  | Readonly<{
    ok: true;
    operations: readonly ManualSceneOperation[];
    selection: EditorSelection;
    label: string;
  }>
  | Readonly<{ ok: false; diagnostic: TimelineDiagnosticIntent }>;

export interface TimelineIntentAuthorityBase {
  projectRevision: string;
  shotId: string;
}

/**
 * Timeline resolvers preflight against an immutable render snapshot. The UI
 * must reject their operations if either the project or active shot has moved
 * on before the intent reaches the latest editor authority.
 */
export function timelineIntentAuthorityIsCurrent(
  expected: TimelineIntentAuthorityBase,
  latest: TimelineIntentAuthorityBase,
): boolean {
  return expected.projectRevision === latest.projectRevision && expected.shotId === latest.shotId;
}

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

function validateOperations(operations: readonly ManualSceneOperation[]): TimelineDiagnosticIntent | undefined {
  for (const operation of operations) {
    const parsed = ManualSceneOperationSchema.safeParse(operation);
    if (!parsed.success) return { code: "invalid-operation", message: parsed.error.issues[0]?.message ?? "Timeline operation is invalid" };
  }
  return undefined;
}

function preflightOperations(
  project: ProjectDocument,
  shotId: string,
  operations: readonly ManualSceneOperation[],
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

/** The effective range contributed by a shot and an object's ancestors, excluding the object itself. */
export function inheritedObjectLifetime(shot: Shot, objectId: string): ObjectLifetime | undefined {
  const object = shot.objects.find(({ id }) => id === objectId);
  if (!object) return undefined;
  const byId = new Map(shot.objects.map((candidate) => [candidate.id, candidate]));
  let cursor = object.parentId ? byId.get(object.parentId) : undefined;
  let start = 0;
  let end = shot.duration;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor.id)) return undefined;
    visited.add(cursor.id);
    if (cursor.lifetime) {
      start = Math.max(start, cursor.lifetime.start);
      end = Math.min(end, cursor.lifetime.end);
    }
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return {
    start: timelineTimeForTick(timelineTickFor(start)),
    end: timelineTimeForTick(timelineTickFor(end)),
  };
}

export type ObjectLifetimeEdit =
  | Readonly<{ objectId: string; mode: "entire" }>
  | Readonly<{ objectId: string; mode: "set"; start: number; end: number }>
  | Readonly<{ objectId: string; mode: "move"; deltaTicks: number }>
  | Readonly<{ objectId: string; mode: "trim-start" | "trim-end"; time: number }>;

export type EditorTimelineRow =
  | Readonly<{ kind: "camera"; id: "timeline-camera" }>
  | Readonly<{ kind: "camera-property"; id: string; track: PropertyTrack }>
  | Readonly<{
    kind: "object-lifetime";
    id: string;
    objectId: string;
    depth: number;
    authored?: ObjectLifetime;
    inherited: ObjectLifetime;
    effective: ObjectLifetime;
    locked: boolean;
  }>
  | Readonly<{ kind: "object-property"; id: string; objectId: string; depth: number; track: PropertyTrack }>;

/**
 * Project one deterministic editor row order: camera first, then object
 * hierarchy preorder with each lifetime immediately followed by its property
 * tracks. This is derived display state, never a second timeline authority.
 */
export function projectEditorTimelineRows(shot: Shot): EditorTimelineRow[] {
  const orderedTracks = orderedPropertyTracks(shot).filter(({ target }) => target.kind !== "audio");
  const rows: EditorTimelineRow[] = [{ kind: "camera", id: "timeline-camera" }];
  for (const track of orderedTracks.filter(({ target }) => target.kind === "camera")) {
    rows.push({ kind: "camera-property", id: `timeline-track-${track.id}`, track });
  }
  const children = new Map<string | null, typeof shot.objects>();
  for (const object of shot.objects) {
    const key = object.parentId ?? null;
    const siblings = children.get(key) ?? [];
    siblings.push(object);
    children.set(key, siblings);
  }
  const visited = new Set<string>();
  const appendObject = (objectId: string, depth: number) => {
    if (visited.has(objectId)) return;
    visited.add(objectId);
    const object = shot.objects.find(({ id }) => id === objectId);
    if (!object) return;
    const inherited = inheritedObjectLifetime(shot, object.id) ?? { start: 0, end: shot.duration };
    const effective = effectiveObjectLifetime(shot, object.id) ?? inherited;
    rows.push({
      kind: "object-lifetime",
      id: `timeline-lifetime-${object.id}`,
      objectId: object.id,
      depth,
      ...(object.lifetime ? { authored: cloneSerializable(object.lifetime) } : {}),
      inherited,
      effective,
      locked: Boolean(effectiveLockOwner(shot, object)),
    });
    for (const track of orderedTracks.filter((candidate) => candidate.target.kind === "object" && candidate.target.objectId === object.id)) {
      rows.push({ kind: "object-property", id: `timeline-track-${track.id}`, objectId: object.id, depth, track });
    }
    for (const child of children.get(object.id) ?? []) appendObject(child.id, depth + 1);
  };
  for (const root of children.get(null) ?? []) appendObject(root.id, 0);
  // Valid documents cannot contain orphaned/cyclic hierarchy, but retain a
  // stable fail-closed projection for recovery tooling and partial fixtures.
  for (const object of shot.objects) if (!visited.has(object.id)) appendObject(object.id, 0);
  return rows;
}

function canonicalLifetime(
  shot: Shot,
  objectId: string,
  input: Exclude<ObjectLifetimeEdit, { mode: "entire" }>,
): ObjectLifetime | TimelineDiagnosticIntent {
  const inherited = inheritedObjectLifetime(shot, objectId);
  if (!inherited) return { code: "missing-object", message: `Object not found: ${objectId}`, objectId };
  const object = shot.objects.find(({ id }) => id === objectId)!;
  const current = object.lifetime ?? effectiveObjectLifetime(shot, objectId) ?? inherited;
  let start: number;
  let end: number;
  try {
    if (input.mode === "set") {
      start = timelineTimeForTick(timelineTickFor(input.start));
      end = timelineTimeForTick(timelineTickFor(input.end));
    } else if (input.mode === "move") {
      if (!Number.isSafeInteger(input.deltaTicks)) {
        return { code: "out-of-range", message: "Lifetime move delta must use safe canonical ticks", objectId };
      }
      start = timelineTimeForTick(timelineTickFor(current.start) + input.deltaTicks);
      end = timelineTimeForTick(timelineTickFor(current.end) + input.deltaTicks);
    } else {
      const time = timelineTimeForTick(timelineTickFor(input.time));
      start = input.mode === "trim-start" ? time : current.start;
      end = input.mode === "trim-end" ? time : current.end;
    }
  } catch (error) {
    return { code: "out-of-range", message: error instanceof Error ? error.message : "Object lifetime is outside the authored timeline", objectId };
  }
  if (timelineTickFor(end) - timelineTickFor(start) < 1) {
    return { code: "out-of-range", message: "Object lifetime must span at least one canonical timeline tick", objectId };
  }
  if (compareTimelineTimes(start, inherited.start) < 0 || compareTimelineTimes(end, inherited.end) > 0) {
    return {
      code: "out-of-range",
      message: `Object lifetime must stay inside inherited bounds ${inherited.start}s–${inherited.end}s`,
      objectId,
    };
  }
  return { start, end };
}

function lifetimePreflightDiagnostic(
  project: ProjectDocument,
  shotId: string,
  operation: ManualSceneOperation,
  objectId: string,
): TimelineDiagnosticIntent | undefined {
  const invalid = preflightOperations(project, shotId, [operation]);
  if (!invalid) return undefined;
  if (/locked/i.test(invalid.message)) return { ...invalid, code: "locked", objectId };
  if (/lifetime|animation|keyframe|track|contained|boundary/i.test(invalid.message)) {
    return { ...invalid, code: "dependent-out-of-range", objectId };
  }
  return { ...invalid, objectId };
}

/**
 * Resolve one atomic object-lifetime authoring intent. Move/trim inputs are
 * relative to the current effective range; persisted endpoints always use the
 * canonical tick grid. The operations boundary preflights descendants,
 * semantic animations, and property keys as one transaction before anything
 * is published.
 */
export function resolveSetObjectLifetime(
  project: ProjectDocument,
  shotId: string,
  input: ObjectLifetimeEdit,
): TimelineOperationIntent {
  const shot = shotFor(project, shotId);
  if (!shot) return failure({ code: "missing-shot", message: `Shot not found: ${shotId}` });
  const object = shot.objects.find(({ id }) => id === input.objectId);
  if (!object) return failure({ code: "missing-object", message: `Object not found: ${input.objectId}`, objectId: input.objectId });
  const lockOwner = effectiveLockOwner(shot, object);
  if (lockOwner) return failure({ code: "locked", message: `Object lifetime is locked by ${lockOwner.name}`, objectId: object.id });

  if (input.mode === "entire") {
    if (!object.lifetime) return failure({ code: "nothing-to-change", message: `${object.name} already uses its entire inherited lifetime`, objectId: object.id });
    const operation: ManualSceneOperation = { type: "clear-object-lifetime", objectId: object.id };
    const invalid = lifetimePreflightDiagnostic(project, shotId, operation, object.id);
    return invalid ? failure(invalid) : {
      ok: true,
      operations: [operation],
      selection: objectSelection(shot, [object.id]),
      label: `Use entire lifetime for ${object.name}`,
    };
  }

  const lifetime = canonicalLifetime(shot, object.id, input);
  if ("code" in lifetime) return failure(lifetime);
  if (object.lifetime
    && compareTimelineTimes(object.lifetime.start, lifetime.start) === 0
    && compareTimelineTimes(object.lifetime.end, lifetime.end) === 0) {
    return failure({ code: "nothing-to-change", message: `${object.name} already has the requested lifetime`, objectId: object.id });
  }
  const operation: ManualSceneOperation = { type: "set-object-lifetime", objectId: object.id, lifetime };
  const invalid = lifetimePreflightDiagnostic(project, shotId, operation, object.id);
  if (invalid) return failure(invalid);
  const action = input.mode === "move" ? "Move" : input.mode.startsWith("trim") ? "Trim" : "Set";
  return {
    ok: true,
    operations: [operation],
    selection: objectSelection(shot, [object.id]),
    label: `${action} ${object.name} lifetime`,
  };
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
      const operations: ManualSceneOperation[] = [{ type: "update-keyframe", trackId: track.id, keyframeId: existing.id, patch: { value: input.value, interpolation } }];
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
    const operations: ManualSceneOperation[] = [{
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
  const operations: ManualSceneOperation[] = [{
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
  const operations: ManualSceneOperation[] = [];
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

export interface LocatedEditorKeyframe {
  track: PropertyTrack;
  keyframe: PropertyKeyframe;
  ref: EditorKeyframeRef;
}

/** Resolve a keyframe reference without allowing a stale selection to drift to another track. */
export function findEditorKeyframe(shot: Shot, ref: EditorKeyframeRef): LocatedEditorKeyframe | undefined {
  const track = shot.propertyTracks.find(({ id }) => id === ref.trackId);
  const keyframe = track?.keyframes.find(({ id }) => id === ref.keyframeId);
  return track && keyframe ? { track, keyframe, ref: { ...ref } } : undefined;
}

/** Find the exact key on a canonical tick, if one exists. */
export function keyframeAtTimelineTime(
  shot: Shot,
  trackId: string,
  time: number,
): EditorKeyframeRef | undefined {
  const track = shot.propertyTracks.find(({ id }) => id === trackId);
  if (!track) return undefined;
  let tick: number;
  try {
    tick = timelineTickFor(time);
  } catch {
    return undefined;
  }
  const keyframe = track.keyframes.find((candidate) => timelineTickFor(candidate.time) === tick);
  return keyframe ? { trackId, keyframeId: keyframe.id } : undefined;
}

/** Navigate within the referenced property's stable authored time order. */
export function adjacentKeyframeRef(
  shot: Shot,
  ref: EditorKeyframeRef,
  direction: "previous" | "next",
): EditorKeyframeRef | undefined {
  const located = findEditorKeyframe(shot, ref);
  if (!located) return undefined;
  const index = located.track.keyframes.findIndex(({ id }) => id === ref.keyframeId);
  const adjacent = located.track.keyframes[index + (direction === "previous" ? -1 : 1)];
  return adjacent ? { trackId: located.track.id, keyframeId: adjacent.id } : undefined;
}

/** Apply one outgoing-segment interpolation to every selected key atomically. */
export function resolveSetKeyframeInterpolation(
  project: ProjectDocument,
  shotId: string,
  selection: TimelineKeyframeSelectionInput,
  interpolation: KeyframeInterpolation,
  primary?: EditorKeyframeRef,
): TimelineOperationIntent {
  const shot = shotFor(project, shotId);
  if (!shot) return failure({ code: "missing-shot", message: `Shot not found: ${shotId}` });
  const resolved = selectedKeyframes(shot, selection, primary);
  if (resolved.diagnostic) return failure(resolved.diagnostic);
  const requested = cloneSerializable(interpolation);
  const operations: ManualSceneOperation[] = resolved.selected!
    .filter(({ track, keyframe }) => track.keyframes.at(-1)?.id !== keyframe.id)
    .filter(({ keyframe }) => JSON.stringify(keyframe.interpolation) !== JSON.stringify(requested))
    .map(({ track, keyframe }) => ({
      type: "update-keyframe",
      trackId: track.id,
      keyframeId: keyframe.id,
      patch: { interpolation: cloneSerializable(requested) },
    }));
  if (!operations.length) return failure({ code: "nothing-to-change", message: "Selected keyframes have no outgoing segment to change, or already use this interpolation" });
  const invalid = preflightOperations(project, shotId, operations);
  return invalid ? failure(invalid) : {
    ok: true,
    operations,
    selection: keyframeSelection(shot, resolved.selectionRefs!, resolved.primary),
    label: operations.length === 1 ? "Set keyframe interpolation" : `Set interpolation for ${operations.length} keyframes`,
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
  const operations: ManualSceneOperation[] = resolved.selected!.map(({ track, keyframe }) => ({
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
  const operations: ManualSceneOperation[] = [];
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
  const operations: ManualSceneOperation[] = resolved.selected!.map(({ track, keyframe }) => {
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
