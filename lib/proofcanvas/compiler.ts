import {
  PROOFCANVAS_SCHEMA_LIMITS,
  PROOFCANVAS_RENDER_SOURCE_MAX_BYTES,
  ProjectDocumentSchema,
  RestrictedExpressionSchema,
  objectTypeSupportsStyleProperty,
  utf8ByteLength,
  type ProjectDocument,
  type RestrictedExpression,
  type SceneAnimation,
  type SceneObject,
  type Shot,
  type StylePack,
} from "./schema";
import { firstVisibilityAnimationByTarget, initiallyHiddenByEntranceIds, previewShotAtAnimationEnd, previewShotAtAnimationPeak, previewShotAtTime, previewShotBeforePointEventsAtTime } from "./preview";
import { styledTransform } from "./styles";
import { manimRateFunctionName } from "./easing";
import { effectiveObjectLifetime, objectExistsAtTime } from "./timeline";
import {
  addTimelineTimes,
  compareTimelineEventStarts,
  compareTimelineTimes,
  editorLengthToManim,
  editorPointToManim,
  isCanonicalTimelineTime,
  positiveTimelineIntervalsOverlap,
  subtractTimelineTimes,
} from "./frame";
import { collectProjectIds } from "./ids";
import {
  buildCompilerSchedule,
  compareCompilerEvents,
  type CompilerEvent,
  type CompilerRateFunction,
  type CompilerSchedule,
} from "./compilerSchedule";

export interface CompilerDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  objectId?: string;
  animationId?: string;
  trackId?: string;
}

export interface CompileResult {
  python: string;
  diagnostics: CompilerDiagnostic[];
}

const MAX_HIDDEN_TARGET_DIAGNOSTICS = 64;

function boundedCompilerDiagnostics(input: CompilerDiagnostic[]): CompilerDiagnostic[] {
  const output: CompilerDiagnostic[] = [];
  const hiddenTargets = new Set<string>();
  let omittedHiddenTargets = 0;
  for (const diagnostic of input) {
    if (diagnostic.code !== "ANIMATION_TARGET_HIDDEN") {
      output.push(diagnostic);
      continue;
    }
    const key = diagnostic.objectId ?? "unknown";
    if (hiddenTargets.has(key)) continue;
    hiddenTargets.add(key);
    if (hiddenTargets.size <= MAX_HIDDEN_TARGET_DIAGNOSTICS) output.push(diagnostic);
    else omittedHiddenTargets += 1;
  }
  if (omittedHiddenTargets > 0) output.push({
    severity: "info",
    code: "ANIMATION_TARGET_HIDDEN_TRUNCATED",
    message: `${omittedHiddenTargets} additional hidden animation targets were deterministically omitted from diagnostics.`,
  });
  return output;
}

function pyString(value: string): string {
  return JSON.stringify(value).replace(/\u2028|\u2029/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function pyComment(value: string): string {
  const singleLine = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return singleLine || "Untitled";
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pyNumber(value: number): string {
  if (Object.is(value, -0)) return "0.0";
  return Number.isInteger(value) ? `${value}.0` : Number(value.toFixed(8)).toString();
}

function emittedPositiveDuration(value: number): number {
  if (!(value > 0) || !isCanonicalTimelineTime(value)) {
    throw new Error("Compiler duration must be a positive canonical timeline tick");
  }
  return value;
}

function pyDuration(value: number): string {
  return pyNumber(emittedPositiveDuration(value));
}

const PROOFCANVAS_CUBIC_BEZIER_HELPER = [
  "def proofcanvas_cubic_bezier(x, x1, y1, x2, y2):",
  "    x = min(1.0, max(0.0, x))",
  "    if x == 0.0 or x == 1.0:",
  "        return x",
  "    lower = 0.0",
  "    upper = 1.0",
  "    for iteration in range(32):",
  "        candidate = (lower + upper) / 2.0",
  "        inverse = 1.0 - candidate",
  "        value = 3.0 * inverse * inverse * candidate * x1 + 3.0 * inverse * candidate * candidate * x2 + candidate * candidate * candidate",
  "        if value < x:",
  "            lower = candidate",
  "        else:",
  "            upper = candidate",
  "    candidate = (lower + upper) / 2.0",
  "    inverse = 1.0 - candidate",
  "    return 3.0 * inverse * inverse * candidate * y1 + 3.0 * inverse * candidate * candidate * y2 + candidate * candidate * candidate",
].join("\n");

function compilerRateExpression(rateFunction: CompilerRateFunction): string {
  if (rateFunction.kind === "named") return easingName(rateFunction.easing);
  // Pinned Manim 0.21 completes a zero-runtime Transform at alpha=1. Hold and
  // delayed-first transitions therefore need no privileged renderer helper.
  if (rateFunction.kind === "hold") return "linear";
  const { x1, y1, x2, y2 } = rateFunction.curve;
  return `(lambda x: proofcanvas_cubic_bezier(x, ${pyNumber(x1)}, ${pyNumber(y1)}, ${pyNumber(x2)}, ${pyNumber(y2)}))`;
}

const PYTHON_IDENTIFIER_LIMIT = 80;
const PYTHON_IDENTIFIER_BASE_LIMIT = 72;

function stableIdentifierHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    hash = Math.imul(hash ^ (codeUnit & 0xff), 0x01000193);
    hash = Math.imul(hash ^ (codeUnit >>> 8), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function variableBase(value: string): string {
  const result = value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  const safe = result || "object";
  const readable = `pc_${safe}`;
  if (readable.length <= PYTHON_IDENTIFIER_BASE_LIMIT) return readable;
  const hash = stableIdentifierHash(value.normalize("NFKD"));
  const stemLength = PYTHON_IDENTIFIER_BASE_LIMIT - "pc_".length - 1 - hash.length;
  return `pc_${safe.slice(0, stemLength)}_${hash}`;
}

interface CompilerVariableMaps {
  objects: Map<string, string>;
  references: Map<string, string>;
}

const REFERENCE_ANIMATION_TYPES: ReadonlySet<SceneAnimation["type"]> = new Set([
  "appear",
  "fade-in",
  "fade-out",
  "write",
  "create",
  "move",
  "scale",
  "transform",
]);

function allocateVariable(base: string, used: Set<string>): string {
  let variable = base;
  let suffix = 2;
  while (used.has(variable)) {
    const suffixText = `_${suffix++}`;
    variable = `${base.slice(0, PYTHON_IDENTIFIER_LIMIT - suffixText.length)}${suffixText}`;
  }
  used.add(variable);
  return variable;
}

function variableMaps(project: ProjectDocument): CompilerVariableMaps {
  const objects = new Map<string, string>();
  const references = new Map<string, string>();
  const used = new Set<string>(["proofcanvas_cubic_bezier"]);
  for (const shot of project.shots) {
    for (const object of shot.objects) {
      objects.set(object.id, allocateVariable(variableBase(object.name), used));
    }
  }
  for (const shot of project.shots) {
    const objectMap = new Map(shot.objects.map((object) => [object.id, object]));
    const referenceTargetIds = new Set<string>();
    const addReferenceLeaves = (id: string) => {
      const object = objectMap.get(id);
      if (!object || object.type !== "group") {
        if (object) referenceTargetIds.add(id);
        return;
      }
      for (const child of shot.objects.filter(({ parentId }) => parentId === id)) addReferenceLeaves(child.id);
    };
    for (const animation of shot.animations.filter(({ type }) => REFERENCE_ANIMATION_TYPES.has(type))) {
      animation.targetIds.forEach(addReferenceLeaves);
    }
    for (const track of shot.propertyTracks) {
      if (track.target.kind === "object") addReferenceLeaves(track.target.objectId);
    }
    for (const object of shot.objects) {
      const lifetime = effectiveObjectLifetime(shot, object.id);
      if (lifetime && (compareTimelineTimes(lifetime.start, 0) > 0 || compareTimelineTimes(lifetime.end, shot.duration) < 0)) {
        addReferenceLeaves(object.id);
      }
    }
    for (const object of shot.objects) {
      if (!referenceTargetIds.has(object.id)) continue;
      references.set(object.id, allocateVariable(`pc_ref_${stableIdentifierHash(object.id)}`, used));
    }
  }
  return { objects, references };
}

function restrictedExpression(expression: RestrictedExpression): string {
  switch (expression.kind) {
    case "constant": return pyNumber(expression.value);
    case "variable": return "x";
    case "add": return `(${restrictedExpression(expression.left)} + ${restrictedExpression(expression.right)})`;
    case "subtract": return `(${restrictedExpression(expression.left)} - ${restrictedExpression(expression.right)})`;
    case "multiply": return `(${restrictedExpression(expression.left)} * ${restrictedExpression(expression.right)})`;
    case "divide": return `(${restrictedExpression(expression.left)} / ${restrictedExpression(expression.right)})`;
    case "power": return `(${restrictedExpression(expression.base)} ** ${expression.exponent})`;
    case "sin": return `math.sin(${restrictedExpression(expression.value)})`;
    case "cos": return `math.cos(${restrictedExpression(expression.value)})`;
    case "abs": return `abs(${restrictedExpression(expression.value)})`;
    case "negate": return `(-${restrictedExpression(expression.value)})`;
  }
}

function coordinate(object: SceneObject, project: ProjectDocument): string {
  const { x, y } = editorPointToManim(project.settings.aspectRatio, object.transform);
  return `[${pyNumber(x)}, ${pyNumber(y)}, 0]`;
}

function size(value: number | undefined, project: ProjectDocument): number {
  return Math.max(0.02, editorLengthToManim(project.settings.aspectRatio, value ?? 40));
}

function styleChain(object: SceneObject, style: StylePack): string {
  const color = object.style.color ?? object.style.stroke ?? style.colors.ink;
  const fill = object.style.fill ?? (
    object.type === "circle"
      ? style.colors.background
      : object.type === "rectangle"
        ? style.colors.ink
        : undefined
  );
  const stroke = object.style.stroke ?? color;
  const strokeWidth = object.style.strokeWidth ?? style.strokes.regular;
  const parts: string[] = [];
  if (objectTypeSupportsStyleProperty(object.type, "color")) parts.push(`.set_color(${pyString(color)})`);
  if (fill && objectTypeSupportsStyleProperty(object.type, "fill")) parts.push(`.set_fill(${pyString(fill)}, opacity=1.0)`);
  if (objectTypeSupportsStyleProperty(object.type, "stroke")) parts.push(`.set_stroke(${pyString(stroke)}, width=${pyNumber(strokeWidth)})`);
  if (object.style.opacity !== undefined && objectTypeSupportsStyleProperty(object.type, "opacity")) parts.push(`.set_opacity(${pyNumber(object.style.opacity)})`);
  return parts.join("");
}

function visualTargetChain(object: SceneObject & { preview?: { opacity: number } }, style: StylePack): string {
  const parts: string[] = [];
  if (object.style.fill && objectTypeSupportsStyleProperty(object.type, "fill")) parts.push(`.set_fill(${pyString(object.style.fill)}, opacity=1.0)`);
  if ((object.style.stroke || object.style.strokeWidth !== undefined) && objectTypeSupportsStyleProperty(object.type, "stroke")) {
    parts.push(`.set_stroke(${pyString(object.style.stroke ?? object.style.color ?? style.colors.ink)}, width=${pyNumber(object.style.strokeWidth ?? style.strokes.regular)})`);
  }
  if (objectTypeSupportsStyleProperty(object.type, "opacity")) parts.push(`.set_opacity(${pyNumber(object.preview?.opacity ?? object.style.opacity ?? 1)})`);
  return parts.join("");
}

function dimensionChain(object: SceneObject, variable: string, project: ProjectDocument): string {
  const parts: string[] = [];
  if (["text", "math"].includes(object.type)) {
    const width = object.transform.width === undefined ? null : size(object.transform.width, project);
    const height = object.transform.height === undefined ? null : size(object.transform.height, project);
    if (width !== null && height !== null) {
      parts.push(`.scale(min(${pyNumber(width)} / max(${variable}.width, 0.001), ${pyNumber(height)} / max(${variable}.height, 0.001)))`);
    } else if (width !== null) parts.push(`.scale_to_fit_width(${pyNumber(width)})`);
    else if (height !== null) parts.push(`.scale_to_fit_height(${pyNumber(height)})`);
  } else if (["graph", "image", "svg"].includes(object.type)) {
    if (object.transform.width !== undefined) parts.push(`.stretch_to_fit_width(${pyNumber(size(object.transform.width, project))})`);
    if (object.transform.height !== undefined) parts.push(`.stretch_to_fit_height(${pyNumber(size(object.transform.height, project))})`);
  }
  return parts.join("");
}

function primitiveExpression(
  object: SceneObject,
  project: ProjectDocument,
  style: StylePack,
  diagnostics: CompilerDiagnostic[],
): string {
  const width = size(object.transform.width, project);
  const height = size(object.transform.height, project);
  const content = typeof object.properties.content === "string" ? object.properties.content : object.name;
  switch (object.type) {
    case "text":
      return `Text(${pyString(content)}, font_size=${pyNumber(object.style.fontSize ?? 28)})`;
    case "math":
      return `MathTex(${pyString(content)}, font_size=${pyNumber(object.style.fontSize ?? 34)})`;
    case "circle":
      return `Circle(radius=1.0).stretch_to_fit_width(${pyNumber(width)}).stretch_to_fit_height(${pyNumber(height)})`;
    case "rectangle":
      return `Rectangle(width=${pyNumber(width)}, height=${pyNumber(height)})`;
    case "line":
      return `Line([-${pyNumber(width / 2)}, 0, 0], [${pyNumber(width / 2)}, 0, 0])`;
    case "arrow":
      return `Arrow([-${pyNumber(width / 2)}, 0, 0], [${pyNumber(width / 2)}, 0, 0], buff=0)`;
    case "brace": {
      const label = typeof object.properties.label === "string" ? object.properties.label : "";
      return `VGroup(BraceBetweenPoints([-${pyNumber(width / 2)}, 0, 0], [${pyNumber(width / 2)}, 0, 0], direction=DOWN), Text(${pyString(label)}, font_size=${pyNumber(object.style.fontSize ?? 22)}).shift(DOWN * 0.45))`;
    }
    case "axes": {
      const xMin = finite(object.properties.xMin, -5);
      const xMax = finite(object.properties.xMax, 5);
      const yMin = finite(object.properties.yMin, -3);
      const yMax = finite(object.properties.yMax, 3);
      return `Axes(x_range=[${pyNumber(xMin)}, ${pyNumber(xMax)}, 1], y_range=[${pyNumber(yMin)}, ${pyNumber(yMax)}, 1], x_length=${pyNumber(width)}, y_length=${pyNumber(height)}, tips=False)`;
    }
    case "graph": {
      const parsed = RestrictedExpressionSchema.safeParse(object.properties.expression);
      if (!parsed.success) {
        diagnostics.push({ severity: "error", code: "GRAPH_EXPRESSION_INVALID", message: "Restricted graph expression could not be compiled.", objectId: object.id });
        return `VMobject()`;
      }
      const xMin = finite(object.properties.xMin, -5);
      const xMax = finite(object.properties.xMax, 5);
      return `FunctionGraph(lambda x: ${restrictedExpression(parsed.data)}, x_range=[${pyNumber(xMin)}, ${pyNumber(xMax)}], color=${pyString(object.style.stroke ?? style.colors.coolAccent)})`;
    }
    case "image":
    case "svg": {
      const source = String(object.properties.source ?? "");
      diagnostics.push({ severity: "error", code: "ASSET_RENDER_TRANSPORT_UNSUPPORTED", message: "Image and SVG objects remain browser-only until trusted asset transport is implemented.", objectId: object.id });
      if (source.startsWith("data:")) {
        return `VGroup(Rectangle(width=${pyNumber(width)}, height=${pyNumber(height)}), Text(${pyString(object.name)}, font_size=16))`;
      }
      return object.type === "svg" ? `SVGMobject(${pyString(source.replace(/^\//, "public/"))})` : `ImageMobject(${pyString(source.replace(/^\//, "public/"))})`;
    }
    case "group":
      return "VGroup()";
  }
}

function easingName(easing: SceneAnimation["easing"]): string {
  return manimRateFunctionName(easing);
}

const ANIMATION_PROPERTIES: Record<SceneAnimation["type"], ReadonlySet<string>> = {
  "appear": new Set(),
  "fade-in": new Set(),
  "fade-out": new Set(),
  "write": new Set(),
  "create": new Set(),
  "move": new Set(["x", "y", "deltaX", "deltaY"]),
  "scale": new Set(["scale", "scaleX", "scaleY"]),
  "transform": new Set(["x", "y", "width", "height", "rotation", "scaleX", "scaleY"]),
  "emphasise": new Set(["scale"]),
  "camera-focus": new Set(["x", "y", "zoom", "rotation"]),
};

function diagnoseAnimationProperties(animation: SceneAnimation, diagnostics: CompilerDiagnostic[]): void {
  for (const key of Object.keys(animation.properties).sort()) {
    if (!ANIMATION_PROPERTIES[animation.type].has(key)) {
      diagnostics.push({ severity: "warning", code: "ANIMATION_PROPERTY_UNSUPPORTED", message: `${animation.type} does not support the property ${key}; it was omitted from export.`, animationId: animation.id });
    }
  }
}

const RENDERER_NUMERIC_LITERAL_LIMIT = 1_000_000_000;

function safeDerivedTransform(
  candidate: SceneObject["transform"],
  fallback: SceneObject["transform"],
  diagnostics: CompilerDiagnostic[],
  objectId: string,
  animationId?: string,
  reference?: SceneObject["transform"],
): SceneObject["transform"] {
  const values = [
    candidate.x,
    candidate.y,
    candidate.width,
    candidate.height,
    candidate.rotation,
    candidate.scaleX,
    candidate.scaleY,
    (candidate.width ?? 1) * candidate.scaleX,
    (candidate.height ?? 1) * candidate.scaleY,
  ];
  if (reference) {
    values.push(
      ((candidate.width ?? 1) * candidate.scaleX) / ((reference.width ?? 1) * reference.scaleX),
      ((candidate.height ?? 1) * candidate.scaleY) / ((reference.height ?? 1) * reference.scaleY),
    );
  }
  const unsafe = values.some((value) => value !== undefined && (!Number.isFinite(value) || Math.abs(value) > RENDERER_NUMERIC_LITERAL_LIMIT));
  if (!unsafe) return candidate;
  if (!diagnostics.some((diagnostic) => diagnostic.code === "DERIVED_NUMERIC_RANGE_EXCEEDED" && diagnostic.objectId === objectId && diagnostic.animationId === animationId)) {
    diagnostics.push({
      severity: "error",
      code: "DERIVED_NUMERIC_RANGE_EXCEEDED",
      message: "A derived transform exceeded the renderer's finite numeric range; safe authored geometry was emitted instead.",
      objectId,
      ...(animationId ? { animationId } : {}),
    });
  }
  return { ...fallback };
}

function copyTransformTarget(
  object: SceneObject,
  transformAtStart: SceneObject["transform"],
  targetTransform: SceneObject["transform"],
  variable: string,
  project: ProjectDocument,
): string {
  const parts = [`${variable}.copy()`];
  if (targetTransform.width !== transformAtStart.width || targetTransform.scaleX !== transformAtStart.scaleX) {
    if (targetTransform.width !== undefined && transformAtStart.width !== undefined) {
      const ratio = targetTransform.width * targetTransform.scaleX / (transformAtStart.width * transformAtStart.scaleX);
      parts.push(`.stretch(${pyNumber(ratio)}, 0)`);
    } else if (targetTransform.width === undefined && transformAtStart.width === undefined) {
      parts.push(`.stretch(${pyNumber(targetTransform.scaleX / transformAtStart.scaleX)}, 0)`);
    } else {
      const width = size(targetTransform.width ?? object.transform.width ?? 40, project) * Math.abs(targetTransform.scaleX);
      parts.push(`.stretch_to_fit_width(${pyNumber(width)})`);
      if (targetTransform.scaleX < 0) parts.push(".stretch(-1.0, 0)");
    }
  }
  if (targetTransform.height !== transformAtStart.height || targetTransform.scaleY !== transformAtStart.scaleY) {
    if (targetTransform.height !== undefined && transformAtStart.height !== undefined) {
      const ratio = targetTransform.height * targetTransform.scaleY / (transformAtStart.height * transformAtStart.scaleY);
      parts.push(`.stretch(${pyNumber(ratio)}, 1)`);
    } else if (targetTransform.height === undefined && transformAtStart.height === undefined) {
      parts.push(`.stretch(${pyNumber(targetTransform.scaleY / transformAtStart.scaleY)}, 1)`);
    } else {
      const height = size(targetTransform.height ?? object.transform.height ?? 40, project) * Math.abs(targetTransform.scaleY);
      parts.push(`.stretch_to_fit_height(${pyNumber(height)})`);
      if (targetTransform.scaleY < 0) parts.push(".stretch(-1.0, 1)");
    }
  }
  if (targetTransform.rotation !== transformAtStart.rotation) {
    parts.push(`.rotate(${pyNumber(targetTransform.rotation - transformAtStart.rotation)} * DEGREES)`);
  }
  if (targetTransform.x !== transformAtStart.x || targetTransform.y !== transformAtStart.y) {
    const proxy = { ...object, transform: targetTransform };
    parts.push(`.move_to(${coordinate(proxy, project)})`);
  }
  return parts.join("");
}

function semanticAnimationTarget(animation: SceneAnimation, transformAtStart: SceneObject["transform"]): SceneObject["transform"] {
  const target = { ...transformAtStart };
  switch (animation.type) {
    case "move":
      target.x = finite(animation.properties.x, transformAtStart.x + finite(animation.properties.deltaX, 0));
      target.y = finite(animation.properties.y, transformAtStart.y + finite(animation.properties.deltaY, 0));
      break;
    case "scale":
      target.scaleX = finite(animation.properties.scaleX, finite(animation.properties.scale, transformAtStart.scaleX));
      target.scaleY = finite(animation.properties.scaleY, finite(animation.properties.scale, transformAtStart.scaleY));
      break;
    case "transform":
      for (const key of ["x", "y", "width", "height", "rotation", "scaleX", "scaleY"] as const) {
        const value = animation.properties[key];
        if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
      }
      break;
  }
  return target;
}

function absoluteGroupTarget(
  group: SceneObject,
  shot: Shot,
  project: ProjectDocument,
  style: StylePack,
  references: ReadonlyMap<string, string>,
  referenceTransforms: ReadonlyMap<string, SceneObject["transform"]>,
  stateAtEnd: ReturnType<typeof previewShotAtTime>,
  diagnostics: CompilerDiagnostic[],
  animationId: string,
): string {
  const objectMap = new Map(shot.objects.map((object) => [object.id, object]));
  const endMap = new Map(stateAtEnd.objects.map((object) => [object.id, object]));
  const expressionFor = (object: SceneObject): string => {
    if (object.type === "group") {
      const children = shot.objects.filter((child) => child.parentId === object.id && isRenderableObject(child, shot, objectMap));
      return `${groupClass(object, shot)}(${children.map(expressionFor).join(", ")})`;
    }
    const authored = referenceTransforms.get(object.id)
      ?? safeDerivedTransform(styledTransform(object, style), object.transform, diagnostics, object.id);
    const semanticTarget = endMap.get(object.id)?.transform ?? object.transform;
    const styledTarget = safeDerivedTransform(
      styledTransform({ ...object, transform: semanticTarget }, style),
      authored,
      diagnostics,
      object.id,
      animationId,
      authored,
    );
    const endObject = endMap.get(object.id) ?? object;
    return `${copyTransformTarget(object, authored, styledTarget, references.get(object.id)!, project)}${visualTargetChain(endObject, style)}`;
  };
  const children = shot.objects.filter((child) => child.parentId === group.id && isRenderableObject(child, shot, objectMap));
  return `${groupClass(group, shot)}(${children.map(expressionFor).join(", ")})`;
}

function targetAnimation(
  animation: SceneAnimation,
  object: SceneObject,
  referenceTransform: SceneObject["transform"],
  targetTransform: SceneObject["transform"],
  variable: string,
  referenceVariable: string | undefined,
  project: ProjectDocument,
  rate: string,
  point: boolean,
  absoluteTarget?: string,
  hiddenAtStart = false,
): string {
  const runTime = point ? "0.0" : pyDuration(animation.duration);
  switch (animation.type) {
    case "appear": return absoluteTarget
      ? `Transform(${variable}, ${absoluteTarget}, run_time=${runTime}, rate_func=${rate})`
      : `FadeIn(${variable}, run_time=${runTime}, rate_func=${rate})`;
    case "fade-in": return absoluteTarget
      ? `Transform(${variable}, ${absoluteTarget}, run_time=${runTime}, rate_func=${rate})`
      : `FadeIn(${variable}, run_time=${runTime}, rate_func=${rate})`;
    case "fade-out":
      return `Transform(${variable}, ${absoluteTarget ?? copyTransformTarget(object, referenceTransform, targetTransform, referenceVariable!, project)}, run_time=${runTime}, rate_func=${rate})`;
    case "write": return absoluteTarget
      ? `Transform(${variable}, ${absoluteTarget}, run_time=${runTime}, rate_func=${rate})`
      : `Write(${variable}, run_time=${runTime}, rate_func=${rate})`;
    case "create": return absoluteTarget
      ? `Transform(${variable}, ${absoluteTarget}, run_time=${runTime}, rate_func=${rate})`
      : `Create(${variable}, run_time=${runTime}, rate_func=${rate})`;
    case "move":
    case "scale":
    case "transform":
      return `Transform(${variable}, ${absoluteTarget ?? copyTransformTarget(object, referenceTransform, targetTransform, referenceVariable!, project)}, run_time=${runTime}, rate_func=${rate})`;
    case "emphasise":
      if (hiddenAtStart) return `Succession(Wait(${runTime}), group=Group(), run_time=${runTime})`;
      return `Indicate(${variable}, color=${pyString(project.styles.find(({ id }) => id === project.activeStyleId)!.colors.warmAccent)}, scale_factor=${pyNumber(finite(animation.properties.scale, 1.08))}, run_time=${runTime}, rate_func=${rate})`;
    case "camera-focus":
      return "";
  }
}

const ENTRANCE_ANIMATION_TYPES: ReadonlySet<SceneAnimation["type"]> = new Set(["appear", "fade-in", "write", "create"]);
const SPATIAL_ANIMATION_TYPES: ReadonlySet<SceneAnimation["type"]> = new Set(["move", "scale", "transform"]);

function renderableVisibilityFamilyIds(
  object: SceneObject,
  shot: Shot,
  objects: ReadonlyMap<string, SceneObject>,
): string[] {
  const result = [object.id];
  if (object.type !== "group") return result;
  const queue = [object.id];
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const child of shot.objects.filter(({ parentId: candidate }) => candidate === parentId)) {
      if (!isRenderableObject(child, shot, objects)) continue;
      result.push(child.id);
      if (child.type === "group") queue.push(child.id);
    }
  }
  return result;
}

function targetAffectsObjectFamily(
  targetId: string,
  object: SceneObject,
  objects: ReadonlyMap<string, SceneObject>,
): boolean {
  if (targetId === object.id || ancestorIds(object, objects).includes(targetId)) return true;
  const target = objects.get(targetId);
  return object.type === "group" && Boolean(target && ancestorIds(target, objects).includes(object.id));
}

function canUseNativeEntrance(
  animation: SceneAnimation,
  object: SceneObject,
  shot: Shot,
  objects: ReadonlyMap<string, SceneObject>,
  firstVisibility: ReturnType<typeof firstVisibilityAnimationByTarget>,
): boolean {
  if (!ENTRANCE_ANIMATION_TYPES.has(animation.type)) return false;
  // Isolated pinned-Manim probes reach the full there-and-back path peak and
  // restore a hidden endpoint. However, the native path animation leaves a
  // degenerate internal state that leaks visible pixels during a later hidden
  // Move/Transform. Keep this combination fail-closed until that follow-up
  // state can be represented exactly.
  if (animation.easing === "there-and-back" && (animation.type === "write" || animation.type === "create")) return false;
  if (!renderableVisibilityFamilyIds(object, shot, objects).every((id) => firstVisibility.get(id)?.id === animation.id)) return false;
  return !shot.animations.some((candidate) => (
    compareTimelineTimes(candidate.start, animation.start) < 0
    && SPATIAL_ANIMATION_TYPES.has(candidate.type)
    && candidate.targetIds.some((targetId) => targetAffectsObjectFamily(targetId, object, objects))
  ));
}

function previewTargetIsHidden(
  object: SceneObject,
  shot: Shot,
  objects: ReadonlyMap<string, SceneObject>,
  previewObjects: ReadonlyMap<string, ReturnType<typeof previewShotAtTime>["objects"][number]>,
): boolean {
  if (object.type !== "group") return (previewObjects.get(object.id)?.preview.opacity ?? object.style.opacity ?? 1) <= 0;
  const leaves = renderableVisibilityFamilyIds(object, shot, objects)
    .map((id) => objects.get(id))
    .filter((member): member is SceneObject => Boolean(member && member.type !== "group"));
  return leaves.every((leaf) => (previewObjects.get(leaf.id)?.preview.opacity ?? leaf.style.opacity ?? 1) <= 0);
}

function animationExpression(
  event: CompilerEvent,
  shot: Shot,
  project: ProjectDocument,
  variables: ReadonlyMap<string, string>,
  references: ReadonlyMap<string, string>,
  referenceTransforms: ReadonlyMap<string, SceneObject["transform"]>,
  diagnostics: CompilerDiagnostic[],
  firstVisibility: ReturnType<typeof firstVisibilityAnimationByTarget>,
  previewAt: (time: number) => ReturnType<typeof previewShotAtTime>,
  previewAtEnd: (animation: SceneAnimation) => ReturnType<typeof previewShotAtAnimationEnd>,
  previewBeforePointsAt: (time: number) => ReturnType<typeof previewShotBeforePointEventsAtTime>,
): string {
  const animation = event.animation;
  const point = event.start === event.end;
  const rate = compilerRateExpression(event.rateFunction);
  diagnoseAnimationProperties(animation, diagnostics);
  if (animation.type === "emphasise" && animation.easing !== "there-and-back") {
    diagnostics.push({
      severity: "error",
      code: "SEMANTIC_EASING_UNSUPPORTED",
      message: "Emphasise is an intrinsic pulse and requires there-and-back easing in preview and Manim.",
      animationId: animation.id,
    });
  }
  // The preview reducer is the semantic authority for state at an animation's
  // start. Using that state keeps generated relative Manim operations correct
  // after earlier scale, transform, move, or camera animations.
  const stateAtStart = previewAt(animation.start);
  const compilerOwnedTrack = event.kind === "property-span";
  const stateAtEnd = previewAtEnd(animation);
  const stateBeforeEndpointPoints = point
    ? stateAtEnd
    : previewBeforePointsAt(addTimelineTimes(animation.start, animation.duration));
  // A semantic there-and-back animation reaches its authored target halfway
  // through and returns to its start state at the endpoint. Absolute group and
  // visibility targets must therefore be built from the peak snapshot. A
  // compiler-owned property span is different: it targets the right keyframe
  // and is followed by an exact zero-time endpoint assignment.
  const stateAtTarget = !compilerOwnedTrack && animation.easing === "there-and-back" && animation.duration > 0
    ? previewShotAtAnimationPeak(shot, animation)
    : compilerOwnedTrack && event.rateFunction.kind === "named" && event.rateFunction.easing === "there-and-back"
      ? stateAtEnd
      : stateBeforeEndpointPoints;
  if (animation.type === "camera-focus") {
    const authoritative = compilerOwnedTrack
      ? { ...stateBeforeEndpointPoints.camera }
      : undefined;
    if (authoritative && event.kind === "property-span" && event.target.kind === "camera") {
      // The positive target owns only its grouped track properties. Foreign
      // singleton/hold points at this exact endpoint run in the following
      // schedule phase and must not leak into the preceding interpolation.
      for (const property of event.propertyNames) {
        if (property === "x" || property === "y" || property === "zoom" || property === "rotation") {
          authoritative[property] = stateAtEnd.camera[property];
        }
      }
    }
    const x = authoritative?.x ?? finite(animation.properties.x, stateAtStart.camera.x);
    const y = authoritative?.y ?? finite(animation.properties.y, stateAtStart.camera.y);
    const zoom = authoritative?.zoom ?? finite(animation.properties.zoom, stateAtStart.camera.zoom);
    const rotation = authoritative?.rotation ?? finite(animation.properties.rotation, stateAtStart.camera.rotation);
    const proxy: SceneObject = { id: "camera", type: "group", name: "Camera", locked: false, visible: true, transform: { x, y, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} };
    return `Transform(self.camera.frame, Rectangle(width=config.frame_width / ${pyNumber(zoom)}, height=config.frame_height / ${pyNumber(zoom)}).move_to(${coordinate(proxy, project)}).rotate(${pyNumber(rotation)} * DEGREES), run_time=${point ? "0.0" : pyDuration(animation.duration)}, rate_func=${rate})`;
  }
  const objectMap = new Map(shot.objects.map((object) => [object.id, object]));
  const previewObjectMap = new Map(stateAtStart.objects.map((object) => [object.id, object]));
  const targetObjectMap = new Map(stateAtTarget.objects.map((object) => [object.id, object]));
  const activeStyle = project.styles.find(({ id }) => id === project.activeStyleId)!;
  const visibleTargetIds = animation.targetIds.filter((targetId) => {
    const object = objectMap.get(targetId);
    if (object && isRenderableObject(object, shot, objectMap)) return true;
    if (object) {
      diagnostics.push({
        severity: "info",
        code: "ANIMATION_TARGET_HIDDEN",
        message: "Animation target was omitted because it is hidden, has a hidden ancestor, or is a group without visible content.",
        objectId: object.id,
        animationId: animation.id,
      });
    }
    return false;
  });
  if (visibleTargetIds.length === 0) {
    const runTime = point ? "0.0" : pyDuration(animation.duration);
    return `Succession(Wait(${runTime}), group=Group(), run_time=${runTime})`;
  }
  if (animation.easing === "there-and-back" && (animation.type === "write" || animation.type === "create")) {
    diagnostics.push({
      severity: "error",
      code: "SEMANTIC_EASING_UNSUPPORTED",
      message: `${animation.type} with there-and-back is rejected because pinned Manim leaks native path state into hidden spatial follow-up animations.`,
      animationId: animation.id,
    });
  }
  if (event.kind === "lifetime-exit") {
    // FadeOut restores the source mobject's opacity before removal in pinned
    // Manim 0.21. A persistent exact-state Transform keeps an expired leaf at
    // opacity zero if a later ancestor animation re-adds its family.
    const expressions = visibleTargetIds.map((targetId) => {
      const variable = variables.get(targetId)!;
      return `Transform(${variable}, ${variable}.copy().set_opacity(0.0), run_time=0.0, rate_func=linear)`;
    });
    return expressions.length === 1 ? expressions[0] : `AnimationGroup(${expressions.join(", ")}, lag_ratio=0, run_time=0.0)`;
  }
  const expressions = visibleTargetIds.map((targetId) => {
    const object = objectMap.get(targetId)!;
    const semanticStart = previewObjectMap.get(targetId)?.transform ?? object.transform;
    const semanticTarget = compilerOwnedTrack
      ? targetObjectMap.get(targetId)?.transform ?? semanticStart
      : semanticAnimationTarget(animation, semanticStart);
    const referenceTransform = referenceTransforms.get(object.id)
      ?? safeDerivedTransform(styledTransform(object, activeStyle), object.transform, diagnostics, object.id);
    const targetTransform = safeDerivedTransform(
      styledTransform({ ...object, transform: semanticTarget }, activeStyle),
      referenceTransform,
      diagnostics,
      object.id,
      animation.id,
      referenceTransform,
    );
    const variable = variables.get(targetId)!;
    if (event.kind === "lifetime-enter") {
      const exactTarget = `${copyTransformTarget(object, referenceTransform, targetTransform, references.get(targetId)!, project)}${visualTargetChain(targetObjectMap.get(targetId) ?? object, activeStyle)}`;
      return `Succession(Transform(${variable}, ${exactTarget}, run_time=0.0, rate_func=linear), FadeIn(${variable}, run_time=0.0, rate_func=linear), group=Group(), run_time=0.0)`;
    }
    const nativeEntrance = canUseNativeEntrance(animation, object, shot, objectMap, firstVisibility);
    if (object.type === "group" && groupClass(object, shot) === "Group" && (animation.type === "create" || animation.type === "write")) {
      diagnostics.push({
        severity: "warning",
        code: "GROUP_ANIMATION_FALLBACK",
        message: nativeEntrance
          ? `${animation.type} is not safe for a heterogeneous Manim Group; FadeIn was emitted instead.`
          : `${animation.type} is not safe for a heterogeneous Manim Group; a state-preserving Transform was emitted instead.`,
        objectId: object.id,
        animationId: animation.id,
      });
      if (nativeEntrance) return `FadeIn(${variable}, run_time=${point ? "0.0" : pyDuration(animation.duration)}, rate_func=${rate})`;
    }
    const needsAbsoluteTarget = SPATIAL_ANIMATION_TYPES.has(animation.type)
      || animation.type === "fade-out"
      || (ENTRANCE_ANIMATION_TYPES.has(animation.type) && !nativeEntrance);
    let absoluteTarget: string | undefined;
    if (needsAbsoluteTarget) {
      absoluteTarget = object.type === "group"
        ? absoluteGroupTarget(
          object,
          shot,
          project,
          activeStyle,
          references,
          referenceTransforms,
          stateAtTarget,
          diagnostics,
          animation.id,
        )
        : `${copyTransformTarget(object, referenceTransform, targetTransform, references.get(targetId)!, project)}${visualTargetChain(targetObjectMap.get(targetId) ?? object, activeStyle)}`;
    }
    const hiddenAtStart = previewTargetIsHidden(object, shot, objectMap, previewObjectMap);
    return targetAnimation(
      animation,
      object,
      referenceTransform,
      targetTransform,
      variable,
      references.get(targetId),
      project,
      rate,
      point,
      absoluteTarget,
      hiddenAtStart,
    );
  });
  const runTime = point ? "0.0" : pyDuration(animation.duration);
  return expressions.length === 1
    ? expressions[0]
    : `AnimationGroup(${expressions.join(", ")}, lag_ratio=0, run_time=${runTime})`;
}

function ancestorIds(object: SceneObject, objects: ReadonlyMap<string, SceneObject>): string[] {
  const result: string[] = [];
  let cursor = object.parentId ? objects.get(object.parentId) : undefined;
  while (cursor) {
    result.push(cursor.id);
    cursor = cursor.parentId ? objects.get(cursor.parentId) : undefined;
  }
  return result;
}

function isEffectivelyVisible(object: SceneObject, objects: ReadonlyMap<string, SceneObject>): boolean {
  if (!object.visible) return false;
  let cursor = object.parentId ? objects.get(object.parentId) : undefined;
  while (cursor) {
    if (!cursor.visible) return false;
    cursor = cursor.parentId ? objects.get(cursor.parentId) : undefined;
  }
  return true;
}

function isRenderableObject(object: SceneObject, shot: Shot, objects: ReadonlyMap<string, SceneObject>): boolean {
  if (!isEffectivelyVisible(object, objects)) return false;
  if (object.type !== "group") return true;
  return shot.objects.some((child) => child.parentId === object.id && isRenderableObject(child, shot, objects));
}

function groupClass(group: SceneObject, shot: Shot): "Group" | "VGroup" {
  const leaves: SceneObject[] = [];
  const objectMap = new Map(shot.objects.map((object) => [object.id, object]));
  const queue = [group.id];
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const child of shot.objects.filter(({ parentId: candidate }) => candidate === parentId)) {
      if (!isRenderableObject(child, shot, objectMap)) continue;
      if (child.type === "group") queue.push(child.id);
      else leaves.push(child);
    }
  }
  const types = new Set(leaves.map(({ type }) => type));
  return types.has("image") || types.size > 1 ? "Group" : "VGroup";
}

interface AnimationComponent {
  events: CompilerEvent[];
  start: number;
  end: number;
}

function timeRangesOverlap(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return positiveTimelineIntervalsOverlap(left, right);
}

function eventsTemporallyConnected(left: CompilerEvent, right: CompilerEvent): boolean {
  const leftPoint = left.start === left.end;
  const rightPoint = right.start === right.end;
  if (leftPoint && rightPoint) return compareTimelineTimes(left.start, right.start) === 0;
  if (leftPoint) {
    return compareTimelineTimes(left.start, right.start) >= 0 && compareTimelineTimes(left.start, right.end) <= 0;
  }
  if (rightPoint) {
    return compareTimelineTimes(right.start, left.start) >= 0 && compareTimelineTimes(right.start, left.end) <= 0;
  }
  return timeRangesOverlap(left, right);
}

function animationComponents(events: readonly CompilerEvent[]): AnimationComponent[] {
  const ordered = [...events].sort(compareCompilerEvents);
  const parents = ordered.map((_, index) => index);
  const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]));
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      if (eventsTemporallyConnected(ordered[left], ordered[right])) union(left, right);
    }
  }
  const grouped = new Map<number, CompilerEvent[]>();
  ordered.forEach((event, index) => grouped.set(find(index), [...(grouped.get(find(index)) ?? []), event]));
  return [...grouped.values()].map((componentEvents) => ({
    events: componentEvents.sort(compareCompilerEvents),
    start: Math.min(...componentEvents.map(({ start }) => start)),
    end: Math.max(...componentEvents.map(({ end }) => end)),
  })).sort((left, right) => compareTimelineEventStarts(left, right) || compareTimelineTimes(left.end, right.end) || compareCompilerEvents(left.events[0], right.events[0]));
}

function eventTargetIds(event: CompilerEvent): string[] {
  return event.animation.type === "camera-focus" ? ["camera"] : event.animation.targetIds;
}

function eventLanes(component: AnimationComponent, shot: Shot): CompilerEvent[][] {
  const objects = new Map(shot.objects.map((object) => [object.id, object]));
  const ancestors = (id: string) => {
    const result = new Set([id]);
    let cursor = objects.get(id);
    while (cursor?.parentId && !result.has(cursor.parentId)) {
      result.add(cursor.parentId);
      cursor = objects.get(cursor.parentId);
    }
    return result;
  };
  const sharesTarget = (left: CompilerEvent, right: CompilerEvent) => eventTargetIds(left).some((leftId) => (
    eventTargetIds(right).some((rightId) => (
      leftId === "camera" || rightId === "camera"
        ? leftId === rightId
        : ancestors(leftId).has(rightId) || ancestors(rightId).has(leftId)
    ))
  ));
  const events = component.events;
  const parents = events.map((_, index) => index);
  const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]));
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < events.length; left += 1) {
    for (let right = left + 1; right < events.length; right += 1) {
      const leftPoint = events[left].start === events[left].end;
      const rightPoint = events[right].start === events[right].end;
      if (!(leftPoint || rightPoint) || !sharesTarget(events[left], events[right])) continue;
      const pointTime = leftPoint ? events[left].start : events[right].start;
      const interval = leftPoint ? events[right] : events[left];
      const connects = compareTimelineTimes(pointTime, interval.start) >= 0
        && compareTimelineTimes(pointTime, interval.end) <= 0;
      if (connects) union(left, right);
    }
  }
  const grouped = new Map<number, CompilerEvent[]>();
  events.forEach((event, index) => grouped.set(find(index), [...(grouped.get(find(index)) ?? []), event]));
  return [...grouped.values()]
    .map((lane) => lane.sort(compareCompilerEvents))
    .sort((left, right) => compareCompilerEvents(left[0], right[0]));
}

/**
 * Conservative decoded-video duration for the exact sequence of explicit-
 * runtime self.play calls emitted below. Manim samples non-static plays with
 * ceil(run_time * fps) frames, so authored duration alone is not an admission
 * bound for timelines containing many sub-frame components.
 */
export function estimateManimTimelineDurationUpperBound(project: ProjectDocument, frameRate: number): number {
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error("Frame rate must be a positive finite number");
  const quantizedEmittedFrames = (duration: number) => Math.max(1, Math.ceil(emittedPositiveDuration(duration) * frameRate));
  let totalFrames = 0;
  const reservedIds = collectProjectIds(project);
  for (const shot of project.shots) {
    const schedule = buildCompilerSchedule(shot, project.settings.frameRate, reservedIds);
    let timelineCursor = 0;
    for (const component of animationComponents(schedule.events)) {
      const gap = subtractTimelineTimes(component.start, timelineCursor);
      if (compareTimelineTimes(component.start, timelineCursor) > 0) {
        totalFrames += quantizedEmittedFrames(gap);
      }
      // Every positive component and inferred child aggregate is emitted with
      // an explicit canonical runtime. This prevents Python float child sums
      // such as 0.1 + 0.2 from silently adding a decoded frame.
      const componentRuntime = subtractTimelineTimes(component.end, component.start);
      if (componentRuntime > 0) totalFrames += quantizedEmittedFrames(componentRuntime);
      timelineCursor = Math.max(timelineCursor, component.end);
    }
    const finalHold = subtractTimelineTimes(shot.duration, timelineCursor);
    if (compareTimelineTimes(shot.duration, timelineCursor) > 0) {
      totalFrames += quantizedEmittedFrames(finalHold);
    }
  }
  return totalFrames / frameRate;
}

export function compileManim(input: ProjectDocument): CompileResult {
  const parsedProject = ProjectDocumentSchema.parse(input);
  const reservedIds = collectProjectIds(parsedProject);
  const schedules = parsedProject.shots.map((shot) => buildCompilerSchedule(shot, parsedProject.settings.frameRate, reservedIds));
  const project: ProjectDocument = { ...parsedProject, shots: schedules.map(({ shot }) => shot) };
  const diagnostics: CompilerDiagnostic[] = [];
  diagnostics.push({
    severity: "info",
    code: "RENDER_SETTINGS_EXTERNAL",
    message: `Renderer transport must apply ${project.settings.resolution.width}x${project.settings.resolution.height} at ${project.settings.frameRate}fps (${project.settings.renderPreset}); preview quality ${project.settings.previewQuality} is editor-only.`,
  });
  for (const shot of project.shots) {
    for (const clip of shot.audioClips) diagnostics.push({
      severity: "error",
      code: "AUDIO_CLIP_RENDER_UNSUPPORTED",
      message: "Authored audio cannot be transported or muxed by the current renderer and is rejected until Slice 4.",
      objectId: clip.id,
    });
  }
  const totalScheduleWork = schedules.reduce((sum, schedule) => sum + schedule.workCount, 0);
  const scheduleOverBudget = totalScheduleWork > PROOFCANVAS_SCHEMA_LIMITS.compilerExpandedTargetsPerProject;
  if (scheduleOverBudget) diagnostics.push({
    severity: "error",
    code: "COMPILER_WORK_LIMIT_EXCEEDED",
    message: `Chronological schedule expands to ${totalScheduleWork} target events, above the project limit of ${PROOFCANVAS_SCHEMA_LIMITS.compilerExpandedTargetsPerProject}; compiler-owned events were not emitted.`,
  });
  const emittedSchedules: CompilerSchedule[] = scheduleOverBudget
    ? schedules.map((schedule) => ({ ...schedule, events: schedule.events.filter(({ kind }) => kind === "semantic"), helpers: { cubicBezier: false } }))
    : schedules;
  const { objects: variables, references } = variableMaps(project);
  const needsCubicBezierHelper = emittedSchedules.some(({ helpers }) => helpers.cubicBezier);
  const lines: string[] = [
    "from manim import *",
    "import math",
    `# ProofCanvas settings: ${project.settings.aspectRatio}, ${project.settings.resolution.width}x${project.settings.resolution.height}, ${project.settings.frameRate}fps, ${project.settings.renderPreset}, preview=${project.settings.previewQuality}`,
    "",
  ];
  if (needsCubicBezierHelper) lines.push(PROOFCANVAS_CUBIC_BEZIER_HELPER, "");
  lines.push("", "class GeneratedScene(MovingCameraScene):", "    def construct(self):");

  project.shots.forEach((shot, shotIndex) => {
    const style = project.styles.find(({ id }) => id === project.activeStyleId)!;
    const objectMap = new Map(shot.objects.map((object) => [object.id, object]));
    const schedule = emittedSchedules[shotIndex];
    diagnostics.push(...schedules[shotIndex].diagnostics);
    const compiledAnimations = schedule.events.map(({ animation }) => animation);
    const compiledScheduleShot: Shot = { ...shot, animations: compiledAnimations };
    // Initial visibility is authored semantic authority. Compiler-owned
    // lifetime edges/property points must not replace a future entrance as a
    // leaf's first visibility event (for example, an expiry before a later
    // group FadeIn), or the leaf can be added visibly at frame zero.
    const entering = new Set(
      [...initiallyHiddenByEntranceIds(shot)].filter((id) => {
        const object = objectMap.get(id);
        return object ? isRenderableObject(object, shot, objectMap) : false;
      }),
    );
    const firstVisibility = firstVisibilityAnimationByTarget(compiledScheduleShot);
    const authoredFirstVisibility = firstVisibilityAnimationByTarget(shot);
    const previewCache = new Map<number, ReturnType<typeof previewShotAtTime>>();
    const beforePointPreviewCache = new Map<number, ReturnType<typeof previewShotBeforePointEventsAtTime>>();
    const endPreviewCache = new Map<string, ReturnType<typeof previewShotAtAnimationEnd>>();
    const previewAt = (time: number) => {
      const cached = previewCache.get(time);
      if (cached) return cached;
      const preview = previewShotAtTime(shot, time);
      previewCache.set(time, preview);
      return preview;
    };
    const previewBeforePointsAt = (time: number) => {
      const cached = beforePointPreviewCache.get(time);
      if (cached) return cached;
      const preview = previewShotBeforePointEventsAtTime(shot, time);
      beforePointPreviewCache.set(time, preview);
      return preview;
    };
    const previewAtEnd = (animation: SceneAnimation) => {
      const end = addTimelineTimes(animation.start, animation.duration);
      const hasAdjacentInstantEntrance = shot.animations.some((candidate) => (
        candidate.id !== animation.id
        && candidate.type === "appear"
        && compareTimelineTimes(candidate.start, end) === 0
      ));
      if (!hasAdjacentInstantEntrance) return previewAt(end);
      const cached = endPreviewCache.get(animation.id);
      if (cached) return cached;
      const preview = previewShotAtAnimationEnd(shot, animation);
      endPreviewCache.set(animation.id, preview);
      return preview;
    };
    const preparedHiddenLeaves = new Set<string>();
    for (const event of schedule.events.filter(({ animation }) => ENTRANCE_ANIMATION_TYPES.has(animation.type))) {
      const animation = event.animation;
      for (const targetId of animation.targetIds) {
        const object = objectMap.get(targetId);
        if (!object || !isRenderableObject(object, shot, objectMap) || canUseNativeEntrance(animation, object, compiledScheduleShot, objectMap, firstVisibility)) continue;
        for (const familyId of renderableVisibilityFamilyIds(object, shot, objectMap)) {
          const member = objectMap.get(familyId);
          if (member?.type !== "group" && entering.has(familyId) && authoredFirstVisibility.get(familyId)?.id === animation.id) {
            preparedHiddenLeaves.add(familyId);
          }
        }
      }
    }
    const emitted = new Set<string>();
    const referenceTransforms = new Map<string, SceneObject["transform"]>();
    const delayedLifetimeLeaves = new Set(shot.objects.filter((object) => (
      object.type !== "group" && (effectiveObjectLifetime(shot, object.id)?.start ?? 0) > 0
    )).map(({ id }) => id));
    lines.push(`        # Shot ${shotIndex + 1}: ${pyComment(shot.name)}`);
    lines.push(`        self.next_section(${pyString(shot.name)})`);
    lines.push(`        self.camera.background_color = ${pyString(style.colors.background)}`);
    const initialPreview = previewAt(0);
    const shotCamera: SceneObject = { id: "camera", type: "group", name: "Camera", locked: false, visible: true, transform: { x: initialPreview.camera.x, y: initialPreview.camera.y, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} };
    lines.push(`        self.camera.frame.become(Rectangle(width=config.frame_width / ${pyNumber(initialPreview.camera.zoom)}, height=config.frame_height / ${pyNumber(initialPreview.camera.zoom)}).move_to(${coordinate(shotCamera, project)}).rotate(${pyNumber(initialPreview.camera.rotation)} * DEGREES))`);

    const emit = (object: SceneObject) => {
      if (emitted.has(object.id)) return;
      if (!isRenderableObject(object, shot, objectMap)) {
        emitted.add(object.id);
        return;
      }
      const children = shot.objects.filter((child) => child.parentId === object.id && isRenderableObject(child, shot, objectMap));
      children.forEach(emit);
      const variable = variables.get(object.id)!;
      if (object.type === "group") {
        lines.push(`        ${variable} = ${groupClass(object, shot)}(${children.map((child) => variables.get(child.id)).join(", ")})`);
      } else {
        const previewObject = initialPreview.objects.find(({ id }) => id === object.id);
        const initialObject = previewObject ?? object;
        const styledObject = {
          ...initialObject,
          transform: safeDerivedTransform(styledTransform(initialObject, style), object.transform, diagnostics, object.id),
        };
        lines.push(`        ${variable} = ${primitiveExpression(styledObject, project, style, diagnostics)}${styleChain(styledObject, style)}`);
        const dimensions = dimensionChain(styledObject, variable, project);
        if (dimensions) lines.push(`        ${variable}${dimensions}`);
        lines.push(`        ${variable}.move_to(${coordinate(styledObject, project)})`);
        if (styledObject.transform.rotation) lines.push(`        ${variable}.rotate(${pyNumber(styledObject.transform.rotation)} * DEGREES)`);
        if (styledObject.transform.scaleX !== 1 || styledObject.transform.scaleY !== 1) {
          lines.push(`        ${variable}.stretch(${pyNumber(styledObject.transform.scaleX)}, 0).stretch(${pyNumber(styledObject.transform.scaleY)}, 1)`);
        }
        referenceTransforms.set(object.id, { ...styledObject.transform });
      }
      const reference = references.get(object.id);
      if (reference) lines.push(`        ${reference} = ${variable}.copy()`);
      if (object.type !== "group" && (preparedHiddenLeaves.has(object.id) || delayedLifetimeLeaves.has(object.id))) lines.push(`        ${variable}.set_opacity(0.0)`);
      emitted.add(object.id);
    };
    shot.objects.forEach(emit);

    // Entrance state is already expanded to each descendant and reduced from
    // that descendant's earliest visibility event. An entering ancestor must
    // not hide a child whose own earlier fade-out requires initial presence.
    const initialIds = shot.objects
      .filter((object) => isEffectivelyVisible(object, objectMap) && objectExistsAtTime(shot, object.id, 0) && object.type !== "group" && !entering.has(object.id))
      .map(({ id }) => id);
    if (initialIds.length) lines.push(`        self.add(${initialIds.map((id) => variables.get(id)).join(", ")})`);

    const components = animationComponents(schedule.events);
    let timelineCursor = 0;
    components.forEach((component, componentIndex) => {
      const gap = subtractTimelineTimes(component.start, timelineCursor);
      const pointOnly = component.events.every((event) => event.start === event.end);
      lines.push(`        # Animation component ${componentIndex + 1}: ${pyNumber(component.start)}s to ${pyNumber(component.end)}s`);
      const lanes = eventLanes(component, compiledScheduleShot).map((lane) => {
        const parts: string[] = [];
        let laneCursor = component.start;
        for (const event of lane) {
          const gap = subtractTimelineTimes(event.start, laneCursor);
          if (compareTimelineTimes(event.start, laneCursor) > 0) parts.push(`Wait(${pyDuration(gap)})`);
          parts.push(animationExpression(event, compiledScheduleShot, project, variables, references, referenceTransforms, diagnostics, firstVisibility, previewAt, previewAtEnd, previewBeforePointsAt));
          laneCursor = Math.max(laneCursor, event.end);
        }
        const laneRuntime = subtractTimelineTimes(lane.at(-1)!.end, component.start);
        return parts.length === 1
          ? parts[0]
          : `Succession(${parts.join(", ")}, group=Group(), run_time=${compareTimelineTimes(laneRuntime, 0) === 0 ? "0.0" : pyDuration(laneRuntime)})`;
      });
      const componentRuntime = subtractTimelineTimes(component.end, component.start);
      const componentExpression = lanes.length === 1
        ? lanes[0]
        : `AnimationGroup(${lanes.join(", ")}, group=Group(), lag_ratio=0, run_time=${compareTimelineTimes(componentRuntime, 0) === 0 ? "0.0" : pyDuration(componentRuntime)})`;
      if (pointOnly) {
        if (compareTimelineTimes(component.start, timelineCursor) > 0) {
          // Manim 0.21 rejects a zero-total-runtime Scene.play. Folding the
          // preceding authored gap into the same positive Succession preserves
          // the exact event timestamp without inventing an epsilon animation.
          lines.push(`        self.play(Succession(Wait(${pyDuration(gap)}), ${componentExpression}, group=Group(), run_time=${pyDuration(gap)}))`);
        } else {
          const nextStart = components[componentIndex + 1]?.start ?? shot.duration;
          const followingGap = subtractTimelineTimes(nextStart, component.end);
          if (compareTimelineTimes(nextStart, component.end) > 0) {
            lines.push(`        self.play(Succession(${componentExpression}, Wait(${pyDuration(followingGap)}), group=Group(), run_time=${pyDuration(followingGap)}))`);
            timelineCursor = nextStart;
          } else {
            diagnostics.push({
              severity: "error",
              code: "ZERO_EVENT_WITHOUT_POSITIVE_ENVELOPE",
              message: "A compiler-owned point event had no positive timeline interval to contain it and was omitted.",
              animationId: component.events[0].id,
            });
          }
        }
      } else {
        if (compareTimelineTimes(component.start, timelineCursor) > 0) {
          lines.push(`        self.play(Succession(Wait(${pyDuration(gap)}), group=Group(), run_time=${pyDuration(gap)}))`);
        }
        lines.push(`        self.play(${componentExpression})`);
      }
      timelineCursor = Math.max(timelineCursor, component.end);
    });
    const finalHold = subtractTimelineTimes(shot.duration, timelineCursor);
    if (compareTimelineTimes(shot.duration, timelineCursor) > 0) {
      lines.push(`        self.play(Succession(Wait(${pyDuration(finalHold)}), group=Group(), run_time=${pyDuration(finalHold)}))`);
    }
    if (shotIndex < project.shots.length - 1) {
      lines.push("        self.clear()");
      lines.push("");
    }
  });

  const python = `${lines.join("\n")}\n`;
  if (utf8ByteLength(python) > PROOFCANVAS_RENDER_SOURCE_MAX_BYTES) diagnostics.push({
    severity: "error",
    code: "GENERATED_SOURCE_TOO_LARGE",
    message: `Generated UTF-8 source is ${utf8ByteLength(python)} bytes and exceeds the ${PROOFCANVAS_RENDER_SOURCE_MAX_BYTES}-byte renderer limit.`,
  });
  return { python, diagnostics: boundedCompilerDiagnostics(diagnostics) };
}
