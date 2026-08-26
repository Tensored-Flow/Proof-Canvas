# ProofCanvas architecture

## Core invariants

1. `ProjectDocument` is the only authoritative editable state.
2. Every imported, persisted, or externally supplied document crosses the shared Zod schema.
3. Mutations are typed `SceneOperation[]` transactions or validated whole-document commits.
4. Stable IDs, hierarchy, locks, animation targets, and shot order survive unrelated edits.
5. AI returns data operations only. It cannot return code or unlock objects.
6. Generated Manim Python is deterministic output and is never imported as editable state.
7. OpenAI and renderer credentials exist only on the server.
8. Rendering accepts compiler-generated source only and fails closed if policy or isolation cannot
   be established.
9. One private owner is authenticated at every page and API boundary; proxy checks are advisory only.
10. Durable mutations are revision-CAS and idempotent, and every stored document is schema-validated.

## Runtime flow

```text
Browser / -> authenticated dashboard -> /projects/[id]
  |
  +-- ProjectHistory.present ------------------------------+
  |      |                                                  |
  |      +-> CanvasStage -> previewShotAtTime -> SVG/KaTeX  |
  |      +-> layers / inspector / shots / timeline          |
  |      +-> canonical JSON -> CAS autosave / download      |
  |      +-> compileManim -> diagnostics + Python download  |
  |                                                         |
  +-- direct edit -> SceneOperation[] -> applyOperations ---+
  +-- projectId + revision -> authenticated Next route       |
  |      +-> SQLite repository -> canonical document --------+
  +-- AI request -> validated operations --------------------+
  +-- render -> compiler -> private sidecar -> MP4
```

`/proofcanvas` is a compatibility redirect to `/`, now the protected project dashboard. Selection, playhead, undo/redo history,
unapplied proposals, critique results, and render status are transient React state. Only structured
creative state is serialized.

## Module map

| Area | Files | Responsibility |
|---|---|---|
| Editor | `app/ProofCanvasEditor.tsx`, `app/CanvasStage.tsx`, `app/proofcanvas.css` | Direct manipulation, layers, inspector, shots, timeline, persistence, AI review, critique, export, and render status |
| Routes/UI | `app/page.tsx`, `app/ProjectDashboard.tsx`, `app/projects/[projectId]/`, `app/login/` | Protected dashboard, durable editor loader, and owner login |
| Auth/storage | `lib/proofcanvas/auth.server.ts`, `database.server.ts`, `repository.server.ts`, `backup.server.ts` | Sessions, CSRF/origin checks, STRICT SQLite migrations, CAS/idempotency, checkpoints, and operations |
| Schema | `lib/proofcanvas/schema.ts` | Versioned document, types, migration, global validation, and canonical JSON |
| Operations/history | `lib/proofcanvas/operations.ts`, `documentOperations.ts`, `objectReferences.ts`, `history.ts` | Atomic edits, declared reference remapping, inherited locks, structural duplication, undo, and redo |
| Preview/styles | `lib/proofcanvas/preview.ts`, `styles.ts` | Deterministic browser state and output-style grammar |
| Components | `lib/proofcanvas/components.ts` | Exactly twelve ordered, style-derived semantic assemblies: 12 ordinary root groups and 48 editable leaves |
| AI | `lib/proofcanvas/ai.ts`, `openaiProvider.ts` | Deterministic fallback, bounded provider context, strict output parsing, and local proposal validation |
| Critique/compiler | `lib/proofcanvas/critique.ts`, `compiler.ts` | Deterministic diagnostics and validated Manim Python generation |
| Next API boundary | `app/api/proofcanvas/**`, `lib/proofcanvas/renderClient.server.ts` | Bounded AI/render envelopes, server compilation, sidecar authentication, and response validation |
| Render sidecar | `services/proofcanvas-render/` | AST policy, bounded queue, restricted Manim subprocess, MP4 validation, and streaming |
| Evidence | `scripts/proofcanvas/`, `tests/browser/proofcanvas/`, `examples/proofcanvas/` | Deterministic artifacts, genuine rendering, browser acceptance, and retained evidence |

## Document and mutation boundary

Schema version 4 describes metadata, aspect ratio, output styles, ordered shots, scene objects,
groups, typed animations and property tracks, object lifetimes, portable asset metadata, audio and
caption metadata, markers, custom easings, and camera state. The registered V1-to-V2 migration is
deterministic; V2 remains a frozen float-time compatibility format, while the loss-aware V2-to-V3
migration establishes one bounded 10 ns tick as the persisted and compiler time authority. It
rewrites only documents whose positive spans, equality classes, strict ordering, containment,
overlap/touching relations, event chronology, and frozen compiler-work admission remain lossless.
Animation `targetIds` are a semantic set with stable first-occurrence ordering: published V1-V3
schemas admitted repeated serialized IDs even though preview already evaluated each ID once. The
V3-to-V4 migration removes only those redundant occurrences, then advances the version signal and
adds five strictly described native types: ellipse, polygon, dashed line, double arrow, and
one-contour cubic freeform path. Repeated compiler expansion was a defect, not authored meaning. Their
normalized local coordinates use positive X right and positive Y down; compilation negates Y once.
Every rendering field is explicit, polygon edges are simple, paths are bounded to 64 nodes, each
line is bounded to 256 rendered dashes, and compiler-occurrence-weighted native geometry is capped
at 4,096 points or dashes per project. The historical V1-to-V3 object vocabulary is frozen so a
new object cannot be laundered through a falsely old version.
Validation is global: it rejects duplicate IDs,
missing or cyclic parents, invalid targets and timing, overlapping animation families, invalid
style references, unsafe LaTeX or assets, unrestricted graph expressions, and values outside the
compiler dialect. Future schema versions are rejected; registered migrations are parsed through
the current schema before publication.

Persistence migration is per document. Exact canonical V2 bytes and their SHA-256 are stored in an
immutable archive before either a project or checkpoint is rewritten. A loss-prone current project
is quarantined from editor, AI, render, and mutation paths and receives an authenticated no-store
byte-exact export. A loss-prone checkpoint leaves its current project editable but cannot be
recovered; its exact export remains addressable after parent soft deletion. Migration SQL, the
versioned data-transform tag, archive writes, counters, and a complete integrity pass commit in one
IMMEDIATE transaction. Invalid or noncanonical V2 data rolls the migration back rather than being
reclassified as recoverable.

A separate checksummed database migration advances only canonical `ready` V3 projects and
checkpoints to V4, stably canonicalizing target sets when needed. It leaves recovery-required V2
bytes and immutable archive records untouched; the historical V2-to-V3 migration continues to
publish canonical V3 bytes while preserving every exact V2 source in that archive.

Canonical serialization recursively sorts object keys while preserving meaningful array order.
This gives persistence, export, tests, and source hashing the same deterministic representation.

The broad document schema retains two legacy easing combinations so persisted V2 material can be
opened and repaired. New add/update operations, full-document saves, structural duplication, and
configured-provider output enforce the narrower authoring vocabulary. An unsupported legacy
animation may remain exactly unchanged during unrelated edits, be deleted, or receive only the
easing change that makes it render-supported; no ingress can silently create another copy.

`applyOperations` clones the project, resolves stable IDs, enforces direct and inherited locks,
applies every operation, repairs dependent references where the operation contract requires it,
and validates the complete result. An exception publishes nothing. History stores the prior
complete project, so a multi-operation action—including an AI proposal—undoes and redoes as one
entry. Whole-document load, import, reset, component insertion, and shot editing use the same
validate-before-publish rule.

Semantic-component instantiation derives typography and strokes from the active style, allocates
IDs against the complete project namespace, computes exact rotated-leaf bounds, and clamps them 24
logical pixels inside every supported frame. The complete candidate document is schema-preflighted
before publication. Click insertion uses the live preview camera centre; drag/drop maps the pointer
through the inverse SVG and camera transforms. A successful insertion creates one history entry and
selects only its ordinary root group.

Structural copy operations rewrite only the declared `annotation-arrow` `properties.targetId`
reference. Opaque `assetId`, `externalId`, and nested lookalike fields are intentionally preserved.

Groups maintain hierarchy pre-order. Reordering is sibling-only and keeps a group subtree
contiguous. Group bounds are derived from rotated leaf-descendant geometry. Group transforms are
baked into descendants before affected ancestor bounds are refreshed.

## Preview and compiler

`previewShotAtTime` clamps the playhead, sorts blocks by `(start, id)`, derives object presence,
preserves inherited visibility, and folds animation and camera effects into cloned preview state.
The canvas then applies the active style and any temporary pointer gesture before drawing SVG.

Canvas gestures edit base poses, not sampled keyframes. After a move, scale, or transform affecting
the selected family begins—or during an emphasis pulse—base-pose manipulation is refused. Scrub to
the start of the block or edit the timeline instead.

The preview is intentionally approximate. Browser fonts, KaTeX, SVG paths, graph sampling, easing,
group bounds, and camera interpolation can differ from Manim. The exported Python diagnostics and
genuine MP4 are authoritative for rendered output.

`compileManim` validates again and emits a deterministic `GeneratedScene(MovingCameraScene)`. It
sanitizes stable variable names, maps editor coordinates to the Manim frame, emits shots as
sections, makes time explicit, and compiles graphs from a restricted expression tree. It never
evaluates project-supplied Python. Error diagnostics prevent render submission; warnings identify
degraded or deployment-dependent behavior.

## AI trust boundary

`POST /api/proofcanvas/ai` authenticates before configuration or body work, then accepts bounded
JSON containing `{projectId, revision}`, active shot, selected IDs, and instruction. It loads the
active schema-validated document from SQLite. When both `OPENAI_API_KEY` and `PROOFCANVAS_OPENAI_MODEL` are set,
the server uses strict Responses structured output. Provider output is converted into canonical
operations, parsed locally, checked for unlocks and effective locks, and applied to a clone before
the proposal is returned.

The browser receives only an availability flag, never the credential. If configuration is absent,
the UI exposes a visibly labelled deterministic interpreter with a deliberately small vocabulary.
A configured provider error is surfaced as an error rather than silently relabelled as a successful
fallback result.

This boundary constrains operation shape and scope; it does not prove that a proposal is
mathematically correct or aesthetically good. Applying remains an explicit user action.

## Render trust boundary

The browser sends `{projectId, revision}` to authenticated same-origin Next.js routes. The server
loads the active canonical document, rejects stale revisions, compiles it, rejects compiler errors or excessive duration/source size, hashes the generated
Python, and forwards only `{ source, sourceSha256, quality }` to the private sidecar. The bearer
token never reaches browser JavaScript.

The server keeps its upstream abort deadline active through bounded JSON consumption. MP4
forwarding has a separate 60-second deadline, cancels upstream work when the browser disconnects,
and requires the streamed byte count to equal the validated `Content-Length` without exceeding the
256 MiB ceiling.

The sidecar then:

- authenticates with constant-time token comparison;
- checks exact request keys, sizes, source hash, and an allowlisted Python AST dialect;
- creates a private job directory and invokes Manim with a shell-free argument vector;
- sanitizes environment and proxy variables and applies process resource limits;
- rejects and terminates a subprocess group if any descendant outlives its Manim leader;
- permits one running and one pending job;
- validates a single regular H.264 MP4, dimensions, frame rate, duration, frame count, and complete
  decode before exposing it;
- continuously drains subprocess output into a fixed-size tail, discards that private tail at the
  sanitized queue boundary, and deletes completed jobs after ten minutes while retaining
  bookkeeping for retry if filesystem deletion fails.

AST checking and process limits are not container isolation. A deployment must preserve the
digest-pinned non-root image, read-only root filesystem, bounded tmpfs, dropped capabilities,
`no-new-privileges`, memory/PID limits, and network isolation described in
[`services/proofcanvas-render/README.md`](./services/proofcanvas-render/README.md). If the platform
cannot enforce those controls, rendering should remain unavailable.

## Capacity and persistence

The schema, canonical exporter, browser importer, and public render route share one 2 MiB UTF-8
project limit. Imports are refused from file metadata before their contents are read, and schema
validation guarantees that every valid project has an importable canonical export. Other schema
limits bound fan-out, generic JSON nesting, hierarchy depth, content length, graph complexity, and
numeric ranges before expensive work. Generated source is limited to 512 KiB. Selected authored
duration and a conservative frame-rounded compiler estimate must both fit within 300 seconds.

The renderer produces 854×480 at 15 fps for preview or 1280×720 at 30 fps for production. Output
is capped at 310 seconds and 256 MiB; a Manim process has a 180-second timeout and 2 GiB address
space. Its queue and job store are process-local: restarts lose jobs, and multiple Uvicorn workers
would create independent queues.

Durable persistence is a configurable SQLite database with checksummed STRICT migrations, WAL,
foreign keys, FULL synchronous writes, metadata-only dashboard queries, soft deletion, checkpoints,
and online backup. Writes increment a positive revision and use compare-and-swap plus idempotent
mutation IDs. A project-scoped `localStorage` snapshot is written only as a recovery bridge and is
never applied automatically. A complete integrity pass validates the exact schema and migration
manifest plus every project, checkpoint, mutation receipt, session, and rate-limit row before a
backup is published or restored. Readiness performs the exact structural checks on every probe and
the complete row pass once per opened application connection, avoiding an unbounded scan every 15
seconds while supported repository writes remain validate-before-commit.

Database restore is an offline operation. Every supported writable database connection holds an
exclusive transaction on a separate persistent `.proofcanvas-instance-lease.sqlite3` database in
the canonical real target directory. Same-process writers share that lease only through an in-memory
directory registry; maintenance is a distinct exclusive mode. Existing file symlinks resolve to the
real target before lease and staging placement, and hardlinked database targets are rejected. SQLite
releases the transaction if its owning process exits, so no PID liveness, same-PID adoption, or stale
lock-file deletion is involved. Restore checkpoints the closed target, publishes and validates a
byte-verified pre-restore backup, fsyncs staged files and directories, then atomically renames the
staged database over the still-present target. This lease governs only code using ProofCanvas's
supported database module; it is not a mandatory lock against a raw SQLite writer. Local filesystem
locking semantics are required, raw-module bypasses are unsupported, and operators must still stop
the application before restore.

Old backups are upgraded only on a private copy. The source database bytes, inode/link target,
mode, mtime, directory listing, and sidecars are not mutated by validation; restore publishes the
fully migrated private copy. Ready V4 rows remain canonical and strict, while recovery archives
retain the exact V2 source bytes. Every supported row mutation rewrites project-duration metadata
from an integer-tick sum, including compatibility cleanup of older binary-dust counters.

The dashboard returns at most the 500 newest active projects and recovery lists the 100 newest
checkpoints; pagination and retention policy are deferred to later storage work.
Render requests do not yet package trusted assets, so checked-in image paths require a future asset
transfer design for remote rendering.

## Current production gaps

- The private owner model has no sign-up, multi-user authorization, password reset, quotas, billing,
  collaboration, or durable render jobs.
- Login uses a process-wide two-job non-queueing scrypt admission cap and a ten-attempt global
  15-minute window. Because ProofCanvas deliberately does not trust spoofable forwarding headers,
  source-aware throttling must be enforced by a trusted same-host reverse proxy; the global window
  can otherwise be abused to cause a temporary owner lockout.
- The deterministic critic and model proposals require human mathematical and editorial judgment.
- Accessibility automation and screenshots do not replace human assistive-technology or usability
  testing.
- Native-shape authoring was exercised at a 1024x1366 browser viewport with a 540x960 9:16 frame;
  the complete portrait animation/render journey and mobile touch editing remain unqualified.
- The exact twelve-card registry and representative component insertion and manipulation were
  exercised at 1440×900 and 1280×800. This is partial semantic-component and browser evidence;
  trusted image/SVG authoring and the remaining required viewports are still unqualified.
- Arbitrary Python, Python round-tripping, sampled-pose keyframe editing, accounts, collaboration,
  3D, and physics are out of scope. Trusted image/SVG authoring, asset transport and packages,
  remaining animation vocabulary, and audio/caption completion remain V1 work and block a V1
  release until their own gates pass.
