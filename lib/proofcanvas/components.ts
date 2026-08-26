import { logicalFrameFor } from "./frame";
import { allocateId, collectProjectIds } from "./ids";
import {
  ProjectDocumentSchema,
  cloneSerializable,
  type JsonValue,
  type ProjectDocument,
  type SceneObject,
  type StylePack,
} from "./schema";
import { styleById, transformCorners } from "./styles";

/** Drag payload shared by the component library and the canvas drop target. */
export const PROOFCANVAS_SEMANTIC_COMPONENT_MIME = "application/x-proofcanvas-semantic-component" as const;

export type SemanticComponentId =
  | "mathematical-title"
  | "definition-block"
  | "proposition-statement"
  | "proof-step-sequence"
  | "equation-chain"
  | "annotated-diagram"
  | "case-comparison"
  | "focus-callout"
  | "marginal-note"
  | "recursive-intervals"
  | "vector-explanation"
  | "example-abstraction";

export interface SemanticComponentDefinition {
  readonly id: SemanticComponentId;
  readonly name: string;
  readonly description: string;
}

export const SEMANTIC_COMPONENTS: readonly SemanticComponentDefinition[] = Object.freeze([
  { id: "mathematical-title", name: "Title & subtitle", description: "An editable title with a supporting mathematical subtitle." },
  { id: "definition-block", name: "Definition", description: "A labelled definition set beside a fine vertical rule." },
  { id: "proposition-statement", name: "Theorem / proposition", description: "An editable labelled statement under a fine horizontal rule." },
  { id: "proof-step-sequence", name: "Proof-step sequence", description: "Three ordered mathematical proof steps joined by editable arrows." },
  { id: "equation-chain", name: "Equation derivation", description: "A grouped sequence of aligned mathematical derivation steps." },
  { id: "annotated-diagram", name: "Annotated graph", description: "Editable axes, a safe sine graph, an arrow, and a marginal note." },
  { id: "case-comparison", name: "Case comparison", description: "Two editable mathematical cases arranged for direct comparison." },
  { id: "focus-callout", name: "Callout", description: "An open editorial rule with a compact label and emphasis statement." },
  { id: "marginal-note", name: "Marginal note", description: "A restrained side note with a rule, annotation, and mathematical reference." },
  { id: "recursive-intervals", name: "Recursive construction", description: "Editable generations of a middle-third construction." },
  { id: "vector-explanation", name: "Vector explanation", description: "Safe vector notation paired with an editable arrow and explanation." },
  { id: "example-abstraction", name: "Example & abstraction", description: "A concrete example compared directly with its abstract pattern." },
]);

export function semanticComponentById(id: string): SemanticComponentDefinition | undefined {
  return SEMANTIC_COMPONENTS.find((component) => component.id === id);
}

export interface SemanticComponentOrigin {
  readonly x: number;
  readonly y: number;
}

const COMPONENT_FRAME_INSET = 24;

type ComponentObjectOptions = Readonly<{
  semanticRole: string;
  style?: SceneObject["style"];
  rotation?: number;
}>;

type ComponentFactoryContext = Readonly<{
  id: (hint: string, prefix?: string) => string;
  groupId: string;
  style: StylePack;
}>;

function object(
  context: ComponentFactoryContext,
  hint: string,
  type: SceneObject["type"],
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  properties: Readonly<Record<string, JsonValue>>,
  options: ComponentObjectOptions,
): SceneObject {
  return {
    id: context.id(hint),
    type,
    name,
    parentId: context.groupId,
    locked: false,
    visible: true,
    transform: {
      x,
      y,
      width,
      height,
      rotation: options.rotation ?? 0,
      scaleX: 1,
      scaleY: 1,
    },
    style: options.style ?? {},
    semanticRole: options.semanticRole,
    properties: type === "math"
      ? { ...properties, renderer: "mathtex", mode: "display" }
      : { ...properties },
  };
}

function textStyle(
  style: StylePack,
  size: number,
  options: Readonly<{ weight?: number; annotation?: boolean; align?: "left" | "center" | "right" }> = {},
): SceneObject["style"] {
  const fontSize = Math.min(256, Math.max(1, Number((size * style.typography.bodyScale).toFixed(4))));
  return {
    fontSize,
    fontFamily: style.typography.statement,
    textAlign: options.align ?? (style.layout.tendency === "centred" ? "center" : "left"),
    ...(options.weight === undefined ? {} : { fontWeight: options.weight }),
    ...(options.annotation ? { roughEmphasis: style.annotation.treatment === "marginal-hand" } : {}),
  };
}

function titleStyle(style: StylePack, size: number): SceneObject["style"] {
  return {
    ...textStyle(style, size * style.typography.titleScale, { weight: 600 }),
    fontFamily: style.typography.statement,
  };
}

function mathStyle(style: StylePack, size: number): SceneObject["style"] {
  const fontSize = Math.min(256, Math.max(1, Number((size * style.typography.bodyScale).toFixed(4))));
  return {
    fontSize,
    fontFamily: style.typography.math,
    textAlign: style.layout.tendency === "centred" ? "center" : "left",
  };
}

function strokeStyle(style: StylePack, weight: "fine" | "regular" | "emphasis" = "regular"): SceneObject["style"] {
  return { strokeWidth: style.strokes[weight] };
}

/** Build one component around local origin (0, 0). */
function componentLeaves(componentId: SemanticComponentId, context: ComponentFactoryContext): SceneObject[] {
  const { style } = context;
  switch (componentId) {
    case "mathematical-title":
      return [
        object(context, "title", "text", "Title", 0, -28, 420, 52, { content: "A structure worth seeing" }, { semanticRole: "title", style: titleStyle(style, 32) }),
        object(context, "subtitle", "math", "Mathematical subtitle", -24, 30, 372, 38, { content: "f(x) \\to 0" }, { semanticRole: "subtitle", style: mathStyle(style, 24) }),
      ];
    case "definition-block":
      return [
        object(context, "definition-rule", "line", "Definition rule", -194, 5, 112, 1, {}, { semanticRole: "definition-rule", style: strokeStyle(style, "fine"), rotation: 90 }),
        object(context, "definition-label", "text", "Definition label", 14, -34, 380, 24, { content: "Definition" }, { semanticRole: "definition-label", style: textStyle(style, 14, { weight: 600 }) }),
        object(context, "definition-body", "text", "Definition statement", 14, 17, 380, 60, { content: "A fixed point is unchanged by the map T." }, { semanticRole: "definition-statement", style: textStyle(style, 22) }),
      ];
    case "proposition-statement":
      return [
        object(context, "rule", "line", "Statement rule", 0, -50, 410, 1, {}, { semanticRole: "statement-rule", style: strokeStyle(style, "fine") }),
        object(context, "proposition-label", "text", "Proposition label", -142, -25, 126, 22, { content: "Proposition" }, { semanticRole: "proposition-label", style: textStyle(style, 14, { weight: 600 }) }),
        object(context, "proposition", "text", "Proposition statement", 0, 19, 410, 58, { content: "The construction preserves every endpoint." }, { semanticRole: "proposition", style: textStyle(style, 23) }),
      ];
    case "proof-step-sequence":
      return [
        object(context, "proof-heading", "text", "Proof heading", 0, -89, 410, 30, { content: "Proof, step by step" }, { semanticRole: "proof-heading", style: titleStyle(style, 19) }),
        object(context, "proof-step-1", "math", "Proof step 1", 0, -51, 390, 34, { content: "x \\le c_n" }, { semanticRole: "proof-step", style: mathStyle(style, 22) }),
        object(context, "proof-arrow-1", "arrow", "Proof connector 1", 0, -24, 54, 12, {}, { semanticRole: "proof-step-connector", style: strokeStyle(style, "fine"), rotation: 90 }),
        object(context, "proof-step-2", "math", "Proof step 2", 0, 4, 390, 34, { content: "c_{n+1} \\le c_n" }, { semanticRole: "proof-step", style: mathStyle(style, 22) }),
        object(context, "proof-arrow-2", "arrow", "Proof connector 2", 0, 31, 54, 12, {}, { semanticRole: "proof-step-connector", style: strokeStyle(style, "fine"), rotation: 90 }),
        object(context, "proof-step-3", "math", "Proof step 3", 0, 61, 390, 34, { content: "\\lim_{n\\to\\infty} c_n = x" }, { semanticRole: "proof-step-conclusion", style: mathStyle(style, 22) }),
      ];
    case "equation-chain":
      return [
        object(context, "equation-1", "math", "Equation 1", 0, -48, 390, 38, { content: "L_0 = 1" }, { semanticRole: "equation-step", style: mathStyle(style, 25) }),
        object(context, "equation-2", "math", "Equation 2", 0, 0, 390, 38, { content: "L_n = (2/3)^n" }, { semanticRole: "surviving-length-equation", style: mathStyle(style, 25) }),
        object(context, "equation-3", "math", "Equation 3", 0, 48, 390, 38, { content: "\\lim_{n\\to\\infty} L_n = 0" }, { semanticRole: "equation-conclusion", style: mathStyle(style, 25) }),
      ];
    case "annotated-diagram": {
      const axes = object(context, "diagram-axes", "axes", "Graph axes", -55, 8, 290, 176, { xMin: -4, xMax: 4, yMin: -2, yMax: 2 }, { semanticRole: "diagram-axes", style: strokeStyle(style, "fine") });
      const graph = object(context, "diagram-graph", "graph", "Sine graph", -55, 8, 290, 176, { expression: { kind: "sin", value: { kind: "variable" } }, xMin: -4, xMax: 4 }, { semanticRole: "diagram-graph", style: strokeStyle(style, "regular") });
      return [
        axes,
        graph,
        object(context, "diagram-arrow", "arrow", "Annotation arrow", 119, -52, 96, 18, { targetId: graph.id }, { semanticRole: "annotation-arrow", style: strokeStyle(style, "regular"), rotation: -18 }),
        object(context, "diagram-note", "text", "Graph note", 145, -101, 150, 46, { content: "the curve changes direction" }, { semanticRole: "annotation", style: textStyle(style, 16, { annotation: true }) }),
      ];
    }
    case "case-comparison":
      return [
        object(context, "case-a-label", "text", "Case A", -116, -50, 176, 28, { content: "Case A — finite" }, { semanticRole: "case-label", style: textStyle(style, 17, { weight: 600 }) }),
        object(context, "case-a-expression", "math", "Case A expression", -116, 13, 176, 58, { content: "n < \\infty" }, { semanticRole: "case-expression", style: mathStyle(style, 28) }),
        object(context, "case-divider", "line", "Case divider", 0, 8, 118, 1, {}, { semanticRole: "case-divider", style: strokeStyle(style, "fine"), rotation: 90 }),
        object(context, "case-b-label", "text", "Case B", 116, -50, 176, 28, { content: "Case B — limiting" }, { semanticRole: "case-label", style: textStyle(style, 17, { weight: 600 }) }),
        object(context, "case-b-expression", "math", "Case B expression", 116, 13, 176, 58, { content: "n \\to \\infty" }, { semanticRole: "case-expression", style: mathStyle(style, 28) }),
      ];
    case "focus-callout":
      return [
        object(context, "callout-frame", "line", "Open focus rule", -190, 0, 116, 1, {}, { semanticRole: "focus-frame", style: strokeStyle(style, "emphasis"), rotation: 90 }),
        object(context, "callout-label", "text", "Focus label", 8, -35, 360, 24, { content: "Key observation" }, { semanticRole: "focus-label", style: textStyle(style, 14, { weight: 600 }) }),
        object(context, "callout-text", "text", "Callout", 8, 13, 360, 62, { content: "This is the moment to hold." }, { semanticRole: "focus-callout", style: textStyle(style, 24, { annotation: true }) }),
      ];
    case "marginal-note":
      return [
        object(context, "margin-rule", "line", "Marginal rule", -86, -47, 172, 1, {}, { semanticRole: "marginal-rule", style: strokeStyle(style, "fine") }),
        object(context, "margin-label", "text", "Marginal label", -58, -24, 116, 22, { content: "Margin note" }, { semanticRole: "marginal-label", style: textStyle(style, 14, { weight: 600 }) }),
        object(context, "margin-copy", "text", "Marginal annotation", 0, 21, 220, 58, { content: "Keep this relation visible while the argument develops." }, { semanticRole: "marginal-note", style: textStyle(style, 17, { annotation: true }) }),
      ];
    case "recursive-intervals": {
      const children: SceneObject[] = [];
      [1, 2, 4].forEach((count, row) => {
        const total = 360;
        const gap = row === 0 ? 0 : 10;
        const width = (total - gap * (count - 1)) / count;
        for (let index = 0; index < count; index += 1) {
          children.push(object(
            context,
            `interval-${row}-${index}`,
            "rectangle",
            `Interval ${row}.${index + 1}`,
            -total / 2 + width / 2 + index * (width + gap),
            -52 + row * 52,
            width,
            12,
            { generation: row },
            { semanticRole: "surviving-interval" },
          ));
        }
      });
      return children;
    }
    case "vector-explanation":
      return [
        object(context, "vector-notation", "math", "Source vector", -98, -51, 250, 42, { content: "\\vec{v}=(3,2)" }, { semanticRole: "vector-source", style: mathStyle(style, 27) }),
        object(context, "vector-arrow", "double-arrow", "Vector relation", 0, -8, 112, 18, { shape: { kind: "double-arrow", lineCap: "round", startTipShape: "stealth", endTipShape: "stealth", tipSizeRatio: 0.18 } }, { semanticRole: "vector-relation", style: strokeStyle(style, "emphasis") }),
        object(context, "vector-decomposition", "math", "Vector decomposition", 80, 34, 300, 42, { content: "\\vec{v}=3e_1+2e_2" }, { semanticRole: "vector-decomposition", style: mathStyle(style, 25) }),
        object(context, "vector-copy", "text", "Vector explanation", -20, 75, 380, 34, { content: "The coordinates become basis directions." }, { semanticRole: "vector-explanation", style: textStyle(style, 18) }),
      ];
    case "example-abstraction":
      return [
        object(context, "example-divider", "line", "Example divider", 0, 5, 128, 1, {}, { semanticRole: "example-divider", style: strokeStyle(style, "fine"), rotation: 90 }),
        object(context, "example-label", "text", "Worked example label", -116, -52, 176, 26, { content: "Concrete example" }, { semanticRole: "example-label", style: textStyle(style, 15, { weight: 600 }) }),
        object(context, "example-expression", "math", "Worked example", -116, 14, 190, 58, { content: "1+3+5+7=16" }, { semanticRole: "example-expression", style: mathStyle(style, 24) }),
        object(context, "abstraction-label", "text", "Abstraction label", 116, -52, 176, 26, { content: "Abstract pattern" }, { semanticRole: "abstraction-label", style: textStyle(style, 15, { weight: 600 }) }),
        object(context, "abstraction", "math", "Abstract pattern", 116, 14, 210, 58, { content: "\\sum_{k=0}^{n}(2k+1)=(n+1)^2" }, { semanticRole: "abstraction", style: mathStyle(style, 21) }),
      ];
  }
}

function exactBounds(objects: readonly SceneObject[]): Readonly<{ left: number; right: number; top: number; bottom: number }> {
  const corners = objects.flatMap(({ transform }) => transformCorners(transform));
  return {
    left: Math.min(...corners.map(({ x }) => x)),
    right: Math.max(...corners.map(({ x }) => x)),
    top: Math.min(...corners.map(({ y }) => y)),
    bottom: Math.max(...corners.map(({ y }) => y)),
  };
}

function translated(objects: readonly SceneObject[], x: number, y: number): SceneObject[] {
  return objects.map((candidate) => ({
    ...candidate,
    transform: { ...candidate.transform, x: candidate.transform.x + x, y: candidate.transform.y + y },
  }));
}

function placeInsideFrame(
  objects: readonly SceneObject[],
  requested: SemanticComponentOrigin,
  frame: ReturnType<typeof logicalFrameFor>,
): SceneObject[] {
  const nominal = exactBounds(objects);
  const nominalWidth = nominal.right - nominal.left;
  const nominalHeight = nominal.bottom - nominal.top;
  const availableWidth = frame.width - COMPONENT_FRAME_INSET * 2;
  const availableHeight = frame.height - COMPONENT_FRAME_INSET * 2;
  if (nominalWidth > availableWidth || nominalHeight > availableHeight) {
    throw new Error(`Semantic component footprint ${nominalWidth}x${nominalHeight} cannot fit the ${frame.width}x${frame.height} frame inset`);
  }
  const centered = translated(
    objects,
    requested.x - (nominal.left + nominal.right) / 2,
    requested.y - (nominal.top + nominal.bottom) / 2,
  );
  const bounds = exactBounds(centered);
  const shiftX = bounds.left < COMPONENT_FRAME_INSET
    ? COMPONENT_FRAME_INSET - bounds.left
    : bounds.right > frame.width - COMPONENT_FRAME_INSET
      ? frame.width - COMPONENT_FRAME_INSET - bounds.right
      : 0;
  const shiftY = bounds.top < COMPONENT_FRAME_INSET
    ? COMPONENT_FRAME_INSET - bounds.top
    : bounds.bottom > frame.height - COMPONENT_FRAME_INSET
      ? frame.height - COMPONENT_FRAME_INSET - bounds.bottom
      : 0;
  return translated(centered, shiftX, shiftY);
}

function rootFor(
  component: SemanticComponentDefinition,
  groupId: string,
  leaves: readonly SceneObject[],
): SceneObject {
  const bounds = exactBounds(leaves);
  return {
    id: groupId,
    type: "group",
    name: component.name,
    locked: false,
    visible: true,
    transform: {
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2,
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    },
    style: {},
    semanticRole: `semantic-component-${component.id}`,
    properties: {},
  };
}

function firstProjectIssue(result: Exclude<ReturnType<typeof ProjectDocumentSchema.safeParse>, { success: true }>): string {
  const issue = result.error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return `${issue?.message ?? "Project validation failed"}${path}`;
}

/**
 * Instantiate a parsed, insertion-ready component without mutating `project`.
 * The complete candidate project is schema-preflighted so per-shot object,
 * project graph/native-work, canonical JSON, and namespace ceilings fail
 * atomically before any caller can persist the returned objects.
 */
export function instantiateSemanticComponent(
  project: ProjectDocument,
  shotId: string,
  componentId: SemanticComponentId,
  origin?: SemanticComponentOrigin,
): SceneObject[] {
  const sourceResult = ProjectDocumentSchema.safeParse(project);
  if (!sourceResult.success) throw new Error(`Cannot instantiate semantic component: ${firstProjectIssue(sourceResult)}`);
  const source = sourceResult.data;
  const shotIndex = source.shots.findIndex(({ id }) => id === shotId);
  if (shotIndex < 0) throw new Error(`Shot not found: ${shotId}`);
  const component = semanticComponentById(componentId);
  if (!component) throw new Error(`Semantic component not found: ${componentId}`);
  const activeStyle = styleById(source.styles, source.activeStyleId);
  if (!activeStyle) throw new Error(`Active style not found: ${source.activeStyleId}`);
  const frame = logicalFrameFor(source.settings.aspectRatio);
  const requested = origin ?? { x: frame.centerX, y: frame.centerY };
  if (!Number.isFinite(requested.x) || !Number.isFinite(requested.y)) {
    throw new Error("Semantic component origin must contain finite x and y coordinates");
  }

  const reserved = collectProjectIds(source);
  const id = (hint: string, prefix = "object") => {
    const next = allocateId(prefix, reserved, hint);
    reserved.add(next);
    return next;
  };
  const groupId = id(componentId, "group");
  const context: ComponentFactoryContext = { id, groupId, style: activeStyle };
  const localLeaves = componentLeaves(componentId, context);
  const leaves = placeInsideFrame(localLeaves, requested, frame);
  const objects = [rootFor(component, groupId, leaves), ...leaves];

  const candidate = cloneSerializable(source);
  candidate.shots[shotIndex].objects.push(...objects);
  const parsedCandidate = ProjectDocumentSchema.safeParse(candidate);
  if (!parsedCandidate.success) {
    throw new Error(`Cannot insert ${component.name}: ${firstProjectIssue(parsedCandidate)}`);
  }
  return cloneSerializable(parsedCandidate.data.shots[shotIndex].objects.slice(source.shots[shotIndex].objects.length));
}

export function insertSemanticComponent(
  project: ProjectDocument,
  shotId: string,
  componentId: SemanticComponentId,
  origin?: SemanticComponentOrigin,
): ProjectDocument {
  const shotIndex = project.shots.findIndex(({ id }) => id === shotId);
  if (shotIndex < 0) throw new Error(`Shot not found: ${shotId}`);
  const objects = instantiateSemanticComponent(project, shotId, componentId, origin);
  const next = cloneSerializable(project);
  next.shots[shotIndex].objects.push(...objects);
  return ProjectDocumentSchema.parse(next);
}
