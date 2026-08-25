import { logicalFrameFor, type LogicalFrame } from "./frame";
import { allocateId, collectProjectIds } from "./ids";
import {
  ProjectDocumentSchema,
  cloneSerializable,
  type ProjectDocument,
  type SceneObject,
} from "./schema";

export const SHAPE_PRESET_IDS = [
  "rectangle",
  "rounded-rectangle",
  "circle",
  "dot-point",
  "line",
  "arrow",
  "brace",
  "bracket",
  "highlight-box",
  "underline",
  "cross-out",
] as const;

export type ShapePresetId = (typeof SHAPE_PRESET_IDS)[number];
export const PROOFCANVAS_SHAPE_PRESET_MIME = "application/x-proofcanvas-shape-preset";

export interface ShapePresetDefinition {
  readonly id: ShapePresetId;
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly composition: "single" | "compound";
}

const DEFINITIONS = [
  {
    id: "rectangle",
    name: "Rectangle",
    description: "A sharp-cornered editable rectangle.",
    keywords: ["box", "panel", "square", "frame"],
    composition: "single",
  },
  {
    id: "rounded-rectangle",
    name: "Rounded rectangle",
    description: "An editable rectangle with an explicit bounded corner radius.",
    keywords: ["rounded", "roundrect", "box", "panel", "card"],
    composition: "single",
  },
  {
    id: "circle",
    name: "Circle",
    description: "An editable circular primitive that can also be resized into an ellipse.",
    keywords: ["ellipse", "oval", "ring", "disk"],
    composition: "single",
  },
  {
    id: "dot-point",
    name: "Dot / point",
    description: "A compact point that inherits the active ink colour.",
    keywords: ["dot", "point", "vertex", "marker", "node"],
    composition: "single",
  },
  {
    id: "line",
    name: "Line",
    description: "A straight editable segment with explicit endpoints.",
    keywords: ["segment", "rule", "stroke", "connector"],
    composition: "single",
  },
  {
    id: "arrow",
    name: "Arrow",
    description: "A straight editable arrow with a bounded triangular tip.",
    keywords: ["vector", "connector", "direction", "pointer", "tip"],
    composition: "single",
  },
  {
    id: "brace",
    name: "Brace",
    description: "An editable labelled brace beneath a measured span.",
    keywords: ["annotation", "measure", "label", "underbrace", "grouping"],
    composition: "single",
  },
  {
    id: "bracket",
    name: "Bracket",
    description: "A square bracket assembled from three independently editable lines.",
    keywords: ["square bracket", "delimiter", "grouping", "annotation"],
    composition: "compound",
  },
  {
    id: "highlight-box",
    name: "Highlight box",
    description: "A restrained translucent emphasis frame that inherits active colours.",
    keywords: ["highlight", "callout", "focus", "emphasis", "frame"],
    composition: "single",
  },
  {
    id: "underline",
    name: "Underline",
    description: "A compact round-capped annotation line.",
    keywords: ["underline", "rule", "emphasis", "annotation"],
    composition: "single",
  },
  {
    id: "cross-out",
    name: "Cross-out",
    description: "Two editable diagonal lines grouped into a cross-out mark.",
    keywords: ["cross", "strike", "strikethrough", "cancel", "delete", "x"],
    composition: "compound",
  },
] as const satisfies readonly ShapePresetDefinition[];

export const SHAPE_PRESETS: readonly ShapePresetDefinition[] = Object.freeze(
  DEFINITIONS.map((definition) => Object.freeze({
    ...definition,
    keywords: Object.freeze([...definition.keywords]),
  })),
);

const DEFINITION_BY_ID = new Map<ShapePresetId, ShapePresetDefinition>(
  SHAPE_PRESETS.map((definition) => [definition.id, definition]),
);

export interface ShapePresetPoint {
  readonly x: number;
  readonly y: number;
}

interface Footprint {
  readonly width: number;
  readonly height: number;
}

const PRESET_FOOTPRINTS: Readonly<Record<ShapePresetId, Footprint>> = Object.freeze({
  rectangle: Object.freeze({ width: 160, height: 90 }),
  "rounded-rectangle": Object.freeze({ width: 160, height: 90 }),
  circle: Object.freeze({ width: 96, height: 96 }),
  "dot-point": Object.freeze({ width: 20, height: 20 }),
  line: Object.freeze({ width: 180, height: 16 }),
  arrow: Object.freeze({ width: 180, height: 28 }),
  brace: Object.freeze({ width: 240, height: 150 }),
  bracket: Object.freeze({ width: 48, height: 120 }),
  "highlight-box": Object.freeze({ width: 220, height: 100 }),
  underline: Object.freeze({ width: 180, height: 16 }),
  "cross-out": Object.freeze({ width: 184, height: 54 }),
});

const PLACEMENT_MARGIN = 12;

function presetDefinition(presetId: string): ShapePresetDefinition {
  const definition = DEFINITION_BY_ID.get(presetId as ShapePresetId);
  if (!definition) throw new Error(`Unknown shape preset: ${presetId}`);
  return definition;
}

export function shapePresetById(presetId: string): ShapePresetDefinition | undefined {
  return DEFINITION_BY_ID.get(presetId as ShapePresetId);
}

export function searchShapePresets(query: string): readonly ShapePresetDefinition[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return SHAPE_PRESETS;
  return Object.freeze(SHAPE_PRESETS.filter((definition) => {
    const searchable = [
      definition.id,
      definition.name,
      definition.description,
      ...definition.keywords,
    ].join(" ").toLowerCase();
    return tokens.every((token) => searchable.includes(token));
  }));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function boundedOrigin(frame: LogicalFrame, footprint: Footprint, origin?: ShapePresetPoint): ShapePresetPoint {
  const requested = origin ?? { x: frame.centerX, y: frame.centerY };
  if (!Number.isFinite(requested.x) || !Number.isFinite(requested.y)) {
    throw new Error("Shape preset origin must contain finite coordinates");
  }
  const minimumX = PLACEMENT_MARGIN + footprint.width / 2;
  const maximumX = frame.width - minimumX;
  const minimumY = PLACEMENT_MARGIN + footprint.height / 2;
  const maximumY = frame.height - minimumY;
  return Object.freeze({
    x: Math.max(minimumX, Math.min(maximumX, requested.x)),
    y: Math.max(minimumY, Math.min(maximumY, requested.y)),
  });
}

interface ObjectOptions {
  readonly parentId?: string;
  readonly rotation?: number;
  readonly style?: SceneObject["style"];
  readonly semanticRole?: string;
}

function editableObject(
  id: string,
  type: SceneObject["type"],
  name: string,
  point: ShapePresetPoint,
  width: number,
  height: number,
  properties: SceneObject["properties"],
  options: ObjectOptions = {},
): SceneObject {
  return {
    id,
    type,
    name,
    ...(options.parentId ? { parentId: options.parentId } : {}),
    locked: false,
    visible: true,
    transform: {
      x: point.x,
      y: point.y,
      width,
      height,
      rotation: options.rotation ?? 0,
      scaleX: 1,
      scaleY: 1,
    },
    style: options.style ?? {},
    ...(options.semanticRole ? { semanticRole: options.semanticRole } : {}),
    properties,
  };
}

function rotatedCorners(object: SceneObject): ShapePresetPoint[] {
  const halfWidth = (object.transform.width ?? 1) * Math.abs(object.transform.scaleX) / 2;
  const halfHeight = (object.transform.height ?? 1) * Math.abs(object.transform.scaleY) / 2;
  const radians = object.transform.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]]
    .map(([x, y]) => ({
      x: object.transform.x + x * cosine - y * sine,
      y: object.transform.y + x * sine + y * cosine,
    }));
}

function exactCompoundGroup(
  groupId: string,
  name: string,
  semanticRole: string,
  children: readonly SceneObject[],
): SceneObject[] {
  const corners = children.flatMap(rotatedCorners);
  const left = Math.min(...corners.map(({ x }) => x));
  const right = Math.max(...corners.map(({ x }) => x));
  const top = Math.min(...corners.map(({ y }) => y));
  const bottom = Math.max(...corners.map(({ y }) => y));
  const group = editableObject(
    groupId,
    "group",
    name,
    { x: (left + right) / 2, y: (top + bottom) / 2 },
    right - left,
    bottom - top,
    {},
    { semanticRole },
  );
  return [group, ...children];
}

function buildPresetObjects(
  presetId: ShapePresetId,
  existingIds: ReadonlySet<string>,
  origin: ShapePresetPoint,
): SceneObject[] {
  const reserved = new Set(existingIds);
  const id = (hint: string, prefix = "object") => {
    const next = allocateId(prefix, reserved, `shape-${presetId}${hint ? `-${hint}` : ""}`);
    reserved.add(next);
    return next;
  };
  const single = (object: SceneObject) => [object];

  switch (presetId) {
    case "rectangle":
      return single(editableObject(
        id(""), "rectangle", "Rectangle", origin, 160, 90,
        { shape: { kind: "rectangle", cornerRadius: 0 } },
        { semanticRole: "shape-rectangle" },
      ));
    case "rounded-rectangle":
      return single(editableObject(
        id(""), "rectangle", "Rounded rectangle", origin, 160, 90,
        { shape: { kind: "rectangle", cornerRadius: 14 } },
        { semanticRole: "shape-rounded-rectangle" },
      ));
    case "circle":
      return single(editableObject(
        id(""), "circle", "Circle", origin, 96, 96,
        { shape: { kind: "circle" } },
        { semanticRole: "shape-circle" },
      ));
    case "dot-point":
      return single(editableObject(
        id(""), "circle", "Dot / point", origin, 10, 10,
        { shape: { kind: "circle" } },
        { semanticRole: "point", style: { strokeWidth: 10 } },
      ));
    case "line":
      return single(editableObject(
        id(""), "line", "Line", origin, 180, 2,
        { shape: { kind: "line", lineCap: "butt" } },
        { semanticRole: "shape-line" },
      ));
    case "arrow":
      return single(editableObject(
        id(""), "arrow", "Arrow", origin, 180, 18,
        { shape: { kind: "arrow", lineCap: "butt", tipShape: "triangle", tipSizeRatio: 0.25 } },
        { semanticRole: "shape-arrow" },
      ));
    case "brace":
      return single(editableObject(
        id(""), "brace", "Brace", origin, 220, 34,
        {
          label: "annotation",
          shape: { kind: "brace", direction: "below", spacing: 12 },
        },
        { semanticRole: "annotation-brace" },
      ));
    case "bracket": {
      const groupId = id("", "group");
      const lineShape = { kind: "line", lineCap: "square" } as const;
      return exactCompoundGroup(groupId, "Bracket", "annotation-bracket", [
        editableObject(
          id("stem"), "line", "Bracket stem", { x: origin.x - 16, y: origin.y }, 96, 2,
          { shape: lineShape }, { parentId: groupId, rotation: 90, semanticRole: "bracket-stem" },
        ),
        editableObject(
          id("top"), "line", "Bracket top", { x: origin.x, y: origin.y - 48 }, 32, 2,
          { shape: lineShape }, { parentId: groupId, semanticRole: "bracket-cap" },
        ),
        editableObject(
          id("bottom"), "line", "Bracket bottom", { x: origin.x, y: origin.y + 48 }, 32, 2,
          { shape: lineShape }, { parentId: groupId, semanticRole: "bracket-cap" },
        ),
      ]);
    }
    case "highlight-box":
      return single(editableObject(
        id(""), "rectangle", "Highlight box", origin, 220, 100,
        { shape: { kind: "rectangle", cornerRadius: 8 } },
        { semanticRole: "highlight-box", style: { opacity: 0.18 } },
      ));
    case "underline":
      return single(editableObject(
        id(""), "line", "Underline", origin, 180, 2,
        { shape: { kind: "line", lineCap: "round" } },
        { semanticRole: "underline" },
      ));
    case "cross-out": {
      const groupId = id("", "group");
      const lineShape = { kind: "line", lineCap: "round" } as const;
      return exactCompoundGroup(groupId, "Cross-out", "cross-out", [
        editableObject(
          id("descending"), "line", "Cross-out descending stroke", origin, 180, 2,
          { shape: lineShape }, { parentId: groupId, rotation: 8, semanticRole: "cross-out-stroke" },
        ),
        editableObject(
          id("ascending"), "line", "Cross-out ascending stroke", origin, 180, 2,
          { shape: lineShape }, { parentId: groupId, rotation: -8, semanticRole: "cross-out-stroke" },
        ),
      ]);
    }
  }
}

/**
 * Instantiate frozen editable objects without changing the project. IDs are
 * reserved against every project namespace, not only the target shot.
 */
export function instantiateShapePreset(
  project: ProjectDocument,
  shotId: string,
  presetId: ShapePresetId | string,
  origin?: ShapePresetPoint,
): readonly SceneObject[] {
  const definition = presetDefinition(presetId);
  const parsedProject = ProjectDocumentSchema.parse(project);
  if (!parsedProject.shots.some(({ id }) => id === shotId)) throw new Error(`Shot not found: ${shotId}`);
  const frame = logicalFrameFor(parsedProject.settings.aspectRatio);
  const point = boundedOrigin(frame, PRESET_FOOTPRINTS[definition.id], origin);
  const objects = buildPresetObjects(definition.id, collectProjectIds(parsedProject), point);
  return deepFreeze(objects);
}

/** Insert atomically, returning a new schema-validated document. */
export function insertShapePreset(
  project: ProjectDocument,
  shotId: string,
  presetId: ShapePresetId | string,
  origin?: ShapePresetPoint,
): ProjectDocument {
  const objects = instantiateShapePreset(project, shotId, presetId, origin);
  const next = cloneSerializable(project);
  const shot = next.shots.find(({ id }) => id === shotId);
  // instantiateShapePreset already checked this; keep the mutation boundary fail-closed.
  if (!shot) throw new Error(`Shot not found: ${shotId}`);
  shot.objects.push(...objects.map((object) => cloneSerializable(object)));
  return ProjectDocumentSchema.parse(next);
}
