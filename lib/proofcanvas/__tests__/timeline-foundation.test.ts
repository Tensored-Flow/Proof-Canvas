import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileManim } from "../compiler";
import { createCantorDemoProject } from "../demo";
import { easingProgress, manimRateFunctionName } from "../easing";
import { commitOperations, createHistory, undo } from "../history";
import { applyOperations } from "../operations";
import { previewShotAtTime } from "../preview";
import { styledTransform } from "../styles";
import {
  PROJECT_SCHEMA_VERSION,
  PROOFCANVAS_SCHEMA_LIMITS,
  ProjectDocumentSchema,
  canonicalProjectJson,
  cloneSerializable,
  parseProjectDocument,
  type PropertyTrack,
} from "../schema";
import {
  cubicBezierProgress,
  effectiveObjectLifetime,
  indexPropertyTracks,
  samplePropertyTrack,
} from "../timeline";

function numericTrack(overrides: Partial<PropertyTrack> = {}): PropertyTrack {
  return {
    id: "track-title-x",
    target: { kind: "object", objectId: "object-title" },
    property: "x",
    keyframes: [
      { id: "keyframe-title-x-start", time: 0, value: 100, interpolation: { kind: "linear" } },
      { id: "keyframe-title-x-end", time: 2, value: 300, interpolation: { kind: "linear" } },
    ],
    ...overrides,
  };
}

describe("schema V2 timeline foundation", () => {
  test("migrates the retained published V1 fixture and preserves its safe cross-namespace IDs", () => {
    const fixtureBytes = readFileSync(resolve(process.cwd(), "tests/fixtures/proofcanvas-published-v1.json"));
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe("7215837ae02639364c67f48eaf9d76ca0fc7fe7ea13ac86be83b4be6ea0995f9");
    const retained = JSON.parse(fixtureBytes.toString("utf8")) as Record<string, unknown>;
    expect(retained.schemaVersion).toBe(1);
    const migratedRetained = parseProjectDocument(retained);
    expect(migratedRetained.metadata.id).toBe("project-uncountable-zero-length");
    expect(migratedRetained.shots.map(({ id }) => id)).toEqual(["shot-cantor-construction", "shot-cantor-conclusion"]);
    expect(migratedRetained.styles).toHaveLength(2);
    expect(migratedRetained.shots).toHaveLength(2);
    expect(migratedRetained.shots.flatMap(({ objects }) => objects)).toHaveLength(32);
    expect(migratedRetained.shots.flatMap(({ animations }) => animations)).toHaveLength(20);
    const legacyTimelineIds = (retained.shots as Array<{ id: string; objects: Array<{ id: string }>; animations: Array<{ id: string }> }>).flatMap((shot) => [shot.id, ...shot.objects.map(({ id }) => id), ...shot.animations.map(({ id }) => id)]).sort();
    const migratedTimelineIds = migratedRetained.shots.flatMap((shot) => [shot.id, ...shot.objects.map(({ id }) => id), ...shot.animations.map(({ id }) => id)]).sort();
    expect(migratedTimelineIds).toEqual(legacyTimelineIds);
    const semanticProjection = {
      activeStyleId: migratedRetained.activeStyleId,
      aspectRatio: migratedRetained.settings.aspectRatio,
      metadata: migratedRetained.metadata,
      schemaVersion: 1,
      shots: migratedRetained.shots.map(({ propertyTracks: _tracks, audioClips: _audio, captionClips: _captions, markers: _markers, ...shot }) => ({
        ...shot,
        objects: shot.objects.map(({ lifetime: _lifetime, ...object }) => object),
      })),
      styles: migratedRetained.styles.map(({ origin: _origin, ...style }) => style),
    };
    const expectedMigratedProjection = cloneSerializable(retained) as typeof retained & {
      shots: Array<{ animations: Array<{ type: string; easing: string }> }>;
    };
    for (const shot of expectedMigratedProjection.shots) {
      for (const animation of shot.animations) {
        if (animation.type === "emphasise") animation.easing = "there-and-back";
      }
    }
    expect(semanticProjection).toEqual(expectedMigratedProjection);
    expect(migratedRetained.shots.flatMap(({ animations }) => animations).find(({ type }) => type === "emphasise")?.easing)
      .toBe("there-and-back");
    const canonicalRoundTrip = parseProjectDocument(canonicalProjectJson(migratedRetained));
    expect(canonicalRoundTrip).toEqual(migratedRetained);
    expect(compileManim(canonicalRoundTrip).python).toBe(compileManim(migratedRetained).python);
    for (const shot of migratedRetained.shots) {
      const scheduleTimes = [0, ...shot.animations.flatMap((animation) => [animation.start, animation.start + animation.duration]), shot.duration];
      expect(scheduleTimes.map((time) => previewShotAtTime(shot, time))).toEqual(scheduleTimes.map((time) => previewShotAtTime(canonicalRoundTrip.shots.find(({ id }) => id === shot.id)!, time)));
    }

    const crossNamespace = cloneSerializable(retained) as typeof retained & {
      metadata: { id: string };
      activeStyleId: string;
      styles: Array<{ id: string }>;
      shots: Array<{ id: string; objects: Array<{ id: string }> }>;
    };
    const sharedId = crossNamespace.shots[0].objects[0].id;
    crossNamespace.metadata.id = sharedId;
    crossNamespace.styles[0].id = sharedId;
    crossNamespace.activeStyleId = sharedId;
    const migrated = parseProjectDocument(crossNamespace);
    expect(migrated.metadata.id).toBe(sharedId);
    expect(migrated.activeStyleId).toBe(sharedId);
    expect(migrated.styles[0].id).toBe(sharedId);
    expect(migrated.shots[0].objects[0].id).toBe(sharedId);
  });

  test("migrates a frozen V1 document deterministically without changing stable IDs", () => {
    const current = createCantorDemoProject();
    const legacy = cloneSerializable(current) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    legacy.aspectRatio = current.settings.aspectRatio;
    delete legacy.settings;
    delete legacy.assets;
    delete legacy.customEasings;
    legacy.styles = current.styles.map(({ origin: _origin, ...style }) => style);
    legacy.shots = current.shots.map(({ propertyTracks: _tracks, audioClips: _audio, captionClips: _captions, markers: _markers, ...shot }) => ({
      ...shot,
      objects: shot.objects.map(({ lifetime: _lifetime, ...object }) => object),
    }));
    const frozen = Object.freeze(legacy);
    const first = parseProjectDocument(frozen);
    const second = parseProjectDocument(cloneSerializable(frozen));
    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(first.settings).toEqual({ aspectRatio: "16:9", frameRate: 30, resolution: { width: 1280, height: 720 }, renderPreset: "720p", previewQuality: "standard" });
    expect(first.shots.flatMap(({ objects }) => objects.map(({ id }) => id))).toEqual(current.shots.flatMap(({ objects }) => objects.map(({ id }) => id)));
    expect(first.shots.every((shot) => shot.objects.every((object) => object.lifetime?.end === shot.duration))).toBe(true);
    expect(frozen.schemaVersion).toBe(1);
  });

  test("fails closed on duplicate target/property tracks, duplicate times, references, and inconsistent settings", () => {
    const duplicateTrack = cloneSerializable(createCantorDemoProject());
    duplicateTrack.shots[0].propertyTracks = [numericTrack(), numericTrack({ id: "track-title-x-two", keyframes: [
      { id: "keyframe-title-x-two-start", time: 0, value: 1, interpolation: { kind: "linear" } },
    ] })];
    expect(ProjectDocumentSchema.safeParse(duplicateTrack).success).toBe(false);

    const duplicateTime = cloneSerializable(createCantorDemoProject());
    duplicateTime.shots[0].propertyTracks = [numericTrack({ keyframes: [
      { id: "keyframe-title-x-start", time: 1, value: 100, interpolation: { kind: "linear" } },
      { id: "keyframe-title-x-end", time: 1, value: 300, interpolation: { kind: "linear" } },
    ] })];
    expect(ProjectDocumentSchema.safeParse(duplicateTime).success).toBe(false);

    const missingTarget = cloneSerializable(createCantorDemoProject());
    missingTarget.shots[0].propertyTracks = [numericTrack({ target: { kind: "object", objectId: "object-missing" } })];
    expect(ProjectDocumentSchema.safeParse(missingTarget).success).toBe(false);

    const wrongResolution = cloneSerializable(createCantorDemoProject());
    wrongResolution.settings.resolution.width = 1920;
    expect(ProjectDocumentSchema.safeParse(wrongResolution).success).toBe(false);
  });

  test("enforces authored and inherited object lifetimes", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[0];
    const group = shot.objects.find(({ id }) => id === "object-interval-diagram")!;
    const child = shot.objects.find(({ id }) => id === "object-interval-left-1")!;
    group.lifetime = { start: 2, end: 18 };
    child.lifetime = { start: 3, end: 17 };
    expect(ProjectDocumentSchema.safeParse(project).success).toBe(false); // existing child animation begins before 3s
    shot.animations = [];
    expect(ProjectDocumentSchema.safeParse(project).success).toBe(true);
    expect(effectiveObjectLifetime(shot, child.id)).toEqual({ start: 3, end: 17 });
    expect(previewShotAtTime(shot, 2.5).objects.find(({ id }) => id === child.id)?.preview.opacity).toBe(0);
    expect(previewShotAtTime(shot, 3).objects.find(({ id }) => id === child.id)?.preview.opacity).toBeGreaterThan(0);
    expect(previewShotAtTime(shot, 17.1).objects.find(({ id }) => id === child.id)?.preview.opacity).toBe(0);
  });
});

describe("deterministic property-track sampling", () => {
  test("matches every named Manim 0.21 rate function at representative points", () => {
    const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));
    const smooth = (time: number) => {
      const error = sigmoid(-5);
      return Math.min(1, Math.max(0, (sigmoid(10 * (time - 0.5)) - error) / (1 - 2 * error)));
    };
    const expected = {
      linear: (time: number) => time,
      "ease-in": (time: number) => 2 * smooth(time / 2),
      "ease-out": (time: number) => 2 * smooth(time / 2 + 0.5) - 1,
      "ease-in-out": smooth,
      editorial: (time: number) => 1 - (1 - time) ** 4,
      "spring-soft": (time: number) => 1 + 2.70158 * (time - 1) ** 3 + 1.70158 * (time - 1) ** 2,
    } as const;
    expect(Object.fromEntries(Object.keys(expected).map((easing) => [easing, manimRateFunctionName(easing as keyof typeof expected)]))).toEqual({
      linear: "linear",
      "ease-in": "rush_into",
      "ease-out": "rush_from",
      "ease-in-out": "smooth",
      editorial: "rate_functions.ease_out_quart",
      "spring-soft": "rate_functions.ease_out_back",
    });
    for (const time of [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1]) {
      for (const easing of Object.keys(expected) as Array<keyof typeof expected>) {
        expect(easingProgress(easing, time)).toBeCloseTo(expected[easing](time), 14);
      }
    }
  });

  test("samples boundaries, hold, linear, every named eased kind, custom Bezier, and color", () => {
    const linear = numericTrack();
    expect(samplePropertyTrack(linear, -1)).toBe(100);
    expect(samplePropertyTrack(linear, 1)).toBe(200);
    expect(samplePropertyTrack(linear, 3)).toBe(300);
    expect(samplePropertyTrack(numericTrack({ keyframes: [
      { id: "keyframe-hold-a", time: 0, value: 10, interpolation: { kind: "hold" } },
      { id: "keyframe-hold-b", time: 2, value: 20, interpolation: { kind: "linear" } },
    ] }), 1)).toBe(10);
    for (const easing of ["linear", "ease-in", "ease-out", "ease-in-out", "editorial", "spring-soft"] as const) {
      const value = samplePropertyTrack(numericTrack({ keyframes: [
        { id: `keyframe-${easing}-a`, time: 0, value: 0, interpolation: { kind: "eased", easing } },
        { id: `keyframe-${easing}-b`, time: 2, value: 100, interpolation: { kind: "linear" } },
      ] }), 1);
      expect(typeof value).toBe("number");
      expect(value).toBeCloseTo(100 * easingProgress(easing, 0.5), 12);
    }
    const curve = { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
    expect(cubicBezierProgress(curve, 0.5)).toBeCloseTo(0.5, 8);
    expect(cubicBezierProgress(curve, 0.5)).toBe(cubicBezierProgress(curve, 0.5));
    const custom = numericTrack({ keyframes: [
      { id: "keyframe-custom-a", time: 0, value: 0, interpolation: { kind: "custom-bezier", curve } },
      { id: "keyframe-custom-b", time: 2, value: 100, interpolation: { kind: "linear" } },
    ] });
    expect(samplePropertyTrack(custom, 1)).toBeCloseTo(50, 7);
    const color: PropertyTrack = { id: "track-title-fill", target: { kind: "object", objectId: "object-title" }, property: "fill", keyframes: [
      { id: "keyframe-fill-a", time: 0, value: "#000000", interpolation: { kind: "linear" } },
      { id: "keyframe-fill-b", time: 2, value: "#ffffff", interpolation: { kind: "linear" } },
    ] };
    expect(samplePropertyTrack(color, 1)).toBe("#808080");
  });

  test("clamps overshooting numeric tracks to their property domains with deterministic scale signs", () => {
    const limits = PROOFCANVAS_SCHEMA_LIMITS;
    const cases: Array<{ property: PropertyTrack["property"]; from: number; to: number; minimum: number; maximum: number }> = [
      { property: "x", from: -limits.animationCoordinateMagnitude, to: limits.animationCoordinateMagnitude, minimum: -limits.animationCoordinateMagnitude, maximum: limits.animationCoordinateMagnitude },
      { property: "y", from: -limits.animationCoordinateMagnitude, to: limits.animationCoordinateMagnitude, minimum: -limits.animationCoordinateMagnitude, maximum: limits.animationCoordinateMagnitude },
      { property: "width", from: limits.animationDimensionMax, to: limits.animationDimensionMin, minimum: limits.animationDimensionMin, maximum: limits.animationDimensionMax },
      { property: "height", from: limits.animationDimensionMax, to: limits.animationDimensionMin, minimum: limits.animationDimensionMin, maximum: limits.animationDimensionMax },
      { property: "rotation", from: -limits.animationRotationMagnitude, to: limits.animationRotationMagnitude, minimum: -limits.animationRotationMagnitude, maximum: limits.animationRotationMagnitude },
      { property: "opacity", from: 0, to: 1, minimum: 0, maximum: 1 },
      { property: "strokeWidth", from: 0, to: limits.strokeWidthMax, minimum: 0, maximum: limits.strokeWidthMax },
      { property: "zoom", from: limits.cameraZoomMin, to: limits.cameraZoomMax, minimum: limits.cameraZoomMin, maximum: limits.cameraZoomMax },
      { property: "volume", from: 0, to: 4, minimum: 0, maximum: 4 },
    ];
    for (const candidate of cases) {
      const value = samplePropertyTrack(numericTrack({ property: candidate.property, keyframes: [
        { id: `keyframe-${candidate.property}-a`, time: 0, value: candidate.from, interpolation: { kind: "eased", easing: "spring-soft" } },
        { id: `keyframe-${candidate.property}-b`, time: 2, value: candidate.to, interpolation: { kind: "linear" } },
      ] }), 1);
      expect(typeof value).toBe("number");
      expect(value as number).toBeGreaterThanOrEqual(candidate.minimum);
      expect(value as number).toBeLessThanOrEqual(candidate.maximum);
    }
    const positiveScale = samplePropertyTrack(numericTrack({ property: "scale", keyframes: [
      { id: "keyframe-positive-scale-a", time: 0, value: 100, interpolation: { kind: "eased", easing: "spring-soft" } },
      { id: "keyframe-positive-scale-b", time: 2, value: 0.01, interpolation: { kind: "linear" } },
    ] }), 1) as number;
    expect(positiveScale).toBeGreaterThanOrEqual(limits.animationScaleMinMagnitude);
    const crossingScale = samplePropertyTrack(numericTrack({ property: "scale", keyframes: [
      { id: "keyframe-crossing-scale-a", time: 0, value: 1, interpolation: { kind: "linear" } },
      { id: "keyframe-crossing-scale-b", time: 2, value: -1, interpolation: { kind: "linear" } },
    ] }), 1);
    expect(crossingScale).toBe(limits.animationScaleMinMagnitude);
  });

  test("applies group visual tracks to renderable descendants with canonical descendant overrides", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[0];
    shot.animations = [];
    const group = shot.objects.find(({ type }) => type === "group")!;
    const child = shot.objects.find(({ parentId, type }) => parentId === group.id && type !== "group")!;
    const track = (id: string, objectId: string, property: PropertyTrack["property"], value: number | string): PropertyTrack => ({
      id,
      target: { kind: "object", objectId },
      property,
      keyframes: [{ id: `keyframe-${id}`, time: 0, value, interpolation: { kind: "linear" } }],
    } as PropertyTrack);
    const tracks = [
      track("track-group-fill", group.id, "fill", "#112233"),
      track("track-group-stroke", group.id, "stroke", "#445566"),
      track("track-group-width", group.id, "strokeWidth", 7),
      track("track-group-opacity", group.id, "opacity", 0.4),
      track("track-child-fill", child.id, "fill", "#abcdef"),
      track("track-child-stroke", child.id, "stroke", "#fedcba"),
      track("track-child-width", child.id, "strokeWidth", 3),
      track("track-child-opacity", child.id, "opacity", 0.8),
    ];
    shot.propertyTracks = [...tracks].reverse();
    const reversed = previewShotAtTime(shot, 0).objects.find(({ id }) => id === child.id)!;
    shot.propertyTracks = tracks;
    const forward = previewShotAtTime(shot, 0).objects.find(({ id }) => id === child.id)!;
    expect(reversed).toEqual(forward);
    expect(forward.style).toEqual(expect.objectContaining({ fill: "#abcdef", stroke: "#fedcba", strokeWidth: 3, opacity: 0.8 }));
    expect(forward.preview.opacity).toBe(0.8);
    const forwardPython = compileManim(ProjectDocumentSchema.parse(project)).python;
    shot.propertyTracks = [...tracks].reverse();
    expect(compileManim(ProjectDocumentSchema.parse(project)).python).toBe(forwardPython);
    expect(forwardPython).toContain('.set_fill("#abcdef", opacity=1.0)');
    expect(forwardPython).toContain('.set_stroke("#fedcba", width=3.0)');
    expect(forwardPython).toContain(".set_opacity(0.8)");
  });

  test("cascades authored styles and animated group visuals through three nested levels", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[0];
    project.shots = [shot];
    shot.animations = [];
    const root = shot.objects.find(({ type }) => type === "group")!;
    const leaf = shot.objects.find(({ parentId, type }) => parentId === root.id && type !== "group")!;
    const middle = cloneSerializable(root);
    middle.id = "group-style-middle";
    middle.name = "Style middle";
    middle.parentId = root.id;
    middle.style = { stroke: "#223344", strokeWidth: 4 };
    const deep = cloneSerializable(root);
    deep.id = "group-style-deep";
    deep.name = "Style deep";
    deep.parentId = middle.id;
    deep.style = { opacity: 0.6 };
    root.style = { fill: "#112233", stroke: "#111111", strokeWidth: 8, opacity: 0.9 };
    leaf.parentId = deep.id;
    leaf.style = { ...leaf.style, fill: "#abcdef" };
    shot.objects.push(middle, deep);
    const groupTrack = (property: PropertyTrack["property"], from: number | string, to: number | string): PropertyTrack => ({
      id: `track-three-level-${property.toLowerCase()}`,
      target: { kind: "object", objectId: middle.id },
      property,
      keyframes: [
        { id: `keyframe-three-level-${property.toLowerCase()}-a`, time: 0, value: from, interpolation: { kind: "linear" } },
        { id: `keyframe-three-level-${property.toLowerCase()}-b`, time: 2, value: to, interpolation: { kind: "linear" } },
      ],
    } as PropertyTrack);
    const tracks = [
      groupTrack("fill", "#000000", "#ffffff"),
      groupTrack("stroke", "#000000", "#224466"),
      groupTrack("strokeWidth", 2, 6),
      groupTrack("opacity", 0.2, 0.8),
      { id: "track-deep-fill-override", target: { kind: "object" as const, objectId: leaf.id }, property: "fill" as const, keyframes: [
        { id: "keyframe-deep-fill-a", time: 0, value: "#ff0000", interpolation: { kind: "linear" as const } },
        { id: "keyframe-deep-fill-b", time: 2, value: "#00ff00", interpolation: { kind: "linear" as const } },
      ] },
    ];
    shot.propertyTracks = tracks;
    const authored = previewShotAtTime({ ...shot, propertyTracks: [] }, 1).objects.find(({ id }) => id === leaf.id)!;
    expect(authored.style).toEqual(expect.objectContaining({ fill: "#abcdef", stroke: "#223344", strokeWidth: 4, opacity: 0.6 }));
    const midpoint = previewShotAtTime(shot, 1).objects.find(({ id }) => id === leaf.id)!;
    expect(midpoint.style).toEqual(expect.objectContaining({ fill: "#808000", stroke: "#112233", strokeWidth: 4, opacity: 0.5 }));
    const forwardSource = compileManim(ProjectDocumentSchema.parse(project)).python;
    const reversed = cloneSerializable(project);
    reversed.shots[0].propertyTracks.reverse();
    expect(previewShotAtTime(reversed.shots[0], 1).objects.find(({ id }) => id === leaf.id)).toEqual(midpoint);
    expect(compileManim(ProjectDocumentSchema.parse(reversed)).python).toBe(forwardSource);
    expect(forwardSource).toContain('.set_fill("#00ff00", opacity=1.0)');
    expect(forwardSource).toContain('.set_stroke("#224466", width=6.0)');
    expect(forwardSource).toContain(".set_opacity(0.8)");
  });

  test("composes touching hierarchy tracks and uniform/axis scale independent of array order", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[0];
    project.shots = [shot];
    shot.animations = [];
    const group = shot.objects.find(({ type }) => type === "group")!;
    const child = shot.objects.find(({ parentId, type }) => parentId === group.id && type !== "group")!;
    const tracks: PropertyTrack[] = [
      numericTrack({ id: "track-parent-touch", target: { kind: "object", objectId: group.id }, property: "x", keyframes: [
        { id: "keyframe-parent-touch-a", time: 0, value: group.transform.x, interpolation: { kind: "linear" } },
        { id: "keyframe-parent-touch-b", time: 2, value: group.transform.x + 100, interpolation: { kind: "linear" } },
      ] }),
      numericTrack({ id: "track-child-touch", target: { kind: "object", objectId: child.id }, property: "x", keyframes: [
        { id: "keyframe-child-touch-a", time: 2, value: child.transform.x, interpolation: { kind: "linear" } },
        { id: "keyframe-child-touch-b", time: 4, value: child.transform.x + 20, interpolation: { kind: "linear" } },
      ] }),
      numericTrack({ id: "track-child-scale", target: { kind: "object", objectId: child.id }, property: "scale", keyframes: [
        { id: "keyframe-child-scale", time: 0, value: 2, interpolation: { kind: "linear" } },
      ] }),
      numericTrack({ id: "track-child-scale-x", target: { kind: "object", objectId: child.id }, property: "scaleX", keyframes: [
        { id: "keyframe-child-scale-x", time: 0, value: 3, interpolation: { kind: "linear" } },
      ] }),
    ];
    shot.propertyTracks = tracks;
    const forwardPreview = previewShotAtTime(shot, 4).objects.find(({ id }) => id === child.id)!;
    const forwardPython = compileManim(ProjectDocumentSchema.parse(project)).python;
    shot.propertyTracks = [...tracks].reverse();
    const reversePreview = previewShotAtTime(shot, 4).objects.find(({ id }) => id === child.id)!;
    const reversePython = compileManim(ProjectDocumentSchema.parse(project)).python;
    expect(reversePreview).toEqual(forwardPreview);
    expect(reversePython).toBe(forwardPython);
    expect(forwardPreview.transform.x).toBe(child.transform.x + 20);
    expect(forwardPreview.transform.scaleX).toBe(3);
    expect(forwardPreview.transform.scaleY).toBe(2);
  });

  test("indexes and previews the complete supported visual/camera contract", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[0];
    shot.animations = [];
    const objectId = shot.objects.find(({ type }) => type === "rectangle")!.id;
    const properties = ["x", "y", "width", "height", "scale", "rotation", "opacity", "fill", "stroke", "strokeWidth"] as const;
    shot.propertyTracks = properties.map((property, index) => ({
      id: `track-contract-${property.toLowerCase()}`,
      target: { kind: "object" as const, objectId },
      property,
      keyframes: [
        { id: `keyframe-contract-${index}-a`, time: 0, value: property === "fill" || property === "stroke" ? "#000000" : property === "opacity" ? 1 : property === "strokeWidth" ? 1 : property === "scale" ? 1 : 100, interpolation: { kind: "linear" as const } },
        { id: `keyframe-contract-${index}-b`, time: 2, value: property === "fill" || property === "stroke" ? "#ffffff" : property === "opacity" ? 0.5 : property === "strokeWidth" ? 3 : property === "scale" ? 2 : 200, interpolation: { kind: "linear" as const } },
      ],
    }));
    shot.propertyTracks.push({ id: "track-camera-zoom", target: { kind: "camera" }, property: "zoom", keyframes: [
      { id: "keyframe-camera-zoom-a", time: 0, value: 1, interpolation: { kind: "linear" } },
      { id: "keyframe-camera-zoom-b", time: 2, value: 2, interpolation: { kind: "linear" } },
    ] });
    const valid = ProjectDocumentSchema.parse(project);
    expect(indexPropertyTracks(valid.shots[0]).byId.size).toBe(properties.length + 1);
    const preview = previewShotAtTime(valid.shots[0], 1);
    const object = preview.objects.find(({ id }) => id === objectId)!;
    expect(object.transform.x).toBe(150);
    expect(object.transform.scaleX).toBe(1.5);
    expect(object.style.fill).toBe("#808080");
    expect(object.style.opacity).toBe(0.75);
    expect(preview.camera.zoom).toBe(1.5);
  });
});

describe("timeline operations and compiler", () => {
  test("applies keyframe transactions atomically, honors locks, and undoes without ID drift", () => {
    const project = createCantorDemoProject();
    project.shots[0].animations = [];
    const shotId = project.shots[0].id;
    const track = numericTrack();
    const committed = commitOperations(createHistory(project), shotId, [
      { type: "set-object-lifetime", objectId: "object-title", lifetime: { start: 0, end: 5 } },
      { type: "add-property-track", track },
      { type: "duplicate-keyframe", trackId: track.id, keyframeId: "keyframe-title-x-start", duplicateId: "keyframe-title-x-middle", time: 1 },
      { type: "update-keyframe", trackId: track.id, keyframeId: "keyframe-title-x-middle", patch: { value: 250, interpolation: { kind: "hold" } } },
      { type: "move-keyframe", trackId: track.id, keyframeId: "keyframe-title-x-end", time: 3 },
    ], "Author title keyframes");
    expect(committed.present.shots[0].propertyTracks[0].keyframes.map(({ id }) => id)).toEqual(["keyframe-title-x-start", "keyframe-title-x-middle", "keyframe-title-x-end"]);
    expect(undo(committed).present).toEqual(project);

    expect(() => applyOperations(committed.present, shotId, [
      { type: "move-keyframe", trackId: track.id, keyframeId: "keyframe-title-x-end", time: 1 },
    ])).toThrow(/one keyframe per time/);
    expect(committed.present.shots[0].propertyTracks[0].keyframes.at(-1)?.time).toBe(3);

    const locked = applyOperations(project, shotId, [{ type: "lock-object", objectId: "object-title" }]).project;
    expect(() => applyOperations(locked, shotId, [{ type: "add-property-track", track }])).toThrow(/locked object/);
  });

  test("rejects every group-target track and keyframe mutation when a descendant is locked", () => {
    const base = cloneSerializable(createCantorDemoProject());
    const shot = base.shots[0];
    shot.animations = [];
    shot.propertyTracks = [];
    const group = shot.objects.find(({ id }) => id === "object-interval-diagram")!;
    const descendant = shot.objects.find(({ parentId }) => parentId === group.id)!;
    const groupTrack = numericTrack({
      id: "track-locked-group-x",
      target: { kind: "object", objectId: group.id },
      keyframes: [
        { id: "keyframe-locked-group-a", time: 0, value: group.transform.x, interpolation: { kind: "linear" } },
        { id: "keyframe-locked-group-b", time: 2, value: group.transform.x + 10, interpolation: { kind: "linear" } },
      ],
    });
    descendant.locked = true;
    expect(() => applyOperations(base, shot.id, [{ type: "add-property-track", track: groupTrack }])).toThrow(/locked object/);

    const withTrack = cloneSerializable(base);
    withTrack.shots[0].propertyTracks = [groupTrack];
    const mutations = [
      { type: "delete-property-track", trackId: groupTrack.id },
      { type: "add-keyframe", trackId: groupTrack.id, keyframe: { id: "keyframe-locked-group-middle", time: 1, value: group.transform.x + 5, interpolation: { kind: "linear" } } },
      { type: "update-keyframe", trackId: groupTrack.id, keyframeId: "keyframe-locked-group-a", patch: { value: group.transform.x + 1 } },
      { type: "move-keyframe", trackId: groupTrack.id, keyframeId: "keyframe-locked-group-b", time: 3 },
      { type: "delete-keyframe", trackId: groupTrack.id, keyframeId: "keyframe-locked-group-b" },
      { type: "duplicate-keyframe", trackId: groupTrack.id, keyframeId: "keyframe-locked-group-a", duplicateId: "keyframe-locked-group-copy", time: 1 },
    ] as const;
    for (const mutation of mutations) {
      expect(() => applyOperations(withTrack, shot.id, [mutation])).toThrow(/locked object/);
    }
  });

  test("compiles linear object/style/camera tracks deterministically and diagnoses unsupported collisions", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    shot.animations = [];
    const objectId = shot.objects[0].id;
    shot.propertyTracks = [
      numericTrack({ id: "track-compiler-x", target: { kind: "object", objectId }, keyframes: [
        { id: "keyframe-compiler-x-a", time: 0, value: 100, interpolation: { kind: "linear" } },
        { id: "keyframe-compiler-x-b", time: 2, value: 200, interpolation: { kind: "linear" } },
      ] }),
      { id: "track-compiler-fill", target: { kind: "object", objectId }, property: "fill", keyframes: [
        { id: "keyframe-compiler-fill-a", time: 0, value: "#000000", interpolation: { kind: "linear" } },
        { id: "keyframe-compiler-fill-b", time: 2, value: "#ffffff", interpolation: { kind: "linear" } },
      ] },
      { id: "track-compiler-camera", target: { kind: "camera" }, property: "zoom", keyframes: [
        { id: "keyframe-compiler-camera-a", time: 0, value: 1, interpolation: { kind: "linear" } },
        { id: "keyframe-compiler-camera-b", time: 2, value: 1.5, interpolation: { kind: "linear" } },
      ] },
    ];
    const valid = ProjectDocumentSchema.parse(project);
    const first = compileManim(valid);
    const second = compileManim(cloneSerializable(valid));
    expect(second.python).toBe(first.python);
    expect(first.python).toContain("# ProofCanvas settings: 16:9, 1280x720, 30fps");
    expect(first.python).toContain('.set_fill("#ffffff", opacity=1.0)');
    expect(first.python).toContain("Rectangle(width=config.frame_width / 1.5");
    expect(first.diagnostics.some(({ code }) => code === "RENDER_SETTINGS_EXTERNAL")).toBe(true);
    const parsed = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: first.python, encoding: "utf8" });
    expect(parsed.status).toBe(0);

    shot.animations = [{ id: "animation-compiler-collision", type: "move", targetIds: [objectId], start: 0, duration: 2, easing: "linear", properties: { x: 250 } }];
    const collision = compileManim(ProjectDocumentSchema.parse(project));
    expect(collision.diagnostics.some(({ code, trackId }) => code === "TRACK_SEMANTIC_COLLISION" && trackId === "track-compiler-x")).toBe(true);
  });

  test("compiles track targets from the exact emitted first-keyframe reference pose", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.animations = [];
    const object = shot.objects.find(({ transform }) => transform.width !== undefined && transform.height !== undefined)!;
    const authored = object.transform;
    shot.propertyTracks = ([
      ["x", authored.x - 100, authored.x + 80],
      ["rotation", authored.rotation - 20, authored.rotation + 35],
      ["scaleX", authored.scaleX * 0.5, authored.scaleX * 1.5],
      ["width", authored.width! * 0.5, authored.width! * 1.25],
      ["height", authored.height! * 0.5, authored.height! * 1.4],
    ] as const).map(([property, initial, final], index) => ({
      id: `track-reference-${property.toLowerCase()}`,
      target: { kind: "object" as const, objectId: object.id },
      property,
      keyframes: [
        { id: `keyframe-reference-${index}-a`, time: 0, value: initial, interpolation: { kind: "linear" as const } },
        { id: `keyframe-reference-${index}-b`, time: 2, value: final, interpolation: { kind: "linear" as const } },
      ],
    }));
    const compiled = compileManim(ProjectDocumentSchema.parse(project));
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const transformLine = compiled.python.split("\n").find((line) => line.includes("self.play(Transform(") && line.includes(".move_to(") && line.includes(".rotate(") && line.includes(".stretch("));
    expect(transformLine).toBeDefined();
    const style = project.styles.find(({ id }) => id === project.activeStyleId)!;
    const initial = styledTransform(previewShotAtTime(shot, 0).objects.find(({ id }) => id === object.id)!, style);
    const final = styledTransform(previewShotAtTime(shot, 2).objects.find(({ id }) => id === object.id)!, style);
    const py = (value: number) => Number.isInteger(value) ? `${value}.0` : Number(value.toFixed(8)).toString();
    const expectedXStretch = final.width! * final.scaleX / (initial.width! * initial.scaleX);
    const expectedYStretch = final.height! * final.scaleY / (initial.height! * initial.scaleY);
    const coordinateScale = 14.222222 / 960;
    expect(transformLine).toContain(`.stretch(${py(expectedXStretch)}, 0)`);
    expect(transformLine).toContain(`.stretch(${py(expectedYStretch)}, 1)`);
    expect(transformLine).toContain(`.rotate(${py(final.rotation - initial.rotation)} * DEGREES)`);
    expect(transformLine).toContain(`.move_to([${py((final.x - 480) * coordinateScale)}, ${py((270 - final.y) * coordinateScale)}, 0])`);
    expect(initial.x).not.toBe(authored.x);
    expect(final.x).not.toBe(authored.x);
    expect(final.x).not.toBe(initial.x);
  });

  test("rejects named or linear track segments whose Manim interpolation leaves the validated property domain", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.animations = [];
    const object = shot.objects[0];
    shot.propertyTracks = [
      numericTrack({ id: "track-unsafe-x", target: { kind: "object", objectId: object.id }, property: "x", keyframes: [
        { id: "keyframe-unsafe-x-a", time: 0, value: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, interpolation: { kind: "eased", easing: "spring-soft" } },
        { id: "keyframe-unsafe-x-b", time: 2, value: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, interpolation: { kind: "linear" } },
      ] }),
      numericTrack({ id: "track-unsafe-scale", target: { kind: "object", objectId: object.id }, property: "scale", keyframes: [
        { id: "keyframe-unsafe-scale-a", time: 0, value: 1, interpolation: { kind: "linear" } },
        { id: "keyframe-unsafe-scale-b", time: 2, value: -1, interpolation: { kind: "linear" } },
      ] }),
      {
        id: "track-unsafe-fill",
        target: { kind: "object", objectId: object.id },
        property: "fill",
        keyframes: [
          { id: "keyframe-unsafe-fill-a", time: 0, value: "#000000", interpolation: { kind: "eased", easing: "spring-soft" } },
          { id: "keyframe-unsafe-fill-b", time: 2, value: "#ffffff", interpolation: { kind: "linear" } },
        ],
      },
    ];
    const compiled = compileManim(ProjectDocumentSchema.parse(project));
    expect(compiled.diagnostics.filter(({ code }) => code === "TRACK_EASING_DOMAIN_UNSAFE").map(({ trackId }) => trackId).sort()).toEqual(["track-unsafe-fill", "track-unsafe-scale", "track-unsafe-x"]);
    expect(compiled.python).not.toContain("# Animation component 1: 0.0s to 6.0s");
  });

  test("removes every rejected whole track from all compiler source and baseline calculations", () => {
    const base = cloneSerializable(createCantorDemoProject());
    const shot = base.shots[1];
    base.shots = [shot];
    shot.animations = [];
    const object = shot.objects.find(({ type }) => type !== "group")!;
    const admitted = numericTrack({ id: "track-admitted-y", target: { kind: "object", objectId: object.id }, property: "y", keyframes: [
      { id: "keyframe-admitted-y-a", time: 0, value: object.transform.y, interpolation: { kind: "linear" } },
      { id: "keyframe-admitted-y-b", time: 2, value: object.transform.y + 10, interpolation: { kind: "linear" } },
    ] });
    shot.propertyTracks = [admitted];
    const admittedSource = compileManim(ProjectDocumentSchema.parse(base)).python;

    const rejectedTracks: PropertyTrack[] = [
      numericTrack({ id: "track-rejected-scale-positive", target: { kind: "object", objectId: object.id }, property: "scale", keyframes: [
        { id: "keyframe-rejected-scale-positive-a", time: 0, value: 100, interpolation: { kind: "eased", easing: "spring-soft" } },
        { id: "keyframe-rejected-scale-positive-b", time: 2, value: 0.01, interpolation: { kind: "linear" } },
      ] }),
      numericTrack({ id: "track-rejected-scale-negative", target: { kind: "object", objectId: object.id }, property: "scaleX", keyframes: [
        { id: "keyframe-rejected-scale-negative-a", time: 0, value: -100, interpolation: { kind: "eased", easing: "spring-soft" } },
        { id: "keyframe-rejected-scale-negative-b", time: 2, value: -0.01, interpolation: { kind: "linear" } },
      ] }),
    ];
    for (const rejected of rejectedTracks) {
      const candidate = cloneSerializable(base);
      candidate.shots[0].propertyTracks = [admitted, rejected];
      const compiled = compileManim(ProjectDocumentSchema.parse(candidate));
      expect(compiled.python).toBe(admittedSource);
      expect(compiled.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", trackId: rejected.id })]));
    }

    const semanticOnly = cloneSerializable(base);
    semanticOnly.shots[0].propertyTracks = [];
    semanticOnly.shots[0].animations = [{ id: "animation-preserved", type: "move", targetIds: [object.id], start: 0, duration: 2, easing: "linear", properties: { x: object.transform.x + 40 } }];
    const semanticSource = compileManim(ProjectDocumentSchema.parse(semanticOnly)).python;
    const withCollision = cloneSerializable(semanticOnly);
    withCollision.shots[0].propertyTracks = [numericTrack({ id: "track-rejected-collision", target: { kind: "object", objectId: object.id }, property: "x", keyframes: [
      { id: "keyframe-rejected-collision-a", time: 0, value: object.transform.x + 500, interpolation: { kind: "linear" } },
      { id: "keyframe-rejected-collision-b", time: 2, value: object.transform.x + 800, interpolation: { kind: "linear" } },
    ] })];
    const collisionCompile = compileManim(ProjectDocumentSchema.parse(withCollision));
    expect(collisionCompile.python).toBe(semanticSource);
    expect(collisionCompile.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRACK_SEMANTIC_COLLISION", trackId: "track-rejected-collision" })]));
  });

  test.each(["rotation", "y"] as const)("rebuilds merged %s segments from surviving tracks after peer rejection", (property) => {
    const standalone = cloneSerializable(createCantorDemoProject());
    const shot = standalone.shots[1];
    standalone.shots = [shot];
    shot.animations = [];
    const object = shot.objects.find(({ type }) => type !== "group")!;
    const authored = property === "rotation" ? object.transform.rotation : object.transform.y;
    const survivor = numericTrack({ id: `track-surviving-${property}`, target: { kind: "object", objectId: object.id }, property, keyframes: [
      { id: `keyframe-surviving-${property}-a`, time: 0, value: authored, interpolation: { kind: "linear" } },
      { id: `keyframe-surviving-${property}-b`, time: 1, value: authored + 15, interpolation: { kind: "linear" } },
    ] });
    shot.propertyTracks = [survivor];
    const standaloneSource = compileManim(ProjectDocumentSchema.parse(standalone)).python;
    const contaminated = cloneSerializable(standalone);
    contaminated.shots[0].propertyTracks.push(numericTrack({ id: `track-rejected-peer-${property}`, target: { kind: "object", objectId: object.id }, property: "scale", keyframes: [
      { id: `keyframe-rejected-peer-${property}-a`, time: 0, value: 100, interpolation: { kind: "eased", easing: "spring-soft" } },
      { id: `keyframe-rejected-peer-${property}-b`, time: 2, value: 0.01, interpolation: { kind: "linear" } },
    ] }));
    const compiled = compileManim(ProjectDocumentSchema.parse(contaminated));
    expect(compiled.python).toBe(standaloneSource);
    expect(compiled.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRACK_EASING_DOMAIN_UNSAFE", trackId: `track-rejected-peer-${property}` })]));
  });

  test("interleaves touching semantic then object and camera tracks by chronological authority", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    const object = shot.objects.find(({ type }) => type !== "group")!;
    object.transform.x = 270;
    shot.animations = [
      { id: "animation-touching-object", type: "move", targetIds: [object.id], start: 0, duration: 1, easing: "linear", properties: { deltaX: 10 } },
      { id: "animation-touching-camera", type: "camera-focus", targetIds: [object.id], start: 0, duration: 1, easing: "linear", properties: { x: 280 } },
    ];
    shot.camera.x = 270;
    shot.propertyTracks = [
      numericTrack({ id: "track-touching-object", target: { kind: "object", objectId: object.id }, property: "x", keyframes: [
        { id: "keyframe-touching-object-a", time: 1, value: 270, interpolation: { kind: "linear" } },
        { id: "keyframe-touching-object-b", time: 2, value: 290, interpolation: { kind: "linear" } },
      ] }),
      numericTrack({ id: "track-touching-camera", target: { kind: "camera" }, property: "x", keyframes: [
        { id: "keyframe-touching-camera-a", time: 1, value: 270, interpolation: { kind: "linear" } },
        { id: "keyframe-touching-camera-b", time: 2, value: 290, interpolation: { kind: "linear" } },
      ] }),
    ];
    const objectX = (time: number) => previewShotAtTime(shot, time).objects.find(({ id }) => id === object.id)!.transform.x;
    const cameraX = (time: number) => previewShotAtTime(shot, time).camera.x;
    expect(objectX(0.5)).toBe(275);
    expect(cameraX(0.5)).toBe(275);
    expect(objectX(1)).toBe(270);
    expect(cameraX(1)).toBe(270);
    expect(objectX(1.5)).toBe(280);
    expect(cameraX(1.5)).toBe(280);
    expect(objectX(2)).toBe(290);
    expect(cameraX(2)).toBe(290);
    const compiled = compileManim(ProjectDocumentSchema.parse(project));
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const semanticOnly = cloneSerializable(project);
    semanticOnly.shots[0].propertyTracks = [];
    expect(compiled.python).not.toBe(compileManim(ProjectDocumentSchema.parse(semanticOnly)).python);
    expect(compiled.python).toContain("# Animation component 1: 0.0s to 2.0s");
    expect(compiled.python.match(/run_time=0\.0, rate_func=linear/g)).toHaveLength(2);
    const reversed = cloneSerializable(project);
    reversed.shots[0].propertyTracks.reverse();
    expect(compileManim(ProjectDocumentSchema.parse(reversed)).python).toBe(compiled.python);

    const opposite = cloneSerializable(project);
    opposite.shots[0].animations = [
      { id: "animation-after-object-track", type: "move", targetIds: [object.id], start: 1, duration: 1, easing: "linear", properties: { deltaX: 10 } },
      { id: "animation-after-camera-track", type: "camera-focus", targetIds: [object.id], start: 1, duration: 1, easing: "linear", properties: { x: 300 } },
    ];
    opposite.shots[0].propertyTracks = opposite.shots[0].propertyTracks.map((track) => ({
      ...track,
      keyframes: track.keyframes.map((keyframe, index) => ({ ...keyframe, time: index })),
    }));
    const oppositeObjectX = (time: number) => previewShotAtTime(opposite.shots[0], time).objects.find(({ id }) => id === object.id)!.transform.x;
    expect(oppositeObjectX(0.5)).toBe(280);
    expect(oppositeObjectX(1)).toBe(290);
    expect(oppositeObjectX(1.5)).toBe(295);
    expect(oppositeObjectX(2)).toBe(300);
    expect(previewShotAtTime(opposite.shots[0], 2).camera.x).toBe(300);
    expect(compileManim(ProjectDocumentSchema.parse(opposite)).diagnostics.some(({ severity }) => severity === "error")).toBe(false);
  });

  test("keeps tracks inactive before their first keyframe", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const object = shot.objects.find(({ type }) => type !== "group")!;
    shot.animations = [];
    object.transform.x = 100;
    shot.propertyTracks = [numericTrack({ id: "track-delayed-authority", target: { kind: "object", objectId: object.id }, property: "x", keyframes: [
      { id: "keyframe-delayed-authority-a", time: 1, value: 270, interpolation: { kind: "linear" } },
      { id: "keyframe-delayed-authority-b", time: 2, value: 290, interpolation: { kind: "linear" } },
    ] })];
    expect(previewShotAtTime(shot, 0.999).objects.find(({ id }) => id === object.id)?.transform.x).toBe(100);
    expect(previewShotAtTime(shot, 1).objects.find(({ id }) => id === object.id)?.transform.x).toBe(270);
  });

  test("emits every delayed initial state as an exact point and preserves time-zero singletons", () => {
    const makeProject = () => {
      const project = cloneSerializable(createCantorDemoProject());
      const shot = project.shots[0];
      project.shots = [shot];
      shot.animations = [];
      shot.propertyTracks = [];
      return { project, shot };
    };
    const cases = [
      (shot: ReturnType<typeof makeProject>["shot"]) => {
        const object = shot.objects.find(({ type }) => type !== "group")!;
        return numericTrack({ id: "track-delayed-object-singleton", target: { kind: "object", objectId: object.id }, property: "x", keyframes: [{ id: "keyframe-delayed-object-singleton", time: 1, value: 200, interpolation: { kind: "linear" } }] });
      },
      (_shot: ReturnType<typeof makeProject>["shot"]) => numericTrack({ id: "track-delayed-camera", target: { kind: "camera" }, property: "x", keyframes: [
        { id: "keyframe-delayed-camera-a", time: 1, value: 200, interpolation: { kind: "linear" } },
        { id: "keyframe-delayed-camera-b", time: 2, value: 300, interpolation: { kind: "linear" } },
      ] }),
      (shot: ReturnType<typeof makeProject>["shot"]) => {
        const group = shot.objects.find(({ type }) => type === "group")!;
        return { id: "track-delayed-group-fill", target: { kind: "object" as const, objectId: group.id }, property: "fill" as const, keyframes: [{ id: "keyframe-delayed-group-fill", time: 1, value: "#123456", interpolation: { kind: "linear" as const } }] };
      },
    ];
    for (const buildTrack of cases) {
      const { project, shot } = makeProject();
      const semanticSource = compileManim(ProjectDocumentSchema.parse(project)).python;
      const track = buildTrack(shot);
      shot.propertyTracks = [track];
      const result = compileManim(ProjectDocumentSchema.parse(project));
      expect(result.python).not.toBe(semanticSource);
      expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
      expect(result.python).toContain("run_time=0.0, rate_func=linear");
    }

    const { project, shot } = makeProject();
    const object = shot.objects.find(({ type }) => type !== "group")!;
    shot.propertyTracks = [numericTrack({ id: "track-zero-singleton", target: { kind: "object", objectId: object.id }, property: "x", keyframes: [{ id: "keyframe-zero-singleton", time: 0, value: 321, interpolation: { kind: "linear" } }] })];
    const supported = compileManim(ProjectDocumentSchema.parse(project));
    expect(supported.diagnostics.some(({ code }) => code === "TRACK_DELAYED_INITIAL_STATE_UNSUPPORTED")).toBe(false);
    expect(previewShotAtTime(shot, 0).objects.find(({ id }) => id === object.id)?.transform.x).toBe(321);
    expect(supported.python).not.toBe(compileManim(ProjectDocumentSchema.parse({ ...project, shots: [{ ...shot, propertyTracks: [] }] })).python);
  });

  test("keeps pre-entrance property transforms hidden and preserves native ordinary entrances", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    const object = shot.objects.find(({ type }) => type === "text")!;
    object.name = "Pre entrance";
    shot.objects = [object];
    shot.animations = [{ id: "animation-pre-entrance", type: "fade-in", targetIds: [object.id], start: 1, duration: 1, easing: "linear", properties: {} }];
    shot.propertyTracks = [numericTrack({ id: "track-before-entrance", target: { kind: "object", objectId: object.id }, property: "x", keyframes: [
      { id: "keyframe-before-entrance-a", time: 0, value: object.transform.x, interpolation: { kind: "linear" } },
      { id: "keyframe-before-entrance-b", time: 0.5, value: object.transform.x + 20, interpolation: { kind: "linear" } },
    ] })];
    const tracked = compileManim(ProjectDocumentSchema.parse(project)).python;
    expect(tracked).toContain("pc_pre_entrance.set_opacity(0.0)");
    expect(tracked).toMatch(/Transform\(pc_pre_entrance, .*\.set_opacity\(0\.0\), run_time=0\.5/);
    expect(tracked).toMatch(/Transform\(pc_pre_entrance, .*\.set_opacity\(1\.0\), run_time=1\.0/);
    expect(tracked).not.toContain("FadeIn(pc_pre_entrance");

    const ordinary = cloneSerializable(project);
    ordinary.shots[0].propertyTracks = [];
    const ordinarySource = compileManim(ProjectDocumentSchema.parse(ordinary)).python;
    expect(ordinarySource).toContain("FadeIn(pc_pre_entrance, run_time=1.0, rate_func=linear)");
  });

  test("keeps delayed pre-entrance points hidden and reveals their exact state", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    const object = shot.objects.find(({ type }) => type === "text")!;
    object.name = "Delayed before entrance";
    shot.objects = [object];
    shot.animations = [{ id: "animation-delayed-entrance", type: "fade-in", targetIds: [object.id], start: 1, duration: 1, easing: "linear", properties: {} }];
    shot.propertyTracks = [];
    const entranceOnly = compileManim(ProjectDocumentSchema.parse(project)).python;
    shot.propertyTracks = [numericTrack({ id: "track-delayed-before-entrance", target: { kind: "object", objectId: object.id }, property: "x", keyframes: [
      { id: "keyframe-delayed-before-entrance-a", time: 0.5, value: object.transform.x + 10, interpolation: { kind: "linear" } },
      { id: "keyframe-delayed-before-entrance-b", time: 0.75, value: object.transform.x + 20, interpolation: { kind: "linear" } },
    ] })];
    const compiled = compileManim(ProjectDocumentSchema.parse(project));
    expect(compiled.python).not.toBe(entranceOnly);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(compiled.python).toContain("pc_delayed_before_entrance.set_opacity(0.0)");
    expect(compiled.python).toMatch(/Transform\(pc_delayed_before_entrance, [^\n]+\.set_opacity\(0\.0\), run_time=0\.0/);
    expect(compiled.python).toMatch(/Transform\(pc_delayed_before_entrance, [^\n]+\.set_opacity\(0\.0\), run_time=0\.25/);
    expect(compiled.python).toMatch(/Transform\(pc_delayed_before_entrance, [^\n]+\.set_opacity\(1\.0\), run_time=1\.0/);
    expect(compiled.python).not.toContain("FadeIn(pc_delayed_before_entrance");
  });

  test("merges identical track lanes and fails closed on staggered or hierarchy-overlapping lanes", () => {
    const makeProject = () => {
      const project = cloneSerializable(createCantorDemoProject());
      const shot = project.shots[0];
      project.shots = [shot];
      shot.animations = [];
      shot.propertyTracks = [];
      return { project, shot };
    };
    const merged = makeProject();
    const leaf = merged.shot.objects.find(({ type }) => type !== "group")!;
    merged.shot.propertyTracks = [
      numericTrack({ id: "track-merged-x", target: { kind: "object", objectId: leaf.id }, property: "x", keyframes: [
        { id: "keyframe-merged-x-a", time: 0, value: leaf.transform.x, interpolation: { kind: "linear" } },
        { id: "keyframe-merged-x-b", time: 2, value: leaf.transform.x + 20, interpolation: { kind: "linear" } },
      ] }),
      numericTrack({ id: "track-merged-y", target: { kind: "object", objectId: leaf.id }, property: "y", keyframes: [
        { id: "keyframe-merged-y-a", time: 0, value: leaf.transform.y, interpolation: { kind: "linear" } },
        { id: "keyframe-merged-y-b", time: 2, value: leaf.transform.y + 20, interpolation: { kind: "linear" } },
      ] }),
    ];
    const mergedCompile = compileManim(ProjectDocumentSchema.parse(merged.project));
    expect(mergedCompile.diagnostics.some(({ code }) => code === "TRACK_TRACK_COLLISION")).toBe(false);
    expect(mergedCompile.python.match(/self\.play\(Transform\(/g)).toHaveLength(1);

    const staggered = makeProject();
    const staggeredLeaf = staggered.shot.objects.find(({ type }) => type !== "group")!;
    staggered.shot.propertyTracks = [
      numericTrack({ id: "track-staggered-x", target: { kind: "object", objectId: staggeredLeaf.id }, property: "x", keyframes: [
        { id: "keyframe-staggered-x-a", time: 0, value: staggeredLeaf.transform.x, interpolation: { kind: "linear" } },
        { id: "keyframe-staggered-x-b", time: 2, value: staggeredLeaf.transform.x + 20, interpolation: { kind: "linear" } },
      ] }),
      numericTrack({ id: "track-staggered-y", target: { kind: "object", objectId: staggeredLeaf.id }, property: "y", keyframes: [
        { id: "keyframe-staggered-y-a", time: 0, value: staggeredLeaf.transform.y, interpolation: { kind: "linear" } },
        { id: "keyframe-staggered-y-mid", time: 1, value: staggeredLeaf.transform.y + 10, interpolation: { kind: "linear" } },
        { id: "keyframe-staggered-y-b", time: 3, value: staggeredLeaf.transform.y + 20, interpolation: { kind: "linear" } },
      ] }),
    ];
    const staggeredCompile = compileManim(ProjectDocumentSchema.parse(staggered.project));
    expect(staggeredCompile.diagnostics.filter(({ code }) => code === "TRACK_TRACK_COLLISION").map(({ trackId }) => trackId).sort()).toEqual(["track-staggered-x", "track-staggered-y"]);
    expect(staggeredCompile.python).not.toContain("# Animation component 1: 0.0s to 3.0s");

    const hierarchy = makeProject();
    const group = hierarchy.shot.objects.find(({ type }) => type === "group")!;
    const child = hierarchy.shot.objects.find(({ parentId }) => parentId === group.id)!;
    hierarchy.shot.animations = [{ id: "animation-parent-collision", type: "move", targetIds: [group.id], start: 0, duration: 2, easing: "linear", properties: { deltaX: 10 } }];
    hierarchy.shot.propertyTracks = [numericTrack({ id: "track-child-collision", target: { kind: "object", objectId: child.id }, property: "x", keyframes: [
      { id: "keyframe-child-collision-a", time: 0, value: child.transform.x, interpolation: { kind: "linear" } },
      { id: "keyframe-child-collision-b", time: 2, value: child.transform.x + 20, interpolation: { kind: "linear" } },
    ] })];
    const hierarchyCompile = compileManim(ProjectDocumentSchema.parse(hierarchy.project));
    expect(hierarchyCompile.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRACK_SEMANTIC_COLLISION", trackId: "track-child-collision", animationId: "animation-parent-collision" })]));
  });
});
