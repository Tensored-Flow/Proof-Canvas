import { render, screen, waitFor } from '@testing-library/react'
import AudioWaveform from '../AudioWaveform'

const close = jest.fn().mockResolvedValue(undefined)
const decodeAudioData = jest.fn().mockResolvedValue({
  numberOfChannels: 1,
  getChannelData: () => new Float32Array([-1, -.5, 0, .5, 1, 0]),
})

beforeEach(() => {
  close.mockClear()
  decodeAudioData.mockClear()
  class TestAudioContext {
    decodeAudioData = decodeAudioData
    close = close
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: TestAudioContext })
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) })
})

test('fetches only the project-scoped asset URL and renders bounded decoded PCM buckets', async () => {
  const { container } = render(<AudioWaveform projectId="project-waveform" assetId="asset-tone" label="Tone" buckets={3}/>)
  await waitFor(() => expect(container.querySelector('svg')).toHaveAttribute('data-waveform-state', 'ready'))
  expect(globalThis.fetch).toHaveBeenCalledWith('/api/projects/project-waveform/assets/asset-tone', { cache: 'force-cache' })
  expect(container.querySelectorAll('svg > line')).toHaveLength(3)
  expect(screen.getByTitle('Tone waveform')).toBeInTheDocument()
  expect(close).toHaveBeenCalledTimes(1)
})

test('shares one bounded asset fetch between concurrent waveform resolutions', async () => {
  const { container } = render(<>
    <AudioWaveform projectId="project-shared-waveform" assetId="asset-shared-tone" label="Library tone" buckets={3}/>
    <AudioWaveform projectId="project-shared-waveform" assetId="asset-shared-tone" label="Timeline tone" buckets={4}/>
  </>)
  await waitFor(() => expect(container.querySelectorAll('[data-waveform-state="ready"]')).toHaveLength(2))
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  expect(globalThis.fetch).toHaveBeenCalledWith('/api/projects/project-shared-waveform/assets/asset-shared-tone', { cache: 'force-cache' })
  expect(decodeAudioData).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledTimes(2)
})

test('fails closed to an honest unavailable visual when browser decoding fails', async () => {
  decodeAudioData.mockRejectedValueOnce(new Error('unsupported'))
  const { container } = render(<AudioWaveform projectId="project-waveform" assetId="asset-broken" label="Broken" buckets={4}/>)
  await waitFor(() => expect(container.querySelector('svg')).toHaveAttribute('data-waveform-state', 'unavailable'))
  expect(screen.getByTitle('Broken waveform unavailable in this browser')).toBeInTheDocument()
})
