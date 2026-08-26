import {
  COMPILER_DASHED_RATIO_MAX_DRIFT,
  COMPILER_DASH_LENGTH_MAX_RELATIVE_DRIFT,
  COMPILER_DASH_TOPOLOGY_MARGIN,
  compilerDecimalNumber,
  LEGACY_ARROW_TIP_SHAPE,
  LEGACY_ARROW_TIP_SIZE_RATIO,
  LEGACY_BRACE_DIRECTION,
  LEGACY_BRACE_SPACING,
  LEGACY_LINE_CAP,
  isCurrentShapeType,
  isLinearShapeType,
  freeformCubicSegments,
  lineEndpointsForTransform,
  resolveArrowPreviewGeometry,
  resolveCompilerSafeDashedLinePattern,
  resolveShapeGeometry,
  resolveShapeDimensions,
  resolveShapePaint,
  transformFromLineEndpoints,
  type LineEndpoints,
} from "../shapeGeometry";
import { editorLengthToManim } from "../frame";
import { resolveDashedLinePattern } from "../schema";
import { EDITORIAL_INK_STYLE } from "../styles";
import type { JsonValue, SceneObject, StylePack } from "../schema";

function shapeObject(
  type: "circle" | "rectangle" | "line" | "arrow" | "brace"
    | "ellipse" | "polygon" | "dashed-line" | "double-arrow" | "freeform-path",
  options: Readonly<{
    properties?: Record<string, JsonValue>;
    style?: SceneObject["style"];
    transform?: Partial<SceneObject["transform"]>;
  }> = {},
): SceneObject {
  return {
    id: `object-shape-${type}`,
    type,
    name: type,
    locked: false,
    visible: true,
    transform: {
      x: 480,
      y: 270,
      width: 160,
      height: 80,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      ...options.transform,
    },
    style: options.style ?? {},
    properties: options.properties ?? {},
  };
}

function expectSamePoint(actual: Readonly<{ x: number; y: number }>, expected: Readonly<{ x: number; y: number }>) {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
}

describe("current shape geometry authority", () => {
  test("matches pinned Manim 0.21 arrow tips and shaft attachment points without an editor-only floor", () => {
    const maximum = 23.625;
    expect(resolveArrowPreviewGeometry(1, "triangle", 0.02, maximum)).toEqual({
      kind: "triangle",
      tipLength: 0.02,
      tipX: 0.5,
      shaftEndX: 0.48,
      points: [
        { x: 0.5, y: 0 },
        { x: 0.48, y: -0.01 },
        { x: 0.48, y: 0.01 },
      ],
    });

    const triangle = resolveArrowPreviewGeometry(180, "triangle", 0.25, maximum);
    expect(triangle.tipLength).toBe(maximum);
    expect(triangle.shaftEndX).toBe(90 - maximum);
    expect(triangle.kind === "triangle" ? triangle.points[1].y : 0).toBe(-maximum / 2);

    const stealth = resolveArrowPreviewGeometry(180, "stealth", 0.25, maximum);
    expect(stealth.shaftEndX).toBe(90 - maximum * 0.625);
    expect(stealth.kind === "stealth" ? stealth.points[2] : null).toEqual({ x: 90 - maximum * 0.625, y: 0 });

    const circle = resolveArrowPreviewGeometry(180, "circle", 0.25, maximum);
    expect(circle).toMatchObject({
      kind: "circle",
      centerX: 90 - maximum / 2,
      radius: maximum / 2,
      shaftEndX: 90 - maximum,
    });

    const square = resolveArrowPreviewGeometry(180, "square", 0.25, maximum);
    expect(square.shaftEndX).toBeCloseTo(90 - Math.SQRT2 * maximum, 12);
    if (square.kind !== "square") throw new Error("Expected square geometry");
    expect(square.points[1].x).toBeCloseTo(90 - maximum / Math.SQRT2, 12);
    expect(square.points[1].y).toBeCloseTo(-maximum / Math.SQRT2, 12);
    expect(square.points[2].x).toBeCloseTo(90 - Math.SQRT2 * maximum, 12);
  });

  test("resolves deterministic legacy defaults without mutating generic properties", () => {
    const rectangle = shapeObject("rectangle");
    const circle = shapeObject("circle");
    const line = shapeObject("line");
    const arrow = shapeObject("arrow");
    const brace = shapeObject("brace", { properties: { label: "n pieces", orientation: "below" } });
    const before = JSON.stringify([rectangle, circle, line, arrow, brace]);

    expect(resolveShapeGeometry(rectangle, EDITORIAL_INK_STYLE)).toEqual({
      kind: "rectangle",
      cornerRadius: EDITORIAL_INK_STYLE.corners.object,
    });
    expect(resolveShapeGeometry(circle, EDITORIAL_INK_STYLE)).toEqual({ kind: "circle" });
    expect(resolveShapeGeometry(line, EDITORIAL_INK_STYLE)).toEqual({ kind: "line", lineCap: LEGACY_LINE_CAP });
    expect(resolveShapeGeometry(arrow, EDITORIAL_INK_STYLE)).toEqual({
      kind: "arrow",
      lineCap: LEGACY_LINE_CAP,
      tipShape: LEGACY_ARROW_TIP_SHAPE,
      tipSizeRatio: LEGACY_ARROW_TIP_SIZE_RATIO,
    });
    expect(resolveShapeGeometry(brace, EDITORIAL_INK_STYLE)).toEqual({
      kind: "brace",
      direction: LEGACY_BRACE_DIRECTION,
      spacing: LEGACY_BRACE_SPACING,
    });
    expect(JSON.stringify([rectangle, circle, line, arrow, brace])).toBe(before);
  });

  test("resolves all schema-v4 native geometry as defensive copies", () => {
    const polygon = shapeObject("polygon", { properties: { shape: {
      kind: "polygon",
      vertices: [{ x: -0.5, y: 0.5 }, { x: 0, y: -0.5 }, { x: 0.5, y: 0.5 }],
      lineJoin: "bevel",
    } } });
    const dashed = shapeObject("dashed-line", { properties: { shape: {
      kind: "dashed-line", lineCap: "round", dashLength: 5, gapLength: 95,
    } } });
    const doubleArrow = shapeObject("double-arrow", { properties: { shape: {
      kind: "double-arrow", lineCap: "square", startTipShape: "circle", endTipShape: "stealth", tipSizeRatio: 0.45,
    } } });
    const freeform = shapeObject("freeform-path", { properties: { shape: {
      kind: "freeform-path", closed: false, lineCap: "round", lineJoin: "bevel", nodes: [
        { point: { x: -0.5, y: 0 }, outHandle: { x: -0.25, y: -0.5 } },
        { point: { x: 0.5, y: 0 }, inHandle: { x: 0.25, y: 0.5 } },
      ],
    } } });
    const before = JSON.stringify([polygon, dashed, doubleArrow, freeform]);

    expect(resolveShapeGeometry(shapeObject("ellipse", { properties: { shape: { kind: "ellipse" } } }), EDITORIAL_INK_STYLE)).toEqual({ kind: "ellipse" });
    const resolvedPolygon = resolveShapeGeometry(polygon, EDITORIAL_INK_STYLE);
    expect(resolvedPolygon).toEqual({ kind: "polygon", vertices: [
      { x: -0.5, y: 0.5 }, { x: 0, y: -0.5 }, { x: 0.5, y: 0.5 },
    ], lineJoin: "bevel" });
    expect(resolveShapeGeometry(dashed, EDITORIAL_INK_STYLE)).toEqual({
      kind: "dashed-line", lineCap: "round", dashLength: 5, gapLength: 95,
    });
    expect(resolveShapeGeometry(doubleArrow, EDITORIAL_INK_STYLE)).toEqual({
      kind: "double-arrow", lineCap: "square", startTipShape: "circle", endTipShape: "stealth", tipSizeRatio: 0.45,
    });
    const resolvedFreeform = resolveShapeGeometry(freeform, EDITORIAL_INK_STYLE);
    expect(resolvedFreeform).toEqual({
      kind: "freeform-path", closed: false, lineCap: "round", lineJoin: "bevel", nodes: [
        { point: { x: -0.5, y: 0 }, outHandle: { x: -0.25, y: -0.5 } },
        { point: { x: 0.5, y: 0 }, inHandle: { x: 0.25, y: 0.5 } },
      ],
    });
    if (resolvedPolygon?.kind !== "polygon" || resolvedFreeform?.kind !== "freeform-path") throw new Error("Expected V4 geometry");
    expect(resolvedPolygon.vertices).not.toBe((polygon.properties.shape as { vertices: unknown[] }).vertices);
    expect(resolvedFreeform.nodes).not.toBe((freeform.properties.shape as { nodes: unknown[] }).nodes);
    expect(JSON.stringify([polygon, dashed, doubleArrow, freeform])).toBe(before);
  });

  test("derives exact freeform cubic controls, including the implicit closing segment", () => {
    const open = {
      kind: "freeform-path" as const,
      closed: false as const,
      lineCap: "round" as const,
      lineJoin: "bevel" as const,
      nodes: [
        { point: { x: -0.5, y: 0 }, outHandle: { x: -0.4, y: -0.5 } },
        { point: { x: 0.5, y: 0 }, inHandle: { x: 0.4, y: 0.5 } },
      ],
    };
    expect(freeformCubicSegments(open)).toEqual([{
      start: { x: -0.5, y: 0 }, control1: { x: -0.4, y: -0.5 }, control2: { x: 0.4, y: 0.5 }, end: { x: 0.5, y: 0 },
    }]);
    const closed = {
      kind: "freeform-path" as const,
      closed: true as const,
      lineJoin: "miter" as const,
      nodes: [
        { point: { x: -0.5, y: 0 } },
        { point: { x: 0.5, y: 0 } },
        { point: { x: 0, y: 0.5 } },
      ],
    };
    const segments = freeformCubicSegments(closed);
    expect(segments).toHaveLength(3);
    expect(segments.at(-1)).toMatchObject({ start: { x: 0, y: 0.5 }, end: { x: -0.5, y: 0 } });
    expect(segments.at(-1)?.control1.x).toBeCloseTo(-1 / 6, 14);
    expect(segments.at(-1)?.control1.y).toBeCloseTo(1 / 3, 14);
    expect(segments.at(-1)?.control2.x).toBeCloseTo(-1 / 3, 14);
    expect(segments.at(-1)?.control2.y).toBeCloseTo(1 / 6, 14);
  });

  test("accepts only a matching strict shape record and leaves unknown direct fields inert", () => {
    expect(resolveShapeGeometry(shapeObject("line", {
      properties: {
        lineCap: "square",
        shape: { kind: "line", lineCap: "round" },
      },
    }), EDITORIAL_INK_STYLE)).toEqual({ kind: "line", lineCap: "round" });

    expect(resolveShapeGeometry(shapeObject("arrow", {
      properties: { tipShape: "stealth", tipSizeRatio: 0.2, lineCap: "square" },
    }), EDITORIAL_INK_STYLE)).toEqual({
      kind: "arrow",
      lineCap: LEGACY_LINE_CAP,
      tipShape: LEGACY_ARROW_TIP_SHAPE,
      tipSizeRatio: LEGACY_ARROW_TIP_SIZE_RATIO,
    });

    expect(resolveShapeGeometry(shapeObject("brace", {
      properties: { shape: { kind: "brace", direction: "left", spacing: 24 } },
    }), EDITORIAL_INK_STYLE)).toEqual({ kind: "brace", direction: "left", spacing: 24 });

    expect(resolveShapeGeometry(shapeObject("brace", {
      properties: { direction: "right", spacing: 40, orientation: "above" },
    }), EDITORIAL_INK_STYLE)).toEqual({
      kind: "brace",
      direction: "above",
      spacing: LEGACY_BRACE_SPACING,
    });
  });

  test("fails malformed, mismatched, non-finite, and out-of-range generic values to safe defaults", () => {
    const malformedArrow = shapeObject("arrow", {
      properties: {
        shape: {
          kind: "arrow",
          lineCap: "projecting",
          tipShape: "needle",
          tipSizeRatio: Number.NaN,
        } as unknown as JsonValue,
      },
    });
    expect(resolveShapeGeometry(malformedArrow, EDITORIAL_INK_STYLE)).toEqual({
      kind: "arrow",
      lineCap: LEGACY_LINE_CAP,
      tipShape: LEGACY_ARROW_TIP_SHAPE,
      tipSizeRatio: LEGACY_ARROW_TIP_SIZE_RATIO,
    });

    const mismatchedLine = shapeObject("line", {
      properties: { shape: { kind: "arrow", lineCap: "round" } },
    });
    expect(resolveShapeGeometry(mismatchedLine, EDITORIAL_INK_STYLE)).toEqual({ kind: "line", lineCap: LEGACY_LINE_CAP });

    const malformedBrace = shapeObject("brace", {
      properties: { direction: "diagonal", spacing: -1, orientation: "sideways" },
    });
    expect(resolveShapeGeometry(malformedBrace, EDITORIAL_INK_STYLE)).toEqual({
      kind: "brace",
      direction: LEGACY_BRACE_DIRECTION,
      spacing: LEGACY_BRACE_SPACING,
    });
  });

  test("clamps explicit and inherited rectangle radii to the authored box", () => {
    const explicit = shapeObject("rectangle", {
      transform: { width: 40, height: 10 },
      properties: { shape: { kind: "rectangle", cornerRadius: 100 } },
    });
    expect(resolveShapeGeometry(explicit, EDITORIAL_INK_STYLE)).toEqual({ kind: "rectangle", cornerRadius: 5 });

    const style = {
      ...EDITORIAL_INK_STYLE,
      corners: { ...EDITORIAL_INK_STYLE.corners, object: 80 },
    } satisfies StylePack;
    const inherited = shapeObject("rectangle", { transform: { width: 18, height: 12 } });
    expect(resolveShapeGeometry(inherited, style)).toEqual({ kind: "rectangle", cornerRadius: 6 });

    const invalid = shapeObject("rectangle", {
      transform: { width: 18, height: 12 },
      properties: { shape: { kind: "rectangle", cornerRadius: -2 } },
    });
    expect(resolveShapeGeometry(invalid, EDITORIAL_INK_STYLE)).toEqual({
      kind: "rectangle",
      cornerRadius: EDITORIAL_INK_STYLE.corners.object,
    });
  });

  test("resolves one bounded paint decision including per-object arrow-tip colour", () => {
    expect(resolveShapePaint(shapeObject("rectangle"), EDITORIAL_INK_STYLE)).toEqual({
      fill: EDITORIAL_INK_STYLE.colors.ink,
      stroke: EDITORIAL_INK_STYLE.colors.ink,
      strokeWidth: EDITORIAL_INK_STYLE.strokes.regular,
      opacity: 1,
      labelColor: EDITORIAL_INK_STYLE.colors.warmAccent,
    });
    expect(resolveShapePaint(shapeObject("circle"), EDITORIAL_INK_STYLE)?.fill).toBe(EDITORIAL_INK_STYLE.colors.background);
    expect(resolveShapePaint(shapeObject("line"), EDITORIAL_INK_STYLE)?.fill).toBeNull();
    expect(resolveShapePaint(shapeObject("ellipse"), EDITORIAL_INK_STYLE)?.fill).toBe(EDITORIAL_INK_STYLE.colors.background);
    expect(resolveShapePaint(shapeObject("polygon"), EDITORIAL_INK_STYLE)?.fill).toBe(EDITORIAL_INK_STYLE.colors.background);
    expect(resolveShapePaint(shapeObject("dashed-line"), EDITORIAL_INK_STYLE)?.fill).toBeNull();
    expect(resolveShapePaint(shapeObject("double-arrow"), EDITORIAL_INK_STYLE)?.fill).toBeNull();
    expect(resolveShapePaint(shapeObject("freeform-path"), EDITORIAL_INK_STYLE)?.fill).toBeNull();
    const freeformNodes = [
      { point: { x: -0.5, y: 0.25 } },
      { point: { x: 0, y: -0.5 } },
      { point: { x: 0.5, y: 0.25 } },
    ];
    const openFreeform = shapeObject("freeform-path", {
      properties: { shape: { kind: "freeform-path", closed: false, lineCap: "round", lineJoin: "round", nodes: freeformNodes } },
      style: { fill: "#123456" },
    });
    const closedFreeform = shapeObject("freeform-path", {
      properties: { shape: { kind: "freeform-path", closed: true, lineJoin: "round", nodes: freeformNodes } },
      style: { fill: "#123456" },
    });
    expect(resolveShapePaint(openFreeform, EDITORIAL_INK_STYLE)?.fill).toBeNull();
    expect(resolveShapePaint(closedFreeform, EDITORIAL_INK_STYLE)?.fill).toBe("#123456");
    expect(resolveShapePaint({ ...closedFreeform, style: {} }, EDITORIAL_INK_STYLE)?.fill).toBe(EDITORIAL_INK_STYLE.colors.background);

    const arrow = shapeObject("arrow", {
      style: { stroke: "#123456", strokeWidth: 7, opacity: 0.4 },
    });
    expect(resolveShapePaint(arrow, EDITORIAL_INK_STYLE)).toEqual({
      fill: null,
      stroke: "#123456",
      strokeWidth: 7,
      opacity: 0.4,
      labelColor: EDITORIAL_INK_STYLE.colors.warmAccent,
    });

    const malformed = shapeObject("rectangle", {
      style: {
        fill: "not-a-colour",
        stroke: "#xyzxyz",
        color: "#abcdef",
        strokeWidth: Number.POSITIVE_INFINITY,
        opacity: -1,
      } as unknown as SceneObject["style"],
    });
    expect(resolveShapePaint(malformed, EDITORIAL_INK_STYLE)).toEqual({
      fill: EDITORIAL_INK_STYLE.colors.ink,
      stroke: EDITORIAL_INK_STYLE.colors.ink,
      strokeWidth: EDITORIAL_INK_STYLE.strokes.regular,
      opacity: 1,
      labelColor: EDITORIAL_INK_STYLE.colors.warmAccent,
    });
  });

  test("shares one 60 by 30 fallback box for schema-valid dimensionless legacy shapes", () => {
    for (const type of ["circle", "rectangle", "line", "arrow", "brace", "ellipse", "polygon", "dashed-line", "double-arrow", "freeform-path"] as const) {
      const object = shapeObject(type, { transform: { width: undefined, height: undefined } });
      expect(resolveShapeDimensions(object)).toEqual({ width: 60, height: 30 });
    }
    const rectangle = shapeObject("rectangle", { transform: { width: undefined, height: undefined } });
    expect(resolveShapeGeometry(rectangle, EDITORIAL_INK_STYLE)).toEqual({
      kind: "rectangle",
      cornerRadius: EDITORIAL_INK_STYLE.corners.object,
    });
    const endpoints = lineEndpointsForTransform(shapeObject("line", {
      transform: { x: 10, y: 20, width: undefined, height: undefined },
    }).transform);
    expect(endpoints).toEqual({ start: { x: -20, y: 20 }, end: { x: 40, y: 20 } });
  });

  test("identifies only current linear primitives", () => {
    expect(isCurrentShapeType("circle")).toBe(true);
    expect(isCurrentShapeType("brace")).toBe(true);
    expect(isCurrentShapeType("ellipse")).toBe(true);
    expect(isCurrentShapeType("freeform-path")).toBe(true);
    expect(isCurrentShapeType("graph")).toBe(false);
    expect(isLinearShapeType("line")).toBe(true);
    expect(isLinearShapeType("arrow")).toBe(true);
    expect(isLinearShapeType("dashed-line")).toBe(true);
    expect(isLinearShapeType("double-arrow")).toBe(true);
    expect(isLinearShapeType("brace")).toBe(false);
    expect(isLinearShapeType("rectangle")).toBe(false);
  });
});

describe("compiler-safe dashed-line literals", () => {
  function expectPreservedDashTopology(
    aspectRatio: "16:9" | "9:16" | "1:1",
    width: number,
    dashLength: number,
    gapLength: number,
  ) {
    const authored = resolveDashedLinePattern(width, dashLength, gapLength)!;
    const emitted = resolveCompilerSafeDashedLinePattern(aspectRatio, width, dashLength, gapLength);
    expect(emitted).not.toBeNull();
    expect(emitted?.count).toBe(authored.count);
    expect(Math.max(2, Math.ceil(emitted!.topologyQuotient))).toBe(authored.count);
    expect(emitted!.topologyQuotient).toBeLessThanOrEqual(authored.count - COMPILER_DASH_TOPOLOGY_MARGIN);
    if (authored.count > 2) {
      expect(emitted!.topologyQuotient).toBeGreaterThanOrEqual(
        authored.count - 1 + COMPILER_DASH_TOPOLOGY_MARGIN,
      );
    }
    const ratioDrift = Math.abs(emitted!.dashedRatio - authored.dashedRatio);
    expect(ratioDrift).toBeLessThanOrEqual(COMPILER_DASHED_RATIO_MAX_DRIFT);
    const preferredDashLength = compilerDecimalNumber(editorLengthToManim(aspectRatio, dashLength));
    expect(Math.abs(emitted!.dashLength - preferredDashLength) / preferredDashLength)
      .toBeLessThanOrEqual(COMPILER_DASH_LENGTH_MAX_RELATIVE_DRIFT);
    expect(Math.abs(
      emitted!.dashedRatio / authored.count - authored.dashedRatio / authored.count,
    )).toBeLessThanOrEqual(COMPILER_DASHED_RATIO_MAX_DRIFT);
    expect(Math.abs(
      (1 - emitted!.dashedRatio) / (authored.count - 1)
        - (1 - authored.dashedRatio) / (authored.count - 1),
    )).toBeLessThanOrEqual(COMPILER_DASHED_RATIO_MAX_DRIFT);
    expect(resolveCompilerSafeDashedLinePattern(aspectRatio, width, dashLength, gapLength)).toEqual(emitted);
  }

  test("moves the real parity fixture safely inside Manim's six-dash ceil bin", () => {
    const emitted = resolveCompilerSafeDashedLinePattern("16:9", 174, 18, 11);
    expect(emitted).toEqual({
      count: 6,
      halfWidth: 1.28888887,
      dashLength: 0.26666671,
      dashedRatio: 0.62068966,
      topologyQuotient: 5.999998983735798,
    });
    expectPreservedDashTopology("16:9", 174, 18, 11);
  });

  test("preserves opposite dash counts when endpoint rounding collapses a ceil boundary", () => {
    const atBoundary = resolveCompilerSafeDashedLinePattern("1:1", 40, 1, 19);
    const aboveBoundary = resolveCompilerSafeDashedLinePattern("1:1", 40.000_000_002, 1, 19);
    expect(atBoundary).toEqual({
      count: 2,
      halfWidth: 0.22222222,
      dashLength: 0.01111112,
      dashedRatio: 0.05,
      topologyQuotient: 1.999998380001296,
    });
    expect(aboveBoundary).toEqual({
      count: 3,
      halfWidth: 0.22222222,
      dashLength: 0.01111111,
      dashedRatio: 0.05000003,
      topologyQuotient: 2.0000013800001257,
    });
    expectPreservedDashTopology("1:1", 40, 1, 19);
    expectPreservedDashTopology("1:1", 40.000_000_002, 1, 19);
  });

  test("preserves every admitted count at both sides of each ceil boundary in every frame", () => {
    for (const aspectRatio of ["16:9", "9:16", "1:1"] as const) {
      expectPreservedDashTopology(aspectRatio, 1, 1, 19);
      for (let count = 3; count <= 256; count += 1) {
        for (const quotient of [count - 1 + 0.000_000_1, count - 0.000_000_1]) {
          expectPreservedDashTopology(aspectRatio, quotient * 16, 8, 8);
        }
      }
    }
  });

  test("stays deterministic across admitted ratio, dimension, and decimal-rounding extremes", () => {
    const widths = [1, 2, 39.99999998, 40.00000002, 174, 511.9999999, 2048, 4096];
    const lengths = [1, 1.00000001, 2, 7.99999999, 8, 18, 19, 4096];
    for (const aspectRatio of ["16:9", "9:16", "1:1"] as const) {
      for (const width of widths) {
        for (const dashLength of lengths) {
          for (const gapLength of lengths) {
            const authored = resolveDashedLinePattern(width, dashLength, gapLength)!;
            if (
              authored.count > 256
              || authored.dashedRatio < 0.05
              || authored.dashedRatio > 0.95
            ) continue;
            expectPreservedDashTopology(aspectRatio, width, dashLength, gapLength);
          }
        }
      }
    }
  });
});

describe("line endpoint transform authority", () => {
  test.each([
    { rotation: 0, scaleX: 1, scaleY: 1 },
    { rotation: 45, scaleX: 2, scaleY: -3 },
    { rotation: -90, scaleX: -2, scaleY: 0.5 },
    { rotation: 270, scaleX: -0.25, scaleY: -4 },
    { rotation: 725, scaleX: 0.5, scaleY: 2 },
  ])("round-trips visible endpoints at rotation $rotation and signed scale $scaleX", ({ rotation, scaleX, scaleY }) => {
    const transform: SceneObject["transform"] = {
      x: 123.25,
      y: -87.5,
      width: 240,
      height: 18,
      rotation,
      scaleX,
      scaleY,
    };
    const endpoints = lineEndpointsForTransform(transform);
    expect(endpoints).not.toBeNull();
    const rebuilt = transformFromLineEndpoints(transform, endpoints!);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.scaleX).toBe(scaleX);
    expect(rebuilt?.scaleY).toBe(scaleY);
    expect(rebuilt?.height).toBe(18);
    expect(rebuilt?.x).toBe(transform.x);
    expect(rebuilt?.y).toBe(transform.y);
    expect(rebuilt?.width).toBe(transform.width);
    expect(rebuilt?.rotation).toBe(transform.rotation);
    const roundTrip = lineEndpointsForTransform(rebuilt!);
    expect(roundTrip).not.toBeNull();
    expectSamePoint(roundTrip!.start, endpoints!.start);
    expectSamePoint(roundTrip!.end, endpoints!.end);
  });

  test("reconstructs exact horizontal and vertical endpoints while preserving negative X scale", () => {
    const template: SceneObject["transform"] = {
      x: 0,
      y: 0,
      width: 20,
      height: 3,
      rotation: 33,
      scaleX: -2,
      scaleY: 1.5,
    };
    const vertical: LineEndpoints = { start: { x: 10, y: 20 }, end: { x: 10, y: 100 } };
    const result = transformFromLineEndpoints(template, vertical);
    expect(result).toMatchObject({ x: 10, y: 60, width: 40, rotation: -90, scaleX: -2, scaleY: 1.5 });
    const endpoints = lineEndpointsForTransform(result!);
    expectSamePoint(endpoints!.start, vertical.start);
    expectSamePoint(endpoints!.end, vertical.end);
  });

  test("refuses degenerate, non-finite, and schema-out-of-range reconstructions", () => {
    const template: SceneObject["transform"] = {
      x: 0,
      y: 0,
      width: 20,
      height: 2,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    };
    expect(transformFromLineEndpoints(template, { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } })).toBeNull();
    expect(transformFromLineEndpoints(template, { start: { x: 0, y: 0 }, end: { x: Number.NaN, y: 1 } })).toBeNull();
    expect(transformFromLineEndpoints(template, { start: { x: 0, y: 0 }, end: { x: 5_000, y: 0 } })).toBeNull();
    expect(transformFromLineEndpoints({ ...template, scaleX: 0 }, { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } })).toBeNull();
    expect(transformFromLineEndpoints({ ...template, scaleY: Number.NaN }, { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } })).toBeNull();
    expect(transformFromLineEndpoints({ ...template, rotation: 4_000 }, { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } })).toBeNull();
    expect(lineEndpointsForTransform({ ...template, width: undefined })).toEqual({
      start: { x: -30, y: 0 },
      end: { x: 30, y: 0 },
    });
  });
});
