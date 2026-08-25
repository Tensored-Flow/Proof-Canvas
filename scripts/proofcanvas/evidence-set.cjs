'use strict'

const EXPECTED_TEMPORARY_EVIDENCE_ENTRIES = Object.freeze([
  'proofcanvas-editorial-1280x800.png',
  'proofcanvas-editorial-1440x900.png',
  'report.json',
  'ui-download/',
  'ui-download/proofcanvas-render.mp4',
])

function requireExactTemporaryEvidenceEntries(entries) {
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
    throw new Error('ProofCanvas browser evidence rejected: temporary evidence entry set is malformed')
  }
  const actual = [...entries].sort()
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_TEMPORARY_EVIDENCE_ENTRIES)) {
    throw new Error('ProofCanvas browser evidence rejected: temporary run must contain exactly the expected recursive entry set')
  }
  return actual
}

module.exports = { EXPECTED_TEMPORARY_EVIDENCE_ENTRIES, requireExactTemporaryEvidenceEntries }
