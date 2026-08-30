import { applyOperations } from '../operations'
import { createCantorDemoProject } from '../demo'
import { StylePackSchema } from '../schema'
import {
  DEFAULT_STYLE_PACKS,
  EDITORIAL_INK_STYLE_ID,
  NOCTURNE_CHALK_STYLE_ID,
  NOCTURNE_CHALK_STYLE,
  SCIENTIFIC_MINIMAL_STYLE_ID,
  resolvedObjectColor,
} from '../styles'

test('ships the three required starting styles as materially differentiated systems', () => {
  const required = DEFAULT_STYLE_PACKS.filter(({ id }) => [
    EDITORIAL_INK_STYLE_ID,
    SCIENTIFIC_MINIMAL_STYLE_ID,
    NOCTURNE_CHALK_STYLE_ID,
  ].includes(id))
  expect(required.map(({ name }) => name)).toEqual(['Editorial Ink', 'Scientific Minimal', 'Nocturne Chalk'])
  required.forEach((style) => expect(StylePackSchema.parse(style)).toEqual(style))

  for (const projection of [
    (style: typeof required[number]) => style.typography,
    (style: typeof required[number]) => style.strokes,
    (style: typeof required[number]) => style.graph,
    (style: typeof required[number]) => style.annotation,
    (style: typeof required[number]) => style.spacing,
    (style: typeof required[number]) => style.layout,
    (style: typeof required[number]) => style.motion,
  ]) expect(new Set(required.map((style) => JSON.stringify(projection(style)))).size).toBe(3)
})

test('changing output style preserves mathematical content and authored geometry exactly', () => {
  const project = createCantorDemoProject()
  const changed = applyOperations(project, project.shots[0].id, [{ type: 'set-style', styleId: NOCTURNE_CHALK_STYLE_ID }]).project
  expect(changed.activeStyleId).toBe(NOCTURNE_CHALK_STYLE_ID)
  expect(changed.shots).toEqual(project.shots)
})

test('semantic text colours follow the active style while explicit user colour remains authoritative', () => {
  const project = createCantorDemoProject()
  const subtitle = project.shots[0].objects.find(({ id }) => id === 'object-subtitle')!
  const equation = project.shots[0].objects.find(({ id }) => id === 'object-equation-limit')!
  const explicit = { ...subtitle, style: { ...subtitle.style, color: '#123456' } }

  expect(resolvedObjectColor(subtitle, NOCTURNE_CHALK_STYLE)).toBe(NOCTURNE_CHALK_STYLE.colors.mutedInk)
  expect(resolvedObjectColor(equation, NOCTURNE_CHALK_STYLE)).toBe(NOCTURNE_CHALK_STYLE.colors.coolAccent)
  expect(resolvedObjectColor(explicit, NOCTURNE_CHALK_STYLE)).toBe('#123456')
})
