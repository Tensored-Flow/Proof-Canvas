'use client'

import type { ChangeEvent, FocusEvent, KeyboardEvent } from 'react'
import { StylePackSchema, type SceneObject, type StylePack } from '@/lib/proofcanvas/schema'

export interface StyleLabProps {
  styles: readonly StylePack[]
  activeStyleId: string
  selectedObject?: SceneObject
  disabled?: boolean
  canPasteObjectStyle?: boolean
  canResetPreset?: boolean
  onActivate(styleId: string, name: string): void
  onReplace(style: StylePack, label: string): boolean
  onDuplicate(styleId: string): void
  onSavePreset(styleId: string): void
  onResetPreset(styleId: string): void
  onImport(style: StylePack): void
  onExport(style: StylePack): void
  onCopyObjectStyle(): void
  onPasteObjectStyle(): void
  onResetObjectStyle(): void
  onNotice(message: string): void
}

function finiteValue(event: FocusEvent<HTMLInputElement>, fallback: number, minimum: number, maximum: number): number | null {
  const value = event.currentTarget.valueAsNumber
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    event.currentTarget.value = String(fallback)
    return null
  }
  return value
}

/** Full global style authority; style changes never rewrite authored mathematics or geometry. */
export default function StyleLab({
  styles,
  activeStyleId,
  selectedObject,
  disabled = false,
  canPasteObjectStyle = false,
  canResetPreset = false,
  onActivate,
  onReplace,
  onDuplicate,
  onSavePreset,
  onResetPreset,
  onImport,
  onExport,
  onCopyObjectStyle,
  onPasteObjectStyle,
  onResetObjectStyle,
  onNotice,
}: StyleLabProps) {
  const style = styles.find(({ id }) => id === activeStyleId) ?? styles[0]
  const caption = style.caption ?? { color: style.colors.background, background: style.colors.ink, fontFamily: style.typography.controls, fontSize: 30, position: 'bottom' as const, maxWidth: 0.84 }
  const replace = (next: StylePack, label: string) => {
    const parsed = StylePackSchema.safeParse(next)
    if (!parsed.success) {
      onNotice(`Style edit rejected: ${parsed.error.issues[0]?.message ?? 'invalid style data'}`)
      return false
    }
    return onReplace(parsed.data, label)
  }
  const textValue = (event: FocusEvent<HTMLInputElement>, current: string, label: string, commit: (value: string) => boolean) => {
    const value = event.currentTarget.value.trim()
    if (!value) {
      event.currentTarget.value = current
      onNotice(`${label} cannot be empty.`)
      return false
    }
    if (value === current) return true
    if (commit(value)) return true
    event.currentTarget.value = current
    return false
  }
  const numberField = (label: string, value: number, minimum: number, maximum: number, commit: (next: number) => void, step = 0.05) => <label>{label}<input type="number" min={minimum} max={maximum} step={step} defaultValue={value} key={`${style.id}-${label}-${value}`} disabled={disabled} onBlur={(event) => { const next = finiteValue(event, value, minimum, maximum); if (next !== null && next !== value) commit(next) }}/></label>
  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    if (file.size > 128 * 1024) {
      onNotice('Style JSON must be 128 KB or smaller.')
      return
    }
    try {
      onImport(StylePackSchema.parse(JSON.parse(await file.text())))
    } catch (error) {
      onNotice(error instanceof Error ? `Style import failed: ${error.message}` : 'Style import failed.')
    }
  }
  const navigatePresets = (event: KeyboardEvent<HTMLButtonElement>, currentId: string) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const index = styles.findIndex(({ id }) => id === currentId)
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
    const next = styles[(index + delta + styles.length) % styles.length]
    const group = event.currentTarget.parentElement
    onActivate(next.id, next.name)
    window.requestAnimationFrame(() => group?.querySelector<HTMLElement>(`[data-style-id="${next.id}"]`)?.focus())
  }

  return <div className="pc-style-lab" aria-label="Style Lab">
    <div className="pc-style-presets" role="radiogroup" aria-label="Library output styles">{styles.map((candidate) => <button type="button" role="radio" aria-checked={candidate.id === activeStyleId} tabIndex={candidate.id === activeStyleId ? 0 : -1} key={candidate.id} disabled={disabled} data-style-surface="library" data-style-id={candidate.id} onKeyDown={(event) => navigatePresets(event, candidate.id)} onClick={() => onActivate(candidate.id, candidate.name)}><i style={{ background: `linear-gradient(135deg, ${candidate.colors.background} 0 48%, ${candidate.colors.coolAccent} 48% 72%, ${candidate.colors.warmAccent} 72%)` }}/><span><b>{candidate.name}</b><small>{candidate.layout.tendency.replaceAll('-', ' ')} · {candidate.motion.easing}</small></span></button>)}</div>
    <div className="pc-style-lab-actions"><button type="button" disabled={disabled} onClick={() => onDuplicate(style.id)}>Duplicate</button><button type="button" disabled={disabled} onClick={() => onSavePreset(style.id)}>Save as preset</button><button type="button" disabled={disabled || !canResetPreset} onClick={() => onResetPreset(style.id)}>Reset preset</button><button type="button" onClick={() => onExport(style)}>Export JSON</button><label className="pc-file-label">Import JSON<input type="file" accept="application/json,.json" disabled={disabled} aria-label="Import style JSON" onChange={(event) => void importJson(event)}/></label></div>
    <label className="pc-style-name">Style name<input maxLength={80} key={`${style.id}-${style.name}`} defaultValue={style.name} disabled={disabled} onBlur={(event) => { textValue(event, style.name, 'Style name', (name) => replace({ ...style, name, origin: 'custom' }, 'Rename style')) }}/></label>

    <details open><summary>Colour system</summary><div className="pc-style-field-grid">{(Object.keys(style.colors) as Array<keyof StylePack['colors']>).map((key) => <label key={key}>{key.replace(/([A-Z])/g, ' $1')}<input type="color" value={style.colors[key]} disabled={disabled} onChange={(event) => replace({ ...style, origin: 'custom', colors: { ...style.colors, [key]: event.target.value } }, `Set style ${key}`)}/></label>)}</div></details>
    <details><summary>Typography</summary><div className="pc-style-field-grid"><label className="pc-wide">Statement family<input key={`${style.id}-statement-${style.typography.statement}`} defaultValue={style.typography.statement} maxLength={120} disabled={disabled} onBlur={(event) => { textValue(event, style.typography.statement, 'Statement family', (statement) => replace({ ...style, origin: 'custom', typography: { ...style.typography, statement } }, 'Set statement typography')) }}/></label><label className="pc-wide">Controls family<input key={`${style.id}-controls-${style.typography.controls}`} defaultValue={style.typography.controls} maxLength={120} disabled={disabled} onBlur={(event) => { textValue(event, style.typography.controls, 'Controls family', (controls) => replace({ ...style, origin: 'custom', typography: { ...style.typography, controls } }, 'Set control typography')) }}/></label><label className="pc-wide">Math family<input key={`${style.id}-math-${style.typography.math}`} defaultValue={style.typography.math} maxLength={120} disabled={disabled} onBlur={(event) => { textValue(event, style.typography.math, 'Math family', (math) => replace({ ...style, origin: 'custom', typography: { ...style.typography, math } }, 'Set math typography')) }}/></label>{numberField('Title scale', style.typography.titleScale, 0.25, 4, (titleScale) => replace({ ...style, origin: 'custom', typography: { ...style.typography, titleScale } }, 'Set title scale'))}{numberField('Body scale', style.typography.bodyScale, 0.25, 4, (bodyScale) => replace({ ...style, origin: 'custom', typography: { ...style.typography, bodyScale } }, 'Set body scale'))}</div></details>
    <details><summary>Spacing & dimensions</summary><div className="pc-style-field-grid">{numberField('Spacing unit', style.spacing.unit, 0.05, 512, (unit) => replace({ ...style, origin: 'custom', spacing: { ...style.spacing, unit } }, 'Set spacing unit'))}{numberField('Canvas margin', style.spacing.margin, 0, 512, (margin) => replace({ ...style, origin: 'custom', spacing: { ...style.spacing, margin } }, 'Set canvas margin'), 1)}{numberField('Object gap', style.spacing.objectGap, 0, 512, (objectGap) => replace({ ...style, origin: 'custom', spacing: { ...style.spacing, objectGap } }, 'Set object gap'), 1)}{numberField('Panel radius', style.corners.panel, 0, 256, (panel) => replace({ ...style, origin: 'custom', corners: { ...style.corners, panel } }, 'Set panel radius'), 1)}{numberField('Object radius', style.corners.object, 0, 256, (object) => replace({ ...style, origin: 'custom', corners: { ...style.corners, object } }, 'Set object radius'), 1)}</div></details>
    <details><summary>Lines, graph & annotations</summary><div className="pc-style-field-grid">{numberField('Fine stroke', style.strokes.fine, 0, 64, (fine) => replace({ ...style, origin: 'custom', strokes: { ...style.strokes, fine } }, 'Set fine stroke'))}{numberField('Regular stroke', style.strokes.regular, 0, 64, (regular) => replace({ ...style, origin: 'custom', strokes: { ...style.strokes, regular } }, 'Set regular stroke'))}{numberField('Emphasis stroke', style.strokes.emphasis, 0, 64, (emphasis) => replace({ ...style, origin: 'custom', strokes: { ...style.strokes, emphasis } }, 'Set emphasis stroke'))}{numberField('Grid opacity', style.graph.gridOpacity, 0, 1, (gridOpacity) => replace({ ...style, origin: 'custom', graph: { ...style.graph, gridOpacity } }, 'Set grid opacity'))}{numberField('Axis weight', style.graph.axisWeight, 0, 64, (axisWeight) => replace({ ...style, origin: 'custom', graph: { ...style.graph, axisWeight } }, 'Set axis weight'))}{numberField('Curve weight', style.graph.curveWeight, 0, 64, (curveWeight) => replace({ ...style, origin: 'custom', graph: { ...style.graph, curveWeight } }, 'Set curve weight'))}<label>Annotation<select value={style.annotation.treatment} disabled={disabled} onChange={(event) => replace({ ...style, origin: 'custom', annotation: { ...style.annotation, treatment: event.target.value as StylePack['annotation']['treatment'] } }, 'Set annotation treatment')}><option value="plain">Plain</option><option value="marginal-hand">Marginal hand</option></select></label><label className="pc-wide">Annotation family<input key={`${style.id}-annotation-family-${style.annotation.fontFamily ?? style.typography.statement}`} defaultValue={style.annotation.fontFamily ?? style.typography.statement} maxLength={120} disabled={disabled} onBlur={(event) => { const current = style.annotation.fontFamily ?? style.typography.statement; textValue(event, current, 'Annotation family', (fontFamily) => replace({ ...style, origin: 'custom', annotation: { ...style.annotation, fontFamily } }, 'Set annotation typography')) }}/></label>{numberField('Annotation offset', style.annotation.offset, -8192, 8192, (offset) => replace({ ...style, origin: 'custom', annotation: { ...style.annotation, offset } }, 'Set annotation offset'), 1)}{numberField('Roughness', style.annotation.roughness, 0, 1, (roughness) => replace({ ...style, origin: 'custom', annotation: { ...style.annotation, roughness } }, 'Set annotation roughness'))}</div></details>
    <details><summary>Composition & motion</summary><div className="pc-style-field-grid"><label>Tendency<select value={style.layout.tendency} disabled={disabled} onChange={(event) => replace({ ...style, origin: 'custom', layout: { ...style.layout, tendency: event.target.value as StylePack['layout']['tendency'] } }, 'Set composition tendency')}><option value="centred">Centred</option><option value="editorial-asymmetric">Editorial asymmetric</option><option value="chalkboard-column">Chalkboard column</option></select></label><label>Title anchor<select value={style.layout.titleAnchor} disabled={disabled} onChange={(event) => replace({ ...style, origin: 'custom', layout: { ...style.layout, titleAnchor: event.target.value as StylePack['layout']['titleAnchor'] } }, 'Set title anchor')}><option value="center">Center</option><option value="upper-left">Upper left</option><option value="upper-center">Upper center</option></select></label>{numberField('Hierarchy contrast', style.layout.hierarchyContrast, 0.25, 8, (hierarchyContrast) => replace({ ...style, origin: 'custom', layout: { ...style.layout, hierarchyContrast } }, 'Set hierarchy contrast'))}{numberField('Default duration', style.motion.defaultDuration, 0.05, 300, (defaultDuration) => replace({ ...style, origin: 'custom', motion: { ...style.motion, defaultDuration } }, 'Set default motion duration'))}<label>Default easing<select value={style.motion.easing} disabled={disabled} onChange={(event) => replace({ ...style, origin: 'custom', motion: { ...style.motion, easing: event.target.value as StylePack['motion']['easing'] } }, 'Set default easing')}>{['linear', 'ease-in', 'ease-out', 'ease-in-out', 'editorial', 'spring-soft', 'there-and-back'].map((value) => <option key={value}>{value}</option>)}</select></label>{numberField('Camera max pan', style.motion.cameraMaxPan, 0, 8192, (cameraMaxPan) => replace({ ...style, origin: 'custom', motion: { ...style.motion, cameraMaxPan } }, 'Set camera pan default'), 1)}{numberField('Camera max zoom', style.motion.cameraMaxZoom, 1, 20, (cameraMaxZoom) => replace({ ...style, origin: 'custom', motion: { ...style.motion, cameraMaxZoom } }, 'Set camera zoom default'))}</div></details>
    <details><summary>Caption treatment</summary><div className="pc-style-field-grid"><label>Text<input type="color" value={caption.color} disabled={disabled} onChange={(event) => replace({ ...style, origin: 'custom', caption: { ...caption, color: event.target.value } }, 'Set caption text colour')}/></label><label>Background<input type="color" value={caption.background} disabled={disabled} onChange={(event) => replace({ ...style, origin: 'custom', caption: { ...caption, background: event.target.value } }, 'Set caption background')}/></label><label className="pc-wide">Font family<input key={`${style.id}-caption-family-${caption.fontFamily}`} defaultValue={caption.fontFamily} maxLength={120} disabled={disabled} onBlur={(event) => { textValue(event, caption.fontFamily, 'Caption font family', (fontFamily) => replace({ ...style, origin: 'custom', caption: { ...caption, fontFamily } }, 'Set caption typography')) }}/></label>{numberField('Font size', caption.fontSize, 8, 144, (fontSize) => replace({ ...style, origin: 'custom', caption: { ...caption, fontSize } }, 'Set caption font size'), 1)}<label>Position<select value={caption.position} disabled={disabled} onChange={(event) => replace({ ...style, origin: 'custom', caption: { ...caption, position: event.target.value as typeof caption.position } }, 'Set caption position')}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label>{numberField('Maximum width', caption.maxWidth, 0.4, 1, (maxWidth) => replace({ ...style, origin: 'custom', caption: { ...caption, maxWidth } }, 'Set caption width'), 0.01)}</div></details>
    <section className="pc-object-style-tools"><strong>Per-object style</strong>{selectedObject ? <><span>{selectedObject.name}</span><div><button type="button" disabled={disabled} onClick={onCopyObjectStyle}>Copy</button><button type="button" disabled={disabled || !canPasteObjectStyle} onClick={onPasteObjectStyle}>Paste</button><button type="button" disabled={disabled} onClick={onResetObjectStyle}>Reset to style</button></div></> : <p>Select an object to copy, paste, or reset its override.</p>}</section>
  </div>
}
