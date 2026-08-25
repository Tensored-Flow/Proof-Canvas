import {
  CurrentShapePropertiesSchema,
  PROOFCANVAS_SCHEMA_LIMITS,
  type SceneObject,
  type StylePack,
} from "./schema";

export const CURRENT_SHAPE_TYPES = ["circle", "rectangle", "line", "arrow", "brace"] as const;
export type CurrentShapeType = (typeof CURRENT_SHAPE_TYPES)[number];

export const LINEAR_SHAPE_TYPES = ["line", "arrow"] as const;
export type LinearShapeType = (typeof LINEAR_SHAPE_TYPES)[number];

export const SHAPE_LINE_CAPS = ["butt", "round", "square"] as const;
export type ShapeLineCap = (typeof SHAPE_LINE_CAPS)[number];

export const ARROW_TIP_SHAPES = ["triangle", "stealth", "circle", "square"] as const;
export type ArrowTipShape = (typeof ARROW_TIP_SHAPES)[number];

export const BRACE_DIRECTIONS = ["above", "below", "left", "right"] as const;
export type BraceDirection = (typeof BRACE_DIRECTIONS)[number];

export const LEGACY_LINE_CAP: ShapeLineCap = "butt";
export const LEGACY_ARROW_TIP_SHAPE: ArrowTipShape = "triangle";
/** Manim Arrow's legacy max_tip_length_to_length_ratio default. */
export const LEGACY_ARROW_TIP_SIZE_RATIO = 0.25;
export const LEGACY_BRACE_DIRECTION: BraceDirection = "below";
export const LEGACY_BRACE_SPACING = 12;
export const LEGACY_SHAPE_WIDTH = 60;
export const LEGACY_SHAPE_HEIGHT = 30;
export const MIN_ARROW_TIP_SIZE_RATIO = 0.02;
export const MAX_ARROW_TIP_SIZE_RATIO = 0.45;

type ShapeObject = Pick<SceneObject, "type" | "transform" | "style" | "properties">;
type UnknownRecord = Readonly<Record<string, unknown>>;

export type ResolvedShapeGeometry =
  | Readonly<{ kind: "circle" }>
  | Readonly<{ kind: "rectangle"; cornerRadius: number }>
  | Readonly<{ kind: "line"; lineCap: ShapeLineCap }>
  | Readonly<{
      kind: "arrow";
      lineCap: ShapeLineCap;
      tipShape: ArrowTipShape;
      tipSizeRatio: number;
    }>
  | Readonly<{
      kind: "brace";
      direction: BraceDirection;
      spacing: number;
    }>;

export interface ResolvedShapePaint {
  /** Null means the primitive is intentionally unfilled. */
  fill: string | null;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  /** Used by the brace label; harmless for other primitives. */
  labelColor: string;
}

export interface LineEndpoints {
  start: Readonly<{ x: number; y: number }>;
  end: Readonly<{ x: number; y: number }>;
}

export interface ResolvedShapeDimensions {
  readonly width: number;
  readonly height: number;
}

export type ArrowPreviewGeometry = Readonly<{
  tipLength: number;
  tipX: number;
  shaftEndX: number;
}> & (
  | Readonly<{ kind: "circle"; centerX: number; radius: number }>
  | Readonly<{ kind: "triangle" | "stealth" | "square"; points: readonly Readonly<{ x: number; y: number }>[] }>
);

export interface ShapeAuthoringIssue {
  readonly code: "SHAPE_SETTINGS_INVALID" | "SHAPE_SETTINGS_KIND_MISMATCH";
  readonly message: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const NUMERIC_EPSILON = 1e-9;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validHex(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function safeDimension(value: number | undefined, fallback: number): number {
  return finiteInRange(
    value,
    PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin,
    PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax,
  ) ? value : fallback;
}

/** One legacy-safe authored box for browser geometry, compilation, and tools. */
export function resolveShapeDimensions(
  object: Pick<ShapeObject, "transform">,
): ResolvedShapeDimensions {
  return {
    width: safeDimension(object.transform.width, LEGACY_SHAPE_WIDTH),
    height: safeDimension(object.transform.height, LEGACY_SHAPE_HEIGHT),
  };
}

function shapeProperties(object: ShapeObject, kind: CurrentShapeType): UnknownRecord | null {
  const candidate = object.properties.shape;
  if (
    !isRecord(candidate)
    || !Object.prototype.hasOwnProperty.call(candidate, "kind")
    || candidate.kind !== kind
  ) return null;
  return candidate;
}

/** Only the matching, namespaced shape record is authoritative for new geometry. */
function shapeValue(object: ShapeObject, kind: CurrentShapeType, key: string): unknown {
  const nested = shapeProperties(object, kind);
  return nested && Object.prototype.hasOwnProperty.call(nested, key) ? nested[key] : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

export function isCurrentShapeType(type: string): type is CurrentShapeType {
  return (CURRENT_SHAPE_TYPES as readonly string[]).includes(type);
}

export function isLinearShapeType(type: string): type is LinearShapeType {
  return (LINEAR_SHAPE_TYPES as readonly string[]).includes(type);
}

/**
 * V3's generic JSON envelope remains load-compatible. New authoring is stricter:
 * an absent shape record is a valid published legacy shape, while a present
 * record must be exact and match the object's current primitive type.
 */
export function shapeAuthoringIssue(
  object: Pick<ShapeObject, "type" | "properties">,
): ShapeAuthoringIssue | undefined {
  if (!isCurrentShapeType(object.type) || !Object.prototype.hasOwnProperty.call(object.properties, "shape")) return undefined;
  const parsed = CurrentShapePropertiesSchema.safeParse(object.properties.shape);
  if (!parsed.success) return {
    code: "SHAPE_SETTINGS_INVALID",
    message: `Shape settings for ${object.type} must use its exact bounded shape record.`,
  };
  if (parsed.data.kind !== object.type) return {
    code: "SHAPE_SETTINGS_KIND_MISMATCH",
    message: `Shape settings kind ${parsed.data.kind} does not match object type ${object.type}.`,
  };
  return undefined;
}

/** Exact local arrow-tip and shaft attachment geometry from pinned Manim 0.21. */
export function resolveArrowPreviewGeometry(
  width: number,
  tipShape: ArrowTipShape,
  tipSizeRatio: number,
  maximumTipLength: number,
): ArrowPreviewGeometry {
  const tipLength = Math.min(width * tipSizeRatio, maximumTipLength);
  const tipX = width / 2;
  const backX = tipX - tipLength;
  if (tipShape === "circle") return {
    kind: "circle",
    tipLength,
    tipX,
    shaftEndX: backX,
    centerX: tipX - tipLength / 2,
    radius: tipLength / 2,
  };
  if (tipShape === "square") {
    const diagonalHalf = tipLength / Math.SQRT2;
    const centerX = tipX - diagonalHalf;
    return {
      kind: "square",
      tipLength,
      tipX,
      shaftEndX: tipX - Math.SQRT2 * tipLength,
      points: [
        { x: tipX, y: 0 },
        { x: centerX, y: -diagonalHalf },
        { x: tipX - Math.SQRT2 * tipLength, y: 0 },
        { x: centerX, y: diagonalHalf },
      ],
    };
  }
  const halfHeight = tipLength / 2;
  if (tipShape === "stealth") {
    const notchX = backX + tipLength * 0.375;
    return {
      kind: "stealth",
      tipLength,
      tipX,
      shaftEndX: notchX,
      points: [
        { x: tipX, y: 0 },
        { x: backX, y: -halfHeight },
        { x: notchX, y: 0 },
        { x: backX, y: halfHeight },
      ],
    };
  }
  return {
    kind: "triangle",
    tipLength,
    tipX,
    shaftEndX: backX,
    points: [
      { x: tipX, y: 0 },
      { x: backX, y: -halfHeight },
      { x: backX, y: halfHeight },
    ],
  };
}

/**
 * Resolve the current V3 primitive vocabulary without trusting the generic
 * properties envelope. Malformed, non-finite, mismatched-kind, or out-of-range
 * values never reach SVG or generated Python; each falls back deterministically.
 */
export function resolveShapeGeometry(object: ShapeObject, style: StylePack): ResolvedShapeGeometry | null {
  if (!isCurrentShapeType(object.type)) return null;

  switch (object.type) {
    case "circle":
      return { kind: "circle" };
    case "rectangle": {
      const { width, height } = resolveShapeDimensions(object);
      const maximum = Math.min(PROOFCANVAS_SCHEMA_LIMITS.cornerRadiusMax, width / 2, height / 2);
      const explicit = shapeValue(object, "rectangle", "cornerRadius");
      const inherited = finiteInRange(style.corners.object, 0, PROOFCANVAS_SCHEMA_LIMITS.cornerRadiusMax)
        ? style.corners.object
        : 0;
      const requested = finiteInRange(explicit, 0, PROOFCANVAS_SCHEMA_LIMITS.cornerRadiusMax)
        ? explicit
        : inherited;
      return { kind: "rectangle", cornerRadius: Math.min(requested, maximum) };
    }
    case "line":
      return {
        kind: "line",
        lineCap: enumValue(shapeValue(object, "line", "lineCap"), SHAPE_LINE_CAPS, LEGACY_LINE_CAP),
      };
    case "arrow": {
      const tipSizeRatio = shapeValue(object, "arrow", "tipSizeRatio");
      return {
        kind: "arrow",
        lineCap: enumValue(shapeValue(object, "arrow", "lineCap"), SHAPE_LINE_CAPS, LEGACY_LINE_CAP),
        tipShape: enumValue(shapeValue(object, "arrow", "tipShape"), ARROW_TIP_SHAPES, LEGACY_ARROW_TIP_SHAPE),
        tipSizeRatio: finiteInRange(
          tipSizeRatio,
          MIN_ARROW_TIP_SIZE_RATIO,
          MAX_ARROW_TIP_SIZE_RATIO,
        ) ? tipSizeRatio : LEGACY_ARROW_TIP_SIZE_RATIO,
      };
    }
    case "brace": {
      const explicitDirection = shapeValue(object, "brace", "direction");
      // `orientation` is the only pre-resolver brace direction field retained
      // by published documents. Keep it readable without accepting aliases.
      const legacyDirection = object.properties.orientation;
      const direction = enumValue(
        explicitDirection === undefined ? legacyDirection : explicitDirection,
        BRACE_DIRECTIONS,
        LEGACY_BRACE_DIRECTION,
      );
      const explicitSpacing = shapeValue(object, "brace", "spacing");
      return {
        kind: "brace",
        direction,
        spacing: finiteInRange(explicitSpacing, 0, PROOFCANVAS_SCHEMA_LIMITS.spacingMax)
          ? explicitSpacing
          : LEGACY_BRACE_SPACING,
      };
    }
  }
}

/** One paint decision for browser primitives, arrow tips, and Manim decorators. */
export function resolveShapePaint(object: ShapeObject, style: StylePack): ResolvedShapePaint | null {
  if (!isCurrentShapeType(object.type)) return null;
  const fallbackStroke = validHex(style.colors.ink) ? style.colors.ink : "#000000";
  const stroke = validHex(object.style.stroke)
    ? object.style.stroke
    : fallbackStroke;
  const defaultFill = object.type === "rectangle"
    ? validHex(style.colors.ink) ? style.colors.ink : "#000000"
    : object.type === "circle"
      ? validHex(style.colors.background) ? style.colors.background : "#ffffff"
      : null;
  const fill = defaultFill !== null && validHex(object.style.fill) ? object.style.fill : defaultFill;
  const fallbackStrokeWidth = finiteInRange(style.strokes.regular, 0, PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax)
    ? style.strokes.regular
    : 0;
  const strokeWidth = finiteInRange(object.style.strokeWidth, 0, PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax)
    ? object.style.strokeWidth
    : fallbackStrokeWidth;
  const opacity = finiteInRange(object.style.opacity, 0, 1) ? object.style.opacity : 1;
  const labelColor = validHex(style.colors.warmAccent) ? style.colors.warmAccent : stroke;
  return { fill, stroke, strokeWidth, opacity, labelColor };
}

/** Remove trigonometric tail bits before endpoints reach editable form fields. */
function stableEndpointCoordinate(value: number): number {
  const stable = Number(value.toPrecision(15));
  return Object.is(stable, -0) ? 0 : stable;
}

/** Endpoints of the rendered local X axis after signed X scale and rotation. */
export function lineEndpointsForTransform(transform: SceneObject["transform"]): LineEndpoints | null {
  const { x, y, rotation, scaleX } = transform;
  const { width } = resolveShapeDimensions({ transform });
  if (
    !finiteInRange(x, -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude)
    || !finiteInRange(y, -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude)
    || !finiteInRange(rotation, -PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude)
    || typeof scaleX !== "number"
    || !Number.isFinite(scaleX)
    || Math.abs(scaleX) < PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude
    || Math.abs(scaleX) > PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude
  ) return null;
  const radians = rotation * Math.PI / 180;
  const half = width * scaleX / 2;
  const dx = Math.cos(radians) * half;
  const dy = Math.sin(radians) * half;
  return {
    start: { x: stableEndpointCoordinate(x - dx), y: stableEndpointCoordinate(y - dy) },
    end: { x: stableEndpointCoordinate(x + dx), y: stableEndpointCoordinate(y + dy) },
  };
}

function normalizedRotation(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function snapNear(value: number, reference: number | undefined): number {
  if (
    typeof reference === "number"
    && Number.isFinite(reference)
    && Math.abs(value - reference) <= NUMERIC_EPSILON * Math.max(1, Math.abs(reference))
  ) return reference;
  return Object.is(value, -0) ? 0 : value;
}

/** Keep the template's equivalent full-turn representation when it is in bounds. */
function rotationNearestTemplate(base: number, templateRotation: number): number | null {
  if (!finiteInRange(
    templateRotation,
    -PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude,
    PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude,
  )) return null;

  const normalized = normalizedRotation(base);
  if (Math.abs(normalizedRotation(normalized - templateRotation)) <= NUMERIC_EPSILON) {
    return templateRotation;
  }
  const minimumTurns = Math.ceil(
    (-PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude - normalized) / 360,
  );
  const maximumTurns = Math.floor(
    (PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude - normalized) / 360,
  );
  if (minimumTurns > maximumTurns) return null;
  const nearestTurns = Math.round((templateRotation - normalized) / 360);
  const turns = Math.min(maximumTurns, Math.max(minimumTurns, nearestTurns));
  return normalized + turns * 360;
}

/**
 * Reconstruct a line transform while preserving the template's signed scale.
 * Equal endpoints or a result outside the existing transform schema bounds are
 * refused instead of being silently clamped.
 */
export function transformFromLineEndpoints(
  template: SceneObject["transform"],
  endpoints: LineEndpoints,
): SceneObject["transform"] | null {
  const values = [endpoints.start.x, endpoints.start.y, endpoints.end.x, endpoints.end.y, template.scaleX];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  if (
    Math.abs(template.scaleX) < PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude
    || Math.abs(template.scaleX) > PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude
    || typeof template.scaleY !== "number"
    || !Number.isFinite(template.scaleY)
    || Math.abs(template.scaleY) < PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude
    || Math.abs(template.scaleY) > PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude
    || (template.height !== undefined && !finiteInRange(
      template.height,
      PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin,
      PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax,
    ))
  ) return null;

  const dx = endpoints.end.x - endpoints.start.x;
  const dy = endpoints.end.y - endpoints.start.y;
  const displayedLength = Math.hypot(dx, dy);
  if (!(displayedLength > 0)) return null;
  const rawWidth = displayedLength / Math.abs(template.scaleX);
  if (
    rawWidth < PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin - NUMERIC_EPSILON
    || rawWidth > PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax + NUMERIC_EPSILON
  ) return null;
  const width = snapNear(rawWidth, template.width);
  const x = snapNear((endpoints.start.x + endpoints.end.x) / 2, template.x);
  const y = snapNear((endpoints.start.y + endpoints.end.y) / 2, template.y);
  if (
    !finiteInRange(x, -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude)
    || !finiteInRange(y, -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude)
  ) return null;

  const endpointAngle = Math.atan2(dy, dx) * 180 / Math.PI;
  const rotation = rotationNearestTemplate(
    endpointAngle - (template.scaleX < 0 ? 180 : 0),
    template.rotation,
  );
  if (rotation === null) return null;
  return {
    ...template,
    x,
    y,
    width: Math.min(PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax, Math.max(PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin, width)),
    rotation,
  };
}

export const lineTransformFromEndpoints = transformFromLineEndpoints;
