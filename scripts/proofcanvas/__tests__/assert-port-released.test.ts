import { spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'

const script = path.join(process.cwd(), 'scripts/proofcanvas/assert-port-released.py')

function run(port: number, timeout = '0.2') {
  return spawnSync('python3', [script, String(port)], {
    encoding: 'utf8',
    env: { ...process.env, PROOFCANVAS_PORT_RELEASE_TIMEOUT_SECONDS: timeout },
  })
}

test('accepts a port that can be rebound', async () => {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

  const result = run(address.port)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('task-owned ports released')
})

test('rejects a port that remains occupied', async () => {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')

  try {
    const result = run(address.port)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ports remain bound')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
