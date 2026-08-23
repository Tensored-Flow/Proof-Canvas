import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonicalProjectJson } from '../../lib/proofcanvas/schema'
import { compileManim } from '../../lib/proofcanvas/compiler'
import { createCantorDemoProject } from '../../lib/proofcanvas/demo'
import { REQUIRED_AI_COMMANDS, interpretDemoCommand } from '../../lib/proofcanvas/ai'
import { commitOperations, createHistory, undo } from '../../lib/proofcanvas/history'
import { verifyArtifactManifest } from './artifact-manifest'

const root = process.cwd()
const outputDirectory = path.join(root, 'examples', 'proofcanvas')
const jsonPath = path.join(outputDirectory, 'uncountable-yet-zero-length.proofcanvas.json')
const pythonPath = path.join(outputDirectory, 'uncountable-yet-zero-length.py')
const manifestPath = path.join(outputDirectory, 'artifact-manifest.json')
const aiResultsPath = path.join(outputDirectory, 'ai-command-results.json')
const prepareRender = process.argv.slice(2).includes('--prepare-render')

if (process.argv.slice(2).some((argument) => argument !== '--prepare-render')) {
  throw new Error('Unsupported artifact-generation argument')
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
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

function contentSignature(project: ReturnType<typeof createCantorDemoProject>, shotId: string) {
  const shot = project.shots.find(({ id }) => id === shotId)!
  return Object.fromEntries(shot.objects.map(({ id, properties }) => [id, properties.content ?? null]))
}

function exerciseAiCommands(project: ReturnType<typeof createCantorDemoProject>) {
  const shotId = 'shot-cantor-construction'
  return REQUIRED_AI_COMMANDS.map((command, index) => {
    const beforeJson = canonicalProjectJson(project)
    const proposal = interpretDemoCommand({ project, shotId, selectedObjectIds: [], instruction: command })
    const committed = commitOperations(createHistory(project), shotId, proposal.operations, `AI: ${proposal.intention}`)
    const after = committed.present
    const afterShot = after.shots.find(({ id }) => id === shotId)!
    const undone = undo(committed)
    if (committed.past.length !== 1 || canonicalProjectJson(undone.present) !== beforeJson) {
      throw new Error(`Required AI command ${index + 1} was not one atomic, reversible transaction`)
    }

    let semanticEvidence: Record<string, unknown>
    if (index === 0) {
      const title = afterShot.objects.find(({ id }) => id === 'object-title')!
      const beforeDiagram = project.shots[0].objects.filter(({ id, parentId }) => id === 'object-interval-diagram' || parentId === 'object-interval-diagram')
      const afterDiagram = afterShot.objects.filter(({ id, parentId }) => id === 'object-interval-diagram' || parentId === 'object-interval-diagram')
      semanticEvidence = { titlePosition: { x: title.transform.x, y: title.transform.y }, intervalDiagramUnchanged: JSON.stringify(beforeDiagram) === JSON.stringify(afterDiagram) }
    } else if (index === 1) {
      const beforeRemoval = project.shots[0].animations.find(({ id }) => id === 'animation-second-removal')!
      const afterRemoval = afterShot.animations.find(({ id }) => id === 'animation-second-removal')!
      const emphasis = afterShot.animations.find(({ id }) => id.includes('second-removal-emphasis'))!
      semanticEvidence = { durationBefore: beforeRemoval.duration, durationAfter: afterRemoval.duration, easingAfter: afterRemoval.easing, emphasisAnimationId: emphasis.id, emphasisEndsBeforeRemoval: emphasis.start + emphasis.duration <= afterRemoval.start }
    } else if (index === 2) {
      const brace = afterShot.objects.find(({ semanticRole }) => semanticRole === 'surviving-intervals-brace')!
      const reveal = afterShot.animations.find(({ targetIds }) => targetIds.includes(brace.id))!
      const thirdRemovals = afterShot.animations.find(({ id }) => id === 'animation-third-removals')!
      semanticEvidence = { braceId: brace.id, label: brace.properties.label, revealAnimationId: reveal.id, revealStart: reveal.start, thirdRemovalsEnd: thirdRemovals.start + thirdRemovals.duration, revealAfterThirdRemoval: reveal.start > thirdRemovals.start + thirdRemovals.duration }
    } else if (index === 3) {
      const beforePositions = new Map(project.shots[0].objects.map(({ id, transform }) => [id, `${transform.x},${transform.y}`]))
      semanticEvidence = { activeStyleId: after.activeStyleId, mathematicalContentUnchanged: JSON.stringify(contentSignature(after, shotId)) === JSON.stringify(contentSignature(project, shotId)), repositionedObjectCount: afterShot.objects.filter(({ id, transform }) => beforePositions.get(id) !== `${transform.x},${transform.y}`).length }
    } else {
      const equationIds = new Set(['object-equation-chain', ...afterShot.objects.filter(({ parentId }) => parentId === 'object-equation-chain').map(({ id }) => id)])
      const supporting = afterShot.objects.filter(({ id }) => !equationIds.has(id))
      semanticEvidence = { equationFamilyLocked: afterShot.objects.filter(({ id }) => equationIds.has(id)).every(({ locked }) => locked), quietedObjectCount: supporting.filter(({ style }) => (style.opacity ?? 1) <= 0.82).length, supportingObjectCount: supporting.length }
    }

    return {
      commandNumber: index + 1,
      command,
      provider: proposal.provider,
      intention: proposal.intention,
      summary: proposal.summary,
      operations: proposal.operations,
      operationCount: proposal.operations.length,
      beforeProjectSha256: sha256(beforeJson),
      afterProjectSha256: sha256(canonicalProjectJson(after)),
      historyEntries: committed.past.length,
      undoRestoredExactProject: true,
      semanticEvidence,
    }
  })
}

async function main() {
  const project = createCantorDemoProject()
  const json = canonicalProjectJson(project)
  const firstCompilation = compileManim(project)
  const secondCompilation = compileManim(project)

  if (firstCompilation.python !== secondCompilation.python) {
    throw new Error('ProofCanvas compiler output was not deterministic')
  }
  const compileErrors = firstCompilation.diagnostics.filter(({ severity }) => severity === 'error')
  if (compileErrors.length) {
    throw new Error(`ProofCanvas compiler reported errors: ${JSON.stringify(compileErrors)}`)
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
  const aiResults = `${JSON.stringify({ artifactVersion: 1, projectId: project.metadata.id, commands: exerciseAiCommands(project) }, null, 2)}\n`
  await writeFile(aiResultsPath, aiResults, 'utf8')

  if (prepareRender) {
    process.stdout.write(`${JSON.stringify({ jsonPath, pythonPath, aiResultsPath, preparedForRender: true, pythonSha256: sha256(firstCompilation.python) }, null, 2)}\n`)
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
    'ai-command-results.json': {
      bytes: Buffer.byteLength(aiResults),
      sha256: sha256(aiResults),
    },
  }
  const retainedEvidence = [
    'uncountable-yet-zero-length.mp4',
    'render-metadata.json',
    'evidence/browser-summary.json',
    'evidence/proofcanvas-editorial-1440x900.png',
    'evidence/proofcanvas-editorial-1280x800.png',
    'render-evidence/proofcanvas-manim-frame-12s.png',
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
