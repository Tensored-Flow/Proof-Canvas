/** @jest-environment node */

import { renderToString } from 'react-dom/server'
import ProofCanvasEditor from '../ProofCanvasEditor'
import { createCantorDemoProject } from '@/lib/proofcanvas/demo'
import { cloneSerializable } from '@/lib/proofcanvas/schema'

test('server-renders the direct durable editor route without browser DOM globals', () => {
  expect(typeof Element).toBe('undefined')
  const project = cloneSerializable(createCantorDemoProject())
  const markup = renderToString(<ProofCanvasEditor
    initialProject={project}
    durableProject={{ projectId: project.metadata.id, revision: 7, csrfToken: null }}
  />)

  expect(markup).toContain('aria-label="ProofCanvas editor"')
  expect(markup).toContain('data-durable="true"')
  expect(markup).toContain('data-server-revision="7"')
  expect(markup).toContain('aria-label="Open command palette"')
})
