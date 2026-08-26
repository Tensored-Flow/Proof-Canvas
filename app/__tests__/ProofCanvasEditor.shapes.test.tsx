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
  type: 'circle' | 'rectangle' | 'line' | 'arrow' | 'brace'
    | 'ellipse' | 'polygon' | 'dashed-line' | 'double-arrow' | 'freeform-path',
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
    style: type === 'arrow' || type === 'double-arrow' ? { stroke: '#315866', strokeWidth: 3 } : {},
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
    expect(container.querySelectorAll('[data-shape-preset-id]')).toHaveLength(16)

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

    fireEvent.click(screen.getByRole('button', { name: 'Insert Polygon' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('treeitem', { name: /^Polygon;/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('combobox', { name: 'Polygon line join' })).toHaveValue('miter')
    expect(container.querySelector('[data-object-type="polygon"]')).toHaveAttribute('points')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

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
      getData: jest.fn((type: string) => type === PROOFCANVAS_SHAPE_PRESET_MIME ? 'bracket' : ''),
    }

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperties(drop, {
      clientX: { configurable: true, value: 480 },
      clientY: { configurable: true, value: 270 },
      dataTransfer: { configurable: true, value: dataTransfer },
    })
    fireEvent(canvas, drop)
    expect(screen.getByLabelText('Editor status')).toHaveTextContent('Insert Bracket')
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('treeitem', { name: /^Bracket;/ })).toHaveAttribute('aria-selected', 'true')
    expect(container.querySelector('[data-object-type="freeform-path"]')).toHaveAttribute('transform', expect.stringContaining('translate(600 200)'))
    expect(container.querySelector('[data-object-type="freeform-path"]')).toHaveAttribute('data-freeform-closed', 'false')
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

  test('authors polygon, dash, double-tip, and freeform controls as complete undoable records', () => {
    const polygon = shapeObject('object-native-polygon', 'polygon', { shape: {
      kind: 'polygon', lineJoin: 'miter', vertices: [
        { x: -0.5, y: 0.5 }, { x: 0, y: -0.5 }, { x: 0.5, y: 0.5 },
      ],
    } }, { width: 100, height: 100 })
    const dashed = shapeObject('object-native-dashed', 'dashed-line', { shape: {
      kind: 'dashed-line', lineCap: 'butt', dashLength: 12, gapLength: 8,
    } }, { width: 180, height: 2 })
    const doubleArrow = shapeObject('object-native-double', 'double-arrow', { shape: {
      kind: 'double-arrow', lineCap: 'butt', startTipShape: 'triangle', endTipShape: 'triangle', tipSizeRatio: 0.25,
    } }, { width: 180, height: 18 })
    const freeform = shapeObject('object-native-freeform', 'freeform-path', { shape: {
      kind: 'freeform-path', closed: false, lineCap: 'round', lineJoin: 'round', nodes: [
        { point: { x: -0.5, y: 0.2 } },
        { point: { x: 0, y: -0.2 } },
        { point: { x: 0.5, y: 0.2 } },
      ],
    } }, { width: 200, height: 100 })
    const { container } = render(<ProofCanvasEditor initialProject={projectWith([polygon, dashed, doubleArrow, freeform])}/>)

    selectLayer('native polygon')
    fireEvent.change(screen.getByRole('combobox', { name: 'Polygon line join' }), { target: { value: 'bevel' } })
    const vertexX = screen.getByRole('spinbutton', { name: 'Vertex 1 X' })
    fireEvent.change(vertexX, { target: { value: '-0.4' } })
    fireEvent.blur(vertexX)
    expect(container.querySelector('[data-object-id="object-native-polygon"]')).toHaveAttribute('points', '-40,50 0,-50 50,50')

    selectLayer('native dashed')
    fireEvent.change(screen.getByRole('combobox', { name: 'Dashed line cap' }), { target: { value: 'round' } })
    const dashLength = screen.getByRole('spinbutton', { name: 'Dash length' })
    fireEvent.change(dashLength, { target: { value: '10' } })
    fireEvent.blur(dashLength)
    expect(screen.getByRole('spinbutton', { name: 'Gap length' })).toHaveValue(8)
    expect(container.querySelector('[data-object-id="object-native-dashed"]')).toHaveAttribute('data-dash-length', '10')

    selectLayer('native double')
    fireEvent.change(screen.getByRole('combobox', { name: 'Start arrow tip' }), { target: { value: 'circle' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'End arrow tip' }), { target: { value: 'square' } })
    const doubleTipSize = screen.getByRole('spinbutton', { name: 'Double arrow tip size' })
    fireEvent.change(doubleTipSize, { target: { value: '0.4' } })
    fireEvent.blur(doubleTipSize)
    expect(container.querySelector('[data-object-id="object-native-double"] [data-arrow-tip-side="start"]')).toHaveAttribute('data-arrow-tip-shape', 'circle')
    expect(container.querySelector('[data-object-id="object-native-double"] [data-arrow-tip-side="end"]')).toHaveAttribute('data-arrow-tip-shape', 'square')

    selectLayer('native freeform')
    fireEvent.change(screen.getByRole('combobox', { name: 'Freeform line join' }), { target: { value: 'bevel' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add incoming handle' })[0])
    expect(screen.getByRole('spinbutton', { name: 'Node 2 incoming handle X' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Closed freeform path' }))
    expect(container.querySelector('[data-object-id="object-native-freeform"]')).toHaveAttribute('data-freeform-closed', 'true')
    expect(screen.queryByRole('combobox', { name: 'Freeform line cap' })).not.toBeInTheDocument()
    expect(editor()).toHaveAttribute('data-history-past-count', '10')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(container.querySelector('[data-object-id="object-native-freeform"]')).toHaveAttribute('data-freeform-closed', 'false')
    expect(screen.getByRole('combobox', { name: 'Freeform line cap' })).toHaveValue('round')
  })

  test('exposes keyframeable fill only while a freeform is closed and atomically clears it when reopened', () => {
    const freeform = shapeObject('object-conditional-fill', 'freeform-path', { shape: {
      kind: 'freeform-path', closed: false, lineCap: 'round', lineJoin: 'round', nodes: [
        { point: { x: -0.5, y: 0.25 } },
        { point: { x: 0, y: -0.5 } },
        { point: { x: 0.5, y: 0.25 } },
      ],
    } }, { width: 180, height: 100 })
    freeform.style = { stroke: '#654321', strokeWidth: 4 }
    const project = projectWith([freeform])
    const background = project.styles.find(({ id }) => id === project.activeStyleId)!.colors.background
    const { container } = render(<ProofCanvasEditor initialProject={project}/>)
    selectLayer('conditional fill')
    expect(screen.queryByLabelText('Fill')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Fill keyframe at 0 seconds' })).not.toBeInTheDocument()
    expect(container.querySelector('[data-object-id="object-conditional-fill"] path:not([stroke="transparent"])')).toHaveAttribute('fill', 'none')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Closed freeform path' }))
    expect(screen.getByLabelText('Fill')).toHaveValue(background)
    expect(container.querySelector('[data-object-id="object-conditional-fill"] path:not([stroke="transparent"])')).toHaveAttribute('fill', background)
    const fill = screen.getByLabelText('Fill')
    fireEvent.change(fill, { target: { value: '#123456' } })
    fireEvent.blur(fill)
    expect(screen.getByLabelText('Fill')).toHaveValue('#123456')
    expect(container.querySelector('[data-object-id="object-conditional-fill"] path:not([stroke="transparent"])')).toHaveAttribute('fill', '#123456')
    fireEvent.click(screen.getByRole('button', { name: 'Add Fill keyframe at 0 seconds' }))
    expect(screen.getByRole('button', { name: 'fill keyframe at 0 seconds' })).toBeInTheDocument()
    expect(editor()).toHaveAttribute('data-history-past-count', '3')

    selectLayer('conditional fill')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Closed freeform path' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '4')
    expect(screen.queryByLabelText('Fill')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'fill keyframe at 0 seconds' })).not.toBeInTheDocument()
    expect(container.querySelector('[data-object-id="object-conditional-fill"]')).toHaveAttribute('data-freeform-closed', 'false')
    expect(container.querySelector('[data-object-id="object-conditional-fill"] path:not([stroke="transparent"])')).toHaveAttribute('fill', 'none')

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(container.querySelector('[data-object-id="object-conditional-fill"]')).toHaveAttribute('data-freeform-closed', 'true')
    expect(screen.getByLabelText('Fill')).toHaveValue('#123456')
    expect(screen.getByRole('button', { name: 'fill keyframe at 0 seconds' })).toBeInTheDocument()
  })

  test('atomically rejects a polygon crossing with a precise nested status and input reset', () => {
    const polygon = shapeObject('object-crossing-status', 'polygon', { shape: {
      kind: 'polygon', lineJoin: 'miter', vertices: [
        { x: -0.5, y: -0.5 },
        { x: -0.5, y: -0.25 },
        { x: -0.5, y: 0 },
        { x: -0.25, y: -0.5 },
      ],
    } }, { width: 100, height: 100 })
    const { container } = render(<ProofCanvasEditor initialProject={projectWith([polygon])}/>)
    selectLayer('crossing status')
    const input = screen.getByRole('spinbutton', { name: 'Vertex 1 X' })
    const points = container.querySelector('[data-object-id="object-crossing-status"]')?.getAttribute('points')
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(input).toHaveValue(-0.5)
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(container.querySelector('[data-object-id="object-crossing-status"]')).toHaveAttribute('points', points)
    expect(screen.getByLabelText('Editor status')).toHaveTextContent('Shape settings at vertices[2]: Polygon edges must not intersect outside adjacent vertices. The edit was not applied.')
  })

  test('atomically rejects quantized freeform endpoint collapse with a precise nested status and input reset', () => {
    const freeform = shapeObject('object-quantized-status', 'freeform-path', { shape: {
      kind: 'freeform-path', closed: false, lineCap: 'round', lineJoin: 'round', nodes: [
        { point: { x: 0, y: 0 } },
        { point: { x: 3e-8, y: 0 } },
      ],
    } }, { width: 180, height: 100 })
    render(<ProofCanvasEditor initialProject={projectWith([freeform])}/>)
    selectLayer('quantized status')
    const input = screen.getByRole('spinbutton', { name: 'Node 2 X' })
    fireEvent.change(input, { target: { value: '0.000000001' } })
    fireEvent.blur(input)
    expect(input).toHaveValue(3e-8)
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(screen.getByLabelText('Editor status')).toHaveTextContent('Shape settings at nodes[1].point: Adjacent shape points must remain distinct after eight-decimal compiler quantization. The edit was not applied.')
  })

  test('atomically rejects an unsafe dash ratio with a precise nested status and input reset', () => {
    const dashed = shapeObject('object-dash-ratio-status', 'dashed-line', { shape: {
      kind: 'dashed-line', lineCap: 'butt', dashLength: 12, gapLength: 8,
    } }, { width: 180, height: 2 })
    render(<ProofCanvasEditor initialProject={projectWith([dashed])}/>)
    selectLayer('dash ratio status')
    const input = screen.getByRole('spinbutton', { name: 'Gap length' })
    fireEvent.change(input, { target: { value: '4096' } })
    fireEvent.blur(input)
    expect(input).toHaveValue(8)
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(screen.getByLabelText('Editor status')).toHaveTextContent('Shape settings at gapLength: Dashed-line dash ratio must be between 0.05 and 0.95. The edit was not applied.')
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

  test.each([
    ['dashed-line', { shape: { kind: 'dashed-line', lineCap: 'butt', dashLength: 12, gapLength: 8 } }],
    ['double-arrow', { shape: { kind: 'double-arrow', lineCap: 'butt', startTipShape: 'triangle', endTipShape: 'square', tipSizeRatio: 0.25 } }],
  ] as const)('applies endpoint authority to the native %s primitive', (type, properties) => {
    const object = shapeObject(`object-authority-${type}`, type, properties, { x: 100, y: 100, width: 100, height: 2 })
    const widthTrack: PropertyTrack = {
      id: `track-authority-${type}`,
      target: { kind: 'object', objectId: object.id },
      property: 'width',
      keyframes: [{ id: `key-authority-${type}`, time: 0, value: 100, interpolation: { kind: 'linear' } }],
    }
    render(<ProofCanvasEditor initialProject={projectWith([object], [widthTrack])}/>)
    selectLayer(`authority ${type.replaceAll('-', ' ')}`)
    expect(screen.getByRole('spinbutton', { name: 'Start X' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'End Y' })).toBeDisabled()
    expect(screen.getByText(/Endpoint editing is unavailable/)).toBeInTheDocument()
  })

  test('disables native shape controls under object lock and sequence playback', () => {
    const polygon = shapeObject('object-lock-polygon', 'polygon', { shape: {
      kind: 'polygon', lineJoin: 'miter', vertices: [
        { x: -0.5, y: 0.5 }, { x: 0, y: -0.5 }, { x: 0.5, y: 0.5 },
      ],
    } })
    render(<ProofCanvasEditor initialProject={projectWith([polygon])}/>)
    selectLayer('lock polygon')
    const join = () => screen.getByRole('combobox', { name: 'Polygon line join' })
    expect(join()).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Lock' }))
    expect(join()).toBeDisabled()
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(join()).toBeEnabled()
    expect(editor()).toHaveAttribute('data-history-past-count', '2')

    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    expect(join()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pause sequence' })).toBeInTheDocument()
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
    fireEvent.click(screen.getByRole('button', { name: 'Pause sequence' }))
    expect(join()).toBeEnabled()
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
