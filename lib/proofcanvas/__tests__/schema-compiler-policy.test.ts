import { spawnSync } from "node:child_process";
import { compileManim } from "../compiler";
import { createCantorDemoProject } from "../demo";
import { resolutionFor } from "../frame";
import { previewShotAtTime } from "../preview";
import { CurrentShapePropertiesSchema, PROOFCANVAS_RENDER_SOURCE_MAX_BYTES, PROOFCANVAS_SCHEMA_LIMITS, ProjectDocumentSchema, cloneSerializable, type SceneObject } from "../schema";
import { resolveCompilerSafeDashedLinePattern } from "../shapeGeometry";
import { insertShapePreset } from "../shapePresets";

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

test("all five schema-v4 native primitives compile deterministically through the pinned renderer policy", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  project.shots = [shot];
  shot.objects = [];
  shot.animations = [];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  let authored = ProjectDocumentSchema.parse(project);
  for (const presetId of ["ellipse", "polygon", "dashed-line", "double-arrow", "freeform-path"] as const) {
    authored = insertShapePreset(authored, authored.shots[0].id, presetId);
  }

  const first = compileManim(authored);
  const second = compileManim(cloneSerializable(authored));
  expect(second).toEqual(first);
  expect(first.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  expect(first.python).toContain("Ellipse(width=");
  expect(first.python).toContain("Polygon([0.0, 0.5, 0], [0.4755, 0.1545, 0]");
  expect(first.python).toContain("joint_type=LineJointType.MITER");
  expect(first.python).toContain("DashedLine(");
  expect(first.python).toContain("dash_length=");
  expect(first.python).toContain("dashed_ratio=0.60869565");
  expect(first.python).toContain("cap_style=CapStyleType.BUTT");
  expect(first.python).toContain("DoubleArrow(");
  expect(first.python).toContain("tip_shape_start=ArrowTriangleFilledTip");
  expect(first.python).toContain("tip_shape_end=ArrowTriangleFilledTip");
  expect(first.python).toContain("VMobject(joint_type=LineJointType.ROUND, cap_style=CapStyleType.ROUND).start_new_path(");
  expect(first.python.match(/\.add_cubic_bezier_curve_to\(/g)).toHaveLength(2);
  const policy = validateWithRendererPolicy(first.python);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("the exact quantized polygon and freeform admission boundaries pass renderer policy", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  project.shots = [shot];
  shot.animations = [];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  shot.objects = [
    {
      id: "object-quantized-boundary-polygon",
      type: "polygon",
      name: "Quantized boundary polygon",
      locked: false,
      visible: true,
      transform: { x: 240, y: 270, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {
        shape: {
          kind: "polygon",
          lineJoin: "miter",
          vertices: [
            { x: -0.5, y: 0 },
            { x: 0.5, y: 0 },
            { x: 0, y: 0.000_001 },
          ],
        },
      },
    },
    {
      id: "object-quantized-boundary-freeform",
      type: "freeform-path",
      name: "Quantized boundary freeform",
      locked: false,
      visible: true,
      transform: { x: 720, y: 270, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {
        shape: {
          kind: "freeform-path",
          closed: false,
          lineCap: "round",
          lineJoin: "round",
          nodes: [
            { point: { x: 0, y: 0 } },
            { point: { x: 3e-8, y: 0 } },
          ],
        },
      },
    },
  ];

  const valid = ProjectDocumentSchema.parse(project);
  const compiled = compileManim(valid);
  expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  expect(compiled.python).toContain("Polygon([-0.5, 0.0, 0], [0.5, 0.0, 0], [0.0, -0.000001, 0]");
  expect(compiled.python).toContain(
    ".start_new_path([0.0, 0.0, 0])"
      + ".add_cubic_bezier_curve_to([1e-8, 0.0, 0], [2e-8, 0.0, 0], [3e-8, 0.0, 0])",
  );
  const policy = validateWithRendererPolicy(compiled.python);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("the native parity fixture compiles to exactly six renderer-policy dashes", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  project.shots = [shot];
  shot.objects = [];
  shot.animations = [];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  let authored = ProjectDocumentSchema.parse(project);
  authored = insertShapePreset(authored, authored.shots[0].id, "dashed-line");
  const dashed = authored.shots[0].objects[0];
  dashed.transform.width = 174;
  dashed.properties.shape = {
    kind: "dashed-line",
    lineCap: "round",
    dashLength: 18,
    gapLength: 11,
  };

  const compiled = compileManim(ProjectDocumentSchema.parse(authored));
  expect(compiled.python).toContain(
    "DashedLine([-1.28888887, 0, 0], [1.28888887, 0, 0], "
      + "dash_length=0.26666671, dashed_ratio=0.62068966, cap_style=CapStyleType.ROUND)",
  );
  const policy = validateWithRendererPolicy(compiled.python);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("schema-valid dashed width transforms admit compiler-safe descriptor drift", () => {
  const cases = [
    { aspectRatio: "16:9", initialWidth: 174, targetWidth: 58, dashLength: 18, gapLength: 11 },
    { aspectRatio: "9:16", initialWidth: 40, targetWidth: 4_096, dashLength: 1, gapLength: 19 },
    { aspectRatio: "1:1", initialWidth: 512, targetWidth: 1, dashLength: 1, gapLength: 1 },
    { aspectRatio: "1:1", initialWidth: 40.000_000_002, targetWidth: 40, dashLength: 1, gapLength: 19 },
  ] as const;
  let observedDashLengthDrift = false;
  let observedRatioDrift = false;

  for (const [index, testCase] of cases.entries()) {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[0];
    project.settings.aspectRatio = testCase.aspectRatio;
    project.settings.resolution = resolutionFor(testCase.aspectRatio, project.settings.renderPreset);
    project.shots = [shot];
    shot.objects = [];
    shot.animations = [];
    shot.propertyTracks = [];
    shot.audioClips = [];
    shot.captionClips = [];
    shot.markers = [];
    let authored = ProjectDocumentSchema.parse(project);
    authored = insertShapePreset(authored, authored.shots[0].id, "dashed-line");
    const dashed = authored.shots[0].objects[0];
    dashed.transform.width = testCase.initialWidth;
    dashed.properties.shape = {
      kind: "dashed-line",
      lineCap: "round",
      dashLength: testCase.dashLength,
      gapLength: testCase.gapLength,
    };
    authored.shots[0].animations = [{
      id: `animation-dashed-width-${index}`,
      type: "transform",
      targetIds: [dashed.id],
      start: 0,
      duration: 1,
      easing: "linear",
      properties: { width: testCase.targetWidth },
    }];

    const initialPattern = resolveCompilerSafeDashedLinePattern(
      testCase.aspectRatio,
      testCase.initialWidth,
      testCase.dashLength,
      testCase.gapLength,
    );
    const targetPattern = resolveCompilerSafeDashedLinePattern(
      testCase.aspectRatio,
      testCase.targetWidth,
      testCase.dashLength,
      testCase.gapLength,
    );
    expect(initialPattern).not.toBeNull();
    expect(targetPattern).not.toBeNull();
    observedDashLengthDrift ||= targetPattern?.dashLength !== initialPattern?.dashLength;
    observedRatioDrift ||= targetPattern?.dashedRatio !== initialPattern?.dashedRatio;

    const compiled = compileManim(ProjectDocumentSchema.parse(authored));
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const policy = validateWithRendererPolicy(compiled.python);
    expect({ status: policy.status, stderr: policy.stderr }).toEqual({ status: 0, stderr: "" });
  }
  expect(observedDashLengthDrift).toBe(true);
  expect(observedRatioDrift).toBe(true);
});

test("rounded rectangles preserve one authored-radius descriptor through dimension tracks and transforms", () => {
  const cases = [
    { authority: "track", dimension: "width" },
    { authority: "track", dimension: "height" },
    { authority: "animation", dimension: "width" },
    { authority: "animation", dimension: "height" },
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[0];
    project.shots = [shot];
    shot.objects = [];
    shot.animations = [];
    shot.propertyTracks = [];
    shot.audioClips = [];
    shot.captionClips = [];
    shot.markers = [];
    const authored = insertShapePreset(ProjectDocumentSchema.parse(project), shot.id, "rounded-rectangle");
    const rectangle = authored.shots[0].objects[0];
    rectangle.transform.width = 200;
    rectangle.transform.height = 160;
    rectangle.properties.shape = { kind: "rectangle", cornerRadius: 40 };
    if (testCase.authority === "track") {
      authored.shots[0].propertyTracks = [{
        id: `track-rounded-${testCase.dimension}-${index}`,
        target: { kind: "object", objectId: rectangle.id },
        property: testCase.dimension,
        keyframes: [
          { id: `keyframe-rounded-${index}-a`, time: 0, value: rectangle.transform[testCase.dimension]!, interpolation: { kind: "linear" } },
          { id: `keyframe-rounded-${index}-b`, time: 1, value: 20, interpolation: { kind: "linear" } },
        ],
      }];
    } else {
      authored.shots[0].animations = [{
        id: `animation-rounded-${testCase.dimension}-${index}`,
        type: "transform",
        targetIds: [rectangle.id],
        start: 0,
        duration: 1,
        easing: "linear",
        properties: { [testCase.dimension]: 20 },
      }];
    }

    const compiled = compileManim(ProjectDocumentSchema.parse(authored));
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const descriptors = [...compiled.python.matchAll(
      /RoundedRectangle\(corner_radius=min\(([^,]+), ([^ ]+) \/ 2\.0, ([^ ]+) \/ 2\.0\), width=\2, height=\3\)/g,
    )];
    expect(descriptors.length).toBeGreaterThanOrEqual(2);
    expect(new Set(descriptors.map((match) => match[1]))).toHaveProperty("size", 1);
    const policy = validateWithRendererPolicy(compiled.python);
    expect({ status: policy.status, stderr: policy.stderr }).toEqual({ status: 0, stderr: "" });
  }
});

test("sub-emission rounded-rectangle radii compile as policy-safe rectangles", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  project.shots = [shot];
  shot.objects = [];
  shot.animations = [];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  const authored = insertShapePreset(ProjectDocumentSchema.parse(project), shot.id, "rounded-rectangle");
  const rectangle = authored.shots[0].objects[0];
  rectangle.properties.shape = { kind: "rectangle", cornerRadius: 1e-9 };
  authored.shots[0].animations = [{
    id: "animation-sub-emission-rounded-width",
    type: "transform",
    targetIds: [rectangle.id],
    start: 0,
    duration: 1,
    easing: "linear",
    properties: { width: 10 },
  }];

  const compiled = compileManim(ProjectDocumentSchema.parse(authored));
  expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  expect(compiled.python).not.toContain("RoundedRectangle(");
  expect(compiled.python).toContain(".copy().become(Rectangle(width=");
  const policy = validateWithRendererPolicy(compiled.python);
  expect({ status: policy.status, stderr: policy.stderr }).toEqual({ status: 0, stderr: "" });
});

test("an actual compiler-owned custom Bezier helper and rate lambda pass the renderer policy", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[1];
  const object = shot.objects.find(({ type }) => type !== "group")!;
  project.shots = [shot];
  shot.animations = [];
  shot.objects = [object];
  shot.propertyTracks = [{
    id: "track-policy-custom-bezier",
    target: { kind: "object", objectId: object.id },
    property: "x",
    keyframes: [
      { id: "keyframe-policy-custom-a", time: 0, value: object.transform.x, interpolation: { kind: "custom-bezier", curve: { x1: 0.25, y1: -1, x2: 0.75, y2: 2 } } },
      { id: "keyframe-policy-custom-b", time: 2, value: object.transform.x + 40, interpolation: { kind: "linear" } },
    ],
  }];
  const compiled = compileManim(ProjectDocumentSchema.parse(project));
  expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  expect(compiled.python).toContain("def proofcanvas_cubic_bezier");
  const policy = validateWithRendererPolicy(compiled.python);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("a one-tick delayed lifetime compiles with an allocated reference through renderer policy", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[1];
  const object = shot.objects.find(({ type }) => type !== "group")!;
  project.shots = [shot];
  shot.animations = [];
  shot.objects = [object];
  shot.propertyTracks = [];
  object.lifetime = { start: 1e-8, end: shot.duration };
  const compiled = compileManim(ProjectDocumentSchema.parse(project));
  expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  expect(compiled.python).toContain("Wait(1e-8)");
  expect(compiled.python).not.toContain("undefined.copy()");
  const policy = validateWithRendererPolicy(compiled.python);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test.each(["write", "create"] as const)("a saved V2 %s there-and-back pulse stays loadable but render-blocked", (type) => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[1];
  const object = shot.objects.find(({ type: objectType }) => objectType !== "group")!;
  project.shots = [shot];
  shot.duration = 4;
  shot.objects = [object];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];
  shot.animations = [
    { id: `animation-policy-${type}-pulse`, type, targetIds: [object.id], start: 0, duration: 1, easing: "there-and-back", properties: {} },
    { id: `animation-policy-${type}-move`, type: "move", targetIds: [object.id], start: 1, duration: 1, easing: "linear", properties: { deltaX: 40 } },
    { id: `animation-policy-${type}-reenter`, type: "fade-in", targetIds: [object.id], start: 3, duration: 1, easing: "linear", properties: {} },
  ];
  expect(previewShotAtTime(shot, 1.5).objects[0].preview.opacity).toBe(0);
  expect(previewShotAtTime(shot, 4).objects[0].preview.opacity).toBe(1);
  const valid = ProjectDocumentSchema.parse(project);
  const compiled = compileManim(valid);
  expect(compiled.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "SEMANTIC_EASING_UNSUPPORTED", animationId: `animation-policy-${type}-pulse` }),
  ]));
  expect(compiled.python).not.toContain(`${type === "write" ? "Write" : "Create"}(`);
  const policy = validateWithRendererPolicy(compiled.python);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("a project at direct numeric schema bounds exercises the compiler method matrix through renderer policy", () => {
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
  expect(compiled.python).toContain("self.camera.frame.become(Rectangle(width=config.frame_width");
  expect(compiled.python).toContain("pc_uncountable_yet_zero_length.scale(min(");
  expect(compiled.python).toContain("pc_uncountable_yet_zero_length.shift(");
  expect(compiled.python).toContain("pc_uncountable_yet_zero_length.rotate(-3600.0 * DEGREES, about_point=ORIGIN)");
  expect(compiled.python).toContain("pc_uncountable_yet_zero_length.stretch(-0.01, 0, about_point=ORIGIN).stretch(100.0, 1, about_point=ORIGIN)");
  expect(compiled.python).toMatch(/pc_ref_[a-f0-9_]+ = pc_[a-z0-9_]+\.copy\(\)/);
  expect(compiled.python).toMatch(/pc_ref_[a-f0-9_]+\.copy\(\).*\.set_opacity\((?:0|1)\.0\)/);
  expect(compiled.python).toContain("Transform(self.camera.frame, Rectangle(width=config.frame_width");
  expect(compiled.python).toContain("self.clear()");
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("actual two-shot compiler output preserves shot-local renderer provenance", () => {
  const compiled = compileManim(ProjectDocumentSchema.parse(createCantorDemoProject()));
  const policy = validateWithRendererPolicy(compiled.python);

  expect(compiled.diagnostics.some(({ severity }) => severity === "error")).toBe(false);
  expect(compiled.python.match(/self\.next_section\(/g)).toHaveLength(2);
  expect(compiled.python.match(/self\.clear\(\)/g)).toHaveLength(1);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("an actual nested heterogeneous group transform preserves exact recursive provenance", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  const root: SceneObject = {
    id: "group-policy-nested-root",
    type: "group",
    name: "Nested root",
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {},
  };
  const inner: SceneObject = {
    id: "group-policy-nested-inner",
    parentId: root.id,
    type: "group",
    name: "Nested inner",
    locked: false,
    visible: true,
    transform: { x: 420, y: 270, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {},
  };
  const rectangle: SceneObject = {
    id: "object-policy-nested-rectangle",
    parentId: inner.id,
    type: "rectangle",
    name: "Nested rectangle",
    locked: false,
    visible: true,
    transform: { x: 420, y: 270, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {},
  };
  const label: SceneObject = {
    id: "object-policy-nested-label",
    parentId: root.id,
    type: "text",
    name: "Nested label",
    locked: false,
    visible: true,
    transform: { x: 560, y: 270, width: 120, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fontSize: 28 },
    properties: { content: "Nested" },
  };
  project.shots = [shot];
  shot.duration = 2;
  shot.objects = [root, inner, rectangle, label];
  shot.animations = [{
    id: "animation-policy-nested-root-move",
    type: "move",
    targetIds: [root.id],
    start: 0,
    duration: 1,
    easing: "linear",
    properties: { deltaX: 40 },
  }];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];

  const compiled = compileManim(ProjectDocumentSchema.parse(project));
  const policy = validateWithRendererPolicy(compiled.python);

  expect(compiled.diagnostics.some(({ severity }) => severity === "error")).toBe(false);
  expect(compiled.python).toContain("pc_nested_inner = VGroup(pc_nested_rectangle)");
  expect(compiled.python).toContain("pc_nested_root = Group(pc_nested_inner, pc_nested_label)");
  expect(compiled.python).toMatch(/Transform\(pc_nested_root, Group\(VGroup\(pc_ref_/);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("an actual discontinuous graph with opacity preserves the exact renderer assignment dialect", () => {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[1];
  const graph: SceneObject = {
    id: "object-policy-reciprocal-graph",
    type: "graph",
    name: "Policy reciprocal graph",
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 240, height: 150, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { stroke: "#315866", strokeWidth: 2, opacity: 0.5 },
    properties: {
      expression: {
        kind: "divide",
        left: { kind: "constant", value: 1 },
        right: { kind: "variable" },
      },
      xMin: -2,
      xMax: 2,
    },
  };
  project.shots = [shot];
  shot.objects = [graph];
  shot.animations = [];
  shot.propertyTracks = [];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.markers = [];

  const compiled = compileManim(ProjectDocumentSchema.parse(project));
  const graphLine = compiled.python.split("\n").find((line) => line.includes("set_points_as_corners"));
  const policy = validateWithRendererPolicy(compiled.python);

  expect(compiled.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "GRAPH_DISCONTINUITIES_SEGMENTED", segmentCount: 2 }),
    expect.objectContaining({ code: "GRAPH_GEOMETRY_DERIVED", segmentCount: 2 }),
  ]));
  expect(compiled.diagnostics.some(({ severity }) => severity === "error")).toBe(false);
  expect(graphLine?.match(/set_points_as_corners/g)).toHaveLength(2);
  expect(graphLine).toContain(').set_stroke("#315866", width=2.0).set_opacity(0.5)');
  expect(compiled.python).not.toContain("FunctionGraph");
  expect(compiled.python).not.toContain("lambda x:");
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});

test("caps graph objects at the renderer's total literal-geometry budget", () => {
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
  function freeformProject(closed: boolean) {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[0];
    project.shots = [shot];
    shot.objects = [];
    shot.animations = [];
    shot.propertyTracks = [];
    shot.audioClips = [];
    shot.captionClips = [];
    shot.markers = [];
    const inserted = insertShapePreset(ProjectDocumentSchema.parse(project), shot.id, "freeform-path");
    const path = inserted.shots[0].objects.find(({ type }) => type === "freeform-path")!;
    const source = CurrentShapePropertiesSchema.parse(path.properties.shape);
    if (source.kind !== "freeform-path") throw new Error("Expected the freeform preset shape record");
    path.properties.shape = closed ? {
      kind: "freeform-path",
      closed: true,
      lineJoin: source.lineJoin,
      nodes: source.nodes,
    } : source;
    return { project: inserted, shot: inserted.shots[0], path };
  }

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

  test("admits fill authority only for closed freeform paths", () => {
    const closed = freeformProject(true);
    closed.path.style = { fill: "#123456", stroke: "#654321", strokeWidth: 4, opacity: 0.75 };
    closed.shot.propertyTracks = [{
      id: "track-closed-freeform-fill",
      target: { kind: "object", objectId: closed.path.id },
      property: "fill",
      keyframes: [
        { id: "keyframe-closed-freeform-fill-a", time: 0, value: "#123456", interpolation: { kind: "linear" } },
        { id: "keyframe-closed-freeform-fill-b", time: 1, value: "#abcdef", interpolation: { kind: "linear" } },
      ],
    }];
    expect(ProjectDocumentSchema.safeParse(closed.project).success).toBe(true);

    const openStyle = freeformProject(false);
    openStyle.path.style.fill = "#123456";
    const directStyle = ProjectDocumentSchema.safeParse(openStyle.project);
    expect(directStyle.success).toBe(false);
    if (!directStyle.success) expect(directStyle.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.arrayContaining(["style", "fill"]), message: expect.stringContaining("do not support fill styling") }),
    ]));

    const openTrack = freeformProject(false);
    openTrack.shot.propertyTracks = [{
      id: "track-open-freeform-fill",
      target: { kind: "object", objectId: openTrack.path.id },
      property: "fill",
      keyframes: [{ id: "keyframe-open-freeform-fill", time: 0, value: "#123456", interpolation: { kind: "linear" } }],
    }];
    const directTrack = ProjectDocumentSchema.safeParse(openTrack.project);
    expect(directTrack.success).toBe(false);
    if (!directTrack.success) expect(directTrack.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.arrayContaining(["propertyTracks", 0, "property"]), message: expect.stringContaining("do not support fill tracks") }),
    ]));
  });

  test("compiles closed freeform fill and opacity tracks through policy and rejects paint tampering", () => {
    const { project, shot, path } = freeformProject(true);
    path.style = { fill: "#123456", stroke: "#654321", strokeWidth: 4, opacity: 0.75 };
    shot.propertyTracks = [
      {
        id: "track-closed-freeform-fill-policy",
        target: { kind: "object", objectId: path.id },
        property: "fill",
        keyframes: [
          { id: "keyframe-closed-freeform-fill-policy-a", time: 0, value: "#123456", interpolation: { kind: "linear" } },
          { id: "keyframe-closed-freeform-fill-policy-b", time: 1, value: "#abcdef", interpolation: { kind: "linear" } },
        ],
      },
      {
        id: "track-closed-freeform-opacity-policy",
        target: { kind: "object", objectId: path.id },
        property: "opacity",
        keyframes: [
          { id: "keyframe-closed-freeform-opacity-policy-a", time: 0, value: 0.75, interpolation: { kind: "linear" } },
          { id: "keyframe-closed-freeform-opacity-policy-b", time: 1, value: 0.4, interpolation: { kind: "linear" } },
        ],
      },
    ];
    const compiled = compileManim(ProjectDocumentSchema.parse(project));
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python).toContain("VMobject(joint_type=LineJointType.ROUND).start_new_path(");
    expect(compiled.python).not.toContain("VMobject(joint_type=LineJointType.ROUND, cap_style=");
    expect(compiled.python).toContain('.set_fill("#123456", opacity=1.0).set_stroke("#654321", width=4.0).set_opacity(0.75)');
    expect(compiled.python).toContain('.set_fill("#abcdef", opacity=1.0)');
    expect(compiled.python).toContain(".set_opacity(0.4)");
    expect(compiled.python).toMatch(/\.copy\(\)\.become\(VMobject\([\s\S]+?\)\.set_opacity\(0\.4\)/);
    const policy = validateWithRendererPolicy(compiled.python);
    expect(policy.status).toBe(0);
    expect(policy.stderr).toBe("");

    const tampered = compiled.python.replace(
      '.set_fill("#123456", opacity=1.0)',
      '.set_fill("#123456", opacity=0.0)',
    );
    expect(tampered).not.toBe(compiled.python);
    const rejected = validateWithRendererPolicy(tampered);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("SourcePolicyError");
  });
});
