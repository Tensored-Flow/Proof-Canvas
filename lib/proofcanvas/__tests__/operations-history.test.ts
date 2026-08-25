import { createCantorDemoProject } from "../demo";
import { insertSemanticComponent } from "../components";
import { canRedo, canUndo, commitOperations, commitProject, createHistory, redo, undo } from "../history";
import { applyOperations, duplicateObjects, effectiveLockOwner, validateOperations } from "../operations";
import { PROOFCANVAS_SCHEMA_LIMITS, ProjectDocumentSchema, cloneProject, cloneSerializable, type ProjectDocument, type SceneAnimation, type SceneObject, type SceneOperation } from "../schema";
import { styleById, styledDisplayBounds, styledTransform } from "../styles";

const SHOT = "shot-cantor-construction";

function groupObject(): SceneObject {
  return {
    id: "group-heading",
    type: "group",
    name: "Heading group",
    locked: false,
    visible: true,
    transform: { x: 260, y: 90, width: 500, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {},
  };
}

function compilerConflictProject(): ProjectDocument {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots.find(({ id }) => id === SHOT)!;
  const object = shot.objects.find(({ id }) => id === "object-title")!;
  delete object.parentId;
  object.locked = false;
  object.lifetime = { start: 0, end: 8 };
  shot.duration = 8;
  shot.objects = [object];
  shot.animations = [{ id: "animation-policy-scene", type: "move", targetIds: [object.id], start: 1, duration: 1, easing: "linear", properties: { deltaX: 20 } }];
  shot.propertyTracks = [{
    id: "track-policy-scene-x",
    target: { kind: "object", objectId: object.id },
    property: "x",
    keyframes: [
      { id: "keyframe-policy-scene-a", time: 0, value: 100, interpolation: { kind: "hold" } },
      { id: "keyframe-policy-scene-b", time: 4, value: 300, interpolation: { kind: "linear" } },
    ],
  }];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  project.shots = [shot];
  return ProjectDocumentSchema.parse(project);
}

function renderedLeft(object: SceneObject, style: ReturnType<typeof styleById> extends infer T ? Exclude<T, undefined> : never): number {
  const transform = styledTransform(object, style);
  const halfWidth = (transform.width ?? 60) * Math.abs(transform.scaleX) / 2;
  const halfHeight = (transform.height ?? 30) * Math.abs(transform.scaleY) / 2;
  const radians = transform.rotation * Math.PI / 180;
  return Math.min(...[[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]].map(([x, y]) => transform.x + x * Math.cos(radians) - y * Math.sin(radians)));
}

describe("atomic scene operations", () => {
  test("guards compiler-invalid timeline authority only at the final atomic scene boundary", () => {
    const legacy = compilerConflictProject();
    const unrelated = applyOperations(legacy, SHOT, [{ type: "update-object", objectId: "object-title", patch: { name: "Unrelated legacy rename" } }]).project;
    expect(unrelated.shots[0].objects[0].name).toBe("Unrelated legacy rename");

    expect(() => applyOperations(legacy, SHOT, [{
      type: "update-keyframe",
      trackId: "track-policy-scene-x",
      keyframeId: "keyframe-policy-scene-a",
      patch: { value: 101 },
    }])).toThrow(/TRACK_SEMANTIC_COLLISION.*track track-policy-scene-x.*animation animation-policy-scene/);

    const repaired = applyOperations(legacy, SHOT, [{ type: "delete-property-track", trackId: "track-policy-scene-x" }]).project;
    expect(repaired.shots[0].propertyTracks).toEqual([]);
    expect(() => applyOperations(repaired, SHOT, [{ type: "add-property-track", track: cloneSerializable(legacy.shots[0].propertyTracks[0]) }])).toThrow(/introduce renderer-rejected TRACK_SEMANTIC_COLLISION/);

    const atomicRepair = applyOperations(legacy, SHOT, [
      { type: "update-keyframe", trackId: "track-policy-scene-x", keyframeId: "keyframe-policy-scene-a", patch: { value: 102 } },
      { type: "delete-animation", animationId: "animation-policy-scene" },
    ]).project;
    expect(atomicRepair.shots[0].animations).toEqual([]);
    expect(atomicRepair.shots[0].propertyTracks[0].keyframes[0].value).toBe(102);
  });

  test("preserves immutable snapshot references instead of quadratically cloning history", () => {
    let history = createHistory(createCantorDemoProject());
    history = commitOperations(history, SHOT, [{ type: "update-object", objectId: "object-title", patch: { name: "First" } }], "First rename");
    const firstSnapshot = history.past[0].project;
    history = commitOperations(history, SHOT, [{ type: "update-object", objectId: "object-title", patch: { name: "Second" } }], "Second rename");
    expect(history.past[0].project).toBe(firstSnapshot);
    expect(firstSnapshot.shots[0].objects.find(({ id }) => id === "object-title")?.name).toBe("Uncountable, Yet Zero Length");
    const undone = undo(history);
    expect(undone.past[0].project).toBe(firstSnapshot);
    const redone = redo(undone);
    expect(redone.past[0].project).toBe(firstSnapshot);
    expect(redone.present.shots[0].objects.find(({ id }) => id === "object-title")?.name).toBe("Second");
  });

  test("updates without mutating its source and rejects a partly valid transaction atomically", () => {
    const project = createCantorDemoProject();
    const originalX = project.shots[0].objects[0].transform.x;
    const result = applyOperations(project, SHOT, [{ type: "update-object", objectId: "object-title", patch: { transform: { x: 120 } } }]);
    expect(project.shots[0].objects[0].transform.x).toBe(originalX);
    expect(result.project.shots[0].objects[0].transform.x).toBe(120);

    const transaction: SceneOperation[] = [
      { type: "update-object", objectId: "object-title", patch: { transform: { x: 140 } } },
      { type: "delete-object", objectId: "object-equation-chain" },
    ];
    expect(validateOperations(project, SHOT, transaction)).toMatchObject({ valid: false });
    expect(project.shots[0].objects[0].transform.x).toBe(originalX);
    expect(project.shots[0].objects.some(({ id }) => id === "object-equation-chain")).toBe(true);
  });

  test("rejects invalid animation-property patches before commit and after type-aware merge", () => {
    const project = createCantorDemoProject();

    expect(validateOperations(project, SHOT, [{
      type: "update-animation",
      animationId: "animation-camera-focus",
      patch: { properties: { zoom: 0 } },
    }])).toMatchObject({ valid: false });
    expect(validateOperations(project, SHOT, [{
      type: "update-animation",
      animationId: "animation-camera-focus",
      patch: { properties: { width: -20 } },
    }])).toMatchObject({ valid: false });
    expect(validateOperations(project, SHOT, [{
      type: "update-animation",
      animationId: "animation-camera-focus",
      patch: { properties: { unsupported: 1 } },
    }])).toMatchObject({ valid: false });

    // Zoom is a supported bounded patch key, but remains invalid when merged
    // into a non-camera animation.
    expect(validateOperations(project, SHOT, [{
      type: "update-animation",
      animationId: "animation-title-write",
      patch: { properties: { zoom: 2 } },
    }])).toMatchObject({ valid: false });

    const updated = applyOperations(project, SHOT, [{
      type: "update-animation",
      animationId: "animation-camera-focus",
      patch: { properties: { zoom: 2 } },
    }]).project;
    expect(updated.shots[0].animations.find(({ id }) => id === "animation-camera-focus")?.properties.zoom).toBe(2);
  });

  test("loads legacy V2 easing and permits an easing-only repair through locked targets", () => {
    const legacy = cloneSerializable(createCantorDemoProject());
    const shot = legacy.shots.find(({ id }) => id === SHOT)!;
    const emphasis = shot.animations.find(({ id }) => id === "animation-limit-emphasis")!;
    emphasis.easing = "editorial";
    const valid = ProjectDocumentSchema.parse(legacy);
    expect(effectiveLockOwner(valid.shots[0], "object-equation-limit")?.id).toBe("object-equation-limit");

    const repair: SceneOperation = {
      type: "update-animation",
      animationId: emphasis.id,
      patch: { easing: "there-and-back" },
    };
    expect(validateOperations(valid, SHOT, [repair])).toMatchObject({ valid: true });
    const repaired = applyOperations(valid, SHOT, [repair]).project;
    expect(repaired.shots[0].animations.find(({ id }) => id === emphasis.id)?.easing).toBe("there-and-back");
    expect(() => applyOperations(valid, SHOT, [{
      type: "update-animation",
      animationId: emphasis.id,
      patch: { duration: 1 },
    }])).toThrow(/read-only except for its exact easing repair/);

    const unrelated = applyOperations(valid, SHOT, [{
      type: "update-object",
      objectId: "object-title",
      patch: { name: "Unrelated V2 edit" },
    }]).project;
    expect(unrelated.shots[0].objects.find(({ id }) => id === "object-title")?.name).toBe("Unrelated V2 edit");

    const unsafeEntrance = cloneSerializable(valid);
    const write = unsafeEntrance.shots[0].animations.find(({ id }) => id === "animation-equation-write")!;
    write.easing = "there-and-back";
    const unsafeValid = ProjectDocumentSchema.parse(unsafeEntrance);
    expect(validateOperations(unsafeValid, SHOT, [{
      type: "update-animation",
      animationId: write.id,
      patch: { easing: "editorial" },
    }])).toMatchObject({ valid: true });

    const unlockedLegacy = cloneSerializable(valid);
    unlockedLegacy.shots[0].objects.find(({ id }) => id === "object-equation-limit")!.locked = false;
    unlockedLegacy.shots[0].objects.find(({ id }) => id === "object-equation-chain")!.locked = false;
    expect(validateOperations(unlockedLegacy, SHOT, [{
      type: "update-animation",
      animationId: emphasis.id,
      patch: { duration: 0.9 },
    }])).toMatchObject({ valid: false, error: expect.objectContaining({ message: expect.stringContaining("exact easing repair") }) });

    expect(validateOperations(createCantorDemoProject(), SHOT, [{
      type: "update-animation",
      animationId: "animation-title-write",
      patch: { easing: "there-and-back" },
    }])).toMatchObject({ valid: false, error: expect.objectContaining({ message: expect.stringContaining("cannot use there-and-back") }) });
  });

  test("canonicalizes add and combined update animation timing from the same absolute endpoints", () => {
    const base = cloneSerializable(createCantorDemoProject());
    const shot = base.shots.find(({ id }) => id === SHOT)!;
    shot.animations = [];
    const rawTiming = { start: 1 / 30, duration: 1 / 30 };
    const rawAnimation: SceneAnimation = {
      id: "animation-tick-add",
      type: "move",
      targetIds: ["object-title"],
      ...rawTiming,
      easing: "linear",
      properties: { deltaX: 10 },
    };
    const added = applyOperations(ProjectDocumentSchema.parse(base), SHOT, [{ type: "add-animation", animation: rawAnimation }]).project;
    const addedTiming = added.shots[0].animations[0];
    expect(addedTiming).toEqual(expect.objectContaining({ start: 0.03333333, duration: 0.03333334 }));

    const updateBase = cloneSerializable(base);
    updateBase.shots[0].animations = [{ ...rawAnimation, id: "animation-tick-update", start: 0, duration: 0.1 }];
    const updated = applyOperations(ProjectDocumentSchema.parse(updateBase), SHOT, [{
      type: "update-animation",
      animationId: "animation-tick-update",
      patch: rawTiming,
    }]).project;
    expect(updated.shots[0].animations[0]).toEqual(expect.objectContaining({
      start: addedTiming.start,
      duration: addedTiming.duration,
    }));

    const durationOnly = applyOperations(updated, SHOT, [{
      type: "update-animation",
      animationId: "animation-tick-update",
      patch: { duration: 1 / 30 },
    }]).project.shots[0].animations[0];
    expect(durationOnly).toEqual(expect.objectContaining({ start: 0.03333333, duration: 0.03333333 }));
  });

  test("enforces transform and object-style numeric bounds at the operation seam", () => {
    const project = createCantorDemoProject();
    expect(validateOperations(project, SHOT, [{
      type: "update-object",
      objectId: "object-title",
      patch: { transform: { x: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude + 1 } },
    }])).toMatchObject({ valid: false });
    expect(validateOperations(project, SHOT, [{
      type: "update-object",
      objectId: "object-title",
      patch: { transform: { scaleX: 0 } },
    }])).toMatchObject({ valid: false });
    expect(validateOperations(project, SHOT, [{
      type: "update-object",
      objectId: "object-title",
      patch: { style: { fontSize: PROOFCANVAS_SCHEMA_LIMITS.fontSizeMax + 1 } },
    }])).toMatchObject({ valid: false });

    const updated = applyOperations(project, SHOT, [{
      type: "update-object",
      objectId: "object-title",
      patch: {
        transform: { x: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude },
        style: { fontSize: PROOFCANVAS_SCHEMA_LIMITS.fontSizeMax },
      },
    }]).project;
    expect(updated.shots[0].objects.find(({ id }) => id === "object-title")?.transform.x)
      .toBe(PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude);
  });

  test("groups, ungroups, aligns, distributes, reorders, locks, and unlocks real state", () => {
    const project = createCantorDemoProject();
    const titleBefore = { ...project.shots[0].objects.find(({ id }) => id === "object-title")!.transform };
    const grouped = applyOperations(project, SHOT, [{ type: "group-objects", objectIds: ["object-title", "object-subtitle"], group: groupObject() }]).project;
    expect(grouped.shots[0].objects.find(({ id }) => id === "object-title")?.parentId).toBe("group-heading");
    expect(grouped.shots[0].objects.find(({ id }) => id === "object-title")?.transform).toEqual(titleBefore);
    expect(grouped.shots[0].objects.slice(0, 3).map(({ id }) => id)).toEqual(["group-heading", "object-title", "object-subtitle"]);

    const groupedShot = grouped.shots[0];
    const groupedTransform = groupedShot.objects.find(({ id }) => id === "group-heading")!.transform;
    const groupedTitle = groupedShot.objects.find(({ id }) => id === "object-title")!;
    const expectedRatioX = 1000 / groupedTransform.width!;
    const expectedRatioY = 200 / groupedTransform.height!;
    const movedGroup = applyOperations(grouped, SHOT, [{ type: "update-object", objectId: "group-heading", patch: { transform: { x: 360, y: 140, width: 1000, height: 200, rotation: 90 } } }]).project;
    const movedTitle = movedGroup.shots[0].objects.find(({ id }) => id === "object-title")!;
    expect(movedTitle.transform.x).toBeCloseTo(360 - (groupedTitle.transform.y - groupedTransform.y) * expectedRatioY);
    expect(movedTitle.transform.y).toBeCloseTo(140 + (groupedTitle.transform.x - groupedTransform.x) * expectedRatioX);
    expect(movedTitle.transform.scaleX).toBeCloseTo(expectedRatioX);
    expect(movedTitle.transform.scaleY).toBeCloseTo(expectedRatioY);
    expect(movedTitle.transform.rotation).toBeCloseTo(90);

    const ungrouped = applyOperations(movedGroup, SHOT, [{ type: "ungroup-object", groupId: "group-heading" }]).project;
    expect(ungrouped.shots[0].objects.some(({ id }) => id === "group-heading")).toBe(false);
    expect(ungrouped.shots[0].objects.find(({ id }) => id === "object-title")?.parentId).toBeUndefined();

    const aligned = applyOperations(ungrouped, SHOT, [{ type: "align-objects", objectIds: ["object-title", "object-subtitle"], alignment: "left" }]).project;
    const [title, subtitle] = ["object-title", "object-subtitle"].map((id) => aligned.shots[0].objects.find((object) => object.id === id)!);
    const style = styleById(aligned.styles, aligned.activeStyleId)!;
    expect(renderedLeft(title, style)).toBeCloseTo(renderedLeft(subtitle, style));

    const distributed = applyOperations(aligned, SHOT, [{ type: "distribute-objects", objectIds: ["object-title", "object-subtitle", "object-margin-note"], axis: "horizontal" }]).project;
    const distributedStyle = styleById(distributed.styles, distributed.activeStyleId)!;
    const xs = ["object-title", "object-subtitle", "object-margin-note"].map((id) => styledTransform(distributed.shots[0].objects.find((object) => object.id === id)!, distributedStyle).x).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1]);

    const reordered = applyOperations(distributed, SHOT, [{ type: "reorder-object", objectId: "object-title", index: 2 }]).project;
    expect(reordered.shots[0].objects.filter(({ parentId }) => parentId === undefined)[2].id).toBe("object-title");
    const locked = applyOperations(reordered, SHOT, [{ type: "lock-object", objectId: "object-title" }]).project;
    expect(() => applyOperations(locked, SHOT, [{ type: "update-object", objectId: "object-title", patch: { name: "Changed" } }])).toThrow(/locked object/);
    expect(applyOperations(locked, SHOT, [{ type: "unlock-object", objectId: "object-title" }]).project.shots[0].objects.find(({ id }) => id === "object-title")?.locked).toBe(false);
  });

  test("aligns and distributes groups by their styled descendant frame", () => {
    const project = insertSemanticComponent(createCantorDemoProject(), SHOT, "mathematical-title", { x: 490, y: 275 });
    const groupId = "group-mathematical-title";
    const aligned = applyOperations(project, SHOT, [{ type: "align-objects", objectIds: [groupId, "object-title"], alignment: "right" }]).project;
    const alignedShot = aligned.shots[0];
    const style = styleById(aligned.styles, aligned.activeStyleId)!;
    const groupRight = styledDisplayBounds(alignedShot.objects.find(({ id }) => id === groupId)!, alignedShot, style).right;
    const titleRight = styledDisplayBounds(alignedShot.objects.find(({ id }) => id === "object-title")!, alignedShot, style).right;
    expect(groupRight).toBeCloseTo(titleRight);

    const distributed = applyOperations(aligned, SHOT, [{ type: "distribute-objects", objectIds: [groupId, "object-title", "object-margin-note"], axis: "horizontal" }]).project;
    const distributedShot = distributed.shots[0];
    const centers = [groupId, "object-title", "object-margin-note"]
      .map((id) => styledDisplayBounds(distributedShot.objects.find((object) => object.id === id)!, distributedShot, style).centerX)
      .sort((left, right) => left - right);
    expect(centers[1] - centers[0]).toBeCloseTo(centers[2] - centers[1]);
  });

  test("reorders a group and its descendants as one visual layer block", () => {
    const project = createCantorDemoProject();
    const before = project.shots[0].objects.filter(({ type }) => type !== "group").map(({ id }) => id);
    const rootCount = project.shots[0].objects.filter(({ parentId }) => parentId === undefined).length;
    const moved = applyOperations(project, SHOT, [{ type: "reorder-object", objectId: "object-interval-diagram", index: rootCount - 1 }]).project.shots[0];
    const family = new Set(["object-interval-diagram", ...project.shots[0].objects.filter(({ parentId }) => parentId === "object-interval-diagram").map(({ id }) => id)]);
    const familyIndexes = moved.objects.flatMap(({ id }, index) => family.has(id) ? [index] : []);
    const after = moved.objects.filter(({ type }) => type !== "group").map(({ id }) => id);

    expect(familyIndexes).toEqual(Array.from({ length: familyIndexes.length }, (_, index) => familyIndexes[0] + index));
    expect(after).not.toEqual(before);
    expect(after.indexOf("object-interval-generation-0")).toBeGreaterThan(after.indexOf("object-equation-limit"));
  });

  test("reorders a child only among siblings and keeps the hierarchy contiguous", () => {
    const project = createCantorDemoProject();
    const shot = project.shots[0];
    const groupId = "object-interval-diagram";
    const childId = "object-interval-generation-0";
    const siblingCount = shot.objects.filter(({ parentId }) => parentId === groupId).length;
    const moved = applyOperations(project, SHOT, [{ type: "reorder-object", objectId: childId, index: siblingCount - 1 }]).project.shots[0];
    const groupIndex = moved.objects.findIndex(({ id }) => id === groupId);
    const nextRootIndex = moved.objects.findIndex(({ id }) => id === "object-equation-chain");

    expect(moved.objects.filter(({ parentId }) => parentId === groupId).at(-1)?.id).toBe(childId);
    expect(moved.objects.findIndex(({ id }) => id === childId)).toBe(nextRootIndex - 1);
    expect(moved.objects.slice(groupIndex + 1, nextRootIndex).every(({ parentId }) => parentId === groupId)).toBe(true);
  });

  test("refreshes ancestor group geometry after a child transform", () => {
    const project = createCantorDemoProject();
    const before = project.shots[0].objects.find(({ id }) => id === "object-interval-diagram")!.transform;
    const updated = applyOperations(project, SHOT, [{ type: "update-object", objectId: "object-interval-generation-0", patch: { transform: { x: 80 } } }]).project.shots[0];
    const group = updated.objects.find(({ id }) => id === "object-interval-diagram")!;
    const child = updated.objects.find(({ id }) => id === "object-interval-generation-0")!;

    expect(group.transform.x).not.toBe(before.x);
    expect(group.transform.x - group.transform.width! / 2).toBeLessThanOrEqual(child.transform.x - child.transform.width! / 2);
    expect(group.transform.x + group.transform.width! / 2).toBeGreaterThanOrEqual(child.transform.x + child.transform.width! / 2);
  });

  test("rejects ancestor and descendant IDs in one multi-object operation", () => {
    const project = createCantorDemoProject();
    const hierarchy = ["object-interval-diagram", "object-interval-generation-0"];
    expect(validateOperations(project, SHOT, [{ type: "align-objects", objectIds: hierarchy, alignment: "left" }])).toMatchObject({ valid: false });
    expect(validateOperations(project, SHOT, [{ type: "distribute-objects", objectIds: [...hierarchy, "object-title"], axis: "horizontal" }])).toMatchObject({ valid: false });
    expect(validateOperations(project, SHOT, [{ type: "group-objects", objectIds: hierarchy, group: groupObject() }])).toMatchObject({ valid: false });
    expect(() => duplicateObjects(project, SHOT, hierarchy)).toThrow(/ancestor .* descendant/);
  });

  test("switches output style without rewriting authored animation state", () => {
    const project = createCantorDemoProject();
    const raw = applyOperations(project, SHOT, [{ type: "set-style", styleId: "style-raw-manim" }]).project;
    expect(raw.activeStyleId).toBe("style-raw-manim");
    expect(raw.shots.map(({ animations }) => animations)).toEqual(project.shots.map(({ animations }) => animations));

    const editorial = applyOperations(raw, SHOT, [{ type: "set-style", styleId: "style-editorial-ink" }]).project;
    expect(editorial.shots.map(({ animations }) => animations)).toEqual(project.shots.map(({ animations }) => animations));
  });

  test("deletion removes descendants and safely repairs dependent animation targets", () => {
    const project = createCantorDemoProject();
    const result = applyOperations(project, SHOT, [{ type: "delete-object", objectId: "object-interval-left-1" }]).project;
    expect(result.shots[0].objects.some(({ id }) => id === "object-interval-left-1")).toBe(false);
    const split = result.shots[0].animations.find(({ id }) => id === "animation-first-split")!;
    expect(split.targetIds).toEqual(["object-interval-right-1"]);

    const unlockedGroup = applyOperations(project, SHOT, [{ type: "unlock-object", objectId: "object-equation-chain" }]).project;
    const unlockedLength = applyOperations(unlockedGroup, SHOT, [{ type: "unlock-object", objectId: "object-equation-length" }]).project;
    const unlocked = applyOperations(unlockedLength, SHOT, [{ type: "unlock-object", objectId: "object-equation-limit" }]).project;
    const deletedGroup = applyOperations(unlocked, SHOT, [{ type: "delete-object", objectId: "object-equation-chain" }]).project;
    expect(deletedGroup.shots[0].objects.some(({ parentId }) => parentId === "object-equation-chain")).toBe(false);
    expect(deletedGroup.shots[0].animations.some(({ targetIds }) => targetIds.includes("object-equation-chain"))).toBe(false);
  });

  test("duplicates with fresh stable IDs", () => {
    const project = createCantorDemoProject();
    const result = duplicateObjects(project, SHOT, ["object-title"]);
    const copy = result.project.shots[0].objects.find(({ name }) => name === "Uncountable, Yet Zero Length copy");
    expect(copy?.id).toBe("object-uncountable-yet-zero-length");
    expect(copy?.transform.x).toBe(project.shots[0].objects[0].transform.x + 24);

    const groupCopy = duplicateObjects(project, SHOT, ["object-interval-diagram"]).project.shots[0];
    const copiedGroup = groupCopy.objects.find(({ name }) => name === "Cantor interval diagram copy")!;
    const copiedChildren = groupCopy.objects.filter(({ parentId }) => parentId === copiedGroup.id);
    expect(copiedChildren).toHaveLength(project.shots[0].objects.filter(({ parentId }) => parentId === "object-interval-diagram").length);
    expect(new Set(groupCopy.objects.map(({ id }) => id)).size).toBe(groupCopy.objects.length);
  });

  test("inherits locks from ancestors and rejects unlock-then-mutate bypasses", () => {
    const project = createCantorDemoProject();
    const locked = applyOperations(project, SHOT, [{ type: "lock-object", objectId: "object-interval-diagram" }]).project;
    const shot = locked.shots[0];
    expect(effectiveLockOwner(shot, "object-interval-left-1")?.id).toBe("object-interval-diagram");
    expect(() => applyOperations(locked, SHOT, [{ type: "update-object", objectId: "object-interval-left-1", patch: { transform: { x: 10 } } }])).toThrow(/locked object/);
    expect(() => duplicateObjects(locked, SHOT, ["object-interval-left-1"])).toThrow(/locked object/);
    expect(() => applyOperations(locked, SHOT, [
      { type: "unlock-object", objectId: "object-interval-diagram" },
      { type: "update-object", objectId: "object-interval-left-1", patch: { transform: { x: 10 } } },
    ])).toThrow(/standalone transaction/);
    const unlocked = applyOperations(locked, SHOT, [{ type: "unlock-object", objectId: "object-interval-diagram" }]).project;
    expect(() => applyOperations(unlocked, SHOT, [{ type: "update-object", objectId: "object-interval-left-1", patch: { transform: { x: 10 } } }])).not.toThrow();

    const lockedChild = applyOperations(project, SHOT, [{ type: "lock-object", objectId: "object-interval-left-1" }]).project;
    expect(() => applyOperations(lockedChild, SHOT, [{ type: "update-object", objectId: "object-interval-diagram", patch: { visible: false } }])).toThrow(/locked object/);
  });
});

describe("snapshot history", () => {
  test("clones only newly accepted caller documents and reuses immutable archived snapshots", () => {
    const callerInitial = createCantorDemoProject();
    const h0 = createHistory(callerInitial);
    const initialSnapshot = h0.present;
    callerInitial.metadata.title = "caller mutated initial";
    expect(h0.present.metadata.title).not.toBe("caller mutated initial");

    const callerNext = cloneProject(h0.present);
    callerNext.metadata.title = "First title";
    const h1 = commitProject(h0, callerNext, "First rename");
    expect(h1.past[0].project).toBe(initialSnapshot);
    callerNext.metadata.title = "caller mutated commit";
    expect(h1.present.metadata.title).toBe("First title");

    const firstEntry = h1.past[0];
    const callerSecond = cloneProject(h1.present);
    callerSecond.metadata.title = "Second title";
    const h2 = commitProject(h1, callerSecond, "Second rename");
    expect(h2.past[0]).toBe(firstEntry);
    expect(h2.past[1].project).toBe(h1.present);

    const undone = undo(h2);
    expect(undone.present).toBe(h1.present);
    expect(undone.past[0]).toBe(firstEntry);
    expect(undone.future[0].project).toBe(h2.present);
    expect(undone.future[0].label).toBe("Second rename");

    const redone = redo(undone);
    expect(redone.present).toBe(h2.present);
    expect(redone.past[0]).toBe(firstEntry);
    expect(redone.present.metadata.title).toBe("Second title");
  });

  test("does not create undo entries for canonically identical documents or operations", () => {
    const project = createCantorDemoProject();
    const history = createHistory(project);
    expect(commitProject(history, cloneProject(project), "Unchanged field blur")).toBe(history);
    expect(commitOperations(history, SHOT, [
      { type: "update-object", objectId: "object-title", patch: { name: "Uncountable, Yet Zero Length" } },
    ], "Unchanged object name")).toBe(history);
  });

  test("commits a multi-operation transaction as one undoable snapshot without ID drift", () => {
    const project = createCantorDemoProject();
    const history = createHistory(project);
    const committed = commitOperations(history, SHOT, [
      { type: "update-object", objectId: "object-title", patch: { transform: { x: 150 } } },
      { type: "update-object", objectId: "object-subtitle", patch: { style: { opacity: 0.5 } } },
    ], "AI: editorial heading");
    expect(canUndo(committed)).toBe(true);
    expect(committed.past).toHaveLength(1);
    const undone = undo(committed);
    expect(undone.present).toEqual(project);
    expect(canRedo(undone)).toBe(true);
    const redone = redo(undone);
    expect(redone.present.shots[0].objects.map(({ id }) => id)).toEqual(committed.present.shots[0].objects.map(({ id }) => id));
    expect(redone.present.shots[0].objects.find(({ id }) => id === "object-title")?.transform.x).toBe(150);
  });
});
