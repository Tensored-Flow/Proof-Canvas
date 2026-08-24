import type { SceneObject, Shot, StylePack } from "./schema";

export const EDITORIAL_INK_STYLE_ID = "style-editorial-ink";
export const RAW_MANIM_STYLE_ID = "style-raw-manim";

export const EDITORIAL_INK_STYLE: StylePack = Object.freeze({
  id: EDITORIAL_INK_STYLE_ID,
  name: "Editorial Ink",
  origin: "preset",
  colors: {
    background: "#f3eedf",
    ink: "#252722",
    mutedInk: "#4f534c",
    coolAccent: "#315866",
    warmAccent: "#71402d",
    rule: "#655f55",
  },
  typography: {
    statement: "Cormorant Garamond, Georgia, serif",
    controls: "Geist, Arial, sans-serif",
    math: "STIX Two Math, Times New Roman, serif",
    titleScale: 1.28,
    bodyScale: 1,
  },
  spacing: { unit: 8, margin: 48, objectGap: 18 },
  strokes: { fine: 1, regular: 1.75, emphasis: 3 },
  corners: { panel: 2, object: 1 },
  annotation: { treatment: "marginal-hand", offset: 14, roughness: 0.32 },
  graph: { gridOpacity: 0.12, axisWeight: 1.15, curveWeight: 2.25 },
  layout: { tendency: "editorial-asymmetric", titleAnchor: "upper-left", hierarchyContrast: 1.5 },
  motion: {
    defaultDuration: 0.8,
    easing: "editorial",
    entrance: "write",
    exit: "fade-out",
    emphasis: "emphasise",
    cameraMaxPan: 140,
    cameraMaxZoom: 1.35,
  },
} satisfies StylePack);

export const RAW_MANIM_STYLE: StylePack = Object.freeze({
  id: RAW_MANIM_STYLE_ID,
  name: "Raw Manim",
  origin: "preset",
  colors: {
    background: "#ffffff",
    ink: "#000000",
    mutedInk: "#555555",
    coolAccent: "#176b80",
    warmAccent: "#b3261e",
    rule: "#656565",
  },
  typography: {
    statement: "Arial, sans-serif",
    controls: "Arial, sans-serif",
    math: "Computer Modern, serif",
    titleScale: 1,
    bodyScale: 1,
  },
  spacing: { unit: 8, margin: 24, objectGap: 12 },
  strokes: { fine: 1, regular: 2, emphasis: 3 },
  corners: { panel: 0, object: 0 },
  annotation: { treatment: "plain", offset: 8, roughness: 0 },
  graph: { gridOpacity: 0.2, axisWeight: 1, curveWeight: 2 },
  layout: { tendency: "centred", titleAnchor: "center", hierarchyContrast: 1 },
  motion: {
    defaultDuration: 1,
    easing: "linear",
    entrance: "appear",
    exit: "fade-out",
    emphasis: "scale",
    cameraMaxPan: 80,
    cameraMaxZoom: 1.2,
  },
} satisfies StylePack);

export const DEFAULT_STYLE_PACKS: readonly StylePack[] = Object.freeze([
  EDITORIAL_INK_STYLE,
  RAW_MANIM_STYLE,
]);

export function styleById(styles: readonly StylePack[], styleId: string): StylePack | undefined {
  return styles.find((style) => style.id === styleId);
}

export function styledTransform(object: Pick<SceneObject, "semanticRole" | "transform">, style: StylePack): SceneObject["transform"] {
  if (style.layout.tendency === "centred") {
    const centringStrength = 0.18;
    return {
      ...object.transform,
      x: object.transform.x + (480 - object.transform.x) * centringStrength,
    };
  }
  if (object.semanticRole === "annotation" || object.semanticRole === "marginal-note") {
    return {
      ...object.transform,
      x: object.transform.x + style.annotation.offset,
      rotation: object.transform.rotation - style.annotation.roughness * 4,
    };
  }
  if (object.semanticRole !== "title") return { ...object.transform };
  const factor = style.typography.titleScale;
  return {
    ...object.transform,
    x: object.transform.x + (object.transform.width ?? 0) * object.transform.scaleX * (factor - 1) / 2,
    y: object.transform.y + (object.transform.height ?? 0) * object.transform.scaleY * (factor - 1) / 2,
    scaleX: object.transform.scaleX * factor,
    scaleY: object.transform.scaleY * factor,
  };
}

export function transformCorners(transform: SceneObject["transform"]): Array<{ x: number; y: number }> {
  const halfWidth = (transform.width ?? 60) * Math.abs(transform.scaleX) / 2;
  const halfHeight = (transform.height ?? 30) * Math.abs(transform.scaleY) / 2;
  const radians = transform.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]].map(([x, y]) => ({
    x: transform.x + x * cos - y * sin,
    y: transform.y + x * sin + y * cos,
  }));
}

export function styledTransformCorners(object: SceneObject, style: StylePack): Array<{ x: number; y: number }> {
  return transformCorners(styledTransform(object, style));
}

function descendantOf(shot: Shot, candidate: SceneObject, ancestorId: string): boolean {
  let cursor = candidate.parentId ? shot.objects.find(({ id }) => id === candidate.parentId) : undefined;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    if (cursor.id === ancestorId) return true;
    visited.add(cursor.id);
    cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined;
  }
  return false;
}

function effectivelyVisible(shot: Shot, object: SceneObject): boolean {
  let cursor: SceneObject | undefined = object;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    if (!cursor.visible) return false;
    visited.add(cursor.id);
    cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined;
  }
  return true;
}

/** The frame a user sees and manipulates for an object in the active style. */
export function styledDisplayTransform(object: SceneObject, shot: Shot, style: StylePack, candidates: readonly SceneObject[] = shot.objects): SceneObject["transform"] {
  if (object.type !== "group") return styledTransform(object, style);
  const descendantLeaves = candidates.filter((candidate) => (
    candidate.type !== "group"
    && effectivelyVisible(shot, candidate)
    && descendantOf(shot, candidate, object.id)
  ));
  if (!descendantLeaves.length) return styledTransform(object, style);
  const points = descendantLeaves.flatMap((candidate) => styledTransformCorners(candidate, style));
  const left = Math.min(...points.map(({ x }) => x));
  const right = Math.max(...points.map(({ x }) => x));
  const top = Math.min(...points.map(({ y }) => y));
  const bottom = Math.max(...points.map(({ y }) => y));
  return { ...object.transform, x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top, rotation: 0, scaleX: 1, scaleY: 1 };
}

export function styledDisplayBounds(object: SceneObject, shot: Shot, style: StylePack, candidates: readonly SceneObject[] = shot.objects) {
  const displayTransform = styledDisplayTransform(object, shot, style, candidates);
  const points = transformCorners(displayTransform);
  return {
    left: Math.min(...points.map(({ x }) => x)),
    right: Math.max(...points.map(({ x }) => x)),
    top: Math.min(...points.map(({ y }) => y)),
    bottom: Math.max(...points.map(({ y }) => y)),
    centerX: displayTransform.x,
    centerY: displayTransform.y,
  };
}
