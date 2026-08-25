#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import process from 'node:process'

function port(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`${label} must be an unprivileged TCP port`)
  }
  return parsed
}

const listenPort = port(process.argv[2], 'HTTPS listen port')
const targetPort = port(process.argv[3], 'HTTP target port')
const certificatePath = process.env.PROOFCANVAS_HTTPS_CERT
const keyPath = process.env.PROOFCANVAS_HTTPS_KEY
if (!certificatePath || !keyPath) throw new Error('HTTPS proxy certificate paths are required')

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function forwardedHeaders(headers) {
  const connectionTokens = new Set(String(headers.connection ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))
  return Object.fromEntries(Object.entries(headers).filter(([name]) => (
    !hopByHopHeaders.has(name.toLowerCase()) && !connectionTokens.has(name.toLowerCase())
  )))
}

const activeUpstreams = new Set()
const activeSockets = new Set()

const server = https.createServer({
  cert: readFileSync(certificatePath),
  key: readFileSync(keyPath),
}, (request, response) => {
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    method: request.method,
    path: request.url,
    headers: {
      ...forwardedHeaders(request.headers),
      'x-forwarded-host': request.headers.host ?? `127.0.0.1:${listenPort}`,
      'x-forwarded-proto': 'https',
    },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, forwardedHeaders(upstreamResponse.headers))
    const abortDownstream = () => {
      if (!response.destroyed) response.destroy()
    }
    upstreamResponse.once('aborted', abortDownstream)
    upstreamResponse.once('error', abortDownstream)
    upstreamResponse.pipe(response)
  })
  activeUpstreams.add(upstream)
  upstream.once('close', () => activeUpstreams.delete(upstream))
  upstream.setTimeout(65_000, () => upstream.destroy(new Error('ProofCanvas acceptance upstream timed out')))
  upstream.on('error', () => {
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('ProofCanvas acceptance proxy could not reach the application.')
  })
  request.once('aborted', () => upstream.destroy())
  response.once('close', () => {
    if (!response.writableEnded) upstream.destroy()
  })
  request.pipe(upstream)
})

server.on('connection', (socket) => {
  activeSockets.add(socket)
  socket.once('close', () => activeSockets.delete(socket))
})

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})

let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  server.close(() => process.exit(0))
  for (const upstream of activeUpstreams) upstream.destroy()
  for (const socket of activeSockets) socket.destroy()
  setTimeout(() => process.exit(0), 1_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
server.listen(listenPort, '127.0.0.1')
