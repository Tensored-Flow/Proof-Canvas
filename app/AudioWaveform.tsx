'use client'

import { useEffect, useId, useState } from 'react'
import { summarizeDecodedWaveform, type WaveformBucket } from '@/lib/proofcanvas/audio'

const CACHE_LIMIT = 32
const waveformCache = new Map<string, Promise<readonly WaveformBucket[]>>()
const audioByteFetches = new Map<string, Promise<ArrayBuffer>>()

function cachedAudioBytes(url: string): Promise<ArrayBuffer> {
  const current = audioByteFetches.get(url)
  if (current) return current
  const request = fetch(url, { cache: 'force-cache' }).then(async (response) => {
    if (!response.ok) throw new Error('Audio bytes could not be loaded')
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 * 1024) throw new Error('Audio waveform input is outside the 64 MiB browser preview limit')
    return bytes
  })
  const shared = request.finally(() => {
    // Retain only bounded waveform summaries. The potentially large source
    // bytes are shared by concurrently mounted library/timeline waveforms,
    // then released once every existing subscriber has received them.
    if (audioByteFetches.get(url) === shared) audioByteFetches.delete(url)
  })
  if (audioByteFetches.size >= CACHE_LIMIT) audioByteFetches.delete(audioByteFetches.keys().next().value ?? '')
  audioByteFetches.set(url, shared)
  return shared
}

async function decodeWaveform(url: string, buckets: number): Promise<readonly WaveformBucket[]> {
  const bytes = await cachedAudioBytes(url)
  const AudioContextConstructor = globalThis.AudioContext
  if (!AudioContextConstructor) throw new Error('Browser audio decoding is unavailable')
  const context = new AudioContextConstructor()
  try {
    const decoded = await context.decodeAudioData(bytes.slice(0))
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index))
    return summarizeDecodedWaveform(channels, buckets)
  } finally {
    await context.close().catch(() => undefined)
  }
}

function cachedWaveform(url: string, buckets: number): Promise<readonly WaveformBucket[]> {
  const key = `${url}\u0000${buckets}`
  const current = waveformCache.get(key)
  if (current) return current
  const next = decodeWaveform(url, buckets).catch((error) => {
    waveformCache.delete(key)
    throw error
  })
  if (waveformCache.size >= CACHE_LIMIT) waveformCache.delete(waveformCache.keys().next().value ?? '')
  waveformCache.set(key, next)
  return next
}

export interface AudioWaveformProps {
  projectId: string
  assetId: string
  label: string
  buckets?: number
}

/** Browser-decoded, bounded PCM summary used only as a visual editing aid. */
export default function AudioWaveform({ projectId, assetId, label, buckets = 48 }: AudioWaveformProps) {
  const [peaks, setPeaks] = useState<readonly WaveformBucket[] | null>(null)
  const [failed, setFailed] = useState(false)
  const titleId = `pc-waveform-${useId().replaceAll(':', '')}`
  const url = `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`
  useEffect(() => {
    let live = true
    setPeaks(null)
    setFailed(false)
    void cachedWaveform(url, buckets).then((value) => { if (live) setPeaks(value) }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [buckets, url])

  return <svg className="pc-waveform" role="img" aria-labelledby={titleId} viewBox={`0 0 ${buckets} 2`} preserveAspectRatio="none" data-waveform-state={failed ? 'unavailable' : peaks ? 'ready' : 'loading'}>
    <title id={titleId}>{failed ? `${label} waveform unavailable in this browser` : `${label} waveform`}</title>
    {peaks ? peaks.map((bucket, index) => <line key={index} x1={index + 0.5} x2={index + 0.5} y1={1 - bucket.maximum} y2={1 - bucket.minimum}/>) : <line className="pc-waveform-placeholder" x1="0" x2={buckets} y1="1" y2="1"/>}
  </svg>
}
