'use client'

import { useEffect, useState, type FocusEvent, type ReactNode } from 'react'
import { keyframeAtTimelineTime, resolveUpsertKeyframe, type TimelineOperationIntent } from '@/lib/proofcanvas/editorTimeline'
import type { EditorKeyframeRef, EditorSelection } from '@/lib/proofcanvas/editorSelection'
import type { ProjectDocument, PropertyKeyframe, PropertyTrack, PropertyTrackTarget } from '@/lib/proofcanvas/schema'

export interface PropertyKeyframeFieldProps {
  project: ProjectDocument
  shotId: string
  target: PropertyTrackTarget
  property: PropertyTrack['property']
  label: string
  value: PropertyKeyframe['value']
  playhead: number
  track?: PropertyTrack
  selection: EditorSelection
  disabled?: boolean
  inputType?: 'number' | 'color'
  min?: number
  max?: number
  minMagnitude?: number
  step?: number | string
  children?: ReactNode
  onCommit(intent: TimelineOperationIntent): boolean
  onBaseChange(value: PropertyKeyframe['value']): boolean
  onSelectKeyframe(ref: EditorKeyframeRef): void
  onNotice(message: string): void
}

function sameRef(left: EditorKeyframeRef, right: EditorKeyframeRef): boolean {
  return left.trackId === right.trackId && left.keyframeId === right.keyframeId
}

/**
 * One property field and its canonical keyframe toggle. When a track exists,
 * edits author a key at the playhead; base-pose mutation is used only before a
 * track exists.
 */
export default function PropertyKeyframeField({
  project,
  shotId,
  target,
  property,
  label,
  value,
  playhead,
  track,
  selection,
  disabled = false,
  inputType = 'number',
  min,
  max,
  minMagnitude,
  step = inputType === 'number' ? 0.1 : undefined,
  children,
  onCommit,
  onBaseChange,
  onSelectKeyframe,
  onNotice,
}: PropertyKeyframeFieldProps) {
  const [draftValue, setDraftValue] = useState(String(value))
  const [inputRevision, setInputRevision] = useState(0)
  useEffect(() => { setDraftValue(String(value)) }, [playhead, track?.id, value])
  const exactRef = track ? keyframeAtTimelineTime(project.shots.find(({ id }) => id === shotId)!, track.id, playhead) : undefined
  const selected = Boolean(exactRef && selection.kind === 'keyframes' && selection.shotId === shotId && selection.keyframes.some((ref) => sameRef(ref, exactRef)))
  const keyState = exactRef ? selected ? 'filled' : 'hollow' : 'empty'
  const restoreValue = () => {
    const needsForcedRemount = draftValue === String(value)
    setDraftValue(String(value))
    if (needsForcedRemount) setInputRevision((revision) => revision + 1)
  }

  const applyValue = (next: PropertyKeyframe['value']): boolean => {
    if (disabled) return false
    if (next === value) return true
    if (track) {
      return onCommit(resolveUpsertKeyframe(project, shotId, { target, property, time: playhead, value: next }))
    }
    return onBaseChange(next)
  }

  const commitInput = (event: FocusEvent<HTMLInputElement>) => {
    if (inputType === 'color') {
      if (!applyValue(event.currentTarget.value)) restoreValue()
      return
    }
    const next = Number(event.currentTarget.value)
    if (!Number.isFinite(next) || (min !== undefined && next < min) || (max !== undefined && next > max) || (minMagnitude !== undefined && Math.abs(next) < minMagnitude)) {
      restoreValue()
      const magnitude = minMagnitude === undefined ? '' : ` with magnitude at least ${minMagnitude}`
      onNotice(min !== undefined && max !== undefined ? `${label} must be between ${min} and ${max}${magnitude}.` : `${label} must be a finite value.`)
      return
    }
    if (!applyValue(next)) restoreValue()
  }

  const addOrSelectKey = () => {
    if (disabled) return
    if (exactRef) {
      onSelectKeyframe(exactRef)
      return
    }
    onCommit(resolveUpsertKeyframe(project, shotId, { target, property, time: playhead, value }))
  }

  return <label className="pc-keyframe-field" data-property={property} data-track-state={track ? 'tracked' : 'base'}>
    <span>{label}</span>
    <span className="pc-keyframe-field-control">
      <input
        key={`${track?.id ?? 'base'}-${property}-${String(value)}-${playhead}-${inputRevision}`}
        type={inputType}
        aria-label={label}
        value={draftValue}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setDraftValue(event.currentTarget.value)}
        onBlur={commitInput}
      />
      <button
        type="button"
        className="pc-keyframe-toggle"
        data-key-state={keyState}
        aria-label={exactRef ? `${selected ? 'Selected' : 'Select'} ${label} keyframe at ${playhead} seconds` : `Add ${label} keyframe at ${playhead} seconds`}
        aria-pressed={selected}
        disabled={disabled}
        onClick={addOrSelectKey}
      ><span aria-hidden="true">◆</span></button>
    </span>
    {children}
  </label>
}
