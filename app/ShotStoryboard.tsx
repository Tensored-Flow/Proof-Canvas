'use client'

import { memo, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CanvasThumbnail } from './CanvasStage'
import { previewShotAtTime } from '@/lib/proofcanvas/preview'
import { PROOFCANVAS_SCHEMA_LIMITS, type ProjectDocument, type Shot, type StylePack } from '@/lib/proofcanvas/schema'
import { type EditorShotAction, type EditorShotSequence } from '@/lib/proofcanvas/editorShotSequence'

export type StoryboardActionResult = Readonly<{
  ok: boolean
  activeShotId: string
}>

type StoryboardDialogKind = 'rename' | 'duration' | 'delete'

export interface ShotStoryboardProps {
  project: ProjectDocument
  activeShotId: string
  previewStyle: StylePack
  sequence: EditorShotSequence
  disabled?: boolean
  onActivate(shotId: string): boolean
  onCommitAction(action: EditorShotAction): StoryboardActionResult
  onSplitActive(): StoryboardActionResult
  onRequestDialog(kind: StoryboardDialogKind, shotId: string, trigger: HTMLElement): void
}

function compactTime(value: number): string {
  return `${value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}s`
}

export function shotThumbnailVisualRevision(
  shot: Shot,
  style: StylePack,
  aspectRatio: ProjectDocument['settings']['aspectRatio'],
): string {
  return JSON.stringify({
    aspectRatio,
    style,
    camera: shot.camera,
    objects: shot.objects,
    animations: shot.animations,
    propertyTracks: shot.propertyTracks,
  })
}

const StoryboardCard = memo(function StoryboardCard({
  project,
  shot,
  index,
  globalStart,
  active,
  previewStyle,
  visualRevision,
  cardRef,
  onClick,
  onKeyDown,
}: {
  project: ProjectDocument
  shot: Shot
  index: number
  globalStart: number
  active: boolean
  previewStyle: StylePack
  visualRevision: string
  orderedShotRevision: string
  cardRef(element: HTMLButtonElement | null): void
  onClick(): void
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void
}) {
  const emptyAtStart = useMemo(
    () => !previewShotAtTime(shot, 0).objects.some(({ preview }) => preview.opacity > 0.001),
    [shot],
  )
  const number = String(index + 1).padStart(2, '0')
  const label = `Shot ${index + 1}, ${shot.name}, duration ${compactTime(shot.duration)}, starts at ${compactTime(globalStart)}${emptyAtStart ? ', empty at start' : ''}`
  return <button
    ref={cardRef}
    type="button"
    role="tab"
    id={`pc-shot-tab-${shot.id}`}
    aria-controls="pc-active-shot-panel"
    aria-label={label}
    aria-selected={active}
    tabIndex={active ? 0 : -1}
    className="pc-storyboard-card"
    data-shot-id={shot.id}
    data-shot-index={index}
    data-shot-start={globalStart}
    data-shot-duration={shot.duration}
    onClick={onClick}
    onKeyDown={onKeyDown}
  >
    <span className="pc-storyboard-thumbnail-wrap" aria-hidden="true">
      <CanvasThumbnail aspectRatio={project.settings.aspectRatio} shot={shot} previewStyle={previewStyle} visualRevision={visualRevision}/>
      {emptyAtStart && <span className="pc-storyboard-empty">Empty at 0s</span>}
    </span>
    <span className="pc-storyboard-card-meta"><b>{number}</b><strong>{shot.name}</strong><small>{compactTime(shot.duration)}</small></span>
    <span className="pc-storyboard-start">Starts {compactTime(globalStart)}</span>
  </button>
}, (previous, next) => previous.active === next.active
  && previous.index === next.index
  && previous.globalStart === next.globalStart
  && previous.orderedShotRevision === next.orderedShotRevision
  && previous.visualRevision === next.visualRevision
  && previous.shot.name === next.shot.name
  && previous.shot.duration === next.shot.duration)

export default memo(function ShotStoryboard({ project, activeShotId, previewStyle, sequence, disabled = false, onActivate, onCommitAction, onSplitActive, onRequestDialog }: ShotStoryboardProps) {
  const cardRefs = useRef(new Map<string, HTMLButtonElement>())
  const actionBarRef = useRef<HTMLDivElement | null>(null)
  const activeIndex = project.shots.findIndex(({ id }) => id === activeShotId)
  const activeShot = project.shots[activeIndex] ?? project.shots[0]
  const atShotLimit = project.shots.length >= PROOFCANVAS_SCHEMA_LIMITS.shots
  const oneShot = project.shots.length === 1
  const previousShot = activeIndex > 0 ? project.shots[activeIndex - 1] : null
  const nextShot = activeIndex >= 0 && activeIndex < project.shots.length - 1 ? project.shots[activeIndex + 1] : null
  const orderedShotRevision = project.shots.map(({ id }) => id).join('\u0000')

  const focusCard = (shotId: string) => {
    requestAnimationFrame(() => {
      const card = cardRefs.current.get(shotId)
      card?.focus({ preventScroll: true })
      card?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    })
  }
  const activateAndFocus = (shotId: string) => {
    if (onActivate(shotId)) focusCard(shotId)
  }
  const commitAndFocus = (action: EditorShotAction) => {
    if (disabled) return
    const result = onCommitAction(action)
    if (result.ok) focusCard(result.activeShotId)
  }
  const navigate = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'F2') {
      event.preventDefault()
      event.stopPropagation()
      if (!disabled) onRequestDialog('rename', project.shots[index].id, event.currentTarget)
      return
    }
    if (event.shiftKey && event.key === 'F10') {
      event.preventDefault()
      event.stopPropagation()
      actionBarRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const targetIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? project.shots.length - 1
        : event.key === 'ArrowLeft' ? Math.max(0, index - 1)
          : Math.min(project.shots.length - 1, index + 1)
    activateAndFocus(project.shots[targetIndex].id)
  }

  return <section className="pc-storyboard" aria-labelledby="pc-storyboard-heading">
    <div className="pc-storyboard-heading">
      <div><span>Sequence</span><h2 id="pc-storyboard-heading">Storyboard</h2></div>
      <p>{project.shots.length}/{PROOFCANVAS_SCHEMA_LIMITS.shots} shots · {compactTime(sequence.totalDuration)} total</p>
      <button type="button" onClick={() => commitAndFocus({ type: 'add-shot' })} disabled={disabled || atShotLimit} aria-describedby={disabled ? 'pc-storyboard-playback-reason' : atShotLimit ? 'pc-shot-limit-reason' : undefined}>Add shot</button>
      {atShotLimit && <span id="pc-shot-limit-reason" className="pc-visually-hidden">A project can contain at most {PROOFCANVAS_SCHEMA_LIMITS.shots} shots.</span>}
      {disabled && <span id="pc-storyboard-playback-reason" className="pc-visually-hidden">Pause sequence playback before changing the storyboard.</span>}
    </div>
    <div className="pc-storyboard-list" role="tablist" aria-label="Shots" aria-orientation="horizontal">
      {project.shots.map((candidate, index) => {
        const entry = sequence.entries[index]
        const visualRevision = shotThumbnailVisualRevision(candidate, previewStyle, project.settings.aspectRatio)
        return <StoryboardCard
          key={candidate.id}
          project={project}
          shot={candidate}
          index={index}
          globalStart={entry.start}
          active={candidate.id === activeShotId}
          previewStyle={previewStyle}
          visualRevision={visualRevision}
          orderedShotRevision={orderedShotRevision}
          cardRef={(element) => { if (element) cardRefs.current.set(candidate.id, element); else cardRefs.current.delete(candidate.id) }}
          onClick={() => { onActivate(candidate.id) }}
          onKeyDown={(event) => navigate(event, index)}
        />
      })}
    </div>
    <div ref={actionBarRef} className="pc-storyboard-actions" role="toolbar" aria-label={`Actions for ${activeShot.name}`}>
      <button type="button" onClick={() => commitAndFocus({ type: 'duplicate-shot', shotId: activeShot.id })} disabled={disabled || atShotLimit} aria-describedby={disabled ? 'pc-storyboard-playback-reason' : atShotLimit ? 'pc-shot-limit-reason' : undefined}>Duplicate</button>
      <button type="button" onClick={(event) => { if (!disabled) onRequestDialog('rename', activeShot.id, event.currentTarget) }} disabled={disabled} aria-describedby={disabled ? 'pc-storyboard-playback-reason' : undefined}>Rename</button>
      <button type="button" onClick={() => commitAndFocus({ type: 'reorder-shot', shotId: activeShot.id, index: activeIndex - 1 })} disabled={disabled || !previousShot} aria-describedby={disabled ? 'pc-storyboard-playback-reason' : !previousShot ? 'pc-shot-first-reason' : undefined}>Earlier</button>
      <button type="button" onClick={() => commitAndFocus({ type: 'reorder-shot', shotId: activeShot.id, index: activeIndex + 1 })} disabled={disabled || !nextShot} aria-describedby={disabled ? 'pc-storyboard-playback-reason' : !nextShot ? 'pc-shot-last-reason' : undefined}>Later</button>
      <button type="button" onClick={() => { if (disabled) return; const result = onSplitActive(); if (result.ok) focusCard(result.activeShotId) }} disabled={disabled || atShotLimit} aria-describedby={disabled ? 'pc-storyboard-playback-reason' : atShotLimit ? 'pc-shot-limit-reason' : undefined}>Split at playhead</button>
      <button type="button" onClick={() => previousShot && commitAndFocus({ type: 'merge-shots', leftShotId: previousShot.id, rightShotId: activeShot.id })} disabled={disabled || !previousShot} aria-describedby={disabled ? 'pc-storyboard-playback-reason' : !previousShot ? 'pc-shot-no-previous-reason' : undefined}>Merge previous</button>
      <button type="button" onClick={() => nextShot && commitAndFocus({ type: 'merge-shots', leftShotId: activeShot.id, rightShotId: nextShot.id })} disabled={disabled || !nextShot} aria-describedby={disabled ? 'pc-storyboard-playback-reason' : !nextShot ? 'pc-shot-no-next-reason' : undefined}>Merge next</button>
      <button type="button" onClick={(event) => { if (!disabled) onRequestDialog('duration', activeShot.id, event.currentTarget) }} disabled={disabled} aria-describedby={disabled ? 'pc-storyboard-playback-reason' : undefined}>Duration</button>
      <button type="button" className="pc-danger-action" onClick={(event) => { if (!disabled) onRequestDialog('delete', activeShot.id, event.currentTarget) }} disabled={disabled || oneShot} aria-describedby={disabled ? 'pc-storyboard-playback-reason' : oneShot ? 'pc-shot-one-reason' : undefined}>Delete</button>
      {!previousShot && <><span id="pc-shot-first-reason" className="pc-visually-hidden">This shot is already first.</span><span id="pc-shot-no-previous-reason" className="pc-visually-hidden">There is no previous shot to merge.</span></>}
      {!nextShot && <><span id="pc-shot-last-reason" className="pc-visually-hidden">This shot is already last.</span><span id="pc-shot-no-next-reason" className="pc-visually-hidden">There is no next shot to merge.</span></>}
      {oneShot && <span id="pc-shot-one-reason" className="pc-visually-hidden">A project must keep at least one shot.</span>}
    </div>
  </section>
})
