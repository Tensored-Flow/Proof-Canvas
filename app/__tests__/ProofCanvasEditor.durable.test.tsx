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
  expect(screen.getByText('Server project')).toBeInTheDocument()
  expect(screen.queryByText('Recovered browser copy')).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Browser recovery available' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Load saved project' })).not.toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Apply browser recovery' }))

  expect(screen.getByText('Recovered browser copy')).toBeInTheDocument()
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

  fireEvent.click(screen.getByRole('button', { name: 'Add math' }))
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

  fireEvent.click(screen.getByRole('button', { name: 'Add math' }))
  await advance(5_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)
});

test('binds configured AI and render requests to the durable project revision without sending a document', async () => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith('/ai')
    ? jsonResponse(503, { ok: false, code: 'provider_unavailable', message: 'Provider unavailable' })
    : jsonResponse(503, { ok: false, code: 'render_unavailable', message: 'Renderer unavailable' }))
  render(<ProofCanvasEditor
    aiConfigured
    initialProject={durableDocument()}
    durableProject={{ projectId: PROJECT_ID, revision: 9, csrfToken: CSRF_TOKEN }}
  />)

  fireEvent.click(screen.getByRole('button', { name: /^Run AI preset 1:/ }))
  await settle()
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

  fireEvent.click(screen.getByRole('button', { name: /^Run AI preset 1:/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Render MP4' }))
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/session')

  session.resolve(jsonResponse(200, { ok: true, csrfToken: CSRF_TOKEN }))
  await settle()
  expect(fetchMock).toHaveBeenCalledTimes(3)
  const durableCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/ai') || String(input).endsWith('/render'))
  expect(durableCalls).toHaveLength(2)
  for (const [, init] of durableCalls as Array<[string, RequestInit]>) {
    expect(init.headers).toMatchObject({ 'X-ProofCanvas-CSRF': CSRF_TOKEN })
  }
});
