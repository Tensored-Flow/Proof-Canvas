# ProofCanvas architecture

## Core invariants

1. `ProjectDocument` is the sole editable creative authority.
2. Every imported, persisted, packaged, or provider-produced document crosses the shared strict Zod
   schema before publication.
3. Stable IDs, hierarchy, inherited locks, timing relations, asset references, and shot order survive
   unrelated edits and portable-package round trips.
4. Mutations are atomic typed `SceneOperation[]` transactions or validated whole-document commits.
5. Generated Manim Python is deterministic output. It is never accepted as editable input.
6. AI returns bounded data operations only; it cannot return code, bypass locks, or publish directly.
7. Browser code never receives the owner password hash, session secret, OpenAI credential, renderer
   bearer token, SQLite path, or renderer subprocess output.
8. Uploaded media is content-authoritative. Client MIME/name/size claims are hints that must agree
   with sniffed, parsed, decoded, and hashed bytes.
9. Rendering accepts only compiler-generated source plus exact trusted project assets and a numeric
   audio/output plan; it fails closed if policy, resource, or isolation checks cannot be established.
10. The product has one private owner, one SQLite writer process, one render process, one running
    render, and at most one pending render. Horizontal scale requires a different design.

## Runtime topology

```text
HTTPS browser
  |
  +-- owner login/session/CSRF
  |
  +-- Next.js application (one process)
        |
        +-- ProjectDocument V4 -> preview/history/editor
        +-- authenticated project, asset, package, AI, and render APIs
        +-- STRICT SQLite on a persistent local-locking volume
        |     +-- canonical documents/checkpoints/mutation receipts
        |     +-- content-addressed asset blobs + project-scoped references
        |     +-- hashed sessions and login-rate state
        |
        +-- compiler -> generated Python + source SHA-256
              +-- exact referenced asset bytes + numeric audio/output plan
                    |
                    +-- private bearer-authenticated render sidecar
                          +-- AST/media/policy validation
                          +-- isolated Manim process group
                          +-- shell-free FFmpeg mux and ffprobe/decode verification
                          +-- ephemeral MP4/still result
```

Only the web application is public. The sidecar has no public port and should have no outbound
network route. `PROOFCANVAS_APP_ORIGIN` names the exact public HTTPS origin used for Origin and Secure
cookie policy; proxy forwarding headers are not an authentication authority.

## Module map

| Area | Principal files | Responsibility |
|---|---|---|
| Editor shell | `app/ProofCanvasEditor.tsx`, `CanvasStage.tsx`, `ShotStoryboard.tsx`, `ShotTimeline.tsx`, `MediaTimeline.tsx` | Canvas, library, inspector, history, shots, layered timeline, playback, captions, audio, exports, render UI |
| Media UI | `app/MediaLibrary.tsx`, `AudioPlayback.tsx`, `AudioWaveform.tsx` | Project-scoped upload, waveform, synchronized playback, audio placement |
| Dashboard/auth pages | `app/page.tsx`, `app/login/`, `app/projects/[projectId]/` | Protected entry, durable editor loading, owner session flow |
| API boundary | `app/api/auth/**`, `app/api/projects/**`, `app/api/proofcanvas/**` | Authentication, CSRF/Origin, framing, schema/CAS admission, render proxy |
| Document model | `lib/proofcanvas/schema.ts`, `frame.ts`, `ids.ts` | V4 schema, deterministic migration, canonical JSON, time/output authority |
| Operations/history | `operations.ts`, `documentOperations.ts`, `objectReferences.ts`, `history.ts` | Atomic changes, stable-reference repair, locks, duplication, undo/redo |
| Preview/styles/components | `preview.ts`, `styles.ts`, `shapePresets.ts`, `components.ts` | Deterministic browser state, style inheritance, exact authoring assemblies |
| Assets/packages | `assetContent.server.ts`, `projectPackage.ts`, `projectPackage.server.ts` | Sniff/decode/hash/sanitize media and canonical bounded package parsing/building |
| Persistence | `database.server.ts`, `repository.server.ts`, `backup.server.ts` | Checksummed migrations, CAS/idempotency, blobs/references, checkpoints, backup/restore |
| Audio/captions | `audio.ts`, `captions.ts` | Waveform and metadata helpers, SRT/VTT parsing, project-sequence SRT export |
| AI | `ai.ts`, `openaiProvider.ts` | Deterministic fallback, strict Responses output, proposal validation |
| Compiler/render client | `compiler.ts`, `renderClient.server.ts` | Deterministic Python, referenced-media plan, private sidecar protocol, bounded streaming |
| Render sidecar | `services/proofcanvas-render/` | Independent source/media policy, queue/cancel, subprocess isolation, mux/verification/stills |
| Evidence | `scripts/proofcanvas/`, `tests/browser/proofcanvas/`, `examples/proofcanvas/` | Reproducible fixtures, browser/restart journeys, genuine render, hashes, stress results |

## Document, time, and output authority

Schema version 4 covers metadata; aspect/resolution/frame-rate/render settings; ordered shots; scene
objects and nested groups; object lifetimes; semantic animations; property/keyframe tracks; cameras;
styles; custom easings; assets; audio clips; captions; and markers. Validation is project-global: it
rejects duplicate or dangling IDs, hierarchy cycles, invalid lock/reference transitions, unsupported
timing overlaps, unsafe TeX/SVG/graph input, non-finite values, excessive fan-out, and compiler work
above fixed budgets.

Published V1 and V2 documents migrate deterministically through registered versions. The loss-aware
V2-to-V3 migration quantizes persisted/compiler time to one 10 ns tick only when positive spans,
equality classes, ordering, containment, overlap/touching, event chronology, and compiler admission
remain lossless. Loss-prone legacy bytes are archived byte-for-byte and quarantined rather than
silently changed. V3-to-V4 adds native geometry and canonicalizes repeated animation target IDs whose
duplicates never represented distinct preview semantics.

Canonical JSON recursively sorts object keys while preserving meaningful array order. Persistence,
JSON export, package hashing, compilation, and evidence generation therefore share one serialization
authority. Canonical project JSON is capped at 2 MiB.

Project settings bind output rather than merely labelling it. Supported aspects are 16:9, 9:16, and
1:1; presets derive an allowed width/height pair for that aspect; and frame rate is one of 15, 24,
30, or 60 fps. The render client includes exact width, height, fps, and a compiler-derived
frame-aligned expected duration. The sidecar uses those values for Manim and rejects a successful
artifact whose decoded frame count, duration, or stream metadata does not match.

## Mutation, autosave, and recovery

`applyOperations` clones the current project, resolves declared IDs, enforces direct and inherited
locks, applies every operation, repairs dependent references where the operation contract permits,
and validates the complete candidate. Any exception publishes nothing. One successful edit or AI
proposal produces one history transaction.

Durable writes carry the expected positive project revision and a 16–128 character mutation ID. A
SQLite `IMMEDIATE` transaction checks the revision, records the canonical document and counters,
increments the revision, and stores a response receipt. Reusing the mutation ID with the same action
and request hash returns the original receipt; changing any bound request field returns an
idempotency conflict. SQL compare-and-swap protects against another connection changing the revision
between read and write.

The editor serializes autosaves and stops on a revision conflict instead of overwriting the server.
A project-scoped browser snapshot exists only as an explicit recovery bridge. The user must choose to
load it; it never wins silently over the durable repository.

Checkpoints store canonical documents with the same project metadata authority. Restore creates a
pre-restore checkpoint and publishes the selected checkpoint in one transaction. Soft deletion hides
the project while retaining the rows required for mutation replay, checkpoint/recovery, and integrity.

## Authentication and HTTP trust boundary

The installation has no signup or account enumeration. The configured owner password is stored as a
scrypt hash. Login verification has a two-job non-queueing admission cap and a global ten-failure,
15-minute window. Because the app does not trust client-controlled forwarding headers, source-aware
rate limiting belongs at a trusted same-host ingress.

Sessions contain random token and CSRF material, are HMAC-signed, stored only as hashes in SQLite,
expire within 12 hours, and are revoked at logout. The session cookie is `HttpOnly`,
`SameSite=Strict`, path `/`, and Secure in production; the CSRF cookie is readable only so the browser
can echo it in the required header. Every protected route authenticates independently. Mutating
routes additionally require the exact configured Origin and session-bound double-submit token.

JSON readers enforce media type and a streaming byte limit. Binary upload/package readers reject
content encoding, ranges, and transfer-framing, require one canonical `Content-Length`, preallocate
only within the applicable limit, and require actual bytes to equal the declared length. Route errors
are no-store and do not expose internal storage or renderer details.

## Trusted assets and lifecycle

The content validator derives authority from bytes:

- PNG structure, chunks, CRC, dimensions, compression geometry, and decoded-size bounds are checked.
- JPEG marker/table/frame/scan structure is bounded, then Sharp performs a full warning-fatal pixel
  decode in a resource-limited worker.
- WebP RIFF/chunk/order/feature/dimension structure is bounded, then Sharp performs the same full pixel
  decode.
- SVG is parsed as a small local vector grammar. Scripts, styles, links, external resources, foreign
  objects, events, unsafe URLs, and unbounded structure are rejected.
- WAV and MP3 framing, stream metadata, duration, ancillary data, and frame counts are bounded.
- M4A metadata exists in the compatibility schema/package vocabulary, but new `audio/mp4` content is
  rejected until the entire preview/renderer path is reliable.

The validator sanitizes the filename and derives its extension, computes SHA-256, and returns a copy
of the exact validated bytes. The repository stores one `asset_blobs` row per hash and one
project-scoped `(project, asset ID, expected hash)` reference. Active project metadata must exactly
match its bound blob. Two projects or IDs may share the same blob without weakening project scope.

Deleting an unused asset removes it from the active document but retains its reference/content
authority for idempotent replay and historical checkpoints. This is intentional, bounded retention;
there is no automatic garbage-collection or retention UI in V1.

| Asset/storage limit | Bound |
|---|---:|
| Active assets in one document | 256 |
| Retained references per project | 1,024 |
| One raster image | 32 MiB |
| One SVG | 2 MiB |
| One audio item / absolute item maximum | 64 MiB |
| Decoded raster pixels | 64 million / 256 MiB RGBA |
| Distinct retained blob bytes per project | 128 MiB |
| Installation blobs | 4,096 |
| Installation blob bytes | 4 GiB |

Repository reads revalidate blob bytes before serving, exporting, or rendering them. Startup
readiness performs exact structural checks on each probe and one complete row/content pass per opened
application connection. Backups and restores always perform the uncached full pass.

## Portable `.proofcanvas` package

The package is a deliberately narrow, canonical ZIP dialect built and parsed in memory:

```text
mimetype
manifest.json
project.json
assets/<lowercase-sha256>.<derived-extension> ... sorted by path
```

Only STORE entries with canonical local/central headers, regular `0600` file attributes, zero extras
and comments, exact contiguous offsets, CRC-32, printable ASCII safe paths, and a final 22-byte EOCD
are accepted. Compression, data descriptors, encryption, ZIP64, multidisk archives, symlinks,
duplicate/case-colliding names, traversal, gaps, overlaps, prefixes, and trailing bytes are rejected.
Nothing is extracted to disk.

The manifest and project JSON must be canonical byte-for-byte. Project length/hash, asset ID/path/hash,
content metadata, and the exact entry set/order are re-derived. Shared hashes use one archive entry.
All parsing and content validation completes before the import writer transaction. Import gives the
top-level project fresh metadata ID/timestamps, keeps all internal IDs, inserts/verifies blobs and
references, and records the replay receipt atomically.

Limits are 132 MiB archive, 256 KiB manifest, 2 MiB project JSON, 64 MiB per asset entry, 128 MiB
aggregate package asset bytes, 512 MiB aggregate decoded-raster admission, and at most 259 entries.
The repository's 128 MiB per-project distinct-blob limit also applies. At peak, the input archive,
validated copies, database binding, and one decoder may coexist; the format is bounded but not
streaming. Deployment memory must reflect this and operators should prefer materially smaller
packages.

## Browser preview and media semantics

`previewShotAtTime` produces deterministic object and camera state at a local shot time. The sequence
player maps global time into ordered shots and uses the same timeline tick authority. Canvas camera
composition applies centre translation, zoom, negative authored rotation, and negative camera pan;
the compiler maps that to Manim's centred Y-up frame with one Y sign conversion.

Audio playback derives the audible set from mute/solo, creates project-scoped authenticated asset
URLs, applies source trim and a bounded 1/16x–16x playback rate, and follows playhead/play/pause/seek.
Waveforms are deterministic summaries, not decoded PCM stored in the project. Audio clips, volume
keyframes, captions, and markers remain structured timeline data.

The browser and Manim do not share a rasterizer or typography engine. SVG DOM/KaTeX preview is an
authoring approximation; source-level and selected decoded-frame parity tests qualify only their
specified fixtures and tolerances. Native-shape evidence first compares the exact five-object base
fixture in Chromium and Manim, then continues into a distinct ten-object manual-authoring journey;
the latter qualifies controls, refusal states, persistence, and layout, not post-edit render parity.

## Compiler and renderer trust boundary

The public render request contains `{ projectId, revision, quality, shotId? }`. The Next.js route:

1. authenticates and checks Origin/CSRF;
2. loads the active canonical revision and exact referenced asset bytes from the repository;
3. selects the requested shot or complete sequence;
4. validates render duration, media count/bytes, audio playback/keyframe dialect, and output profile;
5. compiles deterministic Manim Python and rejects error diagnostics;
6. hashes the UTF-8 source; and
7. sends the private sidecar exactly
   `{source, sourceSha256, quality, output, assets, audio}` under bearer authentication.

Each asset envelope binds a content-derived path, MIME type, SHA-256, byte length, and canonical
base64. The sidecar independently checks the envelope, hash, media structure, source AST asset
references, and exact absence of unreferenced content before writing private `0600` files under one
`0700` job directory.

The generated-source policy allows only the compiler's imports, scene class, constant helper
definitions, literal arguments, bounded methods, and immutable descriptor shapes. It rejects arbitrary
imports/calls, private attributes, dynamic names, user code, filesystem APIs, control-flow expansion,
and constructed strings. Raster crop/fit/masks use a fixed compiler helper over Pillow/NumPy;
sanitized SVG uses `SVGMobject` only in its supported visual subset.

Manim runs with `shell=False`, a fresh process group, sanitized environment/proxies, deterministic
seeds, private HOME/TMP/XDG paths, and CPU, address-space, file-size, open-file, wall-time, log, PID,
and artifact limits. Cancellation and timeout terminate the complete process group with bounded
TERM/KILL escalation. A successful leader is still rejected if descendants survive.

Audio muxing first probes each exact source asset, then constructs FFmpeg arguments from finite
numeric literals only. It applies source trim, playback-rate decomposition, fades, volume/keyframe
envelopes, and project placement without accepting filter text from the request. The final artifact
must have one H.264 video stream, exact dimensions/fps/decoded frame count and expected duration, and,
when audible clips exist, one AAC stream with a bounded sample count. Full video and audio decode is
required before publication.

Status returns only sanitized job metadata. Video and containing-frame still responses carry exact
length and source/artifact hash headers and are streamed through bounded abortable Next.js proxies.
The retained artifact verifier independently recomputes hashes for checked-in evidence.

## Queue, cancellation, and restart loss

The sidecar owns an in-memory queue and job store. One job runs; one waits; further submission returns
429. Cancellation marks queued work terminal or signals the active process group. A completed job can
produce a playhead-containing still and can be downloaded until its ten-minute TTL expires. Failed
filesystem cleanup retains bookkeeping so cleanup can retry.

Restart loses the queue, job metadata, MP4s, and still availability. The UI may resume polling a
known job only while the same sidecar process retains it. This loss is accepted for V1 and must remain
visible in deployment and operator documentation; no durable-render claim is permitted.

## SQLite deployment and backup boundary

The data directory holds `proofcanvas.sqlite3`, WAL/SHM sidecars while active, backups, and a separate
`.proofcanvas-instance-lease.sqlite3`. Every supported writable process holds an exclusive
transaction on that lease in the canonical real directory. Same-process connections share it only
through an in-memory registry. The lease is not distributed and cannot stop a raw SQLite writer, so
the database must be on a local filesystem with reliable SQLite locking and the app must run as one
replica.

Online backup uses SQLite's backup API, validates the copy completely, fsyncs staged data and
directories, then publishes a private checksummed file. Restore is offline: it refuses an active
supported writer, validates a private source copy (including any migration), transactionally removes
all staged sessions and login-rate rows, revalidates and fsyncs that sanitized main file, publishes a
verified pre-restore backup, and atomically renames the stage over the target. This prevents an older
backup from resurrecting a revoked cookie, so every restore forces a fresh owner login. Operators
must stop the app and every maintenance process before restore.

## Production and evidence boundaries

Production requires the topology in [`DEPLOYMENT.md`](./DEPLOYMENT.md): HTTPS ingress, exact Origin,
one web replica, durable local-locking volume, private renderer network, secret injection, read-only
containers, bounded tmpfs, non-root users, dropped capabilities, `no-new-privileges`, explicit memory
and PID limits, and no renderer egress/public ingress. If those controls cannot be proven, leave MP4
rendering disabled.

Passing tests demonstrate the named engineering behavior only. They do not establish mathematical
correctness of user content, accessibility conformance, human usability, subjective visual quality,
privacy/rights clearance, live-provider quality, or hosted production reliability. Exact final
qualification belongs in [`V1_AUDIT.md`](./V1_AUDIT.md), not in architectural assertions.
