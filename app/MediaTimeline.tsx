'use client'

import { useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { canonicalTimelineTime } from '@/lib/proofcanvas/frame'
import type { AudioClip, CaptionClip, ProjectDocument, Shot, TimelineMarker } from '@/lib/proofcanvas/schema'
import AudioWaveform from './AudioWaveform'

export const PROOFCANVAS_AUDIO_ASSET_MIME = 'application/x-proofcanvas-audio-asset'

export type MediaSelection = Readonly<
  | { kind: 'audio'; id: string }
  | { kind: 'caption'; id: string }
  | { kind: 'marker'; id: string }
> | null

type Gesture = Readonly<{
  pointerId: number
  clientX: number
  laneWidth: number
  kind: 'audio-move' | 'audio-start' | 'audio-end' | 'caption-move' | 'caption-start' | 'caption-end'
  id: string
  audio?: AudioClip
  caption?: CaptionClip
}>

type Draft = Readonly<{ kind: 'audio'; clip: AudioClip } | { kind: 'caption'; clip: CaptionClip }> | null

export interface MediaTimelineProps {
  project: ProjectDocument
  shot: Shot
  playhead: number
  selected: MediaSelection
  availableAssetIds?: ReadonlySet<string>
  disabled?: boolean
  onSelect(selection: MediaSelection): void
  onSeek(time: number): void
  onReplaceAudio(clip: AudioClip, label: string): boolean
  onReplaceCaption(clip: CaptionClip, label: string): boolean
  onDeleteAudio(id: string): boolean
  onDeleteCaption(id: string): boolean
  onAddAudioAsset(assetId: string, start: number): boolean
}

function boundedTime(value: number, minimum: number, maximum: number): number {
  return canonicalTimelineTime(Math.max(minimum, Math.min(maximum, value)))
}

function styleForSpan(start: number, end: number, duration: number): CSSProperties {
  return {
    left: `${start / duration * 100}%`,
    width: `${Math.max(0.75, (end - start) / duration * 100)}%`,
  }
}

/**
 * Shot-local media rows. Pointer edits are previews until pointer-up, then one
 * validated document transaction owns the change and one undo entry is made.
 */
export default function MediaTimeline({
  project,
  shot,
  playhead,
  selected,
  availableAssetIds,
  disabled = false,
  onSelect,
  onSeek,
  onReplaceAudio,
  onReplaceCaption,
  onDeleteAudio,
  onDeleteCaption,
  onAddAudioAsset,
}: MediaTimelineProps) {
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [draft, setDraft] = useState<Draft>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const draftRef = useRef<Draft>(null)
  const assets = useMemo(() => new Map(project.assets.map((asset) => [asset.id, asset])), [project.assets])

  const begin = (event: PointerEvent<HTMLElement>, next: Omit<Gesture, 'pointerId' | 'clientX' | 'laneWidth'>) => {
    event.stopPropagation()
    if (disabled || event.button !== 0 || event.isPrimary === false || gestureRef.current) return
    const lane = event.currentTarget.closest<HTMLElement>('[data-media-lane]')
    const value = { ...next, pointerId: event.pointerId, clientX: event.clientX, laneWidth: Math.max(1, lane?.clientWidth ?? 1) }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    gestureRef.current = value
    setGesture(value)
    const initial = value.audio ? { kind: 'audio' as const, clip: value.audio } : { kind: 'caption' as const, clip: value.caption! }
    draftRef.current = initial
    setDraft(initial)
  }

  const move = (event: PointerEvent<HTMLElement>) => {
    const active = gestureRef.current
    if (!active || event.pointerId !== active.pointerId) return
    const delta = (event.clientX - active.clientX) / active.laneWidth * shot.duration
    if (active.audio) {
      const clip = active.audio
      const sourceRate = (clip.sourceEnd - clip.sourceStart) / clip.duration
      const assetDuration = assets.get(clip.assetId)?.duration ?? clip.sourceEnd
      let next = clip
      if (active.kind === 'audio-move') {
        next = { ...clip, start: boundedTime(clip.start + delta, 0, shot.duration - clip.duration) }
      } else if (active.kind === 'audio-start') {
        const maximumDelta = Math.min(clip.duration - 0.01, (clip.sourceEnd - clip.sourceStart - 0.01) / sourceRate)
        const boundedDelta = Math.max(-Math.min(clip.start, clip.sourceStart / sourceRate), Math.min(maximumDelta, delta))
        next = {
          ...clip,
          start: canonicalTimelineTime(clip.start + boundedDelta),
          duration: canonicalTimelineTime(clip.duration - boundedDelta),
          sourceStart: canonicalTimelineTime(clip.sourceStart + boundedDelta * sourceRate),
        }
      } else if (active.kind === 'audio-end') {
        const maximumDelta = Math.min(shot.duration - clip.start - clip.duration, (assetDuration - clip.sourceEnd) / sourceRate)
        const boundedDelta = Math.max(-(clip.duration - 0.01), Math.min(maximumDelta, delta))
        next = {
          ...clip,
          duration: canonicalTimelineTime(clip.duration + boundedDelta),
          sourceEnd: canonicalTimelineTime(clip.sourceEnd + boundedDelta * sourceRate),
        }
      }
      const value = { kind: 'audio' as const, clip: next }
      draftRef.current = value
      setDraft(value)
      return
    }
    const clip = active.caption!
    const duration = clip.end - clip.start
    let next = clip
    if (active.kind === 'caption-move') {
      const start = boundedTime(clip.start + delta, 0, shot.duration - duration)
      next = { ...clip, start, end: canonicalTimelineTime(start + duration) }
    } else if (active.kind === 'caption-start') {
      next = { ...clip, start: boundedTime(clip.start + delta, 0, clip.end - 0.01) }
    } else if (active.kind === 'caption-end') {
      next = { ...clip, end: boundedTime(clip.end + delta, clip.start + 0.01, shot.duration) }
    }
    const value = { kind: 'caption' as const, clip: next }
    draftRef.current = value
    setDraft(value)
  }

  const finish = (event: PointerEvent<HTMLElement>) => {
    const active = gestureRef.current
    if (!active || event.pointerId !== active.pointerId) return
    const value = draftRef.current
    gestureRef.current = null
    draftRef.current = null
    setGesture(null)
    setDraft(null)
    if (!value) return
    if (value.kind === 'audio' && JSON.stringify(value.clip) !== JSON.stringify(active.audio)) {
      onReplaceAudio(value.clip, active.kind === 'audio-move' ? 'Move audio clip' : 'Trim audio clip')
    }
    if (value.kind === 'caption' && JSON.stringify(value.clip) !== JSON.stringify(active.caption)) {
      onReplaceCaption(value.clip, active.kind === 'caption-move' ? 'Move caption' : 'Trim caption')
    }
  }

  const cancel = (event: PointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return
    gestureRef.current = null
    draftRef.current = null
    setGesture(null)
    setDraft(null)
  }

  const keyboardMove = (event: KeyboardEvent<HTMLButtonElement>, kind: 'audio' | 'caption', id: string) => {
    if (disabled) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      kind === 'audio' ? onDeleteAudio(id) : onDeleteCaption(id)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = (event.key === 'ArrowLeft' ? -1 : 1) / project.settings.frameRate
    if (kind === 'audio') {
      const clip = shot.audioClips.find((candidate) => candidate.id === id)
      if (clip) onReplaceAudio({ ...clip, start: boundedTime(clip.start + delta, 0, shot.duration - clip.duration) }, 'Nudge audio clip')
    } else {
      const clip = shot.captionClips.find((candidate) => candidate.id === id)
      if (clip) {
        const duration = clip.end - clip.start
        const start = boundedTime(clip.start + delta, 0, shot.duration - duration)
        onReplaceCaption({ ...clip, start, end: canonicalTimelineTime(start + duration) }, 'Nudge caption')
      }
    }
  }

  const seek = (event: PointerEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || gesture) return
    const rect = event.currentTarget.getBoundingClientRect()
    onSeek(boundedTime((event.clientX - rect.left) / Math.max(1, rect.width) * shot.duration, 0, shot.duration))
  }

  const dropAudio = (event: DragEvent<HTMLElement>) => {
    const assetId = event.dataTransfer.getData(PROOFCANVAS_AUDIO_ASSET_MIME)
    if (!assetId || disabled) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    onAddAudioAsset(assetId, boundedTime((event.clientX - rect.left) / Math.max(1, rect.width) * shot.duration, 0, shot.duration))
  }

  const shownAudio = (clip: AudioClip) => draft?.kind === 'audio' && draft.clip.id === clip.id ? draft.clip : clip
  const shownCaption = (clip: CaptionClip) => draft?.kind === 'caption' && draft.clip.id === clip.id ? draft.clip : clip

  return <section className="pc-media-timeline" aria-label="Audio captions and markers timeline" data-gesture={gesture?.kind ?? 'none'}>
    <div className="pc-media-row">
      <div className="pc-media-label"><strong>Audio</strong><span>{shot.audioClips.length}</span></div>
      <div className="pc-media-lane pc-audio-lane" data-media-lane onPointerDown={seek} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onDragOver={(event) => { if (event.dataTransfer.types.includes(PROOFCANVAS_AUDIO_ASSET_MIME)) event.preventDefault() }} onDrop={dropAudio}>
        {shot.audioClips.map((source) => { const clip = shownAudio(source); return <button
          type="button"
          key={source.id}
          className="pc-media-clip pc-audio-clip"
          style={styleForSpan(clip.start, clip.start + clip.duration, shot.duration)}
          aria-label={`${clip.name} audio clip from ${clip.start} to ${clip.start + clip.duration} seconds`}
          aria-pressed={selected?.kind === 'audio' && selected.id === clip.id}
          disabled={disabled}
          data-audio-clip-id={clip.id}
          data-start={clip.start}
          data-duration={clip.duration}
          data-muted={clip.muted}
          data-solo={clip.solo}
          onClick={(event) => { event.stopPropagation(); onSelect({ kind: 'audio', id: clip.id }); onSeek(clip.start) }}
          onKeyDown={(event) => keyboardMove(event, 'audio', clip.id)}
          onPointerDown={(event) => begin(event, { kind: 'audio-move', id: clip.id, audio: source })}
        ><i className="pc-media-trim pc-media-trim-start" aria-hidden="true" onPointerDown={(event) => begin(event, { kind: 'audio-start', id: clip.id, audio: source })}/>{availableAssetIds === undefined || availableAssetIds.has(clip.assetId) ? <AudioWaveform projectId={project.metadata.id} assetId={clip.assetId} label={clip.name} buckets={48}/> : <span className="pc-waveform" data-waveform-state="missing" aria-label={`${clip.name} waveform unavailable`}>Asset unavailable</span>}<b>{clip.name}</b><small>{clip.duration.toFixed(2)}s</small><i className="pc-media-trim pc-media-trim-end" aria-hidden="true" onPointerDown={(event) => begin(event, { kind: 'audio-end', id: clip.id, audio: source })}/></button> })}
        {shot.audioClips.length === 0 && <span className="pc-media-empty">Drag audio here</span>}
      </div>
    </div>
    <div className="pc-media-row">
      <div className="pc-media-label"><strong>Captions</strong><span>{shot.captionClips.length}</span></div>
      <div className="pc-media-lane pc-caption-lane" data-media-lane onPointerDown={seek} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel}>
        {shot.captionClips.map((source) => { const clip = shownCaption(source); return <button
          type="button"
          key={source.id}
          className="pc-media-clip pc-caption-clip"
          style={styleForSpan(clip.start, clip.end, shot.duration)}
          aria-label={`Caption from ${clip.start} to ${clip.end} seconds: ${clip.text}`}
          aria-pressed={selected?.kind === 'caption' && selected.id === clip.id}
          disabled={disabled}
          data-caption-id={clip.id}
          onClick={(event) => { event.stopPropagation(); onSelect({ kind: 'caption', id: clip.id }); onSeek(clip.start) }}
          onKeyDown={(event) => keyboardMove(event, 'caption', clip.id)}
          onPointerDown={(event) => begin(event, { kind: 'caption-move', id: clip.id, caption: source })}
        ><i className="pc-media-trim pc-media-trim-start" aria-hidden="true" onPointerDown={(event) => begin(event, { kind: 'caption-start', id: clip.id, caption: source })}/><span>{clip.text.replaceAll('\n', ' / ')}</span><i className="pc-media-trim pc-media-trim-end" aria-hidden="true" onPointerDown={(event) => begin(event, { kind: 'caption-end', id: clip.id, caption: source })}/></button> })}
        {shot.captionClips.length === 0 && <span className="pc-media-empty">Create or import captions</span>}
      </div>
    </div>
    <div className="pc-media-row pc-marker-row">
      <div className="pc-media-label"><strong>Markers</strong><span>{shot.markers.length}</span></div>
      <div className="pc-media-lane pc-marker-lane" data-media-lane onPointerDown={seek}>
        {shot.markers.map((marker: TimelineMarker) => <button type="button" key={marker.id} className="pc-marker-pin" style={{ left: `${marker.time / shot.duration * 100}%`, '--pc-marker-color': marker.color } as CSSProperties} aria-label={`${marker.name} marker at ${marker.time} seconds`} aria-pressed={selected?.kind === 'marker' && selected.id === marker.id} disabled={disabled} onClick={(event) => { event.stopPropagation(); onSelect({ kind: 'marker', id: marker.id }); onSeek(marker.time) }}><i aria-hidden="true"/><span>{marker.name}</span></button>)}
      </div>
    </div>
    <div className="pc-media-playhead" aria-hidden="true" style={{ left: `calc(132px + ${(playhead / shot.duration) * (100 - 0)}%)` }}/>
  </section>
}
