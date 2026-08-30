import { createRef } from 'react'
import { act, render } from '@testing-library/react'
import AudioPlayback, { type AudioPlaybackHandle } from '../AudioPlayback'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { ProjectDocumentSchema, cloneSerializable } from '@/lib/proofcanvas/schema'

function shot() {
  const project = cloneSerializable(createCantorDemoProject())
  project.assets = [{ id: 'asset-audio-ui', filename: 'tone.wav', mimeType: 'audio/wav', size: 64, sha256: 'd'.repeat(64), duration: 10, provenance: 'uploaded' }]
  project.shots[0].audioClips = [{
    id: 'audio-ui-main',
    assetId: 'asset-audio-ui',
    name: 'Tone',
    start: 1,
    duration: 4,
    sourceStart: 2,
    sourceEnd: 6,
    volume: 0.8,
    muted: false,
    solo: false,
    fadeIn: 1,
    fadeOut: 1,
  }]
  return ProjectDocumentSchema.parse(project).shots[0]
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: undefined })
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: jest.fn().mockResolvedValue(undefined) })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: jest.fn() })
})

test('resolves only authenticated project-local asset URLs and seeks active audio to the playhead', async () => {
  const view = render(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={shot()} playhead={2.5} playing={false}/>)
  const element = view.container.querySelector('audio')!
  expect(element.getAttribute('src')).toBe('/api/projects/project-0123456789abcdef01234567/assets/asset-audio-ui')
  expect(element.currentTime).toBe(3.5)
  expect(element.playbackRate).toBe(1)
  expect(element.volume).toBe(0.8)
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
})

test('starts and pauses the media element as playback crosses the half-open clip range', async () => {
  const view = render(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={shot()} playhead={1.5} playing/>)
  await act(async () => undefined)
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
  view.rerender(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={shot()} playhead={5} playing/>)
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
})

test('begins media and resumes Web Audio synchronously from the owner transport gesture', () => {
  const resume = jest.fn().mockResolvedValue(undefined)
  const close = jest.fn().mockResolvedValue(undefined)
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    value: class {
      state = 'suspended'
      resume = resume
      close = close
    },
  })
  const handle = createRef<AudioPlaybackHandle>()
  const view = render(<AudioPlayback ref={handle} projectId="project-0123456789abcdef01234567" shot={shot()} playhead={1.5} playing={false}/>)
  ;(HTMLMediaElement.prototype.play as jest.Mock).mockClear()

  act(() => handle.current?.beginFromUserGesture())

  expect(resume).toHaveBeenCalledTimes(1)
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(close).toHaveBeenCalledTimes(1)
})

test('seeks once when playback starts and lets the native media clock run between sequence frames', () => {
  const view = render(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={shot()} playhead={1.5} playing={false}/>)
  const element = view.container.querySelector('audio')!
  const seek = jest.fn()
  Object.defineProperty(element, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA })
  Object.defineProperty(element, 'currentTime', { configurable: true, get: () => 3, set: seek })

  view.rerender(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={shot()} playhead={1.5} playing/>)
  view.rerender(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={shot()} playhead={1.6} playing/>)
  view.rerender(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={shot()} playhead={1.7} playing/>)
  expect(seek).toHaveBeenCalledTimes(1)

  view.rerender(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={shot()} playhead={1.7} playing={false}/>)
  expect(seek).toHaveBeenCalledTimes(2)
})

test('applies mute and solo as zero gain while retaining synchronized active playback', async () => {
  const media = shot()
  media.audioClips[0].muted = true
  const view = render(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={media} playhead={2} playing={false}/>)
  view.rerender(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={media} playhead={2} playing/>)
  await act(async () => undefined)
  const element = document.querySelector('audio')!
  expect(element.volume).toBe(0)
  expect(element.currentTime).toBe(3)
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
})

test('reports and refuses an unsupported preview playback-rate ratio', () => {
  const media = shot()
  media.audioClips[0].sourceEnd = 10
  media.audioClips[0].duration = 0.25
  const onPlaybackError = jest.fn()
  render(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={media} playhead={1.1} playing onPlaybackError={onPlaybackError}/>)
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
  expect(onPlaybackError).toHaveBeenCalledWith(expect.stringContaining('preview-unsupported playback rate'))
})

test('previews the same extended playback-rate envelope admitted by the renderer', async () => {
  const media = shot()
  media.audioClips[0].sourceEnd = 10
  media.audioClips[0].duration = 1
  render(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={media} playhead={1.5} playing/>)
  await act(async () => undefined)
  expect(document.querySelector('audio')!.playbackRate).toBe(8)
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
})

test('reports a rejected browser play promise once per stable failure', async () => {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: jest.fn().mockRejectedValue(new Error('blocked')) })
  const onPlaybackError = jest.fn()
  const media = shot()
  const view = render(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={media} playhead={2} playing onPlaybackError={onPlaybackError}/>)
  await act(async () => undefined)
  view.rerender(<AudioPlayback projectId="project-0123456789abcdef01234567" shot={media} playhead={2.1} playing onPlaybackError={onPlaybackError}/>)
  await act(async () => undefined)
  expect(onPlaybackError.mock.calls.filter(([message]) => String(message).includes('could not begin'))).toHaveLength(1)
})
