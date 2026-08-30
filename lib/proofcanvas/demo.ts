import {
  PROJECT_SCHEMA_VERSION,
  ProjectDocumentSchema,
  cloneSerializable,
  type AssetMetadata,
  type ProjectDocument,
  type PropertyTrack,
  type SceneAnimation,
  type SceneObject,
  type Shot,
} from "./schema";
import { DEFAULT_STYLE_PACKS, EDITORIAL_INK_STYLE_ID } from "./styles";

function object(
  id: string,
  type: SceneObject["type"],
  name: string,
  transform: Pick<SceneObject["transform"], "x" | "y"> & Partial<Omit<SceneObject["transform"], "x" | "y">>,
  properties: SceneObject["properties"],
  options: Partial<Pick<SceneObject, "parentId" | "locked" | "visible" | "style" | "semanticRole">> = {},
): SceneObject {
  return {
    id,
    type,
    name,
    locked: options.locked ?? false,
    visible: options.visible ?? true,
    transform: { x: transform.x, y: transform.y, ...(transform.width === undefined ? {} : { width: transform.width }), ...(transform.height === undefined ? {} : { height: transform.height }), rotation: transform.rotation ?? 0, scaleX: transform.scaleX ?? 1, scaleY: transform.scaleY ?? 1 },
    style: options.style ?? {},
    properties,
    ...(options.parentId ? { parentId: options.parentId } : {}),
    ...(options.semanticRole ? { semanticRole: options.semanticRole } : {}),
  };
}

function animation(
  id: string,
  type: SceneAnimation["type"],
  targetIds: string[],
  start: number,
  duration: number,
  properties: SceneAnimation["properties"] = {},
): SceneAnimation {
  return { id, type, targetIds, start, duration, easing: type === "emphasise" ? "there-and-back" : "editorial", properties };
}

export function createCantorDemoProject(): ProjectDocument {
  const diagramId = "object-interval-diagram";
  const equationGroupId = "object-equation-chain";
  const thirdGenerationParents = [226, 354, 606, 734] as const;
  const thirdGenerationObjects = thirdGenerationParents.flatMap((center, index) => [
    object(`object-interval-third-${index + 1}-left`, "rectangle", `Third generation ${index * 2 + 1}`, { x: center - 21, y: 352, width: 20, height: 10 }, { generation: 3 }, { parentId: diagramId, semanticRole: "surviving-interval", style: { fill: "#315866" } }),
    object(`object-removal-third-${index + 1}`, "rectangle", `Third removal ${index + 1}`, { x: center, y: 352, width: 20, height: 10 }, { generation: 3, removed: true }, { parentId: diagramId, semanticRole: "third-removal", style: { stroke: "#71402d", opacity: 0.32 } }),
    object(`object-interval-third-${index + 1}-right`, "rectangle", `Third generation ${index * 2 + 2}`, { x: center + 21, y: 352, width: 20, height: 10 }, { generation: 3 }, { parentId: diagramId, semanticRole: "surviving-interval", style: { fill: "#315866" } }),
  ]);
  const objects: SceneObject[] = [
    object("object-title", "text", "Uncountable, Yet Zero Length", { x: 360, y: 72, width: 640, height: 52 }, { content: "Uncountable, Yet Zero Length" }, { semanticRole: "title", style: { fontSize: 38, fontWeight: 600, textAlign: "left" } }),
    object("object-subtitle", "text", "A quiet paradox", { x: 244, y: 116, width: 400, height: 30 }, { content: "A quiet paradox in thirds" }, { semanticRole: "subtitle", style: { fontSize: 19, textAlign: "left" } }),
    object(diagramId, "group", "Cantor interval diagram", { x: 480, y: 276, width: 660, height: 225 }, {}, { semanticRole: "interval-diagram" }),
    object("object-interval-generation-0", "rectangle", "Original interval", { x: 480, y: 205, width: 570, height: 14 }, { generation: 0 }, { parentId: diagramId, semanticRole: "surviving-interval", style: { fill: "#252722" } }),
    object("object-interval-left-1", "rectangle", "First left interval", { x: 290, y: 258, width: 190, height: 14 }, { generation: 1 }, { parentId: diagramId, semanticRole: "surviving-interval", style: { fill: "#315866" } }),
    object("object-interval-right-1", "rectangle", "First right interval", { x: 670, y: 258, width: 190, height: 14 }, { generation: 1 }, { parentId: diagramId, semanticRole: "surviving-interval", style: { fill: "#315866" } }),
    object("object-removal-first", "rectangle", "First removal", { x: 480, y: 258, width: 190, height: 14 }, { generation: 1, removed: true }, { parentId: diagramId, semanticRole: "first-removal", style: { stroke: "#71402d", opacity: 0.35 } }),
    object("object-interval-left-2a", "rectangle", "Second generation I", { x: 226, y: 311, width: 62, height: 12 }, { generation: 2 }, { parentId: diagramId, semanticRole: "surviving-interval", style: { fill: "#252722" } }),
    object("object-interval-left-2b", "rectangle", "Second generation II", { x: 354, y: 311, width: 62, height: 12 }, { generation: 2 }, { parentId: diagramId, semanticRole: "surviving-interval", style: { fill: "#252722" } }),
    object("object-interval-right-2a", "rectangle", "Second generation III", { x: 606, y: 311, width: 62, height: 12 }, { generation: 2 }, { parentId: diagramId, semanticRole: "surviving-interval", style: { fill: "#252722" } }),
    object("object-interval-right-2b", "rectangle", "Second generation IV", { x: 734, y: 311, width: 62, height: 12 }, { generation: 2 }, { parentId: diagramId, semanticRole: "surviving-interval", style: { fill: "#252722" } }),
    object("object-removal-second", "rectangle", "Second removal", { x: 290, y: 311, width: 64, height: 12 }, { generation: 2, removed: true }, { parentId: diagramId, semanticRole: "second-removal", style: { stroke: "#71402d", opacity: 0.3 } }),
    object("object-generation-note", "text", "Recursive note", { x: 810, y: 155, width: 220, height: 52 }, { content: "remove the open middle third\n— then repeat" }, { parentId: diagramId, semanticRole: "annotation", style: { fontSize: 17, textAlign: "left", roughEmphasis: true } }),
    ...thirdGenerationObjects,
    object(equationGroupId, "group", "Surviving length equation", { x: 264, y: 414, width: 390, height: 96 }, {}, { semanticRole: "equation-chain", locked: true }),
    object("object-equation-length", "math", "Length after n stages", { x: 260, y: 397, width: 330, height: 42 }, { content: "L_n = (2/3)^n" }, { parentId: equationGroupId, semanticRole: "surviving-length-equation", locked: true, style: { fontSize: 31, textAlign: "left" } }),
    object("object-equation-limit", "math", "Limit of surviving length", { x: 284, y: 445, width: 375, height: 38 }, { content: "\\lim_{n\\to\\infty} L_n = 0" }, { parentId: equationGroupId, semanticRole: "limit-equation", locked: true, style: { fontSize: 26, textAlign: "left" } }),
    object("object-margin-note", "text", "Measure note", { x: 770, y: 400, width: 190, height: 72 }, { content: "Length vanishes.\nCardinality does not." }, { semanticRole: "marginal-note", style: { fontSize: 18, textAlign: "left", roughEmphasis: true } }),
  ];

  const animations: SceneAnimation[] = [
    animation("animation-title-write", "write", ["object-title"], 0, 1.2),
    animation("animation-subtitle-fade", "fade-in", ["object-subtitle"], 0.7, 0.8),
    animation("animation-original-create", "create", ["object-interval-generation-0"], 1.8, 1.2),
    animation("animation-first-marker-in", "fade-in", ["object-removal-first"], 3.5, 0.6),
    animation("animation-first-removal", "fade-out", ["object-removal-first"], 4.2, 1.1),
    animation("animation-first-split", "create", ["object-interval-left-1", "object-interval-right-1"], 4.8, 1.2),
    animation("animation-second-marker-in", "fade-in", ["object-removal-second"], 5.2, 0.7),
    animation("animation-generation-note-in", "fade-in", ["object-generation-note"], 6.4, 0.8),
    animation("animation-second-removal", "fade-out", ["object-removal-second"], 7.4, 1),
    animation("animation-second-split", "create", ["object-interval-left-2a", "object-interval-left-2b", "object-interval-right-2a", "object-interval-right-2b"], 8.1, 1.4),
    animation("animation-third-split", "create", thirdGenerationObjects.map(({ id }) => id), 10.6, 1.2),
    animation("animation-third-removals", "fade-out", thirdGenerationObjects.filter(({ semanticRole }) => semanticRole === "third-removal").map(({ id }) => id), 12, 1.1),
    animation("animation-camera-focus", "camera-focus", [diagramId], 13.2, 0.8, { x: 480, y: 285, zoom: 1.05 }),
    animation("animation-equation-write", "write", [equationGroupId], 14.2, 1.7),
    animation("animation-limit-emphasis", "emphasise", ["object-equation-limit"], 17.2, 1.3, { scale: 1.08 }),
    animation("animation-note-fade", "fade-in", ["object-margin-note"], 19, 1.1),
  ];

  const project: ProjectDocument = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadata: {
      id: "project-uncountable-zero-length",
      title: "Uncountable, Yet Zero Length",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    },
    settings: {
      aspectRatio: "16:9",
      frameRate: 30,
      resolution: { width: 1280, height: 720 },
      renderPreset: "720p",
      previewQuality: "standard",
    },
    activeStyleId: EDITORIAL_INK_STYLE_ID,
    styles: DEFAULT_STYLE_PACKS.map((style) => cloneSerializable(style)),
    customEasings: [],
    assets: [],
    shots: [
      {
        id: "shot-cantor-construction",
        name: "The construction",
        duration: 21,
        objects,
        animations,
        propertyTracks: [],
        audioClips: [],
        captionClips: [],
        markers: [],
        camera: { x: 480, y: 270, zoom: 1, rotation: 0 },
      },
      {
        id: "shot-cantor-conclusion",
        name: "The paradox",
        duration: 7,
        objects: [
          object("object-conclusion-title", "text", "The contrast", { x: 270, y: 100, width: 390, height: 45 }, { content: "The contrast" }, { semanticRole: "title", style: { fontSize: 38, textAlign: "left" } }),
          object("object-conclusion-cardinality", "text", "Uncountable", { x: 300, y: 255, width: 360, height: 52 }, { content: "uncountably many points" }, { semanticRole: "main-claim", style: { fontSize: 31, textAlign: "left" } }),
          object("object-conclusion-measure", "text", "Zero length", { x: 650, y: 360, width: 290, height: 48 }, { content: "zero total length" }, { semanticRole: "counter-claim", style: { fontSize: 30, textAlign: "left" } }),
        ],
        animations: [
          animation("animation-conclusion-title", "write", ["object-conclusion-title"], 0, 1),
          animation("animation-conclusion-cardinality", "fade-in", ["object-conclusion-cardinality"], 1.4, 1.2),
          animation("animation-conclusion-measure", "fade-in", ["object-conclusion-measure"], 3.2, 1.2),
          animation("animation-conclusion-focus", "camera-focus", ["object-conclusion-cardinality", "object-conclusion-measure"], 4.8, 1.2, { x: 500, y: 280, zoom: 1.08 }),
        ],
        propertyTracks: [],
        audioClips: [],
        captionClips: [],
        markers: [],
        camera: { x: 480, y: 270, zoom: 1, rotation: 0 },
      },
    ],
  };
  return ProjectDocumentSchema.parse(project);
}

export const CANTOR_DEMO_PROJECT = createCantorDemoProject();

/**
 * A small, audible, deterministic PCM fixture shared by the representative
 * project and the stress project. The bytes are generated rather than hidden
 * in the project JSON so storage tests and seeders can bind the exact payload
 * to the declared metadata.
 *
 * The signal is a restrained 20 ms, 1 kHz pulse once per second. It is not
 * presented as narration or music; its sole purpose is to make timeline sync,
 * trim, fades, export and mux verification deterministic.
 */
export const DETERMINISTIC_AUDIO_FIXTURE = Object.freeze({
  sampleRate: 8_000,
  duration: 90,
  metadata: Object.freeze({
    id: "asset-proofcanvas-deterministic-audio",
    filename: "proofcanvas-deterministic-pulse-90s.wav",
    mimeType: "audio/wav",
    size: 1_440_044,
    sha256: "c3346b09725f0faa637b1e1eb4b3ab520cbf522d44ef80e5c406c9b0de9a20af",
    duration: 90,
    provenance: "bundled",
  } satisfies AssetMetadata),
});

/** Produce the exact WAV bytes described by DETERMINISTIC_AUDIO_FIXTURE. */
export function createDeterministicAudioFixtureBytes(): Uint8Array {
  const sampleRate = DETERMINISTIC_AUDIO_FIXTURE.sampleRate;
  const sampleCount = sampleRate * DETERMINISTIC_AUDIO_FIXTURE.duration;
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };

  ascii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, sampleCount * 2, true);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const withinSecond = sampleIndex % sampleRate;
    let sample = 0;
    if (withinSecond < 160) {
      const sign = Math.floor(withinSecond / 4) % 2 === 0 ? 1 : -1;
      sample = sign * Math.floor((2_400 * (160 - withinSecond)) / 160);
    }
    view.setInt16(44 + sampleIndex * 2, sample, true);
  }
  return bytes;
}

const CANTOR_CUSTOM_EASING = Object.freeze({
  id: "easing-cantor-settle",
  name: "Cantor settle",
  curve: { x1: 0.22, y1: 0.72, x2: 0.34, y2: 1 },
});

function fixtureAudioClip(index: number, duration: number, sourceStart: number): Shot["audioClips"][number] {
  return {
    id: `audio-cantor-${index + 1}`,
    assetId: DETERMINISTIC_AUDIO_FIXTURE.metadata.id,
    name: `Timing pulse ${index + 1}`,
    start: 0,
    duration,
    sourceStart,
    sourceEnd: sourceStart + duration,
    volume: 0.32,
    muted: false,
    solo: false,
    fadeIn: 0.1,
    fadeOut: 0.1,
  };
}

function caption(id: string, start: number, end: number, text: string): Shot["captionClips"][number] {
  return { id, start, end, text, style: {} };
}

function marker(id: string, time: number, name: string, color = "#315866"): Shot["markers"][number] {
  return { id, time, name, color };
}

function track(
  id: string,
  objectId: string,
  property: PropertyTrack["property"],
  keyframes: PropertyTrack["keyframes"],
): PropertyTrack {
  return { id, target: { kind: "object", objectId }, property, keyframes };
}

function v1FiniteBookkeepingShot(): Shot {
  const groupId = "object-v1-finite-intervals";
  return {
    id: "shot-cantor-bookkeeping",
    name: "Finite bookkeeping",
    duration: 8,
    objects: [
      object("object-v1-bookkeeping-title", "text", "What disappears", { x: 250, y: 70, width: 440, height: 48 }, { content: "What disappears at each stage?" }, { semanticRole: "title", style: { fontSize: 36, fontWeight: 600 } }),
      object("object-v1-bookkeeping-sum", "math", "Removed length", { x: 250, y: 145, width: 460, height: 55 }, { content: "\\frac{1}{3}+2\\cdot\\frac{1}{9}+4\\cdot\\frac{1}{27}+...=1" }, { semanticRole: "equation", style: { fontSize: 30 } }),
      object("object-v1-bookkeeping-brace", "brace", "Removed pieces brace", { x: 470, y: 232, width: 560, height: 36 }, { label: "2^{n-1} pieces, each of length 3^{-n}" }, { semanticRole: "brace", style: { stroke: "#71402d", strokeWidth: 2 } }),
      object(groupId, "group", "Finite stage intervals", { x: 480, y: 330, width: 620, height: 90 }, {}, { semanticRole: "finite-stage" }),
      object("object-v1-finite-left", "rectangle", "Left survivor", { x: 260, y: 330, width: 165, height: 18 }, { stage: 2 }, { parentId: groupId, style: { fill: "#315866", opacity: 0.88 } }),
      object("object-v1-finite-middle-left", "rectangle", "Middle-left survivor", { x: 405, y: 330, width: 55, height: 18 }, { stage: 2 }, { parentId: groupId, style: { fill: "#252722" } }),
      object("object-v1-finite-middle-right", "rectangle", "Middle-right survivor", { x: 555, y: 330, width: 55, height: 18 }, { stage: 2 }, { parentId: groupId, style: { fill: "#252722" } }),
      object("object-v1-finite-right", "rectangle", "Right survivor", { x: 700, y: 330, width: 165, height: 18 }, { stage: 2 }, { parentId: groupId, style: { fill: "#315866", opacity: 0.88 } }),
      object("object-v1-bookkeeping-arrow", "arrow", "Conservation arrow", { x: 480, y: 407, width: 330, height: 30 }, { direction: "right" }, { semanticRole: "inference", style: { stroke: "#71402d", strokeWidth: 2 } }),
      object("object-v1-bookkeeping-note", "text", "Finite versus limit note", { x: 295, y: 475, width: 520, height: 58 }, { content: "Every finite stage still has positive length.\nThe limit is the delicate step." }, { semanticRole: "annotation", style: { fontSize: 19, roughEmphasis: true } }),
    ],
    animations: [
      animation("animation-v1-bookkeeping-title", "write", ["object-v1-bookkeeping-title"], 0, 0.8),
      animation("animation-v1-bookkeeping-sum", "write", ["object-v1-bookkeeping-sum"], 1, 1),
      animation("animation-v1-bookkeeping-brace", "create", ["object-v1-bookkeeping-brace"], 2.2, 0.8),
      animation("animation-v1-finite-create", "create", [groupId], 3.2, 1),
      animation("animation-v1-bookkeeping-arrow", "create", ["object-v1-bookkeeping-arrow"], 4.5, 0.6),
      animation("animation-v1-bookkeeping-note", "fade-in", ["object-v1-bookkeeping-note"], 5.2, 0.8),
      animation("animation-v1-bookkeeping-camera", "camera-focus", [groupId], 6.2, 0.8, { x: 480, y: 325, zoom: 1.12 }),
    ],
    propertyTracks: [track("track-v1-bookkeeping-note-y", "object-v1-bookkeeping-note", "y", [
      { id: "keyframe-v1-bookkeeping-note-y-a", time: 6.1, value: 485, interpolation: { kind: "custom-bezier", curve: CANTOR_CUSTOM_EASING.curve } },
      { id: "keyframe-v1-bookkeeping-note-y-b", time: 7, value: 475, interpolation: { kind: "eased", easing: "ease-out" } },
      { id: "keyframe-v1-bookkeeping-note-y-c", time: 8, value: 475, interpolation: { kind: "hold" } },
    ])],
    audioClips: [fixtureAudioClip(1, 8, 21)],
    captionClips: [
      caption("caption-v1-bookkeeping-a", 0, 3.1, "At stage n, there are 2 to the n minus one new gaps."),
      caption("caption-v1-bookkeeping-b", 3.1, 8, "Finite length remains; only the limiting length vanishes."),
    ],
    markers: [
      marker("marker-v1-bookkeeping-sum", 1, "Removed-length series"),
      marker("marker-v1-bookkeeping-warning", 5.2, "Finite versus limit", "#71402d"),
    ],
    camera: { x: 480, y: 270, zoom: 1, rotation: 0 },
  };
}

function v1AddressesShot(): Shot {
  return {
    id: "shot-cantor-addresses",
    name: "Infinite addresses",
    duration: 8,
    objects: [
      object("object-v1-address-title", "text", "Infinite addresses", { x: 245, y: 72, width: 440, height: 48 }, { content: "An address for every surviving point" }, { semanticRole: "title", style: { fontSize: 35, fontWeight: 600 } }),
      object("object-v1-address-expansion", "math", "Ternary expansion", { x: 270, y: 150, width: 470, height: 55 }, { content: "x=0.a_1a_2a_3...{}_3" }, { semanticRole: "equation", style: { fontSize: 34 } }),
      object("object-v1-address-choice", "math", "Digit choices", { x: 325, y: 235, width: 310, height: 48 }, { content: "a_k=0\\text{ or }2" }, { semanticRole: "equation", style: { fontSize: 31 } }),
      object("object-v1-address-brace", "brace", "Binary-choice brace", { x: 480, y: 282, width: 330, height: 30 }, { label: "left or right, forever", direction: "below" }, { semanticRole: "brace", style: { stroke: "#71402d", strokeWidth: 2 } }),
      object("object-v1-address-arrow-left", "arrow", "Choose left", { x: 335, y: 355, width: 190, height: 55, rotation: -12 }, { branch: 0 }, { semanticRole: "choice", style: { stroke: "#315866", strokeWidth: 2 } }),
      object("object-v1-address-arrow-right", "arrow", "Choose right", { x: 625, y: 355, width: 190, height: 55, rotation: 12 }, { branch: 2 }, { semanticRole: "choice", style: { stroke: "#71402d", strokeWidth: 2 } }),
      object("object-v1-address-left-label", "text", "Zero branch", { x: 265, y: 425, width: 180, height: 32 }, { content: "0 — keep left third" }, { semanticRole: "cool-label", style: { fontSize: 17 } }),
      object("object-v1-address-right-label", "text", "Two branch", { x: 620, y: 425, width: 190, height: 32 }, { content: "2 — keep right third" }, { semanticRole: "warm-label", style: { fontSize: 17 } }),
      object("object-v1-address-note", "text", "Cardinality note", { x: 285, y: 495, width: 520, height: 44 }, { content: "Infinite binary choices cannot be listed one by one." }, { semanticRole: "main-claim", style: { fontSize: 22, fontWeight: 600 } }),
    ],
    animations: [
      animation("animation-v1-address-title", "write", ["object-v1-address-title"], 0, 0.8),
      animation("animation-v1-address-expansion", "write", ["object-v1-address-expansion"], 1, 1),
      animation("animation-v1-address-choice", "write", ["object-v1-address-choice"], 2.2, 0.7),
      animation("animation-v1-address-brace", "create", ["object-v1-address-brace"], 3, 0.6),
      animation("animation-v1-address-arrows", "create", ["object-v1-address-arrow-left", "object-v1-address-arrow-right"], 3.8, 0.8),
      animation("animation-v1-address-labels", "fade-in", ["object-v1-address-left-label", "object-v1-address-right-label"], 4.8, 0.7),
      animation("animation-v1-address-note", "fade-in", ["object-v1-address-note"], 5.7, 0.8),
      animation("animation-v1-address-camera", "camera-focus", ["object-v1-address-note"], 6.7, 0.7, { x: 480, y: 390, zoom: 1.08 }),
    ],
    propertyTracks: [track("track-v1-address-note-opacity", "object-v1-address-note", "opacity", [
      { id: "keyframe-v1-address-note-opacity-a", time: 6.5, value: 0.72, interpolation: { kind: "custom-bezier", curve: CANTOR_CUSTOM_EASING.curve } },
      { id: "keyframe-v1-address-note-opacity-b", time: 7.2, value: 1, interpolation: { kind: "hold" } },
      { id: "keyframe-v1-address-note-opacity-c", time: 8, value: 1, interpolation: { kind: "hold" } },
    ])],
    audioClips: [fixtureAudioClip(2, 8, 29)],
    captionClips: [
      caption("caption-v1-address-a", 0, 4, "A surviving point has a ternary address made only from zeroes and twos."),
      caption("caption-v1-address-b", 4, 8, "Those endless left-right choices form an uncountable family."),
    ],
    markers: [
      marker("marker-v1-address-ternary", 1, "Ternary address"),
      marker("marker-v1-address-cardinality", 5.7, "Uncountability"),
    ],
    camera: { x: 480, y: 270, zoom: 1, rotation: 0 },
  };
}

function v1LengthLedgerShot(): Shot {
  const rows = [
    { stage: 0, value: "1", width: 420 },
    { stage: 1, value: "2/3", width: 280 },
    { stage: 2, value: "4/9", width: 187 },
    { stage: 3, value: "8/27", width: 124 },
    { stage: 4, value: "16/81", width: 83 },
  ];
  const rowObjects = rows.flatMap((row, index) => [
    object(`object-v1-ledger-bar-${index}`, "rectangle", `Stage ${row.stage} length bar`, { x: 315 + row.width / 2, y: 190 + index * 62, width: row.width, height: 18 }, { stage: row.stage, length: row.value }, { semanticRole: "numerical-bar", style: { fill: index % 2 === 0 ? "#315866" : "#252722", opacity: 0.9 } }),
    object(`object-v1-ledger-label-${index}`, "math", `Stage ${row.stage} value`, { x: 705, y: 188 + index * 62, width: 205, height: 34 }, { content: `L_${row.stage}=${row.value}` }, { semanticRole: index === rows.length - 1 ? "warm-label" : "data-label", style: { fontSize: 22 } }),
  ]);
  return {
    id: "shot-cantor-ledger",
    name: "The length ledger",
    duration: 8,
    objects: [
      object("object-v1-ledger-title", "text", "Length ledger", { x: 250, y: 66, width: 430, height: 48 }, { content: "The numerical pattern" }, { semanticRole: "title", style: { fontSize: 36, fontWeight: 600 } }),
      object("object-v1-ledger-header", "math", "Length rule", { x: 620, y: 80, width: 260, height: 42 }, { content: "L_n=(2/3)^n" }, { semanticRole: "equation", style: { fontSize: 27 } }),
      ...rowObjects,
      object("object-v1-ledger-arrow", "arrow", "Decreasing sequence arrow", { x: 825, y: 315, width: 32, height: 220, rotation: 90 }, { direction: "down" }, { semanticRole: "trend", style: { stroke: "#71402d", strokeWidth: 2 } }),
      object("object-v1-ledger-note", "text", "Convergence note", { x: 670, y: 515, width: 250, height: 42 }, { content: "multiply by 2/3\neach time" }, { semanticRole: "annotation", style: { fontSize: 18, roughEmphasis: true } }),
    ],
    animations: [
      animation("animation-v1-ledger-title", "write", ["object-v1-ledger-title"], 0, 0.7),
      animation("animation-v1-ledger-header", "write", ["object-v1-ledger-header"], 0.8, 0.7),
      ...rows.flatMap((_, index) => [
        animation(`animation-v1-ledger-bar-${index}`, "create", [`object-v1-ledger-bar-${index}`], 1.7 + index * 0.7, 0.35),
        animation(`animation-v1-ledger-label-${index}`, "write", [`object-v1-ledger-label-${index}`], 2.05 + index * 0.7, 0.3),
      ]),
      animation("animation-v1-ledger-arrow", "create", ["object-v1-ledger-arrow"], 5.6, 0.5),
      animation("animation-v1-ledger-note", "fade-in", ["object-v1-ledger-note"], 6.2, 0.5),
      animation("animation-v1-ledger-camera", "camera-focus", ["object-v1-ledger-bar-4"], 6.9, 0.6, { x: 500, y: 390, zoom: 1.1 }),
    ],
    propertyTracks: [track("track-v1-ledger-final-width", "object-v1-ledger-bar-4", "width", [
      { id: "keyframe-v1-ledger-final-width-a", time: 6, value: 96, interpolation: { kind: "custom-bezier", curve: CANTOR_CUSTOM_EASING.curve } },
      { id: "keyframe-v1-ledger-final-width-b", time: 7, value: 83, interpolation: { kind: "eased", easing: "ease-out" } },
      { id: "keyframe-v1-ledger-final-width-c", time: 8, value: 83, interpolation: { kind: "hold" } },
    ])],
    audioClips: [fixtureAudioClip(3, 8, 37)],
    captionClips: [
      caption("caption-v1-ledger-a", 0, 4.5, "The surviving lengths are one, two thirds, four ninths, eight twenty-sevenths."),
      caption("caption-v1-ledger-b", 4.5, 8, "Repeated multiplication by two thirds drives the sequence to zero."),
    ],
    markers: [
      marker("marker-v1-ledger-values", 1.7, "Length values"),
      marker("marker-v1-ledger-limit", 6.2, "Convergence"),
    ],
    camera: { x: 480, y: 270, zoom: 1, rotation: 0 },
  };
}

/**
 * Fully editable 52-second V1 representative project. The historical two-shot
 * createCantorDemoProject factory remains frozen for migration and regression
 * contracts; product surfaces can opt into this richer project explicitly.
 */
export function createCantorV1Project(): ProjectDocument {
  const legacy = createCantorDemoProject();
  const construction = cloneSerializable(legacy.shots[0]);
  construction.audioClips = [fixtureAudioClip(0, construction.duration, 0)];
  construction.captionClips = [
    caption("caption-v1-construction-a", 0, 6.4, "Begin with the closed unit interval and remove its open middle third."),
    caption("caption-v1-construction-b", 6.4, 14.2, "Repeat the same removal inside every surviving interval."),
    caption("caption-v1-construction-c", 14.2, 21, "After n stages, the surviving length is two thirds to the n."),
  ];
  construction.markers = [
    marker("marker-v1-construction-start", 0, "Unit interval"),
    marker("marker-v1-construction-repeat", 6.4, "Repeat in thirds"),
    marker("marker-v1-construction-limit", 14.2, "Length equation"),
  ];
  construction.propertyTracks = [track("track-v1-construction-note-x", "object-margin-note", "x", [
    { id: "keyframe-v1-construction-note-x-a", time: 20.1, value: 790, interpolation: { kind: "custom-bezier", curve: CANTOR_CUSTOM_EASING.curve } },
    { id: "keyframe-v1-construction-note-x-b", time: 20.5, value: 770, interpolation: { kind: "eased", easing: "ease-out" } },
    { id: "keyframe-v1-construction-note-x-c", time: 21, value: 770, interpolation: { kind: "hold" } },
  ])];

  const conclusion = cloneSerializable(legacy.shots[1]);
  conclusion.objects.push(
    object("object-v1-conclusion-equation", "math", "Cantor conclusion", { x: 315, y: 465, width: 430, height: 48 }, { content: "|C|=|[0,1]|,\\;m(C)=0" }, { semanticRole: "conclusion", style: { fontSize: 28 } }),
  );
  conclusion.animations.push(
    animation("animation-v1-conclusion-equation", "write", ["object-v1-conclusion-equation"], 5.8, 0.8),
  );
  conclusion.propertyTracks = [track("track-v1-conclusion-equation-opacity", "object-v1-conclusion-equation", "opacity", [
    { id: "keyframe-v1-conclusion-equation-opacity-a", time: 6.6, value: 0.76, interpolation: { kind: "custom-bezier", curve: CANTOR_CUSTOM_EASING.curve } },
    { id: "keyframe-v1-conclusion-equation-opacity-b", time: 7, value: 1, interpolation: { kind: "hold" } },
  ])];
  conclusion.audioClips = [fixtureAudioClip(4, conclusion.duration, 45)];
  conclusion.captionClips = [
    caption("caption-v1-conclusion-a", 0, 3.5, "The Cantor set has as many points as the full interval."),
    caption("caption-v1-conclusion-b", 3.5, 7, "Yet its total length is zero."),
  ];
  conclusion.markers = [
    marker("marker-v1-conclusion-cardinality", 1.4, "Uncountable"),
    marker("marker-v1-conclusion-measure", 3.2, "Zero length", "#71402d"),
  ];

  const project: ProjectDocument = {
    ...cloneSerializable(legacy),
    metadata: {
      ...legacy.metadata,
      title: "Uncountable, Yet Zero Length — V1",
      updatedAt: "2026-08-26T00:00:00.000Z",
    },
    customEasings: [cloneSerializable(CANTOR_CUSTOM_EASING)],
    assets: [cloneSerializable(DETERMINISTIC_AUDIO_FIXTURE.metadata)],
    shots: [
      construction,
      v1FiniteBookkeepingShot(),
      v1AddressesShot(),
      v1LengthLedgerShot(),
      conclusion,
    ],
  };
  return ProjectDocumentSchema.parse(project);
}
