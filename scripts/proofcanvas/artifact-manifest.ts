import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { exportSrtCaptions, importSrtCaptions, projectSequenceCaptions } from '../../lib/proofcanvas/captions'
import { compileManim } from '../../lib/proofcanvas/compiler'
import { DETERMINISTIC_AUDIO_FIXTURE, createCantorV1Project } from '../../lib/proofcanvas/demo'
import { PROOFCANVAS_STRESS_INVENTORY, createProofCanvasStressProject } from '../../lib/proofcanvas/stressFixture'
import { generateAiCommandEvidence } from './artifact-ai'
import {
  PROJECT_SCHEMA_VERSION,
  PROOFCANVAS_RENDER_SOURCE_MAX_BYTES,
  ProjectDocumentSchema,
  canonicalProjectJson,
  projectDurationSeconds,
} from '../../lib/proofcanvas/schema'

export const NATIVE_SHAPE_PARITY_ARTIFACT_PATHS = Object.freeze([
  'native-shape-parity/authoring-desktop-1440x900.png',
  'native-shape-parity/authoring-locked-1440x900.png',
  'native-shape-parity/authoring-playback-1440x900.png',
  'native-shape-parity/authoring-portrait-1024x1366.png',
  'native-shape-parity/browser-authoring.json',
  'native-shape-parity/browser-capture.json',
  'native-shape-parity/browser-report.json',
  'native-shape-parity/browser-stage.png',
  'native-shape-parity/browser-stage.svg',
  'native-shape-parity/comparison-dashed-line.png',
  'native-shape-parity/comparison-double-arrow.png',
  'native-shape-parity/comparison-ellipse.png',
  'native-shape-parity/comparison-freeform-path.png',
  'native-shape-parity/comparison-polygon.png',
  'native-shape-parity/compiler.json',
  'native-shape-parity/evidence-manifest.json',
  'native-shape-parity/generated.py',
  'native-shape-parity/manim-frame.png',
  'native-shape-parity/manim-render.log',
  'native-shape-parity/parity-report.json',
  'native-shape-parity/project.proofcanvas.json',
])

export const EXPECTED_ARTIFACT_PATHS = Object.freeze([
  'uncountable-yet-zero-length.proofcanvas.json',
  'uncountable-yet-zero-length.py',
  'proofcanvas-deterministic-pulse-90s.wav',
  'uncountable-yet-zero-length.proofcanvas',
  'uncountable-yet-zero-length.srt',
  'browser-import-proof-caption.srt',
  'ai-command-results.json',
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
])

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MANIM_IMAGE = 'manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3'
const PROJECT_ID = 'project-uncountable-zero-length'
const BROWSER_IMPORT_CAPTION_FIXTURE = '1\r\n00:00:01,000 --> 00:00:03,000\r\nBrowser-imported proof caption\r\n\r\n'
const NATIVE_SHAPE_PARITY_MAX_BYTES = 8 * 1024 * 1024
const NATIVE_SHAPE_PARITY_ARTIFACT_PATH_SET = new Set<string>(NATIVE_SHAPE_PARITY_ARTIFACT_PATHS)

type JsonRecord = Record<string, unknown>
type FileRecord = { bytes: number; sha256: string }
type RenderMetadata = JsonRecord & {
  codec: 'h264'
  audioCodec: 'aac'
  width: 1280
  height: 720
  fps: number
  durationSeconds: number
  frames: number
  decodedAudioFrames: number
  decodedAudioSamples: number
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

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
}

function validateStressResults(bytes: Buffer): void {
  const stress = parseJson(bytes, 'stress results')
  if (!bytes.equals(Buffer.from(`${JSON.stringify(stress, null, 2)}\n`, 'utf8'))) fail('stress results are not canonical JSON')
  if (!hasExactKeys(stress, ['environment', 'fixture', 'format', 'method', 'metrics', 'pass'])) fail('stress results have an unexpected shape')
  if (stress.format !== 'proofcanvas-stress-results-v1' || stress.pass !== true) fail('stress results do not report a passing V1 benchmark')

  const canonicalStress = Buffer.from(canonicalProjectJson(createProofCanvasStressProject()), 'utf8')
  const fixture = record(stress.fixture, 'stress fixture record')
  if (
    !hasExactKeys(fixture, ['animations', 'audioSeconds', 'canonicalBytes', 'canonicalSha256', 'keyframes', 'objects', 'shots'])
    || fixture.shots !== PROOFCANVAS_STRESS_INVENTORY.shots
    || fixture.objects !== PROOFCANVAS_STRESS_INVENTORY.objects
    || fixture.animations !== PROOFCANVAS_STRESS_INVENTORY.animations
    || fixture.keyframes !== PROOFCANVAS_STRESS_INVENTORY.keyframes
    || fixture.audioSeconds !== PROOFCANVAS_STRESS_INVENTORY.audioSeconds
    || fixture.canonicalBytes !== canonicalStress.byteLength
    || fixture.canonicalSha256 !== sha256(canonicalStress)
  ) fail('stress results do not bind the canonical V1 stress fixture')

  const method = record(stress.method, 'stress method record')
  if (
    !hasExactKeys(method, ['aggregation', 'clock', 'iterations', 'scope'])
    || method.clock !== 'performance.now monotonic milliseconds'
    || method.iterations !== 5
    || method.aggregation !== 'median with minimum and maximum retained; every sample must remain below its regression budget'
    || method.scope !== 'headless shared-core operations; not a browser frame-rate or human-usability claim'
  ) fail('stress results do not describe the bounded benchmark method')

  const environment = record(stress.environment, 'stress environment record')
  if (
    !hasExactKeys(environment, ['architecture', 'logicalCpuCount', 'node', 'platform', 'release'])
    || typeof environment.node !== 'string' || !/^v\d+\.\d+\.\d+$/.test(environment.node)
    || typeof environment.platform !== 'string' || environment.platform.length === 0
    || typeof environment.release !== 'string' || environment.release.length === 0
    || typeof environment.architecture !== 'string' || environment.architecture.length === 0
    || !Number.isSafeInteger(environment.logicalCpuCount) || (environment.logicalCpuCount as number) <= 0
  ) fail('stress results omit their execution environment')

  const expectedBudgets: Record<string, number> = {
    fixtureCreation: 5_000,
    editorLoad: 5_000,
    timelineInteraction: 2_000,
    playback: 3_000,
    selection: 2_000,
    inspectorUpdate: 5_000,
    autosaveSerialization: 2_000,
    compilation: 10_000,
  }
  const metrics = record(stress.metrics, 'stress metrics record')
  if (!hasExactKeys(metrics, Object.keys(expectedBudgets))) fail('stress results have an unexpected metric inventory')
  for (const [name, budget] of Object.entries(expectedBudgets)) {
    const metric = record(metrics[name], `stress metric ${name}`)
    if (!hasExactKeys(metric, ['budgetMs', 'maximumMs', 'medianMs', 'minimumMs', 'pass'])) fail(`stress metric ${name} has an unexpected shape`)
    const minimum = metric.minimumMs
    const median = metric.medianMs
    const maximum = metric.maximumMs
    if (
      typeof minimum !== 'number' || !Number.isFinite(minimum) || minimum < 0
      || typeof median !== 'number' || !Number.isFinite(median) || median < minimum
      || typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum < median
      || metric.budgetMs !== budget || metric.pass !== true || maximum >= budget
    ) fail(`stress metric ${name} does not prove every retained sample passed its budget`)
  }
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
  if (NATIVE_SHAPE_PARITY_ARTIFACT_PATH_SET.has(relativePath) && stat.size > NATIVE_SHAPE_PARITY_MAX_BYTES) {
    fail(`${relativePath} exceeds the native-shape parity artifact size limit`)
  }
  return readFile(absolutePath)
}

function validateRenderMetadata(
  metadata: JsonRecord,
  video: Buffer,
  source: Buffer,
  project: Buffer,
  packageBytes: Buffer,
  wav: Buffer,
  evidenceFrame: Buffer,
): RenderMetadata {
  if (
    metadata.genuineManimRender !== true
    || metadata.sidecarValidated !== true
    || metadata.manimVersion !== '0.21.0'
    || metadata.image !== MANIM_IMAGE
    || typeof metadata.ffmpegVersion !== 'string'
    || !metadata.ffmpegVersion.startsWith('ffmpeg version 7.1.5-0+deb13u1 ')
  ) {
    fail('render metadata does not identify the accepted genuine Manim execution')
  }
  if (
    metadata.codec !== 'h264'
    || metadata.audioCodec !== 'aac'
    || metadata.videoStreams !== 1
    || metadata.audioStreams !== 1
    || metadata.audioSampleRate !== 48_000
    || metadata.audioChannels !== 2
    || metadata.width !== 1280
    || metadata.height !== 720
  ) fail('render metadata has an unexpected video or audio format')
  if (typeof metadata.fps !== 'number' || metadata.fps < 29.9 || metadata.fps > 30.1) fail('render metadata has an unexpected frame rate')
  if (typeof metadata.durationSeconds !== 'number' || metadata.durationSeconds < 45 || metadata.durationSeconds > 60) fail('render metadata has an unexpected duration')
  if (typeof metadata.audioDurationSeconds !== 'number' || Math.abs(metadata.audioDurationSeconds - 52) > 0.05) fail('render metadata has an unexpected decoded audio duration')
  if (!Number.isSafeInteger(metadata.frames) || (metadata.frames as number) <= 0) fail('render metadata has an invalid frame count')
  if (!Number.isSafeInteger(metadata.decodedAudioFrames) || (metadata.decodedAudioFrames as number) <= 0) fail('render metadata has an invalid decoded audio frame count')
  if (!Number.isSafeInteger(metadata.decodedAudioSamples) || Math.abs((metadata.decodedAudioSamples as number) - 52 * 48_000) > 2_048) fail('render metadata has an invalid decoded audio sample count')
  if (typeof metadata.evidenceFrameSeconds !== 'number' || metadata.evidenceFrameSeconds <= 0 || metadata.evidenceFrameSeconds >= metadata.durationSeconds) fail('render metadata has an invalid evidence-frame timestamp')
  if (metadata.bytes !== video.byteLength || metadata.sha256 !== sha256(video)) fail('render metadata does not match the retained MP4')
  if (metadata.sourceSha256 !== sha256(source)) fail('render metadata does not match the retained generated Python')
  if (metadata.projectSha256 !== sha256(project)) fail('render metadata does not match the retained canonical project')
  if (metadata.packageSha256 !== sha256(packageBytes)) fail('render metadata does not match the retained ProofCanvas package')
  if (metadata.audioFixtureSha256 !== sha256(wav)) fail('render metadata does not match the retained deterministic WAV')
  if (metadata.evidenceFrameSha256 !== sha256(evidenceFrame)) fail('render metadata does not match the retained evidence frame')
  return metadata as RenderMetadata
}

function validateStrictPackageRoundTrip(
  repositoryRoot: string,
  projectPath: string,
  wavPath: string,
  packagePath: string,
  projectBytes: Buffer,
  wavBytes: Buffer,
  packageBytes: Buffer,
): void {
  const helper = path.join(process.cwd(), 'scripts', 'proofcanvas', 'artifact-package.ts')
  const result = spawnSync(process.execPath, [
    '--conditions=react-server', '--import', 'tsx', helper,
    'verify', projectPath, wavPath, packagePath,
  ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 30_000 })
  if (result.error || result.status !== 0 || result.signal) fail('retained ProofCanvas package failed strict codec verification')
  let evidence: JsonRecord
  try {
    evidence = record(JSON.parse(result.stdout), 'strict package verification evidence')
  } catch {
    fail('strict package verifier returned malformed evidence')
  }
  if (
    evidence.roundTripVerified !== true
    || evidence.byteStable !== true
    || evidence.sourceRevision !== 1
    || evidence.bytes !== packageBytes.byteLength
    || evidence.sha256 !== sha256(packageBytes)
    || evidence.projectSha256 !== sha256(projectBytes)
    || evidence.assetSha256 !== sha256(wavBytes)
  ) fail('strict package verification evidence does not match retained bytes')
}

const DECODE_FRAME_SCRIPT = `
import av, hashlib, io, json
container = av.open('/input/video.mp4')
streams = list(container.streams)
videos = list(container.streams.video)
audios = list(container.streams.audio)
if len(streams) != 2 or len(videos) != 1 or len(audios) != 1:
    raise SystemExit('expected exactly one video and one audio stream')
stream = videos[0]
audio = audios[0]
video_codec = stream.codec_context.name
audio_codec = audio.codec_context.name
audio_sample_rate = audio.codec_context.sample_rate
audio_channels = audio.codec_context.channels
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
container.close()
audio_container = av.open('/input/video.mp4')
audio_stream = list(audio_container.streams.audio)[0]
decoded_audio_frames = 0
decoded_audio_samples = 0
for frame in audio_container.decode(audio_stream):
    decoded_audio_frames += 1
    decoded_audio_samples += frame.samples
print(json.dumps({
    'codec': video_codec,
    'width': stream.width,
    'height': stream.height,
    'fps': fps,
    'durationSeconds': duration,
    'decodedFrames': decoded_frames,
    'audioCodec': audio_codec,
    'audioSampleRate': audio_sample_rate,
    'audioChannels': audio_channels,
    'decodedAudioFrames': decoded_audio_frames,
    'decodedAudioSamples': decoded_audio_samples,
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
    || result.audioCodec !== metadata.audioCodec
    || result.audioSampleRate !== 48_000
    || result.audioChannels !== 2
    || result.decodedAudioFrames !== metadata.decodedAudioFrames
    || result.decodedAudioSamples !== metadata.decodedAudioSamples
    || result.width !== metadata.width
    || result.height !== metadata.height
    || result.decodedFrames !== metadata.frames
    || typeof result.fps !== 'number' || Math.abs(result.fps - metadata.fps) > 1e-9
    || typeof result.durationSeconds !== 'number' || Math.abs(result.durationSeconds - metadata.durationSeconds) > 1e-9
    || typeof result.evidenceFrameSeconds !== 'number' || Math.abs(result.evidenceFrameSeconds - metadata.evidenceFrameSeconds) > 1e-9
    || result.evidenceFrameSha256 !== metadata.evidenceFrameSha256
  ) fail('retained MP4 decode does not reproduce its render metadata and evidence frame')
}

function validateDecodedStillProvenance(repositoryRoot: string, stillPath: string, stillBytes: Buffer): void {
  const verifierPath = path.join(repositoryRoot, 'scripts', 'proofcanvas', 'verify-png-evidence.py')
  const decoded = spawnSync('docker', [
    'run', '--rm', '--init', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=256m', '--memory-swap=256m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=700,uid=1000,gid=1000',
    '--volume', `${stillPath}:/input/still.png:ro`,
    '--volume', `${verifierPath}:/verify-png-evidence.py:ro`,
    MANIM_IMAGE, 'python', '/verify-png-evidence.py', '/input/still.png', '--width', '1280', '--height', '720',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024, timeout: 60_000 })
  if (decoded.error || decoded.status !== 0 || decoded.signal) fail('retained still PNG could not be fully decoded in the pinned Manim image')
  let receipt: JsonRecord
  try {
    receipt = record(JSON.parse(decoded.stdout.trim()), 'decoded still provenance')
  } catch {
    fail('pinned still decode returned malformed provenance')
  }
  if (
    !hasExactKeys(receipt, ['bytes', 'decoder', 'format', 'fullDecodeVerified', 'height', 'path', 'sha256', 'width'])
    || receipt.bytes !== stillBytes.byteLength
    || receipt.sha256 !== sha256(stillBytes)
    || receipt.decoder !== 'pillow-pinned-renderer-image'
    || receipt.format !== 'png'
    || receipt.fullDecodeVerified !== true
    || receipt.width !== 1280 || receipt.height !== 720
    || receipt.path !== '/input/still.png'
  ) fail('pinned still decode does not bind the retained PNG bytes')
}

function validateNativeShapeParityProvenance(repositoryRoot: string, evidenceDirectory: string): void {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    fail('native-shape parity verification requires a POSIX host identity')
  }
  const verified = spawnSync('docker', [
    'run', '--rm', '--init', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=1g', '--memory-swap=1g',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--volume', `${repositoryRoot}:/workspace:ro`,
    '--volume', `${evidenceDirectory}:/evidence:ro`,
    '--workdir', '/workspace',
    '--env', 'HOME=/tmp',
    MANIM_IMAGE,
    'python', 'scripts/proofcanvas/native-shape-parity/analyze.py',
    '--verify-retained', '/evidence', '/workspace',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 120_000 })
  if (verified.error || verified.status !== 0 || verified.signal) {
    fail('retained native-shape parity evidence failed verification in the pinned Manim image')
  }
}

function validateBrowserSummary(summary: JsonRecord, files: Map<string, Buffer>): void {
  if (
    !hasExactKeys(summary, ['executions', 'failures', 'journey', 'package', 'restart', 'renders', 'retried', 'schemaVersion', 'screenshots', 'skipped', 'still', 'stress'])
    || summary.schemaVersion !== 1
    || summary.journey !== 'complete structured edit-to-Manim journey'
    || summary.executions !== 4
    || summary.skipped !== 0
    || summary.retried !== 0
    || summary.failures !== 0
  ) fail('browser summary does not prove four clean acceptance executions')

  const browserStress = record(summary.stress, 'browser stress record')
  const browserStressFixture = record(browserStress.fixture, 'browser stress fixture')
  const canonicalBrowserStress = Buffer.from(canonicalProjectJson(createProofCanvasStressProject()), 'utf8')
  if (
    !hasExactKeys(browserStress, [
      'activeAnimations', 'activeKeyframes', 'activeObjects', 'aggregateVerified', 'audioMetadataReady', 'autosaveSaved', 'fixture',
      'importDurationMs', 'importedThroughOwnerUi', 'interactionDurationMs', 'primaryInspectorUpdated',
      'playbackAdvanced', 'primaryEditReloadPersisted', 'reloadPersisted', 'schemaVersion', 'selectedObjects', 'timelineScrubbed',
    ])
    || !hasExactKeys(browserStressFixture, ['animations', 'audioSeconds', 'canonicalBytes', 'canonicalSha256', 'keyframes', 'objects', 'shots'])
    || browserStressFixture.shots !== PROOFCANVAS_STRESS_INVENTORY.shots
    || browserStressFixture.objects !== PROOFCANVAS_STRESS_INVENTORY.objects
    || browserStressFixture.animations !== PROOFCANVAS_STRESS_INVENTORY.animations
    || browserStressFixture.keyframes !== PROOFCANVAS_STRESS_INVENTORY.keyframes
    || browserStressFixture.audioSeconds !== PROOFCANVAS_STRESS_INVENTORY.audioSeconds
    || browserStressFixture.canonicalBytes !== canonicalBrowserStress.byteLength
    || browserStressFixture.canonicalSha256 !== sha256(canonicalBrowserStress)
    || browserStress.schemaVersion !== 1
    || browserStress.importedThroughOwnerUi !== true
    || browserStress.activeObjects !== 15 || browserStress.activeAnimations !== 25 || browserStress.activeKeyframes !== 40
    || browserStress.aggregateVerified !== true || browserStress.audioMetadataReady !== true
    || browserStress.timelineScrubbed !== true || browserStress.selectedObjects !== 10 || browserStress.primaryInspectorUpdated !== true
    || browserStress.playbackAdvanced !== true || browserStress.autosaveSaved !== true || browserStress.reloadPersisted !== true
    || browserStress.primaryEditReloadPersisted !== true
    || !Number.isSafeInteger(browserStress.importDurationMs) || (browserStress.importDurationMs as number) < 0 || (browserStress.importDurationMs as number) > 120_000
    || !Number.isSafeInteger(browserStress.interactionDurationMs) || (browserStress.interactionDurationMs as number) < 0 || (browserStress.interactionDurationMs as number) > 120_000
  ) fail('browser summary does not prove the exact deterministic stress fixture in the real editor')

  const restart = record(summary.restart, 'browser restart record')
  if (
    restart.journey !== 'reopens the durable portrait project after a controlled application process restart'
    || restart.status !== 'passed'
    || typeof restart.durationMs !== 'number' || restart.durationMs < 0
  ) fail('browser summary does not prove controlled process-restart persistence')

  if (!Array.isArray(summary.screenshots) || summary.screenshots.length !== 16) fail('browser summary must describe exactly sixteen screenshots')
  const expectedScreenshots = new Map([
    ['proofcanvas-dashboard-1920x1080.png', { project: 'dashboard', width: 1920, height: 1080 }],
    ['proofcanvas-blank-editor-1920x1080.png', { project: 'blank-editor', width: 1920, height: 1080 }],
    ['proofcanvas-selected-text-1920x1080.png', { project: 'selected-text', width: 1920, height: 1080 }],
    ['proofcanvas-selected-graph-1920x1080.png', { project: 'selected-graph', width: 1920, height: 1080 }],
    ['proofcanvas-timeline-keyframes-1920x1080.png', { project: 'timeline-keyframes', width: 1920, height: 1080 }],
    ['proofcanvas-style-lab-1920x1080.png', { project: 'style-lab', width: 1920, height: 1080 }],
    ['proofcanvas-style-nocturne-chalk-1920x1080.png', { project: 'style-nocturne-chalk', width: 1920, height: 1080 }],
    ['proofcanvas-style-scientific-minimal-1920x1080.png', { project: 'style-scientific-minimal', width: 1920, height: 1080 }],
    ['proofcanvas-animation-inspector-1920x1080.png', { project: 'animation-inspector', width: 1920, height: 1080 }],
    ['proofcanvas-ai-proposal-review-1920x1080.png', { project: 'ai-proposal-review', width: 1920, height: 1080 }],
    ['proofcanvas-render-dialog-1440x900.png', { project: 'render-dialog', width: 1440, height: 900 }],
    ['proofcanvas-editorial-1920x1080.png', { project: 'proofcanvas-chromium-1920', width: 1920, height: 1080 }],
    ['proofcanvas-editorial-1440x900.png', { project: 'proofcanvas-chromium-1440', width: 1440, height: 900 }],
    ['proofcanvas-editorial-1280x800.png', { project: 'proofcanvas-chromium-1280', width: 1280, height: 800 }],
    ['proofcanvas-narrow-editor-1024x768.png', { project: 'narrow-editor', width: 1024, height: 768 }],
    ['proofcanvas-portrait-output-1440x900.png', { project: 'portrait-output-authoring', width: 1440, height: 900 }],
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

  if (!Array.isArray(summary.renders) || summary.renders.length !== 2) fail('browser summary must describe exactly two renders')
  const expectedRenders = new Map([
    ['proofcanvas-render.mp4', { width: 1280, height: 720, fps: 30, audioCodec: 'aac' }],
    ['proofcanvas-portrait-480x854-24fps.mp4', { width: 480, height: 854, fps: 24, audioCodec: null }],
  ])
  const seenRenders = new Set<string>()
  for (const value of summary.renders) {
    const render = record(value, 'browser render record')
    if (typeof render.file !== 'string' || seenRenders.has(render.file)) fail('browser summary contains an unexpected or duplicate render')
    const expected = expectedRenders.get(render.file)
    if (
      !expected
      || render.videoCodec !== 'h264' || render.audioCodec !== expected.audioCodec
      || render.width !== expected.width || render.height !== expected.height || render.fps !== expected.fps
      || !Number.isSafeInteger(render.bytes) || (render.bytes as number) <= 32 || (render.bytes as number) > 256 * 1024 * 1024
      || typeof render.sha256 !== 'string' || !SHA256_PATTERN.test(render.sha256)
      || typeof render.durationSeconds !== 'number' || render.durationSeconds <= 0 || render.durationSeconds > 310
      || !Number.isSafeInteger(render.decodedFrames) || (render.decodedFrames as number) <= 0
      || !Number.isSafeInteger(render.decodedAudioSamples) || (render.decodedAudioSamples as number) < 0
      || (expected.audioCodec === 'aac' ? (render.decodedAudioSamples as number) <= 0 : render.decodedAudioSamples !== 0)
      || render.fullDecodeVerified !== true
    ) fail('browser summary does not prove an exact fully decoded UI-downloaded MP4')
    seenRenders.add(render.file)
  }
  if (seenRenders.size !== expectedRenders.size) fail('browser summary omitted an expected render')

  const still = record(summary.still, 'browser still record')
  const stillBytes = files.get('evidence/proofcanvas-still-current.png')
  if (!stillBytes) fail('retained browser still PNG is missing')
  const stillDimensions = pngDimensions(stillBytes, 'evidence/proofcanvas-still-current.png')
  if (
    still.file !== 'proofcanvas-still-current.png' || still.width !== 1280 || still.height !== 720
    || stillDimensions.width !== 1280 || stillDimensions.height !== 720
    || still.bytes !== stillBytes.byteLength || still.sha256 !== sha256(stillBytes)
    || !Number.isSafeInteger(still.bytes) || (still.bytes as number) <= 32 || (still.bytes as number) > 16 * 1024 * 1024
    || typeof still.sha256 !== 'string' || !SHA256_PATTERN.test(still.sha256)
    || still.decoder !== 'pillow-pinned-renderer-image'
    || still.fullDecodeVerified !== true
  ) fail('browser summary does not prove the playhead still PNG')

  const packageRecord = record(summary.package, 'browser package record')
  if (
    packageRecord.file !== 'proofcanvas-v1-roundtrip.proofcanvas'
    || !Number.isSafeInteger(packageRecord.bytes) || (packageRecord.bytes as number) <= 32 || (packageRecord.bytes as number) > 132 * 1024 * 1024
    || typeof packageRecord.sha256 !== 'string' || !SHA256_PATTERN.test(packageRecord.sha256)
    || packageRecord.roundTripVerifiedInBrowser !== true
  ) fail('browser summary does not prove the portable-package round trip')
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
    || manifest.packageRoundTripVerified !== true
    || manifest.packageByteStable !== true
    || manifest.deterministicAudioSha256 !== DETERMINISTIC_AUDIO_FIXTURE.metadata.sha256
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
  if (decodeRetainedVideo) {
    validateNativeShapeParityProvenance(root, path.join(baseDirectory, 'native-shape-parity'))
  }

  const projectBytes = files.get('uncountable-yet-zero-length.proofcanvas.json')!
  const projectInput = parseJson(projectBytes, 'example project')
  const projectResult = ProjectDocumentSchema.safeParse(projectInput)
  if (!projectResult.success) fail('example project does not satisfy the current project schema')
  const project = projectResult.data
  const canonicalProjectBytes = Buffer.from(canonicalProjectJson(project), 'utf8')
  if (!projectBytes.equals(canonicalProjectBytes)) fail('example project is not canonical JSON')
  if (record(project.metadata, 'example project metadata').id !== PROJECT_ID) fail('example project ID does not match the manifest')
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION || project.schemaVersion !== manifest.schemaVersion) fail('example project schema does not match the manifest')
  if (manifest.durationSeconds !== projectDurationSeconds(project) || manifest.durationSeconds < 45 || manifest.durationSeconds > 60) fail('manifest duration does not match the 45-60 second V1 project')

  const firstCompilation = compileManim(project, { audioTransport: true })
  const secondCompilation = compileManim(project, { audioTransport: true })
  if (
    firstCompilation.python !== secondCompilation.python
    || JSON.stringify(firstCompilation.diagnostics) !== JSON.stringify(secondCompilation.diagnostics)
  ) fail('example project compiler output is not deterministic')
  const retainedPython = files.get('uncountable-yet-zero-length.py')!
  if (!retainedPython.equals(Buffer.from(firstCompilation.python, 'utf8'))) fail('retained generated Python does not match the example project compilation')
  if (JSON.stringify(manifest.diagnostics) !== JSON.stringify(firstCompilation.diagnostics)) fail('manifest diagnostics do not match the example project compilation')
  validatePythonAst(retainedPython)
  if (!projectBytes.equals(Buffer.from(canonicalProjectJson(createCantorV1Project()), 'utf8'))) fail('example project is not the canonical retained V1 project')

  const captionBytes = files.get('uncountable-yet-zero-length.srt')!
  const expectedCaptions = exportSrtCaptions(projectSequenceCaptions(project.shots))
  if (!expectedCaptions.ok || expectedCaptions.cueCount !== 11 || !captionBytes.equals(Buffer.from(expectedCaptions.text, 'utf8'))) {
    fail('retained SRT does not exactly match the canonical project caption sequence')
  }
  const importedCaptions = importSrtCaptions(captionBytes)
  if (!importedCaptions.ok || importedCaptions.clips.length !== expectedCaptions.cueCount) fail('retained SRT does not round-trip through the caption authority')
  const browserCaptionBytes = files.get('browser-import-proof-caption.srt')!
  const browserCaptions = importSrtCaptions(browserCaptionBytes)
  if (
    !browserCaptionBytes.equals(Buffer.from(BROWSER_IMPORT_CAPTION_FIXTURE, 'utf8'))
    || !browserCaptions.ok
    || browserCaptions.clips.length !== 1
    || browserCaptions.clips[0].start !== 1
    || browserCaptions.clips[0].end !== 3
    || browserCaptions.clips[0].text !== 'Browser-imported proof caption'
  ) fail('browser caption import fixture does not match its exact tested cue')

  const wavBytes = files.get('proofcanvas-deterministic-pulse-90s.wav')!
  if (
    project.assets.length !== 1
    || JSON.stringify(project.assets[0]) !== JSON.stringify(DETERMINISTIC_AUDIO_FIXTURE.metadata)
    || wavBytes.byteLength !== DETERMINISTIC_AUDIO_FIXTURE.metadata.size
    || sha256(wavBytes) !== DETERMINISTIC_AUDIO_FIXTURE.metadata.sha256
  ) fail('retained deterministic WAV does not match canonical V1 asset metadata')
  const packageBytes = files.get('uncountable-yet-zero-length.proofcanvas')!
  validateStrictPackageRoundTrip(
    root,
    path.join(baseDirectory, 'uncountable-yet-zero-length.proofcanvas.json'),
    path.join(baseDirectory, 'proofcanvas-deterministic-pulse-90s.wav'),
    path.join(baseDirectory, 'uncountable-yet-zero-length.proofcanvas'),
    projectBytes,
    wavBytes,
    packageBytes,
  )

  const video = files.get('uncountable-yet-zero-length.mp4')!
  if (video.length < 12 || video.toString('ascii', 4, 8) !== 'ftyp') fail('retained render is not an MP4 container')
  const renderFrameBytes = files.get('render-evidence/proofcanvas-manim-frame-12s.png')!
  const renderFrame = pngDimensions(renderFrameBytes, 'render evidence frame')
  if (renderFrame.width !== 1280 || renderFrame.height !== 720) fail('render evidence frame has unexpected dimensions')
  const renderMetadata = validateRenderMetadata(
    parseJson(files.get('render-metadata.json')!, 'render metadata'),
    video,
    retainedPython,
    projectBytes,
    packageBytes,
    wavBytes,
    renderFrameBytes,
  )
  if (decodeRetainedVideo) {
    validateDecodedFrameProvenance(path.join(baseDirectory, 'uncountable-yet-zero-length.mp4'), renderMetadata)
  }
  validateBrowserSummary(parseJson(files.get('evidence/browser-summary.json')!, 'browser summary'), files)
  if (decodeRetainedVideo) {
    validateDecodedStillProvenance(root, path.join(baseDirectory, 'evidence', 'proofcanvas-still-current.png'), files.get('evidence/proofcanvas-still-current.png')!)
  }
  validateStressResults(files.get('stress-results.json')!)

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
