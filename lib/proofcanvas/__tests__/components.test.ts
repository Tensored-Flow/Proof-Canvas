import { compileManim } from "../compiler";
import {
  PROOFCANVAS_SEMANTIC_COMPONENT_MIME,
  SEMANTIC_COMPONENTS,
  insertSemanticComponent,
  instantiateSemanticComponent,
  semanticComponentById,
  type SemanticComponentId,
} from "../components";
import { logicalFrameFor, resolutionFor, type ProofCanvasAspectRatio } from "../frame";
import { applyOperations } from "../operations";
import {
  PROOFCANVAS_PROJECT_MAX_BYTES,
  ProjectDocumentSchema,
  cloneSerializable,
  type ProjectDocument,
  type SceneObject,
} from "../schema";
import { DEFAULT_STYLE_PACKS, transformCorners } from "../styles";
import { createProjectTemplate } from "../templates";

type ExpectedLeaf = readonly [SceneObject["type"], string];

const EXPECTED_COMPONENTS: ReadonlyArray<Readonly<{
  id: SemanticComponentId;
  name: string;
  leaves: readonly ExpectedLeaf[];
}>> = [
  {
    id: "mathematical-title",
    name: "Title & subtitle",
    leaves: [["text", "title"], ["math", "subtitle"]],
  },
  {
    id: "definition-block",
    name: "Definition",
    leaves: [["line", "definition-rule"], ["text", "definition-label"], ["text", "definition-statement"]],
  },
  {
    id: "proposition-statement",
    name: "Theorem / proposition",
    leaves: [["line", "statement-rule"], ["text", "proposition-label"], ["text", "proposition"]],
  },
  {
    id: "proof-step-sequence",
    name: "Proof-step sequence",
    leaves: [
      ["text", "proof-heading"],
      ["math", "proof-step"],
      ["arrow", "proof-step-connector"],
      ["math", "proof-step"],
      ["arrow", "proof-step-connector"],
      ["math", "proof-step-conclusion"],
    ],
  },
  {
    id: "equation-chain",
    name: "Equation derivation",
    leaves: [["math", "equation-step"], ["math", "surviving-length-equation"], ["math", "equation-conclusion"]],
  },
  {
    id: "annotated-diagram",
    name: "Annotated graph",
    leaves: [["axes", "diagram-axes"], ["graph", "diagram-graph"], ["arrow", "annotation-arrow"], ["text", "annotation"]],
  },
  {
    id: "case-comparison",
    name: "Case comparison",
    leaves: [["text", "case-label"], ["math", "case-expression"], ["line", "case-divider"], ["text", "case-label"], ["math", "case-expression"]],
  },
  {
    id: "focus-callout",
    name: "Callout",
    leaves: [["line", "focus-frame"], ["text", "focus-label"], ["text", "focus-callout"]],
  },
  {
    id: "marginal-note",
    name: "Marginal note",
    leaves: [["line", "marginal-rule"], ["text", "marginal-label"], ["text", "marginal-note"]],
  },
  {
    id: "recursive-intervals",
    name: "Recursive construction",
    leaves: Array.from({ length: 7 }, () => ["rectangle", "surviving-interval"] as const),
  },
  {
    id: "vector-explanation",
    name: "Vector explanation",
    leaves: [["math", "vector-source"], ["double-arrow", "vector-relation"], ["math", "vector-decomposition"], ["text", "vector-explanation"]],
  },
  {
    id: "example-abstraction",
    name: "Example & abstraction",
    leaves: [["line", "example-divider"], ["text", "example-label"], ["math", "example-expression"], ["text", "abstraction-label"], ["math", "abstraction"]],
  },
];

function blankProject(): ProjectDocument {
  return createProjectTemplate("blank", "project-components", "Component test", "2026-08-26T00:00:00.000Z");
}

function projectFor(aspectRatio: ProofCanvasAspectRatio, activeStyleId: string): ProjectDocument {
  const project = cloneSerializable(blankProject());
  const frame = logicalFrameFor(aspectRatio);
  project.settings.aspectRatio = aspectRatio;
  project.settings.resolution = resolutionFor(aspectRatio, project.settings.renderPreset);
  project.activeStyleId = activeStyleId;
  project.shots[0].camera = { x: frame.centerX, y: frame.centerY, zoom: 1, rotation: 0 };
  return ProjectDocumentSchema.parse(project);
}

function leafBounds(leaves: readonly SceneObject[]) {
  const corners = leaves.flatMap(({ transform }) => transformCorners(transform));
  return {
    left: Math.min(...corners.map(({ x }) => x)),
    right: Math.max(...corners.map(({ x }) => x)),
    top: Math.min(...corners.map(({ y }) => y)),
    bottom: Math.max(...corners.map(({ y }) => y)),
  };
}

function expectExactRootBounds(objects: readonly SceneObject[]): void {
  const [root, ...leaves] = objects;
  const bounds = leafBounds(leaves);
  expect(root.transform.x).toBeCloseTo((bounds.left + bounds.right) / 2, 10);
  expect(root.transform.y).toBeCloseTo((bounds.top + bounds.bottom) / 2, 10);
  expect(root.transform.width).toBeCloseTo(bounds.right - bounds.left, 10);
  expect(root.transform.height).toBeCloseTo(bounds.bottom - bounds.top, 10);
  expect(root.transform).toMatchObject({ rotation: 0, scaleX: 1, scaleY: 1 });
}

function expectRefusalWithoutMutation(project: ProjectDocument, action: () => unknown): void {
  const before = JSON.stringify(project);
  expect(action).toThrow();
  expect(JSON.stringify(project)).toBe(before);
}

describe("editable semantic components", () => {
  test("publishes the exact ordered 12-card registry and drag MIME", () => {
    expect(PROOFCANVAS_SEMANTIC_COMPONENT_MIME).toBe("application/x-proofcanvas-semantic-component");
    expect(SEMANTIC_COMPONENTS.map(({ id, name }) => ({ id, name }))).toEqual(
      EXPECTED_COMPONENTS.map(({ id, name }) => ({ id, name })),
    );
    expect(new Set(SEMANTIC_COMPONENTS.map(({ id }) => id)).size).toBe(12);
    expect(semanticComponentById("annotated-diagram")).toBe(SEMANTIC_COMPONENTS[5]);
    expect(semanticComponentById("not-a-component")).toBeUndefined();
  });

  test("inserts exactly 12 roots and 48 leaves with audited types, roles, math authority, and no authored motion or palette literals", () => {
    let project = blankProject();
    const shotId = project.shots[0].id;
    const beforeTimeline = cloneSerializable({
      animations: project.shots[0].animations,
      propertyTracks: project.shots[0].propertyTracks,
      audioClips: project.shots[0].audioClips,
      captionClips: project.shots[0].captionClips,
      markers: project.shots[0].markers,
    });

    for (const component of EXPECTED_COMPONENTS) {
      const beforeCount = project.shots[0].objects.length;
      project = insertSemanticComponent(project, shotId, component.id, { x: 480, y: 270 });
      const inserted = project.shots[0].objects.slice(beforeCount);
      const [root, ...leaves] = inserted;
      expect(root).toMatchObject({
        type: "group",
        name: component.name,
        semanticRole: `semantic-component-${component.id}`,
      });
      expect(root.parentId).toBeUndefined();
      expect(leaves.map(({ type, semanticRole }) => [type, semanticRole])).toEqual(component.leaves);
      expect(leaves.every(({ parentId }) => parentId === root.id)).toBe(true);
      expect(leaves.some(({ type }) => type === "group")).toBe(false);
      expectExactRootBounds(inserted);
    }

    expect(project.shots[0].objects).toHaveLength(60);
    expect(project.shots[0].objects.filter(({ type }) => type === "group")).toHaveLength(12);
    expect(ProjectDocumentSchema.safeParse(project).success).toBe(true);
    const allIds = project.shots.flatMap((shot) => shot.objects.map(({ id }) => id));
    expect(new Set(allIds).size).toBe(allIds.length);
    expect({
      animations: project.shots[0].animations,
      propertyTracks: project.shots[0].propertyTracks,
      audioClips: project.shots[0].audioClips,
      captionClips: project.shots[0].captionClips,
      markers: project.shots[0].markers,
    }).toEqual(beforeTimeline);
    for (const object of project.shots[0].objects) {
      expect(object).not.toHaveProperty("lifetime");
      expect(["image", "svg"]).not.toContain(object.type);
      expect(JSON.stringify(object.style)).not.toMatch(/#[0-9a-f]{6}/i);
      if (object.type === "math") {
        expect(object.properties).toMatchObject({ renderer: "mathtex", mode: "display" });
      }
    }
    const graph = project.shots[0].objects.find(({ semanticRole }) => semanticRole === "diagram-graph");
    expect(graph?.properties.expression).toEqual({ kind: "sin", value: { kind: "variable" } });
    expect(project.shots[0].objects.find(({ semanticRole }) => semanticRole === "focus-frame")?.type).toBe("line");
    expect(project.shots[0].objects.find(({ semanticRole }) => semanticRole === "vector-relation")?.type).toBe("double-arrow");
  });

  test.each(["16:9", "9:16", "1:1"] as const)(
    "uses every active preset and clamps every component 24px inside the %s frame",
    (aspectRatio) => {
      for (const style of DEFAULT_STYLE_PACKS) {
        const project = projectFor(aspectRatio, style.id);
        const frame = logicalFrameFor(aspectRatio);
        for (const [index, component] of EXPECTED_COMPONENTS.entries()) {
          const origin = index % 2 === 0
            ? { x: -10_000, y: 10_000 }
            : { x: 10_000, y: -10_000 };
          const objects = instantiateSemanticComponent(project, project.shots[0].id, component.id, origin);
          const [root, ...leaves] = objects;
          const bounds = leafBounds(leaves);
          expect(bounds.left).toBeGreaterThanOrEqual(24 - 1e-8);
          expect(bounds.right).toBeLessThanOrEqual(frame.width - 24 + 1e-8);
          expect(bounds.top).toBeGreaterThanOrEqual(24 - 1e-8);
          expect(bounds.bottom).toBeLessThanOrEqual(frame.height - 24 + 1e-8);
          expectExactRootBounds(objects);
          expect(root.transform.x).toBeGreaterThanOrEqual(24);
          expect(root.transform.x).toBeLessThanOrEqual(frame.width - 24);
          for (const leaf of leaves) {
            if (leaf.type === "text") expect(leaf.style.fontFamily).toBe(style.typography.statement);
            if (leaf.type === "math") {
              expect(leaf.style.fontFamily).toBe(style.typography.math);
              expect(leaf.properties).toMatchObject({ renderer: "mathtex", mode: "display" });
            }
          }
        }
        const centered = instantiateSemanticComponent(project, project.shots[0].id, "mathematical-title");
        expect(centered[0].transform.x).toBeCloseTo(frame.centerX, 10);
        expect(centered[0].transform.y).toBeCloseTo(frame.centerY, 10);
      }
    },
  );

  test("allocates against the complete project namespace and remains deterministic", () => {
    const candidate = cloneSerializable(blankProject());
    candidate.metadata.id = "group-mathematical-title";
    candidate.styles[0].id = "object-title";
    candidate.activeStyleId = "object-title";
    const project = ProjectDocumentSchema.parse(candidate);
    const first = instantiateSemanticComponent(project, project.shots[0].id, "mathematical-title");
    const second = instantiateSemanticComponent(project, project.shots[0].id, "mathematical-title");
    expect(first).toEqual(second);
    expect(first[0].id).toBe("group-mathematical-title-2");
    expect(first.find(({ semanticRole }) => semanticRole === "title")?.id).toBe("object-title-2");

    const insertedTwice = insertSemanticComponent(
      insertSemanticComponent(project, project.shots[0].id, "mathematical-title"),
      project.shots[0].id,
      "mathematical-title",
    );
    expect(insertedTwice.shots[0].objects.filter(({ type }) => type === "group").map(({ id }) => id))
      .toEqual(["group-mathematical-title-2", "group-mathematical-title-3"]);
  });

  test("refuses nonfinite origins and object, graph, native-work, and canonical-JSON limit violations atomically", () => {
    const project = blankProject();
    expectRefusalWithoutMutation(project, () => instantiateSemanticComponent(project, project.shots[0].id, "mathematical-title", { x: Number.NaN, y: 0 }));
    expectRefusalWithoutMutation(project, () => instantiateSemanticComponent(project, "shot-missing", "mathematical-title"));

    const objectLimited = cloneSerializable(project);
    objectLimited.shots[0].objects = Array.from({ length: 254 }, (_, index): SceneObject => ({
      id: `object-limit-${index}`,
      type: "circle",
      name: `Limit ${index}`,
      locked: false,
      visible: true,
      transform: { x: 100, y: 100, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    }));
    const validObjectLimited = ProjectDocumentSchema.parse(objectLimited);
    expectRefusalWithoutMutation(validObjectLimited, () => insertSemanticComponent(validObjectLimited, validObjectLimited.shots[0].id, "mathematical-title"));

    const graphLimited = cloneSerializable(project);
    graphLimited.shots[0].objects = Array.from({ length: 8 }, (_, index): SceneObject => ({
      id: `object-graph-limit-${index}`,
      type: "graph",
      name: `Graph ${index}`,
      locked: false,
      visible: true,
      transform: { x: 270, y: 270, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { expression: { kind: "sin", value: { kind: "variable" } }, xMin: -2, xMax: 2 },
    }));
    const validGraphLimited = ProjectDocumentSchema.parse(graphLimited);
    expectRefusalWithoutMutation(validGraphLimited, () => insertSemanticComponent(validGraphLimited, validGraphLimited.shots[0].id, "annotated-diagram"));

    const nativeWorkLimited = cloneSerializable(project);
    nativeWorkLimited.shots[0].objects = Array.from({ length: 17 }, (_, index): SceneObject => ({
      id: `object-dash-limit-${index}`,
      type: "dashed-line",
      name: `Dash ${index}`,
      locked: false,
      visible: true,
      transform: { x: 0, y: 0, width: 4096, height: 2, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { shape: { kind: "dashed-line", lineCap: "butt", dashLength: 8, gapLength: 8 } },
    }));
    expect(ProjectDocumentSchema.safeParse(nativeWorkLimited).success).toBe(false);
    expectRefusalWithoutMutation(nativeWorkLimited, () => instantiateSemanticComponent(nativeWorkLimited, nativeWorkLimited.shots[0].id, "mathematical-title"));

    const jsonLimited = cloneSerializable(project);
    jsonLimited.shots[0].objects.push({
      id: "object-json-limit",
      type: "image",
      name: "Oversized data image",
      locked: false,
      visible: true,
      transform: { x: 100, y: 100, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { source: `data:image/png;base64,${"A".repeat(PROOFCANVAS_PROJECT_MAX_BYTES)}` },
    });
    expectRefusalWithoutMutation(jsonLimited, () => instantiateSemanticComponent(jsonLimited, jsonLimited.shots[0].id, "mathematical-title"));
  });

  test("supports ordinary edit, ungroup, schema reparse, and compiler output", () => {
    const inserted = insertSemanticComponent(blankProject(), "shot-main", "vector-explanation");
    const shot = inserted.shots[0];
    const group = shot.objects.find(({ type }) => type === "group")!;
    const source = shot.objects.find(({ semanticRole }) => semanticRole === "vector-source")!;
    const edited = applyOperations(inserted, shot.id, [
      {
        type: "update-object",
        objectId: source.id,
        patch: { properties: { content: "\\vec{w}=(1,4)", renderer: "mathtex", mode: "display" } },
      },
      { type: "ungroup-object", groupId: group.id },
    ]).project;
    expect(edited.shots[0].objects.some(({ id }) => id === group.id)).toBe(false);
    expect(edited.shots[0].objects.every(({ parentId }) => parentId === undefined)).toBe(true);
    expect(edited.shots[0].objects.find(({ id }) => id === source.id)?.properties.content).toBe("\\vec{w}=(1,4)");
    expect(ProjectDocumentSchema.safeParse(edited).success).toBe(true);
    const compiled = compileManim(edited);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python).toContain("DoubleArrow(");
    expect(compiled.python).toContain("MathTex(");
  });
});
