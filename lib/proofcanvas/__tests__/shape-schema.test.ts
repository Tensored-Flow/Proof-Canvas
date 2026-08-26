import {
  analyzeProjectAuthoringTransition,
  projectAuthoringIssue,
  projectShapeAuthoringIssues,
} from "../authoringPolicy";
import { compileManim } from "../compiler";
import { applyOperations } from "../operations";
import { createProjectTemplate } from "../templates";
import {
  CurrentShapePropertiesSchema,
  ProjectDocumentSchema,
  cloneSerializable,
  type ProjectDocument,
} from "../schema";

type TestedShapeType = "circle" | "rectangle" | "line" | "arrow" | "brace"
  | "ellipse" | "polygon" | "dashed-line" | "double-arrow" | "freeform-path";

function projectWith(type: TestedShapeType, shape: unknown): ProjectDocument {
  const project = cloneSerializable(createProjectTemplate("blank", "project-shape-schema", "Shape schema"));
  project.shots[0].objects = [{
    id: "object-shape-schema",
    type,
    name: "Shape",
    locked: false,
    visible: true,
    transform: { x: 100, y: 100, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {
      ...(type === "brace" ? { label: "span" } : {}),
      shape: shape as never,
    },
  }];
  return project;
}

describe("schema-v4 namespaced shape settings", () => {
  test.each([
    ["circle", { kind: "circle" }],
    ["rectangle", { kind: "rectangle", cornerRadius: 24 }],
    ["line", { kind: "line", lineCap: "round" }],
    ["arrow", { kind: "arrow", lineCap: "square", tipShape: "stealth", tipSizeRatio: 0.2 }],
    ["brace", { kind: "brace", direction: "left", spacing: 18 }],
    ["ellipse", { kind: "ellipse" }],
    ["polygon", { kind: "polygon", vertices: [{ x: -0.5, y: 0.5 }, { x: 0, y: -0.5 }, { x: 0.5, y: 0.5 }], lineJoin: "round" }],
    ["dashed-line", { kind: "dashed-line", lineCap: "square", dashLength: 12, gapLength: 8 }],
    ["double-arrow", { kind: "double-arrow", lineCap: "round", startTipShape: "circle", endTipShape: "stealth", tipSizeRatio: 0.2 }],
    ["freeform-path", { kind: "freeform-path", closed: false, lineCap: "round", lineJoin: "bevel", nodes: [
      { point: { x: -0.5, y: 0 }, outHandle: { x: -0.25, y: -0.5 } },
      { point: { x: 0.5, y: 0 }, inHandle: { x: 0.25, y: 0.5 } },
    ] }],
  ] as const)("validates strict %s settings at the authoring boundary", (type, shape) => {
    expect(CurrentShapePropertiesSchema.safeParse(shape)).toMatchObject({ success: true });
    expect(ProjectDocumentSchema.safeParse(projectWith(type, shape))).toMatchObject({ success: true });
    expect(projectShapeAuthoringIssues(ProjectDocumentSchema.parse(projectWith(type, shape)))).toEqual([]);
  });

  test.each([
    ["ellipse", undefined],
    ["polygon", { kind: "ellipse" }],
    ["dashed-line", { kind: "dashed-line", lineCap: "butt", dashLength: 12, gapLength: 8, extra: true }],
    ["double-arrow", { kind: "double-arrow", lineCap: "butt", startTipShape: "triangle", endTipShape: "triangle" }],
    ["freeform-path", { kind: "freeform-path", closed: false, lineCap: "round", lineJoin: "round", nodes: [{ point: { x: -0.5, y: 0 } }] }],
  ] as const)("rejects missing, mismatched, incomplete, or non-strict schema-v4 %s authority", (type, shape) => {
    const candidate = projectWith(type, shape);
    if (shape === undefined) delete candidate.shots[0].objects[0].properties.shape;
    expect(ProjectDocumentSchema.safeParse(candidate)).toMatchObject({ success: false });
  });

  test.each([
    [
      "polygon",
      { kind: "polygon", lineJoin: "miter", vertices: [
        { x: -0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }, { x: 0.5, y: -0.5 },
      ] },
      ["vertices", 2],
      "Polygon edges must not intersect",
    ],
    [
      "freeform-path",
      { kind: "freeform-path", closed: false, lineCap: "round", lineJoin: "round", nodes: [
        { point: { x: 0, y: 0 } }, { point: { x: 1e-9, y: 0 } },
      ] },
      ["nodes", 1, "point"],
      "eight-decimal compiler quantization",
    ],
    [
      "dashed-line",
      { kind: "dashed-line", lineCap: "butt", dashLength: 12, gapLength: 4096 },
      ["gapLength"],
      "dash ratio must be between",
    ],
  ] as const)("propagates the first precise nested %s issue through SceneObject project validation", (type, shape, relativePath, message) => {
    const result = ProjectDocumentSchema.safeParse(projectWith(type, shape));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the invalid nested shape record to fail project admission");
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["shots", 0, "objects", 0, "properties", "shape", ...relativePath],
        message: expect.stringContaining(message),
      }),
    ]));
  });

  test("bounds normalized coordinates and every authored freeform handle", () => {
    const exactBoundary = {
      kind: "freeform-path",
      closed: false,
      lineCap: "square",
      lineJoin: "miter",
      nodes: [
        { point: { x: -0.5, y: -0.5 }, outHandle: { x: 0.5, y: 0.5 } },
        { point: { x: 0.5, y: 0.5 }, inHandle: { x: -0.5, y: -0.5 } },
      ],
    };
    expect(CurrentShapePropertiesSchema.safeParse(exactBoundary)).toMatchObject({ success: true });
    for (const malformed of [
      { ...exactBoundary, nodes: [{ point: { x: -0.500_001, y: 0 } }, exactBoundary.nodes[1]] },
      { ...exactBoundary, nodes: [{ point: { x: -0.5, y: 0 }, outHandle: { x: 0, y: 0.500_001 } }, exactBoundary.nodes[1]] },
      { ...exactBoundary, nodes: [{ point: { x: Number.NaN, y: 0 } }, exactBoundary.nodes[1]] },
    ]) expect(CurrentShapePropertiesSchema.safeParse(malformed)).toMatchObject({ success: false });
  });

  test("rejects dormant open endpoint handles while accepting the same handles on a closed path", () => {
    const nodes = [
      { point: { x: -0.5, y: 0 }, inHandle: { x: -0.25, y: 0.1 } },
      { point: { x: 0, y: -0.5 } },
      { point: { x: 0.5, y: 0 }, outHandle: { x: 0.25, y: 0.1 } },
    ];
    expect(CurrentShapePropertiesSchema.safeParse({
      kind: "freeform-path", closed: false, nodes, lineCap: "round", lineJoin: "round",
    })).toMatchObject({ success: false });
    expect(CurrentShapePropertiesSchema.safeParse({
      kind: "freeform-path", closed: true, nodes, lineJoin: "round",
    })).toMatchObject({ success: true });
  });

  test.each([
    [[{ x: -0.5, y: 0 }, { x: 0, y: 0 }, { x: 0.5, y: 0 }], "collinear"],
    [[{ x: -0.5, y: -0.5 }, { x: -0.5, y: -0.5 }, { x: 0.5, y: 0.5 }], "adjacent duplicate"],
    [[{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: -0.5, y: -0.5 }], "implicit closure duplicate"],
  ] as const)("rejects degenerate polygon vertices: %s", (vertices) => {
    expect(CurrentShapePropertiesSchema.safeParse({ kind: "polygon", vertices, lineJoin: "miter" })).toMatchObject({ success: false });
  });

  test.each([
    [
      [
        { x: -0.5, y: -0.5 },
        { x: 0.5, y: -0.5 },
        { x: 0.5, y: -0.5 + 4e-9 },
        { x: -0.5, y: 0.5 },
      ],
      "Adjacent shape points must remain distinct",
      "adjacent vertices",
    ],
    [
      [
        { x: -0.5, y: -0.5 },
        { x: 0.5, y: -0.5 },
        { x: 0.5, y: 0.5 },
        { x: -0.5, y: -0.5 + 4e-9 },
      ],
      "implicit closing vertices must remain distinct",
      "implicit closing vertices",
    ],
    [
      [
        { x: -0.5, y: -0.5 },
        { x: 0.5, y: -0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0.5 - 4e-9, y: -0.5 + 4e-9 },
        { x: -0.5, y: 0.5 },
      ],
      "must remain non-intersecting",
      "non-adjacent vertex collision",
    ],
    [
      [
        { x: -0.5, y: -0.5 },
        { x: 0.5, y: -0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0, y: -0.5 + 4e-9 },
        { x: -0.5, y: 0.5 },
      ],
      "must remain non-intersecting",
      "non-adjacent edge contact",
    ],
    [
      [
        { x: -0.5, y: 0 },
        { x: 0.499_999_991, y: 0 },
        { x: 0, y: 0.000_001_000_000_01 },
      ],
      "must remain non-collinear",
      "compiler-threshold collinearity",
    ],
  ] as const)("rejects polygon %s introduced only by eight-decimal emission", (vertices, message) => {
    const result = CurrentShapePropertiesSchema.safeParse({ kind: "polygon", vertices, lineJoin: "miter" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected compiler-unsafe polygon to fail schema admission");
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining(message) }),
    ]));
    expect(result.error.issues.every(({ message: issue }) => issue.includes("compiler quantization"))).toBe(true);
  });

  test("admits the exact polygon non-collinearity boundary after compiler quantization", () => {
    expect(CurrentShapePropertiesSchema.safeParse({
      kind: "polygon",
      lineJoin: "round",
      vertices: [
        { x: -0.5, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0, y: 0.000_001 },
      ],
    })).toMatchObject({ success: true });
  });

  test.each([
    [
      false,
      [
        { point: { x: 0, y: 0 } },
        { point: { x: 4e-9, y: 0 } },
      ],
      "Adjacent shape points must remain distinct",
      "adjacent open endpoints",
    ],
    [
      true,
      [
        { point: { x: 0, y: 0 } },
        { point: { x: 0.5, y: 0.5 } },
        { point: { x: 4e-9, y: 0 } },
      ],
      "implicit closing endpoints must remain distinct",
      "implicit closing endpoints",
    ],
    [
      false,
      [
        { point: { x: 0, y: 0 }, outHandle: { x: 4e-9, y: 0 } },
        { point: { x: 0.5, y: 0 } },
      ],
      "Distinct freeform cubic points must remain distinct",
      "explicit outgoing handle",
    ],
    [
      false,
      [
        { point: { x: -0.5, y: 0 } },
        { point: { x: 0.5, y: 0 }, inHandle: { x: 0.5 - 4e-9, y: 0 } },
      ],
      "Distinct freeform cubic points must remain distinct",
      "explicit incoming handle",
    ],
    [
      false,
      [
        { point: { x: 0, y: 0 } },
        { point: { x: 2e-8, y: 0 } },
      ],
      "Distinct freeform cubic points must remain distinct",
      "implicit cubic controls",
    ],
  ] as const)("rejects freeform %s collapsed only by eight-decimal emission", (closed, nodes, message) => {
    const result = CurrentShapePropertiesSchema.safeParse({
      kind: "freeform-path",
      closed,
      nodes,
      ...(closed ? {} : { lineCap: "round" }),
      lineJoin: "round",
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected compiler-unsafe freeform path to fail schema admission");
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining(message) }),
    ]));
  });

  test("admits compiler-distinct implicit controls at three decimal ticks and intentional endpoint handles", () => {
    expect(CurrentShapePropertiesSchema.safeParse({
      kind: "freeform-path",
      closed: false,
      lineCap: "round",
      lineJoin: "round",
      nodes: [
        { point: { x: 0, y: 0 } },
        { point: { x: 3e-8, y: 0 } },
      ],
    })).toMatchObject({ success: true });
    expect(CurrentShapePropertiesSchema.safeParse({
      kind: "freeform-path",
      closed: false,
      lineCap: "round",
      lineJoin: "round",
      nodes: [
        { point: { x: -0.5, y: -0.5 }, outHandle: { x: -0.5, y: -0.5 } },
        { point: { x: 0.5, y: 0.5 }, inHandle: { x: 0.5, y: 0.5 } },
      ],
    })).toMatchObject({ success: true });
  });

  test("accepts exactly 64 polygon vertices and rejects 65", () => {
    const vertices = Array.from({ length: 65 }, (_, index) => {
      const angle = 2 * Math.PI * index / 65;
      return { x: 0.49 * Math.cos(angle), y: 0.49 * Math.sin(angle) };
    });
    expect(CurrentShapePropertiesSchema.safeParse({ kind: "polygon", vertices: vertices.slice(0, 64), lineJoin: "bevel" })).toMatchObject({ success: true });
    expect(CurrentShapePropertiesSchema.safeParse({ kind: "polygon", vertices, lineJoin: "bevel" })).toMatchObject({ success: false });
  });

  test("enforces bounded dash lengths and the inclusive dash-ratio contract", () => {
    const shape = (dashLength: number, gapLength: number) => ({ kind: "dashed-line", lineCap: "butt", dashLength, gapLength });
    expect(CurrentShapePropertiesSchema.safeParse(shape(5, 95))).toMatchObject({ success: true });
    expect(CurrentShapePropertiesSchema.safeParse(shape(95, 5))).toMatchObject({ success: true });
    expect(CurrentShapePropertiesSchema.safeParse(shape(4.999, 95.001))).toMatchObject({ success: false });
    expect(CurrentShapePropertiesSchema.safeParse(shape(95.001, 4.999))).toMatchObject({ success: false });
    expect(CurrentShapePropertiesSchema.safeParse(shape(0.999, 8))).toMatchObject({ success: false });
  });

  test.each([
    ["line", { kind: "arrow", lineCap: "round" }],
    ["arrow", { kind: "arrow", tipSizeRatio: 0.5 }],
    ["brace", { kind: "brace", direction: "diagonal" }],
    ["circle", { kind: "circle", unknown: true }],
    ["rectangle", "custom-v3-payload"],
  ] as const)("keeps published V3 %s payloads loadable but marks malformed authoring authority", (type, shape) => {
    const parsed = ProjectDocumentSchema.parse(projectWith(type, shape));
    expect(parsed.shots[0].objects[0].properties.shape).toEqual(shape);
    expect(projectShapeAuthoringIssues(parsed)).toEqual([
      expect.objectContaining({ objectId: "object-shape-schema" }),
    ]);
  });

  test("keeps direct legacy names and non-shape custom shape payloads inert", () => {
    const direct = projectWith("arrow", { kind: "arrow" });
    direct.shots[0].objects[0].properties = {
      lineCap: "round",
      tipShape: "stealth",
      tipSizeRatio: 0.2,
    };
    expect(ProjectDocumentSchema.safeParse(direct)).toMatchObject({ success: true });

    const nonShape = cloneSerializable(createProjectTemplate("blank", "project-non-shape-schema", "Non-shape schema"));
    nonShape.shots[0].objects = [{
      id: "object-text-shape-record",
      type: "text",
      name: "Text",
      locked: false,
      visible: true,
      transform: { x: 100, y: 100, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { content: "Text", shape: { custom: ["published", "payload"] } },
    }];
    const parsed = ProjectDocumentSchema.parse(nonShape);
    expect(parsed.shots[0].objects[0].properties.shape).toEqual({ custom: ["published", "payload"] });
    expect(projectShapeAuthoringIssues(parsed)).toEqual([]);
    expect(projectAuthoringIssue(parsed)).toBeUndefined();
  });

  test("allows unrelated legacy edits and repair while rejecting new or modified invalid shape authority", () => {
    const valid = ProjectDocumentSchema.parse(projectWith("arrow", {
      kind: "arrow", lineCap: "butt", tipShape: "triangle", tipSizeRatio: 0.25,
    }));
    const invalid = ProjectDocumentSchema.parse(projectWith("arrow", { kind: "arrow", tipSizeRatio: 0.5 }));
    expect(projectAuthoringIssue(invalid)).toMatch(/renderer-fallback SHAPE_SETTINGS_INVALID/);
    expect(analyzeProjectAuthoringTransition(valid, invalid)).toMatchObject({
      allowed: false,
      reason: "introduced-shape-authority",
    });

    const unrelated = applyOperations(invalid, invalid.shots[0].id, [{
      type: "update-object", objectId: "object-shape-schema", patch: { name: "Renamed legacy arrow" },
    }]).project;
    expect(unrelated.shots[0].objects[0].name).toBe("Renamed legacy arrow");

    const modified = cloneSerializable(invalid);
    modified.shots[0].objects[0].properties.shape = { kind: "arrow", tipSizeRatio: 0.6 };
    expect(analyzeProjectAuthoringTransition(invalid, ProjectDocumentSchema.parse(modified))).toMatchObject({
      allowed: false,
      reason: "modified-shape-authority",
    });

    const repaired = cloneSerializable(invalid);
    repaired.shots[0].objects[0].properties.shape = {
      kind: "arrow", lineCap: "round", tipShape: "circle", tipSizeRatio: 0.45,
    };
    expect(analyzeProjectAuthoringTransition(invalid, ProjectDocumentSchema.parse(repaired))).toMatchObject({ allowed: true });
    expect(projectShapeAuthoringIssues(ProjectDocumentSchema.parse(repaired))).toEqual([]);
  });

  test("warns explicitly and compiles a deterministic safe fallback for loaded malformed V3 shapes", () => {
    const legacy = ProjectDocumentSchema.parse(projectWith("arrow", {
      kind: "arrow", lineCap: "projecting", tipShape: "needle", tipSizeRatio: 999,
    }));
    const result = compileManim(legacy);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "warning",
        code: "SHAPE_SETTINGS_INVALID_FALLBACK",
        objectId: "object-shape-schema",
      }),
    ]));
    expect(result.python).toContain("max_tip_length_to_length_ratio=0.25, tip_shape=ArrowTriangleFilledTip");
  });

  test("caps malformed-shape fallback diagnostics without hiding the exact omitted count", () => {
    const project = cloneSerializable(createProjectTemplate("blank", "project-shape-cap", "Shape cap"));
    const template = projectWith("arrow", { kind: "arrow", tipSizeRatio: 999 }).shots[0].objects[0];
    project.shots[0].objects = Array.from({ length: 70 }, (_, index) => ({
      ...cloneSerializable(template),
      id: `object-malformed-shape-${index}`,
      name: `Malformed shape ${index}`,
    }));
    const result = compileManim(ProjectDocumentSchema.parse(project));
    expect(result.diagnostics.filter(({ code }) => code === "SHAPE_SETTINGS_INVALID_FALLBACK")).toHaveLength(64);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      severity: "info",
      code: "SHAPE_SETTINGS_INVALID_FALLBACK_TRUNCATED",
      message: "6 additional malformed shape settings were deterministically omitted from diagnostics.",
    })]));
  });
});
