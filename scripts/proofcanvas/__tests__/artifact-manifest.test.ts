/** @jest-environment node */

import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProjectDocumentSchema, canonicalProjectJson, type ProjectDocument } from '../../../lib/proofcanvas/schema'
import { verifyArtifactManifestWithoutVideoDecodeForUnitTests as verifyArtifactManifest } from '../artifact-manifest'

describe('artifact manifest verification', () => {
  let temporaryRoot: string

  async function rewriteArtifact(relativePath: string, bytes: Buffer): Promise<void> {
    const artifactDirectory = path.join(temporaryRoot, 'examples', 'proofcanvas')
    await writeFile(path.join(artifactDirectory, ...relativePath.split('/')), bytes)
    const manifestPath = path.join(artifactDirectory, 'artifact-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Record<string, { bytes: number; sha256: string }>
    }
    manifest.files[relativePath] = {
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'proofcanvas-manifest-test-'))
    await cp(path.join(process.cwd(), 'examples'), path.join(temporaryRoot, 'examples'), { recursive: true })
  })

  afterEach(async () => {
    if (path.dirname(temporaryRoot) !== os.tmpdir() || !path.basename(temporaryRoot).startsWith('proofcanvas-manifest-test-')) {
      throw new Error('Refusing to remove an unexpected artifact test directory')
    }
    await rm(temporaryRoot, { recursive: true })
  })

  it('accepts the complete checked evidence set', async () => {
    await expect(verifyArtifactManifest(temporaryRoot)).resolves.toBeUndefined()
  })

  it('rejects evidence changed after the manifest was generated', async () => {
    const summaryPath = path.join(temporaryRoot, 'examples', 'proofcanvas', 'evidence', 'browser-summary.json')
    const summary = await readFile(summaryPath, 'utf8')
    await writeFile(summaryPath, summary.replace('"executions": 2', '"executions": 1'), 'utf8')

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('does not match its manifest record')
  })

  it('rejects a manifest that claims a stale project schema', async () => {
    const manifestPath = path.join(temporaryRoot, 'examples', 'proofcanvas', 'artifact-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.schemaVersion = 1
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('manifest claims do not satisfy the acceptance contract')
  })

  it('rejects a malformed current-version project even when its manifest record is refreshed', async () => {
    const relativePath = 'uncountable-yet-zero-length.proofcanvas.json'
    const projectPath = path.join(temporaryRoot, 'examples', 'proofcanvas', relativePath)
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as { shots: Array<{ duration: number }> }
    project.shots[0].duration = 0
    await rewriteArtifact(relativePath, Buffer.from(`${JSON.stringify(project, null, 2)}\n`))

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('does not satisfy the current project schema')
  })

  it('rejects noncanonical project bytes even when their manifest record is refreshed', async () => {
    const relativePath = 'uncountable-yet-zero-length.proofcanvas.json'
    const projectPath = path.join(temporaryRoot, 'examples', 'proofcanvas', relativePath)
    const canonical = await readFile(projectPath)
    await rewriteArtifact(relativePath, Buffer.concat([canonical, Buffer.from('\n')]))

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('example project is not canonical JSON')
  })

  it('compares canonical project bytes without lossy UTF-8 decoding', async () => {
    const relativePath = 'uncountable-yet-zero-length.proofcanvas.json'
    const projectPath = path.join(temporaryRoot, 'examples', 'proofcanvas', relativePath)
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as ProjectDocument
    project.metadata.title = '\uFFFD'
    const canonical = Buffer.from(canonicalProjectJson(ProjectDocumentSchema.parse(project)), 'utf8')
    const replacement = Buffer.from('\uFFFD', 'utf8')
    const offset = canonical.indexOf(replacement)
    expect(offset).toBeGreaterThanOrEqual(0)
    const malformedUtf8 = Buffer.concat([
      canonical.subarray(0, offset),
      Buffer.from([0xff]),
      canonical.subarray(offset + replacement.byteLength),
    ])
    await rewriteArtifact(relativePath, malformedUtf8)

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('example project is not canonical JSON')
  })

  it('rejects a current-schema project whose retained Python was not recompiled', async () => {
    const relativePath = 'uncountable-yet-zero-length.proofcanvas.json'
    const projectPath = path.join(temporaryRoot, 'examples', 'proofcanvas', relativePath)
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as ProjectDocument
    const text = project.shots.flatMap(({ objects }) => objects).find(({ type }) => type === 'text')
    expect(text).toBeDefined()
    text!.properties.content = 'Manifest verifier compiler-seam mutation'
    await rewriteArtifact(relativePath, Buffer.from(canonicalProjectJson(ProjectDocumentSchema.parse(project)), 'utf8'))

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('retained generated Python does not match')
  })

  it('rejects manifest diagnostics that differ from a fresh deterministic compilation', async () => {
    const manifestPath = path.join(temporaryRoot, 'examples', 'proofcanvas', 'artifact-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.diagnostics = []
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('manifest diagnostics do not match')
  })

  it('rejects fabricated AI command evidence even when its manifest record is refreshed', async () => {
    const relativePath = 'ai-command-results.json'
    const aiPath = path.join(temporaryRoot, 'examples', 'proofcanvas', relativePath)
    const ai = JSON.parse(await readFile(aiPath, 'utf8')) as { commands: Array<Record<string, unknown>> }
    ai.commands[0].command = 'fabricated evidence'
    ai.commands[0].operations = []
    await rewriteArtifact(relativePath, Buffer.from(`${JSON.stringify(ai, null, 2)}\n`, 'utf8'))

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('AI command evidence does not match deterministic execution')
  })

  it('rejects a corrupt PNG payload even when its manifest record is refreshed', async () => {
    const relativePath = 'render-evidence/proofcanvas-manim-frame-12s.png'
    const framePath = path.join(temporaryRoot, 'examples', 'proofcanvas', ...relativePath.split('/'))
    const corrupted = Buffer.from(await readFile(framePath))
    corrupted[corrupted.length - 1] ^= 0xff
    await rewriteArtifact(relativePath, corrupted)

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow(/PNG chunk CRC|PNG terminator/)
  })

  it('binds render metadata to the retained evidence-frame hash', async () => {
    const relativePath = 'render-metadata.json'
    const metadataPath = path.join(temporaryRoot, 'examples', 'proofcanvas', relativePath)
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
    metadata.evidenceFrameSha256 = '0'.repeat(64)
    await rewriteArtifact(relativePath, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'))

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('render metadata does not match the retained evidence frame')
  })

  it('rejects a render associated with different generated Python', async () => {
    const artifactDirectory = path.join(temporaryRoot, 'examples', 'proofcanvas')
    const metadataPath = path.join(artifactDirectory, 'render-metadata.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
    metadata.sourceSha256 = '0'.repeat(64)
    const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)
    await rewriteArtifact('render-metadata.json', metadataBytes)

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('does not match the retained generated Python')
  })
})
