import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

export const EXPECTED_ARTIFACT_PATHS = Object.freeze([
  'uncountable-yet-zero-length.proofcanvas.json',
  'uncountable-yet-zero-length.py',
  'ai-command-results.json',
  'uncountable-yet-zero-length.mp4',
  'render-metadata.json',
  'evidence/browser-summary.json',
  'evidence/proofcanvas-editorial-1440x900.png',
  'evidence/proofcanvas-editorial-1280x800.png',
  'render-evidence/proofcanvas-manim-frame-12s.png',
])

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MANIM_IMAGE = 'manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3'
const PROJECT_ID = 'project-uncountable-zero-length'

type JsonRecord = Record<string, unknown>
type FileRecord = { bytes: number; sha256: string }

function fail(message: string): never {
  throw new Error(`ProofCanvas artifact manifest rejected: ${message}`)
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value as JsonRecord
}

function parseJson(bytes: Buffer, label: string): JsonRecord {
  try {
    return record(JSON.parse(bytes.toString('utf8')), label)
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON`)
    throw error
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function pngDimensions(bytes: Buffer, label: string): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    fail(`${label} is not a canonical PNG`)
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function fileRecord(value: unknown, relativePath: string): FileRecord {
  const candidate = record(value, `manifest record for ${relativePath}`)
  if (!Number.isSafeInteger(candidate.bytes) || (candidate.bytes as number) <= 0) fail(`${relativePath} has an invalid recorded size`)
  if (typeof candidate.sha256 !== 'string' || !SHA256_PATTERN.test(candidate.sha256)) fail(`${relativePath} has an invalid recorded SHA-256`)
  if (Object.keys(candidate).sort().join(',') !== 'bytes,sha256') fail(`${relativePath} has unexpected manifest fields`)
  return candidate as FileRecord
}

async function readRegularFile(baseDirectory: string, relativePath: string): Promise<Buffer> {
  if (!EXPECTED_ARTIFACT_PATHS.includes(relativePath)) fail(`unexpected artifact path ${relativePath}`)
  const absolutePath = path.join(baseDirectory, ...relativePath.split('/'))
  const stat = await lstat(absolutePath)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${relativePath} must be a regular file`)
  if (stat.size <= 0) fail(`${relativePath} must not be empty`)
  return readFile(absolutePath)
}

function validateRenderMetadata(metadata: JsonRecord, video: Buffer, source: Buffer): void {
  if (metadata.genuineManimRender !== true || metadata.manimVersion !== '0.21.0' || metadata.image !== MANIM_IMAGE) {
    fail('render metadata does not identify the accepted genuine Manim execution')
  }
  if (metadata.codec !== 'h264' || metadata.width !== 854 || metadata.height !== 480) fail('render metadata has an unexpected video format')
  if (typeof metadata.fps !== 'number' || metadata.fps < 14.9 || metadata.fps > 15.1) fail('render metadata has an unexpected frame rate')
  if (typeof metadata.durationSeconds !== 'number' || metadata.durationSeconds < 20 || metadata.durationSeconds > 35) fail('render metadata has an unexpected duration')
  if (metadata.bytes !== video.byteLength || metadata.sha256 !== sha256(video)) fail('render metadata does not match the retained MP4')
  if (metadata.sourceSha256 !== sha256(source)) fail('render metadata does not match the retained generated Python')
}

function validateBrowserSummary(summary: JsonRecord, files: Map<string, Buffer>): void {
  if (
    summary.schemaVersion !== 1
    || summary.journey !== 'complete structured edit-to-Manim journey'
    || summary.executions !== 2
    || summary.skipped !== 0
    || summary.retried !== 0
    || summary.failures !== 0
  ) fail('browser summary does not prove two clean acceptance executions')

  if (!Array.isArray(summary.screenshots) || summary.screenshots.length !== 2) fail('browser summary must describe exactly two screenshots')
  const expectedScreenshots = new Map([
    ['proofcanvas-editorial-1440x900.png', { project: 'proofcanvas-chromium-1440', width: 1440, height: 900 }],
    ['proofcanvas-editorial-1280x800.png', { project: 'proofcanvas-chromium-1280', width: 1280, height: 800 }],
  ])
  const seen = new Set<string>()
  for (const value of summary.screenshots) {
    const screenshot = record(value, 'browser screenshot record')
    if (typeof screenshot.file !== 'string' || seen.has(screenshot.file)) fail('browser summary contains an unexpected or duplicate screenshot')
    const expected = expectedScreenshots.get(screenshot.file)
    if (!expected) fail(`browser summary contains unexpected screenshot ${screenshot.file}`)
    const relativePath = `evidence/${screenshot.file}`
    const bytes = files.get(relativePath)
    if (!bytes) fail(`browser screenshot ${relativePath} is missing`)
    const dimensions = pngDimensions(bytes, relativePath)
    if (
      screenshot.project !== expected.project
      || screenshot.status !== 'passed'
      || screenshot.width !== expected.width
      || screenshot.height !== expected.height
      || dimensions.width !== expected.width
      || dimensions.height !== expected.height
      || screenshot.bytes !== bytes.byteLength
      || screenshot.sha256 !== sha256(bytes)
      || typeof screenshot.durationMs !== 'number'
      || screenshot.durationMs < 0
    ) fail(`browser screenshot record does not match ${relativePath}`)
    seen.add(screenshot.file)
  }
  if (seen.size !== expectedScreenshots.size) fail('browser summary omitted an expected screenshot')

  const render = record(summary.render, 'browser render record')
  if (
    render.project !== 'proofcanvas-chromium-1440'
    || render.fileValidatedInTemporaryRun !== true
    || render.container !== 'mp4/ftyp'
    || !Number.isSafeInteger(render.bytes)
    || (render.bytes as number) <= 0
    || typeof render.sha256 !== 'string'
    || !SHA256_PATTERN.test(render.sha256)
  ) fail('browser summary does not prove a validated UI-downloaded MP4')
}

export async function verifyArtifactManifest(repositoryRoot: string): Promise<void> {
  const root = path.resolve(repositoryRoot)
  const baseDirectory = path.join(root, 'examples', 'proofcanvas')
  const manifestBytes = await readFile(path.join(baseDirectory, 'artifact-manifest.json'))
  const manifest = parseJson(manifestBytes, 'artifact manifest')
  if (
    manifest.artifactVersion !== 1
    || manifest.projectId !== PROJECT_ID
    || manifest.schemaVersion !== 1
    || manifest.compilerDeterministic !== true
    || manifest.pythonAstParsed !== true
    || manifest.requiredAiCommandsExercised !== 5
    || !Array.isArray(manifest.diagnostics)
    || manifest.diagnostics.some((value) => record(value, 'compiler diagnostic').severity === 'error')
  ) fail('manifest claims do not satisfy the acceptance contract')

  const manifestFiles = record(manifest.files, 'manifest files')
  const actualPaths = Object.keys(manifestFiles).sort()
  const expectedPaths = [...EXPECTED_ARTIFACT_PATHS].sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) fail('manifest must enumerate exactly the required artifacts')

  const files = new Map<string, Buffer>()
  for (const relativePath of EXPECTED_ARTIFACT_PATHS) {
    const expected = fileRecord(manifestFiles[relativePath], relativePath)
    const bytes = await readRegularFile(baseDirectory, relativePath)
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) fail(`${relativePath} does not match its manifest record`)
    files.set(relativePath, bytes)
  }

  const video = files.get('uncountable-yet-zero-length.mp4')!
  if (video.length < 12 || video.toString('ascii', 4, 8) !== 'ftyp') fail('retained render is not an MP4 container')
  validateRenderMetadata(
    parseJson(files.get('render-metadata.json')!, 'render metadata'),
    video,
    files.get('uncountable-yet-zero-length.py')!,
  )
  validateBrowserSummary(parseJson(files.get('evidence/browser-summary.json')!, 'browser summary'), files)

  const renderFrame = pngDimensions(files.get('render-evidence/proofcanvas-manim-frame-12s.png')!, 'render evidence frame')
  if (renderFrame.width !== 854 || renderFrame.height !== 480) fail('render evidence frame has unexpected dimensions')

  const project = parseJson(files.get('uncountable-yet-zero-length.proofcanvas.json')!, 'example project')
  if (record(project.metadata, 'example project metadata').id !== PROJECT_ID) fail('example project ID does not match the manifest')
  const ai = parseJson(files.get('ai-command-results.json')!, 'AI command evidence')
  if (
    ai.artifactVersion !== 1
    || ai.projectId !== PROJECT_ID
    || !Array.isArray(ai.commands)
    || ai.commands.length !== 5
    || ai.commands.some((value) => record(value, 'AI command result').undoRestoredExactProject !== true)
  ) fail('AI command evidence does not prove five reversible transactions')
}
