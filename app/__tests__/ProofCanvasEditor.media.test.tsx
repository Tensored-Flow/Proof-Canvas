import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ProofCanvasEditor from '../ProofCanvasEditor'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { ProjectDocumentSchema, cloneSerializable } from '@/lib/proofcanvas/schema'

jest.mock('../AudioWaveform', () => function TestWaveform({ label }: { label: string }) { return <span data-testid="waveform">{label}</span> })
jest.mock('../AudioPlayback', () => function TestPlayback() { return <div data-testid="audio-playback"/> })

const fetchMock = jest.fn()
const createObjectURL = jest.fn(() => 'blob:caption-export')
const CSRF_TOKEN = 'C'.repeat(43)
let anchorClick: jest.SpyInstance

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: jest.fn().mockResolvedValue(body) }
}

function packageFile(bytes: Uint8Array, name: string, lastModified = 1_777_777_777_000) {
  const immutableBytes = Uint8Array.from(bytes)
  const file = new File([immutableBytes], name, {
    type: 'application/vnd.proofcanvas.package+zip',
    lastModified,
  })
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: jest.fn(async () => Uint8Array.from(immutableBytes).buffer as ArrayBuffer),
  })
  return file
}

function projectWithAssets() {
  const project = cloneSerializable(createCantorDemoProject())
  project.assets = [
    { id: 'asset-ui-image', filename: 'diagram.png', mimeType: 'image/png', size: 128, sha256: 'a'.repeat(64), width: 320, height: 180, provenance: 'uploaded' },
    { id: 'asset-ui-audio', filename: 'narration.wav', mimeType: 'audio/wav', size: 256, sha256: 'b'.repeat(64), duration: 6, provenance: 'uploaded' },
  ]
  return ProjectDocumentSchema.parse(project)
}

function projectWithUnsafeSvgFraming() {
  const project = cloneSerializable(projectWithAssets())
  project.assets.push({ id: 'asset-ui-svg', filename: 'diagram.svg', mimeType: 'image/svg+xml', size: 192, sha256: 'c'.repeat(64), width: 400, height: 240, provenance: 'uploaded' })
  project.shots[0].objects.push({
    id: 'object-ui-svg',
    type: 'svg',
    name: 'Vector diagram',
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 400, height: 240, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { opacity: 1 },
    properties: {
      assetId: 'asset-ui-svg',
      fit: 'cover',
      preserveAspectRatio: false,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      mask: { kind: 'circle' },
    },
  })
  return ProjectDocumentSchema.parse(project)
}

beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() })
  anchorClick = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterAll(() => anchorClick.mockRestore())

beforeEach(() => {
  fetchMock.mockReset()
  createObjectURL.mockClear()
  anchorClick.mockClear()
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock })
  Object.defineProperty(window, 'confirm', { configurable: true, value: jest.fn(() => true) })
  Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: jest.fn(() => '00000000-0000-4000-8000-000000000001') })
  Object.defineProperty(window.crypto, 'subtle', {
    configurable: true,
    value: {
      digest: jest.fn(async (_algorithm: AlgorithmIdentifier, source: BufferSource) => {
        const bytes = source instanceof ArrayBuffer
          ? new Uint8Array(source)
          : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        const digest = new Uint8Array(32)
        bytes.forEach((value, index) => { digest[index % digest.length] = (digest[index % digest.length] + value + index * 17) & 0xff })
        return digest.buffer as ArrayBuffer
      }),
    },
  })
  document.cookie = `proofcanvas-csrf=${CSRF_TOKEN}; Path=/`
})

afterEach(() => { document.cookie = 'proofcanvas-csrf=; Max-Age=0; Path=/' })

test('authors imported audio, volume keys, captions, markers, and trusted image objects through the visible UI', async () => {
  const project = projectWithAssets()
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/assets') && (!init?.method || init.method === 'GET')) return response(200, {
      ok: true,
      assets: project.assets.map((asset) => ({ ...asset, available: true, contentUrl: `/api/projects/${project.metadata.id}/assets/${asset.id}` })),
    })
    if (init?.method === 'PUT') {
      const expectedRevision = JSON.parse(String(init.body)).expectedRevision
      return response(200, { ok: true, project: { projectId: project.metadata.id, revision: expectedRevision + 1, updatedAt: '2026-08-26T00:00:00.000Z' }, replayed: false })
    }
    return response(404, { ok: false, message: 'not found' })
  })

  const { container } = render(<ProofCanvasEditor initialProject={project} durableProject={{ projectId: project.metadata.id, revision: 7, csrfToken: CSRF_TOKEN }}/>)
  fireEvent.click(screen.getByRole('tab', { name: 'Media' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled())
  expect(screen.getAllByTestId('waveform')).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(screen.getByRole('button', { name: /narration audio clip/ })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Audio clip inspector' })).toBeInTheDocument()
  expect(screen.getByTestId('audio-playback')).toBeInTheDocument()

  const volume = screen.getByRole('spinbutton', { name: 'Volume' })
  fireEvent.change(volume, { target: { value: '0.65' } })
  fireEvent.blur(volume)
  fireEvent.click(screen.getByRole('button', { name: /Add Volume keyframe at 0 seconds/ }))
  expect(container.querySelector('[data-track-target="audio:audio-narration-wav"]')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'New caption' }))
  const captionText = screen.getByRole('textbox', { name: 'Caption text' })
  fireEvent.blur(captionText, { target: { value: 'A line of proof\nwith exact timing' } })
  expect(screen.getByRole('button', { name: /Caption from 0 to 3 seconds: A line of proof/ })).toBeInTheDocument()
  expect(container.querySelector('.pc-canvas-caption-cue')).toHaveTextContent('A line of proof with exact timing')

  fireEvent.click(screen.getByRole('button', { name: 'Add marker' }))
  expect(screen.getByRole('button', { name: /Narration cue 1 marker at 0 seconds/ })).toBeInTheDocument()

  const imageCard = container.querySelector<HTMLElement>('[data-asset-id="asset-ui-image"]')!
  fireEvent.click(within(imageCard).getByRole('button', { name: 'Add to canvas' }))
  expect(container.querySelector('[data-object-type="image"] image')).toHaveAttribute('href', `/api/projects/${project.metadata.id}/assets/asset-ui-image`)
  expect(screen.getByText('Validated project-scoped content; direct source editing is disabled.')).toBeInTheDocument()
})

test('hides unsupported SVG raster controls and repairs legacy advanced framing explicitly', () => {
  const project = projectWithUnsafeSvgFraming()
  const { container } = render(<ProofCanvasEditor initialProject={project}/>)

  fireEvent.click(screen.getByRole('treeitem', { name: /Vector diagram/ }))
  expect(screen.getByRole('status', { name: '' })).toHaveTextContent(/SVG remains vector and render-safe in Contain mode/)
  expect(screen.queryByLabelText('Asset fit')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Preserve asset aspect ratio')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Asset mask')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Enable source crop' })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Reset SVG to render-safe framing' }))
  expect(screen.queryByRole('button', { name: 'Reset SVG to render-safe framing' })).not.toBeInTheDocument()
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-history-past-count', '1')
  expect(container.querySelector('[aria-label="Editor status"]')).toHaveTextContent('Reset Vector diagram to render-safe SVG framing')
})

test('uploads raw validated bytes through the revision queue and binds returned metadata without making the asset undoable', async () => {
  const project = cloneSerializable(createCantorDemoProject())
  project.assets = []
  const parsed = ProjectDocumentSchema.parse(project)
  const uploaded = { id: 'asset-uploaded-png', filename: 'upload.png', mimeType: 'image/png', size: 12, sha256: 'c'.repeat(64), width: 1, height: 1, provenance: 'uploaded' as const }
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/auth/session') return response(200, { ok: true, csrfToken: CSRF_TOKEN })
    if (url.endsWith('/assets') && (!init?.method || init.method === 'GET')) return response(200, { ok: true, assets: [] })
    if (url.endsWith('/assets') && init?.method === 'POST') return response(201, { ok: true, asset: uploaded, project: { projectId: parsed.metadata.id, revision: 4, updatedAt: '2026-08-26T00:00:00.000Z' }, replayed: false })
    if (init?.method === 'PUT') {
      const expectedRevision = JSON.parse(String(init.body)).expectedRevision
      return response(200, { ok: true, project: { projectId: parsed.metadata.id, revision: expectedRevision + 1, updatedAt: '2026-08-26T00:00:01.000Z' }, replayed: false })
    }
    return response(404, { ok: false, message: 'not found' })
  })

  const { container } = render(<ProofCanvasEditor initialProject={parsed} durableProject={{ projectId: parsed.metadata.id, revision: 3, csrfToken: CSRF_TOKEN }}/>)
  fireEvent.click(screen.getByRole('tab', { name: 'Media' }))
  const input = screen.getByLabelText('Import project assets')
  const file = new File([new Uint8Array(12)], 'upload.png', { type: 'image/png' })
  fireEvent.change(input, { target: { files: [file] } })

  await waitFor(() => expect(container.querySelector('[data-asset-id="asset-uploaded-png"]')).toBeInTheDocument())
  const uploadCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/assets') && (init as RequestInit | undefined)?.method === 'POST')
  expect(uploadCall).toBeDefined()
  expect(uploadCall?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: file }))
  expect((uploadCall?.[1] as RequestInit).headers).toEqual(expect.objectContaining({
    'Content-Type': 'image/png',
    'X-ProofCanvas-Expected-Revision': '3',
    'X-ProofCanvas-Asset-Filename': 'upload.png',
  }))
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-server-revision', '4')
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-history-past-count', '0')

  fireEvent.click(within(container.querySelector<HTMLElement>('[data-asset-id="asset-uploaded-png"]')!).getByRole('button', { name: 'Add to canvas' }))
  expect(screen.getByRole('application', { name: 'ProofCanvas editor' })).toHaveAttribute('data-history-past-count', '1')
})

test('downloads a receipt-bound .proofcanvas package and submits package imports with owner protections', async () => {
  const project = createCantorDemoProject()
  const packageBytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4])
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/assets') && (!init?.method || init.method === 'GET')) return response(200, { ok: true, assets: [] })
    if (url.endsWith('/package') && (!init?.method || init.method === 'GET')) return {
      ok: true,
      status: 200,
      headers: new Headers({
        'Content-Type': 'application/vnd.proofcanvas.package+zip',
        'Content-Length': String(packageBytes.byteLength),
        'X-ProofCanvas-Package-Sha256': 'd'.repeat(64),
        'X-ProofCanvas-Source-Revision': '9',
      }),
      blob: jest.fn().mockResolvedValue(new Blob([packageBytes], { type: 'application/vnd.proofcanvas.package+zip' })),
    }
    if (url === '/api/projects/import' && init?.method === 'POST') return response(422, { ok: false, message: 'Package fixture was intentionally rejected.' })
    return response(404, { ok: false, message: 'not found' })
  })

  render(<ProofCanvasEditor initialProject={project} durableProject={{ projectId: project.metadata.id, revision: 9, csrfToken: CSRF_TOKEN }}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Render or export' }))
  fireEvent.click(screen.getByRole('button', { name: 'Export ProofCanvas package' }))
  await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1))
  expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ size: packageBytes.byteLength }))

  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.click(screen.getByLabelText('Owner menu'))
  const archive = packageFile(packageBytes, 'roundtrip.proofcanvas')
  fireEvent.change(screen.getByLabelText('Import ProofCanvas package'), { target: { files: [archive] } })
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/import', expect.objectContaining({ method: 'POST', body: expect.any(ArrayBuffer) })))
  const importCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/projects/import')!
  expect([...new Uint8Array((importCall[1] as RequestInit).body as ArrayBuffer)]).toEqual([...packageBytes])
  expect(archive.arrayBuffer).toHaveBeenCalledTimes(1)
  expect((importCall[1] as RequestInit).headers).toEqual(expect.objectContaining({
    'Content-Type': 'application/vnd.proofcanvas.package+zip',
    'X-ProofCanvas-CSRF': CSRF_TOKEN,
    'x-proofcanvas-mutation-id': 'package-00000000-0000-4000-8000-000000000001',
  }))
  await waitFor(() => expect(screen.getByText(/Package fixture was intentionally rejected\./)).toBeInTheDocument())
})

test('keys package import retries by archive bytes rather than colliding file metadata', async () => {
  const project = createCantorDemoProject()
  let uuidSequence = 0
  Object.defineProperty(window.crypto, 'randomUUID', {
    configurable: true,
    value: jest.fn(() => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`),
  })
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/assets') && (!init?.method || init.method === 'GET')) return response(200, { ok: true, assets: [] })
    if (url === '/api/projects/import' && init?.method === 'POST') return response(503, { ok: false, message: 'Uncertain package response.' })
    return response(404, { ok: false, message: 'not found' })
  })
  render(<ProofCanvasEditor initialProject={project} durableProject={{ projectId: project.metadata.id, revision: 9, csrfToken: CSRF_TOKEN }}/>)
  const firstBytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4])
  const secondBytes = new Uint8Array([80, 75, 3, 4, 4, 3, 2, 1])
  const first = packageFile(firstBytes, 'same.proofcanvas')
  const second = packageFile(secondBytes, 'same.proofcanvas')
  const firstRetry = packageFile(firstBytes, 'same.proofcanvas')
  const input = screen.getByLabelText('Import ProofCanvas package')

  fireEvent.change(input, { target: { files: [first] } })
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/projects/import')).toHaveLength(1))
  await waitFor(() => expect(input).toBeEnabled())

  fireEvent.change(input, { target: { files: [second] } })
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/projects/import')).toHaveLength(2))
  await waitFor(() => expect(input).toBeEnabled())

  fireEvent.change(input, { target: { files: [firstRetry] } })
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/projects/import')).toHaveLength(3))
  await waitFor(() => expect(input).toBeEnabled())

  const importCalls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/projects/import')
  const mutationIds = importCalls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>)['x-proofcanvas-mutation-id'])
  expect(mutationIds).toEqual([
    'package-00000000-0000-4000-8000-000000000001',
    'package-00000000-0000-4000-8000-000000000002',
    'package-00000000-0000-4000-8000-000000000001',
  ])
  expect([...new Uint8Array((importCalls[0][1] as RequestInit).body as ArrayBuffer)]).toEqual([...firstBytes])
  expect([...new Uint8Array((importCalls[1][1] as RequestInit).body as ArrayBuffer)]).toEqual([...secondBytes])
  expect(first.arrayBuffer).toHaveBeenCalledTimes(1)
  expect(second.arrayBuffer).toHaveBeenCalledTimes(1)
  expect(firstRetry.arrayBuffer).toHaveBeenCalledTimes(1)
})
