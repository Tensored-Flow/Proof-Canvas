import { defineConfig } from "@playwright/test";
import path from "node:path";

const evidenceDirectory = process.env.PROOFCANVAS_PARITY_EVIDENCE_DIR ?? path.join(process.cwd(), ".native-shape-parity");

export default defineConfig({
  testDir: ".",
  testMatch: "browser.capture.ts",
  outputDir: path.join(evidenceDirectory, "playwright-results"),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 4 * 60_000,
  globalTimeout: 6 * 60_000,
  reporter: [["json", { outputFile: path.join(evidenceDirectory, "browser-report.json") }]],
  use: {
    baseURL: process.env.PROOFCANVAS_BASE_URL ?? "https://127.0.0.1:3217",
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    trace: "off",
    video: "off",
    screenshot: "off",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
});
