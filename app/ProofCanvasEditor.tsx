'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ComponentProps, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import CanvasStage, { resolveCanvasKeyboardTransformIntent, temporallyTransformsObject, type CanvasKeyboardTransformIntent } from './CanvasStage'
import { REQUIRED_AI_COMMANDS, interpretDemoCommand, type AiProposal } from '@/lib/proofcanvas/ai'
import { compileManim } from '@/lib/proofcanvas/compiler'
import { SEMANTIC_COMPONENTS, insertSemanticComponent, type SemanticComponentId } from '@/lib/proofcanvas/components'
import { critiqueProject, type CritiqueIssue } from '@/lib/proofcanvas/critique'
import { ensureSessionCsrfToken } from '@/lib/proofcanvas/csrf.client'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { applyDocumentOperations } from '@/lib/proofcanvas/documentOperations'
import { addTimelineTimes, compareTimelineTimes, logicalFrameFor, resolutionFor, subtractTimelineTimes, type LogicalFrame } from '@/lib/proofcanvas/frame'
import { canRedo, canUndo, commitOperations, commitProject, createHistory, redo, undo, type ProjectHistory } from '@/lib/proofcanvas/history'
import { commandTargetWithin, createEditorCommandController, EDITOR_COMMANDS, type EditorCommandId } from '@/lib/proofcanvas/editorCommands'
import { EditorPlaybackClock } from '@/lib/proofcanvas/editorPlayback'
import { animationSelection, normalizeEditorSelection, objectSelection, projectSelection, selectedAnimationIds, selectedObjectIds, shotSelection, type EditorSelection } from '@/lib/proofcanvas/editorSelection'
import { allocateId, collectProjectIds } from '@/lib/proofcanvas/ids'
import { applyOperations, duplicateObjects, effectiveLockOwner, effectiveVisibilityOwner, inspectOperations } from '@/lib/proofcanvas/operations'
import { PROOFCANVAS_BRACE_LABEL_MAX_CHARS, PROOFCANVAS_LATEX_MAX_CHARS, PROOFCANVAS_PROJECT_MAX_BYTES, PROOFCANVAS_SCHEMA_LIMITS, PROOFCANVAS_TEXT_MAX_CHARS, ProjectDocumentSchema, SceneOperationSchema, animationAuthoringCompatibilityIssue, canonicalProjectJson, cloneSerializable, parseProjectDocument, type AnimationType, type Easing, type ProjectDocument, type SceneAnimation, type SceneObject, type SceneOperation, type Shot } from '@/lib/proofcanvas/schema'
import { EDITORIAL_INK_STYLE_ID, RAW_MANIM_STYLE_ID, styleById } from '@/lib/proofcanvas/styles'

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
  { type: 'circle', label: 'circle', tab: 'shapes', keywords: 'ellipse disk' },
  { type: 'rectangle', label: 'rectangle', tab: 'shapes', keywords: 'box panel square' },
  { type: 'line', label: 'line', tab: 'shapes', keywords: 'segment rule' },
  { type: 'arrow', label: 'arrow', tab: 'shapes', keywords: 'vector connector' },
  { type: 'axes', label: 'coordinate axes', tab: 'graphs', keywords: 'plot coordinate plane chart' },
  { type: 'graph', label: 'function graph', tab: 'graphs', keywords: 'plot curve function' },
]
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

type DurableSaveState = 'saved' | 'waiting' | 'saving' | 'offline' | 'conflict'

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
    case 'math': return { ...base, name: 'Mathematical text', semanticRole: 'equation', style: { fontSize: 30, textAlign: 'left' }, properties: { content: '\\sum_{k=0}^{n} 2^k' } }
    case 'circle': return { ...base, transform: { ...base.transform, width: 90, height: 90 }, style: { stroke: '#315866', strokeWidth: 2 }, properties: {} }
    case 'rectangle': return { ...base, transform: { ...base.transform, width: 150, height: 78 }, style: { stroke: '#252722', opacity: 0.22 }, properties: {} }
    case 'line': return { ...base, transform: { ...base.transform, width: 180, height: 2 }, style: { stroke: '#655f55', strokeWidth: 1 }, properties: {} }
    case 'arrow': return { ...base, transform: { ...base.transform, width: 160, height: 18 }, style: { stroke: '#71402d', strokeWidth: 2 }, properties: {} }
    case 'brace': return { ...base, transform: { ...base.transform, width: 220, height: 34 }, style: { stroke: '#71402d', fontSize: 18 }, properties: { label: 'n pieces', orientation: 'below' } }
    case 'axes': return { ...base, transform: { ...base.transform, width: 240, height: 150 }, properties: { xMin: -3, xMax: 3, yMin: -2, yMax: 4 } }
    case 'graph': return { ...base, transform: { ...base.transform, width: 240, height: 150 }, style: { stroke: '#315866', strokeWidth: 2 }, properties: { expression: { kind: 'power', base: { kind: 'variable' }, exponent: 2 }, xMin: -3, xMax: 3 } }
    case 'image': return { ...base, name: 'Image asset', properties: { source: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } }
    case 'svg': return { ...base, name: 'SVG asset', properties: { source: '/proofcanvas/assets/editorial-mark.svg' } }
  }
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
  clock: EditorPlaybackClock
  isPlaying: boolean
  pausedPlayhead: number
  previewStyleId: string
}) {
  const livePlayhead = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getServerSnapshot)
  const shownPlayhead = isPlaying ? livePlayhead : pausedPlayhead
  return <div role="region" aria-label="Scene canvas" data-pc-canvas data-preview-time={shownPlayhead} data-preview-style-id={previewStyleId} className="pc-canvas-region"><CanvasStage {...stageProps} playhead={shownPlayhead}/></div>
})

const IsolatedTimelinePlayhead = memo(function IsolatedTimelinePlayhead({
  clock,
  isPlaying,
  pausedPlayhead,
  duration,
}: {
  clock: EditorPlaybackClock
  isPlaying: boolean
  pausedPlayhead: number
  duration: number
}) {
  const livePlayhead = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getServerSnapshot)
  const shownPlayhead = isPlaying ? livePlayhead : pausedPlayhead
  return <><div className="pc-playhead" style={{ left: `${shownPlayhead / duration * 100}%` }}/><output aria-label="Playhead time">{shownPlayhead.toFixed(2)}s</output></>
})

const IsolatedPlayheadScrubber = memo(function IsolatedPlayheadScrubber({
  clock,
  isPlaying,
  pausedPlayhead,
  duration,
  onSeek,
}: {
  clock: EditorPlaybackClock
  isPlaying: boolean
  pausedPlayhead: number
  duration: number
  onSeek(time: number): void
}) {
  const livePlayhead = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getServerSnapshot)
  const shownPlayhead = isPlaying ? livePlayhead : pausedPlayhead
  return <label className="pc-scrubber"><span>Playhead</span><input type="range" min="0" max={duration} step="any" value={shownPlayhead} disabled={isPlaying} aria-label="Playhead" onChange={(event) => onSeek(event.target.valueAsNumber)}/></label>
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
  const [history, setHistory] = useState<ProjectHistory>(() => createHistory(startingProjectRef.current))
  const [activeShotId, setActiveShotId] = useState(startingProjectRef.current.shots[0].id)
  const [selection, setSelection] = useState<EditorSelection>(() => shotSelection([startingProjectRef.current.shots[0].id]))
  const [playhead, setPlayhead] = useState(initialProject ? 0 : INITIAL_DEMO_PLAYHEAD)
  const [isPlaying, setIsPlaying] = useState(false)
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('text')
  const [librarySearch, setLibrarySearch] = useState('')
  const [animationType, setAnimationType] = useState<AnimationType>('fade-in')
  const [timelineDraft, setTimelineDraft] = useState<{ id: string; start: number; duration: number } | null>(null)
  const [timelineGesture, setTimelineGesture] = useState<{ id: string; kind: 'move' | 'resize'; clientX: number; start: number; duration: number; baseRevision: string } | null>(null)
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
  const [timelineHeight, setTimelineHeight] = useState(224)
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false)
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false)
  const [timelineCollapsed, setTimelineCollapsed] = useState(false)
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
  const recoveryAppliedRef = useRef(false)
  const historyRef = useRef(history)
  const selectionRef = useRef(selection)
  const activeShotIdRef = useRef(activeShotId)
  const playbackClockRef = useRef(new EditorPlaybackClock(initialProject ? 0 : INITIAL_DEMO_PLAYHEAD))
  const livePlayheadRef = useRef(playhead)

  serverRevisionRef.current = serverRevision
  csrfTokenRef.current = csrfToken
  historyRef.current = history
  selectionRef.current = selection
  activeShotIdRef.current = activeShotId

  const project = history.present
  const logicalFrame = logicalFrameFor(project.settings.aspectRatio)
  const shot = project.shots.find(({ id }) => id === activeShotId) ?? project.shots[0]
  const previewStyle = styleById(project.styles, project.activeStyleId) ?? project.styles[0]
  const setSelectedIds = useCallback((value: readonly string[] | ((ids: readonly string[]) => readonly string[])) => {
    setSelection((current) => {
      const latestProject = historyRef.current.present
      const latestShot = latestProject.shots.find(({ id }) => id === activeShotIdRef.current) ?? latestProject.shots[0]
      const currentIds = selectedObjectIds(current, latestShot.id)
      const next = typeof value === 'function' ? value(currentIds) : value
      const normalized = objectSelection(latestShot, selectionRootIds(latestShot, next))
      selectionRef.current = normalized
      return normalized
    })
  }, [])
  const setSelectedAnimationId = useCallback((id: string | null) => {
    const latestProject = historyRef.current.present
    const latestShot = latestProject.shots.find(({ id: candidateId }) => candidateId === activeShotIdRef.current) ?? latestProject.shots[0]
    const next = id ? animationSelection(latestShot, [id]) : { kind: 'none', shotId: latestShot.id } as const
    selectionRef.current = next
    setSelection(next)
  }, [])
  const selectProjectContext = useCallback(() => {
    const next = projectSelection()
    selectionRef.current = next
    setSelection(next)
  }, [])
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
    const payload: unknown = await response.json()
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
      if (!response.ok || !payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) {
        throw new Error(responseMessage(payload, 'Autosave could not complete'))
      }
      const receipt = (payload as { project?: unknown }).project
      if (!receipt || typeof receipt !== 'object' || typeof (receipt as { revision?: unknown }).revision !== 'number') {
        throw new Error('Autosave returned an invalid response')
      }
      const nextRevision = (receipt as { revision: number }).revision
      serverRevisionRef.current = nextRevision
      setServerRevision(nextRevision)
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
      if (!saveConflictRef.current && !pendingSaveRef.current && projectRevisionRef.current !== lastSavedCanonicalRef.current) {
        window.setTimeout(() => { void performDurableSave() }, 0)
      }
    }
  }, [durableProject, enqueueRevisionMutation, saveCurrentDurableRevision])
  const renderRepresentsCurrentProject = Boolean(renderJob && renderBaseRevision === projectRevision)
  const aiContextKey = `${projectRevision}\u0000${shot.id}`
  const aiContextRef = useRef(aiContextKey)
  const proposalReviews = useMemo(() => proposal ? reviewOperations(project, shot.id, proposal) : [], [project, proposal, shot.id])
  const animationLanes = useMemo(() => timelineLaneMap(shot.animations, timelineDraft), [shot.animations, timelineDraft])
  const minimumShotDuration = Math.max(1, ...shot.animations.map((animation) => addTimelineTimes(animation.start, animation.duration)))
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
    if (projectRevision === lastSavedCanonicalRef.current && !pendingSaveRef.current) {
      setSaveState('saved')
      return
    }
    setSaveState((current) => current === 'saving' ? current : 'waiting')
    const timeout = window.setTimeout(() => { void performDurableSave() }, 800)
    return () => window.clearTimeout(timeout)
  }, [durableProject, performDurableSave, projectRevision])

  useEffect(() => {
    if (shot.id !== activeShotId) {
      activeShotIdRef.current = shot.id
      setActiveShotId(shot.id)
    }
    setPlayhead((value) => Math.min(value, shot.duration))
    setSelection((current) => {
      const normalized = normalizeEditorSelection(current, project, shot.id)
      selectionRef.current = normalized
      return normalized
    })
  }, [activeShotId, project, shot.id, shot.duration])

  useEffect(() => {
    if (!ownerMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !ownerMenuRef.current?.contains(event.target)) setOwnerMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [ownerMenuOpen])

  useEffect(() => {
    if (timelineGesture && timelineGesture.baseRevision !== projectRevision) {
      setTimelineGesture(null)
      setTimelineDraft(null)
    }
  }, [projectRevision, timelineGesture])

  useEffect(() => {
    if (isPlaying) return
    livePlayheadRef.current = playhead
    playbackClockRef.current.publish(playhead)
  }, [isPlaying, playhead])

  useEffect(() => {
    if (!isPlaying) return
    const startTime = performance.now()
    const startPlayhead = compareTimelineTimes(livePlayheadRef.current, shot.duration) >= 0 ? 0 : livePlayheadRef.current
    livePlayheadRef.current = startPlayhead
    playbackClockRef.current.publish(startPlayhead)
    let frame = 0
    const tick = (now: number) => {
      const next = Math.min(shot.duration, startPlayhead + (now - startTime) / 1000)
      livePlayheadRef.current = next
      playbackClockRef.current.publish(next)
      if (compareTimelineTimes(next, shot.duration) >= 0) {
        setPlayhead(shot.duration)
        setIsPlaying(false)
        return
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [isPlaying, shot.duration])

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

  const commitOps = useCallback((operations: readonly SceneOperation[], label: string) => {
    try {
      const current = historyRef.current
      const next = commitOperations(current, activeShotIdRef.current, operations, label)
      historyRef.current = next
      projectRevisionRef.current = canonicalProjectJson(next.present)
      setHistory(next)
      setStatus(next === current ? 'No project values changed' : label)
      if (next !== current) invalidateAiContext()
      setAiError('')
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The edit could not be applied')
      return false
    }
  }, [invalidateAiContext])

  const commitDocument = useCallback((document: ProjectDocument, label: string) => {
    try {
      const current = historyRef.current
      const next = commitProject(current, ProjectDocumentSchema.parse(document), label)
      historyRef.current = next
      projectRevisionRef.current = canonicalProjectJson(next.present)
      setHistory(next)
      setStatus(next === current ? 'No project values changed' : label)
      if (next !== current) invalidateAiContext()
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The project change was invalid')
      return false
    }
  }, [invalidateAiContext])

  const commitCanvasKeyboardTransform = useCallback((intent: CanvasKeyboardTransformIntent) => {
    const latestProject = historyRef.current.present
    const latestShot = latestProject.shots.find(({ id }) => id === activeShotIdRef.current) ?? latestProject.shots[0]
    const latestStyle = styleById(latestProject.styles, latestProject.activeStyleId) ?? latestProject.styles[0]
    const resolution = resolveCanvasKeyboardTransformIntent(latestProject, latestShot.id, latestStyle, livePlayheadRef.current, intent)
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

  const nudge = useCallback((dx: number, dy: number) => {
    const latestProject = historyRef.current.present
    const latestShot = latestProject.shots.find(({ id }) => id === shot.id) ?? latestProject.shots[0]
    const latestObjects = selectionRootIds(latestShot, selectedRootIds).map((id) => latestShot.objects.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object))
    if (!latestObjects.length) return
    const selectedFamilyIds = new Set(latestObjects.flatMap((object) => familyObjectIds(latestShot, [object.id])))
    if ([...selectedFamilyIds].some((id) => effectiveLockOwner(latestShot, id))) {
      setStatus('The selection contains a locked object; unlock it before nudging the selection.')
      return
    }
    if ([...selectedFamilyIds].some((id) => temporallyTransformsObject(latestShot, id, livePlayheadRef.current))) {
      setStatus('This playhead shows animated geometry. Edit the timeline block, or scrub before the spatial animation begins, to change the base pose.')
      return
    }
    commitOps(latestObjects.map((object) => ({ type: 'update-object', objectId: object.id, patch: { transform: { x: object.transform.x + dx, y: object.transform.y + dy } } })), 'Nudge selection')
  }, [commitOps, selectedRootIds, shot.id])

  const undoHistory = useCallback(() => {
    const current = historyRef.current
    const label = current.past.at(-1)?.label
    if (!label) return setStatus('Nothing to undo')
    const next = undo(current)
    historyRef.current = next
    projectRevisionRef.current = canonicalProjectJson(next.present)
    setHistory(next)
    invalidateAiContext()
    setStatus(`Undid: ${label}`)
  }, [invalidateAiContext])

  const redoHistory = useCallback(() => {
    const current = historyRef.current
    const label = current.future[0]?.label
    if (!label) return setStatus('Nothing to redo')
    const next = redo(current)
    historyRef.current = next
    projectRevisionRef.current = canonicalProjectJson(next.present)
    setHistory(next)
    invalidateAiContext()
    setStatus(`Redid: ${label}`)
  }, [invalidateAiContext])

  const togglePlayback = useCallback(() => {
    if (isPlaying) {
      const current = playbackClockRef.current.getSnapshot()
      livePlayheadRef.current = current
      setPlayhead(current)
      setIsPlaying(false)
      setStatus('Preview paused')
      return
    }
    if (compareTimelineTimes(playhead, shot.duration) >= 0) {
      livePlayheadRef.current = 0
      playbackClockRef.current.publish(0)
      setPlayhead(0)
    }
    setIsPlaying(true)
    setStatus('Preview playing')
  }, [isPlaying, playhead, shot.duration])

  const jumpPlayhead = useCallback((time: number) => {
    setIsPlaying(false)
    livePlayheadRef.current = time
    playbackClockRef.current.publish(time)
    setPlayhead(time)
  }, [])

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

  const selectShot = (candidate: Shot) => {
    invalidateAiContext()
    setIsPlaying(false)
    activeShotIdRef.current = candidate.id
    setActiveShotId(candidate.id)
    const nextSelection = shotSelection([candidate.id])
    selectionRef.current = nextSelection
    setSelection(nextSelection)
    setPlayhead(0)
    livePlayheadRef.current = 0
    playbackClockRef.current.publish(0)
  }

  const navigateShotTabs = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const targetIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? project.shots.length - 1
        : event.key === 'ArrowLeft' ? Math.max(0, index - 1)
          : Math.min(project.shots.length - 1, index + 1)
    if (targetIndex === index) return
    const target = project.shots[targetIndex]
    if (!target) return
    selectShot(target)
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-shot-id="${target.id}"]`)?.focus())
  }

  const addShot = () => {
    const id = allocateId('shot', collectProjectIds(project), `scene-${project.shots.length + 1}`)
    const next = cloneSerializable(project)
    next.shots.push({ id, name: `Scene ${project.shots.length + 1}`, duration: 6, objects: [], animations: [], propertyTracks: [], audioClips: [], captionClips: [], markers: [], camera: { x: logicalFrame.centerX, y: logicalFrame.centerY, zoom: 1, rotation: 0 } })
    if (commitDocument(next, 'Add shot')) {
      const nextSelection = shotSelection([id])
      activeShotIdRef.current = id
      selectionRef.current = nextSelection
      setActiveShotId(id)
      setSelection(nextSelection)
      jumpPlayhead(0)
    }
  }

  const editShot = (patch: Partial<Pick<Shot, 'name' | 'duration'>>, label: string) => {
    const next = cloneSerializable(project)
    const target = next.shots.find(({ id }) => id === shot.id)!
    if (patch.name !== undefined && patch.name.trim()) target.name = patch.name.trim()
    if (patch.duration !== undefined) {
      const minimum = Math.max(1, ...target.animations.map((animation) => addTimelineTimes(animation.start, animation.duration)))
      target.duration = Math.max(minimum, Math.min(300, patch.duration))
    }
    return commitDocument(next, label)
  }

  const reorderShot = (direction: -1 | 1) => {
    const index = project.shots.findIndex(({ id }) => id === shot.id)
    const target = index + direction
    if (target < 0 || target >= project.shots.length) return setStatus('Shot is already at that edge')
    const next = cloneSerializable(project)
    const [moved] = next.shots.splice(index, 1)
    next.shots.splice(target, 0, moved)
    commitDocument(next, 'Reorder shots')
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
    if (animationAuthoringCompatibilityIssue(animation)) {
      setSelectedAnimationId(animation.id)
      setStatus('This saved animation is read-only except for its easing repair.')
      return
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setSelectedAnimationId(animation.id)
    setTimelineGesture({ id: animation.id, kind, clientX: event.clientX, start: animation.start, duration: animation.duration, baseRevision: projectRevisionRef.current })
    setTimelineDraft({ id: animation.id, start: animation.start, duration: animation.duration })
  }

  const moveTimelineGesture = (event: ReactPointerEvent) => {
    if (!timelineGesture || !trackRef.current) return
    if (timelineGesture.baseRevision !== projectRevisionRef.current) {
      setTimelineGesture(null)
      setTimelineDraft(null)
      return
    }
    const seconds = (event.clientX - timelineGesture.clientX) / trackRef.current.clientWidth * shot.duration
    const snap = (value: number) => Math.round(value * 10) / 10
    if (timelineGesture.kind === 'move') setTimelineDraft({ id: timelineGesture.id, start: snap(Math.max(0, Math.min(subtractTimelineTimes(shot.duration, timelineGesture.duration), addTimelineTimes(timelineGesture.start, seconds)))), duration: timelineGesture.duration })
    else setTimelineDraft({ id: timelineGesture.id, start: timelineGesture.start, duration: snap(Math.max(0.1, Math.min(subtractTimelineTimes(shot.duration, timelineGesture.start), addTimelineTimes(timelineGesture.duration, seconds)))) })
  }

  const endTimelineGesture = () => {
    if (timelineGesture && timelineDraft && timelineGesture.baseRevision === projectRevisionRef.current) {
      commitOps([{ type: 'update-animation', animationId: timelineGesture.id, patch: { start: timelineDraft.start, duration: timelineDraft.duration } }], timelineGesture.kind === 'move' ? 'Move timeline block' : 'Resize timeline block')
    }
    setTimelineGesture(null)
    setTimelineDraft(null)
  }

  const cancelTimelineGesture = () => {
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
      if (commitDocument(loaded, 'Load saved project')) { selectShot(loaded.shots[0]); setCritique(null) }
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Saved project is invalid') }
  }

  const createCheckpoint = async () => {
    if (!durableProject || checkpointPending || saveConflictRef.current) return
    setCheckpointPending(true)
    try {
      const created = await enqueueRevisionMutation(async () => {
        if (!await drainDurableSaves()) throw new Error('Save the current project before creating a checkpoint')
        const { response, payload } = await durableMutation(`/api/projects/${encodeURIComponent(durableProject.projectId)}/checkpoints`, 'POST', {
          expectedRevision: serverRevisionRef.current,
          mutationId: window.crypto.randomUUID(),
          label: 'Manual checkpoint',
        })
        if (!response.ok || !payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) throw new Error(responseMessage(payload, 'Checkpoint could not be created'))
        const receipt = (payload as { checkpoint?: unknown }).checkpoint
        if (!receipt || typeof receipt !== 'object' || typeof (receipt as { revision?: unknown }).revision !== 'number') throw new Error('Checkpoint returned an invalid response')
        const revision = (receipt as { revision: number }).revision
        serverRevisionRef.current = revision
        setServerRevision(revision)
        setSaveState(projectRevisionRef.current === lastSavedCanonicalRef.current ? 'saved' : 'waiting')
        setSaveMessage(`Checkpoint created at revision ${revision}`)
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
    const recovered = ProjectDocumentSchema.parse({
      ...cloneSerializable(localRecovery),
      metadata: { ...localRecovery.metadata, id: durableProject.projectId, createdAt: project.metadata.createdAt },
    })
    recoveryAppliedRef.current = true
    setRecoveryIgnored(true)
    if (commitDocument(recovered, 'Recover explicit browser copy')) {
      selectShot(recovered.shots[0])
      setSaveMessage('Browser recovery applied; durable autosave is pending.')
    }
  }

  const resetDemo = () => {
    const source = createCantorDemoProject()
    const demo = durableProject ? ProjectDocumentSchema.parse({
      ...source,
      metadata: { ...source.metadata, id: durableProject.projectId, title: project.metadata.title, createdAt: project.metadata.createdAt, updatedAt: project.metadata.updatedAt },
    }) : source
    if (commitDocument(demo, 'Reset to preloaded demo')) { selectShot(demo.shots[0]); setPlayhead(INITIAL_DEMO_PLAYHEAD); setCritique(null) }
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
      if (requestId !== importRequestSequence.current) return
      if (projectRevisionRef.current !== baseRevision) {
        setImportError('The project changed while the import was being read. Select the file again.')
        return
      }
      if (commitDocument(loaded, `Import ${file.name}`)) { selectShot(loaded.shots[0]); setCritique(null); setImportError(''); setStatus(`Imported ${file.name}`) }
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
    if (utilityDialog) { setUtilityDialog(null); return }
    if (exportPreview) { setExportPreview(null); return }
    if (commandPaletteOpen) { setCommandPaletteOpen(false); setCommandSearch(''); return }
    if (ownerMenuOpen) { setOwnerMenuOpen(false); ownerMenuTriggerRef.current?.focus(); return }
    if (assistantOpen) { setAssistantOpen(false); return }
    if (timelineGesture || timelineDraft) { setTimelineGesture(null); setTimelineDraft(null); return }
    if (proposal) { setProposal(null); setProposalBase(null); return }
    if (recoveryOpen) { setRecoveryOpen(false); return }
    if (rendererMessage || importError) { setRendererMessage(''); setImportError(''); return }
    const next = shotSelection([shot.id])
    selectionRef.current = next
    setSelection(next)
    setStatus('Selection cleared')
  }, [assistantOpen, commandPaletteOpen, exportPreview, importError, ownerMenuOpen, proposal, recoveryOpen, rendererMessage, shot.id, timelineDraft, timelineGesture, utilityDialog])

  const deleteContextSelection = useCallback(() => {
    if (selectedAnimation) { deleteTimelineAnimation(selectedAnimation); return }
    deleteSelection()
  }, [deleteSelection, selectedAnimation])

  const canExecuteEditorCommand = useCallback((id: EditorCommandId, invocation: { source: 'keyboard' | 'toolbar' | 'menu' | 'palette'; event?: KeyboardEvent; shiftKey: boolean }) => {
    const target = invocation.event?.target
    const insideDialog = commandTargetWithin(target ?? null, '[role="dialog"]')
    if (insideDialog && !['dismiss', 'save-project', 'open-command-palette', 'open-render-export'].includes(id)) return false
    if (id === 'undo') return canUndo(history)
    if (id === 'redo') return canRedo(history)
    if (id === 'delete-selection') return Boolean(selectedRootIds.length || selectedAnimation)
    if (id === 'duplicate-selection') return selectedRootIds.length > 0
    if (id === 'group-selection') return selectedRootIds.length > 1
    if (id === 'ungroup-selection') return selectedObjects.some(({ type }) => type === 'group')
    if (id.startsWith('nudge-')) {
      if (!selectedRootIds.length) return false
      return invocation.source !== 'keyboard' || commandTargetWithin(target ?? null, '[data-pc-canvas]')
    }
    return true
  }, [history, selectedAnimation, selectedObjects, selectedRootIds.length])

  const commandController = useMemo(() => createEditorCommandController({
    'toggle-playback': togglePlayback,
    undo: undoHistory,
    redo: redoHistory,
    'delete-selection': deleteContextSelection,
    'duplicate-selection': duplicateSelection,
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
  }, canExecuteEditorCommand), [canExecuteEditorCommand, deleteContextSelection, dismissContext, duplicateSelection, groupSelection, nudge, redoHistory, saveProject, togglePlayback, undoHistory, ungroupSelection])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { commandController.handleKeyboard(event) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commandController])

  const normalizedLibrarySearch = librarySearch.trim().toLowerCase()
  const visibleObjectTypes = OBJECT_TYPES.filter((item) => item.tab === libraryTab && (!normalizedLibrarySearch || `${item.label} ${item.keywords}`.includes(normalizedLibrarySearch)))
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

  return (
    <main className="proofcanvas-app" role="application" aria-label="ProofCanvas editor" aria-busy={leavePending} data-testid="proofcanvas-editor" data-pc-editor data-project-id={project.metadata.id} data-schema-version={project.schemaVersion} data-active-shot-id={shot.id} data-selection-kind={selection.kind} data-history-past-count={history.past.length} data-history-future-count={history.future.length} data-durable={durableProject ? 'true' : 'false'} data-server-revision={durableProject ? serverRevision : undefined} data-save-state={durableProject ? saveState : undefined} data-left-collapsed={leftPanelCollapsed ? 'true' : 'false'} data-right-collapsed={rightPanelCollapsed ? 'true' : 'false'} data-timeline-collapsed={timelineCollapsed ? 'true' : 'false'} style={{ '--pc-left-width': leftPanelCollapsed ? '0px' : `${leftPanelWidth}px`, '--pc-right-width': rightPanelCollapsed ? '0px' : `${rightPanelWidth}px`, '--pc-timeline-height': timelineCollapsed ? '42px' : `${timelineHeight}px` } as CSSProperties}>
      <div className="pc-desktop-notice" aria-label="Desktop viewport required"><strong>A wider workspace is required</strong><span>ProofCanvas is a desktop editor. Use a viewport at least 1024 px wide; your project remains safely autosaved.</span></div>
      <header className="pc-header" aria-label="Project actions">
        <a href="/" className="pc-back-link" aria-label="Back to projects" aria-disabled={leavePending} onClick={(event) => { event.preventDefault(); void guardedLeave('/') }}>←</a>
        <div className="pc-wordmark"><span aria-hidden="true">∴</span><h1>ProofCanvas</h1></div>
        <label className="pc-project-title"><span className="pc-visually-hidden">Project title</span><input aria-label="Project title" key={`${project.metadata.id}-${project.metadata.title}`} defaultValue={project.metadata.title} maxLength={160} onFocus={selectProjectContext} onBlur={(event) => commitTextInput(event, project.metadata.title, 'Project title', renameProject, { trim: true, required: true })}/>{durableProject ? <small role="status" aria-label="Autosave status" data-save-state={saveState}>{saveState === 'saved' ? `Saved · r${serverRevision}` : saveState === 'waiting' ? 'Autosave queued' : saveState === 'saving' ? 'Saving…' : saveState === 'conflict' ? 'Save conflict' : 'Offline · retry'}</small> : <small role="status" aria-label="Autosave status">Local project</small>}</label>
        <div className="pc-history-actions">
          <button type="button" onClick={() => commandController.execute('undo')} disabled={!canUndo(history)} aria-label="Undo" title="Undo · Ctrl/Cmd Z">↶</button>
          <button type="button" onClick={() => commandController.execute('redo')} disabled={!canRedo(history)} aria-label="Redo" title="Redo · Ctrl/Cmd Shift Z">↷</button>
        </div>
        <label className="pc-quality">Preview<span className="pc-visually-hidden"> quality</span><select aria-label="Preview quality" value={project.settings.previewQuality} onChange={(event) => updateProjectSettings({ previewQuality: event.target.value as ProjectDocument['settings']['previewQuality'] })}><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select></label>
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
          {(['text', 'math', 'shapes', 'graphs'] as LibraryTab[]).includes(libraryTab) && <div className="pc-insert-grid">{visibleObjectTypes.map(({ type, label }) => <button key={type} type="button" onClick={() => insertObject(type)} aria-label={`Add ${label}`} data-object-type={type}><span aria-hidden="true">{type === 'text' ? 'T' : type === 'math' ? '∑' : type === 'brace' ? '⏟' : type === 'circle' ? '○' : type === 'rectangle' ? '□' : type === 'line' ? '—' : type === 'arrow' ? '→' : type === 'axes' ? '⌗' : 'ƒ'}</span><b>{label}</b></button>)}{visibleObjectTypes.length === 0 && <p className="pc-library-empty" role="status">No {libraryTab} items match “{librarySearch}”.</p>}</div>}
          {libraryTab === 'components' && <div className="pc-component-list">{visibleComponents.map((component) => { const labels: Record<SemanticComponentId, string> = { 'mathematical-title': 'Insert mathematical title', 'proposition-statement': 'Insert proposition or definition', 'equation-chain': 'Insert equation chain', 'annotated-diagram': 'Insert annotated diagram', 'focus-callout': 'Insert focus callout', 'recursive-intervals': 'Insert recursive interval construction' }; return <button key={component.id} type="button" onClick={() => insertComponent(component.id)} title={component.description} aria-label={labels[component.id]} data-component-id={component.id}><b>{component.name}</b><small>{component.description}</small></button> })}{visibleComponents.length === 0 && <p className="pc-library-empty" role="status">No components match “{librarySearch}”.</p>}</div>}
          {libraryTab === 'styles' && <div className="pc-style-library" role="radiogroup" aria-label="Library output styles"><button type="button" role="radio" aria-checked={project.activeStyleId === EDITORIAL_INK_STYLE_ID} tabIndex={project.activeStyleId === EDITORIAL_INK_STYLE_ID ? 0 : -1} data-style-surface="library" data-style-id={EDITORIAL_INK_STYLE_ID} onKeyDown={(event) => navigateStyleRadios(event, EDITORIAL_INK_STYLE_ID, 'library')} onClick={() => selectOutputStyle(EDITORIAL_INK_STYLE_ID, 'Editorial Ink')}><i data-style-swatch="editorial"/><span><b>Editorial Ink</b><small>Warm restrained proof-film system</small></span></button><button type="button" role="radio" aria-checked={project.activeStyleId === RAW_MANIM_STYLE_ID} tabIndex={project.activeStyleId === RAW_MANIM_STYLE_ID ? 0 : -1} data-style-surface="library" data-style-id={RAW_MANIM_STYLE_ID} onKeyDown={(event) => navigateStyleRadios(event, RAW_MANIM_STYLE_ID, 'library')} onClick={() => selectOutputStyle(RAW_MANIM_STYLE_ID, 'Raw Manim')}><i data-style-swatch="raw"/><span><b>Raw Manim</b><small>Direct geometric defaults</small></span></button></div>}
        </section>
        <section className="pc-layer-section"><div className="pc-section-heading"><h2>Layers</h2><span>{shot.objects.length}</span></div>
          <div className="pc-layer-actions" aria-label="Layer actions">
            <button type="button" onClick={() => commandController.execute('duplicate-selection')} disabled={!selectedRootIds.length} aria-label="Duplicate selection">Duplicate</button><button type="button" onClick={() => commandController.execute('delete-selection')} disabled={!selectedRootIds.length} aria-label="Delete selection">Delete</button><button type="button" onClick={() => commandController.execute('group-selection')} disabled={selectedRootIds.length < 2} aria-label="Group selection">Group</button><button type="button" onClick={() => commandController.execute('ungroup-selection')} disabled={!selectedObjects.some(({ type }) => type === 'group')} aria-label="Ungroup selection">Ungroup</button>
            <button type="button" onClick={() => reorderLayer('front')} disabled={!primary || primarySiblingIndex >= primarySiblings.length - 1} aria-label="Bring to front">To front</button><button type="button" onClick={() => reorderLayer('forward')} disabled={!primary || primarySiblingIndex >= primarySiblings.length - 1} aria-label="Bring forward">Forward</button><button type="button" onClick={() => reorderLayer('backward')} disabled={!primary || primarySiblingIndex <= 0} aria-label="Send backward">Backward</button><button type="button" onClick={() => reorderLayer('back')} disabled={!primary || primarySiblingIndex <= 0} aria-label="Send to back">To back</button>
          </div>
          <div role="tree" aria-label="Objects" aria-multiselectable="true" className="pc-layer-tree">{shot.objects.map((object, index) => { const effectivelyLocked = Boolean(effectiveLockOwner(shot, object)); const visibilityOwner = effectiveVisibilityOwner(shot, object); const visibilityLabel = !visibilityOwner ? 'Visible' : visibilityOwner.id === object.id ? 'Hidden' : `Hidden by ${visibilityOwner.name}`; const lockLabel = effectivelyLocked ? object.locked ? '; Locked' : '; Locked by parent' : ''; return <button key={object.id} type="button" role="treeitem" aria-label={`${object.name}; ${visibilityLabel}${lockLabel}`} aria-selected={selectedRootIds.includes(object.id)} aria-level={descendants(shot, object.id) + 1} tabIndex={selectedRootIds.at(-1) === object.id || (!selectedRootIds.length && index === 0) ? 0 : -1} onKeyDown={(event) => navigateLayerTree(event, index)} onClick={(event) => setSelectedIds(selectionRootIds(shot, event.shiftKey ? selectedRootIds.includes(object.id) ? selectedRootIds.filter((id) => id !== object.id) : [...selectedRootIds, object.id] : [object.id]))} style={{ paddingLeft: 10 + descendants(shot, object.id) * 14 }} data-layer-object-id={object.id} data-locked={effectivelyLocked} data-visibility={visibilityOwner ? visibilityOwner.id === object.id ? 'hidden' : 'inherited-hidden' : 'visible'}><span aria-hidden="true">{visibilityOwner ? visibilityOwner.id === object.id ? '○' : '⊘' : '◉'}</span><span>{object.name}</span>{effectivelyLocked && <span aria-hidden="true">⌑</span>}</button> })}</div>
        </section>
      </aside>

      <section className="pc-canvas-area" aria-label="Canvas workspace">
        <div className="pc-canvas-toolbar">
          <div className="pc-panel-toggles"><button type="button" onClick={() => setLeftPanelCollapsed((value) => !value)} aria-pressed={!leftPanelCollapsed} aria-label={leftPanelCollapsed ? 'Show library panel' : 'Hide library panel'}>Library</button><span>{project.settings.aspectRatio} · {project.settings.resolution.width}×{project.settings.resolution.height}</span></div>
          <div role="radiogroup" aria-label="Active output style" className="pc-canvas-style">
            <label><input type="radio" name="preview-style" value={EDITORIAL_INK_STYLE_ID} checked={project.activeStyleId === EDITORIAL_INK_STYLE_ID} tabIndex={project.activeStyleId === EDITORIAL_INK_STYLE_ID ? 0 : -1} data-style-surface="canvas" data-style-id={EDITORIAL_INK_STYLE_ID} onKeyDown={(event) => navigateStyleRadios(event, EDITORIAL_INK_STYLE_ID, 'canvas')} onChange={() => selectOutputStyle(EDITORIAL_INK_STYLE_ID, 'Editorial Ink')}/>Editorial Ink</label>
            <label><input type="radio" name="preview-style" value={RAW_MANIM_STYLE_ID} checked={project.activeStyleId === RAW_MANIM_STYLE_ID} tabIndex={project.activeStyleId === RAW_MANIM_STYLE_ID ? 0 : -1} data-style-surface="canvas" data-style-id={RAW_MANIM_STYLE_ID} onKeyDown={(event) => navigateStyleRadios(event, RAW_MANIM_STYLE_ID, 'canvas')} onChange={() => selectOutputStyle(RAW_MANIM_STYLE_ID, 'Raw Manim')}/>Raw Manim</label>
          </div>
          <div className="pc-align-actions" aria-label="Alignment actions">
            {(['left','center-x','right','top','center-y','bottom'] as const).map((value) => { const labels = { left: 'Align left', 'center-x': 'Align horizontal centres', right: 'Align right', top: 'Align top', 'center-y': 'Align vertical centres', bottom: 'Align bottom' }; return <button type="button" key={value} onClick={() => align(value)} disabled={selectedRootIds.length < 2} aria-label={labels[value]}>{value.replace('center-', 'mid ')}</button> })}
            <button type="button" onClick={() => distribute('horizontal')} disabled={selectedRootIds.length < 3} aria-label="Distribute horizontally">Distribute H</button><button type="button" onClick={() => distribute('vertical')} disabled={selectedRootIds.length < 3} aria-label="Distribute vertically">Distribute V</button>
          </div>
          <button type="button" onClick={() => setRightPanelCollapsed((value) => !value)} aria-pressed={!rightPanelCollapsed} aria-label={rightPanelCollapsed ? 'Show inspector panel' : 'Hide inspector panel'}>Inspector</button>
        </div>
        <IsolatedCanvasStage clock={playbackClockRef.current} isPlaying={isPlaying} pausedPlayhead={playhead} previewStyleId={previewStyle.id} project={project} projectRevision={projectRevision} shot={shot} previewStyle={previewStyle} previewQuality={project.settings.previewQuality} selectedIds={selectedRootIds} onSelect={(ids) => setSelectedIds(selectionRootIds(shot, ids))} onNotice={setStatus} onCommitTransforms={(updates, label) => commitOps(updates.map(({ objectId, transform }) => ({ type: 'update-object', objectId, patch: { transform } })), label)} onCommitKeyboardTransform={commitCanvasKeyboardTransform}/>
        <p className="pc-status" role="status" aria-label="Editor status">{status}</p>
      </section>

      <aside className="pc-right" aria-label="Inspector and intelligence tools">
        <header className="pc-inspector-context"><div><span>{selection.kind === 'objects' ? primary?.type === 'group' ? 'Group' : selectedObjects.length > 1 ? `${selectedObjects.length} objects` : 'Object' : selection.kind === 'animation' ? 'Animation' : selection.kind === 'keyframes' ? 'Keyframe' : selection.kind === 'project' ? 'Project' : 'Shot'}</span><h2>{primary?.name ?? selectedAnimation?.type ?? (selection.kind === 'project' ? project.metadata.title : shot.name)}</h2></div><button type="button" onClick={() => setRightPanelCollapsed(true)} aria-label="Collapse inspector panel">›</button></header>
        {primary && <form className="pc-inspector" aria-label={primary.type === 'group' ? 'Group inspector' : 'Object inspector'} data-inspector-object-id={primary.id} onSubmit={(event) => event.preventDefault()}><div className="pc-section-heading"><h2>{primary.type === 'group' ? 'Group properties' : 'Object properties'}</h2><button type="button" onClick={toggleLock} disabled={primaryInheritedLocked}>{primaryInheritedLocked ? 'Locked by parent' : primary.locked ? 'Unlock' : 'Lock'}</button></div>
          <div className="pc-field-grid"><p className="pc-wide pc-inspector-note">Base-pose properties. Timeline blocks may animate this geometry at the current playhead.</p>
            {primary.type === 'group' && primaryFamilyLocked && !primaryEffectivelyLocked && <p className="pc-wide pc-inspector-note" role="status">This group contains a locked descendant. Geometry and visibility controls are disabled until the family is unlocked.</p>}
            <label className="pc-wide">Name<input aria-label="Name" defaultValue={primary.name} key={`${primary.id}-name-${primary.name}`} disabled={primaryEffectivelyLocked} onBlur={(event) => commitTextInput(event, primary.name, 'Object name', (value) => commitPatch({ name: value }, 'Rename object'), { trim: true, required: true })}/></label>
            {TRANSFORM_NUMERIC_FIELDS.filter((definition) => (primary.type !== 'circle' || definition.key !== 'rotation') && (!['line', 'arrow'].includes(primary.type) || definition.key !== 'height')).map((definition) => { const key = definition.key as 'x' | 'y' | 'width' | 'height' | 'rotation'; const value = primary.transform[key] ?? (key === 'width' ? 60 : key === 'height' ? 30 : 0); const field = { ...definition, fallback: value }; return <label key={key}>{field.label}<input key={`${primary.id}-${key}-${value}`} type="number" min={field.min} max={field.max} step="0.1" aria-label={field.label} defaultValue={value} disabled={primaryFamilyLocked} onBlur={(event) => commitNumericInput(event, field, value, (next) => commitPatch({ transform: { [key]: next } }, `Set ${field.label.toLowerCase()}`))}/></label> })}
            {primary.type !== 'group' && <label>Opacity<input key={`${primary.id}-opacity-${primary.style.opacity ?? 1}`} type="number" min="0" max="1" step="0.05" aria-label="Opacity" defaultValue={primary.style.opacity ?? 1} disabled={primaryEffectivelyLocked} onBlur={(event) => { const value = primary.style.opacity ?? 1; commitNumericInput(event, { key: 'opacity', label: 'Opacity', fallback: value, min: 0, max: 1 }, value, (next) => commitPatch({ style: { opacity: next } }, 'Set opacity')) }}/></label>}
            {(primary.type === 'text' || primary.type === 'math' || primary.type === 'brace') && <label>Font size<input key={`${primary.id}-font-size-${primary.style.fontSize ?? 22}`} type="number" min="8" max="144" aria-label="Font size" defaultValue={primary.style.fontSize ?? 22} disabled={primaryEffectivelyLocked} onBlur={(event) => { const value = primary.style.fontSize ?? 22; commitNumericInput(event, { key: 'fontSize', label: 'Font size', fallback: value, min: 8, max: 144 }, value, (next) => commitPatch({ style: { fontSize: next } }, 'Set font size')) }}/></label>}
            {(primary.type === 'text' || primary.type === 'math') && <label className="pc-wide">Content<textarea aria-label="Content" rows={3} maxLength={primary.type === 'math' ? PROOFCANVAS_LATEX_MAX_CHARS : PROOFCANVAS_TEXT_MAX_CHARS} defaultValue={String(primary.properties.content ?? '')} key={`${primary.id}-content-${String(primary.properties.content ?? '')}`} disabled={primaryEffectivelyLocked} onBlur={(event) => { const current = String(primary.properties.content ?? ''); commitTextInput(event, current, 'Content', (value) => commitPatch({ properties: { content: value } }, 'Edit content')) }}/></label>}
            {primary.type === 'brace' && <label className="pc-wide">Brace label<input aria-label="Brace label" maxLength={PROOFCANVAS_BRACE_LABEL_MAX_CHARS} defaultValue={String(primary.properties.label ?? '')} key={`${primary.id}-label-${String(primary.properties.label ?? '')}`} disabled={primaryEffectivelyLocked} onBlur={(event) => { const current = String(primary.properties.label ?? ''); commitTextInput(event, current, 'Brace label', (value) => commitPatch({ properties: { label: value } }, 'Edit brace label')) }}/></label>}
            {(primary.type === 'image' || primary.type === 'svg') && <label className="pc-wide">Asset source<input aria-label="Asset source" defaultValue={String(primary.properties.source ?? '')} key={`${primary.id}-source-${String(primary.properties.source ?? '')}`} disabled={primaryEffectivelyLocked} onBlur={(event) => { const current = String(primary.properties.source ?? ''); commitTextInput(event, current, 'Asset source', (value) => commitPatch({ properties: { source: value } }, 'Edit asset source'), { trim: true, required: true }) }}/></label>}
            {(primary.type === 'axes' || primary.type === 'graph') && (['xMin', 'xMax'] as const).map((key) => { const label = key === 'xMin' ? 'X minimum' : 'X maximum'; const value = Number(primary.properties[key]); const field = { key, label, fallback: value, min: -PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude }; return <label key={key}>{label}<input key={`${primary.id}-${key}-${String(primary.properties[key])}`} type="number" min={field.min} max={field.max} aria-label={label} defaultValue={value} disabled={primaryEffectivelyLocked} onBlur={(event) => commitNumericInput(event, field, value, (next) => commitPatch({ properties: { [key]: next } }, `Set ${key}`))}/></label> })}
            {primary.type === 'axes' && (['yMin', 'yMax'] as const).map((key) => { const label = key === 'yMin' ? 'Y minimum' : 'Y maximum'; const value = Number(primary.properties[key]); const field = { key, label, fallback: value, min: -PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude }; return <label key={key}>{label}<input key={`${primary.id}-${key}-${String(primary.properties[key])}`} type="number" min={field.min} max={field.max} aria-label={label} defaultValue={value} disabled={primaryEffectivelyLocked} onBlur={(event) => commitNumericInput(event, field, value, (next) => commitPatch({ properties: { [key]: next } }, `Set ${key}`))}/></label> })}
            {(primary.type === 'axes' || primary.type === 'graph') && <p className="pc-wide pc-inspector-note">The browser graph is schematic. Ranges and expressions are authoritative in Manim export and render.</p>}
            {['text', 'math', 'brace'].includes(primary.type) && <label>Color<input key={`${primary.id}-color-${primary.style.color ?? previewStyle.colors.ink}`} type="color" aria-label="Color" defaultValue={primary.style.color ?? previewStyle.colors.ink} disabled={primaryEffectivelyLocked} onBlur={(event) => { const current = primary.style.color ?? previewStyle.colors.ink; if (event.target.value !== current) commitPatch({ style: { color: event.target.value } }, 'Set color') }}/></label>}
            {primary.type === 'rectangle' && <label>Fill<input key={`${primary.id}-fill-${primary.style.fill ?? previewStyle.colors.ink}`} type="color" aria-label="Fill" defaultValue={primary.style.fill ?? previewStyle.colors.ink} disabled={primaryEffectivelyLocked} onBlur={(event) => { const current = primary.style.fill ?? previewStyle.colors.ink; if (event.target.value !== current) commitPatch({ style: { fill: event.target.value } }, 'Set fill') }}/></label>}
            {primary.type === 'circle' && primary.style.fill === undefined && <button type="button" className="pc-field-action" disabled={primaryEffectivelyLocked} onClick={() => commitPatch({ style: { fill: previewStyle.colors.background } }, 'Add circle fill')}>Add fill</button>}
            {primary.type === 'circle' && primary.style.fill !== undefined && <label>Fill<input key={`${primary.id}-fill-${primary.style.fill}`} type="color" aria-label="Fill" defaultValue={primary.style.fill} disabled={primaryEffectivelyLocked} onBlur={(event) => { if (event.target.value !== primary.style.fill) commitPatch({ style: { fill: event.target.value } }, 'Set fill') }}/></label>}
            {['circle', 'rectangle', 'line', 'arrow', 'brace', 'axes', 'graph'].includes(primary.type) && <label>Stroke<input key={`${primary.id}-stroke-${primary.style.stroke ?? previewStyle.colors.ink}`} type="color" aria-label="Stroke" defaultValue={primary.style.stroke ?? previewStyle.colors.ink} disabled={primaryEffectivelyLocked} onBlur={(event) => { const current = primary.style.stroke ?? previewStyle.colors.ink; if (event.target.value !== current) commitPatch({ style: { stroke: event.target.value } }, 'Set stroke') }}/></label>}
            <label className="pc-check"><input type="checkbox" aria-label={primaryInheritedHidden ? `Visible locally; hidden by ${primaryVisibilityOwner?.name}` : 'Visible'} checked={primary.visible} disabled={primaryFamilyLocked} onChange={(event) => commitPatch({ visible: event.target.checked }, 'Toggle visibility')}/>{primaryInheritedHidden ? `Visible locally — hidden by ${primaryVisibilityOwner?.name}` : 'Visible'}</label>
            <label className="pc-check"><input type="checkbox" aria-label="Locked" checked={primary.locked} disabled={primaryInheritedLocked} onChange={toggleLock}/>Locked</label>
          </div>
        </form>}

        {selectedAnimation && <section className="pc-animation-inspector pc-contextual-animation" aria-label="Animation inspector">
          <div className="pc-section-heading"><h2>Timing and motion</h2>{selectedAnimationLocked && <span>Locked target</span>}</div>
          {selectedAnimation.type === 'transform' && selectedAnimation.targetIds.length > 1 && <span className="pc-animation-lock-note" role="status">Split this legacy multi-target transform before editing absolute geometry.</span>}
          <label>Start<input type="number" min="0" max={subtractTimelineTimes(shot.duration, selectedAnimation.duration)} step="0.1" aria-label="Start time" defaultValue={selectedAnimation.start} key={`${selectedAnimation.id}-start-${selectedAnimation.start}`} disabled={selectedAnimationLocked || selectedAnimationCompatibilityUnsupported} onBlur={(event) => commitNumericInput(event, { key: 'start', label: 'Start time', fallback: selectedAnimation.start, min: 0, max: subtractTimelineTimes(shot.duration, selectedAnimation.duration) }, selectedAnimation.start, (next) => updateAnimation({ start: next }, 'Set animation start'))}/></label>
          <label>Duration<input type="number" min="0.1" max={subtractTimelineTimes(shot.duration, selectedAnimation.start)} step="0.1" aria-label="Duration" defaultValue={selectedAnimation.duration} key={`${selectedAnimation.id}-duration-${selectedAnimation.duration}`} disabled={selectedAnimationLocked || selectedAnimationCompatibilityUnsupported} onBlur={(event) => commitNumericInput(event, { key: 'duration', label: 'Duration', fallback: selectedAnimation.duration, min: 0.1, max: subtractTimelineTimes(shot.duration, selectedAnimation.start) }, selectedAnimation.duration, (next) => updateAnimation({ duration: next }, 'Set animation duration'))}/></label>
          <label>Easing<select aria-label="Easing" value={selectedAnimation.easing} disabled={selectedAnimationLocked && !selectedEmphasisUnsupported && !selectedEntranceThereBackUnsupported} onChange={(event) => updateAnimation({ easing: event.target.value as Easing }, 'Set animation easing')}>{(selectedAnimation.type === 'emphasise' ? ['there-and-back'] : EASINGS.filter((easing) => easing !== 'there-and-back' || (selectedAnimation.type !== 'write' && selectedAnimation.type !== 'create'))).map((easing) => <option key={easing}>{easing}</option>)}{selectedEmphasisUnsupported && <option value={selectedAnimation.easing} disabled>{selectedAnimation.easing} (render unsupported)</option>}{selectedEntranceThereBackUnsupported && <option value="there-and-back" disabled>there-and-back (render unsafe)</option>}</select></label>
          {selectedAnimation.type === 'emphasise' && !selectedEmphasisUnsupported && <span className="pc-animation-lock-note" role="status">Emphasise uses a fixed there-and-back pulse.</span>}
          {selectedEmphasisUnsupported && <span className="pc-animation-lock-note" role="status">Saved legacy easing: choose there-and-back to repair rendering.</span>}
          {selectedEntranceThereBackUnsupported && <span className="pc-animation-lock-note" role="status">Write/Create there-and-back is unsafe in pinned Manim; choose another easing.</span>}
          {animationPropertyFields.map((field) => { const value = typeof selectedAnimation.properties[field.key] === 'number' ? Number(selectedAnimation.properties[field.key]) : field.fallback; return <label key={field.key}>{field.label}<input type="number" min={field.min} max={field.max} step="0.1" aria-label={field.label} defaultValue={value} key={`${selectedAnimation.id}-${field.key}-${String(selectedAnimation.properties[field.key])}`} disabled={selectedAnimationLocked || selectedAnimationCompatibilityUnsupported} onBlur={(event) => commitNumericInput(event, field, value, (next) => updateAnimation({ properties: { [field.key]: next } }, `Set ${field.label.toLowerCase()}`))}/></label> })}
          <button type="button" className="pc-danger-action" disabled={selectedAnimationLocked || selectedAnimationCompatibilityUnsupported} onClick={() => deleteTimelineAnimation(selectedAnimation)}>Delete animation</button>
        </section>}
        {!primary && !selectedAnimation && <section className="pc-context-summary" aria-label={selection.kind === 'project' ? 'Project inspector' : 'Shot inspector'}><div className="pc-section-heading"><h2>{selection.kind === 'project' ? 'Project' : 'Shot'}</h2><span>{selection.kind === 'project' ? project.settings.aspectRatio : `${shot.duration.toFixed(1)}s`}</span></div>{selection.kind === 'project' ? <><p>{project.shots.length} shots · {project.settings.frameRate} fps · {project.settings.resolution.width}×{project.settings.resolution.height}</p><button type="button" onClick={() => openUtilityDialog('settings')}>Open project settings</button></> : <><label>Name<input aria-label="Shot name" key={`inspector-${shot.id}-${shot.name}`} defaultValue={shot.name} onBlur={(event) => commitTextInput(event, shot.name, 'Shot name', (value) => editShot({ name: value }, 'Rename shot'), { trim: true, required: true })}/></label><label>Duration<input type="number" min={minimumShotDuration} max="300" step="0.5" aria-label="Shot duration" key={`inspector-${shot.id}-${shot.duration}`} defaultValue={shot.duration} onBlur={(event) => commitNumericInput(event, { key: 'shotDuration', label: 'Shot duration', fallback: shot.duration, min: minimumShotDuration, max: 300 }, shot.duration, (value) => editShot({ duration: value }, 'Set shot duration'))}/></label><div className="pc-context-actions"><button type="button" onClick={() => reorderShot(-1)} aria-label="Move shot earlier">Move earlier</button><button type="button" onClick={() => reorderShot(1)} aria-label="Move shot later">Move later</button></div><p>{shot.objects.length} layers · {shot.animations.length} animations</p></>}</section>}
      </aside>

      <section className="pc-shots" aria-label="Shot rail"><div className="pc-section-heading"><h2>Shots</h2><button type="button" onClick={addShot}>Add shot</button></div><div className="pc-shot-list" role="tablist" aria-label="Shots">{project.shots.map((candidate, index) => <button type="button" role="tab" key={candidate.id} className={candidate.id === shot.id ? 'active' : ''} data-shot-id={candidate.id} aria-selected={candidate.id === shot.id} tabIndex={candidate.id === shot.id ? 0 : -1} onKeyDown={(event) => navigateShotTabs(event, index)} onClick={() => selectShot(candidate)} aria-label={`Select shot ${candidate.name}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>{candidate.name}</strong><small>{candidate.duration.toFixed(1)}s</small></button>)}</div>
      </section>

      <section className="pc-timeline" role="region" aria-label="Animation timeline" data-shot-id={shot.id}><div className="pc-timeline-head"><div className="pc-transport" aria-label="Preview transport"><button type="button" onClick={() => jumpPlayhead(0)} aria-label="Jump to start">↤</button><button type="button" className="pc-play-button" onClick={togglePlayback} aria-label={isPlaying ? 'Pause preview' : 'Play preview'} aria-pressed={isPlaying}>{isPlaying ? '❚❚' : '▶'}</button><button type="button" onClick={() => jumpPlayhead(shot.duration)} aria-label="Jump to end">↦</button></div><h2>Timeline</h2><label>Animation<select aria-label="Animation type" value={animationType} disabled={isPlaying} onChange={(event) => setAnimationType(event.target.value as AnimationType)}>{ANIMATION_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label><button type="button" onClick={addAnimation} disabled={isPlaying}>Add animation</button><IsolatedPlayheadScrubber clock={playbackClockRef.current} isPlaying={isPlaying} pausedPlayhead={playhead} duration={shot.duration} onSeek={jumpPlayhead}/><button type="button" onClick={() => setTimelineCollapsed((value) => !value)} aria-expanded={!timelineCollapsed} aria-label={timelineCollapsed ? 'Expand timeline' : 'Collapse timeline'}>{timelineCollapsed ? 'Expand' : 'Collapse'}</button></div>
        <div ref={trackRef} className="pc-timeline-track" data-testid="timeline-track" onPointerMove={moveTimelineGesture} onPointerUp={endTimelineGesture} onPointerCancel={cancelTimelineGesture} onPointerDown={(event) => { if (event.target === event.currentTarget && trackRef.current) { const rect = trackRef.current.getBoundingClientRect(); jumpPlayhead(Math.max(0, Math.min(shot.duration, (event.clientX - rect.left) / rect.width * shot.duration))) } }}>
          <IsolatedTimelinePlayhead clock={playbackClockRef.current} isPlaying={isPlaying} pausedPlayhead={playhead} duration={shot.duration}/>{shot.animations.map((animation) => { const timing = timelineDraft?.id === animation.id ? timelineDraft : animation; const lane = animationLanes.get(animation.id) ?? 0; const targets = animation.targetIds.map((id) => shot.objects.find((object) => object.id === id)?.name ?? id).join(', '); const locked = animationTargetsLocked(shot, animation); const lockedNotice = () => { setSelectedAnimationId(animation.id); setStatus('This animation targets a locked object family; unlock it before editing the block.') }; return <button type="button" key={animation.id} className={`pc-animation-block ${selectedAnimationId === animation.id ? 'selected' : ''} ${locked ? 'locked' : ''}`} style={{ left: `${timing.start / shot.duration * 100}%`, width: `${Math.max(1.5, timing.duration / shot.duration * 100)}%`, top: `${8 + lane * 31}px` }} data-animation-id={animation.id} data-animation-type={animation.type} data-target-ids={animation.targetIds.join(' ')} data-timeline-lane={lane} data-start={timing.start} data-duration={timing.duration} data-locked={locked ? 'true' : 'false'} aria-disabled={locked} aria-label={`${animation.type} animation targeting ${targets}; ${locked ? 'locked' : 'drag the right edge to resize'}`} onKeyDown={(event) => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); deleteTimelineAnimation(animation) } }} onClick={() => setSelectedAnimationId(animation.id)} onPointerDown={(event) => { if (isPlaying) { event.stopPropagation(); setStatus('Pause preview before editing timeline blocks.'); return } if (locked) { event.stopPropagation(); lockedNotice(); return } beginTimelineGesture(event, animation, 'move') }}><span>{animation.type}</span><i aria-hidden="true" onPointerDown={(event) => { if (locked) { event.stopPropagation(); lockedNotice(); return } beginTimelineGesture(event, animation, 'resize') }}/></button> })}
        </div>
      </section>

      {commandPaletteOpen && <div ref={commandPaletteRef} className="pc-command-palette" role="dialog" aria-modal="true" aria-label="Command palette"><header><div><span>Command palette</span><h2>What would you like to do?</h2></div><button type="button" onClick={() => setCommandPaletteOpen(false)} aria-label="Close command palette">×</button></header><label><span className="pc-visually-hidden">Search commands</span><input ref={commandSearchRef} type="search" aria-label="Search commands" aria-controls="pc-editor-command-list" aria-activedescendant={activeCommandOptionId ?? undefined} placeholder="Search actions" value={commandSearch} onKeyDown={navigateCommandListbox} onChange={(event) => setCommandSearch(event.target.value)}/></label><div id="pc-editor-command-list" className="pc-command-list" role="listbox" aria-label="Editor commands" onKeyDown={navigateCommandListbox}>{aiCommandVisible && <button id="pc-command-option-ai" type="button" role="option" aria-selected={activeCommandOptionId === 'pc-command-option-ai'} onFocus={() => setActiveCommandOptionId('pc-command-option-ai')} onClick={() => { assistantTriggerRef.current = commandButtonRef.current; setCommandPaletteOpen(false); setAssistantOpen(true) }}><span>AI structured edit…</span><kbd>Review first</kbd></button>}{paletteCommands.map(({ command, id, disabled }) => <button id={id} type="button" role="option" aria-selected={activeCommandOptionId === id} key={command.id} disabled={disabled} onFocus={() => { if (!disabled) setActiveCommandOptionId(id) }} onClick={() => { if (commandController.execute(command.id, { source: 'palette', shiftKey: false })) setCommandPaletteOpen(false) }}><span>{command.label}</span><kbd>{command.shortcut.replace('Mod', 'Ctrl/Cmd')}</kbd></button>)}{paletteCommands.length === 0 && !aiCommandVisible && <p role="status">No commands match “{commandSearch}”.</p>}</div></div>}

      {utilityDialog && <div ref={utilityDialogRef} className="pc-utility-dialog" role="dialog" aria-modal="true" aria-label={utilityDialog === 'settings' ? 'Project settings' : utilityDialog === 'shortcuts' ? 'Keyboard shortcuts' : 'Render and export'}><header><div><span>{utilityDialog === 'render-export' ? 'Output' : 'Workspace'}</span><h2>{utilityDialog === 'settings' ? 'Project settings' : utilityDialog === 'shortcuts' ? 'Keyboard shortcuts' : 'Render and export'}</h2></div><button type="button" onClick={() => setUtilityDialog(null)} aria-label={`Close ${utilityDialog === 'settings' ? 'project settings' : utilityDialog === 'shortcuts' ? 'keyboard shortcuts' : 'render and export'}`}>×</button></header>
        {utilityDialog === 'settings' && <div className="pc-settings-dialog"><p>Output settings are authored project data. Aspect changes recenter only untouched default cameras and preserve authored geometry.</p><div className="pc-settings-grid"><label>Aspect ratio<select aria-label="Aspect ratio" value={project.settings.aspectRatio} onChange={(event) => updateProjectSettings({ aspectRatio: event.target.value as ProjectDocument['settings']['aspectRatio'] })}><option value="16:9">16:9 · landscape</option><option value="9:16">9:16 · portrait</option><option value="1:1">1:1 · square</option></select></label><label>Frame rate<select aria-label="Frame rate" value={project.settings.frameRate} onChange={(event) => updateProjectSettings({ frameRate: Number(event.target.value) as ProjectDocument['settings']['frameRate'] })}>{[15, 24, 30, 60].map((rate) => <option key={rate} value={rate}>{rate} fps</option>)}</select></label><label>Render preset<select aria-label="Render preset" value={project.settings.renderPreset} onChange={(event) => updateProjectSettings({ renderPreset: event.target.value as ProjectDocument['settings']['renderPreset'] })}><option value="draft">Draft</option><option value="720p">720p</option><option value="1080p">1080p</option></select></label><label>Preview quality<select aria-label="Settings preview quality" value={project.settings.previewQuality} onChange={(event) => updateProjectSettings({ previewQuality: event.target.value as ProjectDocument['settings']['previewQuality'] })}><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select></label></div><dl><div><dt>Logical frame</dt><dd>{logicalFrame.width} × {logicalFrame.height}</dd></div><div><dt>Output</dt><dd>{resolutionFor(project.settings.aspectRatio, project.settings.renderPreset).width} × {resolutionFor(project.settings.aspectRatio, project.settings.renderPreset).height}</dd></div></dl></div>}
        {utilityDialog === 'shortcuts' && <div className="pc-shortcut-dialog"><p>Ctrl on Windows/Linux and Command on macOS are shown together as Ctrl/Cmd. Native text editing wins inside fields except global Save, Commands, Render/Export, and Escape.</p>{(['Playback', 'Edit', 'Project', 'View'] as const).map((group) => <section key={group}><h3>{group}</h3><dl>{EDITOR_COMMANDS.filter((command) => command.group === group).map((command) => <div key={command.id}><dt>{command.label}</dt><dd><kbd>{command.shortcut.replace('Mod', 'Ctrl/Cmd')}</kbd></dd></div>)}</dl></section>)}</div>}
        {utilityDialog === 'render-export' && <div className="pc-output-dialog"><p>MP4 output is generated by the pinned Manim renderer. Technical exports are deterministic snapshots of the current project; unsupported assets or timeline features remain explicit compiler diagnostics.</p><label>Render quality<select aria-label="Render quality" value={renderQuality} onChange={(event) => setRenderQuality(event.target.value as ClientRenderJob['quality'])}><option value="preview">Preview · faster</option><option value="production">Production · final quality</option></select></label><div className="pc-output-summary"><span>{project.settings.aspectRatio}</span><span>{project.settings.resolution.width}×{project.settings.resolution.height}</span><span>{project.settings.frameRate} fps</span><span>{project.shots.length} shots</span></div><div className="pc-output-actions"><button type="button" onClick={exportJson} aria-label="Export project JSON">Project JSON<span>Portable structured source</span></button><button type="button" onClick={exportPython} aria-label="Export Manim Python">Manim Python<span>Inspect compiler output</span></button><button type="button" className="pc-primary" onClick={() => void startRender(renderQuality)} disabled={renderPending || renderJob?.status === 'pending' || renderJob?.status === 'running'} aria-label="Render MP4">{renderPending ? 'Submitting…' : renderJob?.status === 'pending' || renderJob?.status === 'running' ? 'Rendering…' : `Render ${renderQuality} MP4`}<span>Genuine pinned Manim job</span></button></div></div>}
      </div>}

      {assistantOpen && <aside ref={assistantRef} className="pc-assistant-drawer" role="dialog" aria-modal="false" aria-label="AI command drawer"><header><div><span>Assistant</span><h2>Structured edit</h2></div><button type="button" onClick={() => setAssistantOpen(false)} aria-label="Close AI command drawer">×</button></header><section className="pc-ai" role="region" aria-label="AI command" data-ai-provider={aiProvider}><p className="pc-demo-label">{aiProvider === 'configured-provider' ? 'OpenAI structured operations — server configured' : 'Deterministic demo interpreter — limited commands'}</p><div className="pc-presets">{REQUIRED_AI_COMMANDS.map((command, index) => <button type="button" key={command} onClick={() => void runAi(command)} aria-label={`Run AI preset ${index + 1}: ${command}`} title={command} disabled={aiPending}>{index + 1}</button>)}</div><label>Instruction<textarea aria-label="Describe the edit" value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={4}/></label><button type="button" className="pc-primary" onClick={() => void runAi()} aria-label="Propose edit" disabled={aiPending}>{aiPending ? 'Proposing…' : 'Propose edit'}</button>{aiError && <p className="pc-error" role="alert">{aiError}</p>}{proposal && <div className="pc-proposal" role="region" aria-label="Proposed changes"><strong>{proposal.intention}</strong><p>Validated against shot <code>{proposalBase?.shotId}</code>. Expand each operation to inspect exact before and after values.</p><ol>{proposalReviews.map((review, index) => <li key={`${proposal.operations[index]?.type}-${index}`} data-operation-kind={proposal.operations[index]?.type}><details><summary>{review.summary}</summary><pre>{review.details}</pre></details></li>)}</ol><div><button type="button" className="pc-primary" onClick={applyProposal}>Apply proposed changes</button><button type="button" onClick={() => { setProposal(null); setProposalBase(null); setCritique(null) }}>Discard proposed changes</button></div></div>}</section><section className="pc-critique" role="region" aria-label="Composition critique"><div className="pc-section-heading"><h2>Composition</h2><button type="button" onClick={() => setCritique({ issues: critiqueProject(project, { shotId: shot.id, proposedOperations: proposal?.operations }), revision: projectRevision, shotId: shot.id })}>Critique composition</button></div>{critique && <p className="pc-critique-provenance">Current revision · {shot.name}</p>}{critique && (critique.issues.length > 0 ? <ul>{critique.issues.map((item) => <li key={item.id} data-issue-kind={item.kind} data-object-ids={item.objectIds.join(' ')} data-severity={item.severity}><strong>{item.kind.replaceAll('-', ' ')}</strong><span>{item.explanation}</span><em>{item.proposedCorrection}</em></li>)}</ul> : <p className="pc-critique-clear" role="status">No deterministic composition issues found for this shot.</p>)}</section></aside>}

      {(rendererMessage || importError) && <div className="pc-message" role="alert"><p>{importError || rendererMessage}</p><button type="button" onClick={() => { setRendererMessage(''); setImportError('') }}>Dismiss</button></div>}
      {durableProject && saveMessage && <div className={`pc-save-message ${saveState === 'conflict' ? 'conflict' : ''}`} role={saveState === 'conflict' ? 'alert' : 'status'}><p>{saveMessage}</p>{(saveState === 'offline' || saveState === 'conflict') && <button type="button" onClick={() => saveState === 'conflict' ? window.location.reload() : void performDurableSave()}>{saveState === 'conflict' ? 'Reload durable project' : 'Retry autosave'}</button>}<button type="button" onClick={() => setSaveMessage('')} aria-label="Dismiss save message">×</button></div>}
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
      {exportPreview && <div ref={exportDialogRef} className="pc-export-dialog" role="dialog" aria-modal="true" aria-label={exportPreview.title}><header><h2>{exportPreview.title}</h2><button type="button" onClick={() => setExportPreview(null)} aria-label="Close export preview">×</button></header><div className="pc-export-body">{exportPreview.diagnostics && exportPreview.diagnostics.length > 0 && <section className="pc-export-diagnostics" aria-label="Compiler diagnostics"><h3>Compiler diagnostics</h3><ul>{exportPreview.diagnostics.map((diagnostic) => <li key={diagnostic}>{diagnostic}</li>)}</ul></section>}<pre tabIndex={0}>{exportPreview.contents}</pre></div></div>}
    </main>
  )
}
