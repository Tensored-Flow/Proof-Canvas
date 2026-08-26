import { createProjectTemplate } from "../templates";
import { logicalFrameFor, resolutionFor, type ProofCanvasAspectRatio } from "../frame";
import { collectProjectIds } from "../ids";
import {
  SHAPE_PRESETS,
  SHAPE_PRESET_IDS,
  insertShapePreset,
  instantiateShapePreset,
  searchShapePresets,
  shapePresetById,
  type ShapePresetId,
} from "../shapePresets";
import {
  PROOFCANVAS_SCHEMA_LIMITS,
  ProjectDocumentSchema,
  cloneSerializable,
  type ProjectDocument,
  type SceneObject,
} from "../schema";

const ASPECT_RATIOS: readonly ProofCanvasAspectRatio[] = ["16:9", "9:16", "1:1"];

const EXPECTED_TYPES: Readonly<Record<ShapePresetId, readonly SceneObject["type"][]>> = {
  rectangle: ["rectangle"],
  "rounded-rectangle": ["rectangle"],
  circle: ["circle"],
  ellipse: ["ellipse"],
  polygon: ["polygon"],
  line: ["line"],
  "dashed-line": ["dashed-line"],
  arrow: ["arrow"],
  "double-arrow": ["double-arrow"],
  brace: ["brace"],
  bracket: ["freeform-path"],
  "freeform-path": ["freeform-path"],
  "highlight-box": ["rectangle"],
  underline: ["line"],
  "cross-out": ["group", "line", "line"],
  "dot-point": ["circle"],
};

function blankProject(aspectRatio: ProofCanvasAspectRatio = "16:9"): ProjectDocument {
  const project = createProjectTemplate("blank", `project-shape-presets-${aspectRatio.replace(":", "-")}`, "Shape presets");
  const frame = logicalFrameFor(aspectRatio);
  project.settings.aspectRatio = aspectRatio;
  project.settings.resolution = resolutionFor(aspectRatio, project.settings.renderPreset);
  project.shots[0].camera = { x: frame.centerX, y: frame.centerY, zoom: 1, rotation: 0 };
  return ProjectDocumentSchema.parse(project);
}

function shapeRecord(object: SceneObject): Readonly<Record<string, unknown>> | null {
  const value = object.properties.shape;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function expectTransformInsideFrame(object: SceneObject, aspectRatio: ProofCanvasAspectRatio): void {
  const frame = logicalFrameFor(aspectRatio);
  const width = object.transform.width ?? 1;
  const height = object.transform.height ?? 1;
  const radians = object.transform.rotation * Math.PI / 180;
  const extentX = Math.abs(Math.cos(radians)) * width / 2 + Math.abs(Math.sin(radians)) * height / 2;
  const extentY = Math.abs(Math.sin(radians)) * width / 2 + Math.abs(Math.cos(radians)) * height / 2;
  expect(object.transform.x - extentX).toBeGreaterThanOrEqual(0);
  expect(object.transform.x + extentX).toBeLessThanOrEqual(frame.width);
  expect(object.transform.y - extentY).toBeGreaterThanOrEqual(0);
  expect(object.transform.y + extentY).toBeLessThanOrEqual(frame.height);
}

function exactLeafBounds(objects: readonly SceneObject[]) {
  const leaves = objects.filter(({ type }) => type !== "group");
  const points = leaves.flatMap((object) => {
    const width = object.transform.width ?? 1;
    const height = object.transform.height ?? 1;
    const radians = object.transform.rotation * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]]
      .map(([x, y]) => ({
        x: object.transform.x + x * cosine - y * sine,
        y: object.transform.y + x * sine + y * cosine,
      }));
  });
  const left = Math.min(...points.map(({ x }) => x));
  const right = Math.max(...points.map(({ x }) => x));
  const top = Math.min(...points.map(({ y }) => y));
  const bottom = Math.max(...points.map(({ y }) => y));
  return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
}

describe("shape preset catalogue", () => {
  test("publishes immutable searchable definitions in deterministic order", () => {
    expect(SHAPE_PRESETS.map(({ id }) => id)).toEqual(SHAPE_PRESET_IDS);
    expect(new Set(SHAPE_PRESET_IDS).size).toBe(SHAPE_PRESET_IDS.length);
    expect(Object.isFrozen(SHAPE_PRESETS)).toBe(true);
    for (const definition of SHAPE_PRESETS) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.keywords)).toBe(true);
      expect(shapePresetById(definition.id)).toBe(definition);
    }

    expect(searchShapePresets("vertex marker").map(({ id }) => id)).toEqual(["dot-point"]);
    expect(searchShapePresets("square delimiter").map(({ id }) => id)).toEqual(["bracket"]);
    expect(searchShapePresets("bezier handles").map(({ id }) => id)).toEqual(["freeform-path"]);
    expect(searchShapePresets("bidirectional tips").map(({ id }) => id)).toEqual(["double-arrow"]);
    expect(searchShapePresets("oval conic").map(({ id }) => id)).toEqual(["ellipse"]);
    expect(searchShapePresets("focus emphasis").map(({ id }) => id)).toEqual(["highlight-box"]);
    expect(searchShapePresets("  ")).toBe(SHAPE_PRESETS);
    expect(searchShapePresets("no-such-shape")).toEqual([]);
    expect(Object.isFrozen(searchShapePresets("line"))).toBe(true);
    expect(shapePresetById("unknown")).toBeUndefined();
  });
});

describe("shape preset instantiation", () => {
  test.each(SHAPE_PRESET_IDS)("instantiates and inserts the %s preset as exact V4 primitives", (presetId) => {
    const project = blankProject();
    const before = JSON.stringify(project);
    const existingIds = collectProjectIds(project);
    const objects = instantiateShapePreset(project, project.shots[0].id, presetId);
    const definition = shapePresetById(presetId)!;

    expect(objects.map(({ type }) => type)).toEqual(EXPECTED_TYPES[presetId]);
    expect(objects).toHaveLength(definition.composition === "single" ? 1 : EXPECTED_TYPES[presetId].length);
    expect(Object.isFrozen(objects)).toBe(true);
    expect(new Set(objects.map(({ id }) => id)).size).toBe(objects.length);
    for (const object of objects) {
      expect(existingIds.has(object.id)).toBe(false);
      expect(Object.isFrozen(object)).toBe(true);
      expect(Object.isFrozen(object.transform)).toBe(true);
      expect(Object.isFrozen(object.style)).toBe(true);
      expect(Object.isFrozen(object.properties)).toBe(true);
      expect(object).toMatchObject({ locked: false, visible: true });
      expect(object.style.fill).toBeUndefined();
      expect(object.style.stroke).toBeUndefined();
      expect(object.style.color).toBeUndefined();
      if (object.type === "group") {
        expect(object.properties).toEqual({});
      } else {
        expect(shapeRecord(object)).toMatchObject({ kind: object.type });
        expect(object.properties.cornerRadius).toBeUndefined();
        expect(object.properties.lineCap).toBeUndefined();
        expect(object.properties.tipShape).toBeUndefined();
        expect(object.properties.tipSizeRatio).toBeUndefined();
        expect(object.properties.direction).toBeUndefined();
        expect(object.properties.spacing).toBeUndefined();
      }
    }

    const group = objects.find(({ type }) => type === "group");
    if (definition.composition === "compound") {
      expect(group).toBeDefined();
      expect(objects.filter(({ parentId }) => parentId === group!.id)).toHaveLength(objects.length - 1);
      const bounds = exactLeafBounds(objects);
      expect(group!.transform.x).toBeCloseTo(bounds.x, 10);
      expect(group!.transform.y).toBeCloseTo(bounds.y, 10);
      expect(group!.transform.width).toBeCloseTo(bounds.width, 10);
      expect(group!.transform.height).toBeCloseTo(bounds.height, 10);
    } else {
      expect(group).toBeUndefined();
      expect(objects[0].parentId).toBeUndefined();
    }

    const inserted = insertShapePreset(project, project.shots[0].id, presetId);
    expect(ProjectDocumentSchema.safeParse(inserted)).toMatchObject({ success: true });
    expect(inserted.shots[0].objects).toEqual(objects);
    expect(JSON.stringify(project)).toBe(before);
  });

  test("encodes the intentional semantic exceptions without baking colours", () => {
    const project = blankProject();
    const rectangle = instantiateShapePreset(project, project.shots[0].id, "rectangle")[0];
    const rounded = instantiateShapePreset(project, project.shots[0].id, "rounded-rectangle")[0];
    const dot = instantiateShapePreset(project, project.shots[0].id, "dot-point")[0];
    const arrow = instantiateShapePreset(project, project.shots[0].id, "arrow")[0];
    const dashed = instantiateShapePreset(project, project.shots[0].id, "dashed-line")[0];
    const doubleArrow = instantiateShapePreset(project, project.shots[0].id, "double-arrow")[0];
    const polygon = instantiateShapePreset(project, project.shots[0].id, "polygon")[0];
    const bracket = instantiateShapePreset(project, project.shots[0].id, "bracket")[0];
    const freeform = instantiateShapePreset(project, project.shots[0].id, "freeform-path")[0];
    const brace = instantiateShapePreset(project, project.shots[0].id, "brace")[0];
    const highlight = instantiateShapePreset(project, project.shots[0].id, "highlight-box")[0];

    expect(shapeRecord(rectangle)).toEqual({ kind: "rectangle", cornerRadius: 0 });
    expect(shapeRecord(rounded)).toEqual({ kind: "rectangle", cornerRadius: 14 });
    expect(dot.style).toEqual({ strokeWidth: 10 });
    expect(shapeRecord(arrow)).toEqual({
      kind: "arrow",
      lineCap: "butt",
      tipShape: "triangle",
      tipSizeRatio: 0.25,
    });
    expect(shapeRecord(dashed)).toEqual({
      kind: "dashed-line",
      lineCap: "butt",
      dashLength: 14,
      gapLength: 9,
    });
    expect(shapeRecord(doubleArrow)).toEqual({
      kind: "double-arrow",
      lineCap: "butt",
      startTipShape: "triangle",
      endTipShape: "triangle",
      tipSizeRatio: 0.25,
    });
    expect(shapeRecord(polygon)).toMatchObject({ kind: "polygon", lineJoin: "miter" });
    expect((shapeRecord(polygon)?.vertices as unknown[])).toHaveLength(5);
    expect(shapeRecord(bracket)).toEqual({
      kind: "freeform-path",
      closed: false,
      lineCap: "square",
      lineJoin: "miter",
      nodes: [
        { point: { x: 0.5, y: -0.5 } },
        { point: { x: -0.5, y: -0.5 } },
        { point: { x: -0.5, y: 0.5 } },
        { point: { x: 0.5, y: 0.5 } },
      ],
    });
    expect(shapeRecord(freeform)).toMatchObject({ kind: "freeform-path", closed: false, lineCap: "round", lineJoin: "round" });
    expect(brace.properties).toEqual({
      label: "annotation",
      shape: { kind: "brace", direction: "below", spacing: 12 },
    });
    expect(highlight.style).toEqual({ opacity: 0.18 });
  });

  test("is deterministic, leaves inputs untouched, and preserves active style inheritance", () => {
    const project = blankProject();
    project.activeStyleId = project.styles[1].id;
    const parsed = ProjectDocumentSchema.parse(project);
    const origin = Object.freeze({ x: 222.5, y: 144.25 });
    const before = JSON.stringify(parsed);

    const first = instantiateShapePreset(parsed, parsed.shots[0].id, "cross-out", origin);
    const second = instantiateShapePreset(parsed, parsed.shots[0].id, "cross-out", origin);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(origin).toEqual({ x: 222.5, y: 144.25 });

    const firstProject = insertShapePreset(parsed, parsed.shots[0].id, "cross-out", origin);
    const secondProject = insertShapePreset(parsed, parsed.shots[0].id, "cross-out", origin);
    expect(firstProject).toEqual(secondProject);
    expect(firstProject).not.toBe(parsed);
    expect(firstProject.activeStyleId).toBe(parsed.activeStyleId);
    expect(firstProject.styles).toEqual(parsed.styles);
    expect(firstProject.shots[0].objects.every(({ style }) => (
      style.fill === undefined && style.stroke === undefined && style.color === undefined
    ))).toBe(true);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  test("reserves every emitted ID against global project namespaces", () => {
    const project = cloneSerializable(blankProject());
    project.metadata.id = "object-shape-bracket";
    project.customEasings = [
      { id: "object-shape-bracket-stem", name: "Stem collision", curve: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 } },
      { id: "object-shape-bracket-top", name: "Top collision", curve: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 } },
      { id: "object-shape-bracket-bottom", name: "Bottom collision", curve: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 } },
    ];
    const parsed = ProjectDocumentSchema.parse(project);
    const existing = collectProjectIds(parsed);
    const objects = instantiateShapePreset(parsed, parsed.shots[0].id, "bracket");

    expect(objects.map(({ id }) => id)).toEqual(["object-shape-bracket-2"]);
    expect(objects.every(({ id }) => !existing.has(id))).toBe(true);

    const once = insertShapePreset(parsed, parsed.shots[0].id, "bracket");
    const twiceObjects = instantiateShapePreset(once, once.shots[0].id, "bracket");
    expect(twiceObjects.map(({ id }) => id)).toEqual(["object-shape-bracket-3"]);
  });

  test.each(ASPECT_RATIOS)("keeps every preset inside the %s logical frame at extreme origins", (aspectRatio) => {
    let project = blankProject(aspectRatio);
    for (const [index, presetId] of SHAPE_PRESET_IDS.entries()) {
      const origin = index % 2 === 0
        ? { x: -1_000_000, y: 1_000_000 }
        : { x: 1_000_000, y: -1_000_000 };
      const objects = instantiateShapePreset(project, project.shots[0].id, presetId, origin);
      objects.forEach((object) => expectTransformInsideFrame(object, aspectRatio));
      project = insertShapePreset(project, project.shots[0].id, presetId, origin);
    }
    expect(ProjectDocumentSchema.safeParse(project)).toMatchObject({ success: true });
  });

  test("fails unknown presets, missing shots, invalid origins, and over-capacity insertion atomically", () => {
    const project = blankProject();
    const before = JSON.stringify(project);
    expect(() => instantiateShapePreset(project, project.shots[0].id, "unknown-preset")).toThrow("Unknown shape preset");
    expect(() => insertShapePreset(project, "shot-missing", "rectangle")).toThrow("Shot not found");
    expect(() => insertShapePreset(project, project.shots[0].id, "rectangle", { x: Number.NaN, y: 0 })).toThrow("finite coordinates");
    expect(JSON.stringify(project)).toBe(before);

    const full = cloneSerializable(project);
    full.shots[0].objects = Array.from({ length: PROOFCANVAS_SCHEMA_LIMITS.objectsPerShot }, (_, index): SceneObject => ({
      id: `object-capacity-${index}`,
      type: "rectangle",
      name: `Capacity object ${index}`,
      locked: false,
      visible: true,
      transform: { x: 20, y: 20, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    }));
    const parsedFull = ProjectDocumentSchema.parse(full);
    const fullBefore = JSON.stringify(parsedFull);
    expect(() => insertShapePreset(parsedFull, parsedFull.shots[0].id, "rectangle")).toThrow();
    expect(JSON.stringify(parsedFull)).toBe(fullBefore);
  });
});
