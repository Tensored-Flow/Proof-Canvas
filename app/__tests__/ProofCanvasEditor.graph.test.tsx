import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ProofCanvasEditor from '../ProofCanvasEditor'
import { compileManim } from '@/lib/proofcanvas/compiler'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { canonicalProjectJson, ProjectDocumentSchema, cloneSerializable, type ProjectDocument } from '@/lib/proofcanvas/schema'

function graphProject({ legacyInvalid = false, keepSecondObject = true } = {}): ProjectDocument {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  const graph = {
    id: 'object-editor-graph',
    type: 'graph' as const,
    name: 'Editor function graph',
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 280, height: 160, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { stroke: '#315866' },
    properties: {
      expression: legacyInvalid
        ? { kind: 'divide' as const, left: { kind: 'constant' as const, value: 1 }, right: { kind: 'constant' as const, value: 0 } }
        : { kind: 'power' as const, base: { kind: 'variable' as const }, exponent: 2 },
      xMin: -2,
      xMax: 2,
    },
  }
  const sibling = cloneSerializable(shot.objects.find(({ type }) => type === 'text')!)
  sibling.id = 'object-editor-graph-sibling'
  sibling.name = 'Graph sibling'
  sibling.locked = false
  delete sibling.parentId
  shot.objects = keepSecondObject ? [graph, sibling] : [graph]
  shot.animations = []
  shot.propertyTracks = []
  shot.audioClips = []
  shot.captionClips = []
  shot.markers = []
  project.shots = [shot]
  return ProjectDocumentSchema.parse(project)
}

function selectGraph() {
  fireEvent.click(screen.getByRole('treeitem', { name: /Editor function graph/ }))
}

function editor() {
  return screen.getByRole('application', { name: 'ProofCanvas editor' })
}

describe('graph draft editor authority', () => {
  test('retains invalid text locally, applies one valid atomic contract, and undoes exactly', () => {
    render(<ProofCanvasEditor initialProject={graphProject()}/>)
    selectGraph()
    const expression = screen.getByRole('textbox', { name: 'Graph expression' })
    expect(expression).toHaveValue('(x ^ 2)')
    expect(screen.queryByText(/browser graph is schematic/i)).not.toBeInTheDocument()

    fireEvent.change(expression, { target: { value: '1 / 0' } })
    expect(expression).toHaveValue('1 / 0')
    expect(expression).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(/constant division by zero/i)
    expect(screen.getByRole('button', { name: 'Apply graph draft' })).toBeDisabled()
    expect(editor()).toHaveAttribute('data-history-past-count', '0')

    fireEvent.change(expression, { target: { value: '1 / x' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(/2 safe segments/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply graph draft' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(expression).toHaveValue('(1 / x)')

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(screen.getByRole('textbox', { name: 'Graph expression' })).toHaveValue('(x ^ 2)')
  })

  test('holds expression and both domain edges as one explicit Apply/Discard transaction', () => {
    render(<ProofCanvasEditor initialProject={graphProject()}/>)
    selectGraph()
    const xMin = screen.getByRole('spinbutton', { name: 'Graph X minimum' })
    const xMax = screen.getByRole('spinbutton', { name: 'Graph X maximum' })
    fireEvent.change(xMin, { target: { value: '5' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/xMax must be greater/i)
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    fireEvent.change(xMax, { target: { value: '7' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard graph draft' }))
    expect(xMin).toHaveValue(-2)
    expect(xMax).toHaveValue(2)
    expect(editor()).toHaveAttribute('data-history-past-count', '0')

    fireEvent.change(xMin, { target: { value: '-4' } })
    fireEvent.change(xMax, { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply graph draft' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(xMin).toHaveValue(-4)
    expect(xMax).toHaveValue(4)
  })

  test('preserves a lossless coefficient through a domain-only graph commit', () => {
    const project = cloneSerializable(graphProject())
    project.shots[0].objects[0].properties.expression = {
      kind: 'multiply',
      left: { kind: 'constant', value: 0.123456789012345 },
      right: { kind: 'variable' },
    }
    render(<ProofCanvasEditor initialProject={ProjectDocumentSchema.parse(project)}/>)
    selectGraph()
    const expression = screen.getByRole('textbox', { name: 'Graph expression' })
    expect(expression).toHaveValue('(0.123456789012345 * x)')

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Graph X minimum' }), { target: { value: '-3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply graph draft' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('textbox', { name: 'Graph expression' })).toHaveValue('(0.123456789012345 * x)')
  })

  test('shows the same effective style-pack graph stroke that preview and compiler use', () => {
    const project = cloneSerializable(graphProject())
    const graph = project.shots[0].objects[0]
    graph.style = {}
    graph.parentId = 'object-editor-graph-style-group'
    project.shots[0].objects.unshift({
      id: 'object-editor-graph-style-group',
      type: 'group',
      name: 'Graph style group',
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 320, height: 200, rotation: 0, scaleX: 1, scaleY: 1 },
      style: { stroke: '#ff0000', strokeWidth: 7 },
      properties: {},
    })
    const parsed = ProjectDocumentSchema.parse(project)
    render(<ProofCanvasEditor initialProject={parsed}/>)
    selectGraph()

    expect(screen.getByLabelText('Stroke')).toHaveValue('#ff0000')
    expect(screen.getByLabelText('Stroke width')).toHaveValue(7)
    expect(document.querySelector('polyline')).toHaveAttribute('stroke', '#ff0000')
    expect(document.querySelector('polyline')).toHaveAttribute('stroke-width', '7')
    expect(compileManim(parsed).python).toContain('.set_stroke("#ff0000", width=7.0)')
  })

  test('never rebinds a dirty draft across revision, selection, playback, or locking', () => {
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 81)
    const cancelFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    try {
      render(<ProofCanvasEditor initialProject={graphProject()}/>)
      selectGraph()
      const expression = screen.getByRole('textbox', { name: 'Graph expression' })
      fireEvent.change(expression, { target: { value: 'sin(x)' } })

      const name = screen.getByRole('textbox', { name: 'Name' })
      fireEvent.change(name, { target: { value: 'Editor function graph revised' } })
      fireEvent.blur(name)
      expect(expression).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Apply graph draft' })).toBeDisabled()
      expect(screen.getAllByText(/draft is stale because the project changed/i)).toHaveLength(2)
      fireEvent.click(screen.getByRole('button', { name: 'Discard graph draft' }))
      expect(expression).toBeEnabled()

      fireEvent.change(expression, { target: { value: 'cos(x)' } })
      fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
      expect(expression).toBeDisabled()
      expect(editor()).toHaveAttribute('data-history-past-count', '1')
      fireEvent.click(screen.getByRole('button', { name: 'Pause sequence' }))
      fireEvent.click(screen.getByRole('button', { name: 'Apply graph draft' }))
      expect(editor()).toHaveAttribute('data-history-past-count', '2')

      fireEvent.change(screen.getByRole('textbox', { name: 'Graph expression' }), { target: { value: 'abs(x)' } })
      fireEvent.click(screen.getByRole('checkbox', { name: 'Locked' }))
      expect(screen.getByRole('textbox', { name: 'Graph expression' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Apply graph draft' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Discard graph draft' })).toBeEnabled()

      fireEvent.click(screen.getByRole('treeitem', { name: /Graph sibling/ }))
      expect(editor()).toHaveAttribute('data-history-past-count', '3')
      fireEvent.click(screen.getByRole('treeitem', { name: /Editor function graph revised/ }))
      expect(screen.getByRole('textbox', { name: 'Graph expression' })).toHaveValue('cos(x)')
    } finally {
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
    }
  })

  test('repairs a loadable legacy-invalid graph but rejects it as a fresh project import', async () => {
    const legacy = graphProject({ legacyInvalid: true })
    render(<ProofCanvasEditor initialProject={legacy}/>)
    selectGraph()
    expect(screen.getByRole('alert')).toHaveTextContent(/constant division by zero/i)
    fireEvent.change(screen.getByRole('textbox', { name: 'Graph expression' }), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply graph draft' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('textbox', { name: 'Graph expression' })).toHaveValue('x')
    expect(screen.getByText(/undo blocked: authoring would introduce renderer-rejected graph_constant_division_by_zero/i)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Owner menu'))
    const file = new File(['legacy'], 'legacy-invalid.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { configurable: true, value: jest.fn().mockResolvedValue(canonicalProjectJson(legacy)) })
    fireEvent.change(screen.getByLabelText('Import project JSON'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/may not introduce invalid graph geometry/i))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
  })
})
