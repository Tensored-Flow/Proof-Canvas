import path from 'node:path'

const { requireManagedEvidenceDirectory } = require('../evidence-paths.cjs') as {
  requireManagedEvidenceDirectory: (repositoryRoot: string, candidate: string) => string
}

describe('managed browser evidence path', () => {
  const repositoryRoot = path.resolve('/tmp/proofcanvas-evidence-path-test')
  const managed = path.join(repositoryRoot, 'examples', 'proofcanvas', 'evidence')

  it('accepts only the exact repository-owned evidence directory', () => {
    expect(requireManagedEvidenceDirectory(repositoryRoot, managed)).toBe(managed)
  })

  it.each([
    repositoryRoot,
    path.dirname(repositoryRoot),
    path.join(repositoryRoot, 'examples'),
    path.join(repositoryRoot, 'examples', 'proofcanvas'),
    path.join(repositoryRoot, 'examples', 'proofcanvas', 'evidence-copy'),
  ])('rejects destructive output target %s', (candidate) => {
    expect(() => requireManagedEvidenceDirectory(repositoryRoot, candidate)).toThrow('output must be')
  })
})
