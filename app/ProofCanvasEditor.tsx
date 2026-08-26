'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ComponentProps, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import CanvasStage, { resolveCanvasKeyboardTransformIntent, temporallyTransformsObject, type CanvasKeyboardTransformIntent } from './CanvasStage'
import GraphInspector, { type GraphDraftValue } from './GraphInspector'
import KeyframeInspector from './KeyframeInspector'
import MathPropertiesEditor from './MathPropertiesEditor'
import PropertyKeyframeField from './PropertyKeyframeField'
import ShotStoryboard, { type StoryboardActionResult } from './ShotStoryboard'
import ShotTimeline from './ShotTimeline'
import { REQUIRED_AI_COMMANDS, interpretDemoCommand, type AiProposal } from '@/lib/proofcanvas/ai'
import { compileManim } from '@/lib/proofcanvas/compiler'
import { SEMANTIC_COMPONENTS, insertSemanticComponent, type SemanticComponentId } from '@/lib/proofcanvas/components'
import { critiqueProject, type CritiqueIssue } from '@/lib/proofcanvas/critique'
import { ensureSessionCsrfToken } from '@/lib/proofcanvas/csrf.client'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { applyDocumentOperations } from '@/lib/proofcanvas/documentOperations'
import { projectAuthoringTransitionIssue, projectGraphAuthoringIssues } from '@/lib/proofcanvas/authoringPolicy'
import { addTimelineTimes, compareTimelineTimes, logicalFrameFor, resolutionFor, subtractTimelineTimes, type LogicalFrame } from '@/lib/proofcanvas/frame'
import { canRedo, canUndo, commitOperations, commitProject, createHistory, redoAuthoringHistory, undoAuthoringHistory, type ProjectHistory } from '@/lib/proofcanvas/history'
import { commandTargetWithin, createEditorCommandController, EDITOR_COMMANDS, type EditorCommandId, type EditorCommandInvocation } from '@/lib/proofcanvas/editorCommands'
import { EditorSequencePlaybackClock, type EditorSequencePlaybackSnapshot } from '@/lib/proofcanvas/editorPlayback'
import { animationSelection, keyframeSelection, normalizeEditorSelection, objectSelection, projectSelection, selectedAnimationIds, selectedObjectIds, shotSelection, type EditorKeyframeRef, type EditorSelection } from '@/lib/proofcanvas/editorSelection'
import { inheritedObjectLifetime, resolveSetObjectLifetime, timelineIntentAuthorityIsCurrent, type TimelineIntentAuthorityBase, type TimelineOperationIntent } from '@/lib/proofcanvas/editorTimeline'
import { beginEditorShotSequencePlayback, buildEditorShotSequence, commitEditorShotAction, deriveEditorShotSequencePosition, minimumAuthoredShotDuration, resolveEditorShotActivation, seekEditorShotSequence, advanceEditorShotSequencePlayback, validateEditorShotWorkspace, type EditorShotAction, type EditorShotWorkspace } from '@/lib/proofcanvas/editorShotSequence'
import { allocateId, collectProjectIds } from '@/lib/proofcanvas/ids'
import { applyOperations, duplicateObjects, effectiveLockOwner, effectiveVisibilityOwner, inspectOperations, type ManualSceneOperation } from '@/lib/proofcanvas/operations'
import { previewShotAtTime } from '@/lib/proofcanvas/preview'
import { PROOFCANVAS_BRACE_LABEL_MAX_CHARS, PROOFCANVAS_PROJECT_MAX_BYTES, PROOFCANVAS_SCHEMA_LIMITS, PROOFCANVAS_TEXT_MAX_CHARS, ProjectDocumentSchema, SceneOperationSchema, animationAuthoringCompatibilityIssue, canonicalProjectJson, cloneSerializable, currentShapePropertiesIssue, formatShapePropertiesIssue, mathPropertiesFor, objectTypeSupportsStyleProperty, parseProjectDocument, type AnimationType, type CurrentShapeProperties, type Easing, type MathProperties, type ProjectDocument, type PropertyKeyframe, type PropertyTrack, type SceneAnimation, type SceneObject, type SceneOperation, type Shot } from '@/lib/proofcanvas/schema'
import { ARROW_TIP_SHAPES, BRACE_DIRECTIONS, MAX_ARROW_TIP_SIZE_RATIO, MIN_ARROW_TIP_SIZE_RATIO, SHAPE_LINE_CAPS, SHAPE_LINE_JOINS, isCurrentShapeType, isLinearShapeType, lineEndpointsForTransform, resolveShapeDimensions, resolveShapeGeometry, resolveShapePaint, shapeAuthoringIssue, transformFromLineEndpoints, type ArrowTipShape, type BraceDirection, type FreeformShapeNode, type NormalizedShapePoint, type ShapeLineCap, type ShapeLineJoin } from '@/lib/proofcanvas/shapeGeometry'
import { PROOFCANVAS_SHAPE_PRESET_MIME, SHAPE_PRESETS, insertShapePreset, searchShapePresets, shapePresetById, type ShapePresetId } from '@/lib/proofcanvas/shapePresets'
import { EDITORIAL_INK_STYLE_ID, RAW_MANIM_STYLE_ID, resolvedGraphStroke, styleById } from '@/lib/proofcanvas/styles'
import { propertyTrackKey } from '@/lib/proofcanvas/timeline'

const STORAGE_KEY = 'proofcanvas_project_v1'
const recoveryStorageKey = (projectId: string) => `proofcanvas_recovery_${projectId}`
type LibraryTab = 'text' | 'math' | 'shapes' | 'graphs' | 'components' | 'styles'
const LIBRARY_TABS: readonly LibraryTab[] = ['text', 'math', 'shapes', 'graphs', 'components', 'styles']
const STYLE_OPTIONS = [
  { id: EDITORIAL_INK_STYLE_ID, name: 'Editorial Ink' },
  { id: RAW_MANIM_STYLE_ID, name: 'Raw Manim' },
] as const
const OBJECT_TYPES: ReadonlyArray<{ type: Exclude<SceneObject['type'], 'group' | 'image' | 'svg'>; label: string; tab: Exclude<LibraryTab, 'components' | 'styles'>; keywords: string }> = [
  { type: 'text', label: 'text', tab: 'text', keywords: 'title heading paragraph label narration' },
  { type: 'math', label: 'math', tab: 'math', keywords: 'latex equation formula expression' },
  { type: 'brace', label: 'brace', tab: 'math', keywords: 'annotation measure label' },
  { type: 'axes', label: 'coordinate axes', tab: 'graphs', keywords: 'plot coordinate plane chart' },
  { type: 'graph', label: 'function graph', tab: 'graphs', keywords: 'plot curve function' },
]
const SHAPE_PRESET_ICONS: Readonly<Record<ShapePresetId, string>> = {
  rectangle: '□',
  'rounded-rectangle': '▢',
  circle: '○',
  ellipse: '⬭',
  polygon: '⬠',
  line: '—',
  'dashed-line': '┄',
  arrow: '→',
  'double-arrow': '↔',
  brace: '⏟',
  bracket: '[',
  'freeform-path': '⌁',
  'highlight-box': '▧',
  underline: '_',
  'cross-out': '×',
  'dot-point': '•',
}
const ENDPOINT_AUTHORITY_PROPERTIES: ReadonlySet<PropertyTrack['property']> = new Set(['x', 'y', 'width', 'rotation', 'scale', 'scaleX'])
const ENDPOINT_ANCESTOR_AUTHORITY_PROPERTIES: ReadonlySet<PropertyTrack['property']> = new Set(['x', 'y', 'width', 'height', 'rotation', 'scale', 'scaleX', 'scaleY'])
const BRACE_AXIS_AUTHORITY_PROPERTIES: ReadonlySet<PropertyTrack['property']> = new Set(['width', 'height', 'rotation', 'scale', 'scaleX', 'scaleY'])
const ANIMATION_TYPES: AnimationType[] = ['appear', 'fade-in', 'fade-out', 'write', 'create', 'move', 'scale', 'transform', 'emphasise', 'camera-focus']
const EASINGS: Easing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'editorial', 'spring-soft', 'there-and-back']
const TIMELINE_LANE_COUNT = 4
const INITIAL_DEMO_PLAYHEAD = 6.8
const MIN_LEFT_PANEL = 176
const MAX_LEFT_PANEL = 320
const MIN_RIGHT_PANEL = 240
const MAX_RIGHT_PANEL = 400
const MIN_TIMELINE_HEIGHT = 156
const MAX_TIMELINE_HEIGHT = 380

type EditorAuthority = Readonly<{
  history: ProjectHistory
  workspace: EditorShotWorkspace
  isPlaying: boolean
}>

type ShotDialogState = Readonly<{
  kind: 'rename' | 'duration' | 'delete'
  shotId: string
}> | null

function reconcileEditorWorkspace(project: ProjectDocument, candidate: EditorShotWorkspace): EditorShotWorkspace {
  const activeShot = project.shots.find(({ id }) => id === candidate.activeShotId) ?? project.shots[0]
  const playhead = Number.isFinite(candidate.playhead)
    ? Math.max(0, Math.min(activeShot.duration, candidate.playhead))
    : 0
  let selection = normalizeEditorSelection(candidate.selection, project, activeShot.id)
  if (selection.kind === 'shot' && (selection.primaryShotId !== activeShot.id || !selection.shotIds.includes(activeShot.id))) {
    selection = shotSelection([activeShot.id])
  }
  const reconciled = { activeShotId: activeShot.id, selection, playhead }
  return validateEditorShotWorkspace(project, reconciled).ok
    ? reconciled
    : { activeShotId: activeShot.id, selection: shotSelection([activeShot.id]), playhead }
}

function sequenceClockSnapshot(project: ProjectDocument, workspace: EditorShotWorkspace): EditorSequencePlaybackSnapshot {
  const reconciled = reconcileEditorWorkspace(project, workspace)
  const position = deriveEditorShotSequencePosition(project, reconciled)
  return position.ok
    ? { globalTime: position.globalTime, shotId: reconciled.activeShotId, localTime: reconciled.playhead, atFinalEndpoint: position.atFinalEndpoint }
    : { globalTime: 0, shotId: reconciled.activeShotId, localTime: reconciled.playhead, atFinalEndpoint: false }
}

function storyboardCardFor(shotId: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.pc-storyboard-card[data-shot-id]')]
    .find(({ dataset }) => dataset.shotId === shotId) ?? null
}

function storyboardShotIdFromCommandTarget(target: EventTarget | null | undefined, project: ProjectDocument): string | null {
  if (!target || typeof (target as Element).closest !== 'function') return null
  const shotId = (target as Element).closest<HTMLElement>('.pc-storyboard-card[data-shot-id]')?.dataset.shotId
  return shotId && project.shots.some(({ id }) => id === shotId) ? shotId : null
}

function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function shotDeleteDescription(project: ProjectDocument, shot: Shot): string {
  const keyframes = shot.propertyTracks.reduce((total, track) => total + track.keyframes.length, 0)
  const shotIndex = project.shots.findIndex(({ id }) => id === shot.id)
  const activation = shotIndex >= 0 && shotIndex < project.shots.length - 1
    ? 'The next shot at this position becomes active.'
    : 'The previous shot becomes active.'
  return `Delete “${shot.name}” (${shot.duration.toFixed(2)} seconds)? This removes ${counted(shot.objects.length, 'object')}, ${counted(shot.animations.length, 'semantic animation')}, ${counted(keyframes, 'keyframe')}, ${counted(shot.audioClips.length, 'audio clip')}, ${counted(shot.captionClips.length, 'caption')}, and ${counted(shot.markers.length, 'marker')} from the sequence. ${activation} Undo can restore this shot until another branch edit.`
}

type ClientRenderJob = {
  id: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  quality: 'preview' | 'production'
  sourceSha256: string
  error: { code: string; message: string } | null
  video: { sha256: string; bytes: number } | null
}

type OperationReview = {
  summary: string
  details: string
}

type CritiqueResult = {
  issues: CritiqueIssue[]
  revision: string
  shotId: string
}

type DurableEditorContext = {
  projectId: string
  revision: number
  csrfToken: string | null
}

type DurableSaveState = 'saved' | 'waiting' | 'saving' | 'offline' | 'blocked' | 'conflict' | 'reconcile'

type DurableCheckpoint = {
  id: string
  projectId: string
  revision: number
  label: string
  createdAt: string
  recoveryRequired: boolean
}

type PendingDurableSave = {
  canonical: string
  document: ProjectDocument
  mutationId: string
  expectedRevision: number
}

type BlockedDurableSave = Pick<PendingDurableSave, 'canonical' | 'expectedRevision'>

function blockedSaveMatches(
  blocked: readonly BlockedDurableSave[],
  canonical: string,
  expectedRevision: number,
): boolean {
  return blocked.some((candidate) => candidate.expectedRevision === expectedRevision && candidate.canonical === canonical)
}

function rememberBlockedSave(
  blocked: readonly BlockedDurableSave[],
  candidate: BlockedDurableSave,
): BlockedDurableSave[] {
  const withoutDuplicate = blocked.filter(({ canonical, expectedRevision }) => (
    canonical !== candidate.canonical || expectedRevision !== candidate.expectedRevision
  ))
  // Do not evict an older rejection while its durable base is current: doing
  // so would let A -> B -> A retry bytes the server already classified as a
  // deterministic failure. The collection is page-session scoped and every
  // entry is discarded as soon as any save advances the durable revision.
  return [...withoutDuplicate, candidate]
}

type NumericField = {
  key: string
  label: string
  fallback: number
  min: number
  max: number
  minMagnitude?: number
}

const TRANSFORM_NUMERIC_FIELDS: ReadonlyArray<Omit<NumericField, 'fallback'>> = [
  { key: 'x', label: 'X position', min: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude },
  { key: 'y', label: 'Y position', min: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude },
  { key: 'width', label: 'Width', min: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin, max: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax },
  { key: 'height', label: 'Height', min: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin, max: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax },
  { key: 'rotation', label: 'Rotation', min: -PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude },
]

function numericFieldAccepts(field: NumericField, value: number): boolean {
  return Number.isFinite(value)
    && value >= field.min
    && value <= field.max
    && (field.minMagnitude === undefined || Math.abs(value) >= field.minMagnitude)
}

function familyObjectIds(shot: Shot, objectIds: readonly string[]): string[] {
  const ids = new Set(objectIds)
  const queue = [...objectIds]
  while (queue.length) {
    const parentId = queue.shift()!
    const parent = shot.objects.find(({ id }) => id === parentId)
    if (parent?.type !== 'group') continue
    for (const child of shot.objects.filter(({ parentId: candidate }) => candidate === parentId)) {
      if (ids.has(child.id)) continue
      ids.add(child.id)
      queue.push(child.id)
    }
  }
  return [...ids]
}

function objectIdsWithAncestors(shot: Shot, objectIds: readonly string[]): string[] {
  const ids = new Set(objectIds)
  for (const objectId of objectIds) {
    let cursor = shot.objects.find(({ id }) => id === objectId)
    while (cursor?.parentId) {
      ids.add(cursor.parentId)
      cursor = shot.objects.find(({ id }) => id === cursor?.parentId)
    }
  }
  return [...ids]
}

function objectIdsForReview(shot: Shot, operation: SceneOperation): string[] {
  if (operation.type === 'add-object') return [operation.object.id]
  if (operation.type === 'update-object' || operation.type === 'delete-object' || operation.type === 'reorder-object' || operation.type === 'lock-object' || operation.type === 'unlock-object') {
    const object = shot.objects.find(({ id }) => id === operation.objectId)
    const familyAffectingUpdate = operation.type === 'update-object'
      && object?.type === 'group'
      && (operation.patch.transform !== undefined || operation.patch.visible !== undefined || operation.patch.parentId !== undefined)
    const changesDerivedBounds = operation.type === 'delete-object'
      || (operation.type === 'update-object' && (operation.patch.transform !== undefined || operation.patch.parentId !== undefined))
    return operation.type === 'delete-object' || operation.type === 'reorder-object' || familyAffectingUpdate || changesDerivedBounds
      ? objectIdsWithAncestors(shot, familyObjectIds(shot, [operation.objectId]))
      : [operation.objectId]
  }
  if (operation.type === 'group-objects') return [...objectIdsWithAncestors(shot, familyObjectIds(shot, operation.objectIds)), operation.group.id]
  if (operation.type === 'ungroup-object') return objectIdsWithAncestors(shot, familyObjectIds(shot, [operation.groupId]))
  if (operation.type === 'align-objects' || operation.type === 'distribute-objects') return objectIdsWithAncestors(shot, familyObjectIds(shot, operation.objectIds))
  return []
}

function snapshotForReview(project: ProjectDocument, shotId: string, operation: SceneOperation) {
  const shot = project.shots.find(({ id }) => id === shotId)
  if (!shot) return null
  const objectIds = objectIdsForReview(shot, operation)
  const animationIds = operation.type === 'add-animation' ? [operation.animation.id]
    : operation.type === 'update-animation' || operation.type === 'delete-animation' ? [operation.animationId]
      : operation.type === 'delete-object' ? shot.animations.filter(({ targetIds }) => targetIds.some((id) => objectIds.includes(id))).map(({ id }) => id)
        : []
  return {
    activeStyleId: project.activeStyleId,
    styleMotion: operation.type === 'set-style' ? project.styles.find(({ id }) => id === project.activeStyleId)?.motion : undefined,
    camera: operation.type === 'set-camera' ? shot.camera : undefined,
    layerOrder: operation.type === 'reorder-object' || operation.type === 'group-objects' || operation.type === 'ungroup-object' || (operation.type === 'update-object' && operation.patch.parentId !== undefined)
      ? shot.objects.map(({ id }) => id)
      : undefined,
    objects: objectIds.map((id) => shot.objects.find((object) => object.id === id) ?? { id, state: 'absent' }),
    animations: operation.type === 'set-style'
      ? project.shots.flatMap((candidate) => candidate.animations.map(({ id, easing, duration }) => ({ shotId: candidate.id, id, easing, duration })))
      : animationIds.map((id) => shot.animations.find((animation) => animation.id === id) ?? { id, state: 'absent' }),
  }
}

function reviewOperations(project: ProjectDocument, shotId: string, proposal: AiProposal): OperationReview[] {
  if (!proposal.operations.length) return []
  try {
    const inspected = inspectOperations(project, shotId, proposal.operations, (candidate, operation) => {
      const shot = candidate.shots.find(({ id }) => id === shotId)
      const objectIds = shot ? objectIdsForReview(shot, operation) : []
      return {
        snapshot: snapshotForReview(candidate, shotId, operation),
        names: objectIds.map((id) => {
          const object = shot?.objects.find((item) => item.id === id)
          return object ? `${object.name} (${id})` : id
        }),
      }
    })
    return inspected.inspections.map(({ operation, before, after }, index) => ({
      summary: `${proposal.summary[index] ?? operation.type}${after.names.length ? ` — ${after.names.join(', ')}` : ''}`,
      details: JSON.stringify({ operation, before: before.snapshot, after: after.snapshot }, null, 2),
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The proposed operation batch is invalid'
    return proposal.operations.map((operation, index) => ({
      summary: proposal.summary[index] ?? operation.type,
      details: JSON.stringify({ operation, before: snapshotForReview(project, shotId, operation), validationError: message }, null, 2),
    }))
  }
}

function renderJobFromPayload(candidate: unknown): ClientRenderJob {
  if (!candidate || typeof candidate !== 'object') throw new Error('Renderer returned an invalid job')
  const job = candidate as Partial<ClientRenderJob>
  if (
    typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(job.id)
    || !['pending', 'running', 'succeeded', 'failed'].includes(String(job.status))
    || !['preview', 'production'].includes(String(job.quality))
    || typeof job.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(job.sourceSha256)
  ) throw new Error('Renderer returned an invalid job')
  return job as ClientRenderJob
}

function responseMessage(candidate: unknown, fallback: string): string {
  return candidate && typeof candidate === 'object' && typeof (candidate as { message?: unknown }).message === 'string'
    ? (candidate as { message: string }).message
    : fallback
}

function responseCode(candidate: unknown): string | undefined {
  return candidate && typeof candidate === 'object' && typeof (candidate as { code?: unknown }).code === 'string'
    ? (candidate as { code: string }).code
    : undefined
}

const DURABLE_TUPLE_REJECTION_CODES = new Set(['invalid_project', 'request_too_large'])
const DURABLE_RECONCILIATION_CODES = new Set(['idempotency_conflict', 'project_not_found', 'project_recovery_required'])

function selectionBounds(objects: readonly SceneObject[]) {
  const corners = objects.flatMap((object) => {
    const halfWidth = (object.transform.width ?? 60) * Math.abs(object.transform.scaleX) / 2
    const halfHeight = (object.transform.height ?? 30) * Math.abs(object.transform.scaleY) / 2
    const radians = object.transform.rotation * Math.PI / 180
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    return [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]].map(([x, y]) => ({
      x: object.transform.x + x * cos - y * sin,
      y: object.transform.y + x * sin + y * cos,
    }))
  })
  const left = Math.min(...corners.map(({ x }) => x))
  const right = Math.max(...corners.map(({ x }) => x))
  const top = Math.min(...corners.map(({ y }) => y))
  const bottom = Math.max(...corners.map(({ y }) => y))
  return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top }
}

function timelineLaneMap(animations: readonly SceneAnimation[], draft: { id: string; start: number; duration: number } | null): ReadonlyMap<string, number> {
  const timing = animations.map((animation) => draft?.id === animation.id ? { ...animation, start: draft.start, duration: draft.duration } : animation)
    .sort((left, right) => compareTimelineTimes(left.start, right.start) || left.id.localeCompare(right.id))
  const laneEnds = Array.from({ length: TIMELINE_LANE_COUNT }, () => Number.NEGATIVE_INFINITY)
  const lanes = new Map<string, number>()
  for (const animation of timing) {
    let lane = laneEnds.findIndex((end) => !Number.isFinite(end) || compareTimelineTimes(end, animation.start) <= 0)
    if (lane < 0) lane = laneEnds.reduce((earliest, end, index) => compareTimelineTimes(end, laneEnds[earliest]) < 0 ? index : earliest, 0)
    lanes.set(animation.id, lane)
    laneEnds[lane] = Math.max(laneEnds[lane], addTimelineTimes(animation.start, animation.duration))
  }
  return lanes
}

function newObject(type: Exclude<SceneObject['type'], 'group'>, id: string, index: number, frame: LogicalFrame): SceneObject {
  const cascadeX = ((index - 1) % 5 - 2) * Math.min(18, frame.width / 30)
  const cascadeY = ((Math.floor((index - 1) / 5) % 5) - 2) * Math.min(18, frame.height / 30)
  // Ordinary insertions are at most 240x150. Keep that complete authored box
  // inside every logical frame while retaining a small deterministic cascade.
  const x = Math.max(120, Math.min(frame.width - 120, frame.centerX + cascadeX))
  const y = Math.max(75, Math.min(frame.height - 75, frame.centerY + cascadeY))
  const base: SceneObject = {
    id, type, name: `${type[0].toUpperCase()}${type.slice(1)} ${index}`, locked: false, visible: true,
    transform: { x, y, width: 150, height: 70, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {}, properties: {},
  }
  switch (type) {
    case 'text': return { ...base, name: 'Plain text', semanticRole: 'body-copy', style: { fontSize: 24, textAlign: 'left' }, properties: { content: 'A precise statement' } }
    case 'math': return { ...base, name: 'Mathematical text', semanticRole: 'equation', style: { fontSize: 30, textAlign: 'left' }, properties: { content: '\\sum_{k=0}^{n} 2^k', renderer: 'mathtex', mode: 'display' } }
    case 'circle': return { ...base, transform: { ...base.transform, width: 90, height: 90 }, style: { stroke: '#315866', strokeWidth: 2 }, properties: {} }
    case 'rectangle': return { ...base, transform: { ...base.transform, width: 150, height: 78 }, style: { stroke: '#252722', opacity: 0.22 }, properties: {} }
    case 'line': return { ...base, transform: { ...base.transform, width: 180, height: 2 }, style: { stroke: '#655f55', strokeWidth: 1 }, properties: {} }
    case 'arrow': return { ...base, transform: { ...base.transform, width: 160, height: 18 }, style: { stroke: '#71402d', strokeWidth: 2 }, properties: {} }
    case 'brace': return { ...base, transform: { ...base.transform, width: 220, height: 34 }, style: { stroke: '#71402d', fontSize: 18 }, properties: { label: 'n pieces', shape: { kind: 'brace', direction: 'below', spacing: 12 } } }
    case 'ellipse': return { ...base, transform: { ...base.transform, width: 140, height: 84 }, style: { stroke: '#315866', strokeWidth: 2 }, properties: { shape: { kind: 'ellipse' } } }
    case 'polygon': return { ...base, transform: { ...base.transform, width: 130, height: 120 }, style: { stroke: '#315866', strokeWidth: 2 }, properties: { shape: { kind: 'polygon', lineJoin: 'miter', vertices: [{ x: 0, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }] } } }
    case 'dashed-line': return { ...base, transform: { ...base.transform, width: 180, height: 2 }, style: { stroke: '#655f55', strokeWidth: 1 }, properties: { shape: { kind: 'dashed-line', lineCap: 'butt', dashLength: 14, gapLength: 9 } } }
    case 'double-arrow': return { ...base, transform: { ...base.transform, width: 180, height: 18 }, style: { stroke: '#71402d', strokeWidth: 2 }, properties: { shape: { kind: 'double-arrow', lineCap: 'butt', startTipShape: 'triangle', endTipShape: 'triangle', tipSizeRatio: 0.25 } } }
    case 'freeform-path': return { ...base, transform: { ...base.transform, width: 180, height: 90 }, style: { stroke: '#315866', strokeWidth: 2 }, properties: { shape: { kind: 'freeform-path', closed: false, lineCap: 'round', lineJoin: 'round', nodes: [{ point: { x: -0.5, y: 0.2 } }, { point: { x: 0, y: -0.2 } }, { point: { x: 0.5, y: 0.2 } }] } } }
    case 'axes': return { ...base, transform: { ...base.transform, width: 240, height: 150 }, properties: { xMin: -3, xMax: 3, yMin: -2, yMax: 4 } }
    case 'graph': return { ...base, transform: { ...base.transform, width: 240, height: 150 }, style: { stroke: '#315866', strokeWidth: 2 }, properties: { expression: { kind: 'power', base: { kind: 'variable' }, exponent: 2 }, xMin: -3, xMax: 3 } }
    case 'image': return { ...base, name: 'Image asset', properties: { source: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } }
    case 'svg': return { ...base, name: 'SVG asset', properties: { source: '/proofcanvas/assets/editorial-mark.svg' } }
  }
}

function objectAndAncestorIds(shot: Shot, object: SceneObject): ReadonlySet<string> {
  const ids = new Set<string>()
  let cursor: SceneObject | undefined = object
  while (cursor && !ids.has(cursor.id)) {
    ids.add(cursor.id)
    cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined
  }
  return ids
}

function objectFamilyHasPropertyAuthority(
  shot: Shot,
  object: SceneObject,
  properties: ReadonlySet<PropertyTrack['property']>,
  ancestorProperties: ReadonlySet<PropertyTrack['property']> = properties,
): boolean {
  const owners = objectAndAncestorIds(shot, object)
  return shot.propertyTracks.some((track) => (
    track.target.kind === 'object'
    && owners.has(track.target.objectId)
    && (track.target.objectId === object.id ? properties : ancestorProperties).has(track.property)
  ))
}

function download(name: string, type: string, contents: string) {
  const blob = new Blob([contents], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function descendants(shot: Shot, id: string): number {
  let depth = 0
  let cursor = shot.objects.find((object) => object.id === id)
  while (cursor?.parentId) {
    depth += 1
    cursor = shot.objects.find((object) => object.id === cursor?.parentId)
  }
  return depth
}

function selectionRootIds(shot: Shot, ids: readonly string[]): string[] {
  const selected = new Set(ids)
  return [...selected].filter((id) => {
    let cursor = shot.objects.find((object) => object.id === id)
    while (cursor?.parentId) {
      if (selected.has(cursor.parentId)) return false
      cursor = shot.objects.find((object) => object.id === cursor?.parentId)
    }
    return Boolean(cursor)
  })
}

function animationTargetsLocked(shot: Shot, animation: SceneAnimation): boolean {
  const familyIds = new Set(animation.targetIds)
  const queue = [...animation.targetIds]
  while (queue.length) {
    const parentId = queue.shift()!
    const parent = shot.objects.find(({ id }) => id === parentId)
    if (parent?.type !== 'group') continue
    for (const child of shot.objects.filter(({ parentId: candidate }) => candidate === parentId)) {
      if (familyIds.has(child.id)) continue
      familyIds.add(child.id)
      queue.push(child.id)
    }
  }
  return [...familyIds].some((id) => Boolean(effectiveLockOwner(shot, id)))
}

const IsolatedCanvasStage = memo(function IsolatedCanvasStage({
  clock,
  isPlaying,
  pausedPlayhead,
  previewStyleId,
  ...stageProps
}: Omit<ComponentProps<typeof CanvasStage>, 'playhead'> & {
  clock: EditorSequencePlaybackClock
  isPlaying: boolean
  pausedPlayhead: number
  previewStyleId: string
}) {
  const livePosition = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getServerSnapshot)
  const shownPlayhead = isPlaying && livePosition.shotId === stageProps.shot.id ? livePosition.localTime : pausedPlayhead
  return <div role="region" aria-label="Scene canvas" data-pc-canvas data-preview-time={shownPlayhead} data-preview-style-id={previewStyleId} className="pc-canvas-region"><CanvasStage {...stageProps} playhead={shownPlayhead}/></div>
})

const IsolatedTimelinePlayhead = memo(function IsolatedTimelinePlayhead({
  clock,
  isPlaying,
  pausedPlayhead,
  duration,
  shotId,
}: {
  clock: EditorSequencePlaybackClock
  isPlaying: boolean
  pausedPlayhead: number
  duration: number
  shotId: string
}) {
  const livePosition = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getServerSnapshot)
  const shownPlayhead = isPlaying && livePosition.shotId === shotId ? livePosition.localTime : pausedPlayhead
  return <><div className="pc-playhead" style={{ left: `${shownPlayhead / duration * 100}%` }}/><output aria-label="Shot playhead time">{shownPlayhead.toFixed(2)}s</output></>
})

const IsolatedSequenceScrubber = memo(function IsolatedSequenceScrubber({
  clock,
  isPlaying,
  pausedGlobalTime,
  duration,
  onSeek,
}: {
  clock: EditorSequencePlaybackClock
  isPlaying: boolean
  pausedGlobalTime: number
  duration: number
  onSeek(time: number): void
}) {
  const livePosition = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getServerSnapshot)
  const shownTime = isPlaying ? livePosition.globalTime : pausedGlobalTime
  return <label className="pc-scrubber"><span>Sequence</span><input type="range" min="0" max={duration} step="any" value={shownTime} disabled={isPlaying} aria-label="Sequence time" onChange={(event) => onSeek(event.target.valueAsNumber)}/><output aria-label="Sequence time display">{shownTime.toFixed(2)}s / {duration.toFixed(2)}s</output></label>
})

export default function ProofCanvasEditor({
  aiConfigured = false,
  initialProject,
  durableProject,
}: {
  aiConfigured?: boolean
  initialProject?: ProjectDocument
  durableProject?: DurableEditorContext
}) {
  const startingProjectRef = useRef<ProjectDocument>(ProjectDocumentSchema.parse(cloneSerializable(initialProject ?? createCantorDemoProject())))
  const initialWorkspaceRef = useRef<EditorShotWorkspace>({
    activeShotId: startingProjectRef.current.shots[0].id,
    selection: shotSelection([startingProjectRef.current.shots[0].id]),
    playhead: initialProject ? 0 : INITIAL_DEMO_PLAYHEAD,
  })
  const [editorAuthority, setEditorAuthority] = useState<EditorAuthority>(() => ({
    history: createHistory(startingProjectRef.current),
    workspace: initialWorkspaceRef.current,
    isPlaying: false,
  }))
  const { history, workspace, isPlaying } = editorAuthority
  const { activeShotId, selection, playhead } = workspace
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('text')
  const [librarySearch, setLibrarySearch] = useState('')
  const [draggedShapePresetId, setDraggedShapePresetId] = useState<ShapePresetId | null>(null)
  const [animationType, setAnimationType] = useState<AnimationType>('fade-in')
  const [lifetimeInputRevision, setLifetimeInputRevision] = useState(0)
  const [timelineDraft, setTimelineDraft] = useState<{ id: string; start: number; duration: number } | null>(null)
  const [timelineGesture, setTimelineGesture] = useState<{ id: string; kind: 'move' | 'resize'; pointerId: number; clientX: number; start: number; duration: number; baseRevision: string; baseShotId: string } | null>(null)
  const timelineDraftRef = useRef<typeof timelineDraft>(null)
  const timelineGestureRef = useRef<typeof timelineGesture>(null)
  const [instruction, setInstruction] = useState<string>(REQUIRED_AI_COMMANDS[0])
  const [proposal, setProposal] = useState<AiProposal | null>(null)
  const [proposalBase, setProposalBase] = useState<{ revision: string; shotId: string } | null>(null)
  const [aiProvider, setAiProvider] = useState<AiProposal['provider']>(aiConfigured ? 'configured-provider' : 'deterministic-demo')
  const [aiPending, setAiPending] = useState(false)
  const [aiError, setAiError] = useState('')
  const [critique, setCritique] = useState<CritiqueResult | null>(null)
  const [status, setStatus] = useState(durableProject ? `Loaded durable revision ${durableProject.revision}` : 'Preloaded Cantor-set project')
  const [importError, setImportError] = useState('')
  const [exportPreview, setExportPreview] = useState<{ title: string; contents: string; diagnostics?: string[] } | null>(null)
  const [rendererMessage, setRendererMessage] = useState('')
  const [renderJob, setRenderJob] = useState<ClientRenderJob | null>(null)
  const [renderBaseRevision, setRenderBaseRevision] = useState<string | null>(null)
  const [renderPending, setRenderPending] = useState(false)
  const [renderPollFailures, setRenderPollFailures] = useState(0)
  const [renderPollingPaused, setRenderPollingPaused] = useState(false)
  const [serverRevision, setServerRevision] = useState(durableProject?.revision ?? 0)
  const [csrfToken, setCsrfToken] = useState(durableProject?.csrfToken ?? null)
  const [saveState, setSaveState] = useState<DurableSaveState>('saved')
  const [saveMessage, setSaveMessage] = useState('')
  const [localRecovery, setLocalRecovery] = useState<ProjectDocument | null>(null)
  const [recoveryIgnored, setRecoveryIgnored] = useState(false)
  const [checkpoints, setCheckpoints] = useState<DurableCheckpoint[]>([])
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [checkpointPending, setCheckpointPending] = useState(false)
  const [utilityDialog, setUtilityDialog] = useState<'settings' | 'shortcuts' | 'render-export' | null>(null)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandSearch, setCommandSearch] = useState('')
  const [activeCommandOptionId, setActiveCommandOptionId] = useState<string | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false)
  const [leavePending, setLeavePending] = useState(false)
  const [renderQuality, setRenderQuality] = useState<ClientRenderJob['quality']>('preview')
  const [leftPanelWidth, setLeftPanelWidth] = useState(224)
  const [rightPanelWidth, setRightPanelWidth] = useState(292)
  const [timelineHeight, setTimelineHeight] = useState(340)
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false)
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false)
  const [timelineCollapsed, setTimelineCollapsed] = useState(false)
  const [shotDialog, setShotDialog] = useState<ShotDialogState>(null)
  const [panelResize, setPanelResize] = useState<{ kind: 'left' | 'right' | 'timeline'; start: number; initial: number } | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const exportDialogRef = useRef<HTMLDivElement | null>(null)
  const exportTriggerRef = useRef<HTMLElement | null>(null)
  const utilityDialogRef = useRef<HTMLDivElement | null>(null)
  const utilityTriggerRef = useRef<HTMLElement | null>(null)
  const commandPaletteRef = useRef<HTMLDivElement | null>(null)
  const commandSearchRef = useRef<HTMLInputElement | null>(null)
  const commandButtonRef = useRef<HTMLButtonElement | null>(null)
  const commandTriggerRef = useRef<HTMLElement | null>(null)
  const assistantRef = useRef<HTMLElement | null>(null)
  const assistantTriggerRef = useRef<HTMLElement | null>(null)
  const ownerMenuRef = useRef<HTMLDetailsElement | null>(null)
  const ownerMenuTriggerRef = useRef<HTMLElement | null>(null)
  const shotDialogRef = useRef<HTMLDivElement | null>(null)
  const shotDialogTriggerRef = useRef<HTMLElement | null>(null)
  const shotDialogInputRef = useRef<HTMLInputElement | null>(null)
  const aiRequestSequence = useRef(0)
  const importRequestSequence = useRef(0)
  const aiAbortController = useRef<AbortController | null>(null)
  const serverRevisionRef = useRef(serverRevision)
  const csrfTokenRef = useRef(csrfToken)
  const lastSavedCanonicalRef = useRef(canonicalProjectJson(startingProjectRef.current))
  const pendingSaveRef = useRef<PendingDurableSave | null>(null)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const revisionMutationTailRef = useRef<Promise<void>>(Promise.resolve())
  const saveConflictRef = useRef(false)
  const blockedSaveTuplesRef = useRef<BlockedDurableSave[]>([])
  const recoveryAppliedRef = useRef(false)
  const authorityRef = useRef(editorAuthority)
  const historyRef = useRef(history)
  const workspaceRef = useRef(workspace)
  const selectionRef = useRef(selection)
  const activeShotIdRef = useRef(activeShotId)
  const [workspaceSnapshots] = useState(() => new WeakMap<ProjectDocument, EditorShotWorkspace>([[history.present, workspace]]))
  const workspaceSnapshotsRef = useRef(workspaceSnapshots)
  const [playbackClock] = useState(() => new EditorSequencePlaybackClock(sequenceClockSnapshot(history.present, workspace)))
  const playbackClockRef = useRef(playbackClock)
  const playbackGenerationRef = useRef(0)
  const playbackFrameRef = useRef<number | null>(null)

  serverRevisionRef.current = serverRevision
  csrfTokenRef.current = csrfToken
  const project = history.present
  const logicalFrame = logicalFrameFor(project.settings.aspectRatio)
  const shot = project.shots.find(({ id }) => id === activeShotId) ?? project.shots[0]
  const previewStyle = styleById(project.styles, project.activeStyleId) ?? project.styles[0]
  const publishWorkspaceOnly = useCallback((nextWorkspace: EditorShotWorkspace, nextPlaying = authorityRef.current.isPlaying) => {
    const current = authorityRef.current
    const reconciled = reconcileEditorWorkspace(current.history.present, nextWorkspace)
    const next: EditorAuthority = { history: current.history, workspace: reconciled, isPlaying: nextPlaying }
    authorityRef.current = next
    workspaceRef.current = reconciled
    selectionRef.current = reconciled.selection
    activeShotIdRef.current = reconciled.activeShotId
    workspaceSnapshotsRef.current.set(current.history.present, reconciled)
    if (!nextPlaying) playbackClockRef.current.publish(sequenceClockSnapshot(current.history.present, reconciled))
    setEditorAuthority(next)
  }, [])
  const setSelectedIds = useCallback((value: readonly string[] | ((ids: readonly string[]) => readonly string[])) => {
    const current = authorityRef.current
    const latestProject = current.history.present
    const latestShot = latestProject.shots.find(({ id }) => id === current.workspace.activeShotId) ?? latestProject.shots[0]
    const currentIds = selectedObjectIds(current.workspace.selection, latestShot.id)
    const next = typeof value === 'function' ? value(currentIds) : value
    publishWorkspaceOnly({ ...current.workspace, selection: objectSelection(latestShot, selectionRootIds(latestShot, next)) })
  }, [publishWorkspaceOnly])
  const setSelectedAnimationId = useCallback((id: string | null) => {
    const current = authorityRef.current
    const latestProject = current.history.present
    const latestShot = latestProject.shots.find(({ id: candidateId }) => candidateId === current.workspace.activeShotId) ?? latestProject.shots[0]
    const next = id ? animationSelection(latestShot, [id]) : { kind: 'none', shotId: latestShot.id } as const
    publishWorkspaceOnly({ ...current.workspace, selection: next })
  }, [publishWorkspaceOnly])
  const setEditorSelection = useCallback((nextSelection: EditorSelection) => {
    const current = authorityRef.current
    publishWorkspaceOnly({ ...current.workspace, selection: nextSelection })
  }, [publishWorkspaceOnly])
  const selectSingleKeyframe = useCallback((ref: EditorKeyframeRef) => {
    const current = authorityRef.current
    const latestProject = current.history.present
    const latestShot = latestProject.shots.find(({ id }) => id === current.workspace.activeShotId) ?? latestProject.shots[0]
    publishWorkspaceOnly({ ...current.workspace, selection: keyframeSelection(latestShot, [ref], ref) })
  }, [publishWorkspaceOnly])
  const selectProjectContext = useCallback(() => {
    const current = authorityRef.current
    publishWorkspaceOnly({ ...current.workspace, selection: projectSelection() })
  }, [publishWorkspaceOnly])
  const selectedRootIds = selectionRootIds(shot, selectedObjectIds(selection, shot.id))
  const selectedObjects = selectedRootIds.map((id) => shot.objects.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object))
  const primary = selectedObjects.at(-1)
  const primarySiblings = primary ? shot.objects.filter(({ parentId }) => parentId === primary.parentId) : []
  const primarySiblingIndex = primary ? primarySiblings.findIndex(({ id }) => id === primary.id) : -1
  const primaryEffectivelyLocked = primary ? Boolean(effectiveLockOwner(shot, primary)) : false
  const primaryFamilyIds = primary ? familyObjectIds(shot, [primary.id]) : []
  const primaryFamilyLocked = primaryFamilyIds.some((id) => Boolean(effectiveLockOwner(shot, id)))
  const primaryInheritedLocked = Boolean(primaryEffectivelyLocked && primary && !primary.locked)
  const primaryVisibilityOwner = primary ? effectiveVisibilityOwner(shot, primary) : undefined
  const primaryInheritedHidden = Boolean(primary && primaryVisibilityOwner && primaryVisibilityOwner.id !== primary.id)
  const shotPreview = useMemo(() => previewShotAtTime(shot, playhead), [playhead, shot])
  const primaryPreview = primary ? shotPreview.objects.find(({ id }) => id === primary.id) : undefined
  const primaryInheritedLifetime = primary ? inheritedObjectLifetime(shot, primary.id) : undefined
  const primaryEffectiveLifetime = primary ? primary.lifetime ?? primaryInheritedLifetime : undefined
  const objectPropertyTrack = useCallback((objectId: string, property: PropertyTrack['property']) => shot.propertyTracks.find((track) => (
    propertyTrackKey(track) === propertyTrackKey({ target: { kind: 'object', objectId }, property })
  )), [shot.propertyTracks])
  const cameraPropertyTrack = useCallback((property: 'x' | 'y' | 'zoom' | 'rotation') => shot.propertyTracks.find((track) => (
    propertyTrackKey(track) === propertyTrackKey({ target: { kind: 'camera' }, property })
  )), [shot.propertyTracks])
  const selectedAnimationId = selectedAnimationIds(selection, shot.id).at(-1) ?? null
  const selectedAnimation = shot.animations.find(({ id }) => id === selectedAnimationId) ?? null
  const selectedEntranceThereBackUnsupported = Boolean(
    selectedAnimation
    && (selectedAnimation.type === 'write' || selectedAnimation.type === 'create')
    && selectedAnimation.easing === 'there-and-back',
  )
  const selectedEmphasisUnsupported = Boolean(
    selectedAnimation
    && selectedAnimation.type === 'emphasise'
    && selectedAnimation.easing !== 'there-and-back',
  )
  const selectedAnimationCompatibilityUnsupported = Boolean(selectedAnimation && animationAuthoringCompatibilityIssue(selectedAnimation))
  const selectedAnimationLocked = selectedAnimation ? animationTargetsLocked(shot, selectedAnimation) : false
  const selectedAnimationTarget = selectedAnimation ? shot.objects.find(({ id }) => id === selectedAnimation.targetIds[0]) : undefined
  const projectRevision = useMemo(() => canonicalProjectJson(project), [project])
  const primaryMathProperties = primary ? mathPropertiesFor(primary) : null
  const mathDraftAuthorityKey = primary ? `${projectRevision}\u0000${shot.id}\u0000${primary.id}` : ''
  const graphDraftAuthorityKey = primary ? `${projectRevision}\u0000${shot.id}\u0000${primary.id}` : ''
  const projectRevisionRef = useRef(projectRevision)
  projectRevisionRef.current = projectRevision
  const ensureCsrfToken = useCallback(async () => {
    const token = await ensureSessionCsrfToken(csrfTokenRef.current)
    csrfTokenRef.current = token
    setCsrfToken(token)
    return token
  }, [])

  const durableMutation = useCallback(async (url: string, method: string, body: object) => {
    const token = await ensureCsrfToken()
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-ProofCanvas-CSRF': token },
      body: JSON.stringify(body),
    })
    let payload: unknown = null
    try { payload = await response.json() }
    catch { /* HTTP status still owns retry classification when the body is malformed. */ }
    return { response, payload }
  }, [ensureCsrfToken])

  const enqueueRevisionMutation = useCallback((operation: () => Promise<boolean>): Promise<boolean> => {
    const queued = revisionMutationTailRef.current.then(operation, operation)
    revisionMutationTailRef.current = queued.then(() => undefined, () => undefined)
    return queued
  }, [])

  const saveCurrentDurableRevision = useCallback(async (): Promise<boolean> => {
    if (!durableProject) return true
    if (saveConflictRef.current) return false
    const currentCanonical = projectRevisionRef.current
    const currentRevision = serverRevisionRef.current
    if (blockedSaveMatches(blockedSaveTuplesRef.current, currentCanonical, currentRevision)) {
      setSaveState('blocked')
      setSaveMessage('Autosave is blocked for this exact project revision. Change or undo the rejected document before retrying; browser recovery is preserved.')
      return false
    }
    if (!pendingSaveRef.current && currentCanonical === lastSavedCanonicalRef.current) {
      setSaveState('saved')
      return true
    }
    const pending = pendingSaveRef.current ?? {
      canonical: currentCanonical,
      document: ProjectDocumentSchema.parse(JSON.parse(currentCanonical)),
      mutationId: window.crypto.randomUUID(),
      expectedRevision: serverRevisionRef.current,
    }
    pendingSaveRef.current = pending
    setSaveState('saving')
    setSaveMessage('')
    try {
      const { response, payload } = await durableMutation(`/api/projects/${encodeURIComponent(durableProject.projectId)}`, 'PUT', {
        expectedRevision: pending.expectedRevision,
        mutationId: pending.mutationId,
        document: pending.document,
      })
      if (response.status === 409 && payload && typeof payload === 'object' && (payload as { code?: unknown }).code === 'revision_conflict') {
        pendingSaveRef.current = null
        saveConflictRef.current = true
        setSaveState('conflict')
        setSaveMessage('This project changed elsewhere. Reload the durable version before continuing.')
        return false
      }
      if (!response.ok) {
        const code = responseCode(payload)
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        if (
          response.status === 401
          || response.status === 403
          || response.status === 404
          || response.status === 409
          || DURABLE_RECONCILIATION_CODES.has(code ?? '')
        ) {
          pendingSaveRef.current = null
          saveConflictRef.current = true
          setSaveState('reconcile')
          const guidance = response.status === 401 || response.status === 403
            ? 'Reload to refresh owner authentication before continuing.'
            : response.status === 404 || code === 'project_not_found'
              ? 'Reload to confirm whether this project was deleted.'
              : 'Reload the durable project before continuing.'
          setSaveMessage(`${responseMessage(payload, 'Autosave requires reconciliation')}. ${guidance} Browser recovery is preserved.`)
          return false
        }
        if (DURABLE_TUPLE_REJECTION_CODES.has(code ?? '')) {
          pendingSaveRef.current = null
          blockedSaveTuplesRef.current = rememberBlockedSave(blockedSaveTuplesRef.current, pending)
          setSaveState('blocked')
          setSaveMessage(`${responseMessage(payload, 'Autosave was rejected')}. This exact document/revision tuple will not retry automatically; change or undo it to continue. Browser recovery is preserved.`)
          return false
        }
        if (!retryable && response.status >= 400 && response.status < 500) {
          throw new Error(responseMessage(payload, 'Autosave was rejected by an unrecognized response'))
        }
        throw new Error(responseMessage(payload, 'Autosave could not complete'))
      }
      if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) {
        throw new Error(responseMessage(payload, 'Autosave could not complete'))
      }
      const receipt = (payload as { project?: unknown }).project
      if (!receipt || typeof receipt !== 'object') {
        throw new Error('Autosave returned an invalid response')
      }
      const nextRevision = (receipt as { revision?: unknown }).revision
      const receiptProjectId = (receipt as { projectId?: unknown }).projectId
      if (!Number.isSafeInteger(nextRevision)
        || nextRevision !== pending.expectedRevision + 1
        || receiptProjectId !== durableProject.projectId) {
        throw new Error('Autosave returned a non-advancing revision receipt')
      }
      serverRevisionRef.current = nextRevision
      setServerRevision(nextRevision)
      // Any prior deterministic rejection was bound to an older durable base.
      blockedSaveTuplesRef.current = []
      lastSavedCanonicalRef.current = pending.canonical
      pendingSaveRef.current = null
      const caughtUp = projectRevisionRef.current === pending.canonical
      if (caughtUp) {
        window.localStorage.removeItem(recoveryStorageKey(durableProject.projectId))
        if (recoveryAppliedRef.current) {
          recoveryAppliedRef.current = false
          setLocalRecovery(null)
        }
      } else {
        try { window.localStorage.setItem(recoveryStorageKey(durableProject.projectId), projectRevisionRef.current) }
        catch { /* Keep autosave moving even if the best-effort recovery cache is unavailable. */ }
      }
      setSaveState(caughtUp ? 'saved' : 'waiting')
      setSaveMessage(caughtUp ? `Saved revision ${nextRevision}` : 'Saving newer edits…')
      return true
    } catch (error) {
      setSaveState('offline')
      setSaveMessage(error instanceof Error ? `${error.message}. Retry uses the same mutation ID.` : 'Autosave is offline. Retry uses the same mutation ID.')
      return false
    }
  }, [durableMutation, durableProject])

  const drainDurableSaves = useCallback(async (): Promise<boolean> => {
    if (!durableProject) return true
    for (let pass = 0; pass < 32; pass += 1) {
      if (saveConflictRef.current) return false
      if (!pendingSaveRef.current && projectRevisionRef.current === lastSavedCanonicalRef.current) return true
      if (!await saveCurrentDurableRevision()) return false
    }
    setSaveState('waiting')
    setSaveMessage('Edits are still arriving. Pause briefly, then retry this revision-bound action.')
    return false
  }, [durableProject, saveCurrentDurableRevision])

  const flushDurableSaves = useCallback(() => enqueueRevisionMutation(drainDurableSaves), [drainDurableSaves, enqueueRevisionMutation])

  const performDurableSave = useCallback(async (): Promise<boolean> => {
    if (!durableProject) return true
    if (savePromiseRef.current) return savePromiseRef.current
    const promise = enqueueRevisionMutation(saveCurrentDurableRevision)
    savePromiseRef.current = promise
    try {
      return await promise
    } finally {
      savePromiseRef.current = null
      const currentBlocked = blockedSaveMatches(
        blockedSaveTuplesRef.current,
        projectRevisionRef.current,
        serverRevisionRef.current,
      )
      if (!saveConflictRef.current && !currentBlocked && !pendingSaveRef.current && projectRevisionRef.current !== lastSavedCanonicalRef.current) {
        window.setTimeout(() => { void performDurableSave() }, 0)
      }
    }
  }, [durableProject, enqueueRevisionMutation, saveCurrentDurableRevision])
  const renderRepresentsCurrentProject = Boolean(renderJob && renderBaseRevision === projectRevision)
  const aiContextKey = `${projectRevision}\u0000${shot.id}`
  const aiContextRef = useRef(aiContextKey)
  const proposalReviews = useMemo(() => proposal ? reviewOperations(project, shot.id, proposal) : [], [project, proposal, shot.id])
  const animationLanes = useMemo(() => timelineLaneMap(shot.animations, timelineDraft), [shot.animations, timelineDraft])
  const shotSequence = useMemo(() => buildEditorShotSequence(project), [project])
  const pausedSequencePosition = deriveEditorShotSequencePosition(project, workspace)
  const pausedGlobalTime = pausedSequencePosition.ok ? pausedSequencePosition.globalTime : 0
  const minimumShotDuration = minimumAuthoredShotDuration(project, shot)
  const lockedAnimationCount = project.shots.reduce((count, candidateShot) => count + candidateShot.animations.filter((animation) => animationTargetsLocked(candidateShot, animation)).length, 0)
  const coordinateBounds = { min: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude }
  const signedScaleBounds = { min: -PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude, minMagnitude: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude }
  const animationPropertyFields: NumericField[] = !selectedAnimation ? []
    : selectedAnimation.type === 'move' ? [
      ...(selectedAnimation.targetIds.length > 1 ? [
        { key: 'deltaX', label: 'Horizontal move', fallback: 0, ...coordinateBounds },
        { key: 'deltaY', label: 'Vertical move', fallback: 0, ...coordinateBounds },
      ] : [
        { key: 'x', label: 'Target X', fallback: selectedAnimationTarget?.transform.x ?? logicalFrame.centerX, ...coordinateBounds },
        { key: 'y', label: 'Target Y', fallback: selectedAnimationTarget?.transform.y ?? logicalFrame.centerY, ...coordinateBounds },
      ]),
    ] : selectedAnimation.type === 'scale' || selectedAnimation.type === 'emphasise' ? [
      selectedAnimation.type === 'emphasise'
        ? { key: 'scale', label: 'Scale amount', fallback: 1.08, min: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude }
        : { key: 'scale', label: 'Scale amount', fallback: 1.15, ...signedScaleBounds },
    ] : selectedAnimation.type === 'transform' && selectedAnimation.targetIds.length === 1 ? [
      { key: 'x', label: 'Target X', fallback: selectedAnimationTarget?.transform.x ?? logicalFrame.centerX, ...coordinateBounds },
      { key: 'y', label: 'Target Y', fallback: selectedAnimationTarget?.transform.y ?? logicalFrame.centerY, ...coordinateBounds },
      { key: 'width', label: 'Target width', fallback: selectedAnimationTarget?.transform.width ?? 60, min: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin, max: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax },
      { key: 'height', label: 'Target height', fallback: selectedAnimationTarget?.transform.height ?? 30, min: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMin, max: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax },
      { key: 'rotation', label: 'Target rotation', fallback: selectedAnimationTarget?.transform.rotation ?? 0, min: -PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude },
      { key: 'scaleX', label: 'Target scale X', fallback: selectedAnimationTarget?.transform.scaleX ?? 1, ...signedScaleBounds },
      { key: 'scaleY', label: 'Target scale Y', fallback: selectedAnimationTarget?.transform.scaleY ?? 1, ...signedScaleBounds },
    ] : selectedAnimation.type === 'camera-focus' ? [
      { key: 'x', label: 'Camera X', fallback: shot.camera.x, ...coordinateBounds },
      { key: 'y', label: 'Camera Y', fallback: shot.camera.y, ...coordinateBounds },
      { key: 'zoom', label: 'Camera zoom', fallback: shot.camera.zoom, min: PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMin, max: PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMax },
      { key: 'rotation', label: 'Camera rotation', fallback: shot.camera.rotation, min: -PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude },
    ] : []

  useEffect(() => {
    if (!durableProject) return
    try {
      const scoped = window.localStorage.getItem(recoveryStorageKey(durableProject.projectId))
      const legacy = window.localStorage.getItem(STORAGE_KEY)
      const legacyProject = legacy ? parseProjectDocument(legacy) : null
      const raw = scoped ?? (legacyProject?.metadata.id === durableProject.projectId ? legacy : null)
      if (!raw) return
      const candidate = parseProjectDocument(raw)
      if (canonicalProjectJson(candidate) !== lastSavedCanonicalRef.current) setLocalRecovery(candidate)
    } catch {
      // Invalid legacy data is never loaded automatically and remains available
      // for the owner to inspect or remove through browser storage tooling.
    }
  }, [durableProject])

  useEffect(() => {
    if (!durableProject) return
    // Recovery is local evidence of the latest authored document, including
    // edits made after a CAS conflict suppresses further network mutations.
    // Persist it before the conflict gate so newer work is never stranded in
    // React state alone.
    if (projectRevision !== lastSavedCanonicalRef.current || pendingSaveRef.current || saveConflictRef.current) {
      try { window.localStorage.setItem(recoveryStorageKey(durableProject.projectId), projectRevision) }
      catch { /* Durable autosave remains authoritative; browser recovery is best-effort. */ }
    }
    if (saveConflictRef.current) return
    if (blockedSaveMatches(blockedSaveTuplesRef.current, projectRevision, serverRevisionRef.current)) {
      setSaveState('blocked')
      return
    }
    if (projectRevision === lastSavedCanonicalRef.current && !pendingSaveRef.current) {
      setSaveState('saved')
      return
    }
    setSaveState((current) => current === 'saving' ? current : 'waiting')
    const timeout = window.setTimeout(() => { void performDurableSave() }, 800)
    return () => window.clearTimeout(timeout)
  }, [durableProject, performDurableSave, projectRevision])

  useEffect(() => {
    if (!ownerMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !ownerMenuRef.current?.contains(event.target)) setOwnerMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [ownerMenuOpen])

  useEffect(() => {
    if (timelineGesture && (timelineGesture.baseRevision !== projectRevision || timelineGesture.baseShotId !== shot.id || isPlaying)) {
      timelineGestureRef.current = null
      timelineDraftRef.current = null
      setTimelineGesture(null)
      setTimelineDraft(null)
    }
  }, [isPlaying, projectRevision, shot.id, timelineGesture])

  useEffect(() => {
    if (!isPlaying) return
    const baseAuthority = authorityRef.current
    const baseProject = baseAuthority.history.present
    const baseWorkspace = baseAuthority.workspace
    const generation = ++playbackGenerationRef.current
    const startedAt = performance.now()
    const tick = (now: number) => {
      if (generation !== playbackGenerationRef.current || authorityRef.current.history.present !== baseProject || !authorityRef.current.isPlaying) return
      const advanced = advanceEditorShotSequencePlayback(baseProject, baseWorkspace, Math.max(0, (now - startedAt) / 1_000))
      if (!advanced.ok) {
        const current = authorityRef.current
        const next = { ...current, isPlaying: false }
        authorityRef.current = next
        setEditorAuthority(next)
        setStatus(advanced.diagnostic.message)
        return
      }
      const position = deriveEditorShotSequencePosition(baseProject, advanced.workspace)
      if (!position.ok || generation !== playbackGenerationRef.current) return
      playbackClockRef.current.publish({
        globalTime: advanced.globalTime,
        shotId: advanced.workspace.activeShotId,
        localTime: advanced.workspace.playhead,
        atFinalEndpoint: position.atFinalEndpoint,
      })
      const current = authorityRef.current
      if (current.workspace.activeShotId !== advanced.workspace.activeShotId || advanced.playback === 'pause') {
        const next: EditorAuthority = {
          history: current.history,
          workspace: advanced.workspace,
          isPlaying: advanced.playback === 'play',
        }
        authorityRef.current = next
        workspaceRef.current = advanced.workspace
        selectionRef.current = advanced.workspace.selection
        activeShotIdRef.current = advanced.workspace.activeShotId
        workspaceSnapshotsRef.current.set(current.history.present, advanced.workspace)
        setEditorAuthority(next)
      }
      if (advanced.playback === 'pause') {
        playbackFrameRef.current = null
        setStatus('Sequence finished')
        return
      }
      playbackFrameRef.current = window.requestAnimationFrame(tick)
    }
    playbackFrameRef.current = window.requestAnimationFrame(tick)
    return () => {
      playbackGenerationRef.current += 1
      if (playbackFrameRef.current !== null) window.cancelAnimationFrame(playbackFrameRef.current)
      playbackFrameRef.current = null
    }
  }, [isPlaying, projectRevision])

  useEffect(() => {
    if (!panelResize) return
    const onPointerMove = (event: PointerEvent) => {
      if (panelResize.kind === 'left') setLeftPanelWidth(Math.max(MIN_LEFT_PANEL, Math.min(MAX_LEFT_PANEL, panelResize.initial + event.clientX - panelResize.start)))
      if (panelResize.kind === 'right') setRightPanelWidth(Math.max(MIN_RIGHT_PANEL, Math.min(MAX_RIGHT_PANEL, panelResize.initial + panelResize.start - event.clientX)))
      if (panelResize.kind === 'timeline') setTimelineHeight(Math.max(MIN_TIMELINE_HEIGHT, Math.min(MAX_TIMELINE_HEIGHT, panelResize.initial + panelResize.start - event.clientY)))
    }
    const onPointerUp = () => setPanelResize(null)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [panelResize])

  useEffect(() => {
    if (aiContextRef.current === aiContextKey) return
    aiContextRef.current = aiContextKey
    aiRequestSequence.current += 1
    aiAbortController.current?.abort()
    aiAbortController.current = null
    setAiPending(false)
    setProposal(null)
    setProposalBase(null)
    setCritique(null)
  }, [aiContextKey])

  useEffect(() => {
    if (!renderJob || renderPollingPaused || (renderJob.status !== 'pending' && renderJob.status !== 'running')) return
    let cancelled = false
    const poll = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/proofcanvas/render/${encodeURIComponent(renderJob.id)}`, { cache: 'no-store' })
        const payload: unknown = await response.json()
        if (!response.ok) throw new Error(responseMessage(payload, 'Render status could not be read'))
        if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) throw new Error('Renderer returned an invalid status')
        const next = renderJobFromPayload((payload as { job?: unknown }).job)
        if (!cancelled) {
          setRenderPollFailures(0)
          setRenderPollingPaused(false)
          setRendererMessage('')
          setRenderJob(next)
          if (next.status === 'failed') setRendererMessage(next.error?.message ?? 'Manim could not render this generated scene.')
          if (next.status === 'succeeded') setStatus('Genuine Manim MP4 render completed')
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Render status could not be read'
          setRenderPollFailures((failures) => {
            const next = failures + 1
            if (next >= 3) {
              setRenderPollingPaused(true)
              setRendererMessage(`${message} Status polling paused after 3 attempts; the render job is still preserved.`)
            } else {
              setRendererMessage(`${message} Retrying status (${next}/3)…`)
            }
            return next
          })
        }
      }
    }, 600 * (2 ** Math.min(renderPollFailures, 2)))
    return () => { cancelled = true; window.clearTimeout(poll) }
  }, [renderJob, renderPollFailures, renderPollingPaused])

  useEffect(() => {
    const dialog = exportDialogRef.current
    if (!exportPreview || !dialog) return
    const background = [...dialog.parentElement!.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialog)
    for (const element of background) element.inert = true
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'))
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setExportPreview(null)
        return
      }
      if (event.key !== 'Tab') return
      const candidates = focusable()
      if (!candidates.length) return
      const first = candidates[0]
      const last = candidates[candidates.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
      for (const element of background) element.inert = false
      exportTriggerRef.current?.focus()
    }
  }, [exportPreview])

  useEffect(() => {
    const dialog = utilityDialogRef.current
    if (!utilityDialog || !dialog) return
    const background = [...dialog.parentElement!.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialog)
    for (const element of background) element.inert = true
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'))
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setUtilityDialog(null); return }
      if (event.key !== 'Tab') return
      const candidates = focusable()
      if (!candidates.length) return
      const first = candidates[0]
      const last = candidates[candidates.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
      for (const element of background) element.inert = false
      utilityTriggerRef.current?.focus()
    }
  }, [utilityDialog])

  useEffect(() => {
    const palette = commandPaletteRef.current
    if (!commandPaletteOpen || !palette) return
    const background = [...palette.parentElement!.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== palette)
    for (const element of background) element.inert = true
    const focusable = () => [...palette.querySelectorAll<HTMLElement>('button, input, [href], [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'))
    palette.querySelector<HTMLInputElement>('[aria-label="Search commands"]')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const candidates = focusable()
      if (!candidates.length) return
      const first = candidates[0]
      const last = candidates.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    palette.addEventListener('keydown', onKeyDown)
    return () => {
      palette.removeEventListener('keydown', onKeyDown)
      for (const element of background) element.inert = false
      commandTriggerRef.current?.focus()
    }
  }, [commandPaletteOpen])

  useEffect(() => {
    const dialog = shotDialogRef.current
    if (!shotDialog || !dialog) return
    const background = [...dialog.parentElement!.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialog)
    for (const element of background) element.inert = true
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'))
    ;(shotDialogInputRef.current ?? dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0])?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setShotDialog(null); return }
      if (event.key !== 'Tab') return
      const candidates = focusable()
      if (!candidates.length) return
      const first = candidates[0]
      const last = candidates.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
      for (const element of background) element.inert = false
      if (shotDialogTriggerRef.current?.isConnected) shotDialogTriggerRef.current.focus()
    }
  }, [shotDialog])

  useEffect(() => {
    const drawer = assistantRef.current ?? document.querySelector<HTMLElement>('.pc-assistant-drawer')
    if (!assistantOpen || !drawer) return
    assistantTriggerRef.current ??= commandButtonRef.current ?? commandTriggerRef.current
    drawer.querySelector<HTMLTextAreaElement>('[aria-label="Describe the edit"]')?.focus()
    return () => assistantTriggerRef.current?.focus()
  }, [assistantOpen])

  const invalidateAiContext = useCallback(() => {
    aiRequestSequence.current += 1
    aiAbortController.current?.abort()
    aiAbortController.current = null
    setAiPending(false)
    setProposal(null)
    setProposalBase(null)
    setCritique(null)
  }, [])

  const cancelPlaybackLoop = useCallback(() => {
    playbackGenerationRef.current += 1
    if (playbackFrameRef.current !== null) window.cancelAnimationFrame(playbackFrameRef.current)
    playbackFrameRef.current = null
  }, [])

  const materializeLiveWorkspace = useCallback((authority = authorityRef.current): EditorShotWorkspace => {
    if (!authority.isPlaying) return authority.workspace
    const live = playbackClockRef.current.getSnapshot()
    const resolved = seekEditorShotSequence(authority.history.present, authority.workspace, live.globalTime)
    return resolved.ok ? resolved.workspace : authority.workspace
  }, [])

  const publishEditorAuthority = useCallback((
    nextHistory: ProjectHistory,
    requestedWorkspace: EditorShotWorkspace,
    playback: 'play' | 'pause' | 'preserve',
    options: Readonly<{ invalidateAi?: boolean; status?: string }> = {},
  ) => {
    const current = authorityRef.current
    const nextWorkspace = reconcileEditorWorkspace(nextHistory.present, requestedWorkspace)
    const keepPlaying = playback === 'play' || (playback === 'preserve' && current.isPlaying)
    workspaceSnapshotsRef.current.set(current.history.present, materializeLiveWorkspace(current))
    workspaceSnapshotsRef.current.set(nextHistory.present, nextWorkspace)
    cancelPlaybackLoop()
    const next: EditorAuthority = { history: nextHistory, workspace: nextWorkspace, isPlaying: keepPlaying }
    authorityRef.current = next
    historyRef.current = nextHistory
    workspaceRef.current = nextWorkspace
    selectionRef.current = nextWorkspace.selection
    activeShotIdRef.current = nextWorkspace.activeShotId
    projectRevisionRef.current = canonicalProjectJson(nextHistory.present)
    playbackClockRef.current.publish(sequenceClockSnapshot(nextHistory.present, nextWorkspace))
    setEditorAuthority(next)
    if (options.invalidateAi !== false && nextHistory !== current.history) invalidateAiContext()
    if (options.status) setStatus(options.status)
  }, [cancelPlaybackLoop, invalidateAiContext, materializeLiveWorkspace])

  const commitOps = useCallback((operations: readonly ManualSceneOperation[], label: string) => {
    try {
      const currentAuthority = authorityRef.current
      if (currentAuthority.isPlaying) {
        setStatus('Pause sequence playback before editing the project.')
        return false
      }
      const current = currentAuthority.history
      const liveWorkspace = materializeLiveWorkspace(currentAuthority)
      const next = commitOperations(current, liveWorkspace.activeShotId, operations, label)
      publishEditorAuthority(next, reconcileEditorWorkspace(next.present, liveWorkspace), 'pause', { status: next === current ? 'No project values changed' : label })
      setAiError('')
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The edit could not be applied')
      return false
    }
  }, [materializeLiveWorkspace, publishEditorAuthority])

  /** Timeline edits keep history, selection, shot, and playback in one authority update. */
  const commitTimelineIntent = useCallback((intent: TimelineOperationIntent, base: TimelineIntentAuthorityBase) => {
    const currentAuthority = authorityRef.current
    if (currentAuthority.isPlaying) {
      setStatus('Pause sequence playback before editing lifetimes or keyframes.')
      return false
    }
    if (!timelineIntentAuthorityIsCurrent(base, {
      projectRevision: projectRevisionRef.current,
      shotId: currentAuthority.workspace.activeShotId,
    })) {
      setStatus('The timeline changed before this edit could be applied. Retry the edit on the current shot.')
      return false
    }
    if (!intent.ok) {
      setStatus(intent.diagnostic.message)
      return false
    }
    try {
      const current = currentAuthority.history
      const liveWorkspace = materializeLiveWorkspace(currentAuthority)
      const next = commitOperations(current, liveWorkspace.activeShotId, intent.operations, intent.label)
      const nextWorkspace = reconcileEditorWorkspace(next.present, { ...liveWorkspace, selection: intent.selection })
      publishEditorAuthority(next, nextWorkspace, 'pause', { status: next === current ? 'No project values changed' : intent.label })
      setAiError('')
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The timeline edit could not be applied')
      return false
    }
  }, [materializeLiveWorkspace, publishEditorAuthority])

  const commitDocument = useCallback((document: ProjectDocument, label: string, options: Readonly<{ allowLegacyGraphLoad?: boolean }> = {}) => {
    try {
      const currentAuthority = authorityRef.current
      if (currentAuthority.isPlaying) {
        setStatus('Pause sequence playback before editing the project.')
        return false
      }
      const current = currentAuthority.history
      const liveWorkspace = materializeLiveWorkspace(currentAuthority)
      const parsed = ProjectDocumentSchema.parse(document)
      const authoringIssue = options.allowLegacyGraphLoad ? undefined : projectAuthoringTransitionIssue(current.present, parsed)
      if (authoringIssue) throw new Error(authoringIssue)
      const next = commitProject(current, parsed, label)
      publishEditorAuthority(next, reconcileEditorWorkspace(next.present, liveWorkspace), 'pause', { status: next === current ? 'No project values changed' : label })
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The project change was invalid')
      return false
    }
  }, [materializeLiveWorkspace, publishEditorAuthority])

  const commitRenderedTimelineIntent = useCallback((intent: TimelineOperationIntent) => commitTimelineIntent(intent, {
    projectRevision,
    shotId: shot.id,
  }), [commitTimelineIntent, projectRevision, shot.id])

  const commitCanvasKeyboardTransform = useCallback((intent: CanvasKeyboardTransformIntent) => {
    const latestProject = historyRef.current.present
    const latestShot = latestProject.shots.find(({ id }) => id === activeShotIdRef.current) ?? latestProject.shots[0]
    const latestStyle = styleById(latestProject.styles, latestProject.activeStyleId) ?? latestProject.styles[0]
    const resolution = resolveCanvasKeyboardTransformIntent(latestProject, latestShot.id, latestStyle, playbackClockRef.current.getSnapshot().localTime, intent)
    if (!resolution) return
    if ('notice' in resolution) {
      setStatus(resolution.notice)
      return
    }
    commitOps(resolution.updates.map(({ objectId, transform }) => ({ type: 'update-object', objectId, patch: { transform } })), resolution.label)
  }, [commitOps])

  const insertObject = (type: Exclude<SceneObject['type'], 'group'>) => {
    const latestProject = historyRef.current.present
    const latestShot = latestProject.shots.find(({ id }) => id === shot.id) ?? latestProject.shots[0]
    const frame = logicalFrameFor(latestProject.settings.aspectRatio)
    const ids = collectProjectIds(latestProject)
    const object = newObject(type, allocateId('object', ids, type), latestShot.objects.length + 1, frame)
    if (commitOps([{ type: 'add-object', object }], `Insert ${type}`)) setSelectedIds([object.id])
  }

  const insertShapePresetAt = useCallback((presetId: ShapePresetId, origin?: { x: number; y: number }) => {
    try {
      const current = authorityRef.current
      if (current.isPlaying) {
        setStatus('Pause sequence playback before inserting a shape.')
        return false
      }
      const definition = shapePresetById(presetId)
      if (!definition) {
        setStatus('That shape preset is not available.')
        return false
      }
      const latestProject = current.history.present
      const latestShot = latestProject.shots.find(({ id }) => id === current.workspace.activeShotId) ?? latestProject.shots[0]
      const insertionPoint = origin ?? (() => {
        const camera = previewShotAtTime(latestShot, current.workspace.playhead).camera
        return { x: camera.x, y: camera.y }
      })()
      const before = new Set(latestShot.objects.map(({ id }) => id))
      const next = insertShapePreset(latestProject, latestShot.id, definition.id, insertionPoint)
      const nextShot = next.shots.find(({ id }) => id === latestShot.id)!
      const inserted = nextShot.objects.filter(({ id }) => !before.has(id))
      const insertedIds = new Set(inserted.map(({ id }) => id))
      const insertedRootIds = inserted
        .filter(({ parentId }) => !parentId || !insertedIds.has(parentId))
        .map(({ id }) => id)
      if (!insertedRootIds.length) throw new Error('Shape preset did not produce an editable root object')
      if (commitDocument(next, `Insert ${definition.name}`)) {
        setSelectedIds(insertedRootIds)
        return true
      }
      return false
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Shape insertion failed')
      return false
    }
  }, [commitDocument, setSelectedIds])

  const insertComponent = (componentId: SemanticComponentId) => {
    try {
      const latestProject = historyRef.current.present
      const latestShot = latestProject.shots.find(({ id }) => id === shot.id) ?? latestProject.shots[0]
      const frame = logicalFrameFor(latestProject.settings.aspectRatio)
      const before = new Set(latestShot.objects.map(({ id }) => id))
      const next = insertSemanticComponent(latestProject, latestShot.id, componentId, { x: frame.centerX, y: frame.centerY })
      if (commitDocument(next, `Insert ${componentId}`)) setSelectedIds(next.shots.find(({ id }) => id === shot.id)!.objects.filter(({ id }) => !before.has(id)).map(({ id }) => id))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Component insertion failed')
    }
  }

  const duplicateSelection = useCallback(() => {
    if (!selectedRootIds.length) return setStatus('Select an object to duplicate')
    try {
      const latestProject = historyRef.current.present
      const latestShot = latestProject.shots.find(({ id }) => id === shot.id) ?? latestProject.shots[0]
      const latestIds = selectionRootIds(latestShot, selectedRootIds)
      const before = new Set(latestShot.objects.map(({ id }) => id))
      const result = duplicateObjects(latestProject, latestShot.id, latestIds)
      if (commitDocument(result.project, 'Duplicate selection')) setSelectedIds(result.project.shots.find(({ id }) => id === shot.id)!.objects.filter(({ id }) => !before.has(id)).map(({ id }) => id))
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Duplicate failed') }
  }, [commitDocument, selectedRootIds, setSelectedIds, shot.id])

  const deleteSelection = useCallback(() => {
    if (!selectedRootIds.length) return setStatus('Select an object to delete')
    if (commitOps(selectedRootIds.map((objectId) => ({ type: 'delete-object', objectId })), 'Delete selection')) setSelectedIds([])
  }, [commitOps, selectedRootIds])

  const groupSelection = useCallback(() => {
    const latestProject = historyRef.current.present
    const latestShot = latestProject.shots.find(({ id }) => id === shot.id) ?? latestProject.shots[0]
    const latestObjects = selectionRootIds(latestShot, selectedRootIds).map((id) => latestShot.objects.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object))
    if (latestObjects.length < 2) return setStatus('Select at least two objects to group')
    const box = selectionBounds(latestObjects)
    const commonParentId = latestObjects.every(({ parentId }) => parentId === latestObjects[0]?.parentId)
      ? latestObjects[0]?.parentId
      : undefined
    const group: SceneObject = { id: allocateId('group', collectProjectIds(latestProject), 'selection'), type: 'group', name: 'Object group', ...(commonParentId ? { parentId: commonParentId } : {}), locked: false, visible: true, transform: { ...box, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} }
    if (commitOps([{ type: 'group-objects', objectIds: latestObjects.map(({ id }) => id), group }], 'Group selection')) setSelectedIds([group.id])
  }, [commitOps, selectedRootIds, setSelectedIds, shot.id])

  const ungroupSelection = useCallback(() => {
    const groups = selectedObjects.filter(({ type }) => type === 'group')
    if (!groups.length) return setStatus('Select a group to ungroup')
    if (commitOps(groups.map(({ id: groupId }) => ({ type: 'ungroup-object', groupId })), 'Ungroup selection')) setSelectedIds([])
  }, [commitOps, selectedObjects])

  const align = (alignment: Extract<SceneOperation, { type: 'align-objects' }>['alignment']) => {
    if (selectedRootIds.length < 2) return setStatus('Select at least two independent objects to align')
    commitOps([{ type: 'align-objects', objectIds: selectedRootIds, alignment }], `Align ${alignment}`)
  }
  const distribute = (axis: 'horizontal' | 'vertical') => {
    if (selectedRootIds.length < 3) return setStatus('Select at least three independent objects to distribute')
    commitOps([{ type: 'distribute-objects', objectIds: selectedRootIds, axis }], `Distribute ${axis}`)
  }

  const reorderLayer = (where: 'forward' | 'backward' | 'front' | 'back') => {
    if (!primary) return setStatus('Select an object to reorder')
    const siblings = shot.objects.filter(({ parentId }) => parentId === primary.parentId)
    const currentIndex = siblings.findIndex(({ id }) => id === primary.id)
    const remaining = siblings.filter(({ id }) => id !== primary.id)
    let target = currentIndex
    if (where === 'front') target = remaining.length
    else if (where === 'back') target = 0
    else if (where === 'forward') target = Math.min(remaining.length, currentIndex + 1)
    else if (where === 'backward') target = Math.max(0, currentIndex - 1)
    if (target === currentIndex) return setStatus(`Object is already at the ${where}`)
    commitOps([{ type: 'reorder-object', objectId: primary.id, index: target }], `Move layer ${where}`)
  }

  const toggleLock = () => {
    if (!primary) return setStatus('Select an object to lock')
    commitOps([{ type: primary.locked ? 'unlock-object' : 'lock-object', objectId: primary.id }], primary.locked ? 'Unlock object' : 'Lock object')
  }

  const selectOutputStyle = (styleId: string, name: string) => {
    const preservation = lockedAnimationCount
      ? `; preserved ${lockedAnimationCount} locked animation${lockedAnimationCount === 1 ? '' : 's'}`
      : ''
    commitOps([{ type: 'set-style', styleId }], `Use ${name} style${preservation}`)
  }

  const navigateStyleRadios = (event: ReactKeyboardEvent<HTMLElement>, currentId: string, surface: 'library' | 'canvas') => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const index = STYLE_OPTIONS.findIndex(({ id }) => id === currentId)
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
    const next = STYLE_OPTIONS[(index + delta + STYLE_OPTIONS.length) % STYLE_OPTIONS.length]
    selectOutputStyle(next.id, next.name)
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-style-surface="${surface}"][data-style-id="${next.id}"]`)?.focus())
  }

  const commitPatch = (patch: Extract<SceneOperation, { type: 'update-object' }>['patch'], label: string) => {
    if (!primary) return false
    return commitOps([{ type: 'update-object', objectId: primary.id, patch }], label)
  }

  const commitShapeSettings = useCallback((
    objectId: string,
    shape: CurrentShapeProperties,
    label: string,
    transform?: Partial<SceneObject['transform']>,
  ) => {
    const current = authorityRef.current
    if (current.isPlaying) {
      setStatus('Pause sequence playback before editing shape geometry.')
      return false
    }
    const latestProject = current.history.present
    const latestShot = latestProject.shots.find(({ id }) => id === current.workspace.activeShotId) ?? latestProject.shots[0]
    const latestObject = latestShot.objects.find(({ id }) => id === objectId)
    if (!latestObject || !isCurrentShapeType(latestObject.type) || latestObject.type !== shape.kind) {
      setStatus('The selected shape is no longer available.')
      return false
    }
    const shapeIssue = currentShapePropertiesIssue(shape)
    if (shapeIssue) {
      setStatus(`${formatShapePropertiesIssue(shapeIssue)}. The edit was not applied.`)
      return false
    }
    if (effectiveLockOwner(latestShot, latestObject)) {
      setStatus('Unlock the shape and its ancestors before editing its geometry.')
      return false
    }
    const openingFreeform = shape.kind === 'freeform-path' && !shape.closed
    const operations: SceneOperation[] = [{
      type: 'update-object',
      objectId,
      patch: {
        ...(transform ? { transform } : {}),
        ...(openingFreeform && latestObject.style.fill !== undefined ? { style: { fill: undefined } } : {}),
        // Operations merge the outer properties envelope shallowly. Replace
        // the complete strict shape record so sibling shape controls survive.
        properties: { shape },
      },
    }]
    if (openingFreeform) operations.push(...latestShot.propertyTracks.filter((track) => (
      track.target.kind === 'object'
      && track.target.objectId === objectId
      && track.property === 'fill'
    )).map((track) => ({ type: 'delete-property-track' as const, trackId: track.id })))
    return commitOps(operations, label)
  }, [commitOps])

  const commitLineEndpoint = useCallback((
    objectId: string,
    endpoint: 'start' | 'end',
    axis: 'x' | 'y',
    value: number,
  ) => {
    if (!Number.isFinite(value)) {
      setStatus('Line endpoints must be finite numbers.')
      return false
    }
    const current = authorityRef.current
    if (current.isPlaying) {
      setStatus('Pause sequence playback before editing line endpoints.')
      return false
    }
    const latestProject = current.history.present
    const latestShot = latestProject.shots.find(({ id }) => id === current.workspace.activeShotId) ?? latestProject.shots[0]
    const latestObject = latestShot.objects.find(({ id }) => id === objectId)
    if (!latestObject || !isLinearShapeType(latestObject.type)) {
      setStatus('The selected linear shape is no longer available.')
      return false
    }
    if (effectiveLockOwner(latestShot, latestObject)) {
      setStatus('Unlock the linear shape and its ancestors before editing its endpoints.')
      return false
    }
    if (objectFamilyHasPropertyAuthority(latestShot, latestObject, ENDPOINT_AUTHORITY_PROPERTIES, ENDPOINT_ANCESTOR_AUTHORITY_PROPERTIES)) {
      setStatus('Remove the dependent object or ancestor position, width, rotation, or scale track before editing endpoints.')
      return false
    }
    const endpoints = lineEndpointsForTransform(latestObject.transform)
    if (!endpoints) {
      setStatus('The current line transform cannot be represented as finite endpoints.')
      return false
    }
    const nextEndpoints = {
      start: { ...endpoints.start },
      end: { ...endpoints.end },
    }
    nextEndpoints[endpoint][axis] = value
    const transform = transformFromLineEndpoints(latestObject.transform, nextEndpoints)
    if (!transform) {
      setStatus('Those endpoints are coincident or outside the editable shape bounds.')
      return false
    }
    return commitOps([{
      type: 'update-object',
      objectId,
      patch: { transform },
    }], `Set ${endpoint} ${axis.toUpperCase()} endpoint`)
  }, [commitOps])

  const commitMathProperties = (next: MathProperties, baseAuthorityKey: string) => {
    const current = authorityRef.current
    const latestProject = current.history.present
    const latestShot = latestProject.shots.find(({ id }) => id === current.workspace.activeShotId) ?? latestProject.shots[0]
    const latestPrimaryId = selectedObjectIds(current.workspace.selection, latestShot.id).at(-1) ?? ''
    const latestAuthorityKey = `${projectRevisionRef.current}\u0000${latestShot.id}\u0000${latestPrimaryId}`
    if (baseAuthorityKey !== latestAuthorityKey) {
      setStatus('The mathematical content changed before this draft could be applied. Review it against the current object and retry.')
      return false
    }
    if (current.isPlaying) {
      setStatus('Pause sequence playback before editing mathematical content.')
      return false
    }
    const latestObject = latestShot.objects.find(({ id }) => id === latestPrimaryId)
    if (!latestObject || latestObject.type !== 'math') {
      setStatus('The selected mathematical object is no longer available.')
      return false
    }
    return commitOps([{ type: 'update-object', objectId: latestPrimaryId, patch: { properties: { ...next } } }], 'Edit mathematical content')
  }

  const commitGraphProperties = (next: GraphDraftValue, baseAuthorityKey: string) => {
    const current = authorityRef.current
    const latestProject = current.history.present
    const latestShot = latestProject.shots.find(({ id }) => id === current.workspace.activeShotId) ?? latestProject.shots[0]
    const latestPrimaryId = selectedObjectIds(current.workspace.selection, latestShot.id).at(-1) ?? ''
    const latestAuthorityKey = `${projectRevisionRef.current}\u0000${latestShot.id}\u0000${latestPrimaryId}`
    if (baseAuthorityKey !== latestAuthorityKey) {
      setStatus('The graph changed before this draft could be applied. Review it against the current object and retry.')
      return false
    }
    if (current.isPlaying) {
      setStatus('Pause sequence playback before editing graph geometry.')
      return false
    }
    const latestObject = latestShot.objects.find(({ id }) => id === latestPrimaryId)
    if (!latestObject || latestObject.type !== 'graph') {
      setStatus('The selected graph object is no longer available.')
      return false
    }
    if (effectiveLockOwner(latestShot, latestObject)) {
      setStatus('Unlock the graph and its ancestors before applying graph geometry.')
      return false
    }
    return commitOps([{
      type: 'update-object',
      objectId: latestPrimaryId,
      patch: { properties: { expression: next.expression, xMin: next.xMin, xMax: next.xMax } },
    }], 'Edit function graph')
  }

  const objectPropertyValue = (property: PropertyTrack['property'], tracked: boolean): PropertyKeyframe['value'] => {
    if (!primary || !primaryPreview) return 0
    const source = tracked ? primaryPreview : primary
    if (property === 'x' || property === 'y' || property === 'width' || property === 'height' || property === 'rotation' || property === 'scaleX' || property === 'scaleY') {
      return source.transform[property] ?? (property === 'width' ? 60 : property === 'height' ? 30 : property.startsWith('scale') ? 1 : 0)
    }
    if (property === 'scale') return (source.transform.scaleX + source.transform.scaleY) / 2
    const shapePaint = isCurrentShapeType(primary.type) ? resolveShapePaint(primaryPreview, previewStyle) : null
    if (property === 'opacity') return shapePaint?.opacity ?? source.style.opacity ?? 1
    if (property === 'fill') return shapePaint?.fill ?? source.style.fill ?? source.style.color ?? (primary.type === 'circle' ? previewStyle.colors.background : previewStyle.colors.ink)
    if (property === 'stroke') return primary.type === 'graph' ? resolvedGraphStroke(source, previewStyle, shot.objects).stroke : shapePaint?.stroke ?? source.style.stroke ?? previewStyle.colors.ink
    if (property === 'strokeWidth') return primary.type === 'graph' ? resolvedGraphStroke(source, previewStyle, shot.objects).strokeWidth : shapePaint?.strokeWidth ?? source.style.strokeWidth ?? previewStyle.strokes.regular
    return 0
  }

  const commitObjectBaseProperty = (property: PropertyTrack['property'], next: PropertyKeyframe['value']) => {
    if (!primary) return false
    if (['x', 'y', 'width', 'height', 'rotation', 'scaleX', 'scaleY'].includes(property) && typeof next === 'number') {
      return commitPatch({ transform: { [property]: next } }, `Set ${property}`)
    }
    if (property === 'scale' && typeof next === 'number') return commitPatch({ transform: { scaleX: next, scaleY: next } }, 'Set scale')
    if (['opacity', 'strokeWidth'].includes(property) && typeof next === 'number') return commitPatch({ style: { [property]: next } }, `Set ${property}`)
    if (['fill', 'stroke'].includes(property) && typeof next === 'string') return commitPatch({ style: { [property]: next } }, `Set ${property}`)
    return false
  }

  const renderObjectPropertyField = (
    property: PropertyTrack['property'],
    label: string,
    options: Readonly<{ min?: number; max?: number; minMagnitude?: number; step?: number | string; inputType?: 'number' | 'color'; familyLock?: boolean }> = {},
  ) => {
    if (!primary) return null
    const track = objectPropertyTrack(primary.id, property)
    return <PropertyKeyframeField
    key={`${primary.id}-${property}`}
    project={project}
    shotId={shot.id}
    target={{ kind: 'object', objectId: primary.id }}
    property={property}
    label={label}
    value={objectPropertyValue(property, Boolean(track))}
    playhead={playhead}
    track={track}
    selection={selection}
    disabled={isPlaying || (options.familyLock ? primaryFamilyLocked : primaryEffectivelyLocked)}
    inputType={options.inputType}
    min={options.min}
    max={options.max}
    minMagnitude={options.minMagnitude}
    step={options.step}
    onCommit={commitRenderedTimelineIntent}
    onBaseChange={(next) => commitObjectBaseProperty(property, next)}
    onSelectKeyframe={selectSingleKeyframe}
    onNotice={setStatus}
  />
  }

  const renderCameraPropertyField = (property: 'x' | 'y' | 'zoom' | 'rotation', label: string, min: number, max: number) => {
    const track = cameraPropertyTrack(property)
    return <PropertyKeyframeField
    key={`camera-${property}`}
    project={project}
    shotId={shot.id}
    target={{ kind: 'camera' }}
    property={property}
    label={label}
    value={track ? shotPreview.camera[property] : shot.camera[property]}
    playhead={playhead}
    track={track}
    selection={selection}
    disabled={isPlaying}
    min={min}
    max={max}
    onCommit={commitRenderedTimelineIntent}
    onBaseChange={(next) => typeof next === 'number' && commitOps([{ type: 'set-camera', camera: { ...shot.camera, [property]: next } }], `Set camera ${property}`)}
    onSelectKeyframe={selectSingleKeyframe}
    onNotice={setStatus}
  />
  }

  const nudge = useCallback((dx: number, dy: number) => {
    const latestAuthority = authorityRef.current
    if (latestAuthority.isPlaying) return
    const latestProject = latestAuthority.history.present
    const latestShot = latestProject.shots.find(({ id }) => id === latestAuthority.workspace.activeShotId) ?? latestProject.shots[0]
    const latestObjects = selectionRootIds(latestShot, selectedRootIds).map((id) => latestShot.objects.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object))
    if (!latestObjects.length) return
    const selectedFamilyIds = new Set(latestObjects.flatMap((object) => familyObjectIds(latestShot, [object.id])))
    if ([...selectedFamilyIds].some((id) => effectiveLockOwner(latestShot, id))) {
      setStatus('The selection contains a locked object; unlock it before nudging the selection.')
      return
    }
    if ([...selectedFamilyIds].some((id) => temporallyTransformsObject(latestShot, id, playbackClockRef.current.getSnapshot().localTime))) {
      setStatus('This playhead shows animated geometry. Edit the timeline block, or scrub before the spatial animation begins, to change the base pose.')
      return
    }
    commitOps(latestObjects.map((object) => ({ type: 'update-object', objectId: object.id, patch: { transform: { x: object.transform.x + dx, y: object.transform.y + dy } } })), 'Nudge selection')
  }, [commitOps, selectedRootIds])

  const undoHistory = useCallback(() => {
    const currentAuthority = authorityRef.current
    if (currentAuthority.isPlaying) {
      setStatus('Pause sequence playback before undoing project changes.')
      return false
    }
    const current = currentAuthority.history
    const label = current.past.at(-1)?.label
    if (!label) {
      setStatus('Nothing to undo')
      return false
    }
    const traversal = undoAuthoringHistory(current)
    if (!traversal.ok) {
      setStatus(`Undo blocked: ${traversal.message}`)
      return false
    }
    const next = traversal.history
    workspaceSnapshotsRef.current.set(current.present, materializeLiveWorkspace(currentAuthority))
    const restored = workspaceSnapshotsRef.current.get(next.present)
      ?? reconcileEditorWorkspace(next.present, currentAuthority.workspace)
    publishEditorAuthority(next, restored, 'pause', { status: `Undid: ${label}` })
    return true
  }, [materializeLiveWorkspace, publishEditorAuthority])

  const redoHistory = useCallback(() => {
    const currentAuthority = authorityRef.current
    if (currentAuthority.isPlaying) {
      setStatus('Pause sequence playback before redoing project changes.')
      return false
    }
    const current = currentAuthority.history
    const label = current.future[0]?.label
    if (!label) {
      setStatus('Nothing to redo')
      return false
    }
    const traversal = redoAuthoringHistory(current)
    if (!traversal.ok) {
      setStatus(`Redo blocked: ${traversal.message}`)
      return false
    }
    const next = traversal.history
    workspaceSnapshotsRef.current.set(current.present, materializeLiveWorkspace(currentAuthority))
    const restored = workspaceSnapshotsRef.current.get(next.present)
      ?? reconcileEditorWorkspace(next.present, currentAuthority.workspace)
    publishEditorAuthority(next, restored, 'pause', { status: `Redid: ${label}` })
    return true
  }, [materializeLiveWorkspace, publishEditorAuthority])

  const togglePlayback = useCallback(() => {
    const current = authorityRef.current
    if (current.isPlaying) {
      publishEditorAuthority(current.history, materializeLiveWorkspace(current), 'pause', { invalidateAi: false, status: 'Sequence paused' })
      return
    }
    const started = beginEditorShotSequencePlayback(current.history.present, current.workspace)
    if (!started.ok) {
      setStatus(started.diagnostic.message)
      return
    }
    publishEditorAuthority(current.history, started.workspace, 'play', { invalidateAi: false, status: started.globalTime === 0 ? 'Sequence playing from start' : 'Sequence playing' })
  }, [materializeLiveWorkspace, publishEditorAuthority])

  const jumpSequenceTime = useCallback((time: number) => {
    const current = authorityRef.current
    const resolved = seekEditorShotSequence(current.history.present, current.workspace, time)
    if (!resolved.ok) {
      setStatus(resolved.diagnostic.message)
      return false
    }
    publishEditorAuthority(current.history, resolved.workspace, 'pause', { invalidateAi: false })
    return true
  }, [publishEditorAuthority])

  const jumpLocalPlayhead = useCallback((time: number) => {
    const current = authorityRef.current
    const sequence = buildEditorShotSequence(current.history.present)
    const entry = sequence.entries.find(({ shotId }) => shotId === current.workspace.activeShotId)
    if (!entry) return false
    return jumpSequenceTime(addTimelineTimes(entry.start, time))
  }, [jumpSequenceTime])

  const selectLibraryTab = (event: ReactKeyboardEvent<HTMLButtonElement>, current: LibraryTab) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const index = LIBRARY_TABS.indexOf(current)
    const next = event.key === 'Home' ? LIBRARY_TABS[0]
      : event.key === 'End' ? LIBRARY_TABS.at(-1)!
        : event.key === 'ArrowLeft' ? LIBRARY_TABS[(index - 1 + LIBRARY_TABS.length) % LIBRARY_TABS.length]
          : LIBRARY_TABS[(index + 1) % LIBRARY_TABS.length]
    setLibraryTab(next)
    setLibrarySearch('')
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-library-tab="${next}"]`)?.focus())
  }

  const navigateLayerTree = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const current = shot.objects[index]
    if (event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      setSelectedIds(selectionRootIds(shot, selectedRootIds.includes(current.id) ? selectedRootIds.filter((id) => id !== current.id) : [...selectedRootIds, current.id]))
      return
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    let targetIndex = index
    if (event.key === 'ArrowUp') targetIndex = Math.max(0, index - 1)
    if (event.key === 'ArrowDown') targetIndex = Math.min(shot.objects.length - 1, index + 1)
    if (event.key === 'Home') targetIndex = 0
    if (event.key === 'End') targetIndex = shot.objects.length - 1
    if (event.key === 'ArrowLeft' && current.parentId) targetIndex = shot.objects.findIndex(({ id }) => id === current.parentId)
    if (event.key === 'ArrowRight' && current.type === 'group') {
      const childIndex = shot.objects.findIndex(({ parentId }) => parentId === current.id)
      if (childIndex >= 0) targetIndex = childIndex
    }
    const target = shot.objects[targetIndex]
    if (!target) return
    if (!event.ctrlKey && !event.metaKey) setSelectedIds([target.id])
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-layer-object-id="${target.id}"]`)?.focus())
  }

  const selectShot = useCallback((shotId: string) => {
    const current = authorityRef.current
    // Reselecting the active storyboard card is intentionally inert. In
    // particular, do not materialize the external playback clock: publishing
    // that equivalent workspace would cancel the current rAF generation.
    if (shotId === current.workspace.activeShotId) return true
    const resolved = resolveEditorShotActivation(current.history.present, materializeLiveWorkspace(current), shotId)
    if (!resolved.ok) {
      setStatus(resolved.diagnostic.message)
      return false
    }
    if (resolved.workspace === current.workspace && resolved.playback === 'preserve') return true
    publishEditorAuthority(current.history, resolved.workspace, resolved.playback, { invalidateAi: false, status: `Selected ${current.history.present.shots.find(({ id }) => id === shotId)?.name ?? 'shot'}` })
    invalidateAiContext()
    return true
  }, [invalidateAiContext, materializeLiveWorkspace, publishEditorAuthority])

  const resetWorkspaceToShot = useCallback((shotId: string, nextPlayhead = 0) => {
    const current = authorityRef.current
    publishEditorAuthority(current.history, { activeShotId: shotId, selection: shotSelection([shotId]), playhead: nextPlayhead }, 'pause', { invalidateAi: false })
    invalidateAiContext()
  }, [invalidateAiContext, publishEditorAuthority])

  const runEditorShotAction = useCallback((action: EditorShotAction): StoryboardActionResult => {
    const current = authorityRef.current
    if (current.isPlaying) {
      setStatus('Pause sequence playback before changing the storyboard.')
      return { ok: false, activeShotId: current.workspace.activeShotId }
    }
    const liveWorkspace = materializeLiveWorkspace(current)
    const expectedRevision = canonicalProjectJson(current.history.present)
    const resolution = commitEditorShotAction(current.history, liveWorkspace, { ...action, expectedRevision })
    if (!resolution.ok) {
      setStatus(resolution.diagnostic.message)
      return { ok: false, activeShotId: current.workspace.activeShotId }
    }
    publishEditorAuthority(resolution.history, resolution.workspace, resolution.playback, { status: resolution.label })
    return { ok: true, activeShotId: resolution.workspace.activeShotId }
  }, [materializeLiveWorkspace, publishEditorAuthority])

  const splitActiveShot = useCallback((): StoryboardActionResult => {
    const current = authorityRef.current
    const liveWorkspace = materializeLiveWorkspace(current)
    return runEditorShotAction({ type: 'split-shot', shotId: liveWorkspace.activeShotId, time: liveWorkspace.playhead })
  }, [materializeLiveWorkspace, runEditorShotAction])

  const focusStoryboardShot = useCallback((shotId: string) => {
    window.requestAnimationFrame(() => {
      const card = storyboardCardFor(shotId)
      card?.focus({ preventScroll: true })
      card?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    })
  }, [])

  const openShotDialog = useCallback((kind: NonNullable<ShotDialogState>['kind'], shotId: string, trigger: HTMLElement) => {
    shotDialogTriggerRef.current = trigger
    setOwnerMenuOpen(false)
    setCommandPaletteOpen(false)
    setUtilityDialog(null)
    setExportPreview(null)
    setShotDialog({ kind, shotId })
  }, [])

  const commitShotDialog = useCallback(() => {
    const dialog = shotDialog
    if (!dialog) return
    const target = authorityRef.current.history.present.shots.find(({ id }) => id === dialog.shotId)
    if (!target) {
      setStatus(`Shot not found: ${dialog.shotId}`)
      return
    }
    const input = shotDialogInputRef.current
    const result = dialog.kind === 'rename'
      ? runEditorShotAction({ type: 'rename-shot', shotId: target.id, name: input?.value ?? '' })
      : dialog.kind === 'duration'
        ? runEditorShotAction({ type: 'set-shot-duration', shotId: target.id, duration: input?.valueAsNumber ?? Number.NaN })
        : runEditorShotAction({ type: 'delete-shot', shotId: target.id })
    if (!result.ok) {
      input?.focus()
      return
    }
    shotDialogTriggerRef.current = storyboardCardFor(result.activeShotId)
    setShotDialog(null)
    focusStoryboardShot(result.activeShotId)
  }, [focusStoryboardShot, runEditorShotAction, shotDialog])

  const editShot = (patch: Partial<Pick<Shot, 'name' | 'duration'>>, _label: string) => {
    const current = authorityRef.current.workspace
    if (patch.name !== undefined) return runEditorShotAction({ type: 'rename-shot', shotId: current.activeShotId, name: patch.name }).ok
    if (patch.duration !== undefined) return runEditorShotAction({ type: 'set-shot-duration', shotId: current.activeShotId, duration: patch.duration }).ok
    return false
  }

  const reorderShot = (direction: -1 | 1) => {
    const current = authorityRef.current
    const index = current.history.present.shots.findIndex(({ id }) => id === current.workspace.activeShotId)
    return runEditorShotAction({ type: 'reorder-shot', shotId: current.workspace.activeShotId, index: index + direction }).ok
  }

  const addAnimation = () => {
    if (!selectedRootIds.length && animationType !== 'camera-focus') return setStatus('Select one or more objects before adding an animation')
    if (animationType === 'transform' && selectedRootIds.length > 1) return setStatus('Transform uses one absolute target. Select one object, or use Move/Scale to preserve multi-object spacing.')
    const duration = Math.min(previewStyle.motion.defaultDuration, Math.max(0.1, subtractTimelineTimes(shot.duration, playhead)))
    const id = allocateId('animation', collectProjectIds(project), animationType)
    const targetIds = animationType === 'camera-focus' ? (selectedRootIds.length ? selectedRootIds : [shot.objects[0]?.id].filter(Boolean)) : selectedRootIds
    if (!targetIds.length) return setStatus('This shot needs an object before camera focus can be added')
    const properties: SceneAnimation['properties'] = animationType === 'move' && primary
      ? selectedRootIds.length > 1 ? { deltaX: 80, deltaY: 0 } : { x: primary.transform.x + 80, y: primary.transform.y }
      : animationType === 'scale' ? { scale: 1.2 } : animationType === 'emphasise' ? { scale: 1.12 } : animationType === 'camera-focus' ? { x: primary?.transform.x ?? logicalFrame.centerX, y: primary?.transform.y ?? logicalFrame.centerY, zoom: 1.15 } : {}
    const easing: Easing = animationType === 'emphasise'
      ? 'there-and-back'
      : (animationType === 'write' || animationType === 'create') && previewStyle.motion.easing === 'there-and-back'
        ? 'linear'
        : previewStyle.motion.easing
    const animation: SceneAnimation = { id, type: animationType, targetIds, start: Math.min(playhead, subtractTimelineTimes(shot.duration, duration)), duration, easing, properties }
    if (commitOps([{ type: 'add-animation', animation }], `Add ${animationType} animation`)) setSelectedAnimationId(id)
  }

  const updateAnimation = (patch: Extract<SceneOperation, { type: 'update-animation' }>['patch'], label: string) => {
    if (!selectedAnimation) return false
    return commitOps([{ type: 'update-animation', animationId: selectedAnimation.id, patch }], label)
  }

  const deleteTimelineAnimation = (animation: SceneAnimation) => {
    if (animationAuthoringCompatibilityIssue(animation)) {
      setStatus('This saved animation is read-only except for its easing repair.')
      return false
    }
    if (animationTargetsLocked(shot, animation)) {
      setStatus('This animation targets a locked object family; unlock it before deleting the block.')
      return false
    }
    const committed = commitOps([{ type: 'delete-animation', animationId: animation.id }], 'Delete animation')
    if (committed) setSelectedAnimationId(null)
    return committed
  }

  const commitNumericInput = (
    event: ReactFocusEvent<HTMLInputElement>,
    field: NumericField,
    current: number,
    commit: (value: number) => boolean | void,
  ) => {
    const value = event.currentTarget.valueAsNumber
    if (!numericFieldAccepts(field, value)) {
      event.currentTarget.value = String(current)
      const magnitude = field.minMagnitude === undefined ? '' : ` with magnitude at least ${field.minMagnitude}`
      setStatus(`${field.label} must be between ${field.min} and ${field.max}${magnitude}`)
      return
    }
    if (commit(value) === false) event.currentTarget.value = String(current)
  }

  const commitTextInput = (
    event: ReactFocusEvent<HTMLInputElement | HTMLTextAreaElement>,
    current: string,
    label: string,
    commit: (value: string) => boolean | void,
    options: { trim?: boolean; required?: boolean } = {},
  ) => {
    const value = options.trim ? event.currentTarget.value.trim() : event.currentTarget.value
    if (options.required && !value) {
      event.currentTarget.value = current
      setStatus(`${label} cannot be empty`)
      return
    }
    const committed = commit(value)
    event.currentTarget.value = committed === false ? current : value
  }

  const beginTimelineGesture = (event: ReactPointerEvent, animation: SceneAnimation, kind: 'move' | 'resize') => {
    event.stopPropagation()
    if (event.button !== 0 || event.isPrimary === false || timelineGestureRef.current) return
    if (authorityRef.current.isPlaying) {
      setStatus('Pause preview before editing timeline blocks.')
      return
    }
    if (animationAuthoringCompatibilityIssue(animation)) {
      setSelectedAnimationId(animation.id)
      setStatus('This saved animation is read-only except for its easing repair.')
      return
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setSelectedAnimationId(animation.id)
    const gesture = { id: animation.id, kind, pointerId: event.pointerId, clientX: event.clientX, start: animation.start, duration: animation.duration, baseRevision: projectRevisionRef.current, baseShotId: activeShotIdRef.current }
    const draft = { id: animation.id, start: animation.start, duration: animation.duration }
    timelineGestureRef.current = gesture
    timelineDraftRef.current = draft
    setTimelineGesture(gesture)
    setTimelineDraft(draft)
  }

  const moveTimelineGesture = (event: ReactPointerEvent) => {
    const gesture = timelineGestureRef.current
    if (!gesture || event.pointerId !== gesture.pointerId || !trackRef.current) return
    if (gesture.baseRevision !== projectRevisionRef.current || gesture.baseShotId !== activeShotIdRef.current || authorityRef.current.isPlaying) {
      timelineGestureRef.current = null
      timelineDraftRef.current = null
      setTimelineGesture(null)
      setTimelineDraft(null)
      return
    }
    const seconds = (event.clientX - gesture.clientX) / trackRef.current.clientWidth * shot.duration
    const snap = (value: number) => Math.round(value * 10) / 10
    const draft = gesture.kind === 'move'
      ? { id: gesture.id, start: snap(Math.max(0, Math.min(subtractTimelineTimes(shot.duration, gesture.duration), addTimelineTimes(gesture.start, seconds)))), duration: gesture.duration }
      : { id: gesture.id, start: gesture.start, duration: snap(Math.max(0.1, Math.min(subtractTimelineTimes(shot.duration, gesture.start), addTimelineTimes(gesture.duration, seconds)))) }
    timelineDraftRef.current = draft
    setTimelineDraft(draft)
  }

  const endTimelineGesture = (event: ReactPointerEvent) => {
    const gesture = timelineGestureRef.current
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const draft = timelineDraftRef.current
    if (draft && gesture.baseRevision === projectRevisionRef.current && gesture.baseShotId === activeShotIdRef.current && !authorityRef.current.isPlaying) {
      commitOps([{ type: 'update-animation', animationId: gesture.id, patch: { start: draft.start, duration: draft.duration } }], gesture.kind === 'move' ? 'Move timeline block' : 'Resize timeline block')
    }
    timelineGestureRef.current = null
    timelineDraftRef.current = null
    setTimelineGesture(null)
    setTimelineDraft(null)
  }

  const cancelTimelineGesture = (event: ReactPointerEvent) => {
    const gesture = timelineGestureRef.current
    if (!gesture || event.pointerId !== gesture.pointerId) return
    timelineGestureRef.current = null
    timelineDraftRef.current = null
    setTimelineGesture(null)
    setTimelineDraft(null)
  }

  const runAi = async (value = instruction) => {
    const requestId = aiRequestSequence.current + 1
    aiRequestSequence.current = requestId
    aiAbortController.current?.abort()
    const controller = new AbortController()
    aiAbortController.current = controller
    setInstruction(value)
    setCritique(null)
    setProposal(null)
    setProposalBase(null)
    setAiPending(true)
    try {
      const submit = async (): Promise<boolean> => {
        if (durableProject && aiConfigured && !await drainDurableSaves()) throw new Error('Save the current project before requesting an AI proposal')
        if (requestId !== aiRequestSequence.current || controller.signal.aborted) return true

        // Capture every field of the request and its UI provenance together,
        // after the save drain and while later revision mutations are queued.
        const snapshotProject = historyRef.current.present
        const snapshotShot = snapshotProject.shots.find(({ id }) => id === activeShotIdRef.current) ?? snapshotProject.shots[0]
        const snapshotSelection = normalizeEditorSelection(selectionRef.current, snapshotProject, snapshotShot.id)
        const canonical = canonicalProjectJson(snapshotProject)
        const base = { revision: canonical, shotId: snapshotShot.id }
        const localRequest = {
          project: snapshotProject,
          shotId: snapshotShot.id,
          selectedObjectIds: [...selectedObjectIds(snapshotSelection, snapshotShot.id)],
          instruction: value,
        }
        if (!aiConfigured) {
          setProposal(interpretDemoCommand(localRequest))
          setProposalBase(base)
          setAiProvider('deterministic-demo')
          setAiError('')
          return true
        }

        const token = durableProject ? await ensureCsrfToken() : null
        const request = durableProject ? {
          projectId: durableProject.projectId,
          revision: serverRevisionRef.current,
          shotId: snapshotShot.id,
          selectedObjectIds: localRequest.selectedObjectIds,
          instruction: value,
        } : localRequest
        const response = await fetch('/api/proofcanvas/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { 'X-ProofCanvas-CSRF': token } : {}) },
          body: JSON.stringify(request),
          signal: controller.signal,
        })
        const payload: unknown = await response.json()
        if (requestId !== aiRequestSequence.current) return true
        if (response.ok) {
          if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) throw new Error('AI provider returned an invalid proposal')
          const output = payload as { intention?: unknown; summary?: unknown; operations?: unknown }
          if (typeof output.intention !== 'string' || !Array.isArray(output.summary) || !output.summary.every((item) => typeof item === 'string') || !Array.isArray(output.operations)) {
            throw new Error('AI provider returned an invalid proposal')
          }
          const operations = output.operations.map((operation) => SceneOperationSchema.parse(operation))
          setProposal({ provider: 'configured-provider', demoMode: false, intention: output.intention, summary: output.summary, operations })
          setProposalBase(base)
          setAiProvider('configured-provider')
        } else if (payload && typeof payload === 'object' && (payload as { code?: unknown }).code === 'provider_unavailable') {
          setProposal(interpretDemoCommand(localRequest))
          setProposalBase(base)
          setAiProvider('deterministic-demo')
        } else {
          throw new Error(responseMessage(payload, 'The configured AI provider could not propose a change'))
        }
        setAiError('')
        return true
      }
      if (durableProject && aiConfigured) await enqueueRevisionMutation(submit)
      else await submit()
    } catch (error) {
      if (requestId === aiRequestSequence.current && !(error instanceof DOMException && error.name === 'AbortError')) {
        setAiError(error instanceof Error ? error.message : 'The AI editor could not propose a change')
      }
    } finally {
      if (requestId === aiRequestSequence.current) {
        aiAbortController.current = null
        setAiPending(false)
      }
    }
  }

  const startRender = async (quality: ClientRenderJob['quality'] = renderQuality) => {
    setUtilityDialog(null)
    setRendererMessage('')
    setRenderJob(null)
    setRenderBaseRevision(null)
    setRenderPollFailures(0)
    setRenderPollingPaused(false)
    setRenderPending(true)
    try {
      const submit = async (): Promise<boolean> => {
        if (durableProject && !await drainDurableSaves()) throw new Error('Save the current project before starting a render')
        const snapshotProject = historyRef.current.present
        const submittedRevision = canonicalProjectJson(snapshotProject)
        const submittedServerRevision = serverRevisionRef.current
        setRenderBaseRevision(submittedRevision)
        const token = durableProject ? await ensureCsrfToken() : null
        const response = await fetch('/api/proofcanvas/render', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { 'X-ProofCanvas-CSRF': token } : {}) },
          body: JSON.stringify(durableProject
            ? { projectId: durableProject.projectId, revision: submittedServerRevision, quality }
            : { project: snapshotProject, quality }),
        })
        const payload: unknown = await response.json()
        if (!response.ok) throw new Error(responseMessage(payload, 'ProofCanvas rendering could not start'))
        if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) throw new Error('Renderer returned an invalid response')
        const job = renderJobFromPayload((payload as { job?: unknown }).job)
        setRenderJob(job)
        setStatus('Genuine Manim render queued')
        return true
      }
      if (durableProject) await enqueueRevisionMutation(submit)
      else await submit()
    } catch (error) {
      setRenderBaseRevision(null)
      setRendererMessage(error instanceof Error ? error.message : 'ProofCanvas rendering could not start')
    } finally {
      setRenderPending(false)
    }
  }

  const applyProposal = () => {
    if (!proposal) return
    if (!proposalBase || proposalBase.revision !== projectRevision || proposalBase.shotId !== shot.id) {
      setProposal(null)
      setProposalBase(null)
      setAiError('The project changed after this proposal was created. Request a fresh proposal before applying it.')
      return
    }
    if (commitOps(proposal.operations, `AI: ${proposal.intention}`)) { setProposal(null); setProposalBase(null); setStatus('AI proposal applied as one transaction') }
  }

  const saveProject = () => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) active.blur()
    if (durableProject) {
      void flushDurableSaves()
      return
    }
    try { window.localStorage.setItem(STORAGE_KEY, canonicalProjectJson(historyRef.current.present)); setStatus('Saved locally') }
    catch { setStatus('Local storage is unavailable') }
  }

  const loadCheckpoints = async () => {
    if (!durableProject) return
    setCheckpointPending(true)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(durableProject.projectId)}/checkpoints`, { cache: 'no-store' })
      const payload: unknown = await response.json()
      if (!response.ok || !payload || typeof payload !== 'object' || !Array.isArray((payload as { checkpoints?: unknown }).checkpoints)) {
        throw new Error(responseMessage(payload, 'Checkpoints could not be loaded'))
      }
      const loaded = (payload as { checkpoints: unknown[] }).checkpoints.filter((candidate): candidate is DurableCheckpoint => Boolean(
        candidate && typeof candidate === 'object'
        && typeof (candidate as { id?: unknown }).id === 'string'
        && typeof (candidate as { revision?: unknown }).revision === 'number'
        && typeof (candidate as { label?: unknown }).label === 'string'
        && typeof (candidate as { createdAt?: unknown }).createdAt === 'string'
        && typeof (candidate as { recoveryRequired?: unknown }).recoveryRequired === 'boolean',
      ))
      setCheckpoints(loaded)
      setRecoveryOpen(true)
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'Checkpoints could not be loaded')
    } finally {
      setCheckpointPending(false)
    }
  }

  const loadProject = () => {
    if (durableProject) {
      void loadCheckpoints()
      return
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return setStatus('No saved ProofCanvas project was found')
      const loaded = parseProjectDocument(raw)
      if (commitDocument(loaded, 'Load saved project', { allowLegacyGraphLoad: true })) { resetWorkspaceToShot(loaded.shots[0].id); setCritique(null) }
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Saved project is invalid') }
  }

  const createCheckpoint = async () => {
    if (!durableProject || checkpointPending || saveConflictRef.current) return
    setCheckpointPending(true)
    try {
      const created = await enqueueRevisionMutation(async () => {
        if (!await drainDurableSaves()) throw new Error('Save the current project before creating a checkpoint')
        const expectedRevision = serverRevisionRef.current
        const { response, payload } = await durableMutation(`/api/projects/${encodeURIComponent(durableProject.projectId)}/checkpoints`, 'POST', {
          expectedRevision,
          mutationId: window.crypto.randomUUID(),
          label: 'Manual checkpoint',
        })
        if (!response.ok) throw new Error(responseMessage(payload, 'Checkpoint could not be created'))
        const uncertainCheckpointReceipt = (): never => {
          // A 2xx response may already have committed. Never guess the new CAS
          // base or retry with a fresh mutation ID; require an authoritative
          // reload before another durable mutation.
          saveConflictRef.current = true
          setSaveState('conflict')
          throw new Error('Checkpoint returned an uncertain revision receipt. Reload the durable project before continuing')
        }
        if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) uncertainCheckpointReceipt()
        const receipt = (payload as { checkpoint?: unknown }).checkpoint
        const revision = receipt && typeof receipt === 'object' ? (receipt as { revision?: unknown }).revision : undefined
        const receiptProjectId = receipt && typeof receipt === 'object' ? (receipt as { projectId?: unknown }).projectId : undefined
        const checkpointId = receipt && typeof receipt === 'object' ? (receipt as { checkpointId?: unknown }).checkpointId : undefined
        if (typeof revision !== 'number'
          || !Number.isSafeInteger(revision)
          || revision !== expectedRevision + 1
          || receiptProjectId !== durableProject.projectId
          || typeof checkpointId !== 'string'
          || !/^checkpoint-[a-f0-9]{24}$/.test(checkpointId)) {
          uncertainCheckpointReceipt()
        }
        const acceptedRevision = revision as number
        serverRevisionRef.current = acceptedRevision
        setServerRevision(acceptedRevision)
        setSaveState(projectRevisionRef.current === lastSavedCanonicalRef.current ? 'saved' : 'waiting')
        setSaveMessage(`Checkpoint created at revision ${acceptedRevision}`)
        return true
      })
      if (!created) return
      await loadCheckpoints()
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'Checkpoint could not be created')
    } finally {
      setCheckpointPending(false)
    }
  }

  const recoverCheckpoint = async (checkpoint: DurableCheckpoint) => {
    if (!durableProject || checkpointPending) return
    if (checkpoint.recoveryRequired) {
      setSaveMessage('This legacy checkpoint cannot be migrated losslessly. Export its exact JSON instead of recovering it.')
      return
    }
    if (!window.confirm(`Recover “${checkpoint.label}” from revision ${checkpoint.revision}? A checkpoint of the current project will be created first.`)) return
    setCheckpointPending(true)
    try {
      await enqueueRevisionMutation(async () => {
        if (!await drainDurableSaves()) throw new Error('Resolve the current save before recovering a checkpoint')
        const { response, payload } = await durableMutation(`/api/projects/${encodeURIComponent(durableProject.projectId)}/recover`, 'POST', {
          checkpointId: checkpoint.id,
          expectedRevision: serverRevisionRef.current,
          mutationId: window.crypto.randomUUID(),
        })
        if (!response.ok || !payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) throw new Error(responseMessage(payload, 'Checkpoint could not be recovered'))
        return true
      })
      window.location.reload()
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'Checkpoint could not be recovered')
      setCheckpointPending(false)
    }
  }

  const applyLocalRecovery = () => {
    if (!localRecovery || !durableProject) return
    try {
      const recovered = ProjectDocumentSchema.parse({
        ...cloneSerializable(localRecovery),
        metadata: { ...localRecovery.metadata, id: durableProject.projectId, createdAt: project.metadata.createdAt },
      })
      if (!commitDocument(recovered, 'Recover explicit browser copy')) {
        setSaveMessage('Browser recovery was not applied. The recovery offer and stored copy were preserved; resolve the reported authoring issue or ignore it explicitly.')
        return
      }
      recoveryAppliedRef.current = true
      setRecoveryIgnored(true)
      resetWorkspaceToShot(recovered.shots[0].id)
      setSaveMessage('Browser recovery applied; durable autosave is pending.')
    } catch (error) {
      setSaveMessage(error instanceof Error ? `Browser recovery was not applied: ${error.message}` : 'Browser recovery was not applied. The stored copy was preserved.')
    }
  }

  const resetDemo = () => {
    const source = createCantorDemoProject()
    const demo = durableProject ? ProjectDocumentSchema.parse({
      ...source,
      metadata: { ...source.metadata, id: durableProject.projectId, title: project.metadata.title, createdAt: project.metadata.createdAt, updatedAt: project.metadata.updatedAt },
    }) : source
    if (commitDocument(demo, 'Reset to preloaded demo')) { resetWorkspaceToShot(demo.shots[0].id, INITIAL_DEMO_PLAYHEAD); setCritique(null) }
  }

  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const requestId = ++importRequestSequence.current
    const baseRevision = projectRevision
    event.target.value = ''
    setImportError('')
    if (file.size > PROOFCANVAS_PROJECT_MAX_BYTES) {
      setImportError('Project JSON exceeds the 2 MiB import limit')
      return
    }
    try {
      const raw = await file.text()
      if (requestId !== importRequestSequence.current) return
      const loaded = parseProjectDocument(raw)
      const graphIssues = projectGraphAuthoringIssues(loaded)
      if (graphIssues.length) throw new Error(`Imported projects may not introduce invalid graph geometry: ${graphIssues[0].code}, object ${graphIssues[0].objectId}. ${graphIssues[0].message}`)
      if (requestId !== importRequestSequence.current) return
      if (projectRevisionRef.current !== baseRevision) {
        setImportError('The project changed while the import was being read. Select the file again.')
        return
      }
      if (commitDocument(loaded, `Import ${file.name}`)) { resetWorkspaceToShot(loaded.shots[0].id); setCritique(null); setImportError(''); setStatus(`Imported ${file.name}`) }
    } catch (error) {
      if (requestId === importRequestSequence.current) setImportError(error instanceof Error ? error.message : 'The selected project is invalid')
    }
  }

  const showExportPreview = (title: string, contents: string, diagnostics?: string[]) => {
    exportTriggerRef.current = utilityDialog
      ? utilityTriggerRef.current
      : document.activeElement instanceof HTMLElement ? document.activeElement : null
    setUtilityDialog(null)
    setExportPreview({ title, contents, diagnostics })
  }
  const exportJson = () => { const contents = canonicalProjectJson(project); showExportPreview('Project JSON', contents); download('uncountable-yet-zero-length.proofcanvas.json', 'application/json', contents) }
  const exportPython = () => {
    const result = compileManim(project)
    const diagnostics = result.diagnostics.map((diagnostic) => `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}${diagnostic.objectId ? ` · object ${diagnostic.objectId}` : ''}${diagnostic.animationId ? ` · animation ${diagnostic.animationId}` : ''}`)
    showExportPreview(`Manim Python${diagnostics.length ? ` · ${diagnostics.length} diagnostics` : ''}`, result.python, diagnostics)
    if (!result.diagnostics.some(({ severity }) => severity === 'error')) download('uncountable_yet_zero_length.py', 'text/x-python', result.python)
  }

  const openUtilityDialog = (dialog: 'settings' | 'shortcuts' | 'render-export') => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const stableTopbarTrigger = document.querySelector<HTMLElement>(`.pc-header [aria-label="${dialog === 'settings' ? 'Project settings' : dialog === 'shortcuts' ? 'Keyboard shortcuts' : 'Render or export'}"]`)
    utilityTriggerRef.current = active?.closest('[role="dialog"]') ? stableTopbarTrigger : active ?? stableTopbarTrigger
    setOwnerMenuOpen(false)
    setCommandPaletteOpen(false)
    setAssistantOpen(false)
    setUtilityDialog(dialog)
  }

  const renameProject = (title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return setStatus('Project title cannot be empty')
    const latest = cloneSerializable(historyRef.current.present)
    latest.metadata.title = trimmed
    commitDocument(latest, 'Rename project')
  }

  const updateProjectSettings = (patch: Partial<Pick<ProjectDocument['settings'], 'aspectRatio' | 'frameRate' | 'renderPreset' | 'previewQuality'>>) => {
    const latest = historyRef.current.present
    const settings = {
      aspectRatio: patch.aspectRatio ?? latest.settings.aspectRatio,
      frameRate: patch.frameRate ?? latest.settings.frameRate,
      renderPreset: patch.renderPreset ?? latest.settings.renderPreset,
      previewQuality: patch.previewQuality ?? latest.settings.previewQuality,
    }
    try {
      const next = applyDocumentOperations(latest, [{ type: 'set-project-settings', settings, cameraPolicy: 'recenter-default' }]).project
      commitDocument(next, 'Update project settings')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Project settings could not be updated')
    }
  }

  const guardedLeave = async (destination: '/' | '/login', logout = false) => {
    if (leavePending) return
    setOwnerMenuOpen(false)
    setLeavePending(true)
    try {
      const leave = async (): Promise<boolean> => {
        if (durableProject && !await drainDurableSaves()) {
          setSaveMessage('ProofCanvas stayed on this project because its latest revision is not durably saved.')
          return false
        }
        if (logout) {
          const { response, payload } = await durableMutation('/api/auth/logout', 'POST', {})
          if (!response.ok) throw new Error(responseMessage(payload, 'Log out failed'))
        }
        window.location.assign(destination)
        return true
      }
      if (durableProject) await enqueueRevisionMutation(leave)
      else await leave()
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'ProofCanvas could not leave this project')
    } finally {
      setLeavePending(false)
    }
  }

  const logoutOwner = () => durableProject ? guardedLeave('/login', true) : Promise.resolve()

  const dismissContext = useCallback(() => {
    if (shotDialog) { setShotDialog(null); return }
    if (utilityDialog) { setUtilityDialog(null); return }
    if (exportPreview) { setExportPreview(null); return }
    if (commandPaletteOpen) { setCommandPaletteOpen(false); setCommandSearch(''); return }
    if (ownerMenuOpen) { setOwnerMenuOpen(false); ownerMenuTriggerRef.current?.focus(); return }
    if (assistantOpen) { setAssistantOpen(false); return }
    if (timelineGesture || timelineDraft) {
      timelineGestureRef.current = null
      timelineDraftRef.current = null
      setTimelineGesture(null)
      setTimelineDraft(null)
      return
    }
    if (proposal) { setProposal(null); setProposalBase(null); return }
    if (recoveryOpen) { setRecoveryOpen(false); return }
    if (rendererMessage || importError) { setRendererMessage(''); setImportError(''); return }
    const current = authorityRef.current
    publishWorkspaceOnly({ ...current.workspace, selection: shotSelection([current.workspace.activeShotId]) })
    setStatus('Selection cleared')
  }, [assistantOpen, commandPaletteOpen, exportPreview, importError, ownerMenuOpen, proposal, publishWorkspaceOnly, recoveryOpen, rendererMessage, shotDialog, timelineDraft, timelineGesture, utilityDialog])

  const deleteContextSelection = useCallback((invocation: EditorCommandInvocation) => {
    const latest = authorityRef.current
    const keyboardShotId = invocation.source === 'keyboard'
      ? storyboardShotIdFromCommandTarget(invocation.event?.target, latest.history.present)
      : null
    const currentSelection = latest.workspace.selection
    const contextualShotId = keyboardShotId ?? (currentSelection.kind === 'shot' ? currentSelection.primaryShotId : null)
    if (contextualShotId) {
      const trigger = invocation.event?.target && typeof (invocation.event.target as HTMLElement).focus === 'function'
        ? invocation.event.target as HTMLElement
        : storyboardCardFor(contextualShotId) ?? document.body
      openShotDialog('delete', contextualShotId, trigger)
      return
    }
    if (selectedAnimation) { deleteTimelineAnimation(selectedAnimation); return }
    deleteSelection()
  }, [deleteSelection, openShotDialog, selectedAnimation])

  const duplicateContextSelection = useCallback((invocation: EditorCommandInvocation) => {
    const latest = authorityRef.current
    const keyboardShotId = invocation.source === 'keyboard'
      ? storyboardShotIdFromCommandTarget(invocation.event?.target, latest.history.present)
      : null
    const currentSelection = latest.workspace.selection
    const contextualShotId = keyboardShotId ?? (currentSelection.kind === 'shot' ? currentSelection.primaryShotId : null)
    if (contextualShotId) {
      const result = runEditorShotAction({ type: 'duplicate-shot', shotId: contextualShotId })
      if (result.ok) focusStoryboardShot(result.activeShotId)
      return
    }
    duplicateSelection()
  }, [duplicateSelection, focusStoryboardShot, runEditorShotAction])

  const canExecuteEditorCommand = useCallback((id: EditorCommandId, invocation: { source: 'keyboard' | 'toolbar' | 'menu' | 'palette'; event?: KeyboardEvent; shiftKey: boolean }) => {
    const target = invocation.event?.target
    const insideDialog = commandTargetWithin(target ?? null, '[role="dialog"]')
    if (insideDialog && !['dismiss', 'save-project', 'open-command-palette', 'open-render-export'].includes(id)) return false
    const latest = authorityRef.current
    const latestSelection = latest.workspace.selection
    if (id === 'undo') return !latest.isPlaying && canUndo(latest.history)
    if (id === 'redo') return !latest.isPlaying && canRedo(latest.history)
    const keyboardShotId = invocation.source === 'keyboard'
      ? storyboardShotIdFromCommandTarget(target, latest.history.present)
      : null
    if (id === 'delete-selection') return !latest.isPlaying && (keyboardShotId !== null || latestSelection.kind === 'shot'
      ? latest.history.present.shots.length > 1
      : Boolean(selectedObjectIds(latestSelection, latest.workspace.activeShotId).length || latestSelection.kind === 'animation'))
    if (id === 'duplicate-selection') return !latest.isPlaying && (keyboardShotId !== null || latestSelection.kind === 'shot'
      ? latest.history.present.shots.length < PROOFCANVAS_SCHEMA_LIMITS.shots
      : selectedObjectIds(latestSelection, latest.workspace.activeShotId).length > 0)
    if (id === 'group-selection') return !latest.isPlaying && selectedRootIds.length > 1
    if (id === 'ungroup-selection') return !latest.isPlaying && selectedObjects.some(({ type }) => type === 'group')
    if (id.startsWith('nudge-')) {
      if (latest.isPlaying) return false
      if (!selectedRootIds.length) return false
      return invocation.source !== 'keyboard' || commandTargetWithin(target ?? null, '[data-pc-canvas]')
    }
    return true
  }, [selectedObjects, selectedRootIds.length])

  const commandController = useMemo(() => createEditorCommandController({
    'toggle-playback': togglePlayback,
    undo: undoHistory,
    redo: redoHistory,
    'delete-selection': (invocation) => deleteContextSelection(invocation),
    'duplicate-selection': duplicateContextSelection,
    'group-selection': groupSelection,
    'ungroup-selection': ungroupSelection,
    'open-command-palette': () => {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      commandTriggerRef.current = active?.closest('[role="dialog"]') ? commandButtonRef.current : active ?? commandButtonRef.current
      setUtilityDialog(null)
      setExportPreview(null)
      setOwnerMenuOpen(false)
      setCommandSearch('')
      setActiveCommandOptionId(null)
      setCommandPaletteOpen(true)
    },
    'save-project': saveProject,
    'open-render-export': () => openUtilityDialog('render-export'),
    'nudge-left': ({ shiftKey }) => nudge(shiftKey ? -10 : -1, 0),
    'nudge-right': ({ shiftKey }) => nudge(shiftKey ? 10 : 1, 0),
    'nudge-up': ({ shiftKey }) => nudge(0, shiftKey ? -10 : -1),
    'nudge-down': ({ shiftKey }) => nudge(0, shiftKey ? 10 : 1),
    dismiss: dismissContext,
  }, canExecuteEditorCommand), [canExecuteEditorCommand, deleteContextSelection, dismissContext, duplicateContextSelection, groupSelection, nudge, redoHistory, saveProject, togglePlayback, undoHistory, ungroupSelection])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { commandController.handleKeyboard(event) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commandController])

  const normalizedLibrarySearch = librarySearch.trim().toLowerCase()
  const visibleObjectTypes = OBJECT_TYPES.filter((item) => item.tab === libraryTab && (!normalizedLibrarySearch || `${item.label} ${item.keywords}`.includes(normalizedLibrarySearch)))
  const visibleShapePresets = libraryTab === 'shapes' ? searchShapePresets(librarySearch) : []
  const visibleComponents = SEMANTIC_COMPONENTS.filter((component) => !normalizedLibrarySearch || `${component.name} ${component.description}`.toLowerCase().includes(normalizedLibrarySearch))
  const visibleCommands = EDITOR_COMMANDS.filter((command) => !commandSearch.trim() || `${command.label} ${command.shortcut}`.toLowerCase().includes(commandSearch.trim().toLowerCase()))
  const aiCommandVisible = !commandSearch.trim() || 'ai structured edit assistant review'.includes(commandSearch.trim().toLowerCase())
  const paletteCommands = visibleCommands.filter(({ id }) => id !== 'open-command-palette' && id !== 'dismiss').map((command) => ({
    command,
    id: `pc-command-option-${command.id}`,
    disabled: !canExecuteEditorCommand(command.id, { source: 'palette', shiftKey: false }),
  }))
  const navigableCommandOptionIds = [
    ...(aiCommandVisible ? ['pc-command-option-ai'] : []),
    ...paletteCommands.filter(({ disabled }) => !disabled).map(({ id }) => id),
  ]
  const navigableCommandOptionKey = navigableCommandOptionIds.join('\u0000')

  useEffect(() => {
    if (!commandPaletteOpen) return
    setActiveCommandOptionId((current) => current && navigableCommandOptionIds.includes(current) ? current : navigableCommandOptionIds[0] ?? null)
  }, [commandPaletteOpen, navigableCommandOptionKey])

  const navigateCommandListbox = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Enter') {
      if (activeCommandOptionId) document.getElementById(activeCommandOptionId)?.click()
      return
    }
    if (!navigableCommandOptionIds.length) return
    const currentIndex = activeCommandOptionId ? navigableCommandOptionIds.indexOf(activeCommandOptionId) : -1
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? navigableCommandOptionIds.length - 1
        : event.key === 'ArrowUp' ? currentIndex <= 0 ? navigableCommandOptionIds.length - 1 : currentIndex - 1
          : currentIndex < 0 || currentIndex >= navigableCommandOptionIds.length - 1 ? 0 : currentIndex + 1
    setActiveCommandOptionId(navigableCommandOptionIds[nextIndex])
    commandSearchRef.current?.focus()
  }

  const shotDialogTarget = shotDialog
    ? project.shots.find(({ id }) => id === shotDialog.shotId) ?? null
    : null

  const primaryShapeGeometry = primary ? resolveShapeGeometry(primary, previewStyle) : null
  const primaryShapeAuthoringIssue = primary ? shapeAuthoringIssue(primary) : undefined
  const primaryShapeDimensions = primary && primaryShapeGeometry ? resolveShapeDimensions(primary) : null
  const primaryLineEndpoints = primary && isLinearShapeType(primary.type)
    ? lineEndpointsForTransform(primary.transform)
    : null
  const primaryEndpointAuthority = Boolean(
    primary
    && isLinearShapeType(primary.type)
    && objectFamilyHasPropertyAuthority(shot, primary, ENDPOINT_AUTHORITY_PROPERTIES, ENDPOINT_ANCESTOR_AUTHORITY_PROPERTIES),
  )
  const primaryBraceAxisAuthority = Boolean(
    primary?.type === 'brace'
    && objectFamilyHasPropertyAuthority(shot, primary, BRACE_AXIS_AUTHORITY_PROPERTIES),
  )

  const commitEndpointInput = (
    event: ReactFocusEvent<HTMLInputElement>,
    endpoint: 'start' | 'end',
    axis: 'x' | 'y',
    currentValue: number,
  ) => {
    if (!primary) return
    const next = Number(event.currentTarget.value)
    if (Object.is(next, currentValue)) return
    if (!commitLineEndpoint(primary.id, endpoint, axis, next)) event.currentTarget.value = String(currentValue)
  }

  const commitBraceDirection = (direction: BraceDirection) => {
    if (!primary || primary.type !== 'brace' || primaryShapeGeometry?.kind !== 'brace' || !primaryShapeDimensions) return false
    const wasVertical = primaryShapeGeometry.direction === 'left' || primaryShapeGeometry.direction === 'right'
    const becomesVertical = direction === 'left' || direction === 'right'
    const crossesAxis = wasVertical !== becomesVertical
    if (crossesAxis && primaryBraceAxisAuthority) {
      setStatus('Remove the dependent object or ancestor dimension, rotation, or scale track before changing the brace axis.')
      return false
    }
    return commitShapeSettings(
      primary.id,
      { kind: 'brace', direction, spacing: primaryShapeGeometry.spacing },
      'Set brace direction',
      crossesAxis ? { width: primaryShapeDimensions.height, height: primaryShapeDimensions.width } : undefined,
    )
  }

  const renderShapeProperties = () => {
    if (!primary || !primaryShapeGeometry || !primaryShapeDimensions) return null
    const disabled = isPlaying || primaryEffectivelyLocked
    return <fieldset className="pc-shape-properties pc-wide" disabled={disabled}>
      <legend>Shape geometry</legend>
      {primaryShapeAuthoringIssue && <div className="pc-wide pc-shape-repair" role="status">
        <p>{primaryShapeAuthoringIssue.message}</p>
        <button type="button" onClick={() => commitShapeSettings(primary.id, primaryShapeGeometry, 'Repair shape settings')}>Repair shape settings</button>
      </div>}
      {primaryShapeGeometry.kind === 'rectangle' && <label className="pc-wide">Corner radius<input
        key={`${primary.id}-corner-radius-${primaryShapeGeometry.cornerRadius}`}
        type="number"
        min={0}
        max={Math.min(PROOFCANVAS_SCHEMA_LIMITS.cornerRadiusMax, primaryShapeDimensions.width / 2, primaryShapeDimensions.height / 2)}
        step="0.1"
        aria-label="Corner radius"
        defaultValue={primaryShapeGeometry.cornerRadius}
        onBlur={(event) => commitNumericInput(event, {
          key: 'cornerRadius',
          label: 'Corner radius',
          fallback: primaryShapeGeometry.cornerRadius,
          min: 0,
          max: Math.min(PROOFCANVAS_SCHEMA_LIMITS.cornerRadiusMax, primaryShapeDimensions.width / 2, primaryShapeDimensions.height / 2),
        }, primaryShapeGeometry.cornerRadius, (cornerRadius) => commitShapeSettings(primary.id, { kind: 'rectangle', cornerRadius }, 'Set corner radius'))}
      /></label>}
      {primaryShapeGeometry.kind === 'polygon' && <>
        <label className="pc-wide">Line join<select aria-label="Polygon line join" value={primaryShapeGeometry.lineJoin} onChange={(event) => commitShapeSettings(primary.id, { kind: 'polygon', vertices: primaryShapeGeometry.vertices.map((vertex) => ({ ...vertex })), lineJoin: event.target.value as ShapeLineJoin }, 'Set polygon line join')}>{SHAPE_LINE_JOINS.map((join) => <option key={join} value={join}>{join}</option>)}</select></label>
        <div className="pc-wide pc-shape-point-list">
          <h3>Vertices</h3>
          <p className="pc-inspector-note">Coordinates are normalized to the object box from −0.5 to 0.5.</p>
          {primaryShapeGeometry.vertices.map((vertex, index) => <div className="pc-shape-point" key={`${primary.id}-vertex-${index}`}>
            {(['x', 'y'] as const).map((axis) => {
              const label = `Vertex ${index + 1} ${axis.toUpperCase()}`
              return <label key={axis}>{label}<input key={`${primary.id}-vertex-${index}-${axis}-${vertex[axis]}`} type="number" min={-PROOFCANVAS_SCHEMA_LIMITS.normalizedShapeCoordinateMagnitude} max={PROOFCANVAS_SCHEMA_LIMITS.normalizedShapeCoordinateMagnitude} step="0.01" aria-label={label} defaultValue={vertex[axis]} onBlur={(event) => commitNumericInput(event, { key: axis, label, fallback: vertex[axis], min: -PROOFCANVAS_SCHEMA_LIMITS.normalizedShapeCoordinateMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.normalizedShapeCoordinateMagnitude }, vertex[axis], (value) => {
                const vertices = primaryShapeGeometry.vertices.map((candidate) => ({ ...candidate }))
                vertices[index][axis] = value
                return commitShapeSettings(primary.id, { kind: 'polygon', vertices, lineJoin: primaryShapeGeometry.lineJoin }, `Set vertex ${index + 1} ${axis.toUpperCase()}`)
              })}/></label>
            })}
            <button type="button" disabled={primaryShapeGeometry.vertices.length >= PROOFCANVAS_SCHEMA_LIMITS.shapePointsMax} onClick={() => {
              const vertices = primaryShapeGeometry.vertices.map((candidate) => ({ ...candidate }))
              const next = vertices[(index + 1) % vertices.length]
              vertices.splice(index + 1, 0, { x: (vertex.x + next.x) / 2, y: (vertex.y + next.y) / 2 })
              commitShapeSettings(primary.id, { kind: 'polygon', vertices, lineJoin: primaryShapeGeometry.lineJoin }, `Add vertex after ${index + 1}`)
            }}>Add after</button>
            <button type="button" disabled={primaryShapeGeometry.vertices.length <= 3} onClick={() => {
              if (primaryShapeGeometry.vertices.length <= 3) return setStatus('A polygon requires at least three vertices.')
              const vertices = primaryShapeGeometry.vertices.filter((_, candidateIndex) => candidateIndex !== index).map((candidate) => ({ ...candidate }))
              commitShapeSettings(primary.id, { kind: 'polygon', vertices, lineJoin: primaryShapeGeometry.lineJoin }, `Remove vertex ${index + 1}`)
            }}>Remove</button>
          </div>)}
        </div>
      </>}
      {primaryShapeGeometry.kind === 'line' && <label className="pc-wide">Line cap<select aria-label="Line cap" value={primaryShapeGeometry.lineCap} onChange={(event) => commitShapeSettings(primary.id, { kind: 'line', lineCap: event.target.value as ShapeLineCap }, 'Set line cap')}>{SHAPE_LINE_CAPS.map((cap) => <option key={cap} value={cap}>{cap}</option>)}</select></label>}
      {primaryShapeGeometry.kind === 'dashed-line' && <>
        <label className="pc-wide">Line cap<select aria-label="Dashed line cap" value={primaryShapeGeometry.lineCap} onChange={(event) => commitShapeSettings(primary.id, { kind: 'dashed-line', lineCap: event.target.value as ShapeLineCap, dashLength: primaryShapeGeometry.dashLength, gapLength: primaryShapeGeometry.gapLength }, 'Set dashed line cap')}>{SHAPE_LINE_CAPS.map((cap) => <option key={cap} value={cap}>{cap}</option>)}</select></label>
        {(['dashLength', 'gapLength'] as const).map((key) => {
          const label = key === 'dashLength' ? 'Dash length' : 'Gap length'
          const value = primaryShapeGeometry[key]
          return <label key={key}>{label}<input key={`${primary.id}-${key}-${value}`} type="number" min={PROOFCANVAS_SCHEMA_LIMITS.dashPatternLengthMin} max={PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax} step="0.1" aria-label={label} defaultValue={value} onBlur={(event) => commitNumericInput(event, { key, label, fallback: value, min: PROOFCANVAS_SCHEMA_LIMITS.dashPatternLengthMin, max: PROOFCANVAS_SCHEMA_LIMITS.animationDimensionMax }, value, (next) => commitShapeSettings(primary.id, { kind: 'dashed-line', lineCap: primaryShapeGeometry.lineCap, dashLength: key === 'dashLength' ? next : primaryShapeGeometry.dashLength, gapLength: key === 'gapLength' ? next : primaryShapeGeometry.gapLength }, `Set ${label.toLowerCase()}`))}/></label>
        })}
        <p className="pc-wide pc-inspector-note">Dash and gap stay bounded to at most 256 generated Manim dash objects.</p>
      </>}
      {primaryShapeGeometry.kind === 'arrow' && <>
        <label>Line cap<select aria-label="Line cap" value={primaryShapeGeometry.lineCap} onChange={(event) => commitShapeSettings(primary.id, { kind: 'arrow', lineCap: event.target.value as ShapeLineCap, tipShape: primaryShapeGeometry.tipShape, tipSizeRatio: primaryShapeGeometry.tipSizeRatio }, 'Set arrow line cap')}>{SHAPE_LINE_CAPS.map((cap) => <option key={cap} value={cap}>{cap}</option>)}</select></label>
        <label>Arrow tip<select aria-label="Arrow tip" value={primaryShapeGeometry.tipShape} onChange={(event) => commitShapeSettings(primary.id, { kind: 'arrow', lineCap: primaryShapeGeometry.lineCap, tipShape: event.target.value as ArrowTipShape, tipSizeRatio: primaryShapeGeometry.tipSizeRatio }, 'Set arrow tip')}>{ARROW_TIP_SHAPES.map((tip) => <option key={tip} value={tip}>{tip}</option>)}</select></label>
        <label className="pc-wide">Arrow tip size<input
          key={`${primary.id}-tip-size-${primaryShapeGeometry.tipSizeRatio}`}
          type="number"
          min={MIN_ARROW_TIP_SIZE_RATIO}
          max={MAX_ARROW_TIP_SIZE_RATIO}
          step="0.01"
          aria-label="Arrow tip size"
          defaultValue={primaryShapeGeometry.tipSizeRatio}
          onBlur={(event) => commitNumericInput(event, { key: 'tipSizeRatio', label: 'Arrow tip size', fallback: primaryShapeGeometry.tipSizeRatio, min: MIN_ARROW_TIP_SIZE_RATIO, max: MAX_ARROW_TIP_SIZE_RATIO }, primaryShapeGeometry.tipSizeRatio, (tipSizeRatio) => commitShapeSettings(primary.id, { kind: 'arrow', lineCap: primaryShapeGeometry.lineCap, tipShape: primaryShapeGeometry.tipShape, tipSizeRatio }, 'Set arrow tip size'))}
        /></label>
      </>}
      {primaryShapeGeometry.kind === 'double-arrow' && <>
        <label>Line cap<select aria-label="Double arrow line cap" value={primaryShapeGeometry.lineCap} onChange={(event) => commitShapeSettings(primary.id, { kind: 'double-arrow', lineCap: event.target.value as ShapeLineCap, startTipShape: primaryShapeGeometry.startTipShape, endTipShape: primaryShapeGeometry.endTipShape, tipSizeRatio: primaryShapeGeometry.tipSizeRatio }, 'Set double arrow line cap')}>{SHAPE_LINE_CAPS.map((cap) => <option key={cap} value={cap}>{cap}</option>)}</select></label>
        <label>Start arrow tip<select aria-label="Start arrow tip" value={primaryShapeGeometry.startTipShape} onChange={(event) => commitShapeSettings(primary.id, { kind: 'double-arrow', lineCap: primaryShapeGeometry.lineCap, startTipShape: event.target.value as ArrowTipShape, endTipShape: primaryShapeGeometry.endTipShape, tipSizeRatio: primaryShapeGeometry.tipSizeRatio }, 'Set start arrow tip')}>{ARROW_TIP_SHAPES.map((tip) => <option key={tip} value={tip}>{tip}</option>)}</select></label>
        <label>End arrow tip<select aria-label="End arrow tip" value={primaryShapeGeometry.endTipShape} onChange={(event) => commitShapeSettings(primary.id, { kind: 'double-arrow', lineCap: primaryShapeGeometry.lineCap, startTipShape: primaryShapeGeometry.startTipShape, endTipShape: event.target.value as ArrowTipShape, tipSizeRatio: primaryShapeGeometry.tipSizeRatio }, 'Set end arrow tip')}>{ARROW_TIP_SHAPES.map((tip) => <option key={tip} value={tip}>{tip}</option>)}</select></label>
        <label>Arrow tip size<input key={`${primary.id}-double-tip-size-${primaryShapeGeometry.tipSizeRatio}`} type="number" min={MIN_ARROW_TIP_SIZE_RATIO} max={MAX_ARROW_TIP_SIZE_RATIO} step="0.01" aria-label="Double arrow tip size" defaultValue={primaryShapeGeometry.tipSizeRatio} onBlur={(event) => commitNumericInput(event, { key: 'tipSizeRatio', label: 'Double arrow tip size', fallback: primaryShapeGeometry.tipSizeRatio, min: MIN_ARROW_TIP_SIZE_RATIO, max: MAX_ARROW_TIP_SIZE_RATIO }, primaryShapeGeometry.tipSizeRatio, (tipSizeRatio) => commitShapeSettings(primary.id, { kind: 'double-arrow', lineCap: primaryShapeGeometry.lineCap, startTipShape: primaryShapeGeometry.startTipShape, endTipShape: primaryShapeGeometry.endTipShape, tipSizeRatio }, 'Set double arrow tip size'))}/></label>
      </>}
      {primaryShapeGeometry.kind === 'brace' && <>
        <label>Brace direction<select aria-label="Brace direction" value={primaryShapeGeometry.direction} onChange={(event) => commitBraceDirection(event.target.value as BraceDirection)}>{BRACE_DIRECTIONS.map((direction) => <option key={direction} value={direction}>{direction}</option>)}</select></label>
        <label>Brace spacing<input
          key={`${primary.id}-brace-spacing-${primaryShapeGeometry.spacing}`}
          type="number"
          min={0}
          max={PROOFCANVAS_SCHEMA_LIMITS.spacingMax}
          step="0.1"
          aria-label="Brace spacing"
          defaultValue={primaryShapeGeometry.spacing}
          onBlur={(event) => commitNumericInput(event, { key: 'spacing', label: 'Brace spacing', fallback: primaryShapeGeometry.spacing, min: 0, max: PROOFCANVAS_SCHEMA_LIMITS.spacingMax }, primaryShapeGeometry.spacing, (spacing) => commitShapeSettings(primary.id, { kind: 'brace', direction: primaryShapeGeometry.direction, spacing }, 'Set brace spacing'))}
        /></label>
        {primaryBraceAxisAuthority && <p className="pc-wide pc-inspector-note" role="status">Brace axis changes are unavailable while an object or ancestor dimension, rotation, or scale track owns this geometry.</p>}
      </>}
      {primaryShapeGeometry.kind === 'freeform-path' && <>
        <label className="pc-check pc-wide"><input type="checkbox" aria-label="Closed freeform path" checked={primaryShapeGeometry.closed} onChange={(event) => {
          if (event.target.checked && primaryShapeGeometry.nodes.length < 3) return setStatus('A closed freeform path requires at least three nodes.')
          const nodes = primaryShapeGeometry.nodes.map((node) => ({ ...node, point: { ...node.point }, ...(node.inHandle ? { inHandle: { ...node.inHandle } } : {}), ...(node.outHandle ? { outHandle: { ...node.outHandle } } : {}) }))
          if (event.target.checked) return commitShapeSettings(primary.id, { kind: 'freeform-path', closed: true, nodes, lineJoin: primaryShapeGeometry.lineJoin }, 'Close freeform path')
          if (nodes[0]?.inHandle) delete nodes[0].inHandle
          if (nodes.at(-1)?.outHandle) delete nodes.at(-1)!.outHandle
          return commitShapeSettings(primary.id, { kind: 'freeform-path', closed: false, nodes, lineCap: 'butt', lineJoin: primaryShapeGeometry.lineJoin }, 'Open freeform path')
        }}/>Closed path</label>
        {!primaryShapeGeometry.closed && <label>Line cap<select aria-label="Freeform line cap" value={primaryShapeGeometry.lineCap} onChange={(event) => commitShapeSettings(primary.id, { kind: 'freeform-path', closed: false, nodes: primaryShapeGeometry.nodes.map((node) => ({ ...node })), lineCap: event.target.value as ShapeLineCap, lineJoin: primaryShapeGeometry.lineJoin }, 'Set freeform line cap')}>{SHAPE_LINE_CAPS.map((cap) => <option key={cap} value={cap}>{cap}</option>)}</select></label>}
        <label>Line join<select aria-label="Freeform line join" value={primaryShapeGeometry.lineJoin} onChange={(event) => {
          const nodes = primaryShapeGeometry.nodes.map((node) => ({ ...node }))
          const lineJoin = event.target.value as ShapeLineJoin
          return primaryShapeGeometry.closed
            ? commitShapeSettings(primary.id, { kind: 'freeform-path', closed: true, nodes, lineJoin }, 'Set freeform line join')
            : commitShapeSettings(primary.id, { kind: 'freeform-path', closed: false, nodes, lineCap: primaryShapeGeometry.lineCap, lineJoin }, 'Set freeform line join')
        }}>{SHAPE_LINE_JOINS.map((join) => <option key={join} value={join}>{join}</option>)}</select></label>
        <div className="pc-wide pc-shape-point-list">
          <h3>Nodes and cubic handles</h3>
          <p className="pc-inspector-note">Nodes and handles use exact normalized coordinates from −0.5 to 0.5.</p>
          {primaryShapeGeometry.nodes.map((node, index) => {
            const commitNodes = (nodes: FreeformShapeNode[], label: string) => primaryShapeGeometry.closed
              ? commitShapeSettings(primary.id, { kind: 'freeform-path', closed: true, nodes, lineJoin: primaryShapeGeometry.lineJoin }, label)
              : commitShapeSettings(primary.id, { kind: 'freeform-path', closed: false, nodes, lineCap: primaryShapeGeometry.lineCap, lineJoin: primaryShapeGeometry.lineJoin }, label)
            const coordinateInput = (kind: 'point' | 'inHandle' | 'outHandle', axis: 'x' | 'y', value: number, label: string) => <label key={`${kind}-${axis}`}>{label}<input key={`${primary.id}-node-${index}-${kind}-${axis}-${value}`} type="number" min={-PROOFCANVAS_SCHEMA_LIMITS.normalizedShapeCoordinateMagnitude} max={PROOFCANVAS_SCHEMA_LIMITS.normalizedShapeCoordinateMagnitude} step="0.01" aria-label={label} defaultValue={value} onBlur={(event) => commitNumericInput(event, { key: axis, label, fallback: value, min: -PROOFCANVAS_SCHEMA_LIMITS.normalizedShapeCoordinateMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.normalizedShapeCoordinateMagnitude }, value, (next) => {
              const nodes = primaryShapeGeometry.nodes.map((candidate) => ({ ...candidate, point: { ...candidate.point }, ...(candidate.inHandle ? { inHandle: { ...candidate.inHandle } } : {}), ...(candidate.outHandle ? { outHandle: { ...candidate.outHandle } } : {}) }))
              if (kind === 'point') nodes[index].point[axis] = next
              else (nodes[index][kind] as NormalizedShapePoint)[axis] = next
              return commitNodes(nodes, `Set node ${index + 1} ${label}`)
            })}/></label>
            const canIncoming = primaryShapeGeometry.closed || index > 0
            const canOutgoing = primaryShapeGeometry.closed || index < primaryShapeGeometry.nodes.length - 1
            return <div className="pc-shape-point" key={`${primary.id}-node-${index}`}>
              <strong>Node {index + 1}</strong>
              {(['x', 'y'] as const).map((axis) => coordinateInput('point', axis, node.point[axis], `Node ${index + 1} ${axis.toUpperCase()}`))}
              {node.inHandle && canIncoming ? (['x', 'y'] as const).map((axis) => coordinateInput('inHandle', axis, node.inHandle![axis], `Node ${index + 1} incoming handle ${axis.toUpperCase()}`)) : canIncoming && <button type="button" onClick={() => {
                const nodes = primaryShapeGeometry.nodes.map((candidate) => ({ ...candidate }))
                const previous = nodes[(index - 1 + nodes.length) % nodes.length].point
                nodes[index] = { ...nodes[index], inHandle: { x: node.point.x + (previous.x - node.point.x) / 3, y: node.point.y + (previous.y - node.point.y) / 3 } }
                commitNodes(nodes, `Add incoming handle to node ${index + 1}`)
              }}>Add incoming handle</button>}
              {node.inHandle && canIncoming && <button type="button" onClick={() => { const nodes = primaryShapeGeometry.nodes.map((candidate) => ({ ...candidate })); delete nodes[index].inHandle; commitNodes(nodes, `Remove incoming handle from node ${index + 1}`) }}>Remove incoming handle</button>}
              {node.outHandle && canOutgoing ? (['x', 'y'] as const).map((axis) => coordinateInput('outHandle', axis, node.outHandle![axis], `Node ${index + 1} outgoing handle ${axis.toUpperCase()}`)) : canOutgoing && <button type="button" onClick={() => {
                const nodes = primaryShapeGeometry.nodes.map((candidate) => ({ ...candidate }))
                const next = nodes[(index + 1) % nodes.length].point
                nodes[index] = { ...nodes[index], outHandle: { x: node.point.x + (next.x - node.point.x) / 3, y: node.point.y + (next.y - node.point.y) / 3 } }
                commitNodes(nodes, `Add outgoing handle to node ${index + 1}`)
              }}>Add outgoing handle</button>}
              {node.outHandle && canOutgoing && <button type="button" onClick={() => { const nodes = primaryShapeGeometry.nodes.map((candidate) => ({ ...candidate })); delete nodes[index].outHandle; commitNodes(nodes, `Remove outgoing handle from node ${index + 1}`) }}>Remove outgoing handle</button>}
              <button type="button" disabled={primaryShapeGeometry.nodes.length >= PROOFCANVAS_SCHEMA_LIMITS.shapePointsMax} onClick={() => {
                const nodes = primaryShapeGeometry.nodes.map((candidate) => ({ ...candidate }))
                const next = nodes[(index + 1) % nodes.length].point
                nodes.splice(index + 1, 0, { point: { x: (node.point.x + next.x) / 2, y: (node.point.y + next.y) / 2 } })
                commitNodes(nodes, `Add node after ${index + 1}`)
              }}>Add node after</button>
              <button type="button" disabled={primaryShapeGeometry.nodes.length <= (primaryShapeGeometry.closed ? 3 : 2)} onClick={() => {
                const minimum = primaryShapeGeometry.closed ? 3 : 2
                if (primaryShapeGeometry.nodes.length <= minimum) return setStatus(`${primaryShapeGeometry.closed ? 'A closed' : 'An open'} freeform path requires at least ${minimum} nodes.`)
                const nodes = primaryShapeGeometry.nodes.filter((_, candidateIndex) => candidateIndex !== index).map((candidate) => ({ ...candidate }))
                if (!primaryShapeGeometry.closed) {
                  if (nodes[0]?.inHandle) delete nodes[0].inHandle
                  if (nodes.at(-1)?.outHandle) delete nodes.at(-1)!.outHandle
                }
                commitNodes(nodes, `Remove node ${index + 1}`)
              }}>Remove node</button>
            </div>
          })}
        </div>
      </>}
      {isLinearShapeType(primaryShapeGeometry.kind) && primaryLineEndpoints && <>
        <h3 className="pc-wide">Authored endpoints</h3>
        {(['start', 'end'] as const).flatMap((endpoint) => (['x', 'y'] as const).map((axis) => {
          const value = primaryLineEndpoints[endpoint][axis]
          const label = `${endpoint === 'start' ? 'Start' : 'End'} ${axis.toUpperCase()}`
          return <label key={`${endpoint}-${axis}`}>{label}<input
            key={`${primary.id}-${endpoint}-${axis}-${value}`}
            type="number"
            step="any"
            aria-label={label}
            defaultValue={value}
            disabled={primaryEndpointAuthority}
            onBlur={(event) => commitEndpointInput(event, endpoint, axis, value)}
          /></label>
        }))}
        {primaryEndpointAuthority && <p className="pc-wide pc-inspector-note" role="status">Endpoint editing is unavailable while an object or ancestor position, width, rotation, or scale track owns this line.</p>}
      </>}
    </fieldset>
  }

  return (
    <div className="proofcanvas-app" role="application" aria-label="ProofCanvas editor" aria-busy={leavePending} data-testid="proofcanvas-editor" data-pc-editor data-project-id={project.metadata.id} data-schema-version={project.schemaVersion} data-active-shot-id={shot.id} data-selection-kind={selection.kind} data-history-past-count={history.past.length} data-history-future-count={history.future.length} data-durable={durableProject ? 'true' : 'false'} data-server-revision={durableProject ? serverRevision : undefined} data-save-state={durableProject ? saveState : undefined} data-left-collapsed={leftPanelCollapsed ? 'true' : 'false'} data-right-collapsed={rightPanelCollapsed ? 'true' : 'false'} data-timeline-collapsed={timelineCollapsed ? 'true' : 'false'} style={{ '--pc-left-width': leftPanelCollapsed ? '0px' : `${leftPanelWidth}px`, '--pc-right-width': rightPanelCollapsed ? '0px' : `${rightPanelWidth}px`, '--pc-timeline-height': timelineCollapsed ? '150px' : `${timelineHeight}px` } as CSSProperties}>
      <div className="pc-desktop-notice" aria-label="Desktop viewport required"><strong>A wider workspace is required</strong><span>ProofCanvas is a desktop editor. Use a viewport at least 1024 px wide; your project remains safely autosaved.</span></div>
      <header className="pc-header" role="group" aria-label="Project actions">
        <a href="/" className="pc-back-link" aria-label="Back to projects" aria-disabled={leavePending} onClick={(event) => { event.preventDefault(); void guardedLeave('/') }}>←</a>
        <div className="pc-wordmark"><span aria-hidden="true">∴</span><h1>ProofCanvas</h1></div>
        <label className="pc-project-title"><span className="pc-visually-hidden">Project title</span><input aria-label="Project title" key={`${project.metadata.id}-${project.metadata.title}`} defaultValue={project.metadata.title} maxLength={160} disabled={isPlaying} onFocus={selectProjectContext} onBlur={(event) => commitTextInput(event, project.metadata.title, 'Project title', renameProject, { trim: true, required: true })}/>{durableProject ? <small role="status" aria-label="Autosave status" data-save-state={saveState}>{saveState === 'saved' ? `Saved · r${serverRevision}` : saveState === 'waiting' ? 'Autosave queued' : saveState === 'saving' ? 'Saving…' : saveState === 'conflict' ? 'Save conflict' : saveState === 'reconcile' ? 'Reload required' : saveState === 'blocked' ? 'Autosave blocked' : 'Offline · retry'}</small> : <small role="status" aria-label="Autosave status">Local project</small>}</label>
        <div className="pc-history-actions">
          <button type="button" onClick={() => commandController.execute('undo')} disabled={isPlaying || !canUndo(history)} aria-label="Undo" title="Undo · Ctrl/Cmd Z">↶</button>
          <button type="button" onClick={() => commandController.execute('redo')} disabled={isPlaying || !canRedo(history)} aria-label="Redo" title="Redo · Ctrl/Cmd Shift Z">↷</button>
        </div>
        <label className="pc-quality">Preview<span className="pc-visually-hidden"> quality</span><select aria-label="Preview quality" value={project.settings.previewQuality} disabled={isPlaying} onChange={(event) => updateProjectSettings({ previewQuality: event.target.value as ProjectDocument['settings']['previewQuality'] })}><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select></label>
        <div className="pc-top-actions">
          <button type="button" onClick={() => { selectProjectContext(); openUtilityDialog('settings') }} aria-label="Project settings">Settings</button>
          <button type="button" onClick={() => openUtilityDialog('shortcuts')} aria-label="Keyboard shortcuts">Shortcuts</button>
          <button ref={commandButtonRef} type="button" onClick={() => commandController.execute('open-command-palette')} aria-label="Open command palette" title="Command palette · Ctrl/Cmd K">Commands</button>
          <button type="button" className="pc-primary" onClick={() => commandController.execute('open-render-export')} aria-label="Render or export">Render / export</button>
          <details ref={ownerMenuRef} className="pc-owner-menu" open={ownerMenuOpen}><summary ref={ownerMenuTriggerRef} aria-label="Owner menu" aria-expanded={ownerMenuOpen} onClick={(event) => { event.preventDefault(); setOwnerMenuOpen((value) => !value) }}><span aria-hidden="true">LW</span><b>Owner</b></summary><div aria-label="Owner and project actions"><p><strong>{durableProject ? 'Private owner workspace' : 'Local demonstration'}</strong><span>{durableProject ? `Project revision ${serverRevision}` : 'Browser-only save'}</span></p><button type="button" onClick={() => { setOwnerMenuOpen(false); saveProject() }} aria-label="Save project">Save now</button>{durableProject ? <><button type="button" onClick={() => { setOwnerMenuOpen(false); void createCheckpoint() }} disabled={checkpointPending || saveState === 'conflict'} aria-label="Create checkpoint">Create checkpoint</button><button type="button" onClick={() => { setOwnerMenuOpen(false); loadProject() }} disabled={checkpointPending} aria-label="Open project recovery">Project recovery</button></> : <button type="button" onClick={() => { setOwnerMenuOpen(false); loadProject() }} aria-label="Load saved project">Load local project</button>}<label className="pc-file-label">Import project…<input type="file" accept="application/json,.json" onChange={(event) => { setOwnerMenuOpen(false); void importJson(event) }} aria-label="Import project JSON" /></label><button type="button" onClick={() => { setOwnerMenuOpen(false); resetDemo() }}>Reset sample project</button>{durableProject && <button type="button" onClick={() => void logoutOwner()} disabled={leavePending}>Log out</button>}</div></details>
        </div>
      </header>

      <button type="button" role="separator" aria-label="Resize library panel" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={MAX_LEFT_PANEL} aria-valuenow={leftPanelCollapsed ? 0 : leftPanelWidth} aria-valuetext={leftPanelCollapsed ? 'Collapsed' : `${leftPanelWidth} pixels`} className="pc-panel-resizer pc-panel-resizer-left" onPointerDown={(event) => { setLeftPanelCollapsed(false); setPanelResize({ kind: 'left', start: event.clientX, initial: leftPanelWidth }) }} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setLeftPanelCollapsed(false); setLeftPanelWidth((value) => Math.max(MIN_LEFT_PANEL, Math.min(MAX_LEFT_PANEL, value + (event.key === 'ArrowRight' ? 12 : -12)))) } }}><span className="pc-visually-hidden">Resize library panel</span></button>
      <button type="button" role="separator" aria-label="Resize inspector panel" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={MAX_RIGHT_PANEL} aria-valuenow={rightPanelCollapsed ? 0 : rightPanelWidth} aria-valuetext={rightPanelCollapsed ? 'Collapsed' : `${rightPanelWidth} pixels`} className="pc-panel-resizer pc-panel-resizer-right" onPointerDown={(event) => { setRightPanelCollapsed(false); setPanelResize({ kind: 'right', start: event.clientX, initial: rightPanelWidth }) }} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setRightPanelCollapsed(false); setRightPanelWidth((value) => Math.max(MIN_RIGHT_PANEL, Math.min(MAX_RIGHT_PANEL, value + (event.key === 'ArrowLeft' ? 12 : -12)))) } }}><span className="pc-visually-hidden">Resize inspector panel</span></button>
      <button type="button" role="separator" aria-label="Resize timeline" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={MAX_TIMELINE_HEIGHT} aria-valuenow={timelineCollapsed ? 0 : timelineHeight} aria-valuetext={timelineCollapsed ? 'Collapsed' : `${timelineHeight} pixels`} className="pc-panel-resizer pc-panel-resizer-timeline" onPointerDown={(event) => { setTimelineCollapsed(false); setPanelResize({ kind: 'timeline', start: event.clientY, initial: timelineHeight }) }} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setTimelineCollapsed(false); setTimelineHeight((value) => Math.max(MIN_TIMELINE_HEIGHT, Math.min(MAX_TIMELINE_HEIGHT, value + (event.key === 'ArrowUp' ? 16 : -16)))) } }}><span className="pc-visually-hidden">Resize timeline</span></button>

      <aside className="pc-left" aria-label="Object and layer library">
        <section className="pc-library-section"><div className="pc-section-heading"><div><span>Insert</span><h2>Library</h2></div><button type="button" onClick={() => setLeftPanelCollapsed(true)} aria-label="Collapse library panel">‹</button></div><div role="tablist" aria-label="Insert library" className="pc-library-tabs">{LIBRARY_TABS.map((tab) => <button type="button" role="tab" key={tab} aria-selected={libraryTab === tab} tabIndex={libraryTab === tab ? 0 : -1} data-library-tab={tab} onKeyDown={(event) => selectLibraryTab(event, tab)} onClick={() => { setLibraryTab(tab); setLibrarySearch('') }}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}</div>
          {libraryTab !== 'styles' && <label className="pc-library-search"><span className="pc-visually-hidden">Search library</span><input type="search" aria-label="Search library" placeholder={`Search ${libraryTab}`} value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)}/><span aria-hidden="true">⌕</span></label>}
          {(['text', 'math', 'graphs'] as LibraryTab[]).includes(libraryTab) && <div className="pc-insert-grid">{visibleObjectTypes.map(({ type, label }) => <button key={type} type="button" onClick={() => insertObject(type)} disabled={isPlaying} aria-label={`Add ${label}`} data-object-type={type}><span aria-hidden="true">{type === 'text' ? 'T' : type === 'math' ? '∑' : type === 'brace' ? '⏟' : type === 'axes' ? '⌗' : 'ƒ'}</span><b>{label}</b></button>)}{visibleObjectTypes.length === 0 && <p className="pc-library-empty" role="status">No {libraryTab} items match “{librarySearch}”.</p>}</div>}
          {libraryTab === 'shapes' && <div className="pc-shape-preset-grid" data-shape-preset-count={SHAPE_PRESETS.length}>{visibleShapePresets.map((preset) => <button
            key={preset.id}
            type="button"
            className="pc-shape-preset-card"
            draggable={!isPlaying}
            disabled={isPlaying}
            aria-label={`Insert ${preset.name}`}
            title={`${preset.name} — ${preset.description}`}
            data-shape-preset-id={preset.id}
            data-shape-preset-composition={preset.composition}
            data-dragging={draggedShapePresetId === preset.id ? 'true' : 'false'}
            onClick={() => insertShapePresetAt(preset.id)}
            onDragStart={(event) => {
              if (authorityRef.current.isPlaying || !shapePresetById(preset.id)) {
                event.preventDefault()
                setStatus('Pause sequence playback before dragging a shape.')
                return
              }
              event.dataTransfer.effectAllowed = 'copy'
              event.dataTransfer.setData(PROOFCANVAS_SHAPE_PRESET_MIME, preset.id)
              setDraggedShapePresetId(preset.id)
            }}
            onDragEnd={() => setDraggedShapePresetId(null)}
          ><span aria-hidden="true">{SHAPE_PRESET_ICONS[preset.id]}</span><b>{preset.name}</b><small>{preset.description}</small></button>)}{visibleShapePresets.length === 0 && <p className="pc-library-empty" role="status">No shapes match “{librarySearch}”.</p>}</div>}
          {libraryTab === 'components' && <div className="pc-component-list">{visibleComponents.map((component) => { const labels: Record<SemanticComponentId, string> = { 'mathematical-title': 'Insert mathematical title', 'proposition-statement': 'Insert proposition or definition', 'equation-chain': 'Insert equation chain', 'annotated-diagram': 'Insert annotated diagram', 'focus-callout': 'Insert focus callout', 'recursive-intervals': 'Insert recursive interval construction' }; return <button key={component.id} type="button" onClick={() => insertComponent(component.id)} disabled={isPlaying} title={component.description} aria-label={labels[component.id]} data-component-id={component.id}><b>{component.name}</b><small>{component.description}</small></button> })}{visibleComponents.length === 0 && <p className="pc-library-empty" role="status">No components match “{librarySearch}”.</p>}</div>}
          {libraryTab === 'styles' && <div className="pc-style-library" role="radiogroup" aria-label="Library output styles"><button type="button" role="radio" aria-checked={project.activeStyleId === EDITORIAL_INK_STYLE_ID} tabIndex={project.activeStyleId === EDITORIAL_INK_STYLE_ID ? 0 : -1} disabled={isPlaying} data-style-surface="library" data-style-id={EDITORIAL_INK_STYLE_ID} onKeyDown={(event) => navigateStyleRadios(event, EDITORIAL_INK_STYLE_ID, 'library')} onClick={() => selectOutputStyle(EDITORIAL_INK_STYLE_ID, 'Editorial Ink')}><i data-style-swatch="editorial"/><span><b>Editorial Ink</b><small>Warm restrained proof-film system</small></span></button><button type="button" role="radio" aria-checked={project.activeStyleId === RAW_MANIM_STYLE_ID} tabIndex={project.activeStyleId === RAW_MANIM_STYLE_ID ? 0 : -1} disabled={isPlaying} data-style-surface="library" data-style-id={RAW_MANIM_STYLE_ID} onKeyDown={(event) => navigateStyleRadios(event, RAW_MANIM_STYLE_ID, 'library')} onClick={() => selectOutputStyle(RAW_MANIM_STYLE_ID, 'Raw Manim')}><i data-style-swatch="raw"/><span><b>Raw Manim</b><small>Direct geometric defaults</small></span></button></div>}
        </section>
        <section className="pc-layer-section"><div className="pc-section-heading"><h2>Layers</h2><span>{shot.objects.length}</span></div>
          <div className="pc-layer-actions" aria-label="Layer actions">
            <button type="button" onClick={() => commandController.execute('duplicate-selection')} disabled={isPlaying || !selectedRootIds.length} aria-label="Duplicate selection">Duplicate</button><button type="button" onClick={() => commandController.execute('delete-selection')} disabled={isPlaying || !selectedRootIds.length} aria-label="Delete selection">Delete</button><button type="button" onClick={() => commandController.execute('group-selection')} disabled={isPlaying || selectedRootIds.length < 2} aria-label="Group selection">Group</button><button type="button" onClick={() => commandController.execute('ungroup-selection')} disabled={isPlaying || !selectedObjects.some(({ type }) => type === 'group')} aria-label="Ungroup selection">Ungroup</button>
            <button type="button" onClick={() => reorderLayer('front')} disabled={isPlaying || !primary || primarySiblingIndex >= primarySiblings.length - 1} aria-label="Bring to front">To front</button><button type="button" onClick={() => reorderLayer('forward')} disabled={isPlaying || !primary || primarySiblingIndex >= primarySiblings.length - 1} aria-label="Bring forward">Forward</button><button type="button" onClick={() => reorderLayer('backward')} disabled={isPlaying || !primary || primarySiblingIndex <= 0} aria-label="Send backward">Backward</button><button type="button" onClick={() => reorderLayer('back')} disabled={isPlaying || !primary || primarySiblingIndex <= 0} aria-label="Send to back">To back</button>
          </div>
          <div role="tree" aria-label="Objects" aria-multiselectable="true" className="pc-layer-tree">{shot.objects.map((object, index) => { const effectivelyLocked = Boolean(effectiveLockOwner(shot, object)); const visibilityOwner = effectiveVisibilityOwner(shot, object); const visibilityLabel = !visibilityOwner ? 'Visible' : visibilityOwner.id === object.id ? 'Hidden' : `Hidden by ${visibilityOwner.name}`; const lockLabel = effectivelyLocked ? object.locked ? '; Locked' : '; Locked by parent' : ''; return <button key={object.id} type="button" role="treeitem" aria-label={`${object.name}; ${visibilityLabel}${lockLabel}`} aria-selected={selectedRootIds.includes(object.id)} aria-level={descendants(shot, object.id) + 1} tabIndex={selectedRootIds.at(-1) === object.id || (!selectedRootIds.length && index === 0) ? 0 : -1} onKeyDown={(event) => navigateLayerTree(event, index)} onClick={(event) => setSelectedIds(selectionRootIds(shot, event.shiftKey ? selectedRootIds.includes(object.id) ? selectedRootIds.filter((id) => id !== object.id) : [...selectedRootIds, object.id] : [object.id]))} style={{ paddingLeft: 10 + descendants(shot, object.id) * 14 }} data-layer-object-id={object.id} data-locked={effectivelyLocked} data-visibility={visibilityOwner ? visibilityOwner.id === object.id ? 'hidden' : 'inherited-hidden' : 'visible'}><span aria-hidden="true">{visibilityOwner ? visibilityOwner.id === object.id ? '○' : '⊘' : '◉'}</span><span>{object.name}</span>{effectivelyLocked && <span aria-hidden="true">⌑</span>}</button> })}</div>
        </section>
      </aside>

      <section className="pc-canvas-area" aria-label="Canvas workspace">
        <div className="pc-canvas-toolbar">
          <div className="pc-panel-toggles"><button type="button" onClick={() => setLeftPanelCollapsed((value) => !value)} aria-pressed={!leftPanelCollapsed} aria-label={leftPanelCollapsed ? 'Show library panel' : 'Hide library panel'}>Library</button><span>{project.settings.aspectRatio} · {project.settings.resolution.width}×{project.settings.resolution.height}</span></div>
          <div role="radiogroup" aria-label="Active output style" className="pc-canvas-style">
            <label><input type="radio" name="preview-style" value={EDITORIAL_INK_STYLE_ID} checked={project.activeStyleId === EDITORIAL_INK_STYLE_ID} tabIndex={project.activeStyleId === EDITORIAL_INK_STYLE_ID ? 0 : -1} disabled={isPlaying} data-style-surface="canvas" data-style-id={EDITORIAL_INK_STYLE_ID} onKeyDown={(event) => navigateStyleRadios(event, EDITORIAL_INK_STYLE_ID, 'canvas')} onChange={() => selectOutputStyle(EDITORIAL_INK_STYLE_ID, 'Editorial Ink')}/>Editorial Ink</label>
            <label><input type="radio" name="preview-style" value={RAW_MANIM_STYLE_ID} checked={project.activeStyleId === RAW_MANIM_STYLE_ID} tabIndex={project.activeStyleId === RAW_MANIM_STYLE_ID ? 0 : -1} disabled={isPlaying} data-style-surface="canvas" data-style-id={RAW_MANIM_STYLE_ID} onKeyDown={(event) => navigateStyleRadios(event, RAW_MANIM_STYLE_ID, 'canvas')} onChange={() => selectOutputStyle(RAW_MANIM_STYLE_ID, 'Raw Manim')}/>Raw Manim</label>
          </div>
          <div className="pc-align-actions" aria-label="Alignment actions">
            {(['left','center-x','right','top','center-y','bottom'] as const).map((value) => { const labels = { left: 'Align left', 'center-x': 'Align horizontal centres', right: 'Align right', top: 'Align top', 'center-y': 'Align vertical centres', bottom: 'Align bottom' }; return <button type="button" key={value} onClick={() => align(value)} disabled={isPlaying || selectedRootIds.length < 2} aria-label={labels[value]}>{value.replace('center-', 'mid ')}</button> })}
            <button type="button" onClick={() => distribute('horizontal')} disabled={isPlaying || selectedRootIds.length < 3} aria-label="Distribute horizontally">Distribute H</button><button type="button" onClick={() => distribute('vertical')} disabled={isPlaying || selectedRootIds.length < 3} aria-label="Distribute vertically">Distribute V</button>
          </div>
          <button type="button" onClick={() => setRightPanelCollapsed((value) => !value)} aria-pressed={!rightPanelCollapsed} aria-label={rightPanelCollapsed ? 'Show inspector panel' : 'Hide inspector panel'}>Inspector</button>
        </div>
        <IsolatedCanvasStage clock={playbackClockRef.current} isPlaying={isPlaying} pausedPlayhead={playhead} previewStyleId={previewStyle.id} project={project} projectRevision={projectRevision} shot={shot} previewStyle={previewStyle} previewQuality={project.settings.previewQuality} selectedIds={selectedRootIds} authoringEnabled={!isPlaying} onSelect={(ids) => setSelectedIds(selectionRootIds(shot, ids))} onNotice={setStatus} onCommitTransforms={(updates, label) => commitOps(updates.map(({ objectId, transform }) => ({ type: 'update-object', objectId, patch: { transform } })), label)} onCommitKeyboardTransform={commitCanvasKeyboardTransform} onInsertShapePresetAt={insertShapePresetAt}/>
        <p className="pc-status" role="status" aria-label="Editor status">{status}</p>
      </section>

      <aside className="pc-right" aria-label="Inspector and intelligence tools">
        <header className="pc-inspector-context"><div><span>{selection.kind === 'objects' ? primary?.type === 'group' ? 'Group' : selectedObjects.length > 1 ? `${selectedObjects.length} objects` : 'Object' : selection.kind === 'animation' ? 'Animation' : selection.kind === 'keyframes' ? 'Keyframe' : selection.kind === 'project' ? 'Project' : 'Shot'}</span><h2>{primary?.name ?? selectedAnimation?.type ?? (selection.kind === 'project' ? project.metadata.title : shot.name)}</h2></div><button type="button" onClick={() => setRightPanelCollapsed(true)} aria-label="Collapse inspector panel">›</button></header>
        {primary && <form className="pc-inspector" aria-label={primary.type === 'group' ? 'Group inspector' : 'Object inspector'} data-inspector-object-id={primary.id} onSubmit={(event) => event.preventDefault()}><div className="pc-section-heading"><h2>{primary.type === 'group' ? 'Group properties' : 'Object properties'}</h2><button type="button" onClick={toggleLock} disabled={isPlaying || primaryInheritedLocked}>{primaryInheritedLocked ? 'Locked by parent' : primary.locked ? 'Unlock' : 'Lock'}</button></div>
          <fieldset className="pc-lifetime-inspector" disabled={isPlaying || primaryFamilyLocked}>
            <legend>Object lifetime</legend>
            <label><input type="radio" name={`lifetime-mode-${primary.id}`} checked={!primary.lifetime} onChange={() => commitRenderedTimelineIntent(resolveSetObjectLifetime(project, shot.id, { objectId: primary.id, mode: 'entire' }))}/>{primary.parentId ? 'Entire inherited range' : 'Entire shot'}</label>
            <label><input type="radio" name={`lifetime-mode-${primary.id}`} checked={Boolean(primary.lifetime)} onChange={() => primaryInheritedLifetime && commitRenderedTimelineIntent(resolveSetObjectLifetime(project, shot.id, { objectId: primary.id, mode: 'set', start: primaryInheritedLifetime.start, end: primaryInheritedLifetime.end }))}/>Custom</label>
            <div className="pc-lifetime-inputs">
              <label>Start<input key={`${primary.id}-lifetime-start-${primaryEffectiveLifetime?.start}-${lifetimeInputRevision}`} type="number" min={primaryInheritedLifetime?.start ?? 0} max={primaryEffectiveLifetime?.end ?? shot.duration} step="any" aria-label="Object lifetime start" defaultValue={primaryEffectiveLifetime?.start ?? 0} disabled={!primary.lifetime || isPlaying || primaryFamilyLocked} onBlur={(event) => { const input = event.currentTarget; const start = Number(input.value); if (primaryEffectiveLifetime && (!Number.isFinite(start) || !commitRenderedTimelineIntent(resolveSetObjectLifetime(project, shot.id, { objectId: primary.id, mode: 'set', start, end: primaryEffectiveLifetime.end })))) { input.value = String(primaryEffectiveLifetime.start); setLifetimeInputRevision((value) => value + 1) } }}/></label>
              <label>End<input key={`${primary.id}-lifetime-end-${primaryEffectiveLifetime?.end}-${lifetimeInputRevision}`} type="number" min={primaryEffectiveLifetime?.start ?? 0} max={primaryInheritedLifetime?.end ?? shot.duration} step="any" aria-label="Object lifetime end" defaultValue={primaryEffectiveLifetime?.end ?? shot.duration} disabled={!primary.lifetime || isPlaying || primaryFamilyLocked} onBlur={(event) => { const input = event.currentTarget; const end = Number(input.value); if (primaryEffectiveLifetime && (!Number.isFinite(end) || !commitRenderedTimelineIntent(resolveSetObjectLifetime(project, shot.id, { objectId: primary.id, mode: 'set', start: primaryEffectiveLifetime.start, end })))) { input.value = String(primaryEffectiveLifetime.end); setLifetimeInputRevision((value) => value + 1) } }}/></label>
            </div>
            <p>Effective range {primaryEffectiveLifetime?.start.toFixed(4)}s–{primaryEffectiveLifetime?.end.toFixed(4)}s.{primary.parentId ? ` Inherited bounds are ${primaryInheritedLifetime?.start.toFixed(4)}s–${primaryInheritedLifetime?.end.toFixed(4)}s and remain read-only.` : ' Entire shot follows the shot duration.'}</p>
          </fieldset>
          <div className="pc-field-grid"><p className="pc-wide pc-inspector-note">Diamonds author schema-v4 property keys. Once a track exists, field edits upsert at the playhead instead of changing the base pose.</p>
            {primary.type === 'group' && primaryFamilyLocked && !primaryEffectivelyLocked && <p className="pc-wide pc-inspector-note" role="status">This group contains a locked descendant. Geometry and visibility controls are disabled until the family is unlocked.</p>}
            <label className="pc-wide">Name<input aria-label="Name" defaultValue={primary.name} key={`${primary.id}-name-${primary.name}`} disabled={isPlaying || primaryEffectivelyLocked} onBlur={(event) => commitTextInput(event, primary.name, 'Object name', (value) => commitPatch({ name: value }, 'Rename object'), { trim: true, required: true })}/></label>
            {TRANSFORM_NUMERIC_FIELDS.filter((definition) => (primary.type !== 'circle' || definition.key !== 'rotation') && (!isLinearShapeType(primary.type) || definition.key !== 'height')).map((definition) => renderObjectPropertyField(definition.key as PropertyTrack['property'], definition.label, { min: definition.min, max: definition.max, step: 0.1, familyLock: true }))}
            {renderObjectPropertyField('scale', 'Scale', { ...signedScaleBounds, step: 0.05, familyLock: true })}
            {renderObjectPropertyField('scaleX', 'Scale X', { ...signedScaleBounds, step: 0.05, familyLock: true })}
            {renderObjectPropertyField('scaleY', 'Scale Y', { ...signedScaleBounds, step: 0.05, familyLock: true })}
            {renderShapeProperties()}
            {primary.type !== 'group' && renderObjectPropertyField('opacity', 'Opacity', { min: 0, max: 1, step: 0.05 })}
            {(primary.type === 'text' || primary.type === 'math' || primary.type === 'brace') && <label>Font size<input key={`${primary.id}-font-size-${primary.style.fontSize ?? 22}`} type="number" min={PROOFCANVAS_SCHEMA_LIMITS.fontSizeMin} max={PROOFCANVAS_SCHEMA_LIMITS.fontSizeMax} aria-label="Font size" defaultValue={primary.style.fontSize ?? 22} disabled={isPlaying || primaryEffectivelyLocked} onBlur={(event) => { const value = primary.style.fontSize ?? 22; commitNumericInput(event, { key: 'fontSize', label: 'Font size', fallback: value, min: PROOFCANVAS_SCHEMA_LIMITS.fontSizeMin, max: PROOFCANVAS_SCHEMA_LIMITS.fontSizeMax }, value, (next) => commitPatch({ style: { fontSize: next } }, 'Set font size')) }}/></label>}
            {primary.type === 'text' && <label className="pc-wide">Content<textarea aria-label="Content" rows={3} maxLength={PROOFCANVAS_TEXT_MAX_CHARS} defaultValue={String(primary.properties.content ?? '')} key={`${primary.id}-content-${String(primary.properties.content ?? '')}`} disabled={isPlaying || primaryEffectivelyLocked} onBlur={(event) => { const current = String(primary.properties.content ?? ''); commitTextInput(event, current, 'Content', (value) => commitPatch({ properties: { content: value } }, 'Edit content')) }}/></label>}
            {primary.type === 'math' && primaryMathProperties && <MathPropertiesEditor key={primary.id} objectId={primary.id} value={primaryMathProperties} authorityKey={mathDraftAuthorityKey} disabled={isPlaying || primaryEffectivelyLocked} onCommit={commitMathProperties} onNotice={setStatus}/>}
            {primary.type === 'graph' && <GraphInspector
              key={primary.id}
              objectId={primary.id}
              value={{ expression: primary.properties.expression as GraphDraftValue['expression'], xMin: Number(primary.properties.xMin), xMax: Number(primary.properties.xMax) }}
              authorityKey={graphDraftAuthorityKey}
              disabled={isPlaying || primaryEffectivelyLocked}
              onCommit={commitGraphProperties}
              onNotice={setStatus}
            />}
            {primary.type === 'brace' && <label className="pc-wide">Brace label<input aria-label="Brace label" maxLength={PROOFCANVAS_BRACE_LABEL_MAX_CHARS} defaultValue={String(primary.properties.label ?? '')} key={`${primary.id}-label-${String(primary.properties.label ?? '')}`} disabled={isPlaying || primaryEffectivelyLocked} onBlur={(event) => { const current = String(primary.properties.label ?? ''); commitTextInput(event, current, 'Brace label', (value) => commitPatch({ properties: { label: value } }, 'Edit brace label')) }}/></label>}
            {(primary.type === 'image' || primary.type === 'svg') && <label className="pc-wide">Asset source<input aria-label="Asset source" defaultValue={String(primary.properties.source ?? '')} key={`${primary.id}-source-${String(primary.properties.source ?? '')}`} disabled={isPlaying || primaryEffectivelyLocked} onBlur={(event) => { const current = String(primary.properties.source ?? ''); commitTextInput(event, current, 'Asset source', (value) => commitPatch({ properties: { source: value } }, 'Edit asset source'), { trim: true, required: true }) }}/></label>}
            {primary.type === 'axes' && (['xMin', 'xMax'] as const).map((key) => { const label = key === 'xMin' ? 'X minimum' : 'X maximum'; const value = Number(primary.properties[key]); const field = { key, label, fallback: value, min: -PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude }; return <label key={key}>{label}<input key={`${primary.id}-${key}-${String(primary.properties[key])}`} type="number" min={field.min} max={field.max} aria-label={label} defaultValue={value} disabled={isPlaying || primaryEffectivelyLocked} onBlur={(event) => commitNumericInput(event, field, value, (next) => commitPatch({ properties: { [key]: next } }, `Set ${key}`))}/></label> })}
            {primary.type === 'axes' && (['yMin', 'yMax'] as const).map((key) => { const label = key === 'yMin' ? 'Y minimum' : 'Y maximum'; const value = Number(primary.properties[key]); const field = { key, label, fallback: value, min: -PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude }; return <label key={key}>{label}<input key={`${primary.id}-${key}-${String(primary.properties[key])}`} type="number" min={field.min} max={field.max} aria-label={label} defaultValue={value} disabled={isPlaying || primaryEffectivelyLocked} onBlur={(event) => commitNumericInput(event, field, value, (next) => commitPatch({ properties: { [key]: next } }, `Set ${key}`))}/></label> })}
            {primary.type === 'axes' && <p className="pc-wide pc-inspector-note">Coordinate-axis ticks remain a bounded browser guide; axis ranges are authoritative in Manim export and render.</p>}
            {objectTypeSupportsStyleProperty(primary, 'fill') && renderObjectPropertyField('fill', ['text', 'math'].includes(primary.type) ? 'Glyph fill' : 'Fill', { inputType: 'color' })}
            {objectTypeSupportsStyleProperty(primary, 'stroke') && renderObjectPropertyField('stroke', 'Stroke', { inputType: 'color' })}
            {objectTypeSupportsStyleProperty(primary, 'strokeWidth') && renderObjectPropertyField('strokeWidth', 'Stroke width', { min: 0, max: PROOFCANVAS_SCHEMA_LIMITS.strokeWidthMax, step: 0.1 })}
            <label className="pc-check"><input type="checkbox" aria-label={primaryInheritedHidden ? `Visible locally; hidden by ${primaryVisibilityOwner?.name}` : 'Visible'} checked={primary.visible} disabled={isPlaying || primaryFamilyLocked} onChange={(event) => commitPatch({ visible: event.target.checked }, 'Toggle visibility')}/>{primaryInheritedHidden ? `Visible locally — hidden by ${primaryVisibilityOwner?.name}` : 'Visible'}</label>
            <label className="pc-check"><input type="checkbox" aria-label="Locked" checked={primary.locked} disabled={isPlaying || primaryInheritedLocked} onChange={toggleLock}/>Locked</label>
          </div>
        </form>}

        {selection.kind === 'keyframes' && selection.shotId === shot.id && <KeyframeInspector project={project} shot={shot} selection={selection} disabled={isPlaying} onCommit={commitRenderedTimelineIntent} onSelect={selectSingleKeyframe} onSeek={jumpLocalPlayhead} onNotice={setStatus}/>}

        {selectedAnimation && <section className="pc-animation-inspector pc-contextual-animation" aria-label="Animation inspector">
          <div className="pc-section-heading"><h2>Timing and motion</h2>{selectedAnimationLocked && <span>Locked target</span>}</div>
          {selectedAnimation.type === 'transform' && selectedAnimation.targetIds.length > 1 && <span className="pc-animation-lock-note" role="status">Split this legacy multi-target transform before editing absolute geometry.</span>}
          <label>Start<input type="number" min="0" max={subtractTimelineTimes(shot.duration, selectedAnimation.duration)} step="0.1" aria-label="Start time" defaultValue={selectedAnimation.start} key={`${selectedAnimation.id}-start-${selectedAnimation.start}`} disabled={isPlaying || selectedAnimationLocked || selectedAnimationCompatibilityUnsupported} onBlur={(event) => commitNumericInput(event, { key: 'start', label: 'Start time', fallback: selectedAnimation.start, min: 0, max: subtractTimelineTimes(shot.duration, selectedAnimation.duration) }, selectedAnimation.start, (next) => updateAnimation({ start: next }, 'Set animation start'))}/></label>
          <label>Duration<input type="number" min="0.1" max={subtractTimelineTimes(shot.duration, selectedAnimation.start)} step="0.1" aria-label="Duration" defaultValue={selectedAnimation.duration} key={`${selectedAnimation.id}-duration-${selectedAnimation.duration}`} disabled={isPlaying || selectedAnimationLocked || selectedAnimationCompatibilityUnsupported} onBlur={(event) => commitNumericInput(event, { key: 'duration', label: 'Duration', fallback: selectedAnimation.duration, min: 0.1, max: subtractTimelineTimes(shot.duration, selectedAnimation.start) }, selectedAnimation.duration, (next) => updateAnimation({ duration: next }, 'Set animation duration'))}/></label>
          <label>Easing<select aria-label="Easing" value={selectedAnimation.easing} disabled={isPlaying || (selectedAnimationLocked && !selectedEmphasisUnsupported && !selectedEntranceThereBackUnsupported)} onChange={(event) => updateAnimation({ easing: event.target.value as Easing }, 'Set animation easing')}>{(selectedAnimation.type === 'emphasise' ? ['there-and-back'] : EASINGS.filter((easing) => easing !== 'there-and-back' || (selectedAnimation.type !== 'write' && selectedAnimation.type !== 'create'))).map((easing) => <option key={easing}>{easing}</option>)}{selectedEmphasisUnsupported && <option value={selectedAnimation.easing} disabled>{selectedAnimation.easing} (render unsupported)</option>}{selectedEntranceThereBackUnsupported && <option value="there-and-back" disabled>there-and-back (render unsafe)</option>}</select></label>
          {selectedAnimation.type === 'emphasise' && !selectedEmphasisUnsupported && <span className="pc-animation-lock-note" role="status">Emphasise uses a fixed there-and-back pulse.</span>}
          {selectedEmphasisUnsupported && <span className="pc-animation-lock-note" role="status">Saved legacy easing: choose there-and-back to repair rendering.</span>}
          {selectedEntranceThereBackUnsupported && <span className="pc-animation-lock-note" role="status">Write/Create there-and-back is unsafe in pinned Manim; choose another easing.</span>}
          {animationPropertyFields.map((field) => { const value = typeof selectedAnimation.properties[field.key] === 'number' ? Number(selectedAnimation.properties[field.key]) : field.fallback; return <label key={field.key}>{field.label}<input type="number" min={field.min} max={field.max} step="0.1" aria-label={field.label} defaultValue={value} key={`${selectedAnimation.id}-${field.key}-${String(selectedAnimation.properties[field.key])}`} disabled={isPlaying || selectedAnimationLocked || selectedAnimationCompatibilityUnsupported} onBlur={(event) => commitNumericInput(event, field, value, (next) => updateAnimation({ properties: { [field.key]: next } }, `Set ${field.label.toLowerCase()}`))}/></label> })}
          <button type="button" className="pc-danger-action" disabled={isPlaying || selectedAnimationLocked || selectedAnimationCompatibilityUnsupported} onClick={() => deleteTimelineAnimation(selectedAnimation)}>Delete animation</button>
        </section>}
        {!primary && !selectedAnimation && selection.kind !== 'keyframes' && <section className="pc-context-summary" aria-label={selection.kind === 'project' ? 'Project inspector' : 'Shot inspector'}>
          <div className="pc-section-heading"><h2>{selection.kind === 'project' ? 'Project' : 'Shot'}</h2><span>{selection.kind === 'project' ? project.settings.aspectRatio : `${shot.duration.toFixed(1)}s`}</span></div>
          {selection.kind === 'project' ? <>
            <p>{project.shots.length} shots · {project.settings.frameRate} fps · {project.settings.resolution.width}×{project.settings.resolution.height}</p>
            <button type="button" onClick={() => openUtilityDialog('settings')}>Open project settings</button>
          </> : <>
            <label>Name<input aria-label="Shot name" key={`inspector-${shot.id}-${shot.name}`} defaultValue={shot.name} maxLength={120} disabled={isPlaying} onBlur={(event) => commitTextInput(event, shot.name, 'Shot name', (value) => editShot({ name: value }, 'Rename shot'), { trim: true, required: true })}/></label>
            <label>Duration<input type="number" min={minimumShotDuration} max="300" step="0.5" aria-label="Shot duration" key={`inspector-${shot.id}-${shot.duration}`} defaultValue={shot.duration} disabled={isPlaying} onBlur={(event) => commitNumericInput(event, { key: 'shotDuration', label: 'Shot duration', fallback: shot.duration, min: minimumShotDuration, max: 300 }, shot.duration, (value) => editShot({ duration: value }, 'Set shot duration'))}/></label>
            <div className="pc-camera-key-fields"><h3>Camera keyframes</h3>{renderCameraPropertyField('x', 'Camera X', -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude)}{renderCameraPropertyField('y', 'Camera Y', -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude)}{renderCameraPropertyField('zoom', 'Camera zoom', PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMin, PROOFCANVAS_SCHEMA_LIMITS.cameraZoomMax)}{renderCameraPropertyField('rotation', 'Camera rotation', -PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude, PROOFCANVAS_SCHEMA_LIMITS.animationRotationMagnitude)}</div>
            <div className="pc-context-actions"><button type="button" onClick={() => reorderShot(-1)} disabled={isPlaying} aria-label="Move shot earlier">Move earlier</button><button type="button" onClick={() => reorderShot(1)} disabled={isPlaying} aria-label="Move shot later">Move later</button></div>
            <p>{shot.objects.length} layers · {shot.animations.length} animations</p>
          </>}
        </section>}
      </aside>

      <div className="pc-bottom-workspace">
        <ShotStoryboard project={project} activeShotId={shot.id} previewStyle={previewStyle} sequence={shotSequence} disabled={isPlaying} onActivate={selectShot} onCommitAction={runEditorShotAction} onSplitActive={splitActiveShot} onRequestDialog={openShotDialog}/>

        <section id="pc-active-shot-panel" className="pc-timeline" role="tabpanel" aria-labelledby={`pc-shot-tab-${shot.id}`} aria-label="Animation timeline" data-shot-id={shot.id}><div className="pc-timeline-head"><div className="pc-transport" aria-label="Sequence transport"><button type="button" onClick={() => jumpSequenceTime(0)} aria-label="Jump to sequence start">↤</button><button type="button" className="pc-play-button" onClick={togglePlayback} aria-label={isPlaying ? 'Pause sequence' : 'Play sequence'} aria-pressed={isPlaying}>{isPlaying ? '❚❚' : '▶'}</button><button type="button" onClick={() => jumpSequenceTime(shotSequence.totalDuration)} aria-label="Jump to sequence end">↦</button></div><h2>Timeline</h2><label>Animation<select aria-label="Animation type" value={animationType} disabled={isPlaying} onChange={(event) => setAnimationType(event.target.value as AnimationType)}>{ANIMATION_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label><button type="button" onClick={addAnimation} disabled={isPlaying}>Add animation</button><IsolatedSequenceScrubber clock={playbackClockRef.current} isPlaying={isPlaying} pausedGlobalTime={pausedGlobalTime} duration={shotSequence.totalDuration} onSeek={jumpSequenceTime}/><button type="button" onClick={() => setTimelineCollapsed((value) => !value)} aria-expanded={!timelineCollapsed} aria-label={timelineCollapsed ? 'Expand shot timeline' : 'Collapse shot timeline'}>{timelineCollapsed ? 'Expand' : 'Collapse'}</button></div>
        {!timelineCollapsed && <ShotTimeline project={project} shot={shot} projectRevision={projectRevision} playhead={playhead} selection={selection} disabled={isPlaying} onSeek={jumpLocalPlayhead} onSelect={setEditorSelection} onCommit={commitRenderedTimelineIntent} onNotice={setStatus}/>}
        <div ref={trackRef} className="pc-timeline-track" data-testid="timeline-track" onPointerMove={moveTimelineGesture} onPointerUp={endTimelineGesture} onPointerCancel={cancelTimelineGesture} onPointerDown={(event) => { if (event.target === event.currentTarget && trackRef.current) { const rect = trackRef.current.getBoundingClientRect(); jumpLocalPlayhead(Math.max(0, Math.min(shot.duration, (event.clientX - rect.left) / rect.width * shot.duration))) } }}>
          <IsolatedTimelinePlayhead clock={playbackClockRef.current} isPlaying={isPlaying} pausedPlayhead={playhead} duration={shot.duration} shotId={shot.id}/>{shot.animations.map((animation) => { const timing = timelineDraft?.id === animation.id ? timelineDraft : animation; const lane = animationLanes.get(animation.id) ?? 0; const targets = animation.targetIds.map((id) => shot.objects.find((object) => object.id === id)?.name ?? id).join(', '); const locked = animationTargetsLocked(shot, animation); const lockedNotice = () => { setSelectedAnimationId(animation.id); setStatus('This animation targets a locked object family; unlock it before editing the block.') }; return <button type="button" key={animation.id} className={`pc-animation-block ${selectedAnimationId === animation.id ? 'selected' : ''} ${locked ? 'locked' : ''}`} style={{ left: `${timing.start / shot.duration * 100}%`, width: `${Math.max(1.5, timing.duration / shot.duration * 100)}%`, top: `${8 + lane * 31}px` }} data-animation-id={animation.id} data-animation-type={animation.type} data-target-ids={animation.targetIds.join(' ')} data-timeline-lane={lane} data-start={timing.start} data-duration={timing.duration} data-locked={locked ? 'true' : 'false'} aria-disabled={locked} aria-label={`${animation.type} animation targeting ${targets}; ${locked ? 'locked' : 'drag the right edge to resize'}`} onKeyDown={(event) => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); deleteTimelineAnimation(animation) } }} onClick={() => setSelectedAnimationId(animation.id)} onPointerDown={(event) => { if (isPlaying) { event.stopPropagation(); setStatus('Pause preview before editing timeline blocks.'); return } if (locked) { event.stopPropagation(); lockedNotice(); return } beginTimelineGesture(event, animation, 'move') }}><span>{animation.type}</span><i aria-hidden="true" onPointerDown={(event) => { if (locked) { event.stopPropagation(); lockedNotice(); return } beginTimelineGesture(event, animation, 'resize') }}/></button> })}
        </div>
        </section>
      </div>

      {shotDialog && shotDialogTarget && <div ref={shotDialogRef} className="pc-shot-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-shot-dialog-title" aria-describedby="pc-shot-dialog-description">
        <form noValidate onSubmit={(event) => { event.preventDefault(); commitShotDialog() }}>
          <header><div><span>Storyboard</span><h2 id="pc-shot-dialog-title">{shotDialog.kind === 'rename' ? 'Rename shot' : shotDialog.kind === 'duration' ? 'Set shot duration' : 'Delete shot'}</h2></div><button type="button" onClick={() => setShotDialog(null)} aria-label="Close shot dialog">×</button></header>
          <div className="pc-shot-dialog-body">
            {shotDialog.kind === 'rename' && <><p id="pc-shot-dialog-description">Choose a concise storyboard name. This edit is one undoable history step.</p><label>Name<input ref={shotDialogInputRef} name="shot-name" defaultValue={shotDialogTarget.name} maxLength={120} aria-label="Shot name" disabled={isPlaying}/></label></>}
            {shotDialog.kind === 'duration' && <><p id="pc-shot-dialog-description">Duration must keep every authored lifetime, animation, keyframe, clip, caption, and marker in range.</p><label>Duration in seconds<input ref={shotDialogInputRef} name="shot-duration" type="number" min={minimumAuthoredShotDuration(project, shotDialogTarget)} max="300" step="any" defaultValue={shotDialogTarget.duration} aria-label="Shot duration" disabled={isPlaying}/></label></>}
            {shotDialog.kind === 'delete' && <p id="pc-shot-dialog-description">{shotDeleteDescription(project, shotDialogTarget)}</p>}
          </div>
          <footer><button type="button" data-autofocus={shotDialog.kind === 'delete' ? '' : undefined} onClick={() => setShotDialog(null)}>Cancel</button><button type="submit" className={shotDialog.kind === 'delete' ? 'pc-danger-action' : 'pc-primary'} disabled={isPlaying}>{shotDialog.kind === 'rename' ? 'Rename shot' : shotDialog.kind === 'duration' ? 'Set duration' : 'Delete shot'}</button></footer>
        </form>
      </div>}

      {commandPaletteOpen && <div ref={commandPaletteRef} className="pc-command-palette" role="dialog" aria-modal="true" aria-label="Command palette"><header><div><span>Command palette</span><h2>What would you like to do?</h2></div><button type="button" onClick={() => setCommandPaletteOpen(false)} aria-label="Close command palette">×</button></header><label><span className="pc-visually-hidden">Search commands</span><input ref={commandSearchRef} type="search" aria-label="Search commands" aria-controls="pc-editor-command-list" aria-activedescendant={activeCommandOptionId ?? undefined} placeholder="Search actions" value={commandSearch} onKeyDown={navigateCommandListbox} onChange={(event) => setCommandSearch(event.target.value)}/></label><div id="pc-editor-command-list" className="pc-command-list" role="listbox" aria-label="Editor commands" onKeyDown={navigateCommandListbox}>{aiCommandVisible && <button id="pc-command-option-ai" type="button" role="option" aria-selected={activeCommandOptionId === 'pc-command-option-ai'} onFocus={() => setActiveCommandOptionId('pc-command-option-ai')} onClick={() => { assistantTriggerRef.current = commandButtonRef.current; setCommandPaletteOpen(false); setAssistantOpen(true) }}><span>AI structured edit…</span><kbd>Review first</kbd></button>}{paletteCommands.map(({ command, id, disabled }) => <button id={id} type="button" role="option" aria-selected={activeCommandOptionId === id} key={command.id} disabled={disabled} onFocus={() => { if (!disabled) setActiveCommandOptionId(id) }} onClick={() => { if (commandController.execute(command.id, { source: 'palette', shiftKey: false })) setCommandPaletteOpen(false) }}><span>{command.label}</span><kbd>{command.shortcut.replace('Mod', 'Ctrl/Cmd')}</kbd></button>)}{paletteCommands.length === 0 && !aiCommandVisible && <p role="status">No commands match “{commandSearch}”.</p>}</div></div>}

      {utilityDialog && <div ref={utilityDialogRef} className="pc-utility-dialog" role="dialog" aria-modal="true" aria-label={utilityDialog === 'settings' ? 'Project settings' : utilityDialog === 'shortcuts' ? 'Keyboard shortcuts' : 'Render and export'}><header><div><span>{utilityDialog === 'render-export' ? 'Output' : 'Workspace'}</span><h2>{utilityDialog === 'settings' ? 'Project settings' : utilityDialog === 'shortcuts' ? 'Keyboard shortcuts' : 'Render and export'}</h2></div><button type="button" onClick={() => setUtilityDialog(null)} aria-label={`Close ${utilityDialog === 'settings' ? 'project settings' : utilityDialog === 'shortcuts' ? 'keyboard shortcuts' : 'render and export'}`}>×</button></header>
        {utilityDialog === 'settings' && <div className="pc-settings-dialog"><p>Output settings are authored project data. Aspect changes recenter only untouched default cameras and preserve authored geometry.</p><fieldset className="pc-settings-grid" disabled={isPlaying}><label>Aspect ratio<select aria-label="Aspect ratio" value={project.settings.aspectRatio} onChange={(event) => updateProjectSettings({ aspectRatio: event.target.value as ProjectDocument['settings']['aspectRatio'] })}><option value="16:9">16:9 · landscape</option><option value="9:16">9:16 · portrait</option><option value="1:1">1:1 · square</option></select></label><label>Frame rate<select aria-label="Frame rate" value={project.settings.frameRate} onChange={(event) => updateProjectSettings({ frameRate: Number(event.target.value) as ProjectDocument['settings']['frameRate'] })}>{[15, 24, 30, 60].map((rate) => <option key={rate} value={rate}>{rate} fps</option>)}</select></label><label>Render preset<select aria-label="Render preset" value={project.settings.renderPreset} onChange={(event) => updateProjectSettings({ renderPreset: event.target.value as ProjectDocument['settings']['renderPreset'] })}><option value="draft">Draft</option><option value="720p">720p</option><option value="1080p">1080p</option></select></label><label>Preview quality<select aria-label="Settings preview quality" value={project.settings.previewQuality} onChange={(event) => updateProjectSettings({ previewQuality: event.target.value as ProjectDocument['settings']['previewQuality'] })}><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select></label></fieldset><dl><div><dt>Logical frame</dt><dd>{logicalFrame.width} × {logicalFrame.height}</dd></div><div><dt>Output</dt><dd>{resolutionFor(project.settings.aspectRatio, project.settings.renderPreset).width} × {resolutionFor(project.settings.aspectRatio, project.settings.renderPreset).height}</dd></div></dl></div>}
        {utilityDialog === 'shortcuts' && <div className="pc-shortcut-dialog"><p>Ctrl on Windows/Linux and Command on macOS are shown together as Ctrl/Cmd. Native text editing wins inside fields except global Save, Commands, Render/Export, and Escape.</p>{(['Playback', 'Edit', 'Project', 'View'] as const).map((group) => <section key={group}><h3>{group}</h3><dl>{EDITOR_COMMANDS.filter((command) => command.group === group).map((command) => <div key={command.id}><dt>{command.label}</dt><dd><kbd>{command.shortcut.replace('Mod', 'Ctrl/Cmd')}</kbd></dd></div>)}</dl></section>)}</div>}
        {utilityDialog === 'render-export' && <div className="pc-output-dialog"><p>MP4 output is generated by the pinned Manim renderer. Technical exports are deterministic snapshots of the current project; unsupported assets or timeline features remain explicit compiler diagnostics.</p><label>Render quality<select aria-label="Render quality" value={renderQuality} onChange={(event) => setRenderQuality(event.target.value as ClientRenderJob['quality'])}><option value="preview">Preview · faster</option><option value="production">Production · final quality</option></select></label><div className="pc-output-summary"><span>{project.settings.aspectRatio}</span><span>{project.settings.resolution.width}×{project.settings.resolution.height}</span><span>{project.settings.frameRate} fps</span><span>{project.shots.length} shots</span></div><div className="pc-output-actions"><button type="button" onClick={exportJson} aria-label="Export project JSON">Project JSON<span>Portable structured source</span></button><button type="button" onClick={exportPython} aria-label="Export Manim Python">Manim Python<span>Inspect compiler output</span></button><button type="button" className="pc-primary" onClick={() => void startRender(renderQuality)} disabled={renderPending || renderJob?.status === 'pending' || renderJob?.status === 'running'} aria-label="Render MP4">{renderPending ? 'Submitting…' : renderJob?.status === 'pending' || renderJob?.status === 'running' ? 'Rendering…' : `Render ${renderQuality} MP4`}<span>Genuine pinned Manim job</span></button></div></div>}
      </div>}

      {assistantOpen && <aside ref={assistantRef} className="pc-assistant-drawer" role="dialog" aria-modal="false" aria-label="AI command drawer"><header><div><span>Assistant</span><h2>Structured edit</h2></div><button type="button" onClick={() => setAssistantOpen(false)} aria-label="Close AI command drawer">×</button></header><section className="pc-ai" role="region" aria-label="AI command" data-ai-provider={aiProvider}><p className="pc-demo-label">{aiProvider === 'configured-provider' ? 'OpenAI structured operations — server configured' : 'Deterministic demo interpreter — limited commands'}</p><div className="pc-presets">{REQUIRED_AI_COMMANDS.map((command, index) => <button type="button" key={command} onClick={() => void runAi(command)} aria-label={`Run AI preset ${index + 1}: ${command}`} title={command} disabled={aiPending}>{index + 1}</button>)}</div><label>Instruction<textarea aria-label="Describe the edit" value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={4}/></label><button type="button" className="pc-primary" onClick={() => void runAi()} aria-label="Propose edit" disabled={aiPending}>{aiPending ? 'Proposing…' : 'Propose edit'}</button>{aiError && <p className="pc-error" role="alert">{aiError}</p>}{proposal && <div className="pc-proposal" role="region" aria-label="Proposed changes"><strong>{proposal.intention}</strong><p>Validated against shot <code>{proposalBase?.shotId}</code>. Expand each operation to inspect exact before and after values.</p><ol>{proposalReviews.map((review, index) => <li key={`${proposal.operations[index]?.type}-${index}`} data-operation-kind={proposal.operations[index]?.type}><details><summary>{review.summary}</summary><pre>{review.details}</pre></details></li>)}</ol><div><button type="button" className="pc-primary" onClick={applyProposal}>Apply proposed changes</button><button type="button" onClick={() => { setProposal(null); setProposalBase(null); setCritique(null) }}>Discard proposed changes</button></div></div>}</section><section className="pc-critique" role="region" aria-label="Composition critique"><div className="pc-section-heading"><h2>Composition</h2><button type="button" onClick={() => setCritique({ issues: critiqueProject(project, { shotId: shot.id, proposedOperations: proposal?.operations }), revision: projectRevision, shotId: shot.id })}>Critique composition</button></div>{critique && <p className="pc-critique-provenance">Current revision · {shot.name}</p>}{critique && (critique.issues.length > 0 ? <ul>{critique.issues.map((item) => <li key={item.id} data-issue-kind={item.kind} data-object-ids={item.objectIds.join(' ')} data-severity={item.severity}><strong>{item.kind.replaceAll('-', ' ')}</strong><span>{item.explanation}</span><em>{item.proposedCorrection}</em></li>)}</ul> : <p className="pc-critique-clear" role="status">No deterministic composition issues found for this shot.</p>)}</section></aside>}

      {(rendererMessage || importError) && <div className="pc-message" role="alert"><p>{importError || rendererMessage}</p><button type="button" onClick={() => { setRendererMessage(''); setImportError('') }}>Dismiss</button></div>}
      {durableProject && saveMessage && <div className={`pc-save-message ${saveState === 'conflict' || saveState === 'reconcile' || saveState === 'blocked' ? 'conflict' : ''}`} role={saveState === 'conflict' || saveState === 'reconcile' || saveState === 'blocked' ? 'alert' : 'status'}><p>{saveMessage}</p>{(saveState === 'offline' || saveState === 'conflict' || saveState === 'reconcile') && <button type="button" onClick={() => saveState === 'offline' ? void performDurableSave() : window.location.reload()}>{saveState === 'offline' ? 'Retry autosave' : saveState === 'conflict' ? 'Reload durable project' : 'Reload project'}</button>}<button type="button" onClick={() => setSaveMessage('')} aria-label="Dismiss save message">×</button></div>}
      {durableProject && localRecovery && !recoveryIgnored && <section className="pc-recovery-offer" role="region" aria-label="Browser recovery available"><strong>Unsaved browser recovery found</strong><p>ProofCanvas did not load it automatically. Apply this project-scoped copy only if it contains work missing from durable revision {serverRevision}.</p><div><button type="button" onClick={applyLocalRecovery}>Apply browser recovery</button><button type="button" onClick={() => setRecoveryIgnored(true)}>Ignore for now</button></div></section>}
      {durableProject && recoveryOpen && <section className="pc-checkpoint-panel" role="dialog" aria-modal="false" aria-label="Project recovery"><header><div><span>Durable recovery</span><strong>Checkpoints</strong></div><button type="button" onClick={() => setRecoveryOpen(false)} aria-label="Close project recovery">×</button></header>{checkpoints.length === 0 ? <p>No checkpoints have been created yet.</p> : <ul>{checkpoints.map((checkpoint) => <li key={checkpoint.id}><div><strong>{checkpoint.label}</strong><span>Revision {checkpoint.revision} · {checkpoint.createdAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}{checkpoint.recoveryRequired ? ' · exact legacy export required' : ''}</span></div>{checkpoint.recoveryRequired ? <a href={`/api/projects/${encodeURIComponent(durableProject.projectId)}/legacy-export?checkpointId=${encodeURIComponent(checkpoint.id)}`}>Export exact legacy JSON</a> : <button type="button" onClick={() => void recoverCheckpoint(checkpoint)} disabled={checkpointPending}>Recover…</button>}</li>)}</ul>}</section>}
      {renderJob && <section className="pc-render-panel" role="region" aria-label="Render status" data-render-job-id={renderJob.id} data-render-status={renderJob.status} data-render-current={renderRepresentsCurrentProject ? 'true' : 'false'}>
        <header><div><span>Manim render</span><strong>{renderJob.status}</strong></div><button type="button" onClick={() => { setRenderJob(null); setRenderBaseRevision(null) }} aria-label="Dismiss render status">×</button></header>
        <p>Source <code>{renderJob.sourceSha256.slice(0, 12)}</code> · {renderJob.quality}</p>
        {!renderRepresentsCurrentProject && <p className="pc-render-stale" role="status">Render of an earlier project revision. Render again to reflect current edits.</p>}
        {renderJob.status === 'succeeded' && <><video controls preload="metadata" aria-label="Rendered Manim preview" src={`/api/proofcanvas/render/${encodeURIComponent(renderJob.id)}/video`}/><a className="pc-download-render" href={`/api/proofcanvas/render/${encodeURIComponent(renderJob.id)}/video`} download="proofcanvas-render.mp4">Download MP4</a></>}
        {renderJob.status === 'failed' && <p>{renderJob.error?.message ?? 'Manim could not render this generated scene.'}</p>}
        {renderPollingPaused && (renderJob.status === 'pending' || renderJob.status === 'running') && <button type="button" onClick={() => { setRendererMessage(''); setRenderPollFailures(0); setRenderPollingPaused(false) }}>Resume status polling</button>}
      </section>}
      {exportPreview && <div ref={exportDialogRef} className="pc-export-dialog" role="dialog" aria-modal="true" aria-label={exportPreview.title}><header role="group"><h2>{exportPreview.title}</h2><button type="button" onClick={() => setExportPreview(null)} aria-label="Close export preview">×</button></header><div className="pc-export-body">{exportPreview.diagnostics && exportPreview.diagnostics.length > 0 && <section className="pc-export-diagnostics" aria-label="Compiler diagnostics"><h3>Compiler diagnostics</h3><ul>{exportPreview.diagnostics.map((diagnostic) => <li key={diagnostic}>{diagnostic}</li>)}</ul></section>}<pre tabIndex={0}>{exportPreview.contents}</pre></div></div>}
    </div>
  )
}
