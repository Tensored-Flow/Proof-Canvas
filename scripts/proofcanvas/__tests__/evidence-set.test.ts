const {
  EXPECTED_TEMPORARY_EVIDENCE_ENTRIES,
  requireExactTemporaryEvidenceEntries,
} = require('../evidence-set.cjs') as {
  EXPECTED_TEMPORARY_EVIDENCE_ENTRIES: readonly string[]
  requireExactTemporaryEvidenceEntries: (entries: readonly string[]) => string[]
}

describe('temporary browser evidence set', () => {
  it('accepts the exact recursive entry set in any order', () => {
    expect(requireExactTemporaryEvidenceEntries([...EXPECTED_TEMPORARY_EVIDENCE_ENTRIES].reverse()))
      .toEqual(EXPECTED_TEMPORARY_EVIDENCE_ENTRIES)
  })

  it.each([
    [[...EXPECTED_TEMPORARY_EVIDENCE_ENTRIES, 'ui-download/extra.json']],
    [[...EXPECTED_TEMPORARY_EVIDENCE_ENTRIES, 'ui-download/empty/']],
    [[...EXPECTED_TEMPORARY_EVIDENCE_ENTRIES, 'unexpected-empty/']],
    [EXPECTED_TEMPORARY_EVIDENCE_ENTRIES.filter((entry) => entry !== 'ui-download/proofcanvas-render.mp4')],
    [[...EXPECTED_TEMPORARY_EVIDENCE_ENTRIES, 'proofcanvas-editorial-1280x800.png']],
  ])('rejects every non-exact recursive entry set', (entries) => {
    expect(() => requireExactTemporaryEvidenceEntries(entries)).toThrow('exactly the expected recursive entry set')
  })
})
