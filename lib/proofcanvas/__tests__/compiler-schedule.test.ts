import { spawnSync } from "node:child_process";
import { compileManim, estimateManimTimelineDurationUpperBound } from "../compiler";
import { buildCompilerSchedule } from "../compilerSchedule";
import { createCantorDemoProject } from "../demo";
import { easingProgress, manimRateFunctionName } from "../easing";
import { previewShotAtTime } from "../preview";
import { ProjectDocumentSchema, cloneSerializable, type ProjectDocument, type PropertyTrack, type SceneObject } from "../schema";
import { cubicBezierProgress } from "../timeline";

function scheduleProject(): ProjectDocument {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[1];
  project.shots = [shot];
  shot.id = "shot-schedule";
  shot.name = "Schedule";
  shot.duration = 6;
  shot.objects = [shot.objects[0]];
  shot.objects[0].id = "object-schedule";
  shot.objects[0].name = "Schedule object";
  shot.objects[0].transform.x = 120;
  shot.objects[0].transform.y = 200;
  shot.animations = [];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  shot.camera = { x: 480, y: 270, zoom: 1, rotation: 0 };
  return ProjectDocumentSchema.parse(project);
}

function track(
  interpolation: PropertyTrack["keyframes"][number]["interpolation"],
  times: readonly [number, number] = [0, 2],
  values: readonly [number, number] = [120, 300],
): PropertyTrack {
  return {
    id: "track-schedule-x",
    target: { kind: "object", objectId: "object-schedule" },
    property: "x",
    keyframes: [
      { id: "keyframe-schedule-start", time: times[0], value: values[0], interpolation },
      { id: "keyframe-schedule-end", time: times[1], value: values[1], interpolation: { kind: "linear" } },
    ],
  };
}

describe("chronological compiler schedule", () => {
  test("chains delayed first assignment and following tween in one same-mobject Succession", () => {
    const project = scheduleProject();
    project.shots[0].propertyTracks = [track({ kind: "linear" }, [1, 2], [200, 300])];
    const valid = ProjectDocumentSchema.parse(project);
    const schedule = buildCompilerSchedule(valid.shots[0], valid.settings.frameRate);
    expect(schedule.events.map(({ kind, start, end }) => ({ kind, start, end }))).toEqual([
      { kind: "property-span", start: 1, end: 1 },
      { kind: "property-span", start: 1, end: 2 },
    ]);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics.some(({ code }) => code === "TRACK_DELAYED_INITIAL_STATE_UNSUPPORTED")).toBe(false);
    expect(compiled.python).toMatch(/Succession\(Transform\([^\n]+run_time=0\.0[^\n]+Transform\([^\n]+run_time=1\.0/);
    expect(compiled.python).not.toMatch(/self\.play\(Transform\([^\n]+run_time=0\.0/);
    const reversed = cloneSerializable(valid);
    reversed.shots[0].propertyTracks.reverse();
    expect(compileManim(reversed).python).toBe(compiled.python);
  });

  test("emits hold as an exact terminal point inside a positive envelope with no hold helper", () => {
    const project = scheduleProject();
    project.shots[0].propertyTracks = [track({ kind: "hold" }, [0, 6], [120, 300])];
    const valid = ProjectDocumentSchema.parse(project);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python).toContain("self.play(Succession(Wait(6.0), Transform(");
    expect(compiled.python).toContain("run_time=0.0, rate_func=linear");
    expect(compiled.python).not.toContain("proofcanvas_hold");
    expect(previewShotAtTime(valid.shots[0], 5.999).objects[0].transform.x).toBe(120);
    expect(previewShotAtTime(valid.shots[0], 6).objects[0].transform.x).toBe(300);
  });

  test("rejects semantic authority inside hold-owned intervals while preserving touching chronology", () => {
    const conflicting = scheduleProject();
    conflicting.shots[0].propertyTracks = [track({ kind: "hold" }, [0, 2], [120, 300])];
    conflicting.shots[0].animations = [{
      id: "animation-inside-hold",
      type: "move",
      targetIds: ["object-schedule"],
      start: 0.5,
      duration: 1,
      easing: "linear",
      properties: { x: 200 },
    }];
    const valid = ProjectDocumentSchema.parse(conflicting);
    expect(previewShotAtTime(valid.shots[0], 1).objects[0].transform.x).toBe(160);
    expect(previewShotAtTime(valid.shots[0], 1.5).objects[0].transform.x).toBe(200);
    expect(previewShotAtTime(valid.shots[0], 1.75).objects[0].transform.x).toBe(120);
    expect(previewShotAtTime(valid.shots[0], 2).objects[0].transform.x).toBe(300);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "TRACK_SEMANTIC_COLLISION",
        trackId: "track-schedule-x",
        animationId: "animation-inside-hold",
        message: expect.stringContaining("Hold-owned x interval"),
      }),
    ]));
    expect(compiled.python).not.toContain("move_to([-2.66666662");

    const touching = scheduleProject();
    touching.shots[0].duration = 3;
    touching.shots[0].propertyTracks = [track({ kind: "hold" }, [0, 2], [120, 300])];
    touching.shots[0].animations = [{
      id: "animation-after-hold",
      type: "move",
      targetIds: ["object-schedule"],
      start: 2,
      duration: 1,
      easing: "linear",
      properties: { x: 360 },
    }];
    const touchingCompiled = compileManim(ProjectDocumentSchema.parse(touching));
    expect(touchingCompiled.diagnostics.some(({ code }) => code === "TRACK_SEMANTIC_COLLISION")).toBe(false);
    expect(touchingCompiled.python).toContain("self.play(Succession(Wait(2.0), group=Group(), run_time=2.0))");
    expect(touchingCompiled.python).toMatch(/Succession\(Transform\([^\n]+run_time=0\.0[^\n]+Transform\([^\n]+run_time=1\.0/);

    const oneTickOverlap = cloneSerializable(touching);
    oneTickOverlap.shots[0].animations[0].start = 1.99999999;
    oneTickOverlap.shots[0].animations[0].duration = 1.00000001;
    expect(compileManim(ProjectDocumentSchema.parse(oneTickOverlap)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TRACK_SEMANTIC_COLLISION", trackId: "track-schedule-x" }),
    ]));
  });

  test("does not invent pre-first hold authority and rejects actual hierarchy hold spans", () => {
    const delayed = scheduleProject();
    delayed.shots[0].propertyTracks = [track({ kind: "hold" }, [1, 3], [120, 300])];
    delayed.shots[0].animations = [{
      id: "animation-before-delayed-first",
      type: "move",
      targetIds: ["object-schedule"],
      start: 0.2,
      duration: 0.5,
      easing: "linear",
      properties: { x: 160 },
    }];
    const delayedCompiled = compileManim(ProjectDocumentSchema.parse(delayed));
    expect(delayedCompiled.diagnostics.some(({ code }) => code === "TRACK_SEMANTIC_COLLISION")).toBe(false);
    expect(delayedCompiled.python).toContain("run_time=0.5, rate_func=linear");
    expect(delayedCompiled.python).toMatch(/Wait\(0\.3\)[^\n]+Transform\([^\n]+run_time=0\.0/);

    const hierarchical = scheduleProject();
    const leaf = hierarchical.shots[0].objects[0];
    const group: SceneObject = {
      id: "group-hold-authority",
      type: "group",
      name: "Hold authority",
      locked: false,
      visible: true,
      transform: { x: 120, y: 200, width: 100, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    leaf.parentId = group.id;
    hierarchical.shots[0].objects.unshift(group);
    hierarchical.shots[0].propertyTracks = [{
      ...track({ kind: "hold" }, [0, 2], [120, 300]),
      target: { kind: "object", objectId: group.id },
    }];
    hierarchical.shots[0].animations = [{
      id: "animation-child-inside-group-hold",
      type: "move",
      targetIds: [leaf.id],
      start: 0.5,
      duration: 1,
      easing: "linear",
      properties: { deltaX: 30 },
    }];
    expect(compileManim(ProjectDocumentSchema.parse(hierarchical)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TRACK_SEMANTIC_COLLISION", trackId: "track-schedule-x", animationId: "animation-child-inside-group-hold" }),
    ]));

    const trackConflict = cloneSerializable(hierarchical);
    trackConflict.shots[0].animations = [];
    trackConflict.shots[0].propertyTracks.push({
      id: "track-child-y",
      target: { kind: "object", objectId: leaf.id },
      property: "y",
      keyframes: [
        { id: "keyframe-child-y-a", time: 0.5, value: 200, interpolation: { kind: "linear" } },
        { id: "keyframe-child-y-b", time: 1.5, value: 240, interpolation: { kind: "linear" } },
      ],
    });
    const trackCompiled = compileManim(ProjectDocumentSchema.parse(trackConflict));
    expect(trackCompiled.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TRACK_TRACK_COLLISION", trackId: "track-schedule-x" }),
      expect.objectContaining({ code: "TRACK_TRACK_COLLISION", trackId: "track-child-y" }),
    ]));

    const pointConflict = cloneSerializable(hierarchical);
    pointConflict.shots[0].animations = [];
    pointConflict.shots[0].propertyTracks.push({
      id: "track-child-point-inside-hold",
      target: { kind: "object", objectId: leaf.id },
      property: "opacity",
      keyframes: [{ id: "keyframe-child-point-inside-hold", time: 1, value: 0.5, interpolation: { kind: "linear" } }],
    });
    expect(compileManim(ProjectDocumentSchema.parse(pointConflict)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TRACK_TRACK_COLLISION", trackId: "track-schedule-x" }),
      expect.objectContaining({ code: "TRACK_TRACK_COLLISION", trackId: "track-child-point-inside-hold" }),
    ]));

    const lifetimeConflict = cloneSerializable(hierarchical);
    lifetimeConflict.shots[0].animations = [];
    lifetimeConflict.shots[0].objects.find(({ id }) => id === leaf.id)!.lifetime = { start: 1, end: 6 };
    expect(compileManim(ProjectDocumentSchema.parse(lifetimeConflict)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TRACK_LIFETIME_COLLISION", trackId: "track-schedule-x", objectId: leaf.id }),
    ]));
  });

  test("emits one exact fixed-bisection custom cubic helper and rejects unsafe domains whole-track", () => {
    const project = scheduleProject();
    const curve = { x1: 0.25, y1: -1, x2: 0.75, y2: 2 };
    project.shots[0].propertyTracks = [track({ kind: "custom-bezier", curve })];
    const valid = ProjectDocumentSchema.parse(project);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python.match(/def proofcanvas_cubic_bezier/g)).toHaveLength(1);
    expect(compiled.python).toContain("for iteration in range(32):");
    expect(compiled.python).toContain("rate_func=(lambda x: proofcanvas_cubic_bezier(x, 0.25, -1.0, 0.75, 2.0))");
    const helper = compiled.python.match(/def proofcanvas_cubic_bezier[\s\S]+?(?=\n\nclass GeneratedScene)/)?.[0];
    expect(helper).toBeDefined();
    const samples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
    const python = spawnSync("python3", ["-c", `${helper}\nimport json\nprint(json.dumps([proofcanvas_cubic_bezier(x, 0.25, -1.0, 0.75, 2.0) for x in ${JSON.stringify(samples)}]))`], { encoding: "utf8" });
    expect(python.status).toBe(0);
    const pythonValues = JSON.parse(python.stdout) as number[];
    samples.forEach((progress, index) => expect(pythonValues[index]).toBeCloseTo(cubicBezierProgress(curve, progress), 9));

    const unsafe = scheduleProject();
    unsafe.shots[0].propertyTracks = [{ ...track({ kind: "custom-bezier", curve }), property: "opacity", keyframes: [
      { id: "keyframe-opacity-start", time: 0, value: 0, interpolation: { kind: "custom-bezier", curve } },
      { id: "keyframe-opacity-end", time: 2, value: 1, interpolation: { kind: "linear" } },
    ] }];
    const rejected = compileManim(ProjectDocumentSchema.parse(unsafe));
    expect(rejected.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRACK_EASING_DOMAIN_UNSAFE", trackId: "track-schedule-x" })]));
    expect(rejected.python).not.toContain("proofcanvas_cubic_bezier");
  });

  test("uses private event kind authority even when authored IDs spoof old compiler prefixes", () => {
    const project = scheduleProject();
    project.shots[0].animations = [{
      id: "compiler-track-deadbeef",
      type: "move",
      targetIds: ["object-schedule"],
      start: 0,
      duration: 1,
      easing: "linear",
      properties: { x: 180 },
    }];
    const compiled = compileManim(ProjectDocumentSchema.parse(project));
    expect(compiled.python).toContain("run_time=1.0, rate_func=linear");
    expect(compiled.python).not.toContain("run_time=0.0");
  });

  test("persists partial lifetime entrance state and opacity-zero exit", () => {
    const project = scheduleProject();
    project.shots[0].objects[0].lifetime = { start: 1, end: 5 };
    const valid = ProjectDocumentSchema.parse(project);
    const schedule = buildCompilerSchedule(valid.shots[0], valid.settings.frameRate);
    expect(schedule.events.map(({ kind, start }) => ({ kind, start }))).toEqual([
      { kind: "lifetime-enter", start: 1 },
      { kind: "lifetime-exit", start: 5 },
    ]);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python).toContain("pc_schedule_object.set_opacity(0.0)");
    expect(compiled.python).toMatch(/Succession\(Wait\(1\.0\), Succession\(Transform\([^\n]+FadeIn\([^\n]+run_time=0\.0/);
    expect(compiled.python).toContain("Transform(pc_schedule_object, pc_schedule_object.copy().set_opacity(0.0), run_time=0.0, rate_func=linear)");
    expect(compiled.python).not.toContain("FadeOut(pc_schedule_object, run_time=0.0");
  });

  test("keeps authored future group entrance authoritative over an earlier synthetic child exit", () => {
    const project = scheduleProject();
    const shot = project.shots[0];
    const expiring = shot.objects[0];
    expiring.lifetime = { start: 0, end: 3 };
    const sibling: SceneObject = {
      ...cloneSerializable(expiring),
      id: "object-full-life-sibling",
      name: "Full life sibling",
      lifetime: undefined,
    };
    const group: SceneObject = {
      id: "group-visibility-authority",
      type: "group",
      name: "Visibility authority",
      locked: false,
      visible: true,
      transform: { x: 120, y: 200, width: 240, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    expiring.parentId = group.id;
    sibling.parentId = group.id;
    shot.objects = [group, expiring, sibling];
    shot.animations = [
      {
        id: "animation-hidden-group-move",
        type: "move",
        targetIds: [group.id],
        start: 0,
        duration: 1,
        easing: "linear",
        properties: { deltaX: 30 },
      },
      {
        id: "animation-future-group-fade-in",
        type: "fade-in",
        targetIds: [group.id],
        start: 4,
        duration: 1,
        easing: "linear",
        properties: {},
      },
    ];
    const valid = ProjectDocumentSchema.parse(project);
    expect(previewShotAtTime(valid.shots[0], 0.5).objects.find(({ id }) => id === expiring.id)?.preview.opacity).toBe(0);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python).toContain("pc_schedule_object.set_opacity(0.0)");
    expect(compiled.python).toContain("pc_full_life_sibling.set_opacity(0.0)");
    expect(compiled.python).not.toMatch(/self\.add\([^\n]*pc_schedule_object/);
    expect(compiled.python).toContain("Transform(pc_schedule_object, pc_schedule_object.copy().set_opacity(0.0), run_time=0.0, rate_func=linear)");
    expect(compiled.python).toContain("# Animation component 3: 4.0s to 5.0s");
  });

  test("lets a future first entrance own hidden lifetime, but enters before fade-out then re-entry", () => {
    const write = scheduleProject();
    write.shots[0].objects[0].lifetime = { start: 1, end: 6 };
    write.shots[0].animations = [{ id: "animation-future-write", type: "write", targetIds: ["object-schedule"], start: 4, duration: 1, easing: "linear", properties: {} }];
    const writeValid = ProjectDocumentSchema.parse(write);
    expect(buildCompilerSchedule(writeValid.shots[0], writeValid.settings.frameRate).events.some(({ kind }) => kind === "lifetime-enter")).toBe(false);
    expect(compileManim(writeValid).python).toContain("Write(pc_schedule_object, run_time=1.0, rate_func=linear)");

    const reentry = scheduleProject();
    reentry.shots[0].objects[0].lifetime = { start: 1, end: 6 };
    reentry.shots[0].animations = [
      { id: "animation-first-fade-out", type: "fade-out", targetIds: ["object-schedule"], start: 2, duration: 1, easing: "linear", properties: {} },
      { id: "animation-later-fade-in", type: "fade-in", targetIds: ["object-schedule"], start: 4, duration: 1, easing: "linear", properties: {} },
    ];
    const reentryValid = ProjectDocumentSchema.parse(reentry);
    expect(buildCompilerSchedule(reentryValid.shots[0], reentryValid.settings.frameRate).events.some(({ kind }) => kind === "lifetime-enter")).toBe(true);
    expect(previewShotAtTime(reentryValid.shots[0], 1).objects[0].preview.opacity).toBeGreaterThan(0);

    const dustEntrance = scheduleProject();
    dustEntrance.shots[0].objects[0].lifetime = { start: 0.1 + 0.2, end: 6 };
    dustEntrance.shots[0].animations = [{ id: "animation-dust-entrance", type: "fade-in", targetIds: ["object-schedule"], start: 0.3, duration: 1, easing: "linear", properties: {} }];
    const dustValid = ProjectDocumentSchema.parse(dustEntrance);
    expect(buildCompilerSchedule(dustValid.shots[0], dustValid.settings.frameRate).events.filter(({ kind }) => kind === "lifetime-enter")).toHaveLength(0);
    expect(compileManim(dustValid).python.match(/FadeIn\(pc_schedule_object/g)).toHaveLength(1);
  });

  test("owns a singleton property state at lifetime start even when a future entrance suppresses lifetime-enter", () => {
    const project = scheduleProject();
    const shot = project.shots[0];
    shot.objects[0].lifetime = { start: 1, end: 6 };
    shot.propertyTracks = [{
      id: "track-lifetime-boundary-x",
      target: { kind: "object", objectId: "object-schedule" },
      property: "x",
      keyframes: [{
        id: "keyframe-lifetime-boundary-x",
        time: 1,
        value: 243,
        interpolation: { kind: "linear" },
      }],
    }];
    shot.animations = [{
      id: "animation-future-fade-in",
      type: "fade-in",
      targetIds: ["object-schedule"],
      start: 2,
      duration: 1,
      easing: "linear",
      properties: {},
    }];
    const valid = ProjectDocumentSchema.parse(project);
    const schedule = buildCompilerSchedule(valid.shots[0], valid.settings.frameRate);
    expect(schedule.events.map(({ kind, start, end }) => ({ kind, start, end }))).toEqual([
      { kind: "property-span", start: 1, end: 1 },
      { kind: "semantic", start: 2, end: 3 },
    ]);
    expect(schedule.workCount).toBe(2);
    expect(previewShotAtTime(valid.shots[0], 1).objects[0]).toEqual(expect.objectContaining({
      transform: expect.objectContaining({ x: 243 }),
      preview: expect.objectContaining({ opacity: 0 }),
    }));
    const compiled = compileManim(valid);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python).toMatch(/Succession\(Wait\(1\.0\), Transform\([^\n]+move_to\(\[-3\.51111106, 1\.03703702, 0\]\)[^\n]+set_opacity\(0\.0\)[^\n]+run_time=0\.0/);
    expect(compiled.python).toContain("# Animation component 2: 2.0s to 3.0s");
  });

  test("rejects ancestor motion crossing a descendant lifetime edge", () => {
    const project = scheduleProject();
    const leaf = project.shots[0].objects[0];
    const group: SceneObject = {
      id: "group-schedule",
      type: "group",
      name: "Schedule group",
      locked: false,
      visible: true,
      transform: { x: 120, y: 200, width: 200, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    leaf.parentId = group.id;
    leaf.lifetime = { start: 0, end: 3 };
    project.shots[0].objects.unshift(group);
    project.shots[0].animations = [{ id: "animation-group-crossing-life", type: "move", targetIds: [group.id], start: 2, duration: 2, easing: "linear", properties: { deltaX: 20 } }];
    const valid = ProjectDocumentSchema.parse(project);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "LIFETIME_SEMANTIC_COLLISION", objectId: leaf.id })]));
  });

  test("samples positive hierarchy targets before exact descendant lifetime edge points", () => {
    for (const [edge, lifetime, expectedOpacity] of [
      ["enter", { start: 1, end: 6 }, 0],
      ["exit", { start: 0, end: 1 }, 1],
    ] as const) {
      const project = scheduleProject();
      const shot = project.shots[0];
      const leaf = shot.objects[0];
      leaf.lifetime = lifetime;
      const group: SceneObject = {
        id: `group-boundary-${edge}`,
        type: "group",
        name: `Boundary ${edge}`,
        locked: false,
        visible: true,
        transform: { x: 120, y: 200, width: 200, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
        style: {},
        properties: {},
      };
      leaf.parentId = group.id;
      shot.objects.unshift(group);
      shot.animations = [{ id: `animation-ending-at-${edge}`, type: "move", targetIds: [group.id], start: 0, duration: 1, easing: "linear", properties: { deltaX: 30 } }];
      const valid = ProjectDocumentSchema.parse(project);
      expect(previewShotAtTime(valid.shots[0], 0.5).objects.find(({ id }) => id === leaf.id)?.preview.opacity).toBe(expectedOpacity);
      const compiled = compileManim(valid);
      expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
      expect(compiled.python).toMatch(new RegExp(`set_opacity\\(${expectedOpacity}\\.0\\)\\)+, run_time=1\\.0, rate_func=linear`));
      expect(compiled.python).toContain(edge === "enter"
        ? "FadeIn(pc_schedule_object, run_time=0.0, rate_func=linear)"
        : "pc_schedule_object.copy().set_opacity(0.0), run_time=0.0, rate_func=linear");
    }

    const tracked = scheduleProject();
    const trackedShot = tracked.shots[0];
    const trackedLeaf = trackedShot.objects[0];
    trackedLeaf.lifetime = { start: 1, end: 6 };
    const trackedGroup: SceneObject = {
      id: "group-track-boundary",
      type: "group",
      name: "Track boundary",
      locked: false,
      visible: true,
      transform: { x: 120, y: 200, width: 200, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    trackedLeaf.parentId = trackedGroup.id;
    trackedShot.objects.unshift(trackedGroup);
    trackedShot.propertyTracks = [{
      id: "track-ending-at-lifetime",
      target: { kind: "object", objectId: trackedGroup.id },
      property: "x",
      keyframes: [
        { id: "keyframe-track-boundary-a", time: 0, value: 120, interpolation: { kind: "linear" } },
        { id: "keyframe-track-boundary-b", time: 1, value: 150, interpolation: { kind: "linear" } },
      ],
    }];
    const trackedCompiled = compileManim(ProjectDocumentSchema.parse(tracked));
    expect(trackedCompiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(trackedCompiled.python).toContain("run_time=1.0, rate_func=linear");
    expect(trackedCompiled.python).toMatch(/set_opacity\(0\.0\)\)+, run_time=1\.0, rate_func=linear/);
    expect(trackedCompiled.python).toContain("FadeIn(pc_schedule_object, run_time=0.0, rate_func=linear)");
  });

  test("supports there-and-back end-to-end at the one-tick minimum", () => {
    expect(manimRateFunctionName("there-and-back")).toBe("rate_functions.there_and_back");
    expect(easingProgress("there-and-back", 0)).toBe(0);
    expect(easingProgress("there-and-back", 0.5)).toBe(1);
    expect(easingProgress("there-and-back", 1)).toBe(0);
    const propertyProject = scheduleProject();
    propertyProject.shots[0].propertyTracks = [{
      ...track({ kind: "eased", easing: "there-and-back" }),
      keyframes: [
        { id: "keyframe-there-back-start", time: 0, value: 120, interpolation: { kind: "eased", easing: "there-and-back" } },
        { id: "keyframe-there-back-end", time: 2, value: 300, interpolation: { kind: "linear" } },
        { id: "keyframe-there-back-next", time: 4, value: 400, interpolation: { kind: "linear" } },
      ],
    }];
    const propertyValid = ProjectDocumentSchema.parse(propertyProject);
    expect(previewShotAtTime(propertyValid.shots[0], 1).objects[0].transform.x).toBe(300);
    expect(previewShotAtTime(propertyValid.shots[0], 2).objects[0].transform.x).toBe(300);
    expect(previewShotAtTime(propertyValid.shots[0], 3).objects[0].transform.x).toBe(350);
    const propertyCompiled = compileManim(propertyValid);
    expect(propertyCompiled.python).toMatch(/Succession\(Transform\([^\n]+run_time=2\.0, rate_func=rate_functions\.there_and_back\), Transform\([^\n]+run_time=0\.0, rate_func=linear\), Transform\([^\n]+run_time=2\.0/);

    const project = scheduleProject();
    project.shots[0].duration = 1e-8;
    project.shots[0].animations = [{
      id: "animation-one-tick-there-back",
      type: "move",
      targetIds: ["object-schedule"],
      start: 0,
      duration: 1e-8,
      easing: "there-and-back",
      properties: { x: 121 },
    }];
    const valid = ProjectDocumentSchema.parse(project);
    const compiled = compileManim(valid);
    expect(compiled.python).toContain("run_time=1e-8, rate_func=rate_functions.there_and_back");
    expect(compiled.python).toContain("move_to([-5.31851844, 1.03703702, 0])");
    expect(compiled.diagnostics.some(({ code }) => code === "ZERO_EVENT_WITHOUT_POSITIVE_ENVELOPE")).toBe(false);
    expect(estimateManimTimelineDurationUpperBound(valid, 30)).toBeCloseTo(1 / 30);

    const groupProject = scheduleProject();
    const groupShot = groupProject.shots[0];
    const groupLeaf = groupShot.objects[0];
    const group: SceneObject = {
      id: "group-one-tick-there-back",
      type: "group",
      name: "One tick there and back",
      locked: false,
      visible: true,
      transform: { x: groupLeaf.transform.x, y: groupLeaf.transform.y, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    groupLeaf.parentId = group.id;
    groupShot.objects.unshift(group);
    groupShot.duration = 1e-8;
    groupShot.animations = [{
      id: "animation-group-one-tick-there-back",
      type: "move",
      targetIds: [group.id],
      start: 0,
      duration: 1e-8,
      easing: "there-and-back",
      properties: { deltaX: 60 },
    }];
    const groupCompiled = compileManim(ProjectDocumentSchema.parse(groupProject));
    expect(groupCompiled.python).toContain("move_to([-4.44444437, 1.03703702, 0])");
    expect(groupCompiled.python).toContain("run_time=1e-8, rate_func=rate_functions.there_and_back");

    const cameraProject = scheduleProject();
    cameraProject.shots[0].duration = 1e-8;
    cameraProject.shots[0].animations = [{
      id: "animation-camera-one-tick-there-back",
      type: "camera-focus",
      targetIds: ["object-schedule"],
      start: 0,
      duration: 1e-8,
      easing: "there-and-back",
      properties: { x: 540 },
    }];
    const cameraCompiled = compileManim(ProjectDocumentSchema.parse(cameraProject));
    expect(cameraCompiled.python).toContain("move_to([0.88888888, 0.0, 0])");
    expect(cameraCompiled.python).toContain("run_time=1e-8, rate_func=rate_functions.there_and_back");

    const tinyFade = scheduleProject();
    tinyFade.shots[0].duration = 1e-8;
    tinyFade.shots[0].animations = [{
      id: "animation-one-tick-fade-out",
      type: "fade-out",
      targetIds: ["object-schedule"],
      start: 0,
      duration: 1e-8,
      easing: "linear",
      properties: {},
    }];
    const tinyFadeValid = ProjectDocumentSchema.parse(tinyFade);
    expect(previewShotAtTime(tinyFadeValid.shots[0], 1e-8).objects[0].preview.opacity).toBe(0);
    const tinyFadeCompiled = compileManim(tinyFadeValid);
    expect(tinyFadeCompiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(tinyFadeCompiled.python).toMatch(/set_opacity\(0\.0\), run_time=1e-8, rate_func=linear/);
  });

  test("keeps supported emphasise exact while preserving and render-blocking legacy V2 easing", () => {
    const project = scheduleProject();
    project.shots[0].animations = [{
      id: "animation-emphasis-pulse",
      type: "emphasise",
      targetIds: ["object-schedule"],
      start: 0,
      duration: 2,
      easing: "there-and-back",
      properties: { scale: 1.2 },
    }];
    const valid = ProjectDocumentSchema.parse(project);
    expect(previewShotAtTime(valid.shots[0], 0).objects[0].transform.scaleX).toBe(1);
    expect(previewShotAtTime(valid.shots[0], 0.5).objects[0].transform.scaleX).toBeCloseTo(1.1, 8);
    expect(previewShotAtTime(valid.shots[0], 1).objects[0].transform.scaleX).toBeCloseTo(1.2, 8);
    expect(previewShotAtTime(valid.shots[0], 2).objects[0].transform.scaleX).toBe(1);
    expect(compileManim(valid).python).toContain("Indicate(pc_schedule_object, color=\"#71402d\", scale_factor=1.2, run_time=2.0, rate_func=rate_functions.there_and_back)");

    const unsupported = cloneSerializable(project);
    unsupported.shots[0].animations[0].easing = "linear";
    const legacyValid = ProjectDocumentSchema.parse(unsupported);
    expect(previewShotAtTime(legacyValid.shots[0], 0.5).objects[0].transform.scaleX)
      .toBeCloseTo(1 + 0.2 * Math.sin(Math.PI * 0.25), 8);
    const legacyCompiled = compileManim(legacyValid);
    expect(legacyCompiled.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SEMANTIC_EASING_UNSUPPORTED", animationId: "animation-emphasis-pulse" }),
    ]));
  });

  test("keeps a one-tick positive group animation finite and renderable", () => {
    const project = scheduleProject();
    const shot = project.shots[0];
    const leaf = shot.objects[0];
    const group: SceneObject = {
      id: "group-one-tick",
      type: "group",
      name: "One ULP group",
      locked: false,
      visible: true,
      transform: { x: leaf.transform.x, y: leaf.transform.y, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    leaf.parentId = group.id;
    shot.objects.unshift(group);
    shot.duration = 1.00000001;
    shot.animations = [{
      id: "animation-one-tick-group",
      type: "move",
      targetIds: [group.id],
      start: 1,
      duration: 1e-8,
      easing: "linear",
      properties: { deltaX: 60 },
    }];
    const valid = ProjectDocumentSchema.parse(project);
    const start = previewShotAtTime(valid.shots[0], 1).objects.find(({ id }) => id === leaf.id)!;
    const end = previewShotAtTime(valid.shots[0], 1.00000001).objects.find(({ id }) => id === leaf.id)!;
    expect(start.transform.x).toBe(120);
    expect(end.transform.x).toBe(180);
    expect(Number.isFinite(end.transform.x)).toBe(true);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics.some(({ code }) => code === "DERIVED_NUMERIC_RANGE_EXCEEDED")).toBe(false);
    expect(compiled.python).toContain("run_time=1e-8, rate_func=linear");
    expect(estimateManimTimelineDurationUpperBound(valid, 30)).toBeCloseTo(1 + 1 / 30);
  });

  test("groups one-tick positive events in parallel and keeps touching ticks sequential", () => {
    const project = scheduleProject();
    const shot = project.shots[0];
    shot.duration = 1e-8;
    const sibling: SceneObject = {
      ...cloneSerializable(shot.objects[0]),
      id: "object-tiny-sibling",
      name: "Tiny sibling",
      transform: { ...shot.objects[0].transform, y: 260 },
    };
    shot.objects.push(sibling);
    shot.animations = [
      { id: "animation-tiny-a", type: "move", targetIds: ["object-schedule"], start: 0, duration: 1e-8, easing: "linear", properties: { x: 121 } },
      { id: "animation-tiny-b", type: "move", targetIds: [sibling.id], start: 0, duration: 1e-8, easing: "linear", properties: { x: 122 } },
    ];
    const valid = ProjectDocumentSchema.parse(project);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python.match(/self\.play\(/g)).toHaveLength(1);
    expect(compiled.python).toContain("self.play(AnimationGroup(");
    expect(compiled.python.match(/run_time=1e-8, rate_func=linear/g)).toHaveLength(2);
    expect(estimateManimTimelineDurationUpperBound(valid, 30)).toBeCloseTo(1 / 30);

    const ambiguous = cloneSerializable(project);
    ambiguous.shots[0].animations[1] = {
      ...ambiguous.shots[0].animations[1],
      targetIds: ["object-schedule"],
    };
    expect(ProjectDocumentSchema.safeParse(ambiguous).success).toBe(false);

    const touching = cloneSerializable(project);
    touching.shots[0].duration = 2e-8;
    touching.shots[0].animations[1] = {
      ...touching.shots[0].animations[1],
      targetIds: ["object-schedule"],
      start: 1e-8,
    };
    expect(ProjectDocumentSchema.safeParse(touching).success).toBe(true);
  });

  test("preserves one-tick delays, lifetime edges, singleton points, final holds, and estimator frames", () => {
    const delayedLifetime = scheduleProject();
    delayedLifetime.shots[0].objects[0].lifetime = { start: 1e-8, end: 6 };
    const delayedLifetimeValid = ProjectDocumentSchema.parse(delayedLifetime);
    const lifetimeSource = compileManim(delayedLifetimeValid).python;
    expect(lifetimeSource).not.toContain("undefined.copy()");
    expect(lifetimeSource).toContain("Wait(1e-8)");
    expect(lifetimeSource).toMatch(/pc_ref_[a-z0-9_]+ = pc_schedule_object\.copy\(\)/);
    expect(previewShotAtTime(delayedLifetimeValid.shots[0], 0).objects[0].preview.opacity).toBe(0);
    expect(previewShotAtTime(delayedLifetimeValid.shots[0], 1e-8).objects[0].preview.opacity).toBe(1);

    const delayedPoint = scheduleProject();
    delayedPoint.shots[0].propertyTracks = [{
      id: "track-tiny-delayed-point",
      target: { kind: "object", objectId: "object-schedule" },
      property: "x",
      keyframes: [{ id: "keyframe-tiny-delayed-point", time: 1e-8, value: 300, interpolation: { kind: "linear" } }],
    }];
    const delayedPointValid = ProjectDocumentSchema.parse(delayedPoint);
    expect(previewShotAtTime(delayedPointValid.shots[0], 0).objects[0].transform.x).toBe(120);
    expect(previewShotAtTime(delayedPointValid.shots[0], 1e-8).objects[0].transform.x).toBe(300);
    expect(compileManim(delayedPointValid).python).toMatch(/Succession\(Wait\(1e-8\), Transform\(/);

    const delayedSemantic = scheduleProject();
    delayedSemantic.shots[0].duration = 1.00000001;
    delayedSemantic.shots[0].animations = [{
      id: "animation-tiny-delay",
      type: "move",
      targetIds: ["object-schedule"],
      start: 1e-8,
      duration: 1,
      easing: "linear",
      properties: { x: 180 },
    }];
    const delayedSemanticValid = ProjectDocumentSchema.parse(delayedSemantic);
    expect(compileManim(delayedSemanticValid).python).toContain("self.play(Succession(Wait(1e-8), group=Group(), run_time=1e-8))");
    expect(estimateManimTimelineDurationUpperBound(delayedSemanticValid, 30)).toBeCloseTo(1 + 1 / 30);

    const finalHold = scheduleProject();
    finalHold.shots[0].duration = 1.00000001;
    finalHold.shots[0].animations = [{
      id: "animation-before-tiny-final-hold",
      type: "move",
      targetIds: ["object-schedule"],
      start: 0,
      duration: 1,
      easing: "linear",
      properties: { x: 180 },
    }];
    const finalHoldValid = ProjectDocumentSchema.parse(finalHold);
    expect(compileManim(finalHoldValid).python).toContain("self.play(Succession(Wait(1e-8), group=Group(), run_time=1e-8))");
    expect(estimateManimTimelineDurationUpperBound(finalHoldValid, 30)).toBeCloseTo(1 + 1 / 30);
  });

  test("treats arithmetic-dust lifetime and point timestamps as one canonical phase", () => {
    const project = scheduleProject();
    project.shots[0].objects[0].lifetime = { start: 0.1 + 0.2, end: 6 };
    project.shots[0].propertyTracks = [{
      id: "track-dust-lifetime-point",
      target: { kind: "object", objectId: "object-schedule" },
      property: "x",
      keyframes: [{ id: "keyframe-dust-lifetime-point", time: 0.3, value: 300, interpolation: { kind: "linear" } }],
    }];
    const valid = ProjectDocumentSchema.parse(project);
    expect(previewShotAtTime(valid.shots[0], 0.3).objects[0].preview.opacity).toBe(1);
    expect(previewShotAtTime(valid.shots[0], 0.1 + 0.2).objects[0].preview.opacity).toBe(1);
    const schedule = buildCompilerSchedule(valid.shots[0], valid.settings.frameRate);
    expect(schedule.events.slice(0, 2).map(({ kind }) => kind)).toEqual(["lifetime-enter", "property-span"]);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python).toMatch(/FadeIn\([^\n]+run_time=0\.0[^\n]+Transform\([^\n]+set_opacity\(1\.0\)[^\n]+run_time=0\.0/);
    expect(compiled.python).not.toContain("undefined.copy()");
  });

  test("persists a lifetime exit after a there-and-back fade-out", () => {
    const project = scheduleProject();
    const shot = project.shots[0];
    const leaf = shot.objects[0];
    const group: SceneObject = {
      id: "group-there-back-exit",
      type: "group",
      name: "There-back exit group",
      locked: false,
      visible: true,
      transform: { x: leaf.transform.x, y: leaf.transform.y, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    leaf.parentId = group.id;
    leaf.lifetime = { start: 0, end: 2 };
    shot.objects.unshift(group);
    shot.animations = [
      { id: "animation-there-back-fade-exit", type: "fade-out", targetIds: [leaf.id], start: 0, duration: 2, easing: "there-and-back", properties: {} },
      { id: "animation-after-there-back-exit", type: "move", targetIds: [group.id], start: 3, duration: 1, easing: "linear", properties: { deltaX: 20 } },
    ];
    const valid = ProjectDocumentSchema.parse(project);
    const schedule = buildCompilerSchedule(valid.shots[0], valid.settings.frameRate);
    expect(schedule.events.some(({ kind, start }) => kind === "lifetime-exit" && start === 2)).toBe(true);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python).toMatch(/rate_functions\.there_and_back[^\n]+Transform\([^\n]+set_opacity\(0\.0\)[^\n]+run_time=0\.0/);
    expect(previewShotAtTime(valid.shots[0], 2).objects.find(({ id }) => id === leaf.id)?.preview.opacity).toBe(0);
    expect(previewShotAtTime(valid.shots[0], 3.5).objects.find(({ id }) => id === leaf.id)?.preview.opacity).toBe(0);
  });

  test("targets semantic there-and-back group motion and visibility at the easing peak", () => {
    const groupProject = scheduleProject();
    const leaf = groupProject.shots[0].objects[0];
    const group: SceneObject = {
      id: "group-there-back",
      type: "group",
      name: "There and back group",
      locked: false,
      visible: true,
      transform: { x: leaf.transform.x, y: leaf.transform.y, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    leaf.parentId = group.id;
    groupProject.shots[0].objects.unshift(group);
    groupProject.shots[0].animations = [{
      id: "animation-group-there-back",
      type: "move",
      targetIds: [group.id],
      start: 0,
      duration: 2,
      easing: "there-and-back",
      properties: { deltaX: 180 },
    }];
    const groupValid = ProjectDocumentSchema.parse(groupProject);
    expect(previewShotAtTime(groupValid.shots[0], 1).objects.find(({ id }) => id === leaf.id)?.transform.x).toBe(300);
    expect(previewShotAtTime(groupValid.shots[0], 2).objects.find(({ id }) => id === leaf.id)?.transform.x).toBe(120);
    const groupSource = compileManim(groupValid).python;
    expect(groupSource).toContain("rate_func=rate_functions.there_and_back");
    expect(groupSource).toMatch(/Transform\(pc_there_and_back_group, VGroup\([^\n]+\.move_to\(\[-2\.66666662, 1\.03703702, 0\]\)/);

    const fadeProject = scheduleProject();
    fadeProject.shots[0].animations = [{
      id: "animation-fade-there-back",
      type: "fade-out",
      targetIds: ["object-schedule"],
      start: 0,
      duration: 2,
      easing: "there-and-back",
      properties: {},
    }];
    const fadeValid = ProjectDocumentSchema.parse(fadeProject);
    expect(previewShotAtTime(fadeValid.shots[0], 1).objects[0].preview.opacity).toBe(0);
    expect(previewShotAtTime(fadeValid.shots[0], 2).objects[0].preview.opacity).toBe(1);
    expect(compileManim(fadeValid).python).toMatch(/Transform\(pc_schedule_object, [^\n]+\.set_opacity\(0\.0\), run_time=2\.0, rate_func=rate_functions\.there_and_back\)/);

    for (const type of ["write", "create"] as const) {
      const entrance = scheduleProject();
      entrance.shots[0].animations = [{ id: `animation-${type}-there-back`, type, targetIds: ["object-schedule"], start: 0, duration: 2, easing: "there-and-back", properties: {} }];
      expect(previewShotAtTime(entrance.shots[0], 1).objects[0].preview.opacity).toBe(1);
      expect(previewShotAtTime(entrance.shots[0], 2).objects[0].preview.opacity).toBe(0);
      const entranceValid = ProjectDocumentSchema.parse(entrance);
      const entranceCompiled = compileManim(entranceValid);
      expect(entranceCompiled.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "SEMANTIC_EASING_UNSUPPORTED", animationId: `animation-${type}-there-back` }),
      ]));
      expect(entranceCompiled.python).not.toContain(`${type === "write" ? "Write" : "Create"}(`);
    }
  });

  test.each(["write", "create"] as const)("fails closed for %s there-and-back before hidden spatial follow-ups", (type) => {
    const project = scheduleProject();
    project.shots[0].duration = 4;
    project.shots[0].animations = [
      { id: `animation-${type}-pulse`, type, targetIds: ["object-schedule"], start: 0, duration: 1, easing: "there-and-back", properties: {} },
      { id: `animation-${type}-move`, type: "move", targetIds: ["object-schedule"], start: 1, duration: 1, easing: "linear", properties: { deltaX: 60 } },
      { id: `animation-${type}-transform`, type: "transform", targetIds: ["object-schedule"], start: 2, duration: 1, easing: "linear", properties: { x: 240 } },
      { id: `animation-${type}-reenter`, type: "fade-in", targetIds: ["object-schedule"], start: 3, duration: 1, easing: "linear", properties: {} },
    ];
    expect(previewShotAtTime(project.shots[0], 0.5).objects[0].preview.opacity).toBe(1);
    expect(previewShotAtTime(project.shots[0], 1).objects[0].preview.opacity).toBe(0);
    expect(previewShotAtTime(project.shots[0], 1.5).objects[0].preview.opacity).toBe(0);
    expect(previewShotAtTime(project.shots[0], 2.5).objects[0].preview.opacity).toBe(0);
    expect(previewShotAtTime(project.shots[0], 4).objects[0].preview.opacity).toBe(1);
    const valid = ProjectDocumentSchema.parse(project);
    const compiled = compileManim(valid);
    expect(compiled.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SEMANTIC_EASING_UNSUPPORTED", animationId: `animation-${type}-pulse` }),
    ]));
    expect(compiled.python).not.toContain(`${type === "write" ? "Write" : "Create"}(`);
  });

  test("rejects tick-interior points instead of reordering them to interval ends", () => {
    const tickInterior = 1.00000001;
    const semantic = scheduleProject();
    semantic.shots[0].animations = [{ id: "animation-tick-span", type: "move", targetIds: ["object-schedule"], start: 1, duration: 0.00000003, easing: "linear", properties: { x: 180 } }];
    semantic.shots[0].propertyTracks = [{ ...track({ kind: "linear" }), keyframes: [
      { id: "keyframe-tick-delayed", time: tickInterior, value: 160, interpolation: { kind: "linear" } },
    ] }];
    const semanticCompiled = compileManim(ProjectDocumentSchema.parse(semantic));
    expect(semanticCompiled.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRACK_SEMANTIC_COLLISION", trackId: "track-schedule-x" })]));

    const tracks = scheduleProject();
    tracks.shots[0].propertyTracks = [
      { ...track({ kind: "linear" }), keyframes: [
        { id: "keyframe-tick-delayed", time: tickInterior, value: 160, interpolation: { kind: "linear" } },
      ] },
      { ...track({ kind: "linear" }), id: "track-epsilon-y", property: "y", keyframes: [
        { id: "keyframe-epsilon-y-start", time: 1, value: 200, interpolation: { kind: "linear" } },
        { id: "keyframe-epsilon-y-end", time: 1.00000003, value: 250, interpolation: { kind: "linear" } },
      ] },
    ];
    const trackCompiled = compileManim(ProjectDocumentSchema.parse(tracks));
    expect(trackCompiled.diagnostics.filter(({ code }) => code === "TRACK_TRACK_COLLISION").map(({ trackId }) => trackId).sort()).toEqual(["track-epsilon-y", "track-schedule-x"]);

    const lifetime = scheduleProject();
    const lifetimeLeaf = lifetime.shots[0].objects[0];
    const lifetimeGroup: SceneObject = {
      id: "group-lifetime-epsilon",
      type: "group",
      name: "Lifetime epsilon group",
      locked: false,
      visible: true,
      transform: { x: lifetimeLeaf.transform.x, y: lifetimeLeaf.transform.y, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    lifetimeLeaf.parentId = lifetimeGroup.id;
    lifetimeLeaf.lifetime = { start: tickInterior, end: 6 };
    lifetime.shots[0].objects.unshift(lifetimeGroup);
    lifetime.shots[0].animations = [{ id: "animation-lifetime-tick", type: "move", targetIds: [lifetimeGroup.id], start: 1, duration: 0.00000003, easing: "linear", properties: { deltaX: 60 } }];
    const lifetimeCompiled = compileManim(ProjectDocumentSchema.parse(lifetime));
    expect(lifetimeCompiled.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "LIFETIME_SEMANTIC_COLLISION", objectId: "object-schedule" })]));
  });

  test("keeps foreign endpoint points out of positive target snapshots", () => {
    const project = scheduleProject();
    project.shots[0].propertyTracks = [
      track({ kind: "linear" }, [0, 1], [120, 220]),
      {
        id: "track-endpoint-opacity",
        target: { kind: "object", objectId: "object-schedule" },
        property: "opacity",
        keyframes: [{ id: "keyframe-endpoint-opacity", time: 1, value: 0, interpolation: { kind: "linear" } }],
      },
    ];
    const compiled = compileManim(ProjectDocumentSchema.parse(project));
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python).toContain("# Animation component 1: 0.0s to 1.0s");
    expect(compiled.python).toContain("set_opacity(1.0), run_time=1.0");
    expect(compiled.python).toContain("set_opacity(0.0), run_time=0.0");
    expect(compiled.python).not.toContain("set_opacity(0.0), run_time=1.0");

    const semantic = scheduleProject();
    semantic.shots[0].animations = [{ id: "animation-ending-before-point", type: "move", targetIds: ["object-schedule"], start: 0, duration: 1, easing: "linear", properties: { x: 220 } }];
    semantic.shots[0].propertyTracks = [{
      id: "track-semantic-endpoint-opacity",
      target: { kind: "object", objectId: "object-schedule" },
      property: "opacity",
      keyframes: [{ id: "keyframe-semantic-endpoint-opacity", time: 1, value: 0, interpolation: { kind: "linear" } }],
    }];
    const semanticCompiled = compileManim(ProjectDocumentSchema.parse(semantic));
    expect(semanticCompiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(semanticCompiled.python).toContain("set_opacity(1.0), run_time=1.0");
    expect(semanticCompiled.python).not.toContain("set_opacity(0.0), run_time=1.0");

    const camera = scheduleProject();
    camera.shots[0].propertyTracks = [
      {
        id: "track-camera-endpoint-x",
        target: { kind: "camera" },
        property: "x",
        keyframes: [
          { id: "keyframe-camera-x-start", time: 0, value: 480, interpolation: { kind: "linear" } },
          { id: "keyframe-camera-x-end", time: 1, value: 600, interpolation: { kind: "linear" } },
        ],
      },
      {
        id: "track-camera-endpoint-y",
        target: { kind: "camera" },
        property: "y",
        keyframes: [{ id: "keyframe-camera-y-point", time: 1, value: 400, interpolation: { kind: "linear" } }],
      },
    ];
    const cameraCompiled = compileManim(ProjectDocumentSchema.parse(camera));
    expect(cameraCompiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const positiveCamera = cameraCompiled.python.split("run_time=1.0")[0].split("\n").at(-1) ?? "";
    expect(positiveCamera).toContain("move_to([1.77777775, 0.0, 0])");
    expect(positiveCamera).not.toContain("-1.9259259");
    expect(cameraCompiled.python).toContain("move_to([1.77777775, -1.9259259, 0])");
  });
});
