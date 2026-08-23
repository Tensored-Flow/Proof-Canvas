import { createCantorDemoProject } from "../demo";
import { compileManim } from "../compiler";
import { previewShotAtTime } from "../preview";
import {
  PROJECT_SCHEMA_VERSION,
  PROOFCANVAS_BRACE_LABEL_MAX_CHARS,
  PROOFCANVAS_PROJECT_MAX_BYTES,
  PROOFCANVAS_SCHEMA_LIMITS,
  PROOFCANVAS_TEXT_MAX_CHARS,
  ProjectDocumentSchema,
  SceneOperationSchema,
  canonicalProjectJson,
  cloneSerializable,
  isSafeAssetSource,
  parseProjectDocument,
  safeParseProjectDocument,
  utf8ByteLength,
  type SceneObject,
} from "../schema";

describe("ProofCanvas project schema", () => {
  test("validates and deterministically round-trips the Cantor project", () => {
    const project = createCantorDemoProject();
    expect(project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    const first = canonicalProjectJson(project);
    const roundTrip = parseProjectDocument(first);
    expect(canonicalProjectJson(roundTrip)).toBe(first);
    expect(roundTrip.shots[0].objects.map(({ id }) => id)).toEqual(project.shots[0].objects.map(({ id }) => id));
    expect(roundTrip.shots[0].objects.filter(({ parentId }) => parentId).length).toBeGreaterThan(0);
  });

  test("keeps every schema-valid canonical export inside the shared 2 MiB import limit", () => {
    const boundaryText = cloneSerializable(createCantorDemoProject());
    boundaryText.shots[0].objects.find(({ type }) => type === "text")!.properties.content = "x".repeat(PROOFCANVAS_TEXT_MAX_CHARS);
    const canonical = canonicalProjectJson(boundaryText);
    expect(utf8ByteLength(canonical)).toBeLessThanOrEqual(PROOFCANVAS_PROJECT_MAX_BYTES);
    expect(canonicalProjectJson(parseProjectDocument(canonical))).toBe(canonical);

    const oversizedText = cloneSerializable(boundaryText);
    oversizedText.shots[0].objects.find(({ type }) => type === "text")!.properties.content = "x".repeat(PROOFCANVAS_TEXT_MAX_CHARS + 1);
    expect(ProjectDocumentSchema.safeParse(oversizedText)).toMatchObject({ success: false });

    const oversizedBrace = cloneSerializable(createCantorDemoProject());
    const braceProbe = oversizedBrace.shots[0].objects.find(({ type }) => type === "text")!;
    braceProbe.type = "brace";
    braceProbe.properties = { label: "x".repeat(PROOFCANVAS_BRACE_LABEL_MAX_CHARS + 1) };
    expect(ProjectDocumentSchema.safeParse(oversizedBrace)).toMatchObject({ success: false });

    const aggregateOverflow = cloneSerializable(createCantorDemoProject());
    const inlinePrefix = "data:image/png;base64,";
    const acceptedSource = `${inlinePrefix}${"a".repeat(PROOFCANVAS_PROJECT_MAX_BYTES - inlinePrefix.length)}`;
    expect(acceptedSource).toHaveLength(PROOFCANVAS_PROJECT_MAX_BYTES);
    expect(isSafeAssetSource(acceptedSource)).toBe(true);
    aggregateOverflow.shots[1].objects.push({
      id: "object-boundary-image",
      type: "image",
      name: "Boundary image",
      locked: false,
      visible: true,
      transform: { x: 200, y: 200, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { source: acceptedSource },
    });
    const overflowResult = ProjectDocumentSchema.safeParse(aggregateOverflow);
    expect(overflowResult.success).toBe(false);
    if (!overflowResult.success) {
      expect(overflowResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Canonical project JSON") }),
      ]));
    }
    expect(() => canonicalProjectJson(aggregateOverflow)).toThrow(/Canonical project JSON/);
  });

  test("bounds generic JSON nesting without overflowing the validator stack", () => {
    const nestedValue = (depth: number): unknown => {
      let value: unknown = "leaf";
      for (let index = 0; index < depth; index += 1) value = [value];
      return value;
    };
    const atLimit = cloneSerializable(createCantorDemoProject());
    atLimit.shots[0].objects[0].properties.depthProbe = nestedValue(PROOFCANVAS_SCHEMA_LIMITS.jsonValueDepth) as never;
    expect(() => ProjectDocumentSchema.safeParse(atLimit)).not.toThrow();
    expect(ProjectDocumentSchema.safeParse(atLimit)).toMatchObject({ success: true });

    const beyondLimit = cloneSerializable(createCantorDemoProject());
    beyondLimit.shots[0].objects[0].properties.depthProbe = nestedValue(PROOFCANVAS_SCHEMA_LIMITS.jsonValueDepth + 1) as never;
    let result: ReturnType<typeof ProjectDocumentSchema.safeParse> | undefined;
    expect(() => { result = ProjectDocumentSchema.safeParse(beyondLimit); }).not.toThrow();
    expect(result).toMatchObject({ success: false });
  });

  test("rejects unsupported versions with an explicit error", () => {
    const candidate = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    candidate.schemaVersion = 99;
    expect(() => parseProjectDocument(candidate)).toThrow("Unsupported ProofCanvas schema version: 99");
  });

  test("migrates the frozen v0 fixture through the explicit registry", () => {
    const legacy = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 0;
    const FROZEN_V0_FIXTURE = Object.freeze(legacy);
    const migrated = parseProjectDocument(FROZEN_V0_FIXTURE);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.metadata.id).toBe("project-uncountable-zero-length");
    expect(FROZEN_V0_FIXTURE.schemaVersion).toBe(0);
  });

  test("rejects missing parents, cycles, duplicate IDs, and stale animation targets", () => {
    const missingParent = cloneSerializable(createCantorDemoProject());
    missingParent.shots[0].objects[1].parentId = "object-does-not-exist";
    expect(ProjectDocumentSchema.safeParse(missingParent).success).toBe(false);

    const cycle = cloneSerializable(createCantorDemoProject());
    cycle.shots[0].objects.find(({ id }) => id === "object-interval-diagram")!.parentId = "object-interval-generation-0";
    expect(ProjectDocumentSchema.safeParse(cycle).success).toBe(false);

    const duplicate = cloneSerializable(createCantorDemoProject());
    duplicate.shots[0].objects[1].id = duplicate.shots[0].objects[0].id;
    expect(ProjectDocumentSchema.safeParse(duplicate).success).toBe(false);

    const stale = cloneSerializable(createCantorDemoProject());
    stale.shots[0].animations[0].targetIds = ["object-missing"];
    expect(ProjectDocumentSchema.safeParse(stale).success).toBe(false);
  });

  test("rejects overlapping animations on the same object hierarchy but permits parallel objects", () => {
    const overlapping = cloneSerializable(createCantorDemoProject());
    overlapping.shots[0].animations.push({
      id: "animation-overlap-title",
      type: "emphasise",
      targetIds: ["object-title"],
      start: 0.5,
      duration: 1,
      easing: "linear",
      properties: { scale: 1.1 },
    });
    expect(ProjectDocumentSchema.safeParse(overlapping).success).toBe(false);

    const parallel = cloneSerializable(createCantorDemoProject());
    parallel.shots[0].animations.push({
      id: "animation-parallel-note",
      type: "emphasise",
      targetIds: ["object-margin-note"],
      start: 0.5,
      duration: 1,
      easing: "linear",
      properties: { scale: 1.1 },
    });
    expect(ProjectDocumentSchema.safeParse(parallel).success).toBe(true);
  });

  test("rejects overlapping camera tracks while allowing camera and object animation overlap", () => {
    const overlapping = cloneSerializable(createCantorDemoProject());
    const shot = overlapping.shots[0];
    const secondCameraIndex = shot.animations.length;
    shot.animations.push({
      id: "animation-camera-overlap",
      type: "camera-focus",
      targetIds: ["object-title"],
      start: 13.5,
      duration: 0.4,
      easing: "linear",
      properties: { x: 520, zoom: 1.1 },
    });
    const overlappingResult = ProjectDocumentSchema.safeParse(overlapping);
    expect(overlappingResult.success).toBe(false);
    if (!overlappingResult.success) {
      expect(overlappingResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["shots", 0, "animations", secondCameraIndex],
          message: expect.stringContaining("camera-focus animations must be sequential"),
        }),
      ]));
    }

    const crossKind = cloneSerializable(createCantorDemoProject());
    crossKind.shots[0].animations.push({
      id: "animation-object-during-camera",
      type: "move",
      targetIds: ["object-title"],
      start: 13.4,
      duration: 0.3,
      easing: "linear",
      properties: { deltaX: 12 },
    });
    expect(ProjectDocumentSchema.safeParse(crossKind).success).toBe(true);
  });

  test("treats decimal-snapped adjacent object and camera tracks as non-overlapping", () => {
    const objectProject = cloneSerializable(createCantorDemoProject());
    const objectShot = objectProject.shots[1];
    const targetId = objectShot.objects[0].id;
    objectShot.animations = [
      { id: "animation-decimal-object-a", type: "move", targetIds: [targetId], start: 0.1, duration: 0.2, easing: "linear", properties: { x: 300 } },
      { id: "animation-decimal-object-b", type: "move", targetIds: [targetId], start: 0.3, duration: 0.2, easing: "linear", properties: { x: 400 } },
    ];
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(ProjectDocumentSchema.safeParse(objectProject).success).toBe(true);

    const cameraProject = cloneSerializable(createCantorDemoProject());
    const cameraShot = cameraProject.shots[1];
    cameraShot.animations = [
      { id: "animation-decimal-camera-a", type: "camera-focus", targetIds: [targetId], start: 0.1, duration: 0.2, easing: "linear", properties: { zoom: 1.1 } },
      { id: "animation-decimal-camera-b", type: "camera-focus", targetIds: [targetId], start: 0.3, duration: 0.2, easing: "linear", properties: { zoom: 1.2 } },
    ];
    expect(ProjectDocumentSchema.safeParse(cameraProject).success).toBe(true);
  });

  test("allows alternating visibility transitions and rejects redundant repeated transitions", () => {
    const alternating = cloneSerializable(createCantorDemoProject());
    const shot = alternating.shots[1];
    const targetId = shot.objects[0].id;
    shot.animations = [
      { id: "animation-visibility-out", type: "fade-out", targetIds: [targetId], start: 1, duration: 1, easing: "linear", properties: {} },
      { id: "animation-visibility-in", type: "fade-in", targetIds: [targetId], start: 3, duration: 1, easing: "linear", properties: {} },
    ];
    expect(ProjectDocumentSchema.safeParse(alternating).success).toBe(true);

    for (const type of ["fade-out", "fade-in"] as const) {
      const repeated = cloneSerializable(alternating);
      repeated.shots[1].animations = [
        { id: `animation-repeated-${type}-one`, type, targetIds: [targetId], start: 1, duration: 1, easing: "linear", properties: {} },
        { id: `animation-repeated-${type}-two`, type, targetIds: [targetId], start: 3, duration: 1, easing: "linear", properties: {} },
      ];
      const result = ProjectDocumentSchema.safeParse(repeated);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({
            path: ["shots", 1, "animations", 1],
            message: expect.stringContaining("without an intervening opposite transition"),
          }),
        ]));
      }
    }
  });

  test("requires relative deltas for multi-target moves", () => {
    const absolute = cloneSerializable(createCantorDemoProject());
    const shot = absolute.shots[1];
    const targetIds = shot.objects.slice(0, 2).map(({ id }) => id);
    shot.animations = [
      { id: "animation-multi-absolute", type: "move", targetIds, start: 0, duration: 1, easing: "linear", properties: { x: 500 } },
    ];
    const absoluteResult = ProjectDocumentSchema.safeParse(absolute);
    expect(absoluteResult.success).toBe(false);
    if (!absoluteResult.success) {
      expect(absoluteResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: "A multi-target move must use deltaX/deltaY so relative spacing is preserved" }),
      ]));
    }

    shot.animations[0].properties = { deltaX: 100, deltaY: -20 };
    expect(ProjectDocumentSchema.safeParse(absolute).success).toBe(true);

    shot.animations = [
      { id: "animation-multi-transform", type: "transform", targetIds, start: 0, duration: 1, easing: "linear", properties: { rotation: 20 } },
    ];
    const transformResult = ProjectDocumentSchema.safeParse(absolute);
    expect(transformResult.success).toBe(false);
    if (!transformResult.success) {
      expect(transformResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: "A transform animation must target exactly one object" }),
      ]));
    }
  });

  test("rejects transform dimensions when a target has no authored interpolation baseline", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const target = shot.objects[0];
    delete target.transform.width;
    delete target.transform.height;
    shot.animations = [
      { id: "animation-unbased-dimensions", type: "transform", targetIds: [target.id], start: 0, duration: 1, easing: "linear", properties: { width: 200, height: 100 } },
    ];

    const result = ProjectDocumentSchema.safeParse(project);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining(`authored width on every target; ${target.id} does not define it`) }),
        expect.objectContaining({ message: expect.stringContaining(`authored height on every target; ${target.id} does not define it`) }),
      ]));
    }
    expect(previewShotAtTime(shot, 1).objects[0].transform).not.toHaveProperty("width");
    expect(() => compileManim(project)).toThrow(/authored width on every target/);
  });

  test("rejects an animation targeting both a group and its descendant", () => {
    const project = cloneSerializable(createCantorDemoProject());
    project.shots[0].animations[0].targetIds = [
      "object-interval-diagram",
      "object-interval-generation-0",
    ];

    const result = ProjectDocumentSchema.safeParse(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["shots", 0, "animations", 0, "targetIds", 1],
          message: expect.stringContaining("cannot target both ancestor object-interval-diagram and descendant object-interval-generation-0"),
        }),
      ]));
    }
  });

  test("caps object hierarchy depth before compiler preview reduction", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const groups: SceneObject[] = Array.from({ length: PROOFCANVAS_SCHEMA_LIMITS.hierarchyDepth + 1 }, (_, index) => ({
      id: `group-depth-${index}`,
      parentId: index === 0 ? undefined : `group-depth-${index - 1}`,
      type: "group",
      name: `Depth ${index}`,
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    }));
    const leaf: SceneObject = {
      id: "object-depth-leaf",
      parentId: groups.at(-1)!.id,
      type: "rectangle",
      name: "Depth leaf",
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 40, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    project.shots = [shot];
    shot.objects = [...groups, leaf];
    shot.animations = [];

    const tooDeep = ProjectDocumentSchema.safeParse(project);
    expect(tooDeep.success).toBe(false);
    if (!tooDeep.success) {
      expect(tooDeep.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["shots", 0, "objects", groups.length, "parentId"],
          message: `Object hierarchy exceeds the maximum depth of ${PROOFCANVAS_SCHEMA_LIMITS.hierarchyDepth}`,
        }),
      ]));
    }
    expect(() => compileManim(project)).toThrow(`Object hierarchy exceeds the maximum depth of ${PROOFCANVAS_SCHEMA_LIMITS.hierarchyDepth}`);

    leaf.parentId = groups.at(-2)!.id;
    expect(ProjectDocumentSchema.safeParse(project).success).toBe(true);
  });

  test("caps expanded animation leaf work before compiler preview reduction", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const group: SceneObject = {
      id: "group-expansion-budget",
      type: "group",
      name: "Expansion budget",
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 300, height: 200, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    const leaves: SceneObject[] = Array.from({ length: 17 }, (_, index) => ({
      id: `object-expansion-${index}`,
      parentId: group.id,
      type: "rectangle",
      name: `Expansion ${index}`,
      locked: false,
      visible: true,
      transform: { x: 100 + index * 20, y: 270, width: 16, height: 16, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    }));
    project.shots = [shot];
    shot.duration = 300;
    shot.objects = [group, ...leaves];
    shot.animations = Array.from({ length: 256 }, (_, index) => ({
      id: `animation-expansion-${index}`,
      type: "move" as const,
      targetIds: [group.id],
      start: index,
      duration: 0.5,
      easing: "linear" as const,
      properties: { deltaX: index % 2 === 0 ? 1 : -1 },
    }));

    const result = ProjectDocumentSchema.safeParse(project);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["shots", 0, "animations", 240, "targetIds", 0],
          message: `Expanded animation targets exceed the project limit of ${PROOFCANVAS_SCHEMA_LIMITS.animationLeafExpansionsPerProject} leaf operations`,
        }),
      ]));
    }
    expect(() => compileManim(project)).toThrow(/Expanded animation targets exceed the project limit/);

    shot.objects = [group, ...leaves.slice(0, 16)];
    expect(ProjectDocumentSchema.safeParse(project).success).toBe(true);
  });

  test("validates animation properties by type with finite, non-collapsing bounds", () => {
    const rejectedMutations: Array<(project: ReturnType<typeof createCantorDemoProject>) => void> = [
      (project) => { project.shots[0].animations.find(({ id }) => id === "animation-camera-focus")!.properties.zoom = 0; },
      (project) => { project.shots[0].animations.find(({ id }) => id === "animation-camera-focus")!.properties.zoom = -1; },
      (project) => { project.shots[0].animations.find(({ id }) => id === "animation-camera-focus")!.properties.zoom = PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMax + 0.01; },
      (project) => {
        const animation = project.shots[0].animations[0];
        animation.type = "transform";
        animation.properties = { width: 0 };
      },
      (project) => {
        const animation = project.shots[0].animations[0];
        animation.type = "transform";
        animation.properties = { height: -1 };
      },
      (project) => {
        const animation = project.shots[0].animations[0];
        animation.type = "scale";
        animation.properties = { scale: 0 };
      },
      (project) => {
        const animation = project.shots[0].animations[0];
        animation.type = "transform";
        animation.properties = { scaleX: 0 };
      },
      (project) => {
        const animation = project.shots[0].animations[0];
        animation.type = "scale";
        animation.properties = { scaleX: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude + 1 };
      },
      (project) => {
        const animation = project.shots[0].animations[0];
        animation.type = "move";
        animation.properties = { x: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude + 1 };
      },
      (project) => {
        const animation = project.shots[0].animations[0];
        animation.type = "fade-in";
        animation.properties = { scale: 1.2 };
      },
      (project) => {
        const animation = project.shots[0].animations[0];
        animation.type = "move";
        animation.properties = { zoom: 2 };
      },
    ];

    for (const mutate of rejectedMutations) {
      const project = cloneSerializable(createCantorDemoProject());
      mutate(project);
      const result = ProjectDocumentSchema.safeParse(project);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(({ path }) => path.includes("properties"))).toBe(true);
      }
    }

    const valid = cloneSerializable(createCantorDemoProject());
    const transform = valid.shots[0].animations[0];
    transform.type = "transform";
    transform.properties = {
      x: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
      y: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
      width: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax,
      height: 1,
      rotation: PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude,
      scaleX: -PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude,
      scaleY: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude,
    };
    const camera = valid.shots[0].animations.find(({ id }) => id === "animation-camera-focus")!;
    camera.properties.zoom = PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMin;
    expect(ProjectDocumentSchema.safeParse(valid).success).toBe(true);
  });

  test("bounds imported transforms, camera, object styles, style packs, graph ranges, and constants", () => {
    const expectInvalid = (mutate: (project: ReturnType<typeof createCantorDemoProject>) => void) => {
      const project = cloneSerializable(createCantorDemoProject());
      mutate(project);
      expect(ProjectDocumentSchema.safeParse(project).success).toBe(false);
    };
    const addGraph = (project: ReturnType<typeof createCantorDemoProject>, xMax: number, constant: number) => {
      project.shots[1].objects.push({
        id: "object-boundary-graph",
        type: "graph",
        name: "Boundary graph",
        locked: false,
        visible: true,
        transform: { x: 480, y: 270, width: 240, height: 150, rotation: 0, scaleX: 1, scaleY: 1 },
        style: {},
        properties: {
          expression: { kind: "constant", value: constant },
          xMin: -PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude,
          xMax,
        },
      });
    };

    expectInvalid((project) => { project.shots[0].objects[0].transform.x = PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude + 1; });
    expectInvalid((project) => { project.shots[0].objects[0].transform.width = 0; });
    expectInvalid((project) => { project.shots[0].objects[0].transform.height = PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax + 1; });
    expectInvalid((project) => { project.shots[0].objects[0].transform.rotation = PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude + 1; });
    expectInvalid((project) => { project.shots[0].objects[0].transform.scaleX = 0; });
    expectInvalid((project) => { project.shots[0].objects[0].transform.scaleY = PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude + 1; });
    expectInvalid((project) => { project.shots[0].camera.zoom = PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMax + 1; });
    expectInvalid((project) => { project.shots[0].objects[0].style.strokeWidth = PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax + 1; });
    expectInvalid((project) => { project.shots[0].objects[0].style.fontSize = PROOFCANVAS_SCHEMA_LIMITS.fontSizeMax + 1; });
    expectInvalid((project) => { project.styles[0].typography.titleScale = PROOFCANVAS_SCHEMA_LIMITS.typographyScaleMax + 1; });
    expectInvalid((project) => { project.styles[0].spacing.margin = PROOFCANVAS_SCHEMA_LIMITS.spacingMax + 1; });
    expectInvalid((project) => { project.styles[0].strokes.regular = PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax + 1; });
    expectInvalid((project) => { project.styles[0].motion.defaultDuration = 301; });
    expectInvalid((project) => addGraph(project, PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude + 1, 1));
    expectInvalid((project) => addGraph(project, 1, PROOFCANVAS_SCHEMA_LIMITS.expressionConstantMagnitude + 1));

    const valid = cloneSerializable(createCantorDemoProject());
    const object = valid.shots[0].objects[0];
    object.transform = {
      x: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
      y: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
      width: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax,
      height: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin,
      rotation: -PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude,
      scaleX: -PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude,
      scaleY: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude,
    };
    object.style.strokeWidth = PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax;
    object.style.fontSize = PROOFCANVAS_SCHEMA_LIMITS.fontSizeMax;
    valid.shots[0].camera = {
      x: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
      y: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude,
      zoom: PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMax,
      rotation: PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude,
    };
    const style = valid.styles[0];
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
    addGraph(valid, PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude, PROOFCANVAS_SCHEMA_LIMITS.expressionConstantMagnitude);
    expect(ProjectDocumentSchema.safeParse(valid).success).toBe(true);
  });

  test("enforces explicit project, shot, target, operation, and JSON array limits", () => {
    const tooManyStyles = cloneSerializable(createCantorDemoProject());
    tooManyStyles.styles = Array.from(
      { length: PROOFCANVAS_SCHEMA_LIMITS.styles + 1 },
      (_, index) => ({ ...cloneSerializable(tooManyStyles.styles[0]), id: `style-limit-${index}` }),
    );
    expect(ProjectDocumentSchema.safeParse(tooManyStyles)).toMatchObject({ success: false });

    const tooManyShots = cloneSerializable(createCantorDemoProject());
    tooManyShots.shots = Array.from(
      { length: PROOFCANVAS_SCHEMA_LIMITS.shots + 1 },
      (_, index) => ({ ...cloneSerializable(tooManyShots.shots[0]), id: `shot-limit-${index}` }),
    );
    expect(ProjectDocumentSchema.safeParse(tooManyShots)).toMatchObject({ success: false });

    const tooManyObjects = cloneSerializable(createCantorDemoProject());
    const baseObject = tooManyObjects.shots[0].objects.find(({ id }) => id === "object-title")!;
    tooManyObjects.shots[0].objects = Array.from(
      { length: PROOFCANVAS_SCHEMA_LIMITS.objectsPerShot + 1 },
      (_, index) => ({ ...cloneSerializable(baseObject), id: `object-limit-${index}` }),
    );
    const objectResult = ProjectDocumentSchema.safeParse(tooManyObjects);
    expect(objectResult.success).toBe(false);
    if (!objectResult.success) {
      expect(objectResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "too_big", path: ["shots", 0, "objects"] }),
      ]));
      expect(objectResult.error.issues.some(({ message }) => message.includes("overlap on the same object hierarchy"))).toBe(false);
    }

    const tooManyAnimations = cloneSerializable(createCantorDemoProject());
    const baseAnimation = tooManyAnimations.shots[0].animations[0];
    tooManyAnimations.shots[0].animations = Array.from(
      { length: PROOFCANVAS_SCHEMA_LIMITS.animationsPerShot + 1 },
      (_, index) => ({ ...cloneSerializable(baseAnimation), id: `animation-limit-${index}` }),
    );
    const animationResult = ProjectDocumentSchema.safeParse(tooManyAnimations);
    expect(animationResult.success).toBe(false);
    if (!animationResult.success) {
      expect(animationResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "too_big", path: ["shots", 0, "animations"] }),
      ]));
      expect(animationResult.error.issues.some(({ message }) => message.includes("overlap on the same object hierarchy"))).toBe(false);
    }

    const tooManyTargets = cloneSerializable(createCantorDemoProject());
    tooManyTargets.shots[0].animations[0].targetIds = Array(PROOFCANVAS_SCHEMA_LIMITS.animationTargets + 1).fill("object-title");
    const targetResult = ProjectDocumentSchema.safeParse(tooManyTargets);
    expect(targetResult.success).toBe(false);
    if (!targetResult.success) {
      expect(targetResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "too_big", path: ["shots", 0, "animations", 0, "targetIds"] }),
      ]));
      expect(targetResult.error.issues.some(({ message }) => message.includes("overlap on the same object hierarchy"))).toBe(false);
    }

    expect(SceneOperationSchema.safeParse({
      type: "align-objects",
      objectIds: Array(PROOFCANVAS_SCHEMA_LIMITS.operationObjectIds + 1).fill("object-title"),
      alignment: "left",
    })).toMatchObject({ success: false });

    const tooManyJsonItems = cloneSerializable(createCantorDemoProject());
    tooManyJsonItems.shots[0].objects[0].properties.limitProbe = Array(PROOFCANVAS_SCHEMA_LIMITS.jsonArrayItems + 1).fill(0);
    expect(ProjectDocumentSchema.safeParse(tooManyJsonItems)).toMatchObject({ success: false });
  });

  test("caps hierarchy-target and overlap diagnostics for adversarial valid-size timelines", () => {
    const hierarchyProject = cloneSerializable(createCantorDemoProject());
    hierarchyProject.shots[0].animations = Array.from(
      { length: PROOFCANVAS_SCHEMA_LIMITS.hierarchyTargetIssuesPerShot + 8 },
      (_, index) => ({
        id: `animation-hierarchy-${index}`,
        type: "appear" as const,
        targetIds: ["object-interval-diagram", "object-interval-generation-0"],
        start: index * 0.2,
        duration: 0.1,
        easing: "linear" as const,
        properties: {},
      }),
    );
    const hierarchyResult = ProjectDocumentSchema.safeParse(hierarchyProject);
    expect(hierarchyResult.success).toBe(false);
    if (!hierarchyResult.success) {
      expect(hierarchyResult.error.issues.filter(({ message }) => message.includes("cannot target both ancestor")))
        .toHaveLength(PROOFCANVAS_SCHEMA_LIMITS.hierarchyTargetIssuesPerShot);
    }

    const overlapProject = cloneSerializable(createCantorDemoProject());
    overlapProject.shots[0].animations = Array.from({ length: 64 }, (_, index) => ({
      id: `animation-overlap-${index}`,
      type: "emphasise" as const,
      targetIds: ["object-title"],
      start: 0,
      duration: 1,
      easing: "linear" as const,
      properties: { scale: 1.1 },
    }));
    const overlapResult = ProjectDocumentSchema.safeParse(overlapProject);
    expect(overlapResult.success).toBe(false);
    if (!overlapResult.success) {
      expect(overlapResult.error.issues.filter(({ message }) => message.includes("overlap on the same object hierarchy")))
        .toHaveLength(PROOFCANVAS_SCHEMA_LIMITS.overlapIssuesPerShot);
    }
  });

  test("rejects executable graph shapes, unsafe LaTeX, and remote assets", () => {
    const project = cloneSerializable(createCantorDemoProject());
    project.shots[1].objects.push({
      id: "object-unsafe-graph",
      type: "graph",
      name: "Unsafe graph",
      locked: false,
      visible: true,
      transform: { x: 200, y: 200, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { expression: "__import__('os')", xMin: -2, xMax: 2 },
    });
    expect(ProjectDocumentSchema.safeParse(project).success).toBe(false);

    const latex = cloneSerializable(createCantorDemoProject());
    latex.shots[0].objects.find(({ type }) => type === "math")!.properties.content = "\\input{/etc/passwd}";
    expect(ProjectDocumentSchema.safeParse(latex).success).toBe(false);

    const asset = cloneSerializable(createCantorDemoProject());
    asset.shots[1].objects.push({
      id: "object-remote-image",
      type: "image",
      name: "Remote image",
      locked: false,
      visible: true,
      transform: { x: 200, y: 200, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { source: "https://example.com/tracker.png" },
    });
    expect(safeParseProjectDocument(asset).success).toBe(false);

    asset.shots[1].objects.at(-1)!.properties.source = "/proofcanvas/../secret.svg";
    expect(safeParseProjectDocument(asset).success).toBe(false);

    asset.shots[1].objects.at(-1)!.properties.source = "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=";
    expect(safeParseProjectDocument(asset).success).toBe(false);

    asset.shots[1].objects.at(-1)!.properties.source = "/proofcanvas/assets/editorial-mark.svg";
    expect(safeParseProjectDocument(asset).success).toBe(true);
  });
});
