import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ProofCanvasEditor from '../ProofCanvasEditor'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { logicalFrameFor, resolutionFor, type ProofCanvasAspectRatio } from '@/lib/proofcanvas/frame'
import { applyOperations } from '@/lib/proofcanvas/operations'
import { PROJECT_SCHEMA_VERSION, PROOFCANVAS_PROJECT_MAX_BYTES, ProjectDocumentSchema, canonicalProjectJson, cloneSerializable } from '@/lib/proofcanvas/schema'

const createObjectURL = jest.fn(() => 'blob:proofcanvas-test')
const revokeObjectURL = jest.fn()
const fetchMock = jest.fn()
let anchorClick: jest.SpyInstance

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: jest.fn().mockResolvedValue(body) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

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

beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  anchorClick = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterAll(() => anchorClick.mockRestore())

beforeEach(() => {
  window.localStorage.clear()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  anchorClick.mockClear()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).includes('/api/proofcanvas/ai')
    ? jsonResponse(503, { ok: false, code: 'provider_unavailable', message: 'OpenAI editing is not configured.' })
    : jsonResponse(503, { ok: false, code: 'render_unavailable', message: 'ProofCanvas rendering is not configured.' }))
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock })
})

afterEach(cleanup)

function editor() {
  return screen.getByRole('application', { name: 'ProofCanvas editor' })
}

function openAssistant() {
  if (screen.queryByRole('dialog', { name: 'AI command drawer' })) return
  fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
  fireEvent.click(screen.getByRole('option', { name: /AI structured edit/ }))
}

function runAiPreset(index = 1) {
  openAssistant()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Run AI preset ${index}:`) }))
}

function openRenderDialog() {
  if (screen.queryByRole('dialog', { name: 'Render and export' })) return
  fireEvent.click(screen.getByRole('button', { name: 'Render or export' }))
}

function openOwnerMenu() {
  if (screen.getByLabelText('Owner menu').getAttribute('aria-expanded') === 'true') return
  fireEvent.click(screen.getByLabelText('Owner menu'))
}

describe('ProofCanvas editor client', () => {
  it('preloads the complete Cantor project and exposes the editor contract', () => {
    const { container } = render(<ProofCanvasEditor />)

    expect(editor()).toHaveAttribute('data-project-id', 'project-uncountable-zero-length')
    expect(editor()).toHaveAttribute('data-schema-version', String(PROJECT_SCHEMA_VERSION))
    expect(editor()).toHaveAttribute('data-active-shot-id', 'shot-cantor-construction')
    expect(screen.getByRole('tree', { name: 'Objects' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-style-id', 'style-editorial-ink')
    expect(screen.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '6.8')
    expect(container.querySelector('[data-object-id="object-title"]')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Active output style' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'AI command drawer' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Project settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Media' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'Shots' })).toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-shot-id', 'shot-cantor-construction')
    expect(container.querySelector('[data-object-id="object-removal-first"]')).not.toBeInTheDocument()
  })

  it('provides editor-only canvas zoom, a reversible focus mode, and safe fitted portrait conversion', () => {
    render(<ProofCanvasEditor />)
    const scene = screen.getByRole('region', { name: 'Scene canvas' })
    expect(scene).toHaveAttribute('data-editor-zoom', '1')
    fireEvent.change(screen.getByRole('combobox', { name: 'Editor canvas zoom' }), { target: { value: '1.5' } })
    expect(scene).toHaveAttribute('data-editor-zoom', '1.5')
    expect(scene).toHaveAttribute('data-editor-zoomed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Focus canvas' }))
    expect(editor()).toHaveAttribute('data-canvas-focus', 'true')
    expect(editor()).toHaveAttribute('data-left-collapsed', 'true')
    expect(editor()).toHaveAttribute('data-right-collapsed', 'true')
    expect(editor()).toHaveAttribute('data-timeline-collapsed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Restore editor panels' }))
    expect(editor()).toHaveAttribute('data-canvas-focus', 'false')
    expect(editor()).toHaveAttribute('data-left-collapsed', 'false')
    expect(editor()).toHaveAttribute('data-right-collapsed', 'false')
    expect(editor()).toHaveAttribute('data-timeline-collapsed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }))
    expect(screen.getByRole('radio', { name: /Fit all content/ })).toBeChecked()
    fireEvent.change(screen.getByRole('combobox', { name: 'Aspect ratio' }), { target: { value: '9:16' } })
    expect(screen.getByRole('combobox', { name: 'Aspect ratio' })).toHaveValue('9:16')
    expect(screen.getByText('All static object bounds are inside the current frame')).toBeInTheDocument()
    expect(editor()).toHaveStyle('--pc-timeline-height: 260px')
    expect(scene).toHaveAttribute('data-editor-zoom', '1')
  })

  it('keeps the visible range, canvas, output, and timeline line on one playback clock', () => {
    const project = cloneSerializable(createCantorDemoProject())
    const shotDuration = project.shots[0].duration
    const duration = project.shots.reduce((total, candidate) => total + candidate.duration, 0)
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameId += 1
      frames.set(frameId, callback)
      return frameId
    })
    const cancelFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
    const now = jest.spyOn(performance, 'now').mockReturnValue(1_000)
    const runNextFrame = (time: number) => {
      const entry = [...frames.entries()][0]
      expect(entry).toBeDefined()
      frames.delete(entry[0])
      act(() => entry[1](time))
    }
    const expectCoherentTime = (time: number) => {
      expect((screen.getByRole('slider', { name: 'Sequence time' }) as HTMLInputElement).valueAsNumber).toBeCloseTo(time, 5)
      expect(Number(screen.getByRole('region', { name: 'Scene canvas' }).getAttribute('data-preview-time'))).toBeCloseTo(time, 5)
      expect(screen.getByRole('status', { name: 'Shot playhead time' })).toHaveTextContent(`${time.toFixed(2)}s`)
      expect(Number.parseFloat((document.querySelector('.pc-playhead') as HTMLElement).style.left)).toBeCloseTo(time / shotDuration * 100, 5)
    }

    try {
      render(<ProofCanvasEditor initialProject={project} />)
      expectCoherentTime(0)
      fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toBeDisabled()
      runNextFrame(1_500)
      expectCoherentTime(0.5)

      fireEvent.click(screen.getByRole('button', { name: 'Pause sequence' }))
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toBeEnabled()
      expectCoherentTime(0.5)
      fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '1.25' } })
      expectCoherentTime(1.25)

      fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
      runNextFrame(1_000 + (duration - 1.25) * 1_000)
      expect(screen.getByRole('button', { name: 'Play sequence' })).toBeInTheDocument()
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toBeEnabled()
      expect((screen.getByRole('slider', { name: 'Sequence time' }) as HTMLInputElement).valueAsNumber).toBeCloseTo(duration, 5)
      expect(editor()).toHaveAttribute('data-active-shot-id', project.shots.at(-1)!.id)
      expect(Number(screen.getByRole('region', { name: 'Scene canvas' }).getAttribute('data-preview-time'))).toBeCloseTo(project.shots.at(-1)!.duration, 5)
      fireEvent.click(screen.getByRole('button', { name: 'Jump to sequence start' }))
      expectCoherentTime(0)
    } finally {
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      now.mockRestore()
    }
  })

  it.each(['9:16', '1:1'] as ProofCanvasAspectRatio[])('centres a new %s shot on the shared logical frame', (aspectRatio) => {
    const project = cloneSerializable(createCantorDemoProject())
    const frame = logicalFrameFor(aspectRatio)
    project.settings.aspectRatio = aspectRatio
    project.settings.resolution = resolutionFor(aspectRatio, project.settings.renderPreset)
    render(<ProofCanvasEditor initialProject={project} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add shot' }))
    const stage = screen.getByRole('group', { name: /Scene 3 canvas/ })
    expect(stage).toHaveAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`)
    expect(stage.querySelector('[data-pc-camera-transform]')).toHaveAttribute('transform', expect.stringContaining(`translate(${frame.centerX} ${frame.centerY})`))
    expect(stage.querySelector('[data-pc-camera-transform]')).toHaveAttribute('transform', expect.stringContaining(`translate(${-frame.centerX} ${-frame.centerY})`))
  })

  it.each(['9:16', '1:1'] as ProofCanvasAspectRatio[])('keeps ordinary and semantic-component insertions inside the %s logical frame', (aspectRatio) => {
    const project = cloneSerializable(createCantorDemoProject())
    const frame = logicalFrameFor(aspectRatio)
    project.settings.aspectRatio = aspectRatio
    project.settings.resolution = resolutionFor(aspectRatio, project.settings.renderPreset)
    const { container } = render(<ProofCanvasEditor initialProject={project} />)
    const existingIds = new Set([...container.querySelectorAll<SVGElement>('[data-object-id]')].map((element) => element.dataset.objectId))

    fireEvent.click(screen.getByRole('tab', { name: 'Graphs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add coordinate axes' }))
    const axes = [...container.querySelectorAll<SVGElement>('svg.pc-stage [data-object-type="axes"]')]
      .find((element) => !existingIds.has(element.dataset.objectId))!
    const axesPosition = axes.getAttribute('transform')?.match(/^translate\(([-\d.]+) ([-\d.]+)\)/)
    expect(axesPosition).not.toBeNull()
    const axesX = Number(axesPosition?.[1])
    const axesY = Number(axesPosition?.[2])
    expect(axesX - 120).toBeGreaterThanOrEqual(0)
    expect(axesX + 120).toBeLessThanOrEqual(frame.width)
    expect(axesY - 75).toBeGreaterThanOrEqual(0)
    expect(axesY + 75).toBeLessThanOrEqual(frame.height)

    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert Title & subtitle' }))
    const titleParts = [...container.querySelectorAll<SVGForeignObjectElement>('[data-parent-id="group-mathematical-title"]')]
    expect(titleParts).toHaveLength(2)
    for (const part of titleParts) {
      const position = part.getAttribute('transform')?.match(/^translate\(([-\d.]+) ([-\d.]+)\)/)
      expect(position).not.toBeNull()
      const centerX = Number(position?.[1])
      const centerY = Number(position?.[2])
      const localX = Number(part.getAttribute('x'))
      const localY = Number(part.getAttribute('y'))
      const width = Number(part.getAttribute('width'))
      const height = Number(part.getAttribute('height'))
      expect(centerX + localX).toBeGreaterThanOrEqual(0)
      expect(centerX + localX + width).toBeLessThanOrEqual(frame.width)
      expect(centerY + localY).toBeGreaterThanOrEqual(0)
      expect(centerY + localY + height).toBeLessThanOrEqual(frame.height)
    }
    expect(screen.getByRole('group', { name: /canvas at/ })).toHaveStyle(`--pc-stage-aspect: ${frame.width} / ${frame.height}`)
  })

  it('runs selection edits and AI proposals through authoritative history', async () => {
    render(<ProofCanvasEditor />)
    const titleLayer = screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ })

    fireEvent.click(titleLayer)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate selection' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length copy/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByRole('treeitem', { name: /Uncountable, Yet Zero Length copy/ })).not.toBeInTheDocument()

    runAiPreset()
    const proposal = await screen.findByRole('region', { name: 'Proposed changes' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(within(proposal).getAllByRole('listitem')[0]).toHaveAttribute('data-operation-kind', 'update-object')
    fireEvent.click(within(proposal).getByRole('button', { name: 'Apply proposed changes' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.queryByRole('region', { name: 'Proposed changes' })).not.toBeInTheDocument()
  })

  it('makes output-style changes authoritative and undoable', () => {
    render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('radio', { name: 'Raw Manim' }))
    expect(screen.getByRole('radio', { name: 'Raw Manim' })).toBeChecked()
    expect(screen.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-style-id', 'style-raw-manim')
    expect(editor()).toHaveAttribute('data-history-past-count', '1')

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByRole('radio', { name: 'Editorial Ink' })).toBeChecked()
    expect(screen.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-style-id', 'style-editorial-ink')
  })

  it('normalizes ancestor and descendant multi-selection before destructive actions', () => {
    const { container } = render(<ProofCanvasEditor />)
    const group = screen.getByRole('treeitem', { name: /Cantor interval diagram/ })
    const child = screen.getByRole('treeitem', { name: /Original interval/ })
    fireEvent.click(group)
    expect(container.querySelector('[data-group-move-target="object-interval-diagram"]')).toBeInTheDocument()
    fireEvent.click(child, { shiftKey: true })
    expect(group).toHaveAttribute('aria-selected', 'true')
    expect(child).toHaveAttribute('aria-selected', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Delete selection' }))
    expect(screen.queryByRole('treeitem', { name: /Cantor interval diagram/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: /Original interval/ })).not.toBeInTheDocument()
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
  })

  it('keeps a new group inside the common parent of selected siblings', () => {
    render(<ProofCanvasEditor />)
    const left = screen.getByRole('treeitem', { name: /First left interval/ })
    const right = screen.getByRole('treeitem', { name: /First right interval/ })

    fireEvent.click(left)
    fireEvent.click(right, { shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Group selection', exact: true }))

    expect(screen.getByRole('treeitem', { name: /Object group/ })).toHaveAttribute('aria-level', '2')
    expect(left).toHaveAttribute('aria-level', '3')
    expect(right).toHaveAttribute('aria-level', '3')
  })

  it('reorders leaf layers one step and group families as visual blocks', () => {
    const { container } = render(<ProofCanvasEditor />)
    const layerIds = () => [...container.querySelectorAll<HTMLElement>('[data-layer-object-id]')].map((element) => element.dataset.layerObjectId)
    const child = screen.getByRole('treeitem', { name: /Original interval/ })
    const childBefore = layerIds().indexOf('object-interval-generation-0')
    fireEvent.click(child)
    fireEvent.click(screen.getByRole('button', { name: 'Bring forward' }))
    expect(layerIds().indexOf('object-interval-generation-0')).toBe(childBefore + 1)

    fireEvent.click(screen.getByRole('treeitem', { name: /Cantor interval diagram/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Bring to front' }))
    const after = layerIds()
    expect(after.indexOf('object-interval-diagram')).toBeGreaterThan(after.indexOf('object-margin-note'))
    expect(after.indexOf('object-interval-generation-0')).toBeGreaterThan(after.indexOf('object-margin-note'))
  })

  it('keeps child layer reordering inside its contiguous parent family', () => {
    const { container } = render(<ProofCanvasEditor />)
    const layerIds = () => [...container.querySelectorAll<HTMLElement>('[data-layer-object-id]')].map((element) => element.dataset.layerObjectId)
    fireEvent.click(screen.getByRole('treeitem', { name: /Original interval/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Bring to front' }))

    const ids = layerIds()
    const groupIndex = ids.indexOf('object-interval-diagram')
    const nextRootIndex = ids.indexOf('object-equation-chain')
    expect(groupIndex).toBeGreaterThanOrEqual(0)
    expect(nextRootIndex).toBeGreaterThan(groupIndex)
    expect(ids.indexOf('object-interval-generation-0')).toBe(nextRootIndex - 1)
  })

  it('supports keyboard multi-selection in the layer tree', async () => {
    render(<ProofCanvasEditor />)
    const title = screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ })
    const subtitle = screen.getByRole('treeitem', { name: /A quiet paradox/ })
    title.focus()
    fireEvent.keyDown(title, { key: ' ' })
    fireEvent.keyDown(title, { key: 'ArrowDown', ctrlKey: true })
    await waitFor(() => expect(subtitle).toHaveFocus())
    fireEvent.keyDown(subtitle, { key: ' ' })

    expect(title).toHaveAttribute('aria-selected', 'true')
    expect(subtitle).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tree', { name: 'Objects' })).toHaveAttribute('aria-multiselectable', 'true')
  })

  it('uses a configured structured provider response when the server returns one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      ok: true,
      provider: 'configured-provider',
      demoMode: false,
      intention: 'Move the title precisely.',
      summary: ['Update object-title: transform'],
      operations: [{ type: 'update-object', objectId: 'object-title', patch: { transform: { x: 210 } } }],
    }))
    render(<ProofCanvasEditor aiConfigured />)

    runAiPreset()
    const proposal = await screen.findByRole('region', { name: 'Proposed changes' })
    expect(screen.getByRole('region', { name: 'AI command' })).toHaveAttribute('data-ai-provider', 'configured-provider')
    expect(screen.getByText('OpenAI structured operations — server configured')).toBeInTheDocument()
    expect(within(proposal).getByText(/Uncountable, Yet Zero Length \(object-title\)/)).toBeInTheDocument()
    fireEvent.click(within(proposal).getByText(/Uncountable, Yet Zero Length \(object-title\)/))
    expect(proposal.querySelector('pre')).toHaveTextContent('"before"')
    expect(proposal.querySelector('pre')).toHaveTextContent('"after"')
    expect(proposal.querySelector('pre')).toHaveTextContent('"x": 210')
  })

  it('reviews an atomically valid AI repair without dropping its invalid intermediate prefix', async () => {
    const project = cloneSerializable(createCantorDemoProject())
    const shot = project.shots[0]
    shot.animations = [{
      id: 'animation-review-atomic',
      type: 'move',
      targetIds: ['object-title'],
      start: 1,
      duration: 1,
      easing: 'linear',
      properties: { deltaX: 20 },
    }]
    shot.propertyTracks = [{
      id: 'track-review-title-x',
      target: { kind: 'object', objectId: 'object-title' },
      property: 'x',
      keyframes: [
        { id: 'keyframe-review-title-x-a', time: 0, value: 100, interpolation: { kind: 'hold' } },
        { id: 'keyframe-review-title-x-b', time: 4, value: 300, interpolation: { kind: 'linear' } },
      ],
    }]
    const legacy = ProjectDocumentSchema.parse(project)
    const operations = [
      { type: 'update-animation' as const, animationId: 'animation-review-atomic', patch: { duration: 2 } },
      { type: 'update-animation' as const, animationId: 'animation-review-atomic', patch: { targetIds: ['object-subtitle'] } },
    ]
    expect(() => applyOperations(legacy, shot.id, [operations[0]])).toThrow(/cannot be modified while it remains invalid/)
    expect(applyOperations(legacy, shot.id, operations).project.shots[0].animations[0]).toMatchObject({ duration: 2, targetIds: ['object-subtitle'] })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      ok: true,
      provider: 'configured-provider',
      demoMode: false,
      intention: 'Repair the legacy collision atomically.',
      summary: ['Extend the move', 'Retarget the move'],
      operations,
    }))
    render(<ProofCanvasEditor initialProject={legacy} aiConfigured />)

    runAiPreset()
    const proposal = await screen.findByRole('region', { name: 'Proposed changes' })
    const details = [...proposal.querySelectorAll('pre')].map((element) => JSON.parse(element.textContent ?? '{}')) as Array<{
      before: { animations: Array<{ duration: number; targetIds: string[] }> };
      after: { animations: Array<{ duration: number; targetIds: string[] }> };
    }>
    expect(details).toHaveLength(2)
    expect(details[0].after.animations[0]).toMatchObject({ duration: 2, targetIds: ['object-title'] })
    expect(details[1].before.animations[0]).toMatchObject({ duration: 2, targetIds: ['object-title'] })
    expect(details[1].after.animations[0]).toMatchObject({ duration: 2, targetIds: ['object-subtitle'] })

    fireEvent.click(within(proposal).getByRole('button', { name: 'Apply proposed changes' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent('AI proposal applied as one transaction')
  })

  it('discards an in-flight provider response when the project revision changes', async () => {
    let release!: (value: ReturnType<typeof jsonResponse>) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    render(<ProofCanvasEditor aiConfigured />)

    runAiPreset()
    expect(screen.getByRole('button', { name: 'Propose edit' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
    await act(async () => {
      release(jsonResponse(200, {
        ok: true,
        intention: 'Stale move',
        summary: ['Update object-title: transform'],
        operations: [{ type: 'update-object', objectId: 'object-title', patch: { transform: { x: 99 } } }],
      }))
      await Promise.resolve()
    })

    expect(screen.queryByRole('region', { name: 'Proposed changes' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Propose edit' })).toBeEnabled()
  })

  it('does not add history entries when unchanged inspector values blur', () => {
    render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    fireEvent.blur(screen.getByRole('textbox', { name: 'Name' }))
    fireEvent.blur(screen.getByRole('spinbutton', { name: 'X position' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent('No project values changed')
  })

  it('rejects out-of-policy numeric edits at the inspector control', () => {
    render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    const x = screen.getByRole('spinbutton', { name: 'X position' })
    fireEvent.change(x, { target: { value: '999999' } })
    fireEvent.blur(x)

    expect(x).toHaveValue(360)
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent('X position must be between')

    const fontSize = screen.getByRole('spinbutton', { name: 'Font size' })
    fireEvent.change(fontSize, { target: { value: '0.5' } })
    fireEvent.blur(fontSize)
    expect(fontSize).toHaveValue(38)
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
  })

  it('authors deep per-object typography through exact inspector controls', () => {
    const { container } = render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))

    const family = screen.getByRole('textbox', { name: 'Font family' })
    fireEvent.change(family, { target: { value: 'Courier New, monospace' } })
    fireEvent.blur(family)
    fireEvent.change(screen.getByRole('combobox', { name: 'Font weight' }), { target: { value: '800' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Text alignment' }), { target: { value: 'center' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Rough emphasis' }))

    const text = container.querySelector<HTMLElement>('[data-object-id="object-title"] .pc-canvas-text')!
    expect(text).toHaveStyle({ fontFamily: 'Courier New, monospace', fontWeight: '800', textAlign: 'center' })
    expect(text).toHaveAttribute('data-rough-emphasis', 'true')
    expect(editor()).toHaveAttribute('data-history-past-count', '4')
  })

  it('exposes keyboard-operable resize and rotate handles', () => {
    render(<ProofCanvasEditor />)
    fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '1.2' } })
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    const rotate = screen.getByRole('button', { name: /Rotate selected object/ })
    const resize = screen.getByRole('button', { name: /Resize selected object/ })
    expect(rotate).toHaveAttribute('tabindex', '0')
    expect(resize).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(rotate, { key: 'ArrowRight' })
    fireEvent.keyDown(resize, { key: 'ArrowRight' })
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
  })

  it('resolves rapid keyboard resize and rotate intents from the latest canonical transform', () => {
    render(<ProofCanvasEditor />)
    fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '1.2' } })
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    const initialWidth = Number((screen.getByRole('spinbutton', { name: 'Width' }) as HTMLInputElement).value)
    const initialRotation = Number((screen.getByRole('spinbutton', { name: 'Rotation' }) as HTMLInputElement).value)
    const resize = screen.getByRole('button', { name: /Resize selected object/ })

    act(() => {
      fireEvent.keyDown(resize, { key: 'ArrowRight' })
      fireEvent.keyDown(resize, { key: 'ArrowRight' })
    })
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(initialWidth + 2)
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(initialWidth + 1)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(initialWidth)

    const rotate = screen.getByRole('button', { name: /Rotate selected object/ })
    act(() => {
      fireEvent.keyDown(rotate, { key: 'ArrowRight' })
      fireEvent.keyDown(rotate, { key: 'ArrowRight' })
    })
    expect(screen.getByRole('spinbutton', { name: 'Rotation' })).toHaveValue(initialRotation + 2)
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByRole('spinbutton', { name: 'Rotation' })).toHaveValue(initialRotation + 1)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByRole('spinbutton', { name: 'Rotation' })).toHaveValue(initialRotation)
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
  })

  it('reserves arrow navigation for focused controls and nudges only from the canvas', () => {
    render(<ProofCanvasEditor />)
    fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '1.2' } })
    const title = screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ })
    fireEvent.click(title)
    const x = screen.getByRole('spinbutton', { name: 'X position' })
    expect(x).toHaveValue(360)

    fireEvent.keyDown(title, { key: 'ArrowDown' })
    expect(screen.getByRole('treeitem', { name: /A quiet paradox/ })).toHaveAttribute('aria-selected', 'true')
    expect(x).toHaveValue(360)
    expect(editor()).toHaveAttribute('data-history-past-count', '0')

    fireEvent.click(title)
    fireEvent.keyDown(screen.getByRole('group', { name: /canvas at 1.2 seconds/ }), { key: 'ArrowRight' })
    expect(screen.getByRole('spinbutton', { name: 'X position' })).toHaveValue(361)
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
  })

  it('resolves two batched ArrowRight commands from the latest canonical geometry', () => {
    const project = cloneSerializable(createCantorDemoProject())
    project.shots[0].animations = []
    const { container } = render(<ProofCanvasEditor initialProject={project} />)
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    const canvas = screen.getByRole('group', { name: /canvas at/ })
    const title = container.querySelector('[data-object-id="object-title"]')!
    const beforeX = Number(title.getAttribute('transform')?.match(/^translate\(([-\d.]+)/)?.[1])

    canvas.focus()
    act(() => {
      fireEvent.keyDown(canvas, { key: 'ArrowRight' })
      fireEvent.keyDown(canvas, { key: 'ArrowRight' })
    })

    expect(Number(container.querySelector('[data-object-id="object-title"]')?.getAttribute('transform')?.match(/^translate\(([-\d.]+)/)?.[1])).toBe(beforeX + 2)
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
  })

  it('executes palette nudges contextually and routes typed shot versus object commands', () => {
    const project = cloneSerializable(createCantorDemoProject())
    project.shots[0].animations = []
    const { container } = render(<ProofCanvasEditor initialProject={project} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    expect(screen.getByRole('option', { name: /Duplicate selection/ })).toBeEnabled()
    expect(screen.getByRole('option', { name: /Group selection/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Close command palette' }))

    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    const beforeX = Number(container.querySelector('[data-object-id="object-title"]')?.getAttribute('transform')?.match(/^translate\(([-\d.]+)/)?.[1])
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search commands' }), { target: { value: 'Nudge right' } })
    fireEvent.click(screen.getByRole('option', { name: /Nudge right/ }))
    expect(Number(container.querySelector('[data-object-id="object-title"]')?.getAttribute('transform')?.match(/^translate\(([-\d.]+)/)?.[1])).toBe(beforeX + 1)
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
  })

  it('navigates enabled command options from the search field and executes the active option', () => {
    render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    const search = screen.getByRole('searchbox', { name: 'Search commands' })
    expect(search).toHaveFocus()
    expect(screen.getByRole('option', { name: /AI structured edit/ })).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /Play or pause/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /Delete selection/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: /Undo/ })).toBeDisabled()
    expect(search).toHaveFocus()

    fireEvent.keyDown(search, { key: 'Home' })
    expect(screen.getByRole('option', { name: /AI structured edit/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(search, { key: 'End' })
    expect(screen.getByRole('option', { name: /Render or export/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Render and export' })).toBeInTheDocument()
  })

  it('uses standard wrapped arrow selection and focus in both style radiogroups', async () => {
    render(<ProofCanvasEditor />)
    const canvasStyles = screen.getByRole('radiogroup', { name: 'Active output style' })
    fireEvent.keyDown(within(canvasStyles).getByRole('radio', { name: 'Editorial Ink' }), { key: 'ArrowLeft' })
    await waitFor(() => expect(within(canvasStyles).getByRole('radio', { name: 'Raw Manim' })).toHaveFocus())
    expect(within(canvasStyles).getByRole('radio', { name: 'Raw Manim' })).toBeChecked()
    fireEvent.keyDown(within(canvasStyles).getByRole('radio', { name: 'Raw Manim' }), { key: 'ArrowRight' })
    await waitFor(() => expect(within(canvasStyles).getByRole('radio', { name: 'Editorial Ink' })).toHaveFocus())
    expect(within(canvasStyles).getByRole('radio', { name: 'Editorial Ink' })).toBeChecked()

    fireEvent.click(screen.getByRole('tab', { name: 'Styles' }))
    const libraryStyles = screen.getByRole('radiogroup', { name: 'Library output styles' })
    fireEvent.keyDown(within(libraryStyles).getByRole('radio', { name: /Editorial Ink/ }), { key: 'ArrowLeft' })
    await waitFor(() => expect(within(libraryStyles).getByRole('radio', { name: /Raw Manim/ })).toHaveFocus())
    expect(within(libraryStyles).getByRole('radio', { name: /Raw Manim/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(within(libraryStyles).getByRole('radio', { name: /Raw Manim/ }), { key: 'ArrowDown' })
    await waitFor(() => expect(within(libraryStyles).getByRole('radio', { name: /Editorial Ink/ })).toHaveFocus())
    expect(within(libraryStyles).getByRole('radio', { name: /Editorial Ink/ })).toHaveAttribute('aria-checked', 'true')
    expect(editor()).toHaveAttribute('data-history-past-count', '4')
  })

  it('moves focus into the assistant drawer and returns it to the stable Commands trigger', () => {
    render(<ProofCanvasEditor />)
    const commands = screen.getByRole('button', { name: 'Open command palette' })
    fireEvent.click(commands)
    fireEvent.click(screen.getByRole('option', { name: /AI structured edit/ }))

    expect(screen.getByRole('textbox', { name: 'Describe the edit' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Close AI command drawer' }))
    expect(commands).toHaveFocus()
  })

  it('restores command-palette focus to the stable trigger when opened over a utility dialog', () => {
    render(<ProofCanvasEditor />)
    const commands = screen.getByRole('button', { name: 'Open command palette' })
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }))
    const settings = screen.getByRole('dialog', { name: 'Project settings' })
    fireEvent.keyDown(settings, { key: 'k', ctrlKey: true })

    expect(screen.queryByRole('dialog', { name: 'Project settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search commands' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Close command palette' }))
    expect(commands).toHaveFocus()
  })

  it('cancels a timeline draft when undo changes its canonical base', () => {
    installTestPointerEvent()
    const { container } = render(<ProofCanvasEditor />)
    const title = screen.getByRole('textbox', { name: 'Project title' })
    fireEvent.change(title, { target: { value: 'Gesture base' } })
    fireEvent.blur(title)
    expect(editor()).toHaveAttribute('data-history-past-count', '1')

    const block = container.querySelector<HTMLElement>('.pc-animation-block[data-locked="false"]')!
    const originalStart = block.dataset.start
    const track = screen.getByTestId('timeline-track')
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 1000 })
    fireEvent.pointerDown(block, { button: 0, pointerId: 4, clientX: 100 })
    fireEvent.pointerMove(track, { pointerId: 4, clientX: 220 })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.pointerUp(track, { pointerId: 4, clientX: 220 })

    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(container.querySelector<HTMLElement>(`[data-animation-id="${block.dataset.animationId}"]`)).toHaveAttribute('data-start', originalStart)
  })

  it('commits the latest timeline draft when pointer move and pointer up share one render batch', () => {
    installTestPointerEvent()
    const { container } = render(<ProofCanvasEditor />)
    const block = container.querySelector<HTMLElement>('[data-animation-id="animation-title-write"]')!
    const track = screen.getByTestId('timeline-track')
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 1_000 })

    act(() => {
      fireEvent.pointerDown(block, { button: 0, pointerId: 5, clientX: 100 })
      fireEvent.pointerMove(track, { pointerId: 5, clientX: 220 })
      fireEvent.pointerUp(track, { pointerId: 5, clientX: 220 })
    })

    expect(container.querySelector('[data-animation-id="animation-title-write"]')).toHaveAttribute('data-start', '2.5')
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
  })

  it('admits only a primary left-button timeline pointer and commits only its captured identity', () => {
    installTestPointerEvent()
    const { container } = render(<ProofCanvasEditor />)
    const block = container.querySelector<HTMLElement>('[data-animation-id="animation-title-write"]')!
    const track = screen.getByTestId('timeline-track')
    const originalStart = block.dataset.start
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 1_000 })

    fireEvent.pointerDown(block, { button: 2, pointerId: 3, clientX: 100, isPrimary: true })
    fireEvent.pointerMove(track, { pointerId: 3, clientX: 220, isPrimary: true })
    fireEvent.pointerUp(track, { pointerId: 3, clientX: 220, isPrimary: true })
    fireEvent.pointerDown(block, { button: 0, pointerId: 4, clientX: 100, isPrimary: false })
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(block).toHaveAttribute('data-start', originalStart)

    fireEvent.pointerDown(block, { button: 0, pointerId: 5, clientX: 100, isPrimary: true })
    fireEvent.pointerMove(track, { pointerId: 6, clientX: 220, isPrimary: false })
    fireEvent.pointerUp(track, { pointerId: 6, clientX: 220, isPrimary: false })
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(block).toHaveAttribute('data-start', originalStart)

    fireEvent.pointerMove(track, { pointerId: 5, clientX: 220, isPrimary: true })
    fireEvent.pointerUp(track, { pointerId: 6, clientX: 220, isPrimary: false })
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    fireEvent.pointerUp(track, { pointerId: 5, clientX: 220, isPrimary: true })
    expect(container.querySelector('[data-animation-id="animation-title-write"]')).toHaveAttribute('data-start', '2.5')
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
  })

  it('keeps editor command shortcuts active after toolbar buttons receive focus', () => {
    render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    const duplicate = screen.getByRole('button', { name: 'Duplicate selection' })
    fireEvent.click(duplicate)
    expect(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length copy/ })).toBeInTheDocument()

    fireEvent.keyDown(duplicate, { key: 'Delete' })
    expect(screen.queryByRole('treeitem', { name: /Uncountable, Yet Zero Length copy/ })).not.toBeInTheDocument()
    fireEvent.keyDown(duplicate, { key: 'z', ctrlKey: true })
    expect(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length copy/ })).toBeInTheDocument()
  })

  it('uses roving focus and arrow navigation across shot tabs', async () => {
    render(<ProofCanvasEditor />)
    const construction = screen.getByRole('tab', { name: /Shot 1, The construction/ })
    const paradox = screen.getByRole('tab', { name: /Shot 2, The paradox/ })
    expect(construction).toHaveAttribute('tabindex', '0')
    expect(paradox).toHaveAttribute('tabindex', '-1')

    construction.focus()
    fireEvent.keyDown(construction, { key: 'ArrowRight' })
    await waitFor(() => expect(paradox).toHaveFocus())
    expect(paradox).toHaveAttribute('aria-selected', 'true')
    expect(editor()).toHaveAttribute('data-active-shot-id', 'shot-cantor-conclusion')
  })

  it('inserts ordinary objects and semantic components as editable layers', () => {
    const { container } = render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
    expect(screen.getByRole('treeitem', { name: /Plain text/ })).toBeInTheDocument()
    const content = screen.getByRole('textbox', { name: 'Content' })
    fireEvent.change(content, { target: { value: 'Edited mathematical narration' } })
    fireEvent.blur(content)
    expect(container.querySelector('[data-object-id="object-text"] .pc-canvas-text')).toHaveTextContent('Edited mathematical narration')

    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert Callout' }))
    expect(screen.getAllByRole('treeitem', { name: /^Callout;/ }).find((item) => item.getAttribute('aria-level') === '1')).toBeInTheDocument()
    expect(editor()).toHaveAttribute('data-history-past-count', '3')
    expect(screen.getByRole('tab', { name: 'Media' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add raster image' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add SVG' })).not.toBeInTheDocument()
  })

  it('derives a selected group frame from authored visible descendants independently of output style', () => {
    const { container } = render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert Title & subtitle' }))
    fireEvent.click(screen.getByRole('treeitem', { name: /^Title & subtitle;/ }))

    const moveTarget = () => container.querySelector<SVGRectElement>('[data-group-move-target="group-mathematical-title"]')!
    expect(Number(moveTarget().getAttribute('width'))).toBe(460)
    fireEvent.click(screen.getByRole('radio', { name: 'Raw Manim' }))
    expect(Number(moveTarget().getAttribute('width'))).toBe(460)
  })

  it('labels inherited visibility and omits the dead group-opacity control', () => {
    render(<ProofCanvasEditor />)
    const selectedGroup = screen.getByRole('treeitem', { name: /Cantor interval diagram/ })
    fireEvent.click(selectedGroup)
    expect(screen.queryByRole('spinbutton', { name: 'Opacity' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visible' }))

    const child = screen.getByRole('treeitem', { name: /Original interval/ })
    expect(child).toHaveAttribute('data-visibility', 'inherited-hidden')
    fireEvent.click(child)
    expect(screen.getByRole('checkbox', { name: /Visible locally; hidden by Cantor interval diagram/ })).toBeChecked()
  })

  it('wires every visible object and semantic-component insertion control', () => {
    const { container } = render(<ProofCanvasEditor />)
    const tabs = [
      ['Text', [['Add text', 'text']]],
      ['Math', [['Add math', 'math'], ['Add brace', 'brace']]],
      ['Graphs', [['Add coordinate axes', 'axes'], ['Add function graph', 'graph']]],
    ] as const
    for (const [tab, objectControls] of tabs) {
      fireEvent.click(screen.getByRole('tab', { name: tab }))
      for (const [label, type] of objectControls) {
        fireEvent.click(screen.getByRole('button', { name: label }))
        expect(container.querySelector(`[data-object-type="${type}"]`)).toBeInTheDocument()
      }
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Shapes' }))
    for (const label of [
      'Rectangle', 'Rounded rectangle', 'Circle', 'Dot / point', 'Line', 'Arrow',
      'Brace', 'Bracket', 'Highlight box', 'Underline', 'Cross-out',
    ]) fireEvent.click(screen.getByRole('button', { name: `Insert ${label}` }))
    for (const name of [
      'Rectangle', 'Rounded rectangle', 'Circle', 'Dot / point', 'Line', 'Arrow',
      'Brace', 'Bracket', 'Highlight box', 'Underline', 'Cross-out',
    ]) expect(screen.getByRole('treeitem', { name: new RegExp(`^${name.replace('/', '\\/')};`) })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Media' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add raster image' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add SVG' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))
    for (const label of [
      'Insert Title & subtitle', 'Insert Definition', 'Insert Theorem / proposition',
      'Insert Proof-step sequence', 'Insert Equation derivation', 'Insert Annotated graph',
      'Insert Case comparison', 'Insert Callout', 'Insert Marginal note',
      'Insert Recursive construction', 'Insert Vector explanation', 'Insert Example & abstraction',
    ]) fireEvent.click(screen.getByRole('button', { name: label }))

    for (const id of [
      'mathematical-title', 'definition-block', 'proposition-statement', 'proof-step-sequence',
      'equation-chain', 'annotated-diagram', 'case-comparison', 'focus-callout', 'marginal-note',
      'recursive-intervals', 'vector-explanation', 'example-abstraction',
    ]) {
      expect(container.querySelector(`[data-layer-object-id="group-${id}"]`)).toBeInTheDocument()
    }
  })

  it('renders camera-focus in the scene and edits move/camera parameters on blur', () => {
    const { container } = render(<ProofCanvasEditor />)
    const camera = container.querySelector('[data-pc-camera-transform]')!
    const initialTransform = camera.getAttribute('transform')
    fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '13.6' } })
    expect(camera.getAttribute('transform')).not.toBe(initialTransform)

    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Animation type' }), { target: { value: 'move' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add animation' }))
    const targetX = screen.getByRole('spinbutton', { name: 'Target X' })
    fireEvent.change(targetX, { target: { value: '410' } })
    fireEvent.blur(targetX)
    expect(screen.getByRole('spinbutton', { name: 'Target X' })).toHaveValue(410)

    fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '16' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Animation type' }), { target: { value: 'camera-focus' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add animation' }))
    const cameraX = screen.getByRole('spinbutton', { name: 'Camera X' })
    fireEvent.change(cameraX, { target: { value: '510' } })
    fireEvent.blur(cameraX)
    expect(screen.getByRole('spinbutton', { name: 'Camera X' })).toHaveValue(510)
  })

  it('uses relative deltas for multi-target move animations', () => {
    render(<ProofCanvasEditor />)
    fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    fireEvent.click(screen.getByRole('treeitem', { name: /A quiet paradox/ }), { shiftKey: true })
    fireEvent.change(screen.getByRole('combobox', { name: 'Animation type' }), { target: { value: 'move' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add animation' }))

    expect(screen.getByRole('spinbutton', { name: 'Horizontal move' })).toHaveValue(80)
    expect(screen.getByRole('spinbutton', { name: 'Vertical move' })).toHaveValue(0)
    expect(screen.queryByRole('spinbutton', { name: 'Target X' })).not.toBeInTheDocument()
  })

  it('rejects ambiguous multi-target absolute transforms', () => {
    const { container } = render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    fireEvent.click(screen.getByRole('treeitem', { name: /A quiet paradox/ }), { shiftKey: true })
    fireEvent.change(screen.getByRole('combobox', { name: 'Animation type' }), { target: { value: 'transform' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add animation' }))

    expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent('Transform uses one absolute target')
    expect(container.querySelectorAll('[data-animation-type="transform"]')).toHaveLength(0)
  })

  it('blocks keyboard nudges while the playhead shows an animated spatial pose', () => {
    render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Animation type' }), { target: { value: 'move' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add animation' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '8' } })
    fireEvent.keyDown(screen.getByRole('group', { name: /canvas at 8.0 seconds/ }), { key: 'ArrowRight' })

    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    expect(screen.getByRole('option', { name: /Nudge right/ })).toBeDisabled()
  })

  it('deletes a focused timeline block without deleting the scene selection and disables locked blocks', () => {
    const { container } = render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    const titleAnimation = container.querySelector<HTMLElement>('[data-animation-id="animation-title-write"]')!
    fireEvent.click(titleAnimation)
    fireEvent.keyDown(titleAnimation, { key: 'Delete' })

    expect(container.querySelector('[data-animation-id="animation-title-write"]')).not.toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ })).toBeInTheDocument()

    const lockedAnimation = container.querySelector<HTMLElement>('[data-animation-id="animation-equation-write"]')!
    expect(lockedAnimation).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(lockedAnimation)
    expect(screen.getByRole('spinbutton', { name: 'Start time' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete animation' })).toBeDisabled()
  })

  it('offers a real easing repair for a legacy V2 animation on a locked target', () => {
    const legacy = cloneSerializable(createCantorDemoProject())
    legacy.shots[0].animations.find(({ id }) => id === 'animation-limit-emphasis')!.easing = 'editorial'
    const { container } = render(<ProofCanvasEditor initialProject={legacy} />)
    const animation = container.querySelector<HTMLElement>('[data-animation-id="animation-limit-emphasis"]')!
    expect(animation).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(animation)

    const easing = screen.getByRole('combobox', { name: 'Easing' })
    expect(easing).toBeEnabled()
    expect(easing).toHaveValue('editorial')
    expect(screen.getByText(/saved legacy easing: choose there-and-back to repair rendering/i)).toBeInTheDocument()
    fireEvent.change(easing, { target: { value: 'there-and-back' } })

    expect(easing).toHaveValue('there-and-back')
    expect(screen.getByText(/fixed there-and-back pulse/i)).toBeInTheDocument()
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('spinbutton', { name: 'Start time' })).toBeDisabled()
  })

  it('keeps an unlocked legacy animation read-only except for its exact easing repair', () => {
    const legacy = cloneSerializable(createCantorDemoProject())
    legacy.shots[0].objects.find(({ id }) => id === 'object-equation-chain')!.locked = false
    legacy.shots[0].objects.find(({ id }) => id === 'object-equation-limit')!.locked = false
    legacy.shots[0].animations.find(({ id }) => id === 'animation-limit-emphasis')!.easing = 'editorial'
    const { container } = render(<ProofCanvasEditor initialProject={legacy} />)
    fireEvent.click(container.querySelector<HTMLElement>('[data-animation-id="animation-limit-emphasis"]')!)

    expect(screen.getByRole('spinbutton', { name: 'Start time' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Duration' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Scale amount' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete animation' })).toBeDisabled()
    const easing = screen.getByRole('combobox', { name: 'Easing' })
    expect(easing).toBeEnabled()
    fireEvent.change(easing, { target: { value: 'there-and-back' } })
    expect(screen.getByRole('spinbutton', { name: 'Start time' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Delete animation' })).toBeEnabled()
  })

  it('saves, resets, and reloads canonical project JSON locally', () => {
    render(<ProofCanvasEditor />)
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    const name = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(name, { target: { value: 'A renamed theorem' } })
    fireEvent.blur(name)
    expect(screen.getByRole('treeitem', { name: /A renamed theorem/ })).toBeInTheDocument()

    openOwnerMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }))
    expect(window.localStorage.getItem('proofcanvas_project_v1')).toContain('A renamed theorem')
    openOwnerMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Reset sample project' }))
    expect(screen.queryByRole('treeitem', { name: /A renamed theorem/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByRole('treeitem', { name: /A renamed theorem/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(screen.queryByRole('treeitem', { name: /A renamed theorem/ })).not.toBeInTheDocument()
    openOwnerMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Load saved project' }))
    expect(screen.getByRole('treeitem', { name: /A renamed theorem/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByRole('treeitem', { name: /A renamed theorem/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(screen.getByRole('treeitem', { name: /A renamed theorem/ })).toBeInTheDocument()
  })

  it('reports import validation and the unconfigured renderer honestly', async () => {
    render(<ProofCanvasEditor />)
    const file = new File(['{"schemaVersion":99}'], 'invalid.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: jest.fn().mockResolvedValue('{"schemaVersion":99}') })
    const input = screen.getByLabelText('Import project JSON')
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/schema version|unsupported|invalid|expected/i))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    openRenderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Render MP4' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('ProofCanvas rendering is not configured'))
  })

  it('rejects oversized project imports before reading their contents', async () => {
    render(<ProofCanvasEditor />)
    const file = new File(['{}'], 'oversized.json', { type: 'application/json' })
    const text = jest.fn().mockResolvedValue('{}')
    Object.defineProperty(file, 'size', { configurable: true, value: PROOFCANVAS_PROJECT_MAX_BYTES + 1 })
    Object.defineProperty(file, 'text', { configurable: true, value: text })

    fireEvent.change(screen.getByLabelText('Import project JSON'), { target: { files: [file] } })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('2 MiB import limit'))
    expect(text).not.toHaveBeenCalled()
  })

  it('preserves an edit made while a slow project import is being read', async () => {
    render(<ProofCanvasEditor />)
    const pending = deferred<string>()
    const imported = cloneSerializable(createCantorDemoProject())
    imported.shots[0].objects[0].name = 'Stale imported title'
    const file = new File(['pending'], 'slow.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { configurable: true, value: jest.fn(() => pending.promise) })

    fireEvent.change(screen.getByLabelText('Import project JSON'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
    const name = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(name, { target: { value: 'Edit while importing' } })
    fireEvent.blur(name)

    await act(async () => { pending.resolve(canonicalProjectJson(imported)); await pending.promise })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('project changed while the import was being read'))
    expect(screen.getByRole('treeitem', { name: /Edit while importing/ })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: /Stale imported title/ })).not.toBeInTheDocument()
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
  })

  it('allows only the latest of two out-of-order project imports to commit', async () => {
    render(<ProofCanvasEditor />)
    const firstPending = deferred<string>()
    const secondPending = deferred<string>()
    const firstProject = cloneSerializable(createCantorDemoProject())
    const secondProject = cloneSerializable(createCantorDemoProject())
    firstProject.shots[0].objects[0].name = 'First import result'
    secondProject.shots[0].objects[0].name = 'Second import result'
    const firstFile = new File(['first'], 'first.json', { type: 'application/json' })
    const secondFile = new File(['second'], 'second.json', { type: 'application/json' })
    Object.defineProperty(firstFile, 'text', { configurable: true, value: jest.fn(() => firstPending.promise) })
    Object.defineProperty(secondFile, 'text', { configurable: true, value: jest.fn(() => secondPending.promise) })
    const input = screen.getByLabelText('Import project JSON')

    fireEvent.change(input, { target: { files: [firstFile] } })
    fireEvent.change(input, { target: { files: [secondFile] } })
    await act(async () => { secondPending.resolve(canonicalProjectJson(secondProject)); await secondPending.promise })
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /Second import result/ })).toBeInTheDocument())

    await act(async () => { firstPending.resolve(canonicalProjectJson(firstProject)); await firstPending.promise })
    expect(screen.getByRole('treeitem', { name: /Second import result/ })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: /First import result/ })).not.toBeInTheDocument()
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
  })

  it('invalidates composition critique when its project or proposal context changes', async () => {
    render(<ProofCanvasEditor />)
    openAssistant()
    fireEvent.click(screen.getByRole('button', { name: 'Critique composition' }))
    expect(screen.getByText(/Current revision/)).toBeInTheDocument()
    runAiPreset()
    await screen.findByRole('region', { name: 'Proposed changes' })
    expect(screen.queryByText(/Current revision/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Critique composition' }))
    expect(screen.getByText(/Current revision/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard proposed changes' }))
    expect(screen.queryByText(/Current revision/)).not.toBeInTheDocument()
  })

  it('shows exact compiler diagnostics alongside the Python preview', () => {
    const project = cloneSerializable(createCantorDemoProject())
    project.shots[0].objects.push({
      id: 'object-image',
      type: 'image',
      name: 'Image asset',
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 150, height: 70, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { source: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
    })
    render(<ProofCanvasEditor initialProject={project} />)
    openRenderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Export Manim Python' }))
    const dialog = screen.getByRole('dialog', { name: /Manim Python/ })
    expect(dialog.querySelector(':scope > header')).toHaveAttribute('role', 'group')
    const diagnostics = within(dialog).getByRole('region', { name: 'Compiler diagnostics' })
    expect(diagnostics).toHaveTextContent('ASSET_RENDER_TRANSPORT_UNSUPPORTED')
    expect(diagnostics).toHaveTextContent(/object object-image/)
  })

  it('keeps Python with unsupported visual transport inspectable without downloading it', async () => {
    const rejected = cloneSerializable(createCantorDemoProject())
    rejected.metadata.id = 'project-rejected-export'
    rejected.metadata.title = 'Rejected export fixture'
    rejected.shots[1].animations = []
    rejected.shots[1].objects.push({
      id: 'object-rejected-image',
      type: 'image',
      name: 'Rejected image',
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { source: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
    })
    render(<ProofCanvasEditor />)
    const file = new File([canonicalProjectJson(rejected)], 'rejected.proofcanvas.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { configurable: true, value: jest.fn().mockResolvedValue(canonicalProjectJson(rejected)) })
    fireEvent.change(screen.getByLabelText('Import project JSON'), { target: { files: [file] } })
    await waitFor(() => expect(editor()).toHaveAttribute('data-project-id', rejected.metadata.id))
    openRenderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Export Manim Python' }))
    expect(screen.getByRole('dialog', { name: /Manim Python/ })).toHaveTextContent('from manim import')
    expect(screen.getByRole('region', { name: 'Compiler diagnostics' })).toHaveTextContent('ASSET_RENDER_TRANSPORT_UNSUPPORTED')
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(anchorClick).not.toHaveBeenCalled()
  })

  it('downloads readable visual Manim source while labelling external audio muxing', async () => {
    const audible = cloneSerializable(createCantorDemoProject())
    audible.assets.push({ id: 'asset-python-audio', filename: 'narration.wav', mimeType: 'audio/wav', size: 32, sha256: 'c'.repeat(64), duration: 1, provenance: 'uploaded' })
    audible.shots[0].audioClips = [{ id: 'audio-python-export', assetId: 'asset-python-audio', name: 'Narration', start: 0, duration: 1, sourceStart: 0, sourceEnd: 1, volume: 1, muted: false, solo: false }]
    render(<ProofCanvasEditor initialProject={ProjectDocumentSchema.parse(audible)} />)
    openRenderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Export Manim Python' }))
    expect(screen.getByRole('region', { name: 'Compiler diagnostics' })).toHaveTextContent('AUDIO_EXTERNAL_MUX_NOT_EMBEDDED')
    expect(screen.getByRole('dialog', { name: /Manim Python/ })).toHaveTextContent('Audio is muxed separately by ProofCanvas')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(anchorClick).toHaveBeenCalledTimes(1)
  })

  it('exposes a genuine completed render as an inspectable video and download', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(202, {
      ok: true,
      job: {
        id: 'AbCdEfGhIjKlMnOpQrStUvWx',
        status: 'succeeded',
        quality: 'preview',
        sourceSha256: 'a'.repeat(64),
        error: null,
        video: { sha256: 'b'.repeat(64), bytes: 1024 },
      },
    }))
    render(<ProofCanvasEditor />)

    openRenderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Render MP4' }))
    const renderStatus = await screen.findByRole('region', { name: 'Render status' })
    expect(renderStatus).toHaveAttribute('data-render-status', 'succeeded')
    expect(renderStatus).toHaveAttribute('data-render-current', 'true')
    expect(screen.getByLabelText('Rendered Manim preview')).toHaveAttribute('src', '/api/proofcanvas/render/AbCdEfGhIjKlMnOpQrStUvWx/video')
    expect(screen.getByRole('link', { name: 'Download MP4' })).toHaveAttribute('download', 'proofcanvas-render.mp4')
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
    expect(renderStatus).toHaveAttribute('data-render-current', 'false')
    expect(within(renderStatus).getByText(/earlier project revision/)).toBeInTheDocument()
  })

  it('recovers render polling after a transient transport failure', async () => {
    const id = 'AbCdEfGhIjKlMnOpQrStUvWx'
    const sourceSha256 = 'a'.repeat(64)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(202, { ok: true, job: { id, status: 'pending', quality: 'preview', sourceSha256, error: null, video: null } }))
      .mockRejectedValueOnce(new Error('Temporary status outage'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, job: { id, status: 'running', quality: 'preview', sourceSha256, error: null, video: null } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, job: { id, status: 'succeeded', quality: 'preview', sourceSha256, error: null, video: { sha256: 'b'.repeat(64), bytes: 1024 } } }))
    render(<ProofCanvasEditor />)

    openRenderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Render MP4' }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Render status' })).toHaveAttribute('data-render-status', 'succeeded'), { timeout: 6000 })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(screen.getByLabelText('Rendered Manim preview')).toBeInTheDocument()
  }, 8000)

  it('cancels an active render with CSRF protection and keeps a retryable receipt', async () => {
    const id = 'AbCdEfGhIjKlMnOpQrStUvWx'
    const sourceSha256 = 'a'.repeat(64)
    const csrfToken = 'c'.repeat(43)
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/session') return jsonResponse(200, { ok: true, csrfToken })
      if (url === `/api/proofcanvas/render/${id}` && init?.method === 'DELETE') {
        return jsonResponse(200, { ok: true, job: { id, status: 'cancelled', quality: 'preview', sourceSha256, error: { code: 'render-cancelled', message: 'Render cancelled.' }, video: null } })
      }
      if (url === '/api/proofcanvas/render' && init?.method === 'POST') {
        return jsonResponse(202, { ok: true, job: { id, status: 'pending', quality: 'preview', sourceSha256, error: null, video: null } })
      }
      return jsonResponse(503, { ok: false, code: 'unexpected_request', message: 'Unexpected test request.' })
    })
    render(<ProofCanvasEditor />)

    openRenderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Render MP4' }))
    const renderStatus = await screen.findByRole('region', { name: 'Render status' })
    expect(renderStatus).toHaveAttribute('data-render-status', 'pending')
    expect(within(renderStatus).getByRole('progressbar', { name: 'Manim render progress' })).toHaveAttribute('aria-valuetext', 'Waiting in the bounded render queue')
    fireEvent.click(within(renderStatus).getByRole('button', { name: 'Cancel render' }))

    await waitFor(() => expect(renderStatus).toHaveAttribute('data-render-status', 'cancelled'))
    expect(within(renderStatus).getByText(/cancelled before publication/)).toBeInTheDocument()
    expect(within(renderStatus).getByRole('button', { name: 'Retry preview render' })).toBeEnabled()
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/proofcanvas/render/${id}`, expect.objectContaining({
      method: 'DELETE',
      headers: { 'X-ProofCanvas-CSRF': csrfToken },
    }))
  })

  it('retries a failed render with the same quality', async () => {
    const firstId = 'AbCdEfGhIjKlMnOpQrStUvWx'
    const secondId = 'ZyXwVuTsRqPoNmLkJiHgFeDc'
    const sourceSha256 = 'a'.repeat(64)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(202, { ok: true, job: { id: firstId, status: 'failed', quality: 'production', sourceSha256, error: { code: 'render-failed', message: 'Manim failed safely.' }, video: null } }))
      .mockResolvedValueOnce(jsonResponse(202, { ok: true, job: { id: secondId, status: 'succeeded', quality: 'production', sourceSha256, error: null, video: { sha256: 'b'.repeat(64), bytes: 1024 } } }))
    render(<ProofCanvasEditor />)

    openRenderDialog()
    fireEvent.change(screen.getByLabelText('Render quality'), { target: { value: 'production' } })
    fireEvent.click(screen.getByRole('button', { name: 'Render MP4' }))
    const renderStatus = await screen.findByRole('region', { name: 'Render status' })
    expect(renderStatus).toHaveAttribute('data-render-status', 'failed')
    fireEvent.click(within(renderStatus).getByRole('button', { name: 'Retry production render' }))

    await waitFor(() => expect(screen.getByRole('region', { name: 'Render status' })).toHaveAttribute('data-render-job-id', secondId))
    expect(screen.getByRole('region', { name: 'Render status' })).toHaveAttribute('data-render-status', 'succeeded')
    const submitBodies = fetchMock.mock.calls.map(([, init]) => init && JSON.parse(String((init as RequestInit).body)))
    expect(submitBodies).toEqual([
      expect.objectContaining({ quality: 'production' }),
      expect.objectContaining({ quality: 'production' }),
    ])
  })

  it('downloads a hash-bound PNG still at the current sequence playhead', async () => {
    const id = 'AbCdEfGhIjKlMnOpQrStUvWx'
    const sourceSha256 = 'a'.repeat(64)
    const stillSha256 = 'd'.repeat(64)
    const stillBlob = new Blob([new Uint8Array(64)], { type: 'image/png' })
    fetchMock
      .mockResolvedValueOnce(jsonResponse(202, {
        ok: true,
        job: {
          id,
          status: 'succeeded',
          quality: 'preview',
          sourceSha256,
          error: null,
          output: { width: 1280, height: 720, fps: 30, expectedDurationSeconds: 53.33333333 },
          video: { sha256: 'b'.repeat(64), bytes: 1024, width: 1280, height: 720, fps: 30, durationSeconds: 53.33333333, videoCodec: 'h264', audioCodec: 'aac', videoStreams: 1, audioStreams: 1, decodedFrames: 1600, decodedAudioSamples: 2560000 },
        },
      }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'Content-Type': 'image/png',
          'Content-Length': String(stillBlob.size),
          'X-ProofCanvas-Source-SHA256': sourceSha256,
          'X-ProofCanvas-Still-SHA256': stillSha256,
          'X-ProofCanvas-Still-Time': '6.8',
        }),
        blob: jest.fn().mockResolvedValue(stillBlob),
      })
    render(<ProofCanvasEditor />)

    openRenderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Render MP4' }))
    const renderStatus = await screen.findByRole('region', { name: 'Render status' })
    expect(within(renderStatus).getByText('1280×720 · 30 fps')).toBeInTheDocument()
    expect(within(renderStatus).getByText('H264 video · AAC audio')).toBeInTheDocument()
    fireEvent.click(within(renderStatus).getByRole('button', { name: 'Download still at playhead' }))

    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/proofcanvas/render/${id}/still?time=6.8`, { cache: 'no-store' })
    expect(createObjectURL).toHaveBeenCalledWith(stillBlob)
    expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent('Still PNG exported at 6.800 seconds')
  })
})
