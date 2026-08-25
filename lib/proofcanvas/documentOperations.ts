import { z } from "zod";
import { allocateId, collectProjectIds, collectShotIds } from "./ids";
import { addTimelineTimes, compareTimelineTimes, logicalFrameFor, resolutionFor, subtractTimelineTimes } from "./frame";
import { firstVisibilityAnimationByTarget, previewShotAtTime } from "./preview";
import { effectiveObjectLifetime, propertyTrackKey, samplePropertyTrack } from "./timeline";
import {
  AspectRatioSchema,
  CustomEasingPresetSchema,
  FrameRateSchema,
  PositiveTimelineDurationSchema,
  PreviewQualitySchema,
  ProjectDocumentSchema,
  ResolutionPresetSchema,
  ShotSchema,
  StylePackSchema,
  TimelineMarkerSchema,
  animationAuthoringCompatibilityIssue,
  cloneSerializable,
  type PropertyKeyframe,
  type PropertyTrack,
  type ProjectDocument,
  type SceneObject,
  type Shot,
} from "./schema";

const ProjectSettingsInputSchema = z.object({
  aspectRatio: AspectRatioSchema,
  frameRate: FrameRateSchema,
  renderPreset: ResolutionPresetSchema,
  previewQuality: PreviewQualitySchema,
}).strict();

const ShotPatchSchema = z.object({
  name: ShotSchema.shape.name.optional(),
  duration: ShotSchema.shape.duration.optional(),
}).strict();

const MarkerPatchSchema = z.object({
  time: TimelineMarkerSchema.shape.time.optional(),
  name: TimelineMarkerSchema.shape.name.optional(),
  color: TimelineMarkerSchema.shape.color.optional(),
}).strict();

const AuthorableShotSchema = ShotSchema.superRefine((shot, context) => {
  shot.animations.forEach((animation, index) => {
    const issue = animationAuthoringCompatibilityIssue(animation);
    if (issue) context.addIssue({ code: "custom", path: ["animations", index, "easing"], message: issue });
  });
});

export const DocumentOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rename-project"), title: ProjectDocumentSchema.shape.metadata.shape.title }).strict(),
  z.object({
    type: z.literal("set-project-settings"),
    settings: ProjectSettingsInputSchema,
    cameraPolicy: z.enum(["preserve", "recenter-default"]),
  }).strict(),
  z.object({ type: z.literal("add-shot"), shot: AuthorableShotSchema, index: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal("update-shot"), shotId: ShotSchema.shape.id, patch: ShotPatchSchema }).strict(),
  z.object({ type: z.literal("delete-shot"), shotId: ShotSchema.shape.id }).strict(),
  z.object({ type: z.literal("reorder-shot"), shotId: ShotSchema.shape.id, index: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("duplicate-shot"), shotId: ShotSchema.shape.id, name: ShotSchema.shape.name.optional() }).strict(),
  z.object({ type: z.literal("split-shot"), shotId: ShotSchema.shape.id, time: PositiveTimelineDurationSchema, rightName: ShotSchema.shape.name.optional() }).strict(),
  z.object({ type: z.literal("merge-shots"), leftShotId: ShotSchema.shape.id, rightShotId: ShotSchema.shape.id, name: ShotSchema.shape.name.optional() }).strict(),
  z.object({ type: z.literal("add-marker"), shotId: ShotSchema.shape.id, marker: TimelineMarkerSchema }).strict(),
  z.object({ type: z.literal("update-marker"), shotId: ShotSchema.shape.id, markerId: TimelineMarkerSchema.shape.id, patch: MarkerPatchSchema }).strict(),
  z.object({ type: z.literal("delete-marker"), shotId: ShotSchema.shape.id, markerId: TimelineMarkerSchema.shape.id }).strict(),
  z.object({ type: z.literal("add-style"), style: StylePackSchema, index: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal("replace-style"), styleId: StylePackSchema.shape.id, style: StylePackSchema }).strict(),
  z.object({ type: z.literal("delete-style"), styleId: StylePackSchema.shape.id, fallbackStyleId: StylePackSchema.shape.id.optional() }).strict(),
  z.object({ type: z.literal("add-custom-easing"), easing: CustomEasingPresetSchema }).strict(),
  z.object({ type: z.literal("replace-custom-easing"), easingId: CustomEasingPresetSchema.shape.id, easing: CustomEasingPresetSchema }).strict(),
  z.object({ type: z.literal("delete-custom-easing"), easingId: CustomEasingPresetSchema.shape.id }).strict(),
]);

export type DocumentOperation = z.infer<typeof DocumentOperationSchema>;

export class DocumentOperationValidationError extends Error {
  constructor(message: string, readonly operationIndex?: number) {
    super(operationIndex === undefined ? message : `Document operation ${operationIndex + 1}: ${message}`);
    this.name = "DocumentOperationValidationError";
  }
}

export interface DocumentOperationResult {
  project: ProjectDocument;
  applied: number;
  summary: string[];
  idMappings: DocumentIdMapping[];
}

/** A complete source-ID to surviving/new-ID relation for structural operations. */
export interface DocumentIdMapping {
  operationIndex: number;
  operationType: "duplicate-shot" | "split-shot" | "merge-shots";
  ids: Readonly<Record<string, readonly string[]>>;
}

interface AppliedDocumentOperation {
  summary: string;
  mapping?: Omit<DocumentIdMapping, "operationIndex">;
}

function shotById(project: ProjectDocument, shotId: string): Shot {
  const shot = project.shots.find(({ id }) => id === shotId);
  if (!shot) throw new DocumentOperationValidationError(`Shot not found: ${shotId}`);
  return shot;
}

function requireFreshId(project: ProjectDocument, id: string): void {
  if (collectProjectIds(project).has(id)) throw new DocumentOperationValidationError(`ID already exists: ${id}`);
}

function insertAt<T>(items: T[], item: T, index: number | undefined, label: string): void {
  const insertionIndex = index ?? items.length;
  if (insertionIndex > items.length) throw new DocumentOperationValidationError(`${label} index ${insertionIndex} is outside the collection`);
  items.splice(insertionIndex, 0, item);
}

function shotEntityIds(shot: Shot): string[] {
  return [
    shot.id,
    ...shot.objects.map(({ id }) => id),
    ...shot.animations.map(({ id }) => id),
    ...shot.audioClips.map(({ id }) => id),
    ...shot.captionClips.map(({ id }) => id),
    ...shot.markers.map(({ id }) => id),
    ...shot.propertyTracks.flatMap((track) => [track.id, ...track.keyframes.map(({ id }) => id)]),
  ];
}

function assertShotIdsAreFresh(project: ProjectDocument, shot: Shot): void {
  const entityIds = shotEntityIds(shot);
  if (new Set(entityIds).size !== entityIds.length) {
    throw new DocumentOperationValidationError("Added shot contains duplicate entity IDs");
  }
  const existing = collectProjectIds(project);
  const collision = entityIds.find((id) => existing.has(id));
  if (collision) throw new DocumentOperationValidationError(`ID already exists: ${collision}`);
}

function assertDurationCanShrink(shot: Shot, duration: number): void {
  const offenders: string[] = [];
  for (const object of shot.objects) {
    if (object.lifetime && compareTimelineTimes(object.lifetime.end, duration) > 0) offenders.push(`object lifetime ${object.id}`);
  }
  for (const animation of shot.animations) {
    if (compareTimelineTimes(addTimelineTimes(animation.start, animation.duration), duration) > 0) offenders.push(`animation ${animation.id}`);
  }
  for (const track of shot.propertyTracks) {
    if (track.keyframes.some((keyframe) => compareTimelineTimes(keyframe.time, duration) > 0)) offenders.push(`property track ${track.id}`);
  }
  for (const clip of shot.audioClips) {
    if (compareTimelineTimes(addTimelineTimes(clip.start, clip.duration), duration) > 0) offenders.push(`audio clip ${clip.id}`);
  }
  for (const clip of shot.captionClips) {
    if (compareTimelineTimes(clip.end, duration) > 0) offenders.push(`caption ${clip.id}`);
  }
  for (const marker of shot.markers) {
    if (compareTimelineTimes(marker.time, duration) > 0) offenders.push(`marker ${marker.id}`);
  }
  if (offenders.length) {
    throw new DocumentOperationValidationError(`Shot duration would truncate ${offenders.join(", ")}`);
  }
}

function applied(summary: string, mapping?: AppliedDocumentOperation["mapping"]): AppliedDocumentOperation {
  return mapping ? { summary, mapping } : { summary };
}

function assertAnimationsCanBeStructurallyCopied(shots: readonly Shot[]): void {
  for (const shot of shots) {
    const unsupported = shot.animations.find((animation) => animationAuthoringCompatibilityIssue(animation));
    if (unsupported) {
      throw new DocumentOperationValidationError(`Shot ${shot.name} contains legacy render-unsupported animation ${unsupported.id}; repair its easing before duplicating, splitting, or merging`);
    }
  }
}

function applyOne(project: ProjectDocument, operation: DocumentOperation): AppliedDocumentOperation {
  switch (operation.type) {
    case "rename-project":
      project.metadata.title = operation.title;
      return applied(`Renamed project to ${operation.title}`);
    case "set-project-settings": {
      const previousFrame = logicalFrameFor(project.settings.aspectRatio);
      const nextFrame = logicalFrameFor(operation.settings.aspectRatio);
      if (operation.cameraPolicy === "recenter-default") {
        for (const shot of project.shots) {
          const hasAuthoredCameraMotion = shot.animations.some(({ type }) => type === "camera-focus")
            || shot.propertyTracks.some(({ target }) => target.kind === "camera");
          const isDefaultCamera = shot.camera.x === previousFrame.centerX
            && shot.camera.y === previousFrame.centerY
            && shot.camera.zoom === 1
            && shot.camera.rotation === 0;
          if (isDefaultCamera && !hasAuthoredCameraMotion) {
            shot.camera.x = nextFrame.centerX;
            shot.camera.y = nextFrame.centerY;
          }
        }
      }
      project.settings = {
        ...cloneSerializable(operation.settings),
        resolution: resolutionFor(operation.settings.aspectRatio, operation.settings.renderPreset),
      };
      return applied(`Updated project settings to ${operation.settings.aspectRatio} ${operation.settings.frameRate}fps`);
    }
    case "add-shot": {
      assertShotIdsAreFresh(project, operation.shot);
      insertAt(project.shots, cloneSerializable(operation.shot), operation.index, "Shot");
      return applied(`Added shot ${operation.shot.name}`);
    }
    case "update-shot": {
      const shot = shotById(project, operation.shotId);
      if (operation.patch.duration !== undefined && compareTimelineTimes(operation.patch.duration, shot.duration) < 0) {
        assertDurationCanShrink(shot, operation.patch.duration);
      }
      if (operation.patch.name !== undefined) shot.name = operation.patch.name;
      if (operation.patch.duration !== undefined) shot.duration = operation.patch.duration;
      return applied(`Updated shot ${shot.name}`);
    }
    case "delete-shot": {
      const shot = shotById(project, operation.shotId);
      if (project.shots.length === 1) throw new DocumentOperationValidationError("A project must retain at least one shot");
      project.shots = project.shots.filter(({ id }) => id !== shot.id);
      return applied(`Deleted shot ${shot.name}`);
    }
    case "reorder-shot": {
      const shot = shotById(project, operation.shotId);
      const remaining = project.shots.filter(({ id }) => id !== shot.id);
      if (operation.index > remaining.length) throw new DocumentOperationValidationError(`Shot index ${operation.index} is outside the project`);
      remaining.splice(operation.index, 0, shot);
      project.shots = remaining;
      return applied(`Moved shot ${shot.name} to position ${operation.index + 1}`);
    }
    case "duplicate-shot": {
      assertAnimationsCanBeStructurallyCopied([shotById(project, operation.shotId)]);
      const duplicate = buildDuplicateShot(project, operation.shotId, operation.name);
      project.shots.splice(duplicate.index, 0, duplicate.shot);
      return applied(`Duplicated shot ${shotById(project, operation.shotId).name}`, {
        operationType: "duplicate-shot",
        ids: mappingRecord(duplicate.mapping),
      });
    }
    case "split-shot": {
      assertAnimationsCanBeStructurallyCopied([shotById(project, operation.shotId)]);
      const split = buildSplitShot(project, operation.shotId, operation.time, operation.rightName);
      const index = project.shots.findIndex(({ id }) => id === operation.shotId);
      project.shots.splice(index, 1, split.left, split.right);
      return applied(`Split shot ${split.left.name} at ${operation.time}s`, {
        operationType: "split-shot",
        ids: mappingRecord(split.mapping),
      });
    }
    case "merge-shots": {
      assertAnimationsCanBeStructurallyCopied([shotById(project, operation.leftShotId), shotById(project, operation.rightShotId)]);
      const merge = buildMergedShot(project, operation.leftShotId, operation.rightShotId, operation.name);
      const index = project.shots.findIndex(({ id }) => id === operation.leftShotId);
      project.shots.splice(index, 2, merge.shot);
      return applied(`Merged shots into ${merge.shot.name}`, {
        operationType: "merge-shots",
        ids: mappingRecord(merge.mapping),
      });
    }
    case "add-marker": {
      const shot = shotById(project, operation.shotId);
      requireFreshId(project, operation.marker.id);
      shot.markers.push(cloneSerializable(operation.marker));
      shot.markers.sort((left, right) => compareTimelineTimes(left.time, right.time) || left.id.localeCompare(right.id));
      return applied(`Added marker ${operation.marker.name}`);
    }
    case "update-marker": {
      const shot = shotById(project, operation.shotId);
      const marker = shot.markers.find(({ id }) => id === operation.markerId);
      if (!marker) throw new DocumentOperationValidationError(`Marker not found: ${operation.markerId}`);
      Object.assign(marker, cloneSerializable(operation.patch));
      shot.markers.sort((left, right) => compareTimelineTimes(left.time, right.time) || left.id.localeCompare(right.id));
      return applied(`Updated marker ${marker.name}`);
    }
    case "delete-marker": {
      const shot = shotById(project, operation.shotId);
      const marker = shot.markers.find(({ id }) => id === operation.markerId);
      if (!marker) throw new DocumentOperationValidationError(`Marker not found: ${operation.markerId}`);
      shot.markers = shot.markers.filter(({ id }) => id !== marker.id);
      return applied(`Deleted marker ${marker.name}`);
    }
    case "add-style":
      requireFreshId(project, operation.style.id);
      insertAt(project.styles, cloneSerializable(operation.style), operation.index, "Style");
      return applied(`Added style ${operation.style.name}`);
    case "replace-style": {
      if (operation.style.id !== operation.styleId) throw new DocumentOperationValidationError("Replacement style must preserve its stable ID");
      const index = project.styles.findIndex(({ id }) => id === operation.styleId);
      if (index < 0) throw new DocumentOperationValidationError(`Style not found: ${operation.styleId}`);
      project.styles[index] = cloneSerializable(operation.style);
      return applied(`Updated style ${operation.style.name}`);
    }
    case "delete-style": {
      const style = project.styles.find(({ id }) => id === operation.styleId);
      if (!style) throw new DocumentOperationValidationError(`Style not found: ${operation.styleId}`);
      if (project.styles.length === 1) throw new DocumentOperationValidationError("A project must retain at least one style");
      const fallback = operation.fallbackStyleId
        ? project.styles.find(({ id }) => id === operation.fallbackStyleId)
        : undefined;
      if (operation.fallbackStyleId && (!fallback || fallback.id === style.id)) {
        throw new DocumentOperationValidationError("Style fallback must identify a different existing style");
      }
      if (project.activeStyleId === style.id) {
        if (!fallback) throw new DocumentOperationValidationError("Deleting the active style requires an explicit fallback style");
        project.activeStyleId = fallback.id;
      }
      project.styles = project.styles.filter(({ id }) => id !== style.id);
      return applied(`Deleted style ${style.name}`);
    }
    case "add-custom-easing":
      requireFreshId(project, operation.easing.id);
      project.customEasings.push(cloneSerializable(operation.easing));
      return applied(`Added easing ${operation.easing.name}`);
    case "replace-custom-easing": {
      if (operation.easing.id !== operation.easingId) throw new DocumentOperationValidationError("Replacement easing must preserve its stable ID");
      const index = project.customEasings.findIndex(({ id }) => id === operation.easingId);
      if (index < 0) throw new DocumentOperationValidationError(`Custom easing not found: ${operation.easingId}`);
      project.customEasings[index] = cloneSerializable(operation.easing);
      return applied(`Updated easing ${operation.easing.name}`);
    }
    case "delete-custom-easing": {
      const easing = project.customEasings.find(({ id }) => id === operation.easingId);
      if (!easing) throw new DocumentOperationValidationError(`Custom easing not found: ${operation.easingId}`);
      project.customEasings = project.customEasings.filter(({ id }) => id !== easing.id);
      return applied(`Deleted easing ${easing.name}`);
    }
  }
}

/** Apply a bounded document-level transaction atomically, outside the AI scene-operation dialect. */
export function applyDocumentOperations(
  project: ProjectDocument,
  operations: readonly DocumentOperation[],
): DocumentOperationResult {
  if (!operations.length) throw new DocumentOperationValidationError("A transaction must contain at least one document operation");
  const next = ProjectDocumentSchema.parse(cloneSerializable(project));
  const summary: string[] = [];
  const idMappings: DocumentIdMapping[] = [];
  operations.forEach((candidate, index) => {
    try {
      const result = applyOne(next, DocumentOperationSchema.parse(candidate));
      summary.push(result.summary);
      if (result.mapping) idMappings.push({ operationIndex: index, ...result.mapping });
    } catch (error) {
      if (error instanceof DocumentOperationValidationError) {
        throw new DocumentOperationValidationError(error.message, index);
      }
      throw new DocumentOperationValidationError(error instanceof Error ? error.message : "Malformed document operation", index);
    }
  });
  try {
    const parsed = ProjectDocumentSchema.parse(next);
    return {
      project: parsed,
      applied: operations.length,
      summary,
      idMappings: mappingsToFinalIds(
        idMappings,
        new Set(parsed.shots.flatMap((shot) => shotEntityIds(shot))),
      ),
    };
  } catch (error) {
    throw new DocumentOperationValidationError(error instanceof Error ? `Resulting project is invalid: ${error.message}` : "Resulting project is invalid");
  }
}

function boundedHint(value: string): string {
  return value.slice(0, 40);
}

function copiedName(value: string, maximum: number): string {
  const suffix = " copy";
  return `${value.slice(0, maximum - suffix.length)}${suffix}`;
}

function remapObjectPropertyReferences(
  object: SceneObject,
  mapping: ReadonlyMap<string, string>,
): SceneObject["properties"] {
  const properties = cloneSerializable(object.properties);
  // Object properties are intentionally open-ended. Only remap references
  // declared by a component contract; names such as `externalId` or `assetId`
  // are opaque author data and may legally collide with scene-object IDs.
  if (object.semanticRole === "annotation-arrow" && typeof properties.targetId === "string") {
    properties.targetId = mapping.get(properties.targetId) ?? properties.targetId;
  }
  return properties;
}

type MutableIdMapping = Map<string, string[]>;

function setMapping(mapping: MutableIdMapping, sourceId: string, ...targetIds: string[]): void {
  mapping.set(sourceId, [...new Set(targetIds)]);
}

function mappingRecord(mapping: MutableIdMapping): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries([...mapping].sort(([left], [right]) => left.localeCompare(right)).map(([id, targets]) => [id, [...targets]]));
}

function mappingsToFinalIds(
  mappings: readonly DocumentIdMapping[],
  finalIds: ReadonlySet<string>,
): DocumentIdMapping[] {
  return mappings.map((mapping, mappingIndex) => ({
    ...mapping,
    ids: Object.fromEntries(Object.entries(mapping.ids).map(([sourceId, immediateTargets]) => {
      let targets = [...immediateTargets];
      for (const later of mappings.slice(mappingIndex + 1)) {
        targets = targets.flatMap((targetId) => later.ids[targetId] ?? [targetId]);
        targets = [...new Set(targets)];
      }
      return [sourceId, targets.filter((targetId) => finalIds.has(targetId))];
    })),
  }));
}

interface BuiltDuplicateShot {
  shot: Shot;
  index: number;
  mapping: MutableIdMapping;
}

function buildDuplicateShot(project: ProjectDocument, shotId: string, name?: string): BuiltDuplicateShot {
  const source = shotById(project, shotId);
  const existing = collectProjectIds(project);
  const scalarMapping = new Map<string, string>();
  const mapping: MutableIdMapping = new Map();
  const reserve = (oldId: string, prefix: string, hint: string) => {
    const nextId = allocateId(prefix, existing, boundedHint(hint));
    existing.add(nextId);
    scalarMapping.set(oldId, nextId);
    setMapping(mapping, oldId, nextId);
  };
  reserve(source.id, "shot", `${source.name}-copy`);
  source.objects.forEach((object) => reserve(object.id, object.type === "group" ? "group" : "object", object.name));
  source.animations.forEach((animation) => reserve(animation.id, "animation", animation.id));
  source.audioClips.forEach((clip) => reserve(clip.id, "audio", clip.name));
  source.captionClips.forEach((clip) => reserve(clip.id, "caption", clip.id));
  source.markers.forEach((marker) => reserve(marker.id, "marker", marker.name));
  source.propertyTracks.forEach((track) => {
    reserve(track.id, "track", track.id);
    track.keyframes.forEach((keyframe) => reserve(keyframe.id, "keyframe", keyframe.id));
  });

  const shot = cloneSerializable(source);
  shot.id = scalarMapping.get(source.id)!;
  shot.name = name?.trim() || copiedName(source.name, 120);
  shot.objects = shot.objects.map((object) => ({
    ...object,
    id: scalarMapping.get(object.id)!,
    ...(object.parentId ? { parentId: scalarMapping.get(object.parentId)! } : {}),
    properties: remapObjectPropertyReferences(object, scalarMapping),
  }));
  shot.animations = shot.animations.map((animation) => ({
    ...animation,
    id: scalarMapping.get(animation.id)!,
    targetIds: animation.targetIds.map((id) => scalarMapping.get(id)!),
  }));
  shot.audioClips = shot.audioClips.map((clip) => ({ ...clip, id: scalarMapping.get(clip.id)! }));
  shot.captionClips = shot.captionClips.map((clip) => ({ ...clip, id: scalarMapping.get(clip.id)! }));
  shot.markers = shot.markers.map((marker) => ({ ...marker, id: scalarMapping.get(marker.id)! }));
  shot.propertyTracks = shot.propertyTracks.map((track) => ({
    ...track,
    id: scalarMapping.get(track.id)!,
    target: track.target.kind === "object"
      ? { kind: "object", objectId: scalarMapping.get(track.target.objectId)! }
      : track.target.kind === "audio"
        ? { kind: "audio", audioClipId: scalarMapping.get(track.target.audioClipId)! }
        : { kind: "camera" },
    keyframes: track.keyframes.map((keyframe) => ({ ...keyframe, id: scalarMapping.get(keyframe.id)! })),
  }));
  const sourceIndex = project.shots.findIndex(({ id }) => id === source.id);
  return { shot: ShotSchema.parse(shot), index: sourceIndex + 1, mapping };
}

/** Build a typed duplicate operation; the applied result exposes the complete ID mapping. */
export function duplicateShotOperation(
  project: ProjectDocument,
  shotId: string,
  name?: string,
): Extract<DocumentOperation, { type: "duplicate-shot" }> {
  shotById(project, shotId);
  return DocumentOperationSchema.parse({ type: "duplicate-shot", shotId, ...(name ? { name } : {}) }) as Extract<DocumentOperation, { type: "duplicate-shot" }>;
}

function sourceLifetime(object: SceneObject, duration: number): { start: number; end: number } {
  return object.lifetime ?? { start: 0, end: duration };
}

function normalizedLifetime(start: number, end: number, duration: number): SceneObject["lifetime"] {
  if (compareTimelineTimes(start, 0) <= 0 && compareTimelineTimes(end, duration) >= 0) return undefined;
  return {
    start: compareTimelineTimes(start, 0) < 0 ? 0 : start,
    end: compareTimelineTimes(end, duration) > 0 ? duration : end,
  };
}

function referencedObjectIds(object: SceneObject, objectIds: ReadonlySet<string>): ReadonlySet<string> {
  const result = new Set<string>();
  if (
    object.semanticRole === "annotation-arrow"
    && typeof object.properties.targetId === "string"
    && objectIds.has(object.properties.targetId)
  ) {
    result.add(object.properties.targetId);
  }
  return result;
}

function animationAffectsObject(shot: Shot, animation: Shot["animations"][number], objectId: string): boolean {
  const objects = new Map(shot.objects.map((object) => [object.id, object]));
  let cursor = objects.get(objectId);
  const family = new Set<string>();
  while (cursor && !family.has(cursor.id)) {
    family.add(cursor.id);
    cursor = cursor.parentId ? objects.get(cursor.parentId) : undefined;
  }
  return animation.targetIds.some((targetId) => family.has(targetId));
}

function targetOnRight(track: PropertyTrack, objectMapping: ReadonlyMap<string, string>): PropertyTrack["target"] {
  if (track.target.kind === "object") return { kind: "object", objectId: objectMapping.get(track.target.objectId) ?? track.target.objectId };
  if (track.target.kind === "audio") return { kind: "audio", audioClipId: track.target.audioClipId };
  return { kind: "camera" };
}

interface SplitTrackResult {
  left?: PropertyTrack;
  right?: PropertyTrack;
}

function splitPropertyTrack(
  track: PropertyTrack,
  boundary: number,
  rightDuration: number,
  existing: Set<string>,
  objectMapping: ReadonlyMap<string, string>,
  mapping: MutableIdMapping,
): SplitTrackResult {
  const before = track.keyframes.filter(({ time }) => compareTimelineTimes(time, boundary) < 0);
  const exact = track.keyframes.find(({ time }) => compareTimelineTimes(time, boundary) === 0);
  const after = track.keyframes.filter(({ time }) => compareTimelineTimes(time, boundary) > 0);
  if (!before.length && !exact) {
    setMapping(mapping, track.id, track.id);
    track.keyframes.forEach(({ id }) => setMapping(mapping, id, id));
    return {
      right: {
        ...cloneSerializable(track),
        target: targetOnRight(track, objectMapping),
        keyframes: track.keyframes.map((keyframe) => ({ ...cloneSerializable(keyframe), time: subtractTimelineTimes(keyframe.time, boundary) })),
      },
    };
  }
  if (!after.length && !exact) {
    setMapping(mapping, track.id, track.id);
    track.keyframes.forEach(({ id }) => setMapping(mapping, id, id));
    return { left: cloneSerializable(track) };
  }
  if (exact && !before.length) {
    setMapping(mapping, track.id, track.id);
    track.keyframes.forEach(({ id }) => setMapping(mapping, id, id));
    return {
      right: {
        ...cloneSerializable(track),
        target: targetOnRight(track, objectMapping),
        keyframes: [exact, ...after].map((keyframe) => ({ ...cloneSerializable(keyframe), time: subtractTimelineTimes(keyframe.time, boundary) })),
      },
    };
  }
  if (exact && !after.length) {
    setMapping(mapping, track.id, track.id);
    track.keyframes.forEach(({ id }) => setMapping(mapping, id, id));
    return { left: cloneSerializable(track) };
  }

  const segmentLeft = before.at(-1)!;
  if (!exact && (
    compareTimelineTimes(boundary, segmentLeft.time) <= 0
    || compareTimelineTimes(after[0].time, boundary) <= 0
  )) {
    throw new DocumentOperationValidationError(`Property track ${track.id} would create a sub-minimum keyframe interval at the split boundary`);
  }
  if (!exact && segmentLeft.interpolation.kind !== "linear" && segmentLeft.interpolation.kind !== "hold") {
    throw new DocumentOperationValidationError(`Property track ${track.id} crosses the split inside a ${segmentLeft.interpolation.kind} segment`);
  }
  if (!exact && segmentLeft.interpolation.kind === "linear") {
    const segmentRight = after[0];
    const colorSegment = typeof segmentLeft.value === "string" || typeof segmentRight?.value === "string";
    const signedScaleSegment = ["scale", "scaleX", "scaleY"].includes(track.property)
      && typeof segmentLeft.value === "number"
      && typeof segmentRight?.value === "number"
      && Math.sign(segmentLeft.value) !== Math.sign(segmentRight.value);
    if (colorSegment || signedScaleSegment) {
      throw new DocumentOperationValidationError(
        `Property track ${track.id} crosses the split inside a non-affine ${colorSegment ? "color" : "signed-scale"} segment`,
      );
    }
  }
  const sampled = samplePropertyTrack(track, boundary);
  const rightTrackId = allocateId("track", existing, `${track.id}-right`);
  existing.add(rightTrackId);
  const boundaryLeftId = exact?.id ?? allocateId("keyframe", existing, `${track.id}-split-left`);
  if (!exact) existing.add(boundaryLeftId);
  const boundaryRightId = allocateId("keyframe", existing, `${track.id}-split-right`);
  existing.add(boundaryRightId);
  const boundaryInterpolation = exact?.interpolation ?? segmentLeft.interpolation;
  const leftBoundary: PropertyKeyframe = exact
    ? cloneSerializable(exact)
    : { id: boundaryLeftId, time: boundary, value: sampled, interpolation: { kind: "linear" } };
  const rightBoundary: PropertyKeyframe = {
    id: boundaryRightId,
    time: 0,
    value: sampled,
    interpolation: cloneSerializable(boundaryInterpolation),
  };
  setMapping(mapping, track.id, track.id, rightTrackId);
  before.forEach(({ id }) => setMapping(mapping, id, id));
  after.forEach(({ id }) => setMapping(mapping, id, id));
  if (exact) setMapping(mapping, exact.id, exact.id, boundaryRightId);
  return {
    left: { ...cloneSerializable(track), keyframes: [...before.map(cloneSerializable), leftBoundary] },
    right: {
      ...cloneSerializable(track),
      id: rightTrackId,
      target: targetOnRight(track, objectMapping),
      keyframes: [rightBoundary, ...after.map((keyframe) => ({ ...cloneSerializable(keyframe), time: subtractTimelineTimes(keyframe.time, boundary) }))],
    },
  };
}

interface BuiltSplitShot {
  left: Shot;
  right: Shot;
  mapping: MutableIdMapping;
}

function buildSplitShot(project: ProjectDocument, shotId: string, boundary: number, rightName?: string): BuiltSplitShot {
  const source = shotById(project, shotId);
  if (compareTimelineTimes(boundary, 0) <= 0 || compareTimelineTimes(boundary, source.duration) >= 0) {
    throw new DocumentOperationValidationError("Split time must be strictly inside the shot");
  }
  const crossingAnimation = source.animations.find((animation) => (
    compareTimelineTimes(animation.start, boundary) < 0
    && compareTimelineTimes(addTimelineTimes(animation.start, animation.duration), boundary) > 0
  ));
  if (crossingAnimation) throw new DocumentOperationValidationError(`Animation ${crossingAnimation.id} crosses the split boundary`);
  const crossingAudio = source.audioClips.find((clip) => compareTimelineTimes(clip.start, boundary) < 0 && compareTimelineTimes(addTimelineTimes(clip.start, clip.duration), boundary) > 0);
  if (crossingAudio) throw new DocumentOperationValidationError(`Audio clip ${crossingAudio.id} crosses the split boundary`);
  const crossingCaption = source.captionClips.find((clip) => compareTimelineTimes(clip.start, boundary) < 0 && compareTimelineTimes(clip.end, boundary) > 0);
  if (crossingCaption) throw new DocumentOperationValidationError(`Caption ${crossingCaption.id} crosses the split boundary`);

  const leftSourceIds = new Set<string>();
  const rightSourceIds = new Set<string>();
  const spanningIds = new Set<string>();
  for (const object of source.objects) {
    const lifetime = effectiveObjectLifetime(source, object.id)!;
    if (compareTimelineTimes(lifetime.start, boundary) < 0) leftSourceIds.add(object.id);
    if (compareTimelineTimes(lifetime.end, boundary) > 0) rightSourceIds.add(object.id);
    if (leftSourceIds.has(object.id) && rightSourceIds.has(object.id)) {
      if (compareTimelineTimes(boundary, lifetime.start) <= 0 || compareTimelineTimes(lifetime.end, boundary) <= 0) {
        throw new DocumentOperationValidationError(
          `Object ${object.id} would create a sub-minimum lifetime at the split boundary`,
        );
      }
      spanningIds.add(object.id);
    }
  }
  for (const object of source.objects.filter(({ id }) => rightSourceIds.has(id) && !leftSourceIds.has(id))) {
    const priorAnimation = source.animations.find((animation) => (
      compareTimelineTimes(addTimelineTimes(animation.start, animation.duration), boundary) <= 0
      && animationAffectsObject(source, animation, object.id)
    ));
    if (priorAnimation) {
      throw new DocumentOperationValidationError(
        `Animation ${priorAnimation.id} before the split affects post-boundary-only object ${object.id} through its hierarchy`,
      );
    }
    const priorTrack = source.propertyTracks.find((track) => (
      track.target.kind === "object"
      && compareTimelineTimes(track.keyframes[0].time, boundary) < 0
      && animationAffectsObject(source, {
        id: track.id,
        type: "transform",
        targetIds: [track.target.objectId],
        start: track.keyframes[0].time,
        duration: 0,
        easing: "linear",
        properties: {},
      }, object.id)
    ));
    if (priorTrack) {
      throw new DocumentOperationValidationError(
        `Property track ${priorTrack.id} before the split affects post-boundary-only object ${object.id} through its hierarchy`,
      );
    }
  }
  const firstVisibility = firstVisibilityAnimationByTarget(source);
  const futureEntrance = [...leftSourceIds].map((objectId) => {
    const authority = firstVisibility.get(objectId);
    if (!authority || !["appear", "fade-in", "write", "create"].includes(authority.type)) return undefined;
    return source.animations.find((animation) => animation.id === authority.id && compareTimelineTimes(animation.start, boundary) >= 0);
  }).find((animation): animation is Shot["animations"][number] => Boolean(animation));
  if (futureEntrance) {
    throw new DocumentOperationValidationError(
      `Future entrance ${futureEntrance.id} determines pre-split hidden state and cannot be moved wholly to the right shot`,
    );
  }
  const completedVisibility = source.animations.find((animation) => (
    ["appear", "fade-in", "fade-out", "write", "create"].includes(animation.type)
    && compareTimelineTimes(addTimelineTimes(animation.start, animation.duration), boundary) <= 0
    && [...spanningIds].some((objectId) => animationAffectsObject(source, animation, objectId))
  ));
  if (completedVisibility) {
    throw new DocumentOperationValidationError(`Visibility animation ${completedVisibility.id} before the split cannot be baked without changing later entrance authority`);
  }
  const cascadingVisualProperties = new Set<PropertyTrack["property"]>(["fill", "stroke", "strokeWidth", "opacity"]);
  const completedCascadingTrack = source.propertyTracks.find((track) => {
    if (
      track.target.kind !== "object"
      || !cascadingVisualProperties.has(track.property)
      || compareTimelineTimes(track.keyframes.at(-1)!.time, boundary) > 0
    ) return false;
    const targetId = track.target.objectId;
    const property = track.property as "fill" | "stroke" | "strokeWidth" | "opacity";
    if (source.objects.find(({ id }) => id === targetId)?.type !== "group") return false;
    return [...spanningIds].some((objectId) => (
      objectId !== targetId
      && animationAffectsObject(source, {
        id: track.id,
        type: "transform",
        targetIds: [targetId],
        start: track.keyframes[0].time,
        duration: 0,
        easing: "linear",
        properties: {},
      }, objectId)
      && (
        source.objects.find(({ id }) => id === objectId)?.style[property] !== undefined
        || source.propertyTracks.some((candidate) => (
          candidate.id !== track.id
          && candidate.target.kind === "object"
          && candidate.property === property
          && compareTimelineTimes(candidate.keyframes.at(-1)!.time, boundary) <= 0
          && animationAffectsObject(source, {
            id: candidate.id,
            type: "transform",
            targetIds: [candidate.target.objectId],
            start: candidate.keyframes[0].time,
            duration: 0,
            easing: "linear",
            properties: {},
          }, objectId)
        ))
      )
    ));
  });
  if (completedCascadingTrack) {
    throw new DocumentOperationValidationError(
      `Completed group ${completedCascadingTrack.property} track ${completedCascadingTrack.id} cannot be removed at the split without re-exposing descendant visual authority`,
    );
  }
  const allObjectIds = new Set(source.objects.map(({ id }) => id));
  for (const object of source.objects) {
    const references = referencedObjectIds(object, allObjectIds);
    if (leftSourceIds.has(object.id) && [...references].some((id) => !leftSourceIds.has(id))) {
      throw new DocumentOperationValidationError(`Object ${object.id} references content that exists only after the split`);
    }
    if (rightSourceIds.has(object.id) && [...references].some((id) => !rightSourceIds.has(id))) {
      throw new DocumentOperationValidationError(`Object ${object.id} references content that exists only before the split`);
    }
  }

  const existing = collectProjectIds(project);
  const mapping: MutableIdMapping = new Map();
  const rightShotId = allocateId("shot", existing, `${source.name}-right`);
  existing.add(rightShotId);
  setMapping(mapping, source.id, source.id, rightShotId);
  const objectMapping = new Map<string, string>();
  for (const object of source.objects) {
    if (spanningIds.has(object.id)) {
      const id = allocateId(object.type === "group" ? "group" : "object", existing, `${object.name}-right`);
      existing.add(id);
      objectMapping.set(object.id, id);
      setMapping(mapping, object.id, object.id, id);
    } else setMapping(mapping, object.id, object.id);
  }
  const boundaryPreview = previewShotAtTime(source, boundary);
  const previewObjects = new Map(boundaryPreview.objects.map((object) => [object.id, object]));
  const leftObjects = source.objects.filter(({ id }) => leftSourceIds.has(id)).map((object) => {
    const clone = cloneSerializable(object);
    const lifetime = sourceLifetime(object, source.duration);
    clone.lifetime = normalizedLifetime(lifetime.start, compareTimelineTimes(lifetime.end, boundary) < 0 ? lifetime.end : boundary, boundary);
    return clone;
  });
  const rightDuration = subtractTimelineTimes(source.duration, boundary);
  const rightObjects = source.objects.filter(({ id }) => rightSourceIds.has(id)).map((object) => {
    const clone = cloneSerializable(object);
    const isSpanning = spanningIds.has(object.id);
    if (isSpanning) {
      clone.id = objectMapping.get(object.id)!;
      const preview = previewObjects.get(object.id)!;
      clone.transform = cloneSerializable(preview.transform);
      // Preserve the sparse authored inheritance map. Only a completed visual
      // track owned by this exact object must be baked; copying computed
      // preview style would turn inherited parent values into sticky child
      // overrides and break later authoring.
      for (const track of source.propertyTracks.filter((candidate) => (
        candidate.target.kind === "object"
        && candidate.target.objectId === object.id
        && ["fill", "stroke", "strokeWidth", "opacity"].includes(candidate.property)
        && compareTimelineTimes(candidate.keyframes.at(-1)!.time, boundary) <= 0
      ))) {
        clone.style = { ...clone.style, [track.property]: samplePropertyTrack(track, boundary) };
      }
    }
    if (clone.parentId) clone.parentId = objectMapping.get(clone.parentId) ?? clone.parentId;
    clone.properties = remapObjectPropertyReferences(object, objectMapping);
    const lifetime = sourceLifetime(object, source.duration);
    clone.lifetime = normalizedLifetime(
      subtractTimelineTimes(compareTimelineTimes(lifetime.start, boundary) < 0 ? boundary : lifetime.start, boundary),
      subtractTimelineTimes(lifetime.end, boundary),
      rightDuration,
    );
    return clone;
  });

  const leftAnimations: Shot["animations"] = [];
  const rightAnimations: Shot["animations"] = [];
  for (const animation of source.animations) {
    setMapping(mapping, animation.id, animation.id);
    if (compareTimelineTimes(animation.start, boundary) >= 0) {
      rightAnimations.push({
        ...cloneSerializable(animation),
        start: subtractTimelineTimes(animation.start, boundary),
        targetIds: animation.targetIds.map((id) => objectMapping.get(id) ?? id),
      });
    } else leftAnimations.push(cloneSerializable(animation));
  }

  const leftTracks: PropertyTrack[] = [];
  const rightTracks: PropertyTrack[] = [];
  for (const track of source.propertyTracks) {
    const result = splitPropertyTrack(track, boundary, rightDuration, existing, objectMapping, mapping);
    if (result.left) leftTracks.push(result.left);
    if (result.right) rightTracks.push(result.right);
  }
  const leftAudio = source.audioClips.filter((clip) => compareTimelineTimes(clip.start, boundary) < 0).map((clip) => {
    setMapping(mapping, clip.id, clip.id);
    return cloneSerializable(clip);
  });
  const rightAudio = source.audioClips.filter((clip) => compareTimelineTimes(clip.start, boundary) >= 0).map((clip) => {
    setMapping(mapping, clip.id, clip.id);
    return { ...cloneSerializable(clip), start: subtractTimelineTimes(clip.start, boundary) };
  });
  const leftCaptions = source.captionClips.filter((clip) => compareTimelineTimes(clip.start, boundary) < 0).map((clip) => {
    setMapping(mapping, clip.id, clip.id);
    return cloneSerializable(clip);
  });
  const rightCaptions = source.captionClips.filter((clip) => compareTimelineTimes(clip.start, boundary) >= 0).map((clip) => {
    setMapping(mapping, clip.id, clip.id);
    return { ...cloneSerializable(clip), start: subtractTimelineTimes(clip.start, boundary), end: subtractTimelineTimes(clip.end, boundary) };
  });
  const leftMarkers = source.markers.filter((marker) => compareTimelineTimes(marker.time, boundary) < 0).map((marker) => {
    setMapping(mapping, marker.id, marker.id);
    return cloneSerializable(marker);
  });
  const rightMarkers = source.markers.filter((marker) => compareTimelineTimes(marker.time, boundary) >= 0).map((marker) => {
    setMapping(mapping, marker.id, marker.id);
    return { ...cloneSerializable(marker), time: subtractTimelineTimes(marker.time, boundary) };
  });
  const left = ShotSchema.parse({
    ...cloneSerializable(source),
    duration: boundary,
    objects: leftObjects,
    animations: leftAnimations,
    propertyTracks: leftTracks,
    audioClips: leftAudio,
    captionClips: leftCaptions,
    markers: leftMarkers,
  });
  const right = ShotSchema.parse({
    ...cloneSerializable(source),
    id: rightShotId,
    name: rightName?.trim() || `${source.name.slice(0, 106)} continuation`,
    duration: rightDuration,
    objects: rightObjects,
    animations: rightAnimations,
    propertyTracks: rightTracks,
    audioClips: rightAudio,
    captionClips: rightCaptions,
    markers: rightMarkers,
    camera: boundaryPreview.camera,
  });
  return { left, right, mapping };
}

function camerasEqual(left: Shot["camera"], right: Shot["camera"]): boolean {
  return (["x", "y", "zoom", "rotation"] as const).every((property) => left[property] === right[property]);
}

interface BuiltMergedShot {
  shot: Shot;
  mapping: MutableIdMapping;
}

function buildMergedShot(project: ProjectDocument, leftShotId: string, rightShotId: string, name?: string): BuiltMergedShot {
  const left = shotById(project, leftShotId);
  const right = shotById(project, rightShotId);
  const leftIndex = project.shots.findIndex(({ id }) => id === left.id);
  const rightIndex = project.shots.findIndex(({ id }) => id === right.id);
  if (rightIndex !== leftIndex + 1) throw new DocumentOperationValidationError("Only adjacent shots in left-to-right order can be merged");
  const duration = addTimelineTimes(left.duration, right.duration);
  if (compareTimelineTimes(duration, 300) > 0) throw new DocumentOperationValidationError("Merged shot duration exceeds 300 seconds");
  const leftFinalCamera = previewShotAtTime(left, left.duration).camera;
  const rightInitialCamera = previewShotAtTime(right, 0).camera;
  if (!camerasEqual(leftFinalCamera, rightInitialCamera)) {
    throw new DocumentOperationValidationError("Shot cameras do not meet at the boundary; merge would introduce a camera jump");
  }
  const leftHasSolo = left.audioClips.some(({ solo }) => solo);
  const rightHasSolo = right.audioClips.some(({ solo }) => solo);
  const leftHasNonSolo = left.audioClips.some(({ solo }) => !solo);
  const rightHasNonSolo = right.audioClips.some(({ solo }) => !solo);
  if ((leftHasSolo && rightHasNonSolo) || (rightHasSolo && leftHasNonSolo)) {
    throw new DocumentOperationValidationError(
      "Shot audio solo state would mute clips that were audible before merge",
    );
  }

  const mapping: MutableIdMapping = new Map();
  setMapping(mapping, left.id, left.id);
  setMapping(mapping, right.id, left.id);
  shotEntityIds(left).slice(1).forEach((id) => setMapping(mapping, id, id));
  shotEntityIds(right).slice(1).forEach((id) => setMapping(mapping, id, id));
  const leftObjects = left.objects.map((object) => {
    const clone = cloneSerializable(object);
    const lifetime = sourceLifetime(object, left.duration);
    clone.lifetime = normalizedLifetime(lifetime.start, lifetime.end, duration);
    return clone;
  });
  const rightObjects = right.objects.map((object) => {
    const clone = cloneSerializable(object);
    const lifetime = sourceLifetime(object, right.duration);
    clone.lifetime = normalizedLifetime(addTimelineTimes(lifetime.start, left.duration), addTimelineTimes(lifetime.end, left.duration), duration);
    return clone;
  });

  const mergedTracks = left.propertyTracks.map(cloneSerializable);
  for (const rightTrack of right.propertyTracks) {
    const shifted = {
      ...cloneSerializable(rightTrack),
      keyframes: rightTrack.keyframes.map((keyframe) => ({ ...cloneSerializable(keyframe), time: addTimelineTimes(keyframe.time, left.duration) })),
    };
    const existing = mergedTracks.find((track) => propertyTrackKey(track) === propertyTrackKey(shifted));
    if (!existing) {
      mergedTracks.push(shifted);
      continue;
    }
    if (rightTrack.target.kind !== "camera" || existing.target.kind !== "camera") {
      throw new DocumentOperationValidationError(`Property tracks ${existing.id} and ${rightTrack.id} would conflict after merge`);
    }
    const boundaryValue = leftFinalCamera[existing.property as keyof Shot["camera"]];
    if (typeof boundaryValue !== "number" || shifted.keyframes[0].value !== boundaryValue) {
      throw new DocumentOperationValidationError(`Camera track ${rightTrack.id} does not start from the shared boundary state`);
    }
    const prior = existing.keyframes.at(-1)!;
    const first = shifted.keyframes[0];
    if (compareTimelineTimes(prior.time, first.time) === 0) {
      if (prior.value !== first.value) throw new DocumentOperationValidationError(`Camera tracks disagree at ${left.duration}s`);
      prior.interpolation = cloneSerializable(first.interpolation);
      setMapping(mapping, first.id, prior.id);
      existing.keyframes.push(...shifted.keyframes.slice(1));
    } else existing.keyframes.push(...shifted.keyframes);
    setMapping(mapping, rightTrack.id, existing.id);
  }
  const shot = ShotSchema.parse({
    ...cloneSerializable(left),
    name: name?.trim() || left.name,
    duration,
    objects: [...leftObjects, ...rightObjects],
    animations: [
      ...left.animations.map(cloneSerializable),
      ...right.animations.map((animation) => ({ ...cloneSerializable(animation), start: addTimelineTimes(animation.start, left.duration) })),
    ],
    propertyTracks: mergedTracks,
    audioClips: [
      ...left.audioClips.map(cloneSerializable),
      ...right.audioClips.map((clip) => ({ ...cloneSerializable(clip), start: addTimelineTimes(clip.start, left.duration) })),
    ],
    captionClips: [
      ...left.captionClips.map(cloneSerializable),
      ...right.captionClips.map((clip) => ({ ...cloneSerializable(clip), start: addTimelineTimes(clip.start, left.duration), end: addTimelineTimes(clip.end, left.duration) })),
    ],
    markers: [
      ...left.markers.map(cloneSerializable),
      ...right.markers.map((marker) => ({ ...cloneSerializable(marker), time: addTimelineTimes(marker.time, left.duration) })),
    ],
  });
  return { shot, mapping };
}

export function splitShotOperation(
  project: ProjectDocument,
  shotId: string,
  time: number,
  rightName?: string,
): Extract<DocumentOperation, { type: "split-shot" }> {
  const boundary = PositiveTimelineDurationSchema.parse(time);
  const split = buildSplitShot(project, shotId, boundary, rightName);
  const candidate = cloneSerializable(project);
  const index = candidate.shots.findIndex(({ id }) => id === shotId);
  candidate.shots.splice(index, 1, split.left, split.right);
  ProjectDocumentSchema.parse(candidate);
  return DocumentOperationSchema.parse({ type: "split-shot", shotId, time: boundary, ...(rightName ? { rightName } : {}) }) as Extract<DocumentOperation, { type: "split-shot" }>;
}

export function mergeShotsOperation(
  project: ProjectDocument,
  leftShotId: string,
  rightShotId: string,
  name?: string,
): Extract<DocumentOperation, { type: "merge-shots" }> {
  const merge = buildMergedShot(project, leftShotId, rightShotId, name);
  const candidate = cloneSerializable(project);
  const index = candidate.shots.findIndex(({ id }) => id === leftShotId);
  candidate.shots.splice(index, 2, merge.shot);
  ProjectDocumentSchema.parse(candidate);
  return DocumentOperationSchema.parse({ type: "merge-shots", leftShotId, rightShotId, ...(name ? { name } : {}) }) as Extract<DocumentOperation, { type: "merge-shots" }>;
}

/** Duplicate any project-local starting style into an explicitly custom style. */
export function duplicateStyleOperation(
  project: ProjectDocument,
  styleId: string,
  name?: string,
): Extract<DocumentOperation, { type: "add-style" }> {
  const source = project.styles.find(({ id }) => id === styleId);
  if (!source) throw new DocumentOperationValidationError(`Style not found: ${styleId}`);
  const style = cloneSerializable(source);
  style.id = allocateId("style", collectProjectIds(project), boundedHint(name ?? `${source.name}-copy`));
  style.name = name?.trim() || copiedName(source.name, 80);
  style.origin = "custom";
  const index = project.styles.findIndex(({ id }) => id === source.id) + 1;
  return DocumentOperationSchema.parse({ type: "add-style", style, index }) as Extract<DocumentOperation, { type: "add-style" }>;
}

// Kept exported for duplicate-operation acceptance tests and future editor wiring.
export function shotLocalIds(shot: Shot): ReadonlySet<string> {
  return collectShotIds(shot);
}
