import { spawnSync } from "node:child_process";
import { compileManim } from "../compiler";
import { createCantorDemoProject } from "../demo";
import { PROOFCANVAS_SCHEMA_LIMITS, ProjectDocumentSchema, cloneSerializable, type SceneObject } from "../schema";

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
  title.style.strokeWidth = PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax;

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
  const group: SceneObject = {
    id: "group-policy-expansion",
    type: "group",
    name: "Policy expansion",
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 320, height: 180, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {},
  };
  const leaves: SceneObject[] = Array.from({ length: 16 }, (_, index) => ({
    id: `object-policy-expansion-${index}`,
    parentId: group.id,
    type: "rectangle",
    name: `Policy expansion ${index}`,
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
    id: `animation-policy-expansion-${index}`,
    type: "move" as const,
    targetIds: [group.id],
    start: index,
    duration: 0.5,
    easing: "linear" as const,
    properties: { deltaX: index % 2 === 0 ? 1 : -1 },
  }));

  const compiled = compileManim(ProjectDocumentSchema.parse(project));
  expect(Buffer.byteLength(compiled.python, "utf8")).toBeLessThanOrEqual(512 * 1024);
  const policy = validateWithRendererPolicy(compiled.python);
  expect(policy.status).toBe(0);
  expect(policy.stderr).toBe("");
});
