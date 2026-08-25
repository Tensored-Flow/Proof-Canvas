import {
  buildCompilerSchedule,
  type CompilerTimelineAuthorityIssue,
  type CompilerTimelineAuthorityIssueCode,
} from "./compilerSchedule";
import {
  projectAnimationAuthoringTransitionIssue,
  type ProjectDocument,
  type Shot,
} from "./schema";
import { effectiveObjectLifetime } from "./timeline";

/** Audio transport/mux support belongs to M4 and remains a render-time capability failure. */
export const AUTHORING_POLICY_EXCLUDED_COMPILER_CODES = Object.freeze([
  "AUDIO_TRACK_RENDER_UNSUPPORTED",
] as const);

export interface TimelineAuthoringIssueSignature extends CompilerTimelineAuthorityIssue {
  /** Stable relation identity. It contains IDs and edge kind, never diagnostic prose. */
  signature: string;
  /** Exact canonical bytes for only the authorities that determine this relation. */
  authorityFingerprint: string;
}

export type ProjectAuthoringTransitionAnalysis =
  | Readonly<{ allowed: true; authorityUnchanged?: true; previousIssues?: readonly TimelineAuthoringIssueSignature[]; nextIssues?: readonly TimelineAuthoringIssueSignature[] }>
  | Readonly<{
    allowed: false;
    reason: "animation-compatibility" | "introduced-timeline-authority" | "modified-timeline-authority";
    message: string;
    issue?: TimelineAuthoringIssueSignature;
  }>;

function canonicalAuthorityBytes(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().flatMap((key) => (
        record[key] === undefined ? [] : [[key, canonical(record[key])]]
      )));
    }
    return candidate;
  };
  return JSON.stringify(canonical(value));
}

function relationSignature(issue: CompilerTimelineAuthorityIssue): string {
  return [
    issue.code,
    issue.shotId,
    issue.trackId ?? "",
    issue.conflictingTrackId ?? "",
    issue.animationId ?? "",
    issue.objectId ?? "",
    issue.lifetimeBoundary ?? "",
  ].join("\u0000");
}

type ParentPathLink = Readonly<{ id: string; parentId?: string }>;

function objectPath(shot: Shot, objectId: string): ParentPathLink[] {
  const objects = new Map(shot.objects.map((object) => [object.id, object]));
  const path: ParentPathLink[] = [];
  const visited = new Set<string>();
  let cursor = objects.get(objectId);
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    path.push({ id: cursor.id, parentId: cursor.parentId });
    cursor = cursor.parentId ? objects.get(cursor.parentId) : undefined;
  }
  return path;
}

function ancestorIds(shot: Shot, objectId: string): ReadonlySet<string> {
  return new Set(objectPath(shot, objectId).map(({ id }) => id));
}

function sharesHierarchy(shot: Shot, leftId: string, rightId: string): boolean {
  return ancestorIds(shot, leftId).has(rightId) || ancestorIds(shot, rightId).has(leftId);
}

function connectingParentPath(shot: Shot, leftId: string, rightId: string): readonly ParentPathLink[] | undefined {
  if (!sharesHierarchy(shot, leftId, rightId)) return undefined;
  const leftPath = objectPath(shot, leftId);
  const rightInLeft = leftPath.findIndex(({ id }) => id === rightId);
  const path = rightInLeft >= 0 ? leftPath.slice(0, rightInLeft + 1) : (() => {
    const rightPath = objectPath(shot, rightId);
    const leftInRight = rightPath.findIndex(({ id }) => id === leftId);
    return rightPath.slice(0, leftInRight + 1);
  })();
  return path.map((link, index) => index === path.length - 1 ? { id: link.id } : link);
}

function participatingHierarchyPaths(
  shot: Shot,
  leftIds: readonly string[],
  rightIds: readonly string[],
): Array<Readonly<{ leftId: string; rightId: string; path: readonly ParentPathLink[] }>> {
  const paths: Array<Readonly<{ leftId: string; rightId: string; path: readonly ParentPathLink[] }>> = [];
  for (const leftId of [...new Set(leftIds)].sort()) {
    for (const rightId of [...new Set(rightIds)].sort()) {
      const path = connectingParentPath(shot, leftId, rightId);
      if (path) paths.push({ leftId, rightId, path });
    }
  }
  return paths;
}

function authorityFingerprint(shot: Shot, issue: CompilerTimelineAuthorityIssue): string {
  const trackIds = new Set([issue.trackId, issue.conflictingTrackId].filter((id): id is string => Boolean(id)));
  const tracks = shot.propertyTracks.filter(({ id }) => trackIds.has(id)).sort((left, right) => left.id.localeCompare(right.id));
  const animations = issue.animationId
    ? shot.animations.filter(({ id }) => id === issue.animationId).sort((left, right) => left.id.localeCompare(right.id))
    : [];
  const trackObjectIds = tracks.flatMap((track) => track.target.kind === "object" ? [track.target.objectId] : []);
  const animationObjectIds = animations.flatMap((animation) => animation.type === "camera-focus" ? [] : animation.targetIds);
  switch (issue.code) {
    case "TRACK_EASING_DOMAIN_UNSAFE":
      return canonicalAuthorityBytes({ track: tracks[0] });
    case "TRACK_SEMANTIC_COLLISION":
      return canonicalAuthorityBytes({
        track: tracks[0],
        animation: animations[0],
        hierarchyPaths: participatingHierarchyPaths(shot, trackObjectIds, animationObjectIds),
      });
    case "TRACK_TRACK_COLLISION": {
      const leftObjectIds = tracks[0]?.target.kind === "object" ? [tracks[0].target.objectId] : [];
      const rightObjectIds = tracks[1]?.target.kind === "object" ? [tracks[1].target.objectId] : [];
      return canonicalAuthorityBytes({
        tracks,
        hierarchyPaths: participatingHierarchyPaths(shot, leftObjectIds, rightObjectIds),
      });
    }
    case "LIFETIME_SEMANTIC_COLLISION": {
      const lifetime = issue.objectId ? effectiveObjectLifetime(shot, issue.objectId) : undefined;
      return canonicalAuthorityBytes({
        animation: animations[0],
        effectiveBoundary: issue.lifetimeBoundary === "enter" ? lifetime?.start : lifetime?.end,
        causalParentPath: issue.objectId ? objectPath(shot, issue.objectId) : [],
        animationHierarchyPaths: issue.objectId ? participatingHierarchyPaths(shot, animationObjectIds, [issue.objectId]) : [],
      });
    }
    case "TRACK_LIFETIME_COLLISION": {
      const lifetime = issue.objectId ? effectiveObjectLifetime(shot, issue.objectId) : undefined;
      return canonicalAuthorityBytes({
        track: tracks[0],
        effectiveBoundary: issue.lifetimeBoundary === "enter" ? lifetime?.start : lifetime?.end,
        causalParentPath: issue.objectId ? objectPath(shot, issue.objectId) : [],
        trackHierarchyPaths: issue.objectId ? participatingHierarchyPaths(shot, trackObjectIds, [issue.objectId]) : [],
      });
    }
  }
}

function projectTimelineAuthorityFingerprint(project: ProjectDocument): string {
  return canonicalAuthorityBytes([...project.shots].sort((left, right) => left.id.localeCompare(right.id)).map((shot) => ({
    id: shot.id,
    duration: shot.duration,
    objects: [...shot.objects].sort((left, right) => left.id.localeCompare(right.id)).map((object) => ({
      id: object.id,
      type: object.type,
      parentId: object.parentId,
      visible: object.visible,
      lifetime: object.lifetime,
    })),
    animations: [...shot.animations].sort((left, right) => left.id.localeCompare(right.id)),
    propertyTracks: [...shot.propertyTracks].sort((left, right) => left.id.localeCompare(right.id)),
  })));
}

/** Complete non-audio renderer-rejected timeline authority for a parsed project. */
export function projectTimelineAuthoringIssues(project: ProjectDocument): TimelineAuthoringIssueSignature[] {
  const issues: TimelineAuthoringIssueSignature[] = [];
  for (const shot of project.shots) {
    const schedule = buildCompilerSchedule(shot, project.settings.frameRate);
    for (const issue of schedule.authorityIssues) {
      issues.push({
        ...issue,
        signature: relationSignature(issue),
        authorityFingerprint: authorityFingerprint(shot, issue),
      });
    }
  }
  return issues.sort((left, right) => left.signature.localeCompare(right.signature));
}

function issueIds(issue: CompilerTimelineAuthorityIssue): string {
  return [
    `shot ${issue.shotId}`,
    issue.trackId ? `track ${issue.trackId}` : undefined,
    issue.conflictingTrackId ? `conflicting track ${issue.conflictingTrackId}` : undefined,
    issue.animationId ? `animation ${issue.animationId}` : undefined,
    issue.objectId ? `object ${issue.objectId}` : undefined,
    issue.lifetimeBoundary ? `${issue.lifetimeBoundary} lifetime edge` : undefined,
  ].filter((part): part is string => Boolean(part)).join(", ");
}

/**
 * Authoring is monotonic with respect to legacy renderer-rejected authority:
 * exact relations may survive unrelated edits or disappear through repair,
 * but cannot be introduced, worsened, or modified while still invalid.
 */
export function analyzeProjectAuthoringTransition(
  previous: ProjectDocument,
  next: ProjectDocument,
): ProjectAuthoringTransitionAnalysis {
  const animationIssue = projectAnimationAuthoringTransitionIssue(previous, next);
  if (animationIssue) return { allowed: false, reason: "animation-compatibility", message: animationIssue };
  if (projectTimelineAuthorityFingerprint(previous) === projectTimelineAuthorityFingerprint(next)) {
    return { allowed: true, authorityUnchanged: true };
  }
  const previousIssues = projectTimelineAuthoringIssues(previous);
  const nextIssues = projectTimelineAuthoringIssues(next);
  const previousBySignature = new Map(previousIssues.map((issue) => [issue.signature, issue]));
  for (const issue of nextIssues) {
    const prior = previousBySignature.get(issue.signature);
    if (!prior) return {
      allowed: false,
      reason: "introduced-timeline-authority",
      issue,
      message: `Authoring would introduce renderer-rejected ${issue.code}: ${issueIds(issue)}`,
    };
    if (prior.authorityFingerprint !== issue.authorityFingerprint) return {
      allowed: false,
      reason: "modified-timeline-authority",
      issue,
      message: `Legacy renderer-rejected ${issue.code} authority cannot be modified while it remains invalid: ${issueIds(issue)}`,
    };
  }
  return { allowed: true, previousIssues, nextIssues };
}

export function projectAuthoringTransitionIssue(previous: ProjectDocument, next: ProjectDocument): string | undefined {
  const analysis = analyzeProjectAuthoringTransition(previous, next);
  return analysis.allowed ? undefined : analysis.message;
}

export function isTimelineAuthoringIssueCode(code: string): code is CompilerTimelineAuthorityIssueCode {
  return [
    "TRACK_EASING_DOMAIN_UNSAFE",
    "TRACK_SEMANTIC_COLLISION",
    "TRACK_TRACK_COLLISION",
    "LIFETIME_SEMANTIC_COLLISION",
    "TRACK_LIFETIME_COLLISION",
  ].includes(code);
}
