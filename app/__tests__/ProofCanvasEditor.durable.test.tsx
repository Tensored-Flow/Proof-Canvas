import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ProofCanvasEditor from '../ProofCanvasEditor'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { ProjectDocumentSchema, canonicalProjectJson, cloneSerializable, parseProjectDocument, type ProjectDocument } from '@/lib/proofcanvas/schema'

const PROJECT_ID = 'project-0123456789abcdef01234567'
const OTHER_PROJECT_ID = 'project-abcdef0123456789abcdef01'
const CSRF_TOKEN = 'C'.repeat(43)
let mutationSequence = 0
const fetchMock = jest.fn()

function durableDocument(title = 'Server project'): ProjectDocument {
  const document = cloneSerializable(createCantorDemoProject())
  document.metadata.id = PROJECT_ID
  document.metadata.title = title
  return ProjectDocumentSchema.parse(document)
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: jest.fn().mockResolvedValue(body) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function renderDurable(document = durableDocument(), revision = 1) {
  return render(<ProofCanvasEditor
    initialProject={document}
    durableProject={{ projectId: PROJECT_ID, revision, csrfToken: CSRF_TOKEN }}
  />)
}

function openAssistant() {
  fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
  fireEvent.click(screen.getByRole('option', { name: /AI structured edit/ }))
}

function runAiPreset(index = 1) {
  if (!screen.queryByRole('dialog', { name: 'AI command drawer' })) openAssistant()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Run AI preset ${index}:`) }))
}

function openRenderDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Render or export' }))
}

function openOwnerMenu() {
  if (screen.getByLabelText('Owner menu').getAttribute('aria-expanded') === 'true') return
  fireEvent.click(screen.getByLabelText('Owner menu'))
}

function projectJsonFile(document: ProjectDocument, name = 'project.json') {
  const contents = canonicalProjectJson(document)
  const file = new File([contents], name, { type: 'application/json' })
  Object.defineProperty(file, 'text', { configurable: true, value: jest.fn().mockResolvedValue(contents) })
  return file
}

function addMath() {
  fireEvent.click(screen.getByRole('tab', { name: 'Math' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add math' }))
}

function addText() {
  fireEvent.click(screen.getByRole('tab', { name: 'Text' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
}

async function advance(milliseconds: number) {
  await act(async () => {
    jest.advanceTimersByTime(milliseconds)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  window.localStorage.clear()
  document.cookie = `proofcanvas-csrf=${CSRF_TOKEN}; Path=/`
  mutationSequence = 0
  fetchMock.mockReset()
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock })
  Object.defineProperty(window.crypto, 'randomUUID', {
    configurable: true,
    value: jest.fn(() => `00000000-0000-4000-8000-${String(++mutationSequence).padStart(12, '0')}`),
  })
})

afterEach(() => {
  cleanup()
  document.cookie = 'proofcanvas-csrf=; Max-Age=0; Path=/'
  jest.clearAllTimers()
  jest.useRealTimers()
})

test('does not expose the local sample reset action in a durable owner workspace', () => {
  renderDurable()

  openOwnerMenu()

  expect(screen.queryByRole('button', { name: 'Reset sample project' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open project recovery' })).toBeInTheDocument()
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-history-past-count', '0')
  expect(fetchMock).not.toHaveBeenCalled()
})

test('refuses cross-project JSON before durable history or autosave can change', async () => {
  const imported = cloneSerializable(durableDocument('Cross-project import'))
  imported.metadata.id = OTHER_PROJECT_ID
  renderDurable(durableDocument('Server project'))

  fireEvent.change(screen.getByLabelText('Import project JSON'), {
    target: { files: [projectJsonFile(ProjectDocumentSchema.parse(imported), 'other-project.json')] },
  })
  await settle()
  await advance(1_000)

  expect(screen.getByRole('alert')).toHaveTextContent(/different project.*dashboard \.proofcanvas import/i)
  expect(screen.getByRole('textbox', { name: 'Project title' })).toHaveValue('Server project')
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-project-id', PROJECT_ID)
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-history-past-count', '0')
  expect(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)).toBeNull()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('refuses JSON that changes durable asset authority before history or autosave can change', async () => {
  const imported = cloneSerializable(durableDocument('Asset-changing import'))
  imported.assets = [{
    id: 'asset-import-refusal',
    filename: 'unbundled.png',
    mimeType: 'image/png',
    size: 128,
    sha256: 'a'.repeat(64),
    width: 320,
    height: 180,
    provenance: 'uploaded',
  }]
  renderDurable(durableDocument('Server project'))

  fireEvent.change(screen.getByLabelText('Import project JSON'), {
    target: { files: [projectJsonFile(ProjectDocumentSchema.parse(imported), 'changed-assets.json')] },
  })
  await settle()
  await advance(1_000)

  expect(screen.getByRole('alert')).toHaveTextContent(/cannot change durable asset authority.*dashboard \.proofcanvas import/i)
  expect(screen.getByRole('textbox', { name: 'Project title' })).toHaveValue('Server project')
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-history-past-count', '0')
  expect(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)).toBeNull()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('imports same-project JSON when durable asset authority is unchanged', async () => {
  const imported = durableDocument('Same durable project import')
  fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 2 } }))
  renderDurable(durableDocument('Server project'))

  fireEvent.change(screen.getByLabelText('Import project JSON'), {
    target: { files: [projectJsonFile(imported, 'same-project.json')] },
  })
  await settle()

  expect(screen.getByRole('textbox', { name: 'Project title' })).toHaveValue('Same durable project import')
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-project-id', PROJECT_ID)
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-history-past-count', '1')
  expect(fetchMock).not.toHaveBeenCalled()

  await advance(800)
  await settle()

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}`, expect.objectContaining({ method: 'PUT' }))
  const request = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
  expect(request.document.metadata).toMatchObject({ id: PROJECT_ID, title: 'Same durable project import' })
  expect(request.document.assets).toEqual([])
})

test('offers only a matching project-scoped browser recovery and never applies it automatically', async () => {
  const recovery = durableDocument('Recovered browser copy')
  const unrelated = cloneSerializable(recovery)
  unrelated.metadata.id = OTHER_PROJECT_ID
  window.localStorage.setItem(`proofcanvas_recovery_${OTHER_PROJECT_ID}`, canonicalProjectJson(unrelated))
  window.localStorage.setItem(`proofcanvas_recovery_${PROJECT_ID}`, canonicalProjectJson(recovery))
  window.localStorage.setItem('proofcanvas_project_v1', canonicalProjectJson(unrelated))

  renderDurable(durableDocument('Server project'))
  await settle()

  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-project-id', PROJECT_ID)
  expect(screen.getByRole('textbox', { name: 'Project title' })).toHaveValue('Server project')
  expect(screen.getByRole('textbox', { name: 'Project title' })).not.toHaveValue('Recovered browser copy')
  expect(screen.getByRole('region', { name: 'Browser recovery available' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Load saved project' })).not.toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(parseProjectDocument(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)!).metadata.title).toBe('Recovered browser copy')

  fireEvent.click(screen.getByRole('button', { name: 'Apply browser recovery' }))

  expect(screen.getByRole('textbox', { name: 'Project title' })).toHaveValue('Recovered browser copy')
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-history-past-count', '1')
  expect(screen.queryByRole('region', { name: 'Browser recovery available' })).not.toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()
});

test('serializes autosaves and advances each queued edit from the acknowledged revision', async () => {
  const first = deferred<ReturnType<typeof jsonResponse>>()
  const second = deferred<ReturnType<typeof jsonResponse>>()
  const retry = deferred<ReturnType<typeof jsonResponse>>()
  fetchMock
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
    .mockImplementationOnce(() => retry.promise)
  const initial = durableDocument()
  renderDurable(initial)

  fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
  expect(parseProjectDocument(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)!).shots[0].objects).toHaveLength(initial.shots[0].objects.length + 1)
  await advance(800)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const firstRequest = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
  expect(firstRequest).toMatchObject({ expectedRevision: 1, mutationId: expect.any(String) })

  addMath()
  await advance(800)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  first.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 2 } }))
  await settle()
  await advance(0)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const secondRequest = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
  expect(secondRequest.expectedRevision).toBe(2)
  expect(secondRequest.mutationId).not.toBe(firstRequest.mutationId)
  expect(secondRequest.document.shots[0].objects).toHaveLength(initial.shots[0].objects.length + 2)
  expect(parseProjectDocument(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)!).shots[0].objects)
    .toHaveLength(initial.shots[0].objects.length + 2)

  second.resolve(jsonResponse(503, { ok: false, code: 'repository_unavailable', message: 'Temporary failure' }))
  await settle()
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-save-state', 'offline')
  expect(parseProjectDocument(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)!).shots[0].objects)
    .toHaveLength(initial.shots[0].objects.length + 2)

  fireEvent.click(screen.getByRole('button', { name: 'Retry autosave' }))
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(3)
  const retryRequest = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)
  expect(retryRequest).toEqual(secondRequest)
  retry.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 3 } }))
  await settle()
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-server-revision', '3')
  expect(screen.getByRole('status', { name: 'Autosave status' })).toHaveTextContent('Saved · r3')
  expect(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)).toBeNull()
});

test('halts autosave after a revision conflict and preserves explicit recovery state', async () => {
  fetchMock.mockResolvedValue(jsonResponse(409, {
    ok: false,
    code: 'revision_conflict',
    message: 'Project changed',
    currentRevision: 2,
  }))
  renderDurable()

  fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
  await advance(800)
  await settle()

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-save-state', 'conflict')
  expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere')
  expect(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)).not.toBeNull()

  addMath()
  await advance(5_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const latestRecovery = parseProjectDocument(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)!)
  expect(latestRecovery.shots[0].objects.some(({ name }) => name === 'Mathematical text')).toBe(true)
  expect(latestRecovery.shots[0].objects.some(({ name }) => name === 'Plain text')).toBe(true)
});

test('blocks deterministic 4xx tuples, queues a newer document, and expires the block only after revision advance', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(400, { ok: false, code: 'invalid_project', message: 'Rejected document' }))
    .mockResolvedValueOnce(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 2 } }))
    .mockResolvedValueOnce(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 3 } }))
  renderDurable()

  addText()
  await advance(800)
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-save-state', 'blocked')
  expect(screen.getByRole('alert')).toHaveTextContent('will not retry automatically')
  expect(screen.queryByRole('button', { name: 'Retry autosave' })).not.toBeInTheDocument()
  expect(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)).not.toBeNull()

  addMath()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await advance(5_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
  await advance(800)
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-server-revision', '2')

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await advance(800)
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-server-revision', '3')
})

test.each([
  [401, 'unauthorized', /refresh owner authentication/i],
  [401, 'invalid_project', /refresh owner authentication/i],
  [403, 'invalid_csrf', /refresh owner authentication/i],
  [403, 'request_too_large', /refresh owner authentication/i],
  [404, 'project_not_found', /confirm whether this project was deleted/i],
  [404, 'invalid_project', /confirm whether this project was deleted/i],
] as const)('offers explicit reload recovery for durable PUT %i %s', async (status, code, guidance) => {
  fetchMock.mockResolvedValue(jsonResponse(status, { ok: false, code, message: `Rejected with ${code}` }))
  renderDurable()

  addText()
  await advance(800)
  await settle()

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-save-state', 'reconcile')
  expect(screen.getByRole('alert')).toHaveTextContent(guidance)
  expect(screen.getByRole('button', { name: 'Reload project' })).toBeInTheDocument()
  expect(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)).not.toBeNull()

  addMath()
  await advance(5_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('link', { name: 'Back to projects' }))
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(screen.getByText(/stayed on this project/i)).toBeInTheDocument()
})

test('keeps an unknown 4xx save recoverable with the same pending mutation', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(418, { ok: false, code: 'unknown_client_failure', message: 'Unrecognized rejection' }))
    .mockResolvedValueOnce(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 2 } }))
  renderDurable()

  addText()
  await advance(800)
  await settle()
  const firstRequest = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)

  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-save-state', 'offline')
  fireEvent.click(screen.getByRole('button', { name: 'Retry autosave' }))
  await settle()

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual(firstRequest)
  expect(screen.getByRole('status', { name: 'Autosave status' })).toHaveTextContent('Saved · r2')
})

test('queues the latest document when an older in-flight tuple is deterministically rejected', async () => {
  const rejected = deferred<ReturnType<typeof jsonResponse>>()
  fetchMock
    .mockImplementationOnce(() => rejected.promise)
    .mockResolvedValueOnce(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 2 } }))
  const initial = durableDocument()
  renderDurable(initial)

  addText()
  await advance(800)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  addMath()

  rejected.resolve(jsonResponse(400, { ok: false, code: 'invalid_project', message: 'Rejected older document' }))
  await settle()
  await advance(0)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const latest = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
  expect(latest).toMatchObject({ expectedRevision: 1 })
  expect(latest.document.shots[0].objects).toHaveLength(initial.shots[0].objects.length + 2)
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-server-revision', '2')
})

test('does not expire a rejected tuple on a non-advancing success receipt', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(400, { ok: false, code: 'invalid_project', message: 'Rejected document' }))
    .mockResolvedValueOnce(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 1 } }))
  renderDurable()

  addText()
  await advance(800)
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(1)

  addMath()
  await advance(800)
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-server-revision', '1')
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-save-state', 'offline')

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await advance(5_000)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-save-state', 'blocked')
})

test('keeps a rejected invalid browser recovery visible and stored until a commit succeeds', async () => {
  const recovery = cloneSerializable(durableDocument('Rejected browser recovery'))
  recovery.shots[0].objects.push({
    id: 'object-invalid-recovery-graph',
    type: 'graph',
    name: 'Invalid recovery graph',
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 240, height: 140, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {
      expression: { kind: 'divide', left: { kind: 'constant', value: 1 }, right: { kind: 'constant', value: 0 } },
      xMin: -2,
      xMax: 2,
    },
  })
  const stored = canonicalProjectJson(ProjectDocumentSchema.parse(recovery))
  window.localStorage.setItem(`proofcanvas_recovery_${PROJECT_ID}`, stored)
  renderDurable(durableDocument('Server project'))
  await settle()

  fireEvent.click(screen.getByRole('button', { name: 'Apply browser recovery' }))

  expect(screen.getByRole('region', { name: 'Browser recovery available' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Project title' })).toHaveValue('Server project')
  expect(screen.getByText(/browser recovery was not applied/i)).toBeInTheDocument()
  expect(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)).toBe(stored)
  expect(fetchMock).not.toHaveBeenCalled()
})

test('blocks durable undo from republishing repaired legacy-invalid graph authority', async () => {
  const legacy = cloneSerializable(durableDocument())
  legacy.shots[0].objects = [{
    id: 'object-durable-legacy-graph',
    type: 'graph',
    name: 'Durable legacy graph',
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 240, height: 140, rotation: 0, scaleX: 1, scaleY: 1 },
    style: {},
    properties: {
      expression: { kind: 'divide', left: { kind: 'constant', value: 1 }, right: { kind: 'constant', value: 0 } },
      xMin: -2,
      xMax: 2,
    },
  }]
  legacy.shots[0].animations = []
  legacy.shots[0].propertyTracks = []
  fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 2 } }))
  renderDurable(ProjectDocumentSchema.parse(legacy))

  fireEvent.click(screen.getByRole('treeitem', { name: /Durable legacy graph/ }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Graph expression' }), { target: { value: 'x' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply graph draft' }))
  await advance(800)
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('status', { name: 'Autosave status' })).toHaveTextContent('Saved · r2')

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-history-past-count', '1')
  expect(screen.getByRole('textbox', { name: 'Graph expression' })).toHaveValue('x')
  expect(screen.getByText(/undo blocked: authoring would introduce renderer-rejected graph_constant_division_by_zero/i)).toBeInTheDocument()
  await advance(5_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('binds configured AI and render requests to the durable project revision without sending a document', async () => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith('/ai')
    ? jsonResponse(503, { ok: false, code: 'provider_unavailable', message: 'Provider unavailable' })
    : jsonResponse(503, { ok: false, code: 'render_unavailable', message: 'Renderer unavailable' }))
  render(<ProofCanvasEditor
    aiConfigured
    initialProject={durableDocument()}
    durableProject={{ projectId: PROJECT_ID, revision: 9, csrfToken: CSRF_TOKEN }}
  />)

  runAiPreset()
  await settle()
  openRenderDialog()
  fireEvent.click(screen.getByRole('button', { name: 'Render MP4' }))
  await settle()

  expect(fetchMock).toHaveBeenCalledTimes(2)
  const [aiUrl, aiInit] = fetchMock.mock.calls[0] as [string, RequestInit]
  const [renderUrl, renderInit] = fetchMock.mock.calls[1] as [string, RequestInit]
  const aiBody = JSON.parse(aiInit.body as string)
  const renderBody = JSON.parse(renderInit.body as string)
  expect(aiUrl).toBe('/api/proofcanvas/ai')
  expect(aiBody).toMatchObject({ projectId: PROJECT_ID, revision: 9, shotId: expect.any(String) })
  expect(aiBody).not.toHaveProperty('project')
  expect(aiInit.headers).toMatchObject({ 'X-ProofCanvas-CSRF': CSRF_TOKEN })
  expect(renderUrl).toBe('/api/proofcanvas/render')
  expect(renderBody).toEqual({ projectId: PROJECT_ID, revision: 9, quality: 'preview' })
  expect(renderInit.headers).toMatchObject({ 'X-ProofCanvas-CSRF': CSRF_TOKEN })
});

test('singleflights missing-cookie recovery across concurrent durable AI and render requests', async () => {
  document.cookie = 'proofcanvas-csrf=; Max-Age=0; Path=/'
  const session = deferred<ReturnType<typeof jsonResponse>>()
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/auth/session')) return session.promise
    if (url.endsWith('/ai')) return Promise.resolve(jsonResponse(503, { ok: false, code: 'provider_unavailable', message: 'Provider unavailable' }))
    if (url.endsWith('/render')) return Promise.resolve(jsonResponse(503, { ok: false, code: 'render_unavailable', message: 'Renderer unavailable' }))
    throw new Error(`Unexpected request: ${url}`)
  })
  render(<ProofCanvasEditor
    aiConfigured
    initialProject={durableDocument()}
    durableProject={{ projectId: PROJECT_ID, revision: 9, csrfToken: null }}
  />)

  runAiPreset()
  openRenderDialog()
  fireEvent.click(screen.getByRole('button', { name: 'Render MP4' }))
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/session')

  document.cookie = `proofcanvas-csrf=${CSRF_TOKEN}; Path=/`
  session.resolve(jsonResponse(200, { ok: true, csrfToken: CSRF_TOKEN }))
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(3)
  const durableCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/ai') || String(input).endsWith('/render'))
  expect(durableCalls).toHaveLength(2)
  for (const [, init] of durableCalls as Array<[string, RequestInit]>) {
    expect(init.headers).toMatchObject({ 'X-ProofCanvas-CSRF': CSRF_TOKEN })
  }
});

test('drains edits that arrive during a save before checkpointing and queues later edits behind the checkpoint', async () => {
  const saveA = deferred<ReturnType<typeof jsonResponse>>()
  const saveB = deferred<ReturnType<typeof jsonResponse>>()
  const checkpoint = deferred<ReturnType<typeof jsonResponse>>()
  const saveC = deferred<ReturnType<typeof jsonResponse>>()
  const saveRequests: Array<{ expectedRevision: number; document: ProjectDocument }> = []
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'PUT') {
      saveRequests.push(JSON.parse(init?.body as string))
      return [saveA.promise, saveB.promise, saveC.promise][saveRequests.length - 1]
    }
    if (url.endsWith('/checkpoints') && method === 'POST') return checkpoint.promise
    if (url.endsWith('/checkpoints') && method === 'GET') return Promise.resolve(jsonResponse(200, { ok: true, checkpoints: [] }))
    throw new Error(`Unexpected request: ${method} ${url}`)
  })
  const initial = durableDocument()
  renderDurable(initial)

  addText()
  await advance(800)
  expect(saveRequests).toHaveLength(1)
  addMath()
  fireEvent.click(screen.getByLabelText('Owner menu'))
  fireEvent.click(screen.getByRole('button', { name: 'Create checkpoint' }))
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/checkpoints') && (init as RequestInit | undefined)?.method === 'POST')).toBe(false)

  saveA.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 2 } }))
  await settle()
  expect(saveRequests).toHaveLength(2)
  expect(saveRequests[1]).toMatchObject({ expectedRevision: 2 })
  expect(saveRequests[1].document.shots[0].objects).toHaveLength(initial.shots[0].objects.length + 2)

  saveB.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 3 } }))
  await settle()
  const checkpointCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/checkpoints') && (init as RequestInit | undefined)?.method === 'POST')
  expect(checkpointCall).toBeDefined()
  expect(JSON.parse((checkpointCall?.[1] as RequestInit).body as string)).toMatchObject({ expectedRevision: 3 })

  addText()
  await advance(800)
  expect(saveRequests).toHaveLength(2)

  checkpoint.resolve(jsonResponse(200, { ok: true, checkpoint: {
    projectId: PROJECT_ID,
    revision: 4,
    checkpointId: `checkpoint-${'a'.repeat(24)}`,
  } }))
  await settle()
  expect(saveRequests).toHaveLength(3)
  expect(saveRequests[2]).toMatchObject({ expectedRevision: 4 })
  expect(saveRequests[2].document.shots[0].objects).toHaveLength(initial.shots[0].objects.length + 3)
  saveC.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 5 } }))
  await settle()
});

test.each([
  ['negative revision', { projectId: PROJECT_ID, revision: -1, checkpointId: `checkpoint-${'a'.repeat(24)}` }],
  ['fractional revision', { projectId: PROJECT_ID, revision: 2.5, checkpointId: `checkpoint-${'a'.repeat(24)}` }],
  ['non-advancing revision', { projectId: PROJECT_ID, revision: 1, checkpointId: `checkpoint-${'a'.repeat(24)}` }],
  ['wrong project', { projectId: OTHER_PROJECT_ID, revision: 2, checkpointId: `checkpoint-${'a'.repeat(24)}` }],
  ['invalid checkpoint identity', { projectId: PROJECT_ID, revision: 2, checkpointId: 'checkpoint-not-authoritative' }],
])('forces reload reconciliation for a successful checkpoint with %s', async (_label, checkpointReceipt) => {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/checkpoints') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse(201, { ok: true, checkpoint: checkpointReceipt }))
    }
    throw new Error(`Unexpected request: ${String(input)}`)
  })
  renderDurable()

  fireEvent.click(screen.getByLabelText('Owner menu'))
  fireEvent.click(screen.getByRole('button', { name: 'Create checkpoint' }))
  await settle()

  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-save-state', 'conflict')
  expect(screen.getByText(/checkpoint returned an uncertain revision receipt/i)).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(1)

  addText()
  await advance(800)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)).not.toBeNull()
});

test.each([
  ['null payload', null],
  ['empty payload', {}],
  ['negative acknowledgement', { ok: false }],
])('forces reload reconciliation for a successful checkpoint with %s', async (_label, payload) => {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/checkpoints') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse(201, payload))
    }
    throw new Error(`Unexpected request: ${String(input)}`)
  })
  renderDurable()

  fireEvent.click(screen.getByLabelText('Owner menu'))
  fireEvent.click(screen.getByRole('button', { name: 'Create checkpoint' }))
  await settle()

  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-save-state', 'conflict')
  expect(screen.getByRole('button', { name: 'Reload durable project' })).toBeInTheDocument()
  addText()
  await advance(800)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)).not.toBeNull()
});

test('preserves an edit queued behind a checkpoint whose successful response has malformed JSON', async () => {
  const checkpoint = deferred<{ ok: boolean; status: number; json: jest.Mock }>()
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/checkpoints') && init?.method === 'POST') return checkpoint.promise
    throw new Error(`Unexpected request: ${String(input)}`)
  })
  const initial = durableDocument()
  renderDurable(initial)

  fireEvent.click(screen.getByLabelText('Owner menu'))
  fireEvent.click(screen.getByRole('button', { name: 'Create checkpoint' }))
  await settle()
  addText()
  await advance(800)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  checkpoint.resolve({
    ok: true,
    status: 201,
    json: jest.fn().mockRejectedValue(new SyntaxError('malformed response JSON')),
  })
  await settle()
  await advance(0)

  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-save-state', 'conflict')
  expect(screen.getByRole('button', { name: 'Reload durable project' })).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const recovered = parseProjectDocument(window.localStorage.getItem(`proofcanvas_recovery_${PROJECT_ID}`)!)
  expect(recovered.shots[0].objects).toHaveLength(initial.shots[0].objects.length + 1)
});

test('captures the post-drain canonical revision for render and marks it stale after a later edit', async () => {
  const saveA = deferred<ReturnType<typeof jsonResponse>>()
  const saveB = deferred<ReturnType<typeof jsonResponse>>()
  const renderResponse = deferred<ReturnType<typeof jsonResponse>>()
  const saveC = deferred<ReturnType<typeof jsonResponse>>()
  const putRequests: Array<{ expectedRevision: number; document: ProjectDocument }> = []
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'PUT') {
      putRequests.push(JSON.parse(init.body as string))
      return [saveA.promise, saveB.promise, saveC.promise][putRequests.length - 1]
    }
    if (url === '/api/proofcanvas/render') return renderResponse.promise
    throw new Error(`Unexpected request: ${url}`)
  })
  renderDurable()

  addText()
  await advance(800)
  addMath()
  openRenderDialog()
  fireEvent.click(screen.getByRole('button', { name: 'Render MP4' }))
  expect(putRequests).toHaveLength(1)

  saveA.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 2 } }))
  await settle()
  expect(putRequests).toHaveLength(2)
  saveB.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 3 } }))
  await settle()

  const renderCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/proofcanvas/render')
  expect(renderCall).toBeDefined()
  expect(JSON.parse((renderCall?.[1] as RequestInit).body as string)).toEqual({ projectId: PROJECT_ID, revision: 3, quality: 'preview' })

  addText()
  await advance(800)
  expect(putRequests).toHaveLength(2)
  renderResponse.resolve(jsonResponse(200, { ok: true, job: {
    id: 'render-job-0000000000000', status: 'pending', quality: 'preview', sourceSha256: 'a'.repeat(64), error: null, video: null,
  } }))
  await settle()
  expect(screen.getByRole('region', { name: 'Render status' })).toHaveAttribute('data-render-current', 'false')
  expect(putRequests).toHaveLength(3)
  expect(putRequests[2].expectedRevision).toBe(3)
  saveC.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 4 } }))
  await settle()
});

test('captures post-drain shot and selection provenance for a configured AI proposal that remains applicable', async () => {
  const saveA = deferred<ReturnType<typeof jsonResponse>>()
  const saveB = deferred<ReturnType<typeof jsonResponse>>()
  const aiResponse = deferred<ReturnType<typeof jsonResponse>>()
  const putRequests: Array<{ expectedRevision: number; document: ProjectDocument }> = []
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      putRequests.push(JSON.parse(init.body as string))
      return [saveA.promise, saveB.promise][putRequests.length - 1]
    }
    if (String(input) === '/api/proofcanvas/ai') return aiResponse.promise
    throw new Error(`Unexpected request: ${String(input)}`)
  })
  render(<ProofCanvasEditor aiConfigured initialProject={durableDocument()} durableProject={{ projectId: PROJECT_ID, revision: 1, csrfToken: CSRF_TOKEN }}/>)

  addText()
  await advance(800)
  addMath()
  runAiPreset()
  expect(putRequests).toHaveLength(1)

  saveA.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 2 } }))
  await settle()
  expect(putRequests).toHaveLength(2)
  saveB.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 3 } }))
  await settle()

  const aiCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/proofcanvas/ai')
  expect(aiCall).toBeDefined()
  const aiBody = JSON.parse((aiCall?.[1] as RequestInit).body as string)
  expect(aiBody).toMatchObject({ projectId: PROJECT_ID, revision: 3, shotId: 'shot-cantor-construction', selectedObjectIds: [expect.any(String)] })
  const selectedId = aiBody.selectedObjectIds[0]
  expect(putRequests[1].document.shots[0].objects.some(({ id, type }) => id === selectedId && type === 'math')).toBe(true)

  aiResponse.resolve(jsonResponse(200, { ok: true, intention: 'Rename selected math', summary: ['Rename selected math'], operations: [
    { type: 'update-object', objectId: selectedId, patch: { name: 'AI revised math' } },
  ] }))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Apply proposed changes' }))
  expect(screen.getByRole('treeitem', { name: /AI revised math/ })).toBeInTheDocument()
  expect(screen.queryByText(/project changed after this proposal/i)).not.toBeInTheDocument()
});

test('does not checkpoint when any save-drain pass fails offline', async () => {
  fetchMock.mockResolvedValue(jsonResponse(503, { ok: false, message: 'Offline' }))
  renderDurable()
  addText()
  fireEvent.click(screen.getByLabelText('Owner menu'))
  fireEvent.click(screen.getByRole('button', { name: 'Create checkpoint' }))
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT')
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/checkpoints'))).toBe(false)
});

test('durably saves an immediate logout before revoking the session', async () => {
  const save = deferred<ReturnType<typeof jsonResponse>>()
  const logout = deferred<ReturnType<typeof jsonResponse>>()
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') return save.promise
    if (String(input) === '/api/auth/logout') return logout.promise
    throw new Error(`Unexpected request: ${String(input)}`)
  })
  renderDurable()
  addText()
  fireEvent.click(screen.getByLabelText('Owner menu'))
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
  await settle()

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT')
  save.resolve(jsonResponse(200, { ok: true, project: { projectId: PROJECT_ID, revision: 2 } }))
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/logout')
  logout.resolve(jsonResponse(503, { ok: false, message: 'Stay signed in' }))
  await settle()
  expect(screen.getByText('Stay signed in')).toBeInTheDocument()
});

test('durably saves an immediate Back action and aborts navigation when saving fails', async () => {
  const save = deferred<ReturnType<typeof jsonResponse>>()
  fetchMock.mockImplementation(() => save.promise)
  renderDurable()
  addText()
  fireEvent.click(screen.getByRole('link', { name: 'Back to projects' }))
  await settle()

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT')
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('aria-busy', 'true')
  save.resolve(jsonResponse(503, { ok: false, message: 'Offline' }))
  await settle()
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('aria-busy', 'false')
  expect(screen.getByText(/stayed on this project/)).toBeInTheDocument()
});
