import {
  GRAPH_EXPRESSION_LIMITS,
  analyzeGraphExpression,
  boundedTrigInterval,
  evaluateRestrictedExpression,
  formatGraphExpression,
  parseGraphExpression,
} from '../graphExpression'
import type { RestrictedExpression } from '../schema'

function parsed(source: string): RestrictedExpression {
  const result = parseGraphExpression(source)
  if (!result.ok) throw new Error(result.diagnostic.message)
  return result.expression
}

describe('bounded graph expression authority', () => {
  test('parses and canonically formats only the restricted grammar', () => {
    const result = parseGraphExpression('sin(x)^2 + cos(x)^3')
    expect(result).toEqual(expect.objectContaining({ ok: true, canonical: '((sin(x) ^ 2) + (cos(x) ^ 3))' }))
    if (!result.ok) return
    expect(parseGraphExpression(result.canonical)).toEqual(expect.objectContaining({ ok: true, expression: result.expression }))
    expect(parseGraphExpression('Math.random()')).toEqual(expect.objectContaining({ ok: false, diagnostic: expect.objectContaining({ code: 'GRAPH_SYNTAX_INVALID' }) }))
    expect(parseGraphExpression('x ** 2')).toEqual(expect.objectContaining({ ok: false }))
    expect(parseGraphExpression('x^1.5')).toEqual(expect.objectContaining({ ok: false }))
    expect(parseGraphExpression('x^9')).toEqual(expect.objectContaining({ ok: false }))
  })

  test('round-trips every structural form, including negative and negated power bases', () => {
    const structuralCorpus: RestrictedExpression[] = [
      { kind: 'constant', value: -2 },
      { kind: 'variable' },
      { kind: 'negate', value: { kind: 'variable' } },
      { kind: 'negate', value: { kind: 'constant', value: 2 } },
      { kind: 'negate', value: { kind: 'constant', value: -2 } },
      { kind: 'negate', value: { kind: 'negate', value: { kind: 'constant', value: 2 } } },
      { kind: 'sin', value: { kind: 'variable' } },
      { kind: 'cos', value: { kind: 'variable' } },
      { kind: 'abs', value: { kind: 'variable' } },
      { kind: 'add', left: { kind: 'variable' }, right: { kind: 'constant', value: 3 } },
      { kind: 'subtract', left: { kind: 'variable' }, right: { kind: 'constant', value: 3 } },
      { kind: 'multiply', left: { kind: 'variable' }, right: { kind: 'constant', value: 3 } },
      { kind: 'divide', left: { kind: 'variable' }, right: { kind: 'constant', value: 3 } },
      { kind: 'power', base: { kind: 'negate', value: { kind: 'variable' } }, exponent: 2 },
      ...Array.from({ length: 17 }, (_, index): RestrictedExpression => ({
        kind: 'power',
        base: { kind: 'constant', value: -2 },
        exponent: index - 8,
      })),
    ]
    for (const expression of structuralCorpus) {
      const canonical = formatGraphExpression(expression)
      expect(parseGraphExpression(canonical)).toEqual(expect.objectContaining({ ok: true, expression }))
    }
    expect(formatGraphExpression({ kind: 'power', base: { kind: 'constant', value: -2 }, exponent: -2 }))
      .toBe('((-2) ^ -2)')
    expect(evaluateRestrictedExpression(parsed('-2^2'), 0)).toEqual({ ok: true, value: -4 })
    expect(evaluateRestrictedExpression(parsed('(-2)^2'), 0)).toEqual({ ok: true, value: 4 })

    for (const source of ['-2', '-2^2', '(-2)^2', '-(2)', '-(-2)', '--2', '-+2']) {
      const first = parseGraphExpression(source)
      expect(first.ok).toBe(true)
      if (!first.ok) continue
      const once = formatGraphExpression(first.expression)
      const second = parseGraphExpression(once)
      expect(second).toEqual(expect.objectContaining({ ok: true, expression: first.expression }))
      if (second.ok) expect(formatGraphExpression(second.expression)).toBe(once)
    }
  })

  test('keeps every allowed canonical AST inside the parser text envelope', () => {
    let level: RestrictedExpression[] = Array.from({ length: 32 }, (_, index) => ({
      kind: 'constant',
      value: -(0.123456789012345 + index * Number.EPSILON),
    }))
    while (level.length > 1) {
      const next: RestrictedExpression[] = []
      for (let index = 0; index < level.length; index += 2) {
        next.push({ kind: 'add', left: level[index], right: level[index + 1] })
      }
      level = next
    }
    const canonical = formatGraphExpression(level[0])
    expect(canonical.length).toBeGreaterThan(512)
    expect(canonical.length).toBeLessThan(GRAPH_EXPRESSION_LIMITS.sourceChars)
    expect(parseGraphExpression(canonical)).toEqual(expect.objectContaining({ ok: true, expression: level[0] }))
    expect(parseGraphExpression(`x${' '.repeat(GRAPH_EXPRESSION_LIMITS.sourceChars - 1)}`).ok).toBe(true)
    expect(parseGraphExpression(`x${' '.repeat(GRAPH_EXPRESSION_LIMITS.sourceChars)}`)).toEqual(expect.objectContaining({
      ok: false,
      diagnostic: expect.objectContaining({ code: 'GRAPH_SOURCE_TOO_LONG' }),
    }))

    // This valid formatter output used to cross the old 256-token parser cap.
    // Six negative powers per leaf exercise both exponent signs and grouping.
    let powerLeaves: RestrictedExpression[] = Array.from({ length: 8 }, () => ({ kind: 'constant', value: 2 }))
    powerLeaves = powerLeaves.map((leaf) => {
      let expression = leaf
      for (let depth = 0; depth < 6; depth += 1) expression = { kind: 'power', base: expression, exponent: -1 }
      return expression
    })
    while (powerLeaves.length > 1) {
      const next: RestrictedExpression[] = []
      for (let index = 0; index < powerLeaves.length; index += 2) {
        next.push({ kind: 'add', left: powerLeaves[index], right: powerLeaves[index + 1] })
      }
      powerLeaves = next
    }
    const tokenBoundaryCanonical = formatGraphExpression(powerLeaves[0])
    expect(tokenBoundaryCanonical.length).toBe(379)
    expect(GRAPH_EXPRESSION_LIMITS.tokens).toBe(GRAPH_EXPRESSION_LIMITS.nodes * 5)
    expect(parseGraphExpression(tokenBoundaryCanonical)).toEqual(expect.objectContaining({ ok: true, expression: powerLeaves[0] }))
    expect(analyzeGraphExpression(powerLeaves[0], -1, 1)).toEqual(expect.objectContaining({ ok: true, diagnostics: [] }))
  })

  test('uses lossless shortest-round-trip constants for canonical authority and hashes', () => {
    const firstValue = 0.123456789012345
    const secondValue = 0.123456789012346
    const firstCanonical = formatGraphExpression({ kind: 'constant', value: firstValue })
    const secondCanonical = formatGraphExpression({ kind: 'constant', value: secondValue })
    expect(firstCanonical).toBe('0.123456789012345')
    expect(secondCanonical).toBe('0.123456789012346')
    expect(secondCanonical).not.toBe(firstCanonical)
    expect(parseGraphExpression(firstCanonical)).toEqual(expect.objectContaining({
      ok: true,
      expression: { kind: 'constant', value: firstValue },
    }))
    expect(analyzeGraphExpression({ kind: 'constant', value: firstValue }, -1, 1).analysisHash)
      .not.toBe(analyzeGraphExpression({ kind: 'constant', value: secondValue }, -1, 1).analysisHash)
  })

  test('evaluates an AST without source execution and preserves exact undefined results', () => {
    expect(evaluateRestrictedExpression(parsed('(x + 2) / 2'), 4)).toEqual({ ok: true, value: 3 })
    expect(evaluateRestrictedExpression(parsed('1 / x'), 0)).toEqual({ ok: false, reason: 'division' })
    expect(evaluateRestrictedExpression(parsed('x^-1'), 0)).toEqual({ ok: false, reason: 'power' })
  })

  test.each([
    ['1 / 0', 'GRAPH_CONSTANT_DIVISION_BY_ZERO'],
    ['1 / (2 - 2)', 'GRAPH_CONSTANT_DIVISION_BY_ZERO'],
    ['0^0', 'GRAPH_CONSTANT_POWER_UNDEFINED'],
    ['0^-1', 'GRAPH_CONSTANT_POWER_UNDEFINED'],
    ['1000000 * 1000000', 'GRAPH_CONSTANT_MAGNITUDE_EXCEEDED'],
  ])('rejects proven constant undefined authority: %s', (source, code) => {
    const analysis = analyzeGraphExpression(parsed(source), -2, 2)
    expect(analysis).toEqual(expect.objectContaining({
      ok: false,
      segments: [],
      diagnostics: [expect.objectContaining({ severity: 'error', code })],
    }))
    expect(analysis.analysisHash).toMatch(/^graph-v3-q12-[0-9a-f]{16}$/)
  })

  test('keeps 1/x drawable but never bridges its pole', () => {
    const analysis = analyzeGraphExpression(parsed('1 / x'), -2, 2)
    expect(analysis.ok).toBe(true)
    expect(analysis.normalizedSegments).toHaveLength(2)
    expect(analysis.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', code: 'GRAPH_DISCONTINUITIES_SEGMENTED' })])
    expect(analysis.segments[0].at(-1)!.x).toBeLessThan(0)
    expect(analysis.segments[1][0].x).toBeGreaterThan(0)
    expect(analysis.segments.every((segment) => !segment.some(({ x }) => x === 0))).toBe(true)
  })

  test('conservatively cuts a pole between base lattice points', () => {
    const pole = 0.12345
    const analysis = analyzeGraphExpression(parsed(`1 / (x - ${pole})`), -1, 1)
    expect(analysis.ok).toBe(true)
    expect(analysis.segments).toHaveLength(2)
    const left = analysis.segments[0]
    const right = analysis.segments[1]
    expect(left.at(-1)!.x).toBeLessThan(pole)
    expect(right[0].x).toBeGreaterThan(pole)
    expect(right[0].x - left.at(-1)!.x)
      .toBeLessThan((1 - (-1)) / (GRAPH_EXPRESSION_LIMITS.initialSamplePoints - 1))
  })

  test('normalizes identical dependent subexpressions before interval analysis', () => {
    const repeatedVariable = { kind: 'subtract' as const, left: { kind: 'variable' as const }, right: { kind: 'variable' as const } }
    const safe = analyzeGraphExpression({
      kind: 'divide',
      left: { kind: 'constant', value: 1 },
      right: { kind: 'add', left: repeatedVariable, right: { kind: 'constant', value: 1 } },
    }, -1000, 1000)
    expect(safe).toEqual(expect.objectContaining({
      ok: true,
      canonical: '(1 / (0 + 1))',
      diagnostics: [],
      yRange: { min: 1, max: 1 },
    }))
    expect(safe.segments.flat().every(({ y }) => y === 1)).toBe(true)

    const undefinedAnalysis = analyzeGraphExpression({
      kind: 'divide',
      left: { kind: 'constant', value: 1 },
      right: repeatedVariable,
    }, -1000, 1000)
    expect(undefinedAnalysis).toEqual(expect.objectContaining({
      ok: false,
      canonical: '(1 / 0)',
      segments: [],
      diagnostics: [expect.objectContaining({ code: 'GRAPH_CONSTANT_DIVISION_BY_ZERO' })],
    }))
  })

  test('proves bounded increment, square, and equal-rational identities without false gaps', () => {
    for (const [source, xMin, xMax] of [
      ['x / x', 1, 2],
      ['(x * x + 1) / (x * x + 1)', -2, 2],
      ['1 / ((x + 1) - x)', -100, 100],
      ['1 / (((100 * x) + 1) - (100 * x))', -100, 100],
    ] as const) {
      const analysis = analyzeGraphExpression(parsed(source), xMin, xMax)
      expect(analysis.ok).toBe(true)
      expect(analysis.diagnostics).toEqual([])
      expect(analysis.segments).toHaveLength(1)
      expect(analysis.yRange).toEqual({ min: 1, max: 1 })
      expect(analysis.segments.flat().every(({ y }) => y === 1)).toBe(true)
    }

    for (const [source, xMin, xMax] of [
      ['1 / (x * x + 1)', -100, 100],
      ['1 / ((100 * x)^2 + 1)', -1, 1],
    ] as const) {
      const analysis = analyzeGraphExpression(parsed(source), xMin, xMax)
      expect(analysis.ok).toBe(true)
      expect(analysis.diagnostics).toEqual([])
      expect(analysis.segments).toHaveLength(1)
      expect(analysis.segments.flat().length).toBeLessThanOrEqual(GRAPH_EXPRESSION_LIMITS.samplePoints)
      expect(analysis.evaluations).toBeLessThanOrEqual(GRAPH_EXPRESSION_LIMITS.evaluations)
    }
  })

  test('normalizes both Pythagorean orders only when the shared inner expression is safe', () => {
    for (const source of ['sin(x)^2 + cos(x)^2', 'cos(x)^2 + sin(x)^2']) {
      const analysis = analyzeGraphExpression(parsed(source), -1, 1)
      expect(analysis).toEqual(expect.objectContaining({
        ok: true,
        canonical: '1',
        diagnostics: [],
        yRange: { min: 1, max: 1 },
      }))
    }

    const partialExpression = parsed('sin(1 / x)^2 + cos(1 / x)^2')
    const partial = analyzeGraphExpression(partialExpression, -1, 1)
    expect(partial.ok).toBe(true)
    expect(partial.canonical).not.toBe('1')
    expect(partial.segments).toHaveLength(2)
    expect(partial.diagnostics).toEqual([
      expect.objectContaining({ code: 'GRAPH_DISCONTINUITIES_SEGMENTED' }),
    ])
    expect(partial.segments.flat().every(({ x, y }) => x !== 0 && Math.abs(y - 1) <= Number.EPSILON)).toBe(true)

    const magnitudeFailure = analyzeGraphExpression(
      parsed('sin(1000000 * x)^2 + cos(1000000 * x)^2'),
      -2,
      2,
    )
    expect(magnitudeFailure.ok).toBe(true)
    expect(magnitudeFailure.canonical).not.toBe('1')
    expect(magnitudeFailure.segments).toHaveLength(1)
    expect(magnitudeFailure.segments.flat().every(({ x }) => Math.abs(x) <= 1)).toBe(true)
    expect(magnitudeFailure.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GRAPH_SAMPLES_OMITTED' }),
    ]))
  })

  test('keeps equal-quotient holes, fatal zero denominators, and magnitude failures', () => {
    for (const source of ['x / x', '(x * x) / (x * x)']) {
      const analysis = analyzeGraphExpression(parsed(source), -1, 1)
      expect(analysis.ok).toBe(true)
      expect(analysis.canonical).not.toBe('1')
      expect(analysis.segments).toHaveLength(2)
      expect(analysis.diagnostics).toEqual([
        expect.objectContaining({ code: 'GRAPH_DISCONTINUITIES_SEGMENTED' }),
      ])
      expect(analysis.segments.flat().every(({ x, y }) => x !== 0 && y === 1)).toBe(true)
    }

    for (const source of ['0 / 0', '1 / (x - x)']) {
      const analysis = analyzeGraphExpression(parsed(source), -1, 1)
      expect(analysis.ok).toBe(false)
      expect(analysis.segments).toEqual([])
      expect(analysis.diagnostics[0]).toEqual(expect.objectContaining({ code: 'GRAPH_CONSTANT_DIVISION_BY_ZERO' }))
    }

    const magnitudeFailure = analyzeGraphExpression(parsed('(1000000 * x) / (1000000 * x)'), 1, 2)
    expect(magnitudeFailure.ok).toBe(false)
    expect(magnitudeFailure.canonical).not.toBe('1')
    expect(magnitudeFailure.segments).toEqual([])
    expect(magnitudeFailure.evaluations).toBeLessThanOrEqual(GRAPH_EXPRESSION_LIMITS.evaluations)

    const roundedToZero = analyzeGraphExpression(
      parsed('((x + 0.0000000000001) - x) / ((x + 0.0000000000001) - x)'),
      9000,
      10000,
    )
    expect(roundedToZero.ok).toBe(false)
    expect(roundedToZero.canonical).not.toBe('1')
    expect(roundedToZero.segments).toEqual([])
  })

  test('rejects an exact half-ULP equal quotient whose unsampled denominator rounds to zero', () => {
    const halfUlp = Number.EPSILON / 2
    const low = 1 + Number.EPSILON
    const high = 1 + 4097 * Number.EPSILON
    const hole = low + Number.EPSILON
    const expression = parsed(`((x + ${halfUlp}) - x) / ((x + ${halfUlp}) - x)`)
    expect(evaluateRestrictedExpression(expression, low)).toEqual({ ok: true, value: 1 })
    expect(evaluateRestrictedExpression(expression, (low + high) / 2)).toEqual({ ok: true, value: 1 })
    expect(evaluateRestrictedExpression(expression, high)).toEqual({ ok: true, value: 1 })
    expect(evaluateRestrictedExpression(expression, hole)).toEqual({ ok: false, reason: 'division' })
    const analysis = analyzeGraphExpression(expression, low, high)
    expect(analysis).toEqual(expect.objectContaining({
      ok: false,
      segments: [],
      diagnostics: [expect.objectContaining({ code: 'GRAPH_OPERATIONAL_RANGE_UNCERTIFIED' })],
    }))
    expect(analysis.canonical).not.toBe('1')
  })

  test('does not turn an underflowing positive product into a strict nonzero proof', () => {
    const expression = parsed('(5e-324 * x) / (5e-324 * x)')
    expect(evaluateRestrictedExpression(expression, 0.5)).toEqual({ ok: false, reason: 'division' })
    expect(evaluateRestrictedExpression(expression, 0.5000000000000001)).toEqual({ ok: true, value: 1 })
    const analysis = analyzeGraphExpression(expression, 0.5, 2)
    expect(analysis.ok).toBe(true)
    expect(analysis.canonical).not.toBe('1')
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GRAPH_DISCONTINUITIES_SEGMENTED' }),
    ]))
    expect(analysis.segments.flat().every(({ x }) => x !== 0.5)).toBe(true)

    const underflowingSquare = parsed('(x^2) / (x^2)')
    expect(evaluateRestrictedExpression(underflowingSquare, 1e-200)).toEqual({ ok: false, reason: 'division' })
    expect(analyzeGraphExpression(underflowingSquare, 1e-200, 2e-200)).toEqual(expect.objectContaining({
      ok: false,
      canonical: '((x ^ 2) / (x ^ 2))',
      segments: [],
      diagnostics: [expect.objectContaining({ code: 'GRAPH_OPERATIONAL_RANGE_UNCERTIFIED' })],
    }))
  })

  test('bounds refined gaps for interior, off-lattice, and endpoint poles', () => {
    for (const [source, xMin, xMax, segmentCount] of [
      ['1 / x', -1, 1, 2],
      ['1 / (x - 0.12345)', -1, 1, 2],
      ['1 / x', 0, 1, 1],
      ['1 / (x - 1)', 0, 1, 1],
    ] as const) {
      const first = analyzeGraphExpression(parsed(source), xMin, xMax)
      expect(first.ok).toBe(true)
      expect(first.segments).toHaveLength(segmentCount)
      expect(first.diagnostics).toEqual([
        expect.objectContaining({ code: 'GRAPH_DISCONTINUITIES_SEGMENTED' }),
      ])
      expect(first.segments.flat().length).toBeLessThanOrEqual(GRAPH_EXPRESSION_LIMITS.samplePoints)
      expect(first.evaluations).toBeLessThanOrEqual(GRAPH_EXPRESSION_LIMITS.evaluations)
      expect(analyzeGraphExpression(parsed(source), xMin, xMax)).toEqual(first)
    }
  })

  test('never lets dependency normalization erase holes or bounded-VM failures', () => {
    for (const source of ['(1 / x) - (1 / x)', '((1 / x) - (1 / x)) + 1']) {
      const analysis = analyzeGraphExpression(parsed(source), -2, 2)
      expect(analysis.ok).toBe(true)
      expect(analysis.segments).toHaveLength(2)
      expect(analysis.diagnostics).toEqual([
        expect.objectContaining({ code: 'GRAPH_DISCONTINUITIES_SEGMENTED' }),
      ])
      expect(analysis.segments.flat().every(({ x }) => x !== 0)).toBe(true)
    }

    const bounded = analyzeGraphExpression(parsed('(1000000 * x) - (1000000 * x)'), -1000, 1000)
    expect(bounded.ok).toBe(false)
    expect(bounded.canonical).not.toBe('0')
    expect(bounded.diagnostics).toEqual([
      expect.objectContaining({ code: 'GRAPH_OPERATIONAL_RANGE_UNCERTIFIED' }),
    ])
    expect(bounded.segments).toEqual([])
    expect(bounded.evaluations).toBeLessThanOrEqual(GRAPH_EXPRESSION_LIMITS.evaluations)
  })

  test('fails closed when a fixed lattice aliases an uncertified oscillation', () => {
    for (const source of [
      'sin(804.247719319 * x)',
      '((100000 * x) + -(100000 * x)) + sin(804.247719319 * x)',
    ]) {
      const expression = parsed(source)
      const analysis = analyzeGraphExpression(expression, -1, 1)
      expect(analysis).toEqual(expect.objectContaining({
        ok: false,
        segments: [],
        normalizedSegments: [],
        diagnostics: [expect.objectContaining({
          severity: 'error',
          code: 'GRAPH_SAMPLING_BUDGET_EXCEEDED',
        })],
      }))
      expect(analysis.evaluations).toBeLessThanOrEqual(GRAPH_EXPRESSION_LIMITS.evaluations)
      expect(analyzeGraphExpression(expression, -1, 1)).toEqual(analysis)
    }

    const ordinary = analyzeGraphExpression(parsed('sin(x)'), -3, 3)
    expect(ordinary.ok).toBe(true)
    expect(ordinary.evaluations).toBeGreaterThanOrEqual(GRAPH_EXPRESSION_LIMITS.rangeSamplePoints)
    expect(ordinary.segments.flat().length).toBeLessThan(ordinary.evaluations)
    expect(ordinary.segments.flat().length).toBeLessThanOrEqual(GRAPH_EXPRESSION_LIMITS.samplePoints)
  })

  test('preserves unsampled original magnitude spikes through every guarded identity', () => {
    const pole = 0.12345
    const spike = `(1 / (((x - ${pole}) ^ 2) + 0.00000001))`
    for (const source of [
      `(${spike} / ${spike})`,
      `(${spike} - ${spike})`,
      `(sin(${spike})^2 + cos(${spike})^2)`,
    ]) {
      const expression = parsed(source)
      expect(evaluateRestrictedExpression(expression, pole)).toEqual({ ok: false, reason: 'magnitude' })
      const analysis = analyzeGraphExpression(expression, -1, 1)
      expect(analysis.ok).toBe(true)
      expect(analysis.canonical).not.toMatch(/^(0|1)$/)
      expect(analysis.segments).toHaveLength(2)
      expect(analysis.segments.every((segment) => segment.at(-1)!.x < pole || segment[0].x > pole)).toBe(true)
      expect(analysis.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'GRAPH_DISCONTINUITIES_SEGMENTED' }),
      ]))
    }
  })

  test('keeps distributive nonlinear dependency fail-closed with an explicit limitation', () => {
    const analysis = analyzeGraphExpression(
      parsed('1 / (((x + 1)^2) - ((x^2) + (2 * x)))'),
      -100,
      100,
    )
    expect(analysis).toEqual(expect.objectContaining({
      ok: false,
      segments: [],
      diagnostics: [expect.objectContaining({ code: 'GRAPH_OPERATIONAL_RANGE_UNCERTIFIED' })],
    }))
  })

  test('bounds trigonometric interval reduction for nonfinite and unsafe phases', () => {
    expect(boundedTrigInterval({ min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY })).toEqual({ min: -1, max: 1 })
    expect(boundedTrigInterval({ min: Number.NaN, max: 0 })).toEqual({ min: -1, max: 1 })
    expect(boundedTrigInterval({ min: 2 ** 54, max: 2 ** 54 + 1 })).toEqual({ min: -1, max: 1 })
    const nested = analyzeGraphExpression(parsed('sin(((1000000 * x)^8)^8)'), 1, 2)
    expect(nested.ok).toBe(false)
    expect(nested.segments).toEqual([])
    expect(nested.evaluations).toBeLessThanOrEqual(GRAPH_EXPRESSION_LIMITS.evaluations)
  })

  test('encloses direct cosine endpoints without a phase-shift sign error', () => {
    const low = 98.96016858807847
    const high = 98.96016858807849
    const range = boundedTrigInterval({ min: low, max: high }, true)
    expect(range.min).toBeLessThanOrEqual(Math.min(Math.cos(low), Math.cos(high)))
    expect(range.max).toBeGreaterThanOrEqual(Math.max(Math.cos(low), Math.cos(high)))
    expect(range.min).toBeLessThanOrEqual(0)
    expect(range.max).toBeGreaterThanOrEqual(0)
  })

  test('binds analysis evidence to the persisted source AST before guarded normalization', () => {
    const quotient = analyzeGraphExpression(parsed('x / x'), 1, 2)
    const literal = analyzeGraphExpression(parsed('1'), 1, 2)
    expect(quotient.canonical).toBe('1')
    expect(literal.canonical).toBe('1')
    expect(quotient.analysisHash).not.toBe(literal.analysisHash)
  })

  test('public evaluation applies guarded mathematical normalization only after original success', () => {
    expect(evaluateRestrictedExpression(parsed('sin(x)^2 + cos(x)^2'), 1 / 997)).toEqual({ ok: true, value: 1 })
    expect(evaluateRestrictedExpression(parsed('sin(1/x)^2 + cos(1/x)^2'), 1 / 997)).toEqual({ ok: true, value: 1 })
    expect(evaluateRestrictedExpression(parsed('sin(1/x)^2 + cos(1/x)^2'), 0)).toEqual({ ok: false, reason: 'division' })
  })

  test('constant functions have stable centered geometry', () => {
    const analysis = analyzeGraphExpression(parsed('3'), -5, 5)
    expect(analysis.ok).toBe(true)
    expect(analysis.normalizedSegments).toHaveLength(1)
    expect(new Set(analysis.normalizedSegments[0].map(({ y }) => y))).toEqual(new Set([0]))
    expect(analysis.yRange).toEqual({ min: 3, max: 3 })
  })

  test('normalizes adjacent subnormal values into the exact documented vertical box', () => {
    const analysis = analyzeGraphExpression(parsed('5e-324 * x'), 1, 2)
    expect(analysis.ok).toBe(true)
    const normalizedY = analysis.normalizedSegments.flat().map(({ y }) => y)
    expect(Math.min(...normalizedY)).toBe(-0.5)
    expect(Math.max(...normalizedY)).toBe(0.5)
    expect(normalizedY.every((value) => value >= -0.5 && value <= 0.5)).toBe(true)
  })

  test('deduplicates fixed-lattice seeds on one-ULP domains without losing endpoints', () => {
    for (const width of [1, 10]) {
      const xMin = 1
      const xMax = 1 + Number.EPSILON * width
      for (const source of ['1', 'x']) {
        const analysis = analyzeGraphExpression(parsed(source), xMin, xMax)
        expect(analysis).toEqual(expect.objectContaining({ ok: true, diagnostics: [] }))
        expect(analysis.segments).toHaveLength(1)
        expect(analysis.segments[0].length).toBeGreaterThanOrEqual(2)
        expect(new Set(analysis.segments[0].map(({ x }) => x)).size).toBe(analysis.segments[0].length)
        expect(analysis.segments[0][0].x).toBe(xMin)
        expect(analysis.segments[0].at(-1)!.x).toBe(xMax)
        expect(analysis.evaluations).toBeLessThanOrEqual(GRAPH_EXPRESSION_LIMITS.evaluations)
      }
    }
  })

  test('keeps exact binary64 magnitude-boundary values while rejecting the next value', () => {
    for (const source of [
      '500000 + 500000',
      '1000000 * 1',
      '1000000 / 1',
      '1000000 ^ 1',
      'abs(-1000000)',
      '1000000 + 5e-11',
    ]) {
      const analysis = analyzeGraphExpression(parsed(source), 0, 1)
      expect(analysis).toEqual(expect.objectContaining({ ok: true, diagnostics: [], yRange: { min: 1_000_000, max: 1_000_000 } }))
    }

    const inclusiveLinear = analyzeGraphExpression(parsed('1000000 * x'), 0, 1)
    expect(inclusiveLinear).toEqual(expect.objectContaining({ ok: true, diagnostics: [] }))
    expect(inclusiveLinear.segments[0].at(-1)).toEqual({ x: 1, y: 1_000_000 })

    expect(analyzeGraphExpression(parsed('1000000 + 6e-11'), 0, 1)).toEqual(expect.objectContaining({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'GRAPH_CONSTANT_MAGNITUDE_EXCEEDED' })],
    }))
    const beyond = analyzeGraphExpression(parsed('1000000 * x'), 0, 1 + Number.EPSILON)
    expect(beyond.segments.flat().every(({ y }) => Math.abs(y) <= GRAPH_EXPRESSION_LIMITS.magnitude)).toBe(true)
    expect(beyond.ok ? beyond.diagnostics.length > 0 : beyond.diagnostics[0].severity === 'error').toBe(true)
  })

  test('reports rather than silently hiding finite-magnitude sample omissions', () => {
    const analysis = analyzeGraphExpression(parsed('x^8'), -100, 100)
    expect(analysis.ok).toBe(true)
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning', code: 'GRAPH_SAMPLES_OMITTED' })]))
    expect(analysis.segments.flat().every(({ y }) => Math.abs(y) <= GRAPH_EXPRESSION_LIMITS.magnitude)).toBe(true)
  })

  test('repeats byte-for-byte with one stable geometry hash', () => {
    const expression = parsed('abs(sin(x)) + (x^2 / 4)')
    const first = analyzeGraphExpression(expression, -3, 3)
    const second = analyzeGraphExpression(expression, -3, 3)
    expect(second).toEqual(first)
    expect(formatGraphExpression(expression)).toBe('(abs(sin(x)) + ((x ^ 2) / 4))')
  })

  test('fails closed at source, AST node, depth, and domain limits', () => {
    expect(parseGraphExpression('x'.repeat(GRAPH_EXPRESSION_LIMITS.sourceChars + 1))).toEqual(expect.objectContaining({ ok: false, diagnostic: expect.objectContaining({ code: 'GRAPH_SOURCE_TOO_LONG' }) }))
    expect(parseGraphExpression(Array.from({ length: Math.floor(GRAPH_EXPRESSION_LIMITS.tokens / 2) + 1 }, () => 'x').join('+'))).toEqual(expect.objectContaining({ ok: false, diagnostic: expect.objectContaining({ code: 'GRAPH_TOKEN_LIMIT_EXCEEDED' }) }))
    let wide: RestrictedExpression = { kind: 'variable' }
    for (let index = 0; index < GRAPH_EXPRESSION_LIMITS.nodes; index += 1) wide = { kind: 'add', left: wide, right: { kind: 'constant', value: 1 } }
    expect(analyzeGraphExpression(wide, -1, 1).diagnostics[0].code).toMatch(/GRAPH_(NODE|DEPTH)_LIMIT_EXCEEDED/)
    const cyclic: Record<string, unknown> = { kind: 'negate' }
    cyclic.value = cyclic
    expect(analyzeGraphExpression(cyclic, -1, 1).diagnostics[0].code).toMatch(/GRAPH_(NODE|DEPTH)_LIMIT_EXCEEDED/)
    expect(analyzeGraphExpression({ kind: 'variable' }, 2, 2).diagnostics[0].code).toBe('GRAPH_DOMAIN_INVALID')
  })
})
