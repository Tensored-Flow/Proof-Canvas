import {
  PROOFCANVAS_TIME_EPSILON,
  ProjectDocumentSchema,
  RestrictedExpressionSchema,
  type ProjectDocument,
  type RestrictedExpression,
  type SceneAnimation,
  type SceneObject,
  type Shot,
  type StylePack,
} from "./schema";
import { firstVisibilityAnimationByTarget, initiallyHiddenByEntranceIds, previewShotAtAnimationEnd, previewShotAtTime } from "./preview";
import { styledTransform } from "./styles";

export interface CompilerDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  objectId?: string;
  animationId?: string;
}

export interface CompileResult {
  python: string;
  diagnostics: CompilerDiagnostic[];
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

// Generated source intentionally keeps numeric literals compact. Runtime
// values need one extra invariant: every schema-valid positive animation must
// remain positive after that eight-decimal serialization step.
const MIN_EMITTED_POSITIVE_DURATION = 0.00000001;

function emittedPositiveDuration(value: number): number {
  const rounded = Number(value.toFixed(8));
  return rounded > 0 ? rounded : MIN_EMITTED_POSITIVE_DURATION;
}

function pyDuration(value: number): string {
  return pyNumber(emittedPositiveDuration(value));
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
  const used = new Set<string>();
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
  const frameWidth = project.aspectRatio === "16:9" ? 960 : 540;
  const frameHeight = project.aspectRatio === "16:9" ? 540 : 960;
  const manimWidth = project.aspectRatio === "16:9" ? 14.222222 : 8;
  const scale = manimWidth / frameWidth;
  const x = (object.transform.x - frameWidth / 2) * scale;
  const y = (frameHeight / 2 - object.transform.y) * scale;
  return `[${pyNumber(x)}, ${pyNumber(y)}, 0]`;
}

function size(value: number | undefined, project: ProjectDocument): number {
  const frameWidth = project.aspectRatio === "16:9" ? 960 : 540;
  const manimWidth = project.aspectRatio === "16:9" ? 14.222222 : 8;
  return Math.max(0.02, (value ?? 40) * manimWidth / frameWidth);
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
  const parts = [`.set_color(${pyString(color)})`];
  if (fill) parts.push(`.set_fill(${pyString(fill)}, opacity=1.0)`);
  if (!["text", "math", "image"].includes(object.type)) parts.push(`.set_stroke(${pyString(stroke)}, width=${pyNumber(strokeWidth)})`);
  if (object.style.opacity !== undefined) parts.push(`.set_opacity(${pyNumber(object.style.opacity)})`);
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
      if (source.startsWith("data:")) {
        diagnostics.push({ severity: "warning", code: "INLINE_ASSET_BROWSER_ONLY", message: "Inline image data is represented by a labelled placeholder in Manim export.", objectId: object.id });
        return `VGroup(Rectangle(width=${pyNumber(width)}, height=${pyNumber(height)}), Text(${pyString(object.name)}, font_size=16))`;
      }
      diagnostics.push({ severity: "info", code: "ASSET_PATH_REQUIRED", message: `Render requires the checked-in asset ${source}.`, objectId: object.id });
      return object.type === "svg" ? `SVGMobject(${pyString(source.replace(/^\//, "public/"))})` : `ImageMobject(${pyString(source.replace(/^\//, "public/"))})`;
    }
    case "group":
      return "VGroup()";
  }
}

function easingName(easing: SceneAnimation["easing"]): string {
  switch (easing) {
    case "linear": return "linear";
    case "ease-in": return "rush_into";
    case "ease-out": return "rush_from";
    case "ease-in-out": return "smooth";
    case "editorial": return "rate_functions.ease_out_quart";
    case "spring-soft": return "rate_functions.ease_out_back";
  }
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
    const authored = safeDerivedTransform(styledTransform(object, style), object.transform, diagnostics, object.id);
    const semanticTarget = endMap.get(object.id)?.transform ?? object.transform;
    const styledTarget = safeDerivedTransform(
      styledTransform({ ...object, transform: semanticTarget }, style),
      authored,
      diagnostics,
      object.id,
      animationId,
      authored,
    );
    const opacity = endMap.get(object.id)?.preview.opacity ?? object.style.opacity ?? 1;
    return `${copyTransformTarget(object, authored, styledTarget, references.get(object.id)!, project)}.set_opacity(${pyNumber(opacity)})`;
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
  absoluteTarget?: string,
  hiddenAtStart = false,
): string {
  const runTime = pyDuration(animation.duration);
  const rate = easingName(animation.easing);
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
      if (hiddenAtStart) return `Wait(${runTime})`;
      return `Indicate(${variable}, color=${pyString(project.styles.find(({ id }) => id === project.activeStyleId)!.colors.warmAccent)}, scale_factor=${pyNumber(finite(animation.properties.scale, 1.08))}, run_time=${runTime}, rate_func=rate_functions.there_and_back)`;
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
  if (!renderableVisibilityFamilyIds(object, shot, objects).every((id) => firstVisibility.get(id)?.id === animation.id)) return false;
  return !shot.animations.some((candidate) => (
    candidate.start < animation.start
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
  animation: SceneAnimation,
  shot: Shot,
  project: ProjectDocument,
  variables: ReadonlyMap<string, string>,
  references: ReadonlyMap<string, string>,
  diagnostics: CompilerDiagnostic[],
  firstVisibility: ReturnType<typeof firstVisibilityAnimationByTarget>,
  previewAt: (time: number) => ReturnType<typeof previewShotAtTime>,
  previewAtEnd: (animation: SceneAnimation) => ReturnType<typeof previewShotAtAnimationEnd>,
): string {
  diagnoseAnimationProperties(animation, diagnostics);
  // The preview reducer is the semantic authority for state at an animation's
  // start. Using that state keeps generated relative Manim operations correct
  // after earlier scale, transform, move, or camera animations.
  const stateAtStart = previewAt(animation.start);
  if (animation.type === "camera-focus") {
    const x = finite(animation.properties.x, stateAtStart.camera.x);
    const y = finite(animation.properties.y, stateAtStart.camera.y);
    const zoom = finite(animation.properties.zoom, stateAtStart.camera.zoom);
    const rotation = finite(animation.properties.rotation, stateAtStart.camera.rotation);
    const proxy: SceneObject = { id: "camera", type: "group", name: "Camera", locked: false, visible: true, transform: { x, y, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} };
    return `Transform(self.camera.frame, Rectangle(width=config.frame_width / ${pyNumber(zoom)}, height=config.frame_height / ${pyNumber(zoom)}).move_to(${coordinate(proxy, project)}).rotate(${pyNumber(rotation)} * DEGREES), run_time=${pyDuration(animation.duration)}, rate_func=${easingName(animation.easing)})`;
  }
  const objectMap = new Map(shot.objects.map((object) => [object.id, object]));
  const previewObjectMap = new Map(stateAtStart.objects.map((object) => [object.id, object]));
  const stateAtEnd = previewAtEnd(animation);
  const endObjectMap = new Map(stateAtEnd.objects.map((object) => [object.id, object]));
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
  if (visibleTargetIds.length === 0) return `Wait(${pyDuration(animation.duration)})`;
  const expressions = visibleTargetIds.map((targetId) => {
    const object = objectMap.get(targetId)!;
    const semanticStart = previewObjectMap.get(targetId)?.transform ?? object.transform;
    const semanticTarget = semanticAnimationTarget(animation, semanticStart);
    const referenceTransform = safeDerivedTransform(styledTransform(object, activeStyle), object.transform, diagnostics, object.id);
    const targetTransform = safeDerivedTransform(
      styledTransform({ ...object, transform: semanticTarget }, activeStyle),
      referenceTransform,
      diagnostics,
      object.id,
      animation.id,
      referenceTransform,
    );
    const variable = variables.get(targetId)!;
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
      if (nativeEntrance) return `FadeIn(${variable}, run_time=${pyDuration(animation.duration)}, rate_func=${easingName(animation.easing)})`;
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
          stateAtEnd,
          diagnostics,
          animation.id,
        )
        : `${copyTransformTarget(object, referenceTransform, targetTransform, references.get(targetId)!, project)}.set_opacity(${pyNumber(endObjectMap.get(targetId)?.preview.opacity ?? object.style.opacity ?? 1)})`;
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
      absoluteTarget,
      hiddenAtStart,
    );
  });
  return expressions.length === 1 ? expressions[0] : `AnimationGroup(${expressions.join(", ")}, lag_ratio=0)`;
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
  animations: SceneAnimation[];
  start: number;
  end: number;
}

function animationComponents(animations: readonly SceneAnimation[]): AnimationComponent[] {
  const ordered = [...animations].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const components: AnimationComponent[] = [];
  for (const animation of ordered) {
    const end = animation.start + animation.duration;
    const current = components.at(-1);
    if (!current || animation.start >= current.end - PROOFCANVAS_TIME_EPSILON) {
      components.push({ animations: [animation], start: animation.start, end });
      continue;
    }
    current.animations.push(animation);
    current.end = Math.max(current.end, end);
  }
  return components;
}

/**
 * Conservative decoded-video duration for the exact sequence of self.play /
 * self.wait calls emitted below. Manim renders every positive call for at
 * least one whole frame, so authored duration alone is not an admission bound
 * for timelines containing many sub-frame components.
 */
export function estimateManimTimelineDurationUpperBound(project: ProjectDocument, frameRate: number): number {
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error("Frame rate must be a positive finite number");
  const quantizedEmittedRuntime = (duration: number) => Math.max(1, Math.ceil(duration * frameRate)) / frameRate;
  let total = 0;
  for (const shot of project.shots) {
    let timelineCursor = 0;
    for (const component of animationComponents(shot.animations)) {
      const gap = component.start - timelineCursor;
      if (gap > PROOFCANVAS_TIME_EPSILON) {
        total += quantizedEmittedRuntime(emittedPositiveDuration(gap));
      }
      // Manim derives the outer AnimationGroup runtime from its longest lane.
      // Each delayed lane is an emitted Wait(offset) plus an emitted animation
      // duration, so model those rounded Python literals rather than the
      // authored component span.
      const componentRuntime = Math.max(...component.animations.map((animation) => {
        const offset = animation.start - component.start;
        return (offset > PROOFCANVAS_TIME_EPSILON ? emittedPositiveDuration(offset) : 0)
          + emittedPositiveDuration(animation.duration);
      }));
      total += quantizedEmittedRuntime(componentRuntime);
      timelineCursor = Math.max(timelineCursor, component.end);
    }
    const finalHold = shot.duration - timelineCursor;
    if (finalHold > PROOFCANVAS_TIME_EPSILON || (shot.animations.length === 0 && finalHold > 0)) {
      total += quantizedEmittedRuntime(emittedPositiveDuration(finalHold));
    }
  }
  return total;
}

export function compileManim(input: ProjectDocument): CompileResult {
  const project = ProjectDocumentSchema.parse(input);
  const diagnostics: CompilerDiagnostic[] = [];
  const { objects: variables, references } = variableMaps(project);
  const lines: string[] = [
    "from manim import *",
    "import math",
    "",
    "",
    "class GeneratedScene(MovingCameraScene):",
    "    def construct(self):",
  ];

  project.shots.forEach((shot, shotIndex) => {
    const style = project.styles.find(({ id }) => id === project.activeStyleId)!;
    const objectMap = new Map(shot.objects.map((object) => [object.id, object]));
    const entering = new Set(
      [...initiallyHiddenByEntranceIds(shot)].filter((id) => {
        const object = objectMap.get(id);
        return object ? isRenderableObject(object, shot, objectMap) : false;
      }),
    );
    const firstVisibility = firstVisibilityAnimationByTarget(shot);
    const previewCache = new Map<string, ReturnType<typeof previewShotAtTime>>();
    const endPreviewCache = new Map<string, ReturnType<typeof previewShotAtAnimationEnd>>();
    const previewAt = (time: number) => {
      const key = time.toFixed(9);
      const cached = previewCache.get(key);
      if (cached) return cached;
      const preview = previewShotAtTime(shot, time);
      previewCache.set(key, preview);
      return preview;
    };
    const previewAtEnd = (animation: SceneAnimation) => {
      const end = animation.start + animation.duration;
      const hasAdjacentInstantEntrance = shot.animations.some((candidate) => (
        candidate.id !== animation.id
        && candidate.type === "appear"
        && candidate.start <= end
        && candidate.start >= end - PROOFCANVAS_TIME_EPSILON
      ));
      if (!hasAdjacentInstantEntrance) return previewAt(end);
      const cached = endPreviewCache.get(animation.id);
      if (cached) return cached;
      const preview = previewShotAtAnimationEnd(shot, animation);
      endPreviewCache.set(animation.id, preview);
      return preview;
    };
    const preparedHiddenLeaves = new Set<string>();
    for (const animation of shot.animations.filter(({ type }) => ENTRANCE_ANIMATION_TYPES.has(type))) {
      for (const targetId of animation.targetIds) {
        const object = objectMap.get(targetId);
        if (!object || !isRenderableObject(object, shot, objectMap) || canUseNativeEntrance(animation, object, shot, objectMap, firstVisibility)) continue;
        for (const familyId of renderableVisibilityFamilyIds(object, shot, objectMap)) {
          const member = objectMap.get(familyId);
          if (member?.type !== "group" && entering.has(familyId) && firstVisibility.get(familyId)?.id === animation.id) {
            preparedHiddenLeaves.add(familyId);
          }
        }
      }
    }
    const emitted = new Set<string>();
    lines.push(`        # Shot ${shotIndex + 1}: ${pyComment(shot.name)}`);
    lines.push(`        self.next_section(${pyString(shot.name)})`);
    lines.push(`        self.camera.background_color = ${pyString(style.colors.background)}`);
    const shotCamera: SceneObject = { id: "camera", type: "group", name: "Camera", locked: false, visible: true, transform: { x: shot.camera.x, y: shot.camera.y, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} };
    lines.push(`        self.camera.frame.become(Rectangle(width=config.frame_width / ${pyNumber(shot.camera.zoom)}, height=config.frame_height / ${pyNumber(shot.camera.zoom)}).move_to(${coordinate(shotCamera, project)}).rotate(${pyNumber(shot.camera.rotation)} * DEGREES))`);

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
        const styledObject = {
          ...object,
          transform: safeDerivedTransform(styledTransform(object, style), object.transform, diagnostics, object.id),
        };
        lines.push(`        ${variable} = ${primitiveExpression(styledObject, project, style, diagnostics)}${styleChain(styledObject, style)}`);
        const dimensions = dimensionChain(styledObject, variable, project);
        if (dimensions) lines.push(`        ${variable}${dimensions}`);
        lines.push(`        ${variable}.move_to(${coordinate(styledObject, project)})`);
        if (styledObject.transform.rotation) lines.push(`        ${variable}.rotate(${pyNumber(styledObject.transform.rotation)} * DEGREES)`);
        if (styledObject.transform.scaleX !== 1 || styledObject.transform.scaleY !== 1) {
          lines.push(`        ${variable}.stretch(${pyNumber(styledObject.transform.scaleX)}, 0).stretch(${pyNumber(styledObject.transform.scaleY)}, 1)`);
        }
      }
      const reference = references.get(object.id);
      if (reference) lines.push(`        ${reference} = ${variable}.copy()`);
      if (object.type !== "group" && preparedHiddenLeaves.has(object.id)) lines.push(`        ${variable}.set_opacity(0.0)`);
      emitted.add(object.id);
    };
    shot.objects.forEach(emit);

    // Entrance state is already expanded to each descendant and reduced from
    // that descendant's earliest visibility event. An entering ancestor must
    // not hide a child whose own earlier fade-out requires initial presence.
    const initialIds = shot.objects
      .filter((object) => isEffectivelyVisible(object, objectMap) && object.type !== "group" && !entering.has(object.id))
      .map(({ id }) => id);
    if (initialIds.length) lines.push(`        self.add(${initialIds.map((id) => variables.get(id)).join(", ")})`);

    const components = animationComponents(shot.animations);
    let timelineCursor = 0;
    components.forEach((component, componentIndex) => {
      const gap = component.start - timelineCursor;
      lines.push(`        # Animation component ${componentIndex + 1}: ${pyNumber(component.start)}s to ${pyNumber(component.end)}s`);
      if (gap > PROOFCANVAS_TIME_EPSILON) lines.push(`        self.wait(${pyDuration(gap)})`);
      const lanes = component.animations.map((animation) => {
        const expression = animationExpression(animation, shot, project, variables, references, diagnostics, firstVisibility, previewAt, previewAtEnd);
        const offset = animation.start - component.start;
        return offset > PROOFCANVAS_TIME_EPSILON ? `Succession(Wait(${pyDuration(offset)}), ${expression}, group=Group())` : expression;
      });
      if (lanes.length === 1) {
        lines.push(`        self.play(${lanes[0]})`);
      } else {
        lines.push("        self.play(AnimationGroup(");
        lanes.forEach((lane) => lines.push(`            ${lane},`));
        lines.push("            group=Group(),");
        lines.push("            lag_ratio=0,");
        lines.push("        ))");
      }
      timelineCursor = Math.max(timelineCursor, component.end);
    });
    const finalHold = shot.duration - timelineCursor;
    if (finalHold > PROOFCANVAS_TIME_EPSILON || (components.length === 0 && finalHold > 0)) {
      lines.push(`        self.wait(${pyDuration(finalHold)})`);
    }
    if (shotIndex < project.shots.length - 1) {
      lines.push("        self.clear()");
      lines.push("");
    }
  });

  return { python: `${lines.join("\n")}\n`, diagnostics };
}
