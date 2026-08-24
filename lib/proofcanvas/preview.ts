import { PROOFCANVAS_TIME_EPSILON, cloneSerializable, objectTypeSupportsStyleProperty, type CameraStateSchema, type VisualStyleProperty } from "./schema";
import type { Easing, SceneAnimation, SceneObject, Shot } from "./schema";
import type { z } from "zod";
import { easingProgress } from "./easing";
import { objectExistsAtTime, orderedPropertyTracks, samplePropertyTrack } from "./timeline";

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

export { easingProgress } from "./easing";

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
  const authoredObjects = new Map(shot.objects.map((object) => [object.id, object]));
  const cascadedStyle = new Map<string, SceneObject["style"]>();
  const styleFor = (id: string): SceneObject["style"] => {
    const cached = cascadedStyle.get(id);
    if (cached) return cached;
    const source = authoredObjects.get(id);
    const inherited = source?.parentId ? styleFor(source.parentId) : {};
    const supports = (property: string) => !["color", "fill", "stroke", "strokeWidth", "opacity"].includes(property)
      || objectTypeSupportsStyleProperty(source?.type ?? "group", property as VisualStyleProperty);
    const style = Object.fromEntries([...Object.entries(inherited), ...Object.entries(source?.style ?? {})].filter(([property]) => supports(property)));
    cascadedStyle.set(id, style);
    return style;
  };
  const objects: PreviewObject[] = shot.objects.map((source) => ({
    ...cloneSerializable(source),
    style: cloneSerializable(styleFor(source.id)),
    preview: {
      opacity: visibleIds.has(source.id) && objectExistsAtTime(shot, source.id, time) && !enteringTargets.has(source.id) ? styleFor(source.id).opacity ?? 1 : 0,
      revealProgress: enteringTargets.has(source.id) ? 0 : 1,
      emphasis: 0,
    },
  }));
  const byId = new Map(objects.map((object) => [object.id, object]));
  let camera = cloneSerializable(shot.camera);

  const applyTrack = (track: Shot["propertyTracks"][number]) => {
    const sample = { target: track.target, property: track.property, value: samplePropertyTrack(track, time) };
    if (sample.target.kind === "camera" && typeof sample.value === "number") {
      camera = { ...camera, [sample.property]: sample.value };
      return;
    }
    if (sample.target.kind !== "object") return;
    const object = byId.get(sample.target.objectId);
    if (!object) return;
    const oldGroupTransform = object.type === "group" ? { ...object.transform } : null;
    if (["x", "y", "width", "height", "rotation", "scaleX", "scaleY"].includes(sample.property) && typeof sample.value === "number") {
      object.transform = { ...object.transform, [sample.property]: sample.value };
    } else if (sample.property === "scale" && typeof sample.value === "number") {
      object.transform = { ...object.transform, scaleX: sample.value, scaleY: sample.value };
    } else if (["opacity", "strokeWidth", "fill", "stroke"].includes(sample.property)) {
      const styledIds = object.type === "group" ? [object.id, ...descendantIds(shot, object.id)] : [object.id];
      for (const styledId of styledIds) {
        const styledObject = byId.get(styledId);
        if (!styledObject) continue;
        if (!objectTypeSupportsStyleProperty(styledObject.type, sample.property as VisualStyleProperty)) continue;
        if (styledId !== object.id && (!visibleIds.has(styledId) || !objectExistsAtTime(shot, styledId, time))) continue;
        if ((sample.property === "opacity" || sample.property === "strokeWidth") && typeof sample.value === "number") {
          styledObject.style = { ...styledObject.style, [sample.property]: sample.value };
          if (sample.property === "opacity" && visibleIds.has(styledId) && !enteringTargets.has(styledId)) {
            styledObject.preview.opacity = sample.value;
          }
        } else if ((sample.property === "fill" || sample.property === "stroke") && typeof sample.value === "string") {
          styledObject.style = { ...styledObject.style, [sample.property]: sample.value };
        }
      }
    }
    if (oldGroupTransform) bakePreviewGroupDelta(objects, object.id, oldGroupTransform, object.transform);
  };

  const applyAnimation = (animation: SceneAnimation) => {
    const progress = animationProgress(animation, time);
    if (animation.type === "camera-focus") {
      camera = {
        x: camera.x + (numberProperty(animation.properties, "x", camera.x) - camera.x) * progress,
        y: camera.y + (numberProperty(animation.properties, "y", camera.y) - camera.y) * progress,
        zoom: camera.zoom + (numberProperty(animation.properties, "zoom", camera.zoom) - camera.zoom) * progress,
        rotation: camera.rotation + (numberProperty(animation.properties, "rotation", camera.rotation) - camera.rotation) * progress,
      };
      return;
    }
    const targetIds = VISIBILITY_ANIMATION_TYPES.has(animation.type)
      ? expandedVisibilityTargetIds(shot, animation)
      : animation.targetIds;
    for (const targetId of [...new Set(targetIds)]) {
      const object = byId.get(targetId);
      if (!object || !visibleIds.has(targetId) || !objectExistsAtTime(shot, targetId, time)) continue;
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
  };

  const canonicalTracks = orderedPropertyTracks(shot);
  const trackOrder = new Map(canonicalTracks.map((track, index) => [track.id, index]));
  const events = [
    ...animations.filter((animation) => time >= animation.start - PROOFCANVAS_TIME_EPSILON).map((animation) => ({
      kind: "animation" as const,
      authority: Math.min(time, animation.start + animation.duration),
      start: animation.start,
      id: animation.id,
      animation,
      order: 0,
    })),
    ...canonicalTracks.filter((track) => time >= track.keyframes[0].time - PROOFCANVAS_TIME_EPSILON).map((track) => ({
      kind: "track" as const,
      authority: Math.min(time, track.keyframes.at(-1)!.time),
      start: track.keyframes[0].time,
      id: track.id,
      track,
      order: trackOrder.get(track.id) ?? 0,
    })),
  ].sort((left, right) => left.authority - right.authority
    || left.start - right.start
    || (left.kind === right.kind ? 0 : left.kind === "animation" ? -1 : 1)
    || left.order - right.order
    || left.id.localeCompare(right.id));
  for (const event of events) {
    if (event.kind === "track") applyTrack(event.track);
    else applyAnimation(event.animation);
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
