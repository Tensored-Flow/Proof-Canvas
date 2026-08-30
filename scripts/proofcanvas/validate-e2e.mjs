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
  ['proofcanvas-chromium-1920', { screenshot: 'proofcanvas-editorial-1920x1080.png', width: 1920, height: 1080 }],
  ['proofcanvas-chromium-1440', { screenshot: 'proofcanvas-editorial-1440x900.png', width: 1440, height: 900 }],
  ['proofcanvas-chromium-1280', { screenshot: 'proofcanvas-editorial-1280x800.png', width: 1280, height: 800 }],
])
const EXTRA_SCREENSHOTS = Object.freeze([
  { project: 'dashboard', sourceProject: 'proofcanvas-chromium-1920', file: 'proofcanvas-dashboard-1920x1080.png', width: 1920, height: 1080 },
  { project: 'blank-editor', sourceProject: 'proofcanvas-chromium-1920', file: 'proofcanvas-blank-editor-1920x1080.png', width: 1920, height: 1080 },
  { project: 'selected-text', sourceProject: 'proofcanvas-chromium-1920', file: 'proofcanvas-selected-text-1920x1080.png', width: 1920, height: 1080 },
  { project: 'selected-graph', sourceProject: 'proofcanvas-chromium-1920', file: 'proofcanvas-selected-graph-1920x1080.png', width: 1920, height: 1080 },
  { project: 'timeline-keyframes', sourceProject: 'proofcanvas-chromium-1920', file: 'proofcanvas-timeline-keyframes-1920x1080.png', width: 1920, height: 1080 },
  { project: 'style-lab', sourceProject: 'proofcanvas-chromium-1920', file: 'proofcanvas-style-lab-1920x1080.png', width: 1920, height: 1080 },
  { project: 'style-nocturne-chalk', sourceProject: 'proofcanvas-chromium-1920', file: 'proofcanvas-style-nocturne-chalk-1920x1080.png', width: 1920, height: 1080 },
  { project: 'style-scientific-minimal', sourceProject: 'proofcanvas-chromium-1920', file: 'proofcanvas-style-scientific-minimal-1920x1080.png', width: 1920, height: 1080 },
  { project: 'animation-inspector', sourceProject: 'proofcanvas-chromium-1920', file: 'proofcanvas-animation-inspector-1920x1080.png', width: 1920, height: 1080 },
  { project: 'ai-proposal-review', sourceProject: 'proofcanvas-chromium-1920', file: 'proofcanvas-ai-proposal-review-1920x1080.png', width: 1920, height: 1080 },
  { project: 'render-dialog', sourceProject: 'proofcanvas-chromium-1440', file: 'proofcanvas-render-dialog-1440x900.png', width: 1440, height: 900 },
  { project: 'narrow-editor', sourceProject: 'proofcanvas-chromium-1280', file: 'proofcanvas-narrow-editor-1024x768.png', width: 1024, height: 768 },
  { project: 'portrait-output-authoring', sourceProject: 'proofcanvas-chromium-1440', file: 'proofcanvas-portrait-output-1440x900.png', width: 1440, height: 900 },
])
const JOURNEY_TITLE = 'complete structured edit-to-Manim journey'
const RESTART_JOURNEY_TITLE = 'reopens the durable portrait project after a controlled application process restart'
const MAX_REPORT_BYTES = 4 * 1024 * 1024
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024
const MAX_VIDEO_BYTES = 256 * 1024 * 1024
const MAX_PACKAGE_BYTES = 132 * 1024 * 1024
const MAX_RECEIPT_BYTES = 8 * 1024
const MAX_SUMMARY_BYTES = 8 * 1024
const EXPECTED_STRESS_INVENTORY = Object.freeze({
  shots: 10,
  objects: 150,
  animations: 250,
  keyframes: 400,
  audioSeconds: 90,
})
const RETAINED_EVIDENCE_FILES = Object.freeze([
  'proofcanvas-editorial-1920x1080.png',
  'proofcanvas-editorial-1440x900.png',
  'proofcanvas-editorial-1280x800.png',
  'proofcanvas-dashboard-1920x1080.png',
  'proofcanvas-blank-editor-1920x1080.png',
  'proofcanvas-selected-text-1920x1080.png',
  'proofcanvas-selected-graph-1920x1080.png',
  'proofcanvas-timeline-keyframes-1920x1080.png',
  'proofcanvas-style-lab-1920x1080.png',
  'proofcanvas-style-nocturne-chalk-1920x1080.png',
  'proofcanvas-style-scientific-minimal-1920x1080.png',
  'proofcanvas-animation-inspector-1920x1080.png',
  'proofcanvas-ai-proposal-review-1920x1080.png',
  'proofcanvas-render-dialog-1440x900.png',
  'proofcanvas-narrow-editor-1024x768.png',
  'proofcanvas-portrait-output-1440x900.png',
  'proofcanvas-still-current.png',
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
  if (tests.length !== 3) fail(`expected exactly three project executions, found ${tests.length}`)
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
  if (!stats || stats.expected !== 3 || stats.skipped !== 0 || stats.unexpected !== 0 || stats.flaky !== 0) {
    fail('report totals include skipped, retried, flaky, or failed execution')
  }
  return projects
}

function validatedRestartReport(report) {
  if (!report || typeof report !== 'object') fail('restart report JSON is malformed')
  const tests = collectTests(report.suites)
  if (tests.length !== 1) fail(`expected exactly one restart execution, found ${tests.length}`)
  const [entry] = tests
  if (entry.title !== RESTART_JOURNEY_TITLE || entry.projectName !== 'proofcanvas-chromium-1440') {
    fail('restart report contains an unexpected journey or project')
  }
  if (entry.expectedStatus !== 'passed' || entry.status !== 'expected') fail('restart journey did not pass as expected')
  if (!Array.isArray(entry.annotations) || entry.annotations.length !== 0) fail('restart journey contains skip/fixme annotations')
  if (!Array.isArray(entry.results) || entry.results.length !== 1) fail('restart journey was skipped or retried')
  const [result] = entry.results
  if (!result || result.status !== 'passed' || result.retry !== 0 || result.error || (Array.isArray(result.errors) && result.errors.length)) {
    fail('restart journey has a failed, skipped, interrupted, or retried result')
  }
  const stats = report.stats
  if (!stats || stats.expected !== 1 || stats.skipped !== 0 || stats.unexpected !== 0 || stats.flaky !== 0) {
    fail('restart report totals include skipped, retried, flaky, or failed execution')
  }
  return { durationMs: Math.max(0, Math.round(Number(result.duration) || 0)) }
}

async function readVerificationReceipt(file, expected, videoBytes, label) {
  await regularFile(file, MAX_RECEIPT_BYTES, `${label} verification receipt`)
  let receipt
  try { receipt = JSON.parse(await readFile(file, 'utf8')) } catch { fail(`${label} verification receipt is malformed`) }
  const exactKeys = ['audioCodec', 'bytes', 'decodedAudioSamples', 'decodedFrames', 'durationSeconds', 'fps', 'height', 'path', 'sha256', 'videoCodec', 'width']
  if (!receipt || typeof receipt !== 'object' || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(exactKeys.sort())) {
    fail(`${label} verification receipt has an unexpected shape`)
  }
  if (
    receipt.sha256 !== sha256(videoBytes)
    || receipt.bytes !== videoBytes.byteLength
    || receipt.videoCodec !== 'h264'
    || receipt.audioCodec !== expected.audioCodec
    || receipt.width !== expected.width || receipt.height !== expected.height || receipt.fps !== expected.fps
    || typeof receipt.durationSeconds !== 'number' || !Number.isFinite(receipt.durationSeconds)
    || receipt.durationSeconds < expected.minDuration || receipt.durationSeconds > expected.maxDuration
    || !Number.isSafeInteger(receipt.decodedFrames) || receipt.decodedFrames <= 0
    || !Number.isSafeInteger(receipt.decodedAudioSamples) || receipt.decodedAudioSamples < 0
    || (expected.audioCodec === 'aac' ? receipt.decodedAudioSamples <= 0 : receipt.decodedAudioSamples !== 0)
    || typeof receipt.path !== 'string' || !receipt.path.endsWith(`/ui-download/${expected.file}`)
  ) fail(`${label} verification receipt does not bind the exact fully decoded artifact`)
  return receipt
}

async function readStillVerificationReceipt(file, stillBytes) {
  await regularFile(file, MAX_RECEIPT_BYTES, 'still verification receipt')
  let receipt
  try { receipt = JSON.parse(await readFile(file, 'utf8')) } catch { fail('still verification receipt is malformed') }
  const exactKeys = ['bytes', 'decoder', 'format', 'fullDecodeVerified', 'height', 'path', 'sha256', 'width']
  if (!receipt || typeof receipt !== 'object' || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(exactKeys.sort())) {
    fail('still verification receipt has an unexpected shape')
  }
  if (
    receipt.sha256 !== sha256(stillBytes)
    || receipt.bytes !== stillBytes.byteLength
    || receipt.decoder !== 'pillow-pinned-renderer-image'
    || receipt.format !== 'png'
    || receipt.fullDecodeVerified !== true
    || receipt.width !== 1280 || receipt.height !== 720
    || typeof receipt.path !== 'string' || !receipt.path.endsWith('/ui-download/proofcanvas-still-current.png')
  ) fail('still verification receipt does not bind the exact fully decoded artifact')
  return receipt
}

async function readBrowserStressReceipt(file) {
  await regularFile(file, MAX_RECEIPT_BYTES, 'browser stress verification receipt')
  let receipt
  try { receipt = JSON.parse(await readFile(file, 'utf8')) } catch { fail('browser stress verification receipt is malformed') }
  const exactKeys = [
    'activeAnimations', 'activeKeyframes', 'activeObjects', 'aggregateVerified', 'audioMetadataReady', 'autosaveSaved', 'fixture',
    'importDurationMs', 'importedThroughOwnerUi', 'interactionDurationMs', 'primaryInspectorUpdated',
    'playbackAdvanced', 'primaryEditReloadPersisted', 'reloadPersisted', 'schemaVersion', 'selectedObjects', 'timelineScrubbed',
  ]
  if (!receipt || typeof receipt !== 'object' || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(exactKeys.sort())) {
    fail('browser stress verification receipt has an unexpected shape')
  }
  if (
    !receipt.fixture || typeof receipt.fixture !== 'object'
    || JSON.stringify(Object.keys(receipt.fixture).sort()) !== JSON.stringify([...Object.keys(EXPECTED_STRESS_INVENTORY), 'canonicalBytes', 'canonicalSha256'].sort())
    || Object.entries(EXPECTED_STRESS_INVENTORY).some(([key, value]) => receipt.fixture[key] !== value)
    || !Number.isSafeInteger(receipt.fixture.canonicalBytes) || receipt.fixture.canonicalBytes <= 0
    || typeof receipt.fixture.canonicalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fixture.canonicalSha256)
    || receipt.schemaVersion !== 1
    || receipt.importedThroughOwnerUi !== true
    || receipt.activeObjects !== 15 || receipt.activeAnimations !== 25 || receipt.activeKeyframes !== 40
    || receipt.aggregateVerified !== true || receipt.audioMetadataReady !== true
    || receipt.timelineScrubbed !== true || receipt.selectedObjects !== 10 || receipt.primaryInspectorUpdated !== true
    || receipt.playbackAdvanced !== true || receipt.autosaveSaved !== true || receipt.reloadPersisted !== true
    || receipt.primaryEditReloadPersisted !== true
    || !Number.isSafeInteger(receipt.importDurationMs) || receipt.importDurationMs < 0 || receipt.importDurationMs > 120_000
    || !Number.isSafeInteger(receipt.interactionDurationMs) || receipt.interactionDurationMs < 0 || receipt.interactionDurationMs > 120_000
  ) fail('browser stress verification receipt does not prove the exact real-editor journey')
  return receipt
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
  const restartReportPath = path.join(run, 'restart-report.json')
  await regularFile(restartReportPath, MAX_REPORT_BYTES, 'restart Playwright report')
  let restartReport
  try {
    restartReport = JSON.parse(await readFile(restartReportPath, 'utf8'))
  } catch {
    fail('restart Playwright report is not valid JSON')
  }
  const restartResult = validatedRestartReport(restartReport)
  const stress = await readBrowserStressReceipt(path.join(run, 'browser-stress-verification.json'))

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

  for (const expected of EXTRA_SCREENSHOTS) {
    const screenshotPath = path.join(run, expected.file)
    const screenshotStat = await regularFile(screenshotPath, MAX_SCREENSHOT_BYTES, expected.file)
    const screenshotBytes = await readFile(screenshotPath)
    const dimensions = pngDimensions(screenshotBytes, expected.file)
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
      fail(`${expected.file} must be exactly ${expected.width}x${expected.height}`)
    }
    screenshots.push({
      project: expected.project,
      file: expected.file,
      width: expected.width,
      height: expected.height,
      bytes: screenshotStat.size,
      sha256: sha256(screenshotBytes),
      status: 'passed',
      durationMs: projectResults.get(expected.sourceProject).durationMs,
    })
  }

  const videos = []
  for (const expected of [
    { label: 'landscape UI MP4', file: 'proofcanvas-render.mp4', receipt: 'landscape-video-verification.json', width: 1280, height: 720, fps: 30, audioCodec: 'aac', minDuration: 45, maxDuration: 60 },
    { label: 'portrait UI MP4', file: 'proofcanvas-portrait-480x854-24fps.mp4', receipt: 'portrait-video-verification.json', width: 480, height: 854, fps: 24, audioCodec: null, minDuration: 1, maxDuration: 310 },
  ]) {
    const videoPath = path.join(run, 'ui-download', expected.file)
    const videoStat = await regularFile(videoPath, MAX_VIDEO_BYTES, expected.label)
    const videoBytes = await readFile(videoPath)
    const videoHeader = videoBytes.subarray(0, 12)
    if (videoHeader.length < 12 || videoHeader.toString('ascii', 4, 8) !== 'ftyp') fail(`${expected.label} is not an MP4 container`)
    const receipt = await readVerificationReceipt(path.join(run, expected.receipt), expected, videoBytes, expected.label)
    videos.push({
      file: expected.file,
      bytes: videoStat.size,
      sha256: receipt.sha256,
      videoCodec: receipt.videoCodec,
      audioCodec: receipt.audioCodec,
      width: receipt.width,
      height: receipt.height,
      fps: receipt.fps,
      durationSeconds: receipt.durationSeconds,
      decodedFrames: receipt.decodedFrames,
      decodedAudioSamples: receipt.decodedAudioSamples,
      fullDecodeVerified: true,
    })
  }

  const stillPath = path.join(run, 'ui-download', 'proofcanvas-still-current.png')
  const stillStat = await regularFile(stillPath, MAX_SCREENSHOT_BYTES, 'UI-downloaded still PNG')
  const stillBytes = await readFile(stillPath)
  const stillDimensions = pngDimensions(stillBytes, 'UI-downloaded still PNG')
  if (stillDimensions.width !== 1280 || stillDimensions.height !== 720) fail('UI-downloaded still must be exactly 1280x720')
  const stillReceipt = await readStillVerificationReceipt(path.join(run, 'still-verification.json'), stillBytes)

  const packagePath = path.join(run, 'ui-download', 'proofcanvas-v1-roundtrip.proofcanvas')
  const packageStat = await regularFile(packagePath, MAX_PACKAGE_BYTES, 'UI-downloaded ProofCanvas package')
  const packageBytes = await readFile(packagePath)
  if (packageBytes.length < 4 || packageBytes.subarray(0, 4).toString('binary') !== 'PK\u0003\u0004') fail('UI-downloaded ProofCanvas package is not a ZIP archive')

  const temporaryEntries = await collectEntries(run)
  requireExactTemporaryEvidenceEntries(temporaryEntries)

  const summary = {
    schemaVersion: 1,
    journey: JOURNEY_TITLE,
    executions: 4,
    skipped: 0,
    retried: 0,
    failures: 0,
    restart: { journey: RESTART_JOURNEY_TITLE, status: 'passed', durationMs: restartResult.durationMs },
    stress,
    screenshots,
    renders: videos,
    still: {
      file: 'proofcanvas-still-current.png',
      width: stillDimensions.width,
      height: stillDimensions.height,
      bytes: stillStat.size,
      sha256: stillReceipt.sha256,
      decoder: stillReceipt.decoder,
      fullDecodeVerified: true,
    },
    package: { file: 'proofcanvas-v1-roundtrip.proofcanvas', bytes: packageStat.size, sha256: sha256(packageBytes), roundTripVerifiedInBrowser: true },
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
  await copyFile(stillPath, path.join(output, 'proofcanvas-still-current.png'))
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
