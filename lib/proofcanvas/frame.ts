export type ProofCanvasAspectRatio = "16:9" | "9:16" | "1:1";
export type ProofCanvasRenderPreset = "draft" | "720p" | "1080p";

export interface LogicalFrame {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  manimWidth: number;
  manimHeight: number;
}

const LOGICAL_FRAMES: Readonly<Record<ProofCanvasAspectRatio, LogicalFrame>> = Object.freeze({
  "16:9": Object.freeze({
    width: 960,
    height: 540,
    centerX: 480,
    centerY: 270,
    manimWidth: 14.222222,
    manimHeight: 8,
  }),
  "9:16": Object.freeze({
    width: 540,
    height: 960,
    centerX: 270,
    centerY: 480,
    manimWidth: 8,
    manimHeight: 14.222222,
  }),
  "1:1": Object.freeze({
    width: 720,
    height: 720,
    centerX: 360,
    centerY: 360,
    manimWidth: 8,
    manimHeight: 8,
  }),
});

/** The aspect-ratio-specific coordinate system persisted in ProjectDocument geometry. */
export function logicalFrameFor(aspectRatio: ProofCanvasAspectRatio): LogicalFrame {
  return { ...LOGICAL_FRAMES[aspectRatio] };
}

/** Render pixels are derived from aspect ratio and preset; they are never authored independently. */
export function resolutionFor(
  aspectRatio: ProofCanvasAspectRatio,
  preset: ProofCanvasRenderPreset,
): { width: number; height: number } {
  const longEdge = preset === "draft" ? 854 : preset === "720p" ? 1280 : 1920;
  const shortEdge = preset === "draft" ? 480 : preset === "720p" ? 720 : 1080;
  if (aspectRatio === "16:9") return { width: longEdge, height: shortEdge };
  if (aspectRatio === "9:16") return { width: shortEdge, height: longEdge };
  return { width: shortEdge, height: shortEdge };
}

/** Convert a persisted editor point into Manim's centered, Y-up coordinate space. */
export function editorPointToManim(
  aspectRatio: ProofCanvasAspectRatio,
  point: { x: number; y: number },
): { x: number; y: number } {
  const frame = logicalFrameFor(aspectRatio);
  const scale = frame.manimWidth / frame.width;
  return {
    x: (point.x - frame.centerX) * scale,
    y: (frame.centerY - point.y) * scale,
  };
}

/** Convert an authored editor-space length using the frame's uniform scale. */
export function editorLengthToManim(aspectRatio: ProofCanvasAspectRatio, value: number): number {
  const frame = logicalFrameFor(aspectRatio);
  return value * frame.manimWidth / frame.width;
}

function requireFrameRate(frameRate: number): void {
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error("Frame rate must be a positive finite number");
}

function frameBoundaryTick(frame: number, frameRate: number): number {
  const tick = Math.round(frame * PROOFCANVAS_TIMELINE_TICKS_PER_SECOND / frameRate);
  if (!Number.isSafeInteger(tick)) throw new Error("Frame exceeds the safe timeline tick range");
  return tick;
}

function frameSearchSeed(timeTick: number, frameRate: number): number {
  const seed = Math.floor(timeTick * frameRate / PROOFCANVAS_TIMELINE_TICKS_PER_SECOND);
  if (!Number.isSafeInteger(seed)) throw new Error("Time exceeds the safe authored frame range");
  return seed;
}

/** Convert canonical seconds to the nearest discrete authored-frame boundary. */
export function secondsToFrame(time: number, frameRate: number): number {
  const lower = secondsToFrameFloor(time, frameRate);
  const timeTick = timelineTickFor(time);
  const lowerDistance = timeTick - frameBoundaryTick(lower, frameRate);
  const upperDistance = frameBoundaryTick(lower + 1, frameRate) - timeTick;
  return upperDistance <= lowerDistance ? lower + 1 : lower;
}

/** Return the greatest frame whose canonical boundary is at or before `time`. */
export function secondsToFrameFloor(time: number, frameRate: number): number {
  requireFrameRate(frameRate);
  const timeTick = timelineTickFor(time);
  let frame = frameSearchSeed(timeTick, frameRate);
  while (frameBoundaryTick(frame + 1, frameRate) <= timeTick) frame += 1;
  while (frameBoundaryTick(frame, frameRate) > timeTick) frame -= 1;
  return frame;
}

/** Return the least frame whose canonical boundary is at or after `time`. */
export function secondsToFrameCeil(time: number, frameRate: number): number {
  const floor = secondsToFrameFloor(time, frameRate);
  const timeTick = timelineTickFor(time);
  return frameBoundaryTick(floor, frameRate) === timeTick ? floor : floor + 1;
}

/** Convert an integer authored frame to its nearest canonical timeline tick. */
export function frameToSeconds(frame: number, frameRate: number): number {
  requireFrameRate(frameRate);
  if (!Number.isInteger(frame)) throw new Error("Frame must be an integer");
  return timelineTimeForTick(frameBoundaryTick(frame, frameRate));
}

export function snapTimeToFrame(time: number, frameRate: number): number {
  return frameToSeconds(secondsToFrame(time, frameRate), frameRate);
}

/** Compiler-bound time is persisted on a 10ns grid, independent of frame snap. */
export const PROOFCANVAS_TIMELINE_TICK_SECONDS = 1e-8;
export const PROOFCANVAS_TIMELINE_TICKS_PER_SECOND = 100_000_000;
/** Maximum authored/project duration: 24 shots x 300 seconds. */
export const PROOFCANVAS_TIMELINE_MAX_SECONDS = 7_200;
export const PROOFCANVAS_TIMELINE_MAX_TICKS = PROOFCANVAS_TIMELINE_MAX_SECONDS * PROOFCANVAS_TIMELINE_TICKS_PER_SECOND;

export function timelineTickFor(time: number): number {
  if (!Number.isFinite(time)) throw new Error("Time must be finite");
  if (Math.abs(time) > PROOFCANVAS_TIMELINE_MAX_SECONDS) throw new Error("Time exceeds the authored timeline range");
  const tick = Math.round(time * PROOFCANVAS_TIMELINE_TICKS_PER_SECOND);
  if (!Number.isSafeInteger(tick) || Math.abs(tick) > PROOFCANVAS_TIMELINE_MAX_TICKS) throw new Error("Time exceeds the authored timeline tick range");
  return tick;
}

export function timelineTimeForTick(tick: number): number {
  if (!Number.isSafeInteger(tick) || Math.abs(tick) > PROOFCANVAS_TIMELINE_MAX_TICKS) throw new Error("Timeline tick exceeds the authored timeline range");
  const time = Number((tick / PROOFCANVAS_TIMELINE_TICKS_PER_SECOND).toFixed(8));
  if (Math.round(time * PROOFCANVAS_TIMELINE_TICKS_PER_SECOND) !== tick) throw new Error("Timeline tick cannot round-trip through authored seconds");
  return time;
}

export function canonicalTimelineTime(time: number): number {
  return timelineTimeForTick(timelineTickFor(time));
}

export function isCanonicalTimelineTime(time: number): boolean {
  if (!Number.isFinite(time) || Math.abs(time) > PROOFCANVAS_TIMELINE_MAX_SECONDS) return false;
  try {
    return time === canonicalTimelineTime(time);
  } catch {
    return false;
  }
}

export function addTimelineTimes(left: number, right: number): number {
  return timelineTimeForTick(timelineTickFor(left) + timelineTickFor(right));
}

export function subtractTimelineTimes(left: number, right: number): number {
  return timelineTimeForTick(timelineTickFor(left) - timelineTickFor(right));
}

/** Sum canonical duration values in integer ticks, never binary float reductions. */
export function sumTimelineTimes(values: readonly number[]): number {
  let totalTicks = 0;
  for (const value of values) {
    totalTicks += timelineTickFor(value);
    if (!Number.isSafeInteger(totalTicks) || Math.abs(totalTicks) > PROOFCANVAS_TIMELINE_MAX_TICKS) {
      throw new Error("Timeline sum exceeds the authored timeline range");
    }
  }
  return timelineTimeForTick(totalTicks);
}

/** Total ordering over safe integer timeline ticks. */
export function compareTimelineTimes(left: number, right: number): -1 | 0 | 1 {
  const leftTick = timelineTickFor(left);
  const rightTick = timelineTickFor(right);
  return leftTick < rightTick ? -1 : leftTick > rightTick ? 1 : 0;
}

export function timelineTimesEqual(left: number, right: number): boolean {
  return compareTimelineTimes(left, right) === 0;
}

/** Half-open overlap over canonical integer ticks. */
export function positiveTimelineIntervalsOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return compareTimelineTimes(left.start, right.end) < 0
    && compareTimelineTimes(right.start, left.end) < 0;
}

/**
 * Order event starts on the same tick authority used by persistence/compiler.
 */
export function compareTimelineEventStarts(
  left: { start: number; end: number },
  right: { start: number; end: number },
): -1 | 0 | 1 {
  return compareTimelineTimes(left.start, right.start);
}
