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

function projectWith(type: "circle" | "rectangle" | "line" | "arrow" | "brace", shape: unknown): ProjectDocument {
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

describe("schema-v3 namespaced shape settings", () => {
  test.each([
    ["circle", { kind: "circle" }],
    ["rectangle", { kind: "rectangle", cornerRadius: 24 }],
    ["line", { kind: "line", lineCap: "round" }],
    ["arrow", { kind: "arrow", lineCap: "square", tipShape: "stealth", tipSizeRatio: 0.2 }],
    ["brace", { kind: "brace", direction: "left", spacing: 18 }],
  ] as const)("validates strict %s settings at the authoring boundary", (type, shape) => {
    expect(CurrentShapePropertiesSchema.safeParse(shape)).toMatchObject({ success: true });
    expect(ProjectDocumentSchema.safeParse(projectWith(type, shape))).toMatchObject({ success: true });
    expect(projectShapeAuthoringIssues(ProjectDocumentSchema.parse(projectWith(type, shape)))).toEqual([]);
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
