import { createCantorDemoProject } from "../demo";
import { shotLocalIds } from "../documentOperations";
import {
  animationSelection,
  keyframeSelection,
  markerSelection,
  objectSelection,
  projectSelection,
  shotSelection,
  type EditorSelection,
} from "../editorSelection";
import {
  advanceEditorShotSequencePlayback,
  beginEditorShotSequencePlayback,
  buildEditorShotSequence,
  commitEditorShotAction,
  deriveEditorShotSequencePosition,
  locateEditorShotSequenceTime,
  minimumAuthoredShotDuration,
  resolveEditorShotActivation,
  seekEditorShotSequence,
  validateEditorShotWorkspace,
  type EditorShotWorkspace,
} from "../editorShotSequence";
import { frameToSeconds, logicalFrameFor, timelineTickFor, timelineTimeForTick } from "../frame";
import { createHistory, redo, undo } from "../history";
import {
  ProjectDocumentSchema,
  canonicalProjectJson,
  cloneSerializable,
  type ProjectDocument,
  type SceneObject,
  type Shot,
} from "../schema";

function blankShot(id: string, name: string, duration = 6): Shot {
  return {
    id,
    name,
    duration,
    objects: [],
    animations: [],
    propertyTracks: [],
    audioClips: [],
    captionClips: [],
    markers: [],
    camera: { x: 480, y: 270, zoom: 1, rotation: 0 },
  };
}

function sequenceProject(durations: readonly number[] = [2, 3, 4]): ProjectDocument {
  const project = cloneSerializable(createCantorDemoProject());
  project.shots = durations.map((duration, index) => blankShot(`shot-sequence-${index + 1}`, `Sequence ${index + 1}`, duration));
  project.assets = [];
  return ProjectDocumentSchema.parse(project);
}

function sceneObject(id: string, name: string, x: number): SceneObject {
  return {
    id,
    type: "rectangle",
    name,
    locked: false,
    visible: true,
    transform: { x, y: 270, width: 120, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {},
  };
}

function richProject(): ProjectDocument {
  const project = sequenceProject([6, 2]);
  const shot = project.shots[0];
  shot.objects = [
    sceneObject("object-sequence-a", "A", 240),
    sceneObject("object-sequence-b", "B", 720),
    sceneObject("object-sequence-motion", "Motion", 480),
  ];
  shot.animations = [
    { id: "animation-sequence-left", type: "scale", targetIds: ["object-sequence-motion"], start: 1, duration: 1, easing: "linear", properties: { scale: 1.2 } },
    { id: "animation-sequence-right", type: "scale", targetIds: ["object-sequence-motion"], start: 4, duration: 1, easing: "linear", properties: { scale: 1.1 } },
  ];
  shot.propertyTracks = [
    {
      id: "track-sequence-a-x",
      target: { kind: "object", objectId: "object-sequence-a" },
      property: "x",
      keyframes: [
        { id: "keyframe-sequence-a-start", time: 0, value: 240, interpolation: { kind: "linear" } },
        { id: "keyframe-sequence-a-boundary", time: 3, value: 300, interpolation: { kind: "linear" } },
        { id: "keyframe-sequence-a-end", time: 6, value: 360, interpolation: { kind: "linear" } },
      ],
    },
    {
      id: "track-sequence-b-y",
      target: { kind: "object", objectId: "object-sequence-b" },
      property: "y",
      keyframes: [
        { id: "keyframe-sequence-b-a", time: 4, value: 270, interpolation: { kind: "linear" } },
        { id: "keyframe-sequence-b-b", time: 5, value: 300, interpolation: { kind: "linear" } },
      ],
    },
  ];
  project.assets = [{
    id: "asset-sequence-audio",
    filename: "sequence.wav",
    mimeType: "audio/wav",
    size: 32,
    sha256: "a".repeat(64),
    duration: 10,
    provenance: "uploaded",
  }];
  shot.audioClips = [{
    id: "audio-sequence-right",
    assetId: "asset-sequence-audio",
    name: "Right audio",
    start: 4,
    duration: 1,
    sourceStart: 0,
    sourceEnd: 1,
    volume: 1,
    muted: false,
    solo: false,
  }];
  shot.captionClips = [{ id: "caption-sequence-right", start: 4, end: 5, text: "Right caption", style: {} }];
  shot.markers = [
    { id: "marker-sequence-left", time: 2, name: "Left", color: "#112233" },
    { id: "marker-sequence-right", time: 4, name: "Right", color: "#445566" },
  ];
  return ProjectDocumentSchema.parse(project);
}

function workspace(project: ProjectDocument, selection: EditorSelection = shotSelection([project.shots[0].id]), playhead = 0): EditorShotWorkspace {
  return { activeShotId: project.shots[0].id, selection, playhead };
}

describe("canonical editor shot sequence", () => {
  test("derives exact fractional offsets and assigns boundaries without accumulated float drift", () => {
    const durations = [frameToSeconds(1, 15), frameToSeconds(1, 24), frameToSeconds(1, 30), frameToSeconds(1, 60)];
    const project = sequenceProject(durations);
    const sequence = buildEditorShotSequence(project);
    let tick = 0;
    for (const [index, entry] of sequence.entries.entries()) {
      expect(entry.shotId).toBe(project.shots[index].id);
      expect(timelineTickFor(entry.start)).toBe(tick);
      tick += timelineTickFor(project.shots[index].duration);
      expect(timelineTickFor(entry.end)).toBe(tick);
      expect(timelineTickFor(entry.duration)).toBe(timelineTickFor(project.shots[index].duration));
    }
    expect(timelineTickFor(sequence.totalDuration)).toBe(tick);

    for (let index = 1; index < sequence.entries.length; index += 1) {
      const boundary = locateEditorShotSequenceTime(sequence, sequence.entries[index].start);
      expect(boundary).toMatchObject({ ok: true, index, shotId: sequence.entries[index].shotId, localTime: 0, atFinalEndpoint: false });
      const priorTick = timelineTickFor(sequence.entries[index].start) - 1;
      const before = locateEditorShotSequenceTime(sequence, timelineTimeForTick(priorTick));
      expect(before).toMatchObject({ ok: true, index: index - 1, shotId: sequence.entries[index - 1].shotId });
    }
    expect(locateEditorShotSequenceTime(sequence, sequence.totalDuration)).toMatchObject({
      ok: true,
      index: sequence.entries.length - 1,
      localTime: durations.at(-1),
      atFinalEndpoint: true,
    });
  });

  test("rejects invalid and out-of-range time unless explicit clamping is requested", () => {
    const sequence = buildEditorShotSequence(sequenceProject());
    expect(locateEditorShotSequenceTime(sequence, Number.NaN)).toMatchObject({ ok: false, diagnostic: { code: "invalid-time" } });
    expect(locateEditorShotSequenceTime(sequence, -1)).toMatchObject({ ok: false, diagnostic: { code: "out-of-range" } });
    expect(locateEditorShotSequenceTime(sequence, sequence.totalDuration + 1)).toMatchObject({ ok: false, diagnostic: { code: "out-of-range" } });
    expect(locateEditorShotSequenceTime(sequence, -10_000, { outOfRange: "clamp" })).toMatchObject({ ok: true, index: 0, globalTime: 0, localTime: 0, clamped: true });
    expect(locateEditorShotSequenceTime(sequence, 10_000, { outOfRange: "clamp" })).toMatchObject({
      ok: true,
      index: 2,
      globalTime: sequence.totalDuration,
      localTime: 4,
      clamped: true,
      atFinalEndpoint: true,
    });
  });
});

describe("editor shot navigation and project clock", () => {
  test("manual inactive selection pauses at local zero while active reselect preserves the exact workspace", () => {
    const project = richProject();
    const source = project.shots[0];
    const initial = workspace(project, objectSelection(source, [source.objects[0].id]), 2);
    const reselected = resolveEditorShotActivation(project, initial, source.id);
    expect(reselected).toEqual({ ok: true, workspace: initial, playback: "preserve" });
    if (reselected.ok) expect(reselected.workspace).toBe(initial);

    const target = project.shots[1];
    expect(resolveEditorShotActivation(project, initial, target.id)).toEqual({
      ok: true,
      workspace: { activeShotId: target.id, selection: shotSelection([target.id]), playhead: 0 },
      playback: "pause",
    });
    const missing = resolveEditorShotActivation(project, initial, "shot-missing");
    expect(missing).toEqual({
      ok: false,
      workspace: initial,
      diagnostic: { code: "missing-shot", message: "Shot not found: shot-missing" },
    });
    expect(missing.workspace).toBe(initial);
  });

  test("derives and seeks canonical global time with half-open internal boundaries", () => {
    const project = sequenceProject([2, 3, 4]);
    const secondWorkspace: EditorShotWorkspace = {
      activeShotId: project.shots[1].id,
      selection: shotSelection([project.shots[1].id]),
      playhead: 1,
    };
    expect(deriveEditorShotSequencePosition(project, secondWorkspace)).toEqual({
      ok: true,
      workspace: secondWorkspace,
      globalTime: 3,
      atFinalEndpoint: false,
    });

    const firstWorkspace = workspace(project, { kind: "none", shotId: project.shots[0].id }, 1);
    const boundary = seekEditorShotSequence(project, firstWorkspace, 2);
    expect(boundary).toEqual({
      ok: true,
      workspace: {
        activeShotId: project.shots[1].id,
        selection: { kind: "none", shotId: project.shots[1].id },
        playhead: 0,
      },
      globalTime: 2,
      playback: "pause",
    });
    const final = seekEditorShotSequence(project, firstWorkspace, 9);
    expect(final).toMatchObject({
      ok: true,
      workspace: { activeShotId: project.shots[2].id, playhead: 4 },
      globalTime: 9,
      playback: "pause",
    });
  });

  test("advances across boundaries, stops at total, and play-at-end restarts the project", () => {
    const project = sequenceProject([2, 3, 4]);
    const initial = workspace(project, shotSelection([project.shots[0].id]), 1.5);
    const boundary = advanceEditorShotSequencePlayback(project, initial, 0.5);
    expect(boundary).toEqual({
      ok: true,
      workspace: {
        activeShotId: project.shots[1].id,
        selection: shotSelection([project.shots[1].id]),
        playhead: 0,
      },
      globalTime: 2,
      playback: "play",
    });
    if (!boundary.ok) return;
    const ended = advanceEditorShotSequencePlayback(project, boundary.workspace, 100_000);
    expect(ended).toMatchObject({
      ok: true,
      workspace: { activeShotId: project.shots[2].id, playhead: 4 },
      globalTime: 9,
      playback: "pause",
    });
    if (!ended.ok) return;
    expect(deriveEditorShotSequencePosition(project, ended.workspace)).toMatchObject({
      ok: true,
      globalTime: 9,
      atFinalEndpoint: true,
    });
    expect(beginEditorShotSequencePlayback(project, ended.workspace)).toEqual({
      ok: true,
      workspace: {
        activeShotId: project.shots[0].id,
        selection: shotSelection([project.shots[0].id]),
        playhead: 0,
      },
      globalTime: 0,
      playback: "play",
    });
  });

  test("canonicalizes an internal-end workspace on play and rejects invalid elapsed time without publication", () => {
    const project = sequenceProject([2, 3]);
    const internalEnd = workspace(project, shotSelection([project.shots[0].id]), 2);
    expect(beginEditorShotSequencePlayback(project, internalEnd)).toEqual({
      ok: true,
      workspace: {
        activeShotId: project.shots[1].id,
        selection: shotSelection([project.shots[1].id]),
        playhead: 0,
      },
      globalTime: 2,
      playback: "play",
    });
    const invalid = advanceEditorShotSequencePlayback(project, internalEnd, -1);
    expect(invalid).toEqual({
      ok: false,
      workspace: internalEnd,
      diagnostic: { code: "invalid-time", message: "Playback advance must be a non-negative finite duration" },
    });
    expect(invalid.workspace).toBe(internalEnd);
  });

  test("automatic shot changes normalize scene-local selection without carrying a focus authority", () => {
    const project = richProject();
    const source = project.shots[0];
    const initial = workspace(project, objectSelection(source, [source.objects[0].id]), 5.5);
    const crossed = advanceEditorShotSequencePlayback(project, initial, 0.5);
    expect(crossed).toEqual({
      ok: true,
      workspace: {
        activeShotId: project.shots[1].id,
        selection: shotSelection([project.shots[1].id]),
        playhead: 0,
      },
      globalTime: 6,
      playback: "play",
    });
    expect(Object.keys(crossed).sort()).toEqual(["globalTime", "ok", "playback", "workspace"]);
  });
});

describe("editor shot actions", () => {
  test("rejects incoherent shot-local selection before any document operation", () => {
    const project = richProject();
    const source = project.shots[0];
    const other = project.shots[1];
    const history = createHistory(project);
    const present = history.present;
    const staleKeyframe: EditorSelection = {
      kind: "keyframes",
      shotId: source.id,
      keyframes: [{
        trackId: source.propertyTracks[0].id,
        keyframeId: source.propertyTracks[1].keyframes[0].id,
      }],
      primaryKeyframe: {
        trackId: source.propertyTracks[0].id,
        keyframeId: source.propertyTracks[1].keyframes[0].id,
      },
    };
    const cases: ReadonlyArray<readonly [EditorShotWorkspace, string]> = [
      [{
        activeShotId: source.id,
        selection: shotSelection([other.id]),
        playhead: 1,
      }, `Shot selection must include active shot ${source.id}`],
      [{
        activeShotId: source.id,
        selection: shotSelection([source.id, other.id], other.id),
        playhead: 1,
      }, `Shot selection primary ${other.id} must equal active shot ${source.id}`],
      [{
        activeShotId: source.id,
        selection: shotSelection([source.id, "shot-stale"], source.id),
        playhead: 1,
      }, `Workspace selection is stale or non-canonical for active shot ${source.id}`],
      [{
        activeShotId: source.id,
        selection: {
          kind: "objects",
          shotId: source.id,
          objectIds: [source.objects[0].id, "object-stale"],
          primaryObjectId: source.objects[0].id,
        },
        playhead: 1,
      }, `Workspace selection is stale or non-canonical for active shot ${source.id}`],
      [{ activeShotId: source.id, selection: { kind: "none", shotId: other.id }, playhead: 1 }, `Workspace selection is stale or non-canonical for active shot ${source.id}`],
      [{ activeShotId: source.id, selection: staleKeyframe, playhead: 1 }, `Workspace selection is stale or non-canonical for active shot ${source.id}`],
    ];

    for (const [invalidWorkspace, message] of cases) {
      expect(validateEditorShotWorkspace(project, invalidWorkspace)).toEqual({
        ok: false,
        workspace: invalidWorkspace,
        diagnostic: { code: "invalid-workspace", message },
      });
      const rejected = commitEditorShotAction(history, invalidWorkspace, {
        type: "rename-shot",
        shotId: source.id,
        name: "Would otherwise apply",
      });
      expect(rejected).toEqual({
        ok: false,
        history,
        workspace: invalidWorkspace,
        diagnostic: { code: "invalid-workspace", message },
      });
      expect(rejected.history).toBe(history);
      expect(rejected.workspace).toBe(invalidWorkspace);
    }
    expect(history.past).toEqual([]);
    expect(history.present).toBe(present);
  });

  test("adds after the active shot with a logical-frame camera and resolves repeated actions from returned history", () => {
    const project = sequenceProject();
    const initial = createHistory(project);
    const firstWorkspace: EditorShotWorkspace = {
      activeShotId: project.shots[1].id,
      selection: shotSelection([project.shots[1].id]),
      playhead: 1,
    };
    const first = commitEditorShotAction(initial, firstWorkspace, { type: "add-shot" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstId = first.workspace.activeShotId;
    const frame = logicalFrameFor(project.settings.aspectRatio);
    expect(first.history.present.shots.map(({ id }) => id)).toEqual([project.shots[0].id, project.shots[1].id, firstId, project.shots[2].id]);
    expect(first.history.present.shots[2]).toMatchObject({
      id: firstId,
      duration: 6,
      objects: [],
      animations: [],
      propertyTracks: [],
      audioClips: [],
      captionClips: [],
      markers: [],
      camera: { x: frame.centerX, y: frame.centerY, zoom: 1, rotation: 0 },
    });
    expect(first.workspace).toEqual({ activeShotId: firstId, selection: shotSelection([firstId]), playhead: 0 });
    expect(first.playback).toBe("pause");
    expect(first.history.past).toHaveLength(1);

    const second = commitEditorShotAction(first.history, first.workspace, { type: "add-shot" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.workspace.activeShotId).not.toBe(firstId);
    expect(second.history.present.shots.map(({ id }) => id)).toEqual([
      project.shots[0].id,
      project.shots[1].id,
      firstId,
      second.workspace.activeShotId,
      project.shots[2].id,
    ]);
    expect(second.history.past).toHaveLength(2);
  });

  test("duplicates every shot-local authority once, maps every selection kind, and keeps redo IDs stable", () => {
    const project = richProject();
    const source = project.shots[0];
    const selections: Array<readonly [string, EditorSelection]> = [
      ["shot", shotSelection([source.id])],
      ["objects", objectSelection(source, [source.objects[1].id, source.objects[0].id], source.objects[1].id)],
      ["animation", animationSelection(source, [source.animations[1].id, source.animations[0].id], source.animations[1].id)],
      ["keyframes", keyframeSelection(source, [
        { trackId: source.propertyTracks[1].id, keyframeId: source.propertyTracks[1].keyframes[0].id },
        { trackId: source.propertyTracks[0].id, keyframeId: source.propertyTracks[0].keyframes[1].id },
      ], { trackId: source.propertyTracks[1].id, keyframeId: source.propertyTracks[1].keyframes[0].id })],
      ["markers", markerSelection(source, [source.markers[1].id, source.markers[0].id], source.markers[1].id)],
      ["none", { kind: "none", shotId: source.id }],
      ["project", projectSelection()],
    ];

    for (const [kind, selection] of selections) {
      const initial = createHistory(project);
      const resolved = commitEditorShotAction(initial, workspace(project, selection, 2), { type: "duplicate-shot", shotId: source.id });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      const mapping = resolved.result.idMappings[0].ids;
      const duplicate = resolved.history.present.shots[1];
      expect(resolved.workspace.activeShotId).toBe(duplicate.id);
      expect(resolved.workspace.playhead).toBe(0);
      expect(resolved.workspace.selection.kind).toBe(kind);
      expect(Object.keys(mapping).sort()).toEqual([...shotLocalIds(source)].sort());
      expect(Object.values(mapping).every((ids) => ids.length === 1)).toBe(true);
      expect(new Set([...shotLocalIds(source), ...shotLocalIds(duplicate)]).size).toBe(shotLocalIds(source).size + shotLocalIds(duplicate).size);
      expect({ ...duplicate.audioClips[0], id: source.audioClips[0].id }).toEqual(source.audioClips[0]);
      expect({ ...duplicate.captionClips[0], id: source.captionClips[0].id }).toEqual(source.captionClips[0]);
      if (resolved.workspace.selection.kind === "objects") expect(resolved.workspace.selection.primaryObjectId).toBe(mapping[source.objects[1].id][0]);
      if (resolved.workspace.selection.kind === "animation") expect(resolved.workspace.selection.primaryAnimationId).toBe(mapping[source.animations[1].id][0]);
      if (resolved.workspace.selection.kind === "markers") expect(resolved.workspace.selection.primaryMarkerId).toBe(mapping[source.markers[1].id][0]);
      if (resolved.workspace.selection.kind === "keyframes") {
        expect(resolved.workspace.selection.primaryKeyframe).toEqual({
          trackId: mapping[source.propertyTracks[1].id][0],
          keyframeId: mapping[source.propertyTracks[1].keyframes[0].id][0],
        });
      }
      const redone = redo(undo(resolved.history));
      expect(redone.present).toBe(resolved.history.present);
      expect(redone.present.shots[1].id).toBe(duplicate.id);
    }

    const coherentMulti = shotSelection([project.shots[1].id, source.id], source.id);
    const multi = commitEditorShotAction(createHistory(project), workspace(project, coherentMulti), { type: "duplicate-shot", shotId: source.id });
    expect(multi.ok).toBe(true);
    if (multi.ok && multi.workspace.selection.kind === "shot") {
      expect(multi.workspace.selection).toEqual(shotSelection(
        [project.shots[1].id, multi.workspace.activeShotId],
        multi.workspace.activeShotId,
      ));
    }
  });

  test("uses the returned duplicate as the latest source for sequential fresh-ID actions", () => {
    const project = richProject();
    const first = commitEditorShotAction(createHistory(project), workspace(project), { type: "duplicate-shot", shotId: project.shots[0].id });
    if (!first.ok) throw new Error(first.diagnostic.message);
    expect(first.ok).toBe(true);
    const second = commitEditorShotAction(first.history, first.workspace, { type: "duplicate-shot", shotId: first.workspace.activeShotId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(new Set(second.history.present.shots.map(({ id }) => id)).size).toBe(second.history.present.shots.length);
    expect(second.history.present.shots.slice(0, 3).map(({ id }) => id)).toEqual([
      project.shots[0].id,
      first.workspace.activeShotId,
      second.workspace.activeShotId,
    ]);
    expect(second.history.past).toHaveLength(2);
  });

  test("fails add and duplicate atomically at the 24-shot project ceiling", () => {
    const project = sequenceProject(Array.from({ length: 24 }, () => 1));
    const history = createHistory(project);
    const initialWorkspace = workspace(project);
    const add = commitEditorShotAction(history, initialWorkspace, { type: "add-shot" });
    const duplicate = commitEditorShotAction(history, initialWorkspace, {
      type: "duplicate-shot",
      shotId: project.shots[0].id,
    });
    for (const rejected of [add, duplicate]) {
      expect(rejected).toMatchObject({ ok: false, diagnostic: { code: "invalid-operation" } });
      expect(rejected.history).toBe(history);
      expect(rejected.workspace).toBe(initialWorkspace);
    }
    expect(history.present.shots).toHaveLength(24);
    expect(history.past).toEqual([]);
  });

  test("trims rename, preserves workspace, and applies absolute reorders against latest history", () => {
    const project = sequenceProject();
    const initialWorkspace = { ...workspace(project), playhead: 1 };
    const renamed = commitEditorShotAction(createHistory(project), initialWorkspace, { type: "rename-shot", shotId: project.shots[0].id, name: "  Opening proof  " });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.history.present.shots[0].name).toBe("Opening proof");
    expect(renamed.workspace).toBe(initialWorkspace);
    expect(renamed.playback).toBe("preserve");
    expect(deriveEditorShotSequencePosition(renamed.history.present, renamed.workspace)).toMatchObject({ ok: true, globalTime: 1 });

    const moved = commitEditorShotAction(renamed.history, renamed.workspace, { type: "reorder-shot", shotId: project.shots[0].id, index: 2 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.history.present.shots.map(({ id }) => id)).toEqual([project.shots[1].id, project.shots[2].id, project.shots[0].id]);
    expect(moved.workspace).toBe(renamed.workspace);
    expect(moved.playback).toBe("pause");
    expect(deriveEditorShotSequencePosition(moved.history.present, moved.workspace)).toMatchObject({ ok: true, globalTime: 8 });

    const movedAgain = commitEditorShotAction(moved.history, moved.workspace, { type: "reorder-shot", shotId: project.shots[0].id, index: 1 });
    expect(movedAgain.ok).toBe(true);
    if (!movedAgain.ok) return;
    expect(movedAgain.history.present.shots.map(({ id }) => id)).toEqual([project.shots[1].id, project.shots[0].id, project.shots[2].id]);
    expect(movedAgain.history.past).toHaveLength(3);
  });

  test("splits exactly once, chooses the right shot, and pairs one-to-many keyframe mappings inside it", () => {
    const project = richProject();
    const source = project.shots[0];
    const selected = keyframeSelection(source, [{
      trackId: "track-sequence-a-x",
      keyframeId: "keyframe-sequence-a-boundary",
    }]);
    const initial = createHistory(project);
    expect(deriveEditorShotSequencePosition(project, workspace(project, selected, 3))).toMatchObject({ ok: true, globalTime: 3 });
    const resolved = commitEditorShotAction(initial, workspace(project, selected, 3), { type: "split-shot", shotId: source.id, time: 3.000000004 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.history.present.shots).toHaveLength(project.shots.length + 1);
    expect(resolved.history.past).toHaveLength(1);
    expect(resolved.result.idMappings).toHaveLength(1);
    const mapping = resolved.result.idMappings[0].ids;
    const [leftId, rightId] = mapping[source.id];
    expect(leftId).toBe(source.id);
    expect(resolved.workspace).toMatchObject({ activeShotId: rightId, playhead: 0 });
    expect(deriveEditorShotSequencePosition(resolved.history.present, resolved.workspace)).toMatchObject({ ok: true, globalTime: 3 });
    expect(resolved.playback).toBe("pause");
    const right = resolved.history.present.shots.find(({ id }) => id === rightId)!;
    expect(resolved.workspace.selection.kind).toBe("keyframes");
    if (resolved.workspace.selection.kind === "keyframes") {
      const primary = resolved.workspace.selection.primaryKeyframe;
      expect(mapping["track-sequence-a-x"]).toContain(primary.trackId);
      expect(mapping["keyframe-sequence-a-boundary"]).toContain(primary.keyframeId);
      expect(right.propertyTracks.find(({ id }) => id === primary.trackId)?.keyframes.some(({ id }) => id === primary.keyframeId)).toBe(true);
      expect(primary.trackId).not.toBe("track-sequence-a-x");
      expect(primary.keyframeId).not.toBe("keyframe-sequence-a-boundary");
    }
    expect(right.audioClips[0]).toMatchObject({ id: "audio-sequence-right", start: 1, duration: 1 });
    expect(right.captionClips[0]).toMatchObject({ id: "caption-sequence-right", start: 1, end: 2 });
    expect(right.markers.find(({ id }) => id === "marker-sequence-right")?.time).toBe(1);
    expect(undo(resolved.history).present).toBe(initial.present);

    const leftOnly = commitEditorShotAction(
      createHistory(project),
      workspace(project, animationSelection(source, ["animation-sequence-left"]), 3),
      { type: "split-shot", shotId: source.id, time: 3 },
    );
    expect(leftOnly).toMatchObject({ ok: true, workspace: { selection: { kind: "none" } } });

    const coherentMulti = shotSelection([project.shots[1].id, source.id], source.id);
    const multi = commitEditorShotAction(
      createHistory(project),
      workspace(project, coherentMulti, 3),
      { type: "split-shot", shotId: source.id, time: 3 },
    );
    expect(multi.ok).toBe(true);
    if (multi.ok && multi.workspace.selection.kind === "shot") {
      expect(multi.workspace.selection).toEqual(shotSelection(
        [project.shots[1].id, multi.workspace.activeShotId],
        multi.workspace.activeShotId,
      ));
    }
  });

  test.each([15, 24, 30, 60] as const)("enforces one full frame on both sides of a split at %ifps", (frameRate) => {
    const draft = sequenceProject([2]);
    draft.settings.frameRate = frameRate;
    const project = ProjectDocumentSchema.parse(draft);
    const oneFrame = frameToSeconds(1, frameRate);
    const belowFrame = timelineTimeForTick(timelineTickFor(oneFrame) - 1);
    const rightBelowBoundary = timelineTimeForTick(timelineTickFor(2) - timelineTickFor(belowFrame));
    const message = `Split must leave at least one ${frameRate}fps frame (${oneFrame}s) on each side`;

    for (const boundary of [belowFrame, rightBelowBoundary]) {
      const history = createHistory(project);
      const initialWorkspace = workspace(project, shotSelection([project.shots[0].id]), boundary);
      const rejected = commitEditorShotAction(history, initialWorkspace, {
        type: "split-shot",
        shotId: project.shots[0].id,
        time: boundary,
      });
      expect(rejected).toEqual({
        ok: false,
        history,
        workspace: initialWorkspace,
        diagnostic: { code: "invalid-operation", message },
      });
      expect(rejected.history).toBe(history);
      expect(rejected.workspace).toBe(initialWorkspace);
    }

    for (const boundary of [oneFrame, timelineTimeForTick(timelineTickFor(2) - timelineTickFor(oneFrame))]) {
      const accepted = commitEditorShotAction(
        createHistory(project),
        workspace(project, shotSelection([project.shots[0].id]), boundary),
        { type: "split-shot", shotId: project.shots[0].id, time: boundary },
      );
      expect(accepted).toMatchObject({ ok: true, workspace: { playhead: 0 }, playback: "pause" });
      if (accepted.ok) {
        expect(accepted.history.present.shots.every(({ duration }) => timelineTickFor(duration) >= timelineTickFor(oneFrame))).toBe(true);
      }
    }
  });

  test("rejects crossing authored content with its exact ID", () => {
    const crossingDraft = richProject();
    crossingDraft.shots[0].animations.push({
      id: "animation-editor-crossing",
      type: "scale",
      targetIds: ["object-sequence-motion"],
      start: 2.5,
      duration: 1,
      easing: "linear",
      properties: { scale: 1.3 },
    });
    const crossing = ProjectDocumentSchema.parse(crossingDraft);
    const history = createHistory(crossing);
    const initialWorkspace = workspace(crossing, shotSelection([crossing.shots[0].id]), 3);
    const rejected = commitEditorShotAction(history, initialWorkspace, {
      type: "split-shot",
      shotId: crossing.shots[0].id,
      time: 3,
    });
    expect(rejected).toEqual({
      ok: false,
      history,
      workspace: initialWorkspace,
      diagnostic: {
        code: "invalid-operation",
        message: "Document operation 1: Animation animation-editor-crossing crosses the split boundary",
      },
    });
    expect(rejected.history).toBe(history);
    expect(rejected.workspace).toBe(initialWorkspace);
  });

  test.each([
    ["objects", (shot: Shot) => objectSelection(shot, ["object-sequence-a"])],
    ["animation", (shot: Shot) => animationSelection(shot, ["animation-sequence-right"])],
    ["markers", (shot: Shot) => markerSelection(shot, ["marker-sequence-right"])],
    ["none", (shot: Shot) => ({ kind: "none", shotId: shot.id }) as EditorSelection],
    ["project", () => projectSelection()],
    ["shot", (shot: Shot) => shotSelection([shot.id])],
  ] as const)("filters %s selection through the chosen split shot", (kind, selectionFor) => {
    const project = richProject();
    const source = project.shots[0];
    const resolved = commitEditorShotAction(createHistory(project), workspace(project, selectionFor(source), 3), { type: "split-shot", shotId: source.id, time: 3 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.workspace.selection.kind).toBe(kind);
    if (resolved.workspace.selection.kind !== "project") expect("shotId" in resolved.workspace.selection ? resolved.workspace.selection.shotId : resolved.workspace.activeShotId).toBe(resolved.workspace.activeShotId);
  });

  test("merges through the surviving left mapping and offsets active-right local time", () => {
    const project = richProject();
    const split = commitEditorShotAction(createHistory(project), workspace(project, shotSelection([project.shots[0].id]), 3), { type: "split-shot", shotId: project.shots[0].id, time: 3 });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const [left, right] = split.history.present.shots;
    const rightMarker = right.markers[0];
    const rightWorkspace: EditorShotWorkspace = {
      activeShotId: right.id,
      selection: markerSelection(right, [rightMarker.id]),
      playhead: 1,
    };
    expect(deriveEditorShotSequencePosition(split.history.present, rightWorkspace)).toMatchObject({ ok: true, globalTime: 4 });
    const merged = commitEditorShotAction(split.history, rightWorkspace, { type: "merge-shots", leftShotId: left.id, rightShotId: right.id });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.workspace.activeShotId).toBe(left.id);
    expect(merged.workspace.playhead).toBe(4);
    expect(deriveEditorShotSequencePosition(merged.history.present, merged.workspace)).toMatchObject({ ok: true, globalTime: 4 });
    expect(merged.workspace.selection).toMatchObject({ kind: "markers", shotId: left.id, primaryMarkerId: rightMarker.id });
    expect(merged.history.present.shots).toHaveLength(project.shots.length);
    const restored = merged.history.present.shots[0];
    expect(restored.audioClips[0]).toMatchObject({ id: "audio-sequence-right", start: 4, duration: 1 });
    expect(restored.captionClips[0]).toMatchObject({ id: "caption-sequence-right", start: 4, end: 5 });
    expect(restored.audioClips).toEqual(project.shots[0].audioClips);
    expect(restored.captionClips).toEqual(project.shots[0].captionClips);
    expect(merged.result.idMappings[0].ids[right.id]).toEqual([left.id]);

    const leftWorkspace: EditorShotWorkspace = { activeShotId: left.id, selection: shotSelection([left.id]), playhead: 2 };
    const leftMerge = commitEditorShotAction(split.history, leftWorkspace, { type: "merge-shots", leftShotId: left.id, rightShotId: right.id });
    expect(leftMerge).toMatchObject({ ok: true, workspace: { activeShotId: left.id, playhead: 2 } });

    const multiShotWorkspace: EditorShotWorkspace = {
      activeShotId: right.id,
      selection: shotSelection([left.id, project.shots[1].id, right.id], right.id),
      playhead: 1,
    };
    const multiShotMerge = commitEditorShotAction(
      split.history,
      multiShotWorkspace,
      { type: "merge-shots", leftShotId: left.id, rightShotId: right.id },
    );
    expect(multiShotMerge.ok).toBe(true);
    if (multiShotMerge.ok && multiShotMerge.workspace.selection.kind === "shot") {
      expect(multiShotMerge.workspace.selection).toEqual(shotSelection(
        [project.shots[1].id, left.id],
        left.id,
      ));
    }
  });

  test("rejects an incompatible merge atomically with the downstream boundary diagnostic", () => {
    const draft = sequenceProject([2, 3]);
    draft.shots[1].camera.x += 1;
    const project = ProjectDocumentSchema.parse(draft);
    const history = createHistory(project);
    const initialWorkspace = workspace(project);
    const rejected = commitEditorShotAction(history, initialWorkspace, {
      type: "merge-shots",
      leftShotId: project.shots[0].id,
      rightShotId: project.shots[1].id,
    });
    expect(rejected).toEqual({
      ok: false,
      history,
      workspace: initialWorkspace,
      diagnostic: {
        code: "invalid-operation",
        message: "Document operation 1: Shot cameras do not meet at the boundary; merge would introduce a camera jump",
      },
    });
    expect(rejected.history).toBe(history);
    expect(rejected.workspace).toBe(initialWorkspace);
  });

  test("deletes the next same-index neighbor, then the previous neighbor, without ever publishing an invalid final deletion", () => {
    const project = sequenceProject();
    const middleWorkspace: EditorShotWorkspace = {
      activeShotId: project.shots[1].id,
      selection: shotSelection([project.shots[0].id, project.shots[1].id], project.shots[1].id),
      playhead: 1,
    };
    const middle = commitEditorShotAction(createHistory(project), middleWorkspace, { type: "delete-shot", shotId: project.shots[1].id });
    expect(middle).toMatchObject({ ok: true, workspace: { activeShotId: project.shots[2].id, playhead: 0 }, playback: "pause" });
    if (!middle.ok) return;
    expect(middle.workspace.selection).toEqual(shotSelection(
      [project.shots[0].id, project.shots[2].id],
      project.shots[2].id,
    ));

    const lastWorkspace: EditorShotWorkspace = { activeShotId: project.shots[2].id, selection: { kind: "none", shotId: project.shots[2].id }, playhead: 2 };
    const last = commitEditorShotAction(createHistory(project), lastWorkspace, { type: "delete-shot", shotId: project.shots[2].id });
    expect(last).toMatchObject({ ok: true, workspace: { activeShotId: project.shots[1].id, playhead: 0 } });

    const inactiveWorkspace = workspace(project, { kind: "none", shotId: project.shots[0].id }, 1);
    const inactive = commitEditorShotAction(createHistory(project), inactiveWorkspace, { type: "delete-shot", shotId: project.shots[2].id });
    expect(inactive).toMatchObject({ ok: true, workspace: { activeShotId: project.shots[0].id, playhead: 1, selection: { kind: "none", shotId: project.shots[0].id } } });

    const single = sequenceProject([2]);
    const singleHistory = createHistory(single);
    const singleWorkspace = workspace(single);
    const rejected = commitEditorShotAction(singleHistory, singleWorkspace, { type: "delete-shot", shotId: single.shots[0].id });
    expect(rejected).toMatchObject({ ok: false, diagnostic: { code: "invalid-operation" } });
    expect(rejected.history).toBe(singleHistory);
    expect(rejected.workspace).toBe(singleWorkspace);
  });

  test("changes duration through typed authority and clamps playhead only after a successful shrink", () => {
    const project = sequenceProject([6]);
    const initial = createHistory(project);
    const lateWorkspace = workspace(project, shotSelection([project.shots[0].id]), 5);
    const shrunk = commitEditorShotAction(initial, lateWorkspace, { type: "set-shot-duration", shotId: project.shots[0].id, duration: 2 });
    expect(shrunk).toMatchObject({ ok: true, workspace: { playhead: 2 }, playback: "pause" });
    if (!shrunk.ok) return;
    const earlyWorkspace = { ...shrunk.workspace, playhead: 1 };
    const extended = commitEditorShotAction(shrunk.history, earlyWorkspace, { type: "set-shot-duration", shotId: project.shots[0].id, duration: 7 });
    expect(extended).toMatchObject({ ok: true, workspace: { playhead: 1 }, playback: "pause" });
    if (extended.ok) {
      expect(extended.history.present.shots[0].duration).toBe(7);
      expect(buildEditorShotSequence(extended.history.present).totalDuration).toBe(7);
    }

    const multi = sequenceProject([6, 2]);
    const inactiveWorkspace = workspace(multi, shotSelection([multi.shots[0].id]), 1);
    const inactive = commitEditorShotAction(createHistory(multi), inactiveWorkspace, {
      type: "set-shot-duration",
      shotId: multi.shots[1].id,
      duration: 3,
    });
    expect(inactive).toMatchObject({ ok: true, workspace: inactiveWorkspace, playback: "pause" });
    if (inactive.ok) {
      expect(inactive.workspace).toBe(inactiveWorkspace);
      expect(inactive.history.present.shots[1].duration).toBe(3);
      expect(buildEditorShotSequence(inactive.history.present).totalDuration).toBe(9);
    }
  });

  test.each([
    ["object lifetime", (shot: Shot) => { shot.objects = [sceneObject("object-duration", "Duration", 100)]; shot.objects[0].lifetime = { start: 0, end: 5 }; }, "Document operation 1: Shot duration would truncate object lifetime object-duration"],
    ["animation", (shot: Shot) => { shot.objects = [sceneObject("object-duration", "Duration", 100)]; shot.animations = [{ id: "animation-duration", type: "scale", targetIds: ["object-duration"], start: 4, duration: 1, easing: "linear", properties: { scale: 1.1 } }]; }, "Document operation 1: Shot duration would truncate animation animation-duration"],
    ["property track", (shot: Shot) => { shot.objects = [sceneObject("object-duration", "Duration", 100)]; shot.propertyTracks = [{ id: "track-duration", target: { kind: "object", objectId: "object-duration" }, property: "x", keyframes: [{ id: "keyframe-duration-a", time: 0, value: 100, interpolation: { kind: "linear" } }, { id: "keyframe-duration-b", time: 5, value: 200, interpolation: { kind: "linear" } }] }]; }, "Document operation 1: Shot duration would truncate property track track-duration"],
    ["audio clip", (shot: Shot, project: ProjectDocument) => { project.assets = [{ id: "asset-duration", filename: "duration.wav", mimeType: "audio/wav", size: 32, sha256: "b".repeat(64), duration: 10, provenance: "uploaded" }]; shot.audioClips = [{ id: "audio-duration", assetId: "asset-duration", name: "Duration audio", start: 4, duration: 1, sourceStart: 0, sourceEnd: 1, volume: 1, muted: false, solo: false }]; }, "Document operation 1: Shot duration would truncate audio clip audio-duration"],
    ["caption", (shot: Shot) => { shot.captionClips = [{ id: "caption-duration", start: 4, end: 5, text: "Duration", style: {} }]; }, "Document operation 1: Shot duration would truncate caption caption-duration"],
    ["marker", (shot: Shot) => { shot.markers = [{ id: "marker-duration", time: 5, name: "Duration", color: "#112233" }]; }, "Document operation 1: Shot duration would truncate marker marker-duration"],
  ] as const)("includes %s in the authored minimum and reports the exact truncation authority", (_label, author, message) => {
    const draft = sequenceProject([6]);
    author(draft.shots[0], draft);
    const project = ProjectDocumentSchema.parse(draft);
    expect(minimumAuthoredShotDuration(project, project.shots[0])).toBe(5);
    const initial = createHistory(project);
    const initialWorkspace = workspace(project, shotSelection([project.shots[0].id]), 3);
    const rejected = commitEditorShotAction(initial, initialWorkspace, { type: "set-shot-duration", shotId: project.shots[0].id, duration: 4 });
    expect(rejected).toEqual({
      ok: false,
      history: initial,
      workspace: initialWorkspace,
      diagnostic: { code: "invalid-operation", message },
    });
    expect(rejected.history).toBe(initial);
    expect(rejected.workspace).toBe(initialWorkspace);
    expect(canonicalProjectJson(initial.present)).toBe(canonicalProjectJson(project));
  });

  test.each([15, 24, 30, 60] as const)("uses exactly one authored frame as the blank-shot minimum at %ifps", (frameRate) => {
    const project = sequenceProject([2]);
    project.settings.frameRate = frameRate;
    const canonical = ProjectDocumentSchema.parse(project);
    expect(minimumAuthoredShotDuration(canonical, canonical.shots[0])).toBe(frameToSeconds(1, frameRate));
  });

  test.each([15, 24, 30, 60] as const)("rejects below and accepts exactly one authored frame at %ifps", (frameRate) => {
    const draft = sequenceProject([2]);
    draft.settings.frameRate = frameRate;
    const project = ProjectDocumentSchema.parse(draft);
    const history = createHistory(project);
    const initialWorkspace = workspace(project);
    const oneFrame = frameToSeconds(1, frameRate);
    const belowFrame = timelineTimeForTick(timelineTickFor(oneFrame) - 1);
    const rejected = commitEditorShotAction(history, initialWorkspace, {
      type: "set-shot-duration",
      shotId: project.shots[0].id,
      duration: belowFrame,
    });
    expect(rejected).toEqual({
      ok: false,
      history,
      workspace: initialWorkspace,
      diagnostic: {
        code: "invalid-operation",
        message: `Shot duration must be at least one ${frameRate}fps frame (${oneFrame}s)`,
      },
    });
    expect(rejected.history).toBe(history);
    expect(rejected.workspace).toBe(initialWorkspace);

    const accepted = commitEditorShotAction(history, initialWorkspace, {
      type: "set-shot-duration",
      shotId: project.shots[0].id,
      duration: oneFrame,
    });
    expect(accepted).toMatchObject({ ok: true, playback: "pause" });
    if (accepted.ok) {
      expect(accepted.history.present.shots[0].duration).toBe(oneFrame);
      expect(accepted.history.past).toHaveLength(1);
    }
  });

  test("returns exact input identities for stale, invalid, missing, and no-op actions", () => {
    const project = sequenceProject();
    const history = createHistory(project);
    const currentWorkspace = workspace(project);
    const stalePlayheadWorkspace = { ...currentWorkspace, playhead: 1 };
    const cases = [
      [commitEditorShotAction(history, currentWorkspace, { type: "add-shot", expectedRevision: `${canonicalProjectJson(project)} stale` }), currentWorkspace],
      [commitEditorShotAction(history, currentWorkspace, { type: "rename-shot", shotId: project.shots[0].id, name: "   " }), currentWorkspace],
      [commitEditorShotAction(history, currentWorkspace, { type: "rename-shot", shotId: "missing", name: "Missing" }), currentWorkspace],
      [commitEditorShotAction(history, currentWorkspace, { type: "reorder-shot", shotId: project.shots[0].id, index: 0 }), currentWorkspace],
      [commitEditorShotAction(history, currentWorkspace, { type: "split-shot", shotId: project.shots[0].id, time: 0 }), currentWorkspace],
      [commitEditorShotAction(history, currentWorkspace, { type: "set-shot-duration", shotId: project.shots[0].id, duration: Number.NaN }), currentWorkspace],
      [commitEditorShotAction(history, stalePlayheadWorkspace, { type: "split-shot", shotId: project.shots[0].id, time: 1.5 }), stalePlayheadWorkspace],
    ];
    expect(cases.map(([result]) => result.ok)).toEqual([false, false, false, false, false, false, false]);
    for (const [result, expectedWorkspace] of cases) {
      expect(result.history).toBe(history);
      expect(result.workspace).toBe(expectedWorkspace);
    }
    expect(history.past).toEqual([]);
    expect(history.present).toEqual(project);
  });

  test("preserves immutable archived snapshots across successful sequence commands", () => {
    const project = sequenceProject();
    const initial = createHistory(project);
    const initialSnapshot = initial.present;
    const added = commitEditorShotAction(initial, workspace(project), { type: "add-shot" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const firstEntry = added.history.past[0];
    const renamed = commitEditorShotAction(added.history, added.workspace, { type: "rename-shot", shotId: added.workspace.activeShotId, name: "Fresh scene" });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.history.past[0]).toBe(firstEntry);
    expect(renamed.history.past[0].project).toBe(initialSnapshot);
    expect(initialSnapshot.shots).toHaveLength(project.shots.length);
  });
});
