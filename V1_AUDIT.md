# ProofCanvas V1 audit

- Audit state: **local AC-01 through AC-19 qualification and fresh independent review complete**
- Embedded publication state: **this record freezes prepublication state; later AC-20 receipts are external**
- Hosted state: **not deployed; no verified public URL or live-service claim**

This is the evidence authority for ProofCanvas V1. AC-17 passes only through the contract's exact
unavailable external credential/host blocker. Local engineering evidence does not establish hosted
production, live-model quality, human accessibility, mathematical correctness, rights/privacy,
universal usability, or subjective editorial approval. No secret, credential, private database, or
private project content is retained here.

## Release identity and provenance

| Field | Qualified or required value |
|---|---|
| Qualification date | `2026-08-30` UTC |
| Candidate branch | `codex/proofcanvas-v1` |
| Baseline commit/tree | `56668c0ff14354412dc89d44f204b55b2f1aca1c` / `68a5eec9342607bdafbed6285f2a2502e07eaae0` |
| Benchmark tag object/target | `b6f395ed1106f45a1d054b59fead5b11710878bc` / `56668c0ff14354412dc89d44f204b55b2f1aca1c` |
| Origin | `https://github.com/Tensored-Flow/Proof-Canvas` |
| Pre-publication remote refs | candidate `ef8b29802f7ba449510bdb7dc8de3175697e101d`; `main` `56668c0ff14354412dc89d44f204b55b2f1aca1c`; no `v1.0.0` |
| Release commit/tree/tag | **External AC-20 receipt**; resolve from pushed refs and the annotated tag after the release commit exists |
| Required final relation | `origin/main`, `origin/codex/proofcanvas-v1`, and `v1.0.0^{commit}` resolve to one release commit |
| Required clean-clone proof | Fresh authenticated HTTPS clone of the exact candidate passes install, typecheck, build, artifact verification, and ref checks before tag publication |
| Required staged-set invariant | No secret, cache, database, local environment, or ignored agent state is staged |
| Protected sibling boundary | No command, dependency, workspace, remote, style, or source path crosses the standalone repository boundary |

A commit cannot contain its own commit hash without changing that hash. The final SHA/tree/tag-object
receipt therefore belongs in the publication handoff after the commit exists; it must not be
fabricated in this tracked pre-publication ledger.

## Acceptance ledger

| Criterion | Assessment before publication | Evidence boundary |
|---|---|---|
| AC-01 repository preservation | **PASS locally** | Standalone history/remote; benchmark tag preserved; no history rewrite; final remote identity remains an AC-20 receipt |
| AC-02 schema/migration | **PASS locally** | Schema V4, registered V1/V2/V3 classifiers/migrations, loss-aware quarantine, canonical round trip, deterministic compiler coverage |
| AC-03 authentication | **PASS locally** | Owner-only scrypt login, opaque 12-hour session, strict production cookies, exact Origin/CSRF/logout/admission and real-TLS checks |
| AC-04 persistence | **PASS locally** | Checksummed STRICT SQLite, CAS/idempotency/checkpoints/assets, fresh context, process restart, validated online backup and atomic offline restore |
| AC-05–08 editor/timeline/keyframes | **PASS locally** | Direct authoring, storyboard/layered timeline, lifetimes/clips/tracks, exact object/camera/audio keys, easing, playback and browser journeys |
| AC-09 assets/packages | **PASS locally** | Content validation/sanitization/scoping/deduplication, bounded canonical archive, adversarial archive/replay tests, stable-ID browser round trip |
| AC-10 audio/captions | **PASS locally** | WAV/MP3, waveform/edit/playback/fades/volume keys, SRT/VTT, package/restart persistence and decoded A/V |
| AC-11 styles | **PASS locally** | Three materially different editable style systems plus explicit Raw Manim technical preview |
| AC-12 optional AI | **PASS with live-provider unqualified** | Complete manual workflow, labelled deterministic fallback, typed review/apply/undo, mocked strict boundary; no real-call claim |
| AC-13 render/export | **PASS locally** | Deterministic Python, pinned private sidecar, queue/cancel/retry/still, exact landscape/portrait decoded downloads |
| AC-14 representative project | **PASS locally** | Editable five-shot 52-second project and verified source/package/media/render/frame/parity/manifest evidence |
| AC-15 stress | **PASS for stated scope** | 10 shots/150 objects/250 clips/400 keys/90 audio seconds; headless and browser receipts within recorded budgets |
| AC-16 layout/accessibility | **PASS automated gate; human frontier retained** | Required viewports, empty serious/critical axe and runtime-error arrays; independent visual review found no P0/P1 |
| AC-17 deployment | **PASS only via exact external blocker** | Local production topology/runbook exercised; no Railway/authenticated project or authorized HTTPS host/domain/certificate exists; no remote claim |
| AC-18 documentation | **PASS locally** | Reconciled docs, relative links, explicit no-license and scope boundaries, stale-claim/public-safety scans |
| AC-19 full quality gate | **PASS** | Exact command ledger below; fresh independent review reports no P0/P1/P2 findings |
| AC-20 publication | **EXTERNAL RECEIPT** | Candidate push, clean clone, remote-main fast-forward, annotated `v1.0.0`, and remote SHA/tag verification are not self-recorded in this immutable payload |

## Command ledger

These are the stabilized local receipts supplied for 2026-08-30 qualification. Publication-only
remote operations are deliberately separate.

| Gate | Exact command | Result |
|---|---|---|
| Locked install | `npm ci` | **PASS** — 507 packages installed, 508 audited, 0 vulnerabilities; upstream notices were non-failing |
| Full Jest | `npm test -- --runInBand` | **PASS** — 68/68 suites, 1,106/1,106 tests, 0 snapshots, 189.34 s |
| TypeScript | `npm run typecheck -- --pretty false` | **PASS** — `tsc --noEmit` |
| Production build | `npm run build` | **PASS** — Next.js 16.3.2 webpack build, 26 route rows |
| Renderer | `npm run test:renderer` | **PASS** — 578/578 tests in 35.47 s; one upstream deprecation warning |
| Browser/restart | `npm run test:e2e` | **PASS**, exit 0 — viewport journeys 3/3 plus restart 1/1; executions 4, skipped 0, retried 0, failures 0; restart 1,703 ms |
| Browser stress | included in `npm run test:e2e` | **PASS** — 10/150/250/400/90 fixture; owner-UI import 395 ms; interaction 3,481 ms; aggregate/media/playback/autosave/reload assertions true |
| Headless stress | `npm run stress:benchmark` | **PASS** — five iterations; all samples below budgets; exact current metrics below |
| Genuine retained render | `npm run render` | **PASS** — Manim 0.21.0, H.264/AAC, 1,637,395 bytes, SHA-256 `2c4d554b2985e25568c97223a6818d98e2f677732d8a2f4b81cde07135703645`, 1280x720 at 30 fps, 52.166667 s, 1,565 frames, 2,496,512 audio samples |
| Native-shape parity | `npm run test:parity` | **PASS** — exact five-object base fixture; 5/5 ellipse, polygon, dashed line, double arrow and freeform path geometry/topology cases; failures `[]` |
| Artifact verification | `npm run artifacts:verify` | **PASS** — 50 manifest members plus the manifest itself; regular-file byte/SHA and semantic verification |
| Production dependencies | `npm audit --omit=dev --audit-level=high` | **PASS** — 0 vulnerabilities |
| Formatting safety | `git diff --check` | **PASS** |
| Documentation scans | repository-relative link and stale/public-claim `rg` scans | **PASS** — no broken local Markdown target, stale finalization placeholder, or contradictory live/publication claim |
| Local deployment qualification | isolated production-TLS Compose/auth/private-render/restart/backup/restore smoke plus final slim-runtime maintenance gate | **PASS** — asset-bearing 1,630,208-byte source backup (SHA-256 prefix `e2edfe2e`) restored and re-backed-up (SHA-256 prefix `c086c0a3`); sessions/rate state sanitized; task resources removed |
| Remote deployment smoke | runbook flow on an authorized target | **EXTERNALLY BLOCKED** — no Railway CLI/authenticated project or authorized host/domain/certificate; no public URL claimed |
| Fresh final independent code review | stabilized candidate review | **PASS** — no P0/P1/P2 findings |
| Clean GitHub clone and remote publication | exact candidate clone, ref checks, `main` fast-forward, annotated tag | **EXTERNAL AC-20 RECEIPT** |

The browser gate also asserted empty console/page-error, failed-request, and HTTP 5xx arrays. Axe
serious/critical findings were empty for the exercised initial, edited, 1024x768, and portrait-output
states. These are automated checks, not an accessibility-conformance claim.

## Browser journey and output receipts

| Journey/output | Receipt |
|---|---|
| Manual creation/save/refresh | **PASS** — login/dashboard/blank and sample projects; text, math, axes, graph, arrow/annotation, direct transform, exact parameters, keyframes/easing, playback, autosave and reload |
| Audio/captions/render | **PASS** — deterministic WAV, waveform, trim/placement/volume key, SRT import/export, synchronized preview and fully decoded landscape H.264/AAC |
| Fallback proposal/apply/undo | **PASS** — labelled deterministic fallback, screenshot-aware typed diff, explicit apply and exact single-action undo; no live model claimed |
| Package round trip | **PASS** — browser-exported 1,531,406-byte package, SHA-256 `531c401fb47b7b1e9ee15ca1afc8f209f6d19c707a43f9614ad99a7d36e5bf73`, stable internal IDs and asset/media persistence |
| Fresh context / restart | **PASS** — server-owned project/assets reopened; portrait project, two audio assets and decoded waveforms survived controlled restart in 1,703 ms |
| Landscape UI MP4 | **PASS** — 1,766,973 bytes, SHA-256 `46dbe9395070c695c360d40b56717cbfadb4199bbd48bbee80f80b90d494c54e`, H.264/AAC, 1280x720 at 30 fps, 59.666667 s, 1,790 frames, 2,856,960 audio samples |
| Portrait UI MP4 | **PASS** — 23,819 bytes, SHA-256 `2509320a6c0f0e8405f5cad64c62ba860f21367261a21d97152b48cca43f2834`, H.264 with no expected audio, 480x854 at 24 fps, 2.541667 s, 61 frames |
| Playhead still | **PASS** — 82,576-byte 1280x720 PNG, SHA-256 `72f21d915cfcad951202363bf9d82430506189d053e3050dc834c2505ea632e8`, fully decoded |
| Cancel/retry | **PASS locally** — client/API/sidecar suites cover bounded cancellation and retry semantics |

## Retained artifact ledger

The root manifest binds 50 members. This table was independently recomputed from the current
`examples/proofcanvas/artifact-manifest.json` entries and actual files, then adds the manifest itself
as row 51. Metadata-vs-file mismatches: **0**.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `examples/proofcanvas/uncountable-yet-zero-length.proofcanvas.json` | 77989 | `27267836323cd5aa9b2726221120375c59a7f02feac101872f4ba790d492fe19` |
| `examples/proofcanvas/uncountable-yet-zero-length.py` | 43383 | `6b553c27ee5635f2762d4fd7b7e5c86f96919bb4deb6092693fe4ec1bdf5705d` |
| `examples/proofcanvas/proofcanvas-deterministic-pulse-90s.wav` | 1440044 | `c3346b09725f0faa637b1e1eb4b3ab520cbf522d44ef80e5c406c9b0de9a20af` |
| `examples/proofcanvas/uncountable-yet-zero-length.proofcanvas` | 1519113 | `5a60fd5288ff354beffb955625872f3004f7f3fa1a80c16557c2a5b8ed63a974` |
| `examples/proofcanvas/uncountable-yet-zero-length.srt` | 1073 | `dfd780c5607bb0761ea77f188f48eb8d35b26a4c8ae115444eacbf5398f5ba09` |
| `examples/proofcanvas/browser-import-proof-caption.srt` | 68 | `70fc287d6abbc10d6fa1eca61425b9bb19278d8599cc8baba4df14bed8dc1363` |
| `examples/proofcanvas/ai-command-results.json` | 14246 | `4364b13908f8aa1408e3183b48684120dec1200f1f01b7429ce0695692db60f7` |
| `examples/proofcanvas/uncountable-yet-zero-length.mp4` | 1637395 | `2c4d554b2985e25568c97223a6818d98e2f677732d8a2f4b81cde07135703645` |
| `examples/proofcanvas/render-metadata.json` | 1215 | `9d8721937371e1c8e8f76660a87746bf5ce9ff9e5d379cd633f9e57bffc1b902` |
| `examples/proofcanvas/stress-results.json` | 2021 | `cec044911793e4f2f295e4495579c1062a33823b398f5b721075a1b50d442fa1` |
| `examples/proofcanvas/evidence/browser-summary.json` | 7427 | `549c22164a195995f5c5614a1f91d847b87e321a6295e4a8bc0f5c631e16a2cf` |
| `examples/proofcanvas/evidence/proofcanvas-dashboard-1920x1080.png` | 56490 | `1ff341d18434343e260d1a3f274be4b3b354af96e3bfa11a63e313e3f3ed93d5` |
| `examples/proofcanvas/evidence/proofcanvas-blank-editor-1920x1080.png` | 116364 | `926bea23bea289d7d9caa55ad6361e13e75208f3118346bf3058da08564ac85b` |
| `examples/proofcanvas/evidence/proofcanvas-selected-text-1920x1080.png` | 222757 | `858349cb84926f5fd8bc82c59ac16db229a726af248dd509bc0fc1ac0c017ca6` |
| `examples/proofcanvas/evidence/proofcanvas-selected-graph-1920x1080.png` | 156782 | `b30fa10cb21ba9d1178b234da5e52589083bd1342eebdd1686cfca7181fc7d4a` |
| `examples/proofcanvas/evidence/proofcanvas-timeline-keyframes-1920x1080.png` | 211002 | `41e734b3338554b316b272f64813aa579717e0c0d03313c45792c4c9b1784424` |
| `examples/proofcanvas/evidence/proofcanvas-style-lab-1920x1080.png` | 211298 | `e664498114b7a52fb6c1a1f2a8f87d980313b97570501701ae2142ad353ea6db` |
| `examples/proofcanvas/evidence/proofcanvas-style-nocturne-chalk-1920x1080.png` | 222347 | `bacc554b36c1b1282dc352452a2167d549f5078391774d52886513256b59a506` |
| `examples/proofcanvas/evidence/proofcanvas-style-scientific-minimal-1920x1080.png` | 220297 | `f09c07125c74a601fe6c04f966306d11b60680f3da8f5c9df55d34c3f2509f94` |
| `examples/proofcanvas/evidence/proofcanvas-animation-inspector-1920x1080.png` | 197237 | `60211cd25dcb5d64a80a7fd6e709043e501210bba6a33b836281160d999274d2` |
| `examples/proofcanvas/evidence/proofcanvas-ai-proposal-review-1920x1080.png` | 224124 | `f284f2f596533d47e8763ab6cf036b8ba121f5b3f7cc861b05ec08bf953f1de8` |
| `examples/proofcanvas/evidence/proofcanvas-render-dialog-1440x900.png` | 181745 | `e4e3455da72b9f42b18838eab00f663e96b1072fe8a065e02870c2e4933e22bf` |
| `examples/proofcanvas/evidence/proofcanvas-editorial-1920x1080.png` | 191740 | `ce015a39ed7ea92d06e22cd874eb2c124faa6220bc83b7ee96db1a65a42c0b1f` |
| `examples/proofcanvas/evidence/proofcanvas-editorial-1440x900.png` | 153594 | `4c4f0a8a3191825f8f9b0b1213a63207604fc8ec1c445fd02db3a25e02fd5551` |
| `examples/proofcanvas/evidence/proofcanvas-editorial-1280x800.png` | 158328 | `5bec536ed1fd0aea196faea669476eb5e680f9477f1a09009fb62b7814f8eb37` |
| `examples/proofcanvas/evidence/proofcanvas-narrow-editor-1024x768.png` | 110109 | `122c13c0f52fe7bd555f5deb6142a5658043503e239c62cbfda98c7d29bbbfdb` |
| `examples/proofcanvas/evidence/proofcanvas-portrait-output-1440x900.png` | 122907 | `1bbd170ae15cf5ebfcd3d1acb8899659fc98af7eb9ff482daa2027bd24b2e1f8` |
| `examples/proofcanvas/evidence/proofcanvas-still-current.png` | 82576 | `72f21d915cfcad951202363bf9d82430506189d053e3050dc834c2505ea632e8` |
| `examples/proofcanvas/render-evidence/proofcanvas-manim-frame-12s.png` | 86190 | `e6d221786a74e46e4c1d04bfe96b4a6a02cc6273db8f89b10852a50c02c51acb` |
| `examples/proofcanvas/native-shape-parity/authoring-desktop-1440x900.png` | 143708 | `35f81569ee1e416f42de0f06d0b3d03539dbd6b6d9dd1b2ca3100f6005c4975b` |
| `examples/proofcanvas/native-shape-parity/authoring-locked-1440x900.png` | 152180 | `3125dd8bc65ddcd65cc30db787b662da2e8a3adcca8753245db781b6e118501b` |
| `examples/proofcanvas/native-shape-parity/authoring-playback-1440x900.png` | 145561 | `39d3c7b4b6f04591e9fbe415d41436f8f63d965b70f723341a79778c9eadf1bd` |
| `examples/proofcanvas/native-shape-parity/authoring-portrait-1024x1366.png` | 205462 | `94b8e275237cd40533cc8b2a24e9f677b4b703c97d9282bc2ed4dfbbccb63806` |
| `examples/proofcanvas/native-shape-parity/browser-authoring.json` | 4057 | `b3cc5cf3bbbc98721187abb9bd2966c7c722d497e1cbed33f1d474d3ad2c0cd8` |
| `examples/proofcanvas/native-shape-parity/browser-capture.json` | 3941 | `4cf82604f896cdfe5fd2b0aea7389906260eb2d027316a2b9f7a36dc22cafe8a` |
| `examples/proofcanvas/native-shape-parity/browser-report.json` | 2893 | `eb460af6d9f4505207737ed64ed1eddb67e7b6ee2bce1b283f2f714e46b76c6a` |
| `examples/proofcanvas/native-shape-parity/browser-stage.png` | 12006 | `d37b6c96bae43ce701bf19b53f7da5ac3852e4e016ba77ed3283130ad8ed7614` |
| `examples/proofcanvas/native-shape-parity/browser-stage.svg` | 3782 | `4f5dfa6b35bc188d5e55f1fb2ced323ac4716faa6306a181a60af726c3df876a` |
| `examples/proofcanvas/native-shape-parity/comparison-dashed-line.png` | 1043 | `50ad8011a828411a9b85b61b032d8b3d424017bdfd24876697c2f2775ea03021` |
| `examples/proofcanvas/native-shape-parity/comparison-double-arrow.png` | 1051 | `a6b3d33e12171dcd93e63d62eb246a723489391767cd54ea35ae0b28d7e4db17` |
| `examples/proofcanvas/native-shape-parity/comparison-ellipse.png` | 1142 | `1170b51dc7b90aab666269f2187a364fd35dc7015d76097c3dd4b5c505dd1338` |
| `examples/proofcanvas/native-shape-parity/comparison-freeform-path.png` | 1235 | `c83434a09a290ab7ee05c763b13707c8421498086e45245f9dd80d756fd23d05` |
| `examples/proofcanvas/native-shape-parity/comparison-polygon.png` | 1035 | `b0f5b208f6f6012e835181856f09d1322f40e30738626a379d01ed8415d6d52a` |
| `examples/proofcanvas/native-shape-parity/compiler.json` | 795 | `5c0b63c90f3789050d3b1cf6f23bfbd03c192025e73354d7e82ab418515e5cb0` |
| `examples/proofcanvas/native-shape-parity/evidence-manifest.json` | 35913 | `588979f32eaac16fbde8f6eec15e62fd80ba2b84e8932d3c89a6b820c032bd49` |
| `examples/proofcanvas/native-shape-parity/generated.py` | 2835 | `eb59c5ea3a806d124e75ecb8109ca3dbaba6a8af0053ebd6a348bf58f2ea3c8b` |
| `examples/proofcanvas/native-shape-parity/manim-frame.png` | 13673 | `4b411d98bb204e6327f3ac6f736de863fcb783b46be3a24dab4f2ef196fc9afe` |
| `examples/proofcanvas/native-shape-parity/manim-render.log` | 218 | `79c122e77a0b6eb1ff716e8567a7c5b3a8d763a72c2f3083bf06ec033da57499` |
| `examples/proofcanvas/native-shape-parity/parity-report.json` | 43565 | `7f0215469ef6c5bc9ef0f31fc259d858d2bba7f518ec3da9c2063b83f3b885e2` |
| `examples/proofcanvas/native-shape-parity/project.proofcanvas.json` | 12961 | `7086e1e445c778a5d9b965553076d27c67fe1b4fd348e860a8c6562a51719be7` |
| `examples/proofcanvas/artifact-manifest.json` | 8807 | `47c31c97e1b1f88f152327e98cfcf28f27b52198632fd0f53651caf3838430fa` |

The retained render metadata binds project SHA-256
`27267836323cd5aa9b2726221120375c59a7f02feac101872f4ba790d492fe19`, retained package
`5a60fd5288ff354beffb955625872f3004f7f3fa1a80c16557c2a5b8ed63a974`, generated source
`6b553c27ee5635f2762d4fd7b7e5c86f96919bb4deb6092693fe4ec1bdf5705d`, deterministic audio
`c3346b09725f0faa637b1e1eb4b3ab520cbf522d44ef80e5c406c9b0de9a20af`, video
`2c4d554b2985e25568c97223a6818d98e2f677732d8a2f4b81cde07135703645`, and decoded frame
`e6d221786a74e46e4c1d04bfe96b4a6a02cc6273db8f89b10852a50c02c51acb`. The browser round-trip
package is a separate journey artifact. Captions are retained as SRT and are not claimed as burned-in
pixels.

## Stress receipt

The deterministic fixture has 10 shots, 150 objects, 250 animation clips, 400 keyframes, 90 audio
seconds, 314,885 canonical bytes, and SHA-256
`7bb4b480d484e123c572433307a8e6b9955817148308476d30dc01554aa75a4c`. Across five headless
iterations every sample passed:

| Operation | Median / maximum | Budget |
|---|---:|---:|
| Fixture creation | 17.403 / 18.145 ms | 5,000 ms |
| Editor load | 15.203 / 23.358 ms | 5,000 ms |
| Timeline interaction | 0.265 / 0.277 ms | 2,000 ms |
| Playback sampling | 3.653 / 4.273 ms | 3,000 ms |
| Selection | 0.058 / 0.089 ms | 2,000 ms |
| Inspector update | 30.633 / 32.634 ms | 5,000 ms |
| Autosave serialization | 14.353 / 15.360 ms | 2,000 ms |
| Compilation | 187.466 / 229.741 ms | 10,000 ms |

These are Linux/Node shared-core timings, not a universal hardware, browser-frame-rate, or human-
usability claim.

## Review findings and evidence boundaries

Prior independent correctness, test, timeline, compiler, storage, security/deployment, UX, and visual
reviews produced source-level findings that were repaired and regression-tested before this packet.
The retained visual review reported **no P0/P1 visual findings**. Its one P2 evidence-scope finding is
now resolved in self-describing evidence:

- The five-object project SHA-256
  `7086e1e445c778a5d9b965553076d27c67fe1b4fd348e860a8c6562a51719be7` is the exact base fixture
  captured by both `browser-stage.png` and genuine `manim-frame.png` for the five parity cases.
- The later ten-object screenshots exercise manual insertion, locked/refusal states, playback,
  persistence, responsive layout, and portrait reframing. They are deliberately marked
  `renderQualified: false` and are not represented as post-edit browser/Manim parity proof.

Final independent review of the stabilized candidate passed with no P0/P1/P2 findings. The last
review/repair cycle also closed these concrete release risks:

- the slim runtime now carries the exact maintenance dependency graph needed for backup/restore;
- durable reset and JSON guards fail closed instead of admitting stale or malformed authority;
- restore sanitizes sessions and rate-limit state, forcing a fresh owner login;
- package download retries preserve and verify the authoritative SHA rather than accepting a changed
  retry payload; and
- asset lifecycle waits are strict barriers, with request failures attributed to the correct asset
  diagnostic rather than hidden or misclassified during normal media teardown.

Static screenshots still cannot prove interaction feel, scroll discoverability, motion quality,
focus transitions, or human taste.

## Deployment proof and exact blocker

The isolated Compose qualification run `20260827T010753Z-2583029` used project/volume namespace
`proofcanvas-ac17-20260827t010753z-2583029`. It exercised real loopback TLS, secure cookies,
auth/Origin/CSRF refusal, private renderer boundaries, web-process persistence, and an exact
118,784-byte off-volume backup/atomic-restore receipt with SHA-256
`38e6124675077530b06a991a66e63d2b8486b9cf0a353c65337bf35cd541ec84`; task containers, images,
volume, generated credentials, certificate, cookies, and scratch were removed after success.

Read-only inspection on 2026-08-30 found Docker `29.7.1` and Compose `v5.3.1`, but no Railway CLI,
authenticated Railway project, Caddy/nginx/Traefik executable, authorized public host/domain, TLS
certificate, or production secret context. No provider, DNS, or remote-service write was attempted.
The exact one-time action is therefore:

> Install and authenticate Railway CLI and grant/select one authorized project for two services,
> private networking, a local-locking persistent volume, a generated HTTPS domain, health checks,
> and server-side secrets; then execute the remote smoke and backup/restore drill in
> [`DEPLOYMENT.md`](./DEPLOYMENT.md).

An explicitly authorized host satisfying the documented HTTPS/local-locking/private-renderer
topology is an alternative. Until one target is supplied and smoke-tested, there is **no hosted URL,
hosted health receipt, or production persistence claim**.

## Known limitations and human-required frontiers

- **Single owner/writer.** No signup, password reset, organizations, collaboration, distributed lock,
  or horizontal SQLite scale. Trusted ingress must add source-aware login throttling.
- **Ephemeral rendering.** One job runs and one waits; results expire after ten minutes; sidecar
  restart loses queued/running/completed jobs.
- **In-memory packages.** Package build/import is bounded but not streaming.
- **Media boundaries.** M4A is unsupported; advanced SVG crop/cover/fill/masking fails closed; SRT is
  separate and not burned into MP4 by default.
- **Preview parity.** Browser SVG/KaTeX and Manim/Cairo are different engines. Only the exact retained
  five-object cases and recorded tolerances are render-parity evidence.
- **Live AI.** No real Responses request was retained; fallback/mocked evidence does not prove general
  model quality or reliability.
- **Platform.** Renderer/browser shell gates target x86_64 Linux, Bash 4+, Docker, and GNU `timeout`.
- **Human frontiers.** Automation and screenshot review do not certify mathematics, assistive-
  technology conformance, universal usability, privacy/rights clearance, or editorial excellence.
- **License.** No project license exists; redistribution/modification rights must not be assumed.

## Publication decision

This embedded record freezes the prepublication decision; AC-20 receipts are **external**. Local
AC-01 through AC-19 and fresh independent review pass; AC-17 expressly permits the exact external
deployment blocker without fabricating a remote deployment. Publication fails closed if the intended
staged set contains private/generated local state, the pushed candidate differs, clean-clone
verification fails, remote `main` moved unexpectedly, or the benchmark tag changed. After those
checks, the operator may fast-forward `main`, create one annotated `v1.0.0`, push without rewriting
history, and record the exact remote SHA/tree/tag-object receipt externally.
