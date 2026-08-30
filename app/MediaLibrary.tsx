'use client'

import type { ChangeEvent, DragEvent } from 'react'
import type { AssetMetadata } from '@/lib/proofcanvas/schema'
import { PROOFCANVAS_AUDIO_ASSET_MIME } from './MediaTimeline'
import AudioWaveform from './AudioWaveform'

export type AvailableProjectAsset = AssetMetadata & Readonly<{ available: boolean }>

export interface MediaLibraryProps {
  projectId: string
  assets: readonly AvailableProjectAsset[]
  disabled?: boolean
  durable: boolean
  pending?: boolean
  onUpload(files: FileList): void
  onInsertVisual(assetId: string): void
  onAddAudio(assetId: string): void
  onDelete(assetId: string): void
  onImportCaptions(file: File): void
  onCreateCaption(): void
  onExportCaptions(): void
  onCreateMarker(): void
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

function startAudioDrag(event: DragEvent<HTMLElement>, asset: AvailableProjectAsset): void {
  if (!asset.available) {
    event.preventDefault()
    return
  }
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData(PROOFCANVAS_AUDIO_ASSET_MIME, asset.id)
}

/** Project-local media library. It never accepts arbitrary URLs or data URLs. */
export default function MediaLibrary({
  projectId,
  assets,
  disabled = false,
  durable,
  pending = false,
  onUpload,
  onInsertVisual,
  onAddAudio,
  onDelete,
  onImportCaptions,
  onCreateCaption,
  onExportCaptions,
  onCreateMarker,
}: MediaLibraryProps) {
  const images = assets.filter(({ mimeType }) => mimeType.startsWith('image/'))
  const audio = assets.filter(({ mimeType }) => mimeType.startsWith('audio/'))
  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.files?.length) onUpload(event.currentTarget.files)
    event.currentTarget.value = ''
  }
  const importCaptions = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    if (file) onImportCaptions(file)
    event.currentTarget.value = ''
  }

  return <div className="pc-media-library" data-project-id={projectId}>
    <section>
      <div className="pc-section-heading"><div><span>Project local</span><h3>Assets</h3></div><span>{assets.length}</span></div>
      <label className="pc-file-label pc-media-upload">{pending ? 'Importing…' : 'Import PNG, JPEG, WebP, SVG, WAV or MP3'}<input type="file" multiple accept=".png,.jpg,.jpeg,.webp,.svg,.wav,.mp3,image/png,image/jpeg,image/webp,image/svg+xml,audio/wav,audio/mpeg" aria-label="Import project assets" disabled={disabled || pending || !durable} onChange={upload}/></label>
      {!durable && <p className="pc-library-empty" role="status">Open a durable owner project to import binary assets.</p>}
      {images.length > 0 && <div className="pc-asset-grid">{images.map((asset) => <article key={asset.id} data-asset-id={asset.id} data-available={asset.available}>
        {asset.available ? <img src={`/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}`} alt=""/> : <div className="pc-asset-missing" aria-hidden="true">!</div>}
        <div><strong>{asset.filename}</strong><small>{asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}{formatBytes(asset.size)}</small>{!asset.available && <em>Content missing</em>}</div>
        <footer><button type="button" disabled={disabled || !asset.available} onClick={() => onInsertVisual(asset.id)}>Add to canvas</button><button type="button" className="pc-danger-action" disabled={disabled || pending} onClick={() => onDelete(asset.id)} aria-label={`Delete ${asset.filename}`}>Delete</button></footer>
      </article>)}</div>}
      {audio.length > 0 && <div className="pc-audio-assets">{audio.map((asset) => <article key={asset.id} data-asset-id={asset.id} data-available={asset.available} draggable={!disabled && asset.available} onDragStart={(event) => startAudioDrag(event, asset)}>
        <span className="pc-audio-asset-icon" aria-hidden="true">≋</span><div>{asset.available && <AudioWaveform projectId={projectId} assetId={asset.id} label={asset.filename} buckets={36}/>}<strong>{asset.filename}</strong><small>{asset.duration?.toFixed(2) ?? '—'}s · {formatBytes(asset.size)}</small>{!asset.available && <em>Content missing</em>}</div>
        <button type="button" disabled={disabled || !asset.available} onClick={() => onAddAudio(asset.id)}>Add</button><button type="button" className="pc-danger-action" disabled={disabled || pending} onClick={() => onDelete(asset.id)} aria-label={`Delete ${asset.filename}`}>Delete</button>
      </article>)}</div>}
      {assets.length === 0 && durable && <p className="pc-library-empty">No assets yet. Imported bytes are validated, hashed, deduplicated, and retained outside project JSON.</p>}
    </section>
    <section>
      <div className="pc-section-heading"><div><span>Timeline text</span><h3>Captions & markers</h3></div></div>
      <div className="pc-media-author-actions"><button type="button" disabled={disabled} onClick={onCreateCaption}>New caption</button><label className="pc-file-label">Import SRT / VTT<input type="file" accept=".srt,.vtt,application/x-subrip,text/vtt,text/plain" aria-label="Import captions" disabled={disabled} onChange={importCaptions}/></label><button type="button" disabled={disabled} onClick={onExportCaptions}>Export SRT</button><button type="button" disabled={disabled} onClick={onCreateMarker}>Add marker</button></div>
    </section>
  </div>
}
