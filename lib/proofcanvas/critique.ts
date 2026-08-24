import type { ProjectDocument, SceneObject, SceneOperation, Shot, StylePack } from "./schema";
import { effectiveLockOwner, effectiveVisibilityOwner } from "./operations";
import { styledTransform } from "./styles";

export type CritiqueSeverity = "info" | "warning" | "error";
export type CritiqueKind =
  | "overlap"
  | "outside-frame"
  | "unreadable-text"
  | "insufficient-contrast"
  | "overcrowded-region"
  | "inconsistent-margins"
  | "simultaneous-animations"
  | "weak-focal-hierarchy"
  | "missing-animation-target"
  | "locked-operation-target";

export interface CritiqueIssue {
  id: string;
  kind: CritiqueKind;
  severity: CritiqueSeverity;
  objectIds: string[];
  explanation: string;
  proposedCorrection: string;
}

export interface CritiqueOptions {
  shotId?: string;
  proposedOperations?: readonly SceneOperation[];
}

function dimensions(project: ProjectDocument) {
  if (project.settings.aspectRatio === "16:9") return { width: 960, height: 540 };
  if (project.settings.aspectRatio === "9:16") return { width: 540, height: 960 };
  return { width: 720, height: 720 };
}

function bounds(object: SceneObject) {
  const width = (object.transform.width ?? 0) * Math.abs(object.transform.scaleX ?? 1);
  const height = (object.transform.height ?? 0) * Math.abs(object.transform.scaleY ?? 1);
  const radians = object.transform.rotation * Math.PI / 180;
  const halfWidth = Math.abs(Math.cos(radians)) * width / 2 + Math.abs(Math.sin(radians)) * height / 2;
  const halfHeight = Math.abs(Math.sin(radians)) * width / 2 + Math.abs(Math.cos(radians)) * height / 2;
  return { left: object.transform.x - halfWidth, right: object.transform.x + halfWidth, top: object.transform.y - halfHeight, bottom: object.transform.y + halfHeight, width: halfWidth * 2, height: halfHeight * 2 };
}

function intersectionArea(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

function luminance(hex: string): number {
  const values = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

function contrast(a: string, b: string): number {
  const [bright, dark] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (bright + 0.05) / (dark + 0.05);
}

function issue(kind: CritiqueKind, severity: CritiqueSeverity, objectIds: string[], explanation: string, proposedCorrection: string): CritiqueIssue {
  return { id: `critique-${kind}-${[...objectIds].sort().join("-") || "shot"}`, kind, severity, objectIds: [...objectIds].sort(), explanation, proposedCorrection };
}

function operationObjectIds(operation: SceneOperation, shot: Shot): string[] {
  const descendants = (id: string) => {
    const result: string[] = [];
    const queue = [id];
    while (queue.length) {
      const parentId = queue.shift()!;
      const children = shot.objects.filter(({ parentId: candidate }) => candidate === parentId);
      result.push(...children.map(({ id: childId }) => childId));
      queue.push(...children.map(({ id: childId }) => childId));
    }
    return result;
  };
  const withGroupFamilies = (ids: string[]) => [...new Set(ids.flatMap((id) => shot.objects.find((object) => object.id === id)?.type === "group" ? [id, ...descendants(id)] : [id]))];
  switch (operation.type) {
    case "update-object": return operation.patch.transform ? withGroupFamilies([operation.objectId]) : [operation.objectId];
    case "delete-object": return withGroupFamilies([operation.objectId]);
    case "reorder-object":
    case "lock-object":
    case "unlock-object": return [operation.objectId];
    case "group-objects": return withGroupFamilies(operation.objectIds);
    case "ungroup-object": return withGroupFamilies([operation.groupId]);
    case "align-objects":
    case "distribute-objects": return withGroupFamilies(operation.objectIds);
    case "add-object": return operation.object.parentId ? [operation.object.parentId] : [];
    case "add-animation": return withGroupFamilies(operation.animation.targetIds);
    case "update-animation": {
      const animation = shot.animations.find(({ id }) => id === operation.animationId);
      return withGroupFamilies(operation.patch.targetIds ?? animation?.targetIds ?? []);
    }
    case "delete-animation": return withGroupFamilies(shot.animations.find(({ id }) => id === operation.animationId)?.targetIds ?? []);
    case "set-object-lifetime": return withGroupFamilies([operation.objectId]);
    case "add-property-track": return operation.track.target.kind === "object" ? withGroupFamilies([operation.track.target.objectId]) : [];
    case "delete-property-track":
    case "add-keyframe":
    case "update-keyframe":
    case "move-keyframe":
    case "delete-keyframe":
    case "duplicate-keyframe": {
      const trackId = operation.type === "delete-property-track" ? operation.trackId : operation.trackId;
      const track = shot.propertyTracks.find(({ id }) => id === trackId);
      return track?.target.kind === "object" ? withGroupFamilies([track.target.objectId]) : [];
    }
    case "set-camera":
    case "set-style": return [];
  }
}

function critiqueShot(project: ProjectDocument, shot: Shot, style: StylePack, operations: readonly SceneOperation[]): CritiqueIssue[] {
  const issues: CritiqueIssue[] = [];
  const frame = dimensions(project);
  const visible = shot.objects
    .filter((object) => object.type !== "group" && !effectiveVisibilityOwner(shot, object))
    .map((object) => ({ ...object, transform: styledTransform(object, style) }));
  const objectMap = new Map(shot.objects.map((object) => [object.id, object]));

  for (let leftIndex = 0; leftIndex < visible.length; leftIndex += 1) {
    const left = visible[leftIndex];
    const leftBounds = bounds(left);
    if (leftBounds.left < 0 || leftBounds.top < 0 || leftBounds.right > frame.width || leftBounds.bottom > frame.height) {
      issues.push(issue("outside-frame", "error", [left.id], `${left.name} extends outside the ${frame.width} × ${frame.height} frame.`, "Move or resize it until its full bounds sit inside the frame."));
    }
    if ((left.type === "text" || left.type === "math") && (left.style.fontSize ?? 18) < 16) {
      issues.push(issue("unreadable-text", "warning", [left.id], `${left.name} is below the 16 px prototype readability floor.`, "Increase its font size or remove nonessential copy."));
    }
    if (left.type === "text" || left.type === "math") {
      const foreground = left.style.color ?? style.colors.ink;
      if (contrast(foreground, style.colors.background) < 4.5) {
        issues.push(issue("insufficient-contrast", "error", [left.id], `${left.name} does not reach 4.5:1 contrast against the scene background.`, "Use the ink or muted-ink semantic role with sufficient measured contrast."));
      }
    }
    for (let rightIndex = leftIndex + 1; rightIndex < visible.length; rightIndex += 1) {
      const right = visible[rightIndex];
      if (left.parentId === right.id || right.parentId === left.id) continue;
      if (left.parentId && left.parentId === right.parentId && (left.semanticRole === "focus-frame" || right.semanticRole === "focus-frame")) continue;
      const rightBounds = bounds(right);
      const overlap = intersectionArea(leftBounds, rightBounds);
      const smaller = Math.max(1, Math.min(leftBounds.width * leftBounds.height, rightBounds.width * rightBounds.height));
      if (overlap / smaller >= 0.18 && (left.type === "text" || left.type === "math" || right.type === "text" || right.type === "math")) {
        issues.push(issue("overlap", "warning", [left.id, right.id], `${left.name} and ${right.name} overlap enough to impair reading.`, "Separate the objects or establish an intentional parent grouping."));
      }
    }
  }

  const cells = new Map<string, SceneObject[]>();
  for (const object of visible) {
    const column = Math.min(2, Math.max(0, Math.floor(object.transform.x / (frame.width / 3))));
    const row = Math.min(2, Math.max(0, Math.floor(object.transform.y / (frame.height / 3))));
    const key = `${column}-${row}`;
    cells.set(key, [...(cells.get(key) ?? []), object]);
  }
  for (const objects of cells.values()) {
    if (objects.length >= 6) issues.push(issue("overcrowded-region", "warning", objects.map(({ id }) => id), `${objects.length} objects compete inside one ninth of the frame.`, "Increase spacing, reduce supporting notation, or distribute the objects across adjacent regions."));
  }

  if (visible.length >= 3) {
    const edgeGaps = visible.flatMap((object) => {
      const box = bounds(object);
      return [box.left, frame.width - box.right, box.top, frame.height - box.bottom].filter((gap) => gap >= 0);
    });
    if (edgeGaps.length && Math.max(...edgeGaps) - Math.min(...edgeGaps) > Math.min(frame.width, frame.height) * 0.72 && Math.min(...edgeGaps) < 12) {
      issues.push(issue("inconsistent-margins", "info", visible.filter((object) => {
        const box = bounds(object);
        return Math.min(box.left, frame.width - box.right, box.top, frame.height - box.bottom) < 12;
      }).map(({ id }) => id), "One or more objects crowd an edge while the rest of the composition uses generous margins.", "Bring edge objects onto the spacing scale or make the edge break clearly intentional."));
    }
  }

  const eventTimes = [...new Set(shot.animations.flatMap((animation) => [animation.start, animation.start + animation.duration]))].sort((a, b) => a - b);
  let maximumActive: SceneAnimationLike[] = [];
  for (const time of eventTimes) {
    const active = shot.animations.filter((animation) => animation.start <= time && animation.start + animation.duration > time);
    if (active.length > maximumActive.length) maximumActive = active;
  }
  if (maximumActive.length > 3) {
    issues.push(issue("simultaneous-animations", "warning", [...new Set(maximumActive.flatMap(({ targetIds }) => targetIds))], `${maximumActive.length} animations compete at the same moment.`, "Stagger supporting motion and reserve simultaneous action for one deliberate beat."));
  }

  const text = visible.filter(({ type }) => type === "text" || type === "math");
  if (text.length >= 3) {
    const sizes = text.map((object) => object.style.fontSize ?? 18);
    const roles = new Set(text.map(({ semanticRole }) => semanticRole).filter(Boolean));
    if (Math.max(...sizes) / Math.max(1, Math.min(...sizes)) < 1.3 || (!roles.has("title") && !roles.has("main-claim"))) {
      issues.push(issue("weak-focal-hierarchy", "warning", text.map(({ id }) => id), "Text elements have insufficient size or semantic contrast to establish a clear focal idea.", "Choose one title or main claim and reduce the scale or contrast of supporting notation."));
    }
  }

  for (const animation of shot.animations) {
    const missing = animation.targetIds.filter((id) => !objectMap.has(id));
    if (missing.length) issues.push(issue("missing-animation-target", "error", missing, `${animation.id} targets missing object IDs: ${missing.join(", ")}.`, "Remove the stale targets or restore the intended objects before playback/export."));
  }

  operations.forEach((operation) => {
    const locked = operationObjectIds(operation, shot).filter((id) => operation.type !== "unlock-object" && effectiveLockOwner(shot, id));
    if (locked.length) issues.push(issue("locked-operation-target", "error", locked, `${operation.type} would mutate a locked object.`, "Remove the operation or explicitly unlock the object in a separately reviewed action."));
  });

  return issues;
}

type SceneAnimationLike = Shot["animations"][number];

export function critiqueProject(project: ProjectDocument, options: CritiqueOptions = {}): CritiqueIssue[] {
  const style = project.styles.find(({ id }) => id === project.activeStyleId) ?? project.styles[0];
  const shots = options.shotId ? project.shots.filter(({ id }) => id === options.shotId) : project.shots;
  if (options.shotId && !shots.length) throw new Error(`Shot not found: ${options.shotId}`);
  return shots.flatMap((shot) => critiqueShot(project, shot, style, options.proposedOperations ?? []));
}
