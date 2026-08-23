import { PROOFCANVAS_TIME_EPSILON, cloneSerializable, type CameraStateSchema } from "./schema";
import type { Easing, SceneAnimation, SceneObject, Shot } from "./schema";
import type { z } from "zod";

export interface PreviewObject extends SceneObject {
  preview: {
    opacity: number;
    revealProgress: number;
    emphasis: number;
  };
}

export interface ShotPreview {
  time: number;
  objects: PreviewObject[];
  camera: z.infer<typeof CameraStateSchema>;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function easingProgress(easing: Easing, progress: number): number {
  const t = clamp(progress);
  switch (easing) {
    case "linear": return t;
    case "ease-in": return t * t;
    case "ease-out": return 1 - (1 - t) ** 2;
    case "ease-in-out": return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    case "editorial": return 1 - (1 - t) ** 4;
    case "spring-soft": return clamp(1 - Math.exp(-6 * t) * Math.cos(8 * t));
  }
}

function animationProgress(animation: SceneAnimation, time: number): number {
  return easingProgress(animation.easing, (time - animation.start) / animation.duration);
}

function numberProperty(properties: SceneAnimation["properties"], key: string, fallback: number): number {
  const value = properties[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function orderedAnimations(shot: Shot): SceneAnimation[] {
  return [...shot.animations].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

function descendantIds(shot: Shot, objectId: string): string[] {
  const result: string[] = [];
  const queue = [objectId];
  while (queue.length) {
    const parentId = queue.shift()!;
    const children = shot.objects.filter(({ parentId: candidate }) => candidate === parentId);
    result.push(...children.map(({ id }) => id));
    queue.push(...children.map(({ id }) => id));
  }
  return result;
}

const ENTRANCE_ANIMATION_TYPES: ReadonlySet<SceneAnimation["type"]> = new Set(["appear", "fade-in", "write", "create"]);
const VISIBILITY_ANIMATION_TYPES: ReadonlySet<SceneAnimation["type"]> = new Set([...ENTRANCE_ANIMATION_TYPES, "fade-out"]);

function expandedVisibilityTargetIds(shot: Shot, animation: SceneAnimation): string[] {
  return animation.targetIds.flatMap((id) => (
    shot.objects.find((object) => object.id === id)?.type === "group" ? [id, ...descendantIds(shot, id)] : [id]
  ));
}

export function firstVisibilityAnimationByTarget(shot: Shot): ReadonlyMap<string, Pick<SceneAnimation, "id" | "type">> {
  const firstVisibility = new Map<string, Pick<SceneAnimation, "id" | "type">>();
  for (const animation of orderedAnimations(shot)) {
    if (!VISIBILITY_ANIMATION_TYPES.has(animation.type)) continue;
    for (const targetId of expandedVisibilityTargetIds(shot, animation)) {
      if (!firstVisibility.has(targetId)) firstVisibility.set(targetId, { id: animation.id, type: animation.type });
    }
  }
  return firstVisibility;
}

export function initiallyHiddenByEntranceIds(shot: Shot): ReadonlySet<string> {
  return new Set(
    [...firstVisibilityAnimationByTarget(shot)]
      .filter(([, animation]) => ENTRANCE_ANIMATION_TYPES.has(animation.type))
      .map(([id]) => id),
  );
}

function effectivelyVisibleIds(shot: Shot): ReadonlySet<string> {
  const byId = new Map(shot.objects.map((object) => [object.id, object]));
  const memo = new Map<string, boolean>();
  const visit = (id: string): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const object = byId.get(id);
    const visible = Boolean(object?.visible) && (!object?.parentId || visit(object.parentId));
    memo.set(id, visible);
    return visible;
  };
  return new Set(shot.objects.filter((object) => visit(object.id)).map(({ id }) => id));
}

function bakePreviewGroupDelta(objects: PreviewObject[], groupId: string, old: SceneObject["transform"], next: SceneObject["transform"]): void {
  const objectMap = new Map(objects.map((object) => [object.id, object]));
  const isDescendant = (object: PreviewObject) => {
    let cursor = object.parentId ? objectMap.get(object.parentId) : undefined;
    while (cursor) {
      if (cursor.id === groupId) return true;
      cursor = cursor.parentId ? objectMap.get(cursor.parentId) : undefined;
    }
    return false;
  };
  const ratioX = ((next.width ?? 1) * next.scaleX) / ((old.width ?? 1) * old.scaleX);
  const ratioY = ((next.height ?? 1) * next.scaleY) / ((old.height ?? 1) * old.scaleY);
  const oldRadians = -old.rotation * Math.PI / 180;
  const nextRadians = next.rotation * Math.PI / 180;
  for (const object of objects.filter(isDescendant)) {
    const relativeX = object.transform.x - old.x;
    const relativeY = object.transform.y - old.y;
    const localX = relativeX * Math.cos(oldRadians) - relativeY * Math.sin(oldRadians);
    const localY = relativeX * Math.sin(oldRadians) + relativeY * Math.cos(oldRadians);
    const scaledX = localX * ratioX;
    const scaledY = localY * ratioY;
    object.transform = {
      ...object.transform,
      x: next.x + scaledX * Math.cos(nextRadians) - scaledY * Math.sin(nextRadians),
      y: next.y + scaledX * Math.sin(nextRadians) + scaledY * Math.cos(nextRadians),
      rotation: object.transform.rotation + next.rotation - old.rotation,
      scaleX: object.transform.scaleX * ratioX,
      scaleY: object.transform.scaleY * ratioY,
    };
  }
}

function reduceShotPreview(
  shot: Shot,
  requestedTime: number,
  includeAnimation: (animation: SceneAnimation) => boolean,
): ShotPreview {
  const time = clamp(Number.isFinite(requestedTime) ? requestedTime : 0, 0, shot.duration);
  const animations = orderedAnimations(shot).filter(includeAnimation);
  const enteringTargets = initiallyHiddenByEntranceIds(shot);
  const visibleIds = effectivelyVisibleIds(shot);
  const objects: PreviewObject[] = shot.objects.map((source) => ({
    ...cloneSerializable(source),
    preview: {
      opacity: visibleIds.has(source.id) && !enteringTargets.has(source.id) ? source.style.opacity ?? 1 : 0,
      revealProgress: enteringTargets.has(source.id) ? 0 : 1,
      emphasis: 0,
    },
  }));
  const byId = new Map(objects.map((object) => [object.id, object]));
  let camera = cloneSerializable(shot.camera);

  for (const animation of animations) {
    if (time < animation.start) continue;
    const progress = animationProgress(animation, time);
    if (animation.type === "camera-focus") {
      camera = {
        x: camera.x + (numberProperty(animation.properties, "x", camera.x) - camera.x) * progress,
        y: camera.y + (numberProperty(animation.properties, "y", camera.y) - camera.y) * progress,
        zoom: camera.zoom + (numberProperty(animation.properties, "zoom", camera.zoom) - camera.zoom) * progress,
        rotation: camera.rotation + (numberProperty(animation.properties, "rotation", camera.rotation) - camera.rotation) * progress,
      };
      continue;
    }
    const targetIds = VISIBILITY_ANIMATION_TYPES.has(animation.type)
      ? expandedVisibilityTargetIds(shot, animation)
      : animation.targetIds;
    for (const targetId of [...new Set(targetIds)]) {
      const object = byId.get(targetId);
      if (!object || !visibleIds.has(targetId)) continue;
      const baseOpacity = object.style.opacity ?? 1;
      const oldGroupTransform = object.type === "group" ? { ...object.transform } : null;
      switch (animation.type) {
        case "appear":
        case "fade-in":
          object.preview.opacity += (baseOpacity - object.preview.opacity) * progress;
          object.preview.revealProgress += (1 - object.preview.revealProgress) * progress;
          break;
        case "fade-out":
          object.preview.opacity *= 1 - progress;
          break;
        case "write":
        case "create":
          object.preview.opacity += (baseOpacity - object.preview.opacity) * progress;
          object.preview.revealProgress += (1 - object.preview.revealProgress) * progress;
          break;
        case "move": {
          const targetX = numberProperty(animation.properties, "x", object.transform.x + numberProperty(animation.properties, "deltaX", 0));
          const targetY = numberProperty(animation.properties, "y", object.transform.y + numberProperty(animation.properties, "deltaY", 0));
          object.transform.x += (targetX - object.transform.x) * progress;
          object.transform.y += (targetY - object.transform.y) * progress;
          break;
        }
        case "scale": {
          const targetScaleX = numberProperty(animation.properties, "scaleX", numberProperty(animation.properties, "scale", object.transform.scaleX));
          const targetScaleY = numberProperty(animation.properties, "scaleY", numberProperty(animation.properties, "scale", object.transform.scaleY));
          object.transform.scaleX += (targetScaleX - object.transform.scaleX) * progress;
          object.transform.scaleY += (targetScaleY - object.transform.scaleY) * progress;
          break;
        }
        case "transform": {
          for (const key of ["x", "y", "rotation", "scaleX", "scaleY", "width", "height"] as const) {
            const target = animation.properties[key];
            const current = object.transform[key];
            if (typeof target === "number" && typeof current === "number") object.transform[key] = current + (target - current) * progress;
          }
          break;
        }
        case "emphasise": {
          const magnitude = numberProperty(animation.properties, "scale", 1.08) - 1;
          const pulse = Math.sin(Math.PI * progress);
          object.preview.emphasis = pulse;
          object.transform.scaleX *= 1 + magnitude * pulse;
          object.transform.scaleY *= 1 + magnitude * pulse;
          break;
        }
      }
      if (oldGroupTransform && ["move", "scale", "transform", "emphasise"].includes(animation.type)) {
        bakePreviewGroupDelta(objects, object.id, oldGroupTransform, object.transform);
      }
    }
  }
  return { time, objects, camera };
}

export function previewShotAtTime(shot: Shot, requestedTime: number): ShotPreview {
  return reduceShotPreview(shot, requestedTime, () => true);
}

/**
 * Semantic state after one animation finishes but before an epsilon-adjacent
 * animation begins. This prevents zero-progress boundary events such as
 * `appear` from changing the absolute compiler target of the prior track.
 */
export function previewShotAtAnimationEnd(
  shot: Shot,
  animation: Pick<SceneAnimation, "id" | "start" | "duration">,
): ShotPreview {
  const end = animation.start + animation.duration;
  return reduceShotPreview(shot, end, (candidate) => (
    candidate.id === animation.id || candidate.start < end - PROOFCANVAS_TIME_EPSILON
  ));
}

export function previewObjectsAtTime(shot: Shot, time: number): PreviewObject[] {
  return previewShotAtTime(shot, time).objects;
}
