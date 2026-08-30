import {
  applyDocumentOperations,
  duplicateShotOperation,
  duplicateStyleOperation,
  mergeShotsOperation,
  shotLocalIds,
  splitShotOperation,
} from "../documentOperations";
import { compileManim } from "../compiler";
import { createCantorDemoProject } from "../demo";
import { duplicateAnimationOperation, applyOperations } from "../operations";
import { previewShotAtTime } from "../preview";
import {
  ProjectDocumentSchema,
  canonicalProjectJson,
  cloneSerializable,
  type ProjectDocument,
  type PropertyTrack,
} from "../schema";

function authoringProject(): ProjectDocument {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[1];
  project.shots = [shot];
  shot.id = "shot-authoring";
  shot.name = "Authoring";
  shot.duration = 6;
  shot.objects = [shot.objects[0]];
  shot.objects[0].id = "object-authoring-title";
  shot.objects[0].name = "Authoring title";
  shot.objects[0].transform.x = 120;
  shot.animations = [];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  shot.camera = { x: 480, y: 270, zoom: 1, rotation: 0 };
  return ProjectDocumentSchema.parse(project);
}

function xTrack(interpolation: PropertyTrack["keyframes"][number]["interpolation"] = { kind: "linear" }): PropertyTrack {
  return {
    id: "track-authoring-x",
    target: { kind: "object", objectId: "object-authoring-title" },
    property: "x",
    keyframes: [
      { id: "keyframe-authoring-x-start", time: 0, value: 120, interpolation },
      { id: "keyframe-authoring-x-end", time: 6, value: 420, interpolation: { kind: "linear" } },
    ],
  };
}

function compilerConflictDocument(): ProjectDocument {
  const project = cloneSerializable(authoringProject());
  const shot = project.shots[0];
  shot.propertyTracks = [xTrack({ kind: "hold" })];
  shot.animations = [{
    id: "animation-authoring-conflict",
    type: "move",
    targetIds: ["object-authoring-title"],
    start: 1,
    duration: 1,
    easing: "linear",
    properties: { deltaX: 20 },
  }];
  return ProjectDocumentSchema.parse(project);
}

describe("typed document operations", () => {
  test("guards unchanged, introduced, modified, and repaired compiler authority at the final document boundary", () => {
    const legacy = compilerConflictDocument();
    const renamed = applyDocumentOperations(legacy, [{ type: "rename-project", title: "Unrelated legacy rename" }]).project;
    expect(renamed.metadata.title).toBe("Unrelated legacy rename");

    expect(() => applyDocumentOperations(legacy, [duplicateShotOperation(legacy, "shot-authoring")])).toThrow(/introduce renderer-rejected TRACK_SEMANTIC_COLLISION/);
    expect(applyDocumentOperations(legacy, [{ type: "update-shot", shotId: "shot-authoring", patch: { duration: 7 } }]).project.shots[0].duration).toBe(7);

    const cleanShot = cloneSerializable(authoringProject().shots[0]);
    cleanShot.id = "shot-authoring-repair";
    cleanShot.name = "Repair target";
    cleanShot.objects[0].id = "object-authoring-repair";
    const repaired = applyDocumentOperations(legacy, [
      { type: "add-shot", shot: cleanShot },
      { type: "delete-shot", shotId: "shot-authoring" },
    ]).project;
    expect(repaired.shots.map(({ id }) => id)).toEqual(["shot-authoring-repair"]);
    expect(repaired.shots[0].propertyTracks).toEqual([]);
  });

  test("applies settings, shot, and marker changes atomically without mutating metadata clocks", () => {
    const project = authoringProject();
    const updatedAt = project.metadata.updatedAt;
    const result = applyDocumentOperations(project, [
      { type: "rename-project", title: "Portrait proof" },
      {
        type: "set-project-settings",
        settings: { aspectRatio: "9:16", frameRate: 24, renderPreset: "1080p", previewQuality: "high" },
        cameraPolicy: "recenter-default",
      },
      { type: "update-shot", shotId: "shot-authoring", patch: { name: "Portrait shot" } },
      { type: "add-marker", shotId: "shot-authoring", marker: { id: "marker-later", time: 4, name: "Later", color: "#112233" } },
      { type: "add-marker", shotId: "shot-authoring", marker: { id: "marker-earlier", time: 1, name: "Earlier", color: "#445566" } },
      { type: "update-marker", shotId: "shot-authoring", markerId: "marker-later", patch: { time: 0.5 } },
    ]);
    expect(project.metadata.title).not.toBe("Portrait proof");
    expect(result.project.metadata.updatedAt).toBe(updatedAt);
    expect(result.project.settings).toEqual({
      aspectRatio: "9:16",
      frameRate: 24,
      resolution: { width: 1080, height: 1920 },
      renderPreset: "1080p",
      previewQuality: "high",
    });
    expect(result.project.shots[0].camera).toEqual({ x: 270, y: 480, zoom: 1, rotation: 0 });
    expect(result.project.shots[0].markers.map(({ id }) => id)).toEqual(["marker-later", "marker-earlier"]);

    const before = canonicalProjectJson(project);
    expect(() => applyDocumentOperations(project, [
      { type: "rename-project", title: "Must roll back" },
      { type: "add-marker", shotId: "shot-authoring", marker: { id: "marker-invalid", time: 7, name: "Invalid", color: "#000000" } },
    ])).toThrow(/Document operation 2|Resulting project is invalid/);
    expect(canonicalProjectJson(project)).toBe(before);
  });

  test("fits every authored landscape object and camera into the centred portrait frame without mutating the source", () => {
    const project = authoringProject();
    const shot = project.shots[0];
    const title = shot.objects[0];
    title.parentId = "group-landscape-content";
    title.transform = { x: 120, y: 90, width: 320, height: 80, rotation: 12, scaleX: 1.25, scaleY: 0.8 };
    title.style = { ...title.style, fontSize: 31, opacity: 0.75 };
    shot.objects.unshift({
      id: "group-landscape-content",
      type: "group",
      name: "Landscape content",
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 800, height: 440, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    });
    shot.objects.push({
      id: "object-landscape-rounded-rectangle",
      type: "rectangle",
      name: "Rounded rectangle",
      parentId: "group-landscape-content",
      locked: false,
      visible: true,
      transform: { x: 760, y: 420, width: 240, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
      style: { stroke: "#315866", strokeWidth: 4, opacity: 0.6 },
      properties: { shape: { kind: "rectangle", cornerRadius: 20 } },
    });
    shot.camera = { x: 720, y: 180, zoom: 1.4, rotation: 7 };
    const source = ProjectDocumentSchema.parse(project);
    const sourceJson = canonicalProjectJson(source);

    const result = applyDocumentOperations(source, [{
      type: "set-project-settings",
      settings: { aspectRatio: "9:16", frameRate: 24, renderPreset: "1080p", previewQuality: "high" },
      cameraPolicy: "fit-all",
    }]);
    const fitted = result.project.shots[0];
    const fittedGroup = fitted.objects.find(({ id }) => id === "group-landscape-content")!;
    const fittedTitle = fitted.objects.find(({ id }) => id === title.id)!;
    const fittedRectangle = fitted.objects.find(({ id }) => id === "object-landscape-rounded-rectangle")!;

    expect(result.summary).toEqual(["Updated project settings to 9:16 24fps and fit all authored content"]);
    expect(result.project.settings).toEqual({
      aspectRatio: "9:16",
      frameRate: 24,
      resolution: { width: 1080, height: 1920 },
      renderPreset: "1080p",
      previewQuality: "high",
    });
    expect(fittedGroup.transform).toEqual({ x: 270, y: 480, width: 450, height: 247.5, rotation: 0, scaleX: 1, scaleY: 1 });
    expect(fittedTitle.transform).toEqual({ x: 67.5, y: 378.75, width: 180, height: 45, rotation: 12, scaleX: 1.25, scaleY: 0.8 });
    expect(fittedTitle.parentId).toBe("group-landscape-content");
    expect(fittedTitle.style).toEqual({ ...title.style, fontSize: 17.4375 });
    expect(fittedRectangle.transform).toEqual({ x: 427.5, y: 564.375, width: 135, height: 56.25, rotation: 0, scaleX: 1, scaleY: 1 });
    expect(fittedRectangle.style).toEqual({ stroke: "#315866", strokeWidth: 2.25, opacity: 0.6 });
    expect(fittedRectangle.properties).toEqual({ shape: { kind: "rectangle", cornerRadius: 11.25 } });
    expect(fitted.camera).toEqual({ x: 405, y: 429.375, zoom: 1.4, rotation: 7 });
    expect(ProjectDocumentSchema.safeParse(result.project).success).toBe(true);
    expect(canonicalProjectJson(source)).toBe(sourceJson);
  });

  test("reframes geometric keyframes and semantic motion while preserving non-geometric values", () => {
    const project = authoringProject();
    const shot = project.shots[0];
    const title = shot.objects[0];
    title.transform = { x: 180, y: 120, width: 300, height: 72, rotation: 15, scaleX: 1.2, scaleY: 0.9 };
    const moveTarget = {
      ...cloneSerializable(title),
      id: "object-fit-move",
      type: "rectangle" as const,
      name: "Move target",
      transform: { x: 360, y: 240, width: 180, height: 60, rotation: -5, scaleX: 1, scaleY: 1 },
      style: { stroke: "#315866", strokeWidth: 4, opacity: 0.8 },
      properties: { shape: { kind: "rectangle", cornerRadius: 12 } },
    };
    const transformTarget = {
      ...cloneSerializable(title),
      id: "object-fit-transform",
      name: "Transform target",
      transform: { x: 600, y: 320, width: 200, height: 100, rotation: 3, scaleX: 0.8, scaleY: 1.1 },
    };
    shot.objects.push(moveTarget, transformTarget);
    shot.animations = [{
      id: "animation-fit-move",
      type: "move",
      targetIds: [moveTarget.id],
      start: 1,
      duration: 0.5,
      easing: "ease-in-out",
      properties: { deltaX: 80, deltaY: -40 },
    }, {
      id: "animation-fit-transform",
      type: "transform",
      targetIds: [transformTarget.id],
      start: 2,
      duration: 0.5,
      easing: "linear",
      properties: { x: 800, y: 420, width: 1, height: 120, rotation: 25, scaleX: 1.4, scaleY: 0.7 },
    }, {
      id: "animation-fit-camera",
      type: "camera-focus",
      targetIds: [title.id],
      start: 3,
      duration: 0.5,
      easing: "editorial",
      properties: { x: 760, y: 200, zoom: 1.6, rotation: -8 },
    }];
    shot.propertyTracks = [{
      id: "track-fit-title-x",
      target: { kind: "object", objectId: title.id },
      property: "x",
      keyframes: [
        { id: "keyframe-fit-title-x-start", time: 0, value: 100, interpolation: { kind: "linear" } },
        { id: "keyframe-fit-title-x-end", time: 0.5, value: 900, interpolation: { kind: "linear" } },
      ],
    }, {
      id: "track-fit-title-y",
      target: { kind: "object", objectId: title.id },
      property: "y",
      keyframes: [
        { id: "keyframe-fit-title-y-start", time: 0, value: 50, interpolation: { kind: "linear" } },
        { id: "keyframe-fit-title-y-end", time: 0.5, value: 490, interpolation: { kind: "linear" } },
      ],
    }, {
      id: "track-fit-title-width",
      target: { kind: "object", objectId: title.id },
      property: "width",
      keyframes: [
        { id: "keyframe-fit-title-width-start", time: 0, value: 1, interpolation: { kind: "linear" } },
        { id: "keyframe-fit-title-width-end", time: 0.5, value: 400, interpolation: { kind: "linear" } },
      ],
    }, {
      id: "track-fit-title-opacity",
      target: { kind: "object", objectId: title.id },
      property: "opacity",
      keyframes: [
        { id: "keyframe-fit-title-opacity-start", time: 0, value: 0.4, interpolation: { kind: "linear" } },
        { id: "keyframe-fit-title-opacity-end", time: 0.5, value: 0.9, interpolation: { kind: "linear" } },
      ],
    }, {
      id: "track-fit-move-stroke-width",
      target: { kind: "object", objectId: moveTarget.id },
      property: "strokeWidth",
      keyframes: [
        { id: "keyframe-fit-move-stroke-width-start", time: 0, value: 2, interpolation: { kind: "linear" } },
        { id: "keyframe-fit-move-stroke-width-end", time: 0.5, value: 6, interpolation: { kind: "linear" } },
      ],
    }, {
      id: "track-fit-camera-x",
      target: { kind: "camera" },
      property: "x",
      keyframes: [
        { id: "keyframe-fit-camera-x-start", time: 4, value: 640, interpolation: { kind: "linear" } },
        { id: "keyframe-fit-camera-x-end", time: 5, value: 720, interpolation: { kind: "linear" } },
      ],
    }, {
      id: "track-fit-camera-y",
      target: { kind: "camera" },
      property: "y",
      keyframes: [
        { id: "keyframe-fit-camera-y-start", time: 4, value: 160, interpolation: { kind: "linear" } },
        { id: "keyframe-fit-camera-y-end", time: 5, value: 240, interpolation: { kind: "linear" } },
      ],
    }, {
      id: "track-fit-camera-zoom",
      target: { kind: "camera" },
      property: "zoom",
      keyframes: [
        { id: "keyframe-fit-camera-zoom-start", time: 4, value: 1.1, interpolation: { kind: "linear" } },
        { id: "keyframe-fit-camera-zoom-end", time: 5, value: 1.5, interpolation: { kind: "linear" } },
      ],
    }];
    const source = ProjectDocumentSchema.parse(project);
    const result = applyDocumentOperations(source, [{
      type: "set-project-settings",
      settings: { aspectRatio: "9:16", frameRate: 30, renderPreset: "720p", previewQuality: "standard" },
      cameraPolicy: "fit-all",
    }]).project;
    const fitted = result.shots[0];
    const trackValues = (id: string) => fitted.propertyTracks.find((track) => track.id === id)!.keyframes.map(({ value }) => value);
    const animationProperties = (id: string) => fitted.animations.find((animation) => animation.id === id)!.properties;

    expect(trackValues("track-fit-title-x")).toEqual([56.25, 506.25]);
    expect(trackValues("track-fit-title-y")).toEqual([356.25, 603.75]);
    expect(trackValues("track-fit-title-width")).toEqual([1, 225]);
    expect(trackValues("track-fit-title-opacity")).toEqual([0.4, 0.9]);
    expect(trackValues("track-fit-move-stroke-width")).toEqual([1.125, 3.375]);
    expect(trackValues("track-fit-camera-x")).toEqual([360, 405]);
    expect(trackValues("track-fit-camera-y")).toEqual([418.125, 463.125]);
    expect(trackValues("track-fit-camera-zoom")).toEqual([1.1, 1.5]);
    expect(animationProperties("animation-fit-move")).toEqual({ deltaX: 45, deltaY: -22.5 });
    expect(animationProperties("animation-fit-transform")).toEqual({ x: 450, y: 564.375, width: 1, height: 67.5, rotation: 25, scaleX: 1.4, scaleY: 0.7 });
    expect(animationProperties("animation-fit-camera")).toEqual({ x: 427.5, y: 440.625, zoom: 1.6, rotation: -8 });
    expect(ProjectDocumentSchema.safeParse(result).success).toBe(true);
  });

  test("retains the preserve settings policy without reframing authored geometry", () => {
    const project = authoringProject();
    project.shots[0].camera = { x: 710, y: 190, zoom: 1.2, rotation: 4 };
    const source = ProjectDocumentSchema.parse(project);
    const result = applyDocumentOperations(source, [{
      type: "set-project-settings",
      settings: { aspectRatio: "9:16", frameRate: 24, renderPreset: "draft", previewQuality: "draft" },
      cameraPolicy: "preserve",
    }]).project;
    expect(result.shots[0].objects).toEqual(source.shots[0].objects);
    expect(result.shots[0].camera).toEqual(source.shots[0].camera);
  });

  test("refuses duration shrink that truncates authored state", () => {
    const project = authoringProject();
    project.shots[0].markers = [{ id: "marker-end", time: 5, name: "End", color: "#000000" }];
    expect(() => applyDocumentOperations(ProjectDocumentSchema.parse(project), [
      { type: "update-shot", shotId: "shot-authoring", patch: { duration: 4 } },
    ])).toThrow(/truncate marker marker-end/);
  });

  test("treats bundled styles as editable project-local starting points and provides duplicate-to-custom", () => {
    const project = authoringProject();
    const source = cloneSerializable(project.styles[0]);
    source.name = "Editorial Ink Revised";
    source.colors.background = "#102030";
    const replaced = applyDocumentOperations(project, [{ type: "replace-style", styleId: source.id, style: source }]).project;
    expect(replaced.styles[0]).toEqual(expect.objectContaining({ id: source.id, name: "Editorial Ink Revised", origin: "preset" }));
    expect(replaced.styles[0].colors.background).toBe("#102030");

    const duplicate = duplicateStyleOperation(replaced, source.id, "My Ink");
    const duplicated = applyDocumentOperations(replaced, [duplicate]).project;
    const custom = duplicated.styles.find(({ name }) => name === "My Ink")!;
    expect(custom.origin).toBe("custom");
    expect(custom.colors.background).toBe("#102030");
    expect(custom.id).not.toBe(source.id);

    const active = applyDocumentOperations(duplicated, [{
      type: "delete-style",
      styleId: duplicated.activeStyleId,
      fallbackStyleId: custom.id,
    }]).project;
    expect(active.activeStyleId).toBe(custom.id);
  });

  test("adds, replaces, and deletes easing-library entries without rewriting inline animation state", () => {
    const project = authoringProject();
    project.shots[0].animations = [{
      id: "animation-there-back",
      type: "emphasise",
      targetIds: ["object-authoring-title"],
      start: 1,
      duration: 1,
      easing: "there-and-back",
      properties: { scale: 1.1 },
    }];
    const valid = ProjectDocumentSchema.parse(project);
    const added = applyDocumentOperations(valid, [{
      type: "add-custom-easing",
      easing: { id: "easing-project-curve", name: "Project curve", curve: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 } },
    }]).project;
    const replaced = applyDocumentOperations(added, [{
      type: "replace-custom-easing",
      easingId: "easing-project-curve",
      easing: { id: "easing-project-curve", name: "Renamed curve", curve: { x1: 0.1, y1: -1, x2: 0.9, y2: 2 } },
    }]).project;
    const deleted = applyDocumentOperations(replaced, [{ type: "delete-custom-easing", easingId: "easing-project-curve" }]).project;
    expect(deleted.customEasings).toEqual([]);
    expect(deleted.shots[0].animations[0].easing).toBe("there-and-back");
  });

  test("duplicates shots with fresh stable IDs and a complete source mapping", () => {
    const project = authoringProject();
    project.shots[0].propertyTracks = [xTrack()];
    const valid = ProjectDocumentSchema.parse(project);
    const sourceIds = [...shotLocalIds(valid.shots[0])].sort();
    const result = applyDocumentOperations(valid, [duplicateShotOperation(valid, "shot-authoring")]);
    const duplicate = result.project.shots[1];
    const mapping = result.idMappings[0];
    expect(mapping.operationType).toBe("duplicate-shot");
    expect(Object.keys(mapping.ids).sort()).toEqual(sourceIds);
    expect(sourceIds.every((id) => mapping.ids[id].length === 1 && mapping.ids[id][0] !== id)).toBe(true);
    expect(new Set([...shotLocalIds(valid.shots[0]), ...shotLocalIds(duplicate)]).size)
      .toBe(shotLocalIds(valid.shots[0]).size + shotLocalIds(duplicate).size);
    expect(duplicate.propertyTracks[0].target).toEqual({ kind: "object", objectId: mapping.ids["object-authoring-title"][0] });
  });

  test("remaps only declared component references and preserves opaque or asset IDs", () => {
    const project = authoringProject();
    const shot = project.shots[0];
    const target = shot.objects[0];
    project.assets.push({
      id: target.id,
      filename: "colliding-id.png",
      mimeType: "image/png",
      size: 32,
      sha256: "b".repeat(64),
      provenance: "uploaded",
    });
    shot.objects.push({
      ...cloneSerializable(target),
      id: "object-annotation-arrow",
      type: "arrow",
      name: "Annotation arrow",
      semanticRole: "annotation-arrow",
      style: {},
      properties: {
        targetId: target.id,
        externalId: target.id,
      },
    }, {
      ...cloneSerializable(target),
      id: "object-colliding-asset",
      type: "image",
      name: "Colliding asset",
      style: {},
      properties: { assetId: target.id },
    });
    const valid = ProjectDocumentSchema.parse(project);

    const duplicated = applyDocumentOperations(valid, [duplicateShotOperation(valid, shot.id)]);
    const duplicate = duplicated.project.shots[1];
    const duplicateIds = duplicated.idMappings[0].ids;
    const duplicateArrow = duplicate.objects.find(({ id }) => id === duplicateIds["object-annotation-arrow"][0])!;
    const duplicateImage = duplicate.objects.find(({ id }) => id === duplicateIds["object-colliding-asset"][0])!;
    expect(duplicateArrow.properties).toEqual({
      targetId: duplicateIds[target.id][0],
      externalId: target.id,
    });
    expect(duplicateImage.properties.assetId).toBe(target.id);

    const split = applyDocumentOperations(valid, [splitShotOperation(valid, shot.id, 3)]);
    const splitIds = split.idMappings[0].ids;
    const right = split.project.shots[1];
    const rightArrow = right.objects.find(({ id }) => id === splitIds["object-annotation-arrow"][1])!;
    const rightImage = right.objects.find(({ id }) => id === splitIds["object-colliding-asset"][1])!;
    expect(rightArrow.properties).toEqual({
      targetId: splitIds[target.id][1],
      externalId: target.id,
    });
    expect(rightImage.properties.assetId).toBe(target.id);
  });

  test("duplicates animations and clears lifetimes through typed manual scene operations", () => {
    const project = authoringProject();
    project.shots[0].animations = [{
      id: "animation-source",
      type: "move",
      targetIds: ["object-authoring-title"],
      start: 0,
      duration: 1,
      easing: "there-and-back",
      properties: { x: 200 },
    }];
    const valid = ProjectDocumentSchema.parse(project);
    const duplicated = applyOperations(valid, "shot-authoring", [duplicateAnimationOperation(valid, "shot-authoring", "animation-source", 3)]).project;
    expect(duplicated.shots[0].animations.map(({ id }) => id)).toEqual(["animation-source", "animation-animation-source-copy"]);
    expect(duplicated.shots[0].animations[1]).toEqual(expect.objectContaining({ start: 3, easing: "there-and-back" }));
    const bounded = applyOperations(duplicated, "shot-authoring", [{
      type: "set-object-lifetime",
      objectId: "object-authoring-title",
      lifetime: { start: 0, end: 5 },
    }]).project;
    expect(applyOperations(bounded, "shot-authoring", [{ type: "clear-object-lifetime", objectId: "object-authoring-title" }]).project.shots[0].objects[0].lifetime).toBeUndefined();
  });

  test("canonicalizes temporal operation payloads and rejects same-tick collisions atomically", () => {
    const project = authoringProject();
    const withMarker = applyDocumentOperations(project, [{
      type: "add-marker",
      shotId: "shot-authoring",
      marker: { id: "marker-operation-tick", time: 1.000000004, name: "Tick", color: "#123456" },
    }]).project;
    expect(withMarker.shots[0].markers[0].time).toBe(1);

    const animated = applyOperations(withMarker, "shot-authoring", [{
      type: "add-animation",
      animation: {
        id: "animation-operation-tick",
        type: "move",
        targetIds: ["object-authoring-title"],
        start: 0.100000004,
        duration: 0.200000004,
        easing: "linear",
        properties: { deltaX: 10 },
      },
    }]).project;
    expect(animated.shots[0].animations[0]).toEqual(expect.objectContaining({ start: 0.1, duration: 0.20000001 }));

    const tracked = cloneSerializable(project);
    tracked.shots[0].propertyTracks = [{
      id: "track-operation-tick",
      target: { kind: "object", objectId: "object-authoring-title" },
      property: "x",
      keyframes: [
        { id: "keyframe-operation-a", time: 0, value: 120, interpolation: { kind: "linear" } },
        { id: "keyframe-operation-b", time: 1, value: 180, interpolation: { kind: "linear" } },
        { id: "keyframe-operation-c", time: 2, value: 240, interpolation: { kind: "linear" } },
      ],
    }];
    const valid = ProjectDocumentSchema.parse(tracked);
    const before = canonicalProjectJson(valid);
    expect(() => applyOperations(valid, "shot-authoring", [{
      type: "move-keyframe",
      trackId: "track-operation-tick",
      keyframeId: "keyframe-operation-c",
      time: 1.000000004,
    }])).toThrow(/one keyframe per timeline tick|strictly ordered/);
    expect(canonicalProjectJson(valid)).toBe(before);
  });
});

describe("conservative shot split and merge", () => {
  test("canonicalizes split boundaries and keeps split/merge arithmetic tick-exact", () => {
    const project = authoringProject();
    const operation = splitShotOperation(project, "shot-authoring", 3.000000004);
    expect(operation.time).toBe(3);
    const split = applyDocumentOperations(project, [operation]);
    expect(split.project.shots.map(({ duration }) => duration)).toEqual([3, 3]);
    const merged = applyDocumentOperations(split.project, [mergeShotsOperation(
      split.project,
      split.project.shots[0].id,
      split.project.shots[1].id,
    )]);
    expect(merged.project.shots[0].duration).toBe(6);
    expect(canonicalProjectJson(ProjectDocumentSchema.parse(merged.project))).toBe(canonicalProjectJson(merged.project));
    expect(() => splitShotOperation(project, "shot-authoring", 5.999999996)).toThrow(/strictly inside/);
  });

  test("splits linear authored state, exposes complete one-to-many mappings, and merges with equivalent sampled output", () => {
    const project = authoringProject();
    project.shots[0].propertyTracks = [xTrack()];
    const valid = ProjectDocumentSchema.parse(project);
    const split = applyDocumentOperations(valid, [splitShotOperation(valid, "shot-authoring", 3)]);
    expect(split.project.shots).toHaveLength(2);
    expect(split.project.shots.map(({ duration }) => duration)).toEqual([3, 3]);
    const splitMapping = split.idMappings[0].ids;
    expect(splitMapping["shot-authoring"]).toHaveLength(2);
    expect(splitMapping["object-authoring-title"]).toHaveLength(2);
    expect(splitMapping["track-authoring-x"]).toHaveLength(2);
    const rightObjectId = splitMapping["object-authoring-title"][1];
    for (const time of [0, 1, 2.5]) {
      const original = previewShotAtTime(valid.shots[0], time).objects[0];
      const left = previewShotAtTime(split.project.shots[0], time).objects.find(({ id }) => id === "object-authoring-title")!;
      expect(left.transform.x).toBeCloseTo(original.transform.x);
    }
    for (const time of [0, 1, 2.5]) {
      const original = previewShotAtTime(valid.shots[0], time + 3).objects[0];
      const right = previewShotAtTime(split.project.shots[1], time).objects.find(({ id }) => id === rightObjectId)!;
      expect(right.transform.x).toBeCloseTo(original.transform.x);
    }

    const merged = applyDocumentOperations(split.project, [mergeShotsOperation(
      split.project,
      split.project.shots[0].id,
      split.project.shots[1].id,
    )]);
    expect(merged.project.shots).toHaveLength(1);
    expect(merged.idMappings[0].ids[split.project.shots[1].id]).toEqual([split.project.shots[0].id]);
    for (const time of [0.5, 2.5, 3, 3.5, 5.5]) {
      const expected = previewShotAtTime(valid.shots[0], time).objects[0];
      const visibleObjects = previewShotAtTime(merged.project.shots[0], time).objects.filter(({ preview }) => preview.opacity > 0.5);
      expect(visibleObjects).toHaveLength(1);
      const visible = visibleObjects[0];
      expect(visible.transform.x).toBeCloseTo(expected.transform.x);
    }
    expect(previewShotAtTime(merged.project.shots[0], 3).objects.find(({ preview }) => preview.opacity > 0.5)?.id).toBe(rightObjectId);
    const mergedCompile = compileManim(merged.project);
    expect(mergedCompile.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(mergedCompile.python).toContain("# Animation component 1: 0.0s to 6.0s");
    expect(mergedCompile.python).toContain("copy().set_opacity(0.0), run_time=0.0, rate_func=linear");
    expect(mergedCompile.python).toContain("FadeIn(");
  });

  test("rejects sub-tick lifetimes/keyframes at ingress and partitions adjacent-tick markers exactly", () => {
    const subTickDelta = 0.1e-9;
    const narrowLifetime = authoringProject();
    const narrowShot = narrowLifetime.shots[0];
    const tiny = {
      ...cloneSerializable(narrowShot.objects[0]),
      id: "object-sub-tick-life",
      name: "Sub-tick lifetime",
      lifetime: { start: 3 - subTickDelta, end: 3 + subTickDelta },
    };
    narrowShot.objects.push(tiny);
    expect(ProjectDocumentSchema.safeParse(narrowLifetime).success).toBe(false);

    const nearKeyframes = authoringProject();
    nearKeyframes.shots[0].propertyTracks = [{
      id: "track-epsilon-x",
      target: { kind: "object", objectId: "object-authoring-title" },
      property: "x",
      keyframes: [
        { id: "keyframe-epsilon-a", time: 2, value: 120, interpolation: { kind: "linear" } },
        { id: "keyframe-epsilon-left", time: 3 - subTickDelta, value: 160, interpolation: { kind: "linear" } },
        { id: "keyframe-epsilon-right", time: 3 + subTickDelta, value: 180, interpolation: { kind: "linear" } },
        { id: "keyframe-epsilon-d", time: 4, value: 220, interpolation: { kind: "linear" } },
      ],
    }];
    expect(ProjectDocumentSchema.safeParse(nearKeyframes).success).toBe(false);

    const project = authoringProject();
    const shot = project.shots[0];
    shot.markers = [
      { id: "marker-epsilon-left", time: 2.99999999, name: "Left", color: "#112233" },
      { id: "marker-epsilon-exact", time: 3, name: "Exact", color: "#223344" },
      { id: "marker-epsilon-right", time: 3.00000001, name: "Right", color: "#334455" },
    ];
    const valid = ProjectDocumentSchema.parse(project);
    const split = applyDocumentOperations(valid, [splitShotOperation(valid, shot.id, 3)]);
    const mapping = split.idMappings[0].ids;
    expect(split.project.shots[0].markers.map(({ id }) => id)).toEqual(["marker-epsilon-left"]);
    expect(split.project.shots[1].markers.map(({ id }) => id)).toEqual(["marker-epsilon-exact", "marker-epsilon-right"]);
    expect(split.project.shots[1].markers[0].time).toBe(0);
    expect(split.project.shots[1].markers[1].time).toBe(0.00000001);
    for (const id of ["marker-epsilon-left", "marker-epsilon-exact", "marker-epsilon-right"]) {
      expect(mapping[id]).toHaveLength(1);
    }
  });

  test("refuses one-tick-sided animation, audio, and caption spans atomically", () => {
    const delta = 1e-8;
    const animation = authoringProject();
    animation.shots[0].animations = [{ id: "animation-epsilon-cross", type: "move", targetIds: ["object-authoring-title"], start: 3 - delta, duration: 2 * delta, easing: "linear", properties: { x: 200 } }];
    const animationValid = ProjectDocumentSchema.parse(animation);
    expect(() => splitShotOperation(animationValid, "shot-authoring", 3)).toThrow(/Animation animation-epsilon-cross/);

    const audio = authoringProject();
    audio.assets.push({ id: "asset-epsilon-audio", filename: "epsilon.wav", mimeType: "audio/wav", size: 16, sha256: "a".repeat(64), duration: 6, provenance: "uploaded" });
    audio.shots[0].audioClips = [{ id: "audio-epsilon-cross", assetId: "asset-epsilon-audio", name: "Epsilon audio", start: 3 - delta, duration: 2 * delta, sourceStart: 0, sourceEnd: 1, volume: 1, muted: false, solo: false }];
    const audioValid = ProjectDocumentSchema.parse(audio);
    expect(() => splitShotOperation(audioValid, "shot-authoring", 3)).toThrow(/Audio clip audio-epsilon-cross/);

    const caption = authoringProject();
    caption.shots[0].captionClips = [{ id: "caption-epsilon-cross", start: 3 - delta, end: 3 + delta, text: "Epsilon caption", style: {} }];
    const captionValid = ProjectDocumentSchema.parse(caption);
    expect(() => splitShotOperation(captionValid, "shot-authoring", 3)).toThrow(/Caption caption-epsilon-cross/);
  });

  test("refuses pre-boundary ancestor authority over post-boundary-only descendants", () => {
    const withHierarchy = () => {
      const project = authoringProject();
      const shot = project.shots[0];
      const child = shot.objects[0];
      const group = {
        id: "group-boundary-authority",
        type: "group" as const,
        name: "Boundary authority",
        locked: false,
        visible: true,
        transform: { x: 100, y: 270, width: 200, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
        style: {},
        properties: {},
      };
      child.parentId = group.id;
      child.lifetime = { start: 4, end: 6 };
      shot.objects.unshift(group);
      return project;
    };

    for (const property of ["x", "opacity"] as const) {
      const tracked = withHierarchy();
      tracked.shots[0].propertyTracks = [{
        id: `track-group-${property}`,
        target: { kind: "object", objectId: "group-boundary-authority" },
        property,
        keyframes: [
          { id: `keyframe-group-${property}-a`, time: 0, value: property === "x" ? 100 : 1, interpolation: { kind: "linear" } },
          { id: `keyframe-group-${property}-b`, time: 2, value: property === "x" ? 200 : 0.5, interpolation: { kind: "linear" } },
        ],
      }];
      const valid = ProjectDocumentSchema.parse(tracked);
      expect(() => splitShotOperation(valid, "shot-authoring", 3)).toThrow(new RegExp(`Property track track-group-${property}.*post-boundary-only`));
    }

    const animated = withHierarchy();
    animated.shots[0].animations = [{ id: "animation-group-before-split", type: "move", targetIds: ["group-boundary-authority"], start: 0, duration: 2, easing: "linear", properties: { x: 200 } }];
    const animatedValid = ProjectDocumentSchema.parse(animated);
    expect(() => splitShotOperation(animatedValid, "shot-authoring", 3)).toThrow(/Animation animation-group-before-split.*post-boundary-only/);
  });

  test("refuses moving a future entrance that owns the left shot's hidden state", () => {
    for (const targetKind of ["leaf", "group"] as const) {
      const project = authoringProject();
      const shot = project.shots[0];
      const leaf = shot.objects[0];
      let targetId = leaf.id;
      if (targetKind === "group") {
        const group = {
          id: "group-future-entrance",
          type: "group" as const,
          name: "Future entrance group",
          locked: false,
          visible: true,
          transform: { x: 120, y: 270, width: 200, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
          style: {},
          properties: {},
        };
        leaf.parentId = group.id;
        shot.objects.unshift(group);
        targetId = group.id;
      }
      shot.animations = [{ id: `animation-future-${targetKind}-entrance`, type: "fade-in", targetIds: [targetId], start: 4, duration: 1, easing: "linear", properties: {} }];
      const valid = ProjectDocumentSchema.parse(project);
      expect(previewShotAtTime(valid.shots[0], 1).objects.find(({ id }) => id === leaf.id)?.preview.opacity).toBe(0);
      expect(() => splitShotOperation(valid, shot.id, 3)).toThrow(/determines pre-split hidden state/);
    }
  });

  test("preserves sparse child style inheritance across a split", () => {
    const project = authoringProject();
    const shot = project.shots[0];
    const child = shot.objects[0];
    child.style = { color: "#abcdef" };
    const group = {
      id: "group-style-inheritance",
      type: "group" as const,
      name: "Style inheritance",
      locked: false,
      visible: true,
      transform: { x: 120, y: 270, width: 200, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: { opacity: 0.5 },
      properties: {},
    };
    child.parentId = group.id;
    shot.objects.unshift(group);
    const valid = ProjectDocumentSchema.parse(project);
    const split = applyDocumentOperations(valid, [splitShotOperation(valid, shot.id, 3)]);
    const right = split.project.shots[1];
    const rightGroupId = split.idMappings[0].ids[group.id][1];
    const rightChildId = split.idMappings[0].ids[child.id][1];
    expect(right.objects.find(({ id }) => id === rightChildId)?.style.opacity).toBeUndefined();

    const edited = cloneSerializable(split.project);
    edited.shots[1].objects.find(({ id }) => id === rightGroupId)!.style.opacity = 0.2;
    const editedValid = ProjectDocumentSchema.parse(edited);
    expect(previewShotAtTime(editedValid.shots[1], 1).objects.find(({ id }) => id === rightChildId)?.preview.opacity).toBe(0.2);
  });

  test("refuses completed group visual authority that would re-expose descendant overrides", () => {
    const cases = [
      { property: "fill" as const, authored: "#ff0000", start: "#112233", end: "#00ff00" },
      { property: "stroke" as const, authored: "#ff0000", start: "#112233", end: "#00ff00" },
      { property: "strokeWidth" as const, authored: 1, start: 2, end: 5 },
      { property: "opacity" as const, authored: 0.8, start: 1, end: 0.5 },
    ];
    for (const { property, authored, start, end } of cases) {
      const project = authoringProject();
      const shot = project.shots[0];
      const child = shot.objects[0];
      child.type = "rectangle";
      child.properties = {};
      child.style = { [property]: authored };
      const group = {
        id: `group-cascade-${property}`,
        type: "group" as const,
        name: `${property} cascade`,
        locked: false,
        visible: true,
        transform: { x: 120, y: 270, width: 200, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
        style: {},
        properties: {},
      };
      child.parentId = group.id;
      shot.objects.unshift(group);
      shot.propertyTracks = [{
        id: `track-group-cascade-${property}`,
        target: { kind: "object", objectId: group.id },
        property,
        keyframes: [
          { id: `keyframe-group-cascade-${property}-a`, time: 0, value: start, interpolation: { kind: "linear" } },
          { id: `keyframe-group-cascade-${property}-b`, time: 2, value: end, interpolation: { kind: "linear" } },
        ],
      }];
      const valid = ProjectDocumentSchema.parse(project);
      const boundaryObject = previewShotAtTime(valid.shots[0], 3).objects.find(({ id }) => id === child.id)!;
      expect(boundaryObject.style[property]).toBe(end);
      expect(compileManim(valid).diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
      const before = canonicalProjectJson(valid);
      expect(() => splitShotOperation(valid, shot.id, 3)).toThrow(new RegExp(`Completed group ${property} track.*descendant visual authority`));
      expect(canonicalProjectJson(valid)).toBe(before);
    }

    const mixed = authoringProject();
    const shot = mixed.shots[0];
    const child = shot.objects[0];
    child.type = "rectangle";
    child.properties = {};
    child.style = {};
    const group = {
      id: "group-cascade-mixed",
      type: "group" as const,
      name: "Mixed cascade",
      locked: false,
      visible: true,
      transform: { x: 120, y: 270, width: 200, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    child.parentId = group.id;
    shot.objects.unshift(group);
    shot.propertyTracks = [
      {
        id: "track-child-cascade-fill",
        target: { kind: "object", objectId: child.id },
        property: "fill",
        keyframes: [
          { id: "keyframe-child-cascade-fill-a", time: 0, value: "#112233", interpolation: { kind: "linear" } },
          { id: "keyframe-child-cascade-fill-b", time: 1, value: "#ff0000", interpolation: { kind: "linear" } },
        ],
      },
      {
        id: "track-group-cascade-fill",
        target: { kind: "object", objectId: group.id },
        property: "fill",
        keyframes: [
          { id: "keyframe-group-cascade-fill-a", time: 1, value: "#ff0000", interpolation: { kind: "linear" } },
          { id: "keyframe-group-cascade-fill-b", time: 2, value: "#00ff00", interpolation: { kind: "linear" } },
        ],
      },
    ];
    const valid = ProjectDocumentSchema.parse(mixed);
    expect(previewShotAtTime(valid.shots[0], 3).objects.find(({ id }) => id === child.id)?.style.fill).toBe("#00ff00");
    expect(compileManim(valid).diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(() => splitShotOperation(valid, shot.id, 3)).toThrow(/Completed group fill track.*descendant visual authority/);
  });

  test("partitions hierarchy members by effective ancestor lifetime", () => {
    const project = authoringProject();
    const shot = project.shots[0];
    const child = shot.objects[0];
    const group = {
      id: "group-ending-at-split",
      type: "group" as const,
      name: "Ending group",
      locked: false,
      visible: true,
      lifetime: { start: 0, end: 3 },
      transform: { x: 120, y: 270, width: 200, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    child.parentId = group.id;
    shot.objects.unshift(group);
    const valid = ProjectDocumentSchema.parse(project);
    const operation = splitShotOperation(valid, shot.id, 3);
    const split = applyDocumentOperations(valid, [operation]);
    expect(split.project.shots[0].objects.map(({ id }) => id)).toEqual([group.id, child.id]);
    expect(split.project.shots[1].objects).toEqual([]);
    expect(split.idMappings[0].ids[child.id]).toEqual([child.id]);
  });

  test("refuses unsplittable interpolation, semantic, and caption spans without mutation", () => {
    const custom = authoringProject();
    custom.shots[0].propertyTracks = [xTrack({ kind: "custom-bezier", curve: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 } })];
    const customValid = ProjectDocumentSchema.parse(custom);
    const before = canonicalProjectJson(customValid);
    expect(() => splitShotOperation(customValid, "shot-authoring", 3)).toThrow(/custom-bezier/);
    expect(canonicalProjectJson(customValid)).toBe(before);

    const semantic = authoringProject();
    semantic.shots[0].animations = [{ id: "animation-crossing", type: "move", targetIds: ["object-authoring-title"], start: 2, duration: 2, easing: "linear", properties: { x: 300 } }];
    const semanticValid = ProjectDocumentSchema.parse(semantic);
    expect(() => splitShotOperation(semanticValid, "shot-authoring", 3)).toThrow(/Animation animation-crossing/);

    const caption = authoringProject();
    caption.shots[0].captionClips = [{ id: "caption-crossing", start: 2, end: 4, text: "Crossing", style: {} }];
    const captionValid = ProjectDocumentSchema.parse(caption);
    expect(() => splitShotOperation(captionValid, "shot-authoring", 3)).toThrow(/Caption caption-crossing/);

    const signedScale = authoringProject();
    signedScale.shots[0].propertyTracks = [{ ...xTrack(), id: "track-crossing-scale", property: "scaleX", keyframes: [
      { id: "keyframe-crossing-scale-a", time: 0, value: 1, interpolation: { kind: "linear" } },
      { id: "keyframe-crossing-scale-b", time: 6, value: -1, interpolation: { kind: "linear" } },
    ] }];
    const signedScaleValid = ProjectDocumentSchema.parse(signedScale);
    expect(() => splitShotOperation(signedScaleValid, "shot-authoring", 3)).toThrow(/non-affine signed-scale/);

    const color = authoringProject();
    color.shots[0].propertyTracks = [{ ...xTrack(), id: "track-crossing-color", property: "fill", keyframes: [
      { id: "keyframe-crossing-color-a", time: 0, value: "#000000", interpolation: { kind: "linear" } },
      { id: "keyframe-crossing-color-b", time: 6, value: "#131313", interpolation: { kind: "linear" } },
    ] }];
    const colorValid = ProjectDocumentSchema.parse(color);
    expect(() => splitShotOperation(colorValid, "shot-authoring", 3)).toThrow(/non-affine color/);
  });

  test("refuses nonadjacent or camera-discontinuous merges precisely", () => {
    const project = createCantorDemoProject();
    expect(() => mergeShotsOperation(project, project.shots[0].id, project.shots[1].id)).toThrow(/cameras do not meet/);
    const reordered = cloneSerializable(project);
    reordered.shots.push({ ...cloneSerializable(reordered.shots[1]), id: "shot-third", name: "Third", objects: [], animations: [], propertyTracks: [], audioClips: [], captionClips: [], markers: [] });
    const valid = ProjectDocumentSchema.parse(reordered);
    expect(() => mergeShotsOperation(valid, valid.shots[0].id, valid.shots[2].id)).toThrow(/adjacent/);
  });

  test("refuses cross-shot solo-state capture and keeps boundary media half-open", () => {
    const project = authoringProject();
    const initialSplit = applyDocumentOperations(project, [splitShotOperation(project, "shot-authoring", 3)]).project;
    initialSplit.assets.push({
      id: "asset-merge-audio",
      filename: "merge.wav",
      mimeType: "audio/wav",
      size: 32,
      sha256: "d".repeat(64),
      duration: 1,
      provenance: "uploaded",
    });
    const [left, right] = initialSplit.shots;
    left.audioClips = [{ id: "audio-merge-left", assetId: "asset-merge-audio", name: "Left solo", start: 2, duration: 1, sourceStart: 0, sourceEnd: 1, volume: 1, muted: false, solo: true }];
    right.audioClips = [{ id: "audio-merge-right", assetId: "asset-merge-audio", name: "Right ordinary", start: 0, duration: 1, sourceStart: 0, sourceEnd: 1, volume: 1, muted: false, solo: false }];
    left.captionClips = [{ id: "caption-merge-left", start: 2, end: 3, text: "Left boundary", style: {} }];
    right.captionClips = [{ id: "caption-merge-right", start: 0, end: 1, text: "Right boundary", style: {} }];
    const mixedSolo = ProjectDocumentSchema.parse(initialSplit);
    expect(() => mergeShotsOperation(mixedSolo, left.id, right.id)).toThrow(/solo state would mute/);

    mixedSolo.shots[1].audioClips[0].solo = true;
    const compatibleSolo = ProjectDocumentSchema.parse(mixedSolo);
    const merged = applyDocumentOperations(compatibleSolo, [mergeShotsOperation(compatibleSolo, left.id, right.id)]).project.shots[0];
    expect(merged.audioClips.map(({ start, solo }) => ({ start, solo }))).toEqual([
      { start: 2, solo: true },
      { start: 3, solo: true },
    ]);
    expect(merged.captionClips.map(({ start, end }) => ({ start, end }))).toEqual([
      { start: 2, end: 3 },
      { start: 3, end: 4 },
    ]);
  });

  test("composes structural mappings through later operations and removes non-survivors", () => {
    const project = authoringProject();
    const duplicate = duplicateShotOperation(project, "shot-authoring");
    const predictedDuplicate = applyDocumentOperations(project, [duplicate]).idMappings[0].ids["shot-authoring"][0];
    const duplicateThenDelete = applyDocumentOperations(project, [
      duplicate,
      { type: "delete-shot", shotId: predictedDuplicate },
    ]);
    expect(duplicateThenDelete.idMappings[0].ids["shot-authoring"]).toEqual([]);

    const split = splitShotOperation(project, "shot-authoring", 3);
    const predictedSplit = applyDocumentOperations(project, [split]);
    const [leftId, rightId] = predictedSplit.idMappings[0].ids["shot-authoring"];
    const splitThenMerge = applyDocumentOperations(project, [
      split,
      { type: "merge-shots", leftShotId: leftId, rightShotId: rightId },
    ]);
    expect(splitThenMerge.idMappings[0].ids["shot-authoring"]).toEqual([leftId]);
    expect(splitThenMerge.idMappings[0].ids["object-authoring-title"]).toEqual(expect.arrayContaining(splitThenMerge.project.shots[0].objects.map(({ id }) => id)));
    const finalIds = new Set(splitThenMerge.project.shots.flatMap((shot) => [...shotLocalIds(shot)]));
    expect(Object.values(splitThenMerge.idMappings[0].ids).flat().every((id) => finalIds.has(id))).toBe(true);

    const collidingNamespace = authoringProject();
    collidingNamespace.assets.push({
      id: "shot-authoring",
      filename: "shot-id-collision.png",
      mimeType: "image/png",
      size: 32,
      sha256: "e".repeat(64),
      provenance: "uploaded",
    });
    const collidingValid = ProjectDocumentSchema.parse(collidingNamespace);
    const predicted = applyDocumentOperations(collidingValid, [splitShotOperation(collidingValid, "shot-authoring", 3)]);
    const rightShotId = predicted.idMappings[0].ids["shot-authoring"][1];
    const splitThenDeleteLeft = applyDocumentOperations(collidingValid, [
      splitShotOperation(collidingValid, "shot-authoring", 3),
      { type: "delete-shot", shotId: "shot-authoring" },
    ]);
    expect(splitThenDeleteLeft.project.assets[0].id).toBe("shot-authoring");
    expect(splitThenDeleteLeft.idMappings[0].ids["shot-authoring"]).toEqual([rightShotId]);
  });
});
