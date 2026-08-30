import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page, type Request } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { canonicalProjectJson } from '../../../lib/proofcanvas/schema'
import { PROOFCANVAS_STRESS_INVENTORY, createProofCanvasStressProject } from '../../../lib/proofcanvas/stressFixture'

const evidenceDir = process.env.PROOFCANVAS_EVIDENCE_DIR ?? path.join(process.cwd(), '.proofcanvas-evidence')

async function dragBy(page: Page, locator: Locator, dx: number, dy: number, startXOffset?: number) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box, `Expected a visible box for ${await locator.getAttribute('aria-label')}`).not.toBeNull()
  const relativeX = startXOffset === undefined ? box!.width / 2 : Math.min(box!.width - 1, Math.max(1, startXOffset))
  const relativeY = box!.height / 2
  await locator.hover({ position: { x: relativeX, y: relativeY } })
  const settledBox = await locator.boundingBox()
  expect(settledBox).not.toBeNull()
  const x = settledBox!.x + relativeX
  const y = settledBox!.y + relativeY
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 5 })
  await page.mouse.up()
}

async function historyCount(page: Page) {
  return Number(await page.getByRole('application', { name: 'ProofCanvas editor' }).getAttribute('data-history-past-count'))
}

async function boxCenter(locator: Locator) {
  const box = await locator.boundingBox()
  expect(box, `Expected a visible box for ${await locator.getAttribute('aria-label')}`).not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

async function setSelectedPosition(page: Page, x: number, y: number) {
  const xPosition = page.getByRole('spinbutton', { name: 'X position' })
  await xPosition.fill(String(x))
  await xPosition.blur()
  await expect(xPosition).toHaveValue(String(x))
  const yPosition = page.getByRole('spinbutton', { name: 'Y position' })
  await yPosition.fill(String(y))
  await yPosition.blur()
  await expect(yPosition).toHaveValue(String(y))
}

async function waitForEditorMediaToSettle(page: Page) {
  const audio = page.locator('audio[data-audio-clip-id]')
  if (await audio.count()) {
    await expect.poll(async () => audio.evaluateAll((elements) => elements.every((element) => {
      const media = element as HTMLAudioElement
      return media.error === null
        && media.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA
        && media.networkState === HTMLMediaElement.NETWORK_IDLE
    })), { timeout: 30_000 }).toBe(true)
  }
  await expect(page.locator('.pc-waveform[data-waveform-state="loading"]')).toHaveCount(0, { timeout: 30_000 })
}

type PortableIdentified = { id: string } & Record<string, unknown>

type PortableProjectIds = {
  assets: PortableIdentified[]
  styles: PortableIdentified[]
  customEasings: PortableIdentified[]
  shots: Array<{
    id: string
    objects: PortableIdentified[]
    animations: PortableIdentified[]
    propertyTracks: Array<PortableIdentified & { keyframes: PortableIdentified[] }>
    audioClips: PortableIdentified[]
    captionClips: PortableIdentified[]
    markers: PortableIdentified[]
  } & Record<string, unknown>>
}

type PortableProjectSnapshot = PortableProjectIds & {
  metadata: { id: string } & Record<string, unknown>
  settings: {
    aspectRatio: '16:9' | '9:16' | '1:1'
    frameRate: 15 | 24 | 30 | 60
    resolution: { width: number; height: number }
    renderPreset: 'draft' | '720p' | '1080p'
    previewQuality: 'draft' | 'standard' | 'high'
  }
  activeStyleId: string
}

function portableStableIds(project: PortableProjectIds) {
  const sorted = (ids: string[]) => ids.sort((left, right) => left.localeCompare(right))
  return {
    assets: sorted(project.assets.map(({ id }) => id)),
    styles: sorted(project.styles.map(({ id }) => id)),
    customEasings: sorted(project.customEasings.map(({ id }) => id)),
    shots: sorted(project.shots.map(({ id }) => id)),
    objects: sorted(project.shots.flatMap(({ objects }) => objects.map(({ id }) => id))),
    animations: sorted(project.shots.flatMap(({ animations }) => animations.map(({ id }) => id))),
    propertyTracks: sorted(project.shots.flatMap(({ propertyTracks }) => propertyTracks.map(({ id }) => id))),
    keyframes: sorted(project.shots.flatMap(({ propertyTracks }) => propertyTracks.flatMap(({ keyframes }) => keyframes.map(({ id }) => id)))),
    audioClips: sorted(project.shots.flatMap(({ audioClips }) => audioClips.map(({ id }) => id))),
    captionClips: sorted(project.shots.flatMap(({ captionClips }) => captionClips.map(({ id }) => id))),
    markers: sorted(project.shots.flatMap(({ markers }) => markers.map(({ id }) => id))),
  }
}

function withoutFreshProjectIdentity(project: PortableProjectSnapshot) {
  const metadata: Record<string, unknown> = { ...project.metadata }
  for (const key of ['id', 'createdAt', 'updatedAt']) delete metadata[key]
  return { ...project, metadata }
}

test('complete structured edit-to-Manim journey', async ({ page, browser }, testInfo) => {
  const ownerPassword = process.env.PROOFCANVAS_E2E_OWNER_PASSWORD
  expect(ownerPassword, 'The isolated acceptance harness must provide an ephemeral owner password').toBeTruthy()
  const consoleErrors: string[] = []
  const networkErrors: string[] = []
  let journeyPhase = 'bootstrap'
  const requestStarts = new WeakMap<Request, { phase: string; startedAt: number }>()
  const markPhase = (phase: string) => { journeyPhase = phase }
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('request', (request) => requestStarts.set(request, { phase: journeyPhase, startedAt: performance.now() }))
  page.on('requestfailed', (request) => {
    const start = requestStarts.get(request)
    const elapsedMs = start ? Math.max(0, Math.round(performance.now() - start.startedAt)) : -1
    networkErrors.push(`${request.method()} ${request.url()} failed: ${request.failure()?.errorText ?? 'unknown error'} [resource=${request.resourceType()} startPhase=${start?.phase ?? 'unknown'} failurePhase=${journeyPhase} elapsedMs=${elapsedMs}]`)
  })
  page.on('response', (response) => {
    if (response.status() >= 500) networkErrors.push(`${response.request().method()} ${response.url()} returned ${response.status()}`)
  })

  const compatibility = await page.request.get('/proofcanvas', { maxRedirects: 0 })
  expect(compatibility.status()).toBe(307)
  expect(compatibility.headers().location).toBe('/login')

  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await page.getByLabel('Owner password').fill(ownerPassword!)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Your mathematical motion projects' })).toBeVisible()
  if (testInfo.project.name === 'proofcanvas-chromium-1920') {
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-dashboard-1920x1080.png'), fullPage: false })
    await page.getByRole('textbox', { name: 'Project title' }).fill('Blank authoring workspace')
    await page.getByRole('button', { name: 'New blank project' }).click()
    await expect(page).toHaveURL(/\/projects\/project-[a-f0-9]{24}$/)
    const blankEditor = page.getByRole('application', { name: 'ProofCanvas editor' })
    await expect(blankEditor).toHaveAttribute('data-durable', 'true')
    await expect(page.locator('[data-layer-object-id]')).toHaveCount(0)
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-blank-editor-1920x1080.png'), fullPage: false })

    // Journey A must start from this genuinely blank durable project. Build
    // the required scene only through visible manual authoring controls,
    // animate exact properties, play it, then prove autosave and refresh.
    const blankPlayhead = page.getByRole('slider', { name: 'Sequence time' })
    await page.getByRole('tab', { name: 'Text' }).click()
    await page.getByRole('button', { name: 'Add text' }).click()
    const blankTitle = page.locator('[data-object-type="text"]').last()
    await expect(blankTitle).toBeVisible()
    const blankTitleName = page.getByRole('textbox', { name: 'Name' })
    await blankTitleName.fill('Blank journey title')
    await blankTitleName.blur()
    const blankTitleContent = page.getByRole('textbox', { name: 'Content' })
    await blankTitleContent.fill('A theorem authored from blank')
    await blankTitleContent.blur()
    await setSelectedPosition(page, 360, 90)
    const blankTitleBefore = await boxCenter(blankTitle)
    await dragBy(page, blankTitle, 24, 12)
    const blankTitleAfter = await boxCenter(blankTitle)
    expect(blankTitleAfter.x - blankTitleBefore.x).toBeGreaterThan(18)
    expect(blankTitleAfter.y - blankTitleBefore.y).toBeGreaterThan(7)

    await page.getByRole('tab', { name: 'Math' }).click()
    await page.getByRole('button', { name: 'Add math' }).click()
    const blankMath = page.locator('[data-object-type="math"]').last()
    await expect(blankMath).toBeVisible()
    const blankMathName = page.getByRole('textbox', { name: 'Name' })
    await blankMathName.fill('Blank journey equation')
    await blankMathName.blur()
    await page.getByRole('textbox', { name: 'Math content' }).fill('f(x)=x^2')
    await page.getByRole('button', { name: 'Apply math draft' }).click()

    await page.getByRole('tab', { name: 'Graphs' }).click()
    await page.getByRole('button', { name: 'Add coordinate axes' }).click()
    await page.getByRole('button', { name: 'Add function graph' }).click()
    await page.getByRole('tab', { name: 'Shapes' }).click()
    await page.getByRole('button', { name: 'Insert Arrow' }).click()
    await page.getByRole('tab', { name: 'Text' }).click()
    await page.getByRole('button', { name: 'Add text' }).click()
    const blankAnnotationName = page.getByRole('textbox', { name: 'Name' })
    await blankAnnotationName.fill('Blank journey annotation')
    await blankAnnotationName.blur()
    const blankAnnotationContent = page.getByRole('textbox', { name: 'Content' })
    await blankAnnotationContent.fill('The curve is constructed manually.')
    await blankAnnotationContent.blur()
    await expect(page.locator('[data-layer-object-id]')).toHaveCount(6)

    const blankTitleLayer = page.getByRole('treeitem', { name: /Blank journey title/ })
    await blankTitleLayer.click()
    await blankPlayhead.fill('0')
    await page.getByRole('button', { name: 'Add X position keyframe at 0 seconds' }).click()
    await blankTitleLayer.click()
    await page.getByRole('button', { name: 'Add Opacity keyframe at 0 seconds' }).click()
    await blankPlayhead.fill('1')
    await blankTitleLayer.click()
    const blankKeyedX = page.getByRole('spinbutton', { name: 'X position' })
    await blankKeyedX.fill('430')
    await blankKeyedX.blur()
    await blankTitleLayer.click()
    const blankKeyedOpacity = page.getByRole('spinbutton', { name: 'Opacity' })
    await blankKeyedOpacity.fill('0.7')
    await blankKeyedOpacity.blur()
    await expect(page.getByRole('button', { name: 'x keyframe at 1 seconds' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'opacity keyframe at 1 seconds' })).toBeVisible()
    await blankPlayhead.fill('0')
    const blankArrowLayer = page.getByRole('treeitem', { name: /^Arrow;/ })
    const blankArrowId = await blankArrowLayer.getAttribute('data-layer-object-id')
    expect(blankArrowId).toMatch(/^object-/)
    await blankArrowLayer.click()
    await page.getByRole('combobox', { name: 'Animation type' }).selectOption('fade-in')
    await page.getByRole('button', { name: 'Add animation' }).click()
    const blankFade = page.locator('[data-animation-type="fade-in"]')
    await expect(blankFade).toHaveCount(1)
    await expect(blankFade).toHaveAttribute('data-target-ids', blankArrowId!)
    const blankAnimationEasing = page.getByRole('combobox', { name: 'Easing' })
    await blankAnimationEasing.selectOption('ease-in-out')
    await expect(blankAnimationEasing).toHaveValue('ease-in-out')
    await page.getByRole('button', { name: 'Play sequence' }).click()
    await expect(page.getByRole('button', { name: 'Pause sequence' })).toBeVisible()
    await expect.poll(async () => Number(await page.getByRole('region', { name: 'Scene canvas' }).getAttribute('data-preview-time'))).toBeGreaterThan(0.1)
    await page.getByRole('button', { name: 'Pause sequence' }).click()
    await page.getByLabel('Owner menu').click()
    await page.getByRole('button', { name: 'Save project' }).click()
    await expect(blankEditor).toHaveAttribute('data-save-state', 'saved', { timeout: 30_000 })
    await page.reload()
    await expect(page.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-durable', 'true')
    await expect(page.getByRole('treeitem', { name: /Blank journey title/ })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: /Blank journey equation/ })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: /Blank journey annotation/ })).toBeVisible()
    await expect(page.locator('[data-layer-object-id]')).toHaveCount(6)
    await expect(page.getByRole('button', { name: 'x keyframe at 0 seconds', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'opacity keyframe at 1 seconds', exact: true })).toBeVisible()
    const reloadedBlankFade = page.locator('[data-animation-type="fade-in"]')
    await expect(reloadedBlankFade).toHaveCount(1)
    await reloadedBlankFade.click()
    await expect(page.getByRole('combobox', { name: 'Easing' })).toHaveValue('ease-in-out')
    await page.getByRole('link', { name: 'Back to projects' }).click()
    await expect(page.getByRole('heading', { name: 'Your mathematical motion projects' })).toBeVisible()
  }
  await page.getByRole('textbox', { name: 'Project title' }).fill('Semantic component study')
  markPhase('representative-project-create')
  await page.getByRole('button', { name: 'New sample project' }).click()
  await expect(page).toHaveURL(/\/projects\/project-[a-f0-9]{24}$/)
  const editor = page.getByRole('application', { name: 'ProofCanvas editor' })
  await expect(editor).toHaveAttribute('data-project-id', /^project-[a-f0-9]{24}$/)
  await expect(editor).toHaveAttribute('data-durable', 'true')
  const projectId = await editor.getAttribute('data-project-id')
  expect(projectId).not.toBeNull()
  const authenticatedCompatibility = await page.request.get('/proofcanvas', { maxRedirects: 0 })
  expect(authenticatedCompatibility.status()).toBe(307)
  expect(authenticatedCompatibility.headers().location).toBe('/')
  await expect(page.getByRole('tree', { name: 'Objects' })).toBeVisible()
  await expect(page.locator('[role="tabpanel"][aria-label="Animation timeline"]')).toBeVisible()

  const playhead = page.getByRole('slider', { name: 'Sequence time' })
  await playhead.fill('12.5')
  await expect(page.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '12.5')
  await expect(page.locator('[data-object-id="object-equation-length"]')).toHaveCount(0)
  await expect(page.locator('[data-object-id="object-interval-third-1-left"]')).toBeVisible()
  await playhead.fill('15.2')
  await expect(page.locator('[data-object-id="object-equation-length"]')).toBeVisible()
  await playhead.fill('12.5')

  const title = page.locator('[data-object-id="object-title"]')
  await expect(title).toBeVisible()
  const editorialTransform = await title.getAttribute('transform')
  await playhead.fill('0.6')
  const editorialOpacity = Number(await title.getAttribute('opacity'))
  const titleText = title.locator('.pc-canvas-text')
  const editorialFontFamily = await titleText.evaluate((element) => getComputedStyle(element).fontFamily)
  const editorialBackground = await page.locator('.pc-stage-wrap').evaluate((element) => getComputedStyle(element).backgroundColor)
  const styleHistory = await historyCount(page)
  await page.getByRole('radio', { name: 'Raw Manim' }).check()
  await expect(page.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-style-id', 'style-raw-manim')
  expect(await historyCount(page)).toBe(styleHistory + 1)
  expect(Number(await title.getAttribute('opacity'))).toBeCloseTo(editorialOpacity, 8)
  expect(await titleText.evaluate((element) => getComputedStyle(element).fontFamily)).not.toBe(editorialFontFamily)
  expect(await page.locator('.pc-stage-wrap').evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(editorialBackground)
  await playhead.fill('12.5')
  expect(await title.getAttribute('transform')).toBe(editorialTransform)
  await title.click()
  const rawTitleBefore = await boxCenter(title)
  await dragBy(page, title, 100, 0)
  const rawTitleAfter = await boxCenter(title)
  expect(rawTitleAfter.x - rawTitleBefore.x).toBeGreaterThan(95)
  expect(rawTitleAfter.x - rawTitleBefore.x).toBeLessThan(105)
  expect(Math.abs(rawTitleAfter.y - rawTitleBefore.y)).toBeLessThan(2)
  await page.getByRole('button', { name: 'Undo' }).click()
  const rawTitleUndone = await boxCenter(title)
  expect(Math.abs(rawTitleUndone.x - rawTitleBefore.x)).toBeLessThan(2)
  await page.getByRole('radio', { name: 'Editorial Ink' }).check()
  expect(await historyCount(page)).toBe(styleHistory + 2)

  const screenshotName = testInfo.project.name.includes('1920')
    ? 'proofcanvas-editorial-1920x1080.png'
    : testInfo.project.name.includes('1440')
      ? 'proofcanvas-editorial-1440x900.png'
      : 'proofcanvas-editorial-1280x800.png'

  const stageBounds = await page.locator('.pc-stage').boundingBox()
  const titleBounds = await title.boundingBox()
  expect(stageBounds).not.toBeNull()
  expect(titleBounds).not.toBeNull()
  expect(titleBounds!.x).toBeGreaterThanOrEqual(stageBounds!.x - 1)
  expect(titleBounds!.y).toBeGreaterThanOrEqual(stageBounds!.y - 1)
  expect(titleBounds!.x + titleBounds!.width).toBeLessThanOrEqual(stageBounds!.x + stageBounds!.width + 1)
  const captionBounds = await page.locator('.pc-stage-caption').boundingBox()
  const statusBounds = await page.getByRole('status', { name: 'Editor status', exact: true }).boundingBox()
  expect(captionBounds).not.toBeNull()
  expect(statusBounds).not.toBeNull()
  expect(captionBounds!.y + captionBounds!.height).toBeLessThanOrEqual(statusBounds!.y)

  const layout = await page.evaluate(() => ({
    innerWidth,
    innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    canvasWidth: document.querySelector('[data-pc-canvas]')?.getBoundingClientRect().width ?? 0,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.innerWidth)
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.innerHeight)
  expect(layout.canvasWidth).toBeGreaterThan(650)

  const axe = await new AxeBuilder({ page }).setLegacyMode(true).analyze()
  const materialA11y = axe.violations.filter(({ impact }) => impact === 'critical' || impact === 'serious')
  expect(materialA11y, JSON.stringify(materialA11y, null, 2)).toEqual([])

  // Journey B: import trusted audio bytes through the owner UI, place and
  // trim a clip, author an exact volume key, import/export captions, and
  // exercise synchronized browser playback before the genuine MP4 render.
  markPhase('journey-b-audio-import-and-playback')
  await page.getByRole('tab', { name: 'Media' }).click()
  const audioAssets = page.locator('.pc-audio-assets article')
  const initialAudioAssetCount = await audioAssets.count()
  expect(initialAudioAssetCount).toBeGreaterThan(0)
  const audioFixturePath = path.join(process.cwd(), 'examples/proofcanvas/proofcanvas-deterministic-pulse-90s.wav')
  await page.getByLabel('Import project assets').setInputFiles(audioFixturePath)
  await expect(audioAssets).toHaveCount(initialAudioAssetCount + 1, { timeout: 30_000 })
  const audioClips = page.locator('.pc-audio-clip')
  const initialAudioClipCount = await audioClips.count()
  await playhead.fill('4')
  await audioAssets.last().getByRole('button', { name: 'Add', exact: true }).click()
  await expect(audioClips).toHaveCount(initialAudioClipCount + 1)
  await expect(audioClips.last()).toHaveAttribute('data-start', '4')
  await expect(audioClips.last()).toHaveAttribute('data-duration', '17')
  const sourceIn = page.getByRole('spinbutton', { name: 'Source in' })
  await sourceIn.fill('0.5')
  await sourceIn.blur()
  await expect(sourceIn).toHaveValue('0.5')
  const sourceOut = page.getByRole('spinbutton', { name: 'Source out' })
  await sourceOut.fill('17.5')
  await sourceOut.blur()
  await expect(sourceOut).toHaveValue('17.5')
  await playhead.fill('4')
  await page.getByRole('button', { name: /^Add Volume keyframe at 4(?:\.0+)? seconds$/ }).click()
  await expect(page.getByRole('button', { name: /^volume keyframe at 4(?:\.0+)? seconds$/i })).toBeVisible()
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.getByRole('button', { name: 'Pause sequence' })).toBeVisible()
  await expect.poll(async () => Number(await page.getByRole('region', { name: 'Scene canvas' }).getAttribute('data-preview-time'))).toBeGreaterThan(4)
  const importedAudioElement = page.locator('audio[data-audio-clip-id]').last()
  await expect.poll(async () => importedAudioElement.evaluate((element: HTMLAudioElement) => ({
    advanced: element.currentTime > 0.52,
    errorCode: element.error?.code ?? null,
    paused: element.paused,
    ready: element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
  }))).toEqual({ advanced: true, errorCode: null, paused: false, ready: true })
  await page.getByRole('button', { name: 'Pause sequence' }).click()
  await expect.poll(async () => importedAudioElement.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true)
  await expect(page.locator('audio[data-audio-clip-id]')).toHaveCount(initialAudioClipCount + 1)
  // The next operation changes shots and intentionally removes these
  // shot-local media elements. Prove the imported 90-second asset finished
  // loading first so a normal DOM teardown cannot be misreported as a failed
  // project-asset request on slower viewports.
  await waitForEditorMediaToSettle(page)

  // Import into a bounded empty shot at the end of the representative
  // sequence. The five sample shots intentionally have gapless captions, so
  // appending there would create an invalid overlapping SRT authority.
  markPhase('journey-b-leave-construction-for-caption-shot')
  await page.getByRole('tab', { name: /^Shot \d+, The paradox,/ }).click()
  await page.getByRole('button', { name: 'Add shot' }).click()
  const captionShotId = await editor.getAttribute('data-active-shot-id')
  expect(captionShotId).toMatch(/^shot-scene-\d+$/)

  const importedCaptionText = 'Browser-imported proof caption'
  const captionClips = page.locator('.pc-caption-clip')
  const initialCaptionCount = await captionClips.count()
  await page.getByLabel('Import captions').setInputFiles(
    path.join(process.cwd(), 'examples/proofcanvas/browser-import-proof-caption.srt'),
  )
  await expect(captionClips).toHaveCount(initialCaptionCount + 1)
  const srtDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export SRT' }).click()
  const srtDownload = await srtDownloadPromise
  const srtPath = await srtDownload.path()
  expect(srtPath).not.toBeNull()
  const exportedSrt = await readFile(srtPath!, 'utf8')
  expect(exportedSrt).toContain(importedCaptionText)
  expect(exportedSrt).toContain('00:00:53,000 --> 00:00:55,000')
  await playhead.fill('53.2')
  await expect(page.locator('.pc-canvas-caption-cue')).toContainText(importedCaptionText)
  await page.getByRole('button', { name: 'Play sequence' }).click()
  await expect(page.getByRole('button', { name: 'Pause sequence' })).toBeVisible()
  await expect.poll(async () => Number(await page.getByRole('region', { name: 'Scene canvas' }).getAttribute('data-preview-time'))).toBeGreaterThan(1.2)
  await page.getByRole('button', { name: 'Pause sequence' }).click()

  const constructionTab = page.getByRole('tab', { name: /^Shot \d+, The construction,/ })
  const bookkeepingTab = page.getByRole('tab', { name: /^Shot \d+, Finite bookkeeping,/ })
  await constructionTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(bookkeepingTab).toBeFocused()
  await expect(editor).toHaveAttribute('data-active-shot-id', 'shot-cantor-bookkeeping')
  await page.keyboard.press('ArrowLeft')
  await expect(constructionTab).toBeFocused()
  await expect(editor).toHaveAttribute('data-active-shot-id', 'shot-cantor-construction')
  await playhead.fill('12.5')

  const initialTitleLayer = page.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ })
  const initialSubtitleLayer = page.getByRole('treeitem', { name: /A quiet paradox/ })
  await initialTitleLayer.focus()
  await page.keyboard.press('ArrowDown')
  await expect(initialSubtitleLayer).toBeFocused()
  await expect(initialSubtitleLayer).toHaveAttribute('aria-selected', 'true')
  expect(await title.getAttribute('transform')).toBe(editorialTransform)
  await initialTitleLayer.click()
  if (testInfo.project.name === 'proofcanvas-chromium-1920') {
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-selected-text-1920x1080.png'), fullPage: false })
    await page.getByRole('tab', { name: 'Styles' }).click()
    await expect(page.getByLabel('Style Lab')).toBeVisible()
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-style-lab-1920x1080.png'), fullPage: false })
    await page.getByRole('radio', { name: 'Scientific Minimal', exact: true }).check()
    expect(await titleText.evaluate((element) => ({ horizontal: element.scrollWidth > element.clientWidth + 1, vertical: element.scrollHeight > element.clientHeight + 1 }))).toEqual({ horizontal: false, vertical: false })
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-style-scientific-minimal-1920x1080.png'), fullPage: false })
    await page.getByRole('radio', { name: 'Nocturne Chalk', exact: true }).check()
    expect(await titleText.evaluate((element) => ({ horizontal: element.scrollWidth > element.clientWidth + 1, vertical: element.scrollHeight > element.clientHeight + 1 }))).toEqual({ horizontal: false, vertical: false })
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-style-nocturne-chalk-1920x1080.png'), fullPage: false })
    await page.getByRole('radio', { name: 'Editorial Ink', exact: true }).check()
    await page.getByRole('tab', { name: 'Text' }).click()
  }

  if (testInfo.project.name === 'proofcanvas-chromium-1280') {
    const inspectorPanel = page.locator('.pc-right')
    const inspectorBounds = await inspectorPanel.boundingBox()
    expect(inspectorBounds).not.toBeNull()
    expect(inspectorBounds!.x).toBeGreaterThanOrEqual(0)
    expect(inspectorBounds!.x + inspectorBounds!.width).toBeLessThanOrEqual(1280)
    expect(inspectorBounds!.y + inspectorBounds!.height).toBeLessThanOrEqual(800)
    expect(await inspectorPanel.evaluate((element) => element.scrollHeight > element.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY))).toBe(true)
    for (const name of ['Ungroup selection', 'Send to back']) {
      const control = page.getByRole('button', { name })
      const textFits = await control.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      expect(textFits, `${name} must not clip at 1280 px`).toBe(true)
    }
    for (const label of ['X position', 'Y position', 'Width', 'Height', 'Rotation']) {
      const control = page.getByRole('spinbutton', { name: label, exact: true })
      await control.scrollIntoViewIfNeeded()
      const bounds = await control.boundingBox()
      expect(bounds, `${label} must remain visible inside the 1280 px inspector`).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(inspectorBounds!.x)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(inspectorBounds!.x + inspectorBounds!.width)
      expect(bounds!.y).toBeGreaterThanOrEqual(inspectorBounds!.y)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(inspectorBounds!.y + inspectorBounds!.height)
    }
  }
  let before = await historyCount(page)
  const editorialTitleBefore = await boxCenter(title)
  await dragBy(page, title, 32, 18)
  expect(await historyCount(page)).toBe(before + 1)
  const editorialTitleAfter = await boxCenter(title)
  expect(Math.abs((editorialTitleAfter.x - editorialTitleBefore.x) - 32)).toBeLessThan(6)
  expect(Math.abs((editorialTitleAfter.y - editorialTitleBefore.y) - 18)).toBeLessThan(6)
  before = await historyCount(page)
  const resizeHandle = page.getByLabel(/^Resize selected object;/)
  const resizeBefore = await boxCenter(resizeHandle)
  await dragBy(page, resizeHandle, 22, 14)
  expect(await historyCount(page)).toBe(before + 1)
  const resizeAfter = await boxCenter(resizeHandle)
  expect(Math.abs((resizeAfter.x - resizeBefore.x) - 22)).toBeLessThan(2)
  expect(Math.abs((resizeAfter.y - resizeBefore.y) - 14)).toBeLessThan(2)
  before = await historyCount(page)
  const rotateHandle = page.getByLabel(/^Rotate selected object;/)
  const rotateBefore = await boxCenter(rotateHandle)
  const rotationBefore = await page.getByRole('spinbutton', { name: 'Rotation' }).inputValue()
  await dragBy(page, rotateHandle, 25, -8)
  expect(await historyCount(page)).toBe(before + 1)
  expect(await page.getByRole('spinbutton', { name: 'Rotation' }).inputValue()).not.toBe(rotationBefore)
  const rotateAfter = await boxCenter(rotateHandle)
  expect(Math.hypot(rotateAfter.x - rotateBefore.x, rotateAfter.y - rotateBefore.y)).toBeGreaterThan(2)

  // Direct-manipulation evidence must not leave the representative project in
  // a visibly broken intermediate pose. Restore its exact authored title pose
  // before the later timeline and AI evidence captures.
  await setSelectedPosition(page, 360, 72)
  for (const [label, value] of [['Width', '640'], ['Height', '52'], ['Rotation', '0']] as const) {
    const control = page.getByRole('spinbutton', { name: label, exact: true })
    await control.fill(value)
    await control.blur()
    await expect(control).toHaveValue(value)
  }

  await page.getByRole('button', { name: 'Duplicate selection' }).click()
  await expect(page.getByRole('treeitem', { name: /Uncountable, Yet Zero Length copy/ })).toBeVisible()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('treeitem', { name: /Uncountable, Yet Zero Length copy/ })).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(page.getByRole('treeitem', { name: /Uncountable, Yet Zero Length copy/ })).toBeVisible()
  await page.keyboard.press('Control+Shift+z')

  await page.getByRole('tab', { name: 'Text' }).click()
  await page.getByRole('button', { name: 'Add text' }).click()
  await page.getByRole('tab', { name: 'Math' }).click()
  await page.getByRole('button', { name: 'Add math' }).click()
  await page.getByRole('button', { name: 'Add brace' }).click()
  await page.getByRole('tab', { name: 'Shapes' }).click()
  await page.getByRole('button', { name: 'Insert Circle' }).click()
  await page.getByRole('button', { name: 'Insert Arrow' }).click()
  await page.getByRole('tab', { name: 'Graphs' }).click()
  await page.getByRole('button', { name: 'Add coordinate axes' }).click()
  await page.getByRole('button', { name: 'Add function graph' }).click()
  await expect(page.getByRole('treeitem', { name: /Plain text/ })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /Mathematical text/ })).toBeVisible()

  const insertedGraph = page.locator('[data-object-type="graph"]').last()
  await expect(insertedGraph).toBeVisible()
  const graphExpression = page.getByRole('textbox', { name: 'Graph expression' })
  await expect(graphExpression).toHaveValue('(x ^ 2)')
  await graphExpression.fill('1 / 0')
  await expect(page.locator('.pc-graph-properties [role="alert"]')).toContainText(/division by zero/i)
  await expect(page.getByRole('button', { name: 'Apply graph draft' })).toBeDisabled()
  await page.getByRole('button', { name: 'Discard graph draft' }).click()
  await expect(graphExpression).toHaveValue('(x ^ 2)')

  let longGraphTerms = Array.from({ length: 32 }, (_, index) => String(-(0.123456789012345 + index * Number.EPSILON)))
  while (longGraphTerms.length > 1) {
    const next: string[] = []
    for (let index = 0; index < longGraphTerms.length; index += 2) next.push(`(${longGraphTerms[index]} + ${longGraphTerms[index + 1]})`)
    longGraphTerms = next
  }
  const longGraphExpression = longGraphTerms[0]
  expect(longGraphExpression.length).toBeGreaterThan(512)
  const longGraphHistory = await historyCount(page)
  await graphExpression.fill(longGraphExpression)
  await page.getByRole('button', { name: 'Apply graph draft' }).click()
  expect(await historyCount(page)).toBe(longGraphHistory + 1)
  await expect(graphExpression).toHaveValue(longGraphExpression)

  const reciprocalHistory = await historyCount(page)
  await graphExpression.fill('1 / x')
  await page.getByRole('button', { name: 'Apply graph draft' }).click()
  expect(await historyCount(page)).toBe(reciprocalHistory + 1)
  const graphGeometry = insertedGraph.locator('[data-graph-status="valid"]')
  await expect(graphGeometry).toHaveAttribute('data-graph-segment-count', '2')
  await expect(graphGeometry).toHaveAttribute('data-graph-diagnostic-codes', 'GRAPH_DISCONTINUITIES_SEGMENTED')
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(graphExpression).toHaveValue(longGraphExpression)
  await page.getByRole('button', { name: 'Redo' }).click()
  await expect(graphExpression).toHaveValue('(1 / x)')
  const insertedArrow = page.locator('[data-object-type="arrow"]').last()
  await expect(insertedArrow).toHaveAttribute('opacity', '1')
  const arrowHitPoint = await insertedArrow.evaluate((element: SVGGraphicsElement) => {
    const point = element.ownerSVGElement!.createSVGPoint()
    point.x = 0
    point.y = 6
    const screenPoint = point.matrixTransform(element.getScreenCTM()!)
    return { x: screenPoint.x, y: screenPoint.y }
  })
  await page.mouse.click(arrowHitPoint.x, arrowHitPoint.y)
  const insertedArrowId = await insertedArrow.getAttribute('data-object-id')
  expect(insertedArrowId).not.toBeNull()
  await expect(page.locator(`[data-layer-object-id="${insertedArrowId}"]`)).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('treeitem', { name: /^Plain text/ }).click()
  const contentField = page.getByRole('textbox', { name: 'Content' })
  await contentField.fill('Edited mathematical narration')
  await contentField.blur()
  await expect(page.locator('[data-object-id="object-text"] .pc-canvas-text')).toContainText('Edited mathematical narration')
  const xPosition = page.getByRole('spinbutton', { name: 'X position' })
  await xPosition.fill('520')
  await xPosition.blur()
  await expect(page.getByRole('spinbutton', { name: 'X position' })).toHaveValue('520')

  // The inserted primitives above prove the authoring controls. Remove their
  // disposable test instances from the polished representative shot, keeping
  // only the arrow needed for the animation-timeline exercise below.
  const disposableObjectIds = await Promise.all([
    page.locator('[data-object-type="text"]').last(),
    page.locator('[data-object-type="math"]').last(),
    page.locator('[data-object-type="brace"]').last(),
    page.locator('[data-object-type="circle"]').last(),
    page.locator('[data-object-type="axes"]').last(),
    insertedGraph,
  ].map((object) => object.getAttribute('data-object-id')))
  for (const objectId of disposableObjectIds) {
    expect(objectId).not.toBeNull()
    await page.locator(`[data-layer-object-id="${objectId}"]`).click()
    await page.keyboard.press('Delete')
    await expect(page.locator(`[data-layer-object-id="${objectId}"]`)).toHaveCount(0)
  }
  await page.locator(`[data-layer-object-id="${insertedArrowId}"]`).click()
  await setSelectedPosition(page, 850, 300)

  markPhase('journey-b-leave-construction-for-semantic-shot')
  await waitForEditorMediaToSettle(page)
  await page.locator(`[data-shot-id="${captionShotId}"]`).click()
  await expect(editor).toHaveAttribute('data-active-shot-id', captionShotId!)
  await page.getByRole('tab', { name: 'Graphs' }).click()
  await page.getByRole('button', { name: 'Add function graph' }).click()
  const visualGraph = page.locator('[data-object-type="graph"]').last()
  await expect(visualGraph).toBeVisible()
  if (testInfo.project.name === 'proofcanvas-chromium-1920') {
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-selected-graph-1920x1080.png'), fullPage: false })
  }
  const visualGraphId = await visualGraph.getAttribute('data-object-id')
  expect(visualGraphId).not.toBeNull()
  await page.keyboard.press('Delete')
  await expect(page.locator(`[data-layer-object-id="${visualGraphId}"]`)).toHaveCount(0)
  const componentShotName = page.getByRole('textbox', { name: 'Shot name' })
  await componentShotName.fill('Semantic component study')
  await componentShotName.blur()
  const componentShotTab = page.getByRole('tab', { name: /^Shot \d+, Semantic component study,/ })
  await expect(componentShotTab).toBeVisible()
  await page.getByRole('tab', { name: 'Components' }).click()
  await expect(page.getByRole('tab', { name: 'Components' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Components' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('tab', { name: 'Graphs' })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Components' })).toBeFocused()
  const componentLibrary = page.locator('.pc-component-list')
  await expect(componentLibrary).toHaveAttribute('data-semantic-component-count', '12')
  await expect(componentLibrary.locator('[data-component-id]')).toHaveCount(12)
  expect(await componentLibrary.locator('[data-component-id]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-component-id')))).toEqual([
    'mathematical-title', 'definition-block', 'proposition-statement', 'proof-step-sequence',
    'equation-chain', 'annotated-diagram', 'case-comparison', 'focus-callout', 'marginal-note',
    'recursive-intervals', 'vector-explanation', 'example-abstraction',
  ])
  await page.getByRole('button', { name: 'Insert Callout' }).click()
  await expect(page.locator('[data-layer-object-id="group-focus-callout"]')).toBeVisible()
  await setSelectedPosition(page, 240, 390)
  const componentDragHistory = await historyCount(page)
  const componentTransfer = await page.evaluateHandle(() => new DataTransfer())
  await page.getByRole('button', { name: 'Insert Vector explanation' }).dispatchEvent('dragstart', { dataTransfer: componentTransfer })
  const componentDropStage = page.locator('.pc-stage')
  const componentDropBounds = await componentDropStage.boundingBox()
  expect(componentDropBounds).not.toBeNull()
  const componentDropPoint = {
    x: componentDropBounds!.x + componentDropBounds!.width * 0.7,
    y: componentDropBounds!.y + componentDropBounds!.height * 0.62,
  }
  await componentDropStage.dispatchEvent('dragover', { dataTransfer: componentTransfer, clientX: componentDropPoint.x, clientY: componentDropPoint.y })
  await componentDropStage.dispatchEvent('drop', { dataTransfer: componentTransfer, clientX: componentDropPoint.x, clientY: componentDropPoint.y })
  await page.getByRole('button', { name: 'Insert Vector explanation' }).dispatchEvent('dragend', { dataTransfer: componentTransfer })
  expect(await historyCount(page)).toBe(componentDragHistory + 1)
  await expect(page.locator('[data-layer-object-id="group-vector-explanation"]')).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Insert Title & subtitle' }).click()
  const insertedTitleGroupLayer = page.locator('[data-layer-object-id="group-mathematical-title"]')
  await insertedTitleGroupLayer.click()
  const insertedTitleGroup = page.locator('[data-group-move-target="group-mathematical-title"]')
  await expect(insertedTitleGroup).toBeVisible()
  await setSelectedPosition(page, 480, 110)
  const semanticTitleText = page.locator('foreignObject[data-parent-id="group-mathematical-title"][aria-label="Title"] .pc-canvas-text')
  await expect(semanticTitleText).toBeVisible()
  expect(await semanticTitleText.evaluate((element) => ({
    horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
    verticalOverflow: element.scrollHeight > element.clientHeight + 1,
  }))).toEqual({ horizontalOverflow: false, verticalOverflow: false })
  if (testInfo.project.name === 'proofcanvas-chromium-1280') {
    await page.locator('.pc-left').evaluate((element) => element.scrollTo({ top: 0 }))
    await page.locator('.pc-right').evaluate((element) => element.scrollTo({ top: 0 }))
    await page.getByRole('button', { name: 'Collapse shot timeline' }).click()
    await expect(editor).toHaveAttribute('data-timeline-collapsed', 'true')
    expect((await page.locator('.pc-stage').boundingBox())!.width).toBeGreaterThan(650)
  }
  await page.screenshot({ path: path.join(evidenceDir, screenshotName), fullPage: false })
  if (testInfo.project.name === 'proofcanvas-chromium-1280') {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.getByRole('button', { name: 'Hide inspector panel' }).click()
    await expect(editor).toHaveAttribute('data-right-collapsed', 'true')
    const narrowLayout = await page.evaluate(() => ({
      innerWidth,
      innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
    }))
    expect(narrowLayout.documentWidth).toBeLessThanOrEqual(narrowLayout.innerWidth)
    expect(narrowLayout.documentHeight).toBeLessThanOrEqual(narrowLayout.innerHeight)
    await expect(page.getByRole('button', { name: 'Render or export' })).toBeVisible()
    expect((await page.locator('.pc-stage').boundingBox())!.width).toBeGreaterThan(650)
    const narrowAxe = await new AxeBuilder({ page }).setLegacyMode(true).analyze()
    expect(narrowAxe.violations.filter(({ impact }) => impact === 'critical' || impact === 'serious'), JSON.stringify(narrowAxe.violations, null, 2)).toEqual([])
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-narrow-editor-1024x768.png'), fullPage: false })
    await page.getByRole('button', { name: 'Show inspector panel' }).click()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('button', { name: 'Expand shot timeline' }).click()
    await expect(editor).toHaveAttribute('data-timeline-collapsed', 'false')
  }
  await setSelectedPosition(page, 480, 230)
  let groupCenterBefore = await boxCenter(insertedTitleGroup)
  const canvasSnapTarget = await page.locator('.pc-stage').evaluate((element: SVGSVGElement) => {
    const center = element.createSVGPoint()
    center.x = 480
    center.y = 270
    const near = element.createSVGPoint()
    near.x = 483
    near.y = 270
    const screenCenter = center.matrixTransform(element.getScreenCTM()!)
    const screenNear = near.matrixTransform(element.getScreenCTM()!)
    return { center: { x: screenCenter.x, y: screenCenter.y }, nearX: screenNear.x }
  })
  await page.mouse.move(groupCenterBefore.x, groupCenterBefore.y)
  await page.mouse.down()
  await page.mouse.move(canvasSnapTarget.nearX, groupCenterBefore.y, { steps: 5 })
  const xSnapGuide = page.locator('.pc-snap-guide[data-guide-axis="x"]')
  await expect(xSnapGuide).toHaveCount(1)
  await expect(xSnapGuide).toHaveAttribute('x1', '480')
  await page.mouse.up()
  await expect(xSnapGuide).toHaveCount(0)
  groupCenterBefore = await boxCenter(insertedTitleGroup)
  expect(Math.abs(groupCenterBefore.x - canvasSnapTarget.center.x)).toBeLessThan(2)
  const groupResizeHandle = page.getByLabel(/^Resize selected object;/)
  const groupHistoryBeforeResize = await historyCount(page)
  const groupResizeBefore = await boxCenter(groupResizeHandle)
  await dragBy(page, groupResizeHandle, 30, 15)
  const groupResizeAfter = await boxCenter(groupResizeHandle)
  const groupCenterAfterResize = await boxCenter(insertedTitleGroup)
  expect(Math.abs(groupCenterAfterResize.x - groupCenterBefore.x)).toBeLessThan(2)
  expect(Math.abs(groupCenterAfterResize.y - groupCenterBefore.y)).toBeLessThan(2)
  expect(Math.abs((groupResizeAfter.x - groupResizeBefore.x) - 30)).toBeLessThan(2)
  expect(Math.abs((groupResizeAfter.y - groupResizeBefore.y) - 15)).toBeLessThan(2)
  const groupRotationBefore = await page.getByRole('spinbutton', { name: 'Rotation' }).inputValue()
  const groupRotateHandle = page.getByLabel(/^Rotate selected object;/)
  const groupCenterBeforeRotate = await boxCenter(insertedTitleGroup)
  await groupRotateHandle.hover()
  await page.mouse.down()
  await page.mouse.move(groupCenterBeforeRotate.x + 100, groupCenterBeforeRotate.y, { steps: 8 })
  await page.mouse.up()
  expect(await historyCount(page)).toBe(groupHistoryBeforeResize + 2)
  expect(await page.getByRole('spinbutton', { name: 'Rotation' }).inputValue()).not.toBe(groupRotationBefore)
  const groupCenterAfterRotate = await boxCenter(insertedTitleGroup)
  expect(Math.abs(groupCenterAfterRotate.x - groupCenterBefore.x)).toBeLessThan(2)
  expect(Math.abs(groupCenterAfterRotate.y - groupCenterBefore.y)).toBeLessThan(2)
  await insertedTitleGroupLayer.click()
  const insertedVectorGroupLayer = page.locator('[data-layer-object-id="group-vector-explanation"]')
  await insertedVectorGroupLayer.click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: 'Align right' }).click()
  await insertedTitleGroupLayer.click()
  const alignedGroup = await insertedTitleGroup.boundingBox()
  await insertedVectorGroupLayer.click()
  const alignedTitle = await page.locator('[data-group-move-target="group-vector-explanation"]').boundingBox()
  expect(alignedGroup).not.toBeNull()
  expect(alignedTitle).not.toBeNull()
  expect(Math.abs((alignedGroup!.x + alignedGroup!.width) - (alignedTitle!.x + alignedTitle!.width))).toBeLessThan(2)
  markPhase('representative-return-to-construction')
  await constructionTab.click()
  await expect(editor).toHaveAttribute('data-active-shot-id', 'shot-cantor-construction')
  await playhead.fill('12.5')
  await page.getByRole('tab', { name: 'Text' }).click()

  const titleLayer = page.getByRole('treeitem', { name: /Uncountable, Yet Zero Length/ })
  const subtitleLayer = page.getByRole('treeitem', { name: /A quiet paradox/ })
  const marginLayer = page.getByRole('treeitem', { name: /Measure note/ })
  await titleLayer.click()
  await subtitleLayer.click({ modifiers: ['Shift'] })
  await marginLayer.click({ modifiers: ['Shift'] })
  before = await historyCount(page)
  await page.getByRole('button', { name: 'Align top' }).click()
  await page.getByRole('button', { name: 'Distribute horizontally' }).click()
  expect(await historyCount(page)).toBe(before + 2)
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByRole('button', { name: 'Undo' }).click()
  expect(await historyCount(page)).toBe(before)
  const dynamicAxe = await new AxeBuilder({ page }).setLegacyMode(true).analyze()
  const dynamicMaterialA11y = dynamicAxe.violations.filter(({ impact }) => impact === 'critical' || impact === 'serious')
  expect(dynamicMaterialA11y, JSON.stringify(dynamicMaterialA11y, null, 2)).toEqual([])

  await titleLayer.click()
  await subtitleLayer.click({ modifiers: ['Shift'] })
  before = await historyCount(page)
  await page.getByRole('button', { name: 'Group selection', exact: true }).click()
  expect(await historyCount(page)).toBe(before + 1)
  const groupedLayerIds = await page.locator('[data-layer-object-id]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-layer-object-id')))
  const groupedParentIndex = groupedLayerIds.indexOf('group-selection')
  expect(groupedParentIndex).toBeGreaterThanOrEqual(0)
  expect(groupedLayerIds.slice(groupedParentIndex + 1, groupedParentIndex + 3).sort()).toEqual(['object-subtitle', 'object-title'])
  const groupMoveTarget = page.locator('[data-group-move-target="group-selection"]')
  await expect(groupMoveTarget).toBeVisible()
  await dragBy(page, groupMoveTarget, 18, 10)
  expect(await historyCount(page)).toBe(before + 2)
  await page.getByRole('button', { name: 'Ungroup selection' }).click()
  expect(await historyCount(page)).toBe(before + 3)
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByRole('button', { name: 'Undo' }).click()
  expect(await historyCount(page)).toBe(before)

  await titleLayer.click()
  await page.getByRole('checkbox', { name: 'Locked' }).check()
  before = await historyCount(page)
  await dragBy(page, title, 24, 0)
  expect(await historyCount(page)).toBe(before)
  await expect(page.getByRole('status', { name: 'Editor status', exact: true })).toContainText('Locked objects')
  await page.getByRole('checkbox', { name: 'Locked' }).uncheck()
  await page.getByRole('button', { name: 'Bring to front' }).click()

  // Author position and opacity keys through the exact-value inspector, then
  // prove the outgoing segment uses a user-edited custom cubic curve. These
  // follow all base-pose direct-manipulation assertions because tracked
  // spatial values correctly make canvas handles read-only at animated times.
  await playhead.fill('12.5')
  await titleLayer.click()
  await page.getByRole('button', { name: 'Add X position keyframe at 12.5 seconds' }).click()
  await titleLayer.click()
  await page.getByRole('button', { name: 'Add Opacity keyframe at 12.5 seconds' }).click()
  await expect(page.getByRole('button', { name: 'x keyframe at 12.5 seconds' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'opacity keyframe at 12.5 seconds' })).toBeVisible()
  await playhead.fill('13.5')
  await titleLayer.click()
  const keyedXPosition = page.getByRole('spinbutton', { name: 'X position' })
  await keyedXPosition.fill('500')
  await keyedXPosition.blur()
  await titleLayer.click()
  const keyedOpacity = page.getByRole('spinbutton', { name: 'Opacity' })
  await keyedOpacity.fill('0.85')
  await keyedOpacity.blur()
  await expect(page.getByRole('button', { name: 'x keyframe at 13.5 seconds' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'opacity keyframe at 13.5 seconds' })).toBeVisible()
  // The retained sample already carries a nonterminal custom cubic on its
  // margin-note X track. Select and edit that canonical curve through the
  // integrated keyframe inspector.
  await page.getByRole('button', { name: 'x keyframe at 20.1 seconds', exact: true }).click()
  const cubicEditor = page.locator('.pc-cubic-editor')
  await expect(cubicEditor).toBeVisible()
  const cubicX1 = cubicEditor.locator('input[name="curve-x1"]')
  await expect(cubicX1).toHaveValue('0.22')
  await cubicX1.fill('0.24')
  await cubicX1.blur()
  await expect(cubicX1).toHaveValue('0.24')
  if (testInfo.project.name === 'proofcanvas-chromium-1920') {
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-timeline-keyframes-1920x1080.png'), fullPage: false })
  }
  await playhead.fill('12.5')

  await page.locator(`[data-layer-object-id="${insertedArrowId}"]`).click()
  const blocksBefore = await page.locator('[data-animation-id]').count()
  await page.getByRole('combobox', { name: 'Animation type' }).selectOption('appear')
  await page.getByRole('button', { name: 'Add animation' }).click()
  const newBlock = page.locator('[data-animation-type="appear"]').last()
  await expect(newBlock).toBeVisible()
  await expect(newBlock).toHaveAttribute('data-locked', 'false')
  expect(await page.locator('[data-animation-id]').count()).toBe(blocksBefore + 1)
  const oldStart = await newBlock.getAttribute('data-start')
  // Start in the block body, away from the dedicated right-edge resize grip.
  await dragBy(page, newBlock, 45, 0, 4)
  expect(await newBlock.getAttribute('data-start')).not.toBe(oldStart)
  const oldDuration = await newBlock.getAttribute('data-duration')
  await dragBy(page, page.locator('.pc-animation-block i').last(), 35, 0)
  expect(await newBlock.getAttribute('data-duration')).not.toBe(oldDuration)
  const cameraBlock = page.locator('[data-animation-id="animation-camera-focus"]')
  expect(await cameraBlock.getAttribute('data-timeline-lane')).not.toBe(await newBlock.getAttribute('data-timeline-lane'))
  await cameraBlock.click()
  const cameraZoom = page.getByRole('spinbutton', { name: 'Camera zoom' })
  await cameraZoom.fill('1.18')
  await cameraZoom.blur()
  await expect(page.getByRole('spinbutton', { name: 'Camera zoom' })).toHaveValue('1.18')
  await page.getByRole('combobox', { name: 'Easing' }).selectOption('ease-in-out')
  await expect(page.getByRole('combobox', { name: 'Easing' })).toHaveValue('ease-in-out')
  if (testInfo.project.name === 'proofcanvas-chromium-1920') {
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-animation-inspector-1920x1080.png'), fullPage: false })
  }
  await page.locator(`[data-layer-object-id="${insertedArrowId}"]`).click()
  await page.keyboard.press('Delete')
  await expect(page.locator(`[data-layer-object-id="${insertedArrowId}"]`)).toHaveCount(0)
  await playhead.fill('6.4')
  await expect(page.locator('[data-object-id="object-generation-note"]')).toHaveCount(0)
  await playhead.fill('6.8')
  await expect(page.locator('[data-object-id="object-generation-note"]')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '6.8')

  await page.getByRole('button', { name: 'Open command palette' }).click()
  await page.getByRole('option', { name: /AI structured edit/ }).click()
  for (let index = 1; index <= 5; index += 1) {
    await page.getByRole('button', { name: new RegExp(`^Run AI preset ${index}:`) }).click()
    const proposal = page.getByRole('region', { name: 'Proposed changes' })
    await expect(proposal).toBeVisible()
    if (index === 1) {
      await expect(page.getByRole('region', { name: 'AI command' })).toHaveAttribute('data-ai-provider', 'deterministic-demo')
      await expect(page.getByText('Deterministic demo interpreter — limited commands')).toBeVisible()
      if (testInfo.project.name === 'proofcanvas-chromium-1920') {
        await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-ai-proposal-review-1920x1080.png'), fullPage: false })
      }
    }
    await expect(proposal.getByRole('listitem').first()).toBeVisible()
    const transactionBefore = await historyCount(page)
    const visibleBefore = index === 1 ? await title.getAttribute('transform') : null
    await proposal.getByRole('button', { name: 'Apply proposed changes' }).click()
    expect(await historyCount(page)).toBe(transactionBefore + 1)
    const visibleApplied = index === 1 ? await title.getAttribute('transform') : null
    await page.getByRole('button', { name: 'Undo' }).click()
    expect(await historyCount(page)).toBe(transactionBefore)
    if (index === 1) {
      expect(await title.getAttribute('transform')).toBe(visibleBefore)
      await page.getByRole('button', { name: 'Redo' }).click()
      expect(await historyCount(page)).toBe(transactionBefore + 1)
      expect(await title.getAttribute('transform')).toBe(visibleApplied)
      await page.getByRole('button', { name: 'Undo' }).click()
      expect(await historyCount(page)).toBe(transactionBefore)
      expect(await title.getAttribute('transform')).toBe(visibleBefore)
    }
  }
  await page.getByRole('button', { name: 'Close AI command drawer' }).click()

  await titleLayer.click()
  const nameField = page.getByRole('textbox', { name: 'Name', exact: true })
  await nameField.fill('Persisted theorem title')
  await nameField.blur()
  const savedAnimationCount = await page.locator('[data-animation-id]').count()
  await page.getByRole('radio', { name: 'Raw Manim' }).check()
  await page.getByLabel('Owner menu').click()
  await page.getByRole('button', { name: 'Save project' }).click()
  await expect(page.getByRole('status', { name: 'Autosave status' })).toHaveAttribute('data-save-state', 'saved')
  const savedRevision = Number(await editor.getAttribute('data-server-revision'))
  expect(savedRevision).toBeGreaterThan(1)
  markPhase('representative-pre-reload-settle')
  await waitForEditorMediaToSettle(page)
  await page.reload()
  markPhase('representative-post-reload-first-shot')
  await expect(editor).toHaveAttribute('data-project-id', projectId!)
  await expect(editor).toHaveAttribute('data-durable', 'true')
  await expect(editor).toHaveAttribute('data-save-state', 'saved')
  await expect(page.getByRole('treeitem', { name: /Persisted theorem title/ })).toHaveAttribute('data-layer-object-id', 'object-title')
  await waitForEditorMediaToSettle(page)
  markPhase('representative-post-reload-semantic-shot')
  await page.getByRole('tab', { name: /^Shot \d+, Semantic component study,/ }).click()
  await expect(page.locator('[data-layer-object-id="group-focus-callout"]')).toBeVisible()
  await expect(page.locator('[data-layer-object-id="group-vector-explanation"]')).toBeVisible()
  await waitForEditorMediaToSettle(page)
  markPhase('representative-post-reload-construction')
  await constructionTab.click()
  await expect(page.getByRole('radio', { name: 'Raw Manim' })).toBeChecked()
  expect(await page.locator('[data-animation-id]').count()).toBe(savedAnimationCount)
  await page.getByRole('radio', { name: 'Editorial Ink' }).check()

  markPhase('representative-leave-construction-for-closing-shot')
  await waitForEditorMediaToSettle(page)
  await page.getByRole('button', { name: 'Add shot' }).click()
  await expect(editor).toHaveAttribute('data-active-shot-id', /shot-scene-\d+/)
  const shotName = page.getByRole('textbox', { name: 'Shot name' })
  await shotName.fill('Closing annotation')
  await shotName.blur()
  const shotDuration = page.getByRole('spinbutton', { name: 'Shot duration' })
  await shotDuration.fill('1.5')
  await shotDuration.blur()
  await page.getByRole('button', { name: 'Move shot later' }).click()
  await expect(page.getByRole('tab', { name: /^Shot \d+, Closing annotation,/ })).toBeVisible()
  markPhase('representative-closing-shot-return-to-construction')
  await page.getByRole('tab', { name: /^Shot \d+, The construction,/ }).click()
  await expect(editor).toHaveAttribute('data-active-shot-id', 'shot-cantor-construction')

  await page.getByRole('button', { name: 'Render or export' }).click()
  const jsonDownloadPromise = page.waitForEvent('download')
  const exportJsonButton = page.getByRole('button', { name: 'Export project JSON' })
  await exportJsonButton.click()
  const jsonDownload = await jsonDownloadPromise
  const jsonPath = await jsonDownload.path()
  expect(jsonPath).not.toBeNull()
  const exportedJson = await readFile(jsonPath!, 'utf8')
  const exportedProject = JSON.parse(exportedJson) as PortableProjectSnapshot
  expect(exportedProject.metadata.id).toBe(projectId)
  expect(exportedProject.activeStyleId).toBe('style-editorial-ink')
  expect(exportedProject.shots[0].objects.some((object: { type: string }) => object.type === 'group')).toBe(true)
  expect(exportedProject.shots[0].animations.length).toBeGreaterThan(0)
  const closeJsonPreview = page.getByRole('button', { name: 'Close export preview' })
  await expect(closeJsonPreview).toBeFocused()
  expect(await page.locator('.pc-header').evaluate((element: HTMLElement) => element.inert)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Project JSON' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Render or export' })).toBeFocused()

  await page.getByRole('button', { name: 'Render or export' }).click()
  const pythonDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export Manim Python' }).click()
  const pythonDownload = await pythonDownloadPromise
  const pythonPath = await pythonDownload.path()
  expect(pythonPath).not.toBeNull()
  expect(await readFile(pythonPath!, 'utf8')).toContain('class GeneratedScene(MovingCameraScene):')
  await page.getByRole('button', { name: 'Close export preview' }).click()

  await page.getByLabel('Owner menu').click()
  const importInput = page.getByLabel('Import project JSON')
  await importInput.focus()
  expect(await importInput.locator('..').evaluate((element) => element.matches(':focus-within'))).toBe(true)
  const reimportedTitle = 'Validated JSON re-import checkpoint'
  const reimportedProject = structuredClone(exportedProject)
  reimportedProject.metadata = { ...reimportedProject.metadata, title: reimportedTitle }
  markPhase('representative-pre-json-reimport-settle')
  await waitForEditorMediaToSettle(page)
  await importInput.setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(reimportedProject)) })
  markPhase('representative-post-json-reimport')
  await expect(page.getByRole('textbox', { name: 'Project title' })).toHaveValue(reimportedTitle)
  await expect(page.getByRole('status', { name: 'Editor status', exact: true })).toContainText('Imported project.json')
  await expect(editor).toHaveAttribute('data-project-id', projectId!)
  await waitForEditorMediaToSettle(page)
  await page.getByRole('tab', { name: /^Shot \d+, Semantic component study,/ }).click()
  await expect(page.locator('[data-layer-object-id="group-focus-callout"]')).toBeVisible()
  await constructionTab.click()
  expect(await page.locator('[data-animation-id]').count()).toBe(exportedProject.shots[0].animations.length)
  await page.getByLabel('Owner menu').click()
  await importInput.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":999}') })
  await expect(page.locator('.pc-message[role="alert"]')).toContainText(/schema version|unsupported|invalid|expected/i)
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(editor).toHaveAttribute('data-project-id', projectId!)

  await page.getByRole('button', { name: 'Open command palette' }).click()
  await page.getByRole('option', { name: /AI structured edit/ }).click()
  await page.getByRole('button', { name: 'Critique composition' }).click()
  await expect(page.locator('[data-issue-kind]').first()).toBeVisible()
  await page.getByRole('button', { name: 'Close AI command drawer' }).click()

  if (testInfo.project.name === 'proofcanvas-chromium-1440') {
    markPhase('journey-c-landscape-render')
    await constructionTab.click()
    await playhead.fill('12')
    await expect(editor).toHaveAttribute('data-active-shot-id', 'shot-cantor-construction')
    await expect(page.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '12')
    await page.getByRole('button', { name: 'Render or export' }).click()
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-render-dialog-1440x900.png'), fullPage: false })
    await page.getByRole('button', { name: 'Render MP4' }).click()
    const renderStatus = page.getByRole('region', { name: 'Render status' })
    await expect(renderStatus).toHaveAttribute('data-render-status', /^(pending|running)$/)
    await page.getByRole('button', { name: 'Cancel render' }).click()
    await expect(renderStatus).toHaveAttribute('data-render-status', 'cancelled', { timeout: 30_000 })
    await expect(renderStatus).toContainText('cancelled before publication')
    await page.getByRole('button', { name: /^Retry (?:preview|production) render$/ }).click()
    await expect(renderStatus).toHaveAttribute('data-render-status', 'succeeded', { timeout: 240_000 })
    const video = page.getByLabel('Rendered Manim preview')
    await expect(video).toBeVisible()
    const inspectedVideo = await video.evaluate((node: HTMLVideoElement) => ({
      controls: node.controls,
      preload: node.preload,
      source: node.getAttribute('src'),
      width: node.getBoundingClientRect().width,
    }))
    expect(inspectedVideo).toMatchObject({ controls: true, preload: 'metadata' })
    expect(inspectedVideo.source).toMatch(/^\/api\/proofcanvas\/render\/[A-Za-z0-9_-]{24}\/video$/)
    expect(inspectedVideo.width).toBeGreaterThan(0)

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Download MP4' }).click()
    const download = await downloadPromise
    const downloadDirectory = path.join(evidenceDir, 'ui-download')
    await mkdir(downloadDirectory, { recursive: true })
    const savedVideo = path.join(downloadDirectory, 'proofcanvas-render.mp4')
    await download.saveAs(savedVideo)
    const bytes = await readFile(savedVideo)
    expect(bytes.byteLength).toBeGreaterThan(32)
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp')

    const stillDownloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download still at playhead' }).click()
    const stillDownload = await stillDownloadPromise
    const savedStill = path.join(downloadDirectory, 'proofcanvas-still-current.png')
    await stillDownload.saveAs(savedStill)
    const stillBytes = await readFile(savedStill)
    expect(stillBytes.byteLength).toBeGreaterThan(32)
    expect([...stillBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

    // Journey D: export the current durable revision with every trusted asset,
    // import it as a fresh project, then compare every portable stable-ID
    // namespace and prove that imported asset bytes remain readable.
    await page.getByRole('button', { name: 'Render or export' }).click()
    await expect(page.getByRole('dialog', { name: 'Render and export' })).toBeVisible()
    const packageDownloadPromise = page.waitForEvent('download')
    const packageSourceProject = structuredClone(reimportedProject)
    await page.getByRole('button', { name: 'Export ProofCanvas package' }).click()
    const packageDownload = await packageDownloadPromise
    const savedPackage = path.join(downloadDirectory, 'proofcanvas-v1-roundtrip.proofcanvas')
    await packageDownload.saveAs(savedPackage)
    expect((await readFile(savedPackage)).byteLength).toBeGreaterThan(1024)
    await page.getByRole('button', { name: 'Close render and export' }).click()

    const sourceProjectId = await editor.getAttribute('data-project-id')
    const sourceProjectUrl = page.url()
    markPhase('journey-d-pre-package-navigation-settle')
    await waitForEditorMediaToSettle(page)
    await page.getByLabel('Owner menu').click()
    await page.getByLabel('Import ProofCanvas package').setInputFiles({
      name: 'proofcanvas-v1-roundtrip.proofcanvas',
      mimeType: 'application/vnd.proofcanvas.package+zip',
      buffer: await readFile(savedPackage),
    })
    await expect(page).not.toHaveURL(sourceProjectUrl, { timeout: 30_000 })
    markPhase('journey-d-imported-package-project')
    await expect(editor).toHaveAttribute('data-project-id', /^project-[a-f0-9]{24}$/)
    const importedProjectId = await editor.getAttribute('data-project-id')
    expect(importedProjectId).not.toBe(sourceProjectId)
    await expect(editor).toHaveAttribute('data-save-state', 'saved')
    await page.getByRole('tab', { name: 'Media' }).click()
    await expect(page.locator('.pc-media-library [data-available="false"]')).toHaveCount(0)
    const importedWaveforms = page.locator('.pc-audio-assets .pc-waveform')
    await expect(importedWaveforms.first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.pc-audio-assets .pc-waveform[data-waveform-state="ready"]')).toHaveCount(await importedWaveforms.count(), { timeout: 30_000 })

    await page.getByRole('button', { name: 'Render or export' }).click()
    const importedJsonDownloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export project JSON' }).click()
    const importedJsonDownload = await importedJsonDownloadPromise
    const importedJsonPath = await importedJsonDownload.path()
    expect(importedJsonPath).not.toBeNull()
    const importedProject = JSON.parse(await readFile(importedJsonPath!, 'utf8')) as PortableProjectSnapshot
    expect(portableStableIds(importedProject)).toEqual(portableStableIds(exportedProject))
    expect(withoutFreshProjectIdentity(importedProject)).toEqual(withoutFreshProjectIdentity(packageSourceProject))
    await page.getByRole('button', { name: 'Close export preview' }).click()

    // Journey E: a clean browser context authenticates independently and
    // reopens the imported project from server persistence.
    const importedUrl = page.url()
    markPhase('journey-e-fresh-context')
    const freshContext = await browser.newContext({ ignoreHTTPSErrors: true })
    const freshPage = await freshContext.newPage()
    freshPage.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`fresh-context: ${message.text()}`) })
    freshPage.on('pageerror', (error) => consoleErrors.push(`fresh-context: ${error.message}`))
    freshPage.on('requestfailed', (request) => {
      networkErrors.push(`fresh-context: ${request.method()} ${request.url()} failed: ${request.failure()?.errorText ?? 'unknown error'}`)
    })
    freshPage.on('response', (response) => {
      if (response.status() >= 500) networkErrors.push(`fresh-context: ${response.request().method()} ${response.url()} returned ${response.status()}`)
    })
    await freshPage.goto(new URL('/login', importedUrl).href)
    await freshPage.getByLabel('Owner password').fill(ownerPassword!)
    await freshPage.getByRole('button', { name: 'Log in' }).click()
    await expect(freshPage.getByRole('heading', { name: 'Your mathematical motion projects' })).toBeVisible()
    await freshPage.goto(importedUrl)
    const freshEditor = freshPage.getByRole('application', { name: 'ProofCanvas editor' })
    await expect(freshEditor).toHaveAttribute('data-project-id', importedProjectId!)
    await expect(freshEditor).toHaveAttribute('data-durable', 'true')
    await expect(freshPage.getByRole('treeitem', { name: /Persisted theorem title/ })).toHaveAttribute('data-layer-object-id', 'object-title')
    const freshAudio = freshPage.locator('audio[data-audio-clip-id]')
    await expect(freshAudio.first()).toBeAttached()
    await expect.poll(async () => freshAudio.evaluateAll((elements) => elements.every((element) => {
      const audio = element as HTMLAudioElement
      return audio.error === null
        && audio.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA
        && audio.networkState === HTMLMediaElement.NETWORK_IDLE
    }))).toBe(true)
    const freshWaveforms = freshPage.locator('.pc-media-timeline .pc-waveform')
    await expect(freshWaveforms.first()).toBeAttached()
    await expect(freshPage.locator('.pc-media-timeline .pc-waveform[data-waveform-state="ready"]')).toHaveCount(await freshWaveforms.count(), { timeout: 30_000 })
    await freshContext.close()

    // AC-15: exercise the exact deterministic capacity fixture in the real
    // browser editor. This complements (and does not relabel) the separate
    // headless timing benchmark with observable authoring-usability evidence.
    // A dedicated sample project supplies the fixture's exact one-asset
    // authority; JSON import is not allowed to mutate durable asset arrays.
    markPhase('journey-e-leave-imported-package-project')
    await waitForEditorMediaToSettle(page)
    await page.getByRole('link', { name: 'Back to projects' }).click()
    await expect(page.getByRole('heading', { name: 'Your mathematical motion projects' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Project title' }).fill('Browser stress authority')
    await page.getByRole('button', { name: 'New sample project' }).click()
    await expect(page).toHaveURL(/\/projects\/project-[a-f0-9]{24}$/)
    const stressProjectId = await editor.getAttribute('data-project-id')
    expect(stressProjectId).toMatch(/^project-[a-f0-9]{24}$/)
    await page.getByRole('tab', { name: 'Media' }).click()
    await expect(page.locator('.pc-audio-assets article')).toHaveCount(1)
    await expect(page.locator('.pc-audio-assets .pc-waveform[data-waveform-state="ready"]')).toHaveCount(1, { timeout: 30_000 })

    const stressStartedAt = performance.now()
    const stressProject = createProofCanvasStressProject()
    const canonicalStressBytes = Buffer.from(canonicalProjectJson(stressProject), 'utf8')
    const canonicalStressSha256 = createHash('sha256').update(canonicalStressBytes).digest('hex')
    stressProject.metadata = {
      ...stressProject.metadata,
      id: stressProjectId!,
    }
    markPhase('journey-e-pre-stress-json-import')
    await waitForEditorMediaToSettle(page)
    await page.getByLabel('Owner menu').click()
    await page.getByLabel('Import project JSON').setInputFiles({
      name: 'proofcanvas-v1-browser-stress.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(stressProject)),
    })
    await expect(page.getByRole('textbox', { name: 'Project title' })).toHaveValue('ProofCanvas V1 deterministic stress fixture')
    await expect(page.locator('.pc-storyboard-card')).toHaveCount(PROOFCANVAS_STRESS_INVENTORY.shots)
    await expect(editor).toHaveAttribute('data-active-shot-id', 'shot-stress-01')
    await expect(page.locator('[data-layer-object-id]')).toHaveCount(15)
    await expect(page.locator('[data-animation-id]')).toHaveCount(25)
    await expect(page.locator('[data-keyframe-id]')).toHaveCount(40)
    const stressImportDurationMs = Math.round(performance.now() - stressStartedAt)

    const stressInteractionStartedAt = performance.now()
    markPhase('journey-e-stress-shot-switch')
    await waitForEditorMediaToSettle(page)
    await playhead.fill('45.5')
    await expect(editor).toHaveAttribute('data-active-shot-id', 'shot-stress-06')
    await expect(page.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '0.5')
    const stressLayers = page.getByRole('tree', { name: 'Objects' }).getByRole('treeitem')
    await stressLayers.first().click()
    for (let index = 1; index < 10; index += 1) await stressLayers.nth(index).click({ modifiers: ['Shift'] })
    await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(10)
    await expect(page.locator('.pc-inspector-context')).toContainText('10 objects')
    const stressOpacity = page.getByRole('spinbutton', { name: 'Opacity' })
    await stressOpacity.fill('0.6')
    await stressOpacity.blur()
    await expect(stressOpacity).toHaveValue('0.6')
    await page.getByRole('button', { name: 'Play sequence' }).click()
    await expect(page.getByRole('button', { name: 'Pause sequence' })).toBeVisible()
    await expect.poll(async () => Number(await page.getByRole('region', { name: 'Scene canvas' }).getAttribute('data-preview-time'))).toBeGreaterThan(0.6)
    await page.getByRole('button', { name: 'Pause sequence' }).click()
    await expect(editor).toHaveAttribute('data-save-state', 'saved', { timeout: 30_000 })
    markPhase('journey-e-stress-pre-reload')
    await waitForEditorMediaToSettle(page)
    await page.reload()
    await expect(page.getByRole('textbox', { name: 'Project title' })).toHaveValue('ProofCanvas V1 deterministic stress fixture')
    await expect(page.locator('.pc-storyboard-card')).toHaveCount(PROOFCANVAS_STRESS_INVENTORY.shots)
    await expect(page.locator('[data-layer-object-id]')).toHaveCount(15)
    await playhead.fill('45.5')
    await expect(editor).toHaveAttribute('data-active-shot-id', 'shot-stress-06')
    const reloadedStressLayers = page.getByRole('tree', { name: 'Objects' }).getByRole('treeitem')
    await reloadedStressLayers.nth(9).click()
    await expect(page.getByRole('spinbutton', { name: 'Opacity' })).toHaveValue('0.6')
    const reloadedStressAudio = page.locator('audio[data-audio-clip-id]')
    await expect(reloadedStressAudio).toHaveCount(1)
    await expect.poll(async () => reloadedStressAudio.evaluateAll((elements) => elements.every((element) => {
      const audio = element as HTMLAudioElement
      return audio.error === null
        && audio.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA
        && audio.networkState === HTMLMediaElement.NETWORK_IDLE
    }))).toBe(true)

    await page.getByRole('button', { name: 'Render or export' }).click()
    const stressJsonDownloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export project JSON' }).click()
    const stressJsonDownload = await stressJsonDownloadPromise
    const stressJsonPath = await stressJsonDownload.path()
    expect(stressJsonPath).not.toBeNull()
    const browserStressProject = JSON.parse(await readFile(stressJsonPath!, 'utf8')) as PortableProjectSnapshot
    expect(browserStressProject.shots).toHaveLength(PROOFCANVAS_STRESS_INVENTORY.shots)
    expect(browserStressProject.shots.reduce((sum, candidate) => sum + candidate.objects.length, 0)).toBe(PROOFCANVAS_STRESS_INVENTORY.objects)
    expect(browserStressProject.shots.reduce((sum, candidate) => sum + candidate.animations.length, 0)).toBe(PROOFCANVAS_STRESS_INVENTORY.animations)
    expect(browserStressProject.shots.reduce((sum, candidate) => sum + candidate.propertyTracks.reduce((trackSum, track) => trackSum + track.keyframes.length, 0), 0)).toBe(PROOFCANVAS_STRESS_INVENTORY.keyframes)
    expect(browserStressProject.shots.reduce((sum, candidate) => sum + candidate.audioClips.reduce((clipSum, clip) => clipSum + Number(clip.duration), 0), 0)).toBe(PROOFCANVAS_STRESS_INVENTORY.audioSeconds)
    await page.getByRole('button', { name: 'Close export preview' }).click()
    const stressInteractionDurationMs = Math.round(performance.now() - stressInteractionStartedAt)
    await writeFile(path.join(evidenceDir, 'browser-stress-verification.json'), `${JSON.stringify({
      schemaVersion: 1,
      fixture: {
        ...PROOFCANVAS_STRESS_INVENTORY,
        canonicalBytes: canonicalStressBytes.byteLength,
        canonicalSha256: canonicalStressSha256,
      },
      importedThroughOwnerUi: true,
      activeObjects: 15,
      activeAnimations: 25,
      activeKeyframes: 40,
      aggregateVerified: true,
      audioMetadataReady: true,
      timelineScrubbed: true,
      selectedObjects: 10,
      primaryInspectorUpdated: true,
      primaryEditReloadPersisted: true,
      playbackAdvanced: true,
      autosaveSaved: true,
      reloadPersisted: true,
      importDurationMs: stressImportDurationMs,
      interactionDurationMs: stressInteractionDurationMs,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' })

    // Journey F: start another durable blank project, configure portrait
    // output, create and animate both objects through visible controls, import
    // an audio asset without adding a clip, then render the authored scene.
    markPhase('journey-f-leave-stress-project')
    await waitForEditorMediaToSettle(page)
    await page.getByRole('link', { name: 'Back to projects' }).click()
    await expect(page.getByRole('heading', { name: 'Your mathematical motion projects' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Project title' }).fill('Restart-persisted portrait proof')
    await page.getByRole('button', { name: 'New blank project' }).click()
    await expect(page).toHaveURL(/\/projects\/project-[a-f0-9]{24}$/)
    await expect(editor).toHaveAttribute('data-durable', 'true')
    await expect(page.locator('[data-layer-object-id]')).toHaveCount(0)

    await page.getByRole('button', { name: 'Project settings' }).click()
    await page.getByRole('combobox', { name: 'Aspect ratio' }).selectOption('9:16')
    await page.getByRole('combobox', { name: 'Frame rate' }).selectOption('24')
    await page.getByRole('combobox', { name: 'Render preset' }).selectOption('draft')
    await expect(page.getByRole('combobox', { name: 'Aspect ratio' })).toHaveValue('9:16')
    await expect(page.getByRole('combobox', { name: 'Frame rate' })).toHaveValue('24')
    await expect(page.getByRole('combobox', { name: 'Render preset' })).toHaveValue('draft')
    await page.getByRole('button', { name: 'Close project settings' }).click()

    await page.keyboard.press('Escape')
    await expect(page.locator('.pc-context-summary[aria-label="Shot inspector"]')).toBeVisible()
    const portraitShotName = page.getByRole('textbox', { name: 'Shot name' })
    await portraitShotName.fill('Portrait proof')
    await portraitShotName.blur()
    const portraitShotDuration = page.getByRole('spinbutton', { name: 'Shot duration' })
    await portraitShotDuration.fill('2.5')
    await portraitShotDuration.blur()
    await expect(page.getByRole('tab', { name: /^Shot 1, Portrait proof,/ })).toBeVisible()

    await page.getByRole('tab', { name: 'Text' }).click()
    await page.getByRole('button', { name: 'Add text' }).click()
    const portraitTitle = page.locator('[data-object-type="text"]').last()
    const portraitTitleId = await portraitTitle.getAttribute('data-object-id')
    expect(portraitTitleId).toMatch(/^object-/)
    const portraitTitleName = page.getByRole('textbox', { name: 'Name' })
    await portraitTitleName.fill('Portrait title')
    await portraitTitleName.blur()
    const portraitTitleContent = page.getByRole('textbox', { name: 'Content' })
    await portraitTitleContent.fill('A portrait proof, authored by hand')
    await portraitTitleContent.blur()
    await setSelectedPosition(page, 270, 360)
    const portraitWidth = page.getByRole('spinbutton', { name: 'Width', exact: true })
    await portraitWidth.fill('440')
    await portraitWidth.blur()
    await playhead.fill('0.2')
    await page.getByRole('combobox', { name: 'Animation type' }).selectOption('write')
    await page.getByRole('button', { name: 'Add animation' }).click()
    const portraitWrite = page.locator('[data-animation-type="write"]')
    await expect(portraitWrite).toHaveCount(1)
    await expect(portraitWrite).toHaveAttribute('data-target-ids', portraitTitleId!)
    await expect(portraitWrite).toHaveAttribute('data-start', '0.2')
    await expect(portraitWrite).toHaveAttribute('data-duration', '0.8')

    await page.getByRole('tab', { name: 'Shapes' }).click()
    await page.getByRole('button', { name: 'Insert Arrow' }).click()
    const portraitArrow = page.locator('[data-object-type="arrow"]').last()
    const portraitArrowId = await portraitArrow.getAttribute('data-object-id')
    expect(portraitArrowId).toMatch(/^object-/)
    const portraitArrowName = page.getByRole('textbox', { name: 'Name' })
    await portraitArrowName.fill('Portrait arrow')
    await portraitArrowName.blur()
    await setSelectedPosition(page, 270, 540)
    await playhead.fill('0.5')
    await page.getByRole('combobox', { name: 'Animation type' }).selectOption('fade-in')
    await page.getByRole('button', { name: 'Add animation' }).click()
    await expect(page.locator('[data-animation-id]')).toHaveCount(2)
    const portraitFade = page.locator('[data-animation-type="fade-in"]')
    await expect(portraitFade).toHaveAttribute('data-target-ids', portraitArrowId!)
    await expect(portraitFade).toHaveAttribute('data-start', '0.5')
    await expect(portraitFade).toHaveAttribute('data-duration', '0.8')
    await playhead.fill('0')
    await expect(page.locator(`[data-object-id="${portraitTitleId!}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-object-id="${portraitArrowId!}"]`)).toHaveCount(0)

    markPhase('journey-f-portrait-audio-import')
    await page.getByRole('tab', { name: 'Media' }).click()
    await page.getByLabel('Import project assets').setInputFiles(audioFixturePath)
    const portraitAudioAssets = page.locator('.pc-audio-assets article')
    await expect(portraitAudioAssets).toHaveCount(1, { timeout: 30_000 })
    await expect(portraitAudioAssets.first()).toHaveAttribute('data-available', 'true')
    await expect(portraitAudioAssets.first()).toContainText('proofcanvas-deterministic-pulse-90s.wav')
    await expect(portraitAudioAssets.first().locator('.pc-waveform[data-waveform-state="ready"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.pc-audio-clip')).toHaveCount(0)
    await expect(editor).toHaveAttribute('data-save-state', 'saved', { timeout: 30_000 })

    await playhead.fill('1.5')
    await expect(page.getByRole('region', { name: 'Scene canvas' })).toHaveAttribute('data-preview-time', '1.5')
    await expect(page.locator(`[data-object-id="${portraitTitleId!}"]`)).toBeVisible()
    await expect(page.locator(`[data-object-id="${portraitArrowId!}"]`)).toBeVisible()
    const portraitAxe = await new AxeBuilder({ page }).setLegacyMode(true).analyze()
    const materialPortraitA11y = portraitAxe.violations.filter(({ impact }) => impact === 'critical' || impact === 'serious')
    expect(materialPortraitA11y, JSON.stringify(materialPortraitA11y, null, 2)).toEqual([])
    const portraitStageBounds = await page.locator('.pc-stage').boundingBox()
    const portraitTitleBounds = await page.locator(`[data-object-id="${portraitTitleId!}"]`).boundingBox()
    const portraitArrowBounds = await page.locator(`[data-object-id="${portraitArrowId!}"]`).boundingBox()
    expect(portraitStageBounds).not.toBeNull()
    expect(portraitTitleBounds).not.toBeNull()
    expect(portraitArrowBounds).not.toBeNull()
    expect(portraitTitleBounds!.x).toBeGreaterThanOrEqual(portraitStageBounds!.x - 1)
    expect(portraitTitleBounds!.y).toBeGreaterThanOrEqual(portraitStageBounds!.y - 1)
    expect(portraitTitleBounds!.x + portraitTitleBounds!.width).toBeLessThanOrEqual(portraitStageBounds!.x + portraitStageBounds!.width + 1)
    expect(portraitTitleBounds!.y + portraitTitleBounds!.height).toBeLessThanOrEqual(portraitStageBounds!.y + portraitStageBounds!.height + 1)
    expect(portraitArrowBounds!.x).toBeGreaterThanOrEqual(portraitStageBounds!.x - 1)
    expect(portraitArrowBounds!.y).toBeGreaterThanOrEqual(portraitStageBounds!.y - 1)
    expect(portraitArrowBounds!.x + portraitArrowBounds!.width).toBeLessThanOrEqual(portraitStageBounds!.x + portraitStageBounds!.width + 1)
    expect(portraitArrowBounds!.y + portraitArrowBounds!.height).toBeLessThanOrEqual(portraitStageBounds!.y + portraitStageBounds!.height + 1)
    await page.screenshot({ path: path.join(evidenceDir, 'proofcanvas-portrait-output-1440x900.png'), fullPage: false })
    markPhase('journey-f-portrait-render')
    await page.getByRole('button', { name: 'Render or export' }).click()
    await expect(page.getByRole('dialog', { name: 'Render and export' })).toContainText('480×854')
    await expect(page.getByRole('dialog', { name: 'Render and export' })).toContainText('24 fps')
    await page.getByRole('button', { name: 'Render MP4' }).click()
    const portraitRenderStatus = page.getByRole('region', { name: 'Render status' })
    await expect(portraitRenderStatus).toHaveAttribute('data-render-status', 'succeeded', { timeout: 240_000 })
    await expect(portraitRenderStatus).toHaveAttribute('data-render-current', 'true')
    const portraitDownloadPromise = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Download MP4' }).click()
    const portraitDownload = await portraitDownloadPromise
    const portraitVideo = path.join(downloadDirectory, 'proofcanvas-portrait-480x854-24fps.mp4')
    await portraitDownload.saveAs(portraitVideo)
    const portraitBytes = await readFile(portraitVideo)
    expect(portraitBytes.byteLength).toBeGreaterThan(32)
    expect(portraitBytes.subarray(4, 8).toString('ascii')).toBe('ftyp')
    await expect(editor).toHaveAttribute('data-save-state', 'saved', { timeout: 30_000 })
  }

  markPhase('final-media-settle')
  await waitForEditorMediaToSettle(page)
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  expect(networkErrors, networkErrors.join('\n')).toEqual([])
})
