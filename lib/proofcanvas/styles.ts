import type { SceneObject, Shot, StylePack } from "./schema";

export const EDITORIAL_INK_STYLE_ID = "style-editorial-ink";
export const RAW_MANIM_STYLE_ID = "style-raw-manim";
export const SCIENTIFIC_MINIMAL_STYLE_ID = "style-scientific-minimal";
export const NOCTURNE_CHALK_STYLE_ID = "style-nocturne-chalk";

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
  annotation: { treatment: "marginal-hand", fontFamily: "Georgia, serif", offset: 14, roughness: 0.32 },
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
  caption: { color: "#f3eedf", background: "#252722", fontFamily: "Geist, Arial, sans-serif", fontSize: 30, position: "bottom", maxWidth: 0.82 },
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
  annotation: { treatment: "plain", fontFamily: "Arial, sans-serif", offset: 8, roughness: 0 },
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
  caption: { color: "#ffffff", background: "#000000", fontFamily: "Arial, sans-serif", fontSize: 28, position: "bottom", maxWidth: 0.84 },
} satisfies StylePack);

export const SCIENTIFIC_MINIMAL_STYLE: StylePack = Object.freeze({
  id: SCIENTIFIC_MINIMAL_STYLE_ID,
  name: "Scientific Minimal",
  origin: "preset",
  colors: {
    background: "#f8fafc",
    ink: "#14202b",
    mutedInk: "#607080",
    coolAccent: "#176b87",
    warmAccent: "#c85a34",
    rule: "#9aaab8",
  },
  typography: {
    statement: "Inter, Helvetica Neue, Arial, sans-serif",
    controls: "IBM Plex Mono, Menlo, monospace",
    math: "STIX Two Math, Times New Roman, serif",
    titleScale: 1.16,
    bodyScale: 0.92,
  },
  spacing: { unit: 6, margin: 36, objectGap: 14 },
  strokes: { fine: 0.75, regular: 1.25, emphasis: 2.5 },
  corners: { panel: 4, object: 3 },
  annotation: { treatment: "plain", fontFamily: "IBM Plex Mono, Menlo, monospace", offset: 10, roughness: 0 },
  graph: { gridOpacity: 0.08, axisWeight: 1, curveWeight: 2 },
  layout: { tendency: "centred", titleAnchor: "center", hierarchyContrast: 1.28 },
  motion: {
    defaultDuration: 0.55,
    easing: "ease-in-out",
    entrance: "fade-in",
    exit: "fade-out",
    emphasis: "emphasise",
    cameraMaxPan: 90,
    cameraMaxZoom: 1.2,
  },
  caption: { color: "#f8fafc", background: "#14202b", fontFamily: "Inter, Helvetica Neue, Arial, sans-serif", fontSize: 27, position: "bottom", maxWidth: 0.76 },
} satisfies StylePack);

export const NOCTURNE_CHALK_STYLE: StylePack = Object.freeze({
  id: NOCTURNE_CHALK_STYLE_ID,
  name: "Nocturne Chalk",
  origin: "preset",
  colors: {
    background: "#101b1b",
    ink: "#f0ead7",
    mutedInk: "#b2b8a9",
    coolAccent: "#77b7a5",
    warmAccent: "#e39a70",
    rule: "#70827b",
  },
  typography: {
    statement: "Alegreya, Georgia, serif",
    controls: "Geist Mono, Menlo, monospace",
    math: "STIX Two Math, Times New Roman, serif",
    titleScale: 1.38,
    bodyScale: 1.04,
  },
  spacing: { unit: 10, margin: 58, objectGap: 24 },
  strokes: { fine: 1.35, regular: 2.35, emphasis: 4 },
  corners: { panel: 7, object: 6 },
  annotation: { treatment: "marginal-hand", fontFamily: "Alegreya, Georgia, serif", offset: 20, roughness: 0.58 },
  graph: { gridOpacity: 0.16, axisWeight: 1.5, curveWeight: 3.2 },
  layout: { tendency: "chalkboard-column", titleAnchor: "upper-center", hierarchyContrast: 1.72 },
  motion: {
    defaultDuration: 1.05,
    easing: "spring-soft",
    entrance: "write",
    exit: "fade-out",
    emphasis: "emphasise",
    cameraMaxPan: 110,
    cameraMaxZoom: 1.28,
  },
  caption: { color: "#f0ead7", background: "#101b1b", fontFamily: "Alegreya, Georgia, serif", fontSize: 32, position: "bottom", maxWidth: 0.88 },
} satisfies StylePack);

export const DEFAULT_STYLE_PACKS: readonly StylePack[] = Object.freeze([
  EDITORIAL_INK_STYLE,
  SCIENTIFIC_MINIMAL_STYLE,
  NOCTURNE_CHALK_STYLE,
  RAW_MANIM_STYLE,
]);

export function styleById(styles: readonly StylePack[], styleId: string): StylePack | undefined {
  return styles.find((style) => style.id === styleId);
}

const MUTED_TEXT_ROLES = new Set(["annotation", "data-label", "marginal-note", "subtitle"]);
const COOL_ACCENT_TEXT_ROLES = new Set(["cool-label", "equation", "limit-equation", "main-claim"]);
const WARM_ACCENT_TEXT_ROLES = new Set(["counter-claim", "warm-label"]);

/** Resolve semantic demo typography through the active style while preserving explicit user colour. */
export function resolvedObjectColor(
  object: Pick<SceneObject, "semanticRole" | "style">,
  style: StylePack,
): string {
  if (object.style.color !== undefined) return object.style.color;
  if (object.semanticRole && MUTED_TEXT_ROLES.has(object.semanticRole)) return style.colors.mutedInk;
  if (object.semanticRole && COOL_ACCENT_TEXT_ROLES.has(object.semanticRole)) return style.colors.coolAccent;
  if (object.semanticRole && WARM_ACCENT_TEXT_ROLES.has(object.semanticRole)) return style.colors.warmAccent;
  return style.colors.ink;
}

/** One effective graph-curve style for inspector, preview, and compiler. */
export function resolvedGraphStroke(
  object: Pick<SceneObject, "id" | "parentId" | "style">,
  style: StylePack,
  hierarchy: readonly Pick<SceneObject, "id" | "parentId" | "style">[] = [],
): Readonly<{ stroke: string; strokeWidth: number }> {
  const objects = new Map(hierarchy.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  let cursor: Pick<SceneObject, "id" | "parentId" | "style"> | undefined = object;
  let stroke: string | undefined;
  let strokeWidth: number | undefined;
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    stroke ??= cursor.style.stroke;
    strokeWidth ??= cursor.style.strokeWidth;
    if (stroke !== undefined && strokeWidth !== undefined) break;
    cursor = cursor.parentId ? objects.get(cursor.parentId) : undefined;
  }
  return {
    stroke: stroke ?? style.colors.coolAccent,
    strokeWidth: strokeWidth ?? style.graph.curveWeight,
  };
}

export function styledTransform(object: Pick<SceneObject, "transform">, _style: StylePack): SceneObject["transform"] {
  // Geometry is authored project state. Style packs provide visual tokens and
  // insertion defaults; selecting or editing one must never move existing work.
  return { ...object.transform };
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
