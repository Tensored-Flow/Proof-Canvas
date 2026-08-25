import { interpretDemoCommand } from "../ai";
import { compileManim } from "../compiler";
import { instantiateSemanticComponent } from "../components";
import { critiqueProject } from "../critique";
import { createCantorDemoProject } from "../demo";
import {
  PROOFCANVAS_TIMELINE_TICK_SECONDS,
  PROOFCANVAS_TIMELINE_MAX_SECONDS,
  PROOFCANVAS_TIMELINE_MAX_TICKS,
  addTimelineTimes,
  canonicalTimelineTime,
  compareTimelineTimes,
  compareTimelineEventStarts,
  editorLengthToManim,
  editorPointToManim,
  frameToSeconds,
  isCanonicalTimelineTime,
  logicalFrameFor,
  positiveTimelineIntervalsOverlap,
  resolutionFor,
  secondsToFrame,
  secondsToFrameCeil,
  secondsToFrameFloor,
  snapTimeToFrame,
  subtractTimelineTimes,
  sumTimelineTimes,
  timelineTickFor,
  timelineTimeForTick,
  timelineTimesEqual,
  type ProofCanvasAspectRatio,
} from "../frame";
import { ProjectDocumentSchema, cloneSerializable } from "../schema";

describe("shared logical frame authority", () => {
  test.each([
    ["16:9", 960, 540, 480, 270, 14.222222, 8],
    ["9:16", 540, 960, 270, 480, 8, 14.222222],
    ["1:1", 720, 720, 360, 360, 8, 8],
  ] as const)("defines the exact %s authored frame", (aspectRatio, width, height, centerX, centerY, manimWidth, manimHeight) => {
    expect(logicalFrameFor(aspectRatio)).toEqual({ width, height, centerX, centerY, manimWidth, manimHeight });
    expect(editorPointToManim(aspectRatio, { x: centerX, y: centerY })).toEqual({ x: 0, y: 0 });
    expect(editorLengthToManim(aspectRatio, width)).toBeCloseTo(manimWidth, 8);
    const corner = editorPointToManim(aspectRatio, { x: width, y: 0 });
    expect(corner.x).toBeCloseTo(manimWidth / 2, 6);
    expect(corner.y).toBeCloseTo(manimHeight / 2, 6);
  });

  test.each([
    ["16:9", "draft", 854, 480], ["16:9", "720p", 1280, 720], ["16:9", "1080p", 1920, 1080],
    ["9:16", "draft", 480, 854], ["9:16", "720p", 720, 1280], ["9:16", "1080p", 1080, 1920],
    ["1:1", "draft", 480, 480], ["1:1", "720p", 720, 720], ["1:1", "1080p", 1080, 1080],
  ] as const)("derives %s %s pixels", (aspectRatio, preset, width, height) => {
    expect(resolutionFor(aspectRatio, preset)).toEqual({ width, height });
  });

  test("offers deterministic round, floor, ceil, and snap views over canonical authored seconds", () => {
    expect(secondsToFrame(1.019, 30)).toBe(31);
    expect(secondsToFrameFloor(1.019, 30)).toBe(30);
    expect(secondsToFrameCeil(1.019, 30)).toBe(31);
    expect(frameToSeconds(31, 30)).toBeCloseTo(1.0333333333);
    expect(snapTimeToFrame(1.019, 30)).toBe(frameToSeconds(31, 30));
    expect(() => secondsToFrame(Number.NaN, 30)).toThrow(/finite/);
    expect(() => frameToSeconds(1.5, 30)).toThrow(/integer/);
    expect(() => snapTimeToFrame(1, 0)).toThrow(/positive/);
  });

  test.each([15, 24, 30, 60] as const)("round-trips discrete %ifps frame boundaries across long timelines", (frameRate) => {
    for (let frame = 0; frame <= frameRate * 300; frame += 17) {
      const time = frameToSeconds(frame, frameRate);
      expect(secondsToFrame(time, frameRate)).toBe(frame);
      expect(secondsToFrameFloor(time, frameRate)).toBe(frame);
      expect(secondsToFrameCeil(time, frameRate)).toBe(frame);
      expect(timelineTickFor(time)).toBe(Math.round(frame * 100_000_000 / frameRate));
    }
    const first = frameToSeconds(1, frameRate);
    const before = timelineTimeForTick(timelineTickFor(first) - 1);
    const after = timelineTimeForTick(timelineTickFor(first) + 1);
    expect(secondsToFrameFloor(before, frameRate)).toBe(0);
    expect(secondsToFrameCeil(before, frameRate)).toBe(1);
    expect(secondsToFrameFloor(after, frameRate)).toBe(1);
    expect(secondsToFrameCeil(after, frameRate)).toBe(2);
  });

  test("uses one transitive 10ns tick authority for arithmetic, order, and overlap", () => {
    expect(PROOFCANVAS_TIMELINE_TICK_SECONDS).toBe(0.00000001);
    expect(canonicalTimelineTime(0.1 + 0.2)).toBe(0.3);
    expect(canonicalTimelineTime(1e-10)).toBe(0);
    expect(canonicalTimelineTime(1 + 6e-9)).toBe(1.00000001);
    expect(compareTimelineTimes(0.1 + 0.2, 0.3)).toBe(0);
    expect(timelineTimesEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(compareTimelineTimes(1e-10, 0)).toBe(0);
    const dust = [1, 1 + 3 * Number.EPSILON, 1 + 6 * Number.EPSILON];
    expect(new Set(dust.map(timelineTickFor))).toEqual(new Set([100_000_000]));
    expect(addTimelineTimes(0.1, 0.2)).toBe(0.3);
    expect(sumTimelineTimes([0.1, 0.2])).toBe(0.3);
    expect(subtractTimelineTimes(0.3, 0.1)).toBe(0.2);
    expect(positiveTimelineIntervalsOverlap(
      { start: 1, end: 1.00000001 },
      { start: 1, end: 1.00000001 },
    )).toBe(true);
    expect(positiveTimelineIntervalsOverlap(
      { start: 1, end: 1.00000001 },
      { start: 1.00000001, end: 1.00000002 },
    )).toBe(false);
    expect(compareTimelineEventStarts(
      { start: 1, end: 1.00000001 },
      { start: 1.00000001, end: 1.00000002 },
    )).toBe(-1);
    expect(positiveTimelineIntervalsOverlap(
      { start: 0.1, end: 0.1 + 0.2 },
      { start: 0.3, end: 0.5 },
    )).toBe(false);
  });

  test("bounds authored time to an exact 7200-second tick round-trip without throwing predicates", () => {
    expect(PROOFCANVAS_TIMELINE_MAX_SECONDS).toBe(7_200);
    expect(timelineTickFor(PROOFCANVAS_TIMELINE_MAX_SECONDS)).toBe(PROOFCANVAS_TIMELINE_MAX_TICKS);
    expect(timelineTimeForTick(PROOFCANVAS_TIMELINE_MAX_TICKS)).toBe(PROOFCANVAS_TIMELINE_MAX_SECONDS);
    expect(isCanonicalTimelineTime(PROOFCANVAS_TIMELINE_MAX_SECONDS)).toBe(true);
    expect(isCanonicalTimelineTime(PROOFCANVAS_TIMELINE_MAX_SECONDS + PROOFCANVAS_TIMELINE_TICK_SECONDS)).toBe(false);
    expect(isCanonicalTimelineTime(Number.MAX_VALUE)).toBe(false);
    expect(isCanonicalTimelineTime(Number.POSITIVE_INFINITY)).toBe(false);
    expect(() => timelineTickFor(Number.MAX_VALUE)).toThrow(/authored timeline range/);
    expect(() => timelineTimeForTick(PROOFCANVAS_TIMELINE_MAX_TICKS + 1)).toThrow(/authored timeline range/);
    expect(() => sumTimelineTimes([PROOFCANVAS_TIMELINE_MAX_SECONDS, PROOFCANVAS_TIMELINE_TICK_SECONDS])).toThrow(/sum exceeds/);
  });

  test.each(["9:16", "1:1"] as ProofCanvasAspectRatio[])("keeps compiler, components, critique, and AI inside the %s frame", (aspectRatio) => {
    const project = cloneSerializable(createCantorDemoProject());
    const frame = logicalFrameFor(aspectRatio);
    project.settings.aspectRatio = aspectRatio;
    project.settings.resolution = resolutionFor(aspectRatio, project.settings.renderPreset);
    project.shots = [project.shots[1]];
    project.shots[0].camera = { x: frame.centerX, y: frame.centerY, zoom: 1, rotation: 0 };
    project.shots[0].animations = [];
    project.shots[0].propertyTracks = [];
    project.shots[0].objects = [project.shots[0].objects[0]];
    project.shots[0].objects[0].transform = { ...project.shots[0].objects[0].transform, x: frame.centerX, y: frame.centerY };
    const valid = ProjectDocumentSchema.parse(project);
    expect(compileManim(valid).python).toContain(".move_to([0.0, 0.0, 0])");
    expect(instantiateSemanticComponent("mathematical-title", new Set(), undefined, aspectRatio)[0].transform)
      .toEqual(expect.objectContaining({ x: frame.centerX, y: frame.centerY }));
    expect(critiqueProject(valid).some(({ kind }) => kind === "outside-frame")).toBe(false);
    const proposal = interpretDemoCommand({
      project: valid,
      shotId: valid.shots[0].id,
      selectedObjectIds: [],
      instruction: "Make the composition less centred and more editorial without changing the mathematical content.",
    });
    for (const operation of proposal.operations) {
      if (operation.type !== "update-object" || !operation.patch.transform) continue;
      expect(operation.patch.transform.x).toBeGreaterThanOrEqual(0);
      expect(operation.patch.transform.x).toBeLessThanOrEqual(frame.width);
    }
  });
});
