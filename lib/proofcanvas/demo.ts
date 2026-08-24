import { ProjectDocumentSchema, cloneSerializable, type ProjectDocument, type SceneAnimation, type SceneObject } from "./schema";
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
  return { id, type, targetIds, start, duration, easing: "editorial", properties };
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
    object("object-title", "text", "Uncountable, Yet Zero Length", { x: 300, y: 72, width: 520, height: 52 }, { content: "Uncountable, Yet Zero Length" }, { semanticRole: "title", style: { fontSize: 38, fontWeight: 600, textAlign: "left" } }),
    object("object-subtitle", "text", "A quiet paradox", { x: 244, y: 116, width: 400, height: 30 }, { content: "A quiet paradox in thirds" }, { semanticRole: "subtitle", style: { fontSize: 19, textAlign: "left", color: "#4f534c" } }),
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
    object("object-equation-limit", "math", "Limit of surviving length", { x: 284, y: 445, width: 375, height: 38 }, { content: "\\lim_{n\\to\\infty} L_n = 0" }, { parentId: equationGroupId, semanticRole: "limit-equation", locked: true, style: { fontSize: 26, textAlign: "left", color: "#315866" } }),
    object("object-margin-note", "text", "Measure note", { x: 770, y: 430, width: 190, height: 72 }, { content: "Length vanishes.\nCardinality does not." }, { semanticRole: "marginal-note", style: { fontSize: 18, textAlign: "left", color: "#4f534c", roughEmphasis: true } }),
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
    schemaVersion: 2,
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
          object("object-conclusion-cardinality", "text", "Uncountable", { x: 300, y: 255, width: 360, height: 52 }, { content: "uncountably many points" }, { semanticRole: "main-claim", style: { fontSize: 31, textAlign: "left", color: "#315866" } }),
          object("object-conclusion-measure", "text", "Zero length", { x: 650, y: 360, width: 290, height: 48 }, { content: "zero total length" }, { semanticRole: "main-claim", style: { fontSize: 30, textAlign: "left", color: "#71402d" } }),
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
