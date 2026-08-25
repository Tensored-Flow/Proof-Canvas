import { fireEvent, render, screen, within } from '@testing-library/react'
import ShotTimeline from '../ShotTimeline'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import type { TimelineOperationIntent } from '@/lib/proofcanvas/editorTimeline'
import { keyframeSelection, shotSelection, type EditorSelection } from '@/lib/proofcanvas/editorSelection'
import { ProjectDocumentSchema, cloneSerializable } from '@/lib/proofcanvas/schema'

function fixture() {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  project.shots = [shot]
  shot.duration = 8
  shot.animations = []
  shot.objects = [shot.objects.find(({ id }) => id === 'object-title')!]
  shot.objects[0].locked = false
  delete shot.objects[0].parentId
  shot.objects[0].lifetime = { start: 0.5, end: 4 }
  shot.propertyTracks = [
    { id: 'track-camera-x', target: { kind: 'camera' }, property: 'x', keyframes: [
      { id: 'keyframe-camera-x-a', time: 0, value: 480, interpolation: { kind: 'linear' } },
      { id: 'keyframe-camera-x-b', time: 4, value: 520, interpolation: { kind: 'linear' } },
    ] },
    { id: 'track-title-x', target: { kind: 'object', objectId: shot.objects[0].id }, property: 'x', keyframes: [
      { id: 'keyframe-title-x-a', time: 1, value: 100, interpolation: { kind: 'linear' } },
      { id: 'keyframe-title-x-b', time: 3, value: 300, interpolation: { kind: 'linear' } },
    ] },
  ]
  return ProjectDocumentSchema.parse(project)
}

function renderTimeline(selection: EditorSelection = shotSelection([fixture().shots[0].id]), disabled = false) {
  const project = fixture()
  const onCommit = jest.fn((_intent: TimelineOperationIntent) => true)
  const onSelect = jest.fn()
  const onSeek = jest.fn()
  const onNotice = jest.fn()
  const view = render(<ShotTimeline project={project} shot={project.shots[0]} projectRevision="revision-a" playhead={2} selection={selection} disabled={disabled} onSeek={onSeek} onSelect={onSelect} onCommit={onCommit} onNotice={onNotice}/>)
  return { project, onCommit, onSelect, onSeek, onNotice, ...view }
}

test('renders camera first, exact object lifetime bars, property rows, zoom, snap, and boundaries', () => {
  const { container } = renderTimeline()
  const grid = container.querySelector('.pc-shot-timeline-grid')!
  expect(grid.querySelector('.pc-shot-timeline-group-title')).toHaveTextContent('Camera')
  expect([...grid.querySelectorAll('[data-track-id]')].map((node) => node.getAttribute('data-track-id'))).toEqual(['track-camera-x', 'track-title-x'])
  expect(container.querySelector('[data-lifetime-mode="custom"] .pc-lifetime-bar')).toHaveAccessibleName(/lifetime 0.5 to 4 seconds/)
  expect(container.querySelector('.pc-timeline-boundary-start')).toBeInTheDocument()
  expect(container.querySelector('.pc-timeline-boundary-end')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Snap on' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByRole('button', { name: 'Snap on' }))
  expect(screen.getByRole('button', { name: 'Snap off' })).toHaveAttribute('aria-pressed', 'false')
  fireEvent.change(screen.getByRole('combobox', { name: 'Timeline zoom' }), { target: { value: '160' } })
  expect(container.querySelector('.pc-shot-timeline-grid')).toHaveStyle('--pc-shot-timeline-width: 1280px')
})

test('click-seeks keys, shift-multiselects, and selects lifetime objects through one selection callback', () => {
  const { project, onSelect, onSeek } = renderTimeline()
  const first = screen.getByRole('button', { name: 'x keyframe at 1 seconds' })
  fireEvent.click(first)
  expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'keyframes', keyframes: [{ trackId: 'track-title-x', keyframeId: 'keyframe-title-x-a' }] }))
  expect(onSeek).toHaveBeenCalledWith(1)

  const firstRef = { trackId: 'track-title-x', keyframeId: 'keyframe-title-x-a' }
  const selected = keyframeSelection(project.shots[0], [firstRef], firstRef)
  const view = render(<ShotTimeline project={project} shot={project.shots[0]} projectRevision="revision-b" playhead={2} selection={selected} onSeek={onSeek} onSelect={onSelect} onCommit={jest.fn(() => true)} onNotice={jest.fn()}/>)
  fireEvent.click(within(view.container).getByRole('button', { name: 'x keyframe at 3 seconds' }), { shiftKey: true })
  expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'keyframes', keyframes: expect.arrayContaining([firstRef, { trackId: 'track-title-x', keyframeId: 'keyframe-title-x-b' }]) }))
  fireEvent.click(within(view.container).getByRole('button', { name: /lifetime 0.5 to 4 seconds/ }))
  expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'objects', primaryObjectId: project.shots[0].objects[0].id }))
})

test('moves, deletes, duplicates, copies, and pastes selected keys with keyboard-accessible actions', () => {
  const project = fixture()
  const ref = { trackId: 'track-title-x', keyframeId: 'keyframe-title-x-a' }
  const selection = keyframeSelection(project.shots[0], [ref], ref)
  const { onCommit } = renderTimeline(selection)
  fireEvent.keyDown(screen.getByRole('button', { name: 'x keyframe at 1 seconds' }), { key: 'ArrowRight' })
  expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, operations: expect.arrayContaining([expect.objectContaining({ type: 'move-keyframe' })]) }))
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate selected keyframes' }))
  expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, operations: expect.arrayContaining([expect.objectContaining({ type: 'duplicate-keyframe' })]) }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected keyframes' }))
  expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, operations: expect.arrayContaining([expect.objectContaining({ type: 'delete-keyframe' })]) }))
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
  expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, operations: expect.arrayContaining([expect.objectContaining({ type: 'add-keyframe', keyframe: expect.objectContaining({ time: 2 }) })]) }))
})

test('keeps every mutation control disabled during sequence playback while selection remains readable', () => {
  const project = fixture()
  const ref = { trackId: 'track-title-x', keyframeId: 'keyframe-title-x-a' }
  renderTimeline(keyframeSelection(project.shots[0], [ref], ref), true)
  expect(screen.getByRole('button', { name: 'x keyframe at 1 seconds' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Move selected keyframes one frame later' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Delete selected keyframes' })).toBeDisabled()
})
