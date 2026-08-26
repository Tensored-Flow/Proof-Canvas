import { analyzeProjectAuthoringTransition, projectGraphAuthoringIssues } from '../authoringPolicy'
import { compileManim } from '../compiler'
import { createCantorDemoProject } from '../demo'
import { applyDocumentOperations } from '../documentOperations'
import { analyzeGraphExpression } from '../graphExpression'
import { redoAuthoringHistory, undoAuthoringHistory, type ProjectHistory } from '../history'
import { applyOperations } from '../operations'
import { PROJECT_SCHEMA_VERSION, ProjectDocumentSchema, cloneSerializable, type ProjectDocument, type SceneObject } from '../schema'

function graphObject(expression: SceneObject['properties']['expression'] = { kind: 'power', base: { kind: 'variable' }, exponent: 2 }): SceneObject {
  return {
    id: 'object-graph-authority',
    type: 'graph',
    name: 'Authority graph',
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 240, height: 140, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { stroke: '#315866', strokeWidth: 2 },
    properties: { expression, xMin: -2, xMax: 2 },
  }
}

function projectWithGraph(expression?: SceneObject['properties']['expression']): ProjectDocument {
  const project = cloneSerializable(createCantorDemoProject())
  const shot = project.shots[0]
  shot.objects = [graphObject(expression)]
  shot.animations = []
  shot.propertyTracks = []
  shot.audioClips = []
  shot.captionClips = []
  shot.markers = []
  project.shots = [shot]
  return ProjectDocumentSchema.parse(project)
}

const undefinedExpression = {
  kind: 'divide' as const,
  left: { kind: 'constant' as const, value: 1 },
  right: { kind: 'constant' as const, value: 0 },
}

describe('graph authoring compatibility and compiler truth', () => {
  test('keeps legacy-invalid graph authority loadable and allows unrelated edits, valid repair, or deletion', () => {
    const legacy = projectWithGraph(undefinedExpression)
    expect(legacy.schemaVersion).toBe(PROJECT_SCHEMA_VERSION)
    expect(projectGraphAuthoringIssues(legacy)).toEqual([
      expect.objectContaining({ code: 'GRAPH_CONSTANT_DIVISION_BY_ZERO', objectId: 'object-graph-authority' }),
    ])

    const unrelated = applyOperations(legacy, legacy.shots[0].id, [{
      type: 'update-object', objectId: 'object-graph-authority', patch: { name: 'Renamed invalid legacy graph' },
    }]).project
    expect(unrelated.shots[0].objects[0].name).toBe('Renamed invalid legacy graph')

    const renamedProject = applyDocumentOperations(legacy, [{ type: 'rename-project', title: 'Legacy graph project' }]).project
    expect(renamedProject.metadata.title).toBe('Legacy graph project')

    const repaired = applyOperations(legacy, legacy.shots[0].id, [{
      type: 'update-object', objectId: 'object-graph-authority', patch: { properties: { expression: { kind: 'variable' } } },
    }]).project
    expect(projectGraphAuthoringIssues(repaired)).toEqual([])

    const withSibling = cloneSerializable(legacy)
    withSibling.shots[0].objects.push({ ...graphObject({ kind: 'variable' }), id: 'object-graph-sibling', name: 'Sibling graph' })
    const parsedSibling = ProjectDocumentSchema.parse(withSibling)
    const deleted = applyOperations(parsedSibling, parsedSibling.shots[0].id, [{ type: 'delete-object', objectId: 'object-graph-authority' }]).project
    expect(projectGraphAuthoringIssues(deleted)).toEqual([])
  })

  test('rejects introducing, worsening, or replacing one invalid graph authority at manual and document seams', () => {
    const valid = projectWithGraph()
    expect(() => applyOperations(valid, valid.shots[0].id, [{
      type: 'update-object', objectId: 'object-graph-authority', patch: { properties: { expression: undefinedExpression } },
    }])).toThrow(/introduce renderer-rejected GRAPH_CONSTANT_DIVISION_BY_ZERO/)

    const legacy = projectWithGraph(undefinedExpression)
    expect(() => applyOperations(legacy, legacy.shots[0].id, [{
      type: 'update-object', objectId: 'object-graph-authority', patch: { properties: { expression: { kind: 'power', base: { kind: 'constant', value: 0 }, exponent: 0 } } },
    }])).toThrow(/cannot be modified while it remains invalid/)

    const direct = cloneSerializable(valid)
    direct.shots[0].objects[0].properties.expression = undefinedExpression
    expect(analyzeProjectAuthoringTransition(valid, ProjectDocumentSchema.parse(direct))).toMatchObject({
      allowed: false,
      reason: 'introduced-graph-authority',
    })
  })

  test('blocks undo and redo before a repaired document can restore invalid legacy authority', () => {
    const legacy = projectWithGraph(undefinedExpression)
    const repaired = applyOperations(legacy, legacy.shots[0].id, [{
      type: 'update-object', objectId: 'object-graph-authority', patch: { properties: { expression: { kind: 'variable' } } },
    }]).project
    const undoHistory: ProjectHistory = {
      past: [{ label: 'Repair legacy graph', project: legacy }],
      present: repaired,
      future: [],
    }
    const blockedUndo = undoAuthoringHistory(undoHistory)
    expect(blockedUndo).toEqual(expect.objectContaining({
      ok: false,
      history: undoHistory,
      message: expect.stringContaining('introduce renderer-rejected GRAPH_CONSTANT_DIVISION_BY_ZERO'),
    }))

    const redoHistory: ProjectHistory = {
      past: [],
      present: repaired,
      future: [{ label: 'Restore legacy graph', project: legacy }],
    }
    const blockedRedo = redoAuthoringHistory(redoHistory)
    expect(blockedRedo).toEqual(expect.objectContaining({
      ok: false,
      history: redoHistory,
      message: expect.stringContaining('introduce renderer-rejected GRAPH_CONSTANT_DIVISION_BY_ZERO'),
    }))
  })

  test('compiles exact shared literal geometry without lambda, FunctionGraph, or double stretch', () => {
    const project = projectWithGraph()
    const object = project.shots[0].objects[0]
    const expected = analyzeGraphExpression(object.properties.expression, Number(object.properties.xMin), Number(object.properties.xMax))
    const result = compileManim(project)
    const evidence = result.diagnostics.find(({ code }) => code === 'GRAPH_GEOMETRY_DERIVED')
    expect(evidence).toEqual(expect.objectContaining({
      severity: 'info',
      objectId: 'object-graph-authority',
      analysisHash: expected.analysisHash,
      segmentCount: expected.normalizedSegments.length,
    }))
    expect(result.python).toContain('VGroup(VMobject().set_points_as_corners([')
    expect(result.python).not.toContain('FunctionGraph')
    expect(result.python).not.toContain('lambda x:')
    expect(result.python).not.toMatch(/pc_authority_graph\.stretch_to_fit_(?:width|height)/)
  })

  test('emits a stable blocking diagnostic and an expression-free empty primitive for fatal legacy input', () => {
    const result = compileManim(projectWithGraph(undefinedExpression))
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        code: 'GRAPH_CONSTANT_DIVISION_BY_ZERO',
        objectId: 'object-graph-authority',
        analysisHash: expect.stringMatching(/^graph-v3-q12-/),
        segmentCount: 0,
      }),
    ]))
    expect(result.python).toContain('pc_authority_graph = VMobject()')
    expect(result.python).not.toContain('1.0 / 0.0')
    expect(result.python).not.toContain('FunctionGraph')
  })

  test('never compiles uncertified fixed-lattice alias geometry', () => {
    const alias = {
      kind: 'sin' as const,
      value: {
        kind: 'multiply' as const,
        left: { kind: 'constant' as const, value: 804.247719319 },
        right: { kind: 'variable' as const },
      },
    }
    const project = projectWithGraph(alias)
    project.shots[0].objects[0].properties.xMin = -1
    project.shots[0].objects[0].properties.xMax = 1
    const expected = analyzeGraphExpression(alias, -1, 1)
    expect(expected).toEqual(expect.objectContaining({ ok: false, segments: [] }))

    const result = compileManim(project)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        code: 'GRAPH_SAMPLING_BUDGET_EXCEEDED',
        objectId: 'object-graph-authority',
        analysisHash: expected.analysisHash,
        segmentCount: 0,
      }),
    ]))
    expect(result.python).toContain('pc_authority_graph = VMobject()')
    expect(result.python).not.toContain('set_points_as_corners')
  })

  test('propagates shared discontinuity evidence without making a valid reciprocal graph fatal', () => {
    const reciprocal = {
      kind: 'divide' as const,
      left: { kind: 'constant' as const, value: 1 },
      right: { kind: 'variable' as const },
    }
    const project = projectWithGraph(reciprocal)
    const expected = analyzeGraphExpression(reciprocal, -2, 2)
    const result = compileManim(project)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning',
        code: 'GRAPH_DISCONTINUITIES_SEGMENTED',
        objectId: 'object-graph-authority',
        analysisHash: expected.analysisHash,
        segmentCount: 2,
      }),
    ]))
    expect(result.diagnostics.some(({ severity }) => severity === 'error')).toBe(false)
  })

  test('compiles safe equal quotients while preserving their crossing-zero hole', () => {
    const quotient = {
      kind: 'divide' as const,
      left: { kind: 'variable' as const },
      right: { kind: 'variable' as const },
    }
    const safe = projectWithGraph(quotient)
    safe.shots[0].objects[0].properties.xMin = 1
    safe.shots[0].objects[0].properties.xMax = 2
    const safeAnalysis = analyzeGraphExpression(quotient, 1, 2)
    const safeResult = compileManim(safe)
    expect(safeAnalysis).toEqual(expect.objectContaining({ ok: true, canonical: '1' }))
    expect(projectGraphAuthoringIssues(safe)).toEqual([])
    expect(safeResult.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GRAPH_GEOMETRY_DERIVED', analysisHash: safeAnalysis.analysisHash, segmentCount: 1 }),
    ]))
    expect(safeResult.python).toContain('set_points_as_corners')

    const crossing = projectWithGraph(quotient)
    crossing.shots[0].objects[0].properties.xMin = -1
    crossing.shots[0].objects[0].properties.xMax = 1
    const crossingAnalysis = analyzeGraphExpression(quotient, -1, 1)
    const crossingResult = compileManim(crossing)
    expect(crossingAnalysis).toEqual(expect.objectContaining({ ok: true }))
    expect(projectGraphAuthoringIssues(crossing)).toEqual([])
    expect(crossingAnalysis.segments).toHaveLength(2)
    expect(crossingResult.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GRAPH_DISCONTINUITIES_SEGMENTED', analysisHash: crossingAnalysis.analysisHash, segmentCount: 2 }),
    ]))
    expect(crossingResult.diagnostics.some(({ severity }) => severity === 'error')).toBe(false)
  })
})
