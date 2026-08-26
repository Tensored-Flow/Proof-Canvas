import { createCantorDemoProject } from "../demo";
import { compileManim } from "../compiler";
import { previewShotAtTime } from "../preview";
import { DocumentOperationSchema } from "../documentOperations";
import {
  PROJECT_SCHEMA_VERSION,
  PROOFCANVAS_BRACE_LABEL_MAX_CHARS,
  PROOFCANVAS_PROJECT_MAX_BYTES,
  PROOFCANVAS_RENDER_SOURCE_MAX_BYTES,
  PROOFCANVAS_SCHEMA_LIMITS,
  PROOFCANVAS_TEXT_MAX_CHARS,
  AssetMetadataSchema,
  AudioClipSchema,
  CaptionClipSchema,
  ObjectLifetimeSchema,
  NonnegativeTimelineTimeSchema,
  PositiveTimelineDurationSchema,
  ProjectDocumentSchema,
  PropertyKeyframeSchema,
  SceneAnimationSchema,
  SceneOperationSchema,
  TimelineMarkerSchema,
  canonicalProjectJson,
  classifyLegacyV2ProjectDocument,
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

  test("migrates a unique-target schema-v3 document by changing only the version signal", () => {
    const legacy = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 3;
    const shots = legacy.shots as Array<Record<string, unknown>>;
    const objects = shots[0].objects as Array<Record<string, unknown>>;
    (objects[0].properties as Record<string, unknown>).publishedCustomPayload = {
      exact: ["preserved", 3, false],
    };
    const before = cloneSerializable(legacy);
    const migrated = parseProjectDocument(legacy);
    expect(migrated.schemaVersion).toBe(4);
    const migratedWithoutVersion = cloneSerializable(migrated) as unknown as Record<string, unknown>;
    delete migratedWithoutVersion.schemaVersion;
    delete before.schemaVersion;
    expect(migratedWithoutVersion).toEqual(before);
    expect((legacy as Record<string, unknown>).schemaVersion).toBe(3);
  });

  test("stably deduplicates historically valid V1/V2/V3 animation target sets without mutating input", () => {
    const legacyWithDuplicateTarget = () => {
      const project = cloneSerializable(createCantorDemoProject());
      const shot = project.shots[1];
      shot.animations = [{
        id: "animation-legacy-duplicate-target",
        type: "move",
        targetIds: [
          "object-conclusion-title",
          "object-conclusion-title",
          "object-conclusion-cardinality",
          "object-conclusion-title",
          "object-conclusion-cardinality",
        ],
        start: 0,
        duration: 1,
        easing: "linear",
        properties: { deltaX: 10 },
      }];
      shot.propertyTracks = [];
      return project;
    };
    const expectedTargets = ["object-conclusion-title", "object-conclusion-cardinality"];

    const legacyV3 = legacyWithDuplicateTarget();
    (legacyV3 as unknown as Record<string, unknown>).schemaVersion = 3;
    const legacyV3Before = cloneSerializable(legacyV3);
    const previewBeforeMigration = previewShotAtTime(legacyV3.shots[1], 0.5);
    const migratedV3 = parseProjectDocument(legacyV3);
    const expectedV3 = cloneSerializable(legacyV3) as unknown as Record<string, unknown>;
    expectedV3.schemaVersion = PROJECT_SCHEMA_VERSION;
    const expectedV3Shot = (expectedV3.shots as Array<{ animations: Array<{ targetIds: string[] }> }>)[1];
    expectedV3Shot.animations[0].targetIds = expectedTargets;
    expect(migratedV3).toEqual(expectedV3);
    expect(previewShotAtTime(migratedV3.shots[1], 0.5)).toEqual(previewBeforeMigration);
    expect(legacyV3).toEqual(legacyV3Before);

    const legacyV2 = legacyWithDuplicateTarget();
    (legacyV2 as unknown as Record<string, unknown>).schemaVersion = 2;
    const legacyV2Before = cloneSerializable(legacyV2);
    const classifiedV2 = classifyLegacyV2ProjectDocument(legacyV2);
    expect(classifiedV2.status).toBe("migrated");
    if (classifiedV2.status === "migrated") expect(classifiedV2.document.shots[1].animations[0].targetIds).toEqual(expectedTargets);
    expect(parseProjectDocument(legacyV2).shots[1].animations[0].targetIds).toEqual(expectedTargets);
    expect(legacyV2).toEqual(legacyV2Before);

    const legacyV1 = legacyWithDuplicateTarget();
    const legacyV1Record = legacyV1 as unknown as Record<string, unknown>;
    legacyV1Record.schemaVersion = 1;
    legacyV1Record.aspectRatio = "16:9";
    delete legacyV1Record.settings;
    const legacyV1Before = cloneSerializable(legacyV1);
    expect(parseProjectDocument(legacyV1).shots[1].animations[0].targetIds).toEqual(expectedTargets);
    expect(legacyV1).toEqual(legacyV1Before);
  });

  test("rejects false-version laundering of schema-v4 native objects as schema-v3", () => {
    const candidate = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    candidate.schemaVersion = 3;
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    shot.objects = [{
      id: "object-laundered-ellipse",
      type: "ellipse",
      name: "Laundered ellipse",
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { shape: { kind: "ellipse" } },
    }];
    shot.animations = [];
    shot.propertyTracks = [];
    expect(() => parseProjectDocument(candidate)).toThrow(/Invalid ProofCanvas schema-v3 document: Legacy project contains non-legacy object type ellipse/);
  });

  test("migrates the frozen v0 fixture through the explicit registry", () => {
    const legacy = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 0;
    const legacyShots = legacy.shots as Array<Record<string, unknown>>;
    legacyShots[0].duration = 21.000000004;
    (legacyShots[0].animations as Array<Record<string, unknown>>)[0].start = 0.100000004;
    const FROZEN_V0_FIXTURE = Object.freeze(legacy);
    const migrated = parseProjectDocument(FROZEN_V0_FIXTURE);
    expect(migrated.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(migrated.metadata.id).toBe("project-uncountable-zero-length");
    expect(migrated.shots[0].duration).toBe(21);
    expect(migrated.shots[0].objects[0].lifetime).toEqual({ start: 0, end: 21 });
    expect(migrated.shots[0].animations[0].start).toBe(0.1);
    expect(FROZEN_V0_FIXTURE.schemaVersion).toBe(0);
  });

  test("keeps previously valid V2 easing loadable while V1 migration records its emphasis repair", () => {
    const persistedV2 = cloneSerializable(createCantorDemoProject());
    (persistedV2 as unknown as Record<string, unknown>).schemaVersion = 2;
    const emphasis = persistedV2.shots[0].animations.find(({ id }) => id === "animation-limit-emphasis")!;
    emphasis.easing = "editorial";
    const write = persistedV2.shots[0].animations.find(({ id }) => id === "animation-title-write")!;
    write.easing = "there-and-back";
    const loaded = parseProjectDocument(JSON.stringify(persistedV2));
    expect(loaded.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(loaded.shots[0].animations.find(({ id }) => id === emphasis.id)?.easing).toBe("editorial");
    expect(loaded.shots[0].animations.find(({ id }) => id === write.id)?.easing).toBe("there-and-back");
    expect(compileManim(loaded).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SEMANTIC_EASING_UNSUPPORTED", animationId: emphasis.id }),
      expect.objectContaining({ code: "SEMANTIC_EASING_UNSUPPORTED", animationId: write.id }),
    ]));
    expect(canonicalProjectJson(parseProjectDocument(canonicalProjectJson(loaded)))).toBe(canonicalProjectJson(loaded));

    const legacyV1 = cloneSerializable(persistedV2) as unknown as Record<string, unknown>;
    legacyV1.schemaVersion = 1;
    legacyV1.aspectRatio = "16:9";
    delete legacyV1.settings;
    const migrated = parseProjectDocument(legacyV1);
    expect(migrated.shots[0].animations.find(({ id }) => id === emphasis.id)?.easing).toBe("there-and-back");
  });

  test("separates broad persisted animation compatibility from new authoring ingress", () => {
    const legacyEmphasis = {
      id: "animation-legacy-emphasis",
      type: "emphasise" as const,
      targetIds: ["object-title"],
      start: 1,
      duration: 1,
      easing: "editorial" as const,
      properties: { scale: 1.1 },
    };
    const legacyWrite = { ...legacyEmphasis, id: "animation-legacy-write", type: "write" as const, easing: "there-and-back" as const, properties: {} };
    expect(SceneAnimationSchema.safeParse(legacyEmphasis)).toMatchObject({ success: true });
    expect(SceneAnimationSchema.safeParse(legacyWrite)).toMatchObject({ success: true });
    expect(SceneOperationSchema.safeParse({ type: "add-animation", animation: legacyEmphasis })).toMatchObject({ success: false });
    expect(SceneOperationSchema.safeParse({ type: "add-animation", animation: legacyWrite })).toMatchObject({ success: false });

    const shot = cloneSerializable(createCantorDemoProject().shots[1]);
    shot.animations = [legacyEmphasis];
    expect(DocumentOperationSchema.safeParse({ type: "add-shot", shot })).toMatchObject({ success: false });
  });

  test("requires unique target IDs at the shared animation and operation ingress boundary", () => {
    const duplicateTargetAnimation = {
      id: "animation-duplicate-target",
      type: "move" as const,
      targetIds: ["object-title", "object-title"],
      start: 1,
      duration: 1,
      easing: "linear" as const,
      properties: { deltaX: 10 },
    };
    const message = "Duplicate animation target object-title; first targeted at index 0";

    const direct = SceneAnimationSchema.safeParse(duplicateTargetAnimation);
    expect(direct.success).toBe(false);
    if (!direct.success) expect(direct.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["targetIds", 1], message }),
    ]));

    // Configured-provider output is decoded through these same two operation
    // variants before it can reach applyOperations.
    for (const operation of [
      { type: "add-animation", animation: duplicateTargetAnimation },
      { type: "update-animation", animationId: "animation-existing", patch: { targetIds: ["object-title", "object-title"] } },
    ]) {
      const parsed = SceneOperationSchema.safeParse(operation);
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: operation.type === "add-animation" ? ["animation", "targetIds", 1] : ["patch", "targetIds", 1],
          message,
        }),
      ]));
    }
  });

  test("classifies schema-v2 fixed-tick migration loss without coalescing chronology", () => {
    const lossless = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    lossless.schemaVersion = 2;
    const losslessShots = lossless.shots as Array<Record<string, unknown>>;
    losslessShots[0].duration = 21.000000004;
    const migrated = classifyLegacyV2ProjectDocument(lossless);
    expect(migrated.status).toBe("migrated");
    if (migrated.status === "migrated") expect(migrated.document.shots[0].duration).toBe(21);

    const collapsing = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    collapsing.schemaVersion = 2;
    const collapsingShot = (collapsing.shots as Array<Record<string, unknown>>)[0];
    collapsingShot.markers = [
      { id: "marker-collapse-a", time: 1, name: "A", color: "#315866" },
      { id: "marker-collapse-b", time: 1.000000001, name: "B", color: "#71402d" },
    ];
    expect(classifyLegacyV2ProjectDocument(collapsing)).toMatchObject({ status: "recovery-required", reason: expect.stringContaining("chronology changes") });
    expect(() => parseProjectDocument(collapsing)).toThrow(/requires recovery/);

    const epsilonChain = cloneSerializable(collapsing);
    ((epsilonChain.shots as Array<Record<string, unknown>>)[0].markers as Array<Record<string, unknown>>).push(
      { id: "marker-collapse-c", time: 1.0000000015, name: "C", color: "#252722" },
    );
    expect(classifyLegacyV2ProjectDocument(epsilonChain)).toMatchObject({ status: "recovery-required" });
  });

  test("quarantines every frozen-valid positive V2 span that collapses below one V3 tick", () => {
    const minimalV2 = () => {
      const candidate = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
      candidate.schemaVersion = 2;
      candidate.assets = [];
      const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
      shot.duration = 5;
      shot.objects = [];
      shot.animations = [];
      shot.propertyTracks = [];
      shot.audioClips = [];
      shot.captionClips = [];
      shot.markers = [];
      candidate.shots = [shot];
      return candidate;
    };
    const expectRecovery = (candidate: Record<string, unknown>, label: string) => {
      expect(classifyLegacyV2ProjectDocument(candidate)).toMatchObject({ status: "recovery-required", reason: expect.stringContaining(label) });
    };

    const shot = minimalV2();
    (shot.shots as Array<Record<string, unknown>>)[0].duration = 4e-9;
    expectRecovery(shot, "duration collapses");

    const animation = minimalV2();
    const animationShot = (animation.shots as Array<Record<string, unknown>>)[0];
    const object = cloneSerializable(createCantorDemoProject().shots[0].objects.find(({ type }) => type === "text")!) as unknown as Record<string, unknown>;
    delete object.parentId;
    delete object.lifetime;
    animationShot.objects = [object];
    animationShot.animations = [{
      id: "animation-v2-subtick",
      type: "move",
      targetIds: [object.id],
      start: 1,
      duration: 4e-9,
      easing: "linear",
      properties: { deltaX: 10 },
    }];
    expectRecovery(animation, "animations[0] collapses");

    const lifetime = minimalV2();
    const lifetimeObject = cloneSerializable(object);
    lifetimeObject.lifetime = { start: 0, end: 4e-9 };
    (lifetime.shots as Array<Record<string, unknown>>)[0].objects = [lifetimeObject];
    expectRecovery(lifetime, "lifetime collapses");

    const caption = minimalV2();
    ((caption.shots as Array<Record<string, unknown>>)[0].captionClips as Array<Record<string, unknown>>).push({
      id: "caption-v2-subtick",
      start: 0,
      end: 4e-9,
      text: "Subtick caption",
      style: {},
    });
    expectRecovery(caption, "captionClips[0] collapses");

    const keyframes = minimalV2();
    (keyframes.shots as Array<Record<string, unknown>>)[0].objects = [cloneSerializable(object)];
    ((keyframes.shots as Array<Record<string, unknown>>)[0].propertyTracks as Array<Record<string, unknown>>).push({
      id: "track-v2-subtick",
      target: { kind: "object", objectId: object.id },
      property: "x",
      keyframes: [
        { id: "keyframe-v2-subtick-a", time: 0, value: 100, interpolation: { kind: "linear" } },
        { id: "keyframe-v2-subtick-b", time: 4e-9, value: 200, interpolation: { kind: "linear" } },
      ],
    });
    expectRecovery(keyframes, "keyframes collapse");

    const asset = minimalV2();
    asset.assets = [{
      id: "asset-v2-subtick",
      filename: "subtick.wav",
      mimeType: "audio/wav",
      size: 44,
      sha256: "a".repeat(64),
      duration: 4e-9,
      provenance: "uploaded",
    }];
    expectRecovery(asset, "assets[0].duration collapses");

    const audioDuration = minimalV2();
    audioDuration.assets = [{
      id: "asset-v2-audio",
      filename: "audio.wav",
      mimeType: "audio/wav",
      size: 44,
      sha256: "b".repeat(64),
      duration: 5,
      provenance: "uploaded",
    }];
    ((audioDuration.shots as Array<Record<string, unknown>>)[0].audioClips as Array<Record<string, unknown>>).push({
      id: "audio-v2-subtick-duration",
      assetId: "asset-v2-audio",
      name: "Subtick clip",
      start: 1,
      duration: 4e-9,
      sourceStart: 0,
      sourceEnd: 1,
      volume: 1,
      muted: false,
      solo: false,
    });
    expectRecovery(audioDuration, "audioClips[0] collapses");

    const audioSource = minimalV2();
    audioSource.assets = cloneSerializable(audioDuration.assets);
    ((audioSource.shots as Array<Record<string, unknown>>)[0].audioClips as Array<Record<string, unknown>>).push({
      id: "audio-v2-subtick-source",
      assetId: "asset-v2-audio",
      name: "Subtick source",
      start: 1,
      duration: 1,
      sourceStart: 0,
      sourceEnd: 4e-9,
      volume: 1,
      muted: false,
      solo: false,
    });
    expectRecovery(audioSource, "source range collapses");

    const invalid = minimalV2();
    (invalid.shots as Array<Record<string, unknown>>)[0].duration = 0;
    expect(classifyLegacyV2ProjectDocument(invalid)).toMatchObject({ status: "invalid" });
  });

  test("rejects an oversized canonical V2 document before tick normalization can shrink it", () => {
    const candidate = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    candidate.schemaVersion = 2;
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    shot.duration = 21.000000004;
    const object = (shot.objects as Array<Record<string, unknown>>)[0];
    (object.properties as Record<string, unknown>).migrationPadding = "";
    const sortValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortValue);
      if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
      return value;
    };
    const emptyBytes = utf8ByteLength(`${JSON.stringify(sortValue(candidate), null, 2)}\n`);
    (object.properties as Record<string, unknown>).migrationPadding = "x".repeat(PROOFCANVAS_PROJECT_MAX_BYTES + 5 - emptyBytes);
    expect(utf8ByteLength(`${JSON.stringify(sortValue(candidate), null, 2)}\n`)).toBe(PROOFCANVAS_PROJECT_MAX_BYTES + 5);
    expect(classifyLegacyV2ProjectDocument(candidate)).toMatchObject({ status: "invalid", reason: expect.stringContaining("UTF-8 bytes") });
  });

  test("quarantines epsilon-tolerated V2 containment that becomes a strict V3 tick violation", () => {
    const shotEnd = 1.0000000046;
    const toleratedEnd = 1.0000000054;
    const base = () => {
      const candidate = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
      candidate.schemaVersion = 2;
      candidate.assets = [];
      const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
      shot.duration = shotEnd;
      shot.objects = [];
      shot.animations = [];
      shot.propertyTracks = [];
      shot.audioClips = [];
      shot.captionClips = [];
      shot.markers = [];
      candidate.shots = [shot];
      return candidate;
    };
    const sourceShot = createCantorDemoProject().shots[0];
    const independentObject = () => {
      const value = cloneSerializable(sourceShot.objects.find(({ type }) => type === "text")!) as unknown as Record<string, unknown>;
      delete value.parentId;
      delete value.lifetime;
      return value;
    };

    const animation = base();
    const animationShot = (animation.shots as Array<Record<string, unknown>>)[0];
    const target = independentObject();
    animationShot.objects = [target];
    animationShot.animations = [{
      id: "animation-v2-epsilon-overrun",
      type: "move",
      targetIds: [target.id],
      start: 0,
      duration: toleratedEnd,
      easing: "linear",
      properties: { deltaX: 10 },
    }];
    expect(classifyLegacyV2ProjectDocument(animation)).toMatchObject({ status: "recovery-required" });

    const lifetime = base();
    const lifetimeTarget = independentObject();
    lifetimeTarget.lifetime = { start: 0, end: toleratedEnd };
    (lifetime.shots as Array<Record<string, unknown>>)[0].objects = [lifetimeTarget];
    expect(classifyLegacyV2ProjectDocument(lifetime)).toMatchObject({ status: "recovery-required" });

    const parentContainment = base();
    const parentShot = (parentContainment.shots as Array<Record<string, unknown>>)[0];
    parentShot.duration = 3;
    const group = cloneSerializable(sourceShot.objects.find(({ type }) => type === "group")!) as unknown as Record<string, unknown>;
    delete group.parentId;
    group.lifetime = { start: toleratedEnd, end: 2.5 };
    const child = independentObject();
    child.parentId = group.id;
    child.lifetime = { start: shotEnd, end: 2.5 };
    parentShot.objects = [group, child];
    expect(classifyLegacyV2ProjectDocument(parentContainment)).toMatchObject({ status: "recovery-required" });

    const targetContainment = base();
    const targetShot = (targetContainment.shots as Array<Record<string, unknown>>)[0];
    targetShot.duration = 3;
    const lateTarget = independentObject();
    lateTarget.lifetime = { start: toleratedEnd, end: 2.5 };
    targetShot.objects = [lateTarget];
    targetShot.animations = [{
      id: "animation-v2-epsilon-target",
      type: "move",
      targetIds: [lateTarget.id],
      start: shotEnd,
      duration: 0.5,
      easing: "linear",
      properties: { deltaX: 10 },
    }];
    expect(classifyLegacyV2ProjectDocument(targetContainment)).toMatchObject({ status: "recovery-required" });

    const audio = base();
    audio.assets = [{
      id: "asset-v2-overrun",
      filename: "overrun.wav",
      mimeType: "audio/wav",
      size: 44,
      sha256: "c".repeat(64),
      duration: 2,
      provenance: "uploaded",
    }];
    ((audio.shots as Array<Record<string, unknown>>)[0].audioClips as Array<Record<string, unknown>>).push({
      id: "audio-v2-epsilon-overrun",
      assetId: "asset-v2-overrun",
      name: "Overrun",
      start: 0,
      duration: toleratedEnd,
      sourceStart: 0,
      sourceEnd: 1,
      volume: 1,
      muted: false,
      solo: false,
    });
    expect(classifyLegacyV2ProjectDocument(audio)).toMatchObject({ status: "recovery-required" });
  });

  test("treats interim V2 there-and-back visibility animations as nonpersistent pulses", () => {
    const candidate = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    candidate.schemaVersion = 2;
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    const animations = shot.animations as Array<Record<string, unknown>>;
    const write = animations.find(({ id }) => id === "animation-title-write")!;
    write.easing = "there-and-back";
    animations.push({ ...cloneSerializable(write), id: "animation-title-write-pulse-2", start: 3 });
    expect(classifyLegacyV2ProjectDocument(candidate)).toMatchObject({ status: "migrated" });
  });

  test("quarantines a frozen-valid alternating visibility sequence whose tick tie order changes", () => {
    const candidate = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    candidate.schemaVersion = 2;
    const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
    shot.duration = 1;
    const target = cloneSerializable((shot.objects as Array<Record<string, unknown>>).find(({ type }) => type === "text")!);
    delete target.parentId;
    delete target.lifetime;
    shot.objects = [target];
    shot.propertyTracks = [];
    shot.audioClips = [];
    shot.captionClips = [];
    shot.markers = [];
    shot.animations = [
      { id: "z-enter", type: "fade-in", targetIds: [target.id], start: 0, duration: 5e-9, easing: "linear", properties: {} },
      { id: "a-exit", type: "fade-out", targetIds: [target.id], start: 4e-9, duration: 1e-9, easing: "linear", properties: {} },
      { id: "b-enter", type: "fade-in", targetIds: [target.id], start: 4.5e-9, duration: 0.5e-9, easing: "linear", properties: {} },
    ];
    candidate.shots = [shot];
    expect(classifyLegacyV2ProjectDocument(candidate)).toMatchObject({ status: "recovery-required" });
  });

  test("preserves the frozen V2 compiler-work boundary before counting V3 point events", () => {
    const fixture = (rotationKeyframes: number) => {
      const candidate = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
      candidate.schemaVersion = 2;
      const shot = (candidate.shots as Array<Record<string, unknown>>)[0];
      shot.duration = 200;
      const target = cloneSerializable((shot.objects as Array<Record<string, unknown>>).find(({ type }) => type === "text")!);
      delete target.parentId;
      delete target.lifetime;
      shot.objects = [target];
      shot.animations = [];
      shot.audioClips = [];
      shot.captionClips = [];
      shot.markers = [];
      const track = (id: string, property: "x" | "y" | "rotation", count: number) => ({
        id,
        target: { kind: "object", objectId: target.id },
        property,
        keyframes: Array.from({ length: count }, (_, index) => ({
          id: `${id}-keyframe-${index}`,
          time: 1 + index * 0.25,
          value: property === "rotation" ? index : 100 + index,
          interpolation: { kind: "linear" },
        })),
      });
      shot.propertyTracks = [
        track("track-v2-work-x", "x", 512),
        track("track-v2-work-y", "y", 512),
        track("track-v2-work-rotation", "rotation", rotationKeyframes),
      ];
      candidate.shots = [shot];
      return candidate;
    };
    // Frozen work is 511 + 511 + 2 = 1024. V3 adds three delayed-first
    // point events, so this valid V2 document must be quarantined, not lost.
    expect(classifyLegacyV2ProjectDocument(fixture(3))).toMatchObject({ status: "recovery-required", reason: expect.stringContaining("Expanded compiler targets") });
    // Frozen work 1025 was never valid and must not be mislabeled recoverable.
    expect(classifyLegacyV2ProjectDocument(fixture(4))).toMatchObject({ status: "invalid", reason: expect.stringContaining("frozen schema-v2 limit") });
  });

  test("frozen schema-v2 validity rejects pre-existing overlap and preserves implicit child lifetime intersection", () => {
    const overlap = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    overlap.schemaVersion = 2;
    const overlapShot = (overlap.shots as Array<Record<string, unknown>>)[0];
    const animations = overlapShot.animations as Array<Record<string, unknown>>;
    animations.push({ ...cloneSerializable(animations[0]), id: "animation-tampered-overlap" });
    expect(classifyLegacyV2ProjectDocument(overlap)).toMatchObject({ status: "invalid", reason: expect.stringMatching(/overlap|redundant/) });

    const hierarchy = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
    hierarchy.schemaVersion = 2;
    const hierarchyShot = (hierarchy.shots as Array<Record<string, unknown>>)[0];
    const group = (hierarchyShot.objects as Array<Record<string, unknown>>).find(({ id }) => id === "object-interval-diagram")!;
    group.lifetime = { start: 0, end: 20 };
    expect(classifyLegacyV2ProjectDocument(hierarchy)).toMatchObject({ status: "migrated" });

    for (const misleadingId of ["duration", "timeline", "lifetime", "overlap", "Caption"]) {
      const duplicate = cloneSerializable(createCantorDemoProject()) as unknown as Record<string, unknown>;
      duplicate.schemaVersion = 2;
      const duplicateShot = (duplicate.shots as Array<Record<string, unknown>>)[0];
      duplicateShot.animations = [];
      duplicateShot.propertyTracks = [];
      const source = cloneSerializable((duplicateShot.objects as Array<Record<string, unknown>>)[0]);
      delete source.parentId;
      delete source.lifetime;
      duplicateShot.objects = [
        { ...cloneSerializable(source), id: misleadingId, name: "First" },
        { ...cloneSerializable(source), id: misleadingId, name: "Second" },
      ];
      expect(classifyLegacyV2ProjectDocument(duplicate)).toMatchObject({ status: "invalid", reason: expect.stringContaining(`Duplicate ID ${misleadingId}`) });
    }
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
      easing: "there-and-back",
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
      easing: "there-and-back",
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

  test("rejects one-tick timeline overruns while accepting arithmetic-dust boundaries", () => {
    const overrun = cloneSerializable(createCantorDemoProject());
    const overrunShot = overrun.shots[1];
    const targetId = overrunShot.objects[0].id;
    overrunShot.duration = 1;
    overrunShot.animations = [{
      id: "animation-tiny-overrun",
      type: "move",
      targetIds: [targetId],
      start: 1,
      duration: 0.00000001,
      easing: "linear",
      properties: { deltaX: 1 },
    }];
    const overrunResult = ProjectDocumentSchema.safeParse(overrun);
    expect(overrunResult.success).toBe(false);
    if (!overrunResult.success) expect(overrunResult.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Animation exceeds shot duration" }),
    ]));

    const keyframeOverrun = cloneSerializable(createCantorDemoProject());
    const keyframeShot = keyframeOverrun.shots[1];
    const keyframeTarget = keyframeShot.objects[0];
    keyframeTarget.lifetime = { start: 0, end: 1 };
    keyframeShot.animations = [];
    keyframeShot.propertyTracks = [{
      id: "track-tiny-lifetime-overrun",
      target: { kind: "object", objectId: keyframeTarget.id },
      property: "x",
      keyframes: [{ id: "keyframe-tiny-lifetime-overrun", time: 1.00000001, value: 300, interpolation: { kind: "linear" } }],
    }];
    const keyframeResult = ProjectDocumentSchema.safeParse(keyframeOverrun);
    expect(keyframeResult.success).toBe(false);
    if (!keyframeResult.success) expect(keyframeResult.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Keyframe time must be inside its target lifetime" }),
    ]));

    const lifetimeOverrun = cloneSerializable(createCantorDemoProject());
    lifetimeOverrun.shots[1].objects[0].lifetime = { start: 0, end: lifetimeOverrun.shots[1].duration + 0.00000001 };
    const lifetimeResult = ProjectDocumentSchema.safeParse(lifetimeOverrun);
    expect(lifetimeResult.success).toBe(false);
    if (!lifetimeResult.success) expect(lifetimeResult.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Object lifetime exceeds shot duration" }),
    ]));

    const dust = cloneSerializable(createCantorDemoProject());
    const dustShot = dust.shots[1];
    dustShot.duration = 0.3;
    dustShot.propertyTracks = [];
    dustShot.audioClips = [];
    dustShot.captionClips = [];
    dustShot.markers = [];
    dustShot.animations = [{
      id: "animation-dust-boundary",
      type: "move",
      targetIds: [dustShot.objects[0].id],
      start: 0.1,
      duration: 0.2,
      easing: "linear",
      properties: { deltaX: 1 },
    }];
    expect(ProjectDocumentSchema.safeParse(dust).success).toBe(true);
  });

  test("canonicalizes every persisted timeline surface while preserving generic numeric author data", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.duration = 2.000000004;
    shot.animations = [];
    shot.propertyTracks = [];
    shot.audioClips = [];
    shot.captionClips = [];
    shot.markers = [];
    const object = shot.objects[0];
    shot.objects = [object];
    object.lifetime = { start: 0.100000004, end: 1.900000004 };
    object.properties.precisionProbe = 0.123456789123;
    shot.animations.push({
      id: "animation-tick-normalized",
      type: "move",
      targetIds: [object.id],
      start: 0.200000004,
      duration: 0.300000004,
      easing: "linear",
      properties: { deltaX: 10 },
    });
    shot.propertyTracks.push({
      id: "track-tick-normalized",
      target: { kind: "camera" },
      property: "x",
      keyframes: [
        { id: "keyframe-tick-a", time: 0.200000004, value: 480, interpolation: { kind: "linear" } },
        { id: "keyframe-tick-b", time: 0.600000006, value: 500, interpolation: { kind: "linear" } },
      ],
    });
    project.assets = [{
      id: "asset-tick-audio",
      filename: "tick.wav",
      mimeType: "audio/wav",
      size: 32,
      sha256: "a".repeat(64),
      duration: 5.000000004,
      provenance: "uploaded",
    }];
    shot.audioClips.push({
      id: "audio-tick-normalized",
      assetId: "asset-tick-audio",
      name: "Tick audio",
      start: 0.100000004,
      duration: 0.500000004,
      sourceStart: 0.200000004,
      sourceEnd: 1.200000004,
      volume: 1,
      muted: false,
      solo: false,
    });
    shot.captionClips.push({ id: "caption-tick", start: 0.300000004, end: 0.900000006, text: "Tick", style: {} });
    shot.markers.push({ id: "marker-tick", time: 1.100000004, name: "Tick", color: "#abcdef" });
    project.styles[0].motion.defaultDuration = 0.800000004;

    const parsed = ProjectDocumentSchema.parse(project);
    const parsedShot = parsed.shots[0];
    expect(parsedShot.duration).toBe(2);
    expect(parsedShot.objects[0].lifetime).toEqual({ start: 0.1, end: 1.9 });
    expect(parsedShot.animations[0]).toEqual(expect.objectContaining({ start: 0.2, duration: 0.30000001 }));
    expect(parsedShot.propertyTracks[0].keyframes.map(({ time }) => time)).toEqual([0.2, 0.60000001]);
    expect(parsed.assets[0].duration).toBe(5);
    expect(parsedShot.audioClips[0]).toEqual(expect.objectContaining({ start: 0.1, duration: 0.50000001, sourceStart: 0.2, sourceEnd: 1.2 }));
    expect(parsedShot.captionClips[0]).toEqual(expect.objectContaining({ start: 0.3, end: 0.90000001 }));
    expect(parsedShot.markers[0].time).toBe(1.1);
    expect(parsed.styles[0].motion.defaultDuration).toBe(0.8);
    expect(parsedShot.objects[0].properties.precisionProbe).toBe(0.123456789123);
    const canonical = canonicalProjectJson(parsed);
    expect(canonicalProjectJson(parseProjectDocument(canonical))).toBe(canonical);
  });

  test("rejects negative and raw sub-tick durations while endpoint pairs use canonical ticks", () => {
    const negative = cloneSerializable(createCantorDemoProject());
    negative.shots[1].markers = [{ id: "marker-negative", time: -0.000000001, name: "Negative", color: "#abcdef" }];
    expect(ProjectDocumentSchema.safeParse(negative).success).toBe(false);

    const subTickAnimation = cloneSerializable(createCantorDemoProject());
    subTickAnimation.shots[1].animations = [{
      id: "animation-sub-tick",
      type: "move",
      targetIds: [subTickAnimation.shots[1].objects[0].id],
      start: 0.0000000049,
      duration: 0.0000000002,
      easing: "linear",
      properties: { deltaX: 1 },
    }];
    expect(ProjectDocumentSchema.safeParse(subTickAnimation).success).toBe(false);

    expect(ObjectLifetimeSchema.parse({ start: 1.0000000049, end: 1.0000000051 })).toEqual({
      start: 1,
      end: 1.00000001,
    });
    expect(ObjectLifetimeSchema.parse({ start: 1, end: 1.00000001 })).toEqual({
      start: 1,
      end: 1.00000001,
    });

    const collapsedKeyframes = cloneSerializable(createCantorDemoProject());
    const targetId = collapsedKeyframes.shots[1].objects[0].id;
    collapsedKeyframes.shots[1].animations = [];
    collapsedKeyframes.shots[1].propertyTracks = [{
      id: "track-collapsed-ticks",
      target: { kind: "object", objectId: targetId },
      property: "x",
      keyframes: [
        { id: "keyframe-collapse-a", time: 1.000000001, value: 1, interpolation: { kind: "linear" } },
        { id: "keyframe-collapse-b", time: 1.000000004, value: 2, interpolation: { kind: "linear" } },
      ],
    }];
    const keyframeResult = ProjectDocumentSchema.safeParse(collapsedKeyframes);
    expect(keyframeResult.success).toBe(false);
    if (!keyframeResult.success) expect(keyframeResult.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("one keyframe per timeline tick") }),
    ]));
  });

  test("turns extreme finite timeline inputs into bounded validation failures without throwing", () => {
    const expectSafeFailure = (parse: () => { success: boolean }) => {
      let result: { success: boolean } | undefined;
      expect(() => { result = parse(); }).not.toThrow();
      expect(result).toMatchObject({ success: false });
    };
    expectSafeFailure(() => NonnegativeTimelineTimeSchema.safeParse(Number.MAX_VALUE));
    expectSafeFailure(() => PositiveTimelineDurationSchema.safeParse(Number.MAX_VALUE));
    expectSafeFailure(() => NonnegativeTimelineTimeSchema.safeParse(-Number.MIN_VALUE));
    expectSafeFailure(() => PropertyKeyframeSchema.safeParse({
      id: "keyframe-extreme",
      time: Number.MAX_VALUE,
      value: 1,
      interpolation: { kind: "linear" },
    }));
    expectSafeFailure(() => TimelineMarkerSchema.safeParse({
      id: "marker-extreme",
      time: Number.MAX_VALUE,
      name: "Extreme",
      color: "#abcdef",
    }));
    expectSafeFailure(() => CaptionClipSchema.safeParse({
      id: "caption-extreme",
      start: 0,
      end: Number.MAX_VALUE,
      text: "Extreme",
      style: {},
    }));
    expectSafeFailure(() => AudioClipSchema.safeParse({
      id: "audio-extreme",
      assetId: "asset-extreme",
      name: "Extreme",
      start: 0,
      duration: 1,
      sourceStart: 0,
      sourceEnd: Number.MAX_VALUE,
      volume: 1,
      muted: false,
      solo: false,
    }));
    expectSafeFailure(() => AssetMetadataSchema.safeParse({
      id: "asset-extreme",
      filename: "extreme.wav",
      mimeType: "audio/wav",
      size: 1,
      sha256: "a".repeat(64),
      duration: Number.MAX_VALUE,
      provenance: "uploaded",
    }));
    expect(ObjectLifetimeSchema.safeParse({ start: 7_199.99999999, end: 7_200 })).toMatchObject({ success: true });
    expectSafeFailure(() => ObjectLifetimeSchema.safeParse({ start: 7_200, end: 7_200.00000001 }));
    expectSafeFailure(() => SceneAnimationSchema.safeParse({
      id: "animation-extreme-start",
      type: "move",
      targetIds: ["object-extreme"],
      start: Number.MAX_VALUE,
      duration: 1,
      easing: "linear",
      properties: { deltaX: 1 },
    }));
    expectSafeFailure(() => SceneAnimationSchema.safeParse({
      id: "animation-extreme-duration",
      type: "move",
      targetIds: ["object-extreme"],
      start: 0,
      duration: Number.MAX_VALUE,
      easing: "linear",
      properties: { deltaX: 1 },
    }));
    expectSafeFailure(() => SceneAnimationSchema.safeParse({
      id: "animation-end-overflow",
      type: "move",
      targetIds: ["object-extreme"],
      start: 7_200,
      duration: 0.00000001,
      easing: "linear",
      properties: { deltaX: 1 },
    }));
    expectSafeFailure(() => SceneOperationSchema.safeParse({
      type: "update-animation",
      animationId: "animation-extreme",
      patch: { start: Number.MAX_VALUE, duration: Number.MAX_VALUE },
    }));
    expectSafeFailure(() => SceneOperationSchema.safeParse({
      type: "set-object-lifetime",
      objectId: "object-extreme",
      lifetime: { start: 0, end: Number.MAX_VALUE },
    }));
    expectSafeFailure(() => SceneOperationSchema.safeParse({
      type: "add-keyframe",
      trackId: "track-extreme",
      keyframe: { id: "keyframe-extreme", time: Number.MAX_VALUE, value: 1, interpolation: { kind: "linear" } },
    }));
    expectSafeFailure(() => DocumentOperationSchema.safeParse({
      type: "split-shot",
      shotId: "shot-extreme",
      time: Number.MAX_VALUE,
    }));
    const project = cloneSerializable(createCantorDemoProject());
    project.shots[0].duration = Number.MAX_VALUE;
    expectSafeFailure(() => ProjectDocumentSchema.safeParse(project));
    const lifetimeProject = cloneSerializable(createCantorDemoProject());
    lifetimeProject.shots[0].objects[0].lifetime = { start: 0, end: Number.MAX_VALUE };
    expectSafeFailure(() => ProjectDocumentSchema.safeParse(lifetimeProject));
  });

  test("accepts the one-tick minimum for all endpoint and duration interval forms", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.duration = 1;
    shot.animations = [];
    shot.propertyTracks = [];
    shot.audioClips = [];
    shot.captionClips = [];
    shot.markers = [];
    const object = shot.objects[0];
    shot.objects = [object];
    object.lifetime = { start: 0, end: 0.00000001 };
    shot.animations = [{ id: "animation-one-tick", type: "move", targetIds: [object.id], start: 0, duration: 0.00000001, easing: "linear", properties: { deltaX: 1 } }];
    shot.propertyTracks = [{
      id: "track-one-tick",
      target: { kind: "camera" },
      property: "x",
      keyframes: [
        { id: "keyframe-one-tick-a", time: 0, value: 480, interpolation: { kind: "linear" } },
        { id: "keyframe-one-tick-b", time: 0.00000001, value: 481, interpolation: { kind: "linear" } },
      ],
    }];
    shot.captionClips = [{ id: "caption-one-tick", start: 0, end: 0.00000001, text: "x", style: {} }];
    expect(ProjectDocumentSchema.safeParse(project).success).toBe(true);
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

    for (const type of ["fade-out", "fade-in"] as const) {
      const pulsing = cloneSerializable(alternating);
      pulsing.shots[1].animations = [
        { id: `animation-pulse-${type}-one`, type, targetIds: [targetId], start: 1, duration: 1, easing: "there-and-back", properties: {} },
        { id: `animation-pulse-${type}-two`, type, targetIds: [targetId], start: 3, duration: 1, easing: "there-and-back", properties: {} },
      ];
      expect(ProjectDocumentSchema.safeParse(pulsing).success).toBe(true);
    }

    for (const type of ["write", "create"] as const) {
      const unsafePathPulse = cloneSerializable(alternating);
      unsafePathPulse.shots[1].animations = [
        { id: `animation-unsafe-${type}-pulse`, type, targetIds: [targetId], start: 1, duration: 1, easing: "there-and-back", properties: {} },
      ];
      expect(ProjectDocumentSchema.safeParse(unsafePathPulse).success).toBe(true);
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
    const leaves: SceneObject[] = Array.from({ length: 5 }, (_, index) => ({
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
      easing: "there-and-back" as const,
      properties: { deltaX: index % 2 === 0 ? 1 : -1 },
    }));

    const result = ProjectDocumentSchema.safeParse(project);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["shots", 0, "animations", 204, "targetIds", 0],
          message: `Expanded compiler targets exceed the project limit of ${PROOFCANVAS_SCHEMA_LIMITS.compilerExpandedTargetsPerProject} operations`,
        }),
      ]));
    }
    expect(() => compileManim(project)).toThrow(/Expanded compiler targets exceed the project limit/);

    shot.objects = [group, ...leaves.slice(0, 4)];
    expect(ProjectDocumentSchema.safeParse(project).success).toBe(true);
  });

  test("budgets property-track compiler expansion before a compact project amplifies past renderer limits", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.duration = 300;
    shot.animations = [];
    const group: SceneObject = {
      id: "group-track-expansion-budget",
      type: "group",
      name: "Track expansion budget",
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 300, height: 200, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    const leaves: SceneObject[] = Array.from({ length: 3 }, (_, index) => ({
      id: `object-track-expansion-${index}`,
      parentId: group.id,
      type: "rectangle",
      name: `Track expansion ${index}`,
      locked: false,
      visible: true,
      transform: { x: 180 + index * 120, y: 270, width: 40, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    }));
    shot.objects = [group, ...leaves.slice(0, 2)];
    shot.propertyTracks = [{
      id: "track-group-expansion-x",
      target: { kind: "object", objectId: group.id },
      property: "x",
      keyframes: Array.from({ length: 512 }, (_, index) => ({
        id: `keyframe-group-expansion-${index}`,
        time: index / 2,
        value: 480 + index % 2,
        interpolation: { kind: "linear" as const },
      })),
    }];

    const nearLimit = ProjectDocumentSchema.parse(project);
    expect(utf8ByteLength(canonicalProjectJson(nearLimit))).toBeLessThan(PROOFCANVAS_RENDER_SOURCE_MAX_BYTES);
    const compiled = compileManim(nearLimit);
    expect(utf8ByteLength(compiled.python)).toBeLessThanOrEqual(PROOFCANVAS_RENDER_SOURCE_MAX_BYTES);

    shot.objects = [group, ...leaves];
    const overLimit = ProjectDocumentSchema.safeParse(project);
    expect(overLimit.success).toBe(false);
    if (!overLimit.success) {
      expect(overLimit.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["shots", 0, "propertyTracks", 0, "keyframes", 341],
          message: `Expanded compiler targets exceed the project limit of ${PROOFCANVAS_SCHEMA_LIMITS.compilerExpandedTargetsPerProject} operations`,
        }),
      ]));
    }
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
    expectInvalid((project) => { project.shots[0].objects.find(({ type }) => type === "rectangle")!.style.strokeWidth = PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax + 1; });
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
    valid.shots[0].objects.find(({ type }) => type === "rectangle")!.style.strokeWidth = PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax;
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
      easing: "there-and-back" as const,
      properties: { scale: 1.1 },
    }));
    const overlapResult = ProjectDocumentSchema.safeParse(overlapProject);
    expect(overlapResult.success).toBe(false);
    if (!overlapResult.success) {
      expect(overlapResult.error.issues.filter(({ message }) => message.includes("overlap on the same object hierarchy")))
        .toHaveLength(PROOFCANVAS_SCHEMA_LIMITS.overlapIssuesPerShot);
    }
  });

  test("holds the exact 256-dash boundary for base, transform-animation, and width-keyframe geometry", () => {
    const makeProject = (width: number) => {
      const project = cloneSerializable(createCantorDemoProject());
      const shot = project.shots[0];
      project.shots = [shot];
      shot.duration = 10;
      shot.objects = [{
        id: "object-dash-budget",
        type: "dashed-line",
        name: "Dash budget",
        locked: false,
        visible: true,
        transform: { x: 480, y: 270, width, height: 2, rotation: 0, scaleX: 1, scaleY: 1 },
        style: {},
        properties: { shape: { kind: "dashed-line", lineCap: "butt", dashLength: 1, gapLength: 1 } },
      }];
      shot.animations = [];
      shot.propertyTracks = [];
      shot.audioClips = [];
      shot.captionClips = [];
      shot.markers = [];
      return project;
    };

    expect(ProjectDocumentSchema.safeParse(makeProject(512))).toMatchObject({ success: true });
    expect(ProjectDocumentSchema.safeParse(makeProject(513))).toMatchObject({ success: false });

    const animationAtLimit = makeProject(2);
    animationAtLimit.shots[0].animations = [{
      id: "animation-dash-width-256",
      type: "transform",
      targetIds: ["object-dash-budget"],
      start: 0,
      duration: 1,
      easing: "linear",
      properties: { width: 512 },
    }];
    expect(ProjectDocumentSchema.safeParse(animationAtLimit)).toMatchObject({ success: true });
    animationAtLimit.shots[0].animations[0].properties.width = 513;
    expect(ProjectDocumentSchema.safeParse(animationAtLimit)).toMatchObject({ success: false });

    const keyframeAtLimit = makeProject(2);
    keyframeAtLimit.shots[0].propertyTracks = [{
      id: "track-dash-width-256",
      target: { kind: "object", objectId: "object-dash-budget" },
      property: "width",
      keyframes: [
        { id: "keyframe-dash-width-a", time: 0, value: 2, interpolation: { kind: "linear" } },
        { id: "keyframe-dash-width-b", time: 1, value: 512, interpolation: { kind: "linear" } },
      ],
    }];
    expect(ProjectDocumentSchema.safeParse(keyframeAtLimit)).toMatchObject({ success: true });
    keyframeAtLimit.shots[0].propertyTracks[0].keyframes[1].value = 513;
    expect(ProjectDocumentSchema.safeParse(keyframeAtLimit)).toMatchObject({ success: false });
  });

  test("budgets native polygon geometry across every base and animation occurrence", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[0];
    project.shots = [shot];
    shot.duration = 80;
    const vertices = Array.from({ length: PROOFCANVAS_SCHEMA_LIMITS.shapePointsMax }, (_, index) => {
      const angle = 2 * Math.PI * index / PROOFCANVAS_SCHEMA_LIMITS.shapePointsMax;
      return { x: 0.49 * Math.cos(angle), y: 0.49 * Math.sin(angle) };
    });
    shot.objects = [{
      id: "object-native-occurrence-budget",
      type: "polygon",
      name: "Native occurrence budget",
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 120, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { shape: { kind: "polygon", vertices, lineJoin: "miter" } },
    }];
    shot.propertyTracks = [];
    shot.audioClips = [];
    shot.captionClips = [];
    shot.markers = [];
    const animation = (index: number) => ({
      id: `animation-native-occurrence-${index}`,
      type: "move" as const,
      targetIds: ["object-native-occurrence-budget"],
      start: index,
      duration: 0.5,
      easing: "linear" as const,
      properties: { deltaX: index % 2 === 0 ? 1 : -1 },
    });
    shot.animations = Array.from({ length: 63 }, (_, index) => animation(index));
    expect(ProjectDocumentSchema.safeParse(project)).toMatchObject({ success: true });

    shot.animations.push(animation(63));
    const overLimit = ProjectDocumentSchema.safeParse(project);
    expect(overLimit.success).toBe(false);
    if (!overLimit.success) expect(overLimit.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: `Native shape geometry exceeds the project work limit of ${PROOFCANVAS_SCHEMA_LIMITS.nativeGeometryWorkPerProject} points or dashes` }),
    ]));
  });

  test("rejects 64 repeated targets before they can understate 64-vertex compiler work", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.duration = 2;
    const objectId = "object-duplicate-target-polygon";
    const vertices = Array.from({ length: PROOFCANVAS_SCHEMA_LIMITS.shapePointsMax }, (_, index) => {
      const angle = 2 * Math.PI * index / PROOFCANVAS_SCHEMA_LIMITS.shapePointsMax;
      return { x: 0.49 * Math.cos(angle), y: 0.49 * Math.sin(angle) };
    });
    shot.objects = [{
      id: objectId,
      type: "polygon",
      name: "Duplicate target polygon",
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 120, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { shape: { kind: "polygon", vertices, lineJoin: "miter" } },
    }];
    shot.animations = [{
      id: "animation-duplicate-target-budget",
      type: "move",
      targetIds: Array.from({ length: PROOFCANVAS_SCHEMA_LIMITS.animationTargets }, () => objectId),
      start: 0,
      duration: 1,
      easing: "linear",
      properties: { deltaX: 1 },
    }];
    shot.propertyTracks = [];
    shot.audioClips = [];
    shot.captionClips = [];
    shot.markers = [];

    const parsed = ProjectDocumentSchema.safeParse(project);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const duplicateIssues = parsed.error.issues.filter(({ message }) => message.startsWith("Duplicate animation target"));
      expect(duplicateIssues).toHaveLength(PROOFCANVAS_SCHEMA_LIMITS.animationTargets - 1);
      expect(duplicateIssues[0]).toMatchObject({
        path: ["shots", 0, "animations", 0, "targetIds", 1],
        message: `Duplicate animation target ${objectId}; first targeted at index 0`,
      });
      expect(parsed.error.issues.some(({ message }) => message.startsWith("Native shape geometry exceeds"))).toBe(false);
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
