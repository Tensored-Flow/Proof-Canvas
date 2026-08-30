import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import MediaTimeline, { PROOFCANVAS_AUDIO_ASSET_MIME } from '../MediaTimeline'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { ProjectDocumentSchema, cloneSerializable } from '@/lib/proofcanvas/schema'

jest.mock('../AudioWaveform', () => function TestWaveform({ label }: { label: string }) { return <span data-testid="waveform">{label}</span> })

function mediaProject() {
  const project = cloneSerializable(createCantorDemoProject())
  project.assets = [{ id: 'asset-audio-media', filename: 'tone.wav', mimeType: 'audio/wav', size: 128, sha256: 'a'.repeat(64), duration: 6, provenance: 'uploaded' }]
  const shot = project.shots[0]
  shot.duration = 8
  shot.objects = []
  shot.animations = []
  shot.propertyTracks = []
  shot.audioClips = [{ id: 'audio-media', assetId: 'asset-audio-media', name: 'Tone', start: 1, duration: 4, sourceStart: 0, sourceEnd: 4, volume: 1, muted: false, solo: false, fadeIn: 0, fadeOut: 0 }]
  shot.captionClips = [{ id: 'caption-media', start: 2, end: 4, text: 'First line\nSecond line', style: { position: 'bottom' } }]
  shot.markers = [{ id: 'marker-media', time: 3, name: 'Narration', color: '#c05b3d' }]
  return ProjectDocumentSchema.parse(project)
}

function renderTimeline() {
  const project = mediaProject()
  const callbacks = {
    onSelect: jest.fn(), onSeek: jest.fn(), onReplaceAudio: jest.fn(() => true), onReplaceCaption: jest.fn(() => true),
    onDeleteAudio: jest.fn(() => true), onDeleteCaption: jest.fn(() => true), onAddAudioAsset: jest.fn(() => true),
  }
  render(<MediaTimeline project={project} shot={project.shots[0]} playhead={2.5} selected={null} {...callbacks}/>)
  return callbacks
}

test('projects audio, captions, markers and a decoded waveform into distinct timeline rows', () => {
  renderTimeline()
  expect(screen.getByRole('button', { name: /Tone audio clip from 1 to 5 seconds/ })).toHaveStyle({ left: '12.5%', width: '50%' })
  expect(screen.getByRole('button', { name: /Caption from 2 to 4 seconds/ })).toHaveTextContent('First line / Second line')
  expect(screen.getByRole('button', { name: 'Narration marker at 3 seconds' })).toBeInTheDocument()
  expect(screen.getByTestId('waveform')).toHaveTextContent('Tone')
})

test('keyboard nudging and deletion commit one exact media operation', () => {
  const callbacks = renderTimeline()
  const audio = screen.getByRole('button', { name: /Tone audio clip/ })
  fireEvent.keyDown(audio, { key: 'ArrowRight' })
  expect(callbacks.onReplaceAudio).toHaveBeenCalledWith(expect.objectContaining({ id: 'audio-media' }), 'Nudge audio clip')
  expect(callbacks.onReplaceAudio.mock.calls[0][0].start).toBeCloseTo(1 + 1 / 30, 8)
  fireEvent.keyDown(audio, { key: 'Delete' })
  expect(callbacks.onDeleteAudio).toHaveBeenCalledWith('audio-media')

  const caption = screen.getByRole('button', { name: /Caption from 2 to 4 seconds/ })
  fireEvent.keyDown(caption, { key: 'ArrowLeft' })
  expect(callbacks.onReplaceCaption).toHaveBeenCalledWith(expect.objectContaining({ id: 'caption-media' }), 'Nudge caption')
  expect(callbacks.onReplaceCaption.mock.calls[0][0].start).toBeCloseTo(2 - 1 / 30, 8)
  expect(callbacks.onReplaceCaption.mock.calls[0][0].end).toBeCloseTo(4 - 1 / 30, 8)
  fireEvent.keyDown(caption, { key: 'Backspace' })
  expect(callbacks.onDeleteCaption).toHaveBeenCalledWith('caption-media')
})

test('accepts only the private ProofCanvas audio drag type on the audio lane', () => {
  const callbacks = renderTimeline()
  const lane = document.querySelector('.pc-audio-lane') as HTMLElement
  Object.defineProperty(lane, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 0, width: 800, top: 0, right: 800, bottom: 40, height: 40, x: 0, y: 0, toJSON() {} }) })
  const dataTransfer = {
    types: [PROOFCANVAS_AUDIO_ASSET_MIME],
    getData: (type: string) => type === PROOFCANVAS_AUDIO_ASSET_MIME ? 'asset-audio-media' : '',
  }
  const drop = createEvent.drop(lane, { dataTransfer })
  Object.defineProperty(drop, 'clientX', { configurable: true, value: 400 })
  fireEvent(lane, drop)
  expect(callbacks.onAddAudioAsset).toHaveBeenCalledWith('asset-audio-media', 4)
})
