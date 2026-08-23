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

## Runtime flow

```text
Browser /
  |
  +-- ProjectHistory.present ------------------------------+
  |      |                                                  |
  |      +-> CanvasStage -> previewShotAtTime -> SVG/KaTeX  |
  |      +-> layers / inspector / shots / timeline          |
  |      +-> canonical JSON -> localStorage or download     |
  |      +-> compileManim -> diagnostics + Python download  |
  |                                                         |
  +-- direct edit -> SceneOperation[] -> applyOperations ---+
  +-- AI request -> Next route -> validated operations -----+
  +-- render -> Next route -> compiler -> sidecar -> MP4
```

`/proofcanvas` is a compatibility redirect to `/`. Selection, playhead, undo/redo history,
unapplied proposals, critique results, and render status are transient React state. Only structured
creative state is serialized.

## Module map

| Area | Files | Responsibility |
|---|---|---|
| Editor | `app/ProofCanvasEditor.tsx`, `app/CanvasStage.tsx`, `app/proofcanvas.css` | Direct manipulation, layers, inspector, shots, timeline, persistence, AI review, critique, export, and render status |
| Routes | `app/page.tsx`, `app/proofcanvas/page.tsx` | Root editor and compatibility redirect |
| Schema | `lib/proofcanvas/schema.ts` | Versioned document, types, migration, global validation, and canonical JSON |
| Operations/history | `lib/proofcanvas/operations.ts`, `history.ts` | Atomic edits, reference repair, inherited locks, undo, and redo |
| Preview/styles | `lib/proofcanvas/preview.ts`, `styles.ts` | Deterministic browser state and output-style grammar |
| Components | `lib/proofcanvas/components.ts` | Six semantic assemblies made from editable scene objects |
| AI | `lib/proofcanvas/ai.ts`, `openaiProvider.ts` | Deterministic fallback, bounded provider context, strict output parsing, and local proposal validation |
| Critique/compiler | `lib/proofcanvas/critique.ts`, `compiler.ts` | Deterministic diagnostics and validated Manim Python generation |
| Next API boundary | `app/api/proofcanvas/**`, `lib/proofcanvas/renderClient.server.ts` | Bounded AI/render envelopes, server compilation, sidecar authentication, and response validation |
| Render sidecar | `services/proofcanvas-render/` | AST policy, bounded queue, restricted Manim subprocess, MP4 validation, and streaming |
| Evidence | `scripts/proofcanvas/`, `tests/browser/proofcanvas/`, `examples/proofcanvas/` | Deterministic artifacts, genuine rendering, browser acceptance, and retained evidence |

## Document and mutation boundary

Schema version 1 describes metadata, aspect ratio, output styles, ordered shots, scene objects,
groups, typed animations, and camera state. Validation is global: it rejects duplicate IDs,
missing or cyclic parents, invalid targets and timing, overlapping animation families, invalid
style references, unsafe LaTeX or assets, unrestricted graph expressions, and values outside the
compiler dialect. Future schema versions are rejected; registered migrations are parsed through
the current schema before publication.

Canonical serialization recursively sorts object keys while preserving meaningful array order.
This gives persistence, export, tests, and source hashing the same deterministic representation.

`applyOperations` clones the project, resolves stable IDs, enforces direct and inherited locks,
applies every operation, repairs dependent references where the operation contract requires it,
and validates the complete result. An exception publishes nothing. History stores the prior
complete project, so a multi-operation action—including an AI proposal—undoes and redoes as one
entry. Whole-document load, import, reset, component insertion, and shot editing use the same
validate-before-publish rule.

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

`POST /api/proofcanvas/ai` accepts bounded JSON containing the current project, active shot,
selected IDs, and instruction. When both `OPENAI_API_KEY` and `PROOFCANVAS_OPENAI_MODEL` are set,
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

The browser sends a structured project to same-origin Next.js routes. The server validates it,
compiles it, rejects compiler errors or excessive duration/source size, hashes the generated
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

Browser persistence is canonical project JSON in `localStorage` under `proofcanvas_project_v1`.
There is no account binding, server database, collaboration, autosave, or conflict resolution.
Render requests do not yet package trusted assets, so checked-in image paths require a future asset
transfer design for remote rendering.

## Current production gaps

- Browser-facing AI and render routes have no user authentication, tenant authorization, per-user
  quotas, billing control, or durable jobs.
- The deterministic critic and model proposals require human mathematical and editorial judgment.
- Accessibility automation and desktop screenshots do not replace human assistive-technology or
  usability testing.
- The editor is demonstrated on a 16:9 desktop surface; portrait editing is not browser-validated.
- Arbitrary Python, Python round-tripping, sampled-pose keyframe editing, accounts, collaboration,
  audio, 3D, and physics are out of scope.
