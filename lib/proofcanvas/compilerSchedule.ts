import {
  PROOFCANVAS_SCHEMA_LIMITS,
  propertyTrackValueValid,
  type Easing,
  type KeyframeInterpolation,
  type ProjectDocument,
  type PropertyTrack,
  type PropertyTrackTarget,
  type SceneAnimation,
  type SceneObject,
  type Shot,
} from "./schema";
import { easingProgressBounds } from "./easing";
import {
  addTimelineTimes,
  compareTimelineEventStarts,
  compareTimelineTimes,
  positiveTimelineIntervalsOverlap,
  subtractTimelineTimes,
  timelineTickFor,
} from "./frame";
import { effectiveObjectLifetime, orderedPropertyTracks } from "./timeline";

export type CompilerRateFunction =
  | { kind: "named"; easing: Easing }
  | { kind: "hold" }
  | { kind: "custom-bezier"; curve: { x1: number; y1: number; x2: number; y2: number } };

interface CompilerEventBase {
  id: string;
  start: number;
  end: number;
  animation: SceneAnimation;
  rateFunction: CompilerRateFunction;
}

export interface CompilerSemanticEvent extends CompilerEventBase {
  kind: "semantic";
}

export interface CompilerPropertySpanEvent extends CompilerEventBase {
  kind: "property-span";
  target: Exclude<PropertyTrackTarget, { kind: "audio" }>;
  trackIds: string[];
  propertyNames: PropertyTrack["property"][];
  point: boolean;
}

export interface CompilerLifetimeEnterEvent extends CompilerEventBase {
  kind: "lifetime-enter";
  objectId: string;
}

export interface CompilerLifetimeExitEvent extends CompilerEventBase {
  kind: "lifetime-exit";
  objectId: string;
}

export type CompilerEvent =
  | CompilerSemanticEvent
  | CompilerPropertySpanEvent
  | CompilerLifetimeEnterEvent
  | CompilerLifetimeExitEvent;

export interface CompilerScheduleDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  objectId?: string;
  animationId?: string;
  trackId?: string;
}

export interface CompilerSchedule {
  shot: Shot;
  events: CompilerEvent[];
  diagnostics: CompilerScheduleDiagnostic[];
  rejectedTrackIds: ReadonlySet<string>;
  workCount: number;
  helpers: { cubicBezier: boolean };
}

function eventPhase(event: CompilerEvent): number {
  if (event.kind === "lifetime-enter") return 0;
  if (event.kind === "property-span" && event.point) return 1;
  if (event.kind === "lifetime-exit") return 2;
  return 3;
}

/** Canonical schedule order is time, semantic phase, completion time, then stable ID. */
export function compareCompilerEvents(left: CompilerEvent, right: CompilerEvent): number {
  return compareTimelineEventStarts(left, right)
    || eventPhase(left) - eventPhase(right)
    || compareTimelineTimes(left.end, right.end)
    || left.id.localeCompare(right.id);
}

function cubicCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}

/** Exact output bounds for the cubic Y polynomial over t in [0, 1]. */
export function cubicBezierProgressBounds(curve: { y1: number; y2: number }): readonly [number, number] {
  const a = 3 * curve.y1 - 3 * curve.y2 + 1;
  const b = -6 * curve.y1 + 3 * curve.y2;
  const c = 3 * curve.y1;
  const candidates = [0, 1];
  const quadraticA = 3 * a;
  const quadraticB = 2 * b;
  if (Math.abs(quadraticA) <= Number.EPSILON) {
    if (Math.abs(quadraticB) > Number.EPSILON) candidates.push(-c / quadraticB);
  } else {
    const discriminant = quadraticB * quadraticB - 4 * quadraticA * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      candidates.push((-quadraticB - root) / (2 * quadraticA));
      candidates.push((-quadraticB + root) / (2 * quadraticA));
    }
  }
  const values = candidates
    .filter((candidate) => candidate >= 0 && candidate <= 1 && Number.isFinite(candidate))
    .map((candidate) => cubicCoordinate(candidate, curve.y1, curve.y2));
  return [Math.min(...values), Math.max(...values)];
}

function rateFor(interpolation: KeyframeInterpolation): CompilerRateFunction {
  if (interpolation.kind === "hold") return { kind: "hold" };
  if (interpolation.kind === "linear") return { kind: "named", easing: "linear" };
  if (interpolation.kind === "eased") return { kind: "named", easing: interpolation.easing };
  return { kind: "custom-bezier", curve: { ...interpolation.curve } };
}

function rateKey(rate: CompilerRateFunction): string {
  if (rate.kind === "named") return `named:${rate.easing}`;
  if (rate.kind === "hold") return "hold";
  return `bezier:${rate.curve.x1}:${rate.curve.y1}:${rate.curve.x2}:${rate.curve.y2}`;
}

function progressBounds(rate: CompilerRateFunction): readonly [number, number] {
  if (rate.kind === "named") return easingProgressBounds(rate.easing);
  if (rate.kind === "hold") return [0, 1];
  return cubicBezierProgressBounds(rate.curve);
}

function timeRangesOverlap(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return positiveTimelineIntervalsOverlap(left, right);
}

function pointStrictlyInside(point: number, interval: { start: number; end: number }): boolean {
  return compareTimelineTimes(point, interval.start) > 0
    && compareTimelineTimes(point, interval.end) < 0;
}

function objectMaps(shot: Shot) {
  const objects = new Map(shot.objects.map((object) => [object.id, object]));
  const ancestorCache = new Map<string, ReadonlySet<string>>();
  const ancestorsOf = (objectId: string): ReadonlySet<string> => {
    const cached = ancestorCache.get(objectId);
    if (cached) return cached;
    const result = new Set<string>();
    let cursor = objects.get(objectId);
    while (cursor?.parentId && !result.has(cursor.parentId)) {
      result.add(cursor.parentId);
      cursor = objects.get(cursor.parentId);
    }
    ancestorCache.set(objectId, result);
    return result;
  };
  const shareHierarchy = (leftId: string, rightId: string) => (
    leftId === rightId || ancestorsOf(leftId).has(rightId) || ancestorsOf(rightId).has(leftId)
  );
  const children = new Map<string, string[]>();
  for (const object of shot.objects) {
    if (object.parentId) children.set(object.parentId, [...(children.get(object.parentId) ?? []), object.id]);
  }
  const leafCache = new Map<string, string[]>();
  const leafIds = (objectId: string, visiting = new Set<string>()): string[] => {
    const cached = leafCache.get(objectId);
    if (cached) return cached;
    const object = objects.get(objectId);
    if (!object) return [];
    if (object.type !== "group") return [object.id];
    if (visiting.has(objectId)) return [];
    const next = new Set(visiting).add(objectId);
    const result = (children.get(objectId) ?? []).flatMap((id) => leafIds(id, next));
    leafCache.set(objectId, result);
    return result;
  };
  return { objects, ancestorsOf, shareHierarchy, leafIds };
}

class SyntheticIdAllocator {
  private counter = 0;

  constructor(private readonly used: Set<string>) {}

  next(prefix: "property" | "lifetime-enter" | "lifetime-exit"): string {
    let candidate: string;
    do {
      this.counter += 1;
      candidate = `compiler-${prefix}-event-${this.counter}`;
    } while (this.used.has(candidate));
    this.used.add(candidate);
    return candidate;
  }
}

interface RawPropertyEvent {
  key: string;
  target: Exclude<PropertyTrackTarget, { kind: "audio" }>;
  start: number;
  end: number;
  rateFunction: CompilerRateFunction;
  trackId: string;
  property: PropertyTrack["property"];
  rightValue: PropertyTrack["keyframes"][number]["value"];
  point: boolean;
}

/** A property value that preview keeps authoritative without emitting a positive animation. */
interface RawPropertyAuthoritySpan {
  target: RawPropertyEvent["target"];
  start: number;
  end: number;
  trackId: string;
  property: PropertyTrack["property"];
}

interface GroupedPropertyEvent {
  key: string;
  target: RawPropertyEvent["target"];
  start: number;
  end: number;
  rateFunction: CompilerRateFunction;
  trackIds: string[];
  propertyNames: PropertyTrack["property"][];
  properties: Record<string, number>;
  point: boolean;
}

function groupedPropertyEvents(rawEvents: readonly RawPropertyEvent[], rejectedTrackIds: ReadonlySet<string>): GroupedPropertyEvent[] {
  const grouped: GroupedPropertyEvent[] = [];
  for (const raw of rawEvents.filter(({ trackId }) => !rejectedTrackIds.has(trackId))) {
    const event = grouped.find((candidate) => (
      targetKey(candidate.target) === targetKey(raw.target)
      && compareTimelineTimes(candidate.start, raw.start) === 0
      && compareTimelineTimes(candidate.end, raw.end) === 0
      && rateKey(candidate.rateFunction) === rateKey(raw.rateFunction)
      && candidate.point === raw.point
    )) ?? {
      key: raw.key,
      target: raw.target,
      start: raw.start,
      end: raw.end,
      rateFunction: raw.rateFunction,
      trackIds: [],
      propertyNames: [],
      properties: {},
      point: raw.point,
    };
    if (!grouped.includes(event)) grouped.push(event);
    event.trackIds.push(raw.trackId);
    event.propertyNames.push(raw.property);
    if (typeof raw.rightValue === "number") {
      if (raw.property === "scale") {
        event.properties.scaleX = raw.rightValue;
        event.properties.scaleY = raw.rightValue;
      } else if (!["opacity", "strokeWidth"].includes(raw.property)) event.properties[raw.property] = raw.rightValue;
    }
  }
  return grouped.sort((left, right) => compareTimelineTimes(left.start, right.start) || Number(left.point) - Number(right.point) || left.key.localeCompare(right.key));
}

function timelineKey(time: number): string {
  return timelineTickFor(time).toString();
}

function targetKey(target: RawPropertyEvent["target"]): string {
  return target.kind === "camera" ? "camera" : `object:${target.objectId}`;
}

function eventTargetsObject(event: GroupedPropertyEvent, objectId: string, shareHierarchy: (leftId: string, rightId: string) => boolean): boolean {
  return event.target.kind === "object" && shareHierarchy(event.target.objectId, objectId);
}

function animationTargetsObject(animation: SceneAnimation, objectId: string, shareHierarchy: (leftId: string, rightId: string) => boolean): boolean {
  return animation.type !== "camera-focus" && animation.targetIds.some((targetId) => shareHierarchy(targetId, objectId));
}

function animationTargetsLeaf(animation: SceneAnimation, leaf: SceneObject, ancestorsOf: (id: string) => ReadonlySet<string>): boolean {
  return animation.targetIds.some((targetId) => targetId === leaf.id || ancestorsOf(leaf.id).has(targetId));
}

function lastVisibilityBefore(
  shot: Shot,
  leaf: SceneObject,
  time: number,
  ancestorsOf: (id: string) => ReadonlySet<string>,
): SceneAnimation | undefined {
  return shot.animations
    .filter((animation) => (
      ["appear", "fade-in", "fade-out", "write", "create"].includes(animation.type)
      && animationTargetsLeaf(animation, leaf, ancestorsOf)
      && compareTimelineTimes(addTimelineTimes(animation.start, animation.duration), time) <= 0
    ))
    .sort((left, right) => (
      compareTimelineTimes(addTimelineTimes(right.start, right.duration), addTimelineTimes(left.start, left.duration))
      || compareTimelineTimes(right.start, left.start)
      || right.id.localeCompare(left.id)
    ))[0];
}

export function buildCompilerSchedule(
  shot: Shot,
  frameRate: ProjectDocument["settings"]["frameRate"],
  reservedIds: Set<string> = new Set(shotEntityIds(shot)),
): CompilerSchedule {
  const diagnostics: CompilerScheduleDiagnostic[] = [];
  const rejectedTrackIds = new Set<string>();
  const rawEvents: RawPropertyEvent[] = [];
  const holdAuthoritySpans: RawPropertyAuthoritySpan[] = [];
  const { objects, ancestorsOf, shareHierarchy, leafIds } = objectMaps(shot);
  const diagnosticKeys = new Set<string>();
  const addDiagnostic = (diagnostic: CompilerScheduleDiagnostic, key: string) => {
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    if (diagnosticKeys.size <= 64) diagnostics.push(diagnostic);
  };

  for (const track of orderedPropertyTracks(shot)) {
    if (track.target.kind === "audio") {
      diagnostics.push({
        severity: "error",
        code: "AUDIO_TRACK_RENDER_UNSUPPORTED",
        message: "Audio property tracks cannot be transported or muxed by the current renderer.",
        trackId: track.id,
      });
      rejectedTrackIds.add(track.id);
      continue;
    }
    const first = track.keyframes[0];
    // A non-zero first keyframe always needs an explicit state owner. In
    // particular, it may coincide with a delayed lifetime start whose
    // synthetic entrance is intentionally suppressed by a future authored
    // entrance. Relying on lifetime-enter in that case silently loses this
    // boundary assignment in the renderer.
    if (compareTimelineTimes(first.time, 0) > 0) {
      const rateFunction: CompilerRateFunction = { kind: "hold" };
      const key = `${targetKey(track.target)}:${timelineKey(first.time)}:${timelineKey(first.time)}:${rateKey(rateFunction)}`;
      rawEvents.push({
        key,
        target: track.target,
        start: first.time,
        end: first.time,
        rateFunction,
        trackId: track.id,
        property: track.property,
        rightValue: first.value,
        point: true,
      });
    }
    for (let index = 0; index + 1 < track.keyframes.length; index += 1) {
      const left = track.keyframes[index];
      const right = track.keyframes[index + 1];
      const rateFunction = rateFor(left.interpolation);
      const [minimumProgress, maximumProgress] = progressBounds(rateFunction);
      if (typeof left.value === "number" && typeof right.value === "number") {
        const candidates = [minimumProgress, maximumProgress].map((progress) => left.value as number + ((right.value as number) - (left.value as number)) * progress);
        const isScale = ["scale", "scaleX", "scaleY"].includes(track.property);
        const endpointSign = left.value > 0 && right.value > 0 ? 1 : left.value < 0 && right.value < 0 ? -1 : 0;
        const crossesInvalidScale = isScale && (endpointSign === 0 || candidates.some((value) => (
          value * endpointSign < PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude
          || Math.abs(value) > PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude
        )));
        if (crossesInvalidScale || candidates.some((value) => !propertyTrackValueValid(track.property, value))) {
          addDiagnostic({
            severity: "error",
            code: "TRACK_EASING_DOMAIN_UNSAFE",
            message: `${rateKey(rateFunction)} interpolation would leave the validated ${track.property} domain; the whole track was rejected.`,
            trackId: track.id,
          }, `domain:${track.id}`);
          rejectedTrackIds.add(track.id);
          continue;
        }
      } else if (typeof left.value === "string" && typeof right.value === "string" && (minimumProgress < 0 || maximumProgress > 1)) {
        addDiagnostic({
          severity: "error",
          code: "TRACK_EASING_DOMAIN_UNSAFE",
          message: `${rateKey(rateFunction)} interpolation would leave the validated color domain; the whole track was rejected.`,
          trackId: track.id,
        }, `domain:${track.id}`);
        rejectedTrackIds.add(track.id);
        continue;
      }
      const point = rateFunction.kind === "hold";
      if (point) holdAuthoritySpans.push({
        target: track.target,
        start: left.time,
        end: right.time,
        trackId: track.id,
        property: track.property,
      });
      const start = point ? right.time : left.time;
      const end = point ? right.time : right.time;
      const key = `${targetKey(track.target)}:${timelineKey(start)}:${timelineKey(end)}:${rateKey(rateFunction)}`;
      rawEvents.push({
        key,
        target: track.target,
        start,
        end,
        rateFunction,
        trackId: track.id,
        property: track.property,
        rightValue: right.value,
        point,
      });
      if (rateFunction.kind === "named" && rateFunction.easing === "there-and-back") {
        const endpointRate: CompilerRateFunction = { kind: "hold" };
        rawEvents.push({
          key: `${targetKey(track.target)}:${timelineKey(right.time)}:${timelineKey(right.time)}:${rateKey(endpointRate)}`,
          target: track.target,
          start: right.time,
          end: right.time,
          rateFunction: endpointRate,
          trackId: track.id,
          property: track.property,
          rightValue: right.value,
          point: true,
        });
      }
    }
  }

  const semanticRanges = [...shot.animations].sort((left, right) => compareTimelineTimes(left.start, right.start) || left.id.localeCompare(right.id));
  for (const authority of holdAuthoritySpans) {
    if (rejectedTrackIds.has(authority.trackId)) continue;
    const collision = semanticRanges.find((animation) => {
      const sameTarget = authority.target.kind === "camera"
        ? animation.type === "camera-focus"
        : animationTargetsObject(animation, authority.target.objectId, shareHierarchy);
      return sameTarget && timeRangesOverlap(authority, {
        start: animation.start,
        end: addTimelineTimes(animation.start, animation.duration),
      });
    });
    if (!collision) continue;
    rejectedTrackIds.add(authority.trackId);
    addDiagnostic({
      severity: "error",
      code: "TRACK_SEMANTIC_COLLISION",
      message: `Hold-owned ${authority.property} interval intersects semantic animation ${collision.id} on the same Manim hierarchy; the whole track was omitted.`,
      trackId: authority.trackId,
      animationId: collision.id,
    }, `semantic-hold:${authority.trackId}:${collision.id}`);
  }
  for (const event of groupedPropertyEvents(rawEvents, rejectedTrackIds)) {
    const collision = semanticRanges.find((animation) => {
      const sameTarget = event.target.kind === "camera"
        ? animation.type === "camera-focus"
        : animationTargetsObject(animation, event.target.objectId, shareHierarchy);
      if (!sameTarget) return false;
      const semanticInterval = { start: animation.start, end: addTimelineTimes(animation.start, animation.duration) };
      return event.point
        ? pointStrictlyInside(event.start, semanticInterval)
        : timeRangesOverlap(event, semanticInterval);
    });
    if (!collision) continue;
    for (const trackId of event.trackIds) {
      rejectedTrackIds.add(trackId);
      addDiagnostic({
        severity: "error",
        code: "TRACK_SEMANTIC_COLLISION",
        message: `Property track intersects semantic animation ${collision.id} on the same Manim hierarchy; the whole track was omitted.`,
        trackId,
        animationId: collision.id,
      }, `semantic:${trackId}:${collision.id}`);
    }
  }

  let groups = groupedPropertyEvents(rawEvents, rejectedTrackIds);
  for (const authority of holdAuthoritySpans) {
    if (rejectedTrackIds.has(authority.trackId)) continue;
    for (const event of groups) {
      if (event.trackIds.includes(authority.trackId)) continue;
      const sameMobject = authority.target.kind === "camera" && event.target.kind === "camera"
        || authority.target.kind === "object" && event.target.kind === "object" && shareHierarchy(authority.target.objectId, event.target.objectId);
      const temporalCollision = event.point
        ? pointStrictlyInside(event.start, authority)
        : timeRangesOverlap(authority, event);
      if (!sameMobject || !temporalCollision) continue;
      const collidingTrackIds = [authority.trackId, ...event.trackIds];
      for (const trackId of collidingTrackIds) {
        rejectedTrackIds.add(trackId);
        addDiagnostic({
          severity: "error",
          code: "TRACK_TRACK_COLLISION",
          message: `Hold-owned property interval intersects ${trackId === authority.trackId ? event.trackIds[0] : authority.trackId} on the same Manim hierarchy; both whole tracks were omitted.`,
          trackId,
        }, `track-hold:${trackId}:${authority.trackId}:${event.trackIds[0]}`);
      }
    }
  }
  groups = groupedPropertyEvents(rawEvents, rejectedTrackIds);
  for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
    const left = groups[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
      const right = groups[rightIndex];
      const sameMobject = left.target.kind === "camera" && right.target.kind === "camera"
        || left.target.kind === "object" && right.target.kind === "object" && shareHierarchy(left.target.objectId, right.target.objectId);
      if (!sameMobject) continue;
      const pointEndsForeignInterval = (point: GroupedPropertyEvent, interval: GroupedPropertyEvent) => (
        compareTimelineTimes(point.start, interval.end) === 0
        && !point.trackIds.every((trackId) => interval.trackIds.includes(trackId))
        && interval.rateFunction.kind === "named"
        && interval.rateFunction.easing === "there-and-back"
      );
      const temporalCollision = left.point && right.point
        ? compareTimelineTimes(left.start, right.start) === 0
        : left.point
          ? pointStrictlyInside(left.start, right) || pointEndsForeignInterval(left, right)
          : right.point
            ? pointStrictlyInside(right.start, left) || pointEndsForeignInterval(right, left)
            : timeRangesOverlap(left, right);
      if (!temporalCollision) continue;
      const visualProperties = new Set<PropertyTrack["property"]>(["fill", "stroke", "strokeWidth", "opacity"]);
      const representableVisualHierarchy = left.target.kind === "object" && right.target.kind === "object"
        && compareTimelineTimes(left.start, right.start) === 0
        && compareTimelineTimes(left.end, right.end) === 0
        && rateKey(left.rateFunction) === rateKey(right.rateFunction)
        && left.propertyNames.every((property) => visualProperties.has(property))
        && right.propertyNames.every((property) => visualProperties.has(property));
      const canMerge = left.key === right.key || representableVisualHierarchy;
      if (canMerge) continue;
      for (const [event, counterpart] of [[left, right], [right, left]] as const) {
        for (const trackId of event.trackIds) {
          rejectedTrackIds.add(trackId);
          addDiagnostic({
            severity: "error",
            code: "TRACK_TRACK_COLLISION",
            message: `Property track intersects ${counterpart.trackIds[0]} on the same Manim hierarchy; both whole tracks were omitted.`,
            trackId,
          }, `track:${trackId}:${counterpart.trackIds[0]}`);
        }
      }
    }
  }

  groups = groupedPropertyEvents(rawEvents, rejectedTrackIds);
  const lifetimeBoundaryCollisions = new Set<string>();
  for (const leaf of [...shot.objects].filter(({ type, visible }) => type !== "group" && visible).sort((left, right) => left.id.localeCompare(right.id))) {
    const lifetime = effectiveObjectLifetime(shot, leaf.id);
    if (!lifetime) continue;
    for (const [boundaryKind, time] of [["enter", lifetime.start], ["exit", lifetime.end]] as const) {
      if (compareTimelineTimes(time, 0) <= 0 || compareTimelineTimes(time, shot.duration) >= 0) continue;
      for (const animation of semanticRanges) {
        if (!animationTargetsObject(animation, leaf.id, shareHierarchy)) continue;
        const interval = { start: animation.start, end: addTimelineTimes(animation.start, animation.duration) };
        if (!pointStrictlyInside(time, interval)) continue;
        lifetimeBoundaryCollisions.add(`${boundaryKind}:${leaf.id}`);
        addDiagnostic({
          severity: "error",
          code: "LIFETIME_SEMANTIC_COLLISION",
          message: `${boundaryKind === "enter" ? "Entrance" : "Exit"} lifetime edge crosses semantic animation ${animation.id} on ${leaf.id}'s hierarchy.`,
          objectId: leaf.id,
          animationId: animation.id,
        }, `lifetime-semantic:${boundaryKind}:${leaf.id}:${animation.id}`);
      }
      for (const authority of holdAuthoritySpans) {
        if (rejectedTrackIds.has(authority.trackId)) continue;
        const targetsLifetimeHierarchy = authority.target.kind === "object"
          && shareHierarchy(authority.target.objectId, leaf.id);
        if (!targetsLifetimeHierarchy || !pointStrictlyInside(time, authority)) continue;
        rejectedTrackIds.add(authority.trackId);
        addDiagnostic({
          severity: "error",
          code: "TRACK_LIFETIME_COLLISION",
          message: `Hold-owned ${authority.property} interval crosses ${leaf.id}'s ${boundaryKind} lifetime edge through the same Manim hierarchy; the whole track was omitted.`,
          objectId: leaf.id,
          trackId: authority.trackId,
        }, `lifetime-hold:${boundaryKind}:${leaf.id}:${authority.trackId}`);
      }
      for (const event of groups) {
        if (!eventTargetsObject(event, leaf.id, shareHierarchy) || event.point) continue;
        const endsAtBoundary = compareTimelineTimes(event.start, time) < 0
          && compareTimelineTimes(event.end, time) === 0;
        const unsafeThereAndBackEndpoint = endsAtBoundary
          && event.rateFunction.kind === "named"
          && event.rateFunction.easing === "there-and-back";
        if (!pointStrictlyInside(time, event) && !unsafeThereAndBackEndpoint) continue;
        for (const trackId of event.trackIds) {
          rejectedTrackIds.add(trackId);
          addDiagnostic({
            severity: "error",
            code: "TRACK_LIFETIME_COLLISION",
            message: `Property track ${endsAtBoundary ? "ends at" : "crosses"} ${leaf.id}'s ${boundaryKind} lifetime edge through the same Manim hierarchy; the whole track was omitted.`,
            objectId: leaf.id,
            trackId,
          }, `lifetime-track:${boundaryKind}:${leaf.id}:${trackId}`);
        }
      }
    }
  }

  groups = groupedPropertyEvents(rawEvents, rejectedTrackIds);
  const allocator = new SyntheticIdAllocator(reservedIds);
  const propertyEvents: CompilerPropertySpanEvent[] = [];
  const visualProperties = new Set<PropertyTrack["property"]>(["fill", "stroke", "strokeWidth", "opacity"]);
  for (const group of groups) {
    const isVisual = group.target.kind === "object" && group.propertyNames.every((property) => visualProperties.has(property));
    const representedByAncestor = isVisual && groups.some((candidate) => (
      candidate !== group
      && candidate.target.kind === "object"
      && compareTimelineTimes(candidate.start, group.start) === 0
      && compareTimelineTimes(candidate.end, group.end) === 0
      && rateKey(candidate.rateFunction) === rateKey(group.rateFunction)
      && candidate.propertyNames.every((property) => visualProperties.has(property))
      && ancestorsOf(group.target.kind === "object" ? group.target.objectId : "").has(candidate.target.objectId)
    ));
    if (representedByAncestor) continue;
    const id = allocator.next("property");
    const animation: SceneAnimation = {
      id,
      type: group.target.kind === "camera" ? "camera-focus" : "transform",
      targetIds: group.target.kind === "object" ? [group.target.objectId] : [],
      start: group.start,
      duration: subtractTimelineTimes(group.end, group.start),
      easing: group.rateFunction.kind === "named" ? group.rateFunction.easing : "linear",
      properties: group.properties,
    };
    propertyEvents.push({
      kind: "property-span",
      id,
      start: group.start,
      end: group.end,
      animation,
      rateFunction: group.rateFunction,
      target: group.target,
      trackIds: [...new Set(group.trackIds)].sort(),
      propertyNames: [...new Set(group.propertyNames)].sort(),
      point: group.point,
    });
  }

  const lifetimeEvents: Array<CompilerLifetimeEnterEvent | CompilerLifetimeExitEvent> = [];
  const entranceTypes = new Set<SceneAnimation["type"]>(["appear", "fade-in", "write", "create"]);
  for (const leaf of [...shot.objects].filter(({ type, visible }) => type !== "group" && visible).sort((left, right) => left.id.localeCompare(right.id))) {
    const lifetime = effectiveObjectLifetime(shot, leaf.id);
    if (!lifetime) continue;
    if (compareTimelineTimes(lifetime.start, 0) > 0 && !lifetimeBoundaryCollisions.has(`enter:${leaf.id}`)) {
      const firstVisibilityAuthority = semanticRanges.find((animation) => (
        ["appear", "fade-in", "fade-out", "write", "create"].includes(animation.type)
        && compareTimelineTimes(animation.start, lifetime.start) >= 0
        && animationTargetsLeaf(animation, leaf, ancestorsOf)
      ));
      // A future first entrance intentionally owns the hidden interval. A
      // fade-out as the first authority proves the object must be present at
      // lifetime start, even when a later entrance exists.
      if (!firstVisibilityAuthority || !entranceTypes.has(firstVisibilityAuthority.type)) {
        const id = allocator.next("lifetime-enter");
        const animation: SceneAnimation = { id, type: "fade-in", targetIds: [leaf.id], start: lifetime.start, duration: 0, easing: "linear", properties: {} };
        lifetimeEvents.push({ kind: "lifetime-enter", id, objectId: leaf.id, start: lifetime.start, end: lifetime.start, animation, rateFunction: { kind: "named", easing: "linear" } });
      }
    }
    if (compareTimelineTimes(lifetime.end, shot.duration) < 0 && !lifetimeBoundaryCollisions.has(`exit:${leaf.id}`)) {
      const lastVisibility = lastVisibilityBefore(shot, leaf, lifetime.end, ancestorsOf);
      const lastVisibilityEndsHidden = lastVisibility?.type === "fade-out" && lastVisibility.easing !== "there-and-back";
      if (!lastVisibilityEndsHidden) {
        const matchingExit = semanticRanges.some((animation) => (
          animation.type === "fade-out"
          && animation.easing !== "there-and-back"
          && compareTimelineTimes(addTimelineTimes(animation.start, animation.duration), lifetime.end) === 0
          && animationTargetsLeaf(animation, leaf, ancestorsOf)
        ));
        if (!matchingExit) {
          const id = allocator.next("lifetime-exit");
          const animation: SceneAnimation = { id, type: "fade-out", targetIds: [leaf.id], start: lifetime.end, duration: 0, easing: "linear", properties: {} };
          lifetimeEvents.push({ kind: "lifetime-exit", id, objectId: leaf.id, start: lifetime.end, end: lifetime.end, animation, rateFunction: { kind: "named", easing: "linear" } });
        }
      }
    }
  }

  const semanticEvents: CompilerSemanticEvent[] = semanticRanges.map((animation) => ({
    kind: "semantic",
    id: animation.id,
    start: animation.start,
    end: addTimelineTimes(animation.start, animation.duration),
    animation,
    rateFunction: { kind: "named", easing: animation.easing },
  }));
  const events = [...semanticEvents, ...propertyEvents, ...lifetimeEvents].sort(compareCompilerEvents);
  let workCount = 0;
  for (const event of events) {
    if (event.animation.type === "camera-focus") workCount += 1;
    else if (event.kind === "lifetime-enter" || event.kind === "lifetime-exit") workCount += 1;
    else workCount += event.animation.targetIds.reduce((sum, id) => sum + Math.max(1, leafIds(id).length), 0);
  }
  if (workCount > PROOFCANVAS_SCHEMA_LIMITS.compilerExpandedTargetsPerProject) diagnostics.push({
    severity: "error",
    code: "COMPILER_WORK_LIMIT_EXCEEDED",
    message: `Chronological schedule expands to ${workCount} target events, above the ${PROOFCANVAS_SCHEMA_LIMITS.compilerExpandedTargetsPerProject} limit.`,
  });
  if (diagnosticKeys.size > 64) diagnostics.push({
    severity: "error",
    code: "TRACK_CONFLICT_DIAGNOSTICS_TRUNCATED",
    message: `${diagnosticKeys.size - 64} additional schedule conflict diagnostics were deterministically omitted.`,
  });
  const admittedTracks = shot.propertyTracks.filter((track) => !rejectedTrackIds.has(track.id));
  return {
    shot: { ...shot, propertyTracks: admittedTracks },
    events,
    diagnostics,
    rejectedTrackIds,
    workCount,
    helpers: { cubicBezier: propertyEvents.some(({ rateFunction }) => rateFunction.kind === "custom-bezier") },
  };
}

function shotEntityIds(shot: Shot): string[] {
  return [
    shot.id,
    ...shot.objects.map(({ id }) => id),
    ...shot.animations.map(({ id }) => id),
    ...shot.audioClips.map(({ id }) => id),
    ...shot.captionClips.map(({ id }) => id),
    ...shot.markers.map(({ id }) => id),
    ...shot.propertyTracks.flatMap((track) => [track.id, ...track.keyframes.map(({ id }) => id)]),
  ];
}
