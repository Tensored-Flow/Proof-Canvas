import { createCantorDemoProject } from "../demo";
import {
  TIMELINE_SNAP_PRIORITY,
  chooseTimelineRulerInterval,
  copyKeyframes,
  iterateTimelineRulerMarks,
  resolveDeleteKeyframes,
  resolveDuplicateKeyframes,
  resolveMoveKeyframes,
  resolvePasteKeyframes,
  resolveTimelineDrag,
  resolveUpsertKeyframe,
  snapTimelineTime,
  stepTimelineFrame,
  timelineTicksForFrameDelta,
  timelineTimeToX,
  timelineXToTime,
  type TimelineOperationIntent,
} from "../editorTimeline";
import { frameToSeconds, timelineTickFor, timelineTimeForTick } from "../frame";
import { keyframeSelection } from "../editorSelection";
import { commitOperations, createHistory, undo } from "../history";
import { applyOperations } from "../operations";
import { ProjectDocumentSchema, cloneSerializable, type ProjectDocument, type PropertyTrack } from "../schema";

function projectWithTimeline(): ProjectDocument {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  const object = shot.objects.find(({ id }) => id === "object-title")!;
  delete object.parentId;
  object.locked = false;
  object.lifetime = { start: 0, end: 8 };
  shot.duration = 8;
  shot.objects = [object];
  shot.animations = [];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  project.shots = [shot];
  return ProjectDocumentSchema.parse(project);
}

function track(id: string, property: "x" | "y", times: readonly number[] = [1, 2]): PropertyTrack {
  return {
    id,
    target: { kind: "object", objectId: "object-title" },
    property,
    keyframes: times.map((time, index) => ({
      id: `keyframe-${id}-${index + 1}`,
      time,
      value: index * 100 + (property === "x" ? 10 : 20),
      interpolation: index === 0 ? { kind: "eased", easing: "ease-in-out" } : { kind: "linear" },
    })),
  };
}

function requireIntent(intent: TimelineOperationIntent): Extract<TimelineOperationIntent, { ok: true }> {
  if (!intent.ok) throw new Error(intent.diagnostic.message);
  return intent;
}

describe("pure editor timeline authority", () => {
  test("maps viewport positions through canonical ticks and rejects malformed viewports", () => {
    const viewport = { start: 2, end: 6, widthPx: 800 };
    expect(timelineTimeToX(4, viewport)).toBe(400);
    expect(timelineXToTime(400, viewport)).toBe(4);
    expect(timelineXToTime(-100, viewport)).toBe(2);
    expect(timelineXToTime(900, viewport)).toBe(6);
    expect(timelineXToTime(-100, viewport, false)).toBe(1.5);
    expect(() => timelineXToTime(1, { ...viewport, widthPx: 0 })).toThrow(/width/);
    expect(() => timelineTimeToX(1, { ...viewport, end: 2 })).toThrow(/end/);
  });

  test.each([15, 24, 30, 60])("steps and clamps exact authored frames at %ifps", (frameRate) => {
    expect(stepTimelineFrame(0, 1, frameRate, { start: 0, end: 2 })).toBe(frameToSeconds(1, frameRate));
    expect(stepTimelineFrame(frameToSeconds(4, frameRate), -2, frameRate, { start: 0, end: 2 })).toBe(frameToSeconds(2, frameRate));
    expect(stepTimelineFrame(0, -20, frameRate, { start: 0, end: 2 })).toBe(0);
    expect(stepTimelineFrame(2, 20, frameRate, { start: 0, end: 2 })).toBe(frameToSeconds(frameRate * 2, frameRate));
    expect(timelineTicksForFrameDelta(0, 1, frameRate)).toBe(timelineTickFor(frameToSeconds(1, frameRate)));
    expect(timelineTicksForFrameDelta(frameToSeconds(1, frameRate), 1, frameRate)).toBe(
      timelineTickFor(frameToSeconds(2, frameRate)) - timelineTickFor(frameToSeconds(1, frameRate)),
    );
  });

  test.each([15, 24, 30, 60])("steps off-grid time through the immediate frame in either direction at %ifps", (frameRate) => {
    const lower = frameToSeconds(2, frameRate);
    const upper = frameToSeconds(3, frameRate);
    const offGrid = timelineTimeForTick(timelineTickFor(lower) + 1);
    const midpoint = timelineTimeForTick(Math.round((timelineTickFor(lower) + timelineTickFor(upper)) / 2));
    const range = { start: frameToSeconds(1, frameRate), end: frameToSeconds(5, frameRate) };
    expect(offGrid).not.toBe(lower);
    expect(stepTimelineFrame(offGrid, 0, frameRate, range)).toBe(offGrid);
    expect(stepTimelineFrame(offGrid, 1, frameRate, range)).toBe(upper);
    expect(stepTimelineFrame(offGrid, 2, frameRate, range)).toBe(frameToSeconds(4, frameRate));
    expect(stepTimelineFrame(offGrid, -1, frameRate, range)).toBe(lower);
    expect(stepTimelineFrame(offGrid, -2, frameRate, range)).toBe(frameToSeconds(1, frameRate));
    expect(stepTimelineFrame(midpoint, 1, frameRate, range)).toBe(upper);
    expect(stepTimelineFrame(midpoint, -1, frameRate, range)).toBe(lower);
    expect(stepTimelineFrame(lower, 1, frameRate, range)).toBe(upper);
    expect(stepTimelineFrame(lower, -1, frameRate, range)).toBe(frameToSeconds(1, frameRate));
    expect(stepTimelineFrame(offGrid, -20, frameRate, range)).toBe(range.start);
    expect(stepTimelineFrame(offGrid, 20, frameRate, range)).toBe(range.end);
  });

  test.each([15, 24, 30, 60])("derives relative tick intents that land on absolute adjacent frames at %ifps", (frameRate) => {
    const lower = frameToSeconds(2, frameRate);
    const offGrid = timelineTimeForTick(timelineTickFor(lower) + 1);
    const destination = (time: number, deltaFrames: number) => timelineTimeForTick(
      timelineTickFor(time) + timelineTicksForFrameDelta(time, deltaFrames, frameRate),
    );
    expect(timelineTicksForFrameDelta(offGrid, 0, frameRate)).toBe(0);
    expect(destination(offGrid, 1)).toBe(frameToSeconds(3, frameRate));
    expect(destination(offGrid, 3)).toBe(frameToSeconds(5, frameRate));
    expect(destination(offGrid, -1)).toBe(frameToSeconds(2, frameRate));
    expect(destination(offGrid, -3)).toBe(frameToSeconds(0, frameRate));
    expect(destination(lower, 1)).toBe(frameToSeconds(3, frameRate));
    expect(destination(lower, -1)).toBe(frameToSeconds(1, frameRate));

    const justAfterZero = timelineTimeForTick(1);
    expect(destination(justAfterZero, -2)).toBe(frameToSeconds(-1, frameRate));
    expect(() => timelineTicksForFrameDelta(7_200, 1, frameRate)).toThrow(/timeline|authored/i);
  });

  test("chooses the smallest stable frame-aligned ruler interval at each zoom", () => {
    const wide = chooseTimelineRulerInterval({ start: 0, end: 10, widthPx: 2_000 }, 30, 50);
    const narrow = chooseTimelineRulerInterval({ start: 0, end: 10, widthPx: 500 }, 30, 50);
    expect(wide.pixelSpacing).toBeGreaterThanOrEqual(50);
    expect(narrow.pixelSpacing).toBeGreaterThanOrEqual(50);
    expect(wide.frameStep).toBeLessThan(narrow.frameStep);
    expect(wide.approximateSecondsPerMark).toBe(wide.frameStep / 30);
    expect(wide).not.toHaveProperty("timeStep");
  });

  test.each([15, 24, 30, 60])("iterates many ruler marks from exact absolute frame indices at %ifps", (frameRate) => {
    const viewport = { start: frameToSeconds(7, frameRate), end: frameToSeconds(607, frameRate), widthPx: 1_200 };
    const marks = [...iterateTimelineRulerMarks(viewport, frameRate, 3)];
    expect(marks).toHaveLength(200);
    expect(marks[0].frameIndex).toBe(9);
    expect(marks.at(-1)!.frameIndex).toBe(606);
    for (const mark of marks) {
      expect(mark.frameIndex % 3).toBe(0);
      expect(mark.time).toBe(frameToSeconds(mark.frameIndex, frameRate));
      expect(timelineTickFor(mark.time)).toBe(timelineTickFor(frameToSeconds(mark.frameIndex, frameRate)));
      expect(mark.x).toBeCloseTo((timelineTickFor(mark.time) - timelineTickFor(viewport.start)) * viewport.widthPx
        / (timelineTickFor(viewport.end) - timelineTickFor(viewport.start)), 12);
    }
  });

  test("snaps by distance, then stable priority, tick, and ID within a fixed pixel threshold", () => {
    const viewport = { start: 0, end: 10, widthPx: 1_000 };
    expect(TIMELINE_SNAP_PRIORITY.marker).toBeLessThan(TIMELINE_SNAP_PRIORITY.keyframe);
    const closest = snapTimelineTime({
      time: 5,
      viewport,
      candidates: [
        { id: "marker-near", kind: "marker", time: 5.04 },
        { id: "keyframe-closer", kind: "keyframe", time: 5.03 },
      ],
    });
    expect(closest).toMatchObject({ snapped: true, time: 5.03, candidate: { id: "keyframe-closer" } });

    const priorityTie = snapTimelineTime({
      time: 5,
      viewport,
      candidates: [
        { id: "keyframe-right", kind: "keyframe", time: 5.04 },
        { id: "marker-left", kind: "marker", time: 4.96 },
      ],
    });
    expect(priorityTie.candidate?.id).toBe("marker-left");

    const tickTie = snapTimelineTime({
      time: 5,
      viewport,
      candidates: [
        { id: "marker-right", kind: "marker", time: 5.04 },
        { id: "marker-left", kind: "marker", time: 4.96 },
      ],
    });
    expect(tickTie.candidate?.id).toBe("marker-left");
    expect(snapTimelineTime({ time: 5, viewport, candidates: [{ id: "marker", kind: "marker", time: 5.05 }], enabled: false })).toEqual({ time: 5, snapped: false });
    expect(snapTimelineTime({ time: 5, viewport: { ...viewport, widthPx: 2_000 }, candidates: [{ id: "marker", kind: "marker", time: 5.05 }] }).snapped).toBe(false);
    expect(snapTimelineTime({ time: 10, viewport, candidates: [{ id: "outside", kind: "marker", time: 10.01 }] }).snapped).toBe(false);
  });

  test("cancels a drag when either canonical revision or shot changes", () => {
    const base = { kind: "keyframes" as const, projectRevision: "revision-a", shotId: "shot-a", pointerStartX: 100, viewport: { start: 0, end: 10, widthPx: 1_000 } };
    expect(resolveTimelineDrag(base, { projectRevision: "revision-a", shotId: "shot-a", pointerX: 150 })).toEqual({ status: "active", deltaTicks: 50_000_000 });
    expect(resolveTimelineDrag(base, { projectRevision: "revision-b", shotId: "shot-a", pointerX: 150 })).toEqual({ status: "cancelled", reason: "project-revision-changed" });
    expect(resolveTimelineDrag(base, { projectRevision: "revision-a", shotId: "shot-b", pointerX: 150 })).toEqual({ status: "cancelled", reason: "shot-changed" });
  });

  test("creates a first track, adds an exact-tick key, and updates the existing key", () => {
    const project = projectWithTimeline();
    const shotId = project.shots[0].id;
    const first = requireIntent(resolveUpsertKeyframe(project, shotId, {
      target: { kind: "object", objectId: "object-title" },
      property: "x",
      time: 1 / 30,
      value: 111,
    }));
    expect(first.operations).toEqual([expect.objectContaining({ type: "add-property-track" })]);
    const withTrack = applyOperations(project, shotId, first.operations).project;
    const authoredTrack = withTrack.shots[0].propertyTracks[0];
    expect(authoredTrack.keyframes[0].time).toBe(0.03333333);
    expect(first.selection).toMatchObject({ kind: "keyframes", keyframes: [{ trackId: authoredTrack.id, keyframeId: authoredTrack.keyframes[0].id }] });

    const added = requireIntent(resolveUpsertKeyframe(withTrack, shotId, {
      target: authoredTrack.target,
      property: authoredTrack.property,
      time: 1,
      value: 222,
      interpolation: { kind: "hold" },
    }));
    const withSecond = applyOperations(withTrack, shotId, added.operations).project;
    expect(withSecond.shots[0].propertyTracks[0].keyframes.map(({ time }) => time)).toEqual([0.03333333, 1]);

    const updated = requireIntent(resolveUpsertKeyframe(withSecond, shotId, {
      target: authoredTrack.target,
      property: authoredTrack.property,
      time: 1,
      value: 333,
    }));
    expect(updated.operations).toEqual([expect.objectContaining({ type: "update-keyframe", patch: { value: 333, interpolation: { kind: "hold" } } })]);
    expect(applyOperations(withSecond, shotId, updated.operations).project.shots[0].propertyTracks[0].keyframes[1]).toMatchObject({ value: 333, interpolation: { kind: "hold" } });
  });

  test("rejects provably invalid upserts before returning an authoring intent", () => {
    const project = projectWithTimeline();
    const shot = project.shots[0];
    const cases = [
      {
        label: "outside target lifetime",
        project,
        input: { target: { kind: "object" as const, objectId: "object-title" }, property: "x" as const, time: 9, value: 10 },
        message: /inside its target lifetime/,
      },
      ...[
        ["NaN time", Number.NaN],
        ["positive infinite time", Number.POSITIVE_INFINITY],
        ["negative infinite time", Number.NEGATIVE_INFINITY],
        ["time beyond the canonical domain", 7_201],
      ].map(([label, time]) => ({
        label: String(label),
        project,
        input: { target: { kind: "object" as const, objectId: "object-title" }, property: "x" as const, time: Number(time), value: 10 },
        message: /finite|authored timeline range/i,
      })),
      {
        label: "missing target",
        project,
        input: { target: { kind: "object" as const, objectId: "object-missing" }, property: "x" as const, time: 1, value: 10 },
        message: /Object not found|Missing track target/,
      },
      {
        label: "incompatible target property",
        project,
        input: { target: { kind: "camera" as const }, property: "fill" as const, time: 1, value: "#ffffff" },
        message: /not valid for camera tracks/,
      },
      {
        label: "color on numeric property",
        project,
        input: { target: { kind: "object" as const, objectId: "object-title" }, property: "x" as const, time: 1, value: "#ffffff" },
        message: /invalid for x/,
      },
      {
        label: "numeric value outside property domain",
        project,
        input: { target: { kind: "object" as const, objectId: "object-title" }, property: "opacity" as const, time: 1, value: 2 },
        message: /invalid for opacity/,
      },
      {
        label: "locked target",
        project: ProjectDocumentSchema.parse({ ...cloneSerializable(project), shots: [{ ...cloneSerializable(shot), objects: [{ ...cloneSerializable(shot.objects[0]), locked: true }] }] }),
        input: { target: { kind: "object" as const, objectId: "object-title" }, property: "y" as const, time: 1, value: 10 },
        message: /locked object/,
      },
    ];
    for (const candidate of cases) {
      const intent = resolveUpsertKeyframe(candidate.project, candidate.project.shots[0].id, candidate.input);
      expect({ label: candidate.label, intent }).toMatchObject({
        label: candidate.label,
        intent: { ok: false, diagnostic: { code: "invalid-operation", message: expect.stringMatching(candidate.message) } },
      });
    }
  });

  test("turns final-key deletion into track deletion and mixes whole-track and partial deletion atomically", () => {
    const project = projectWithTimeline();
    const shot = project.shots[0];
    shot.propertyTracks = [track("track-title-x", "x", [1]), track("track-title-y", "y", [1, 2])];
    const valid = ProjectDocumentSchema.parse(project);
    const intent = requireIntent(resolveDeleteKeyframes(valid, shot.id, [
      { trackId: "track-title-x", keyframeId: "keyframe-track-title-x-1" },
      { trackId: "track-title-y", keyframeId: "keyframe-track-title-y-1" },
    ]));
    expect(intent.operations).toEqual([
      { type: "delete-property-track", trackId: "track-title-x" },
      { type: "delete-keyframe", trackId: "track-title-y", keyframeId: "keyframe-track-title-y-1" },
    ]);
    const applied = applyOperations(valid, shot.id, intent.operations).project.shots[0];
    expect(applied.propertyTracks.map(({ id }) => id)).toEqual(["track-title-y"]);
    expect(applied.propertyTracks[0].keyframes.map(({ id }) => id)).toEqual(["keyframe-track-title-y-2"]);
    expect(resolveDeleteKeyframes(valid, shot.id, [{ trackId: "track-title-x", keyframeId: "missing" }])).toMatchObject({ ok: false, diagnostic: { code: "missing-keyframe" } });
    expect(requireIntent(resolveDeleteKeyframes(valid, shot.id, [
      { trackId: "track-title-x", keyframeId: "keyframe-track-title-x-1" },
      { trackId: "track-title-x", keyframeId: "keyframe-track-title-x-1" },
    ])).operations).toEqual([{ type: "delete-property-track", trackId: "track-title-x" }]);
  });

  test("moves multiple tracks relatively through selected old ticks in one history entry and preserves key ownership", () => {
    const project = projectWithTimeline();
    const shot = project.shots[0];
    shot.propertyTracks = [track("track-title-x", "x"), track("track-title-y", "y")];
    const valid = ProjectDocumentSchema.parse(project);
    const refs = shot.propertyTracks.flatMap((candidate) => candidate.keyframes.map((keyframe) => ({ trackId: candidate.id, keyframeId: keyframe.id })));
    const intent = requireIntent(resolveMoveKeyframes(valid, shot.id, refs, timelineTickFor(1)));
    expect(intent.operations).toHaveLength(4);
    const history = commitOperations(createHistory(valid), shot.id, intent.operations, intent.label);
    expect(history.past).toHaveLength(1);
    for (const movedTrack of history.present.shots[0].propertyTracks) {
      expect(movedTrack.keyframes.map(({ time }) => time)).toEqual([2, 3]);
      expect(movedTrack.keyframes[0].interpolation).toEqual({ kind: "eased", easing: "ease-in-out" });
      expect(movedTrack.keyframes.map(({ value }) => value)).toEqual(movedTrack.property === "x" ? [10, 110] : [20, 120]);
    }
    expect(undo(history).present).toEqual(valid);
  });

  test("rejects multi-move collisions and out-of-range destinations before applying any operation", () => {
    const project = projectWithTimeline();
    const shot = project.shots[0];
    shot.propertyTracks = [track("track-title-x", "x", [1, 2, 3])];
    const valid = ProjectDocumentSchema.parse(project);
    expect(resolveMoveKeyframes(valid, shot.id, [{ trackId: "track-title-x", keyframeId: "keyframe-track-title-x-2" }], timelineTickFor(1))).toMatchObject({
      ok: false,
      diagnostic: { code: "collision", conflictingKeyframeId: "keyframe-track-title-x-3" },
    });
    expect(resolveMoveKeyframes(valid, shot.id, [{ trackId: "track-title-x", keyframeId: "keyframe-track-title-x-3" }], timelineTickFor(6))).toMatchObject({ ok: false, diagnostic: { code: "out-of-range" } });
    expect(valid.shots[0].propertyTracks[0].keyframes.map(({ time }) => time)).toEqual([1, 2, 3]);
  });

  test("lets the existing apply boundary enforce effective locks", () => {
    const project = projectWithTimeline();
    const shot = project.shots[0];
    shot.objects[0].locked = true;
    shot.propertyTracks = [track("track-title-x", "x")];
    const valid = ProjectDocumentSchema.parse(project);
    const intent = requireIntent(resolveMoveKeyframes(valid, shot.id, [{ trackId: "track-title-x", keyframeId: "keyframe-track-title-x-1" }], timelineTickFor(0.5)));
    expect(() => applyOperations(valid, shot.id, intent.operations)).toThrow(/locked object/);
  });

  test("duplicates and copy-pastes deterministic fresh IDs without mutating the source", () => {
    const project = projectWithTimeline();
    const shot = project.shots[0];
    shot.propertyTracks = [track("track-title-x", "x")];
    const valid = ProjectDocumentSchema.parse(project);
    const sourceRef = [{ trackId: "track-title-x", keyframeId: "keyframe-track-title-x-1" }];
    const duplicate = requireIntent(resolveDuplicateKeyframes(valid, shot.id, sourceRef, timelineTickFor(2)));
    expect(duplicate.operations).toEqual([{
      type: "duplicate-keyframe",
      trackId: "track-title-x",
      keyframeId: "keyframe-track-title-x-1",
      duplicateId: "keyframe-track-title-x-300000000",
      time: 3,
    }]);
    const duplicated = applyOperations(valid, shot.id, duplicate.operations).project;
    expect(valid.shots[0].propertyTracks[0].keyframes).toHaveLength(2);
    expect(duplicated.shots[0].propertyTracks[0].keyframes).toHaveLength(3);

    const clipboard = copyKeyframes(valid, shot.id, sourceRef);
    expect("entries" in clipboard).toBe(true);
    if (!("entries" in clipboard)) throw new Error(clipboard.message);
    const pastedIntent = requireIntent(resolvePasteKeyframes(duplicated, shot.id, clipboard, 5));
    expect(pastedIntent.operations).toEqual([expect.objectContaining({
      type: "add-keyframe",
      trackId: "track-title-x",
      keyframe: expect.objectContaining({ id: "keyframe-track-title-x-500000000", time: 5, value: 10 }),
    })]);
    expect(applyOperations(duplicated, shot.id, pastedIntent.operations).project.shots[0].propertyTracks[0].keyframes.map(({ time }) => time)).toEqual([1, 2, 3, 5]);

    expect(resolveDuplicateKeyframes(valid, shot.id, valid.shots[0].propertyTracks[0].keyframes.map((keyframe) => ({
      trackId: "track-title-x",
      keyframeId: keyframe.id,
    })), timelineTickFor(1))).toMatchObject({ ok: false, diagnostic: { code: "collision", conflictingKeyframeId: "keyframe-track-title-x-2" } });
  });

  test("preserves an explicit cross-track primary independently from sorted operations and maps it through duplicate and paste", () => {
    const project = projectWithTimeline();
    const shot = project.shots[0];
    shot.propertyTracks = [track("track-title-x", "x", [1]), track("track-title-y", "y", [2])];
    const valid = ProjectDocumentSchema.parse(project);
    const x = { trackId: "track-title-x", keyframeId: "keyframe-track-title-x-1" };
    const y = { trackId: "track-title-y", keyframeId: "keyframe-track-title-y-1" };
    const typed = keyframeSelection(valid.shots[0], [x, y], x);
    expect(typed).toEqual({ kind: "keyframes", shotId: shot.id, keyframes: [y, x], primaryKeyframe: x });

    const moved = requireIntent(resolveMoveKeyframes(valid, shot.id, [y, x], timelineTickFor(0.5), x));
    expect(moved.operations.map((operation) => "trackId" in operation ? operation.trackId : "")).toEqual([x.trackId, y.trackId]);
    expect(moved.selection).toMatchObject({ kind: "keyframes", keyframes: [y, x], primaryKeyframe: x });

    const duplicated = requireIntent(resolveDuplicateKeyframes(valid, shot.id, typed, timelineTickFor(2)));
    expect(duplicated.operations.map((operation) => "trackId" in operation ? operation.trackId : "")).toEqual([x.trackId, y.trackId]);
    expect(duplicated.selection).toMatchObject({
      kind: "keyframes",
      keyframes: [
        expect.objectContaining({ trackId: y.trackId }),
        expect.objectContaining({ trackId: x.trackId }),
      ],
      primaryKeyframe: expect.objectContaining({ trackId: x.trackId }),
    });
    const duplicatedX = duplicated.operations.find((operation) => operation.type === "duplicate-keyframe" && operation.keyframeId === x.keyframeId);
    expect(duplicated.selection).toMatchObject({
      primaryKeyframe: { trackId: x.trackId, keyframeId: duplicatedX && "duplicateId" in duplicatedX ? duplicatedX.duplicateId : "missing" },
    });

    const clipboard = copyKeyframes(valid, shot.id, typed);
    expect(clipboard).toMatchObject({ sourceShotId: shot.id, primarySourceKeyframe: x });
    if (!("entries" in clipboard)) throw new Error(clipboard.message);
    const pasted = requireIntent(resolvePasteKeyframes(valid, shot.id, clipboard, 5));
    expect(pasted.selection).toMatchObject({
      kind: "keyframes",
      keyframes: [
        expect.objectContaining({ trackId: y.trackId }),
        expect.objectContaining({ trackId: x.trackId }),
      ],
      primaryKeyframe: expect.objectContaining({ trackId: x.trackId }),
    });
    const pastedX = pasted.operations.find((operation) => operation.type === "add-keyframe" && operation.trackId === x.trackId);
    expect(pasted.selection).toMatchObject({
      primaryKeyframe: { trackId: x.trackId, keyframeId: pastedX && "keyframe" in pastedX ? pastedX.keyframe.id : "missing" },
    });
  });
});
