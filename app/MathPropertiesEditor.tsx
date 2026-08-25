'use client'

import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { PROOFCANVAS_LATEX_MAX_CHARS, analyzeLatex, type MathProperties } from '@/lib/proofcanvas/latex'

export interface MathPropertiesEditorProps {
  objectId: string
  value: MathProperties
  authorityKey: string
  disabled?: boolean
  onCommit(value: MathProperties, baseAuthorityKey: string): boolean
  onNotice(message: string): void
}

function sameMathProperties(left: MathProperties, right: MathProperties): boolean {
  return left.content === right.content && left.renderer === right.renderer && left.mode === right.mode
}

/**
 * Controlled draft boundary: invalid LaTeX remains inspectable in the field,
 * while only a validated whole math contract may cross into project history.
 */
export default function MathPropertiesEditor({
  objectId,
  value,
  authorityKey,
  disabled = false,
  onCommit,
  onNotice,
}: MathPropertiesEditorProps) {
  const errorId = useId()
  const draftStateId = useId()
  const [draft, setDraft] = useState<MathProperties>(value)
  const [dirty, setDirty] = useState(false)
  const editAuthorityRef = useRef(authorityKey)
  const objectIdRef = useRef(objectId)
  const valueKey = `${value.renderer}\u0000${value.mode}\u0000${value.content}`
  const analysis = useMemo(() => analyzeLatex(draft.content, { renderer: draft.renderer }), [draft.content, draft.renderer])
  const stale = dirty && editAuthorityRef.current !== authorityKey

  useEffect(() => {
    if (objectIdRef.current !== objectId) {
      objectIdRef.current = objectId
      editAuthorityRef.current = authorityKey
      setDraft(value)
      setDirty(false)
      return
    }
    if (!dirty) {
      editAuthorityRef.current = authorityKey
      setDraft(value)
    }
  // valueKey is the stable serialized contract; depending on the helper's
  // freshly allocated object would re-run this synchronization every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorityKey, dirty, objectId, valueKey])

  useEffect(() => {
    if (stale) onNotice('The mathematical draft is stale because the project changed. Discard it before editing again.')
  }, [onNotice, stale])

  const beginEdit = () => {
    if (!dirty) editAuthorityRef.current = authorityKey
  }
  const applyDraft = () => {
    if (!dirty || stale || disabled || !analysis.ok) return
    if (sameMathProperties(draft, value)) {
      setDraft(value)
      setDirty(false)
      editAuthorityRef.current = authorityKey
      onNotice('The mathematical draft already matches the project.')
      return
    }
    if (onCommit(draft, editAuthorityRef.current)) setDirty(false)
  }

  const discardDraft = () => {
    setDraft(value)
    setDirty(false)
    editAuthorityRef.current = authorityKey
    onNotice('Discarded the mathematical draft.')
  }

  const select = (field: 'renderer' | 'mode') => (event: ChangeEvent<HTMLSelectElement>) => {
    beginEdit()
    const candidate = { ...draft, [field]: event.target.value } as MathProperties
    setDraft(candidate)
    setDirty(true)
  }

  const draftState = stale
    ? 'This draft is stale because the project changed. Discard it before editing again.'
    : disabled && dirty ? 'This draft is not applied. Pause playback or unlock the object to continue.'
      : dirty ? 'Draft only — choose Apply to add one history entry, or Discard to restore the project value.'
        : 'Project value — editing creates a local draft.'

  return <fieldset className="pc-math-properties pc-wide">
    <legend>Mathematical content</legend>
    <div className="pc-math-contract-fields">
      <label>Renderer<select aria-label="Math renderer" value={draft.renderer} disabled={disabled || stale} onChange={select('renderer')}><option value="mathtex">MathTex</option><option value="tex">Tex</option></select></label>
      <label>Mode<select aria-label="Math mode" value={draft.mode} disabled={disabled || stale} onChange={select('mode')}><option value="display">Display</option><option value="inline">Inline</option></select></label>
    </div>
    <label>Content<textarea
      aria-label="Math content"
      aria-describedby={`${draftStateId}${!analysis.ok ? ` ${errorId}` : ''}`}
      aria-invalid={!analysis.ok}
      rows={3}
      maxLength={PROOFCANVAS_LATEX_MAX_CHARS}
      value={draft.content}
      disabled={disabled || stale}
      onChange={(event) => { beginEdit(); setDraft({ ...draft, content: event.target.value }); setDirty(true) }}
    /></label>
    {!analysis.ok && <p id={errorId} className="pc-field-error" role="alert">{analysis.message}</p>}
    <p id={draftStateId} className="pc-math-draft-state" role="status">{draftState}</p>
    <div className="pc-math-draft-actions">
      <button type="button" onClick={applyDraft} disabled={!dirty || stale || disabled || !analysis.ok}>Apply math draft</button>
      <button type="button" onClick={discardDraft} disabled={!dirty}>Discard math draft</button>
    </div>
    <p className="pc-inspector-note">MathTex authors equations; Tex authors ordinary LaTeX text. Display and inline are distinct in preview, while export reports the bounded Manim layout difference for inline content.</p>
  </fieldset>
}
