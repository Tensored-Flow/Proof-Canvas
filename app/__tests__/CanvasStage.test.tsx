import { fireEvent, render } from '@testing-library/react'
import CanvasStage from '../CanvasStage'
import { compileManim } from '@/lib/proofcanvas/compiler'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { logicalFrameFor, resolutionFor, type ProofCanvasAspectRatio } from '@/lib/proofcanvas/frame'
import { ProjectDocumentSchema, cloneSerializable, type SceneObject } from '@/lib/proofcanvas/schema'

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
