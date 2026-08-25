#!/usr/bin/env node

import { copyFile, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import evidencePaths from './evidence-paths.cjs'
import evidenceSet from './evidence-set.cjs'

const { requireManagedEvidenceDirectory } = evidencePaths
const { requireExactTemporaryEvidenceEntries } = evidenceSet

const EXPECTED_PROJECTS = new Map([
  ['proofcanvas-chromium-1440', { screenshot: 'proofcanvas-editorial-1440x900.png', width: 1440, height: 900 }],
  ['proofcanvas-chromium-1280', { screenshot: 'proofcanvas-editorial-1280x800.png', width: 1280, height: 800 }],
])
const JOURNEY_TITLE = 'complete structured edit-to-Manim journey'
const MAX_REPORT_BYTES = 4 * 1024 * 1024
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024
const MAX_VIDEO_BYTES = 256 * 1024 * 1024
const MAX_SUMMARY_BYTES = 8 * 1024
const RETAINED_EVIDENCE_FILES = Object.freeze([
  'proofcanvas-editorial-1440x900.png',
  'proofcanvas-editorial-1280x800.png',
  'browser-summary.json',
])
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function fail(message) {
  throw new Error(`ProofCanvas browser evidence rejected: ${message}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function regularFile(file, maximumBytes, label) {
  let stat
  try {
    stat = await lstat(file)
  } catch {
    fail(`${label} is missing`)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`)
  if (stat.size <= 0 || stat.size > maximumBytes) fail(`${label} has an invalid size`)
  return stat
}

function pngDimensions(bytes, label) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    fail(`${label} is not a canonical PNG`)
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function collectTests(suites, destination = []) {
  if (!Array.isArray(suites)) fail('report suites are malformed')
  for (const suite of suites) {
    if (!suite || typeof suite !== 'object') fail('report suite is malformed')
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        if (!spec || typeof spec !== 'object' || !Array.isArray(spec.tests)) fail('report spec is malformed')
        for (const test of spec.tests) destination.push({ title: spec.title, ...test })
      }
    }
    if (suite.suites !== undefined) collectTests(suite.suites, destination)
  }
  return destination
}

async function collectEntries(directory, prefix = '') {
  const entries = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isSymbolicLink()) fail(`temporary run contains a symbolic link at ${relative}`)
    if (entry.isDirectory()) entries.push(`${relative}/`, ...await collectEntries(path.join(directory, entry.name), relative))
    else if (entry.isFile()) entries.push(relative)
    else fail(`temporary run contains an unsupported entry at ${relative}`)
  }
  return entries
}

function validatedReport(report) {
  if (!report || typeof report !== 'object') fail('report JSON is malformed')
  const tests = collectTests(report.suites)
  if (tests.length !== 2) fail(`expected exactly two project executions, found ${tests.length}`)
  const titles = new Set(tests.map(({ title }) => title))
  if (titles.size !== 1 || !titles.has(JOURNEY_TITLE)) fail('expected exactly one named acceptance journey')

  const projects = new Map()
  for (const entry of tests) {
    const projectName = entry.projectName
    if (!EXPECTED_PROJECTS.has(projectName) || projects.has(projectName)) fail(`unexpected or duplicate project ${String(projectName)}`)
    if (entry.expectedStatus !== 'passed' || entry.status !== 'expected') fail(`${projectName} did not pass as expected`)
    if (!Array.isArray(entry.annotations) || entry.annotations.length !== 0) fail(`${projectName} contains skip/fixme annotations`)
    if (!Array.isArray(entry.results) || entry.results.length !== 1) fail(`${projectName} was skipped or retried`)
    const result = entry.results[0]
    if (!result || result.status !== 'passed' || result.retry !== 0) fail(`${projectName} has a failed, skipped, interrupted, or retried result`)
    if ((Array.isArray(result.errors) && result.errors.length) || result.error) fail(`${projectName} includes an execution error`)
    projects.set(projectName, { durationMs: Math.max(0, Math.round(Number(result.duration) || 0)) })
  }

  const stats = report.stats
  if (!stats || stats.expected !== 2 || stats.skipped !== 0 || stats.unexpected !== 0 || stats.flaky !== 0) {
    fail('report totals include skipped, retried, flaky, or failed execution')
  }
  return projects
}

async function validate(runDirectory, outputDirectory) {
  const run = path.resolve(runDirectory)
  const output = requireManagedEvidenceDirectory(repositoryRoot, outputDirectory)
  if (run === output) fail('unsafe evidence output directory')

  const reportPath = path.join(run, 'report.json')
  await regularFile(reportPath, MAX_REPORT_BYTES, 'raw Playwright report')
  let report
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch {
    fail('raw Playwright report is not valid JSON')
  }
  const projectResults = validatedReport(report)

  const screenshots = []
  for (const [project, expected] of EXPECTED_PROJECTS) {
    const file = path.join(run, expected.screenshot)
    const stat = await regularFile(file, MAX_SCREENSHOT_BYTES, expected.screenshot)
    const screenshotBytes = await readFile(file)
    const dimensions = pngDimensions(screenshotBytes, expected.screenshot)
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
      fail(`${expected.screenshot} must be exactly ${expected.width}x${expected.height}`)
    }
    screenshots.push({
      project,
      file: expected.screenshot,
      width: dimensions.width,
      height: dimensions.height,
      bytes: stat.size,
      sha256: sha256(screenshotBytes),
      status: 'passed',
      durationMs: projectResults.get(project).durationMs,
    })
  }

  const videoPath = path.join(run, 'ui-download', 'proofcanvas-render.mp4')
  const videoStat = await regularFile(videoPath, MAX_VIDEO_BYTES, 'UI-downloaded MP4')
  const videoBytes = await readFile(videoPath)
  const videoHeader = videoBytes.subarray(0, 12)
  if (videoHeader.length < 12 || videoHeader.toString('ascii', 4, 8) !== 'ftyp') fail('UI download is not an MP4 container')

  const temporaryEntries = await collectEntries(run)
  requireExactTemporaryEvidenceEntries(temporaryEntries)

  const summary = {
    schemaVersion: 1,
    journey: JOURNEY_TITLE,
    executions: 2,
    skipped: 0,
    retried: 0,
    failures: 0,
    screenshots,
    render: { project: 'proofcanvas-chromium-1440', fileValidatedInTemporaryRun: true, bytes: videoStat.size, sha256: sha256(videoBytes), container: 'mp4/ftyp' },
  }
  const summaryJson = `${JSON.stringify(summary, null, 2)}\n`
  if (Buffer.byteLength(summaryJson) > MAX_SUMMARY_BYTES) fail('sanitized browser summary exceeds its bound')

  for (const ancestor of [repositoryRoot, path.join(repositoryRoot, 'examples'), path.join(repositoryRoot, 'examples', 'proofcanvas')]) {
    const stat = await lstat(ancestor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('evidence output ancestry must contain only real directories')
  }
  let existing = []
  try {
    const current = await lstat(output)
    if (!current.isDirectory() || current.isSymbolicLink()) fail('evidence output must be a real directory')
    existing = await readdir(output)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const entry of existing) {
    if (!RETAINED_EVIDENCE_FILES.includes(entry)) fail(`evidence output contains unexpected entry ${entry}`)
    await regularFile(path.join(output, entry), MAX_SCREENSHOT_BYTES, `existing evidence ${entry}`)
  }
  await mkdir(output, { recursive: true })
  for (const entry of existing) await unlink(path.join(output, entry))
  for (const { file } of screenshots) await copyFile(path.join(run, file), path.join(output, file))
  await writeFile(path.join(output, 'browser-summary.json'), summaryJson, { encoding: 'utf8', mode: 0o644, flag: 'wx' })

  const retained = (await readdir(output)).sort()
  const expectedRetained = [...RETAINED_EVIDENCE_FILES].sort()
  if (JSON.stringify(retained) !== JSON.stringify(expectedRetained)) fail('retained evidence contains unexpected files')
  process.stdout.write(`${summaryJson}`)
}

if (process.argv.length !== 4) {
  process.stderr.write('Usage: node scripts/proofcanvas/validate-e2e.mjs <temporary-run-directory> <retained-evidence-directory>\n')
  process.exit(2)
}

validate(process.argv[2], process.argv[3]).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
