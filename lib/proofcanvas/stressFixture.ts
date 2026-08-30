import {
  PROJECT_SCHEMA_VERSION,
  ProjectDocumentSchema,
  cloneSerializable,
  type ProjectDocument,
  type PropertyTrack,
  type SceneAnimation,
  type SceneObject,
  type Shot,
} from "./schema";
import { DETERMINISTIC_AUDIO_FIXTURE } from "./demo";
import { DEFAULT_STYLE_PACKS, EDITORIAL_INK_STYLE_ID } from "./styles";

export const PROOFCANVAS_STRESS_INVENTORY = Object.freeze({
  shots: 10,
  objects: 150,
  animations: 250,
  keyframes: 400,
  audioSeconds: 90,
});

const STRESS_CURVE = Object.freeze({ x1: 0.18, y1: 0.66, x2: 0.3, y2: 1 });

function stressId(kind: string, shotIndex: number, index: number): string {
  return `${kind}-stress-${String(shotIndex + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`;
}
function stressObject(shotIndex: number, objectIndex: number): SceneObject {
  const id = stressId("object", shotIndex, objectIndex);
  const column = objectIndex % 5;
  const row = Math.floor(objectIndex / 5);
  const x = 170 + column * 155;
  const y = 120 + row * 165;
  if (objectIndex === 0) {
    return {
      id,
      type: "text",
      name: `Stress shot ${shotIndex + 1} title`,
      locked: false,
      visible: true,
      transform: { x, y, width: 360, height: 42, rotation: 0, scaleX: 1, scaleY: 1 },
      style: { fontSize: 28, fontWeight: 600, color: "#252722" },
      semanticRole: "title",
      properties: { content: `Deterministic stress shot ${shotIndex + 1}` },
    };
  }
  if (objectIndex === 1) {
    return {
      id,
      type: "math",
      name: `Stress equation ${shotIndex + 1}`,
      locked: false,
      visible: true,
      transform: { x, y, width: 210, height: 42, rotation: 0, scaleX: 1, scaleY: 1 },
      style: { fontSize: 24, color: "#315866" },
      semanticRole: "equation",
      properties: { content: `s_{${shotIndex + 1},${objectIndex + 1}}=${shotIndex + objectIndex + 2}` },
    };
  }
  if (objectIndex === 2) {
    return {
      id,
      type: "arrow",
      name: `Stress arrow ${shotIndex + 1}`,
      locked: false,
      visible: true,
      transform: { x, y, width: 112, height: 28, rotation: 0, scaleX: 1, scaleY: 1 },
      style: { stroke: "#71402d", strokeWidth: 2 },
      semanticRole: "inference",
      properties: { direction: "right" },
    };
  }
  const isCircle = objectIndex % 3 === 0;
  return {
    id,
    type: isCircle ? "circle" : "rectangle",
    name: `Stress ${isCircle ? "circle" : "rectangle"} ${shotIndex + 1}.${objectIndex + 1}`,
    locked: false,
    visible: true,
    transform: {
      x,
      y,
      width: isCircle ? 62 : 106,
      height: isCircle ? 62 : 54,
      rotation: objectIndex % 2 === 0 ? 0 : 2,
      scaleX: 1,
      scaleY: 1,
    },
    style: {
      fill: (shotIndex + objectIndex) % 2 === 0 ? "#315866" : "#252722",
      stroke: "#252722",
      strokeWidth: 1.5,
      opacity: 0.86,
    },
    semanticRole: "stress-cell",
    properties: { ordinal: objectIndex + 1, shot: shotIndex + 1 },
  };
}

function stressAnimation(shotIndex: number, animationIndex: number, objectIds: readonly string[]): SceneAnimation {
  if (animationIndex < 15) {
    return {
      id: stressId("animation", shotIndex, animationIndex),
      type: "fade-in",
      targetIds: [objectIds[animationIndex]],
      start: animationIndex * 0.1,
      duration: 0.08,
      easing: "editorial",
      properties: {},
    };
  }
  const targetIndex = animationIndex - 15;
  return {
    id: stressId("animation", shotIndex, animationIndex),
    type: "emphasise",
    targetIds: [objectIds[targetIndex]],
    start: 2 + targetIndex * 0.15,
    duration: 0.12,
    easing: "there-and-back",
    properties: { scale: 1.04 },
  };
}

function stressTrack(shotIndex: number, trackIndex: number, target: SceneObject): PropertyTrack {
  const times = [4, 5, 6, 7, 8] as const;
  const offsets = [-8, 5, -3, 7, 0] as const;
  return {
    id: stressId("track", shotIndex, trackIndex),
    target: { kind: "object", objectId: target.id },
    property: "x",
    keyframes: times.map((time, keyframeIndex) => ({
      id: `${stressId("keyframe", shotIndex, trackIndex)}-${keyframeIndex + 1}`,
      time,
      value: target.transform.x + offsets[keyframeIndex],
      interpolation: keyframeIndex === 0
        ? { kind: "custom-bezier", curve: STRESS_CURVE }
        : keyframeIndex === 1
          ? { kind: "eased", easing: "ease-in-out" }
          : keyframeIndex === 4
            ? { kind: "hold" }
            : { kind: "linear" },
    })),
  };
}

function stressShot(shotIndex: number): Shot {
  const objects = Array.from({ length: 15 }, (_, objectIndex) => stressObject(shotIndex, objectIndex));
  const objectIds = objects.map(({ id }) => id);
  return {
    id: `shot-stress-${String(shotIndex + 1).padStart(2, "0")}`,
    name: `Stress sequence ${shotIndex + 1}`,
    duration: 9,
    objects,
    animations: Array.from({ length: 25 }, (_, animationIndex) => stressAnimation(shotIndex, animationIndex, objectIds)),
    propertyTracks: Array.from({ length: 8 }, (_, trackIndex) => stressTrack(shotIndex, trackIndex, objects[trackIndex])),
    audioClips: [{
      id: `audio-stress-${String(shotIndex + 1).padStart(2, "0")}`,
      assetId: DETERMINISTIC_AUDIO_FIXTURE.metadata.id,
      name: `Stress timing pulse ${shotIndex + 1}`,
      start: 0,
      duration: 9,
      sourceStart: shotIndex * 9,
      sourceEnd: (shotIndex + 1) * 9,
      volume: 0.24,
      muted: false,
      solo: false,
      fadeIn: 0.1,
      fadeOut: 0.1,
    }],
    captionClips: [{
      id: `caption-stress-${String(shotIndex + 1).padStart(2, "0")}`,
      start: 0,
      end: 9,
      text: `Stress fixture shot ${shotIndex + 1} of 10.`,
      style: {},
    }],
    markers: [
      { id: `${stressId("marker", shotIndex, 0)}`, time: 0, name: "Entrance", color: "#315866" },
      { id: `${stressId("marker", shotIndex, 1)}`, time: 4, name: "Keyframes", color: "#71402d" },
      { id: `${stressId("marker", shotIndex, 2)}`, time: 8, name: "Hold", color: "#252722" },
    ],
    camera: { x: 480, y: 270, zoom: 1, rotation: 0 },
  };
}

/**
 * Exact, deterministic V1 capacity fixture: 10 shots, 150 objects, 250
 * semantic animation clips, 400 property keyframes and 90 seconds of
 * contiguous audio authority.
 */
export function createProofCanvasStressProject(): ProjectDocument {
  return ProjectDocumentSchema.parse({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadata: {
      id: "project-proofcanvas-v1-stress",
      title: "ProofCanvas V1 deterministic stress fixture",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    },
    settings: {
      aspectRatio: "16:9",
      frameRate: 30,
      resolution: { width: 1280, height: 720 },
      renderPreset: "720p",
      previewQuality: "draft",
    },
    activeStyleId: EDITORIAL_INK_STYLE_ID,
    styles: DEFAULT_STYLE_PACKS.map((style) => cloneSerializable(style)),
    customEasings: [{
      id: "easing-stress-settle",
      name: "Stress settle",
      curve: cloneSerializable(STRESS_CURVE),
    }],
    assets: [cloneSerializable(DETERMINISTIC_AUDIO_FIXTURE.metadata)],
    shots: Array.from({ length: PROOFCANVAS_STRESS_INVENTORY.shots }, (_, shotIndex) => stressShot(shotIndex)),
  });
}
