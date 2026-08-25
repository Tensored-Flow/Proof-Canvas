'use client'

import { useState, type FocusEvent } from 'react'
import {
  adjacentKeyframeRef,
  findEditorKeyframe,
  resolveDeleteKeyframes,
  resolveMoveKeyframes,
  resolveSetKeyframeInterpolation,
  resolveUpsertKeyframe,
  type TimelineOperationIntent,
} from '@/lib/proofcanvas/editorTimeline'
import type { EditorKeyframeRef, EditorSelection } from '@/lib/proofcanvas/editorSelection'
import { timelineTickFor } from '@/lib/proofcanvas/frame'
import type { KeyframeInterpolation, ProjectDocument, Shot } from '@/lib/proofcanvas/schema'

const INTERPOLATION_OPTIONS = [
  ['hold', 'Hold'],
  ['linear', 'Linear'],
  ['ease-in', 'Ease in'],
  ['ease-out', 'Ease out'],
  ['ease-in-out', 'Ease in out'],
  ['editorial', 'Editorial'],
  ['there-and-back', 'There and back'],
  ['spring-soft', 'Spring soft'],
  ['custom-bezier', 'Custom cubic'],
] as const

function interpolationOption(interpolation: KeyframeInterpolation): string {
  if (interpolation.kind === 'eased') return interpolation.easing
  return interpolation.kind
}

function optionInterpolation(value: string): KeyframeInterpolation {
  if (value === 'hold') return { kind: 'hold' }
  if (value === 'linear') return { kind: 'linear' }
  if (value === 'custom-bezier') return { kind: 'custom-bezier', curve: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } }
  return { kind: 'eased', easing: value as Extract<KeyframeInterpolation, { kind: 'eased' }>['easing'] }
}

export interface KeyframeInspectorProps {
  project: ProjectDocument
  shot: Shot
  selection: Extract<EditorSelection, { kind: 'keyframes' }>
  disabled?: boolean
  onCommit(intent: TimelineOperationIntent): boolean
  onSelect(ref: EditorKeyframeRef): void
  onSeek(time: number): void
  onNotice(message: string): void
}

export default function KeyframeInspector({ project, shot, selection, disabled = false, onCommit, onSelect, onSeek, onNotice }: KeyframeInspectorProps) {
  const [inputRevision, setInputRevision] = useState(0)
  const located = findEditorKeyframe(shot, selection.primaryKeyframe)
  if (!located) return <section className="pc-keyframe-inspector" aria-label="Keyframe inspector"><p role="status">The selected keyframe no longer exists.</p></section>
  const { track, keyframe } = located
  const curve = keyframe.interpolation.kind === 'custom-bezier'
    ? keyframe.interpolation.curve
    : { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }
  const outgoingSelectionCount = selection.keyframes.reduce((count, ref) => {
    const candidate = findEditorKeyframe(shot, ref)
    return count + (candidate && candidate.track.keyframes.at(-1)?.id !== candidate.keyframe.id ? 1 : 0)
  }, 0)
  const hasOutgoingSelection = outgoingSelectionCount > 0
  const resetInspectorInputs = () => setInputRevision((revision) => revision + 1)
  const navigate = (direction: 'previous' | 'next') => {
    const ref = adjacentKeyframeRef(shot, selection.primaryKeyframe, direction)
    if (!ref) return
    const destination = findEditorKeyframe(shot, ref)!
    onSelect(ref)
    onSeek(destination.keyframe.time)
  }
  const commitTime = (event: FocusEvent<HTMLInputElement>) => {
    const next = Number(event.currentTarget.value)
    if (!Number.isFinite(next)) {
      resetInspectorInputs()
      onNotice('Keyframe time must be finite.')
      return
    }
    try {
      const deltaTicks = timelineTickFor(next) - timelineTickFor(keyframe.time)
      if (!deltaTicks) {
        resetInspectorInputs()
        return
      }
      if (!onCommit(resolveMoveKeyframes(project, shot.id, selection, deltaTicks, selection.primaryKeyframe))) {
        resetInspectorInputs()
      }
    } catch {
      resetInspectorInputs()
      onNotice('Keyframe time must be within the authored timeline range.')
    }
  }
  const commitValue = (event: FocusEvent<HTMLInputElement>) => {
    const next = typeof keyframe.value === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value
    if (typeof next === 'number' && !Number.isFinite(next)) {
      resetInspectorInputs()
      onNotice('Keyframe value must be finite.')
      return
    }
    if (next === keyframe.value) return
    if (!onCommit(resolveUpsertKeyframe(project, shot.id, {
      target: track.target,
      property: track.property,
      time: keyframe.time,
      value: next,
      interpolation: keyframe.interpolation,
    }))) resetInspectorInputs()
  }
  const restoreCurve = (form: HTMLFormElement) => {
    for (const point of ['x1', 'y1', 'x2', 'y2'] as const) {
      const input = form.elements.namedItem(`curve-${point}`)
      if (input instanceof HTMLInputElement) input.value = String(curve[point])
    }
    resetInspectorInputs()
  }
  const commitCurve = (event: FocusEvent<HTMLInputElement>) => {
    const form = event.currentTarget.form
    if (!form) return
    const data = new FormData(form)
    const nextCurve = {
      x1: Number(data.get('curve-x1')),
      y1: Number(data.get('curve-y1')),
      x2: Number(data.get('curve-x2')),
      y2: Number(data.get('curve-y2')),
    }
    if (
      Object.values(nextCurve).some((value) => !Number.isFinite(value))
      || nextCurve.x1 < 0 || nextCurve.x1 > 1
      || nextCurve.x2 < 0 || nextCurve.x2 > 1
      || nextCurve.y1 < -4 || nextCurve.y1 > 4
      || nextCurve.y2 < -4 || nextCurve.y2 > 4
    ) {
      restoreCurve(form)
      onNotice('Custom cubic X controls must be between 0 and 1, and Y controls between -4 and 4.')
      return
    }
    if (!onCommit(resolveSetKeyframeInterpolation(project, shot.id, selection, { kind: 'custom-bezier', curve: nextCurve }, selection.primaryKeyframe))) restoreCurve(form)
  }
  return <section className="pc-keyframe-inspector" aria-label="Keyframe inspector" data-selected-keyframe-id={keyframe.id}>
    <div className="pc-section-heading"><h2>{selection.keyframes.length > 1 ? `${selection.keyframes.length} keyframes` : `${track.property} keyframe`}</h2><span>{keyframe.time.toFixed(4)}s</span></div>
    <p className="pc-inspector-note">Interpolation controls the outgoing segment from each selected keyframe. {!hasOutgoingSelection && 'The selected terminal keyframe has no outgoing segment.'}</p>
    <div className="pc-keyframe-nav">
      <button type="button" onClick={() => navigate('previous')} disabled={!adjacentKeyframeRef(shot, selection.primaryKeyframe, 'previous')} aria-label="Select previous keyframe">Previous</button>
      <button type="button" onClick={() => navigate('next')} disabled={!adjacentKeyframeRef(shot, selection.primaryKeyframe, 'next')} aria-label="Select next keyframe">Next</button>
    </div>
    <label>Time<input type="number" min="0" max={shot.duration} step="any" aria-label="Keyframe time" defaultValue={keyframe.time} key={`${keyframe.id}-time-${keyframe.time}-${inputRevision}`} disabled={disabled} onBlur={commitTime}/></label>
    <label>Value<input type={typeof keyframe.value === 'string' ? 'color' : 'number'} step="any" aria-label="Keyframe value" defaultValue={keyframe.value} key={`${keyframe.id}-value-${String(keyframe.value)}-${inputRevision}`} disabled={disabled} onBlur={commitValue}/></label>
    <label>Outgoing interpolation<select key={`${keyframe.id}-interpolation-${inputRevision}`} aria-label="Outgoing interpolation" value={interpolationOption(keyframe.interpolation)} disabled={disabled || !hasOutgoingSelection} onChange={(event) => { if (!onCommit(resolveSetKeyframeInterpolation(project, shot.id, selection, optionInterpolation(event.currentTarget.value), selection.primaryKeyframe))) resetInspectorInputs() }}>{INTERPOLATION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {keyframe.interpolation.kind === 'custom-bezier' && <form className="pc-cubic-editor" aria-label="Custom cubic bezier" onSubmit={(event) => event.preventDefault()}>
      {(['x1', 'y1', 'x2', 'y2'] as const).map((point) => <label key={point}>{point.toUpperCase()}<input key={`${keyframe.id}-${point}-${inputRevision}`} name={`curve-${point}`} type="number" min={point.startsWith('x') ? 0 : -4} max={point.startsWith('x') ? 1 : 4} step="0.01" defaultValue={curve[point]} disabled={disabled || !hasOutgoingSelection} onBlur={commitCurve}/></label>)}
    </form>}
    <button type="button" className="pc-danger-action" disabled={disabled} onClick={() => onCommit(resolveDeleteKeyframes(project, shot.id, selection.keyframes))}>Remove {selection.keyframes.length === 1 ? 'keyframe' : 'keyframes'}</button>
  </section>
}
