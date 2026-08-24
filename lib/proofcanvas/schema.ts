import { z } from "zod";

export const PROJECT_SCHEMA_VERSION = 2 as const;
export const PROOFCANVAS_TIME_EPSILON = 1e-9;
export const PROOFCANVAS_PROJECT_MAX_BYTES = 2 * 1024 * 1024;
export const PROOFCANVAS_RENDER_SOURCE_MAX_BYTES = 512 * 1024;
export const PROOFCANVAS_TEXT_MAX_CHARS = 4_096;
export const PROOFCANVAS_LATEX_MAX_CHARS = 500;
export const PROOFCANVAS_BRACE_LABEL_MAX_CHARS = 500;
export const PROOFCANVAS_JSON_KEY_MAX_CHARS = 120;

/**
 * Structural ceilings keep both interactive editing and public API validation
 * predictably bounded. These are format limits, not renderer capacity claims.
 */
export const PROOFCANVAS_SCHEMA_LIMITS = Object.freeze({
  styles: 8,
  shots: 24,
  objectsPerShot: 256,
  animationsPerShot: 256,
  assets: 256,
  propertyTracksPerShot: 512,
  keyframesPerTrack: 512,
  audioClipsPerShot: 64,
  captionClipsPerShot: 256,
  markersPerShot: 256,
  customEasings: 64,
  animationTargets: 64,
  animationProperties: 8,
  operationObjectIds: 64,
  jsonArrayItems: 256,
  jsonValueDepth: 16,
  hierarchyDepth: 16,
  graphsPerProject: 8,
  animationLeafExpansionsPerProject: 4_096,
  compilerExpandedTargetsPerProject: 1_024,
  hierarchyTargetIssuesPerShot: 16,
  overlapIssuesPerShot: 16,
  animationCoordinateMagnitude: 4_096,
  animationDimensionMin: 1,
  animationDimensionMax: 4_096,
  animationRotationMagnitude: 3_600,
  animationScaleMinMagnitude: 0.01,
  animationScaleMaxMagnitude: 100,
  cameraZoomMin: 0.05,
  cameraZoomMax: 20,
  strokeWidthMax: 64,
  fontSizeMin: 1,
  fontSizeMax: 256,
  graphRangeMagnitude: 10_000,
  expressionConstantMagnitude: 1_000_000,
  typographyScaleMin: 0.1,
  typographyScaleMax: 10,
  spacingMax: 4_096,
  cornerRadiusMax: 512,
  hierarchyContrastMax: 100,
} as const);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const JsonKeySchema = z.string().max(PROOFCANVAS_JSON_KEY_MAX_CHARS);

/** Exact UTF-8 byte length without depending on Node-only Buffer or browser TextEncoder globals. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const JsonScalarSchema: z.ZodType<JsonValue> = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(PROOFCANVAS_PROJECT_MAX_BYTES),
]);
const jsonValueSchemas = new Map<number, z.ZodType<JsonValue>>();

function jsonValueSchemaAtDepth(depth: number): z.ZodType<JsonValue> {
  const cached = jsonValueSchemas.get(depth);
  if (cached) return cached;
  const schema: z.ZodType<JsonValue> = depth >= PROOFCANVAS_SCHEMA_LIMITS.jsonValueDepth
    ? JsonScalarSchema
    : z.lazy(() => z.union([
      z.null(),
      z.boolean(),
      z.number().finite(),
      z.string().max(PROOFCANVAS_PROJECT_MAX_BYTES),
      z.array(jsonValueSchemaAtDepth(depth + 1)).max(PROOFCANVAS_SCHEMA_LIMITS.jsonArrayItems),
      z.record(JsonKeySchema, jsonValueSchemaAtDepth(depth + 1)),
    ]));
  jsonValueSchemas.set(depth, schema);
  return schema;
}

export const JsonValueSchema = jsonValueSchemaAtDepth(0);

const IdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/i).max(96);
const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const EasingSchema = z.enum([
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "editorial",
  "spring-soft",
]);

export const AspectRatioSchema = z.enum(["16:9", "9:16", "1:1"]);
export const FrameRateSchema = z.union([z.literal(15), z.literal(24), z.literal(30), z.literal(60)]);
export const ResolutionPresetSchema = z.enum(["draft", "720p", "1080p"]);
export const PreviewQualitySchema = z.enum(["draft", "standard", "high"]);

export const ProjectSettingsSchema = z.object({
  aspectRatio: AspectRatioSchema,
  frameRate: FrameRateSchema,
  resolution: z.object({
    width: z.number().int().min(240).max(3840),
    height: z.number().int().min(240).max(3840),
  }).strict(),
  renderPreset: ResolutionPresetSchema,
  previewQuality: PreviewQualitySchema,
}).strict();

export const CubicBezierSchema = z.object({
  x1: z.number().finite().min(0).max(1),
  y1: z.number().finite().min(-4).max(4),
  x2: z.number().finite().min(0).max(1),
  y2: z.number().finite().min(-4).max(4),
}).strict();

export const KeyframeInterpolationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hold") }).strict(),
  z.object({ kind: z.literal("linear") }).strict(),
  z.object({ kind: z.literal("eased"), easing: EasingSchema }).strict(),
  z.object({ kind: z.literal("custom-bezier"), curve: CubicBezierSchema }).strict(),
]);

export const ObjectTypeSchema = z.enum([
  "text",
  "math",
  "circle",
  "rectangle",
  "line",
  "arrow",
  "brace",
  "axes",
  "graph",
  "image",
  "svg",
  "group",
]);

export const AnimationTypeSchema = z.enum([
  "appear",
  "fade-in",
  "fade-out",
  "write",
  "create",
  "move",
  "scale",
  "transform",
  "emphasise",
  "camera-focus",
]);

type AnimationKind = z.infer<typeof AnimationTypeSchema>;

const AnimationCoordinateSchema = z.number().finite()
  .min(-PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude)
  .max(PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude);
const AnimationDimensionSchema = z.number().finite().positive()
  .min(PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin)
  .max(PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax);
const AnimationRotationSchema = z.number().finite()
  .min(-PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude)
  .max(PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude);
const AnimationSignedScaleSchema = z.number().finite().refine(
  (value) => (
    Math.abs(value) >= PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude
    && Math.abs(value) <= PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude
  ),
  `Scale magnitude must be between ${PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude} and ${PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude}`,
);
const AnimationPositiveScaleSchema = z.number().finite()
  .min(PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude)
  .max(PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude);
const CameraZoomSchema = z.number().finite()
  .min(PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMin)
  .max(PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMax);

const ANIMATION_PROPERTY_RULES = {
  "appear": {},
  "fade-in": {},
  "fade-out": {},
  "write": {},
  "create": {},
  "move": {
    x: AnimationCoordinateSchema,
    y: AnimationCoordinateSchema,
    deltaX: AnimationCoordinateSchema,
    deltaY: AnimationCoordinateSchema,
  },
  "scale": {
    scale: AnimationSignedScaleSchema,
    scaleX: AnimationSignedScaleSchema,
    scaleY: AnimationSignedScaleSchema,
  },
  "transform": {
    x: AnimationCoordinateSchema,
    y: AnimationCoordinateSchema,
    width: AnimationDimensionSchema,
    height: AnimationDimensionSchema,
    rotation: AnimationRotationSchema,
    scaleX: AnimationSignedScaleSchema,
    scaleY: AnimationSignedScaleSchema,
  },
  "emphasise": { scale: AnimationPositiveScaleSchema },
  "camera-focus": {
    x: AnimationCoordinateSchema,
    y: AnimationCoordinateSchema,
    zoom: CameraZoomSchema,
    rotation: AnimationRotationSchema,
  },
} satisfies Record<AnimationKind, Readonly<Record<string, z.ZodType<number>>>>;

const ANIMATION_PATCH_PROPERTY_RULES: Readonly<Record<string, z.ZodType<number>>> = {
  x: AnimationCoordinateSchema,
  y: AnimationCoordinateSchema,
  deltaX: AnimationCoordinateSchema,
  deltaY: AnimationCoordinateSchema,
  width: AnimationDimensionSchema,
  height: AnimationDimensionSchema,
  rotation: AnimationRotationSchema,
  scale: AnimationSignedScaleSchema,
  scaleX: AnimationSignedScaleSchema,
  scaleY: AnimationSignedScaleSchema,
  zoom: CameraZoomSchema,
};

function validateAnimationProperties(
  properties: Readonly<Record<string, JsonValue>>,
  rules: Readonly<Record<string, z.ZodType<number>>>,
  context: z.RefinementCtx,
  pathPrefix: readonly (string | number)[] = [],
): void {
  const keys = Object.keys(properties);
  if (keys.length > PROOFCANVAS_SCHEMA_LIMITS.animationProperties) return;
  for (const key of keys) {
    const rule = rules[key];
    if (!rule) {
      context.addIssue({
        code: "custom",
        path: [...pathPrefix, key],
        message: `Animation property ${key} is not supported for this animation type`,
      });
      continue;
    }
    const parsed = rule.safeParse(properties[key]);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        path: [...pathPrefix, key],
        message: parsed.error.issues[0]?.message ?? `Animation property ${key} is invalid`,
      });
    }
  }
}

const AnimationPropertiesSchema = z.record(z.string().max(64), JsonValueSchema).superRefine((properties, context) => {
  if (Object.keys(properties).length > PROOFCANVAS_SCHEMA_LIMITS.animationProperties) {
    context.addIssue({
      code: "custom",
      message: `Animation properties may contain at most ${PROOFCANVAS_SCHEMA_LIMITS.animationProperties} entries`,
    });
  }
});

const AnimationPropertyPatchSchema = AnimationPropertiesSchema.superRefine((properties, context) => {
  validateAnimationProperties(properties, ANIMATION_PATCH_PROPERTY_RULES, context);
});

export const RestrictedExpressionSchema: z.ZodType<RestrictedExpression> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("constant"),
      value: z.number().finite()
        .min(-PROOFCANVAS_SCHEMA_LIMITS.expressionConstantMagnitude)
        .max(PROOFCANVAS_SCHEMA_LIMITS.expressionConstantMagnitude),
    }).strict(),
    z.object({ kind: z.literal("variable") }).strict(),
    z.object({
      kind: z.enum(["add", "subtract", "multiply", "divide"]),
      left: RestrictedExpressionSchema,
      right: RestrictedExpressionSchema,
    }).strict(),
    z.object({
      kind: z.literal("power"),
      base: RestrictedExpressionSchema,
      exponent: z.number().int().min(-8).max(8),
    }).strict(),
    z.object({
      kind: z.enum(["sin", "cos", "abs", "negate"]),
      value: RestrictedExpressionSchema,
    }).strict(),
  ]),
);

export type RestrictedExpression =
  | { kind: "constant"; value: number }
  | { kind: "variable" }
  | {
      kind: "add" | "subtract" | "multiply" | "divide";
      left: RestrictedExpression;
      right: RestrictedExpression;
    }
  | { kind: "power"; base: RestrictedExpression; exponent: number }
  | { kind: "sin" | "cos" | "abs" | "negate"; value: RestrictedExpression };

export const TransformSchema = z.object({
  x: AnimationCoordinateSchema,
  y: AnimationCoordinateSchema,
  width: AnimationDimensionSchema.optional(),
  height: AnimationDimensionSchema.optional(),
  rotation: AnimationRotationSchema.default(0),
  scaleX: AnimationSignedScaleSchema.default(1),
  scaleY: AnimationSignedScaleSchema.default(1),
}).strict();

export const ObjectStyleSchema = z.object({
  fill: HexColorSchema.optional(),
  stroke: HexColorSchema.optional(),
  color: HexColorSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
  strokeWidth: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax).optional(),
  fontSize: z.number().finite()
    .min(PROOFCANVAS_SCHEMA_LIMITS.fontSizeMin)
    .max(PROOFCANVAS_SCHEMA_LIMITS.fontSizeMax)
    .optional(),
  fontFamily: z.string().max(120).optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  textAlign: z.enum(["left", "center", "right"]).optional(),
  roughEmphasis: z.boolean().optional(),
}).strict();

export const ObjectLifetimeSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
}).strict().refine(({ start, end }) => end > start + PROOFCANVAS_TIME_EPSILON, {
  message: "Object lifetime end must be after its start",
  path: ["end"],
});

export const AssetMetadataSchema = z.object({
  id: IdSchema,
  filename: z.string().min(1).max(240).refine((value) => !/[\\/\u0000]/.test(value), "Asset filename must not contain a path"),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "audio/wav", "audio/mpeg", "audio/mp4"]),
  size: z.number().int().positive().max(512 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().positive().max(16_384).optional(),
  height: z.number().int().positive().max(16_384).optional(),
  duration: z.number().finite().positive().max(7_200).optional(),
  provenance: z.enum(["uploaded", "generated", "bundled", "legacy-import"]),
}).strict();

export const CustomEasingPresetSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(80),
  curve: CubicBezierSchema,
}).strict();

export const ObjectAnimatablePropertySchema = z.enum([
  "x", "y", "width", "height", "scale", "scaleX", "scaleY", "rotation",
  "opacity", "fill", "stroke", "strokeWidth",
]);
export const CameraAnimatablePropertySchema = z.enum(["x", "y", "zoom", "rotation"]);
export const AudioAnimatablePropertySchema = z.literal("volume");

export type VisualStyleProperty = "color" | "fill" | "stroke" | "strokeWidth" | "opacity";

/** Shared browser/compiler capability contract for visual style application. */
export function objectTypeSupportsStyleProperty(objectType: string, property: VisualStyleProperty): boolean {
  if (property === "opacity") return true;
  if (objectType === "group") return true;
  if (objectType === "image" || objectType === "svg") return false;
  if (property === "fill") return ["text", "math", "circle", "rectangle"].includes(objectType);
  if (property === "stroke" || property === "strokeWidth") return ["circle", "rectangle", "line", "arrow", "brace", "axes", "graph"].includes(objectType);
  return objectType === "text" || objectType === "math";
}

export const PropertyTrackTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("object"), objectId: IdSchema }).strict(),
  z.object({ kind: z.literal("camera") }).strict(),
  z.object({ kind: z.literal("audio"), audioClipId: IdSchema }).strict(),
]);

export const PropertyKeyframeSchema = z.object({
  id: IdSchema,
  time: z.number().finite().nonnegative(),
  value: z.union([z.number().finite(), HexColorSchema]),
  interpolation: KeyframeInterpolationSchema,
}).strict();

export const PropertyTrackSchema = z.object({
  id: IdSchema,
  target: PropertyTrackTargetSchema,
  property: z.union([ObjectAnimatablePropertySchema, CameraAnimatablePropertySchema, AudioAnimatablePropertySchema]),
  keyframes: z.array(PropertyKeyframeSchema).min(1).max(PROOFCANVAS_SCHEMA_LIMITS.keyframesPerTrack),
}).strict();

export const AudioClipSchema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  name: z.string().trim().min(1).max(120),
  start: z.number().finite().nonnegative(),
  duration: z.number().finite().positive().max(7_200),
  sourceStart: z.number().finite().nonnegative(),
  sourceEnd: z.number().finite().positive().max(7_200),
  volume: z.number().finite().min(0).max(4),
  muted: z.boolean(),
  solo: z.boolean(),
}).strict().refine(({ sourceStart, sourceEnd }) => sourceEnd > sourceStart + PROOFCANVAS_TIME_EPSILON, {
  message: "Audio source end must be after its start",
  path: ["sourceEnd"],
});

export const CaptionClipSchema = z.object({
  id: IdSchema,
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  text: z.string().min(1).max(PROOFCANVAS_TEXT_MAX_CHARS),
  style: z.object({
    color: HexColorSchema.optional(),
    background: HexColorSchema.optional(),
    fontSize: z.number().finite().min(8).max(144).optional(),
    position: z.enum(["top", "center", "bottom"]).optional(),
  }).strict(),
}).strict().refine(({ start, end }) => end > start + PROOFCANVAS_TIME_EPSILON, {
  message: "Caption end must be after its start",
  path: ["end"],
});

export const TimelineMarkerSchema = z.object({
  id: IdSchema,
  time: z.number().finite().nonnegative(),
  name: z.string().trim().min(1).max(120),
  color: HexColorSchema,
}).strict();

const GraphRangeSchema = z.number().finite()
  .min(-PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude)
  .max(PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude);

const SAFE_LATEX_BLOCKLIST = /\\(?:input|include|write|openin|openout|read|usepackage|catcode|csname|newcommand|renewcommand|def|special)\b/i;
const SAFE_LATEX_COMMANDS = new Set([
  "abs", "alpha", "beta", "cdot", "cos", "delta", "epsilon", "frac", "gamma",
  "ge", "infty", "int", "lambda", "le", "left", "lim", "ln", "log", "mathbb",
  "mathbf", "mathrm", "neq", "overline", "pi", "prod", "right", "sin", "sqrt",
  "sum", "tan", "text", "theta", "times", "to", "underline", "varphi",
]);

export function isSafeLatex(value: string): boolean {
  if (value.length > PROOFCANVAS_LATEX_MAX_CHARS || SAFE_LATEX_BLOCKLIST.test(value) || /(?:\.\.[/\\]|\^\^|[\u0000-\u001f])/.test(value)) return false;
  const commands = [...value.matchAll(/\\([a-zA-Z]+)/g)].map((match) => match[1]);
  return commands.every((command) => SAFE_LATEX_COMMANDS.has(command));
}

export function isSafeAssetSource(value: string): boolean {
  if (value.length > PROOFCANVAS_PROJECT_MAX_BYTES) return false;
  return (/^\/proofcanvas\/[a-z0-9_./-]+$/i.test(value) && !value.includes("..") && !value.includes("//"))
    || /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value);
}

function restrictedExpressionWithinLimits(expression: RestrictedExpression, depth = 0, count = { value: 0 }): boolean {
  count.value += 1;
  if (depth > 12 || count.value > 64) return false;
  if (expression.kind === "add" || expression.kind === "subtract" || expression.kind === "multiply" || expression.kind === "divide") {
    return restrictedExpressionWithinLimits(expression.left, depth + 1, count)
      && restrictedExpressionWithinLimits(expression.right, depth + 1, count);
  }
  if (expression.kind === "power") return restrictedExpressionWithinLimits(expression.base, depth + 1, count);
  if (expression.kind === "sin" || expression.kind === "cos" || expression.kind === "abs" || expression.kind === "negate") {
    return restrictedExpressionWithinLimits(expression.value, depth + 1, count);
  }
  return true;
}

export const SceneObjectSchema = z.object({
  id: IdSchema,
  type: ObjectTypeSchema,
  name: z.string().min(1).max(120),
  parentId: IdSchema.optional(),
  locked: z.boolean(),
  visible: z.boolean(),
  lifetime: ObjectLifetimeSchema.optional(),
  transform: TransformSchema,
  style: ObjectStyleSchema,
  semanticRole: z.string().min(1).max(120).optional(),
  properties: z.record(JsonKeySchema, JsonValueSchema),
}).strict().superRefine((object, context) => {
  const content = object.properties.content;
  if ((object.type === "text" || object.type === "math") && typeof content !== "string") {
    context.addIssue({ code: "custom", path: ["properties", "content"], message: `${object.type} requires string content` });
  }
  if (object.type === "math" && typeof content === "string" && !isSafeLatex(content)) {
    context.addIssue({ code: "custom", path: ["properties", "content"], message: "Math content contains a forbidden LaTeX command" });
  }
  if (object.type === "text" && typeof content === "string" && content.length > PROOFCANVAS_TEXT_MAX_CHARS) {
    context.addIssue({ code: "custom", path: ["properties", "content"], message: `Text content may contain at most ${PROOFCANVAS_TEXT_MAX_CHARS} characters` });
  }
  if (object.type === "brace" && typeof object.properties.label !== "string") {
    context.addIssue({ code: "custom", path: ["properties", "label"], message: "Brace requires a label" });
  }
  if (object.type === "brace" && typeof object.properties.label === "string" && object.properties.label.length > PROOFCANVAS_BRACE_LABEL_MAX_CHARS) {
    context.addIssue({ code: "custom", path: ["properties", "label"], message: `Brace labels may contain at most ${PROOFCANVAS_BRACE_LABEL_MAX_CHARS} characters` });
  }
  if (object.type === "axes") {
    for (const key of ["xMin", "xMax", "yMin", "yMax"] as const) {
      if (!GraphRangeSchema.safeParse(object.properties[key]).success) {
        context.addIssue({ code: "custom", path: ["properties", key], message: `Axes requires bounded numeric ${key}` });
      }
    }
    if (
      typeof object.properties.xMin === "number"
      && typeof object.properties.xMax === "number"
      && object.properties.xMin >= object.properties.xMax
    ) context.addIssue({ code: "custom", path: ["properties", "xMax"], message: "Axes xMax must be greater than xMin" });
    if (
      typeof object.properties.yMin === "number"
      && typeof object.properties.yMax === "number"
      && object.properties.yMin >= object.properties.yMax
    ) context.addIssue({ code: "custom", path: ["properties", "yMax"], message: "Axes yMax must be greater than yMin" });
  }
  if (object.type === "graph") {
    const parsed = RestrictedExpressionSchema.safeParse(object.properties.expression);
    if (!parsed.success || !restrictedExpressionWithinLimits(parsed.data)) {
      context.addIssue({ code: "custom", path: ["properties", "expression"], message: "Graph requires a restricted expression tree" });
    }
    for (const key of ["xMin", "xMax"] as const) {
      if (!GraphRangeSchema.safeParse(object.properties[key]).success) {
        context.addIssue({ code: "custom", path: ["properties", key], message: `Graph requires bounded numeric ${key}` });
      }
    }
    if (
      typeof object.properties.xMin === "number"
      && typeof object.properties.xMax === "number"
      && object.properties.xMin >= object.properties.xMax
    ) context.addIssue({ code: "custom", path: ["properties", "xMax"], message: "Graph xMax must be greater than xMin" });
  }
  if (object.type === "image" || object.type === "svg") {
    const source = object.properties.source;
    const assetId = object.properties.assetId;
    if ((typeof assetId !== "string" || !IdSchema.safeParse(assetId).success) && (typeof source !== "string" || !isSafeAssetSource(source))) {
      context.addIssue({ code: "custom", path: ["properties"], message: "Asset object requires a valid assetId or a legacy local ProofCanvas source" });
    }
  }
});

export const SceneAnimationSchema = z.object({
  id: IdSchema,
  type: AnimationTypeSchema,
  targetIds: z.array(IdSchema).min(1).max(PROOFCANVAS_SCHEMA_LIMITS.animationTargets),
  start: z.number().finite().nonnegative(),
  duration: z.number().finite().positive(),
  easing: EasingSchema,
  properties: AnimationPropertiesSchema,
}).strict().superRefine((animation, context) => {
  validateAnimationProperties(animation.properties, ANIMATION_PROPERTY_RULES[animation.type], context, ["properties"]);
  if (
    animation.type === "move"
    && animation.targetIds.length > 1
    && (animation.properties.x !== undefined || animation.properties.y !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ["properties"],
      message: "A multi-target move must use deltaX/deltaY so relative spacing is preserved",
    });
  }
  if (animation.type === "transform" && animation.targetIds.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["targetIds"],
      message: "A transform animation must target exactly one object",
    });
  }
});

export const CameraStateSchema = z.object({
  x: AnimationCoordinateSchema,
  y: AnimationCoordinateSchema,
  zoom: CameraZoomSchema,
  rotation: AnimationRotationSchema.default(0),
}).strict();

export const ShotSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  duration: z.number().finite().positive().max(300),
  objects: z.array(SceneObjectSchema).max(PROOFCANVAS_SCHEMA_LIMITS.objectsPerShot),
  animations: z.array(SceneAnimationSchema).max(PROOFCANVAS_SCHEMA_LIMITS.animationsPerShot),
  propertyTracks: z.array(PropertyTrackSchema).max(PROOFCANVAS_SCHEMA_LIMITS.propertyTracksPerShot).default([]),
  audioClips: z.array(AudioClipSchema).max(PROOFCANVAS_SCHEMA_LIMITS.audioClipsPerShot).default([]),
  captionClips: z.array(CaptionClipSchema).max(PROOFCANVAS_SCHEMA_LIMITS.captionClipsPerShot).default([]),
  markers: z.array(TimelineMarkerSchema).max(PROOFCANVAS_SCHEMA_LIMITS.markersPerShot).default([]),
  camera: CameraStateSchema,
}).strict();

export const StylePackSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  origin: z.enum(["preset", "custom"]).default("custom"),
  colors: z.object({
    background: HexColorSchema,
    ink: HexColorSchema,
    mutedInk: HexColorSchema,
    coolAccent: HexColorSchema,
    warmAccent: HexColorSchema,
    rule: HexColorSchema,
  }).strict(),
  typography: z.object({
    statement: z.string().min(1).max(120),
    controls: z.string().min(1).max(120),
    math: z.string().min(1).max(120),
    titleScale: z.number().finite().min(PROOFCANVAS_SCHEMA_LIMITS.typographyScaleMin).max(PROOFCANVAS_SCHEMA_LIMITS.typographyScaleMax),
    bodyScale: z.number().finite().min(PROOFCANVAS_SCHEMA_LIMITS.typographyScaleMin).max(PROOFCANVAS_SCHEMA_LIMITS.typographyScaleMax),
  }).strict(),
  spacing: z.object({
    unit: z.number().finite().min(PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude).max(PROOFCANVAS_SCHEMA_LIMITS.spacingMax),
    margin: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.spacingMax),
    objectGap: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.spacingMax),
  }).strict(),
  strokes: z.object({
    fine: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax),
    regular: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax),
    emphasis: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax),
  }).strict(),
  corners: z.object({
    panel: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.cornerRadiusMax),
    object: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.cornerRadiusMax),
  }).strict(),
  annotation: z.object({
    treatment: z.enum(["plain", "marginal-hand"]),
    offset: AnimationCoordinateSchema,
    roughness: z.number().finite().min(0).max(1),
  }).strict(),
  graph: z.object({
    gridOpacity: z.number().finite().min(0).max(1),
    axisWeight: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax),
    curveWeight: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax),
  }).strict(),
  layout: z.object({
    tendency: z.enum(["centred", "editorial-asymmetric"]),
    titleAnchor: z.enum(["center", "upper-left"]),
    hierarchyContrast: z.number().finite().min(PROOFCANVAS_SCHEMA_LIMITS.typographyScaleMin).max(PROOFCANVAS_SCHEMA_LIMITS.hierarchyContrastMax),
  }).strict(),
  motion: z.object({
    defaultDuration: z.number().finite().min(PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude).max(300),
    easing: EasingSchema,
    entrance: AnimationTypeSchema,
    exit: AnimationTypeSchema,
    emphasis: AnimationTypeSchema,
    cameraMaxPan: z.number().finite().nonnegative().max(PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude),
    cameraMaxZoom: z.number().finite().min(1).max(PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMax),
  }).strict(),
}).strict();

function trackTargetKey(target: z.infer<typeof PropertyTrackTargetSchema>): string {
  if (target.kind === "object") return `object:${target.objectId}`;
  if (target.kind === "audio") return `audio:${target.audioClipId}`;
  return "camera";
}

export function propertyTrackValueValid(property: string, value: number | string): boolean {
  if (property === "fill" || property === "stroke") return typeof value === "string" && HexColorSchema.safeParse(value).success;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (property === "opacity") return value >= 0 && value <= 1;
  if (property === "volume") return value >= 0 && value <= 4;
  if (property === "strokeWidth") return value >= 0 && value <= PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax;
  if (property === "width" || property === "height") return AnimationDimensionSchema.safeParse(value).success;
  if (property === "scale" || property === "scaleX" || property === "scaleY") return AnimationSignedScaleSchema.safeParse(value).success;
  if (property === "zoom") return CameraZoomSchema.safeParse(value).success;
  if (property === "rotation") return AnimationRotationSchema.safeParse(value).success;
  return AnimationCoordinateSchema.safeParse(value).success;
}

function propertyAllowedForTarget(track: z.infer<typeof PropertyTrackSchema>): boolean {
  if (track.target.kind === "camera") return CameraAnimatablePropertySchema.safeParse(track.property).success;
  if (track.target.kind === "audio") return track.property === "volume";
  return ObjectAnimatablePropertySchema.safeParse(track.property).success;
}

function resolutionFor(aspectRatio: z.infer<typeof AspectRatioSchema>, preset: z.infer<typeof ResolutionPresetSchema>) {
  const longEdge = preset === "draft" ? 854 : preset === "720p" ? 1280 : 1920;
  const shortEdge = preset === "draft" ? 480 : preset === "720p" ? 720 : 1080;
  if (aspectRatio === "16:9") return { width: longEdge, height: shortEdge };
  if (aspectRatio === "9:16") return { width: shortEdge, height: longEdge };
  return { width: shortEdge, height: shortEdge };
}

export const ProjectDocumentSchema = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  metadata: z.object({
    id: IdSchema,
    title: z.string().min(1).max(160),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  settings: ProjectSettingsSchema,
  activeStyleId: IdSchema,
  styles: z.array(StylePackSchema).min(1).max(PROOFCANVAS_SCHEMA_LIMITS.styles),
  customEasings: z.array(CustomEasingPresetSchema).max(PROOFCANVAS_SCHEMA_LIMITS.customEasings).default([]),
  assets: z.array(AssetMetadataSchema).max(PROOFCANVAS_SCHEMA_LIMITS.assets).default([]),
  shots: z.array(ShotSchema).min(1).max(PROOFCANVAS_SCHEMA_LIMITS.shots),
}).strict().superRefine((project, context) => {
  const canonicalBytes = utf8ByteLength(`${JSON.stringify(project, null, 2)}\n`);
  if (canonicalBytes > PROOFCANVAS_PROJECT_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `Canonical project JSON may contain at most ${PROOFCANVAS_PROJECT_MAX_BYTES} UTF-8 bytes`,
    });
    return;
  }

  // Zod reports the precise array limit errors. Avoid relational work over an
  // already oversized document, especially the animation overlap scan.
  if (
    project.styles.length > PROOFCANVAS_SCHEMA_LIMITS.styles
    || project.assets.length > PROOFCANVAS_SCHEMA_LIMITS.assets
    || project.customEasings.length > PROOFCANVAS_SCHEMA_LIMITS.customEasings
    || project.shots.length > PROOFCANVAS_SCHEMA_LIMITS.shots
    || project.shots.some((shot) => (
      shot.objects.length > PROOFCANVAS_SCHEMA_LIMITS.objectsPerShot
      || shot.animations.length > PROOFCANVAS_SCHEMA_LIMITS.animationsPerShot
      || shot.propertyTracks.length > PROOFCANVAS_SCHEMA_LIMITS.propertyTracksPerShot
      || shot.audioClips.length > PROOFCANVAS_SCHEMA_LIMITS.audioClipsPerShot
      || shot.captionClips.length > PROOFCANVAS_SCHEMA_LIMITS.captionClipsPerShot
      || shot.markers.length > PROOFCANVAS_SCHEMA_LIMITS.markersPerShot
      || shot.animations.some((animation) => animation.targetIds.length > PROOFCANVAS_SCHEMA_LIMITS.animationTargets)
      || shot.propertyTracks.some((track) => track.keyframes.length > PROOFCANVAS_SCHEMA_LIMITS.keyframesPerTrack)
    ))
  ) return;

  const expectedResolution = resolutionFor(project.settings.aspectRatio, project.settings.renderPreset);
  if (
    project.settings.resolution.width !== expectedResolution.width
    || project.settings.resolution.height !== expectedResolution.height
  ) {
    context.addIssue({
      code: "custom",
      path: ["settings", "resolution"],
      message: `Resolution must be ${expectedResolution.width}x${expectedResolution.height} for ${project.settings.aspectRatio} ${project.settings.renderPreset}`,
    });
  }

  const registerNamespacedId = (namespace: Set<string>, id: string, path: (string | number)[], label = "ID") => {
    if (namespace.has(id)) context.addIssue({ code: "custom", path, message: `Duplicate ${label} ${id}` });
    namespace.add(id);
  };

  const styleIds = new Set<string>();
  for (let index = 0; index < project.styles.length; index += 1) {
    const id = project.styles[index].id;
    registerNamespacedId(styleIds, id, ["styles", index, "id"], "style ID");
  }
  if (!styleIds.has(project.activeStyleId)) {
    context.addIssue({ code: "custom", path: ["activeStyleId"], message: "Active style does not exist" });
  }

  const customEasingIds = new Set<string>();
  project.customEasings.forEach((preset, index) => registerNamespacedId(customEasingIds, preset.id, ["customEasings", index, "id"], "custom easing ID"));
  const assetIds = new Set<string>();
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  project.assets.forEach((asset, index) => registerNamespacedId(assetIds, asset.id, ["assets", index, "id"], "asset ID"));

  const graphLocations = project.shots.flatMap((shot, shotIndex) => shot.objects
    .map((object, objectIndex) => ({ object, shotIndex, objectIndex }))
    .filter(({ object }) => object.type === "graph"));
  if (graphLocations.length > PROOFCANVAS_SCHEMA_LIMITS.graphsPerProject) {
    const firstExcess = graphLocations[PROOFCANVAS_SCHEMA_LIMITS.graphsPerProject];
    context.addIssue({
      code: "custom",
      path: ["shots", firstExcess.shotIndex, "objects", firstExcess.objectIndex, "type"],
      message: `A project may contain at most ${PROOFCANVAS_SCHEMA_LIMITS.graphsPerProject} graph objects so generated source stays within renderer policy`,
    });
  }

  let compilerExpandedTargets = 0;
  let compilerExpansionIssueAdded = false;
  const timelineIds = new Set<string>();
  project.shots.forEach((shot, shotIndex) => {
    registerNamespacedId(timelineIds, shot.id, ["shots", shotIndex, "id"]);
    const objects = new Map(shot.objects.map((object) => [object.id, object]));
    shot.objects.forEach((object, objectIndex) => {
      registerNamespacedId(timelineIds, object.id, ["shots", shotIndex, "objects", objectIndex, "id"]);
      for (const property of ["fill", "stroke", "strokeWidth"] as const) {
        if (object.style[property] !== undefined && !objectTypeSupportsStyleProperty(object.type, property)) {
          context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "style", property], message: `${object.type} objects do not support ${property} styling` });
        }
      }
      const lifetime = object.lifetime ?? { start: 0, end: shot.duration };
      if (lifetime.end > shot.duration + PROOFCANVAS_TIME_EPSILON) {
        context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "lifetime"], message: "Object lifetime exceeds shot duration" });
      }
      if (object.type === "image" || object.type === "svg") {
        const assetId = object.properties.assetId;
        if (typeof assetId === "string") {
          const asset = assets.get(assetId);
          if (!asset) context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "properties", "assetId"], message: `Missing asset ${assetId}` });
          else if (!asset.mimeType.startsWith("image/")) context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "properties", "assetId"], message: `Asset ${assetId} is not an image` });
        }
      }
      if (object.parentId) {
        const parent = objects.get(object.parentId);
        if (!parent) context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "parentId"], message: `Missing parent ${object.parentId}` });
        else if (parent.type !== "group") context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "parentId"], message: "Parent must be a group" });
        else {
          const parentLifetime = parent.lifetime ?? { start: 0, end: shot.duration };
          if (object.lifetime && (lifetime.start < parentLifetime.start - PROOFCANVAS_TIME_EPSILON || lifetime.end > parentLifetime.end + PROOFCANVAS_TIME_EPSILON)) {
            context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "lifetime"], message: "Child lifetime must be contained by its parent lifetime" });
          }
        }
        const seen = new Set([object.id]);
        let cursor = parent;
        let depth = 0;
        while (cursor) {
          if (seen.has(cursor.id)) {
            context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "parentId"], message: "Parent relationship contains a cycle" });
            break;
          }
          seen.add(cursor.id);
          depth += 1;
          if (depth > PROOFCANVAS_SCHEMA_LIMITS.hierarchyDepth) {
            context.addIssue({
              code: "custom",
              path: ["shots", shotIndex, "objects", objectIndex, "parentId"],
              message: `Object hierarchy exceeds the maximum depth of ${PROOFCANVAS_SCHEMA_LIMITS.hierarchyDepth}`,
            });
            break;
          }
          cursor = cursor.parentId ? objects.get(cursor.parentId) : undefined;
        }
      }
    });
    const effectiveLifetime = (object: z.infer<typeof SceneObjectSchema>) => {
      let start = 0;
      let end = shot.duration;
      let cursor: z.infer<typeof SceneObjectSchema> | undefined = object;
      const visited = new Set<string>();
      for (let depth = 0; cursor && depth <= PROOFCANVAS_SCHEMA_LIMITS.hierarchyDepth; depth += 1) {
        if (visited.has(cursor.id)) break;
        visited.add(cursor.id);
        if (cursor.lifetime) {
          start = Math.max(start, cursor.lifetime.start);
          end = Math.min(end, cursor.lifetime.end);
        }
        cursor = cursor.parentId ? objects.get(cursor.parentId) : undefined;
      }
      return { start, end };
    };
    shot.animations.forEach((animation, animationIndex) => {
      registerNamespacedId(timelineIds, animation.id, ["shots", shotIndex, "animations", animationIndex, "id"]);
      if (animation.start + animation.duration > shot.duration + PROOFCANVAS_TIME_EPSILON) {
        context.addIssue({ code: "custom", path: ["shots", shotIndex, "animations", animationIndex], message: "Animation exceeds shot duration" });
      }
      animation.targetIds.forEach((targetId, targetIndex) => {
        const target = objects.get(targetId);
        if (!target) context.addIssue({ code: "custom", path: ["shots", shotIndex, "animations", animationIndex, "targetIds", targetIndex], message: `Missing animation target ${targetId}` });
        else {
          const lifetime = effectiveLifetime(target);
          if (animation.start < lifetime.start - PROOFCANVAS_TIME_EPSILON || animation.start + animation.duration > lifetime.end + PROOFCANVAS_TIME_EPSILON) {
            context.addIssue({ code: "custom", path: ["shots", shotIndex, "animations", animationIndex, "targetIds", targetIndex], message: `Animation must be contained by target ${targetId}'s lifetime` });
          }
        }
      });
      if (animation.type === "transform") {
        for (const dimension of ["width", "height"] as const) {
          if (animation.properties[dimension] === undefined) continue;
          const missingDimension = animation.targetIds.find((targetId) => objects.get(targetId)?.transform[dimension] === undefined);
          if (missingDimension) {
            context.addIssue({
              code: "custom",
              path: ["shots", shotIndex, "animations", animationIndex, "properties", dimension],
              message: `Transform ${dimension} requires authored ${dimension} on every target; ${missingDimension} does not define it`,
            });
          }
        }
      }
    });

    const audioClips = new Map(shot.audioClips.map((clip) => [clip.id, clip]));
    shot.audioClips.forEach((clip, clipIndex) => {
      registerNamespacedId(timelineIds, clip.id, ["shots", shotIndex, "audioClips", clipIndex, "id"]);
      const asset = assets.get(clip.assetId);
      if (!asset) context.addIssue({ code: "custom", path: ["shots", shotIndex, "audioClips", clipIndex, "assetId"], message: `Missing asset ${clip.assetId}` });
      else if (!asset.mimeType.startsWith("audio/")) context.addIssue({ code: "custom", path: ["shots", shotIndex, "audioClips", clipIndex, "assetId"], message: `Asset ${clip.assetId} is not audio` });
      else if (asset.duration !== undefined && clip.sourceEnd > asset.duration + PROOFCANVAS_TIME_EPSILON) {
        context.addIssue({ code: "custom", path: ["shots", shotIndex, "audioClips", clipIndex, "sourceEnd"], message: "Audio source range exceeds asset duration" });
      }
      if (clip.start + clip.duration > shot.duration + PROOFCANVAS_TIME_EPSILON) {
        context.addIssue({ code: "custom", path: ["shots", shotIndex, "audioClips", clipIndex], message: "Audio clip exceeds shot duration" });
      }
    });
    shot.captionClips.forEach((clip, clipIndex) => {
      registerNamespacedId(timelineIds, clip.id, ["shots", shotIndex, "captionClips", clipIndex, "id"]);
      if (clip.end > shot.duration + PROOFCANVAS_TIME_EPSILON) {
        context.addIssue({ code: "custom", path: ["shots", shotIndex, "captionClips", clipIndex, "end"], message: "Caption exceeds shot duration" });
      }
    });
    shot.markers.forEach((marker, markerIndex) => {
      registerNamespacedId(timelineIds, marker.id, ["shots", shotIndex, "markers", markerIndex, "id"]);
      if (marker.time > shot.duration + PROOFCANVAS_TIME_EPSILON) {
        context.addIssue({ code: "custom", path: ["shots", shotIndex, "markers", markerIndex, "time"], message: "Marker exceeds shot duration" });
      }
    });

    const targetPropertyTracks = new Map<string, number>();
    shot.propertyTracks.forEach((track, trackIndex) => {
      registerNamespacedId(timelineIds, track.id, ["shots", shotIndex, "propertyTracks", trackIndex, "id"]);
      const targetPropertyKey = `${trackTargetKey(track.target)}:${track.property}`;
      const priorTrackIndex = targetPropertyTracks.get(targetPropertyKey);
      if (priorTrackIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["shots", shotIndex, "propertyTracks", trackIndex],
          message: `Property track conflicts with propertyTracks[${priorTrackIndex}]; only one track per target/property is allowed`,
        });
      } else targetPropertyTracks.set(targetPropertyKey, trackIndex);

      if (!propertyAllowedForTarget(track)) {
        context.addIssue({ code: "custom", path: ["shots", shotIndex, "propertyTracks", trackIndex, "property"], message: `Property ${track.property} is not valid for ${track.target.kind} tracks` });
      }

      let range = { start: 0, end: shot.duration };
      if (track.target.kind === "object") {
        const target = objects.get(track.target.objectId);
        if (!target) context.addIssue({ code: "custom", path: ["shots", shotIndex, "propertyTracks", trackIndex, "target", "objectId"], message: `Missing track target ${track.target.objectId}` });
        else {
          range = effectiveLifetime(target);
          if (["fill", "stroke", "strokeWidth", "opacity"].includes(track.property) && !objectTypeSupportsStyleProperty(target.type, track.property as VisualStyleProperty)) {
            context.addIssue({ code: "custom", path: ["shots", shotIndex, "propertyTracks", trackIndex, "property"], message: `${target.type} objects do not support ${track.property} tracks` });
          }
        }
      } else if (track.target.kind === "audio") {
        const target = audioClips.get(track.target.audioClipId);
        if (!target) context.addIssue({ code: "custom", path: ["shots", shotIndex, "propertyTracks", trackIndex, "target", "audioClipId"], message: `Missing audio track target ${track.target.audioClipId}` });
        else range = { start: target.start, end: target.start + target.duration };
      }

      let priorTime: number | undefined;
      track.keyframes.forEach((keyframe, keyframeIndex) => {
        registerNamespacedId(timelineIds, keyframe.id, ["shots", shotIndex, "propertyTracks", trackIndex, "keyframes", keyframeIndex, "id"]);
        if (!propertyTrackValueValid(track.property, keyframe.value)) {
          context.addIssue({ code: "custom", path: ["shots", shotIndex, "propertyTracks", trackIndex, "keyframes", keyframeIndex, "value"], message: `Keyframe value is invalid for ${track.property}` });
        }
        if (priorTime !== undefined && keyframe.time <= priorTime + PROOFCANVAS_TIME_EPSILON) {
          context.addIssue({ code: "custom", path: ["shots", shotIndex, "propertyTracks", trackIndex, "keyframes", keyframeIndex, "time"], message: "Keyframes must be strictly ordered with one keyframe per time" });
        }
        priorTime = keyframe.time;
        if (keyframe.time < range.start - PROOFCANVAS_TIME_EPSILON || keyframe.time > range.end + PROOFCANVAS_TIME_EPSILON) {
          context.addIssue({ code: "custom", path: ["shots", shotIndex, "propertyTracks", trackIndex, "keyframes", keyframeIndex, "time"], message: "Keyframe time must be inside its target lifetime" });
        }
      });
    });

    const childrenByParent = new Map<string, string[]>();
    for (const object of shot.objects) {
      if (!object.parentId) continue;
      childrenByParent.set(object.parentId, [...(childrenByParent.get(object.parentId) ?? []), object.id]);
    }
    const leafCountCache = new Map<string, number>();
    const expandedLeafCount = (objectId: string, visiting = new Set<string>()): number => {
      const cached = leafCountCache.get(objectId);
      if (cached !== undefined) return cached;
      const object = objects.get(objectId);
      if (!object) return 0;
      if (object.type !== "group") return 1;
      if (visiting.has(objectId)) return PROOFCANVAS_SCHEMA_LIMITS.animationLeafExpansionsPerProject + 1;
      const nextVisiting = new Set(visiting).add(objectId);
      let count = 0;
      for (const childId of childrenByParent.get(objectId) ?? []) {
        count += expandedLeafCount(childId, nextVisiting);
        if (count > PROOFCANVAS_SCHEMA_LIMITS.animationLeafExpansionsPerProject) break;
      }
      leafCountCache.set(objectId, count);
      return count;
    };
    const addCompilerWork = (amount: number, path: (string | number)[]) => {
      if (compilerExpansionIssueAdded) return;
      compilerExpandedTargets += amount;
      if (compilerExpandedTargets > PROOFCANVAS_SCHEMA_LIMITS.compilerExpandedTargetsPerProject) {
        context.addIssue({
          code: "custom",
          path,
          message: `Expanded compiler targets exceed the project limit of ${PROOFCANVAS_SCHEMA_LIMITS.compilerExpandedTargetsPerProject} operations`,
        });
        compilerExpansionIssueAdded = true;
      }
    };
    if (!compilerExpansionIssueAdded) {
      expansionScan:
      for (let animationIndex = 0; animationIndex < shot.animations.length; animationIndex += 1) {
        const animation = shot.animations[animationIndex];
        if (animation.type === "camera-focus") {
          addCompilerWork(1, ["shots", shotIndex, "animations", animationIndex]);
          continue;
        }
        for (let targetIndex = 0; targetIndex < animation.targetIds.length; targetIndex += 1) {
          const expandedTargets = Math.max(1, expandedLeafCount(animation.targetIds[targetIndex]));
          addCompilerWork(expandedTargets, ["shots", shotIndex, "animations", animationIndex, "targetIds", targetIndex]);
          if (compilerExpansionIssueAdded) break expansionScan;
        }
      }
    }
    if (!compilerExpansionIssueAdded) {
      trackCompilerWorkScan:
      for (let trackIndex = 0; trackIndex < shot.propertyTracks.length; trackIndex += 1) {
        const track = shot.propertyTracks[trackIndex];
        if (track.target.kind === "audio") continue;
        const targetExpansion = track.target.kind === "camera" ? 1 : Math.max(1, expandedLeafCount(track.target.objectId));
        for (let segmentIndex = 0; segmentIndex + 1 < track.keyframes.length; segmentIndex += 1) {
          addCompilerWork(targetExpansion, ["shots", shotIndex, "propertyTracks", trackIndex, "keyframes", segmentIndex]);
          if (compilerExpansionIssueAdded) break trackCompilerWorkScan;
        }
      }
    }
    const ancestorCache = new Map<string, Set<string>>();
    const ancestorChain = (objectId: string) => {
      const cached = ancestorCache.get(objectId);
      if (cached) return cached;
      const result = new Set([objectId]);
      let cursor = objects.get(objectId);
      while (cursor?.parentId && !result.has(cursor.parentId)) {
        result.add(cursor.parentId);
        cursor = objects.get(cursor.parentId);
      }
      ancestorCache.set(objectId, result);
      return result;
    };

    const entranceTypes: ReadonlySet<AnimationKind> = new Set(["appear", "fade-in", "write", "create"]);
    const visibilityTypes: ReadonlySet<AnimationKind> = new Set([...entranceTypes, "fade-out"]);
    const visibilityState = new Map<string, boolean>();
    const orderedVisibilityAnimations = shot.animations
      .map((animation, index) => ({ animation, index }))
      .filter(({ animation }) => visibilityTypes.has(animation.type))
      .sort((a, b) => a.animation.start - b.animation.start || a.animation.id.localeCompare(b.animation.id));
    for (const { animation, index } of orderedVisibilityAnimations) {
      const nextVisible = entranceTypes.has(animation.type);
      const affectedObjects = shot.objects.filter((object) => (
        object.visible
        && [...ancestorChain(object.id)].every((id) => objects.get(id)?.visible !== false)
        && animation.targetIds.some((targetId) => ancestorChain(object.id).has(targetId))
      ));
      let redundantObjectId: string | undefined;
      for (const object of affectedObjects) {
        const currentVisible = visibilityState.get(object.id);
        if (currentVisible === nextVisible && redundantObjectId === undefined) redundantObjectId = object.id;
        visibilityState.set(object.id, nextVisible);
      }
      if (redundantObjectId) {
        context.addIssue({
          code: "custom",
          path: ["shots", shotIndex, "animations", index],
          message: `Visibility animation ${animation.id} repeats ${nextVisible ? "an entrance" : "a fade-out"} for ${redundantObjectId} without an intervening opposite transition`,
        });
      }
    }

    const targetSets = shot.animations.map((animation) => new Set(animation.targetIds));
    const animationFamilies = shot.animations.map((animation) => new Set(
      animation.targetIds.flatMap((id) => [...ancestorChain(id)]),
    ));

    let hierarchyTargetIssues = 0;
    for (let animationIndex = 0; animationIndex < shot.animations.length; animationIndex += 1) {
      if (hierarchyTargetIssues >= PROOFCANVAS_SCHEMA_LIMITS.hierarchyTargetIssuesPerShot) break;
      const animation = shot.animations[animationIndex];
      const targets = targetSets[animationIndex];
      let conflict: { ancestor: string; descendant: string; targetIndex: number } | undefined;
      for (let targetIndex = 0; targetIndex < animation.targetIds.length && !conflict; targetIndex += 1) {
        const descendant = animation.targetIds[targetIndex];
        for (const ancestor of ancestorChain(descendant)) {
          if (ancestor !== descendant && targets.has(ancestor)) {
            conflict = { ancestor, descendant, targetIndex };
            break;
          }
        }
      }
      if (conflict) {
        context.addIssue({
          code: "custom",
          path: ["shots", shotIndex, "animations", animationIndex, "targetIds", conflict.targetIndex],
          message: `Animation ${animation.id} cannot target both ancestor ${conflict.ancestor} and descendant ${conflict.descendant}`,
        });
        hierarchyTargetIssues += 1;
      }
    }

    let overlapIssues = 0;
    overlapScan:
    for (let animationIndex = 0; animationIndex < shot.animations.length; animationIndex += 1) {
      const animation = shot.animations[animationIndex];
      if (animation.type === "camera-focus") continue;
      const family = animationFamilies[animationIndex];
      for (let otherIndex = animationIndex + 1; otherIndex < shot.animations.length; otherIndex += 1) {
        const other = shot.animations[otherIndex];
        if (other.type === "camera-focus") continue;
        const overlapsInTime = animation.start < other.start + other.duration - PROOFCANVAS_TIME_EPSILON
          && other.start < animation.start + animation.duration - PROOFCANVAS_TIME_EPSILON;
        if (!overlapsInTime) continue;
        const sharesMobjectFamily = other.targetIds.some((id) => {
          const otherFamily = ancestorChain(id);
          return family.has(id) || [...otherFamily].some((candidate) => targetSets[animationIndex].has(candidate));
        });
        if (sharesMobjectFamily) {
          context.addIssue({
            code: "custom",
            path: ["shots", shotIndex, "animations", otherIndex],
            message: `Animations ${animation.id} and ${other.id} overlap on the same object hierarchy`,
          });
          overlapIssues += 1;
          if (overlapIssues >= PROOFCANVAS_SCHEMA_LIMITS.overlapIssuesPerShot) break overlapScan;
        }
      }
    }

    cameraOverlapScan:
    for (let cameraIndex = 0; cameraIndex < shot.animations.length; cameraIndex += 1) {
      const camera = shot.animations[cameraIndex];
      if (camera.type !== "camera-focus") continue;
      for (let otherIndex = cameraIndex + 1; otherIndex < shot.animations.length; otherIndex += 1) {
        const other = shot.animations[otherIndex];
        if (other.type !== "camera-focus") continue;
        const overlapsInTime = camera.start < other.start + other.duration - PROOFCANVAS_TIME_EPSILON
          && other.start < camera.start + camera.duration - PROOFCANVAS_TIME_EPSILON;
        if (!overlapsInTime) continue;
        context.addIssue({
          code: "custom",
          path: ["shots", shotIndex, "animations", otherIndex],
          message: `Camera animations ${camera.id} and ${other.id} overlap; camera-focus animations must be sequential`,
        });
        overlapIssues += 1;
        if (overlapIssues >= PROOFCANVAS_SCHEMA_LIMITS.overlapIssuesPerShot) break cameraOverlapScan;
      }
    }
  });
});

export type SceneObject = z.infer<typeof SceneObjectSchema>;
export type SceneAnimation = z.infer<typeof SceneAnimationSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type StylePack = z.infer<typeof StylePackSchema>;
export type ProjectDocument = z.infer<typeof ProjectDocumentSchema>;
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
export type AssetMetadata = z.infer<typeof AssetMetadataSchema>;
export type ObjectLifetime = z.infer<typeof ObjectLifetimeSchema>;
export type PropertyTrack = z.infer<typeof PropertyTrackSchema>;
export type PropertyKeyframe = z.infer<typeof PropertyKeyframeSchema>;
export type KeyframeInterpolation = z.infer<typeof KeyframeInterpolationSchema>;
export type PropertyTrackTarget = z.infer<typeof PropertyTrackTargetSchema>;
export type ObjectType = z.infer<typeof ObjectTypeSchema>;
export type AnimationType = z.infer<typeof AnimationTypeSchema>;
export type Easing = z.infer<typeof EasingSchema>;

const ObjectPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  parentId: IdSchema.nullable().optional(),
  visible: z.boolean().optional(),
  transform: z.object({
    x: AnimationCoordinateSchema.optional(),
    y: AnimationCoordinateSchema.optional(),
    width: AnimationDimensionSchema.optional(),
    height: AnimationDimensionSchema.optional(),
    rotation: AnimationRotationSchema.optional(),
    scaleX: AnimationSignedScaleSchema.optional(),
    scaleY: AnimationSignedScaleSchema.optional(),
  }).strict().optional(),
  style: ObjectStyleSchema.partial().optional(),
  semanticRole: z.string().min(1).max(120).nullable().optional(),
  properties: z.record(JsonKeySchema, JsonValueSchema).optional(),
}).strict();

const AnimationPatchSchema = z.object({
  targetIds: z.array(IdSchema).min(1).max(PROOFCANVAS_SCHEMA_LIMITS.animationTargets).optional(),
  start: z.number().finite().nonnegative().optional(),
  duration: z.number().finite().positive().optional(),
  easing: EasingSchema.optional(),
  properties: AnimationPropertyPatchSchema.optional(),
}).strict();

const KeyframePatchSchema = z.object({
  value: PropertyKeyframeSchema.shape.value.optional(),
  interpolation: KeyframeInterpolationSchema.optional(),
}).strict();

export const SceneOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add-object"), object: SceneObjectSchema }).strict(),
  z.object({ type: z.literal("update-object"), objectId: IdSchema, patch: ObjectPatchSchema }).strict(),
  z.object({ type: z.literal("delete-object"), objectId: IdSchema }).strict(),
  z.object({ type: z.literal("group-objects"), objectIds: z.array(IdSchema).min(2).max(PROOFCANVAS_SCHEMA_LIMITS.operationObjectIds), group: SceneObjectSchema }).strict(),
  z.object({ type: z.literal("ungroup-object"), groupId: IdSchema }).strict(),
  z.object({ type: z.literal("align-objects"), objectIds: z.array(IdSchema).min(2).max(PROOFCANVAS_SCHEMA_LIMITS.operationObjectIds), alignment: z.enum(["left", "center-x", "right", "top", "center-y", "bottom"]) }).strict(),
  z.object({ type: z.literal("distribute-objects"), objectIds: z.array(IdSchema).min(3).max(PROOFCANVAS_SCHEMA_LIMITS.operationObjectIds), axis: z.enum(["horizontal", "vertical"]) }).strict(),
  z.object({ type: z.literal("reorder-object"), objectId: IdSchema, index: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("lock-object"), objectId: IdSchema }).strict(),
  z.object({ type: z.literal("unlock-object"), objectId: IdSchema }).strict(),
  z.object({ type: z.literal("add-animation"), animation: SceneAnimationSchema }).strict(),
  z.object({ type: z.literal("update-animation"), animationId: IdSchema, patch: AnimationPatchSchema }).strict(),
  z.object({ type: z.literal("delete-animation"), animationId: IdSchema }).strict(),
  z.object({ type: z.literal("set-object-lifetime"), objectId: IdSchema, lifetime: ObjectLifetimeSchema }).strict(),
  z.object({ type: z.literal("add-property-track"), track: PropertyTrackSchema }).strict(),
  z.object({ type: z.literal("delete-property-track"), trackId: IdSchema }).strict(),
  z.object({ type: z.literal("add-keyframe"), trackId: IdSchema, keyframe: PropertyKeyframeSchema }).strict(),
  z.object({ type: z.literal("update-keyframe"), trackId: IdSchema, keyframeId: IdSchema, patch: KeyframePatchSchema }).strict(),
  z.object({ type: z.literal("move-keyframe"), trackId: IdSchema, keyframeId: IdSchema, time: z.number().finite().nonnegative() }).strict(),
  z.object({ type: z.literal("delete-keyframe"), trackId: IdSchema, keyframeId: IdSchema }).strict(),
  z.object({ type: z.literal("duplicate-keyframe"), trackId: IdSchema, keyframeId: IdSchema, duplicateId: IdSchema, time: z.number().finite().nonnegative() }).strict(),
  z.object({ type: z.literal("set-camera"), camera: CameraStateSchema }).strict(),
  z.object({ type: z.literal("set-style"), styleId: IdSchema }).strict(),
]);

export type SceneOperation = z.infer<typeof SceneOperationSchema>;

export type ProjectMigration = (candidate: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/** Stepwise migrations keyed by the source schema version. */
export const PROJECT_MIGRATIONS: Readonly<Record<number, ProjectMigration>> = Object.freeze({
  0: (candidate) => ({ ...cloneSerializable(candidate), schemaVersion: 1 }),
  1: (candidate) => {
    const migrated = cloneSerializable(candidate) as Record<string, unknown>;
    const legacyAspect = migrated.aspectRatio;
    const aspectRatio: z.infer<typeof AspectRatioSchema> = legacyAspect === "9:16" ? "9:16" : "16:9";
    migrated.schemaVersion = PROJECT_SCHEMA_VERSION;
    migrated.settings = {
      aspectRatio,
      frameRate: 30,
      resolution: resolutionFor(aspectRatio, "720p"),
      renderPreset: "720p",
      previewQuality: "standard",
    };
    delete migrated.aspectRatio;
    migrated.assets = [];
    migrated.customEasings = [];
    if (Array.isArray(migrated.styles)) {
      migrated.styles = migrated.styles.map((style) => (
        style && typeof style === "object" ? { ...style, origin: "preset" } : style
      ));
    }
    if (Array.isArray(migrated.shots)) {
      migrated.shots = migrated.shots.map((shot) => {
        if (!shot || typeof shot !== "object") return shot;
        const shotRecord = shot as Record<string, unknown>;
        const duration = typeof shotRecord.duration === "number" ? shotRecord.duration : 0;
        return {
          ...shotRecord,
          objects: Array.isArray(shotRecord.objects)
            ? shotRecord.objects.map((object) => (
              object && typeof object === "object"
                ? { ...object, lifetime: { start: 0, end: duration } }
                : object
            ))
            : shotRecord.objects,
          propertyTracks: [],
          audioClips: [],
          captionClips: [],
          markers: [],
        };
      });
    }
    return migrated;
  },
});

export function parseProjectDocument(input: unknown): ProjectDocument {
  let candidate = typeof input === "string" ? JSON.parse(input) : input;
  if (!candidate || typeof candidate !== "object" || !("schemaVersion" in candidate)) {
    throw new Error("ProofCanvas project is missing schemaVersion");
  }
  let version = (candidate as { schemaVersion?: unknown }).schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 0 || (version as number) > PROJECT_SCHEMA_VERSION) {
    throw new Error(`Unsupported ProofCanvas schema version: ${String(version)}`);
  }
  while ((version as number) < PROJECT_SCHEMA_VERSION) {
    const migration = PROJECT_MIGRATIONS[version as number];
    if (!migration) throw new Error(`No ProofCanvas migration is registered for schema version ${String(version)}`);
    candidate = migration(candidate as Readonly<Record<string, unknown>>);
    version = (candidate as { schemaVersion?: unknown }).schemaVersion;
  }
  return ProjectDocumentSchema.parse(candidate);
}

export function safeParseProjectDocument(input: unknown) {
  try {
    return { success: true as const, data: parseProjectDocument(input) };
  } catch (error) {
    return { success: false as const, error };
  }
}

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])) as JsonValue;
  }
  return value;
}

export function canonicalProjectJson(project: ProjectDocument): string {
  const valid = ProjectDocumentSchema.parse(project);
  return `${JSON.stringify(canonicalValue(valid as unknown as JsonValue), null, 2)}\n`;
}

export function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneProject(project: ProjectDocument): ProjectDocument {
  return ProjectDocumentSchema.parse(cloneSerializable(project));
}
