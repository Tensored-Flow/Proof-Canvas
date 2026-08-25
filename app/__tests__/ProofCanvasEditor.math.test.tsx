import { fireEvent, render, screen } from '@testing-library/react'
import ProofCanvasEditor from '../ProofCanvasEditor'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { ProjectDocumentSchema, cloneSerializable } from '@/lib/proofcanvas/schema'

function mathProject({ keepSecondShot = false } = {}) {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  const math = shot.objects.find(({ type }) => type === 'math')!
  const text = shot.objects.find(({ name }) => name === 'A quiet paradox')!
  math.locked = false
  text.locked = false
  delete math.parentId
  delete text.parentId
  shot.objects = [math, text]
  shot.animations = []
  shot.propertyTracks = []
  shot.audioClips = []
  shot.captionClips = []
  shot.markers = []
  project.shots = keepSecondShot ? [shot, project.shots[1]] : [shot]
  return ProjectDocumentSchema.parse(project)
}

function editor() {
  return screen.getByRole('application', { name: 'ProofCanvas editor' })
}

function selectMath() {
  fireEvent.click(screen.getByRole('treeitem', { name: /Length after n stages/ }))
}

test('retains an invalid math draft, applies one repaired contract explicitly, and undoes exactly', () => {
  render(<ProofCanvasEditor initialProject={mathProject()}/>)
  expect(screen.getByRole('group', { name: 'Project actions' })).toBeInTheDocument()
  selectMath()
  const content = screen.getByRole('textbox', { name: 'Math content' })
  expect(screen.getByRole('combobox', { name: 'Math renderer' })).toHaveValue('mathtex')
  expect(screen.getByRole('combobox', { name: 'Math mode' })).toHaveValue('display')
  expect(screen.getByRole('spinbutton', { name: 'Font size' })).toHaveAttribute('min', '1')
  expect(screen.getByRole('spinbutton', { name: 'Font size' })).toHaveAttribute('max', '256')

  fireEvent.change(content, { target: { value: '\\frac{1' } })
  expect(content).toHaveValue('\\frac{1')
  expect(content).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByRole('alert')).toHaveTextContent('Unclosed "{" at character 6.')
  fireEvent.blur(content)
  expect(content).toHaveValue('\\frac{1')
  expect(editor()).toHaveAttribute('data-history-past-count', '0')

  fireEvent.change(content, { target: { value: '\\frac{1}{2}' } })
  fireEvent.blur(content)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText(/Draft only.*choose Apply/i)).toBeInTheDocument()
  expect(editor()).toHaveAttribute('data-history-past-count', '0')

  fireEvent.click(screen.getByRole('button', { name: 'Apply math draft' }))
  expect(editor()).toHaveAttribute('data-history-past-count', '1')
  expect(content).toHaveValue('\\frac{1}{2}')

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(editor()).toHaveAttribute('data-history-past-count', '0')
  expect(screen.getByRole('textbox', { name: 'Math content' })).toHaveValue('L_n = (2/3)^n')
})

test('renderer and mode remain draft-only until the whole valid contract is applied', () => {
  render(<ProofCanvasEditor initialProject={mathProject()}/>)
  selectMath()
  fireEvent.change(screen.getByRole('combobox', { name: 'Math renderer' }), { target: { value: 'tex' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Math mode' }), { target: { value: 'inline' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Math content' }), { target: { value: 'Euler wrote $e^{i\\pi}+1=0$.' } })
  fireEvent.blur(screen.getByRole('textbox', { name: 'Math content' }))
  expect(editor()).toHaveAttribute('data-history-past-count', '0')

  fireEvent.click(screen.getByRole('button', { name: 'Apply math draft' }))
  expect(editor()).toHaveAttribute('data-history-past-count', '1')
  expect(screen.getByRole('combobox', { name: 'Math renderer' })).toHaveValue('tex')
  expect(screen.getByRole('combobox', { name: 'Math mode' })).toHaveValue('inline')
})

test('a stale math draft never rebinds on focus and requires discard before a deliberate retry', () => {
  render(<ProofCanvasEditor initialProject={mathProject()}/>)
  selectMath()
  const content = screen.getByRole('textbox', { name: 'Math content' })
  fireEvent.change(content, { target: { value: '\\frac{3}{4}' } })

  const name = screen.getByRole('textbox', { name: 'Name' })
  fireEvent.change(name, { target: { value: 'Revised equation name' } })
  fireEvent.blur(name)
  expect(editor()).toHaveAttribute('data-history-past-count', '1')
  expect(content).toHaveValue('\\frac{3}{4}')
  expect(content).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Apply math draft' })).toBeDisabled()
  expect(screen.getAllByText(/draft is stale because the project changed/i)).toHaveLength(2)
  expect(screen.getByRole('status', { name: 'Editor status' })).toHaveTextContent(/draft is stale/i)

  fireEvent.focus(content)
  fireEvent.click(screen.getByRole('button', { name: 'Apply math draft' }))
  expect(editor()).toHaveAttribute('data-history-past-count', '1')
  expect(content).toHaveValue('\\frac{3}{4}')

  fireEvent.click(screen.getByRole('button', { name: 'Discard math draft' }))
  expect(content).toHaveValue('L_n = (2/3)^n')
  expect(content).toBeEnabled()
  fireEvent.change(content, { target: { value: '\\frac{3}{4}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply math draft' }))
  expect(editor()).toHaveAttribute('data-history-past-count', '2')
  expect(content).toHaveValue('\\frac{3}{4}')
})

test('undoing an external revision makes an older dirty draft stale and preserves the undone value', () => {
  render(<ProofCanvasEditor initialProject={mathProject()}/>)
  selectMath()
  const name = screen.getByRole('textbox', { name: 'Name' })
  fireEvent.change(name, { target: { value: 'Temporary equation name' } })
  fireEvent.blur(name)
  expect(editor()).toHaveAttribute('data-history-past-count', '1')

  const content = screen.getByRole('textbox', { name: 'Math content' })
  fireEvent.change(content, { target: { value: '\\frac{7}{9}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(editor()).toHaveAttribute('data-history-past-count', '0')
  expect(content).toHaveValue('\\frac{7}{9}')
  expect(content).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Apply math draft' })).toBeDisabled()

  fireEvent.click(screen.getByRole('button', { name: 'Discard math draft' }))
  expect(content).toHaveValue('L_n = (2/3)^n')
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Length after n stages')
})

test('typing valid math then changing the layer or shot discards without publishing', () => {
  render(<ProofCanvasEditor initialProject={mathProject({ keepSecondShot: true })}/>)
  selectMath()
  fireEvent.change(screen.getByRole('textbox', { name: 'Math content' }), { target: { value: '\\frac{5}{8}' } })
  fireEvent.click(screen.getByRole('treeitem', { name: /A quiet paradox/ }))
  expect(editor()).toHaveAttribute('data-history-past-count', '0')
  selectMath()
  expect(screen.getByRole('textbox', { name: 'Math content' })).toHaveValue('L_n = (2/3)^n')

  fireEvent.change(screen.getByRole('textbox', { name: 'Math content' }), { target: { value: '\\frac{2}{3}' } })
  fireEvent.click(screen.getByRole('tab', { name: /Shot 2, The paradox/ }))
  expect(editor()).toHaveAttribute('data-history-past-count', '0')
  fireEvent.click(screen.getByRole('tab', { name: /Shot 1, The construction/ }))
  selectMath()
  expect(screen.getByRole('textbox', { name: 'Math content' })).toHaveValue('L_n = (2/3)^n')
})

test('playback disables a valid local draft without applying it, then allows explicit apply after pause', () => {
  const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 71)
  const cancelFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  try {
    render(<ProofCanvasEditor initialProject={mathProject()}/>)
    selectMath()
    const content = screen.getByRole('textbox', { name: 'Math content' })
    fireEvent.change(content, { target: { value: '\\frac{5}{8}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Play sequence' }))
    expect(content).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Apply math draft' })).toBeDisabled()
    expect(editor()).toHaveAttribute('data-history-past-count', '0')
    expect(content).toHaveValue('\\frac{5}{8}')
    expect(screen.getByText(/draft is not applied.*Pause playback/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Pause sequence' }))
    expect(content).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply math draft' }))
    expect(editor()).toHaveAttribute('data-history-past-count', '1')
  } finally {
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  }
})

test('locking while a draft is dirty cannot publish it and leaves only Discard available', () => {
  render(<ProofCanvasEditor initialProject={mathProject()}/>)
  selectMath()
  const content = screen.getByRole('textbox', { name: 'Math content' })
  fireEvent.change(content, { target: { value: '\\frac{11}{12}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Lock' }))
  expect(editor()).toHaveAttribute('data-history-past-count', '1')
  expect(content).toHaveValue('\\frac{11}{12}')
  expect(content).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Apply math draft' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Discard math draft' })).toBeEnabled()
  expect(content.closest('fieldset')).not.toHaveAttribute('aria-disabled')
})
