import { verifyArtifactManifest } from './artifact-manifest'

void verifyArtifactManifest(process.cwd())
  .then(() => process.stdout.write('ProofCanvas artifact manifest verified.\n'))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
