import { spawnSync } from "node:child_process";
import { compileManim } from "../compiler";
import { createCantorDemoProject } from "../demo";
import { previewShotAtTime } from "../preview";
import { PROOFCANVAS_RENDER_SOURCE_MAX_BYTES, PROOFCANVAS_SCHEMA_LIMITS, ProjectDocumentSchema, cloneSerializable, type SceneObject } from "../schema";

function validateWithRendererPolicy(source: string) {
  const script = [
    "import hashlib, importlib.util, sys",
    "path = 'services/proofcanvas-render/proofcanvas_render/policy.py'",
    "spec = importlib.util.spec_from_file_location('proofcanvas_schema_policy_test', path)",
    "module = importlib.util.module_from_spec(spec)",
    "sys.modules[spec.name] = module",
    "spec.loader.exec_module(module)",
    "source = sys.stdin.read()",
    "module.validate_generated_source(source, hashlib.sha256(source.encode()).hexdigest())",
  ].join("; ");
  return spawnSync("python3", ["-c", script], { input: source, encoding: "utf8" });
}

test("a project at direct numeric schema bounds compiles through the renderer policy", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const title = project.shots[0].objects.find(({ id }) => id === "object-title")!;
  title.transform = {
    x: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
    y: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
    width: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax,
    height: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin,
    rotation: PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude,
    scaleX: -PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude,
    scaleY: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude,
  };
  title.style.fontSize = PROOFCANVAS_SCHEMA_LIMITS.fontSizeMax;
  const boundaryShape = project.shots[0].objects.find(({ type }) => type === "rectangle")!;
  boundaryShape.style.strokeWidth = PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax;

  project.shots[0].camera = {
    x: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
    y: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
    zoom: PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMax,
    rotation: -PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude,
  };
  const cameraAnimation = project.shots[0].animations.find(({ id }) => id === "animation-camera-focus")!;
  cameraAnimation.properties = {
    x: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
    y: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
    zoom: PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMin,
    rotation: PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude,
  };

  const style = project.styles.find(({ id }) => id === project.activeStyleId)!;
  style.typography.titleScale = PROOFCANVAS_SCHEMA_LIMITS.typographyScaleMax;
  style.typography.bodyScale = PROOFCANVAS_SCHEMA_LIMITS.typographyScaleMin;
  style.spacing = {
    unit: PROOFCANVAS_SCHEMA_LIMITS.spacingMax,
    margin: PROOFCANVAS_SCHEMA_LIMITS.spacingMax,
    objectGap: PROOFCANVAS_SCHEMA_LIMITS.spacingMax,
  };
  style.strokes = {
    fine: PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax,
    regular: PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax,
    emphasis: PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax,
  };
  style.corners = {
    panel: PROOFCANVAS_SCHEMA_LIMITS.cornerRadiusMax,
    object: PROOFCANVAS_SCHEMA_LIMITS.cornerRadiusMax,
  };
  style.annotation.offset = PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude;
  style.graph.axisWeight = PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax;
  style.graph.curveWeight = PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax;
  style.layout.hierarchyContrast = PROOFCANVAS_SCHEMA_LIMITS.hierarchyContrastMax;
  style.motion.defaultDuration = 300;
  style.motion.cameraMaxPan = PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude;
  style.motion.cameraMaxZoom = PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMax;

  project.shots[1].objects.push({
    id: "object-policy-boundary-graph",
    type: "graph",
    name: "Policy boundary graph",
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 240, height: 150, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {
      expression: { kind: "constant", value: PROOFCANVAS_SCHEMA_LIMITS.expressionConstantMagnitude },
      xMin: -PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude,
      xMax: PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude,
    },
  });

  const valid = ProjectDocumentSchema.parse(project);
  const compiled = compileManim(valid);
  const policy = validateWithRendererPolicy(compiled.python);

  expect(compiled.diagnostics.some(({ severity }) => severity === "error")).toBe(false);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("caps graph objects at the renderer's total restricted-lambda budget", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[1];
  project.shots = [shot];
  shot.animations = [];
  shot.objects = Array.from({ length: PROOFCANVAS_SCHEMA_LIMITS.graphsPerProject }, (_, index) => ({
    id: `object-policy-graph-${index}`,
    type: "graph" as const,
    name: `Policy graph ${index}`,
    locked: false,
    visible: true,
    transform: { x: 120 + index * 80, y: 270, width: 70, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: { expression: { kind: "constant" as const, value: index }, xMin: -2, xMax: 2 },
  }));

  const valid = ProjectDocumentSchema.parse(project);
  const policy = validateWithRendererPolicy(compileManim(valid).python);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");

  const ninth = cloneSerializable(project);
  ninth.shots[0].objects.push({
    ...cloneSerializable(ninth.shots[0].objects[0]),
    id: "object-policy-graph-8",
    name: "Policy graph 8",
  });
  const result = ProjectDocumentSchema.safeParse(ninth);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("at most 8 graph objects") }),
    ]));
  }
  expect(() => compileManim(ninth)).toThrow(/at most 8 graph objects/);
});

test("the maximum expanded-animation budget remains within source policy", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[1];
  const maximumStyleId = `s${"x".repeat(95)}`;
  project.styles[0].id = maximumStyleId;
  project.styles[0].name = "S".repeat(80);
  project.activeStyleId = maximumStyleId;
  const maximumGroupId = `g${"x".repeat(95)}`;
  const group: SceneObject = {
    id: maximumGroupId,
    type: "group",
    name: "G".repeat(80),
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 320, height: 180, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {},
  };
  const leaves: SceneObject[] = Array.from({ length: 4 }, (_, index) => ({
    id: `o${index}${"x".repeat(94)}`,
    parentId: group.id,
    type: "rectangle",
    name: `${index}${"N".repeat(79)}`,
    locked: false,
    visible: true,
    transform: { x: 120 + index * 40, y: 270, width: 24, height: 18, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {},
  }));
  project.shots = [shot];
  shot.duration = 300;
  shot.objects = [group, ...leaves];
  shot.animations = Array.from({ length: 256 }, (_, index) => ({
    id: `a-${String(index).padStart(3, "0")}-${"x".repeat(90)}`,
    type: "move" as const,
    targetIds: [group.id],
    start: index,
    duration: 0.5,
    easing: "linear" as const,
    properties: { deltaX: index % 2 === 0 ? 1 : -1 },
  }));

  const compiled = compileManim(ProjectDocumentSchema.parse(project));
  expect(Buffer.byteLength(compiled.python, "utf8")).toBeLessThanOrEqual(PROOFCANVAS_RENDER_SOURCE_MAX_BYTES);
  const policy = validateWithRendererPolicy(compiled.python);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("compiler keeps oversized source inspectable but emits an exact UTF-8 limit error", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[1];
  project.shots = [shot];
  shot.animations = [];
  shot.propertyTracks = [];
  const template = shot.objects.find(({ type }) => type === "text")!;
  shot.objects = Array.from({ length: 128 }, (_, index) => ({
    ...cloneSerializable(template),
    id: `object-max-text-${index}`,
    name: `Max text ${index}`,
    transform: { ...template.transform, x: index % 16 * 55, y: Math.floor(index / 16) * 55 },
    properties: { ...template.properties, content: "x".repeat(4_096) },
  }));
  const result = compileManim(ProjectDocumentSchema.parse(project));
  const bytes = Buffer.byteLength(result.python, "utf8");
  expect(bytes).toBeGreaterThan(PROOFCANVAS_RENDER_SOURCE_MAX_BYTES);
  expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
    severity: "error",
    code: "GENERATED_SOURCE_TOO_LARGE",
    message: `Generated UTF-8 source is ${bytes} bytes and exceeds the ${PROOFCANVAS_RENDER_SOURCE_MAX_BYTES}-byte renderer limit.`,
  })]));
});

test("deduplicates and caps hidden diagnostics at the exact 1024 empty-group work boundary", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[1];
  project.shots = [shot];
  shot.duration = 300;
  const groups: SceneObject[] = Array.from({ length: 256 }, (_, index) => ({
    id: `group-empty-boundary-${index}`,
    type: "group",
    name: `Empty boundary ${index}`,
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {},
  }));
  shot.objects = groups;
  shot.propertyTracks = [];
  shot.animations = Array.from({ length: 16 }, (_, index) => ({
    id: `animation-empty-boundary-${index}`,
    type: "move" as const,
    targetIds: groups.slice(index % 4 * 64, index % 4 * 64 + 64).map(({ id }) => id),
    start: index,
    duration: 0.5,
    easing: "linear" as const,
    properties: { deltaX: 1 },
  }));
  const result = compileManim(ProjectDocumentSchema.parse(project));
  expect(result.diagnostics.filter(({ code }) => code === "ANIMATION_TARGET_HIDDEN")).toHaveLength(64);
  expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
    code: "ANIMATION_TARGET_HIDDEN_TRUNCATED",
    message: "192 additional hidden animation targets were deterministically omitted from diagnostics.",
  })]));
});

describe("object style capability contract", () => {
  function assetProject(type: "image" | "svg") {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.animations = [];
    shot.propertyTracks = [];
    const asset: SceneObject = {
      id: `object-capability-${type}`,
      type,
      name: `${type} capability`,
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 100, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { source: type === "image" ? "data:image/png;base64,AA==" : "/proofcanvas/test.svg" },
    };
    shot.objects = [asset];
    return { project, shot, asset };
  }

  test.each(["image", "svg"] as const)("rejects direct %s fill/stroke capabilities but supports opacity only", (type) => {
    for (const property of ["fill", "stroke", "strokeWidth"] as const) {
      const { project, asset } = assetProject(type);
      asset.style = { [property]: property === "strokeWidth" ? 2 : "#123456" };
      expect(ProjectDocumentSchema.safeParse(project).success).toBe(false);
    }
    const directTrack = assetProject(type);
    directTrack.shot.propertyTracks = [{ id: `track-${type}-fill`, target: { kind: "object", objectId: directTrack.asset.id }, property: "fill", keyframes: [{ id: `keyframe-${type}-fill`, time: 0, value: "#123456", interpolation: { kind: "linear" } }] }];
    expect(ProjectDocumentSchema.safeParse(directTrack.project).success).toBe(false);

    const opacityOnly = assetProject(type);
    opacityOnly.asset.style.opacity = 0.75;
    opacityOnly.shot.propertyTracks = [{ id: `track-${type}-opacity`, target: { kind: "object", objectId: opacityOnly.asset.id }, property: "opacity", keyframes: [
      { id: `keyframe-${type}-opacity-a`, time: 0, value: 0.75, interpolation: { kind: "linear" } },
      { id: `keyframe-${type}-opacity-b`, time: 2, value: 0.5, interpolation: { kind: "linear" } },
    ] }];
    const parsed = ProjectDocumentSchema.parse(opacityOnly.project);
    const first = compileManim(parsed);
    expect(first.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", code: "ASSET_RENDER_TRANSPORT_UNSUPPORTED", objectId: opacityOnly.asset.id })]));
    expect(first.python).toContain(".set_opacity(0.75)");
    expect(first.python).toContain(".set_opacity(0.5)");
    expect(first.python).not.toMatch(/\.set_(?:color|fill|stroke)\(/);
    expect(compileManim(cloneSerializable(parsed)).python).toBe(first.python);
  });

  test("skips inherited and keyframed group styles on raster descendants while styling supported siblings", () => {
    const { project, shot, asset } = assetProject("image");
    const group: SceneObject = { id: "group-mixed-capability", type: "group", name: "Mixed capability", locked: false, visible: true, transform: { x: 480, y: 270, rotation: 0, scaleX: 1, scaleY: 1 }, style: { fill: "#112233", stroke: "#445566", strokeWidth: 3, opacity: 0.8 }, properties: {} };
    const rectangle: SceneObject = { id: "object-capability-rectangle", parentId: group.id, type: "rectangle", name: "Supported sibling", locked: false, visible: true, transform: { x: 600, y: 270, width: 80, height: 60, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} };
    asset.parentId = group.id;
    shot.objects = [group, asset, rectangle];
    shot.propertyTracks = ([
      ["fill", "#112233", "#abcdef"],
      ["stroke", "#445566", "#fedcba"],
      ["strokeWidth", 3, 7],
      ["opacity", 0.8, 0.4],
    ] as const).map(([property, from, to]) => ({ id: `track-mixed-${property.toLowerCase()}`, target: { kind: "object" as const, objectId: group.id }, property, keyframes: [
      { id: `keyframe-mixed-${property.toLowerCase()}-a`, time: 0, value: from, interpolation: { kind: "linear" as const } },
      { id: `keyframe-mixed-${property.toLowerCase()}-b`, time: 2, value: to, interpolation: { kind: "linear" as const } },
    ] }));
    const parsed = ProjectDocumentSchema.parse(project);
    const endpoint = previewShotAtTime(parsed.shots[0], 2);
    expect(endpoint.objects.find(({ id }) => id === asset.id)?.style).toEqual(expect.objectContaining({ opacity: 0.4 }));
    expect(endpoint.objects.find(({ id }) => id === asset.id)?.style).not.toEqual(expect.objectContaining({ fill: expect.anything(), stroke: expect.anything(), strokeWidth: expect.anything() }));
    expect(endpoint.objects.find(({ id }) => id === rectangle.id)?.style).toEqual(expect.objectContaining({ fill: "#abcdef", stroke: "#fedcba", strokeWidth: 7, opacity: 0.4 }));
    const source = compileManim(parsed).python;
    const rasterLine = source.split("\n").find((line) => line.includes("pc_image_capability ="))!;
    expect(rasterLine).toContain(".set_opacity(0.8)");
    expect(rasterLine).not.toMatch(/\.set_(?:color|fill|stroke)\(/);
    expect(source).toContain('.set_fill("#abcdef", opacity=1.0)');
    expect(source).toContain('.set_stroke("#fedcba", width=7.0)');
  });

  test("rejects direct text/math stroke styles at project validation", () => {
    for (const type of ["text", "math"] as const) {
      const project = cloneSerializable(createCantorDemoProject());
      const object = project.shots.flatMap(({ objects }) => objects).find((candidate) => candidate.type === type)!;
      object.style.stroke = "#123456";
      expect(ProjectDocumentSchema.safeParse(project).success).toBe(false);
    }
  });
});
