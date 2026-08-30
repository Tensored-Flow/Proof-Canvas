import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildProjectPackage, parseProjectPackage } from '../../lib/proofcanvas/projectPackage.server'
import { ProjectDocumentSchema, canonicalProjectJson } from '../../lib/proofcanvas/schema'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function regularFile(filePath: string, label: string): Promise<Buffer> {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error(`${label} must be a non-empty regular file`)
  return readFile(filePath)
}

async function main(): Promise<void> {
  const [command, projectArgument, wavArgument, packageArgument, ...extra] = process.argv.slice(2)
  if ((command !== 'build' && command !== 'verify') || !projectArgument || !wavArgument || !packageArgument || extra.length) {
    throw new Error('Usage: artifact-package.ts <build|verify> <project.json> <fixture.wav> <artifact.proofcanvas>')
  }
  const projectPath = path.resolve(projectArgument)
  const wavPath = path.resolve(wavArgument)
  const packagePath = path.resolve(packageArgument)
  if (new Set([projectPath, wavPath, packagePath]).size !== 3) throw new Error('Artifact package paths must be distinct')

  const projectBytes = await regularFile(projectPath, 'Canonical project JSON')
  const wavBytes = await regularFile(wavPath, 'Deterministic WAV fixture')
  const project = ProjectDocumentSchema.parse(JSON.parse(projectBytes.toString('utf8')))
  if (!projectBytes.equals(Buffer.from(canonicalProjectJson(project), 'utf8'))) throw new Error('Artifact project JSON is not canonical')
  if (project.assets.length !== 1 || project.assets[0].mimeType !== 'audio/wav') throw new Error('Artifact project must declare exactly the deterministic WAV asset')

  const build = () => buildProjectPackage({
    project,
    sourceRevision: 1,
    assets: [{ assetId: project.assets[0].id, contentBytes: wavBytes }],
  })
  if (command === 'build') await writeFile(packagePath, build().bytes)
  const packageBytes = await regularFile(packagePath, 'ProofCanvas package')
  const parsed = parseProjectPackage(packageBytes)
  const rebuilt = buildProjectPackage({
    project: parsed.project,
    sourceRevision: parsed.sourceRevision,
    assets: parsed.assets.map(({ assetId, contentBytes }) => ({ assetId, contentBytes })),
  })
  if (
    parsed.sourceRevision !== 1
    || parsed.assets.length !== 1
    || parsed.assets[0].assetId !== project.assets[0].id
    || !Buffer.from(parsed.assets[0].contentBytes).equals(wavBytes)
    || canonicalProjectJson(parsed.project) !== canonicalProjectJson(project)
    || !Buffer.from(rebuilt.bytes).equals(packageBytes)
  ) throw new Error('ProofCanvas package failed its strict byte-stable round trip')

  process.stdout.write(`${JSON.stringify({
    bytes: packageBytes.byteLength,
    sha256: sha256(packageBytes),
    projectSha256: sha256(projectBytes),
    assetSha256: sha256(wavBytes),
    sourceRevision: parsed.sourceRevision,
    roundTripVerified: true,
    byteStable: true,
  })}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
