import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compileManim, estimateManimTimelineDurationUpperBound } from '../../lib/proofcanvas/compiler'
import { ProjectDocumentSchema, canonicalProjectJson, projectDurationSeconds } from '../../lib/proofcanvas/schema'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function regularFile(filePath: string, label: string): Promise<Buffer> {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error(`${label} must be a non-empty regular file`)
  return readFile(filePath)
}

async function main(): Promise<void> {
  const [projectArgument, pythonArgument, wavArgument, outputArgument, ...extra] = process.argv.slice(2)
  if (!projectArgument || !pythonArgument || !wavArgument || !outputArgument || extra.length) {
    throw new Error('Usage: artifact-render-request.ts <project.json> <generated.py> <fixture.wav> <request.json>')
  }
  const projectPath = path.resolve(projectArgument)
  const pythonPath = path.resolve(pythonArgument)
  const wavPath = path.resolve(wavArgument)
  const outputPath = path.resolve(outputArgument)
  if (new Set([projectPath, pythonPath, wavPath, outputPath]).size !== 4) throw new Error('Artifact render-request paths must be distinct')

  const projectBytes = await regularFile(projectPath, 'Canonical project JSON')
  const sourceBytes = await regularFile(pythonPath, 'Generated Manim source')
  const wavBytes = await regularFile(wavPath, 'Deterministic WAV fixture')
  const project = ProjectDocumentSchema.parse(JSON.parse(projectBytes.toString('utf8')))
  if (!projectBytes.equals(Buffer.from(canonicalProjectJson(project), 'utf8'))) throw new Error('Artifact project JSON is not canonical')
  if (project.assets.length !== 1 || project.assets[0].mimeType !== 'audio/wav') throw new Error('Artifact render supports exactly its deterministic WAV fixture')
  const asset = project.assets[0]
  if (asset.size !== wavBytes.byteLength || asset.sha256 !== sha256(wavBytes)) throw new Error('Artifact WAV does not match project metadata')

  const compilation = compileManim(project, { audioTransport: true })
  if (compilation.diagnostics.some(({ severity }) => severity === 'error')) throw new Error('Artifact project does not compile for trusted audio transport')
  if (!sourceBytes.equals(Buffer.from(compilation.python, 'utf8'))) throw new Error('Retained generated Manim source is stale')

  const clips: Array<Record<string, unknown>> = []
  let shotOffset = 0
  for (const shot of project.shots) {
    const hasSolo = shot.audioClips.some(({ solo, muted }) => solo && !muted)
    for (const clip of [...shot.audioClips].sort((left, right) => left.id.localeCompare(right.id))) {
      if (clip.muted || (hasSolo && !clip.solo)) continue
      if (clip.assetId !== asset.id) throw new Error(`Artifact audio clip ${clip.id} references an unexpected asset`)
      const track = shot.propertyTracks.find((candidate) => (
        candidate.target.kind === 'audio'
        && candidate.target.audioClipId === clip.id
        && candidate.property === 'volume'
      ))
      const keyframes = (track?.keyframes ?? []).map((keyframe) => {
        if (typeof keyframe.value !== 'number' || !['hold', 'linear'].includes(keyframe.interpolation.kind)) {
          throw new Error(`Artifact audio clip ${clip.id} uses an unsupported retained-render volume interpolation`)
        }
        return { time: keyframe.time - clip.start, value: keyframe.value, interpolation: keyframe.interpolation.kind }
      })
      clips.push({
        assetPath: `assets/${asset.sha256}.wav`,
        start: shotOffset + clip.start,
        duration: clip.duration,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        volume: clip.volume,
        fadeIn: clip.fadeIn ?? 0,
        fadeOut: clip.fadeOut ?? 0,
        keyframes,
      })
    }
    shotOffset += shot.duration
  }
  if (!clips.length) throw new Error('Artifact render request must contain audible fixture clips')

  const payload = {
    source: compilation.python,
    sourceSha256: sha256(sourceBytes),
    quality: 'preview',
    output: {
      width: project.settings.resolution.width,
      height: project.settings.resolution.height,
      fps: project.settings.frameRate,
      expectedDurationSeconds: estimateManimTimelineDurationUpperBound(project, project.settings.frameRate),
    },
    assets: [{
      path: `assets/${asset.sha256}.wav`,
      mimeType: 'audio/wav',
      sha256: asset.sha256,
      bytes: wavBytes.byteLength,
      contentBase64: wavBytes.toString('base64'),
    }],
    audio: { durationSeconds: projectDurationSeconds(project), clips },
  }
  await writeFile(outputPath, JSON.stringify(payload))
  process.stdout.write(`${JSON.stringify({
    outputPath,
    requestBytes: Buffer.byteLength(JSON.stringify(payload)),
    sourceSha256: payload.sourceSha256,
    assetSha256: asset.sha256,
    durationSeconds: payload.audio.durationSeconds,
    clips: clips.length,
  })}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
