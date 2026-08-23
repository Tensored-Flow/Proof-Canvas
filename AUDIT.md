# ProofCanvas engineering audit

Audit snapshot: `2026-08-23T19:11:36Z`.

## Verdict

The standalone working tree provides a functioning structured edit-to-Manim vertical slice. The
root editor, canvas operations, hierarchy, shots, timeline, persistence, AI proposal transaction,
critic, compiler, isolated renderer, and downloadable MP4 operate on one validated
`ProjectDocument`.

The checks below establish engineering behavior in the stated environment. They are not claims of
production readiness, human usability approval, accessibility conformance, mathematical review,
subjective visual quality, or general natural-language reliability.

## Validation environment

- Linux `6.8.0-136-generic`
- Host architecture `x86_64`; renderer container CPython `3.14`
- GNU Bash `5.2.21`
- GNU coreutils `timeout` `9.4`
- Node.js `24.18.1`
- npm `11.16.0`
- Python `3.12.3`
- Docker `29.7.1`
- Git `2.43.0`
- ripgrep `14.1.0`
- Next.js `16.3.2` from the committed lockfile

## Exact working-copy results

| Command | Result |
|---|---|
| `npm ci` | PASS: 504 packages installed, 505 audited, 0 vulnerabilities; upstream deprecation notices and one npm install-script review notice were printed |
| `npm test` | PASS: 14/14 suites, 158/158 tests, 0 snapshots |
| `npm run typecheck` | PASS: `tsc --noEmit` |
| `npm run build` | PASS: production webpack build; `/`, compatibility `/proofcanvas`, and four AI/render routes emitted |
| `npm run test:renderer` | PASS: hash-locked isolated test image passed 36/36 tests with one Starlette/httpx deprecation warning; lean runtime image then built from the same pinned base |
| `npm run artifacts` | PASS: deterministic double compile, Python AST parse, no compiler diagnostics, five AI commands, regenerated manifest, and fail-closed verification of all retained evidence |
| `npm run artifacts:verify` | PASS: exact nine-file set, sizes, SHA-256 records, media headers/dimensions, render metadata, browser summary, project identity, and reversible-AI claims verified |
| `npm run render` | PASS: fresh genuine Manim Community 0.21.0 H.264 render and decoded evidence frame; manifest refreshed and verified before exit |
| `npm run test:e2e` | PASS: 2/2 complete journeys, 0 skipped, 0 retried, 0 failures; manifest refreshed and verified before exit |
| `npm run dev -- --port 3417` | PASS: `/` returned the expected title, listener was only `127.0.0.1:3417`, and the task-owned port was released |
| `npm audit --omit=dev --audit-level=high` | PASS: 0 vulnerabilities |
| Runtime-image inspection | PASS: `/app/tests` absent and pytest unavailable; upstream Manim still supplies `httpx` transitively |

The browser journey starts at `/` and separately proves that `/proofcanvas` returns the expected
compatibility redirect. It runs in an externally networkless Playwright container against the
production build and a separate renderer container. Both 1440x900 and 1280x800 journeys cover:

- preloaded project, timeline scrubbing, two output styles, ordinary and grouped direct
  manipulation, selection, alignment, distribution, hierarchy, locks, layers, undo, and redo;
- object and six-component insertion, multiple shots, timeline block creation/move/resize, local
  save/load, valid import, rejected invalid import, JSON/Python download, critique, and diagnostics;
- all five deterministic AI proposals with visible review, atomic apply, exact undo, and redo;
- genuine render submission/status/video/download through the authenticated sidecar hop;
- page-error and console-error capture, keyboard interactions, serious/critical axe scans, control
  fit, and document overflow checks.

The run reported no uncaught page/console errors, serious or critical axe findings, or horizontal
document overflow in the exercised states.

## Artifact evidence

| Repository-relative artifact | Bytes | SHA-256 |
|---|---:|---|
| `examples/proofcanvas/uncountable-yet-zero-length.proofcanvas.json` | 30,543 | `7215837ae02639364c67f48eaf9d76ca0fc7fe7ea13ac86be83b4be6ea0995f9` |
| `examples/proofcanvas/uncountable-yet-zero-length.py` | 16,773 | `064df3d9548836ee681508e2b894277923b69c4eb6308e5697341693e3b50db6` |
| `examples/proofcanvas/ai-command-results.json` | 14,241 | `faabae153919d01f7911a671aabcd5f6627522110ccf0f87fc3fa26c3c1accb4` |
| `examples/proofcanvas/artifact-manifest.json` | 1,666 | `e5d3d175b9f2c206bcc9cf263b776b80b3957189118de87e3c0b510383538ed8` |
| `examples/proofcanvas/uncountable-yet-zero-length.mp4` | 473,780 | `638041f76b602646fdc1b81116c02c0d0b77d32204c77c7e99172fd015d3b8e9` |
| `examples/proofcanvas/render-metadata.json` | 524 | `92b4552c9ae9574b7c7122469ce40b40c1513831dd153746109ba9de22c496aa` |
| `examples/proofcanvas/evidence/browser-summary.json` | 1,032 | `77f92d662118c9edb79b175d7a638c5ae1b2aafe39f1d188c594120c6d8097ba` |
| `examples/proofcanvas/render-evidence/proofcanvas-manim-frame-12s.png` | 54,281 | `68e874490083b26e8c6581ab97f74e5524e94be3726465bd2e9f5f275d370ffb` |
| `examples/proofcanvas/evidence/proofcanvas-editorial-1440x900.png` | 149,882 | `654ab354edcec886bcb8f5ada568fe3b7d0b6946da79c3d7ef174bee0823885c` |
| `examples/proofcanvas/evidence/proofcanvas-editorial-1280x800.png` | 131,016 | `b84e06d35d034d6efec9334af2400bb390ff9c05cc7e340aa92e5a5f11038031` |

The canonical document contains two shots totaling 28 authored seconds. The regenerated video uses
`manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3`:
H.264, 854x480, 15.00035 fps, 27.932682 seconds, and 419 decoded frames. Its evidence frame was
decoded at 12.533008 seconds. Render metadata binds the video to generated-Python SHA-256
`064df3d9548836ee681508e2b894277923b69c4eb6308e5697341693e3b50db6`.

The browser journey independently rendered and downloaded another valid `mp4/ftyp` file: 571,542
bytes, SHA-256 `5aae4f3537e2defb9a60c3c1cd1a4dff6e8dc5a9f8b187f7bb2489d57577160d`.

Both editor screenshots and the decoded Manim frame were visually inspected. Text and controls
remain legible without clipping at both target sizes. The output frame materially contains the
same title, recursive interval construction, annotation, palette, and asymmetry. This is bounded
visual evidence, not a human design or usability verdict.

## Five AI command results

No live model credential was configured. All retained results come from the visibly labelled
`deterministic-demo` interpreter. Each proposal passed operation validation, created one history
entry, and restored the exact canonical project after undo.

1. **Move the title into the upper-left margin.** One operation moved it to `(250, 70)` while the
   interval diagram family remained unchanged.
2. **Emphasise and slow the second removal.** Two operations changed its duration from `1.0` to
   `1.8` seconds with `ease-in-out` and inserted a non-overlapping emphasis before removal.
3. **Add the `2^n pieces` brace.** Two operations added an editable brace and reveal at `13.25s`,
   after the third-removal block ends at `13.1s`.
4. **Make the composition less centred and more editorial.** Four operations retained Editorial
   Ink, repositioned three objects, and preserved mathematical content.
5. **Keep the equation locked and quiet everything else.** Twenty-six operations preserved the
   locked equation family and reduced opacity on all 26 supporting objects without an unlock.

The configured-provider boundary is separately covered with mocked official-SDK responses,
strict structured output, selection context, malformed-output rejection, provider-unavailable
behavior, operation revalidation, and effective inherited-lock enforcement. No live provider
request was made.

## What genuinely works

- Versioned shared schema, v0-to-v1 migration, canonical JSON, stable IDs, global hierarchy and
  reference checks, resource ceilings, safe LaTeX/assets/graphs, atomic operations, and history.
- SVG direct manipulation of ordinary objects and styled groups, multi-selection, snap/alignment,
  layers, inherited locks/visibility, six editable components, multiple shots, and timeline blocks.
- Deterministic approximate preview, Editorial Ink and Raw Manim grammars, persistence, import,
  export, diagnostics, and deterministic critique.
- Strict structured-AI boundary plus an honest deterministic fallback and precise proposed diffs.
- Readable deterministic Manim Python with explicit timings/easing, stable identifiers, compiler
  diagnostics, restricted expressions, and a conservative frame-rounded duration estimate.
- Authenticated render hop, source hashing and AST policy, bounded process-local queue, private
  temporary directories, shell-free subprocess, resource limits, complete decode, and explicit
  errors.

## Independent-review repairs

Independent security, correctness, and publication-hygiene review found material gaps before
publication. All were repaired and regression-tested:

- The sidecar previously accepted caller-authored `MathTex` containing file-reading LaTeX such as
  `\input`. It now mirrors the schema allowlist and accepts only the compiler's constant-string and
  bounded-`font_size` call shape; constructed strings and constructor aliases are rejected before
  Manim starts. The canonical generated Python passes this stricter policy.
- The browser-evidence validator previously accepted an arbitrary output path and removed it
  recursively. It now accepts exactly `examples/proofcanvas/evidence`, proves real directory
  ancestry, rejects unexpected entries, and unlinks only three named regular files.
- Render and E2E production could leave stale hashes if run after artifact generation. Both now
  regenerate the manifest, and the shared verifier rejects missing required records, unexpected
  manifest records, changed files, malformed evidence, or semantic inconsistency. The E2E evidence
  subdirectory additionally rejects unmanifested entries.
- Rendering could consume an old generated Python file immediately before artifact regeneration.
  The render command now prepares deterministic source first, records that source SHA in render
  metadata, and verifies the metadata against the retained Python after Manim completes.
- Next.js defaults to all interfaces. Root `dev` and `start` scripts now bind loopback explicitly;
  renderer Docker context also excludes environment, secret, key, certificate, upload, scratch,
  database, and editor residue.
- Browser JSON import previously read the selected file before enforcing any raw-byte ceiling. A
  shared 2 MiB schema/export/API/import contract now rejects oversized input before `File.text()`,
  guarantees that canonical exports remain importable, and covers the exact accepted-inline-asset
  overflow case.
- Generic JSON properties previously allowed unbounded recursive nesting. A depth-indexed schema
  now accepts at most 16 container levels; boundary tests prove level 16 succeeds and level 17 is
  rejected without a validator stack overflow.
- A delayed browser import could overwrite an edit or let an older file win an out-of-order race.
  Imports now bind to the initiating project revision and a monotonic request sequence; regressions
  prove that intervening edits survive and only the latest selected file may commit.
- Renderer log truncation previously happened only after `communicate()` buffered all output. A
  continuously drained ring tail now retains at most 64 KiB while the child runs, then is discarded
  at the sanitized job boundary; a regression emits more than three times the cap.
- Expiry previously forgot job bookkeeping even if directory deletion failed. Failed cleanup now
  retains the completed job for a later retry, with a simulated-failure regression.
- Timeout escalation previously stopped after a process-group leader exited, allowing a
  signal-ignoring descendant to survive. Cleanup now polls and escalates the original process group
  independently of leader status, rejects a successful leader if any descendant remains, reaps the
  leader, and fails closed if the group survives cleanup. The renderer suite establishes and
  eliminates both a live TERM-ignoring parent/child group and a TERM-ignoring child orphaned by an
  exited leader under an init subreaper.
- Renderer-proxy abort timers previously ended when response headers arrived. JSON deadlines now
  cover bounded body consumption; MP4 forwarding has a separate 60-second deadline, exact declared
  byte-count enforcement, upstream cancellation, and short/oversized/stalled-stream regressions.
- The renderer's Docker test target now owns pytest and `/app/tests`; the final runtime target omits
  both. Some development-capable libraries such as `httpx` remain inherited from the pinned Manim
  base and are not represented as removed. Runtime and test dependency closures are separately
  version- and wheel-hash-locked for the pinned Linux x86_64 / CPython 3.14 image.

## Public-exposure review

- The application dependency graph is limited to packages imported by the standalone editor,
  tests, and tooling. There are no database, analytics, authentication, game, or unrelated product
  dependencies.
- No downloaded font files are committed. Geist is consumed through its SIL Open Font License npm
  package; display and monospaced text use system fallbacks. The small SVG is project-authored local
  geometry with no external references or script. Screenshots and video are generated evidence.
- Secret-pattern and binary-metadata scans found no API key, GitHub credential, private key, local
  machine path, or private project metadata. Static credentials that remain in unit tests are
  explicitly synthetic sentinels; the E2E bearer token is generated afresh for each isolated run.
- Only `.env.example` is intended for version control. Local environments, build output, caches,
  renderer/browser scratch, databases, editor state, and agent state are ignored. Renderer Docker
  context additionally excludes secret/key/certificate shapes, uploads, outputs, and databases.
- The repository deliberately has no project license. Dependency licenses do not grant a license
  to ProofCanvas itself.

## Important limitations

- No live OpenAI call was made; mocked SDK boundaries and deterministic commands do not prove
  general language understanding or model reliability.
- Browser-facing AI/render routes lack end-user authentication, tenant authorization, rate limits,
  quotas, abuse controls, and billing. The documented local commands bind loopback, but the current
  application is still not safe for public multi-tenant exposure.
- Persistence is single-device `localStorage`; selection, history, proposals, critiques, and render
  jobs are ephemeral. Renderer jobs are process-local, capacity two, and lost on restart.
- The browser preview is approximate. Browser/Manim typography, stroke reveals, emphasis, easing,
  camera interpolation, compound transforms, and styled-group geometry can differ. Exported Python
  and the genuine MP4 are authoritative output.
- Render requests transfer generated source only. Checked-in or uploaded assets need a trusted
  packaging mechanism before a remote renderer can receive them.
- Direct gestures edit base pose and are refused after a spatial animation starts; sampled-pose
  keyframe editing is not implemented.
- The editor is demonstrated at 16:9 and desktop widths of at least 1100px. The schema/compiler
  accept 9:16, but portrait direct manipulation was not browser-tested; mobile editing is excluded.
- Automated critique is mechanical. Axe, keyboard checks, screenshots, and agent inspection do not
  replace manual assistive-technology, mathematical-content, or usability review.
- Arbitrary Python import/execution and Python-to-canvas round-tripping are deliberately unsupported.
- Renderer, genuine-render, and Docker E2E shell workflows target Linux with Bash 4+ and GNU
  `timeout`; stock macOS hosts need a compatible toolchain or future portable wrappers.

## Highest-value next engineering step

Add an authenticated, tenant-aware admission service backed by a durable render queue and trusted
asset bundle, with per-tenant quotas, cancellation, and observability. This closes the largest
production security and reliability gap while preserving the validated document/compiler boundary.
