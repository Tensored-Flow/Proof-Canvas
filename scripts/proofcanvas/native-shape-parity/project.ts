import {
  ProjectDocumentSchema,
  cloneSerializable,
  type ProjectDocument,
  type SceneObject,
} from "../../../lib/proofcanvas/schema";
import { resolutionFor } from "../../../lib/proofcanvas/frame";

export const NATIVE_SHAPE_PARITY_PROJECT_ID = "project-4e4154495645534841504553";
export const NATIVE_SHAPE_PARITY_SHOT_ID = "shot-native-shape-parity";

export const NATIVE_SHAPE_PARITY_COLORS = Object.freeze({
  ellipse: "#ff0000",
  polygon: "#00ff00",
  "dashed-line": "#0000ff",
  "double-arrow": "#ff00ff",
  "freeform-path": "#00ffff",
} as const);

type NativeShapeParityType = keyof typeof NATIVE_SHAPE_PARITY_COLORS;

function shapeObject(
  type: NativeShapeParityType,
  transform: SceneObject["transform"],
  shape: SceneObject["properties"]["shape"],
  options: Readonly<{ fill?: boolean; strokeWidth: number }>,
): SceneObject {
  const color = NATIVE_SHAPE_PARITY_COLORS[type];
  return {
    id: `object-parity-${type}`,
    type,
    name: `${type} parity probe`,
    locked: false,
    visible: true,
    transform,
    style: {
      ...(options.fill ? { fill: color } : {}),
      stroke: color,
      strokeWidth: options.strokeWidth,
      opacity: 1,
    },
    semanticRole: `native-shape-parity-${type}`,
    properties: { shape },
  };
}

/**
 * Build one deliberately asymmetric, non-overlapping schema-v4 scene. Pure
 * chroma assignments make each primitive independently measurable after SVG
 * and Cairo rasterization without relying on object-presence assertions.
 */
export function createNativeShapeParityProject(base: ProjectDocument): ProjectDocument {
  const project = cloneSerializable(base);
  const style = project.styles.find(({ id }) => id === project.activeStyleId) ?? project.styles[0];
  style.colors = {
    ...style.colors,
    background: "#ffffff",
    ink: "#101010",
  };
  project.settings = {
    ...project.settings,
    aspectRatio: "16:9",
    frameRate: 15,
    renderPreset: "draft",
    resolution: resolutionFor("16:9", "draft"),
    previewQuality: "standard",
  };
  project.shots = [{
    id: NATIVE_SHAPE_PARITY_SHOT_ID,
    name: "Native shape parity",
    // Keep the static parity frame visible long enough for the same production
    // browser journey to prove that playback refuses authoring mutations.
    duration: 8,
    camera: { x: 480, y: 270, zoom: 1, rotation: 0 },
    animations: [],
    propertyTracks: [],
    audioClips: [],
    captionClips: [],
    markers: [],
    objects: [
      shapeObject(
        "ellipse",
        { x: 120, y: 140, width: 150, height: 90, rotation: 17, scaleX: 1, scaleY: 1 },
        { kind: "ellipse" },
        { fill: true, strokeWidth: 4 },
      ),
      shapeObject(
        "polygon",
        { x: 330, y: 140, width: 154, height: 118, rotation: -12, scaleX: 1, scaleY: 1 },
        {
          kind: "polygon",
          lineJoin: "bevel",
          vertices: [
            { x: -0.48, y: 0.3 },
            { x: -0.18, y: -0.48 },
            { x: 0.46, y: -0.24 },
            { x: 0.34, y: 0.42 },
            { x: -0.12, y: 0.48 },
          ],
        },
        { fill: true, strokeWidth: 5 },
      ),
      shapeObject(
        "dashed-line",
        { x: 550, y: 140, width: 174, height: 16, rotation: 7, scaleX: 1, scaleY: 1 },
        { kind: "dashed-line", lineCap: "round", dashLength: 18, gapLength: 11 },
        { strokeWidth: 8 },
      ),
      shapeObject(
        "double-arrow",
        { x: 790, y: 140, width: 174, height: 30, rotation: -8, scaleX: 1, scaleY: 1 },
        {
          kind: "double-arrow",
          lineCap: "square",
          startTipShape: "stealth",
          endTipShape: "circle",
          tipSizeRatio: 0.22,
        },
        { strokeWidth: 5 },
      ),
      shapeObject(
        "freeform-path",
        { x: 480, y: 382, width: 310, height: 138, rotation: 4, scaleX: 1, scaleY: 1 },
        {
          kind: "freeform-path",
          closed: false,
          lineCap: "round",
          lineJoin: "round",
          nodes: [
            {
              point: { x: -0.5, y: 0.24 },
              outHandle: { x: -0.4, y: -0.42 },
            },
            {
              point: { x: -0.08, y: -0.3 },
              inHandle: { x: -0.28, y: -0.34 },
              outHandle: { x: 0.1, y: -0.26 },
            },
            {
              point: { x: 0.5, y: 0.2 },
              inHandle: { x: 0.34, y: -0.46 },
            },
          ],
        },
        { strokeWidth: 7 },
      ),
    ],
  }];
  return ProjectDocumentSchema.parse(project);
}
