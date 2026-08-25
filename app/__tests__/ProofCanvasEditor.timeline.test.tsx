import { fireEvent, render, screen } from '@testing-library/react'
import ProofCanvasEditor from '../ProofCanvasEditor'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { ProjectDocumentSchema, cloneSerializable } from '@/lib/proofcanvas/schema'

function timelineProject() {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  const object = shot.objects.find(({ id }) => id === 'object-title')!
  project.shots = [shot]
  shot.duration = 4
  shot.objects = [object]
  object.locked = false
  delete object.parentId
  delete object.lifetime
  shot.animations = []
  shot.audioClips = []
  shot.captionClips = []
  shot.markers = []
  shot.propertyTracks = [{
    id: 'track-title-x', target: { kind: 'object', objectId: object.id }, property: 'x', keyframes: [
      { id: 'keyframe-title-x-a', time: 1, value: 100, interpolation: { kind: 'linear' } },
      { id: 'keyframe-title-x-b', time: 3, value: 300, interpolation: { kind: 'linear' } },
    ],
  }]
  return ProjectDocumentSchema.parse(project)
}

function editor() {
  return screen.getByRole('application', { name: 'ProofCanvas editor' })
}

function selectObject() {
  fireEvent.click(screen.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ }))
}

function canvasObject() {
  return screen.getByRole('region', { name: 'Scene canvas' }).querySelector('[data-object-id="object-title"]')!
}

function semanticMoveProject() {
  const project = cloneSerializable(timelineProject())
  const shot = project.shots[0]
  const object = shot.objects[0]
  object.transform.x = 100
  object.transform.y = 200
  shot.propertyTracks = []
  shot.animations = [{ id: 'animation-title-move', type: 'move', targetIds: [object.id], start: 0, duration: 2, easing: 'linear', properties: { x: 300, y: 200 } }]
  return ProjectDocumentSchema.parse(project)
}

function semanticCameraProject() {
  const project = cloneSerializable(timelineProject())
  const shot = project.shots[0]
  shot.propertyTracks = []
  shot.camera = { x: 0, y: 0, zoom: 1, rotation: 0 }
  shot.animations = [{ id: 'animation-camera-focus', type: 'camera-focus', targetIds: [shot.objects[0].id], start: 0, duration: 2, easing: 'linear', properties: { x: 400, y: 0, zoom: 1, rotation: 0 } }]
  return ProjectDocumentSchema.parse(project)
}

test('routes tracked field edits to a playhead key, untracked edits to base pose, and preserves undo/redo preview truth', () => {
  render(<ProofCanvasEditor initialProject={timelineProject()}/>)
  selectObject()
  expect(screen.getByRole('spinbutton', { name: 'X position' }).closest('.pc-keyframe-field')).toHaveAttribute('data-track-state', 'tracked')
  expect(screen.getByRole('spinbutton', { name: 'Y position' }).closest('.pc-keyframe-field')).toHaveAttribute('data-track-state', 'base')

  fireEvent.blur(screen.getByRole('spinbutton', { name: 'X position' }), { target: { value: '321' } })
  expect(editor()).toHaveAttribute('data-selection-kind', 'keyframes')
  expect(editor()).toHaveAttribute('data-history-past-count', '1')
  expect(screen.getByRole('button', { name: 'x keyframe at 0 seconds' })).toHaveAttribute('data-key-state', 'filled')
  expect(canvasObject()).toHaveAttribute('transform', expect.stringContaining('translate(321 '))

  selectObject()
  fireEvent.blur(screen.getByRole('spinbutton', { name: 'Y position' }), { target: { value: '234' } })
  expect(editor()).toHaveAttribute('data-selection-kind', 'objects')
  expect(editor()).toHaveAttribute('data-history-past-count', '2')
  expect(canvasObject()).toHaveAttribute('transform', expect.stringContaining(' 234)'))

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(editor()).toHaveAttribute('data-history-past-count', '1')
  expect(canvasObject()).not.toHaveAttribute('transform', expect.stringContaining(' 234)'))
  fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
  expect(editor()).toHaveAttribute('data-history-past-count', '2')
  expect(canvasObject()).toHaveAttribute('transform', expect.stringContaining(' 234)'))
})

test('edits and clears exact lifetimes atomically, rejects dependent keys, and disables mutation during playback', () => {
  const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 91)
  const cancelFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  try {
    render(<ProofCanvasEditor initialProject={timelineProject()}/>)
    selectObject()
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('spinbutton', { name: 'Object lifetime start' })).toHaveValue(0)
    expect(screen.getByRole('spinbutton', { name: 'Object lifetime end' })).toHaveValue(4)

    fireEvent.blur(screen.getByRole('spinbutton', { name: 'Object lifetime start' }), { target: { value: '2' } })
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
    expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent(/Keyframe|lifetime/i)
    expect(screen.getByRole('spinbutton', { name: 'Object lifetime start' })).toHaveValue(0)

    fireEvent.blur(screen.getByRole('spinbutton', { name: 'Object lifetime end' }), { target: { value: '3.5' } })
    expect(editor()).toHaveAttribute('data-history-past-count', '2')
    expect(screen.getByRole('button', { name: /lifetime 0 to 3.5 seconds/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Entire shot' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '3')
    expect(screen.getByText(/Entire shot follows the shot duration/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'X position' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add X position keyframe at 0 seconds' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Pause sequence' }))
  } finally {
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  }
})

test('authors a camera key from shot context and immediately previews the canonical camera track', () => {
  render(<ProofCanvasEditor initialProject={timelineProject()}/>)
  const canvas = screen.getByRole('group', { name: /canvas at 0.0 seconds/ })
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1 })
  expect(editor()).toHaveAttribute('data-selection-kind', 'none')
  fireEvent.blur(screen.getByRole('spinbutton', { name: 'Camera X' }), { target: { value: '500' } })
  expect(editor()).toHaveAttribute('data-selection-kind', 'none')
  expect(editor()).toHaveAttribute('data-history-past-count', '1')
  fireEvent.click(screen.getByRole('button', { name: 'Add Camera X keyframe at 0 seconds' }))
  expect(editor()).toHaveAttribute('data-selection-kind', 'keyframes')
  expect(editor()).toHaveAttribute('data-history-past-count', '2')
  expect(document.querySelector('[data-track-target="camera"]')).toBeInTheDocument()
  expect(document.querySelector('[data-pc-camera-transform]')).toHaveAttribute('transform', expect.stringContaining('translate(-500 '))
})

test('shows and edits the canonical object base while a semantic move remains composed in preview', () => {
  render(<ProofCanvasEditor initialProject={semanticMoveProject()}/>)
  fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '1' } })
  selectObject()

  expect(screen.getByRole('spinbutton', { name: 'X position' })).toHaveValue(100)
  expect(canvasObject()).toHaveAttribute('transform', expect.stringContaining('translate(200 200)'))

  fireEvent.blur(screen.getByRole('spinbutton', { name: 'X position' }), { target: { value: '150' } })
  expect(screen.getByRole('spinbutton', { name: 'X position' })).toHaveValue(150)
  expect(canvasObject()).toHaveAttribute('transform', expect.stringContaining('translate(225 200)'))
  expect(editor()).toHaveAttribute('data-history-past-count', '1')
})

test('shows and edits the canonical camera base while camera focus remains composed in preview', () => {
  render(<ProofCanvasEditor initialProject={semanticCameraProject()}/>)
  fireEvent.change(screen.getByRole('slider', { name: 'Sequence time' }), { target: { value: '1' } })
  fireEvent.pointerDown(screen.getByRole('group', { name: /canvas at 1.0 seconds/ }), { button: 0, pointerId: 1 })

  expect(screen.getByRole('spinbutton', { name: 'Camera X' })).toHaveValue(0)
  expect(document.querySelector('[data-pc-camera-transform]')).toHaveAttribute('transform', expect.stringContaining('translate(-200 '))

  fireEvent.blur(screen.getByRole('spinbutton', { name: 'Camera X' }), { target: { value: '100' } })
  expect(screen.getByRole('spinbutton', { name: 'Camera X' })).toHaveValue(100)
  expect(document.querySelector('[data-pc-camera-transform]')).toHaveAttribute('transform', expect.stringContaining('translate(-250 '))
  expect(editor()).toHaveAttribute('data-history-past-count', '1')
})

test('authors uniform scale and camera rotation keys and rejects zero-magnitude scale without publication', () => {
  render(<ProofCanvasEditor initialProject={timelineProject()}/>)
  selectObject()
  const scale = screen.getByRole('spinbutton', { name: 'Scale' })
  const historyBefore = editor().getAttribute('data-history-past-count')
  fireEvent.blur(scale, { target: { value: '0' } })
  expect(screen.getByRole('spinbutton', { name: 'Scale' })).toHaveValue(1)
  expect(editor()).toHaveAttribute('data-history-past-count', historyBefore)

  fireEvent.click(screen.getByRole('button', { name: 'Add Scale keyframe at 0 seconds' }))
  expect(editor()).toHaveAttribute('data-selection-kind', 'keyframes')
  expect(screen.getByRole('button', { name: 'scale keyframe at 0 seconds' })).toBeInTheDocument()

  fireEvent.pointerDown(screen.getByRole('group', { name: /canvas at 0.0 seconds/ }), { button: 0, pointerId: 2 })
  fireEvent.click(screen.getByRole('button', { name: 'Add Camera rotation keyframe at 0 seconds' }))
  expect(editor()).toHaveAttribute('data-selection-kind', 'keyframes')
  expect(screen.getByRole('button', { name: 'rotation keyframe at 0 seconds' })).toBeInTheDocument()
  expect(editor()).toHaveAttribute('data-history-past-count', '2')
})

test('latest playback authority blocks stale and forced mutation controls without pausing or changing history', () => {
  const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 91)
  const cancelFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  try {
    const project = cloneSerializable(timelineProject())
    project.shots[0].animations = [{ id: 'animation-title-appear', type: 'appear', targetIds: ['object-title'], start: 0, duration: 1, easing: 'linear', properties: {} }]
    render(<ProofCanvasEditor initialProject={ProjectDocumentSchema.parse(project)}/>)
    selectObject()
    fireEvent.blur(screen.getByRole('spinbutton', { name: 'Y position' }), { target: { value: '234' } })
    expect(editor()).toHaveAttribute('data-history-past-count', '1')

    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    const assertStillPlayingAndUnchanged = () => {
      expect(screen.getByRole('button', { name: 'Pause sequence' })).toBeInTheDocument()
      expect(editor()).toHaveAttribute('data-history-past-count', '1')
      expect(screen.getAllByRole('treeitem')).toHaveLength(1)
      expect(screen.getAllByRole('tab', { name: /Shot \d/ })).toHaveLength(1)
    }

    const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    expect(name).toBeDisabled()
    name.disabled = false
    fireEvent.blur(name, { target: { value: 'Forbidden rename' } })
    expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent(/Pause sequence playback before editing the project/i)
    assertStillPlayingAndUnchanged()

    const undo = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement
    expect(undo).toBeDisabled()
    undo.disabled = false
    fireEvent.click(undo)
    assertStillPlayingAndUnchanged()

    const duplicate = screen.getByRole('button', { name: 'Duplicate' }) as HTMLButtonElement
    expect(duplicate).toBeDisabled()
    duplicate.disabled = false
    fireEvent.click(duplicate)
    assertStillPlayingAndUnchanged()

    const addText = screen.getByRole('button', { name: 'Add text' }) as HTMLButtonElement
    expect(addText).toBeDisabled()
    addText.disabled = false
    fireEvent.click(addText)
    assertStillPlayingAndUnchanged()

    fireEvent.click(screen.getByRole('button', { name: /appear animation targeting/ }))
    const start = screen.getByRole('spinbutton', { name: 'Start time' }) as HTMLInputElement
    expect(start).toBeDisabled()
    start.disabled = false
    fireEvent.blur(start, { target: { value: '0.5' } })
    expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent(/Pause sequence playback before editing the project/i)
    assertStillPlayingAndUnchanged()
  } finally {
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  }
})

test('an unset child lifetime is labelled as its inherited range', () => {
  const project = createCantorDemoProject()
  render(<ProofCanvasEditor initialProject={project}/>)
  fireEvent.click(screen.getByRole('treeitem', { name: /Original interval/ }))
  expect(screen.getByRole('radio', { name: 'Entire inherited range' })).toBeChecked()
  expect(screen.queryByRole('radio', { name: 'Entire shot' })).not.toBeInTheDocument()
})
