'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import CanvasStage, { temporallyTransformsObject } from './CanvasStage'
import { REQUIRED_AI_COMMANDS, interpretDemoCommand, type AiProposal } from '@/lib/proofcanvas/ai'
import { compileManim } from '@/lib/proofcanvas/compiler'
import { SEMANTIC_COMPONENTS, insertSemanticComponent, type SemanticComponentId } from '@/lib/proofcanvas/components'
import { critiqueProject, type CritiqueIssue } from '@/lib/proofcanvas/critique'
import { ensureSessionCsrfToken } from '@/lib/proofcanvas/csrf.client'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { canRedo, canUndo, commitOperations, commitProject, createHistory, redo, undo, type ProjectHistory } from '@/lib/proofcanvas/history'
import { allocateId, collectProjectIds } from '@/lib/proofcanvas/ids'
import { applyOperations, duplicateObjects, effectiveLockOwner, effectiveVisibilityOwner } from '@/lib/proofcanvas/operations'
import { PROOFCANVAS_BRACE_LABEL_MAX_CHARS, PROOFCANVAS_LATEX_MAX_CHARS, PROOFCANVAS_PROJECT_MAX_BYTES, PROOFCANVAS_SCHEMA_LIMITS, PROOFCANVAS_TEXT_MAX_CHARS, ProjectDocumentSchema, SceneOperationSchema, canonicalProjectJson, cloneSerializable, parseProjectDocument, type AnimationType, type Easing, type ProjectDocument, type SceneAnimation, type SceneObject, type SceneOperation, type Shot } from '@/lib/proofcanvas/schema'
import { EDITORIAL_INK_STYLE_ID, RAW_MANIM_STYLE_ID, styleById } from '@/lib/proofcanvas/styles'

const STORAGE_KEY = 'proofcanvas_project_v1'
const recoveryStorageKey = (projectId: string) => `proofcanvas_recovery_${projectId}`
const OBJECT_TYPES: Array<{ type: Exclude<SceneObject['type'], 'group'>; label: string }> = [
  { type: 'text', label: 'text' }, { type: 'math', label: 'math' }, { type: 'circle', label: 'circle' },
  { type: 'rectangle', label: 'rectangle' }, { type: 'line', label: 'line' }, { type: 'arrow', label: 'arrow' },
  { type: 'brace', label: 'brace' }, { type: 'axes', label: 'coordinate axes' }, { type: 'graph', label: 'function graph' },
  { type: 'image', label: 'raster image' }, { type: 'svg', label: 'SVG' },
]
const ANIMATION_TYPES: AnimationType[] = ['appear', 'fade-in', 'fade-out', 'write', 'create', 'move', 'scale', 'transform', 'emphasise', 'camera-focus']
const EASINGS: Easing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'editorial', 'spring-soft']
const TIMELINE_LANE_COUNT = 4
const INITIAL_DEMO_PLAYHEAD = 6.8

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
  let cursor = project
  return proposal.operations.map((operation, index) => {
    const before = snapshotForReview(cursor, shotId, operation)
    try {
      cursor = applyOperations(cursor, shotId, [operation]).project
      const after = snapshotForReview(cursor, shotId, operation)
      const shot = cursor.shots.find(({ id }) => id === shotId)
      const objectIds = shot ? objectIdsForReview(shot, operation) : []
      const names = objectIds.map((id) => {
        const object = shot?.objects.find((candidate) => candidate.id === id)
        return object ? `${object.name} (${id})` : id
      })
      return {
        summary: `${proposal.summary[index] ?? operation.type}${names.length ? ` — ${names.join(', ')}` : ''}`,
        details: JSON.stringify({ operation, before, after }, null, 2),
      }
    } catch {
      return { summary: proposal.summary[index] ?? operation.type, details: JSON.stringify({ operation, before }, null, 2) }
    }
  })
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
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id))
  const laneEnds = Array.from({ length: TIMELINE_LANE_COUNT }, () => Number.NEGATIVE_INFINITY)
  const lanes = new Map<string, number>()
  for (const animation of timing) {
    let lane = laneEnds.findIndex((end) => end <= animation.start + Number.EPSILON)
    if (lane < 0) lane = laneEnds.reduce((earliest, end, index) => end < laneEnds[earliest] ? index : earliest, 0)
    lanes.set(animation.id, lane)
    laneEnds[lane] = Math.max(laneEnds[lane], animation.start + animation.duration)
  }
  return lanes
}

function newObject(type: Exclude<SceneObject['type'], 'group'>, id: string, index: number): SceneObject {
  const base: SceneObject = {
    id, type, name: `${type[0].toUpperCase()}${type.slice(1)} ${index}`, locked: false, visible: true,
    transform: { x: 430 + (index % 5) * 24, y: 235 + (index % 4) * 22, width: 150, height: 70, rotation: 0, scaleX: 1, scaleY: 1 },
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
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [activeShotId, setActiveShotId] = useState(startingProjectRef.current.shots[0].id)
  const [playhead, setPlayhead] = useState(initialProject ? 0 : INITIAL_DEMO_PLAYHEAD)
  const [libraryTab, setLibraryTab] = useState<'objects' | 'components'>('objects')
  const [animationType, setAnimationType] = useState<AnimationType>('fade-in')
  const [selectedAnimationId, setSelectedAnimationId] = useState<string | null>(null)
  const [timelineDraft, setTimelineDraft] = useState<{ id: string; start: number; duration: number } | null>(null)
  const [timelineGesture, setTimelineGesture] = useState<{ id: string; kind: 'move' | 'resize'; clientX: number; start: number; duration: number } | null>(null)
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
  const trackRef = useRef<HTMLDivElement | null>(null)
  const exportDialogRef = useRef<HTMLDivElement | null>(null)
  const exportTriggerRef = useRef<HTMLElement | null>(null)
  const aiRequestSequence = useRef(0)
  const importRequestSequence = useRef(0)
  const aiAbortController = useRef<AbortController | null>(null)
  const serverRevisionRef = useRef(serverRevision)
  const csrfTokenRef = useRef(csrfToken)
  const lastSavedCanonicalRef = useRef(canonicalProjectJson(startingProjectRef.current))
  const pendingSaveRef = useRef<PendingDurableSave | null>(null)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const saveConflictRef = useRef(false)
  const recoveryAppliedRef = useRef(false)

  serverRevisionRef.current = serverRevision
  csrfTokenRef.current = csrfToken

  const project = history.present
  const shot = project.shots.find(({ id }) => id === activeShotId) ?? project.shots[0]
  const previewStyle = styleById(project.styles, project.activeStyleId) ?? project.styles[0]
  const selectedRootIds = selectionRootIds(shot, selectedIds)
  const selectedObjects = selectedRootIds.map((id) => shot.objects.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object))
  const primary = selectedObjects.at(-1)
  const primaryEffectivelyLocked = primary ? Boolean(effectiveLockOwner(shot, primary)) : false
  const primaryFamilyIds = primary ? familyObjectIds(shot, [primary.id]) : []
  const primaryFamilyLocked = primaryFamilyIds.some((id) => Boolean(effectiveLockOwner(shot, id)))
  const primaryInheritedLocked = Boolean(primaryEffectivelyLocked && primary && !primary.locked)
  const primaryVisibilityOwner = primary ? effectiveVisibilityOwner(shot, primary) : undefined
  const primaryInheritedHidden = Boolean(primary && primaryVisibilityOwner && primaryVisibilityOwner.id !== primary.id)
  const selectedAnimation = shot.animations.find(({ id }) => id === selectedAnimationId) ?? null
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

  const performDurableSave = useCallback(async (): Promise<boolean> => {
    if (!durableProject) return true
    if (saveConflictRef.current) return false
    if (savePromiseRef.current) return savePromiseRef.current
    const run = async () => {
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
    }
    const promise = run()
    savePromiseRef.current = promise
    try {
      return await promise
    } finally {
      savePromiseRef.current = null
      if (!saveConflictRef.current && !pendingSaveRef.current && projectRevisionRef.current !== lastSavedCanonicalRef.current) {
        window.setTimeout(() => { void performDurableSave() }, 0)
      }
    }
  }, [durableMutation, durableProject])
  const renderRepresentsCurrentProject = Boolean(renderJob && renderBaseRevision === projectRevision)
  const aiContextKey = `${projectRevision}\u0000${shot.id}`
  const aiContextRef = useRef(aiContextKey)
  const proposalReviews = useMemo(() => proposal ? reviewOperations(project, shot.id, proposal) : [], [project, proposal, shot.id])
  const animationLanes = useMemo(() => timelineLaneMap(shot.animations, timelineDraft), [shot.animations, timelineDraft])
  const minimumShotDuration = Math.max(1, ...shot.animations.map((animation) => animation.start + animation.duration))
  const lockedAnimationCount = project.shots.reduce((count, candidateShot) => count + candidateShot.animations.filter((animation) => animationTargetsLocked(candidateShot, animation)).length, 0)
  const coordinateBounds = { min: -PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationCoordinateMagnitude }
  const signedScaleBounds = { min: -PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude, minMagnitude: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude }
  const animationPropertyFields: NumericField[] = !selectedAnimation ? []
    : selectedAnimation.type === 'move' ? [
      ...(selectedAnimation.targetIds.length > 1 ? [
        { key: 'deltaX', label: 'Horizontal move', fallback: 0, ...coordinateBounds },
        { key: 'deltaY', label: 'Vertical move', fallback: 0, ...coordinateBounds },
      ] : [
        { key: 'x', label: 'Target X', fallback: selectedAnimationTarget?.transform.x ?? 480, ...coordinateBounds },
        { key: 'y', label: 'Target Y', fallback: selectedAnimationTarget?.transform.y ?? 270, ...coordinateBounds },
      ]),
    ] : selectedAnimation.type === 'scale' || selectedAnimation.type === 'emphasise' ? [
      selectedAnimation.type === 'emphasise'
        ? { key: 'scale', label: 'Scale amount', fallback: 1.08, min: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMinMagnitude, max: PROOFCANVAS_SCHEMA_LIMITS.animationScaleMaxMagnitude }
        : { key: 'scale', label: 'Scale amount', fallback: 1.15, ...signedScaleBounds },
    ] : selectedAnimation.type === 'transform' && selectedAnimation.targetIds.length === 1 ? [
      { key: 'x', label: 'Target X', fallback: selectedAnimationTarget?.transform.x ?? 480, ...coordinateBounds },
      { key: 'y', label: 'Target Y', fallback: selectedAnimationTarget?.transform.y ?? 270, ...coordinateBounds },
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
    if (!durableProject || saveConflictRef.current) return
    if (projectRevision === lastSavedCanonicalRef.current && !pendingSaveRef.current) {
      setSaveState('saved')
      return
    }
    try { window.localStorage.setItem(recoveryStorageKey(durableProject.projectId), projectRevision) }
    catch { /* Durable autosave remains authoritative; browser recovery is best-effort. */ }
    setSaveState((current) => current === 'saving' ? current : 'waiting')
    const timeout = window.setTimeout(() => { void performDurableSave() }, 800)
    return () => window.clearTimeout(timeout)
  }, [durableProject, performDurableSave, projectRevision])

  useEffect(() => {
    if (shot.id !== activeShotId) setActiveShotId(shot.id)
    setPlayhead((value) => Math.min(value, shot.duration))
    setSelectedIds((ids) => ids.filter((id) => shot.objects.some((object) => object.id === id)))
  }, [activeShotId, shot])

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
      const next = commitOperations(history, shot.id, operations, label)
      setHistory(next)
      setStatus(next === history ? 'No project values changed' : label)
      if (next !== history) invalidateAiContext()
      setAiError('')
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The edit could not be applied')
      return false
    }
  }, [history, invalidateAiContext, shot.id])

  const commitDocument = useCallback((document: ProjectDocument, label: string) => {
    try {
      const next = commitProject(history, ProjectDocumentSchema.parse(document), label)
      setHistory(next)
      setStatus(next === history ? 'No project values changed' : label)
      if (next !== history) invalidateAiContext()
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The project change was invalid')
      return false
    }
  }, [history, invalidateAiContext])

  const insertObject = (type: Exclude<SceneObject['type'], 'group'>) => {
    const ids = collectProjectIds(project)
    const object = newObject(type, allocateId('object', ids, type), shot.objects.length + 1)
    if (commitOps([{ type: 'add-object', object }], `Insert ${type}`)) setSelectedIds([object.id])
  }

  const insertComponent = (componentId: SemanticComponentId) => {
    try {
      const before = new Set(shot.objects.map(({ id }) => id))
      const next = insertSemanticComponent(project, shot.id, componentId, { x: 490, y: 275 })
      if (commitDocument(next, `Insert ${componentId}`)) setSelectedIds(next.shots.find(({ id }) => id === shot.id)!.objects.filter(({ id }) => !before.has(id)).map(({ id }) => id))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Component insertion failed')
    }
  }

  const duplicateSelection = useCallback(() => {
    if (!selectedRootIds.length) return setStatus('Select an object to duplicate')
    try {
      const before = new Set(shot.objects.map(({ id }) => id))
      const result = duplicateObjects(project, shot.id, selectedRootIds)
      if (commitDocument(result.project, 'Duplicate selection')) setSelectedIds(result.project.shots.find(({ id }) => id === shot.id)!.objects.filter(({ id }) => !before.has(id)).map(({ id }) => id))
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Duplicate failed') }
  }, [commitDocument, project, selectedRootIds, shot])

  const deleteSelection = useCallback(() => {
    if (!selectedRootIds.length) return setStatus('Select an object to delete')
    if (commitOps(selectedRootIds.map((objectId) => ({ type: 'delete-object', objectId })), 'Delete selection')) setSelectedIds([])
  }, [commitOps, selectedRootIds])

  const groupSelection = useCallback(() => {
    if (selectedObjects.length < 2) return setStatus('Select at least two objects to group')
    const box = selectionBounds(selectedObjects)
    const commonParentId = selectedObjects.every(({ parentId }) => parentId === selectedObjects[0]?.parentId)
      ? selectedObjects[0]?.parentId
      : undefined
    const group: SceneObject = { id: allocateId('group', collectProjectIds(project), 'selection'), type: 'group', name: 'Object group', ...(commonParentId ? { parentId: commonParentId } : {}), locked: false, visible: true, transform: { ...box, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} }
    if (commitOps([{ type: 'group-objects', objectIds: selectedObjects.map(({ id }) => id), group }], 'Group selection')) setSelectedIds([group.id])
  }, [commitOps, project, selectedObjects])

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

  const commitPatch = (patch: Extract<SceneOperation, { type: 'update-object' }>['patch'], label: string) => {
    if (!primary) return false
    return commitOps([{ type: 'update-object', objectId: primary.id, patch }], label)
  }

  const nudge = useCallback((dx: number, dy: number) => {
    if (!selectedObjects.length) return
    const selectedFamilyIds = new Set(selectedObjects.flatMap((object) => familyObjectIds(shot, [object.id])))
    if ([...selectedFamilyIds].some((id) => effectiveLockOwner(shot, id))) {
      setStatus('The selection contains a locked object; unlock it before nudging the selection.')
      return
    }
    if ([...selectedFamilyIds].some((id) => temporallyTransformsObject(shot, id, playhead))) {
      setStatus('This playhead shows animated geometry. Edit the timeline block, or scrub before the spatial animation begins, to change the base pose.')
      return
    }
    commitOps(selectedObjects.map((object) => ({ type: 'update-object', objectId: object.id, patch: { transform: { x: object.transform.x + dx, y: object.transform.y + dy } } })), 'Nudge selection')
  }, [commitOps, playhead, selectedObjects, shot])

  const undoHistory = useCallback(() => {
    const label = history.past.at(-1)?.label
    if (!label) return setStatus('Nothing to undo')
    setHistory(undo(history))
    setStatus(`Undid: ${label}`)
  }, [history])

  const redoHistory = useCallback(() => {
    const label = history.future[0]?.label
    if (!label) return setStatus('Nothing to redo')
    setHistory(redo(history))
    setStatus(`Redid: ${label}`)
  }, [history])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') { setTimelineGesture(null); setTimelineDraft(null); setProposal(null); setExportPreview(null); setRendererMessage(''); setImportError(''); return }
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const command = event.metaKey || event.ctrlKey
      if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redoHistory(); else undoHistory(); return }
      if (command && event.key.toLowerCase() === 'y') { event.preventDefault(); redoHistory(); return }
      if (command && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection(); return }
      if (command && event.key.toLowerCase() === 'g') { event.preventDefault(); if (event.shiftKey) ungroupSelection(); else groupSelection(); return }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (target instanceof Element && target.closest('.pc-timeline')) return
        event.preventDefault()
        deleteSelection()
        return
      }
      const canvasFocused = target instanceof Element && Boolean(target.closest('[data-pc-canvas]'))
      if (event.key.startsWith('Arrow') && canvasFocused) {
        event.preventDefault()
        const amount = event.shiftKey ? 10 : 1
        nudge(event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0, event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteSelection, duplicateSelection, groupSelection, nudge, redoHistory, undoHistory, ungroupSelection])

  const selectLibraryTab = (event: ReactKeyboardEvent<HTMLButtonElement>, current: 'objects' | 'components') => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'objects' : event.key === 'ArrowRight' || event.key === 'End' ? 'components' : current
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
    setActiveShotId(candidate.id)
    setSelectedIds([])
    setSelectedAnimationId(null)
    setPlayhead(0)
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
    next.shots.push({ id, name: `Scene ${project.shots.length + 1}`, duration: 6, objects: [], animations: [], propertyTracks: [], audioClips: [], captionClips: [], markers: [], camera: { x: 480, y: 270, zoom: 1, rotation: 0 } })
    if (commitDocument(next, 'Add shot')) { setActiveShotId(id); setSelectedIds([]); setPlayhead(0) }
  }

  const editShot = (patch: Partial<Pick<Shot, 'name' | 'duration'>>, label: string) => {
    const next = cloneSerializable(project)
    const target = next.shots.find(({ id }) => id === shot.id)!
    if (patch.name !== undefined && patch.name.trim()) target.name = patch.name.trim()
    if (patch.duration !== undefined) {
      const minimum = Math.max(1, ...target.animations.map((animation) => animation.start + animation.duration))
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
    const duration = Math.min(previewStyle.motion.defaultDuration, Math.max(0.1, shot.duration - playhead))
    const id = allocateId('animation', collectProjectIds(project), animationType)
    const targetIds = animationType === 'camera-focus' ? (selectedRootIds.length ? selectedRootIds : [shot.objects[0]?.id].filter(Boolean)) : selectedRootIds
    if (!targetIds.length) return setStatus('This shot needs an object before camera focus can be added')
    const properties: SceneAnimation['properties'] = animationType === 'move' && primary
      ? selectedRootIds.length > 1 ? { deltaX: 80, deltaY: 0 } : { x: primary.transform.x + 80, y: primary.transform.y }
      : animationType === 'scale' ? { scale: 1.2 } : animationType === 'emphasise' ? { scale: 1.12 } : animationType === 'camera-focus' ? { x: primary?.transform.x ?? 480, y: primary?.transform.y ?? 270, zoom: 1.15 } : {}
    const animation: SceneAnimation = { id, type: animationType, targetIds, start: Math.min(playhead, shot.duration - duration), duration, easing: previewStyle.motion.easing, properties }
    if (commitOps([{ type: 'add-animation', animation }], `Add ${animationType} animation`)) setSelectedAnimationId(id)
  }

  const updateAnimation = (patch: Extract<SceneOperation, { type: 'update-animation' }>['patch'], label: string) => {
    if (!selectedAnimation) return false
    return commitOps([{ type: 'update-animation', animationId: selectedAnimation.id, patch }], label)
  }

  const deleteTimelineAnimation = (animation: SceneAnimation) => {
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
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setSelectedAnimationId(animation.id)
    setTimelineGesture({ id: animation.id, kind, clientX: event.clientX, start: animation.start, duration: animation.duration })
    setTimelineDraft({ id: animation.id, start: animation.start, duration: animation.duration })
  }

  const moveTimelineGesture = (event: ReactPointerEvent) => {
    if (!timelineGesture || !trackRef.current) return
    const seconds = (event.clientX - timelineGesture.clientX) / trackRef.current.clientWidth * shot.duration
    const snap = (value: number) => Math.round(value * 10) / 10
    if (timelineGesture.kind === 'move') setTimelineDraft({ id: timelineGesture.id, start: snap(Math.max(0, Math.min(shot.duration - timelineGesture.duration, timelineGesture.start + seconds))), duration: timelineGesture.duration })
    else setTimelineDraft({ id: timelineGesture.id, start: timelineGesture.start, duration: snap(Math.max(0.1, Math.min(shot.duration - timelineGesture.start, timelineGesture.duration + seconds))) })
  }

  const endTimelineGesture = () => {
    if (timelineGesture && timelineDraft) updateAnimation({ start: timelineDraft.start, duration: timelineDraft.duration }, timelineGesture.kind === 'move' ? 'Move timeline block' : 'Resize timeline block')
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
    const base = { revision: projectRevision, shotId: shot.id }
    setInstruction(value)
    setCritique(null)
    setProposal(null)
    setProposalBase(null)
    setAiPending(true)
    try {
      const localRequest = { project, shotId: shot.id, selectedObjectIds: selectedRootIds, instruction: value }
      if (!aiConfigured) {
        setProposal(interpretDemoCommand(localRequest))
        setProposalBase(base)
        setAiProvider('deterministic-demo')
        setAiError('')
        return
      }
      if (durableProject && (!await performDurableSave() || projectRevisionRef.current !== lastSavedCanonicalRef.current)) {
        throw new Error('Save the current project before requesting an AI proposal')
      }
      const token = durableProject ? await ensureCsrfToken() : null
      const request = durableProject ? {
        projectId: durableProject.projectId,
        revision: serverRevisionRef.current,
        shotId: shot.id,
        selectedObjectIds: selectedRootIds,
        instruction: value,
      } : localRequest
      const response = await fetch('/api/proofcanvas/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-ProofCanvas-CSRF': token } : {}) },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      const payload: unknown = await response.json()
      if (requestId !== aiRequestSequence.current) return
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

  const startRender = async () => {
    const submittedRevision = projectRevision
    setRendererMessage('')
    setRenderJob(null)
    setRenderBaseRevision(submittedRevision)
    setRenderPollFailures(0)
    setRenderPollingPaused(false)
    setRenderPending(true)
    try {
      if (durableProject && (!await performDurableSave() || projectRevisionRef.current !== lastSavedCanonicalRef.current)) {
        throw new Error('Save the current project before starting a render')
      }
      const token = durableProject ? await ensureCsrfToken() : null
      const response = await fetch('/api/proofcanvas/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-ProofCanvas-CSRF': token } : {}) },
        body: JSON.stringify(durableProject
          ? { projectId: durableProject.projectId, revision: serverRevisionRef.current, quality: 'preview' }
          : { project, quality: 'preview' }),
      })
      const payload: unknown = await response.json()
      if (!response.ok) throw new Error(responseMessage(payload, 'ProofCanvas rendering could not start'))
      if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) throw new Error('Renderer returned an invalid response')
      const job = renderJobFromPayload((payload as { job?: unknown }).job)
      setRenderJob(job)
      setStatus('Genuine Manim render queued')
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
    if (durableProject) {
      void performDurableSave()
      return
    }
    try { window.localStorage.setItem(STORAGE_KEY, canonicalProjectJson(project)); setStatus('Saved locally') }
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
        && typeof (candidate as { createdAt?: unknown }).createdAt === 'string',
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
      if (commitDocument(loaded, 'Load saved project')) { setActiveShotId(loaded.shots[0].id); setSelectedIds([]); setCritique(null) }
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Saved project is invalid') }
  }

  const createCheckpoint = async () => {
    if (!durableProject || checkpointPending || saveConflictRef.current) return
    setCheckpointPending(true)
    try {
      if (!await performDurableSave()) throw new Error('Save the current project before creating a checkpoint')
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
      setSaveState('saved')
      setSaveMessage(`Checkpoint created at revision ${revision}`)
      await loadCheckpoints()
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'Checkpoint could not be created')
    } finally {
      setCheckpointPending(false)
    }
  }

  const recoverCheckpoint = async (checkpoint: DurableCheckpoint) => {
    if (!durableProject || checkpointPending) return
    if (!window.confirm(`Recover “${checkpoint.label}” from revision ${checkpoint.revision}? A checkpoint of the current project will be created first.`)) return
    setCheckpointPending(true)
    try {
      if (!await performDurableSave()) throw new Error('Resolve the current save before recovering a checkpoint')
      const { response, payload } = await durableMutation(`/api/projects/${encodeURIComponent(durableProject.projectId)}/recover`, 'POST', {
        checkpointId: checkpoint.id,
        expectedRevision: serverRevisionRef.current,
        mutationId: window.crypto.randomUUID(),
      })
      if (!response.ok || !payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) throw new Error(responseMessage(payload, 'Checkpoint could not be recovered'))
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
      setActiveShotId(recovered.shots[0].id)
      setSelectedIds([])
      setPlayhead(0)
      setSaveMessage('Browser recovery applied; durable autosave is pending.')
    }
  }

  const resetDemo = () => {
    const source = createCantorDemoProject()
    const demo = durableProject ? ProjectDocumentSchema.parse({
      ...source,
      metadata: { ...source.metadata, id: durableProject.projectId, title: project.metadata.title, createdAt: project.metadata.createdAt, updatedAt: project.metadata.updatedAt },
    }) : source
    if (commitDocument(demo, 'Reset to preloaded demo')) { setActiveShotId(demo.shots[0].id); setSelectedIds([]); setPlayhead(INITIAL_DEMO_PLAYHEAD); setCritique(null) }
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
      if (commitDocument(loaded, `Import ${file.name}`)) { setActiveShotId(loaded.shots[0].id); setSelectedIds([]); setCritique(null); setImportError(''); setStatus(`Imported ${file.name}`) }
    } catch (error) {
      if (requestId === importRequestSequence.current) setImportError(error instanceof Error ? error.message : 'The selected project is invalid')
    }
  }

  const showExportPreview = (title: string, contents: string, diagnostics?: string[]) => {
    exportTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setExportPreview({ title, contents, diagnostics })
  }
  const exportJson = () => { const contents = canonicalProjectJson(project); showExportPreview('Project JSON', contents); download('uncountable-yet-zero-length.proofcanvas.json', 'application/json', contents) }
  const exportPython = () => {
    const result = compileManim(project)
    const diagnostics = result.diagnostics.map((diagnostic) => `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}${diagnostic.objectId ? ` · object ${diagnostic.objectId}` : ''}${diagnostic.animationId ? ` · animation ${diagnostic.animationId}` : ''}`)
    showExportPreview(`Manim Python${diagnostics.length ? ` · ${diagnostics.length} diagnostics` : ''}`, result.python, diagnostics)
    if (!result.diagnostics.some(({ severity }) => severity === 'error')) download('uncountable_yet_zero_length.py', 'text/x-python', result.python)
  }

  return (
    <main className="proofcanvas-app" role="application" aria-label="ProofCanvas editor" data-testid="proofcanvas-editor" data-pc-editor data-project-id={project.metadata.id} data-schema-version={project.schemaVersion} data-active-shot-id={shot.id} data-history-past-count={history.past.length} data-history-future-count={history.future.length} data-durable={durableProject ? 'true' : 'false'} data-server-revision={durableProject ? serverRevision : undefined} data-save-state={durableProject ? saveState : undefined}>
      <div className="pc-desktop-notice" aria-label="Desktop viewport required">ProofCanvas editing requires a desktop viewport at least 1100 px wide.</div>
      <header className="pc-header" aria-label="Project actions">
        <div className="pc-wordmark"><span aria-hidden="true">∴</span><div><h1>ProofCanvas</h1><p>Structured mathematical motion</p></div></div>
        <div className="pc-project-title"><span>Project</span><strong>{project.metadata.title}</strong>{durableProject && <small role="status" aria-label="Autosave status" data-save-state={saveState}>{saveState === 'saved' ? `Saved · r${serverRevision}` : saveState === 'waiting' ? 'Autosave queued' : saveState === 'saving' ? 'Saving…' : saveState === 'conflict' ? 'Save conflict' : 'Offline · retry available'}</small>}</div>
        <div className="pc-history-actions">
          <button type="button" onClick={undoHistory} disabled={!canUndo(history)} aria-label="Undo">↶ Undo</button>
          <button type="button" onClick={redoHistory} disabled={!canRedo(history)} aria-label="Redo">↷ Redo</button>
        </div>
        <div className="pc-file-actions">
          {durableProject && <a href="/" className="pc-header-link">Projects</a>}
          <button type="button" onClick={saveProject} aria-label="Save project">{durableProject ? 'Save now' : 'Save'}</button>
          {durableProject ? <><button type="button" onClick={() => void createCheckpoint()} disabled={checkpointPending || saveState === 'conflict'} aria-label="Create checkpoint">Checkpoint</button><button type="button" onClick={loadProject} disabled={checkpointPending} aria-label="Open project recovery">Recovery</button></> : <button type="button" onClick={loadProject} aria-label="Load saved project">Load</button>}
          <button type="button" onClick={resetDemo}>Reset demo</button>
          <label className="pc-file-label">Import JSON<input type="file" accept="application/json,.json" onChange={importJson} aria-label="Import project JSON" /></label>
          <button type="button" onClick={exportJson} aria-label="Export project JSON">Export JSON</button><button type="button" onClick={exportPython} aria-label="Export Manim Python">Export Python</button><button type="button" onClick={startRender} disabled={renderPending || renderJob?.status === 'pending' || renderJob?.status === 'running'} aria-label="Render MP4">{renderPending ? 'Submitting…' : renderJob?.status === 'pending' || renderJob?.status === 'running' ? 'Rendering…' : 'Render MP4'}</button>
        </div>
      </header>

      <aside className="pc-left" aria-label="Object and layer library">
        <section><div role="tablist" aria-label="Insert library" className="pc-library-tabs"><button type="button" role="tab" aria-selected={libraryTab === 'objects'} tabIndex={libraryTab === 'objects' ? 0 : -1} data-library-tab="objects" onKeyDown={(event) => selectLibraryTab(event, 'objects')} onClick={() => setLibraryTab('objects')}>Objects</button><button type="button" role="tab" aria-selected={libraryTab === 'components'} tabIndex={libraryTab === 'components' ? 0 : -1} data-library-tab="components" onKeyDown={(event) => selectLibraryTab(event, 'components')} onClick={() => setLibraryTab('components')}>Components</button></div>
          {libraryTab === 'objects' ? <div className="pc-insert-grid">{OBJECT_TYPES.map(({ type, label }) => <button key={type} type="button" onClick={() => insertObject(type)} aria-label={`Add ${label}`} data-object-type={type}>{label}</button>)}</div> : <div className="pc-component-list">{SEMANTIC_COMPONENTS.map((component) => { const labels: Record<SemanticComponentId, string> = { 'mathematical-title': 'Insert mathematical title', 'proposition-statement': 'Insert proposition or definition', 'equation-chain': 'Insert equation chain', 'annotated-diagram': 'Insert annotated diagram', 'focus-callout': 'Insert focus callout', 'recursive-intervals': 'Insert recursive interval construction' }; return <button key={component.id} type="button" onClick={() => insertComponent(component.id)} title={component.description} aria-label={labels[component.id]} data-component-id={component.id}>{component.name}</button> })}</div>}
        </section>
        <section className="pc-layer-section"><div className="pc-section-heading"><h2>Layers</h2><span>{shot.objects.length}</span></div>
          <div className="pc-layer-actions" aria-label="Layer actions">
            <button type="button" onClick={duplicateSelection} aria-label="Duplicate selection">Duplicate</button><button type="button" onClick={deleteSelection} aria-label="Delete selection">Delete</button><button type="button" onClick={groupSelection} aria-label="Group selection">Group</button><button type="button" onClick={ungroupSelection} aria-label="Ungroup selection">Ungroup</button>
            <button type="button" onClick={() => reorderLayer('front')} aria-label="Bring to front">To front</button><button type="button" onClick={() => reorderLayer('forward')} aria-label="Bring forward">Forward</button><button type="button" onClick={() => reorderLayer('backward')} aria-label="Send backward">Backward</button><button type="button" onClick={() => reorderLayer('back')} aria-label="Send to back">To back</button>
          </div>
          <div role="tree" aria-label="Objects" aria-multiselectable="true" className="pc-layer-tree">{shot.objects.map((object, index) => { const effectivelyLocked = Boolean(effectiveLockOwner(shot, object)); const visibilityOwner = effectiveVisibilityOwner(shot, object); const visibilityLabel = !visibilityOwner ? 'Visible' : visibilityOwner.id === object.id ? 'Hidden' : `Hidden by ${visibilityOwner.name}`; const lockLabel = effectivelyLocked ? object.locked ? '; Locked' : '; Locked by parent' : ''; return <button key={object.id} type="button" role="treeitem" aria-label={`${object.name}; ${visibilityLabel}${lockLabel}`} aria-selected={selectedRootIds.includes(object.id)} aria-level={descendants(shot, object.id) + 1} tabIndex={selectedRootIds.at(-1) === object.id || (!selectedRootIds.length && index === 0) ? 0 : -1} onKeyDown={(event) => navigateLayerTree(event, index)} onClick={(event) => setSelectedIds(selectionRootIds(shot, event.shiftKey ? selectedRootIds.includes(object.id) ? selectedRootIds.filter((id) => id !== object.id) : [...selectedRootIds, object.id] : [object.id]))} style={{ paddingLeft: 10 + descendants(shot, object.id) * 14 }} data-layer-object-id={object.id} data-locked={effectivelyLocked} data-visibility={visibilityOwner ? visibilityOwner.id === object.id ? 'hidden' : 'inherited-hidden' : 'visible'}><span aria-hidden="true">{visibilityOwner ? visibilityOwner.id === object.id ? '○' : '⊘' : '◉'}</span><span>{object.name}</span>{effectivelyLocked && <span aria-hidden="true">⌑</span>}</button> })}</div>
        </section>
      </aside>

      <section className="pc-canvas-area" aria-label="Canvas workspace">
        <div className="pc-canvas-toolbar">
          <div role="radiogroup" aria-label="Active output style">
            <label><input type="radio" name="preview-style" value={EDITORIAL_INK_STYLE_ID} checked={project.activeStyleId === EDITORIAL_INK_STYLE_ID} onChange={() => selectOutputStyle(EDITORIAL_INK_STYLE_ID, 'Editorial Ink')}/>Editorial Ink</label>
            <label><input type="radio" name="preview-style" value={RAW_MANIM_STYLE_ID} checked={project.activeStyleId === RAW_MANIM_STYLE_ID} onChange={() => selectOutputStyle(RAW_MANIM_STYLE_ID, 'Raw Manim')}/>Raw Manim</label>
          </div>
          <div className="pc-align-actions" aria-label="Alignment actions">
            {(['left','center-x','right','top','center-y','bottom'] as const).map((value) => { const labels = { left: 'Align left', 'center-x': 'Align horizontal centres', right: 'Align right', top: 'Align top', 'center-y': 'Align vertical centres', bottom: 'Align bottom' }; return <button type="button" key={value} onClick={() => align(value)} aria-label={labels[value]}>{value.replace('center-', 'mid ')}</button> })}
            <button type="button" onClick={() => distribute('horizontal')} aria-label="Distribute horizontally">Distribute H</button><button type="button" onClick={() => distribute('vertical')} aria-label="Distribute vertically">Distribute V</button>
          </div>
        </div>
        <div role="region" aria-label="Scene canvas" data-pc-canvas data-preview-time={playhead} data-preview-style-id={previewStyle.id} className="pc-canvas-region"><CanvasStage project={project} shot={shot} playhead={playhead} previewStyle={previewStyle} selectedIds={selectedRootIds} onSelect={(ids) => setSelectedIds(selectionRootIds(shot, ids))} onNotice={setStatus} onCommitTransforms={(updates, label) => commitOps(updates.map(({ objectId, transform }) => ({ type: 'update-object', objectId, patch: { transform } })), label)}/></div>
        <p className="pc-status" role="status" aria-label="Editor status">{status}</p>
      </section>

      <aside className="pc-right" aria-label="Inspector and intelligence tools">
        <form className="pc-inspector" aria-label="Object inspector" data-inspector-object-id={primary?.id} onSubmit={(event) => event.preventDefault()}><div className="pc-section-heading"><h2>Inspector</h2>{primary && <button type="button" onClick={toggleLock} disabled={primaryInheritedLocked}>{primaryInheritedLocked ? 'Locked by parent' : primary.locked ? 'Unlock' : 'Lock'}</button>}</div>
          {!primary ? <p className="pc-empty">Select an object to inspect its ordinary design properties.</p> : <div className="pc-field-grid"><p className="pc-wide pc-inspector-note">Base-pose properties. Timeline blocks may animate this geometry at the current playhead.</p>
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
          </div>}
        </form>

        <section className="pc-ai" role="region" aria-label="AI command" data-ai-provider={aiProvider}><div className="pc-section-heading"><h2>AI edit</h2><span>review first</span></div><p className="pc-demo-label">{aiProvider === 'configured-provider' ? 'OpenAI structured operations — server configured' : 'Deterministic demo interpreter — limited commands'}</p>
          <div className="pc-presets">{REQUIRED_AI_COMMANDS.map((command, index) => <button type="button" key={command} onClick={() => void runAi(command)} aria-label={`Run AI preset ${index + 1}: ${command}`} title={command} disabled={aiPending}>{index + 1}</button>)}</div>
          <label>Instruction<textarea aria-label="Describe the edit" value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={3}/></label><button type="button" className="pc-primary" onClick={() => void runAi()} aria-label="Propose edit" disabled={aiPending}>{aiPending ? 'Proposing…' : 'Propose edit'}</button>
          {aiError && <p className="pc-error" role="alert">{aiError}</p>}
          {proposal && <div className="pc-proposal" role="region" aria-label="Proposed changes"><strong>{proposal.intention}</strong><p>Validated against shot <code>{proposalBase?.shotId}</code>. Expand each operation to inspect exact before and after values.</p><ol>{proposalReviews.map((review, index) => <li key={`${proposal.operations[index]?.type}-${index}`} data-operation-kind={proposal.operations[index]?.type}><details><summary>{review.summary}</summary><pre>{review.details}</pre></details></li>)}</ol><div><button type="button" className="pc-primary" onClick={applyProposal}>Apply proposed changes</button><button type="button" onClick={() => { setProposal(null); setProposalBase(null); setCritique(null) }}>Discard proposed changes</button></div></div>}
        </section>

        <section className="pc-critique" role="region" aria-label="Composition critique"><div className="pc-section-heading"><h2>Composition</h2><button type="button" onClick={() => setCritique({ issues: critiqueProject(project, { shotId: shot.id, proposedOperations: proposal?.operations }), revision: projectRevision, shotId: shot.id })}>Critique composition</button></div>
          {critique && <p className="pc-critique-provenance">Current revision · {shot.name}</p>}
          {critique && (critique.issues.length > 0 ? <ul>{critique.issues.map((item) => <li key={item.id} data-issue-kind={item.kind} data-object-ids={item.objectIds.join(' ')} data-severity={item.severity}><strong>{item.kind.replaceAll('-', ' ')}</strong><span>{item.explanation}</span><em>{item.proposedCorrection}</em></li>)}</ul> : <p className="pc-critique-clear" role="status">No deterministic composition issues found for this shot.</p>)}
        </section>
      </aside>

      <section className="pc-shots" aria-label="Shot rail"><div className="pc-section-heading"><h2>Shots</h2><button type="button" onClick={addShot}>Add shot</button></div><div className="pc-shot-list" role="tablist" aria-label="Shots">{project.shots.map((candidate, index) => <button type="button" role="tab" key={candidate.id} className={candidate.id === shot.id ? 'active' : ''} data-shot-id={candidate.id} aria-selected={candidate.id === shot.id} tabIndex={candidate.id === shot.id ? 0 : -1} onKeyDown={(event) => navigateShotTabs(event, index)} onClick={() => selectShot(candidate)} aria-label={`Select shot ${candidate.name}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>{candidate.name}</strong><small>{candidate.duration.toFixed(1)}s</small></button>)}</div>
        <div className="pc-shot-edit"><label>Name<input aria-label="Shot name" key={`${shot.id}-${shot.name}`} defaultValue={shot.name} onBlur={(event) => commitTextInput(event, shot.name, 'Shot name', (value) => editShot({ name: value }, 'Rename shot'), { trim: true, required: true })}/></label><label>Duration<input type="number" min={minimumShotDuration} max="300" step="0.5" aria-label="Shot duration" key={`${shot.id}-${shot.duration}`} defaultValue={shot.duration} onBlur={(event) => commitNumericInput(event, { key: 'shotDuration', label: 'Shot duration', fallback: shot.duration, min: minimumShotDuration, max: 300 }, shot.duration, (value) => editShot({ duration: value }, 'Set shot duration'))}/></label><button type="button" onClick={() => reorderShot(-1)} aria-label="Move shot earlier">←</button><button type="button" onClick={() => reorderShot(1)} aria-label="Move shot later">→</button></div>
      </section>

      <section className="pc-timeline" role="region" aria-label="Animation timeline" data-shot-id={shot.id}><div className="pc-timeline-head"><h2>Timeline</h2><label>Animation<select aria-label="Animation type" value={animationType} onChange={(event) => setAnimationType(event.target.value as AnimationType)}>{ANIMATION_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label><button type="button" onClick={addAnimation}>Add animation</button><label className="pc-scrubber">Playhead<input type="range" min="0" max={shot.duration} step="0.05" value={playhead} aria-label="Playhead" onChange={(event) => setPlayhead(event.target.valueAsNumber)}/><output aria-label="Playhead time">{playhead.toFixed(2)}s</output></label></div>
        <div ref={trackRef} className="pc-timeline-track" data-testid="timeline-track" onPointerMove={moveTimelineGesture} onPointerUp={endTimelineGesture} onPointerCancel={cancelTimelineGesture} onPointerDown={(event) => { if (event.target === event.currentTarget && trackRef.current) { const rect = trackRef.current.getBoundingClientRect(); setPlayhead(Math.max(0, Math.min(shot.duration, (event.clientX - rect.left) / rect.width * shot.duration))) } }}>
          <div className="pc-playhead" style={{ left: `${playhead / shot.duration * 100}%` }}/>{shot.animations.map((animation) => { const timing = timelineDraft?.id === animation.id ? timelineDraft : animation; const lane = animationLanes.get(animation.id) ?? 0; const targets = animation.targetIds.map((id) => shot.objects.find((object) => object.id === id)?.name ?? id).join(', '); const locked = animationTargetsLocked(shot, animation); const lockedNotice = () => { setSelectedAnimationId(animation.id); setStatus('This animation targets a locked object family; unlock it before editing the block.') }; return <button type="button" key={animation.id} className={`pc-animation-block ${selectedAnimationId === animation.id ? 'selected' : ''} ${locked ? 'locked' : ''}`} style={{ left: `${timing.start / shot.duration * 100}%`, width: `${Math.max(1.5, timing.duration / shot.duration * 100)}%`, top: `${8 + lane * 31}px` }} data-animation-id={animation.id} data-animation-type={animation.type} data-target-ids={animation.targetIds.join(' ')} data-timeline-lane={lane} data-start={timing.start} data-duration={timing.duration} data-locked={locked ? 'true' : 'false'} aria-disabled={locked} aria-label={`${animation.type} animation targeting ${targets}; ${locked ? 'locked' : 'drag the right edge to resize'}`} onKeyDown={(event) => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); deleteTimelineAnimation(animation) } }} onClick={() => setSelectedAnimationId(animation.id)} onPointerDown={(event) => { if (locked) { event.stopPropagation(); lockedNotice(); return } beginTimelineGesture(event, animation, 'move') }}><span>{animation.type}</span><i aria-hidden="true" onPointerDown={(event) => { if (locked) { event.stopPropagation(); lockedNotice(); return } beginTimelineGesture(event, animation, 'resize') }}/></button> })}
        </div>
        {selectedAnimation && <div className="pc-animation-inspector">
          <strong>{selectedAnimation.type}</strong>
          {selectedAnimationLocked && <span className="pc-animation-lock-note" role="status">Locked target</span>}
          {selectedAnimation.type === 'transform' && selectedAnimation.targetIds.length > 1 && <span className="pc-animation-lock-note" role="status">Split this legacy multi-target transform before editing absolute geometry.</span>}
          <label>Start<input type="number" min="0" max={shot.duration - selectedAnimation.duration} step="0.1" aria-label="Start time" defaultValue={selectedAnimation.start} key={`${selectedAnimation.id}-start-${selectedAnimation.start}`} disabled={selectedAnimationLocked} onBlur={(event) => commitNumericInput(event, { key: 'start', label: 'Start time', fallback: selectedAnimation.start, min: 0, max: shot.duration - selectedAnimation.duration }, selectedAnimation.start, (next) => updateAnimation({ start: next }, 'Set animation start'))}/></label>
          <label>Duration<input type="number" min="0.1" max={shot.duration - selectedAnimation.start} step="0.1" aria-label="Duration" defaultValue={selectedAnimation.duration} key={`${selectedAnimation.id}-duration-${selectedAnimation.duration}`} disabled={selectedAnimationLocked} onBlur={(event) => commitNumericInput(event, { key: 'duration', label: 'Duration', fallback: selectedAnimation.duration, min: 0.1, max: shot.duration - selectedAnimation.start }, selectedAnimation.duration, (next) => updateAnimation({ duration: next }, 'Set animation duration'))}/></label>
          <label>Easing<select aria-label="Easing" value={selectedAnimation.easing} disabled={selectedAnimationLocked} onChange={(event) => updateAnimation({ easing: event.target.value as Easing }, 'Set animation easing')}>{EASINGS.map((easing) => <option key={easing}>{easing}</option>)}</select></label>
          {animationPropertyFields.map((field) => { const value = typeof selectedAnimation.properties[field.key] === 'number' ? Number(selectedAnimation.properties[field.key]) : field.fallback; return <label key={field.key}>{field.label}<input type="number" min={field.min} max={field.max} step="0.1" aria-label={field.label} defaultValue={value} key={`${selectedAnimation.id}-${field.key}-${String(selectedAnimation.properties[field.key])}`} disabled={selectedAnimationLocked} onBlur={(event) => commitNumericInput(event, field, value, (next) => updateAnimation({ properties: { [field.key]: next } }, `Set ${field.label.toLowerCase()}`))}/></label> })}
          <button type="button" disabled={selectedAnimationLocked} onClick={() => deleteTimelineAnimation(selectedAnimation)}>Delete animation</button>
        </div>}
      </section>

      {(rendererMessage || importError) && <div className="pc-message" role="alert"><p>{importError || rendererMessage}</p><button type="button" onClick={() => { setRendererMessage(''); setImportError('') }}>Dismiss</button></div>}
      {durableProject && saveMessage && <div className={`pc-save-message ${saveState === 'conflict' ? 'conflict' : ''}`} role={saveState === 'conflict' ? 'alert' : 'status'}><p>{saveMessage}</p>{(saveState === 'offline' || saveState === 'conflict') && <button type="button" onClick={() => saveState === 'conflict' ? window.location.reload() : void performDurableSave()}>{saveState === 'conflict' ? 'Reload durable project' : 'Retry autosave'}</button>}<button type="button" onClick={() => setSaveMessage('')} aria-label="Dismiss save message">×</button></div>}
      {durableProject && localRecovery && !recoveryIgnored && <section className="pc-recovery-offer" role="region" aria-label="Browser recovery available"><strong>Unsaved browser recovery found</strong><p>ProofCanvas did not load it automatically. Apply this project-scoped copy only if it contains work missing from durable revision {serverRevision}.</p><div><button type="button" onClick={applyLocalRecovery}>Apply browser recovery</button><button type="button" onClick={() => setRecoveryIgnored(true)}>Ignore for now</button></div></section>}
      {durableProject && recoveryOpen && <section className="pc-checkpoint-panel" role="dialog" aria-modal="false" aria-label="Project recovery"><header><div><span>Durable recovery</span><strong>Checkpoints</strong></div><button type="button" onClick={() => setRecoveryOpen(false)} aria-label="Close project recovery">×</button></header>{checkpoints.length === 0 ? <p>No checkpoints have been created yet.</p> : <ul>{checkpoints.map((checkpoint) => <li key={checkpoint.id}><div><strong>{checkpoint.label}</strong><span>Revision {checkpoint.revision} · {checkpoint.createdAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}</span></div><button type="button" onClick={() => void recoverCheckpoint(checkpoint)} disabled={checkpointPending}>Recover…</button></li>)}</ul>}</section>}
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
