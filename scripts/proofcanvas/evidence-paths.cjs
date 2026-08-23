const path = require('node:path')

const MANAGED_EVIDENCE_RELATIVE_PATH = path.join('examples', 'proofcanvas', 'evidence')

function requireManagedEvidenceDirectory(repositoryRoot, candidate) {
  const root = path.resolve(repositoryRoot)
  const expected = path.join(root, MANAGED_EVIDENCE_RELATIVE_PATH)
  const actual = path.resolve(candidate)
  if (actual !== expected) {
    throw new Error(`ProofCanvas browser evidence rejected: output must be ${expected}`)
  }
  return actual
}

module.exports = { MANAGED_EVIDENCE_RELATIVE_PATH, requireManagedEvidenceDirectory }
