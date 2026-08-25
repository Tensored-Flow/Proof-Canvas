import { defineConfig } from '@playwright/test'
import path from 'node:path'

const artifactRoot = process.env.PROOFCANVAS_EVIDENCE_DIR ?? path.join(process.cwd(), '.proofcanvas-evidence')
const testResultsRoot = process.env.PROOFCANVAS_TEST_RESULTS_DIR ?? path.join(artifactRoot, 'test-results')

export default defineConfig({
  testDir: './tests/browser/proofcanvas',
  testMatch: '**/*.e2e.ts',
  outputDir: testResultsRoot,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 6 * 60_000,
  globalTimeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['json', { outputFile: path.join(artifactRoot, 'report.json') }]],
  use: {
    baseURL: process.env.PROOFCANVAS_BASE_URL ?? 'http://localhost:3217',
    // The isolated acceptance harness terminates TLS with an ephemeral,
    // loopback-only certificate so production Secure cookies are exercised.
    ignoreHTTPSErrors: process.env.PROOFCANVAS_BASE_URL?.startsWith('https://127.0.0.1:') ?? false,
    serviceWorkers: 'block',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    acceptDownloads: true,
  },
  projects: [
    { name: 'proofcanvas-chromium-1440', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
    { name: 'proofcanvas-chromium-1280', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  ],
})
