import type { ProjectDocument, Shot } from "./schema";

export type EditorKeyframeRef = Readonly<{
  trackId: string;
  keyframeId: string;
}>;

/**
 * The editor owns one contextual selection at a time. Every scene-bound
 * selection carries its shot so stale selections cannot leak across a shot
 * switch. Keyframes and markers share this contract so M3.3 never introduces
 * a second, timeline-only selection authority.
 */
export type EditorSelection =
  | Readonly<{ kind: "project" }>
  | Readonly<{ kind: "shot"; shotIds: readonly string[]; primaryShotId: string }>
  | Readonly<{ kind: "objects"; shotId: string; objectIds: readonly string[]; primaryObjectId: string }>
  | Readonly<{ kind: "animation"; shotId: string; animationIds: readonly string[]; primaryAnimationId: string }>
  | Readonly<{ kind: "keyframes"; shotId: string; keyframes: readonly EditorKeyframeRef[]; primaryKeyframe: EditorKeyframeRef }>
  | Readonly<{ kind: "markers"; shotId: string; markerIds: readonly string[]; primaryMarkerId: string }>
  | Readonly<{ kind: "none"; shotId: string }>;

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function projectSelection(): EditorSelection {
  return { kind: "project" };
}

export function shotSelection(shotIds: readonly string[], primaryShotId = shotIds.at(-1)): EditorSelection {
  const normalized = unique(shotIds);
  if (!primaryShotId || !normalized.includes(primaryShotId)) throw new Error("Shot selection requires a selected primary shot");
  return { kind: "shot", shotIds: normalized, primaryShotId };
}

export function objectSelection(shot: Shot, ids: readonly string[], primaryObjectId = ids.at(-1)): EditorSelection {
  const existing = new Set(shot.objects.map(({ id }) => id));
  const selected = unique(ids).filter((id) => existing.has(id));
  const selectedSet = new Set(selected);
  const normalized = selected.filter((id) => {
    let cursor = shot.objects.find((object) => object.id === id);
    while (cursor?.parentId) {
      if (selectedSet.has(cursor.parentId)) return false;
      cursor = shot.objects.find((object) => object.id === cursor?.parentId);
    }
    return true;
  });
  if (!normalized.length) return { kind: "none", shotId: shot.id };
  let primary = primaryObjectId && normalized.includes(primaryObjectId) ? primaryObjectId : undefined;
  let cursor = primaryObjectId ? shot.objects.find(({ id }) => id === primaryObjectId) : undefined;
  while (!primary && cursor?.parentId) {
    if (normalized.includes(cursor.parentId)) primary = cursor.parentId;
    cursor = shot.objects.find(({ id }) => id === cursor?.parentId);
  }
  primary ??= normalized.at(-1)!;
  const ordered = [...normalized.filter((id) => id !== primary), primary];
  return { kind: "objects", shotId: shot.id, objectIds: ordered, primaryObjectId: primary };
}

export function animationSelection(shot: Shot, ids: readonly string[], primaryAnimationId = ids.at(-1)): EditorSelection {
  const existing = new Set(shot.animations.map(({ id }) => id));
  const normalized = unique(ids).filter((id) => existing.has(id));
  if (!normalized.length) return { kind: "none", shotId: shot.id };
  const primary = primaryAnimationId && normalized.includes(primaryAnimationId) ? primaryAnimationId : normalized.at(-1)!;
  return { kind: "animation", shotId: shot.id, animationIds: [...normalized.filter((id) => id !== primary), primary], primaryAnimationId: primary };
}

export function keyframeSelection(shot: Shot, refs: readonly EditorKeyframeRef[], primary = refs.at(-1)): EditorSelection {
  const existing = new Set(shot.propertyTracks.flatMap((track) => track.keyframes.map((keyframe) => `${track.id}\u0000${keyframe.id}`)));
  const normalized = refs.filter((ref, index) => (
    refs.findIndex((candidate) => candidate.trackId === ref.trackId && candidate.keyframeId === ref.keyframeId) === index
    && existing.has(`${ref.trackId}\u0000${ref.keyframeId}`)
  ));
  if (!normalized.length) return { kind: "none", shotId: shot.id };
  const resolvedPrimary = primary && normalized.some((ref) => ref.trackId === primary.trackId && ref.keyframeId === primary.keyframeId)
    ? primary
    : normalized.at(-1)!;
  return {
    kind: "keyframes",
    shotId: shot.id,
    keyframes: [...normalized.filter((ref) => ref.trackId !== resolvedPrimary.trackId || ref.keyframeId !== resolvedPrimary.keyframeId), resolvedPrimary],
    primaryKeyframe: resolvedPrimary,
  };
}

export function markerSelection(shot: Shot, ids: readonly string[], primaryMarkerId = ids.at(-1)): EditorSelection {
  const existing = new Set(shot.markers.map(({ id }) => id));
  const normalized = unique(ids).filter((id) => existing.has(id));
  if (!normalized.length) return { kind: "none", shotId: shot.id };
  const primary = primaryMarkerId && normalized.includes(primaryMarkerId) ? primaryMarkerId : normalized.at(-1)!;
  return { kind: "markers", shotId: shot.id, markerIds: [...normalized.filter((id) => id !== primary), primary], primaryMarkerId: primary };
}

export function normalizeEditorSelection(selection: EditorSelection, project: ProjectDocument, activeShotId: string): EditorSelection {
  const activeShot = project.shots.find(({ id }) => id === activeShotId) ?? project.shots[0];
  if (!activeShot) return projectSelection();
  switch (selection.kind) {
    case "project": return selection;
    case "shot": {
      const existing = new Set(project.shots.map(({ id }) => id));
      const ids = selection.shotIds.filter((id) => existing.has(id));
      return ids.length ? shotSelection(ids, ids.includes(selection.primaryShotId) ? selection.primaryShotId : ids.at(-1)) : shotSelection([activeShot.id]);
    }
    case "objects": return selection.shotId === activeShot.id ? objectSelection(activeShot, selection.objectIds, selection.primaryObjectId) : shotSelection([activeShot.id]);
    case "animation": return selection.shotId === activeShot.id ? animationSelection(activeShot, selection.animationIds, selection.primaryAnimationId) : shotSelection([activeShot.id]);
    case "keyframes": return selection.shotId === activeShot.id ? keyframeSelection(activeShot, selection.keyframes, selection.primaryKeyframe) : shotSelection([activeShot.id]);
    case "markers": return selection.shotId === activeShot.id ? markerSelection(activeShot, selection.markerIds, selection.primaryMarkerId) : shotSelection([activeShot.id]);
    case "none": return selection.shotId === activeShot.id ? selection : { kind: "none", shotId: activeShot.id };
  }
}

export function selectedObjectIds(selection: EditorSelection, shotId: string): readonly string[] {
  return selection.kind === "objects" && selection.shotId === shotId ? selection.objectIds : [];
}

export function selectedAnimationIds(selection: EditorSelection, shotId: string): readonly string[] {
  return selection.kind === "animation" && selection.shotId === shotId ? selection.animationIds : [];
}

export function selectedKeyframeRefs(selection: EditorSelection, shotId: string): readonly EditorKeyframeRef[] {
  return selection.kind === "keyframes" && selection.shotId === shotId ? selection.keyframes : [];
}

export function selectedMarkerIds(selection: EditorSelection, shotId: string): readonly string[] {
  return selection.kind === "markers" && selection.shotId === shotId ? selection.markerIds : [];
}
