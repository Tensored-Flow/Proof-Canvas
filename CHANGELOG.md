# Changelog

All notable ProofCanvas changes are recorded here. This file describes the V1.0.0 release payload;
the repository's prepublication audit cannot self-record the later remote commit/tag receipts and
makes no hosted-production claim.

## 1.0.0 — 2026-08-30

### Added

- Private single-owner dashboard with no-sign-up login, strict sessions, CSRF/Origin protection,
  durable project CRUD, optimistic autosave, checkpoints/recovery, duplication, soft deletion,
  metadata thumbnails, online backup, and offline atomic restore.
- `ProjectDocument` V4 with deterministic registered migrations, integer-tick time, loss-aware legacy
  archival, object lifetimes, property tracks/keyframes, cameras, media, captions, markers, output
  profiles, custom easings, styles, and canonical JSON.
- Professional editor shell with searchable library, direct SVG canvas, contextual inspector, layers,
  ordered shots, resizable/collapsible layered timeline, project settings, dialogs, shortcuts, focus
  feedback, snapping/guides, grouping/layout, and sequence playback.
- Full manual authoring vocabulary for text, safe mathematical notation, axes, restricted function
  graphs, sixteen shape presets, nested groups, and twelve editable semantic components.
- Editorial Ink, Scientific Minimal, Nocturne Chalk, and Raw Manim style/preview workflows with
  project-local overrides and style import/export.
- Trusted project-local PNG, JPEG, WebP, sanitized SVG, WAV, and MP3 storage with content sniffing,
  structural/decode validation, metadata/hash authority, content-addressed deduplication, and
  authenticated project-scoped serving.
- Raster fit, crop, aspect, circle mask, and rounded-mask authoring/rendering. Advanced SVG crop,
  cover/fill, and masking remain explicit compiler errors.
- Canonical `.proofcanvas` package export/import with stable internal IDs, fresh imported project
  identity, exact STORE-only ZIP grammar, hashes/CRC, adversarial path/type/size checks, and atomic
  idempotent repository publication.
- Audio library, deterministic waveform, timeline placement/move/trim/split/delete, mute/solo,
  volume/fades/keyframes, bounded synchronized preview, and safe final MP4 muxing.
- Manual captions, split/delete/timing/text/basic styling, SRT/VTT import, cumulative project SRT
  export, and named/coloured timeline markers.
- Private renderer media/output protocol with exact referenced assets, source hash, authored
  resolution/fps, frame-aligned expected duration, numeric audio plan, queue status, cancellation,
  retry, retained verified metadata, MP4 download, and playhead-containing still PNG.
- Independent sidecar validation for generated-source AST, assets, filesystem paths, process/resource
  isolation, shell-free Manim/FFmpeg, H.264/AAC stream layout, decoded frames/audio samples, duration,
  hashes, and artifact bounds.
- Five-shot, 52-second **Uncountable, Yet Zero Length** release example with deterministic audio/captions,
  canonical JSON, package, generated Python, genuine render, decoded frame, AI evidence, and manifest.
- Deterministic 10-shot/150-object/250-clip/400-keyframe/90-second stress fixture and checked-in
  headless shared-core budget results.
- Production browser journeys for manual authoring, audio/captions, package round trip, fresh browser
  context, landscape/portrait render downloads, and controlled app-process restart.
- V1 documentation set: architecture, plan, audit ledger, changelog, deployment runbook, and safe
  environment template.

### Changed

- Promoted persistence from browser-local demonstration state to a checksummed STRICT SQLite
  repository. Browser storage is now only an explicit project-scoped recovery bridge.
- Bound render output to authored project aspect, resolution preset, frame rate, and compiler-derived
  exact frame duration instead of fixed preview/production dimensions.
- Extended the private render request from source-only transport to exact generated source, output,
  referenced media, and audio authority.
- Expanded the retained example from the earlier two-shot benchmark to a V1-scale editable A/V
  project while preserving the benchmark tag.
- Regeneration and browser/render workflows now refresh and verify retained evidence rather than
  leaving source-independent hashes.
- Deployment guidance now requires two private services, durable storage, exact HTTPS Origin,
  source-aware ingress throttling, container isolation, and explicit render restart loss.

### Security and correctness

- Shipped the exact slim-runtime dependency graph required for application-level backup and restore,
  and qualified an asset-bearing restore/rebackup through that final image.
- Made durable reset and JSON boundaries fail closed on stale or malformed state.
- Sanitized sessions and rate-limit state during restore so recovered installations require a fresh
  owner login.
- Bound package retry delivery to the authoritative SHA-256 and rejected changed retry payloads.
- Added strict asset lifecycle readiness barriers and precise failure attribution without suppressing
  genuine media-request errors during teardown.
- Added bounded binary request framing, global large-body admission, content-derived paths, filename
  sanitization, SVG allowlisting, full JPEG/WebP pixel decode, and media duration/dimension ceilings.
- Added canonical archive header/order/offset/type validation and rejection of compression, ZIP64,
  encryption, symlinks, traversal, collisions, gaps, overlaps, and unexpected entries.
- Added project-scoped asset references, exact content/metadata revalidation, aggregate installation
  limits, replay-conflict binding, and atomic blob/ref/document/receipt transactions.
- Added renderer bearer authentication, exact private envelopes, base64/hash/path binding, absence of
  unreferenced assets, no arbitrary remote fetches, and compiler-source-only execution.
- Added process-group cancellation/timeout escalation, sanitized HOME/TMP/XDG/proxy environment,
  resource limits, fixed-size private log tails, artifact confinement, complete media decode, and
  retryable cleanup bookkeeping.
- Added cumulative multi-shot caption export, aligned browser/renderer audio playback-rate bounds,
  exact decoded video-frame/audio-sample binding, and containing-frame still selection.

### Explicit limitations

- No production deployment or hosted HTTPS URL has been verified.
- Render jobs/results remain process-local, expire after ten minutes, and are lost on restart.
- M4A import is unsupported.
- Captions export as SRT and are not burned into MP4 by default.
- SVG advanced crop/cover/fill/mask rendering fails closed.
- Package build/import is bounded but in-memory rather than streaming.
- Live OpenAI behavior is unqualified without a real configured call.
- The product remains private single-owner software with no collaboration or horizontal SQLite scale.
- Automated evidence does not replace human mathematical, accessibility, usability, rights/privacy,
  or editorial review.
- No license file is included.

## 0.1.0 benchmark — 2026-08-23

- Published the standalone ProofCanvas autonomous-build benchmark as annotated tag
  `v0.1-autonomous-benchmark`.
- Established the structured canvas/editor, versioned project model, deterministic Manim export,
  bounded optional AI proposal path, initial renderer, example project, and baseline evidence.
- This historical benchmark is preserved and must not be rewritten or presented as the completed V1.
