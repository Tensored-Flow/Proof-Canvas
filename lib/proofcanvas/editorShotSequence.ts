import {
  type DocumentIdMapping,
  type DocumentOperation,
  type DocumentOperationResult,
} from "./documentOperations";
import {
  animationSelection,
  keyframeSelection,
  markerSelection,
  normalizeEditorSelection,
  objectSelection,
  shotSelection,
  type EditorKeyframeRef,
  type EditorSelection,
} from "./editorSelection";
import {
  addTimelineTimes,
  frameToSeconds,
  logicalFrameFor,
  timelineTickFor,
  timelineTimeForTick,
} from "./frame";
import {
  commitDocumentOperationsWithResult,
  type ProjectHistory,
} from "./history";
import { allocateId, collectProjectIds } from "./ids";
import {
  canonicalProjectJson,
  type ProjectDocument,
  type Shot,
} from "./schema";

export interface EditorShotSequenceEntry {
  readonly index: number;
  readonly shotId: string;
  readonly start: number;
  readonly end: number;
  readonly duration: number;
}

export interface EditorShotSequence {
  readonly entries: readonly EditorShotSequenceEntry[];
  readonly totalDuration: number;
}

/** Build global shot offsets by summing canonical integer timeline ticks. */
export function buildEditorShotSequence(project: ProjectDocument): EditorShotSequence {
  let cursorTick = 0;
  const entries = project.shots.map((shot, index): EditorShotSequenceEntry => {
    const durationTick = timelineTickFor(shot.duration);
    const startTick = cursorTick;
    cursorTick += durationTick;
    return {
      index,
      shotId: shot.id,
      start: timelineTimeForTick(startTick),
      end: timelineTimeForTick(cursorTick),
      duration: timelineTimeForTick(durationTick),
    };
  });
  return { entries, totalDuration: timelineTimeForTick(cursorTick) };
}

export type EditorShotSequenceLocation = Readonly<{
  ok: true;
  index: number;
  shotId: string;
  globalTime: number;
  localTime: number;
  clamped: boolean;
  atFinalEndpoint: boolean;
}>;

export type EditorShotSequenceLocationFailure = Readonly<{
  ok: false;
  diagnostic: Readonly<{
    code: "empty-sequence" | "invalid-time" | "out-of-range";
    message: string;
  }>;
}>;

/**
 * Locate canonical project time in the ordered sequence. Internal endpoints
 * are half-open and belong to the next shot at local zero. The final endpoint
 * belongs to the last shot at its duration. `outOfRange: "reject"` is the
 * default; `"clamp"` explicitly clamps finite values to the project bounds.
 */
export function locateEditorShotSequenceTime(
  sequence: EditorShotSequence,
  time: number,
  options: Readonly<{ outOfRange?: "reject" | "clamp" }> = {},
): EditorShotSequenceLocation | EditorShotSequenceLocationFailure {
  if (!sequence.entries.length) {
    return { ok: false, diagnostic: { code: "empty-sequence", message: "Cannot locate time in an empty shot sequence" } };
  }
  if (!Number.isFinite(time)) {
    return { ok: false, diagnostic: { code: "invalid-time", message: "Sequence time must be finite" } };
  }
  const totalTick = timelineTickFor(sequence.totalDuration);
  let requestedTick: number;
  let forcedClamp = false;
  try {
    requestedTick = timelineTickFor(time);
  } catch (error) {
    if (options.outOfRange === "clamp") {
      requestedTick = time < 0 ? 0 : totalTick;
      forcedClamp = true;
    }
    else return { ok: false, diagnostic: { code: "out-of-range", message: error instanceof Error ? error.message : "Sequence time is outside the authored range" } };
  }
  const outside = forcedClamp || requestedTick < 0 || requestedTick > totalTick;
  if (outside && options.outOfRange !== "clamp") {
    return {
      ok: false,
      diagnostic: {
        code: "out-of-range",
        message: `Sequence time must be between 0 and ${sequence.totalDuration}`,
      },
    };
  }
  const globalTick = Math.min(totalTick, Math.max(0, requestedTick));
  const finalEndpoint = globalTick === totalTick;
  const entry = finalEndpoint
    ? sequence.entries.at(-1)!
    : sequence.entries.find((candidate) => globalTick < timelineTickFor(candidate.end))!;
  const localTick = globalTick - timelineTickFor(entry.start);
  return {
    ok: true,
    index: entry.index,
    shotId: entry.shotId,
    globalTime: timelineTimeForTick(globalTick),
    localTime: timelineTimeForTick(localTick),
    clamped: outside,
    atFinalEndpoint: finalEndpoint,
  };
}

/**
 * Return one authored project frame plus every persisted end authority. The
 * frame floor is an editor convention, not a schema migration: legacy imports
 * may retain shorter schema-valid shots until the user edits their duration.
 */
export function minimumAuthoredShotDuration(project: ProjectDocument, shot: Shot): number {
  let minimumTick = timelineTickFor(frameToSeconds(1, project.settings.frameRate));
  const include = (time: number) => { minimumTick = Math.max(minimumTick, timelineTickFor(time)); };
  for (const object of shot.objects) if (object.lifetime) include(object.lifetime.end);
  for (const animation of shot.animations) include(addTimelineTimes(animation.start, animation.duration));
  for (const track of shot.propertyTracks) for (const keyframe of track.keyframes) include(keyframe.time);
  for (const clip of shot.audioClips) include(addTimelineTimes(clip.start, clip.duration));
  for (const clip of shot.captionClips) include(clip.end);
  for (const marker of shot.markers) include(marker.time);
  return timelineTimeForTick(minimumTick);
}

export interface EditorShotWorkspace {
  readonly activeShotId: string;
  readonly selection: EditorSelection;
  readonly playhead: number;
}

export type EditorShotWorkspaceDiagnostic = Readonly<{
  code: "invalid-workspace";
  message: string;
}>;

export type EditorShotWorkspaceValidation =
  | Readonly<{ ok: true; workspace: EditorShotWorkspace }>
  | Readonly<{ ok: false; workspace: EditorShotWorkspace; diagnostic: EditorShotWorkspaceDiagnostic }>;

export type EditorShotNavigationResolution =
  | Readonly<{
      ok: true;
      workspace: EditorShotWorkspace;
      playback: "pause" | "preserve";
    }>
  | Readonly<{
      ok: false;
      workspace: EditorShotWorkspace;
      diagnostic: Readonly<{ code: "invalid-workspace" | "missing-shot"; message: string }>;
    }>;

export type EditorShotSequencePositionResolution =
  | Readonly<{
      ok: true;
      workspace: EditorShotWorkspace;
      globalTime: number;
      atFinalEndpoint: boolean;
    }>
  | Readonly<{
      ok: false;
      workspace: EditorShotWorkspace;
      diagnostic: Readonly<{ code: "invalid-workspace"; message: string }>;
    }>;

export type EditorShotPlaybackResolution =
  | Readonly<{
      ok: true;
      workspace: EditorShotWorkspace;
      globalTime: number;
      playback: "play" | "pause";
    }>
  | Readonly<{
      ok: false;
      workspace: EditorShotWorkspace;
      diagnostic: Readonly<{ code: "invalid-workspace" | "invalid-time"; message: string }>;
    }>;

type RevisionGuard = Readonly<{ expectedRevision?: string }>;

export type EditorShotAction =
  | (Readonly<{ type: "add-shot" }> & RevisionGuard)
  | (Readonly<{ type: "duplicate-shot"; shotId: string; name?: string }> & RevisionGuard)
  | (Readonly<{ type: "rename-shot"; shotId: string; name: string }> & RevisionGuard)
  | (Readonly<{ type: "reorder-shot"; shotId: string; index: number }> & RevisionGuard)
  | (Readonly<{ type: "split-shot"; shotId: string; time: number; rightName?: string }> & RevisionGuard)
  | (Readonly<{ type: "merge-shots"; leftShotId: string; rightShotId: string; name?: string }> & RevisionGuard)
  | (Readonly<{ type: "delete-shot"; shotId: string }> & RevisionGuard)
  | (Readonly<{ type: "set-shot-duration"; shotId: string; duration: number }> & RevisionGuard);

export type EditorShotActionDiagnosticCode =
  | "stale-revision"
  | "stale-playhead"
  | "invalid-workspace"
  | "missing-shot"
  | "invalid-name"
  | "nothing-to-change"
  | "invalid-operation"
  | "missing-id-mapping";

export type EditorShotActionResolution =
  | Readonly<{
      ok: true;
      history: ProjectHistory;
      workspace: EditorShotWorkspace;
      result: DocumentOperationResult;
      playback: "pause" | "preserve";
      label: string;
    }>
  | Readonly<{
      ok: false;
      history: ProjectHistory;
      workspace: EditorShotWorkspace;
      diagnostic: Readonly<{ code: EditorShotActionDiagnosticCode; message: string }>;
    }>;

type PreparedEditorShotAction = Readonly<{
  operation: DocumentOperation;
  label: string;
  transition:
    | Readonly<{ kind: "add"; shotId: string }>
    | Readonly<{ kind: "duplicate"; sourceShotId: string }>
    | Readonly<{ kind: "rename" }>
    | Readonly<{ kind: "reorder" }>
    | Readonly<{ kind: "split"; sourceShotId: string }>
    | Readonly<{ kind: "merge"; leftShotId: string; rightShotId: string; leftDuration: number }>
    | Readonly<{ kind: "delete"; shotId: string; sourceIndex: number }>
    | Readonly<{ kind: "duration"; shotId: string }>;
}>;

function failed(
  history: ProjectHistory,
  workspace: EditorShotWorkspace,
  code: EditorShotActionDiagnosticCode,
  message: string,
): EditorShotActionResolution {
  return { ok: false, history, workspace, diagnostic: { code, message } };
}

function shotById(project: ProjectDocument, shotId: string): Shot | undefined {
  return project.shots.find(({ id }) => id === shotId);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameSelection(left: EditorSelection, right: EditorSelection): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "project": return true;
    case "shot": return right.kind === "shot"
      && left.primaryShotId === right.primaryShotId
      && sameIds(left.shotIds, right.shotIds);
    case "objects": return right.kind === "objects"
      && left.shotId === right.shotId
      && left.primaryObjectId === right.primaryObjectId
      && sameIds(left.objectIds, right.objectIds);
    case "animation": return right.kind === "animation"
      && left.shotId === right.shotId
      && left.primaryAnimationId === right.primaryAnimationId
      && sameIds(left.animationIds, right.animationIds);
    case "keyframes": return right.kind === "keyframes"
      && left.shotId === right.shotId
      && left.primaryKeyframe.trackId === right.primaryKeyframe.trackId
      && left.primaryKeyframe.keyframeId === right.primaryKeyframe.keyframeId
      && left.keyframes.length === right.keyframes.length
      && left.keyframes.every((ref, index) => (
        ref.trackId === right.keyframes[index].trackId
        && ref.keyframeId === right.keyframes[index].keyframeId
      ));
    case "markers": return right.kind === "markers"
      && left.shotId === right.shotId
      && left.primaryMarkerId === right.primaryMarkerId
      && sameIds(left.markerIds, right.markerIds);
    case "none": return right.kind === "none" && left.shotId === right.shotId;
  }
}

function normalizedSelectionForActiveShot(
  project: ProjectDocument,
  selection: EditorSelection,
  activeShotId: string,
): EditorSelection {
  const normalized = normalizeEditorSelection(selection, project, activeShotId);
  if (normalized.kind !== "shot") return normalized;
  return shotSelection([activeShotId]);
}

/** Validate the complete shot-local workspace before a command can author. */
export function validateEditorShotWorkspace(
  project: ProjectDocument,
  workspace: EditorShotWorkspace,
): EditorShotWorkspaceValidation {
  const activeShot = shotById(project, workspace.activeShotId);
  if (!activeShot) {
    return {
      ok: false,
      workspace,
      diagnostic: { code: "invalid-workspace", message: `Active shot not found: ${workspace.activeShotId}` },
    };
  }
  if (!Number.isFinite(workspace.playhead)) {
    return {
      ok: false,
      workspace,
      diagnostic: { code: "invalid-workspace", message: "Workspace playhead must be finite" },
    };
  }
  try {
    const playheadTick = timelineTickFor(workspace.playhead);
    if (playheadTick < 0 || playheadTick > timelineTickFor(activeShot.duration)) {
      return {
        ok: false,
        workspace,
        diagnostic: { code: "invalid-workspace", message: "Workspace playhead is outside the active shot" },
      };
    }
  } catch (error) {
    return {
      ok: false,
      workspace,
      diagnostic: {
        code: "invalid-workspace",
        message: error instanceof Error ? error.message : "Workspace playhead is invalid",
      },
    };
  }
  if (workspace.selection.kind === "shot") {
    if (!workspace.selection.shotIds.includes(activeShot.id)) {
      return {
        ok: false,
        workspace,
        diagnostic: {
          code: "invalid-workspace",
          message: `Shot selection must include active shot ${activeShot.id}`,
        },
      };
    }
    if (workspace.selection.primaryShotId !== activeShot.id) {
      return {
        ok: false,
        workspace,
        diagnostic: {
          code: "invalid-workspace",
          message: `Shot selection primary ${workspace.selection.primaryShotId} must equal active shot ${activeShot.id}`,
        },
      };
    }
  }
  try {
    const normalized = normalizeEditorSelection(workspace.selection, project, activeShot.id);
    if (!sameSelection(normalized, workspace.selection)) {
      return {
        ok: false,
        workspace,
        diagnostic: {
          code: "invalid-workspace",
          message: `Workspace selection is stale or non-canonical for active shot ${activeShot.id}`,
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      workspace,
      diagnostic: {
        code: "invalid-workspace",
        message: error instanceof Error ? error.message : "Workspace selection is invalid",
      },
    };
  }
  return { ok: true, workspace };
}

/** Resolve a manual shot click without coupling this authority to DOM focus. */
export function resolveEditorShotActivation(
  project: ProjectDocument,
  workspace: EditorShotWorkspace,
  targetShotId: string,
): EditorShotNavigationResolution {
  const validation = validateEditorShotWorkspace(project, workspace);
  if (!validation.ok) return validation;
  if (!shotById(project, targetShotId)) {
    return {
      ok: false,
      workspace,
      diagnostic: { code: "missing-shot", message: `Shot not found: ${targetShotId}` },
    };
  }
  if (targetShotId === workspace.activeShotId) {
    return { ok: true, workspace, playback: "preserve" };
  }
  return {
    ok: true,
    workspace: { activeShotId: targetShotId, selection: shotSelection([targetShotId]), playhead: 0 },
    playback: "pause",
  };
}

/** Derive project-global time from the active shot and canonical local tick. */
export function deriveEditorShotSequencePosition(
  project: ProjectDocument,
  workspace: EditorShotWorkspace,
): EditorShotSequencePositionResolution {
  const validation = validateEditorShotWorkspace(project, workspace);
  if (!validation.ok) return validation;
  const sequence = buildEditorShotSequence(project);
  const entry = sequence.entries.find(({ shotId }) => shotId === workspace.activeShotId)!;
  const globalTick = timelineTickFor(entry.start) + timelineTickFor(workspace.playhead);
  return {
    ok: true,
    workspace,
    globalTime: timelineTimeForTick(globalTick),
    atFinalEndpoint: globalTick === timelineTickFor(sequence.totalDuration),
  };
}

function workspaceForSequenceLocation(
  project: ProjectDocument,
  workspace: EditorShotWorkspace,
  location: EditorShotSequenceLocation,
): EditorShotWorkspace {
  if (
    workspace.activeShotId === location.shotId
    && timelineTickFor(workspace.playhead) === timelineTickFor(location.localTime)
  ) return workspace;
  return {
    activeShotId: location.shotId,
    selection: workspace.activeShotId === location.shotId
      ? workspace.selection
      : normalizedSelectionForActiveShot(project, workspace.selection, location.shotId),
    playhead: location.localTime,
  };
}

function playbackFailure(
  workspace: EditorShotWorkspace,
  code: "invalid-workspace" | "invalid-time",
  message: string,
): EditorShotPlaybackResolution {
  return { ok: false, workspace, diagnostic: { code, message } };
}

/** Seek the project clock; scrubbing pauses and canonicalizes boundary ownership. */
export function seekEditorShotSequence(
  project: ProjectDocument,
  workspace: EditorShotWorkspace,
  globalTime: number,
): EditorShotPlaybackResolution {
  const position = deriveEditorShotSequencePosition(project, workspace);
  if (!position.ok) return position;
  const location = locateEditorShotSequenceTime(buildEditorShotSequence(project), globalTime);
  if (!location.ok) return playbackFailure(workspace, "invalid-time", location.diagnostic.message);
  return {
    ok: true,
    workspace: workspaceForSequenceLocation(project, workspace, location),
    globalTime: location.globalTime,
    playback: "pause",
  };
}

/** Begin playback, restarting the whole project when already at its final tick. */
export function beginEditorShotSequencePlayback(
  project: ProjectDocument,
  workspace: EditorShotWorkspace,
): EditorShotPlaybackResolution {
  const position = deriveEditorShotSequencePosition(project, workspace);
  if (!position.ok) return position;
  const target = position.atFinalEndpoint ? 0 : position.globalTime;
  const location = locateEditorShotSequenceTime(buildEditorShotSequence(project), target);
  if (!location.ok) return playbackFailure(workspace, "invalid-time", location.diagnostic.message);
  return {
    ok: true,
    workspace: workspaceForSequenceLocation(project, workspace, location),
    globalTime: location.globalTime,
    playback: "play",
  };
}

/** Advance elapsed project time and stop exactly on the final canonical tick. */
export function advanceEditorShotSequencePlayback(
  project: ProjectDocument,
  workspace: EditorShotWorkspace,
  elapsedSeconds: number,
): EditorShotPlaybackResolution {
  const position = deriveEditorShotSequencePosition(project, workspace);
  if (!position.ok) return position;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    return playbackFailure(workspace, "invalid-time", "Playback advance must be a non-negative finite duration");
  }
  const sequence = buildEditorShotSequence(project);
  const currentTick = timelineTickFor(position.globalTime);
  const totalTick = timelineTickFor(sequence.totalDuration);
  const remainingTick = totalTick - currentTick;
  let deltaTick: number;
  try {
    deltaTick = elapsedSeconds > sequence.totalDuration
      ? remainingTick
      : timelineTickFor(elapsedSeconds);
  } catch (error) {
    return playbackFailure(workspace, "invalid-time", error instanceof Error ? error.message : "Playback advance is invalid");
  }
  const targetTick = currentTick + Math.min(remainingTick, deltaTick);
  const location = locateEditorShotSequenceTime(sequence, timelineTimeForTick(targetTick));
  if (!location.ok) return playbackFailure(workspace, "invalid-time", location.diagnostic.message);
  return {
    ok: true,
    workspace: workspaceForSequenceLocation(project, workspace, location),
    globalTime: location.globalTime,
    playback: targetTick === totalTick ? "pause" : "play",
  };
}

function mappedIds(ids: readonly string[], mapping: Readonly<Record<string, readonly string[]>>): string[] {
  return [...new Set(ids.flatMap((id) => mapping[id] ?? [id]))];
}

function mappedPrimary(
  id: string,
  mapping: Readonly<Record<string, readonly string[]>>,
  eligible: ReadonlySet<string>,
): string | undefined {
  return (mapping[id] ?? [id]).find((candidate) => eligible.has(candidate));
}

function mappedKeyframeRefs(
  ref: EditorKeyframeRef,
  mapping: Readonly<Record<string, readonly string[]>>,
  target: Shot,
): EditorKeyframeRef[] {
  const trackIds = new Set(mapping[ref.trackId] ?? [ref.trackId]);
  const keyframeIds = new Set(mapping[ref.keyframeId] ?? [ref.keyframeId]);
  return target.propertyTracks.flatMap((track) => (
    trackIds.has(track.id)
      ? track.keyframes.filter(({ id }) => keyframeIds.has(id)).map(({ id }) => ({ trackId: track.id, keyframeId: id }))
      : []
  ));
}

function remapSelection(
  selection: EditorSelection,
  previousShotIds: ReadonlySet<string>,
  targetShot: Shot,
  preferredMappedShotId: string,
  project: ProjectDocument,
  mapping: Readonly<Record<string, readonly string[]>>,
): EditorSelection {
  let mapped: EditorSelection;
  switch (selection.kind) {
    case "project":
      mapped = selection;
      break;
    case "shot": {
      const finalShotIds = new Set(project.shots.map(({ id }) => id));
      const ids = [...new Set(selection.shotIds.flatMap((id) => {
        const targets = mapping[id] ?? [id];
        return previousShotIds.has(id) && targets.includes(preferredMappedShotId) ? [preferredMappedShotId] : targets;
      }))].filter((id) => finalShotIds.has(id));
      const chosen = targetShot.id;
      mapped = shotSelection([...ids.filter((id) => id !== chosen), chosen], chosen);
      break;
    }
    case "objects": {
      if (!previousShotIds.has(selection.shotId)) {
        mapped = selection;
        break;
      }
      const eligible = new Set(targetShot.objects.map(({ id }) => id));
      mapped = objectSelection(targetShot, mappedIds(selection.objectIds, mapping), mappedPrimary(selection.primaryObjectId, mapping, eligible));
      break;
    }
    case "animation": {
      if (!previousShotIds.has(selection.shotId)) {
        mapped = selection;
        break;
      }
      const eligible = new Set(targetShot.animations.map(({ id }) => id));
      mapped = animationSelection(targetShot, mappedIds(selection.animationIds, mapping), mappedPrimary(selection.primaryAnimationId, mapping, eligible));
      break;
    }
    case "keyframes": {
      if (!previousShotIds.has(selection.shotId)) {
        mapped = selection;
        break;
      }
      const refs = selection.keyframes.flatMap((ref) => mappedKeyframeRefs(ref, mapping, targetShot));
      const primary = mappedKeyframeRefs(selection.primaryKeyframe, mapping, targetShot)[0];
      mapped = keyframeSelection(targetShot, refs, primary);
      break;
    }
    case "markers": {
      if (!previousShotIds.has(selection.shotId)) {
        mapped = selection;
        break;
      }
      const eligible = new Set(targetShot.markers.map(({ id }) => id));
      mapped = markerSelection(targetShot, mappedIds(selection.markerIds, mapping), mappedPrimary(selection.primaryMarkerId, mapping, eligible));
      break;
    }
    case "none":
      mapped = previousShotIds.has(selection.shotId) ? { kind: "none", shotId: targetShot.id } : selection;
      break;
  }
  return normalizeEditorSelection(mapped, project, targetShot.id);
}

function structuralMapping(
  result: DocumentOperationResult,
  operationType: DocumentIdMapping["operationType"],
): DocumentIdMapping | undefined {
  return result.idMappings.find((candidate) => candidate.operationIndex === 0 && candidate.operationType === operationType);
}

function prepareEditorShotAction(
  history: ProjectHistory,
  workspace: EditorShotWorkspace,
  action: EditorShotAction,
): PreparedEditorShotAction | EditorShotActionResolution {
  const project = history.present;
  switch (action.type) {
    case "add-shot": {
      const activeIndex = project.shots.findIndex(({ id }) => id === workspace.activeShotId);
      const sequenceNumber = project.shots.length + 1;
      const id = allocateId("shot", collectProjectIds(project), `scene-${sequenceNumber}`);
      const frame = logicalFrameFor(project.settings.aspectRatio);
      return {
        operation: {
          type: "add-shot",
          index: activeIndex + 1,
          shot: {
            id,
            name: `Scene ${sequenceNumber}`,
            duration: 6,
            objects: [],
            animations: [],
            propertyTracks: [],
            audioClips: [],
            captionClips: [],
            markers: [],
            camera: { x: frame.centerX, y: frame.centerY, zoom: 1, rotation: 0 },
          },
        },
        label: "Add shot",
        transition: { kind: "add", shotId: id },
      };
    }
    case "duplicate-shot": {
      if (!shotById(project, action.shotId)) return failed(history, workspace, "missing-shot", `Shot not found: ${action.shotId}`);
      return {
        operation: { type: "duplicate-shot", shotId: action.shotId, ...(action.name === undefined ? {} : { name: action.name }) },
        label: "Duplicate shot",
        transition: { kind: "duplicate", sourceShotId: action.shotId },
      };
    }
    case "rename-shot": {
      const shot = shotById(project, action.shotId);
      if (!shot) return failed(history, workspace, "missing-shot", `Shot not found: ${action.shotId}`);
      const name = action.name.trim();
      if (!name) return failed(history, workspace, "invalid-name", "Shot name cannot be empty");
      if (name === shot.name) return failed(history, workspace, "nothing-to-change", "Shot name is unchanged");
      return {
        operation: { type: "update-shot", shotId: action.shotId, patch: { name } },
        label: "Rename shot",
        transition: { kind: "rename" },
      };
    }
    case "reorder-shot": {
      const sourceIndex = project.shots.findIndex(({ id }) => id === action.shotId);
      if (sourceIndex < 0) return failed(history, workspace, "missing-shot", `Shot not found: ${action.shotId}`);
      if (action.index === sourceIndex) return failed(history, workspace, "nothing-to-change", "Shot is already at that position");
      return {
        operation: { type: "reorder-shot", shotId: action.shotId, index: action.index },
        label: "Reorder shots",
        transition: { kind: "reorder" },
      };
    }
    case "split-shot": {
      const source = shotById(project, action.shotId);
      if (!source) return failed(history, workspace, "missing-shot", `Shot not found: ${action.shotId}`);
      if (workspace.activeShotId !== action.shotId) {
        return failed(history, workspace, "invalid-workspace", "Only the active shot can be split at the editor playhead");
      }
      try {
        const splitTick = timelineTickFor(action.time);
        if (splitTick !== timelineTickFor(workspace.playhead)) {
          return failed(history, workspace, "stale-playhead", "The playhead changed before this split was applied");
        }
        const oneFrame = frameToSeconds(1, project.settings.frameRate);
        const frameTick = timelineTickFor(oneFrame);
        const rightTick = timelineTickFor(source.duration) - splitTick;
        if (splitTick < frameTick || rightTick < frameTick) {
          return failed(
            history,
            workspace,
            "invalid-operation",
            `Split must leave at least one ${project.settings.frameRate}fps frame (${oneFrame}s) on each side`,
          );
        }
      } catch (error) {
        return failed(history, workspace, "invalid-operation", error instanceof Error ? error.message : "Split time is invalid");
      }
      return {
        operation: { type: "split-shot", shotId: action.shotId, time: action.time, ...(action.rightName === undefined ? {} : { rightName: action.rightName }) },
        label: "Split shot",
        transition: { kind: "split", sourceShotId: action.shotId },
      };
    }
    case "merge-shots": {
      const left = shotById(project, action.leftShotId);
      const right = shotById(project, action.rightShotId);
      if (!left) return failed(history, workspace, "missing-shot", `Shot not found: ${action.leftShotId}`);
      if (!right) return failed(history, workspace, "missing-shot", `Shot not found: ${action.rightShotId}`);
      return {
        operation: { type: "merge-shots", leftShotId: left.id, rightShotId: right.id, ...(action.name === undefined ? {} : { name: action.name }) },
        label: "Merge shots",
        transition: { kind: "merge", leftShotId: left.id, rightShotId: right.id, leftDuration: left.duration },
      };
    }
    case "delete-shot": {
      const sourceIndex = project.shots.findIndex(({ id }) => id === action.shotId);
      if (sourceIndex < 0) return failed(history, workspace, "missing-shot", `Shot not found: ${action.shotId}`);
      return {
        operation: { type: "delete-shot", shotId: action.shotId },
        label: "Delete shot",
        transition: { kind: "delete", shotId: action.shotId, sourceIndex },
      };
    }
    case "set-shot-duration": {
      const shot = shotById(project, action.shotId);
      if (!shot) return failed(history, workspace, "missing-shot", `Shot not found: ${action.shotId}`);
      try {
        const oneFrame = frameToSeconds(1, project.settings.frameRate);
        if (timelineTickFor(action.duration) < timelineTickFor(oneFrame)) {
          return failed(
            history,
            workspace,
            "invalid-operation",
            `Shot duration must be at least one ${project.settings.frameRate}fps frame (${oneFrame}s)`,
          );
        }
      } catch {
        // The typed document operation remains the final validator for malformed
        // or out-of-domain values and returns the canonical diagnostic below.
      }
      return {
        operation: { type: "update-shot", shotId: action.shotId, patch: { duration: action.duration } },
        label: "Set shot duration",
        transition: { kind: "duration", shotId: action.shotId },
      };
    }
  }
}

/**
 * Resolve and commit one shot-sequence action against the supplied latest
 * history snapshot. Failed actions publish neither document nor workspace
 * state and return the exact input identities.
 */
export function commitEditorShotAction(
  history: ProjectHistory,
  workspace: EditorShotWorkspace,
  action: EditorShotAction,
): EditorShotActionResolution {
  if (action.expectedRevision !== undefined && action.expectedRevision !== canonicalProjectJson(history.present)) {
    return failed(history, workspace, "stale-revision", "The project changed before this shot action was applied");
  }
  const workspaceValidation = validateEditorShotWorkspace(history.present, workspace);
  if (!workspaceValidation.ok) {
    return failed(history, workspace, workspaceValidation.diagnostic.code, workspaceValidation.diagnostic.message);
  }

  const prepared = prepareEditorShotAction(history, workspace, action);
  if ("ok" in prepared) return prepared;
  try {
    const committed = commitDocumentOperationsWithResult(history, [prepared.operation], prepared.label);
    if (committed.history === history) return failed(history, workspace, "nothing-to-change", "Shot action did not change the project");
    const project = committed.history.present;
    let nextWorkspace: EditorShotWorkspace = workspace;
    let playback: "pause" | "preserve" = "pause";
    switch (prepared.transition.kind) {
      case "add": {
        nextWorkspace = { activeShotId: prepared.transition.shotId, selection: shotSelection([prepared.transition.shotId]), playhead: 0 };
        break;
      }
      case "duplicate": {
        const idMapping = structuralMapping(committed.result, "duplicate-shot");
        const duplicateId = idMapping?.ids[prepared.transition.sourceShotId]?.[0];
        const duplicate = duplicateId ? shotById(project, duplicateId) : undefined;
        if (!idMapping || !duplicate) return failed(history, workspace, "missing-id-mapping", "Duplicate shot did not return its complete ID mapping");
        nextWorkspace = {
          activeShotId: duplicate.id,
          selection: remapSelection(workspace.selection, new Set([prepared.transition.sourceShotId]), duplicate, duplicate.id, project, idMapping.ids),
          playhead: 0,
        };
        break;
      }
      case "rename":
        playback = "preserve";
        break;
      case "reorder":
        break;
      case "split": {
        const idMapping = structuralMapping(committed.result, "split-shot");
        const mappedShots = idMapping?.ids[prepared.transition.sourceShotId] ?? [];
        const right = mappedShots.length > 1 ? shotById(project, mappedShots[1]) : undefined;
        if (!idMapping || !right) return failed(history, workspace, "missing-id-mapping", "Split shot did not return its right-side ID mapping");
        nextWorkspace = {
          activeShotId: right.id,
          selection: remapSelection(workspace.selection, new Set([prepared.transition.sourceShotId]), right, right.id, project, idMapping.ids),
          playhead: 0,
        };
        break;
      }
      case "merge": {
        const idMapping = structuralMapping(committed.result, "merge-shots");
        const left = shotById(project, prepared.transition.leftShotId);
        if (!idMapping || !left) return failed(history, workspace, "missing-id-mapping", "Merge did not return its surviving left-shot mapping");
        const activeWasSource = workspace.activeShotId === prepared.transition.leftShotId || workspace.activeShotId === prepared.transition.rightShotId;
        const nextActive = activeWasSource ? left : shotById(project, workspace.activeShotId)!;
        const playhead = workspace.activeShotId === prepared.transition.rightShotId
          ? addTimelineTimes(prepared.transition.leftDuration, workspace.playhead)
          : workspace.playhead;
        nextWorkspace = {
          activeShotId: nextActive.id,
          selection: remapSelection(
            workspace.selection,
            new Set([prepared.transition.leftShotId, prepared.transition.rightShotId]),
            nextActive,
            left.id,
            project,
            idMapping.ids,
          ),
          playhead,
        };
        break;
      }
      case "delete": {
        if (workspace.activeShotId === prepared.transition.shotId) {
          const fallback = project.shots[Math.min(prepared.transition.sourceIndex, project.shots.length - 1)];
          const normalized = normalizeEditorSelection(workspace.selection, project, fallback.id);
          nextWorkspace = {
            activeShotId: fallback.id,
            selection: normalized.kind === "shot"
              ? shotSelection([...normalized.shotIds.filter((id) => id !== fallback.id), fallback.id], fallback.id)
              : normalized,
            playhead: 0,
          };
        } else {
          nextWorkspace = {
            ...workspace,
            selection: normalizeEditorSelection(workspace.selection, project, workspace.activeShotId),
          };
        }
        break;
      }
      case "duration": {
        const updated = shotById(project, prepared.transition.shotId)!;
        if (workspace.activeShotId === updated.id && timelineTickFor(workspace.playhead) > timelineTickFor(updated.duration)) {
          nextWorkspace = { ...workspace, playhead: updated.duration };
        }
        playback = "pause";
        break;
      }
    }
    return {
      ok: true,
      history: committed.history,
      workspace: nextWorkspace,
      result: committed.result,
      playback,
      label: prepared.label,
    };
  } catch (error) {
    return failed(history, workspace, "invalid-operation", error instanceof Error ? error.message : "Shot action could not be applied");
  }
}
