import { allocateId } from "./ids";
import { logicalFrameFor, type ProofCanvasAspectRatio } from "./frame";
import {
  ProjectDocumentSchema,
  cloneSerializable,
  type ProjectDocument,
  type SceneObject,
} from "./schema";

export type SemanticComponentId =
  | "mathematical-title"
  | "proposition-statement"
  | "equation-chain"
  | "annotated-diagram"
  | "focus-callout"
  | "recursive-intervals";

export interface SemanticComponentDefinition {
  id: SemanticComponentId;
  name: string;
  description: string;
}

export const SEMANTIC_COMPONENTS: readonly SemanticComponentDefinition[] = Object.freeze([
  { id: "mathematical-title", name: "Mathematical title", description: "A title and supporting mathematical subtitle." },
  { id: "proposition-statement", name: "Proposition", description: "An editable statement with a fine editorial rule." },
  { id: "equation-chain", name: "Equation chain", description: "A grouped sequence of aligned mathematical steps." },
  { id: "annotated-diagram", name: "Annotated diagram", description: "Editable geometry, arrow, and marginal note." },
  { id: "focus-callout", name: "Focus callout", description: "A restrained emphasis frame and annotation." },
  { id: "recursive-intervals", name: "Recursive intervals", description: "Editable generations of a middle-third construction." },
]);

type Point = { x: number; y: number };

function object(
  id: string,
  type: SceneObject["type"],
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  properties: SceneObject["properties"],
  parentId?: string,
): SceneObject {
  return {
    id,
    type,
    name,
    ...(parentId ? { parentId } : {}),
    locked: false,
    visible: true,
    transform: { x, y, width, height, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties,
  };
}

export function instantiateSemanticComponent(
  componentId: SemanticComponentId,
  existingIds: ReadonlySet<string>,
  origin?: Point,
  aspectRatio: ProofCanvasAspectRatio = "16:9",
): SceneObject[] {
  const frame = logicalFrameFor(aspectRatio);
  const resolvedOrigin = origin ?? { x: frame.centerX, y: frame.centerY };
  const reserved = new Set(existingIds);
  const id = (hint: string, prefix: string = "object") => {
    const next = allocateId(prefix, reserved, hint);
    reserved.add(next);
    return next;
  };
  const groupId = id(componentId, "group");
  const group = object(groupId, "group", SEMANTIC_COMPONENTS.find(({ id: candidate }) => candidate === componentId)?.name ?? componentId, resolvedOrigin.x, resolvedOrigin.y, 360, 150, {});

  origin = resolvedOrigin;

  switch (componentId) {
    case "mathematical-title":
      return [
        group,
        { ...object(id("title"), "text", "Title", origin.x, origin.y - 24, 340, 48, { content: "A mathematical idea" }, groupId), semanticRole: "title", style: { fontSize: 42, textAlign: "left" } },
        { ...object(id("subtitle"), "math", "Subtitle", origin.x, origin.y + 28, 300, 36, { content: "f(x) \\to 0" }, groupId), semanticRole: "subtitle", style: { fontSize: 25, textAlign: "left" } },
      ];
    case "proposition-statement":
      return [
        group,
        { ...object(id("rule"), "line", "Statement rule", origin.x - 170, origin.y - 55, 340, 1, {}, groupId), semanticRole: "statement-rule" },
        { ...object(id("proposition"), "text", "Proposition", origin.x, origin.y - 12, 330, 54, { content: "Proposition. The construction preserves every endpoint." }, groupId), semanticRole: "proposition", style: { fontSize: 25, textAlign: "left" } },
      ];
    case "equation-chain":
      return [
        { ...group, transform: { ...group.transform, width: 320, height: 170 } },
        ...["L_0 = 1", "L_n = (2/3)^n", "\\lim_{n\\to\\infty} L_n = 0"].map((content, index) => ({
          ...object(id(`equation-${index + 1}`), "math", `Equation ${index + 1}`, origin.x, origin.y - 52 + index * 52, 300, 38, { content }, groupId),
          semanticRole: index === 1 ? "surviving-length-equation" : "equation-step",
          style: { fontSize: 26, textAlign: "left" as const },
        })),
      ];
    case "annotated-diagram": {
      const circleId = id("diagram-circle");
      return [
        group,
        { ...object(circleId, "circle", "Diagram focus", origin.x - 55, origin.y, 82, 82, {}, groupId), semanticRole: "diagram-subject" },
        { ...object(id("diagram-arrow"), "arrow", "Annotation arrow", origin.x + 12, origin.y - 12, 105, 40, { targetId: circleId }, groupId), semanticRole: "annotation-arrow" },
        { ...object(id("diagram-note"), "text", "Marginal note", origin.x + 120, origin.y - 32, 130, 58, { content: "the surviving part" }, groupId), semanticRole: "annotation", style: { fontSize: 18, textAlign: "left" } },
      ];
    }
    case "focus-callout":
      return [
        { ...group, transform: { ...group.transform, width: 290, height: 105 } },
        { ...object(id("callout-frame"), "rectangle", "Callout frame", origin.x, origin.y, 290, 105, {}, groupId), semanticRole: "focus-frame", style: { opacity: 0.18, roughEmphasis: true } },
        { ...object(id("callout-text"), "text", "Callout", origin.x, origin.y, 250, 64, { content: "This is the moment to hold." }, groupId), semanticRole: "focus-callout", style: { fontSize: 23, textAlign: "left" } },
      ];
    case "recursive-intervals": {
      const rows = [1, 2, 4];
      const children: SceneObject[] = [];
      rows.forEach((count, row) => {
        const total = 310;
        const gap = row === 0 ? 0 : 8;
        const width = (total - gap * (count - 1)) / count;
        for (let index = 0; index < count; index += 1) {
          children.push({
            ...object(id(`interval-${row}-${index}`), "rectangle", `Interval ${row}.${index + 1}`, origin.x - total / 2 + width / 2 + index * (width + gap), origin.y - 52 + row * 52, width, 12, { generation: row }, groupId),
            semanticRole: "surviving-interval",
          });
        }
      });
      return [{ ...group, transform: { ...group.transform, width: 350, height: 145 }, semanticRole: "interval-diagram" }, ...children];
    }
  }
}

export function insertSemanticComponent(
  project: ProjectDocument,
  shotId: string,
  componentId: SemanticComponentId,
  origin?: Point,
): ProjectDocument {
  const shotIndex = project.shots.findIndex(({ id }) => id === shotId);
  if (shotIndex < 0) throw new Error(`Shot not found: ${shotId}`);
  const ids = new Set(project.shots.flatMap((shot) => shot.objects.map(({ id }) => id)));
  const objects = instantiateSemanticComponent(componentId, ids, origin, project.settings.aspectRatio);
  const next = cloneSerializable(project);
  next.shots[shotIndex].objects.push(...objects);
  return ProjectDocumentSchema.parse(next);
}
