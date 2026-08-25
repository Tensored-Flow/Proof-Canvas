import {
  AUTHORING_POLICY_EXCLUDED_COMPILER_CODES,
  analyzeProjectAuthoringTransition,
  projectTimelineAuthoringIssues,
} from "../authoringPolicy";
import { buildCompilerSchedule } from "../compilerSchedule";
import { compileManim } from "../compiler";
import { createCantorDemoProject } from "../demo";
import { ProjectDocumentSchema, cloneSerializable, type ProjectDocument, type PropertyTrack, type SceneObject } from "../schema";

function baseProject(): ProjectDocument {
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

function holdTrack(): PropertyTrack {
  return {
    id: "track-policy-title-x",
    target: { kind: "object", objectId: "object-title" },
    property: "x",
    keyframes: [
      { id: "keyframe-policy-title-x-a", time: 0, value: 100, interpolation: { kind: "hold" } },
      { id: "keyframe-policy-title-x-b", time: 4, value: 300, interpolation: { kind: "linear" } },
    ],
  };
}

function semanticConflictProject(): ProjectDocument {
  const project = cloneSerializable(baseProject());
  const shot = project.shots[0];
  shot.propertyTracks = [holdTrack()];
  shot.animations = [{
    id: "animation-policy-title-move",
    type: "move",
    targetIds: ["object-title"],
    start: 1,
    duration: 1,
    easing: "linear",
    properties: { deltaX: 20 },
  }];
  return ProjectDocumentSchema.parse(project);
}

function trackTrackConflictProject(): ProjectDocument {
  const project = cloneSerializable(baseProject());
  project.shots[0].propertyTracks = [
    holdTrack(),
    {
      id: "track-policy-title-y",
      target: { kind: "object", objectId: "object-title" },
      property: "y",
      keyframes: [
        { id: "keyframe-policy-title-y-a", time: 1, value: 100, interpolation: { kind: "linear" } },
        { id: "keyframe-policy-title-y-b", time: 3, value: 200, interpolation: { kind: "linear" } },
      ],
    },
  ];
  return ProjectDocumentSchema.parse(project);
}

function domainConflictProject(): ProjectDocument {
  const project = cloneSerializable(baseProject());
  const curve = { x1: 0.25, y1: -1, x2: 0.75, y2: 2 };
  project.shots[0].propertyTracks = [{
    id: "track-policy-unsafe-opacity",
    target: { kind: "object", objectId: "object-title" },
    property: "opacity",
    keyframes: [
      { id: "keyframe-policy-opacity-a", time: 0, value: 0, interpolation: { kind: "custom-bezier", curve } },
      { id: "keyframe-policy-opacity-b", time: 2, value: 1, interpolation: { kind: "linear" } },
    ],
  }];
  return ProjectDocumentSchema.parse(project);
}

function hierarchicalSemanticConflictProject(): ProjectDocument {
  const project = cloneSerializable(baseProject());
  const source = createCantorDemoProject().shots[0];
  const group = cloneSerializable(source.objects.find(({ id }) => id === "object-interval-diagram")!);
  const participant = cloneSerializable(source.objects.find(({ id }) => id === "object-interval-generation-0")!);
  const unrelated = cloneSerializable(source.objects.find(({ id }) => id === "object-interval-left-1")!);
  delete group.parentId;
  group.locked = false;
  group.lifetime = { start: 0, end: 8 };
  participant.parentId = group.id;
  participant.locked = false;
  participant.lifetime = { start: 0, end: 8 };
  unrelated.parentId = group.id;
  unrelated.locked = false;
  unrelated.lifetime = { start: 0, end: 8 };
  project.shots[0].objects = [group, participant, unrelated];
  project.shots[0].propertyTracks = [{ ...holdTrack(), target: { kind: "object", objectId: group.id } }];
  project.shots[0].animations = [{
    id: "animation-policy-descendant-move",
    type: "move",
    targetIds: [participant.id],
    start: 1,
    duration: 1,
    easing: "linear",
    properties: { deltaX: 20 },
  }];
  return ProjectDocumentSchema.parse(project);
}

function lifetimeConflictProject(): ProjectDocument {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  const group = cloneSerializable(shot.objects.find(({ id }) => id === "object-interval-diagram")!);
  const child = cloneSerializable(shot.objects.find(({ id }) => id === "object-interval-generation-0")!);
  delete group.parentId;
  group.locked = false;
  group.lifetime = { start: 0, end: 8 };
  child.parentId = group.id;
  child.locked = false;
  child.lifetime = { start: 2, end: 8 };
  shot.duration = 8;
  shot.objects = [group, child];
  shot.animations = [{
    id: "animation-policy-group-move",
    type: "move",
    targetIds: [group.id],
    start: 1,
    duration: 2,
    easing: "linear",
    properties: { deltaX: 20 },
  }];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  project.shots = [shot];
  return ProjectDocumentSchema.parse(project);
}

function manyConflictsProject(): ProjectDocument {
  const project = cloneSerializable(baseProject());
  const shot = project.shots[0];
  const leaf = shot.objects[0];
  const sourceGroup = cloneSerializable(createCantorDemoProject().shots[0].objects.find(({ type }) => type === "group")!);
  const groups: SceneObject[] = Array.from({ length: 15 }, (_, index) => ({
    ...cloneSerializable(sourceGroup),
    id: `object-policy-chain-${index}`,
    name: `Policy chain ${index}`,
    parentId: index === 0 ? undefined : `object-policy-chain-${index - 1}`,
    locked: false,
    lifetime: { start: 0, end: 8 },
  }));
  leaf.parentId = groups.at(-1)!.id;
  shot.objects = [...groups, leaf];
  shot.propertyTracks = shot.objects.map((object, index) => ({
    id: `track-policy-chain-${index}`,
    target: { kind: "object" as const, objectId: object.id },
    property: "x" as const,
    keyframes: [
      { id: `keyframe-policy-chain-${index}-a`, time: 0, value: index, interpolation: { kind: "linear" as const } },
      { id: `keyframe-policy-chain-${index}-b`, time: 4, value: index + 20, interpolation: { kind: "linear" as const } },
    ],
  }));
  return ProjectDocumentSchema.parse(project);
}

describe("timeline authoring transition policy", () => {
  test("exposes structured compiler counterparts separately from diagnostic prose", () => {
    const project = cloneSerializable(baseProject());
    const shot = project.shots[0];
    shot.propertyTracks = [
      holdTrack(),
      {
        id: "track-policy-title-y",
        target: { kind: "object", objectId: "object-title" },
        property: "y",
        keyframes: [
          { id: "keyframe-policy-title-y-a", time: 1, value: 100, interpolation: { kind: "linear" } },
          { id: "keyframe-policy-title-y-b", time: 3, value: 200, interpolation: { kind: "linear" } },
        ],
      },
    ];
    const valid = ProjectDocumentSchema.parse(project);
    const schedule = buildCompilerSchedule(valid.shots[0], valid.settings.frameRate);
    expect(schedule.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "TRACK_TRACK_COLLISION",
        trackId: "track-policy-title-x",
        conflictingTrackId: "track-policy-title-y",
      }),
    ]));
    expect(schedule.authorityIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "TRACK_TRACK_COLLISION",
        trackId: "track-policy-title-x",
        conflictingTrackId: "track-policy-title-y",
      }),
    ]));
    expect(compileManim(valid).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "TRACK_TRACK_COLLISION",
        trackId: "track-policy-title-x",
        conflictingTrackId: "track-policy-title-y",
      }),
    ]));
  });

  test("allows unchanged legacy authority through unrelated edits and deletion repair", () => {
    const legacy = semanticConflictProject();
    const issue = projectTimelineAuthoringIssues(legacy)[0];
    expect(issue).toMatchObject({
      code: "TRACK_SEMANTIC_COLLISION",
      shotId: legacy.shots[0].id,
      trackId: "track-policy-title-x",
      animationId: "animation-policy-title-move",
    });

    const unrelated = cloneSerializable(legacy);
    unrelated.metadata.title = "Unrelated project rename";
    unrelated.shots[0].objects[0].name = "Unrelated object rename";
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(unrelated))).toMatchObject({ allowed: true });

    const repaired = cloneSerializable(legacy);
    repaired.shots[0].propertyTracks = [];
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(repaired))).toMatchObject({ allowed: true, nextIssues: [] });
  });

  test.each([
    ["semantic", semanticConflictProject, "TRACK_SEMANTIC_COLLISION"],
    ["track-track", trackTrackConflictProject, "TRACK_TRACK_COLLISION"],
    ["domain", domainConflictProject, "TRACK_EASING_DOMAIN_UNSAFE"],
  ] as const)("allows a pure duration extension for an unchanged %s issue", (_label, createProject, code) => {
    const legacy = createProject();
    expect(projectTimelineAuthoringIssues(legacy)).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    const extended = cloneSerializable(legacy);
    extended.shots[0].duration = 9;
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(extended))).toMatchObject({ allowed: true });
  });

  test("ignores unrelated descendant hierarchy, visibility, and lifetime bytes", () => {
    const legacy = hierarchicalSemanticConflictProject();
    const unrelated = cloneSerializable(legacy);
    const sibling = unrelated.shots[0].objects.find(({ id }) => id === "object-interval-left-1")!;
    delete sibling.parentId;
    sibling.visible = false;
    sibling.lifetime = { start: 3, end: 7 };
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(unrelated))).toMatchObject({ allowed: true });
  });

  test("rejects modified invalid track or animation even when relation IDs and code remain the same", () => {
    const legacy = semanticConflictProject();
    const changedTrack = cloneSerializable(legacy);
    changedTrack.shots[0].propertyTracks[0].keyframes[0].value = 101;
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(changedTrack))).toMatchObject({
      allowed: false,
      reason: "modified-timeline-authority",
      issue: { trackId: "track-policy-title-x", animationId: "animation-policy-title-move" },
    });

    const changedAnimation = cloneSerializable(legacy);
    changedAnimation.shots[0].animations[0].properties.deltaX = 30;
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(changedAnimation))).toMatchObject({
      allowed: false,
      reason: "modified-timeline-authority",
    });
  });

  test("rejects a second collider while preserving the prior relation", () => {
    const legacy = semanticConflictProject();
    const worsened = cloneSerializable(legacy);
    worsened.shots[0].animations.push({
      id: "animation-policy-title-move-two",
      type: "move",
      targetIds: ["object-title"],
      start: 2.5,
      duration: 1,
      easing: "linear",
      properties: { deltaX: 30 },
    });
    const analysis = analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(worsened));
    expect(analysis).toMatchObject({
      allowed: false,
      reason: "introduced-timeline-authority",
      issue: { animationId: "animation-policy-title-move-two", trackId: "track-policy-title-x" },
    });
  });

  test("allows partial repair when the surviving relation authority is byte-identical", () => {
    const legacy = cloneSerializable(semanticConflictProject());
    legacy.shots[0].animations.push({
      id: "animation-policy-title-move-two",
      type: "move",
      targetIds: ["object-title"],
      start: 2.5,
      duration: 1,
      easing: "linear",
      properties: { deltaX: 30 },
    });
    const previous = ProjectDocumentSchema.parse(legacy);
    const partiallyRepaired = cloneSerializable(previous);
    partiallyRepaired.shots[0].animations = partiallyRepaired.shots[0].animations.filter(({ id }) => id !== "animation-policy-title-move-two");
    expect(analyzeProjectAuthoringTransition(previous, ProjectDocumentSchema.parse(partiallyRepaired))).toMatchObject({
      allowed: true,
      previousIssues: expect.arrayContaining([expect.objectContaining({ animationId: "animation-policy-title-move-two" })]),
      nextIssues: [expect.objectContaining({ animationId: "animation-policy-title-move" })],
    });
  });

  test("rejects replacing a structured track counterpart even when the error code is unchanged", () => {
    const legacy = cloneSerializable(baseProject());
    legacy.shots[0].propertyTracks = [
      holdTrack(),
      {
        id: "track-policy-title-y",
        target: { kind: "object", objectId: "object-title" },
        property: "y",
        keyframes: [
          { id: "keyframe-policy-title-y-a", time: 1, value: 100, interpolation: { kind: "linear" } },
          { id: "keyframe-policy-title-y-b", time: 3, value: 200, interpolation: { kind: "linear" } },
        ],
      },
    ];
    const previous = ProjectDocumentSchema.parse(legacy);
    const replaced = cloneSerializable(previous);
    const counterpart = replaced.shots[0].propertyTracks[1];
    counterpart.id = "track-policy-title-z";
    counterpart.keyframes[0].id = "keyframe-policy-title-z-a";
    counterpart.keyframes[1].id = "keyframe-policy-title-z-b";
    expect(analyzeProjectAuthoringTransition(previous, ProjectDocumentSchema.parse(replaced))).toMatchObject({
      allowed: false,
      reason: "introduced-timeline-authority",
      issue: { code: "TRACK_TRACK_COLLISION", trackId: "track-policy-title-x", conflictingTrackId: "track-policy-title-z" },
    });
  });

  test("retains lifetime edge kind, boundary authority, and causal parent path", () => {
    const legacy = lifetimeConflictProject();
    expect(projectTimelineAuthoringIssues(legacy)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "LIFETIME_SEMANTIC_COLLISION",
        objectId: "object-interval-generation-0",
        animationId: "animation-policy-group-move",
        lifetimeBoundary: "enter",
      }),
    ]));
    const unrelatedVisibility = cloneSerializable(legacy);
    unrelatedVisibility.shots[0].objects.find(({ id }) => id === "object-interval-diagram")!.visible = false;
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(unrelatedVisibility))).toMatchObject({ allowed: true });

    const nonBindingParentStart = cloneSerializable(legacy);
    nonBindingParentStart.shots[0].objects.find(({ id }) => id === "object-interval-diagram")!.lifetime = { start: 0.5, end: 8 };
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(nonBindingParentStart))).toMatchObject({ allowed: true });

    const oppositeChildExit = cloneSerializable(legacy);
    oppositeChildExit.shots[0].objects.find(({ id }) => id === "object-interval-generation-0")!.lifetime = { start: 2, end: 7 };
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(oppositeChildExit))).toMatchObject({ allowed: true });

    const reparented = cloneSerializable(legacy);
    const bridge = cloneSerializable(createCantorDemoProject().shots[0].objects.find(({ id }) => id === "object-interval-diagram")!);
    bridge.id = "group-policy-lifetime-bridge";
    bridge.name = "Lifetime bridge";
    bridge.parentId = "object-interval-diagram";
    bridge.locked = false;
    bridge.lifetime = { start: 0, end: 8 };
    reparented.shots[0].objects.splice(1, 0, bridge);
    reparented.shots[0].objects.find(({ id }) => id === "object-interval-generation-0")!.parentId = bridge.id;
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(reparented))).toMatchObject({
      allowed: false,
      reason: "modified-timeline-authority",
    });

    const movedBoundary = cloneSerializable(legacy);
    movedBoundary.shots[0].objects.find(({ id }) => id === "object-interval-generation-0")!.lifetime = { start: 1.5, end: 8 };
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(movedBoundary))).toMatchObject({
      allowed: false,
      reason: "modified-timeline-authority",
      issue: { code: "LIFETIME_SEMANTIC_COLLISION", lifetimeBoundary: "enter" },
    });

    const movedEdge = cloneSerializable(legacy);
    movedEdge.shots[0].objects.find(({ id }) => id === "object-interval-generation-0")!.lifetime = { start: 0, end: 2 };
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(movedEdge))).toMatchObject({
      allowed: false,
      reason: "introduced-timeline-authority",
      issue: { code: "LIFETIME_SEMANTIC_COLLISION", lifetimeBoundary: "exit" },
    });
  });

  test("uses complete authority relations beyond the 64-item presentation cap", () => {
    const legacy = manyConflictsProject();
    const schedule = buildCompilerSchedule(legacy.shots[0], legacy.settings.frameRate);
    expect(schedule.authorityIssues.length).toBeGreaterThan(64);
    expect(schedule.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRACK_CONFLICT_DIAGNOSTICS_TRUNCATED" })]));
    const changed = cloneSerializable(legacy);
    changed.shots[0].propertyTracks.at(-1)!.keyframes[0].value += 1;
    expect(analyzeProjectAuthoringTransition(legacy, ProjectDocumentSchema.parse(changed))).toMatchObject({ allowed: false, reason: "modified-timeline-authority" });
  });

  test("classifies audio transport as M4-only without masking visual authority", () => {
    expect(AUTHORING_POLICY_EXCLUDED_COMPILER_CODES).toEqual(["AUDIO_TRACK_RENDER_UNSUPPORTED"]);
    const previous = baseProject();
    const audio = cloneSerializable(previous);
    audio.assets.push({ id: "asset-policy-audio", filename: "tone.wav", mimeType: "audio/wav", size: 16, sha256: "a".repeat(64), duration: 4, provenance: "uploaded" });
    audio.shots[0].audioClips.push({ id: "audio-policy-clip", assetId: "asset-policy-audio", name: "Tone", start: 0, duration: 4, sourceStart: 0, sourceEnd: 4, volume: 1, muted: false, solo: false });
    audio.shots[0].propertyTracks.push({
      id: "track-policy-audio-volume",
      target: { kind: "audio", audioClipId: "audio-policy-clip" },
      property: "volume",
      keyframes: [{ id: "keyframe-policy-audio-volume", time: 0, value: 1, interpolation: { kind: "linear" } }],
    });
    const validAudio = ProjectDocumentSchema.parse(audio);
    expect(buildCompilerSchedule(validAudio.shots[0], validAudio.settings.frameRate).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "AUDIO_TRACK_RENDER_UNSUPPORTED", trackId: "track-policy-audio-volume" }),
    ]));
    expect(projectTimelineAuthoringIssues(validAudio)).toEqual([]);
    expect(analyzeProjectAuthoringTransition(previous, validAudio)).toMatchObject({ allowed: true });

    const visualConflict = cloneSerializable(validAudio);
    visualConflict.shots[0].propertyTracks.push(holdTrack());
    visualConflict.shots[0].animations.push({ id: "animation-policy-title-move", type: "move", targetIds: ["object-title"], start: 1, duration: 1, easing: "linear", properties: { deltaX: 20 } });
    expect(analyzeProjectAuthoringTransition(validAudio, ProjectDocumentSchema.parse(visualConflict))).toMatchObject({
      allowed: false,
      reason: "introduced-timeline-authority",
      issue: { code: "TRACK_SEMANTIC_COLLISION", trackId: "track-policy-title-x" },
    });
  });

  test("continues to apply the existing animation compatibility transition first", () => {
    const legacy = cloneSerializable(createCantorDemoProject());
    const emphasis = legacy.shots[0].animations.find(({ id }) => id === "animation-limit-emphasis")!;
    emphasis.easing = "editorial";
    const previous = ProjectDocumentSchema.parse(legacy);
    const unrelated = cloneSerializable(previous);
    unrelated.metadata.title = "Legacy animation survives rename";
    expect(analyzeProjectAuthoringTransition(previous, ProjectDocumentSchema.parse(unrelated))).toMatchObject({ allowed: true });
    const modified = cloneSerializable(previous);
    modified.shots[0].animations.find(({ id }) => id === emphasis.id)!.duration = 1;
    expect(analyzeProjectAuthoringTransition(previous, ProjectDocumentSchema.parse(modified))).toMatchObject({
      allowed: false,
      reason: "animation-compatibility",
      message: expect.stringContaining(emphasis.id),
    });
  });
});
