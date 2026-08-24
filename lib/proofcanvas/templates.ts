import { createCantorDemoProject } from "./demo";
import { ProjectDocumentSchema, cloneSerializable, type ProjectDocument } from "./schema";
import { DEFAULT_STYLE_PACKS, EDITORIAL_INK_STYLE_ID } from "./styles";

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
    const sample = cloneSerializable(createCantorDemoProject());
    sample.metadata = { id: projectId, title: safeTitle, createdAt: now, updatedAt: now };
    return ProjectDocumentSchema.parse(sample);
  }
  return ProjectDocumentSchema.parse({
    schemaVersion: 2,
    metadata: { id: projectId, title: safeTitle, createdAt: now, updatedAt: now },
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
      camera: { x: 480, y: 270, zoom: 1, rotation: 0 },
    }],
  });
}
