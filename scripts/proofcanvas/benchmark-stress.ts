import { createHash } from 'node:crypto'
import { cpus, platform, release, arch } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { compileManim } from '../../lib/proofcanvas/compiler'
import { objectSelection } from '../../lib/proofcanvas/editorSelection'
import { applyOperations } from '../../lib/proofcanvas/operations'
import { previewShotAtTime } from '../../lib/proofcanvas/preview'
import { ProjectDocumentSchema, canonicalProjectJson, cloneSerializable } from '../../lib/proofcanvas/schema'
import { PROOFCANVAS_STRESS_INVENTORY, createProofCanvasStressProject } from '../../lib/proofcanvas/stressFixture'
import { indexPropertyTracks, samplePropertyTracks } from '../../lib/proofcanvas/timeline'

const ITERATIONS = 5
const outputPath = path.join(process.cwd(), 'examples/proofcanvas/stress-results.json')

type Metric = Readonly<{
  medianMs: number
  minimumMs: number
  maximumMs: number
  budgetMs: number
  pass: boolean
}>

function rounded(value: number): number {
  return Number(value.toFixed(3))
}

function measure(action: () => void, budgetMs: number): Metric {
  const samples: number[] = []
  action()
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = performance.now()
    action()
    samples.push(performance.now() - startedAt)
  }
  samples.sort((left, right) => left - right)
  const medianMs = samples[Math.floor(samples.length / 2)]
  return {
    medianMs: rounded(medianMs),
    minimumMs: rounded(samples[0]),
    maximumMs: rounded(samples.at(-1) ?? medianMs),
    budgetMs,
    pass: samples.every((value) => value < budgetMs),
  }
}

async function main(): Promise<void> {
  const project = createProofCanvasStressProject()
  const canonical = canonicalProjectJson(project)
  const metrics = {
  fixtureCreation: measure(() => { createProofCanvasStressProject() }, 5_000),
  editorLoad: measure(() => { ProjectDocumentSchema.parse(cloneSerializable(project)) }, 5_000),
  timelineInteraction: measure(() => {
    for (const shot of project.shots) {
      const index = indexPropertyTracks(shot)
      if (index.byId.size !== 8 || samplePropertyTracks(shot, 5.5).length !== 8) throw new Error('Stress timeline index changed')
    }
  }, 2_000),
  playback: measure(() => {
    for (const shot of project.shots) {
      if (previewShotAtTime(shot, 4.5).objects.length !== 15) throw new Error('Stress preview inventory changed')
    }
  }, 3_000),
  selection: measure(() => {
    for (const shot of project.shots) {
      if (objectSelection(shot, shot.objects.slice(0, 10).map(({ id }) => id)).kind !== 'objects') throw new Error('Stress selection failed')
    }
  }, 2_000),
  inspectorUpdate: measure(() => {
    const shot = project.shots[0]
    const target = shot.objects[14]
    const result = applyOperations(project, shot.id, [{ type: 'update-object', objectId: target.id, patch: { style: { opacity: 0.75 } } }])
    if (result.project.shots[0].objects[14].style.opacity !== 0.75) throw new Error('Stress inspector update failed')
  }, 5_000),
  autosaveSerialization: measure(() => {
    if (canonicalProjectJson(project).length < 100_000) throw new Error('Stress serialization unexpectedly shrank')
  }, 2_000),
  compilation: measure(() => {
    const result = compileManim(project, { audioTransport: true })
    if (result.python.length < 200_000 || result.diagnostics.some(({ severity }) => severity === 'error')) throw new Error('Stress compilation failed')
  }, 10_000),
  }

  const result = {
  format: 'proofcanvas-stress-results-v1',
  fixture: {
    ...PROOFCANVAS_STRESS_INVENTORY,
    canonicalBytes: Buffer.byteLength(canonical),
    canonicalSha256: createHash('sha256').update(canonical).digest('hex'),
  },
  method: {
    clock: 'performance.now monotonic milliseconds',
    iterations: ITERATIONS,
    aggregation: 'median with minimum and maximum retained; every sample must remain below its regression budget',
    scope: 'headless shared-core operations; not a browser frame-rate or human-usability claim',
  },
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    architecture: arch(),
    logicalCpuCount: cpus().length,
  },
  metrics,
  pass: Object.values(metrics).every(({ pass }) => pass),
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.pass) process.exitCode = 1
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
