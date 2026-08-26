import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  PROOFCANVAS_SHAPE_PRESET_MIME,
  SHAPE_PRESET_IDS,
} from "../../../lib/proofcanvas/shapePresets";
import { NATIVE_SHAPE_PARITY_PROJECT_ID } from "./project";

const evidenceDirectory = process.env.PROOFCANVAS_PARITY_EVIDENCE_DIR ?? path.join(process.cwd(), ".native-shape-parity");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const shapeTypes = ["ellipse", "polygon", "dashed-line", "double-arrow", "freeform-path"] as const;
const authoringScreenshots = {
  desktop: "authoring-desktop-1440x900.png",
  locked: "authoring-locked-1440x900.png",
  playback: "authoring-playback-1440x900.png",
  portrait: "authoring-portrait-1024x1366.png",
} as const;

async function historyCount(page: Page): Promise<number> {
  return Number(await page.getByRole("application", { name: "ProofCanvas editor" }).getAttribute("data-history-past-count"));
}

async function changeNumber(page: Page, label: string, value: string): Promise<void> {
  const input = page.getByRole("spinbutton", { name: label, exact: true });
  await input.scrollIntoViewIfNeeded();
  await input.fill(value);
  await input.blur();
  await expect(input).toHaveValue(value);
}

async function dragBy(page: Page, locator: Locator, dx: number, dy: number): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("captures the exact persisted native-shape fixture through the real CanvasStage", async ({ page, browser }) => {
  const ownerPassword = process.env.PROOFCANVAS_PARITY_OWNER_PASSWORD;
  expect(ownerPassword, "The parity harness must provide its ephemeral owner password").toBeTruthy();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`));
  page.on("response", (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });

  await page.goto("/login");
  await page.getByLabel("Owner password").fill(ownerPassword!);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/projects/${NATIVE_SHAPE_PARITY_PROJECT_ID}`);

  const editor = page.getByRole("application", { name: "ProofCanvas editor" });
  await expect(editor).toHaveAttribute("data-project-id", NATIVE_SHAPE_PARITY_PROJECT_ID);
  await expect(editor).toHaveAttribute("data-schema-version", "4");
  await expect(editor).toHaveAttribute("data-server-revision", "2");
  await expect(page.locator(".pc-selection-handles")).toHaveCount(0);
  for (const type of shapeTypes) {
    await expect(page.locator(`[data-object-type="${type}"]`), `${type} must reach the real SVG stage`).toHaveCount(1);
  }

  const stage = editor.locator(".pc-stage");
  await expect(stage).toHaveAttribute("viewBox", "0 0 960 540");
  const screenshotPath = path.join(evidenceDirectory, "browser-stage.png");
  const svg = await stage.evaluate((element: SVGSVGElement) => {
    const clone = element.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", "960");
    clone.setAttribute("height", "540");
    return clone.outerHTML;
  });
  await writeFile(path.join(evidenceDirectory, "browser-stage.svg"), `${svg}\n`, { encoding: "utf8", mode: 0o600 });

  // The live stage caption is an absolutely positioned editor overlay that
  // intersects locator screenshots. Mount the exact serialized SVG as a
  // fixed-size browser surface so Chromium rasterizes only the authored frame.
  await page.evaluate((serialized) => {
    const host = document.createElement("div");
    host.id = "proofcanvas-native-shape-parity-frame";
    Object.assign(host.style, {
      position: "fixed",
      inset: "0 auto auto 0",
      width: "960px",
      height: "540px",
      zIndex: "2147483647",
      background: "#ffffff",
      overflow: "hidden",
    });
    host.innerHTML = serialized;
    const mounted = host.firstElementChild as SVGSVGElement;
    Object.assign(mounted.style, {
      width: "960px",
      height: "540px",
      maxWidth: "none",
      maxHeight: "none",
    });
    document.body.appendChild(host);
  }, svg);
  const screenshot = await page.locator("#proofcanvas-native-shape-parity-frame svg").screenshot({
    path: screenshotPath,
    animations: "disabled",
  });

  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();
  const objectGeometry = await Promise.all(shapeTypes.map(async (type) => {
    const object = editor.locator(`[data-object-type="${type}"]`);
    return object.evaluate((element: SVGGraphicsElement) => {
      const bounds = element.getBoundingClientRect();
      const box = element.getBBox();
      return {
        type: element.getAttribute("data-object-type"),
        objectId: element.getAttribute("data-object-id"),
        transform: element.getAttribute("transform"),
        localBBox: { x: box.x, y: box.y, width: box.width, height: box.height },
        screenBBox: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        dashCount: element.getAttribute("data-dash-count"),
      };
    });
  }));
  const expectedDashCount = Number(objectGeometry.find(({ type }) => type === "dashed-line")?.dashCount);
  expect(Number.isSafeInteger(expectedDashCount) && expectedDashCount >= 2).toBe(true);

  const projectBytes = await readFile(path.join(evidenceDirectory, "project.proofcanvas.json"));
  const projectSha256 = sha256(projectBytes);
  await page.locator("#proofcanvas-native-shape-parity-frame").evaluate((element) => element.remove());

  type ScreenshotKey = keyof typeof authoringScreenshots;
  type ScreenshotRecord = Readonly<{ path: string; sha256: string; width: number; height: number }>;
  const screenshotRecords = {} as Record<ScreenshotKey, ScreenshotRecord>;
  const captureAuthoringScreenshot = async (key: ScreenshotKey): Promise<void> => {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("The authoring journey requires an explicit viewport");
    const bytes = await page.screenshot({
      path: path.join(evidenceDirectory, authoringScreenshots[key]),
      fullPage: false,
      animations: "disabled",
    });
    screenshotRecords[key] = {
      path: authoringScreenshots[key],
      sha256: sha256(bytes),
      width: viewport.width,
      height: viewport.height,
    };
  };

  // Continue from the exact parity frame into one production authoring journey.
  await page.getByRole("tab", { name: "Shapes" }).click();
  const shapeCards = editor.locator("[data-shape-preset-id]");
  await expect(shapeCards).toHaveCount(SHAPE_PRESET_IDS.length);
  const palettePresetIds = await shapeCards.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-shape-preset-id")));
  expect(palettePresetIds).toEqual([...SHAPE_PRESET_IDS]);
  expect(await shapeCards.evaluateAll((cards) => cards.every((card) => card.getAttribute("draggable") === "true"))).toBe(true);
  const initialObjectCount = await editor.locator("[data-object-id]").count();
  expect(initialObjectCount).toBe(5);

  // Click insertion, independent ellipse dimensions, and exact undo/redo.
  await page.getByRole("button", { name: "Insert Ellipse" }).click();
  const ellipse = editor.locator('[data-object-type="ellipse"]').last();
  await expect(ellipse).toBeVisible();
  await changeNumber(page, "Width", "176");
  await changeNumber(page, "Height", "92");
  await expect(ellipse).toHaveAttribute("rx", "88");
  await expect(ellipse).toHaveAttribute("ry", "46");
  const historyAfterEllipse = await historyCount(page);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("spinbutton", { name: "Height", exact: true })).toHaveValue("84");
  const undoHeight = await page.getByRole("spinbutton", { name: "Height", exact: true }).inputValue();
  expect(undoHeight).toBe("84");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.getByRole("spinbutton", { name: "Height", exact: true })).toHaveValue("92");
  const redoHeight = await page.getByRole("spinbutton", { name: "Height", exact: true }).inputValue();
  expect(redoHeight).toBe("92");
  const historyAfterRedo = await historyCount(page);
  expect(historyAfterRedo).toBe(historyAfterEllipse);

  // Native HTML drag/drop plus exact polygon vertices and join controls.
  const polygonCard = page.getByRole("button", { name: "Insert Polygon" });
  await polygonCard.dragTo(stage, { targetPosition: { x: 285, y: 170 } });
  const polygon = editor.locator('[data-object-type="polygon"]').last();
  await expect(polygon).toBeVisible();
  const polygonJoin = page.getByRole("combobox", { name: "Polygon line join" });
  await expect(polygonJoin).toHaveValue("miter");
  await polygonJoin.selectOption("bevel");
  await changeNumber(page, "Vertex 1 X", "-0.42");
  await page.getByRole("button", { name: "Add after" }).first().click();
  await expect(page.getByRole("spinbutton", { name: "Vertex 6 X" })).toBeVisible();
  await expect(polygon).toHaveAttribute("stroke-linejoin", "bevel");
  const polygonVertexCount = (await polygon.getAttribute("points"))?.split(" ").length;
  expect(polygonVertexCount).toBe(6);

  // Exact dash pattern, cap, and endpoint authority.
  await page.getByRole("button", { name: "Insert Dashed line" }).click();
  const dashed = editor.locator('[data-object-type="dashed-line"]').last();
  await expect(dashed).toBeAttached();
  const dashedVisibility = await dashed.evaluate((element: SVGGraphicsElement) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const visibleSegments = [...element.querySelectorAll<SVGLineElement>('line:not([stroke="transparent"])')];
    return {
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
      screenWidth: bounds.width,
      dashCount: Number(element.getAttribute("data-dash-count")),
      segmentCount: visibleSegments.length,
      paintedSegments: visibleSegments.filter((segment) => segment.getAttribute("stroke") !== "none").length,
      dashPatterns: visibleSegments.map((segment) => getComputedStyle(segment).strokeDasharray),
    };
  });
  expect(dashedVisibility).toEqual(expect.objectContaining({
    display: "inline",
    visibility: "visible",
    opacity: 1,
  }));
  expect(dashedVisibility.screenWidth).toBeGreaterThan(100);
  expect(dashedVisibility.dashCount).toBeGreaterThan(1);
  expect(dashedVisibility.segmentCount).toBeGreaterThanOrEqual(1);
  expect(dashedVisibility.paintedSegments).toBe(dashedVisibility.segmentCount);
  expect(dashedVisibility.dashPatterns.every((pattern) => pattern !== "none" && pattern !== "")).toBe(true);
  await page.getByRole("combobox", { name: "Dashed line cap" }).selectOption("round");
  await changeNumber(page, "Dash length", "10.5");
  await changeNumber(page, "Gap length", "6.25");
  const dashedStartX = Number(await page.getByRole("spinbutton", { name: "Start X" }).inputValue());
  await changeNumber(page, "End Y", "294");
  await expect(dashed).toHaveAttribute("data-dash-length", "10.5");
  await expect(dashed).toHaveAttribute("data-gap-length", "6.25");
  await expect(dashed.locator('line:not([stroke="transparent"])')).toHaveAttribute("stroke-linecap", "round");
  const dashedStartXAfter = Number(await page.getByRole("spinbutton", { name: "Start X" }).inputValue());
  expect(dashedStartXAfter).toBe(dashedStartX);

  // Independent double-arrow tips, ratio, cap, and endpoints.
  await page.getByRole("button", { name: "Insert Double arrow" }).click();
  const doubleArrow = editor.locator('[data-object-type="double-arrow"]').last();
  await expect(doubleArrow).toBeVisible();
  await page.getByRole("combobox", { name: "Double arrow line cap" }).selectOption("square");
  await page.getByRole("combobox", { name: "Start arrow tip" }).selectOption("circle");
  await page.getByRole("combobox", { name: "End arrow tip" }).selectOption("square");
  await changeNumber(page, "Double arrow tip size", "0.36");
  await changeNumber(page, "End Y", "332");
  await expect(doubleArrow.locator('[data-arrow-tip-side="start"]')).toHaveAttribute("data-arrow-tip-shape", "circle");
  await expect(doubleArrow.locator('[data-arrow-tip-side="end"]')).toHaveAttribute("data-arrow-tip-shape", "square");

  // Open cubic controls, exact node/handle edits, and closure semantics.
  await page.getByRole("button", { name: "Insert Freeform path" }).click();
  const freeform = editor.locator('[data-object-type="freeform-path"]').last();
  await expect(freeform).toBeVisible();
  await page.getByRole("combobox", { name: "Freeform line cap" }).selectOption("square");
  await page.getByRole("combobox", { name: "Freeform line join" }).selectOption("bevel");
  await changeNumber(page, "Node 2 X", "0.12");
  await changeNumber(page, "Node 2 incoming handle X", "-0.08");
  const openPathData = await freeform.locator('path:not([stroke="transparent"])').getAttribute("d");
  await page.getByRole("checkbox", { name: "Closed freeform path" }).check();
  await expect(freeform).toHaveAttribute("data-freeform-closed", "true");
  await expect(page.getByRole("combobox", { name: "Freeform line cap" })).toHaveCount(0);
  const closedPathData = await freeform.locator('path:not([stroke="transparent"])').getAttribute("d");
  expect(closedPathData).not.toBe(openPathData);
  const authoredObjectCount = await editor.locator("[data-object-id]").count();
  expect(authoredObjectCount).toBe(10);
  await captureAuthoringScreenshot("desktop");

  // Locked objects stay selectable while inspector and pointer mutation refuse.
  const historyBeforeLock = await historyCount(page);
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  const lockedJoin = page.getByRole("combobox", { name: "Freeform line join" });
  await expect(lockedJoin).toBeDisabled();
  const lockedInspectorDisabled = await lockedJoin.isDisabled();
  const lockedTransform = await freeform.getAttribute("transform");
  await dragBy(page, freeform, 55, 25);
  const lockedNotice = (await page.getByRole("status", { name: "Editor status" }).textContent())?.trim() ?? "";
  expect(lockedNotice).toMatch(/Locked objects remain selectable/i);
  const lockedTransformAfter = await freeform.getAttribute("transform");
  expect(lockedTransformAfter).toBe(lockedTransform);
  const historyAfterLockedAttempt = await historyCount(page);
  expect(historyAfterLockedAttempt).toBe(historyBeforeLock + 1);
  await captureAuthoringScreenshot("locked");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();

  // Playback disables authoring and explicitly refuses a forged shape drop.
  const historyBeforePlayback = await historyCount(page);
  await page.getByRole("button", { name: "Play sequence" }).click();
  await expect(page.getByRole("button", { name: "Pause sequence" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Insert Ellipse" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Freeform line join" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await expect(stage).toHaveAttribute("data-shape-drop-enabled", "false");
  const playbackPaletteDisabled = await page.getByRole("button", { name: "Insert Ellipse" }).isDisabled();
  const playbackInspectorDisabled = await page.getByRole("combobox", { name: "Freeform line join" }).isDisabled();
  const playbackUndoDisabled = await page.getByRole("button", { name: "Undo" }).isDisabled();
  const playbackStageDropEnabled = await stage.getAttribute("data-shape-drop-enabled");
  const transfer = await page.evaluateHandle((mime) => {
    const value = new DataTransfer();
    value.setData(mime, "ellipse");
    return value;
  }, PROOFCANVAS_SHAPE_PRESET_MIME);
  await stage.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  const playbackNotice = (await page.getByRole("status", { name: "Editor status" }).textContent())?.trim() ?? "";
  expect(playbackNotice).toMatch(/Pause playback before dropping a shape/i);
  const historyAfterPlaybackDrop = await historyCount(page);
  expect(historyAfterPlaybackDrop).toBe(historyBeforePlayback);
  await captureAuthoringScreenshot("playback");
  await page.getByRole("button", { name: "Pause sequence" }).click();

  // Supported portrait viewport plus a real 540x960 authored frame and no overflow.
  await page.setViewportSize({ width: 1024, height: 1366 });
  await page.getByRole("button", { name: "Project settings" }).click();
  await page.getByRole("combobox", { name: "Aspect ratio" }).selectOption("9:16");
  await expect(page.getByText("540 × 960")).toBeVisible();
  await page.getByRole("button", { name: "Close project settings" }).click();
  await expect(page.getByLabel("Desktop viewport required")).toBeHidden();
  await expect(stage).toHaveAttribute("viewBox", "0 0 540 960");
  await page.getByRole("treeitem", { name: /^Freeform path;/ }).click();
  await page.getByRole("spinbutton", { name: "Node 2 X" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("spinbutton", { name: "Node 2 X" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Insert Ellipse" })).toBeVisible();
  const portraitLayout = await page.evaluate(() => {
    const currentStage = document.querySelector<SVGSVGElement>(".pc-stage")!;
    const inspector = document.querySelector<HTMLElement>(".pc-right")!;
    const library = document.querySelector<HTMLElement>(".pc-left")!;
    const currentStageBox = currentStage.getBoundingClientRect();
    return {
      innerWidth,
      innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      stageWidth: currentStageBox.width,
      stageHeight: currentStageBox.height,
      stageAspect: currentStageBox.width / currentStageBox.height,
      inspectorClientWidth: inspector.clientWidth,
      inspectorScrollHeight: inspector.scrollHeight,
      inspectorClientHeight: inspector.clientHeight,
      libraryClientWidth: library.clientWidth,
    };
  });
  expect(portraitLayout.documentWidth).toBeLessThanOrEqual(portraitLayout.innerWidth);
  expect(portraitLayout.documentHeight).toBeLessThanOrEqual(portraitLayout.innerHeight);
  expect(portraitLayout.stageWidth).toBeGreaterThan(180);
  expect(portraitLayout.stageHeight).toBeGreaterThan(320);
  expect(portraitLayout.stageAspect).toBeCloseTo(9 / 16, 2);
  expect(portraitLayout.inspectorClientWidth).toBeGreaterThan(250);
  expect(portraitLayout.libraryClientWidth).toBeGreaterThan(220);
  await captureAuthoringScreenshot("portrait");
  await expect(page.locator('[role="status"][aria-label="Autosave status"]')).toHaveAttribute("data-save-state", "saved", { timeout: 15_000 });

  const authoringSummary = {
    schemaVersion: 1,
    projectId: NATIVE_SHAPE_PARITY_PROJECT_ID,
    parityProjectSha256: projectSha256,
    projectSchemaVersion: 4,
    initialObjectCount,
    authoredObjectCount,
    paletteCount: palettePresetIds.length,
    palettePresetIds,
    insertionModes: ["click", "drag-and-drop"],
    editedNativeShapes: [...shapeTypes],
    controls: {
      ellipse: { width: 176, height: 92 },
      polygon: { lineJoin: "bevel", vertex1X: -0.42, vertexCount: polygonVertexCount },
      dashedLine: { lineCap: "round", dashLength: 10.5, gapLength: 6.25, endY: 294, startXPreserved: dashedStartXAfter === dashedStartX },
      doubleArrow: { lineCap: "square", startTip: "circle", endTip: "square", tipSizeRatio: 0.36, endY: 332 },
      freeformPath: { lineCapBeforeClose: "square", lineJoin: "bevel", node2X: 0.12, node2IncomingHandleX: -0.08, closed: true, closureChangedPath: closedPathData !== openPathData },
    },
    history: { historyAfterEllipse, undoHeight, redoHeight, historyAfterRedo },
    lockedMutationRefusal: {
      historyBeforeLock,
      historyAfterLockedAttempt,
      inspectorDisabled: lockedInspectorDisabled,
      transformUnchanged: lockedTransformAfter === lockedTransform,
      notice: lockedNotice,
    },
    playbackRefusal: {
      historyBeforePlayback,
      historyAfterPlaybackDrop,
      paletteDisabled: playbackPaletteDisabled,
      inspectorDisabled: playbackInspectorDisabled,
      undoDisabled: playbackUndoDisabled,
      stageDropEnabled: playbackStageDropEnabled === "true",
      notice: playbackNotice,
    },
    portrait: {
      viewport: { width: 1024, height: 1366 },
      authoredFrame: { width: 540, height: 960 },
      layout: portraitLayout,
    },
    screenshots: screenshotRecords,
    errors: { consoleErrors, pageErrors, failedRequests, serverErrors },
  };
  const authoringBytes = Buffer.from(`${JSON.stringify(authoringSummary, null, 2)}\n`, "utf8");
  const browserCapture = {
    schemaVersion: 1,
    browser: await browser.version(),
    projectId: NATIVE_SHAPE_PARITY_PROJECT_ID,
    projectSha256,
    screenshotSha256: sha256(screenshot),
    svgSha256: sha256(`${svg}\n`),
    stagePixels: { width: stageBox!.width, height: stageBox!.height },
    viewBox: { width: 960, height: 540 },
    expectedDashCount,
    objects: objectGeometry,
    authoring: {
      summarySha256: sha256(authoringBytes),
      screenshots: screenshotRecords,
    },
    consoleErrors,
    pageErrors,
    failedRequests,
    serverErrors,
  };
  await Promise.all([
    writeFile(path.join(evidenceDirectory, "browser-authoring.json"), authoringBytes, { mode: 0o600 }),
    writeFile(
      path.join(evidenceDirectory, "browser-capture.json"),
      `${JSON.stringify(browserCapture, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ),
  ]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(serverErrors).toEqual([]);
});
