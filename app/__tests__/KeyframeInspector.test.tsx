import { fireEvent, render, screen } from '@testing-library/react'
import KeyframeInspector from '../KeyframeInspector'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import type { TimelineOperationIntent } from '@/lib/proofcanvas/editorTimeline'
import { keyframeSelection } from '@/lib/proofcanvas/editorSelection'
import { applyOperations } from '@/lib/proofcanvas/operations'
import { ProjectDocumentSchema, cloneSerializable } from '@/lib/proofcanvas/schema'

function fixture() {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  project.shots = [shot]
  shot.duration = 4
  shot.animations = []
  shot.objects = [shot.objects.find(({ id }) => id === 'object-title')!]
  shot.objects[0].locked = false
  delete shot.objects[0].parentId
  shot.objects[0].lifetime = { start: 0, end: 4 }
  shot.propertyTracks = [{
    id: 'track-title-x', target: { kind: 'object', objectId: shot.objects[0].id }, property: 'x', keyframes: [
      { id: 'keyframe-title-x-a', time: 1, value: 100, interpolation: { kind: 'linear' } },
      { id: 'keyframe-title-x-b', time: 3, value: 300, interpolation: { kind: 'linear' } },
    ],
  }]
  return ProjectDocumentSchema.parse(project)
}

test('edits exact time/value and navigates adjacent keys through canonical intents', () => {
  const project = fixture()
  const shot = project.shots[0]
  const first = { trackId: shot.propertyTracks[0].id, keyframeId: shot.propertyTracks[0].keyframes[0].id }
  const selection = keyframeSelection(shot, [first], first)
  if (selection.kind !== 'keyframes') throw new Error('fixture selection missing')
  const intents: TimelineOperationIntent[] = []
  const onSelect = jest.fn()
  const onSeek = jest.fn()
  render(<KeyframeInspector project={project} shot={shot} selection={selection} onCommit={(intent) => { intents.push(intent); return intent.ok }} onSelect={onSelect} onSeek={onSeek} onNotice={jest.fn()}/>)
  fireEvent.blur(screen.getByRole('spinbutton', { name: 'Keyframe time' }), { target: { value: '1.5' } })
  expect(intents.at(-1)).toMatchObject({ ok: true, operations: [{ type: 'move-keyframe', time: 1.5 }] })
  fireEvent.blur(screen.getByRole('spinbutton', { name: 'Keyframe value' }), { target: { value: '125' } })
  expect(intents.at(-1)).toMatchObject({ ok: true, operations: [{ type: 'update-keyframe', patch: { value: 125 } }] })
  fireEvent.click(screen.getByRole('button', { name: 'Select next keyframe' }))
  expect(onSelect).toHaveBeenCalledWith({ trackId: first.trackId, keyframeId: 'keyframe-title-x-b' })
  expect(onSeek).toHaveBeenCalledWith(3)
})

test('applies multi-selection outgoing easing atomically and edits inline custom cubic points', () => {
  let project = fixture()
  let shot = project.shots[0]
  const refs = shot.propertyTracks[0].keyframes.map((keyframe) => ({ trackId: shot.propertyTracks[0].id, keyframeId: keyframe.id }))
  let selection = keyframeSelection(shot, refs, refs[0])
  if (selection.kind !== 'keyframes') throw new Error('fixture selection missing')
  let last: TimelineOperationIntent | undefined
  const onCommit = (intent: TimelineOperationIntent) => {
    last = intent
    if (intent.ok) project = applyOperations(project, shot.id, intent.operations).project
    return intent.ok
  }
  const view = render(<KeyframeInspector project={project} shot={shot} selection={selection} onCommit={onCommit} onSelect={jest.fn()} onSeek={jest.fn()} onNotice={jest.fn()}/>)
  fireEvent.change(screen.getByRole('combobox', { name: 'Outgoing interpolation' }), { target: { value: 'spring-soft' } })
  expect(last).toMatchObject({ ok: true, operations: [{ type: 'update-keyframe', keyframeId: refs[0].keyframeId, patch: { interpolation: { kind: 'eased', easing: 'spring-soft' } } }] })

  shot = project.shots[0]
  selection = keyframeSelection(shot, refs, refs[0])
  if (selection.kind !== 'keyframes') throw new Error('fixture selection missing')
  view.rerender(<KeyframeInspector project={project} shot={shot} selection={selection} onCommit={onCommit} onSelect={jest.fn()} onSeek={jest.fn()} onNotice={jest.fn()}/>)
  fireEvent.change(screen.getByRole('combobox', { name: 'Outgoing interpolation' }), { target: { value: 'custom-bezier' } })
  expect(last).toMatchObject({ ok: true, operations: [{ patch: { interpolation: { kind: 'custom-bezier' } } }] })

  shot = project.shots[0]
  selection = keyframeSelection(shot, refs, refs[0])
  if (selection.kind !== 'keyframes') throw new Error('fixture selection missing')
  view.rerender(<KeyframeInspector project={project} shot={shot} selection={selection} onCommit={onCommit} onSelect={jest.fn()} onSeek={jest.fn()} onNotice={jest.fn()}/>)
  expect(screen.getByText(/Interpolation controls the outgoing segment/)).toBeInTheDocument()
  fireEvent.blur(screen.getByRole('spinbutton', { name: 'X1' }), { target: { value: '0.4' } })
  expect(last).toMatchObject({ ok: true, operations: [{ patch: { interpolation: { kind: 'custom-bezier', curve: { x1: 0.4 } } } }] })
})

test('restores rejected, colliding, out-of-range, and non-canonical editor values immediately', () => {
  const project = fixture()
  const shot = project.shots[0]
  const first = { trackId: shot.propertyTracks[0].id, keyframeId: shot.propertyTracks[0].keyframes[0].id }
  const selection = keyframeSelection(shot, [first], first)
  if (selection.kind !== 'keyframes') throw new Error('fixture selection missing')
  const onNotice = jest.fn()
  render(<KeyframeInspector project={project} shot={shot} selection={selection} onCommit={(intent) => intent.ok} onSelect={jest.fn()} onSeek={jest.fn()} onNotice={onNotice}/>)

  const time = screen.getByRole('spinbutton', { name: 'Keyframe time' })
  fireEvent.blur(time, { target: { value: '3' } })
  expect(screen.getByRole('spinbutton', { name: 'Keyframe time' })).toHaveValue(1)
  fireEvent.blur(screen.getByRole('spinbutton', { name: 'Keyframe time' }), { target: { value: '99' } })
  expect(screen.getByRole('spinbutton', { name: 'Keyframe time' })).toHaveValue(1)
  fireEvent.blur(screen.getByRole('spinbutton', { name: 'Keyframe time' }), { target: { value: '1e100' } })
  expect(screen.getByRole('spinbutton', { name: 'Keyframe time' })).toHaveValue(1)
  expect(onNotice).toHaveBeenCalledWith('Keyframe time must be within the authored timeline range.')

  const value = screen.getByRole('spinbutton', { name: 'Keyframe value' })
  fireEvent.blur(value, { target: { value: '1000000000' } })
  expect(screen.getByRole('spinbutton', { name: 'Keyframe value' })).toHaveValue(100)
})

test('restores rejected custom cubic controls and disables terminal-only outgoing easing truthfully', () => {
  const draft = cloneSerializable(fixture())
  draft.shots[0].propertyTracks[0].keyframes[0].interpolation = { kind: 'custom-bezier', curve: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } }
  draft.shots[0].propertyTracks[0].keyframes[1].interpolation = { kind: 'custom-bezier', curve: { x1: 0.4, y1: 0, x2: 0.6, y2: 1 } }
  const project = ProjectDocumentSchema.parse(draft)
  const shot = project.shots[0]
  const track = shot.propertyTracks[0]
  const first = { trackId: track.id, keyframeId: track.keyframes[0].id }
  const firstSelection = keyframeSelection(shot, [first], first)
  if (firstSelection.kind !== 'keyframes') throw new Error('fixture selection missing')
  const view = render(<KeyframeInspector project={project} shot={shot} selection={firstSelection} onCommit={jest.fn(() => false)} onSelect={jest.fn()} onSeek={jest.fn()} onNotice={jest.fn()}/>)
  const x1 = screen.getByRole('spinbutton', { name: 'X1' })
  fireEvent.blur(x1, { target: { value: '2' } })
  expect(screen.getByRole('spinbutton', { name: 'X1' })).toHaveValue(0.25)

  const terminal = { trackId: track.id, keyframeId: track.keyframes[1].id }
  const terminalSelection = keyframeSelection(shot, [terminal], terminal)
  if (terminalSelection.kind !== 'keyframes') throw new Error('fixture selection missing')
  view.rerender(<KeyframeInspector project={project} shot={shot} selection={terminalSelection} onCommit={jest.fn(() => true)} onSelect={jest.fn()} onSeek={jest.fn()} onNotice={jest.fn()}/>)
  expect(screen.getByRole('combobox', { name: 'Outgoing interpolation' })).toBeDisabled()
  expect(screen.getByText(/terminal keyframe has no outgoing segment/i)).toBeInTheDocument()
  expect(screen.getByRole('spinbutton', { name: 'X1' })).toBeDisabled()
})
