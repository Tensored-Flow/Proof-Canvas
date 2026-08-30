import { createCantorDemoProject } from "../demo";
import {
  AssetVisualSettingsSchema,
  ProjectDocumentSchema,
  assetVisualSettingsFor,
  cloneSerializable,
} from "../schema";

function mediaProject() {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  project.assets = [
    {
      id: "asset-media-image",
      filename: "diagram.png",
      mimeType: "image/png",
      size: 128,
      sha256: "a".repeat(64),
      width: 320,
      height: 180,
      provenance: "uploaded",
    },
    {
      id: "asset-media-audio",
      filename: "narration.wav",
      mimeType: "audio/wav",
      size: 256,
      sha256: "b".repeat(64),
      duration: 5,
      provenance: "uploaded",
    },
  ];
  shot.objects.push({
    id: "object-media-image",
    type: "image",
    name: "Diagram",
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 320, height: 180, rotation: 17, scaleX: 1, scaleY: 1 },
    style: { opacity: 0.75 },
    properties: {
      assetId: "asset-media-image",
      fit: "cover",
      preserveAspectRatio: true,
      crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.7 },
      mask: { kind: "rounded-rectangle", radius: 18 },
    },
  });
  shot.audioClips.push({
    id: "audio-media-clip",
    assetId: "asset-media-audio",
    name: "Narration",
    start: 0,
    duration: 5,
    sourceStart: 0,
    sourceEnd: 5,
    volume: 1,
    muted: false,
    solo: false,
    fadeIn: 0.5,
    fadeOut: 1,
  });
  return project;
}

test("validates exact image fit, crop, mask, transform, and opacity settings", () => {
  const project = ProjectDocumentSchema.parse(mediaProject());
  const object = project.shots[0].objects.find(({ id }) => id === "object-media-image")!;
  expect(assetVisualSettingsFor(object)).toEqual({
    fit: "cover",
    preserveAspectRatio: true,
    crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.7 },
    mask: { kind: "rounded-rectangle", radius: 18 },
  });
  expect(object.transform).toMatchObject({ width: 320, height: 180, rotation: 17 });
  expect(object.style.opacity).toBe(0.75);
});

test("keeps old image documents loadable while resolving explicit visual defaults", () => {
  const project = mediaProject();
  const object = project.shots[0].objects.find(({ id }) => id === "object-media-image")!;
  object.properties = { assetId: "asset-media-image" };
  const parsed = ProjectDocumentSchema.parse(project);
  expect(assetVisualSettingsFor(parsed.shots[0].objects.find(({ id }) => id === object.id)!)).toEqual({
    fit: "contain",
    preserveAspectRatio: true,
  });
});

test("rejects crop escape, unknown fit/mask fields, and invalid asset settings without throwing outside Zod", () => {
  for (const settings of [
    { crop: { x: 0.9, y: 0, width: 0.2, height: 1 } },
    { fit: "stretch" },
    { mask: { kind: "rounded-rectangle", radius: 5, script: "alert(1)" } },
  ]) expect(AssetVisualSettingsSchema.safeParse(settings).success).toBe(false);

  const project = mediaProject();
  const object = project.shots[0].objects.find(({ id }) => id === "object-media-image")!;
  object.properties.crop = { x: 0, y: 0.95, width: 1, height: 0.1 };
  expect(ProjectDocumentSchema.safeParse(project).success).toBe(false);
});

test("accepts bounded fades and rejects a fade envelope longer than the clip", () => {
  expect(ProjectDocumentSchema.safeParse(mediaProject()).success).toBe(true);
  const invalid = mediaProject();
  invalid.shots[0].audioClips[0].fadeIn = 3;
  invalid.shots[0].audioClips[0].fadeOut = 3;
  const result = ProjectDocumentSchema.safeParse(invalid);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.some(({ message }) => message.includes("fades must fit"))).toBe(true);
});

test("keeps pre-fade audio clips schema-compatible without injecting new canonical fields", () => {
  const project = mediaProject();
  delete project.shots[0].audioClips[0].fadeIn;
  delete project.shots[0].audioClips[0].fadeOut;
  const parsed = ProjectDocumentSchema.parse(project);
  expect(parsed.shots[0].audioClips[0]).not.toHaveProperty("fadeIn");
  expect(parsed.shots[0].audioClips[0]).not.toHaveProperty("fadeOut");
});
