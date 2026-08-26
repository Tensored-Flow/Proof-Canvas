'use client'

import katex from 'katex'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { previewShotAtTime } from '@/lib/proofcanvas/preview'
import { addTimelineTimes, compareTimelineTimes, logicalFrameFor, type LogicalFrame } from '@/lib/proofcanvas/frame'
import { analyzeMathProperties, texContentSegments, type MathMode } from '@/lib/proofcanvas/latex'
import { applyOperations, effectiveLockOwner } from '@/lib/proofcanvas/operations'
import { analyzeGraphExpression } from '@/lib/proofcanvas/graphExpression'
import { objectTypeSupportsStyleProperty, resolveDashedLinePattern, type ProjectDocument, type SceneObject, type Shot, type StylePack } from '@/lib/proofcanvas/schema'
import { freeformCubicSegments, isLinearShapeType, resolveArrowPreviewGeometry, resolveShapeDimensions, resolveShapeGeometry, resolveShapePaint } from '@/lib/proofcanvas/shapeGeometry'
import { PROOFCANVAS_SHAPE_PRESET_MIME, shapePresetById, type ShapePresetId } from '@/lib/proofcanvas/shapePresets'
import { resolvedGraphStroke, styledDisplayTransform, styledTransform } from '@/lib/proofcanvas/styles'

type Gesture = {
  kind: 'move' | 'resize' | 'rotate'
  pointerId: number
  start: { x: number; y: number }
  objectId: string
  displayOriginal: SceneObject['transform']
  originals: Map<string, SceneObject['transform']>
  commitIds: Set<string>
  baseRevision: string
  baseShotId: string
}

export function canvasGestureAuthorityInvalidated(
  gesture: Pick<Gesture, 'baseRevision' | 'baseShotId'> | null,
  authority: { authoringEnabled: boolean; projectRevision: string; shotId: string },
): boolean {
  if (!authority.authoringEnabled) return true
  return Boolean(gesture && (gesture.baseRevision !== authority.projectRevision || gesture.baseShotId !== authority.shotId))
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
  onInsertShapePresetAt?(presetId: ShapePresetId, point: { x: number; y: number }): void
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

function KatexMath({ content, mode }: { content: string; mode: MathMode }) {
  const rendered = useMemo(() => {
    try {
      return { ok: true as const, html: katex.renderToString(content, {
        displayMode: mode === 'display',
        maxExpand: 256,
        output: 'html',
        strict: 'error',
        throwOnError: true,
        trust: false,
      }) }
    } catch {
      return { ok: false as const }
    }
  }, [content, mode])
  return rendered.ok
    ? <span dangerouslySetInnerHTML={{ __html: rendered.html }} />
    : <span className="pc-math-diagnostic" role="img" aria-label="Mathematical content error: browser preview could not parse this expression.">LaTeX error · browser preview could not parse this expression.</span>
}

function texPlainTextForPreview(content: string): string {
  let output = ''
  for (let index = 0; index < content.length; index += 1) {
    if (/[ \t\r\n]/.test(content[index])) {
      while (index + 1 < content.length && /[ \t\r\n]/.test(content[index + 1])) index += 1
      if (output.at(-1) !== ' ' && output.at(-1) !== '\n') output += ' '
      continue
    }
    if (content[index] !== '\\' || content[index + 1] === undefined) {
      output += content[index]
      continue
    }
    const escaped = content[index + 1]
    index += 1
    if (escaped === '\\') output = `${output.endsWith(' ') ? output.slice(0, -1) : output}\n`
    else if (escaped === ',') output += '\u2009'
    else if (escaped === ';') output += '\u2003'
    else if (escaped === ':') output += '\u2005'
    else if (escaped !== '!') output += escaped
  }
  return output
}

function TexHtml({ content }: { content: string }) {
  const segments = texContentSegments(content)
  if (!segments.some(({ kind }) => kind === 'math')) {
    return <span className="pc-tex-content">{texPlainTextForPreview(content)}</span>
  }
  return <span className="pc-tex-content">{segments.map((segment, index) => (
    segment.kind === 'text'
      ? <span key={`${index}-text`}>{texPlainTextForPreview(segment.content)}</span>
      : <KatexMath key={`${index}-math`} content={segment.content} mode="inline" />
  ))}</span>
}

const MathHtml = memo(function MathHtml({ content, renderer, mode }: { content: unknown; renderer: unknown; mode: unknown }) {
  const analysis = useMemo(() => analyzeMathProperties({ content, renderer, mode }), [content, mode, renderer])
  if (!analysis.ok) {
    const message = analysis.ok ? 'Mathematical content is invalid.' : analysis.message
    return <span className="pc-math-diagnostic" role="img" aria-label={`Mathematical content error: ${message}`}>LaTeX error · {message}</span>
  }
  const properties = analysis.properties
  return <span className={`pc-math-render pc-math-${properties.mode}`} data-math-renderer={properties.renderer} data-math-mode={properties.mode}>
    {properties.renderer === 'mathtex'
      ? <KatexMath content={properties.content} mode={properties.mode}/>
      : <TexHtml content={properties.content}/>}
  </span>
})

const GRAPH_PREVIEW_COORDINATE_DECIMALS = 6

/**
 * React renders this attribute independently on the server and in the browser.
 * Quantizing only the final SVG coordinate prevents harmless libm tail-bit
 * differences from changing hydration strings; graph analysis remains at full
 * precision and still governs whether any segment is safe to draw.
 */
export function serializeGraphPreviewCoordinate(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('Graph preview coordinates must be finite.')
  const serialized = value.toFixed(GRAPH_PREVIEW_COORDINATE_DECIMALS)
  return serialized === '-0.000000' ? '0.000000' : serialized
}

const GraphGeometry = memo(function GraphGeometry({ expression, xMin, xMax, width, height, stroke, strokeWidth }: {
  expression: unknown
  xMin: number
  xMax: number
  width: number
  height: number
  stroke: string
  strokeWidth: number
}) {
  const expressionKey = JSON.stringify(expression)
  // Preview objects are sampled anew at each playhead tick. Depending on the
  // stable serialized graph authority prevents that animation sampling from
  // resampling the graph lattice.
  const analysis = useMemo(
    () => analyzeGraphExpression(expression, xMin, xMax),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expressionKey, xMax, xMin],
  )
  if (!analysis.ok) {
    const message = analysis.diagnostics[0]?.message ?? 'Graph geometry is invalid.'
    return <g
      data-graph-analysis-hash={analysis.analysisHash}
      data-graph-segment-count="0"
      data-graph-status="invalid"
      role="img"
      aria-label={`Graph error: ${message}`}
    >
      <rect x={-width / 2} y={-height / 2} width={width} height={height} rx="6" fill="none" stroke={stroke} strokeWidth={Math.max(1, strokeWidth)} strokeDasharray="8 6" opacity="0.65"/>
      <path d={`M ${-width / 6} ${-height / 6} L ${width / 6} ${height / 6} M ${width / 6} ${-height / 6} L ${-width / 6} ${height / 6}`} stroke={stroke} strokeWidth={Math.max(1, strokeWidth)} opacity="0.75"/>
    </g>
  }
  return <g
    data-graph-analysis-hash={analysis.analysisHash}
    data-graph-diagnostic-codes={analysis.diagnostics.map(({ code }) => code).join(' ')}
    data-graph-segment-count={analysis.normalizedSegments.length}
    data-graph-status="valid"
  >
    {analysis.normalizedSegments.map((segment, index) => <polyline
      key={`${analysis.analysisHash}-${index}`}
      data-graph-segment-index={index}
      points={segment.map(({ x, y }) => `${serializeGraphPreviewCoordinate(x * width)},${serializeGraphPreviewCoordinate(-y * height)}`).join(' ')}
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      vectorEffect="non-scaling-stroke"
    />)}
  </g>
})

export function temporallyTransformsObject(shot: Shot, objectId: string, time: number): boolean {
  const targetFamily = new Set<string>()
  let cursor = shot.objects.find(({ id }) => id === objectId)
  while (cursor) {
    targetFamily.add(cursor.id)
    cursor = cursor.parentId ? shot.objects.find(({ id }) => id === cursor?.parentId) : undefined
  }
  const semanticAnimationTransforms = shot.animations.some((animation) => {
    if (!animation.targetIds.some((id) => targetFamily.has(id))) return false
    if (animation.type === 'move' || animation.type === 'scale' || animation.type === 'transform') {
      return compareTimelineTimes(time, animation.start) > 0
    }
    return animation.type === 'emphasise'
      && compareTimelineTimes(time, animation.start) > 0
      && compareTimelineTimes(time, addTimelineTimes(animation.start, animation.duration)) < 0
  })
  if (semanticAnimationTransforms) return true
  const spatialProperties = new Set(['x', 'y', 'width', 'height', 'scale', 'scaleX', 'scaleY', 'rotation'])
  return shot.propertyTracks.some((track) => (
    track.target.kind === 'object'
    && targetFamily.has(track.target.objectId)
    && spatialProperties.has(track.property)
    && compareTimelineTimes(time, track.keyframes[0].time) >= 0
  ))
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
  if (intent.kind === 'resize' && (intent.key === 'ArrowUp' || intent.key === 'ArrowDown') && isLinearShapeType(source.type)) {
    return { notice: 'Linear shapes resize horizontally; use Left or Right Arrow on the handle.' }
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

function RenderObject({ object, style, selected, effectivelyLocked, temporallyTransformed, tipLengthLimit, interactive = true, onPointerDown }: { object: ReturnType<typeof previewShotAtTime>['objects'][number]; style: StylePack; selected: boolean; effectivelyLocked: boolean; temporallyTransformed: boolean; tipLengthLimit: number; interactive?: boolean; onPointerDown?(event: ReactPointerEvent<SVGElement>, object: SceneObject): void }) {
  const transform = styledTransform(object, style)
  const { width, height } = resolveShapeDimensions({ transform })
  const opacity = object.preview.opacity
  const geometry = resolveShapeGeometry({ ...object, transform }, style)
  const paint = resolveShapePaint(object, style)
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
  const fill = paint ? paint.fill ?? 'none' : objectTypeSupportsStyleProperty(object, 'fill') ? object.style.fill ?? 'none' : 'none'
  const stroke = paint ? paint.stroke : objectTypeSupportsStyleProperty(object, 'stroke') ? object.style.stroke ?? style.colors.ink : 'none'
  const strokeWidth = paint ? paint.strokeWidth : objectTypeSupportsStyleProperty(object, 'strokeWidth') ? object.style.strokeWidth ?? style.strokes.regular : 0
  switch (object.type) {
    case 'text':
    case 'math':
      return (
        <foreignObject {...common} x={-width / 2} y={-height / 2} width={width} height={height}>
          <div className={`pc-canvas-text pc-${object.type}`} style={{ color: objectTypeSupportsStyleProperty(object, 'fill') ? object.style.fill ?? object.style.color ?? style.colors.ink : object.style.color ?? style.colors.ink, fontSize: object.style.fontSize ?? 22, fontWeight: object.style.fontWeight, textAlign: object.style.textAlign ?? 'left', fontFamily: object.type === 'math' ? style.typography.math : style.typography.statement }}>
            {object.type === 'math' ? <MathHtml content={object.properties.content} renderer={object.properties.renderer} mode={object.properties.mode} /> : String(object.properties.content ?? '')}
          </div>
        </foreignObject>
      )
    case 'circle': return <ellipse {...common} rx={width / 2} ry={height / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
    case 'rectangle': return <rect {...common} x={-width / 2} y={-height / 2} width={width} height={height} rx={geometry?.kind === 'rectangle' ? geometry.cornerRadius : 0} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
    case 'ellipse': return <ellipse {...common} rx={width / 2} ry={height / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
    case 'polygon': {
      const polygon = geometry?.kind === 'polygon' ? geometry : null
      const points = (polygon?.vertices ?? []).map(({ x, y }) => `${x * width},${y * height}`).join(' ')
      return <polygon {...common} points={points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin={polygon?.lineJoin ?? 'miter'}/>
    }
    case 'line': return <g {...common}><line x1={-width / 2} x2={width / 2} y1={0} y2={0} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap={geometry?.kind === 'line' ? geometry.lineCap : 'butt'} pointerEvents="none"/><line x1={-width / 2} x2={width / 2} y1={0} y2={0} stroke="transparent" strokeWidth={Math.max(16, strokeWidth)} pointerEvents="stroke"/></g>
    case 'dashed-line': {
      const dashed = geometry?.kind === 'dashed-line' ? geometry : null
      const pattern = resolveDashedLinePattern(width, dashed?.dashLength ?? 12, dashed?.gapLength ?? 8)
      const dashArray = pattern ? `${pattern.renderedDashLength} ${pattern.renderedGapLength}` : '0 1'
      const cap = dashed?.lineCap ?? 'butt'
      return <g {...common} data-dash-count={pattern?.count ?? 0} data-dash-length={dashed?.dashLength ?? 12} data-gap-length={dashed?.gapLength ?? 8}><line x1={-width / 2} x2={width / 2} y1={0} y2={0} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap={cap} strokeDasharray={dashArray} pointerEvents="none"/><line x1={-width / 2} x2={width / 2} y1={0} y2={0} stroke="transparent" strokeWidth={Math.max(16, strokeWidth)} pointerEvents={interactive ? 'stroke' : 'none'}/></g>
    }
    case 'arrow': {
      const arrow = geometry?.kind === 'arrow' ? geometry : null
      const tipGeometry = resolveArrowPreviewGeometry(
        width,
        arrow?.tipShape ?? 'triangle',
        arrow?.tipSizeRatio ?? 0.25,
        tipLengthLimit,
      )
      const tip = tipGeometry.kind === 'circle'
        ? <circle data-arrow-tip-shape="circle" cx={tipGeometry.centerX} cy={0} r={tipGeometry.radius} fill={stroke} stroke={stroke} strokeWidth={strokeWidth}/>
        : <polygon data-arrow-tip-shape={tipGeometry.kind} points={tipGeometry.points.map(({ x, y }) => `${x},${y}`).join(' ')} fill={stroke} stroke={stroke} strokeWidth={strokeWidth}/>
      return <g {...common} data-arrow-tip-length={tipGeometry.tipLength} data-arrow-shaft-end={tipGeometry.shaftEndX}><line x1={-width / 2} x2={tipGeometry.shaftEndX} y1={0} y2={0} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap={arrow?.lineCap ?? 'butt'} pointerEvents="none"/>{tip}<line x1={-width / 2} x2={tipGeometry.tipX} y1={0} y2={0} stroke="transparent" strokeWidth={Math.max(16, strokeWidth)} pointerEvents={interactive ? 'stroke' : 'none'}/></g>
    }
    case 'double-arrow': {
      const arrow = geometry?.kind === 'double-arrow' ? geometry : null
      const end = resolveArrowPreviewGeometry(width, arrow?.endTipShape ?? 'triangle', arrow?.tipSizeRatio ?? 0.25, tipLengthLimit)
      const startSource = resolveArrowPreviewGeometry(width, arrow?.startTipShape ?? 'triangle', arrow?.tipSizeRatio ?? 0.25, tipLengthLimit)
      const startShaft = -startSource.shaftEndX
      const renderTip = (tip: typeof end, side: 'start' | 'end') => {
        const sign = side === 'start' ? -1 : 1
        if (tip.kind === 'circle') return <circle data-arrow-tip-side={side} data-arrow-tip-shape="circle" cx={sign * tip.centerX} cy={0} r={tip.radius} fill={stroke} stroke={stroke} strokeWidth={strokeWidth}/>
        return <polygon data-arrow-tip-side={side} data-arrow-tip-shape={tip.kind} points={tip.points.map(({ x, y }) => `${sign * x},${y}`).join(' ')} fill={stroke} stroke={stroke} strokeWidth={strokeWidth}/>
      }
      return <g {...common} data-start-arrow-tip-length={startSource.tipLength} data-end-arrow-tip-length={end.tipLength}><line x1={startShaft} x2={end.shaftEndX} y1={0} y2={0} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap={arrow?.lineCap ?? 'butt'} pointerEvents="none"/>{renderTip(startSource, 'start')}{renderTip(end, 'end')}<line x1={-width / 2} x2={width / 2} y1={0} y2={0} stroke="transparent" strokeWidth={Math.max(16, strokeWidth)} pointerEvents={interactive ? 'stroke' : 'none'}/></g>
    }
    case 'freeform-path': {
      const path = geometry?.kind === 'freeform-path' ? geometry : null
      if (!path) return null
      const point = ({ x, y }: { x: number; y: number }) => `${x * width} ${y * height}`
      const segments = freeformCubicSegments(path)
      const d = [`M ${point(path.nodes[0].point)}`, ...segments.map(({ control1, control2, end }) => `C ${point(control1)}, ${point(control2)}, ${point(end)}`), ...(path.closed ? ['Z'] : [])].join(' ')
      const visible = <path d={d} fill={path.closed ? fill : 'none'} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap={path.closed ? undefined : path.lineCap} strokeLinejoin={path.lineJoin} pointerEvents="none"/>
      return <g {...common} data-freeform-closed={path.closed ? 'true' : 'false'}>{visible}<path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(16, strokeWidth)} pointerEvents={interactive ? 'stroke' : 'none'}/></g>
    }
    case 'brace': {
      const brace = geometry?.kind === 'brace' ? geometry : { kind: 'brace' as const, direction: 'below' as const, spacing: 12 }
      const fontSize = object.style.fontSize ?? 22
      if (brace.direction === 'left' || brace.direction === 'right') {
        const sign = brace.direction === 'right' ? 1 : -1
        const amplitude = sign * width / 2
        const offset = sign * brace.spacing
        return <g {...common}><path d={`M ${offset} ${-height / 2} C ${offset + amplitude} ${-height / 4}, ${offset + amplitude} ${-height / 4}, ${offset + amplitude} 0 C ${offset + amplitude} ${height / 4}, ${offset + amplitude} ${height / 4}, ${offset} ${height / 2}`} fill="none" stroke={stroke} strokeWidth={strokeWidth}/><text x={sign * (width + brace.spacing)} y={0} textAnchor={sign > 0 ? 'start' : 'end'} dominantBaseline="middle" fill={paint?.labelColor ?? style.colors.warmAccent} fontSize={fontSize}>{String(object.properties.label ?? '')}</text></g>
      }
      const sign = brace.direction === 'below' ? 1 : -1
      const amplitude = sign * height / 2
      const offset = sign * brace.spacing
      return <g {...common}><path d={`M ${-width / 2} ${offset} C ${-width / 4} ${offset + amplitude}, ${-width / 4} ${offset + amplitude}, 0 ${offset + amplitude} C ${width / 4} ${offset + amplitude}, ${width / 4} ${offset + amplitude}, ${width / 2} ${offset}`} fill="none" stroke={stroke} strokeWidth={strokeWidth}/><text y={sign * (height + brace.spacing)} textAnchor="middle" fill={paint?.labelColor ?? style.colors.warmAccent} fontSize={fontSize}>{String(object.properties.label ?? '')}</text></g>
    }
    case 'axes': return <g {...common} stroke={stroke} strokeWidth={strokeWidth}><line x1={-width / 2} x2={width / 2}/><line y1={-height / 2} y2={height / 2}/>{[-2,-1,1,2].map((tick) => <line key={`x${tick}`} x1={tick * width / 5} x2={tick * width / 5} y1={-3} y2={3}/>)}</g>
    case 'graph': {
      const graphStroke = resolvedGraphStroke(object, style)
      return <g {...common}><GraphGeometry
        expression={object.properties.expression}
        xMin={Number(object.properties.xMin)}
        xMax={Number(object.properties.xMax)}
        width={width}
        height={height}
        stroke={graphStroke.stroke}
        strokeWidth={graphStroke.strokeWidth}
      /></g>
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
  const visibleObjects = preview.objects.filter((object) => object.preview.opacity > 0.001)
  return <svg className="pc-shot-thumbnail" viewBox={`0 0 ${frame.width} ${frame.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false" data-thumbnail-shot-id={shot.id} data-thumbnail-time="0">
    <rect width={frame.width} height={frame.height} fill={previewStyle.colors.background}/>
    <g transform={`translate(${frame.centerX} ${frame.centerY}) scale(${preview.camera.zoom}) rotate(${-preview.camera.rotation}) translate(${-preview.camera.x} ${-preview.camera.y})`}>
      {visibleObjects.map((object) => <RenderObject key={object.id} object={object} style={previewStyle} selected={false} effectivelyLocked={false} temporallyTransformed={false} tipLengthLimit={0.35 * frame.width / frame.manimWidth} interactive={false}/>) }
    </g>
  </svg>
}, (previous, next) => previous.visualRevision === next.visualRevision)

export default function CanvasStage({ project, shot, playhead, previewStyle, projectRevision, previewQuality, selectedIds, authoringEnabled = true, onSelect, onCommitTransforms, onCommitKeyboardTransform, onInsertShapePresetAt, onNotice }: CanvasStageProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const [previewTransforms, setPreviewTransforms] = useState<Map<string, SceneObject['transform']>>(new Map())
  const previewTransformsRef = useRef<Map<string, SceneObject['transform']>>(new Map())
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({})
  const frame = useMemo(() => logicalFrameFor(project.settings.aspectRatio), [project.settings.aspectRatio])
  const preview = useMemo(() => previewShotAtTime(shot, playhead), [shot, playhead])
  const dropShapePreset = (event: ReactDragEvent<SVGSVGElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(PROOFCANVAS_SHAPE_PRESET_MIME)) return
    event.preventDefault()
    event.stopPropagation()
    const presetId = event.dataTransfer.getData(PROOFCANVAS_SHAPE_PRESET_MIME)
    if (!authoringEnabled) {
      onNotice('Pause playback before dropping a shape.')
      return
    }
    if (!onInsertShapePresetAt) {
      onNotice('Shape insertion is not available on this canvas.')
      return
    }
    if (!shapePresetById(presetId)) {
      onNotice('That shape preset is not available.')
      return
    }
    onInsertShapePresetAt(presetId as ShapePresetId, cameraPoint(svgPoint(event.currentTarget, event), preview.camera, frame))
  }
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
    gestureRef.current = null
    previewTransformsRef.current = new Map()
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
  // This must be conditional: a passive effect from the preceding commit may
  // run after the user has already started a new gesture on the new revision.
  useEffect(() => {
    const activeGesture = gestureRef.current
    if (canvasGestureAuthorityInvalidated(activeGesture, { authoringEnabled, projectRevision, shotId: shot.id })) cancelGesture()
  }, [authoringEnabled, cancelGesture, projectRevision, shot.id])

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
    if (event.button !== 0 || event.isPrimary === false || gestureRef.current) return
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
    const nextGesture = { kind, pointerId: event.pointerId, start: cameraPoint(svgPoint(svgRef.current, event.nativeEvent), preview.camera, frame), objectId: object.id, displayOriginal: styledDisplayTransform(object, shot, previewStyle, visibleObjects), originals, commitIds, baseRevision: projectRevision, baseShotId: shot.id }
    const initialTransforms = new Map(originals)
    gestureRef.current = nextGesture
    previewTransformsRef.current = initialTransforms
    setPreviewTransforms(initialTransforms)
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!authoringEnabled) return
    const activeGesture = gestureRef.current
    if (!activeGesture || !svgRef.current || event.pointerId !== activeGesture.pointerId) return
    const point = cameraPoint(svgPoint(svgRef.current, event.nativeEvent), preview.camera, frame)
    const dx = point.x - activeGesture.start.x
    const dy = point.y - activeGesture.start.y
    const next = new Map(activeGesture.originals)
    const primaryOriginal = activeGesture.originals.get(activeGesture.objectId)
    if (!primaryOriginal) return
    if (activeGesture.kind === 'move') {
      let snapX: number | undefined
      let snapY: number | undefined
      const primarySource = shot.objects.find(({ id }) => id === activeGesture.objectId)
      if (!primarySource) return
      const sourceAtStart = { ...primarySource, transform: primaryOriginal }
      const authoredDx = rawDeltaForStyledDelta(sourceAtStart, previewStyle, 'x', dx)
      const authoredDy = rawDeltaForStyledDelta(sourceAtStart, previewStyle, 'y', dy)
      const candidateObject = { ...primarySource, transform: { ...primaryOriginal, x: primaryOriginal.x + authoredDx, y: primaryOriginal.y + authoredDy } }
      const candidateX = activeGesture.displayOriginal.x + dx
      const candidateY = activeGesture.displayOriginal.y + dy
      const snapObjects = visibleObjects.filter(({ id }) => !activeGesture.originals.has(id))
      const xTargets = [frame.centerX, ...snapObjects.map((object) => styledDisplayTransform(object, shot, previewStyle, visibleObjects).x)]
      const yTargets = [frame.centerY, ...snapObjects.map((object) => styledDisplayTransform(object, shot, previewStyle, visibleObjects).y)]
      snapX = xTargets.find((target) => Math.abs(target - candidateX) <= 6)
      snapY = yTargets.find((target) => Math.abs(target - candidateY) <= 6)
      const correctionX = snapX === undefined ? 0 : rawDeltaForStyledDelta(candidateObject, previewStyle, 'x', snapX - candidateX)
      const correctionY = snapY === undefined ? 0 : rawDeltaForStyledDelta(candidateObject, previewStyle, 'y', snapY - candidateY)
      for (const [id, original] of activeGesture.originals) next.set(id, { ...original, x: original.x + authoredDx + correctionX, y: original.y + authoredDy + correctionY })
      setGuides({ x: snapX, y: snapY })
    } else if (activeGesture.kind === 'resize') {
      const source = shot.objects.find(({ id }) => id === activeGesture.objectId)
      if (!source) return
      const radians = activeGesture.displayOriginal.rotation * Math.PI / 180
      const localDx = dx * Math.cos(radians) + dy * Math.sin(radians)
      const localDy = -dx * Math.sin(radians) + dy * Math.cos(radians)
      const displayWidth = (activeGesture.displayOriginal.width ?? 60) * Math.abs(activeGesture.displayOriginal.scaleX)
      const displayHeight = (activeGesture.displayOriginal.height ?? 30) * Math.abs(activeGesture.displayOriginal.scaleY)
      const nextDisplayWidth = Math.max(10, displayWidth + localDx * 2)
      const nextDisplayHeight = Math.max(10, displayHeight + localDy * 2)
      let transform = {
        ...primaryOriginal,
        width: Math.max(1, (primaryOriginal.width ?? 60) * nextDisplayWidth / Math.max(1, displayWidth)),
        height: isLinearShapeType(source.type)
          ? primaryOriginal.height
          : Math.max(1, (primaryOriginal.height ?? 30) * nextDisplayHeight / Math.max(1, displayHeight)),
      }
      if (source?.type === 'group') {
        const simulation = simulateGroupTransformAroundDisplayCenter(source, transform, activeGesture.displayOriginal)
        const simulated = simulation.shot
        for (const id of activeGesture.originals.keys()) {
          const candidate = simulated.objects.find((object) => object.id === id)
          if (candidate) next.set(id, candidate.transform)
        }
        next.set(source.id, simulation.transform)
      } else {
        const candidate = { ...source, transform }
        const displayed = styledTransform(candidate, previewStyle)
        transform = {
          ...transform,
          x: transform.x + rawDeltaForStyledDelta(candidate, previewStyle, 'x', activeGesture.displayOriginal.x - displayed.x),
          y: transform.y + rawDeltaForStyledDelta(candidate, previewStyle, 'y', activeGesture.displayOriginal.y - displayed.y),
        }
        next.set(activeGesture.objectId, transform)
      }
    } else {
      const displayAngle = Math.atan2(point.y - activeGesture.displayOriginal.y, point.x - activeGesture.displayOriginal.x) * 180 / Math.PI + 90
      const rotationDelta = displayAngle - activeGesture.displayOriginal.rotation
      const transform = { ...primaryOriginal, rotation: Math.round((primaryOriginal.rotation + rotationDelta) * 10) / 10 }
      const source = shot.objects.find(({ id }) => id === activeGesture.objectId)
      if (source?.type === 'group') {
        const simulation = simulateGroupTransformAroundDisplayCenter(source, transform, activeGesture.displayOriginal)
        const simulated = simulation.shot
        for (const id of activeGesture.originals.keys()) {
          const candidate = simulated.objects.find((object) => object.id === id)
          if (candidate) next.set(id, candidate.transform)
        }
        next.set(source.id, simulation.transform)
      } else next.set(activeGesture.objectId, transform)
    }
    previewTransformsRef.current = next
    setPreviewTransforms(next)
  }

  const endGesture = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!authoringEnabled) { cancelGesture(); return }
    const activeGesture = gestureRef.current
    if (!activeGesture || event.pointerId !== activeGesture.pointerId) return
    if (activeGesture.baseRevision !== projectRevision || activeGesture.baseShotId !== shot.id) {
      cancelGesture()
      return
    }
    const updates = [...previewTransformsRef.current].filter(([objectId]) => activeGesture.commitIds.has(objectId)).map(([objectId, transform]) => ({ objectId, transform }))
    const changed = updates.some(({ objectId, transform }) => JSON.stringify(transform) !== JSON.stringify(activeGesture.originals.get(objectId)))
    cancelGesture()
    if (changed) onCommitTransforms(updates, activeGesture.kind === 'move' ? 'Move objects' : activeGesture.kind === 'resize' ? 'Resize object' : 'Rotate object')
  }

  const cancelPointerGesture = (event: ReactPointerEvent<SVGSVGElement>) => {
    const activeGesture = gestureRef.current
    if (!activeGesture || event.pointerId !== activeGesture.pointerId) return
    cancelGesture()
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
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && isLinearShapeType(source.type)) {
      onNotice('Linear shapes resize horizontally; use Left or Right Arrow on the handle.')
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
      <svg ref={svgRef} className="pc-stage" viewBox={`0 0 ${frame.width} ${frame.height}`} style={{ '--pc-stage-aspect': `${frame.width} / ${frame.height}` } as CSSProperties} data-preview-quality={previewQuality} data-authoring-enabled={authoringEnabled ? 'true' : 'false'} data-shape-drop-enabled={authoringEnabled && onInsertShapePresetAt ? 'true' : 'false'} role="group" tabIndex={0} aria-disabled={!authoringEnabled} aria-label={`${shot.name} canvas at ${playhead.toFixed(1)} seconds${authoringEnabled ? '' : '; playback preview, editing disabled'}`} onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes(PROOFCANVAS_SHAPE_PRESET_MIME)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = authoringEnabled && onInsertShapePresetAt ? 'copy' : 'none' } }} onDrop={dropShapePreset} onPointerDown={(event) => { if (authoringEnabled && event.target === event.currentTarget) { event.currentTarget.focus({ preventScroll: true }); onSelect([]) } }} onPointerMove={onPointerMove} onPointerUp={endGesture} onPointerCancel={cancelPointerGesture}>
        <g data-pc-camera-transform transform={`translate(${frame.centerX} ${frame.centerY}) scale(${preview.camera.zoom}) rotate(${-preview.camera.rotation}) translate(${-preview.camera.x} ${-preview.camera.y})`}>
          {guides.x !== undefined && <line className="pc-snap-guide" data-guide-axis="x" x1={guides.x} x2={guides.x} y1={0} y2={frame.height}/>}
          {guides.y !== undefined && <line className="pc-snap-guide" data-guide-axis="y" x1={0} x2={frame.width} y1={guides.y} y2={guides.y}/>}
          {visibleObjects.map((object) => <RenderObject key={object.id} object={object} style={previewStyle} selected={selectedIds.includes(object.id)} effectivelyLocked={Boolean(effectiveLockOwner(shot, object))} temporallyTransformed={temporalPoseIds.has(object.id)} tipLengthLimit={0.35 * frame.width / frame.manimWidth} interactive={authoringEnabled} onPointerDown={beginGesture}/>) }
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
