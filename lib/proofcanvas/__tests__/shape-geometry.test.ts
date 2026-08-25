import {
  LEGACY_ARROW_TIP_SHAPE,
  LEGACY_ARROW_TIP_SIZE_RATIO,
  LEGACY_BRACE_DIRECTION,
  LEGACY_BRACE_SPACING,
  LEGACY_LINE_CAP,
  isCurrentShapeType,
  isLinearShapeType,
  lineEndpointsForTransform,
  resolveArrowPreviewGeometry,
  resolveShapeGeometry,
  resolveShapeDimensions,
  resolveShapePaint,
  transformFromLineEndpoints,
  type LineEndpoints,
} from "../shapeGeometry";
import { EDITORIAL_INK_STYLE } from "../styles";
import type { JsonValue, SceneObject, StylePack } from "../schema";

function shapeObject(
  type: "circle" | "rectangle" | "line" | "arrow" | "brace",
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
    for (const type of ["circle", "rectangle", "line", "arrow", "brace"] as const) {
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
    expect(isCurrentShapeType("graph")).toBe(false);
    expect(isLinearShapeType("line")).toBe(true);
    expect(isLinearShapeType("arrow")).toBe(true);
    expect(isLinearShapeType("brace")).toBe(false);
    expect(isLinearShapeType("rectangle")).toBe(false);
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
