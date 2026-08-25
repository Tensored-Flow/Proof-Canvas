import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { compileManim } from '../../lib/proofcanvas/compiler'
import { generateAiCommandEvidence } from './artifact-ai'
import {
  PROJECT_SCHEMA_VERSION,
  PROOFCANVAS_RENDER_SOURCE_MAX_BYTES,
  ProjectDocumentSchema,
  canonicalProjectJson,
  projectDurationSeconds,
} from '../../lib/proofcanvas/schema'

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
type RenderMetadata = JsonRecord & {
  codec: 'h264'
  width: 854
  height: 480
  fps: number
  durationSeconds: number
  frames: number
  evidenceFrameSeconds: number
  evidenceFrameSha256: string
}

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

function validatePythonAst(source: Buffer): void {
  const parsed = spawnSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], {
    input: source,
    encoding: 'utf8',
    maxBuffer: PROOFCANVAS_RENDER_SOURCE_MAX_BYTES,
    timeout: 5_000,
  })
  if (parsed.error || parsed.status !== 0 || parsed.signal) fail('retained generated Python does not parse as a Python module')
}

const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function pngDimensions(bytes: Buffer, label: string): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) fail(`${label} is not a canonical PNG`)
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  let phase: 'header' | 'data' | 'end' = 'header'
  const compressed: Buffer[] = []
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) fail(`${label} has a truncated PNG chunk`)
    const chunkLength = bytes.readUInt32BE(offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + chunkLength
    const chunkEnd = dataEnd + 4
    if (chunkEnd > bytes.length) fail(`${label} has a truncated PNG chunk`)
    const chunkType = bytes.toString('ascii', offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/.test(chunkType)) fail(`${label} has an invalid PNG chunk type`)
    if (pngCrc32(bytes.subarray(offset + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) fail(`${label} has an invalid PNG chunk CRC`)
    if (chunkType === 'IHDR') {
      if (offset !== 8 || chunkLength !== 13 || width !== 0) fail(`${label} has a noncanonical PNG header`)
      width = bytes.readUInt32BE(dataStart)
      height = bytes.readUInt32BE(dataStart + 4)
      const bitDepth = bytes[dataStart + 8]
      const colorType = bytes[dataStart + 9]
      if (
        width <= 0 || height <= 0
        || bitDepth !== 8 || ![2, 6].includes(colorType)
        || bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] !== 0
      ) fail(`${label} has an unsupported canonical PNG pixel format`)
      channels = colorType === 2 ? 3 : 4
    } else if (chunkType === 'IDAT') {
      if (width === 0 || phase === 'end') fail(`${label} has an out-of-order PNG data chunk`)
      phase = 'data'
      compressed.push(bytes.subarray(dataStart, dataEnd))
    } else if (chunkType === 'IEND') {
      if (phase !== 'data' || chunkLength !== 0 || chunkEnd !== bytes.length) fail(`${label} has a noncanonical PNG terminator`)
      phase = 'end'
    } else {
      fail(`${label} contains unsupported noncanonical PNG chunk ${chunkType}`)
    }
    offset = chunkEnd
  }
  if (phase !== 'end' || compressed.length === 0) fail(`${label} is missing canonical PNG image data`)
  const rowBytes = 1 + width * channels
  const expectedInflatedBytes = rowBytes * height
  let pixels: Buffer
  try {
    pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedInflatedBytes })
  } catch {
    fail(`${label} contains invalid PNG image data`)
  }
  if (pixels.byteLength !== expectedInflatedBytes) fail(`${label} has an unexpected PNG pixel payload`)
  for (let row = 0; row < height; row += 1) {
    if (pixels[row * rowBytes] > 4) fail(`${label} has an invalid PNG row filter`)
  }
  return { width, height }
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

function validateRenderMetadata(metadata: JsonRecord, video: Buffer, source: Buffer, evidenceFrame: Buffer): RenderMetadata {
  if (metadata.genuineManimRender !== true || metadata.manimVersion !== '0.21.0' || metadata.image !== MANIM_IMAGE) {
    fail('render metadata does not identify the accepted genuine Manim execution')
  }
  if (metadata.codec !== 'h264' || metadata.width !== 854 || metadata.height !== 480) fail('render metadata has an unexpected video format')
  if (typeof metadata.fps !== 'number' || metadata.fps < 14.9 || metadata.fps > 15.1) fail('render metadata has an unexpected frame rate')
  if (typeof metadata.durationSeconds !== 'number' || metadata.durationSeconds < 20 || metadata.durationSeconds > 35) fail('render metadata has an unexpected duration')
  if (!Number.isSafeInteger(metadata.frames) || (metadata.frames as number) <= 0) fail('render metadata has an invalid frame count')
  if (typeof metadata.evidenceFrameSeconds !== 'number' || metadata.evidenceFrameSeconds <= 0 || metadata.evidenceFrameSeconds >= metadata.durationSeconds) fail('render metadata has an invalid evidence-frame timestamp')
  if (metadata.bytes !== video.byteLength || metadata.sha256 !== sha256(video)) fail('render metadata does not match the retained MP4')
  if (metadata.sourceSha256 !== sha256(source)) fail('render metadata does not match the retained generated Python')
  if (metadata.evidenceFrameSha256 !== sha256(evidenceFrame)) fail('render metadata does not match the retained evidence frame')
  return metadata as RenderMetadata
}

const DECODE_FRAME_SCRIPT = `
import av, hashlib, io, json
container = av.open('/input/video.mp4')
streams = container.streams.video
if len(streams) != 1:
    raise SystemExit('expected exactly one video stream')
stream = streams[0]
duration = float(container.duration / av.time_base) if container.duration else 0.0
fps = float(stream.average_rate) if stream.average_rate else 0.0
target = min(12.5, max(0.0, duration - 0.5))
selected = None
selected_seconds = None
decoded_frames = 0
for frame in container.decode(video=0):
    decoded_frames += 1
    seconds = float(frame.pts * frame.time_base) if frame.pts is not None else 0.0
    if selected is None and seconds >= target:
        output = io.BytesIO()
        frame.to_image().save(output, format='PNG')
        selected = hashlib.sha256(output.getvalue()).hexdigest()
        selected_seconds = seconds
if selected is None:
    raise SystemExit('video contained no evidence frame')
print(json.dumps({
    'codec': stream.codec_context.name,
    'width': stream.width,
    'height': stream.height,
    'fps': fps,
    'durationSeconds': duration,
    'decodedFrames': decoded_frames,
    'evidenceFrameSeconds': selected_seconds,
    'evidenceFrameSha256': selected,
}, sort_keys=True))
`

function validateDecodedFrameProvenance(videoPath: string, metadata: RenderMetadata): void {
  const decoded = spawnSync('docker', [
    'run', '--rm', '--init', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--memory-swap=512m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=700,uid=1000,gid=1000',
    '--tmpfs', '/manim:rw,nosuid,nodev,size=64m,mode=700,uid=1000,gid=1000',
    '--volume', `${videoPath}:/input/video.mp4:ro`,
    MANIM_IMAGE, 'python', '-c', DECODE_FRAME_SCRIPT,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 60_000 })
  if (decoded.error || decoded.status !== 0 || decoded.signal) fail('retained MP4 could not be fully decoded in the pinned Manim image')
  let result: JsonRecord
  try {
    result = record(JSON.parse(decoded.stdout.trim()), 'decoded render provenance')
  } catch {
    fail('pinned Manim decode returned malformed provenance')
  }
  if (
    result.codec !== metadata.codec
    || result.width !== metadata.width
    || result.height !== metadata.height
    || result.decodedFrames !== metadata.frames
    || typeof result.fps !== 'number' || Math.abs(result.fps - metadata.fps) > 1e-9
    || typeof result.durationSeconds !== 'number' || Math.abs(result.durationSeconds - metadata.durationSeconds) > 1e-9
    || typeof result.evidenceFrameSeconds !== 'number' || Math.abs(result.evidenceFrameSeconds - metadata.evidenceFrameSeconds) > 1e-9
    || result.evidenceFrameSha256 !== metadata.evidenceFrameSha256
  ) fail('retained MP4 decode does not reproduce its render metadata and evidence frame')
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

async function verifyArtifactManifestInternal(repositoryRoot: string, decodeRetainedVideo: boolean): Promise<void> {
  const root = path.resolve(repositoryRoot)
  const baseDirectory = path.join(root, 'examples', 'proofcanvas')
  const manifestBytes = await readFile(path.join(baseDirectory, 'artifact-manifest.json'))
  const manifest = parseJson(manifestBytes, 'artifact manifest')
  if (
    manifest.artifactVersion !== 1
    || manifest.projectId !== PROJECT_ID
    || manifest.schemaVersion !== PROJECT_SCHEMA_VERSION
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
  const renderFrameBytes = files.get('render-evidence/proofcanvas-manim-frame-12s.png')!
  const renderFrame = pngDimensions(renderFrameBytes, 'render evidence frame')
  if (renderFrame.width !== 854 || renderFrame.height !== 480) fail('render evidence frame has unexpected dimensions')
  const renderMetadata = validateRenderMetadata(
    parseJson(files.get('render-metadata.json')!, 'render metadata'),
    video,
    files.get('uncountable-yet-zero-length.py')!,
    renderFrameBytes,
  )
  if (decodeRetainedVideo) {
    validateDecodedFrameProvenance(path.join(baseDirectory, 'uncountable-yet-zero-length.mp4'), renderMetadata)
  }
  validateBrowserSummary(parseJson(files.get('evidence/browser-summary.json')!, 'browser summary'), files)

  const projectBytes = files.get('uncountable-yet-zero-length.proofcanvas.json')!
  const projectInput = parseJson(projectBytes, 'example project')
  const projectResult = ProjectDocumentSchema.safeParse(projectInput)
  if (!projectResult.success) fail('example project does not satisfy the current project schema')
  const project = projectResult.data
  const canonicalProjectBytes = Buffer.from(canonicalProjectJson(project), 'utf8')
  if (!projectBytes.equals(canonicalProjectBytes)) fail('example project is not canonical JSON')
  if (record(project.metadata, 'example project metadata').id !== PROJECT_ID) fail('example project ID does not match the manifest')
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION || project.schemaVersion !== manifest.schemaVersion) fail('example project schema does not match the manifest')
  if (manifest.durationSeconds !== projectDurationSeconds(project)) fail('manifest duration does not match the example project')

  const firstCompilation = compileManim(project)
  const secondCompilation = compileManim(project)
  if (
    firstCompilation.python !== secondCompilation.python
    || JSON.stringify(firstCompilation.diagnostics) !== JSON.stringify(secondCompilation.diagnostics)
  ) fail('example project compiler output is not deterministic')
  const retainedPython = files.get('uncountable-yet-zero-length.py')!
  if (!retainedPython.equals(Buffer.from(firstCompilation.python, 'utf8'))) fail('retained generated Python does not match the example project compilation')
  if (JSON.stringify(manifest.diagnostics) !== JSON.stringify(firstCompilation.diagnostics)) fail('manifest diagnostics do not match the example project compilation')
  validatePythonAst(retainedPython)

  const aiBytes = files.get('ai-command-results.json')!
  const ai = parseJson(aiBytes, 'AI command evidence')
  if (
    ai.artifactVersion !== 1
    || ai.projectId !== PROJECT_ID
    || !Array.isArray(ai.commands)
    || ai.commands.length !== 5
    || ai.commands.some((value) => record(value, 'AI command result').undoRestoredExactProject !== true)
  ) fail('AI command evidence does not prove five reversible transactions')
  const expectedAiBytes = Buffer.from(`${JSON.stringify({
    artifactVersion: 1,
    projectId: project.metadata.id,
    commands: generateAiCommandEvidence(project),
  }, null, 2)}\n`, 'utf8')
  if (!aiBytes.equals(expectedAiBytes)) fail('AI command evidence does not match deterministic execution against the example project')
}

/** Full production verifier, including a pinned full decode of the retained MP4. */
export async function verifyArtifactManifest(repositoryRoot: string): Promise<void> {
  return verifyArtifactManifestInternal(repositoryRoot, true)
}

/** Unit-test entrypoint; all byte relations run, while the external pinned decode is exercised by the acceptance command. */
export async function verifyArtifactManifestWithoutVideoDecodeForUnitTests(repositoryRoot: string): Promise<void> {
  return verifyArtifactManifestInternal(repositoryRoot, false)
}
