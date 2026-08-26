# ProofCanvas engineering audit

Audit snapshot: `2026-08-26T06:55:14Z`.

## Verdict

The standalone working tree provides a functioning private structured edit-to-Manim vertical
slice. Schema V4 now carries five additional native shapes through strict admission, manual
authoring, SVG preview, deterministic compilation, and renderer-policy validation. The root editor,
canvas operations, hierarchy, shots, timeline, SQLite persistence, AI proposal transaction, critic,
compiler, isolated renderer, and downloadable MP4 operate on one validated `ProjectDocument`.

This is a milestone audit, not the final V1 audit. The semantic-component library, asset/package
transport, audio/captions, complete animation vocabulary, representative 45–60 second project,
hosted qualification, and final V1 release gates remain open.

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
| `npm test -- --runInBand` | PASS: 49/49 suites, 893/893 tests, 0 snapshots |
| `npm run typecheck -- --pretty false` | PASS: `tsc --noEmit` |
| `npm run build` | PASS twice inside the native-shape harness: production webpack build; dashboard, auth, health, project, AI, and render routes emitted |
| `npm run test:renderer` | PASS: hash-locked isolated test image passed 550/550 tests with one Starlette/httpx deprecation warning; lean runtime image also built |
| `npm run artifacts:verify` | PASS: exact nine-file set, sizes, SHA-256 records, media headers/dimensions, render metadata, browser summary, project identity, and reversible-AI claims verified |
| `bash scripts/proofcanvas/native-shape-parity/run.sh` | PASS twice: first publication and atomic replacement; 1/1 authenticated production-browser journey, five browser/Manim parity probes, staged verification, final-path verification, and rollback-safe finalization |
| `npm audit --omit=dev --audit-level=high` | PASS: 0 vulnerabilities |
| `git diff --check` | PASS |

The new browser journey starts at owner login, opens an exact persisted schema-V4 project, and runs
in an externally networkless digest-pinned Playwright container against the production build. One
transaction proves the ordered 16-card clickable/draggable palette, click and native drag/drop
insertion, every deep native-shape control, exact undo/redo, locked mutation refusal, playback
mutation refusal, and autosave. It also exercises a 1024x1366 browser viewport with a 540x960
authored frame: the library and inspector remain usable and the document does not overflow. Separate
console, page, request, and HTTP-5xx error arrays are empty.

The same persisted document is compiled twice deterministically, rasterized once by real
`CanvasStage` SVG in Chromium and once by pinned Manim 0.21/Cairo, then compared with per-shape
bounding-box, centroid, area, symmetric coverage/distance, and dash-topology gates. All five masks
pass; the dashed line has exactly six material components in each renderer. This does not establish
typography, animation, or complete portrait-render parity.

## Artifact evidence

| Repository-relative artifact | Bytes | SHA-256 |
|---|---:|---|
| `examples/proofcanvas/uncountable-yet-zero-length.proofcanvas.json` | 31,142 | `8800d5510fcc6ef2e1de6c1797773e8e69afbc4e52defb7613f8369f22e40ce2` |
| `examples/proofcanvas/uncountable-yet-zero-length.py` | 19,861 | `014eae0e47ed5c1dd0dfa936ac2358ff111daf9366849a7ba8a187484bbbca57` |
| `examples/proofcanvas/ai-command-results.json` | 14,246 | `a11b5e781d85a9859031172fcc27409070230eabaa0bcb6a28ec836305e7d2c1` |
| `examples/proofcanvas/artifact-manifest.json` | 1,865 | `10535ddad01ad9d6e913291d65b7b7dc326eb461b25f0e2b5fa5c5e6614a409c` |
| `examples/proofcanvas/uncountable-yet-zero-length.mp4` | 445,731 | `0f540ea8373e327ee41f8e134615783c85543da37e7b4fd378a3c4d2d64bd7b0` |
| `examples/proofcanvas/render-metadata.json` | 617 | `206e8e7d821261a2487c4fe4c5e3c20e67902b9c2cd2040c4ce50c32788fdbdf` |
| `examples/proofcanvas/evidence/browser-summary.json` | 1,033 | `6d7a6aba68b4fd509894263387107d8c87a0745daa304133b6481808ce73a8f6` |
| `examples/proofcanvas/render-evidence/proofcanvas-manim-frame-12s.png` | 47,174 | `05301ce843dff1573d56574ecc19ae227037dbaa509f56905694f67792be1080` |
| `examples/proofcanvas/evidence/proofcanvas-editorial-1440x900.png` | 155,095 | `34747d985157796cba37a37e26e1eaef13ae7e5d9add68eab9b4567e7075f4ce` |
| `examples/proofcanvas/evidence/proofcanvas-editorial-1280x800.png` | 136,951 | `dfcecef82cda15154661679e45fa55a7617df84647811f74ee69315110eb643b` |

### Native-shape parity and authoring evidence

The retained directory is an exact 21-file set. Its manifest canonically binds 20 non-manifest
artifacts, 10 harness files, and 135 current runtime-input files; retained verification recomputes
all of them. Publication was exercised both with no prior directory and with Linux atomic directory
exchange. Prior evidence remains rollback-capable until the candidate passes verification at its
final path.

| Repository-relative artifact | Bytes | SHA-256 |
|---|---:|---|
| `examples/proofcanvas/native-shape-parity/evidence-manifest.json` | 29,979 | `51c195eba9ee87e94c11da39dcdced602d9ba34f0df84bec11dc88dddf1a27fe` |
| `examples/proofcanvas/native-shape-parity/parity-report.json` | 37,632 | `a42b699c3135f6a7129fc3f4dca158f793d466aa259e5289630ea32d65cdd428` |
| `examples/proofcanvas/native-shape-parity/browser-authoring.json` | 3,602 | `71737eb01d9d5e3defbbe6e557f4febadbd109133aa501498a38d522cc117af6` |
| `examples/proofcanvas/native-shape-parity/browser-stage.png` | 12,006 | `d37b6c96bae43ce701bf19b53f7da5ac3852e4e016ba77ed3283130ad8ed7614` |
| `examples/proofcanvas/native-shape-parity/manim-frame.png` | 13,673 | `4b411d98bb204e6327f3ac6f736de863fcb783b46be3a24dab4f2ef196fc9afe` |

The exact parity input hashes are project
`e6e4d9bd32031b01bbd5c559fd01a6363ed791a40560d3e7ee804b0ecb99e538` and generated Python
`eb59c5ea3a806d124e75ecb8109ca3dbaba6a8af0053ebd6a348bf58f2ea3c8b`.
All six retained screenshots and all five comparison images were visually inspected. The static
browser and Manim frames materially coincide; comparison images show overlap with only narrow
antialias fringes. Authoring screenshots show the deep inspector, closed-path fill, locked state,
playback state, and bounded portrait layout. This is engineering evidence, not human taste,
accessibility, mathematical-content, or mobile-touch approval.

The canonical document contains two shots totaling 28 authored seconds. The regenerated video uses
`manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3`:
H.264, 854x480, 15.00034 fps, 28.466016 seconds, and 427 decoded frames. Its evidence frame was
decoded at 12.533008 seconds. Render metadata binds the video to generated-Python SHA-256
`014eae0e47ed5c1dd0dfa936ac2358ff111daf9366849a7ba8a187484bbbca57`.

The browser journey independently rendered and downloaded another valid `mp4/ftyp` file: 540,138
bytes, SHA-256 `87281a5c09b7747edb16a415f2852946afe09cad644c2a9458fa1d17eddd2d69`.

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

- Versioned shared schema with deterministic V1-to-V4 and database migrations, canonical JSON,
  stable IDs, global hierarchy and reference checks, resource ceilings, safe LaTeX/assets/graphs,
  strict native-shape descriptors, atomic operations, and history.
- SVG direct manipulation of ordinary objects and styled groups, multi-selection, snap/alignment,
  layers, inherited locks/visibility, six existing semantic components, 16 editable shape presets,
  multiple shots, and timeline blocks.
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

- Repeated animation target IDs could make preview semantics diverge from compiler work and bypass
  aggregate admission. Schema V4 makes targets a stable unique set at document, operation, copy,
  provider, and database ingress; legacy migration preserves first-occurrence order and exact V2
  archive bytes.
- Schema-valid polygon/path coordinates could collapse or self-intersect after eight-decimal Python
  emission. Admission now projects exact compiler coordinates and revalidates adjacency, closure,
  non-collinearity, intersections, endpoints, and control coincidences before accepting the object.
- Renderer policy previously lacked independent simple-polygon enforcement and rejected the
  compiler's narrowly transformed safe dash descriptor. It now mirrors topology checks and accepts
  only overlapping, bounded compiler-origin dash/ratio intervals while rejecting tampering.
- Closed freeform paths had no fill contract, while generic opacity could accidentally imply fill
  in generated source. Fill is now conditional on `closed: true` across schema, inspector,
  keyframes, preview, compiler, and renderer grammar; reopening atomically removes incompatible
  fill state and open paths remain stroke-only.
- Shape edit failures previously collapsed useful nested paths into a generic status. Polygon
  crossing, post-quantization path collapse, and unsafe dash edits now surface the first precise
  path/reason and reset the invalid control without a partial history mutation.
- A rounded rectangle could be keyframed below twice its corner radius, causing the compiler's
  correct clamp to conflict with renderer policy's frozen emitted-radius descriptor. Generated
  source now carries the exact `min(authored radius, width / 2, height / 2)` derivation; policy binds
  the immutable authored origin and repeated dimension literals while rejecting clamp tampering.
  A positive radius below eight-decimal emission precision deterministically selects `Rectangle`
  from the emitted literal rather than producing an invalid zero-origin derived descriptor.
- Early parity evidence was not current-source-bound or rollback-safe. The retained harness now
  snapshots inputs before build, proves the same 135 runtime and 10 harness files after rendering
  and during retained verification, enforces an exact canonical public-safe manifest, and keeps
  prior evidence recoverable until final-path verification commits the replacement.
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
  owner-authenticated SQLite persistence, tests, and tooling. There are no analytics, game, or
  unrelated-product dependencies.
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
- Browser-facing project, AI, and render routes require the private owner's signed session and CSRF
  contract. There are still no multi-user tenants, per-owner rate limits, quotas, abuse controls, or
  billing, so the application is not safe for public multi-tenant exposure.
- Project documents, revisions, checkpoints, and recovery state persist in SQLite. Selection,
  history, proposals, critiques, and renderer jobs remain ephemeral; renderer capacity is two and
  jobs are lost on restart.
- The native-shape harness establishes bounded static geometry parity for five shapes. Browser/Manim
  typography, stroke reveals, emphasis, easing, camera interpolation, compound transforms, and
  styled-group geometry remain approximate. Exported Python and genuine media are authoritative.
- Render requests transfer generated source only. Checked-in or uploaded assets need a trusted
  packaging mechanism before a remote renderer can receive them.
- Direct gestures edit base pose and are refused after a spatial animation starts; sampled-pose
  keyframe editing is not implemented.
- Native-shape authoring is demonstrated at 1440x900 and at a 1024x1366 viewport with a 540x960
  frame and no page overflow. The complete portrait animation/render journey and mobile touch
  editing remain unqualified.
- Automated critique is mechanical. Axe, keyboard checks, screenshots, and agent inspection do not
  replace manual assistive-technology, mathematical-content, or usability review.
- Arbitrary Python import/execution and Python-to-canvas round-tripping are deliberately unsupported.
- Renderer, genuine-render, and Docker E2E shell workflows target Linux with Bash 4+ and GNU
  `timeout`; stock macOS hosts need a compatible toolchain or future portable wrappers.

## Highest-value next engineering step

Complete the twelve-component semantic library and exact animation vocabulary on the same
schema/editor/compiler/policy boundary, then proceed to trusted portable assets and synchronized
audio/captions. Those are current V1 product blockers; multi-tenant admission remains outside this
private-owner V1 contract.
