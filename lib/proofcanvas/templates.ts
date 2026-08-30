import { createCantorV1Project } from "./demo";
import { PROJECT_SCHEMA_VERSION, ProjectDocumentSchema, cloneSerializable, type ProjectDocument } from "./schema";
import { DEFAULT_STYLE_PACKS, EDITORIAL_INK_STYLE_ID } from "./styles";
import { logicalFrameFor, resolutionFor } from "./frame";

export type ProjectTemplateKind = "blank" | "sample";

function normalizedTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 160) throw new Error("Project title must contain 1–160 characters");
  return trimmed;
}

export function createProjectTemplate(
  kind: ProjectTemplateKind,
  projectId: string,
  title: string,
  now = new Date().toISOString(),
): ProjectDocument {
  const safeTitle = normalizedTitle(title);
  if (kind === "sample") {
    const sample = cloneSerializable(createCantorV1Project());
    sample.metadata = { id: projectId, title: safeTitle, createdAt: now, updatedAt: now };
    return ProjectDocumentSchema.parse(sample);
  }
  const frame = logicalFrameFor("16:9");
  return ProjectDocumentSchema.parse({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadata: { id: projectId, title: safeTitle, createdAt: now, updatedAt: now },
    settings: {
      aspectRatio: "16:9",
      frameRate: 30,
      resolution: resolutionFor("16:9", "720p"),
      renderPreset: "720p",
      previewQuality: "standard",
    },
    activeStyleId: EDITORIAL_INK_STYLE_ID,
    styles: DEFAULT_STYLE_PACKS.map((style) => cloneSerializable(style)),
    customEasings: [],
    assets: [],
    shots: [{
      id: "shot-main",
      name: "Main shot",
      duration: 5,
      objects: [],
      animations: [],
      propertyTracks: [],
      audioClips: [],
      captionClips: [],
      markers: [],
      camera: { x: frame.centerX, y: frame.centerY, zoom: 1, rotation: 0 },
    }],
  });
}
