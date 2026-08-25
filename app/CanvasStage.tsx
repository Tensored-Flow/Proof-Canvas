'use client'

import katex from 'katex'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { previewShotAtTime } from '@/lib/proofcanvas/preview'
import { addTimelineTimes, compareTimelineTimes, logicalFrameFor, type LogicalFrame } from '@/lib/proofcanvas/frame'
import { applyOperations, effectiveLockOwner } from '@/lib/proofcanvas/operations'
import { objectTypeSupportsStyleProperty, type ProjectDocument, type SceneObject, type Shot, type StylePack } from '@/lib/proofcanvas/schema'
import { styledDisplayTransform, styledTransform } from '@/lib/proofcanvas/styles'

type Gesture = {
  kind: 'move' | 'resize' | 'rotate'
  pointerId: number
  start: { x: number; y: number }
  objectId: string
  displayOriginal: SceneObject['transform']
  originals: Map<string, SceneObject['transform']>
  commitIds: Set<string>
  baseRevision: string
}

export interface CanvasStageProps {
  project: ProjectDocument
  shot: Shot
  playhead: number
  previewStyle: StylePack
  projectRevision: string
  previewQuality: ProjectDocument['settings']['previewQuality']
  selectedIds: readonly string[]
  authoringEnabled?: boolean
  onSelect(ids: string[]): void
  onCommitTransforms(updates: Array<{ objectId: string; transform: Partial<SceneObject['transform']> }>, label: string): void
  onCommitKeyboardTransform(intent: CanvasKeyboardTransformIntent): void
  onNotice(message: string): void
}

export type CanvasKeyboardTransformIntent = Readonly<{
  objectId: string
  kind: 'resize' | 'rotate'
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
  shiftKey: boolean
}>

export type CanvasKeyboardTransformResolution = Readonly<{
  updates: Array<{ objectId: string; transform: Partial<SceneObject['transform']> }>
  label: string
}> | Readonly<{ notice: string }> | null

function svgPoint(svg: SVGSVGElement, event: Pick<PointerEvent, 'clientX' | 'clientY'>) {
  const point = svg.createSVGPoint()
  point.x = event.clientX
  point.y = event.clientY
  const matrix = svg.getScreenCTM()?.inverse()
  const transformed = matrix ? point.matrixTransform(matrix) : point
  return { x: transformed.x, y: transformed.y }
}

function cameraPoint(point: { x: number; y: number }, camera: ShotPreviewCamera, frame: Pick<LogicalFrame, 'centerX' | 'centerY'>) {
  const translatedX = (point.x - frame.centerX) / camera.zoom
  const translatedY = (point.y - frame.centerY) / camera.zoom
  const radians = camera.rotation * Math.PI / 180
  return {
    x: camera.x + translatedX * Math.cos(radians) - translatedY * Math.sin(radians),
    y: camera.y + translatedX * Math.sin(radians) + translatedY * Math.cos(radians),
  }
}

type ShotPreviewCamera = ReturnType<typeof previewShotAtTime>['camera']

function MathHtml({ content }: { content: string }) {
  const html = useMemo(() => katex.renderToString(content, { throwOnError: false, strict: 'error', trust: false, output: 'html' }), [content])
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

export function temporallyTransformsObject(shot: Shot, objectId: string, time: number): boolean {
  const targetFamily = new Set<string>()
  let cursor = shot.objects.find(({ id }) => id === objectId)
  while (cursor) {
    targetFamily.add(cursor.id)
    cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined
  }
  return shot.animations.some((animation) => {
    if (!animation.targetIds.some((id) => targetFamily.has(id))) return false
    if (animation.type === 'move' || animation.type === 'scale' || animation.type === 'transform') {
      return compareTimelineTimes(time, animation.start) > 0
    }
    return animation.type === 'emphasise'
      && compareTimelineTimes(time, animation.start) > 0
      && compareTimelineTimes(time, addTimelineTimes(animation.start, animation.duration)) < 0
  })
}

function rawDeltaForStyledDelta(object: SceneObject, style: StylePack, axis: 'x' | 'y', delta: number): number {
  const before = styledTransform(object, style)[axis]
  const shifted = { ...object, transform: { ...object.transform, [axis]: object.transform[axis] + 1 } }
  const slope = styledTransform(shifted, style)[axis] - before
  return Math.abs(slope) < 0.000_001 ? 0 : delta / slope
}

function mutationFamilyIds(shot: Shot, objectId: string): Set<string> {
  const ids = new Set([objectId])
  const queue = [objectId]
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
  return ids
}

/** Resolves a relative keyboard intent against the latest canonical document. */
export function resolveCanvasKeyboardTransformIntent(
  project: ProjectDocument,
  shotId: string,
  previewStyle: StylePack,
  playhead: number,
  intent: CanvasKeyboardTransformIntent,
): CanvasKeyboardTransformResolution {
  const shot = project.shots.find(({ id }) => id === shotId)
  const source = shot?.objects.find(({ id }) => id === intent.objectId)
  if (!shot || !source) return null
  const familyIds = mutationFamilyIds(shot, source.id)
  if ([...familyIds].some((id) => effectiveLockOwner(shot, id))) {
    return { notice: 'This object family contains a lock; unlock every family member before transforming it.' }
  }
  if ([...familyIds].some((id) => temporallyTransformsObject(shot, id, playhead))) {
    return { notice: 'This playhead shows animated geometry. Edit the timeline block, or scrub before the spatial animation begins, to change the base pose.' }
  }
  if (intent.kind === 'rotate' && (source.type === 'circle' || (intent.key !== 'ArrowLeft' && intent.key !== 'ArrowRight'))) return null
  if (intent.kind === 'resize' && (intent.key === 'ArrowUp' || intent.key === 'ArrowDown') && (source.type === 'line' || source.type === 'arrow')) {
    return { notice: 'Lines and arrows resize horizontally; use Left or Right Arrow on the handle.' }
  }

  const preview = previewShotAtTime(shot, playhead)
  const visibleObjects = preview.objects.filter((object) => object.preview.opacity > 0.001)
  const displayedSource = visibleObjects.find(({ id }) => id === source.id)
  if (!displayedSource) return null
  const displayOriginal = styledDisplayTransform(displayedSource, shot, previewStyle, visibleObjects)
  const step = intent.shiftKey ? 10 : 1
  const transform = { ...source.transform }
  if (intent.kind === 'rotate') {
    transform.rotation += intent.key === 'ArrowLeft' ? -step : step
  } else if (intent.key === 'ArrowLeft' || intent.key === 'ArrowRight') {
    transform.width = Math.max(10, (transform.width ?? 60) + (intent.key === 'ArrowLeft' ? -step : step))
  } else {
    transform.height = Math.max(10, (transform.height ?? 30) + (intent.key === 'ArrowDown' ? step : -step))
  }

  let committedTransform = transform
  if (source.type === 'group') {
    let adjusted = { ...transform }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const simulatedShot = applyOperations(project, shot.id, [{ type: 'update-object', objectId: source.id, patch: { transform: adjusted } }]).project.shots.find(({ id }) => id === shot.id)!
      const simulatedSource = simulatedShot.objects.find(({ id }) => id === source.id)!
      const simulatedVisible = visibleObjects.map((object) => {
        const candidate = simulatedShot.objects.find(({ id }) => id === object.id)
        return candidate ? { ...object, transform: candidate.transform } : object
      })
      const simulatedFrame = styledDisplayTransform(simulatedSource, simulatedShot, previewStyle, simulatedVisible)
      const errorX = displayOriginal.x - simulatedFrame.x
      const errorY = displayOriginal.y - simulatedFrame.y
      if (Math.abs(errorX) < 0.000_001 && Math.abs(errorY) < 0.000_001) break
      adjusted = {
        ...adjusted,
        x: adjusted.x + rawDeltaForStyledDelta({ ...source, transform: adjusted }, previewStyle, 'x', errorX),
        y: adjusted.y + rawDeltaForStyledDelta({ ...source, transform: adjusted }, previewStyle, 'y', errorY),
      }
    }
    committedTransform = adjusted
  } else if (intent.kind === 'resize') {
    const candidate = { ...source, transform }
    const displayed = styledTransform(candidate, previewStyle)
    committedTransform = {
      ...transform,
      x: transform.x + rawDeltaForStyledDelta(candidate, previewStyle, 'x', displayOriginal.x - displayed.x),
      y: transform.y + rawDeltaForStyledDelta(candidate, previewStyle, 'y', displayOriginal.y - displayed.y),
    }
  }
  if (JSON.stringify(committedTransform) === JSON.stringify(source.transform)) return null
  return {
    updates: [{ objectId: source.id, transform: committedTransform }],
    label: intent.kind === 'rotate' ? 'Rotate object with keyboard' : 'Resize object with keyboard',
  }
}

function RenderObject({ object, style, selected, effectivelyLocked, temporallyTransformed, markerId = 'pc-arrow', interactive = true, onPointerDown }: { object: ReturnType<typeof previewShotAtTime>['objects'][number]; style: StylePack; selected: boolean; effectivelyLocked: boolean; temporallyTransformed: boolean; markerId?: string; interactive?: boolean; onPointerDown?(event: ReactPointerEvent<SVGElement>, object: SceneObject): void }) {
  const transform = styledTransform(object, style)
  const width = transform.width ?? 60
  const height = transform.height ?? 30
  const opacity = object.preview.opacity
  const common = {
    transform: `translate(${transform.x} ${transform.y}) rotate(${transform.rotation}) scale(${transform.scaleX} ${transform.scaleY})`,
    opacity,
    ...(interactive && onPointerDown ? { onPointerDown: (event: ReactPointerEvent<SVGElement>) => onPointerDown(event, object) } : {}),
    ...(interactive ? {
      'data-object-id': object.id,
      'data-object-type': object.type,
      'data-selected': selected ? 'true' : 'false',
      'data-locked': effectivelyLocked ? 'true' : 'false',
      'data-temporal-pose': temporallyTransformed ? 'animated' : 'base',
      ...(object.parentId ? { 'data-parent-id': object.parentId } : {}),
      role: 'graphics-symbol',
      'aria-label': object.name,
      style: { cursor: effectivelyLocked || temporallyTransformed ? 'not-allowed' : 'move' },
    } : { 'aria-hidden': true, pointerEvents: 'none' as const }),
  }
  const fill = objectTypeSupportsStyleProperty(object.type, 'fill') ? object.style.fill ?? (object.type === 'rectangle' ? style.colors.ink : object.type === 'circle' ? style.colors.background : 'none') : 'none'
  const stroke = objectTypeSupportsStyleProperty(object.type, 'stroke') ? object.style.stroke ?? style.colors.ink : 'none'
  const strokeWidth = objectTypeSupportsStyleProperty(object.type, 'strokeWidth') ? object.style.strokeWidth ?? style.strokes.regular : 0
  switch (object.type) {
    case 'text':
    case 'math':
      return (
        <foreignObject {...common} x={-width / 2} y={-height / 2} width={width} height={height}>
          <div className={`pc-canvas-text pc-${object.type}`} style={{ color: objectTypeSupportsStyleProperty(object.type, 'fill') ? object.style.fill ?? object.style.color ?? style.colors.ink : object.style.color ?? style.colors.ink, fontSize: object.style.fontSize ?? 22, fontWeight: object.style.fontWeight, textAlign: object.style.textAlign ?? 'left', fontFamily: object.type === 'math' ? style.typography.math : style.typography.statement }}>
            {object.type === 'math' ? <MathHtml content={String(object.properties.content ?? '')} /> : String(object.properties.content ?? '')}
          </div>
        </foreignObject>
      )
    case 'circle': return <ellipse {...common} rx={width / 2} ry={height / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
    case 'rectangle': return <rect {...common} x={-width / 2} y={-height / 2} width={width} height={height} rx={style.corners.object} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
    case 'line': return <g {...common}><line x1={-width / 2} x2={width / 2} y1={0} y2={0} stroke={stroke} strokeWidth={strokeWidth} pointerEvents="none"/><line x1={-width / 2} x2={width / 2} y1={0} y2={0} stroke="transparent" strokeWidth={Math.max(16, strokeWidth)} pointerEvents="stroke"/></g>
    case 'arrow': return <g {...common}><line x1={-width / 2} x2={width / 2} y1={0} y2={0} stroke={stroke} strokeWidth={strokeWidth} markerEnd={`url(#${markerId})`} pointerEvents="none"/><line x1={-width / 2} x2={width / 2} y1={0} y2={0} stroke="transparent" strokeWidth={Math.max(16, strokeWidth)} pointerEvents={interactive ? 'stroke' : 'none'}/></g>
    case 'brace': return <g {...common}><path d={`M ${-width / 2} 0 C ${-width / 4} ${height / 2}, ${-width / 4} ${height / 2}, 0 ${height / 2} C ${width / 4} ${height / 2}, ${width / 4} ${height / 2}, ${width / 2} 0`} fill="none" stroke={stroke} strokeWidth={strokeWidth}/><text y={height + 12} textAnchor="middle" fill={object.style.color ?? style.colors.warmAccent} fontSize={object.style.fontSize ?? 22}>{String(object.properties.label ?? '')}</text></g>
    case 'axes': return <g {...common} stroke={stroke} strokeWidth={strokeWidth}><line x1={-width / 2} x2={width / 2}/><line y1={-height / 2} y2={height / 2}/>{[-2,-1,1,2].map((tick) => <line key={`x${tick}`} x1={tick * width / 5} x2={tick * width / 5} y1={-3} y2={3}/>)}</g>
    case 'graph': {
      const points = Array.from({ length: 31 }, (_, index) => {
        const x = -width / 2 + width * index / 30
        const y = -Math.min(height / 2, (x / Math.max(1, width / 4)) ** 2 * height / 5)
        return `${x},${y}`
      }).join(' ')
      return <polyline {...common} points={points} fill="none" stroke={object.style.stroke ?? style.colors.coolAccent} strokeWidth={object.style.strokeWidth ?? style.graph.curveWeight}/>
    }
    case 'image':
    case 'svg': return <image {...common} href={String(object.properties.source ?? '')} x={-width / 2} y={-height / 2} width={width} height={height} preserveAspectRatio="xMidYMid meet"/>
    case 'group': return null
  }
}

export interface CanvasThumbnailProps {
  aspectRatio: ProjectDocument['settings']['aspectRatio']
  shot: Shot
  previewStyle: StylePack
  /** Stable content signature supplied by the storyboard, excluding playhead and selection. */
  visualRevision: string
}

/** Passive, memoized local-zero preview sharing CanvasStage's object renderer. */
export const CanvasThumbnail = memo(function CanvasThumbnail({ aspectRatio, shot, previewStyle }: CanvasThumbnailProps) {
  const frame = useMemo(() => logicalFrameFor(aspectRatio), [aspectRatio])
  const preview = useMemo(() => previewShotAtTime(shot, 0), [shot])
  const markerId = `pc-thumbnail-arrow-${useId().replaceAll(':', '')}`
  const visibleObjects = preview.objects.filter((object) => object.preview.opacity > 0.001)
  return <svg className="pc-shot-thumbnail" viewBox={`0 0 ${frame.width} ${frame.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false" data-thumbnail-shot-id={shot.id} data-thumbnail-time="0">
    <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill={previewStyle.colors.ink}/></marker></defs>
    <rect width={frame.width} height={frame.height} fill={previewStyle.colors.background}/>
    <g transform={`translate(${frame.centerX} ${frame.centerY}) scale(${preview.camera.zoom}) rotate(${-preview.camera.rotation}) translate(${-preview.camera.x} ${-preview.camera.y})`}>
      {visibleObjects.map((object) => <RenderObject key={object.id} object={object} style={previewStyle} selected={false} effectivelyLocked={false} temporallyTransformed={false} markerId={markerId} interactive={false}/>) }
    </g>
  </svg>
}, (previous, next) => previous.visualRevision === next.visualRevision)

export default function CanvasStage({ project, shot, playhead, previewStyle, projectRevision, previewQuality, selectedIds, authoringEnabled = true, onSelect, onCommitTransforms, onCommitKeyboardTransform, onNotice }: CanvasStageProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [previewTransforms, setPreviewTransforms] = useState<Map<string, SceneObject['transform']>>(new Map())
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({})
  const frame = useMemo(() => logicalFrameFor(project.settings.aspectRatio), [project.settings.aspectRatio])
  const preview = useMemo(() => previewShotAtTime(shot, playhead), [shot, playhead])
  const objects = preview.objects.map((object) => previewTransforms.has(object.id) ? { ...object, transform: previewTransforms.get(object.id)! } : object)
  const visibleObjects = objects.filter((object) => object.preview.opacity > 0.001)
  const primary = visibleObjects.find(({ id }) => id === selectedIds.at(-1))
  const temporalPoseIds = useMemo(() => new Set(shot.objects.filter((object) => temporallyTransformsObject(shot, object.id, playhead)).map(({ id }) => id)), [playhead, shot])

  const familyIds = useCallback((objectId: string) => {
    const ids = new Set([objectId])
    const queue = [objectId]
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
    return ids
  }, [shot])

  const cancelGesture = useCallback(() => {
    setGesture(null)
    setPreviewTransforms(new Map())
    setGuides({})
  }, [])

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelGesture() }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [cancelGesture])

  // Pointer drafts are absolute transforms derived from one canonical
  // document. Undo, redo, shot changes, or any other committed edit invalidates
  // that base so releasing a stale pointer cannot resurrect older geometry.
  useEffect(() => cancelGesture(), [authoringEnabled, cancelGesture, projectRevision, shot.id])

  const simulateGroupTransformAroundDisplayCenter = useCallback((source: SceneObject, requested: SceneObject['transform'], center: { x: number; y: number }) => {
    let adjusted = { ...requested }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const simulatedShot = applyOperations(project, shot.id, [{ type: 'update-object', objectId: source.id, patch: { transform: adjusted } }]).project.shots.find(({ id }) => id === shot.id)!
      const simulatedSource = simulatedShot.objects.find(({ id }) => id === source.id)!
      const simulatedVisible = visibleObjects.map((object) => {
        const candidate = simulatedShot.objects.find(({ id }) => id === object.id)
        return candidate ? { ...object, transform: candidate.transform } : object
      })
      const simulatedFrame = styledDisplayTransform(simulatedSource, simulatedShot, previewStyle, simulatedVisible)
      const errorX = center.x - simulatedFrame.x
      const errorY = center.y - simulatedFrame.y
      if (Math.abs(errorX) < 0.000_001 && Math.abs(errorY) < 0.000_001) return { transform: adjusted, shot: simulatedShot }
      adjusted = {
        ...adjusted,
        x: adjusted.x + rawDeltaForStyledDelta({ ...source, transform: adjusted }, previewStyle, 'x', errorX),
        y: adjusted.y + rawDeltaForStyledDelta({ ...source, transform: adjusted }, previewStyle, 'y', errorY),
      }
    }
    const simulatedShot = applyOperations(project, shot.id, [{ type: 'update-object', objectId: source.id, patch: { transform: adjusted } }]).project.shots.find(({ id }) => id === shot.id)!
    return { transform: adjusted, shot: simulatedShot }
  }, [previewStyle, project, shot, visibleObjects])

  const beginGesture = (event: ReactPointerEvent<SVGElement>, object: SceneObject, kind: Gesture['kind'] = 'move') => {
    if (!authoringEnabled) return
    if (event.button !== 0) return
    event.stopPropagation()
    svgRef.current?.focus({ preventScroll: true })
    const nextSelection = event.shiftKey
      ? selectedIds.includes(object.id) ? selectedIds.filter((id) => id !== object.id) : [...selectedIds, object.id]
      : selectedIds.includes(object.id) ? [...selectedIds] : [object.id]
    onSelect(nextSelection)
    const selected = new Set(nextSelection)
    const hasSelectedAncestor = (candidate: SceneObject) => {
      let cursor = candidate.parentId ? shot.objects.find(({ id }) => id === candidate.parentId) : undefined
      while (cursor) {
        if (selected.has(cursor.id)) return true
        cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined
      }
      return false
    }
    const commitIds = new Set(nextSelection.filter((id) => { const candidate = shot.objects.find((item) => item.id === id); return candidate ? !hasSelectedAncestor(candidate) : false }))
    const familyIds = new Set(commitIds)
    const queue = [...commitIds]
    while (queue.length) {
      const parentId = queue.shift()!
      const parent = shot.objects.find(({ id }) => id === parentId)
      if (parent?.type !== 'group') continue
      for (const child of shot.objects.filter(({ parentId: candidate }) => candidate === parentId)) {
        familyIds.add(child.id)
        queue.push(child.id)
      }
    }
    if ([...familyIds].some((id) => effectiveLockOwner(shot, id))) {
      onNotice('Locked objects remain selectable, but the selection cannot be transformed until every selected object is unlocked.')
      return
    }
    if ([...familyIds].some((id) => temporalPoseIds.has(id))) {
      onNotice('This playhead shows animated geometry. Edit the timeline block, or scrub before the spatial animation begins, to change the base pose.')
      return
    }
    if (!svgRef.current) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const originals = new Map<string, SceneObject['transform']>()
    for (const id of familyIds) {
      const candidate = shot.objects.find((item) => item.id === id)
      if (candidate && !effectiveLockOwner(shot, candidate)) originals.set(id, { ...candidate.transform })
    }
    setGesture({ kind, pointerId: event.pointerId, start: cameraPoint(svgPoint(svgRef.current, event.nativeEvent), preview.camera, frame), objectId: object.id, displayOriginal: styledDisplayTransform(object, shot, previewStyle, visibleObjects), originals, commitIds, baseRevision: projectRevision })
    setPreviewTransforms(new Map(originals))
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!authoringEnabled) return
    if (!gesture || !svgRef.current || event.pointerId !== gesture.pointerId) return
    const point = cameraPoint(svgPoint(svgRef.current, event.nativeEvent), preview.camera, frame)
    const dx = point.x - gesture.start.x
    const dy = point.y - gesture.start.y
    const next = new Map(gesture.originals)
    const primaryOriginal = gesture.originals.get(gesture.objectId)
    if (!primaryOriginal) return
    if (gesture.kind === 'move') {
      let snapX: number | undefined
      let snapY: number | undefined
      const primarySource = shot.objects.find(({ id }) => id === gesture.objectId)
      if (!primarySource) return
      const sourceAtStart = { ...primarySource, transform: primaryOriginal }
      const authoredDx = rawDeltaForStyledDelta(sourceAtStart, previewStyle, 'x', dx)
      const authoredDy = rawDeltaForStyledDelta(sourceAtStart, previewStyle, 'y', dy)
      const candidateObject = { ...primarySource, transform: { ...primaryOriginal, x: primaryOriginal.x + authoredDx, y: primaryOriginal.y + authoredDy } }
      const candidateX = gesture.displayOriginal.x + dx
      const candidateY = gesture.displayOriginal.y + dy
      const snapObjects = visibleObjects.filter(({ id }) => !gesture.originals.has(id))
      const xTargets = [frame.centerX, ...snapObjects.map((object) => styledDisplayTransform(object, shot, previewStyle, visibleObjects).x)]
      const yTargets = [frame.centerY, ...snapObjects.map((object) => styledDisplayTransform(object, shot, previewStyle, visibleObjects).y)]
      snapX = xTargets.find((target) => Math.abs(target - candidateX) <= 6)
      snapY = yTargets.find((target) => Math.abs(target - candidateY) <= 6)
      const correctionX = snapX === undefined ? 0 : rawDeltaForStyledDelta(candidateObject, previewStyle, 'x', snapX - candidateX)
      const correctionY = snapY === undefined ? 0 : rawDeltaForStyledDelta(candidateObject, previewStyle, 'y', snapY - candidateY)
      for (const [id, original] of gesture.originals) next.set(id, { ...original, x: original.x + authoredDx + correctionX, y: original.y + authoredDy + correctionY })
      setGuides({ x: snapX, y: snapY })
    } else if (gesture.kind === 'resize') {
      const source = shot.objects.find(({ id }) => id === gesture.objectId)
      if (!source) return
      const radians = gesture.displayOriginal.rotation * Math.PI / 180
      const localDx = dx * Math.cos(radians) + dy * Math.sin(radians)
      const localDy = -dx * Math.sin(radians) + dy * Math.cos(radians)
      const displayWidth = (gesture.displayOriginal.width ?? 60) * Math.abs(gesture.displayOriginal.scaleX)
      const displayHeight = (gesture.displayOriginal.height ?? 30) * Math.abs(gesture.displayOriginal.scaleY)
      const nextDisplayWidth = Math.max(10, displayWidth + localDx * 2)
      const nextDisplayHeight = Math.max(10, displayHeight + localDy * 2)
      let transform = {
        ...primaryOriginal,
        width: Math.max(1, (primaryOriginal.width ?? 60) * nextDisplayWidth / Math.max(1, displayWidth)),
        height: source.type === 'line' || source.type === 'arrow'
          ? primaryOriginal.height
          : Math.max(1, (primaryOriginal.height ?? 30) * nextDisplayHeight / Math.max(1, displayHeight)),
      }
      if (source?.type === 'group') {
        const simulation = simulateGroupTransformAroundDisplayCenter(source, transform, gesture.displayOriginal)
        const simulated = simulation.shot
        for (const id of gesture.originals.keys()) {
          const candidate = simulated.objects.find((object) => object.id === id)
          if (candidate) next.set(id, candidate.transform)
        }
        next.set(source.id, simulation.transform)
      } else {
        const candidate = { ...source, transform }
        const displayed = styledTransform(candidate, previewStyle)
        transform = {
          ...transform,
          x: transform.x + rawDeltaForStyledDelta(candidate, previewStyle, 'x', gesture.displayOriginal.x - displayed.x),
          y: transform.y + rawDeltaForStyledDelta(candidate, previewStyle, 'y', gesture.displayOriginal.y - displayed.y),
        }
        next.set(gesture.objectId, transform)
      }
    } else {
      const displayAngle = Math.atan2(point.y - gesture.displayOriginal.y, point.x - gesture.displayOriginal.x) * 180 / Math.PI + 90
      const rotationDelta = displayAngle - gesture.displayOriginal.rotation
      const transform = { ...primaryOriginal, rotation: Math.round((primaryOriginal.rotation + rotationDelta) * 10) / 10 }
      const source = shot.objects.find(({ id }) => id === gesture.objectId)
      if (source?.type === 'group') {
        const simulation = simulateGroupTransformAroundDisplayCenter(source, transform, gesture.displayOriginal)
        const simulated = simulation.shot
        for (const id of gesture.originals.keys()) {
          const candidate = simulated.objects.find((object) => object.id === id)
          if (candidate) next.set(id, candidate.transform)
        }
        next.set(source.id, simulation.transform)
      } else next.set(gesture.objectId, transform)
    }
    setPreviewTransforms(next)
  }

  const endGesture = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!authoringEnabled) { cancelGesture(); return }
    if (!gesture || event.pointerId !== gesture.pointerId) return
    if (gesture.baseRevision !== projectRevision) {
      cancelGesture()
      return
    }
    const updates = [...previewTransforms].filter(([objectId]) => gesture.commitIds.has(objectId)).map(([objectId, transform]) => ({ objectId, transform }))
    if (updates.some(({ objectId, transform }) => JSON.stringify(transform) !== JSON.stringify(gesture.originals.get(objectId)))) onCommitTransforms(updates, gesture.kind === 'move' ? 'Move objects' : gesture.kind === 'resize' ? 'Resize object' : 'Rotate object')
    setGesture(null)
    setPreviewTransforms(new Map())
    setGuides({})
  }

  const transformWithKeyboard = (event: ReactKeyboardEvent<SVGElement>, kind: 'resize' | 'rotate') => {
    if (!authoringEnabled) return
    if (!primary || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    const source = shot.objects.find(({ id }) => id === primary.id)
    if (!source) return
    const sourceFamilyIds = familyIds(source.id)
    if ([...sourceFamilyIds].some((id) => effectiveLockOwner(shot, id))) {
      onNotice('This object family contains a lock; unlock every family member before transforming it.')
      return
    }
    if ([...sourceFamilyIds].some((id) => temporalPoseIds.has(id))) {
      onNotice('This playhead shows animated geometry. Edit the timeline block, or scrub before the spatial animation begins, to change the base pose.')
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (kind === 'rotate') {
      if (source.type === 'circle') return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && (source.type === 'line' || source.type === 'arrow')) {
      onNotice('Lines and arrows resize horizontally; use Left or Right Arrow on the handle.')
      return
    }
    onCommitKeyboardTransform({
      objectId: source.id,
      kind,
      key: event.key as CanvasKeyboardTransformIntent['key'],
      shiftKey: event.shiftKey,
    })
  }

  const primaryTransform = primary ? styledDisplayTransform(primary, shot, previewStyle, visibleObjects) : null
  const primaryMutationFamilyIds = primary ? familyIds(primary.id) : new Set<string>()
  const primaryFamilyLocked = [...primaryMutationFamilyIds].some((id) => Boolean(effectiveLockOwner(shot, id)))
  const primaryTemporallyTransformed = [...primaryMutationFamilyIds].some((id) => temporalPoseIds.has(id))
  const primaryWidth = primaryTransform ? (primaryTransform.width ?? 60) * Math.abs(primaryTransform.scaleX) : 0
  const primaryHeight = primaryTransform ? (primaryTransform.height ?? 30) * Math.abs(primaryTransform.scaleY) : 0
  const motionExceptionCount = shot.animations.filter(({ easing }) => easing !== previewStyle.motion.easing).length
  return (
    <div className="pc-stage-wrap" data-testid="proofcanvas-stage" style={{ background: previewStyle.colors.background, aspectRatio: `${frame.width} / ${frame.height}`, '--pc-stage-ratio': frame.width / frame.height } as CSSProperties}>
      <svg ref={svgRef} className="pc-stage" viewBox={`0 0 ${frame.width} ${frame.height}`} style={{ '--pc-stage-aspect': `${frame.width} / ${frame.height}` } as CSSProperties} data-preview-quality={previewQuality} data-authoring-enabled={authoringEnabled ? 'true' : 'false'} role="group" tabIndex={0} aria-disabled={!authoringEnabled} aria-label={`${shot.name} canvas at ${playhead.toFixed(1)} seconds${authoringEnabled ? '' : '; playback preview, editing disabled'}`} onPointerDown={(event) => { if (authoringEnabled && event.target === event.currentTarget) { event.currentTarget.focus({ preventScroll: true }); onSelect([]) } }} onPointerMove={onPointerMove} onPointerUp={endGesture} onPointerCancel={cancelGesture}>
        <defs><marker id="pc-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill={previewStyle.colors.ink}/></marker></defs>
        <g data-pc-camera-transform transform={`translate(${frame.centerX} ${frame.centerY}) scale(${preview.camera.zoom}) rotate(${-preview.camera.rotation}) translate(${-preview.camera.x} ${-preview.camera.y})`}>
          {guides.x !== undefined && <line className="pc-snap-guide" data-guide-axis="x" x1={guides.x} x2={guides.x} y1={0} y2={frame.height}/>}
          {guides.y !== undefined && <line className="pc-snap-guide" data-guide-axis="y" x1={0} x2={frame.width} y1={guides.y} y2={guides.y}/>}
          {visibleObjects.map((object) => <RenderObject key={object.id} object={object} style={previewStyle} selected={selectedIds.includes(object.id)} effectivelyLocked={Boolean(effectiveLockOwner(shot, object))} temporallyTransformed={temporalPoseIds.has(object.id)} interactive={authoringEnabled} onPointerDown={beginGesture}/>) }
          {authoringEnabled && primary?.type === 'group' && primaryTransform && <rect
            data-group-move-target={primary.id}
            aria-hidden="true"
            x={-primaryWidth / 2}
            y={-primaryHeight / 2}
            width={primaryWidth}
            height={primaryHeight}
            fill="transparent"
            pointerEvents="all"
            transform={`translate(${primaryTransform.x} ${primaryTransform.y}) rotate(${primaryTransform.rotation})`}
            style={{ cursor: primaryFamilyLocked || primaryTemporallyTransformed ? 'not-allowed' : 'move' }}
            onPointerDown={(event) => beginGesture(event, primary)}
          />}
          {authoringEnabled && primary && primaryTransform && !primaryFamilyLocked && !primaryTemporallyTransformed && <g className="pc-selection-handles" transform={`translate(${primaryTransform.x} ${primaryTransform.y}) rotate(${primaryTransform.rotation})`}>
            <rect x={-primaryWidth / 2} y={-primaryHeight / 2} width={primaryWidth} height={primaryHeight}/>
            {primary.type !== 'circle' && <circle className="pc-rotate-handle" cx={0} cy={-primaryHeight / 2 - 22} r={7} role="button" tabIndex={0} aria-label="Rotate selected object; use left and right arrow keys" onKeyDown={(event) => transformWithKeyboard(event, 'rotate')} onPointerDown={(event) => beginGesture(event, primary, 'rotate')}/>}
            <rect className="pc-resize-handle" x={primaryWidth / 2 - 6} y={primaryHeight / 2 - 6} width={12} height={12} role="button" tabIndex={0} aria-label="Resize selected object; use arrow keys" onKeyDown={(event) => transformWithKeyboard(event, 'resize')} onPointerDown={(event) => beginGesture(event, primary, 'resize')}/>
          </g>}
        </g>
      </svg>
      <div className="pc-stage-caption"><span>{previewStyle.name}</span><span>{previewStyle.layout.tendency.replace('-', ' ')} · {previewStyle.motion.easing} default{motionExceptionCount ? ` · ${motionExceptionCount} timeline exception${motionExceptionCount === 1 ? '' : 's'}` : ''}</span><span>{Math.round(preview.camera.zoom * 100)}% camera</span></div>
    </div>
  )
}
