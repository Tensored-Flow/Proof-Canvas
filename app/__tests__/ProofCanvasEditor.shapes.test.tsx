import { fireEvent, render, screen } from '@testing-library/react'
import ProofCanvasEditor from '../ProofCanvasEditor'
import { PROOFCANVAS_SHAPE_PRESET_MIME } from '@/lib/proofcanvas/shapePresets'
import { ProjectDocumentSchema, cloneSerializable, type ProjectDocument, type PropertyTrack, type SceneObject } from '@/lib/proofcanvas/schema'
import { createProjectTemplate } from '@/lib/proofcanvas/templates'

function blankProject(): ProjectDocument {
  return createProjectTemplate('blank', 'project-shape-editor', 'Shape editor')
}

function shapeObject(
  id: string,
  type: 'circle' | 'rectangle' | 'line' | 'arrow' | 'brace',
  properties: SceneObject['properties'],
  transform: Partial<SceneObject['transform']> = {},
): SceneObject {
  return {
    id,
    type,
    name: id.replace('object-', '').replaceAll('-', ' '),
    locked: false,
    visible: true,
    transform: { x: 100, y: 100, width: 100, height: type === 'brace' ? 34 : 50, rotation: 0, scaleX: 1, scaleY: 1, ...transform },
    style: type === 'arrow' ? { stroke: '#315866', strokeWidth: 3 } : {},
    properties,
  }
}

function projectWith(objects: SceneObject[], propertyTracks: PropertyTrack[] = []): ProjectDocument {
  const project = cloneSerializable(blankProject())
  project.shots[0].objects = objects
  project.shots[0].propertyTracks = propertyTracks
  return ProjectDocumentSchema.parse(project)
}

function selectLayer(name: string) {
  fireEvent.click(screen.getByRole('treeitem', { name: new RegExp(`^${name};`) }))
}

function editor() {
  return screen.getByRole('application', { name: 'ProofCanvas editor' })
}

describe('shape preset and inspector authoring', () => {
  test('searches all immutable presets and inserts each click as one root-selected history step', () => {
    const { container } = render(<ProofCanvasEditor initialProject={blankProject()}/>)
    fireEvent.click(screen.getByRole('tab', { name: 'Shapes' }))
    expect(container.querySelectorAll('[data-shape-preset-id]')).toHaveLength(11)

    const search = screen.getByRole('searchbox', { name: 'Search library' })
    fireEvent.change(search, { target: { value: 'strike' } })
    expect(container.querySelectorAll('[data-shape-preset-id]')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Insert Cross-out' })).toBeInTheDocument()
    fireEvent.change(search, { target: { value: '' } })

    const values = new Map<string, string>()
    const dragTransfer = {
      types: [] as string[],
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: jest.fn((type: string, value: string) => values.set(type, value)),
      getData: jest.fn((type: string) => values.get(type) ?? ''),
    }
    const arrowCard = screen.getByRole('button', { name: 'Insert Arrow' })
    fireEvent.dragStart(arrowCard, { dataTransfer: dragTransfer })
    expect(dragTransfer.setData).toHaveBeenCalledWith(PROOFCANVAS_SHAPE_PRESET_MIME, 'arrow')
    expect(dragTransfer.effectAllowed).toBe('copy')
    expect(arrowCard).toHaveAttribute('data-dragging', 'true')
    fireEvent.dragEnd(arrowCard, { dataTransfer: dragTransfer })
    expect(arrowCard).toHaveAttribute('data-dragging', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Insert Rounded rectangle' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('treeitem', { name: /^Rounded rectangle;/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('spinbutton', { name: 'Corner radius' })).toHaveValue(14)
    expect(container.querySelector('[data-object-type="rectangle"]')).toHaveAttribute('rx', '14')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(screen.queryByRole('treeitem', { name: /^Rounded rectangle;/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Insert Cross-out' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('treeitem', { name: /^Cross-out;/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('treeitem').filter((item) => item.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(screen.getByRole('treeitem', { name: /^Cross-out descending stroke;/ })).toHaveAttribute('aria-level', '2')
    expect(screen.getByRole('treeitem', { name: /^Cross-out ascending stroke;/ })).toHaveAttribute('aria-level', '2')
  })

  test('drops a preset at the exact camera-space point through the fixed MIME contract', () => {
    const project = cloneSerializable(blankProject())
    project.shots[0].camera = { x: 600, y: 200, zoom: 2, rotation: 90 }
    const parsed = ProjectDocumentSchema.parse(project)
    const { container } = render(<ProofCanvasEditor initialProject={parsed}/>)
    const canvas = container.querySelector('svg.pc-stage') as SVGSVGElement
    Object.defineProperty(canvas, 'createSVGPoint', { configurable: true, value: () => {
      const point = { x: 0, y: 0, matrixTransform: () => ({ x: point.x, y: point.y }) }
      return point
    } })
    Object.defineProperty(canvas, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({}) }) })
    const dataTransfer = {
      types: [PROOFCANVAS_SHAPE_PRESET_MIME],
      effectAllowed: 'copy',
      dropEffect: 'copy',
      setData: jest.fn(),
      getData: jest.fn((type: string) => type === PROOFCANVAS_SHAPE_PRESET_MIME ? 'arrow' : ''),
    }

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperties(drop, {
      clientX: { configurable: true, value: 480 },
      clientY: { configurable: true, value: 270 },
      dataTransfer: { configurable: true, value: dataTransfer },
    })
    fireEvent(canvas, drop)
    expect(screen.getByLabelText('Editor status')).toHaveTextContent('Insert Arrow')
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('treeitem', { name: /^Arrow;/ })).toHaveAttribute('aria-selected', 'true')
    expect(container.querySelector('[data-object-type="arrow"]')).toHaveAttribute('transform', expect.stringContaining('translate(600 200)'))
  })

  test('edits complete bounded shape records and preserves sibling controls across commits', () => {
    const rectangle = shapeObject('object-rectangle', 'rectangle', { shape: { kind: 'rectangle', cornerRadius: 10 } }, { width: 160, height: 90 })
    const arrow = shapeObject('object-arrow', 'arrow', { shape: { kind: 'arrow', lineCap: 'round', tipShape: 'stealth', tipSizeRatio: 0.25 } }, { width: 180, height: 18 })
    const brace = shapeObject('object-brace', 'brace', { label: 'span', shape: { kind: 'brace', direction: 'below', spacing: 12 } }, { width: 220, height: 34 })
    const { container } = render(<ProofCanvasEditor initialProject={projectWith([rectangle, arrow, brace])}/>)

    selectLayer('arrow')
    fireEvent.change(screen.getByRole('combobox', { name: 'Line cap' }), { target: { value: 'square' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Arrow tip' }), { target: { value: 'circle' } })
    const tipSize = screen.getByRole('spinbutton', { name: 'Arrow tip size' })
    fireEvent.change(tipSize, { target: { value: '0.4' } })
    fireEvent.blur(tipSize)
    expect(screen.getByRole('combobox', { name: 'Line cap' })).toHaveValue('square')
    expect(screen.getByRole('combobox', { name: 'Arrow tip' })).toHaveValue('circle')
    expect(screen.getByRole('spinbutton', { name: 'Arrow tip size' })).toHaveValue(0.4)
    const arrowTip = container.querySelector('[data-object-id="object-arrow"] [data-arrow-tip-shape="circle"]')
    expect(arrowTip).toHaveAttribute('stroke', '#315866')
    expect(arrowTip).toHaveAttribute('stroke-width', '3')

    selectLayer('rectangle')
    const cornerRadius = screen.getByRole('spinbutton', { name: 'Corner radius' })
    fireEvent.change(cornerRadius, { target: { value: '18' } })
    fireEvent.blur(cornerRadius)
    expect(container.querySelector('[data-object-id="object-rectangle"]')).toHaveAttribute('rx', '18')

    selectLayer('brace')
    fireEvent.change(screen.getByRole('combobox', { name: 'Brace direction' }), { target: { value: 'left' } })
    expect(screen.getByRole('combobox', { name: 'Brace direction' })).toHaveValue('left')
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(34)
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toHaveValue(220)
    expect(screen.getByRole('spinbutton', { name: 'Brace spacing' })).toHaveValue(12)
    expect(editor()).toHaveAttribute('data-history-past-count', '5')
  })

  test('round-trips authored endpoints atomically and disables them under dependent track authority', () => {
    const line = shapeObject('object-line', 'line', { custom: 'preserved' }, { x: 100, y: 100, width: 100, height: 2 })
    const view = render(<ProofCanvasEditor initialProject={projectWith([line])}/>)
    selectLayer('line')
    expect(screen.getByRole('combobox', { name: 'Line cap' })).toHaveValue('butt')
    expect(screen.getByRole('spinbutton', { name: 'Start X' })).toHaveValue(50)
    expect(screen.getByRole('spinbutton', { name: 'Start Y' })).toHaveValue(100)
    expect(screen.getByRole('spinbutton', { name: 'End X' })).toHaveValue(150)
    expect(screen.getByRole('spinbutton', { name: 'End Y' })).toHaveValue(100)

    fireEvent.change(screen.getByRole('combobox', { name: 'Line cap' }), { target: { value: 'round' } })
    const endY = screen.getByRole('spinbutton', { name: 'End Y' })
    fireEvent.change(endY, { target: { value: '150' } })
    fireEvent.blur(endY)
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
    expect(screen.getByRole('combobox', { name: 'Line cap' })).toHaveValue('round')
    expect(screen.getByRole('spinbutton', { name: 'Start X' })).toHaveValue(50)
    expect(screen.getByRole('spinbutton', { name: 'Start Y' })).toHaveValue(100)
    expect(screen.getByRole('spinbutton', { name: 'End X' })).toHaveValue(150)
    expect(screen.getByRole('spinbutton', { name: 'End Y' })).toHaveValue(150)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByRole('spinbutton', { name: 'End Y' })).toHaveValue(100)
    expect(screen.getByRole('combobox', { name: 'Line cap' })).toHaveValue('round')

    view.unmount()
    const widthTrack: PropertyTrack = {
      id: 'track-line-width',
      target: { kind: 'object', objectId: line.id },
      property: 'width',
      keyframes: [{ id: 'key-line-width', time: 0, value: 100, interpolation: { kind: 'linear' } }],
    }
    render(<ProofCanvasEditor initialProject={projectWith([line], [widthTrack])}/>)
    selectLayer('line')
    expect(screen.getByRole('spinbutton', { name: 'Start X' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'End Y' })).toBeDisabled()
    expect(screen.getByText(/Endpoint editing is unavailable/)).toBeInTheDocument()
  })

  test('shows the same inherited and compatibility-safe shape paint used by preview and compilation', () => {
    const group: SceneObject = {
      id: 'group-shape-paint',
      type: 'group',
      name: 'paint group',
      locked: false,
      visible: true,
      transform: { x: 100, y: 100, width: 220, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      style: { stroke: '#ff0000', strokeWidth: 6 },
      properties: {},
    }
    const line = shapeObject('object-inherited-line', 'line', { shape: { kind: 'line', lineCap: 'round' } })
    line.parentId = group.id
    const inherited = render(<ProofCanvasEditor initialProject={projectWith([group, line])}/>)
    selectLayer('inherited line')
    expect(screen.getByLabelText('Stroke')).toHaveValue('#ff0000')
    expect(screen.getByRole('spinbutton', { name: 'Stroke width' })).toHaveValue(6)
    expect(inherited.container.querySelector('[data-object-id="object-inherited-line"] line:not([stroke="transparent"])')).toHaveAttribute('stroke', '#ff0000')

    inherited.unmount()
    const circle = shapeObject('object-compatibility-circle', 'circle', { shape: { kind: 'circle' } })
    circle.style = { color: '#ff0000' }
    const circleProject = projectWith([circle])
    const background = circleProject.styles.find(({ id }) => id === circleProject.activeStyleId)!.colors.background
    const compatibility = render(<ProofCanvasEditor initialProject={circleProject}/>)
    selectLayer('compatibility circle')
    expect(screen.getByLabelText('Fill')).toHaveValue(background)
    expect(compatibility.container.querySelector('[data-object-id="object-compatibility-circle"]')).toHaveAttribute('fill', background)
  })

  test.each([
    ['height', 200],
    ['scaleY', 2],
  ] as const)('disables child endpoints while an ancestor %s track owns rendered geometry', (property, value) => {
    const group: SceneObject = {
      id: `group-endpoint-${property.toLowerCase()}`,
      type: 'group',
      name: 'endpoint group',
      locked: false,
      visible: true,
      transform: { x: 100, y: 100, width: 200, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    }
    const line = shapeObject(`object-endpoint-${property.toLowerCase()}`, 'line', { shape: { kind: 'line', lineCap: 'butt' } }, { y: 75 })
    line.parentId = group.id
    const authority: PropertyTrack = {
      id: `track-endpoint-${property.toLowerCase()}`,
      target: { kind: 'object', objectId: group.id },
      property,
      keyframes: [{ id: `keyframe-endpoint-${property.toLowerCase()}`, time: 0, value, interpolation: { kind: 'linear' } }],
    }
    render(<ProofCanvasEditor initialProject={projectWith([group, line], [authority])}/>)
    selectLayer(`endpoint ${property.toLowerCase()}`)
    expect(screen.getByRole('spinbutton', { name: 'Start X' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'End Y' })).toBeDisabled()
    expect(screen.getByText(/Endpoint editing is unavailable/)).toBeInTheDocument()
  })

  test('repairs a load-compatible malformed circle record and blocks invalid reintroduction', () => {
    const circle = shapeObject('object-malformed-circle', 'circle', { shape: { kind: 'arrow' } })
    render(<ProofCanvasEditor initialProject={projectWith([circle])}/>)
    selectLayer('malformed circle')
    expect(screen.getByRole('button', { name: 'Repair shape settings' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Repair shape settings' }))
    expect(screen.queryByRole('button', { name: 'Repair shape settings' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Editor status')).toHaveTextContent('Repair shape settings')
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByRole('button', { name: 'Repair shape settings' })).not.toBeInTheDocument()
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByLabelText('Editor status')).toHaveTextContent(/Undo blocked: Authoring would introduce renderer-fallback/)
  })
})
