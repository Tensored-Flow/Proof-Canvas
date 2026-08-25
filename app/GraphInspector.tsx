'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { GRAPH_EXPRESSION_LIMITS, analyzeGraphExpression, formatGraphExpression, parseGraphExpression } from '@/lib/proofcanvas/graphExpression'
import { PROOFCANVAS_SCHEMA_LIMITS, type RestrictedExpression } from '@/lib/proofcanvas/schema'

export interface GraphDraftValue {
  expression: RestrictedExpression
  xMin: number
  xMax: number
}

export interface GraphInspectorProps {
  objectId: string
  value: GraphDraftValue
  authorityKey: string
  disabled?: boolean
  onCommit(value: GraphDraftValue, baseAuthorityKey: string): boolean
  onNotice(message: string): void
}

type Draft = Readonly<{ expressionText: string; xMinText: string; xMaxText: string }>

function draftFor(value: GraphDraftValue): Draft {
  return {
    expressionText: formatGraphExpression(value.expression),
    xMinText: String(value.xMin),
    xMaxText: String(value.xMax),
  }
}

function sameValue(left: GraphDraftValue, right: GraphDraftValue): boolean {
  return JSON.stringify(left.expression) === JSON.stringify(right.expression)
    && left.xMin === right.xMin
    && left.xMax === right.xMax
}

/** Atomic draft boundary for the complete graph expression/domain contract. */
export default function GraphInspector({
  objectId,
  value,
  authorityKey,
  disabled = false,
  onCommit,
  onNotice,
}: GraphInspectorProps) {
  const diagnosticId = useId()
  const draftStateId = useId()
  const [draft, setDraft] = useState<Draft>(() => draftFor(value))
  const [dirty, setDirty] = useState(false)
  const editAuthorityRef = useRef(authorityKey)
  const objectIdRef = useRef(objectId)
  const valueKey = `${JSON.stringify(value.expression)}\u0000${value.xMin}\u0000${value.xMax}`
  const parsedDraft = useMemo(() => {
    const parsed = parseGraphExpression(draft.expressionText)
    if (!parsed.ok) return { ok: false as const, message: parsed.diagnostic.message }
    const xMin = draft.xMinText.trim() === '' ? Number.NaN : Number(draft.xMinText)
    const xMax = draft.xMaxText.trim() === '' ? Number.NaN : Number(draft.xMaxText)
    const analysis = analyzeGraphExpression(parsed.expression, xMin, xMax)
    if (!analysis.ok) return { ok: false as const, message: analysis.diagnostics[0]?.message ?? 'Graph geometry is invalid.', analysis }
    return {
      ok: true as const,
      value: { expression: parsed.expression, xMin, xMax },
      analysis,
    }
  }, [draft])
  const stale = dirty && editAuthorityRef.current !== authorityKey

  useEffect(() => {
    if (objectIdRef.current !== objectId) {
      objectIdRef.current = objectId
      editAuthorityRef.current = authorityKey
      setDraft(draftFor(value))
      setDirty(false)
      return
    }
    if (!dirty) {
      editAuthorityRef.current = authorityKey
      setDraft(draftFor(value))
    }
  // valueKey is the stable serialized graph authority.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorityKey, dirty, objectId, valueKey])

  useEffect(() => {
    if (stale) onNotice('The graph draft is stale because the project changed. Discard it before editing again.')
  }, [onNotice, stale])

  const change = (patch: Partial<Draft>) => {
    if (!dirty) editAuthorityRef.current = authorityKey
    setDraft((current) => ({ ...current, ...patch }))
    setDirty(true)
  }

  const applyDraft = () => {
    if (!dirty || stale || disabled || !parsedDraft.ok) return
    if (sameValue(parsedDraft.value, value)) {
      setDraft(draftFor(value))
      setDirty(false)
      editAuthorityRef.current = authorityKey
      onNotice('The graph draft already matches the project.')
      return
    }
    if (onCommit(parsedDraft.value, editAuthorityRef.current)) setDirty(false)
  }

  const discardDraft = () => {
    setDraft(draftFor(value))
    setDirty(false)
    editAuthorityRef.current = authorityKey
    onNotice('Discarded the graph draft.')
  }

  const draftState = stale
    ? 'This draft is stale because the project changed. Discard it before editing again.'
    : disabled && dirty ? 'This draft is not applied. Pause playback or unlock the object to continue.'
      : dirty ? 'Draft only — choose Apply to add one history entry, or Discard to restore the project value.'
        : 'Project value — editing creates a local draft.'

  return <fieldset className="pc-graph-properties pc-wide">
    <legend>Function graph</legend>
    <label>Expression<textarea
      aria-label="Graph expression"
      aria-describedby={`${draftStateId}${!parsedDraft.ok ? ` ${diagnosticId}` : ''}`}
      aria-invalid={!parsedDraft.ok}
      rows={3}
      maxLength={GRAPH_EXPRESSION_LIMITS.sourceChars}
      value={draft.expressionText}
      disabled={disabled || stale}
      onChange={(event) => change({ expressionText: event.target.value })}
    /></label>
    <div className="pc-graph-domain-fields">
      <label>X minimum<input
        type="number"
        min={-PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude}
        max={PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude}
        step="any"
        aria-label="Graph X minimum"
        value={draft.xMinText}
        disabled={disabled || stale}
        onChange={(event) => change({ xMinText: event.target.value })}
      /></label>
      <label>X maximum<input
        type="number"
        min={-PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude}
        max={PROOFCANVAS_SCHEMA_LIMITS.graphRangeMagnitude}
        step="any"
        aria-label="Graph X maximum"
        value={draft.xMaxText}
        disabled={disabled || stale}
        onChange={(event) => change({ xMaxText: event.target.value })}
      /></label>
    </div>
    {!parsedDraft.ok && <p id={diagnosticId} className="pc-field-error" role="alert">{parsedDraft.message}</p>}
    {parsedDraft.ok && <p className="pc-graph-analysis" role="status" data-graph-analysis-hash={parsedDraft.analysis.analysisHash}>
      {parsedDraft.analysis.normalizedSegments.length} safe segment{parsedDraft.analysis.normalizedSegments.length === 1 ? '' : 's'} · {parsedDraft.analysis.evaluations} bounded samples · {parsedDraft.analysis.analysisHash}
      {parsedDraft.analysis.diagnostics.length > 0 && ` · ${parsedDraft.analysis.diagnostics.map(({ message }) => message).join(' ')}`}
    </p>}
    <p id={draftStateId} className="pc-graph-draft-state" role="status">{draftState}</p>
    <div className="pc-graph-draft-actions">
      <button type="button" onClick={applyDraft} disabled={!dirty || stale || disabled || !parsedDraft.ok}>Apply graph draft</button>
      <button type="button" onClick={discardDraft} disabled={!dirty}>Discard graph draft</button>
    </div>
    <p className="pc-inspector-note">Use x, finite numbers, +, -, *, /, integer powers from -8 to 8, and sin, cos, or abs. Preview and export use the same bounded literal segments and never execute expression text.</p>
  </fieldset>
}
