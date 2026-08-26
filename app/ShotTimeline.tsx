'use client'

import { useMemo, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import {
  chooseTimelineRulerInterval,
  copyKeyframes,
  iterateTimelineRulerMarks,
  projectEditorTimelineRows,
  resolveDeleteKeyframes,
  resolveDuplicateKeyframes,
  resolveMoveKeyframes,
  resolvePasteKeyframes,
  snapTimelineTime,
  timelineTicksForFrameDelta,
  type TimelineKeyframeClipboard,
  type TimelineOperationIntent,
} from '@/lib/proofcanvas/editorTimeline'
import { keyframeSelection, objectSelection, type EditorKeyframeRef, type EditorSelection } from '@/lib/proofcanvas/editorSelection'
import { frameToSeconds } from '@/lib/proofcanvas/frame'
import type { ProjectDocument, PropertyTrack, Shot } from '@/lib/proofcanvas/schema'
import { effectiveObjectLifetime, orderedPropertyTracks, propertyTrackTargetKey } from '@/lib/proofcanvas/timeline'

const ZOOM_OPTIONS = [70, 110, 160] as const

function refKey(ref: EditorKeyframeRef): string {
  return `${ref.trackId}\u0000${ref.keyframeId}`
}

function targetLabel(shot: Shot, track: PropertyTrack): string {
  const target = track.target
  if (target.kind === 'camera') return 'Camera'
  if (target.kind === 'audio') return shot.audioClips.find(({ id }) => id === target.audioClipId)?.name ?? target.audioClipId
  return shot.objects.find(({ id }) => id === target.objectId)?.name ?? target.objectId
}

export interface ShotTimelineProps {
  project: ProjectDocument
  shot: Shot
  projectRevision: string
  playhead: number
  selection: EditorSelection
  disabled?: boolean
  onSeek(time: number): void
  onSelect(selection: EditorSelection): void
  onCommit(intent: TimelineOperationIntent): boolean
  onNotice(message: string): void
}

/** Layered property timeline backed directly by the active schema-v4 shot. */
export default function ShotTimeline({ project, shot, projectRevision, playhead, selection, disabled = false, onSeek, onSelect, onCommit, onNotice }: ShotTimelineProps) {
  const [pixelsPerSecond, setPixelsPerSecond] = useState<(typeof ZOOM_OPTIONS)[number]>(110)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [clipboard, setClipboard] = useState<TimelineKeyframeClipboard | null>(null)
  const timelineWidth = Math.max(760, shot.duration * pixelsPerSecond)
  const viewport = { start: 0, end: shot.duration, widthPx: timelineWidth }
  const interval = chooseTimelineRulerInterval(viewport, project.settings.frameRate, 72)
  const marks = [...iterateTimelineRulerMarks(viewport, project.settings.frameRate, interval.frameStep)]
  const tracks = useMemo(() => orderedPropertyTracks(shot).filter(({ target }) => target.kind !== 'audio'), [shot])
  const rows = useMemo(() => projectEditorTimelineRows(shot), [shot])
  const selectedRefs = selection.kind === 'keyframes' && selection.shotId === shot.id ? selection.keyframes : []
  const selectedSet = new Set(selectedRefs.map(refKey))
  const primaryRef = selection.kind === 'keyframes' && selection.shotId === shot.id ? selection.primaryKeyframe : undefined
  const candidates = [
    { id: 'shot-start', kind: 'shot-edge' as const, time: 0 },
    { id: 'shot-end', kind: 'shot-edge' as const, time: shot.duration },
    { id: 'playhead', kind: 'playhead' as const, time: playhead },
    ...shot.objects.flatMap((object) => {
      const lifetime = effectiveObjectLifetime(shot, object.id)
      return lifetime ? [
        { id: `${object.id}-start`, kind: 'lifetime-edge' as const, time: lifetime.start },
        { id: `${object.id}-end`, kind: 'lifetime-edge' as const, time: lifetime.end },
      ] : []
    }),
    ...tracks.flatMap((track) => track.keyframes.map((keyframe) => ({ id: keyframe.id, kind: 'keyframe' as const, time: keyframe.time }))),
  ]

  const seekFromLane = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest('button')) return
    const rect = event.currentTarget.getBoundingClientRect()
    const raw = Math.max(0, Math.min(shot.duration, (event.clientX - rect.left) / Math.max(1, rect.width) * shot.duration))
    const frame = frameToSeconds(Math.round(raw * project.settings.frameRate), project.settings.frameRate)
    const resolved = snapTimelineTime({
      time: raw,
      viewport,
      candidates: [...candidates, { id: `frame-${Math.round(raw * project.settings.frameRate)}`, kind: 'frame', time: frame }],
      enabled: snapEnabled,
    })
    onSeek(resolved.time)
  }

  const selectionForRef = (ref: EditorKeyframeRef, shiftKey: boolean): EditorSelection => {
    if (!shiftKey) return keyframeSelection(shot, [ref], ref)
    const exists = selectedSet.has(refKey(ref))
    const refs = exists ? selectedRefs.filter((candidate) => refKey(candidate) !== refKey(ref)) : [...selectedRefs, ref]
    return keyframeSelection(shot, refs, exists && primaryRef && refKey(primaryRef) === refKey(ref) ? refs.at(-1) : ref)
  }

  const activeRefs = (fallback?: EditorKeyframeRef): readonly EditorKeyframeRef[] => selectedRefs.length ? selectedRefs : fallback ? [fallback] : []
  const moveByFrame = (delta: -1 | 1, fallback?: EditorKeyframeRef) => {
    if (disabled) return
    const refs = activeRefs(fallback)
    if (!refs.length) return
    const anchor = primaryRef && refs.some((ref) => refKey(ref) === refKey(primaryRef)) ? primaryRef : refs.at(-1)!
    const located = shot.propertyTracks.find(({ id }) => id === anchor.trackId)?.keyframes.find(({ id }) => id === anchor.keyframeId)
    if (!located) return
    onCommit(resolveMoveKeyframes(project, shot.id, refs, timelineTicksForFrameDelta(located.time, delta, project.settings.frameRate), anchor))
  }
  const deleteSelection = (fallback?: EditorKeyframeRef) => {
    if (!disabled) onCommit(resolveDeleteKeyframes(project, shot.id, activeRefs(fallback)))
  }
  const duplicateSelection = (fallback?: EditorKeyframeRef) => {
    if (disabled) return
    const refs = activeRefs(fallback)
    if (!refs.length) return
    const anchor = primaryRef && refs.some((ref) => refKey(ref) === refKey(primaryRef)) ? primaryRef : refs.at(-1)!
    const located = shot.propertyTracks.find(({ id }) => id === anchor.trackId)?.keyframes.find(({ id }) => id === anchor.keyframeId)
    if (!located) return
    onCommit(resolveDuplicateKeyframes(project, shot.id, refs, timelineTicksForFrameDelta(located.time, 1, project.settings.frameRate), anchor))
  }
  const copySelection = (fallback?: EditorKeyframeRef) => {
    const copied = copyKeyframes(project, shot.id, activeRefs(fallback), primaryRef)
    if ('entries' in copied) {
      setClipboard(copied)
      onNotice(`Copied ${copied.entries.length} keyframe${copied.entries.length === 1 ? '' : 's'}.`)
    } else onNotice(copied.message)
  }
  const pasteSelection = () => {
    if (disabled) return
    if (!clipboard) return onNotice('Copy keyframes before pasting.')
    onCommit(resolvePasteKeyframes(project, shot.id, clipboard, playhead))
  }
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, ref: EditorKeyframeRef) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation(); moveByFrame(event.key === 'ArrowLeft' ? -1 : 1, ref)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault(); event.stopPropagation(); deleteSelection(ref)
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault(); event.stopPropagation(); copySelection(ref)
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault(); event.stopPropagation(); duplicateSelection(ref)
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      event.preventDefault(); event.stopPropagation(); pasteSelection()
    }
  }

  const renderTrackRow = (track: PropertyTrack, depth = 0) => <div className="pc-shot-timeline-row pc-property-row" key={track.id} data-track-id={track.id} data-track-target={propertyTrackTargetKey(track.target)}>
    <div className="pc-shot-track-label" style={{ paddingLeft: 12 + depth * 12 }}><span>{track.property}</span><small>{targetLabel(shot, track)}</small></div>
    <div className="pc-shot-track-lane" style={{ width: timelineWidth }} onClick={seekFromLane}>
      {track.keyframes.map((keyframe) => {
        const ref = { trackId: track.id, keyframeId: keyframe.id }
        const selected = selectedSet.has(refKey(ref))
        const primary = Boolean(primaryRef && refKey(primaryRef) === refKey(ref))
        return <button
          type="button"
          key={keyframe.id}
          className="pc-timeline-key"
          data-keyframe-id={keyframe.id}
          data-key-state={primary || selected ? 'filled' : 'hollow'}
          style={{ left: `${keyframe.time / shot.duration * 100}%` }}
          aria-label={`${track.property} keyframe at ${keyframe.time} seconds`}
          aria-pressed={selected}
          disabled={disabled}
          onClick={(event) => { event.stopPropagation(); onSelect(selectionForRef(ref, event.shiftKey)); onSeek(keyframe.time) }}
          onKeyDown={(event) => keyDown(event, ref)}
        ><span aria-hidden="true">◆</span></button>
      })}
    </div>
  </div>

  return <section className="pc-shot-timeline" aria-label="Shot property timeline" data-project-revision={projectRevision} data-snap={snapEnabled ? 'on' : 'off'}>
    <header className="pc-shot-timeline-toolbar">
      <div><strong>Property timeline</strong><span>{shot.duration.toFixed(2)}s · {project.settings.frameRate} fps</span></div>
      <label>Zoom<select aria-label="Timeline zoom" value={pixelsPerSecond} onChange={(event) => setPixelsPerSecond(Number(event.currentTarget.value) as typeof pixelsPerSecond)}>{ZOOM_OPTIONS.map((zoom) => <option value={zoom} key={zoom}>{zoom}px/s</option>)}</select></label>
      <button type="button" aria-pressed={snapEnabled} onClick={() => setSnapEnabled((value) => !value)}>Snap {snapEnabled ? 'on' : 'off'}</button>
      <div className="pc-key-actions" aria-label="Keyframe actions">
        <button type="button" disabled={!selectedRefs.length || disabled} onClick={() => moveByFrame(-1)} aria-label="Move selected keyframes one frame earlier">− frame</button>
        <button type="button" disabled={!selectedRefs.length || disabled} onClick={() => moveByFrame(1)} aria-label="Move selected keyframes one frame later">+ frame</button>
        <button type="button" disabled={!selectedRefs.length} onClick={() => copySelection()}>Copy</button>
        <button type="button" disabled={!clipboard || disabled} onClick={pasteSelection}>Paste</button>
        <button type="button" aria-label="Duplicate selected keyframes" disabled={!selectedRefs.length || disabled} onClick={() => duplicateSelection()}>Duplicate</button>
        <button type="button" aria-label="Delete selected keyframes" disabled={!selectedRefs.length || disabled} onClick={() => deleteSelection()}>Delete</button>
      </div>
    </header>
    <div className="pc-shot-timeline-scroll" tabIndex={0} aria-label="Scrollable shot timeline">
      <div className="pc-shot-timeline-grid" style={{ '--pc-shot-timeline-width': `${timelineWidth}px` } as CSSProperties}>
        <div className="pc-shot-timeline-row pc-ruler-row">
          <div className="pc-shot-track-label"><strong>Time</strong></div>
          <div className="pc-shot-track-lane pc-ruler" style={{ width: timelineWidth }} onClick={seekFromLane}>
            {marks.map((mark) => <span key={mark.frameIndex} style={{ left: `${mark.time / shot.duration * 100}%` }}><i/><small>{mark.time.toFixed(mark.time < 10 ? 2 : 1)}s</small></span>)}
          </div>
        </div>
        <div className="pc-timeline-boundary pc-timeline-boundary-start" aria-hidden="true"/>
        <div className="pc-timeline-boundary pc-timeline-boundary-end" style={{ left: `calc(180px + ${timelineWidth}px)` }} aria-hidden="true"/>
        <div className="pc-property-playhead" style={{ left: `calc(180px + ${playhead / shot.duration * timelineWidth}px)` }} aria-hidden="true"><span>{playhead.toFixed(2)}</span></div>
        {rows.map((row) => {
          if (row.kind === 'camera') return <div key={row.id} className="pc-shot-timeline-group-title">Camera</div>
          if (row.kind === 'camera-property') return renderTrackRow(row.track)
          if (row.kind === 'object-property') return renderTrackRow(row.track, row.depth + 1)
          const object = shot.objects.find(({ id }) => id === row.objectId)!
          return <div className="pc-shot-timeline-row pc-lifetime-row" key={row.id} data-timeline-object-id={object.id} data-depth={row.depth} data-lifetime-mode={row.authored ? 'custom' : object.parentId ? 'inherited' : 'entire'}>
            <button type="button" className="pc-shot-track-label" style={{ paddingLeft: 8 + row.depth * 12 }} onClick={() => onSelect(objectSelection(shot, [object.id]))}><span>{object.name}</span><small>{row.authored ? 'Custom lifetime' : object.parentId ? 'Inherited lifetime' : 'Entire shot'}</small></button>
            <div className="pc-shot-track-lane" style={{ width: timelineWidth }} onClick={seekFromLane}>
              <button type="button" className="pc-lifetime-bar" style={{ left: `${row.effective.start / shot.duration * 100}%`, width: `${(row.effective.end - row.effective.start) / shot.duration * 100}%` }} onClick={(event) => { event.stopPropagation(); onSelect(objectSelection(shot, [object.id])) }} aria-label={`${object.name} lifetime ${row.effective.start} to ${row.effective.end} seconds; select object to edit exact bounds`}><span>{row.effective.start.toFixed(2)}–{row.effective.end.toFixed(2)}</span></button>
            </div>
          </div>
        })}
      </div>
    </div>
  </section>
}
