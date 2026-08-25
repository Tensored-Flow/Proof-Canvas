import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import ProofCanvasEditor from '../ProofCanvasEditor'
import { shotThumbnailVisualRevision } from '../ShotStoryboard'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { ProjectDocumentSchema, cloneSerializable, type ProjectDocument } from '@/lib/proofcanvas/schema'

const mockStoryboardRender = jest.fn()

jest.mock('../ShotStoryboard', () => {
  const actual = jest.requireActual('../ShotStoryboard') as typeof import('../ShotStoryboard')
  const ActualStoryboard = actual.default
  return {
    __esModule: true,
    ...actual,
    default: (props: ComponentProps<typeof ActualStoryboard>) => {
      mockStoryboardRender()
      return <ActualStoryboard {...props}/>
    },
  }
})

afterEach(cleanup)

beforeEach(() => {
  mockStoryboardRender.mockClear()
})

function editor() {
  return screen.getByRole('application', { name: 'ProofCanvas editor' })
}

function emptySequence(durations: readonly number[]): ProjectDocument {
  const project = cloneSerializable(createCantorDemoProject())
  const camera = project.shots[0].camera
  project.shots = durations.map((duration, index) => ({
    id: `shot-sequence-${index + 1}`,
    name: `Sequence ${index + 1}`,
    duration,
    objects: [],
    animations: [],
    propertyTracks: [],
    audioClips: [],
    captionClips: [],
    markers: [],
    camera: { ...camera },
  }))
  return ProjectDocumentSchema.parse(project)
}

function shotTabs() {
  return screen.getAllByRole('tab', { name: /^Shot \d+,/ })
}

describe('ProofCanvas storyboard integration', () => {
  it('keeps a truthful full-width storyboard independent of side and detail collapse', async () => {
    const { container } = render(<ProofCanvasEditor/>)
    const storyboard = screen.getByRole('region', { name: 'Storyboard' })
    const tablist = within(storyboard).getByRole('tablist', { name: 'Shots' })
    expect(tablist).toHaveAttribute('aria-orientation', 'horizontal')
    expect(storyboard.closest('.pc-bottom-workspace')).not.toBeNull()
    expect(storyboard.closest('.pc-left')).toBeNull()
    expect(shotTabs()).toHaveLength(2)
    expect(shotTabs()[0]).toHaveAccessibleName(/duration 21s, starts at 0s/)
    expect(shotTabs()[1]).toHaveAccessibleName(/duration 7s, starts at 21s/)

    const thumbnails = [...container.querySelectorAll<SVGSVGElement>('.pc-shot-thumbnail')]
    expect(thumbnails).toHaveLength(2)
    expect(thumbnails.every((thumbnail) => thumbnail.dataset.thumbnailTime === '0')).toBe(true)
    expect(thumbnails.every((thumbnail) => thumbnail.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(thumbnails.flatMap((thumbnail) => [...thumbnail.querySelectorAll('[data-object-id]')])).toHaveLength(0)
    const markerIds = thumbnails.map((thumbnail) => thumbnail.querySelector('marker')?.id)
    expect(new Set(markerIds).size).toBe(markerIds.length)

    const [firstTab, secondTab] = shotTabs()
    firstTab.focus()
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' })
    await waitFor(() => expect(secondTab).toHaveFocus())
    expect(secondTab).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(secondTab, { key: 'Home' })
    await waitFor(() => expect(firstTab).toHaveFocus())
    fireEvent.keyDown(firstTab, { key: 'End' })
    await waitFor(() => expect(secondTab).toHaveFocus())
    fireEvent.keyDown(secondTab, { key: 'F10', shiftKey: true })
    expect(screen.getByRole('button', { name: 'Duplicate' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Hide library panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse shot timeline' }))
    expect(editor()).toHaveAttribute('data-left-collapsed', 'true')
    expect(editor()).toHaveAttribute('data-timeline-collapsed', 'true')
    expect(screen.getByRole('region', { name: 'Storyboard' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'Shots' })).toBeInTheDocument()
  })

  it('uses the focused storyboard card for keyboard duplicate and delete even when object context is preserved', async () => {
    render(<ProofCanvasEditor/>)
    const activeCard = shotTabs().find((tab) => tab.getAttribute('aria-selected') === 'true')!
    fireEvent.click(screen.getAllByRole('treeitem')[0])
    expect(editor()).toHaveAttribute('data-selection-kind', 'objects')

    activeCard.focus()
    fireEvent.keyDown(activeCard, { key: 'Delete' })
    const deleteDialog = screen.getByRole('dialog', { name: 'Delete shot' })
    expect(deleteDialog).toHaveTextContent('Delete “The construction” (21.00 seconds)?')
    expect(deleteDialog).toHaveTextContent('29 objects, 16 semantic animations, 0 keyframes, 0 audio clips, 0 captions, and 0 markers')
    expect(deleteDialog).toHaveTextContent('The next shot at this position becomes active.')
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(activeCard).toHaveFocus())

    fireEvent.keyDown(activeCard, { key: 'd', ctrlKey: true })
    expect(shotTabs()).toHaveLength(3)
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(editor().dataset.activeShotId).not.toBe(activeCard.dataset.shotId)
    expect(editor()).toHaveAttribute('data-selection-kind', 'objects')

    const finalCard = shotTabs().at(-1)!
    fireEvent.click(finalCard)
    finalCard.focus()
    fireEvent.keyDown(finalCard, { key: 'Delete' })
    expect(screen.getByRole('dialog', { name: 'Delete shot' })).toHaveTextContent('The previous shot becomes active.')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete shot' })).getByRole('button', { name: 'Cancel' }))
  })

  it('refreshes card navigation against the latest ordered shot sequence', async () => {
    render(<ProofCanvasEditor initialProject={emptySequence([1, 1])}/>)
    fireEvent.click(shotTabs()[1])
    fireEvent.click(screen.getByRole('button', { name: 'Add shot' }))
    const newestShotId = editor().dataset.activeShotId!
    expect(shotTabs()).toHaveLength(3)

    const first = shotTabs()[0]
    first.focus()
    fireEvent.keyDown(first, { key: 'End' })
    await waitFor(() => expect(shotTabs().find(({ dataset }) => dataset.shotId === newestShotId)).toHaveFocus())
    expect(editor()).toHaveAttribute('data-active-shot-id', newestShotId)
  })

  it('keeps thumbnail memo keys content-based and invalidates them for style and aspect changes', () => {
    const project = createCantorDemoProject()
    const shot = project.shots[0]
    const style = project.styles.find(({ id }) => id === project.activeStyleId)!
    const revision = shotThumbnailVisualRevision(shot, style, project.settings.aspectRatio)
    expect(shotThumbnailVisualRevision(cloneSerializable(shot), cloneSerializable(style), project.settings.aspectRatio)).toBe(revision)
    expect(shotThumbnailVisualRevision(shot, { ...style, colors: { ...style.colors, background: '#ffffff' } }, project.settings.aspectRatio)).not.toBe(revision)
    expect(shotThumbnailVisualRevision(shot, style, '9:16')).not.toBe(revision)
  })

  it('publishes add, rename, duplicate, delete, undo, and redo through one workspace authority', async () => {
    render(<ProofCanvasEditor/>)
    const initialActive = editor().dataset.activeShotId
    const initialGlobal = (screen.getByRole('slider', { name: 'Sequence time' }) as HTMLInputElement).valueAsNumber

    fireEvent.click(screen.getByRole('button', { name: 'Add shot' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(shotTabs()).toHaveLength(3)
    const addedId = editor().dataset.activeShotId!
    expect(addedId).not.toBe(initialActive)
    await waitFor(() => expect(shotTabs().find(({ dataset }) => dataset.shotId === addedId)).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(shotTabs()).toHaveLength(2)
    expect(editor()).toHaveAttribute('data-active-shot-id', initialActive)
    expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue(String(initialGlobal))

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(editor()).toHaveAttribute('data-active-shot-id', addedId)
    expect(shotTabs().some(({ dataset }) => dataset.shotId === addedId)).toBe(true)
    expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('21')

    const addedTab = shotTabs().find(({ dataset }) => dataset.shotId === addedId)!
    addedTab.focus()
    fireEvent.keyDown(addedTab, { key: 'F2' })
    const focusTrapDialog = screen.getByRole('dialog', { name: 'Rename shot' })
    const closeRename = within(focusTrapDialog).getByRole('button', { name: 'Close shot dialog' })
    const submitRename = within(focusTrapDialog).getByRole('button', { name: 'Rename shot' })
    closeRename.focus()
    fireEvent.keyDown(closeRename, { key: 'Tab', shiftKey: true })
    expect(submitRename).toHaveFocus()
    fireEvent.keyDown(submitRename, { key: 'Tab' })
    expect(closeRename).toHaveFocus()
    fireEvent.keyDown(focusTrapDialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Rename shot' })).not.toBeInTheDocument()
    await waitFor(() => expect(addedTab).toHaveFocus())

    fireEvent.keyDown(addedTab, { key: 'F2' })
    const rename = screen.getByRole('dialog', { name: 'Rename shot' })
    const name = within(rename).getByRole('textbox', { name: 'Shot name' })
    expect(name).toHaveFocus()
    expect(name).toHaveAttribute('maxlength', '120')
    fireEvent.change(name, { target: { value: 'Bridge lemma' } })
    fireEvent.click(within(rename).getByRole('button', { name: 'Rename shot' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
    await waitFor(() => expect(screen.getByRole('tab', { name: /Bridge lemma/ })).toHaveFocus())
    expect(screen.getByRole('textbox', { name: 'Shot name' })).toHaveAttribute('maxlength', '120')

    const renamed = screen.getByRole('tab', { name: /Bridge lemma/ })
    fireEvent.keyDown(renamed, { key: 'd', ctrlKey: true })
    expect(editor()).toHaveAttribute('data-history-past-count', '3')
    expect(shotTabs()).toHaveLength(4)
    const duplicateId = editor().dataset.activeShotId!
    await waitFor(() => expect(shotTabs().find(({ dataset }) => dataset.shotId === duplicateId)).toHaveFocus())

    const duplicate = shotTabs().find(({ dataset }) => dataset.shotId === duplicateId)!
    fireEvent.keyDown(duplicate, { key: 'Delete' })
    const confirmation = screen.getByRole('dialog', { name: 'Delete shot' })
    expect(editor()).toHaveAttribute('data-history-past-count', '3')
    expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }))
    expect(duplicate).toHaveFocus()

    fireEvent.keyDown(duplicate, { key: 'Delete' })
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete shot' })).getByRole('button', { name: 'Delete shot' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '4')
    expect(shotTabs()).toHaveLength(3)
    expect(screen.queryByRole('tab', { name: /Bridge lemma copy/ })).not.toBeInTheDocument()
    const survivorId = editor().dataset.activeShotId!
    await waitFor(() => expect(shotTabs().find(({ dataset }) => dataset.shotId === survivorId)).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(shotTabs()).toHaveLength(4)
    expect(editor()).toHaveAttribute('data-active-shot-id', duplicateId)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(shotTabs()).toHaveLength(3)
    expect(editor()).toHaveAttribute('data-active-shot-id', survivorId)
  })

  it('keeps split, merge, duration failures, and one-shot edges atomic and accessible', async () => {
    render(<ProofCanvasEditor initialProject={emptySequence([2])}/>)
    const deleteButton = screen.getByRole('button', { name: 'Delete' })
    expect(deleteButton).toBeDisabled()
    expect(deleteButton).toHaveAccessibleDescription('A project must keep at least one shot.')

    fireEvent.click(screen.getByRole('button', { name: 'Split at playhead' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent('at least one 30fps frame')

    fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Split at playhead' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(shotTabs()).toHaveLength(2)
    expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('1')
    await waitFor(() => expect(shotTabs().find(({ dataset }) => dataset.shotId === editor().dataset.activeShotId)).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Merge previous' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
    expect(shotTabs()).toHaveLength(1)
    expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('1')

    fireEvent.click(screen.getByRole('button', { name: 'Duration' }))
    const durationDialog = screen.getByRole('dialog', { name: 'Set shot duration' })
    const duration = within(durationDialog).getByRole('spinbutton', { name: 'Shot duration' })
    fireEvent.change(duration, { target: { value: '0' } })
    fireEvent.click(within(durationDialog).getByRole('button', { name: 'Set duration' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
    expect(durationDialog).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent('at least one 30fps frame')

    fireEvent.change(duration, { target: { value: '4' } })
    fireEvent.click(within(durationDialog).getByRole('button', { name: 'Set duration' }))
    expect(screen.queryByRole('dialog', { name: 'Set shot duration' })).not.toBeInTheDocument()
    expect(editor()).toHaveAttribute('data-history-past-count', '3')
    expect(screen.getByRole('status', { name: 'Sequence time display' })).toHaveTextContent('/ 4.00s')
  })

  it('applies Earlier, Later, and Merge next as one structural history step each', async () => {
    render(<ProofCanvasEditor initialProject={emptySequence([1, 2, 3])}/>)
    fireEvent.click(shotTabs()[1])

    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }))
    expect(shotTabs().map(({ dataset }) => dataset.shotId)).toEqual(['shot-sequence-2', 'shot-sequence-1', 'shot-sequence-3'])
    expect(editor()).toHaveAttribute('data-history-past-count', '1')

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(shotTabs().map(({ dataset }) => dataset.shotId)).toEqual(['shot-sequence-1', 'shot-sequence-2', 'shot-sequence-3'])
    expect(editor()).toHaveAttribute('data-history-past-count', '2')

    fireEvent.click(screen.getByRole('button', { name: 'Merge next' }))
    expect(shotTabs()).toHaveLength(2)
    expect(shotTabs()[1]).toHaveAccessibleName(/duration 5s/)
    expect(editor()).toHaveAttribute('data-history-past-count', '3')
    await waitFor(() => expect(shotTabs()[1]).toHaveFocus())
  })

  it('exposes the 24-shot ceiling as a disabled reason without publishing history', () => {
    render(<ProofCanvasEditor initialProject={emptySequence(Array.from({ length: 24 }, () => 1))}/>)
    const reason = 'A project can contain at most 24 shots.'
    expect(screen.getByRole('button', { name: 'Add shot' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add shot' })).toHaveAccessibleDescription(reason)
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Duplicate' })).toHaveAccessibleDescription(reason)
    expect(screen.getByRole('button', { name: 'Split at playhead' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Split at playhead' })).toHaveAccessibleDescription(reason)
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
  })

  it('blocks canvas nudge commands at both command and mutation boundaries during playback', () => {
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 91)
    const cancelFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    try {
      const { container } = render(<ProofCanvasEditor/>)
      fireEvent.click(screen.getAllByRole('treeitem')[0])
      const before = container.querySelector('[data-object-id]')?.getAttribute('transform')
      fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
      const canvas = screen.getByRole('group', { name: /playback preview, editing disabled/ })
      canvas.focus()
      fireEvent.keyDown(canvas, { key: 'ArrowRight' })

      expect(editor()).toHaveAttribute('data-history-past-count', '0')
      expect(screen.getByRole('button', { name: 'Pause sequence' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Pause sequence' }))
      expect(container.querySelector('[data-object-id]')).toHaveAttribute('transform', before)
      expect(editor()).toHaveAttribute('data-history-past-count', '0')
    } finally {
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
    }
  })

  it('keeps the live rAF generation intact when the active storyboard card is reselected', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameId += 1
      frames.set(frameId, callback)
      return frameId
    })
    const cancelFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
    const now = jest.spyOn(performance, 'now').mockReturnValue(1_000)
    const runNext = (time: number) => {
      const entry = [...frames.entries()][0]
      expect(entry).toBeDefined()
      frames.delete(entry[0])
      act(() => entry[1](time))
    }

    try {
      render(<ProofCanvasEditor initialProject={createCantorDemoProject()}/>)
      fireEvent.click(screen.getAllByRole('treeitem')[0])
      const activeCard = shotTabs().find((tab) => tab.getAttribute('aria-selected') === 'true')!
      fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
      runNext(1_500)
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('0.5')
      expect(screen.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '0.5')
      expect(frames).toHaveProperty('size', 1)

      activeCard.focus()
      fireEvent.click(activeCard)
      expect(activeCard).toHaveFocus()
      expect(editor()).toHaveAttribute('data-selection-kind', 'objects')
      expect(screen.getByRole('button', { name: 'Pause sequence' })).toBeInTheDocument()
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('0.5')
      expect(frames).toHaveProperty('size', 1)

      runNext(2_000)
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('1')
      expect(screen.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '1')
      expect(editor()).toHaveAttribute('data-selection-kind', 'objects')
      expect(activeCard).toHaveFocus()
      expect(frames).toHaveProperty('size', 1)
    } finally {
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      now.mockRestore()
    }
  })

  it('crosses project boundaries on one external clock, stops at the final endpoint, and rejects stale frames', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameId += 1
      frames.set(frameId, callback)
      return frameId
    })
    const cancelFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
    const now = jest.spyOn(performance, 'now').mockReturnValue(1_000)
    const runNext = (time: number) => {
      const entry = [...frames.entries()][0]
      expect(entry).toBeDefined()
      frames.delete(entry[0])
      act(() => entry[1](time))
    }

    try {
      render(<ProofCanvasEditor initialProject={emptySequence([2, 3, 4])}/>)
      fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '1.5' } })
      const play = screen.getByRole('button', { name: 'Play sequence' })
      play.focus()
      fireEvent.click(play)
      mockStoryboardRender.mockClear()

      runNext(1_250)
      expect(mockStoryboardRender).not.toHaveBeenCalled()
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('1.75')
      expect(screen.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '1.75')

      runNext(1_500)
      expect(editor()).toHaveAttribute('data-active-shot-id', 'shot-sequence-2')
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('2')
      expect(screen.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '0')
      expect(screen.getByRole('status', { name: 'Shot playhead time' })).toHaveTextContent('0.00s')
      expect(screen.getByRole('button', { name: 'Pause sequence' })).toHaveFocus()
      expect(mockStoryboardRender).toHaveBeenCalledTimes(1)

      runNext(5_500)
      expect(editor()).toHaveAttribute('data-active-shot-id', 'shot-sequence-3')
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('6')
      expect(screen.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '1')

      runNext(12_000)
      expect(screen.getByRole('button', { name: 'Play sequence' })).toBeInTheDocument()
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toBeEnabled()
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('9')
      expect(screen.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '4')

      fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
      expect(editor()).toHaveAttribute('data-active-shot-id', 'shot-sequence-1')
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('0')
      const stale = [...frames.values()][0]
      expect(stale).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'Jump to sequence end' }))
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('9')
      act(() => stale!(20_000))
      expect(screen.getByRole('slider', { name: 'Sequence time' })).toHaveValue('9')
      expect(editor()).toHaveAttribute('data-active-shot-id', 'shot-sequence-3')
      expect(frames.size).toBe(0)
    } finally {
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      now.mockRestore()
    }
  })
})
