import { render } from '@testing-library/react'
import CanvasStage from '../CanvasStage'
import { compileManim } from '@/lib/proofcanvas/compiler'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
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
    selectedIds: [],
    onSelect: jest.fn(),
    onCommitTransforms: jest.fn(),
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
    selectedIds={[]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onNotice={jest.fn()}
  />)
  expect(view.container.querySelector('polyline')).toHaveAttribute('stroke-width', '11')
})
