import { fireEvent, render, screen } from '@testing-library/react'
import PropertyKeyframeField from '../PropertyKeyframeField'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { objectSelection } from '@/lib/proofcanvas/editorSelection'
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
    id: 'track-title-x',
    target: { kind: 'object', objectId: shot.objects[0].id },
    property: 'x',
    keyframes: [
      { id: 'keyframe-title-x-a', time: 1, value: 100, interpolation: { kind: 'linear' } },
      { id: 'keyframe-title-x-b', time: 3, value: 300, interpolation: { kind: 'linear' } },
    ],
  }]
  return ProjectDocumentSchema.parse(project)
}

test('uses base-pose mutation only while no property track exists', () => {
  const project = fixture()
  const shot = project.shots[0]
  const onBaseChange = jest.fn(() => true)
  const onCommit = jest.fn(() => true)
  render(<PropertyKeyframeField project={project} shotId={shot.id} target={{ kind: 'object', objectId: shot.objects[0].id }} property="y" label="Y position" value={200} playhead={2} selection={objectSelection(shot, [shot.objects[0].id])} onCommit={onCommit} onBaseChange={onBaseChange} onSelectKeyframe={jest.fn()} onNotice={jest.fn()}/>)
  fireEvent.blur(screen.getByRole('spinbutton', { name: 'Y position' }), { target: { value: '240' } })
  expect(onBaseChange).toHaveBeenCalledWith(240)
  expect(onCommit).not.toHaveBeenCalled()
})

test('upserts a tracked field at a non-key playhead and exposes empty/hollow/filled diamonds', () => {
  const project = fixture()
  const shot = project.shots[0]
  const track = shot.propertyTracks[0]
  let applied = project
  const onCommit = jest.fn((intent) => {
    if (!intent.ok) return false
    applied = applyOperations(applied, shot.id, intent.operations).project
    return true
  })
  const view = render(<PropertyKeyframeField project={project} shotId={shot.id} target={track.target} property="x" label="X position" value={200} playhead={2} track={track} selection={objectSelection(shot, [shot.objects[0].id])} onCommit={onCommit} onBaseChange={jest.fn()} onSelectKeyframe={jest.fn()} onNotice={jest.fn()}/>)
  expect(screen.getByRole('button', { name: 'Add X position keyframe at 2 seconds' })).toHaveAttribute('data-key-state', 'empty')
  fireEvent.blur(screen.getByRole('spinbutton', { name: 'X position' }), { target: { value: '220' } })
  expect(applied.shots[0].propertyTracks[0].keyframes.map(({ time, value }) => [time, value])).toEqual([[1, 100], [2, 220], [3, 300]])

  const authored = applied.shots[0].propertyTracks[0]
  const exact = { trackId: authored.id, keyframeId: authored.keyframes[1].id }
  view.rerender(<PropertyKeyframeField project={applied} shotId={shot.id} target={authored.target} property="x" label="X position" value={220} playhead={2} track={authored} selection={objectSelection(applied.shots[0], [shot.objects[0].id])} onCommit={onCommit} onBaseChange={jest.fn()} onSelectKeyframe={jest.fn()} onNotice={jest.fn()}/>)
  expect(screen.getByRole('button', { name: 'Select X position keyframe at 2 seconds' })).toHaveAttribute('data-key-state', 'hollow')
  view.rerender(<PropertyKeyframeField project={applied} shotId={shot.id} target={authored.target} property="x" label="X position" value={220} playhead={2} track={authored} selection={{ kind: 'keyframes', shotId: shot.id, keyframes: [exact], primaryKeyframe: exact }} onCommit={onCommit} onBaseChange={jest.fn()} onSelectKeyframe={jest.fn()} onNotice={jest.fn()}/>)
  expect(screen.getByRole('button', { name: 'Selected X position keyframe at 2 seconds' })).toHaveAttribute('data-key-state', 'filled')
})

test('restores a rejected numeric edit when the latest commit authority refuses it', () => {
  const project = fixture()
  const shot = project.shots[0]
  const onBaseChange = jest.fn(() => false)
  render(<PropertyKeyframeField project={project} shotId={shot.id} target={{ kind: 'object', objectId: shot.objects[0].id }} property="y" label="Y position" value={200} playhead={2} selection={objectSelection(shot, [shot.objects[0].id])} onCommit={jest.fn(() => false)} onBaseChange={onBaseChange} onSelectKeyframe={jest.fn()} onNotice={jest.fn()}/>)
  const input = screen.getByRole('spinbutton', { name: 'Y position' })
  fireEvent.blur(input, { target: { value: '240' } })
  expect(onBaseChange).toHaveBeenCalledWith(240)
  expect(screen.getByRole('spinbutton', { name: 'Y position' })).toHaveValue(200)
})

test('commits a tracked color once on blur and restores it when the commit is rejected', () => {
  const draft = cloneSerializable(fixture())
  draft.shots[0].propertyTracks.push({
    id: 'track-title-fill',
    target: { kind: 'object', objectId: draft.shots[0].objects[0].id },
    property: 'fill',
    keyframes: [
      { id: 'keyframe-title-fill-a', time: 1, value: '#112233', interpolation: { kind: 'linear' } },
      { id: 'keyframe-title-fill-b', time: 3, value: '#445566', interpolation: { kind: 'linear' } },
    ],
  })
  const project = ProjectDocumentSchema.parse(draft)
  const shot = project.shots[0]
  const track = shot.propertyTracks.find(({ id }) => id === 'track-title-fill')!
  const onCommit = jest.fn(() => true)
  const view = render(<PropertyKeyframeField project={project} shotId={shot.id} target={track.target} property="fill" label="Fill" inputType="color" value="#223344" playhead={2} track={track} selection={objectSelection(shot, [shot.objects[0].id])} onCommit={onCommit} onBaseChange={jest.fn()} onSelectKeyframe={jest.fn()} onNotice={jest.fn()}/>)
  const input = screen.getByLabelText('Fill') as HTMLInputElement
  fireEvent.change(input, { target: { value: '#abcdef' } })
  expect(onCommit).not.toHaveBeenCalled()
  fireEvent.blur(input)
  expect(onCommit).toHaveBeenCalledTimes(1)

  const reject = jest.fn(() => false)
  view.rerender(<PropertyKeyframeField project={project} shotId={shot.id} target={track.target} property="fill" label="Fill" inputType="color" value="#223344" playhead={2} track={track} selection={objectSelection(shot, [shot.objects[0].id])} onCommit={reject} onBaseChange={jest.fn()} onSelectKeyframe={jest.fn()} onNotice={jest.fn()}/>)
  const rejected = screen.getByLabelText('Fill') as HTMLInputElement
  fireEvent.change(rejected, { target: { value: '#fedcba' } })
  fireEvent.blur(rejected)
  expect(reject).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('Fill')).toHaveValue('#223344')
})
