import { createCantorDemoProject } from "../demo";
import { applyDocumentOperations, DocumentOperationValidationError } from "../documentOperations";
import { resolveUpsertKeyframe } from "../editorTimeline";
import { applyOperations } from "../operations";
import { ProjectDocumentSchema, cloneSerializable } from "../schema";

function projectWithMedia() {
  const project = cloneSerializable(createCantorDemoProject());
  project.assets = [{
    id: "asset-media-operations",
    filename: "narration.wav",
    mimeType: "audio/wav",
    size: 128,
    sha256: "c".repeat(64),
    duration: 20,
    provenance: "uploaded",
  }];
  const shot = project.shots[0];
  shot.audioClips = [];
  shot.captionClips = [];
  shot.propertyTracks = shot.propertyTracks.filter(({ target }) => target.kind !== "audio");
  return ProjectDocumentSchema.parse(project);
}

const audio = {
  id: "audio-media-operations",
  assetId: "asset-media-operations",
  name: "Narration",
  start: 2,
  duration: 6,
  sourceStart: 1,
  sourceEnd: 7,
  volume: 0.8,
  muted: false,
  solo: false,
  fadeIn: 0.5,
  fadeOut: 0.75,
} as const;

test("adds and exactly replaces an audio clip for move, trim, mute, solo, volume, and fades", () => {
  const project = projectWithMedia();
  const added = applyDocumentOperations(project, [{ type: "add-audio-clip", shotId: project.shots[0].id, clip: audio }]).project;
  const replacement = {
    ...added.shots[0].audioClips[0],
    start: 3,
    duration: 4,
    sourceStart: 2,
    sourceEnd: 6,
    volume: 1.25,
    muted: true,
    solo: true,
    fadeIn: 1,
    fadeOut: 1.5,
  };
  const updated = applyDocumentOperations(added, [{
    type: "replace-audio-clip",
    shotId: added.shots[0].id,
    audioClipId: audio.id,
    clip: replacement,
  }]).project;
  expect(updated.shots[0].audioClips).toEqual([replacement]);
});

test("authors an exact audio volume keyframe through the shared keyframe authority", () => {
  const project = applyDocumentOperations(projectWithMedia(), [{
    type: "add-audio-clip",
    shotId: projectWithMedia().shots[0].id,
    clip: audio,
  }]).project;
  const intent = resolveUpsertKeyframe(project, project.shots[0].id, {
    target: { kind: "audio", audioClipId: audio.id },
    property: "volume",
    time: 3.5,
    value: 0.4,
  });
  expect(intent.ok).toBe(true);
  if (!intent.ok) throw new Error(intent.message);
  const updated = applyOperations(project, project.shots[0].id, intent.operations).project;
  expect(updated.shots[0].propertyTracks).toEqual(expect.arrayContaining([
    expect.objectContaining({
      target: { kind: "audio", audioClipId: audio.id },
      property: "volume",
      keyframes: [expect.objectContaining({ time: 3.5, value: 0.4 })],
    }),
  ]));
});

test("splits an un-faded clip proportionally and refuses envelope/keyframe loss atomically", () => {
  const plain = { ...audio, fadeIn: 0, fadeOut: 0, sourceStart: 4, sourceEnd: 16 };
  const project = applyDocumentOperations(projectWithMedia(), [{
    type: "add-audio-clip",
    shotId: projectWithMedia().shots[0].id,
    clip: plain,
  }]).project;
  const split = applyDocumentOperations(project, [{
    type: "split-audio-clip",
    shotId: project.shots[0].id,
    audioClipId: audio.id,
    time: 4,
    rightClipId: "audio-media-operations-right",
  }]).project;
  expect(split.shots[0].audioClips).toEqual([
    expect.objectContaining({ id: audio.id, start: 2, duration: 2, sourceStart: 4, sourceEnd: 8 }),
    expect.objectContaining({ id: "audio-media-operations-right", start: 4, duration: 4, sourceStart: 8, sourceEnd: 16 }),
  ]);

  const faded = applyDocumentOperations(projectWithMedia(), [{
    type: "add-audio-clip",
    shotId: projectWithMedia().shots[0].id,
    clip: audio,
  }]).project;
  expect(() => applyDocumentOperations(faded, [{
    type: "split-audio-clip",
    shotId: faded.shots[0].id,
    audioClipId: audio.id,
    time: 4,
    rightClipId: "audio-media-operations-refused",
  }])).toThrow(/Remove audio fades/);
  expect(faded.shots[0].audioClips).toEqual([audio]);

  const keyframed = applyOperations(project, project.shots[0].id, [{
    type: "add-property-track",
    track: {
      id: "track-media-volume",
      target: { kind: "audio", audioClipId: audio.id },
      property: "volume",
      keyframes: [{ id: "keyframe-media-volume", time: 3, value: 0.5, interpolation: { kind: "linear" } }],
    },
  }]).project;
  expect(() => applyDocumentOperations(keyframed, [{
    type: "split-audio-clip",
    shotId: keyframed.shots[0].id,
    audioClipId: audio.id,
    time: 4,
    rightClipId: "audio-media-keyframed-right",
  }])).toThrow(/volume keyframes/);
});

test("deleting audio also removes its volume authority and remains one atomic validated edit", () => {
  const project = applyDocumentOperations(projectWithMedia(), [{
    type: "add-audio-clip",
    shotId: projectWithMedia().shots[0].id,
    clip: audio,
  }]).project;
  const keyframed = applyOperations(project, project.shots[0].id, [{
    type: "add-property-track",
    track: {
      id: "track-media-delete",
      target: { kind: "audio", audioClipId: audio.id },
      property: "volume",
      keyframes: [{ id: "keyframe-media-delete", time: 3, value: 0.5, interpolation: { kind: "linear" } }],
    },
  }]).project;
  const deleted = applyDocumentOperations(keyframed, [{ type: "delete-audio-clip", shotId: keyframed.shots[0].id, audioClipId: audio.id }]).project;
  expect(deleted.shots[0].audioClips).toEqual([]);
  expect(deleted.shots[0].propertyTracks.some(({ target }) => target.kind === "audio")).toBe(false);
});

test("adds, edits, splits, and deletes line-break-preserving styled captions", () => {
  const project = projectWithMedia();
  const clip = {
    id: "caption-media-operations",
    start: 1,
    end: 5,
    text: "A countable union\ncan still be null",
    style: { color: "#ffffff", background: "#111111", fontSize: 34, position: "bottom" as const },
  };
  const added = applyDocumentOperations(project, [{ type: "add-caption", shotId: project.shots[0].id, clip }]).project;
  const replacement = { ...clip, text: "Edited\ncaption", style: { ...clip.style, position: "top" as const } };
  const replaced = applyDocumentOperations(added, [{
    type: "replace-caption",
    shotId: added.shots[0].id,
    captionId: clip.id,
    clip: replacement,
  }]).project;
  const split = applyDocumentOperations(replaced, [{
    type: "split-caption",
    shotId: replaced.shots[0].id,
    captionId: clip.id,
    time: 3,
    rightCaptionId: "caption-media-operations-right",
  }]).project;
  expect(split.shots[0].captionClips).toEqual([
    { ...replacement, end: 3 },
    { ...replacement, id: "caption-media-operations-right", start: 3 },
  ]);
  const deleted = applyDocumentOperations(split, [{
    type: "delete-caption",
    shotId: split.shots[0].id,
    captionId: clip.id,
  }]).project;
  expect(deleted.shots[0].captionClips.map(({ id }) => id)).toEqual(["caption-media-operations-right"]);
});

test("media operations reject missing assets, invalid ranges, ID reuse, and mismatched replacements without mutating input", () => {
  const project = projectWithMedia();
  const before = cloneSerializable(project);
  const invalid = { ...audio, assetId: "asset-missing" };
  expect(() => applyDocumentOperations(project, [{ type: "add-audio-clip", shotId: project.shots[0].id, clip: invalid }]))
    .toThrow(DocumentOperationValidationError);
  expect(() => applyDocumentOperations(project, [{
    type: "add-caption",
    shotId: project.shots[0].id,
    clip: { id: project.shots[0].id, start: 1, end: 2, text: "collision", style: {} },
  }])).toThrow(/ID already exists/);
  const added = applyDocumentOperations(project, [{ type: "add-audio-clip", shotId: project.shots[0].id, clip: audio }]).project;
  expect(() => applyDocumentOperations(added, [{
    type: "replace-audio-clip",
    shotId: added.shots[0].id,
    audioClipId: audio.id,
    clip: { ...audio, id: "audio-other" },
  }])).toThrow(/preserve its stable ID/);
  expect(project).toEqual(before);
});
