import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import StyleLab from '../StyleLab'
import { cloneSerializable, type SceneObject, type StylePack } from '@/lib/proofcanvas/schema'
import { DEFAULT_STYLE_PACKS, EDITORIAL_INK_STYLE_ID } from '@/lib/proofcanvas/styles'

const selectedObject: SceneObject = {
  id: 'object-style-lab',
  type: 'text',
  name: 'Selected statement',
  locked: false,
  visible: true,
  transform: { x: 10, y: 20, width: 200, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
  style: { color: '#123456', fontSize: 28 },
  properties: { content: 'A statement' },
}

function renderLab(overrides: Partial<React.ComponentProps<typeof StyleLab>> = {}) {
  const callbacks = {
    onActivate: jest.fn(),
    onReplace: jest.fn(() => true),
    onDuplicate: jest.fn(),
    onSavePreset: jest.fn(),
    onResetPreset: jest.fn(),
    onImport: jest.fn(),
    onExport: jest.fn(),
    onCopyObjectStyle: jest.fn(),
    onPasteObjectStyle: jest.fn(),
    onResetObjectStyle: jest.fn(),
    onNotice: jest.fn(),
  }
  render(<StyleLab
    styles={cloneSerializable(DEFAULT_STYLE_PACKS)}
    activeStyleId={EDITORIAL_INK_STYLE_ID}
    selectedObject={selectedObject}
    canPasteObjectStyle
    canResetPreset
    {...callbacks}
    {...overrides}
  />)
  return callbacks
}

test('exposes differentiated starting styles and all project/per-object style actions', () => {
  const callbacks = renderLab()
  const presets = screen.getByRole('radiogroup', { name: 'Library output styles' })
  expect(screen.getByLabelText('Style Lab')).toBeInTheDocument()
  expect(presets).toHaveAttribute('role', 'radiogroup')
  expect(screen.getByRole('radio', { name: /Editorial Ink/ })).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByRole('radio', { name: /Scientific Minimal/ })).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: /Nocturne Chalk/ })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save as preset' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reset preset' }))
  fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reset to style' }))

  expect(callbacks.onDuplicate).toHaveBeenCalledWith(EDITORIAL_INK_STYLE_ID)
  expect(callbacks.onSavePreset).toHaveBeenCalledWith(EDITORIAL_INK_STYLE_ID)
  expect(callbacks.onResetPreset).toHaveBeenCalledWith(EDITORIAL_INK_STYLE_ID)
  expect(callbacks.onExport).toHaveBeenCalledWith(expect.objectContaining({ id: EDITORIAL_INK_STYLE_ID }))
  expect(callbacks.onCopyObjectStyle).toHaveBeenCalledTimes(1)
  expect(callbacks.onPasteObjectStyle).toHaveBeenCalledTimes(1)
  expect(callbacks.onResetObjectStyle).toHaveBeenCalledTimes(1)
})

test('authors global tokens without changing non-style content and imports bounded validated JSON', async () => {
  const callbacks = renderLab()
  const background = screen.getAllByLabelText(/^background$/i)[0]
  fireEvent.change(background, { target: { value: '#112233' } })
  expect(callbacks.onReplace).toHaveBeenCalledWith(expect.objectContaining({
    id: EDITORIAL_INK_STYLE_ID,
    origin: 'custom',
    colors: expect.objectContaining({ background: '#112233' }),
  }), 'Set style background')

  const imported: StylePack = { ...cloneSerializable(DEFAULT_STYLE_PACKS[1]), id: 'style-imported', name: 'Imported lab style', origin: 'custom' }
  const file = new File([JSON.stringify(imported)], 'style.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: jest.fn().mockResolvedValue(JSON.stringify(imported)) })
  fireEvent.change(screen.getByLabelText('Import style JSON'), { target: { files: [file] } })
  await waitFor(() => expect(callbacks.onImport).toHaveBeenCalledWith(imported))
})

test('uses wrapped arrow navigation for its radio group', async () => {
  const requestAnimationFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0)
    return 1
  })
  const callbacks = renderLab()
  const editorial = screen.getByRole('radio', { name: /Editorial Ink/ })
  const raw = screen.getByRole('radio', { name: /Raw Manim/ })
  fireEvent.keyDown(editorial, { key: 'ArrowLeft' })
  expect(callbacks.onActivate).toHaveBeenCalledWith('style-raw-manim', 'Raw Manim')
  expect(raw).toHaveFocus()
  requestAnimationFrame.mockRestore()
})

test('reports invalid or oversized imports on the visible notice surface', async () => {
  const callbacks = renderLab()
  const statementFamily = screen.getByLabelText('Statement family')
  fireEvent.change(statementFamily, { target: { value: '   ' } })
  fireEvent.blur(statementFamily)
  expect(statementFamily).toHaveValue(DEFAULT_STYLE_PACKS[0].typography.statement)
  expect(callbacks.onNotice).toHaveBeenCalledWith('Statement family cannot be empty.')
  expect(callbacks.onReplace).not.toHaveBeenCalled()

  const file = new File(['{'], 'broken.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: jest.fn().mockResolvedValue('{') })
  fireEvent.change(screen.getByLabelText('Import style JSON'), { target: { files: [file] } })
  await waitFor(() => expect(callbacks.onNotice).toHaveBeenCalledWith(expect.stringMatching(/^Style import failed:/)))
})
