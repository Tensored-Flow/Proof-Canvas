import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ProofCanvasEditor from '../ProofCanvasEditor'
import { PROOFCANVAS_SEMANTIC_COMPONENT_MIME, SEMANTIC_COMPONENTS } from '@/lib/proofcanvas/components'
import { cloneSerializable, type ProjectDocument } from '@/lib/proofcanvas/schema'
import { createProjectTemplate } from '@/lib/proofcanvas/templates'

const COMPONENT_IDS = [
  'mathematical-title',
  'definition-block',
  'proposition-statement',
  'proof-step-sequence',
  'equation-chain',
  'annotated-diagram',
  'case-comparison',
  'focus-callout',
  'marginal-note',
  'recursive-intervals',
  'vector-explanation',
  'example-abstraction',
] as const

function blankProject(): ProjectDocument {
  return createProjectTemplate('blank', 'project-component-editor', 'Component editor')
}

function editor() {
  return screen.getByRole('application', { name: 'ProofCanvas editor' })
}

function transferFor(componentId: string) {
  const values = new Map<string, string>()
  return {
    types: [PROOFCANVAS_SEMANTIC_COMPONENT_MIME],
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: jest.fn((type: string, value: string) => values.set(type, value)),
    getData: jest.fn((type: string) => values.get(type) ?? (type === PROOFCANVAS_SEMANTIC_COMPONENT_MIME ? componentId : '')),
  }
}

function dropEvent(dataTransfer: ReturnType<typeof transferFor>, point: { x: number; y: number }) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientX: { configurable: true, value: point.x },
    clientY: { configurable: true, value: point.y },
    dataTransfer: { configurable: true, value: dataTransfer },
  })
  return event
}

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

describe('semantic component library authoring', () => {
  test('exposes the exact searchable twelve-card registry and fixed drag MIME', () => {
    const { container } = render(<ProofCanvasEditor initialProject={blankProject()}/>)
    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))
    const library = container.querySelector('.pc-component-list')!
    expect(library).toHaveAttribute('data-semantic-component-count', '12')
    expect([...library.querySelectorAll<HTMLElement>('[data-component-id]')].map(({ dataset }) => dataset.componentId)).toEqual(COMPONENT_IDS)
    expect(SEMANTIC_COMPONENTS.map(({ id }) => id)).toEqual(COMPONENT_IDS)

    const search = screen.getByRole('searchbox', { name: 'Search library' })
    fireEvent.change(search, { target: { value: 'vector' } })
    expect(library.querySelectorAll('[data-component-id]')).toHaveLength(1)
    const vectorCard = screen.getByRole('button', { name: 'Insert Vector explanation' })
    const dataTransfer = transferFor('vector-explanation')
    fireEvent.dragStart(vectorCard, { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe('copy')
    expect(dataTransfer.setData).toHaveBeenCalledWith(PROOFCANVAS_SEMANTIC_COMPONENT_MIME, 'vector-explanation')
    expect(vectorCard).toHaveAttribute('data-dragging', 'true')
    fireEvent.dragEnd(vectorCard, { dataTransfer })
    expect(vectorCard).toHaveAttribute('data-dragging', 'false')
  })

  test('click inserts one root-selected, editable and ungroupable history step at the preview camera centre', () => {
    const project = cloneSerializable(blankProject())
    project.shots[0].camera = { x: 610, y: 210, zoom: 1.5, rotation: 12 }
    render(<ProofCanvasEditor initialProject={project}/>)
    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert Definition' }))

    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    const root = screen.getByRole('treeitem', { name: /^Definition;/ })
    expect(root).toHaveAttribute('aria-level', '1')
    expect(root).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('treeitem').filter((item) => item.getAttribute('aria-selected') === 'true')).toEqual([root])
    expect(screen.getByRole('form', { name: 'Group inspector' })).toHaveAttribute('data-inspector-object-id', root.getAttribute('data-layer-object-id'))
    expect(screen.getByRole('spinbutton', { name: 'X position' })).toHaveValue(610)
    expect(screen.getByRole('spinbutton', { name: 'Y position' })).toHaveValue(210)

    fireEvent.click(screen.getByRole('button', { name: 'Ungroup selection' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
    expect(screen.queryByRole('treeitem', { name: /^Definition;/ })).not.toBeInTheDocument()
    const statement = screen.getByRole('treeitem', { name: /^Definition statement;/ })
    expect(statement).toHaveAttribute('aria-level', '1')
    fireEvent.click(statement)
    const content = screen.getByRole('textbox', { name: 'Content' })
    fireEvent.change(content, { target: { value: 'A definition remains ordinary editable text.' } })
    fireEvent.blur(content)
    expect(screen.getByRole('textbox', { name: 'Content' })).toHaveValue('A definition remains ordinary editable text.')
  })

  test('drag inserts atomically at the camera-transformed pointer and refuses forged playback drops', () => {
    const project = cloneSerializable(blankProject())
    project.shots[0].camera = { x: 600, y: 200, zoom: 2, rotation: 90 }
    const { container } = render(<ProofCanvasEditor initialProject={project}/>)
    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))
    const canvas = container.querySelector('svg.pc-stage') as SVGSVGElement
    Object.defineProperty(canvas, 'createSVGPoint', { configurable: true, value: () => {
      const point = { x: 0, y: 0, matrixTransform: () => ({ x: point.x, y: point.y }) }
      return point
    } })
    Object.defineProperty(canvas, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({}) }) })

    fireEvent(canvas, dropEvent(transferFor('vector-explanation'), { x: 480, y: 270 }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByLabelText('Editor status')).toHaveTextContent('Insert Vector explanation')
    expect(screen.getAllByRole('treeitem', { name: /^Vector explanation;/ }).find((item) => item.getAttribute('aria-level') === '1')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('spinbutton', { name: 'X position' })).toHaveValue(600)
    expect(screen.getByRole('spinbutton', { name: 'Y position' })).toHaveValue(200)

    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    const titleCard = screen.getByRole('button', { name: 'Insert Title & subtitle' })
    expect(titleCard).toBeDisabled()
    expect(titleCard).toHaveAttribute('draggable', 'false')
    fireEvent(canvas, dropEvent(transferFor('mathematical-title'), { x: 480, y: 270 }))
    expect(screen.getByLabelText('Editor status')).toHaveTextContent('Pause playback before dropping a component.')
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
  })
})
