import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { exportSrtCaptions, projectSequenceCaptions } from '../../lib/proofcanvas/captions'
import { canonicalProjectJson } from '../../lib/proofcanvas/schema'
import { compileManim } from '../../lib/proofcanvas/compiler'
import {
  DETERMINISTIC_AUDIO_FIXTURE,
  createCantorV1Project,
  createDeterministicAudioFixtureBytes,
} from '../../lib/proofcanvas/demo'
import { REQUIRED_AI_COMMANDS } from '../../lib/proofcanvas/ai'
import { generateAiCommandEvidence } from './artifact-ai'
import { NATIVE_SHAPE_PARITY_ARTIFACT_PATHS, verifyArtifactManifest } from './artifact-manifest'

const root = process.cwd()
const outputDirectory = path.join(root, 'examples', 'proofcanvas')
const jsonPath = path.join(outputDirectory, 'uncountable-yet-zero-length.proofcanvas.json')
const pythonPath = path.join(outputDirectory, 'uncountable-yet-zero-length.py')
const wavPath = path.join(outputDirectory, 'proofcanvas-deterministic-pulse-90s.wav')
const packagePath = path.join(outputDirectory, 'uncountable-yet-zero-length.proofcanvas')
const captionsPath = path.join(outputDirectory, 'uncountable-yet-zero-length.srt')
const browserImportCaptionsPath = path.join(outputDirectory, 'browser-import-proof-caption.srt')
const manifestPath = path.join(outputDirectory, 'artifact-manifest.json')
const aiResultsPath = path.join(outputDirectory, 'ai-command-results.json')
const prepareRender = process.argv.slice(2).includes('--prepare-render')
const browserImportCaptions = '1\r\n00:00:01,000 --> 00:00:03,000\r\nBrowser-imported proof caption\r\n\r\n'

if (process.argv.slice(2).some((argument) => argument !== '--prepare-render')) {
  throw new Error('Unsupported artifact-generation argument')
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function buildAndVerifyPackage(): { bytes: number; sha256: string; roundTripVerified: true; byteStable: true } {
  const helper = path.join(root, 'scripts', 'proofcanvas', 'artifact-package.ts')
  const result = spawnSync(process.execPath, [
    '--conditions=react-server', '--import', 'tsx', helper,
    'build', jsonPath, wavPath, packagePath,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 30_000 })
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(`Strict ProofCanvas package build failed: ${result.stderr.trim()}`)
  }
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>
  if (
    parsed.roundTripVerified !== true
    || parsed.byteStable !== true
    || parsed.projectSha256 !== sha256(Buffer.from(canonicalProjectJson(createCantorV1Project()), 'utf8'))
    || parsed.assetSha256 !== DETERMINISTIC_AUDIO_FIXTURE.metadata.sha256
    || !Number.isSafeInteger(parsed.bytes)
    || typeof parsed.sha256 !== 'string'
  ) throw new Error('Strict ProofCanvas package helper returned invalid verification evidence')
  return parsed as { bytes: number; sha256: string; roundTripVerified: true; byteStable: true }
}

async function optionalArtifactRecord(relativePath: string) {
  try {
    const contents = await readFile(path.join(outputDirectory, relativePath))
    return { bytes: contents.byteLength, sha256: sha256(contents) }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function main() {
  const project = createCantorV1Project()
  const json = canonicalProjectJson(project)
  const firstCompilation = compileManim(project, { audioTransport: true })
  const secondCompilation = compileManim(project, { audioTransport: true })
  const captionExport = exportSrtCaptions(projectSequenceCaptions(project.shots))

  if (firstCompilation.python !== secondCompilation.python) {
    throw new Error('ProofCanvas compiler output was not deterministic')
  }
  const compileErrors = firstCompilation.diagnostics.filter(({ severity }) => severity === 'error')
  if (compileErrors.length) {
    throw new Error(`ProofCanvas compiler reported errors: ${JSON.stringify(compileErrors)}`)
  }
  if (!captionExport.ok || captionExport.cueCount !== 11) {
    throw new Error(`ProofCanvas caption fixture generation failed: ${JSON.stringify(captionExport)}`)
  }

  const parse = spawnSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], {
    input: firstCompilation.python,
    encoding: 'utf8',
  })
  if (parse.status !== 0) {
    throw new Error(`Generated Manim Python did not parse: ${parse.stderr.trim()}`)
  }

  await mkdir(outputDirectory, { recursive: true })
  await writeFile(jsonPath, json, 'utf8')
  await writeFile(pythonPath, firstCompilation.python, 'utf8')
  await writeFile(captionsPath, captionExport.text, 'utf8')
  await writeFile(browserImportCaptionsPath, browserImportCaptions, 'utf8')
  const wav = Buffer.from(createDeterministicAudioFixtureBytes())
  if (wav.byteLength !== DETERMINISTIC_AUDIO_FIXTURE.metadata.size || sha256(wav) !== DETERMINISTIC_AUDIO_FIXTURE.metadata.sha256) {
    throw new Error('Deterministic WAV bytes do not match their canonical project metadata')
  }
  await writeFile(wavPath, wav)
  const packageEvidence = buildAndVerifyPackage()
  const aiResults = `${JSON.stringify({ artifactVersion: 1, projectId: project.metadata.id, commands: generateAiCommandEvidence(project) }, null, 2)}\n`
  await writeFile(aiResultsPath, aiResults, 'utf8')

  if (prepareRender) {
    process.stdout.write(`${JSON.stringify({
      jsonPath,
      pythonPath,
      wavPath,
      packagePath,
      captionsPath,
      browserImportCaptionsPath,
      aiResultsPath,
      preparedForRender: true,
      pythonSha256: sha256(firstCompilation.python),
      wavSha256: sha256(wav),
      packageSha256: packageEvidence.sha256,
      packageRoundTripVerified: packageEvidence.roundTripVerified,
    }, null, 2)}\n`)
    return
  }

  const files: Record<string, { bytes: number; sha256: string }> = {
    'uncountable-yet-zero-length.proofcanvas.json': {
      bytes: Buffer.byteLength(json),
      sha256: sha256(json),
    },
    'uncountable-yet-zero-length.py': {
      bytes: Buffer.byteLength(firstCompilation.python),
      sha256: sha256(firstCompilation.python),
    },
    'proofcanvas-deterministic-pulse-90s.wav': {
      bytes: wav.byteLength,
      sha256: sha256(wav),
    },
    'uncountable-yet-zero-length.proofcanvas': {
      bytes: packageEvidence.bytes,
      sha256: packageEvidence.sha256,
    },
    'uncountable-yet-zero-length.srt': {
      bytes: Buffer.byteLength(captionExport.text),
      sha256: sha256(captionExport.text),
    },
    'browser-import-proof-caption.srt': {
      bytes: Buffer.byteLength(browserImportCaptions),
      sha256: sha256(browserImportCaptions),
    },
    'ai-command-results.json': {
      bytes: Buffer.byteLength(aiResults),
      sha256: sha256(aiResults),
    },
  }
  const retainedEvidence = [
    'uncountable-yet-zero-length.mp4',
    'render-metadata.json',
    'stress-results.json',
    'evidence/browser-summary.json',
    'evidence/proofcanvas-dashboard-1920x1080.png',
    'evidence/proofcanvas-blank-editor-1920x1080.png',
    'evidence/proofcanvas-selected-text-1920x1080.png',
    'evidence/proofcanvas-selected-graph-1920x1080.png',
    'evidence/proofcanvas-timeline-keyframes-1920x1080.png',
    'evidence/proofcanvas-style-lab-1920x1080.png',
    'evidence/proofcanvas-style-nocturne-chalk-1920x1080.png',
    'evidence/proofcanvas-style-scientific-minimal-1920x1080.png',
    'evidence/proofcanvas-animation-inspector-1920x1080.png',
    'evidence/proofcanvas-ai-proposal-review-1920x1080.png',
    'evidence/proofcanvas-render-dialog-1440x900.png',
    'evidence/proofcanvas-editorial-1920x1080.png',
    'evidence/proofcanvas-editorial-1440x900.png',
    'evidence/proofcanvas-editorial-1280x800.png',
    'evidence/proofcanvas-narrow-editor-1024x768.png',
    'evidence/proofcanvas-portrait-output-1440x900.png',
    'evidence/proofcanvas-still-current.png',
    'render-evidence/proofcanvas-manim-frame-12s.png',
    ...NATIVE_SHAPE_PARITY_ARTIFACT_PATHS,
  ]
  for (const relativePath of retainedEvidence) {
    const record = await optionalArtifactRecord(relativePath)
    if (record) files[relativePath] = record
  }

  const manifest = {
    artifactVersion: 1,
    projectId: project.metadata.id,
    schemaVersion: project.schemaVersion,
    compilerDeterministic: true,
    pythonAstParsed: true,
    packageRoundTripVerified: packageEvidence.roundTripVerified,
    packageByteStable: packageEvidence.byteStable,
    deterministicAudioSha256: sha256(wav),
    durationSeconds: project.shots.reduce((total, shot) => total + shot.duration, 0),
    requiredAiCommandsExercised: REQUIRED_AI_COMMANDS.length,
    diagnostics: firstCompilation.diagnostics,
    files,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await verifyArtifactManifest(root)

  process.stdout.write(`${JSON.stringify({ jsonPath, pythonPath, aiResultsPath, manifestPath, manifestVerified: true, ...manifest }, null, 2)}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
