import { z } from "zod";

export const PROJECT_SCHEMA_VERSION = 1 as const;
export const PROOFCANVAS_TIME_EPSILON = 1e-9;
export const PROOFCANVAS_PROJECT_MAX_BYTES = 2 * 1024 * 1024;
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
  animationTargets: 64,
  animationProperties: 8,
  operationObjectIds: 64,
  jsonArrayItems: 256,
  jsonValueDepth: 16,
  hierarchyDepth: 16,
  graphsPerProject: 8,
  animationLeafExpansionsPerProject: 4_096,
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
    if (typeof source !== "string" || !isSafeAssetSource(source)) {
      context.addIssue({ code: "custom", path: ["properties", "source"], message: "Asset source must be a local ProofCanvas path or safe inline image" });
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
  camera: CameraStateSchema,
}).strict();

export const StylePackSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
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

export const ProjectDocumentSchema = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  metadata: z.object({
    id: IdSchema,
    title: z.string().min(1).max(160),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  aspectRatio: z.enum(["16:9", "9:16"]),
  activeStyleId: IdSchema,
  styles: z.array(StylePackSchema).min(1).max(PROOFCANVAS_SCHEMA_LIMITS.styles),
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
    || project.shots.length > PROOFCANVAS_SCHEMA_LIMITS.shots
    || project.shots.some((shot) => (
      shot.objects.length > PROOFCANVAS_SCHEMA_LIMITS.objectsPerShot
      || shot.animations.length > PROOFCANVAS_SCHEMA_LIMITS.animationsPerShot
      || shot.animations.some((animation) => animation.targetIds.length > PROOFCANVAS_SCHEMA_LIMITS.animationTargets)
    ))
  ) return;

  const styleIds = new Set<string>();
  for (let index = 0; index < project.styles.length; index += 1) {
    const id = project.styles[index].id;
    if (styleIds.has(id)) context.addIssue({ code: "custom", path: ["styles", index, "id"], message: `Duplicate style ID ${id}` });
    styleIds.add(id);
  }
  if (!styleIds.has(project.activeStyleId)) {
    context.addIssue({ code: "custom", path: ["activeStyleId"], message: "Active style does not exist" });
  }

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

  const allIds = new Set<string>();
  let animationLeafExpansions = 0;
  let animationExpansionIssueAdded = false;
  project.shots.forEach((shot, shotIndex) => {
    if (allIds.has(shot.id)) context.addIssue({ code: "custom", path: ["shots", shotIndex, "id"], message: `Duplicate ID ${shot.id}` });
    allIds.add(shot.id);
    const objects = new Map(shot.objects.map((object) => [object.id, object]));
    shot.objects.forEach((object, objectIndex) => {
      if (allIds.has(object.id)) context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "id"], message: `Duplicate ID ${object.id}` });
      allIds.add(object.id);
      if (object.parentId) {
        const parent = objects.get(object.parentId);
        if (!parent) context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "parentId"], message: `Missing parent ${object.parentId}` });
        else if (parent.type !== "group") context.addIssue({ code: "custom", path: ["shots", shotIndex, "objects", objectIndex, "parentId"], message: "Parent must be a group" });
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
    shot.animations.forEach((animation, animationIndex) => {
      if (allIds.has(animation.id)) context.addIssue({ code: "custom", path: ["shots", shotIndex, "animations", animationIndex, "id"], message: `Duplicate ID ${animation.id}` });
      allIds.add(animation.id);
      if (animation.start + animation.duration > shot.duration + PROOFCANVAS_TIME_EPSILON) {
        context.addIssue({ code: "custom", path: ["shots", shotIndex, "animations", animationIndex], message: "Animation exceeds shot duration" });
      }
      animation.targetIds.forEach((targetId, targetIndex) => {
        if (!objects.has(targetId)) context.addIssue({ code: "custom", path: ["shots", shotIndex, "animations", animationIndex, "targetIds", targetIndex], message: `Missing animation target ${targetId}` });
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
    if (!animationExpansionIssueAdded) {
      expansionScan:
      for (let animationIndex = 0; animationIndex < shot.animations.length; animationIndex += 1) {
        const animation = shot.animations[animationIndex];
        if (animation.type === "camera-focus") continue;
        for (let targetIndex = 0; targetIndex < animation.targetIds.length; targetIndex += 1) {
          animationLeafExpansions += expandedLeafCount(animation.targetIds[targetIndex]);
          if (animationLeafExpansions > PROOFCANVAS_SCHEMA_LIMITS.animationLeafExpansionsPerProject) {
            context.addIssue({
              code: "custom",
              path: ["shots", shotIndex, "animations", animationIndex, "targetIds", targetIndex],
              message: `Expanded animation targets exceed the project limit of ${PROOFCANVAS_SCHEMA_LIMITS.animationLeafExpansionsPerProject} leaf operations`,
            });
            animationExpansionIssueAdded = true;
            break expansionScan;
          }
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
  z.object({ type: z.literal("set-camera"), camera: CameraStateSchema }).strict(),
  z.object({ type: z.literal("set-style"), styleId: IdSchema }).strict(),
]);

export type SceneOperation = z.infer<typeof SceneOperationSchema>;

export type ProjectMigration = (candidate: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/** Stepwise migrations keyed by the source schema version. */
export const PROJECT_MIGRATIONS: Readonly<Record<number, ProjectMigration>> = Object.freeze({
  0: (candidate) => ({ ...cloneSerializable(candidate), schemaVersion: 1 }),
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
