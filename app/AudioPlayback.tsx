'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import { activeAudioPlayback } from '@/lib/proofcanvas/audio'
import type { Shot } from '@/lib/proofcanvas/schema'

interface AudioGraph {
  source: MediaElementAudioSourceNode
  gain: GainNode
}

export interface AudioPlaybackProps {
  projectId: string
  shot: Shot
  playhead: number
  playing: boolean
  onPlaybackError?(message: string): void
}

export interface AudioPlaybackHandle {
  /** Must be called synchronously from the owner's transport gesture. */
  beginFromUserGesture(): void
}

const MIN_RENDERABLE_PLAYBACK_RATE = 1 / 16
const MAX_RENDERABLE_PLAYBACK_RATE = 16

/**
 * Synchronizes trusted project-local audio elements to the authoritative shot
 * playhead. Web Audio supplies authored gain above 1; browsers without that
 * graph retain synchronized playback with a safely capped element volume.
 */
const AudioPlayback = forwardRef<AudioPlaybackHandle, AudioPlaybackProps>(function AudioPlayback(
  { projectId, shot, playhead, playing, onPlaybackError },
  ref,
) {
  const elements = useRef(new Map<string, HTMLAudioElement>())
  const context = useRef<AudioContext | null>(null)
  const graphs = useRef(new Map<string, AudioGraph>())
  const reported = useRef(new Set<string>())
  const synchronizedPlayingClips = useRef(new Set<string>())

  const report = useCallback((clipId: string, message: string) => {
    if (reported.current.has(`${clipId}:${message}`)) return
    reported.current.add(`${clipId}:${message}`)
    onPlaybackError?.(message)
  }, [onPlaybackError])

  const ensureContext = useCallback((): AudioContext | null => {
    if (context.current) return context.current
    const AudioContextConstructor = globalThis.AudioContext
    if (!AudioContextConstructor) return null
    try {
      context.current = new AudioContextConstructor()
      return context.current
    } catch {
      return null
    }
  }, [])

  const ensureGraph = useCallback((clipId: string, element: HTMLAudioElement): AudioGraph | null => {
    const existing = graphs.current.get(clipId)
    if (existing) return existing
    try {
      const audioContext = ensureContext()
      if (!audioContext) return null
      const source = audioContext.createMediaElementSource(element)
      const gain = audioContext.createGain()
      source.connect(gain)
      gain.connect(audioContext.destination)
      const graph = { source, gain }
      graphs.current.set(clipId, graph)
      return graph
    } catch {
      report(clipId, 'Browser audio gain could not be initialized; preview volume is capped at 100%.')
      return null
    }
  }, [ensureContext, report])

  const synchronize = useCallback((shouldPlay: boolean, resumeAudioContext = true) => {
    const currentClipIds = new Set(shot.audioClips.map(({ id }) => id))
    for (const [clipId, graph] of graphs.current) {
      if (currentClipIds.has(clipId)) continue
      try { graph.source.disconnect() } catch { /* already disconnected */ }
      try { graph.gain.disconnect() } catch { /* already disconnected */ }
      graphs.current.delete(clipId)
    }
    for (const [clipId, element] of elements.current) {
      if (currentClipIds.has(clipId)) continue
      element.pause()
      elements.current.delete(clipId)
      synchronizedPlayingClips.current.delete(clipId)
    }
    for (const failure of reported.current) {
      if (![...currentClipIds].some((clipId) => failure.startsWith(`${clipId}:`))) reported.current.delete(failure)
    }
    const active = new Map(activeAudioPlayback(shot, playhead).map((state) => [state.clipId, state]))
    for (const clip of shot.audioClips) {
      const element = elements.current.get(clip.id)
      if (!element) continue
      const state = active.get(clip.id)
      if (!state) {
        element.pause()
        synchronizedPlayingClips.current.delete(clip.id)
        continue
      }
      const sourceSpan = clip.sourceEnd - clip.sourceStart
      const playbackRate = sourceSpan / clip.duration
      if (!Number.isFinite(playbackRate) || playbackRate < MIN_RENDERABLE_PLAYBACK_RATE || playbackRate > MAX_RENDERABLE_PLAYBACK_RATE) {
        element.pause()
        report(clip.id, `Audio clip ${clip.name} uses a preview-unsupported playback rate.`)
        continue
      }
      element.playbackRate = playbackRate
      if (!shouldPlay) {
        synchronizedPlayingClips.current.delete(clip.id)
        try { element.currentTime = state.sourceTime } catch { report(clip.id, `Audio clip ${clip.name} could not seek to the playhead.`) }
      } else if (!synchronizedPlayingClips.current.has(clip.id) && element.readyState >= HTMLMediaElement.HAVE_METADATA) {
        // One metadata-aware seek establishes the transport position. Repeated
        // requestAnimationFrame seeks prevent Chromium's native media clock
        // from ever settling or advancing, so active playback runs natively
        // until pause, deactivation, or a shot transition clears this marker.
        try {
          element.currentTime = state.sourceTime
          synchronizedPlayingClips.current.add(clip.id)
        } catch {
          report(clip.id, `Audio clip ${clip.name} could not seek to the playhead.`)
        }
      }
      // Native element volume is enough through 100% and does not route media
      // through a possibly suspended Web Audio graph. Create the gain graph
      // only when authored gain exceeds the element's supported envelope.
      const graph = graphs.current.get(clip.id) ?? (state.gain > 1 ? ensureGraph(clip.id, element) : null)
      if (graph) {
        graph.gain.gain.value = state.gain
        element.volume = 1
      } else element.volume = Math.min(1, state.gain)
      element.muted = false
      if (shouldPlay) {
        if (resumeAudioContext && context.current?.state === 'suspended') void context.current.resume().catch(() => report(clip.id, 'Browser audio preview is waiting for playback permission.'))
        if (element.paused) void element.play().catch(() => report(clip.id, `Audio clip ${clip.name} could not begin browser playback.`))
      } else element.pause()
    }
  }, [ensureGraph, playhead, report, shot])

  useImperativeHandle(ref, () => ({
    beginFromUserGesture() {
      // Resume/create Web Audio while transient user activation is still
      // available. React effects run after that activation window and cannot
      // honestly establish audible playback in strict browsers.
      const audioContext = ensureContext()
      if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => undefined)
      synchronize(true, false)
    },
  }), [ensureContext, synchronize])

  useEffect(() => {
    synchronize(playing)
  }, [playing, synchronize])

  useEffect(() => () => {
    for (const element of elements.current.values()) element.pause()
    for (const { source, gain } of graphs.current.values()) {
      try { source.disconnect() } catch { /* already disconnected */ }
      try { gain.disconnect() } catch { /* already disconnected */ }
    }
    graphs.current.clear()
    synchronizedPlayingClips.current.clear()
    void context.current?.close().catch(() => undefined)
    context.current = null
  }, [])

  return <div hidden aria-hidden="true" data-testid="proofcanvas-audio-playback">
    {shot.audioClips.map((clip) => <audio
      key={clip.id}
      ref={(element) => {
        if (element) elements.current.set(clip.id, element)
        else elements.current.delete(clip.id)
      }}
      preload="auto"
      src={`/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(clip.assetId)}`}
      data-audio-clip-id={clip.id}
    />)}
  </div>
})

export default AudioPlayback
