import { render } from '@testing-library/react'
import CanvasStage, { CanvasThumbnail } from '../CanvasStage'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { ProjectDocumentSchema, cloneSerializable } from '@/lib/proofcanvas/schema'
import { NOCTURNE_CHALK_STYLE_ID, styleById } from '@/lib/proofcanvas/styles'

function mediaProject() {
  const project = cloneSerializable(createCantorDemoProject())
  project.metadata.id = 'project-0123456789abcdef01234567'
  project.assets = [{
    id: 'asset-canvas-media',
    filename: 'diagram.png',
    mimeType: 'image/png',
    size: 128,
    sha256: 'e'.repeat(64),
    width: 800,
    height: 600,
    provenance: 'uploaded',
  }]
  const shot = project.shots[0]
  shot.objects = [{
    id: 'object-canvas-media',
    type: 'image',
    name: 'Diagram',
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 400, height: 200, rotation: 12, scaleX: 1, scaleY: 1 },
    style: { opacity: 0.65 },
    properties: {
      assetId: 'asset-canvas-media',
      fit: 'cover',
      preserveAspectRatio: true,
      crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.8 },
      mask: { kind: 'rounded-rectangle', radius: 24 },
    },
  }]
  shot.animations = []
  shot.propertyTracks = []
  shot.captionClips = [{
    id: 'caption-canvas-media',
    start: 1,
    end: 3,
    text: 'A line\nand another',
    style: { color: '#ffffff', background: '#111111', fontSize: 36, position: 'top' },
  }]
  return ProjectDocumentSchema.parse(project)
}

function stage(project = mediaProject(), playhead = 2) {
  const shot = project.shots[0]
  return <CanvasStage
    project={project}
    shot={shot}
    playhead={playhead}
    previewStyle={styleById(project.styles, project.activeStyleId)!}
    projectRevision="media-revision"
    previewQuality="standard"
    selectedIds={[]}
    onSelect={jest.fn()}
    onCommitTransforms={jest.fn()}
    onCommitKeyboardTransform={jest.fn()}
    onNotice={jest.fn()}
  />
}

test('resolves an asset ID only through its project-scoped authenticated route and renders exact crop/fit/mask authority', () => {
  const view = render(stage())
  const group = view.container.querySelector('[data-asset-id="asset-canvas-media"]')!
  const nested = group.querySelector('svg')!
  const image = nested.querySelector('image')!
  expect(image.getAttribute('href')).toBe('/api/projects/project-0123456789abcdef01234567/assets/asset-canvas-media')
  expect(nested.getAttribute('viewBox')).toBe('200 60 400 480')
  expect(nested.getAttribute('preserveAspectRatio')).toBe('xMidYMid slice')
  expect(group.getAttribute('data-asset-fit')).toBe('cover')
  expect(group.getAttribute('data-asset-mask')).toBe('rounded-rectangle')
  expect(group.querySelector('clipPath rect')?.getAttribute('rx')).toBe('24')
  expect(group.getAttribute('opacity')).toBe('0.65')
  expect(group.getAttribute('transform')).toContain('rotate(12)')
});

test('renders active caption text and authored style/position only inside its half-open span', () => {
  const active = render(stage(mediaProject(), 1))
  const cue = active.getByText((_, element) => element?.getAttribute('data-caption-id') === 'caption-canvas-media')
  expect(cue).toHaveTextContent('A line and another')
  expect(cue).toHaveAttribute('data-caption-position', 'top')
  expect(cue).toHaveStyle({ color: '#ffffff', background: '#111111' })
  active.rerender(stage(mediaProject(), 3))
  expect(active.container.querySelector('[data-caption-id="caption-canvas-media"]')).toBeNull()
});

test('inherits caption treatment from the active global style when a cue has no overrides', () => {
  const project = mediaProject()
  project.activeStyleId = NOCTURNE_CHALK_STYLE_ID
  project.shots[0].captionClips[0].style = {}
  const view = render(stage(ProjectDocumentSchema.parse(project), 2))
  const cue = view.container.querySelector<HTMLElement>('[data-caption-id="caption-canvas-media"]')!
  expect(cue).toHaveAttribute('data-caption-position', 'bottom')
  expect(cue).toHaveStyle({ color: '#f0ead7', background: '#101b1b' })
  expect(cue.style.getPropertyValue('--pc-caption-width')).toBe('88%')
});

test('applies exact per-object typography overrides above the active style', () => {
  const project = mediaProject()
  project.shots[0].objects = [{
    id: 'object-canvas-typography',
    type: 'text',
    name: 'Typography specimen',
    locked: false,
    visible: true,
    transform: { x: 480, y: 270, width: 420, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fontFamily: 'Courier New, monospace', fontSize: 31, fontWeight: 700, textAlign: 'right', roughEmphasis: true },
    properties: { content: 'Exact typography' },
  }]
  const view = render(stage(ProjectDocumentSchema.parse(project), 0))
  const text = view.container.querySelector<HTMLElement>('[data-object-id="object-canvas-typography"] .pc-canvas-text')!
  expect(text).toHaveStyle({ fontFamily: 'Courier New, monospace', fontSize: '31px', fontWeight: '700', textAlign: 'right' })
  expect(text).toHaveAttribute('data-rough-emphasis', 'true')
});

test('keeps project-scoped assets in passive storyboard thumbnails', () => {
  const project = mediaProject()
  const view = render(<CanvasThumbnail
    aspectRatio={project.settings.aspectRatio}
    shot={project.shots[0]}
    previewStyle={styleById(project.styles, project.activeStyleId)!}
    projectId={project.metadata.id}
    assets={project.assets}
    visualRevision="media-thumbnail"
  />)
  expect(view.container.querySelector('image')?.getAttribute('href')).toBe('/api/projects/project-0123456789abcdef01234567/assets/asset-canvas-media')
});

test('retains the safe legacy local source fallback without inventing an asset route', () => {
  const project = mediaProject()
  const object = project.shots[0].objects[0]
  object.properties = { source: '/proofcanvas/assets/editorial-mark.svg' }
  const parsed = ProjectDocumentSchema.parse(project)
  const view = render(stage(parsed, 0))
  expect(view.container.querySelector('image')?.getAttribute('href')).toBe('/proofcanvas/assets/editorial-mark.svg')
});
