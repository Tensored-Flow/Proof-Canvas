/** @jest-environment node */

import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { verifyArtifactManifest } from '../artifact-manifest'

describe('artifact manifest verification', () => {
  let temporaryRoot: string

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

  it('rejects a render associated with different generated Python', async () => {
    const artifactDirectory = path.join(temporaryRoot, 'examples', 'proofcanvas')
    const metadataPath = path.join(artifactDirectory, 'render-metadata.json')
    const manifestPath = path.join(artifactDirectory, 'artifact-manifest.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
    metadata.sourceSha256 = '0'.repeat(64)
    const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)
    await writeFile(metadataPath, metadataBytes)

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Record<string, { bytes: number; sha256: string }>
    }
    manifest.files['render-metadata.json'] = {
      bytes: metadataBytes.byteLength,
      sha256: createHash('sha256').update(metadataBytes).digest('hex'),
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(verifyArtifactManifest(temporaryRoot)).rejects.toThrow('does not match the retained generated Python')
  })
})
