import { allocateId, collectProjectIds } from "./ids";
import { z } from "zod";
import {
  ProjectDocumentSchema,
  SceneAnimationSchema,
  SceneOperationSchema,
  animationAuthoringCompatibilityIssue,
  cloneSerializable,
  type ProjectDocument,
  type PropertyKeyframe,
  type PropertyTrack,
  type SceneAnimation,
  type SceneObject,
  type SceneOperation,
  type Shot,
} from "./schema";
import { styleById, styledDisplayBounds, styledTransform } from "./styles";
import { compareTimelineTimes } from "./frame";

export const ManualSceneOperationSchema = z.union([
  SceneOperationSchema,
  z.object({
    type: z.literal("clear-object-lifetime"),
    objectId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/i).max(96),
  }).strict(),
]);

export type ManualSceneOperation = z.infer<typeof ManualSceneOperationSchema>;

export class OperationValidationError extends Error {
  constructor(message: string, readonly operationIndex?: number) {
    super(operationIndex === undefined ? message : `Operation ${operationIndex + 1}: ${message}`);
    this.name = "OperationValidationError";
  }
}

export interface OperationResult {
  project: ProjectDocument;
  applied: number;
  summary: string[];
}

export type OperationValidationResult =
  | { valid: true; project: ProjectDocument }
  | { valid: false; error: OperationValidationError };

function shotById(project: ProjectDocument, shotId: string): Shot {
  const shot = project.shots.find(({ id }) => id === shotId);
  if (!shot) throw new OperationValidationError(`Shot not found: ${shotId}`);
  return shot;
}

function objectById(shot: Shot, objectId: string): SceneObject {
  const object = shot.objects.find(({ id }) => id === objectId);
  if (!object) throw new OperationValidationError(`Object not found: ${objectId}`);
  return object;
}

function animationById(shot: Shot, animationId: string): SceneAnimation {
  const animation = shot.animations.find(({ id }) => id === animationId);
  if (!animation) throw new OperationValidationError(`Animation not found: ${animationId}`);
  return animation;
}

function propertyTrackById(shot: Shot, trackId: string): PropertyTrack {
  const track = shot.propertyTracks.find(({ id }) => id === trackId);
  if (!track) throw new OperationValidationError(`Property track not found: ${trackId}`);
  return track;
}

function keyframeById(track: PropertyTrack, keyframeId: string): PropertyKeyframe {
  const keyframe = track.keyframes.find(({ id }) => id === keyframeId);
  if (!keyframe) throw new OperationValidationError(`Keyframe not found: ${keyframeId}`);
  return keyframe;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new OperationValidationError(`${label} contains duplicate IDs`);
}

/** Returns the object that makes an object effectively locked, including itself. */
export function effectiveLockOwner(shot: Shot, objectOrId: SceneObject | string): SceneObject | undefined {
  let cursor = typeof objectOrId === "string" ? shot.objects.find(({ id }) => id === objectOrId) : objectOrId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    if (cursor.locked) return cursor;
    visited.add(cursor.id);
    cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined;
  }
  return undefined;
}

/** Returns the object that makes an object effectively hidden, including itself. */
export function effectiveVisibilityOwner(shot: Shot, objectOrId: SceneObject | string): SceneObject | undefined {
  let cursor = typeof objectOrId === "string" ? shot.objects.find(({ id }) => id === objectOrId) : objectOrId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    if (!cursor.visible) return cursor;
    visited.add(cursor.id);
    cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined;
  }
  return undefined;
}

function requireUnlocked(shot: Shot, objects: readonly SceneObject[], action: string): void {
  const locked = objects.filter((object) => effectiveLockOwner(shot, object)).map(({ id }) => id);
  if (locked.length) throw new OperationValidationError(`${action} targets locked object${locked.length === 1 ? "" : "s"}: ${locked.join(", ")}`);
}

function requireTrackUnlocked(shot: Shot, track: PropertyTrack, action: string): void {
  if (track.target.kind === "object") {
    requireUnlocked(shot, mutationFamily(shot, [objectById(shot, track.target.objectId)]), action);
  }
}

function sortKeyframes(track: PropertyTrack): void {
  track.keyframes.sort((left, right) => compareTimelineTimes(left.time, right.time) || left.id.localeCompare(right.id));
}

function requireIndependentHierarchy(shot: Shot, objects: readonly SceneObject[], action: string): void {
  const selected = new Set(objects.map(({ id }) => id));
  for (const object of objects) {
    let cursor = object.parentId ? shot.objects.find(({ id }) => id === object.parentId) : undefined;
    while (cursor) {
      if (selected.has(cursor.id)) {
        throw new OperationValidationError(`${action} cannot target both ancestor ${cursor.id} and descendant ${object.id}`);
      }
      cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined;
    }
  }
}

function descendantsOf(shot: Shot, objectId: string): SceneObject[] {
  const descendants: SceneObject[] = [];
  const queue = [objectId];
  while (queue.length) {
    const parentId = queue.shift()!;
    const children = shot.objects.filter((object) => object.parentId === parentId);
    descendants.push(...children);
    queue.push(...children.map(({ id }) => id));
  }
  return descendants;
}

function hierarchyDepth(shot: Shot, object: SceneObject): number {
  let depth = 0;
  let cursor = object.parentId ? shot.objects.find(({ id }) => id === object.parentId) : undefined;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    depth += 1;
    cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined;
  }
  return depth;
}

function normalizeHierarchyOrder(shot: Shot, siblingOverride?: { parentId?: string; ids: readonly string[] }): void {
  const childrenByParent = new Map<string | undefined, SceneObject[]>();
  for (const object of shot.objects) {
    const children = childrenByParent.get(object.parentId) ?? [];
    children.push(object);
    childrenByParent.set(object.parentId, children);
  }
  if (siblingOverride) {
    const siblings = childrenByParent.get(siblingOverride.parentId) ?? [];
    const byId = new Map(siblings.map((object) => [object.id, object]));
    if (siblingOverride.ids.length !== siblings.length || siblingOverride.ids.some((id) => !byId.has(id))) {
      throw new OperationValidationError("Layer reorder must preserve the complete sibling set");
    }
    childrenByParent.set(siblingOverride.parentId, siblingOverride.ids.map((id) => byId.get(id)!));
  }
  const ordered: SceneObject[] = [];
  const visited = new Set<string>();
  const visit = (object: SceneObject) => {
    if (visited.has(object.id)) throw new OperationValidationError(`Layer hierarchy contains a cycle at ${object.id}`);
    visited.add(object.id);
    ordered.push(object);
    for (const child of childrenByParent.get(object.id) ?? []) visit(child);
  };
  for (const root of childrenByParent.get(undefined) ?? []) visit(root);
  if (ordered.length !== shot.objects.length) throw new OperationValidationError("Layer hierarchy contains an unreachable object");
  shot.objects = ordered;
}

function mutationFamily(shot: Shot, objects: readonly SceneObject[]): SceneObject[] {
  const ids = new Set<string>();
  const result: SceneObject[] = [];
  for (const object of objects) {
    for (const member of object.type === "group" ? [object, ...descendantsOf(shot, object.id)] : [object]) {
      if (!ids.has(member.id)) {
        ids.add(member.id);
        result.push(member);
      }
    }
  }
  return result;
}

function removeAnimationTargets(shot: Shot, removed: ReadonlySet<string>): void {
  shot.animations = shot.animations.flatMap((animation) => {
    const targetIds = animation.targetIds.filter((id) => !removed.has(id));
    return targetIds.length ? [{ ...animation, targetIds }] : [];
  });
  shot.propertyTracks = shot.propertyTracks.filter((track) => track.target.kind !== "object" || !removed.has(track.target.objectId));
}

function mergeObjectPatch(object: SceneObject, patch: Extract<SceneOperation, { type: "update-object" }>["patch"]): SceneObject {
  const next: SceneObject = {
    ...object,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
    ...(patch.transform ? { transform: { ...object.transform, ...patch.transform } } : {}),
    ...(patch.style ? { style: { ...object.style, ...patch.style } } : {}),
    ...(patch.properties ? { properties: { ...object.properties, ...patch.properties } } : {}),
  };
  if (patch.parentId === null) delete next.parentId;
  else if (patch.parentId !== undefined) next.parentId = patch.parentId;
  if (patch.semanticRole === null) delete next.semanticRole;
  else if (patch.semanticRole !== undefined) next.semanticRole = patch.semanticRole;
  return next;
}

function bakeGroupTransform(shot: Shot, group: SceneObject, nextTransform: SceneObject["transform"]): void {
  const old = group.transform;
  const oldWidth = old.width ?? 1;
  const oldHeight = old.height ?? 1;
  const nextWidth = nextTransform.width ?? 1;
  const nextHeight = nextTransform.height ?? 1;
  const ratioX = (nextWidth * nextTransform.scaleX) / (oldWidth * old.scaleX);
  const ratioY = (nextHeight * nextTransform.scaleY) / (oldHeight * old.scaleY);
  const oldRadians = old.rotation * Math.PI / 180;
  const nextRadians = nextTransform.rotation * Math.PI / 180;
  const cosOld = Math.cos(-oldRadians);
  const sinOld = Math.sin(-oldRadians);
  const cosNext = Math.cos(nextRadians);
  const sinNext = Math.sin(nextRadians);
  const descendantIds = new Set(descendantsOf(shot, group.id).map(({ id }) => id));
  shot.objects = shot.objects.map((object) => {
    if (!descendantIds.has(object.id)) return object;
    const relativeX = object.transform.x - old.x;
    const relativeY = object.transform.y - old.y;
    const localX = relativeX * cosOld - relativeY * sinOld;
    const localY = relativeX * sinOld + relativeY * cosOld;
    const scaledX = localX * ratioX;
    const scaledY = localY * ratioY;
    return {
      ...object,
      transform: {
        ...object.transform,
        x: nextTransform.x + scaledX * cosNext - scaledY * sinNext,
        y: nextTransform.y + scaledX * sinNext + scaledY * cosNext,
        rotation: object.transform.rotation + nextTransform.rotation - old.rotation,
        scaleX: object.transform.scaleX * ratioX,
        scaleY: object.transform.scaleY * ratioY,
      },
    };
  });
}

function transformedCorners(object: SceneObject): Array<{ x: number; y: number }> {
  const halfWidth = (object.transform.width ?? 60) * Math.abs(object.transform.scaleX) / 2;
  const halfHeight = (object.transform.height ?? 30) * Math.abs(object.transform.scaleY) / 2;
  const radians = object.transform.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]].map(([x, y]) => ({
    x: object.transform.x + x * cos - y * sin,
    y: object.transform.y + x * sin + y * cos,
  }));
}

function refreshGroupBounds(shot: Shot, affectedObjectIds: readonly string[]): void {
  const affectedGroupIds = new Set<string>();
  for (const objectId of affectedObjectIds) {
    let cursor = shot.objects.find(({ id }) => id === objectId);
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.type === "group") affectedGroupIds.add(cursor.id);
      cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined;
    }
  }
  const groups = shot.objects.filter(({ type, id }) => type === "group" && affectedGroupIds.has(id)).sort((left, right) => hierarchyDepth(shot, right) - hierarchyDepth(shot, left));
  for (const group of groups) {
    const leaves = descendantsOf(shot, group.id).filter(({ type }) => type !== "group");
    if (!leaves.length) continue;
    const radians = group.transform.rotation * Math.PI / 180;
    const ux = Math.cos(radians);
    const uy = Math.sin(radians);
    const vx = -uy;
    const vy = ux;
    const points = leaves.flatMap(transformedCorners);
    const uValues = points.map(({ x, y }) => x * ux + y * uy);
    const vValues = points.map(({ x, y }) => x * vx + y * vy);
    const minU = Math.min(...uValues);
    const maxU = Math.max(...uValues);
    const minV = Math.min(...vValues);
    const maxV = Math.max(...vValues);
    const centerU = (minU + maxU) / 2;
    const centerV = (minV + maxV) / 2;
    group.transform = {
      ...group.transform,
      x: centerU * ux + centerV * vx,
      y: centerU * uy + centerV * vy,
      width: Math.max(1, (maxU - minU) / Math.max(0.01, Math.abs(group.transform.scaleX))),
      height: Math.max(1, (maxV - minV) / Math.max(0.01, Math.abs(group.transform.scaleY))),
    };
  }
}

function replaceObjectTransform(shot: Shot, object: SceneObject, transform: SceneObject["transform"]): void {
  if (object.type === "group") bakeGroupTransform(shot, object, transform);
  const index = shot.objects.findIndex(({ id }) => id === object.id);
  shot.objects[index] = { ...shot.objects[index], transform };
}

function rawTranslationForStyledDelta(object: SceneObject, style: ProjectDocument["styles"][number], axis: "x" | "y", delta: number): number {
  const before = styledTransform(object, style)[axis];
  const shifted = {
    ...object,
    transform: { ...object.transform, [axis]: object.transform[axis] + 1 },
  };
  const slope = styledTransform(shifted, style)[axis] - before;
  if (!Number.isFinite(slope) || Math.abs(slope) < 0.000_001) {
    throw new OperationValidationError(`${style.name} does not permit direct ${axis.toUpperCase()} placement for ${object.name}`);
  }
  return delta / slope;
}

function applyOne(project: ProjectDocument, shotId: string, operation: ManualSceneOperation): string {
  const shot = shotById(project, shotId);
  const projectIds = collectProjectIds(project);
  const activeStyle = styleById(project.styles, project.activeStyleId) ?? project.styles[0];
  switch (operation.type) {
    case "add-object": {
      if (projectIds.has(operation.object.id)) throw new OperationValidationError(`ID already exists: ${operation.object.id}`);
      if (operation.object.parentId) {
        const parent = objectById(shot, operation.object.parentId);
        if (parent.type !== "group") throw new OperationValidationError("New object parent must be a group");
        requireUnlocked(shot, [parent], "Add object");
      }
      shot.objects.push(cloneSerializable(operation.object));
      normalizeHierarchyOrder(shot);
      refreshGroupBounds(shot, [operation.object.id]);
      return `Added ${operation.object.name}`;
    }
    case "update-object": {
      const object = objectById(shot, operation.objectId);
      const previousParentId = object.parentId;
      const affectsDescendants = object.type === "group" && (
        operation.patch.transform !== undefined
        || operation.patch.visible !== undefined
        || operation.patch.parentId !== undefined
      );
      requireUnlocked(shot, affectsDescendants ? mutationFamily(shot, [object]) : [object], "Update");
      if (operation.patch.parentId) {
        const parent = objectById(shot, operation.patch.parentId);
        if (parent.type !== "group") throw new OperationValidationError("Object parent must be a group");
        requireUnlocked(shot, [parent], "Reparent");
      }
      const nextObject = mergeObjectPatch(object, operation.patch);
      if (object.type === "group" && operation.patch.transform) bakeGroupTransform(shot, object, nextObject.transform);
      const index = shot.objects.findIndex(({ id }) => id === object.id);
      shot.objects[index] = nextObject;
      if (operation.patch.parentId !== undefined) normalizeHierarchyOrder(shot);
      if (operation.patch.transform !== undefined || operation.patch.parentId !== undefined) {
        refreshGroupBounds(shot, [object.id, ...(previousParentId ? [previousParentId] : [])]);
      }
      return `Updated ${object.name}`;
    }
    case "delete-object": {
      const object = objectById(shot, operation.objectId);
      const previousParentId = object.parentId;
      const removal = [object, ...descendantsOf(shot, object.id)];
      requireUnlocked(shot, removal, "Delete");
      const ids = new Set(removal.map(({ id }) => id));
      shot.objects = shot.objects.filter(({ id }) => !ids.has(id));
      removeAnimationTargets(shot, ids);
      normalizeHierarchyOrder(shot);
      if (previousParentId) refreshGroupBounds(shot, [previousParentId]);
      return `Deleted ${object.name}`;
    }
    case "group-objects": {
      requireUnique(operation.objectIds, "Group selection");
      if (operation.group.type !== "group") throw new OperationValidationError("Group operation requires a group object");
      if (projectIds.has(operation.group.id)) throw new OperationValidationError(`ID already exists: ${operation.group.id}`);
      const objects = operation.objectIds.map((id) => objectById(shot, id));
      const previousParentIds = objects.flatMap(({ parentId }) => parentId ? [parentId] : []);
      requireIndependentHierarchy(shot, objects, "Group");
      requireUnlocked(shot, mutationFamily(shot, objects), "Group");
      if (objects.some(({ id }) => id === operation.group.parentId)) throw new OperationValidationError("Group cannot be parented to a selected child");
      if (operation.group.parentId) {
        const parent = objectById(shot, operation.group.parentId);
        if (parent.type !== "group") throw new OperationValidationError("Group parent must be a group");
        requireUnlocked(shot, [parent], "Group");
      }
      const selected = new Set(operation.objectIds);
      const familyIds = new Set(mutationFamily(shot, objects).map(({ id }) => id));
      const firstFamilyIndex = shot.objects.findIndex(({ id }) => familyIds.has(id));
      const insertionIndex = shot.objects.slice(0, firstFamilyIndex).filter(({ id }) => !familyIds.has(id)).length;
      const family = shot.objects
        .filter(({ id }) => familyIds.has(id))
        .map((object) => selected.has(object.id) ? { ...object, parentId: operation.group.id } : object);
      const remaining = shot.objects.filter(({ id }) => !familyIds.has(id));
      shot.objects = [
        ...remaining.slice(0, insertionIndex),
        cloneSerializable(operation.group),
        ...family,
        ...remaining.slice(insertionIndex),
      ];
      normalizeHierarchyOrder(shot);
      refreshGroupBounds(shot, [operation.group.id, ...previousParentIds]);
      return `Grouped ${objects.length} objects`;
    }
    case "ungroup-object": {
      const group = objectById(shot, operation.groupId);
      if (group.type !== "group") throw new OperationValidationError(`${group.id} is not a group`);
      const children = shot.objects.filter(({ parentId }) => parentId === group.id);
      requireUnlocked(shot, mutationFamily(shot, [group]), "Ungroup");
      shot.objects = shot.objects.flatMap((object) => {
        if (object.id === group.id) return [];
        if (object.parentId !== group.id) return [object];
        const child = { ...object };
        if (group.parentId) child.parentId = group.parentId;
        else delete child.parentId;
        return [child];
      });
      removeAnimationTargets(shot, new Set([group.id]));
      normalizeHierarchyOrder(shot);
      if (group.parentId) refreshGroupBounds(shot, [group.parentId]);
      return `Ungrouped ${group.name}`;
    }
    case "align-objects": {
      requireUnique(operation.objectIds, "Alignment selection");
      const objects = operation.objectIds.map((id) => objectById(shot, id));
      requireIndependentHierarchy(shot, objects, "Align");
      requireUnlocked(shot, mutationFamily(shot, objects), "Align");
      const allBounds = objects.map((object) => styledDisplayBounds(object, shot, activeStyle));
      const target = operation.alignment === "left" ? Math.min(...allBounds.map(({ left }) => left))
        : operation.alignment === "right" ? Math.max(...allBounds.map(({ right }) => right))
        : operation.alignment === "top" ? Math.min(...allBounds.map(({ top }) => top))
        : operation.alignment === "bottom" ? Math.max(...allBounds.map(({ bottom }) => bottom))
        : operation.alignment === "center-x" ? allBounds.reduce((sum, item) => sum + item.centerX, 0) / allBounds.length
        : allBounds.reduce((sum, item) => sum + item.centerY, 0) / allBounds.length;
      for (const object of objects) {
        const box = styledDisplayBounds(object, shot, activeStyle);
        const transform = { ...object.transform };
        if (operation.alignment === "left") transform.x += rawTranslationForStyledDelta(object, activeStyle, "x", target - box.left);
        else if (operation.alignment === "right") transform.x += rawTranslationForStyledDelta(object, activeStyle, "x", target - box.right);
        else if (operation.alignment === "center-x") transform.x += rawTranslationForStyledDelta(object, activeStyle, "x", target - box.centerX);
        else if (operation.alignment === "top") transform.y += rawTranslationForStyledDelta(object, activeStyle, "y", target - box.top);
        else if (operation.alignment === "bottom") transform.y += rawTranslationForStyledDelta(object, activeStyle, "y", target - box.bottom);
        else transform.y += rawTranslationForStyledDelta(object, activeStyle, "y", target - box.centerY);
        replaceObjectTransform(shot, object, transform);
      }
      refreshGroupBounds(shot, objects.map(({ id }) => id));
      return `Aligned ${objects.length} objects ${operation.alignment}`;
    }
    case "distribute-objects": {
      requireUnique(operation.objectIds, "Distribution selection");
      const objects = operation.objectIds.map((id) => objectById(shot, id));
      requireIndependentHierarchy(shot, objects, "Distribute");
      requireUnlocked(shot, mutationFamily(shot, objects), "Distribute");
      const coordinate = operation.axis === "horizontal" ? "x" : "y";
      const styledCoordinate = (object: SceneObject) => {
        const box = styledDisplayBounds(object, shot, activeStyle);
        return coordinate === "x" ? box.centerX : box.centerY;
      };
      const sorted = [...objects].sort((a, b) => styledCoordinate(a) - styledCoordinate(b) || a.id.localeCompare(b.id));
      const first = styledCoordinate(sorted[0]);
      const last = styledCoordinate(sorted.at(-1)!);
      const step = (last - first) / (sorted.length - 1);
      const positions = new Map(sorted.map((object, index) => [object.id, first + index * step]));
      for (const object of objects) {
        const delta = positions.get(object.id)! - styledCoordinate(object);
        replaceObjectTransform(shot, object, { ...object.transform, [coordinate]: object.transform[coordinate] + rawTranslationForStyledDelta(object, activeStyle, coordinate, delta) });
      }
      refreshGroupBounds(shot, objects.map(({ id }) => id));
      return `Distributed ${objects.length} objects ${operation.axis}ly`;
    }
    case "reorder-object": {
      const object = objectById(shot, operation.objectId);
      const family = object.type === "group" ? mutationFamily(shot, [object]) : [object];
      requireUnlocked(shot, family, "Reorder");
      const siblings = shot.objects.filter(({ parentId }) => parentId === object.parentId);
      const remaining = siblings.filter(({ id }) => id !== object.id);
      if (operation.index > remaining.length) throw new OperationValidationError(`Sibling layer index ${operation.index} is outside this group`);
      const orderedSiblingIds = [...remaining.slice(0, operation.index).map(({ id }) => id), object.id, ...remaining.slice(operation.index).map(({ id }) => id)];
      normalizeHierarchyOrder(shot, { parentId: object.parentId, ids: orderedSiblingIds });
      return `Moved ${object.name} to sibling layer ${operation.index + 1}`;
    }
    case "lock-object": {
      const object = objectById(shot, operation.objectId);
      if (object.locked) return `${object.name} was already locked`;
      requireUnlocked(shot, [object], "Lock");
      object.locked = true;
      return `Locked ${object.name}`;
    }
    case "unlock-object": {
      const object = objectById(shot, operation.objectId);
      if (!object.locked) return `${object.name} was already unlocked`;
      object.locked = false;
      return `Unlocked ${object.name}`;
    }
    case "add-animation": {
      if (projectIds.has(operation.animation.id)) throw new OperationValidationError(`ID already exists: ${operation.animation.id}`);
      const targets = operation.animation.targetIds.map((id) => objectById(shot, id));
      requireUnlocked(shot, mutationFamily(shot, targets), "Animate");
      shot.animations.push(cloneSerializable(operation.animation));
      return `Added ${operation.animation.type} animation`;
    }
    case "update-animation": {
      const animation = animationById(shot, operation.animationId);
      const existingCompatibilityIssue = animationAuthoringCompatibilityIssue(animation);
      const compatibilityEasingRepair = Object.keys(operation.patch).length === 1
        && operation.patch.easing !== undefined
        && (
          animation.type === "emphasise" && animation.easing !== "there-and-back" && operation.patch.easing === "there-and-back"
          || (animation.type === "write" || animation.type === "create") && animation.easing === "there-and-back" && operation.patch.easing !== "there-and-back"
        );
      if (existingCompatibilityIssue && !compatibilityEasingRepair) {
        throw new OperationValidationError("A legacy render-unsupported animation is read-only except for its exact easing repair");
      }
      const currentTargets = animation.targetIds.map((id) => objectById(shot, id));
      if (!compatibilityEasingRepair) requireUnlocked(shot, mutationFamily(shot, currentTargets), "Update animation");
      const targets = operation.patch.targetIds ?? animation.targetIds;
      const targetObjects = targets.map((id) => objectById(shot, id));
      if (!compatibilityEasingRepair) requireUnlocked(shot, mutationFamily(shot, targetObjects), "Update animation");
      const index = shot.animations.findIndex(({ id }) => id === animation.id);
      const updated = SceneAnimationSchema.parse({
        ...animation,
        ...operation.patch,
        properties: operation.patch.properties ? { ...animation.properties, ...operation.patch.properties } : animation.properties,
      });
      const updatedCompatibilityIssue = animationAuthoringCompatibilityIssue(updated);
      if (existingCompatibilityIssue) {
        if (!compatibilityEasingRepair || updatedCompatibilityIssue) {
          throw new OperationValidationError("A legacy render-unsupported animation is read-only except for its exact easing repair");
        }
      } else if (updatedCompatibilityIssue) {
        throw new OperationValidationError(updatedCompatibilityIssue);
      }
      shot.animations[index] = updated;
      return `Updated ${animation.type} animation`;
    }
    case "delete-animation": {
      const animation = animationById(shot, operation.animationId);
      requireUnlocked(shot, mutationFamily(shot, animation.targetIds.map((id) => objectById(shot, id))), "Delete animation");
      shot.animations = shot.animations.filter(({ id }) => id !== animation.id);
      return `Deleted ${animation.type} animation`;
    }
    case "set-object-lifetime": {
      const object = objectById(shot, operation.objectId);
      requireUnlocked(shot, mutationFamily(shot, [object]), "Set lifetime");
      object.lifetime = cloneSerializable(operation.lifetime);
      return `Set ${object.name} lifetime to ${operation.lifetime.start}s–${operation.lifetime.end}s`;
    }
    case "clear-object-lifetime": {
      const object = objectById(shot, operation.objectId);
      requireUnlocked(shot, mutationFamily(shot, [object]), "Clear lifetime");
      delete object.lifetime;
      return `Cleared ${object.name} lifetime`;
    }
    case "add-property-track": {
      if (projectIds.has(operation.track.id)) throw new OperationValidationError(`ID already exists: ${operation.track.id}`);
      for (const keyframe of operation.track.keyframes) {
        if (projectIds.has(keyframe.id)) throw new OperationValidationError(`ID already exists: ${keyframe.id}`);
      }
      requireTrackUnlocked(shot, operation.track, "Add property track");
      shot.propertyTracks.push(cloneSerializable(operation.track));
      return `Added ${operation.track.property} property track`;
    }
    case "delete-property-track": {
      const track = propertyTrackById(shot, operation.trackId);
      requireTrackUnlocked(shot, track, "Delete property track");
      shot.propertyTracks = shot.propertyTracks.filter(({ id }) => id !== track.id);
      return `Deleted ${track.property} property track`;
    }
    case "add-keyframe": {
      const track = propertyTrackById(shot, operation.trackId);
      requireTrackUnlocked(shot, track, "Add keyframe");
      if (projectIds.has(operation.keyframe.id)) throw new OperationValidationError(`ID already exists: ${operation.keyframe.id}`);
      track.keyframes.push(cloneSerializable(operation.keyframe));
      sortKeyframes(track);
      return `Added keyframe at ${operation.keyframe.time}s`;
    }
    case "update-keyframe": {
      const track = propertyTrackById(shot, operation.trackId);
      requireTrackUnlocked(shot, track, "Update keyframe");
      const keyframe = keyframeById(track, operation.keyframeId);
      Object.assign(keyframe, cloneSerializable(operation.patch));
      return `Updated keyframe ${keyframe.id}`;
    }
    case "move-keyframe": {
      const track = propertyTrackById(shot, operation.trackId);
      requireTrackUnlocked(shot, track, "Move keyframe");
      const keyframe = keyframeById(track, operation.keyframeId);
      keyframe.time = operation.time;
      sortKeyframes(track);
      return `Moved keyframe ${keyframe.id} to ${operation.time}s`;
    }
    case "delete-keyframe": {
      const track = propertyTrackById(shot, operation.trackId);
      requireTrackUnlocked(shot, track, "Delete keyframe");
      keyframeById(track, operation.keyframeId);
      track.keyframes = track.keyframes.filter(({ id }) => id !== operation.keyframeId);
      return `Deleted keyframe ${operation.keyframeId}`;
    }
    case "duplicate-keyframe": {
      const track = propertyTrackById(shot, operation.trackId);
      requireTrackUnlocked(shot, track, "Duplicate keyframe");
      if (projectIds.has(operation.duplicateId)) throw new OperationValidationError(`ID already exists: ${operation.duplicateId}`);
      const source = keyframeById(track, operation.keyframeId);
      track.keyframes.push({ ...cloneSerializable(source), id: operation.duplicateId, time: operation.time });
      sortKeyframes(track);
      return `Duplicated keyframe ${source.id} at ${operation.time}s`;
    }
    case "set-camera":
      shot.camera = cloneSerializable(operation.camera);
      return "Updated camera";
    case "set-style":
      if (!project.styles.some(({ id }) => id === operation.styleId)) throw new OperationValidationError(`Style not found: ${operation.styleId}`);
      if (project.activeStyleId === operation.styleId) return `${project.styles.find(({ id }) => id === operation.styleId)!.name} was already active`;
      project.activeStyleId = operation.styleId;
      return `Changed style to ${project.styles.find(({ id }) => id === operation.styleId)!.name}`;
  }
}

export function applyOperations(
  project: ProjectDocument,
  shotId: string,
  operations: readonly ManualSceneOperation[],
): OperationResult {
  if (!operations.length) throw new OperationValidationError("A transaction must contain at least one operation");
  if (operations.some(({ type }) => type === "unlock-object") && operations.length !== 1) {
    throw new OperationValidationError("Unlock must be an explicit standalone transaction");
  }
  const next = ProjectDocumentSchema.parse(cloneSerializable(project));
  const summary: string[] = [];
  operations.forEach((candidate, index) => {
    try {
      const operation = ManualSceneOperationSchema.parse(candidate);
      summary.push(applyOne(next, shotId, operation));
    } catch (error) {
      if (error instanceof OperationValidationError) throw new OperationValidationError(error.message, index);
      throw new OperationValidationError(error instanceof Error ? error.message : "Malformed operation", index);
    }
  });
  try {
    return { project: ProjectDocumentSchema.parse(next), applied: operations.length, summary };
  } catch (error) {
    throw new OperationValidationError(error instanceof Error ? `Resulting project is invalid: ${error.message}` : "Resulting project is invalid");
  }
}

export function validateOperations(
  project: ProjectDocument,
  shotId: string,
  operations: readonly ManualSceneOperation[],
): OperationValidationResult {
  try {
    return { valid: true, project: applyOperations(project, shotId, operations).project };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof OperationValidationError ? error : new OperationValidationError(String(error)),
    };
  }
}

export function describeOperations(operations: readonly ManualSceneOperation[]): string[] {
  return operations.map((operation) => {
    switch (operation.type) {
      case "add-object": return `Add “${operation.object.name}”`;
      case "update-object": return `Update ${operation.objectId}: ${Object.keys(operation.patch).join(", ")}`;
      case "delete-object": return `Delete ${operation.objectId}`;
      case "group-objects": return `Group ${operation.objectIds.length} objects`;
      case "ungroup-object": return `Ungroup ${operation.groupId}`;
      case "align-objects": return `Align ${operation.objectIds.length} objects ${operation.alignment}`;
      case "distribute-objects": return `Distribute ${operation.objectIds.length} objects ${operation.axis}ly`;
      case "reorder-object": return `Move ${operation.objectId} to layer ${operation.index + 1}`;
      case "lock-object": return `Lock ${operation.objectId}`;
      case "unlock-object": return `Unlock ${operation.objectId}`;
      case "add-animation": return `Add ${operation.animation.type} at ${operation.animation.start}s`;
      case "update-animation": return `Update animation ${operation.animationId}`;
      case "delete-animation": return `Delete animation ${operation.animationId}`;
      case "set-object-lifetime": return `Set ${operation.objectId} lifetime to ${operation.lifetime.start}s–${operation.lifetime.end}s`;
      case "clear-object-lifetime": return `Clear ${operation.objectId} lifetime`;
      case "add-property-track": return `Add ${operation.track.property} track ${operation.track.id}`;
      case "delete-property-track": return `Delete property track ${operation.trackId}`;
      case "add-keyframe": return `Add keyframe to ${operation.trackId} at ${operation.keyframe.time}s`;
      case "update-keyframe": return `Update keyframe ${operation.keyframeId}`;
      case "move-keyframe": return `Move keyframe ${operation.keyframeId} to ${operation.time}s`;
      case "delete-keyframe": return `Delete keyframe ${operation.keyframeId}`;
      case "duplicate-keyframe": return `Duplicate keyframe ${operation.keyframeId} at ${operation.time}s`;
      case "set-camera": return "Update camera framing";
      case "set-style": return `Use style ${operation.styleId}`;
    }
  });
}

export function duplicateObjects(
  project: ProjectDocument,
  shotId: string,
  objectIds: readonly string[],
  offset = { x: 24, y: 24 },
): OperationResult {
  const shot = shotById(project, shotId);
  requireUnique(objectIds, "Duplicate selection");
  const roots = objectIds.map((id) => objectById(shot, id));
  requireIndependentHierarchy(shot, roots, "Duplicate");
  requireUnlocked(shot, roots, "Duplicate");
  const selected = new Set(objectIds);
  for (const root of roots) {
    if (root.type === "group") descendantsOf(shot, root.id).forEach(({ id }) => selected.add(id));
  }
  requireUnlocked(shot, shot.objects.filter(({ id }) => selected.has(id)), "Duplicate");
  const depth = (object: SceneObject): number => {
    let value = 0;
    let cursor = object.parentId ? shot.objects.find(({ id }) => id === object.parentId) : undefined;
    while (cursor && selected.has(cursor.id)) {
      value += 1;
      cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor!.parentId) : undefined;
    }
    return value;
  };
  const source = shot.objects.filter((object) => selected.has(object.id)).sort((left, right) => depth(left) - depth(right));
  const ids = collectProjectIds(project);
  const mapping = new Map<string, string>();
  for (const item of source) {
    const nextId = allocateId(item.type === "group" ? "group" : "object", ids, item.name);
    ids.add(nextId);
    mapping.set(item.id, nextId);
  }
  const operations: SceneOperation[] = source.map((item) => {
    const clone = cloneSerializable(item);
    clone.id = mapping.get(item.id)!;
    clone.name = `${item.name} copy`;
    clone.transform.x += offset.x;
    clone.transform.y += offset.y;
    if (clone.parentId && mapping.has(clone.parentId)) clone.parentId = mapping.get(clone.parentId)!;
    return { type: "add-object", object: clone };
  });
  return applyOperations(project, shotId, operations);
}

/** Build a deterministic, reviewable add operation for an existing animation. */
export function duplicateAnimationOperation(
  project: ProjectDocument,
  shotId: string,
  animationId: string,
  start: number,
): Extract<SceneOperation, { type: "add-animation" }> {
  const shot = shotById(project, shotId);
  const source = animationById(shot, animationId);
  const ids = collectProjectIds(project);
  const animation = cloneSerializable(source);
  animation.id = allocateId("animation", ids, `${source.id}-copy`);
  animation.start = start;
  return { type: "add-animation", animation };
}
