import {
  PROOFCANVAS_SCHEMA_LIMITS,
  PROOFCANVAS_TIME_EPSILON,
  type KeyframeInterpolation,
  type ObjectLifetime,
  type PropertyKeyframe,
  type PropertyTrack,
  type PropertyTrackTarget,
  type Shot,
} from "./schema";
import { easingProgress } from "./easing";

export type PropertyValue = PropertyKeyframe["value"];

export interface TimelineIndex {
  byId: ReadonlyMap<string, PropertyTrack>;
  byTargetProperty: ReadonlyMap<string, PropertyTrack>;
}

export interface SampledProperty {
  trackId: string;
  target: PropertyTrackTarget;
  property: PropertyTrack["property"];
  value: PropertyValue;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function propertyTrackTargetKey(target: PropertyTrackTarget): string {
  if (target.kind === "object") return `object:${target.objectId}`;
  if (target.kind === "audio") return `audio:${target.audioClipId}`;
  return "camera";
}

export function propertyTrackKey(track: Pick<PropertyTrack, "target" | "property">): string {
  return `${propertyTrackTargetKey(track.target)}:${track.property}`;
}

export function indexPropertyTracks(shot: Pick<Shot, "propertyTracks">): TimelineIndex {
  const byId = new Map<string, PropertyTrack>();
  const byTargetProperty = new Map<string, PropertyTrack>();
  for (const track of shot.propertyTracks) {
    byId.set(track.id, track);
    byTargetProperty.set(propertyTrackKey(track), track);
  }
  return { byId, byTargetProperty };
}

function cubicCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}

/** Deterministic fixed-iteration inversion of the cubic's monotonic X coordinate. */
export function cubicBezierProgress(
  curve: { x1: number; y1: number; x2: number; y2: number },
  progress: number,
): number {
  const x = clamp(progress);
  if (x === 0 || x === 1) return x;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const candidate = (lower + upper) / 2;
    if (cubicCoordinate(candidate, curve.x1, curve.x2) < x) lower = candidate;
    else upper = candidate;
  }
  return cubicCoordinate((lower + upper) / 2, curve.y1, curve.y2);
}

export function interpolationProgress(interpolation: KeyframeInterpolation, progress: number): number {
  if (interpolation.kind === "hold") return 0;
  if (interpolation.kind === "linear") return clamp(progress);
  if (interpolation.kind === "eased") return easingProgress(interpolation.easing, progress);
  return cubicBezierProgress(interpolation.curve, progress);
}

function clampNumericProperty(
  property: PropertyTrack["property"],
  value: number,
  leftValue: number,
  rightValue: number,
): number {
  switch (property) {
    case "x":
    case "y": return clamp(value, -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude);
    case "width":
    case "height": return clamp(value, PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin, PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax);
    case "rotation": return clamp(value, -PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude);
    case "opacity": return clamp(value);
    case "strokeWidth": return clamp(value, 0, PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax);
    case "zoom": return clamp(value, PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMin, PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMax);
    case "volume": return clamp(value, 0, 4);
    case "scale":
    case "scaleX":
    case "scaleY": {
      const bounded = clamp(value, -PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude);
      const sharedSign = leftValue < 0 && rightValue < 0 ? -1 : leftValue > 0 && rightValue > 0 ? 1 : 0;
      if (sharedSign !== 0 && bounded * sharedSign < PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude) {
        return sharedSign * PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude;
      }
      if (Math.abs(bounded) >= PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude) return bounded;
      const sign = bounded < 0 ? -1 : bounded > 0 ? 1 : leftValue < 0 ? -1 : leftValue > 0 ? 1 : rightValue < 0 ? -1 : 1;
      return sign * PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude;
    }
    case "fill":
    case "stroke": return value;
  }
}

function interpolateColor(from: string, to: string, progress: number): string {
  const channel = (value: string, offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16);
  const result = [1, 3, 5].map((offset) => Math.round(
    channel(from, offset) + (channel(to, offset) - channel(from, offset)) * clamp(progress),
  ));
  return `#${result.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function samplePropertyTrack(track: PropertyTrack, time: number): PropertyValue {
  const frames = track.keyframes;
  if (time <= frames[0].time + PROOFCANVAS_TIME_EPSILON) return frames[0].value;
  const last = frames[frames.length - 1];
  if (time >= last.time - PROOFCANVAS_TIME_EPSILON) return last.value;
  let rightIndex = 1;
  while (rightIndex < frames.length && time > frames[rightIndex].time + PROOFCANVAS_TIME_EPSILON) rightIndex += 1;
  const left = frames[rightIndex - 1];
  const right = frames[rightIndex];
  if (Math.abs(time - right.time) <= PROOFCANVAS_TIME_EPSILON) return right.value;
  const progress = interpolationProgress(left.interpolation, (time - left.time) / (right.time - left.time));
  if (typeof left.value === "number" && typeof right.value === "number") {
    return clampNumericProperty(track.property, left.value + (right.value - left.value) * progress, left.value, right.value);
  }
  if (typeof left.value === "string" && typeof right.value === "string") return interpolateColor(left.value, right.value, progress);
  return left.value;
}

export function orderedPropertyTracks(shot: Pick<Shot, "propertyTracks" | "objects">): PropertyTrack[] {
  const objects = new Map(shot.objects.map((object) => [object.id, object]));
  const depthCache = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    let depth = 0;
    let cursor = objects.get(id);
    const visited = new Set<string>();
    while (cursor?.parentId && !visited.has(cursor.parentId)) {
      visited.add(cursor.parentId);
      depth += 1;
      cursor = objects.get(cursor.parentId);
    }
    depthCache.set(id, depth);
    return depth;
  };
  const propertyPriority = (property: PropertyTrack["property"]): number => (
    property === "scale" ? 0 : property === "scaleX" ? 1 : property === "scaleY" ? 2 : 3
  );
  return [...shot.propertyTracks].sort((left, right) => {
    const leftDepth = left.target.kind === "object" ? depthOf(left.target.objectId) : -1;
    const rightDepth = right.target.kind === "object" ? depthOf(right.target.objectId) : -1;
    return leftDepth - rightDepth
      || propertyTrackTargetKey(left.target).localeCompare(propertyTrackTargetKey(right.target))
      || propertyPriority(left.property) - propertyPriority(right.property)
      || left.property.localeCompare(right.property)
      || left.id.localeCompare(right.id);
  });
}

export function samplePropertyTracks(shot: Pick<Shot, "propertyTracks" | "objects">, time: number): SampledProperty[] {
  return orderedPropertyTracks(shot).map((track) => ({
    trackId: track.id,
    target: track.target,
    property: track.property,
    value: samplePropertyTrack(track, time),
  }));
}

/** Intersects authored ancestor lifetimes using a bounded iterative walk. */
export function effectiveObjectLifetime(shot: Pick<Shot, "duration" | "objects">, objectId: string): ObjectLifetime | undefined {
  const objects = new Map(shot.objects.map((object) => [object.id, object]));
  let cursor = objects.get(objectId);
  if (!cursor) return undefined;
  let start = 0;
  let end = shot.duration;
  const visited = new Set<string>();
  for (let depth = 0; cursor && depth <= PROOFCANVAS_SCHEMA_LIMITS.hierarchyDepth; depth += 1) {
    if (visited.has(cursor.id)) return undefined;
    visited.add(cursor.id);
    if (cursor.lifetime) {
      start = Math.max(start, cursor.lifetime.start);
      end = Math.min(end, cursor.lifetime.end);
    }
    cursor = cursor.parentId ? objects.get(cursor.parentId) : undefined;
  }
  return { start, end };
}

export function objectExistsAtTime(shot: Pick<Shot, "duration" | "objects">, objectId: string, time: number): boolean {
  const lifetime = effectiveObjectLifetime(shot, objectId);
  return Boolean(lifetime && time >= lifetime.start - PROOFCANVAS_TIME_EPSILON && time <= lifetime.end + PROOFCANVAS_TIME_EPSILON);
}
