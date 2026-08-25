import { act, fireEvent, render } from '@testing-library/react'
import katex from 'katex'
import CanvasStage, { CanvasThumbnail, canvasGestureAuthorityInvalidated, resolveCanvasKeyboardTransformIntent, serializeGraphPreviewCoordinate, temporallyTransformsObject } from '../CanvasStage'
import { compileManim } from '@/lib/proofcanvas/compiler'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { logicalFrameFor, resolutionFor, type ProofCanvasAspectRatio } from '@/lib/proofcanvas/frame'
import * as latexAuthority from '@/lib/proofcanvas/latex'
import * as graphAuthority from '@/lib/proofcanvas/graphExpression'
import { ProjectDocumentSchema, cloneSerializable, type SceneObject } from '@/lib/proofcanvas/schema'
import { resolveArrowPreviewGeometry } from '@/lib/proofcanvas/shapeGeometry'
import { insertShapePreset, PROOFCANVAS_SHAPE_PRESET_MIME } from '@/lib/proofcanvas/shapePresets'

jest.mock('@/lib/proofcanvas/latex', () => {
  const actual = jest.requireActual('@/lib/proofcanvas/latex') as typeof import('@/lib/proofcanvas/latex')
  return { ...actual, analyzeMathProperties: jest.fn(actual.analyzeMathProperties) }
})

jest.mock('@/lib/proofcanvas/graphExpression', () => {
  const actual = jest.requireActual('@/lib/proofcanvas/graphExpression') as typeof import('@/lib/proofcanvas/graphExpression')
  return { ...actual, analyzeGraphExpression: jest.fn(actual.analyzeGraphExpression) }
})

function installTestPointerEvent() {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number
    readonly isPrimary: boolean

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
      this.isPrimary = init.isPrimary ?? true
    }
  }
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent })
}

function stageDragEvent(
  type: 'dragover' | 'drop',
  dataTransfer: { types: string[]; effectAllowed: string; dropEffect: string; getData(type: string): string },
  point = { x: 0, y: 0 },
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientX: { configurable: true, value: point.x },
    clientY: { configurable: true, value: point.y },
    dataTransfer: { configurable: true, value: dataTransfer },
  })
  return event
}

test('invalidates only canvas drafts whose recorded authority is stale', () => {
  const current = { baseRevision: 'revision-b', baseShotId: 'shot-b' }
  expect(canvasGestureAuthorityInvalidated(null, { authoringEnabled: true, projectRevision: 'revision-b', shotId: 'shot-b' })).toBe(false)
  expect(canvasGestureAuthorityInvalidated(current, { authoringEnabled: true, projectRevision: 'revision-b', shotId: 'shot-b' })).toBe(false)
  expect(canvasGestureAuthorityInvalidated(current, { authoringEnabled: true, projectRevision: 'revision-c', shotId: 'shot-b' })).toBe(true)
  expect(canvasGestureAuthorityInvalidated(current, { authoringEnabled: true, projectRevision: 'revision-b', shotId: 'shot-c' })).toBe(true)
  expect(canvasGestureAuthorityInvalidated(current, { authoringEnabled: false, projectRevision: 'revision-b', shotId: 'shot-b' })).toBe(true)
})

test('text and math glyph color follows nested/keyframed fill with fill over color precedence', () => {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  project.shots = [shot]
  shot.animations = []
  const text = shot.objects.find(({ type }) => type === 'text')!
  const math = shot.objects.find(({ type }) => type === 'math')!
  text.style = { ...text.style, color: '#ff0000', fill: '#abcdef' }
  math.style = { ...math.style, color: '#00ff00' }
  const root: SceneObject = {
    id: 'group-glyph-fill-root', type: 'group', name: 'Glyph fill root', locked: false, visible: true,
    transform: { x: 480, y: 270, rotation: 0, scaleX: 1, scaleY: 1 }, style: { fill: '#112233' }, properties: {},
  }
  const nested: SceneObject = {
    ...cloneSerializable(root), id: 'group-glyph-fill-nested', name: 'Glyph fill nested', parentId: root.id, style: {},
  }
  text.parentId = nested.id
  math.parentId = nested.id
  shot.objects = [root, nested, text, math]
  shot.propertyTracks = [{
    id: 'track-glyph-fill', target: { kind: 'object', objectId: root.id }, property: 'fill', keyframes: [
      { id: 'keyframe-glyph-fill-a', time: 1, value: '#000000', interpolation: { kind: 'linear' } },
      { id: 'keyframe-glyph-fill-b', time: 3, value: '#ffffff', interpolation: { kind: 'linear' } },
    ],
  }]
  const parsed = ProjectDocumentSchema.parse(project)
  const props = {
    project: parsed,
    shot: parsed.shots[0],
    previewStyle: parsed.styles.find(({ id }) => id === parsed.activeStyleId)!,
    projectRevision: 'revision-a',
    previewQuality: parsed.settings.previewQuality,
    selectedIds: [],
    onSelect: jest.fn(),
    onCommitTransforms: jest.fn(),
    onCommitKeyboardTransform: jest.fn(),
    onNotice: jest.fn(),
  }
  const view = render(<CanvasStage {...props} playhead={0} />)
  expect(view.container.querySelector('.pc-text')).toHaveStyle({ color: '#abcdef' })
  expect(view.container.querySelector('.pc-math')).toHaveStyle({ color: '#112233' })
  view.rerender(<CanvasStage {...props} playhead={2} />)
  expect(view.container.querySelector('.pc-text')).toHaveStyle({ color: '#808080' })
  expect(view.container.querySelector('.pc-math')).toHaveStyle({ color: '#808080' })
  view.rerender(<CanvasStage {...props} playhead={3} />)
  expect(view.container.querySelector('.pc-text')).toHaveStyle({ color: '#ffffff' })
  expect(view.container.querySelector('.pc-math')).toHaveStyle({ color: '#ffffff' })
  const compilable = cloneSerializable(parsed)
  compilable.shots[0].propertyTracks[0].keyframes[0].time = 0
  const source = compileManim(ProjectDocumentSchema.parse(compilable)).python
  expect(source.match(/\.set_fill\("#ffffff", opacity=1\.0\)/g)).toHaveLength(2)
})

test('graph stroke width uses the object override', () => {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[1]
  project.shots = [shot]
  const graph: SceneObject = {
    id: 'object-graph-stroke-width', type: 'graph', name: 'Stroke-width graph', locked: false, visible: true,
    transform: { x: 480, y: 270, width: 320, height: 180, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {}, properties: { expression: { kind: 'variable' }, xMin: -3, xMax: 3 },
  }
  graph.style.strokeWidth = 11
  shot.objects = [graph]
  shot.animations = []
  shot.propertyTracks = []
  const parsed = ProjectDocumentSchema.parse(project)
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={0}
    previewStyle={parsed.styles.find(({ id }) => id === parsed.activeStyleId)!}
    projectRevision="revision-a"
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />)
  expect(view.container.querySelector('polyline')).toHaveAttribute('stroke-width', '11')
})

test('shares style-pack graph stroke defaults across preview and compiled animation targets', () => {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[1]
  project.shots = [shot]
  const graph: SceneObject = {
    id: 'object-graph-style-default', type: 'graph', name: 'Default-style graph', locked: false, visible: true,
    transform: { x: 480, y: 270, width: 320, height: 180, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {}, properties: { expression: { kind: 'variable' }, xMin: -3, xMax: 3 },
  }
  shot.objects = [graph]
  shot.animations = []
  shot.propertyTracks = [{
    id: 'track-graph-style-default-x',
    target: { kind: 'object', objectId: graph.id },
    property: 'x',
    keyframes: [
      { id: 'keyframe-graph-style-default-x-a', time: 0, value: 480, interpolation: { kind: 'linear' } },
      { id: 'keyframe-graph-style-default-x-b', time: 1, value: 560, interpolation: { kind: 'linear' } },
    ],
  }]
  const parsed = ProjectDocumentSchema.parse(project)
  const previewStyle = parsed.styles.find(({ id }) => id === parsed.activeStyleId)!
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={0}
    previewStyle={previewStyle}
    projectRevision="revision-style-default"
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />)
  expect(view.container.querySelector('polyline')).toHaveAttribute('stroke', previewStyle.colors.coolAccent)
  expect(view.container.querySelector('polyline')).toHaveAttribute('stroke-width', String(previewStyle.graph.curveWeight))

  const source = compileManim(parsed).python
  const effectiveStroke = `.set_stroke("${previewStyle.colors.coolAccent}", width=${previewStyle.graph.curveWeight})`
  expect(source.split(effectiveStroke).length - 1).toBeGreaterThanOrEqual(2)
})

test('quantizes graph SVG coordinates across observed server/browser tail-bit variance', () => {
  expect(serializeGraphPreviewCoordinate(44.885171733810694)).toBe('44.885172')
  expect(serializeGraphPreviewCoordinate(44.8851717338107)).toBe('44.885172')
  expect(serializeGraphPreviewCoordinate(-0)).toBe('0.000000')
  expect(() => serializeGraphPreviewCoordinate(Number.NaN)).toThrow('Graph preview coordinates must be finite.')
})

test('graph preview uses exact expression/domain segments, stable evidence, and no playhead resampling', () => {
  const analyzer = graphAuthority.analyzeGraphExpression as jest.MockedFunction<typeof graphAuthority.analyzeGraphExpression>
  analyzer.mockClear()
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  const graph: SceneObject = {
    id: 'object-graph-shared-geometry', type: 'graph', name: 'Reciprocal graph', locked: false, visible: true,
    transform: { x: 480, y: 270, width: 320, height: 180, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { stroke: '#315866' }, properties: {
      expression: { kind: 'divide', left: { kind: 'constant', value: 1 }, right: { kind: 'variable' } },
      xMin: -2,
      xMax: 2,
    },
  }
  shot.objects = [graph]
  shot.animations = []
  shot.propertyTracks = []
  project.shots = [shot]
  const parsed = ProjectDocumentSchema.parse(project)
  const expected = graphAuthority.analyzeGraphExpression(graph.properties.expression, -2, 2)
  analyzer.mockClear()
  const props = {
    project: parsed,
    shot: parsed.shots[0],
    previewStyle: parsed.styles.find(({ id }) => id === parsed.activeStyleId)!,
    projectRevision: 'graph-preview-a',
    previewQuality: parsed.settings.previewQuality,
    selectedIds: [] as string[],
    onSelect: jest.fn(),
    onCommitTransforms: jest.fn(),
    onCommitKeyboardTransform: jest.fn(),
    onNotice: jest.fn(),
  }
  const view = render(<CanvasStage {...props} playhead={0}/>)
  const geometry = view.container.querySelector('[data-graph-status="valid"]')
  expect(geometry).toHaveAttribute('data-graph-analysis-hash', expected.analysisHash)
  expect(geometry).toHaveAttribute('data-graph-diagnostic-codes', 'GRAPH_DISCONTINUITIES_SEGMENTED')
  expect(geometry).toHaveAttribute('data-graph-segment-count', '2')
  expect(geometry?.querySelectorAll('polyline')).toHaveLength(2)
  const serializedPoints = Array.from(geometry!.querySelectorAll('polyline'))
    .flatMap((polyline) => (polyline.getAttribute('points') ?? '').split(' '))
  expect(serializedPoints.length).toBeGreaterThan(0)
  expect(serializedPoints.every((point) => /^-?\d+\.\d{6},-?\d+\.\d{6}$/.test(point))).toBe(true)
  expect(analyzer).toHaveBeenCalledTimes(1)

  view.rerender(<CanvasStage {...props} playhead={1}/>)
  view.rerender(<CanvasStage {...props} playhead={2}/>)
  expect(analyzer).toHaveBeenCalledTimes(1)
})

test('subnormal graph geometry uses the full authored height without escaping it', () => {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  const graph: SceneObject = {
    id: 'object-graph-subnormal', type: 'graph', name: 'Subnormal graph', locked: false, visible: true,
    transform: { x: 480, y: 270, width: 240, height: 150, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {}, properties: {
      expression: { kind: 'multiply', left: { kind: 'constant', value: Number.MIN_VALUE }, right: { kind: 'variable' } },
      xMin: 1,
      xMax: 2,
    },
  }
  shot.objects = [graph]
  shot.animations = []
  shot.propertyTracks = []
  project.shots = [shot]
  const parsed = ProjectDocumentSchema.parse(project)
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={0}
    previewStyle={parsed.styles.find(({ id }) => id === parsed.activeStyleId)!}
    projectRevision="graph-subnormal-a"
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />)
  const points = view.container.querySelector('polyline')?.getAttribute('points') ?? ''
  expect(points).toContain(',75.000000')
  expect(points).toContain(',-75.000000')
  for (const point of points.split(' ')) {
    const y = Number(point.split(',')[1])
    expect(Math.abs(y)).toBeLessThanOrEqual(75)
  }
})

test('legacy-invalid graph preview is diagnostic and never draws fabricated geometry', () => {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  const graph: SceneObject = {
    id: 'object-graph-invalid-preview', type: 'graph', name: 'Invalid graph', locked: false, visible: true,
    transform: { x: 480, y: 270, width: 260, height: 140, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {}, properties: {
      expression: { kind: 'divide', left: { kind: 'constant', value: 1 }, right: { kind: 'constant', value: 0 } },
      xMin: -2,
      xMax: 2,
    },
  }
  shot.objects = [graph]
  shot.animations = []
  shot.propertyTracks = []
  project.shots = [shot]
  const parsed = ProjectDocumentSchema.parse(project)
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={0}
    previewStyle={parsed.styles.find(({ id }) => id === parsed.activeStyleId)!}
    projectRevision="graph-invalid-a"
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />)
  expect(view.container.querySelector('[data-graph-status="invalid"]')).toHaveAttribute('data-graph-segment-count', '0')
  expect(view.container.querySelector('[aria-label^="Graph error:"]')).toBeInTheDocument()
  expect(view.container.querySelector('polyline')).not.toBeInTheDocument()
})

test('uncertified oscillation preview is diagnostic and draws no aliased line', () => {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  const graph: SceneObject = {
    id: 'object-graph-aliased-preview', type: 'graph', name: 'Uncertified oscillation', locked: false, visible: true,
    transform: { x: 480, y: 270, width: 320, height: 180, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {}, properties: {
      expression: {
        kind: 'sin',
        value: { kind: 'multiply', left: { kind: 'constant', value: 804.247719319 }, right: { kind: 'variable' } },
      },
      xMin: -1,
      xMax: 1,
    },
  }
  shot.objects = [graph]
  shot.animations = []
  shot.propertyTracks = []
  project.shots = [shot]
  const parsed = ProjectDocumentSchema.parse(project)
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={0}
    previewStyle={parsed.styles.find(({ id }) => id === parsed.activeStyleId)!}
    projectRevision="graph-alias-a"
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />)
  expect(view.container.querySelector('[data-graph-status="invalid"]')).toHaveAttribute('data-graph-segment-count', '0')
  expect(view.getByRole('img', { name: /could not be certified within its deterministic sampling budget/i })).toBeInTheDocument()
  expect(view.container.querySelector('polyline')).not.toBeInTheDocument()
})

test('equal-quotient preview draws one safe segment or two branches around zero', () => {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  const graph: SceneObject = {
    id: 'object-graph-equal-quotient', type: 'graph', name: 'Equal quotient', locked: false, visible: true,
    transform: { x: 480, y: 270, width: 320, height: 180, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {}, properties: {
      expression: { kind: 'divide', left: { kind: 'variable' }, right: { kind: 'variable' } },
      xMin: 1,
      xMax: 2,
    },
  }
  shot.objects = [graph]
  shot.animations = []
  shot.propertyTracks = []
  project.shots = [shot]
  const safe = ProjectDocumentSchema.parse(project)
  const shared = {
    playhead: 0,
    previewStyle: safe.styles.find(({ id }) => id === safe.activeStyleId)!,
    previewQuality: safe.settings.previewQuality,
    selectedIds: [] as string[],
    onSelect: jest.fn(),
    onCommitTransforms: jest.fn(),
    onCommitKeyboardTransform: jest.fn(),
    onNotice: jest.fn(),
  }
  const view = render(<CanvasStage {...shared} project={safe} shot={safe.shots[0]} projectRevision="graph-quotient-safe"/>)
  expect(view.container.querySelector('[data-graph-status="valid"]')).toHaveAttribute('data-graph-segment-count', '1')
  expect(view.container.querySelectorAll('polyline')).toHaveLength(1)

  const crossingProject = cloneSerializable(safe)
  crossingProject.shots[0].objects[0].properties.xMin = -1
  crossingProject.shots[0].objects[0].properties.xMax = 1
  const crossing = ProjectDocumentSchema.parse(crossingProject)
  view.rerender(<CanvasStage {...shared} project={crossing} shot={crossing.shots[0]} projectRevision="graph-quotient-crossing"/>)
  expect(view.container.querySelector('[data-graph-status="valid"]')).toHaveAttribute('data-graph-segment-count', '2')
  expect(view.container.querySelector('[data-graph-diagnostic-codes]')).toHaveAttribute('data-graph-diagnostic-codes', 'GRAPH_DISCONTINUITIES_SEGMENTED')
  expect(view.container.querySelectorAll('polyline')).toHaveLength(2)
})

test('previews MathTex/Tex mode truth and uses a diagnostic placeholder for invalid defense input', () => {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  const math = shot.objects.find(({ type }) => type === 'math')!
  math.locked = false
  delete math.parentId
  math.properties = { content: '\\frac{1}{2}', renderer: 'mathtex', mode: 'display' }
  shot.objects = [math]
  shot.animations = []
  shot.propertyTracks = []
  project.shots = [shot]
  const parsed = ProjectDocumentSchema.parse(project)
  const props = {
    project: parsed,
    shot: parsed.shots[0],
    playhead: 0,
    previewStyle: parsed.styles.find(({ id }) => id === parsed.activeStyleId)!,
    projectRevision: 'math-preview-a',
    previewQuality: parsed.settings.previewQuality,
    selectedIds: [],
    onSelect: jest.fn(),
    onCommitTransforms: jest.fn(),
    onCommitKeyboardTransform: jest.fn(),
    onNotice: jest.fn(),
  }
  const view = render(<CanvasStage {...props}/>)
  expect(view.container.querySelector('[data-math-renderer="mathtex"][data-math-mode="display"] .katex-display')).toBeInTheDocument()

  const tex = cloneSerializable(parsed)
  tex.shots[0].objects[0].properties = { content: 'Euler wrote $e^{i\\pi}+1=0$.', renderer: 'tex', mode: 'inline' }
  const parsedTex = ProjectDocumentSchema.parse(tex)
  view.rerender(<CanvasStage {...props} project={parsedTex} shot={parsedTex.shots[0]} projectRevision="math-preview-b"/>)
  expect(view.container.querySelector('[data-math-renderer="tex"][data-math-mode="inline"]')).toHaveTextContent(/Euler wrote/)
  expect(view.container.querySelector('[data-math-renderer="tex"] .katex')).toBeInTheDocument()

  const whitespace = cloneSerializable(parsed)
  whitespace.shots[0].objects[0].properties = {
    content: 'Alpha   beta\tgamma \n \\\\   Delta', renderer: 'tex', mode: 'inline',
  }
  const parsedWhitespace = ProjectDocumentSchema.parse(whitespace)
  view.rerender(<CanvasStage {...props} project={parsedWhitespace} shot={parsedWhitespace.shots[0]} projectRevision="math-preview-whitespace"/>)
  expect(view.container.querySelector('.pc-tex-content')).toHaveTextContent('Alpha beta gamma\nDelta', { normalizeWhitespace: false })

  const boundaries = cloneSerializable(parsed)
  boundaries.shots[0].objects[0].properties = { content: 'Before   $x$ \t After', renderer: 'tex', mode: 'inline' }
  const parsedBoundaries = ProjectDocumentSchema.parse(boundaries)
  view.rerender(<CanvasStage {...props} project={parsedBoundaries} shot={parsedBoundaries.shots[0]} projectRevision="math-preview-boundaries"/>)
  const boundaryChildren = Array.from(view.container.querySelector('.pc-tex-content')!.children)
  expect(boundaryChildren[0]).toHaveTextContent('Before ', { normalizeWhitespace: false })
  expect(boundaryChildren.at(-1)).toHaveTextContent(' After', { normalizeWhitespace: false })

  const starredLinebreak = cloneSerializable(parsedTex)
  starredLinebreak.shots[0].objects[0].properties.content = 'First\\\\*Second'
  view.rerender(<CanvasStage {...props} project={starredLinebreak} shot={starredLinebreak.shots[0]} projectRevision="math-preview-starred-linebreak"/>)
  expect(view.getByRole('img', { name: /linebreak modifiers are outside the supported dialect/i })).toBeInTheDocument()
  expect(view.container.querySelector('.pc-tex-content')).not.toBeInTheDocument()

  const invalid = cloneSerializable(parsedTex)
  invalid.shots[0].objects[0].properties.content = '\\frac{1'
  invalid.shots[0].objects[0].properties.renderer = 'mathtex'
  view.rerender(<CanvasStage {...props} project={invalid} shot={invalid.shots[0]} projectRevision="math-preview-invalid"/>)
  expect(view.container.querySelector('.pc-math-diagnostic')).toHaveTextContent('Unclosed "{" at character 6.')
  expect(view.container.querySelector('.katex-error')).not.toBeInTheDocument()
})

test('memoizes LaTeX analysis and KaTeX rendering across playback-only rerenders', () => {
  const analyze = jest.mocked(latexAuthority.analyzeMathProperties)
  analyze.mockClear()
  const renderLatex = jest.spyOn(katex, 'renderToString')
  try {
    const project = cloneSerializable(createCantorDemoProject())
    const shot = project.shots[0]
    const math = shot.objects.find(({ type }) => type === 'math')!
    delete math.parentId
    math.properties = { content: '\\frac{1}{2}', renderer: 'mathtex', mode: 'display' }
    shot.objects = [math]
    shot.animations = []
    shot.propertyTracks = []
    project.shots = [shot]
    const parsed = ProjectDocumentSchema.parse(project)
    const props = {
      project: parsed,
      shot: parsed.shots[0],
      previewStyle: parsed.styles.find(({ id }) => id === parsed.activeStyleId)!,
      projectRevision: 'math-preview-memoized',
      previewQuality: parsed.settings.previewQuality,
      selectedIds: [],
      onSelect: jest.fn(),
      onCommitTransforms: jest.fn(),
      onCommitKeyboardTransform: jest.fn(),
      onNotice: jest.fn(),
    }
    const view = render(<CanvasStage {...props} playhead={0}/>)
    const initialAnalyzeCalls = analyze.mock.calls.length
    const initialRenderCalls = renderLatex.mock.calls.length
    expect(initialAnalyzeCalls).toBeGreaterThan(0)
    expect(initialRenderCalls).toBeGreaterThan(0)

    for (let tick = 1; tick <= 40; tick += 1) {
      view.rerender(<CanvasStage {...props} playhead={tick / 100}/>)
    }
    expect(analyze).toHaveBeenCalledTimes(initialAnalyzeCalls)
    expect(renderLatex).toHaveBeenCalledTimes(initialRenderCalls)
  } finally {
    analyze.mockClear()
    renderLatex.mockRestore()
  }
})

test.each([
  ['16:9', '0 0 960 540', 'translate(480 270)', '960 / 540'],
  ['9:16', '0 0 540 960', 'translate(270 480)', '540 / 960'],
  ['1:1', '0 0 720 720', 'translate(360 360)', '720 / 720'],
] as const)('uses the shared %s frame for the SVG viewport, container ratio, and camera pivot', (aspectRatio, viewBox, pivot, aspectRatioStyle) => {
  const project = cloneSerializable(createCantorDemoProject())
  const frame = logicalFrameFor(aspectRatio)
  project.settings.aspectRatio = aspectRatio
  project.settings.resolution = resolutionFor(aspectRatio, project.settings.renderPreset)
  project.shots = [project.shots[1]]
  project.shots[0].camera = { x: frame.centerX, y: frame.centerY, zoom: 1, rotation: 0 }
  project.shots[0].animations = []
  project.shots[0].propertyTracks = []
  const parsed = ProjectDocumentSchema.parse(project)
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={0}
    previewStyle={parsed.styles.find(({ id }) => id === parsed.activeStyleId)!}
    projectRevision="revision-a"
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />)
  expect(view.container.querySelector('svg.pc-stage')).toHaveAttribute('viewBox', viewBox)
  expect(view.container.querySelector('svg.pc-stage')).toHaveStyle(`--pc-stage-aspect: ${aspectRatioStyle}`)
  expect(view.container.querySelector('[data-pc-camera-transform]')).toHaveAttribute('transform', expect.stringContaining(pivot))
})

test('snaps portrait movement to the portrait frame centre and spans portrait guides', () => {
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: MouseEvent })
  const project = cloneSerializable(createCantorDemoProject())
  const aspectRatio: ProofCanvasAspectRatio = '9:16'
  const frame = logicalFrameFor(aspectRatio)
  project.settings.aspectRatio = aspectRatio
  project.settings.resolution = resolutionFor(aspectRatio, project.settings.renderPreset)
  const shot = project.shots[1]
  project.shots = [shot]
  shot.camera = { x: frame.centerX, y: frame.centerY, zoom: 1, rotation: 0 }
  shot.animations = []
  shot.propertyTracks = []
  shot.objects = [shot.objects[0]]
  shot.objects[0].transform = { ...shot.objects[0].transform, x: 100, y: 100 }
  const parsed = ProjectDocumentSchema.parse(project)
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={0}
    previewStyle={parsed.styles.find(({ id }) => id === parsed.activeStyleId)!}
    projectRevision="revision-a"
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />)
  const svg = view.container.querySelector('svg.pc-stage') as SVGSVGElement
  Object.defineProperty(svg, 'createSVGPoint', { configurable: true, value: () => {
    const point = { x: 0, y: 0, matrixTransform: () => ({ x: point.x, y: point.y }) }
    return point
  } })
  Object.defineProperty(svg, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({}) }) })
  const object = view.container.querySelector('[data-object-id]')!
  fireEvent.pointerDown(object, { button: 0, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(svg, { clientX: frame.centerX - 2, clientY: frame.centerY - 2 })
  expect(view.container.querySelector('[data-guide-axis="x"]')).toHaveAttribute('x1', String(frame.centerX))
  expect(view.container.querySelector('[data-guide-axis="x"]')).toHaveAttribute('y2', String(frame.height))
  expect(view.container.querySelector('[data-guide-axis="y"]')).toHaveAttribute('y1', String(frame.centerY))
  expect(view.container.querySelector('[data-guide-axis="y"]')).toHaveAttribute('x2', String(frame.width))
})

test('cancels an absolute transform draft when its canonical project revision changes', () => {
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: MouseEvent })
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[1]
  project.shots = [shot]
  shot.animations = []
  shot.propertyTracks = []
  shot.objects = [shot.objects[0]]
  const parsed = ProjectDocumentSchema.parse(project)
  const onCommitTransforms = jest.fn()
  const shared = {
    project: parsed,
    shot: parsed.shots[0],
    playhead: 0,
    previewStyle: parsed.styles.find(({ id }) => id === parsed.activeStyleId)!,
    previewQuality: parsed.settings.previewQuality,
    selectedIds: [parsed.shots[0].objects[0].id],
    onSelect: jest.fn(),
    onCommitTransforms,
    onCommitKeyboardTransform: jest.fn(),
    onNotice: jest.fn(),
  }
  const view = render(<CanvasStage {...shared} projectRevision="revision-a" />)
  const svg = view.container.querySelector('svg.pc-stage') as SVGSVGElement
  Object.defineProperty(svg, 'createSVGPoint', { configurable: true, value: () => {
    const point = { x: 0, y: 0, matrixTransform: () => ({ x: point.x, y: point.y }) }
    return point
  } })
  Object.defineProperty(svg, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({}) }) })
  const object = view.container.querySelector('[data-object-id]')!
  fireEvent.pointerDown(object, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(svg, { pointerId: 1, clientX: 130, clientY: 120 })
  view.rerender(<CanvasStage {...shared} projectRevision="revision-b" />)
  fireEvent.pointerUp(svg, { pointerId: 1, clientX: 130, clientY: 120 })
  expect(onCommitTransforms).not.toHaveBeenCalled()
})

test('commits the latest canvas draft when pointer down, move, and release share one React batch', () => {
  installTestPointerEvent()
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[1]
  project.shots = [shot]
  shot.animations = []
  shot.propertyTracks = []
  shot.objects = [shot.objects[0]]
  const parsed = ProjectDocumentSchema.parse(project)
  const object = parsed.shots[0].objects[0]
  const onCommitTransforms = jest.fn()
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={0}
    previewStyle={parsed.styles.find(({ id }) => id === parsed.activeStyleId)!}
    projectRevision="revision-a"
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[object.id]}
    onSelect={jest.fn()}
    onCommitTransforms={onCommitTransforms}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />)
  const svg = view.container.querySelector('svg.pc-stage') as SVGSVGElement
  Object.defineProperty(svg, 'createSVGPoint', { configurable: true, value: () => {
    const point = { x: 0, y: 0, matrixTransform: () => ({ x: point.x, y: point.y }) }
    return point
  } })
  Object.defineProperty(svg, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({}) }) })
  const target = view.container.querySelector(`[data-object-id="${object.id}"]`)!

  act(() => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7, isPrimary: true, clientX: 100, clientY: 100 }))
    svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 7, isPrimary: true, clientX: 130, clientY: 120 }))
    svg.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 7, isPrimary: true, clientX: 130, clientY: 120 }))
  })

  expect(onCommitTransforms).toHaveBeenCalledTimes(1)
  expect(onCommitTransforms).toHaveBeenCalledWith([
    expect.objectContaining({
      objectId: object.id,
      transform: expect.objectContaining({ x: object.transform.x + 30, y: object.transform.y + 20 }),
    }),
  ], 'Move objects')
})

test('admits one primary canvas pointer and ignores every foreign event while it owns the draft', () => {
  installTestPointerEvent()
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[1]
  project.shots = [shot]
  shot.animations = []
  shot.propertyTracks = []
  shot.objects = [shot.objects[0]]
  const parsed = ProjectDocumentSchema.parse(project)
  const object = parsed.shots[0].objects[0]
  const onSelect = jest.fn()
  const onCommitTransforms = jest.fn()
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={0}
    previewStyle={parsed.styles.find(({ id }) => id === parsed.activeStyleId)!}
    projectRevision="revision-a"
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[object.id]}
    onSelect={onSelect}
    onCommitTransforms={onCommitTransforms}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />)
  const svg = view.container.querySelector('svg.pc-stage') as SVGSVGElement
  Object.defineProperty(svg, 'createSVGPoint', { configurable: true, value: () => {
    const point = { x: 0, y: 0, matrixTransform: () => ({ x: point.x, y: point.y }) }
    return point
  } })
  Object.defineProperty(svg, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({}) }) })
  const target = view.container.querySelector(`[data-object-id="${object.id}"]`)!

  fireEvent.pointerDown(target, { button: 2, pointerId: 2, isPrimary: true, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(svg, { pointerId: 2, isPrimary: true, clientX: 300, clientY: 300 })
  fireEvent.pointerUp(svg, { pointerId: 2, isPrimary: true, clientX: 300, clientY: 300 })
  fireEvent.pointerDown(target, { button: 0, pointerId: 3, isPrimary: false, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(svg, { pointerId: 3, isPrimary: false, clientX: 300, clientY: 300 })
  fireEvent.pointerUp(svg, { pointerId: 3, isPrimary: false, clientX: 300, clientY: 300 })
  expect(onSelect).not.toHaveBeenCalled()
  expect(onCommitTransforms).not.toHaveBeenCalled()

  fireEvent.pointerDown(target, { button: 0, pointerId: 10, isPrimary: true, clientX: 100, clientY: 100 })
  fireEvent.pointerDown(target, { button: 0, pointerId: 11, isPrimary: false, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(svg, { pointerId: 11, isPrimary: false, clientX: 500, clientY: 500 })
  fireEvent.pointerUp(svg, { pointerId: 11, isPrimary: false, clientX: 500, clientY: 500 })
  fireEvent.pointerCancel(svg, { pointerId: 11, isPrimary: false, clientX: 500, clientY: 500 })
  fireEvent.pointerMove(svg, { pointerId: 10, isPrimary: true, clientX: 130, clientY: 120 })
  fireEvent.pointerUp(svg, { pointerId: 10, isPrimary: true, clientX: 130, clientY: 120 })
  expect(onSelect).toHaveBeenCalledTimes(1)
  expect(onCommitTransforms).toHaveBeenCalledTimes(1)
  expect(onCommitTransforms).toHaveBeenLastCalledWith([
    expect.objectContaining({
      objectId: object.id,
      transform: expect.objectContaining({ x: object.transform.x + 30, y: object.transform.y + 20 }),
    }),
  ], 'Move objects')

  fireEvent.pointerDown(target, { button: 0, pointerId: 20, isPrimary: true, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(svg, { pointerId: 20, isPrimary: true, clientX: 160, clientY: 160 })
  fireEvent.pointerCancel(svg, { pointerId: 20, isPrimary: true, clientX: 160, clientY: 160 })
  fireEvent.pointerUp(svg, { pointerId: 20, isPrimary: true, clientX: 160, clientY: 160 })
  expect(onCommitTransforms).toHaveBeenCalledTimes(1)
})

test('cancels canvas authoring and any live gesture while sequence playback is active', () => {
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: MouseEvent })
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[1]
  project.shots = [shot]
  shot.animations = []
  shot.propertyTracks = []
  shot.objects = [shot.objects[0]]
  const parsed = ProjectDocumentSchema.parse(project)
  const onSelect = jest.fn()
  const onCommitTransforms = jest.fn()
  const shared = {
    project: parsed,
    shot: parsed.shots[0],
    playhead: 0,
    previewStyle: parsed.styles.find(({ id }) => id === parsed.activeStyleId)!,
    projectRevision: 'revision-a',
    previewQuality: parsed.settings.previewQuality,
    selectedIds: [parsed.shots[0].objects[0].id],
    onSelect,
    onCommitTransforms,
    onCommitKeyboardTransform: jest.fn(),
    onNotice: jest.fn(),
  }
  const view = render(<CanvasStage {...shared} authoringEnabled/>)
  const svg = view.container.querySelector('svg.pc-stage') as SVGSVGElement
  Object.defineProperty(svg, 'createSVGPoint', { configurable: true, value: () => {
    const point = { x: 0, y: 0, matrixTransform: () => ({ x: point.x, y: point.y }) }
    return point
  } })
  Object.defineProperty(svg, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({}) }) })
  const object = view.container.querySelector('[data-object-id]')!
  fireEvent.pointerDown(object, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(svg, { pointerId: 1, clientX: 130, clientY: 120 })

  view.rerender(<CanvasStage {...shared} authoringEnabled={false}/>)
  fireEvent.pointerUp(svg, { pointerId: 1, clientX: 130, clientY: 120 })
  fireEvent.pointerDown(svg, { button: 0, pointerId: 2, clientX: 0, clientY: 0 })

  expect(svg).not.toHaveAttribute('aria-readonly')
  expect(svg).toHaveAttribute('aria-disabled', 'true')
  expect(svg).toHaveAttribute('data-authoring-enabled', 'false')
  expect(svg).toHaveAccessibleName(/playback preview, editing disabled/)
  expect(view.container.querySelector('[data-object-id]')).not.toBeInTheDocument()
  expect(view.container.querySelector('.pc-selection-handles')).not.toBeInTheDocument()
  expect(onSelect).toHaveBeenCalledTimes(1)
  expect(onCommitTransforms).not.toHaveBeenCalled()
})

test('protects a property-tracked object family from direct base-pose editing once its first key is active', () => {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[1]
  project.shots = [shot]
  shot.animations = []
  shot.objects = [shot.objects[0]]
  const object = shot.objects[0]
  object.locked = false
  shot.propertyTracks = [{
    id: 'track-object-x',
    target: { kind: 'object', objectId: object.id },
    property: 'x',
    keyframes: [
      { id: 'keyframe-object-x-a', time: 1, value: object.transform.x, interpolation: { kind: 'linear' } },
      { id: 'keyframe-object-x-b', time: 2, value: object.transform.x + 100, interpolation: { kind: 'linear' } },
    ],
  }]
  const parsed = ProjectDocumentSchema.parse(project)
  const style = parsed.styles.find(({ id }) => id === parsed.activeStyleId)!
  expect(temporallyTransformsObject(parsed.shots[0], object.id, 0.5)).toBe(false)
  expect(temporallyTransformsObject(parsed.shots[0], object.id, 1)).toBe(true)
  expect(resolveCanvasKeyboardTransformIntent(parsed, shot.id, style, 1.5, {
    objectId: object.id,
    kind: 'resize',
    key: 'ArrowRight',
    shiftKey: false,
  })).toEqual({ notice: expect.stringMatching(/animated geometry/) })

  const onNotice = jest.fn()
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={1.5}
    previewStyle={style}
    projectRevision="revision-a"
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[object.id]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={onNotice}
  />)
  expect(view.container.querySelector(`[data-object-id="${object.id}"]`)).toHaveAttribute('data-temporal-pose', 'animated')
  expect(view.container.querySelector('.pc-selection-handles')).not.toBeInTheDocument()
  fireEvent.pointerDown(view.container.querySelector(`[data-object-id="${object.id}"]`)!, { button: 0, pointerId: 1 })
  expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/animated geometry/))
})

test('owns only the fixed shape-preset drag contract and reports every unavailable drop state', () => {
  const project = cloneSerializable(createCantorDemoProject())
  project.shots = [project.shots[0]]
  project.shots[0].camera = { x: 600, y: 200, zoom: 2, rotation: 90 }
  const parsed = ProjectDocumentSchema.parse(project)
  const onInsertShapePresetAt = jest.fn()
  const onNotice = jest.fn()
  const shared = {
    project: parsed,
    shot: parsed.shots[0],
    playhead: 0,
    previewStyle: parsed.styles.find(({ id }) => id === parsed.activeStyleId)!,
    projectRevision: 'shape-drop-contract',
    previewQuality: parsed.settings.previewQuality,
    selectedIds: [] as string[],
    onSelect: jest.fn(),
    onCommitTransforms: jest.fn(),
    onCommitKeyboardTransform: jest.fn(),
    onNotice,
  }
  const view = render(<CanvasStage {...shared} onInsertShapePresetAt={onInsertShapePresetAt}/>)
  const svg = view.container.querySelector('svg.pc-stage') as SVGSVGElement
  Object.defineProperty(svg, 'createSVGPoint', { configurable: true, value: () => {
    const point = { x: 0, y: 0, matrixTransform: () => ({ x: point.x, y: point.y }) }
    return point
  } })
  Object.defineProperty(svg, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({}) }) })

  const transfer = (types: string[], value: string) => ({
    types,
    effectAllowed: 'copy',
    dropEffect: 'link',
    getData: jest.fn((type: string) => type === PROOFCANVAS_SHAPE_PRESET_MIME ? value : ''),
  })

  const unrelatedTransfer = transfer(['text/plain'], 'arrow')
  const unrelatedDrop = stageDragEvent('drop', unrelatedTransfer)
  fireEvent(svg, unrelatedDrop)
  expect(unrelatedDrop.defaultPrevented).toBe(false)
  expect(unrelatedTransfer.getData).not.toHaveBeenCalled()
  expect(onInsertShapePresetAt).not.toHaveBeenCalled()
  expect(onNotice).not.toHaveBeenCalled()

  const invalidTransfer = transfer([PROOFCANVAS_SHAPE_PRESET_MIME], 'not-a-preset')
  const invalidDrop = stageDragEvent('drop', invalidTransfer)
  fireEvent(svg, invalidDrop)
  expect(invalidDrop.defaultPrevented).toBe(true)
  expect(onNotice).toHaveBeenLastCalledWith('That shape preset is not available.')
  expect(onInsertShapePresetAt).not.toHaveBeenCalled()

  const enabledTransfer = transfer([PROOFCANVAS_SHAPE_PRESET_MIME], 'arrow')
  const enabledDragOver = stageDragEvent('dragover', enabledTransfer)
  fireEvent(svg, enabledDragOver)
  expect(enabledDragOver.defaultPrevented).toBe(true)
  expect(enabledTransfer.dropEffect).toBe('copy')

  view.rerender(<CanvasStage {...shared} authoringEnabled={false} onInsertShapePresetAt={onInsertShapePresetAt}/>)
  expect(svg).toHaveAttribute('data-shape-drop-enabled', 'false')
  const disabledTransfer = transfer([PROOFCANVAS_SHAPE_PRESET_MIME], 'arrow')
  fireEvent(svg, stageDragEvent('dragover', disabledTransfer))
  expect(disabledTransfer.dropEffect).toBe('none')
  fireEvent(svg, stageDragEvent('drop', disabledTransfer))
  expect(onNotice).toHaveBeenLastCalledWith('Pause playback before dropping a shape.')
  expect(onInsertShapePresetAt).not.toHaveBeenCalled()

  view.rerender(<CanvasStage {...shared} authoringEnabled/>)
  expect(svg).toHaveAttribute('data-shape-drop-enabled', 'false')
  fireEvent(svg, stageDragEvent('drop', transfer([PROOFCANVAS_SHAPE_PRESET_MIME], 'arrow')))
  expect(onNotice).toHaveBeenLastCalledWith('Shape insertion is not available on this canvas.')

  view.rerender(<CanvasStage {...shared} authoringEnabled onInsertShapePresetAt={onInsertShapePresetAt}/>)
  expect(svg).toHaveAttribute('data-shape-drop-enabled', 'true')
  const validDrop = stageDragEvent(
    'drop',
    transfer([PROOFCANVAS_SHAPE_PRESET_MIME], 'arrow'),
    { x: 480, y: 270 },
  )
  fireEvent(svg, validDrop)
  expect(validDrop.defaultPrevented).toBe(true)
  expect(onInsertShapePresetAt).toHaveBeenCalledTimes(1)
  expect(onInsertShapePresetAt).toHaveBeenCalledWith('arrow', { x: 600, y: 200 })
})

test.each([
  ['triangle', 'butt'],
  ['stealth', 'round'],
  ['circle', 'square'],
  ['square', 'butt'],
] as const)('renders a %s Arrow tip with shared shaft paint and a %s line cap', (tipShape, lineCap) => {
  const project = cloneSerializable(createCantorDemoProject())
  project.shots = [project.shots[0]]
  project.shots[0].objects = []
  project.shots[0].animations = []
  project.shots[0].propertyTracks = []
  const empty = ProjectDocumentSchema.parse(project)
  const inserted = insertShapePreset(empty, empty.shots[0].id, 'arrow')
  const arrow = inserted.shots[0].objects.find(({ type }) => type === 'arrow')!
  arrow.properties.shape = { kind: 'arrow', lineCap, tipShape, tipSizeRatio: 0.2 }
  arrow.style = { stroke: '#123456', strokeWidth: 7, opacity: 0.4 }
  const parsed = ProjectDocumentSchema.parse(inserted)
  const frame = logicalFrameFor(parsed.settings.aspectRatio)
  const expected = resolveArrowPreviewGeometry(
    arrow.transform.width!,
    tipShape,
    0.2,
    0.35 * frame.width / frame.manimWidth,
  )
  const view = render(<CanvasStage
    project={parsed}
    shot={parsed.shots[0]}
    playhead={0}
    previewStyle={parsed.styles.find(({ id }) => id === parsed.activeStyleId)!}
    projectRevision={`arrow-preview-${tipShape}-${lineCap}`}
    previewQuality={parsed.settings.previewQuality}
    selectedIds={[]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />)
  const renderedArrow = view.container.querySelector('[data-object-type="arrow"]')!
  const shaft = renderedArrow.querySelector('line:not([stroke="transparent"])')
  const tip = renderedArrow.querySelector(`[data-arrow-tip-shape="${tipShape}"]`)
  expect(renderedArrow).toHaveAttribute('opacity', '0.4')
  expect(renderedArrow).toHaveAttribute('data-arrow-tip-length', String(expected.tipLength))
  expect(renderedArrow).toHaveAttribute('data-arrow-shaft-end', String(expected.shaftEndX))
  expect(shaft).toHaveAttribute('stroke', '#123456')
  expect(shaft).toHaveAttribute('stroke-width', '7')
  expect(shaft).toHaveAttribute('stroke-linecap', lineCap)
  expect(tip).toHaveAttribute('fill', '#123456')
  expect(tip).toHaveAttribute('stroke', '#123456')
  expect(tip).toHaveAttribute('stroke-width', '7')
})

test('renders passive Arrow thumbnails with exact namespace-free tip geometry', () => {
  const project = cloneSerializable(createCantorDemoProject())
  project.shots = [project.shots[0]]
  project.shots[0].objects = []
  project.shots[0].animations = []
  project.shots[0].propertyTracks = []
  const empty = ProjectDocumentSchema.parse(project)
  const inserted = insertShapePreset(empty, empty.shots[0].id, 'arrow')
  const view = render(<CanvasThumbnail
    aspectRatio={inserted.settings.aspectRatio}
    shot={inserted.shots[0]}
    previewStyle={inserted.styles.find(({ id }) => id === inserted.activeStyleId)!}
    visualRevision="arrow-thumbnail"
  />)
  const thumbnail = view.container.querySelector('svg.pc-shot-thumbnail')!
  expect(thumbnail.querySelector('marker')).not.toBeInTheDocument()
  expect(thumbnail.innerHTML).not.toContain('url(#')
  expect(thumbnail.querySelector('[data-arrow-tip-shape="triangle"]')).toBeInTheDocument()
  expect(thumbnail.querySelector('[data-object-id]')).not.toBeInTheDocument()
})
