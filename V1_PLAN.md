# ProofCanvas V1 implementation plan

This plan maps the requested V1 work to the frozen acceptance contract in
`.codex/quality-loop/proofcanvas-v1/QUALITY_CONTRACT.md`. A checked item means the engineering slice
has been implemented and tested; it does not imply that the complete V1 acceptance criterion has
passed.

## Milestone 1 — authoritative V2 timeline foundation

Acceptance criteria: AC-02, AC-07, AC-08.

- Upgrade `ProjectDocument` to schema version 2 through a deterministic V1-to-V2 migration.
- Add bounded project settings, portable asset metadata, object lifetimes, property/keyframe tracks,
  audio clips, captions, markers, custom easing presets, stable IDs, and global references.
- Add deterministic timeline indexing and sampling for numeric, colour, hold, eased, and custom
  cubic-Bezier tracks.
- Extend atomic operations/history for lifetimes, property tracks, and keyframes.
- Apply supported visual and camera tracks in browser preview and deterministic Manim compilation.
- Preserve the published semantic animation schedule and fail closed on unsupported collisions.
- Evidence: migration, schema, timeline, operation/history, preview, compiler, type and build tests.

This milestone does not add the final timeline UI, audio playback, asset ingestion, persistence, or
renderer asset/audio transport. Those remain explicitly unqualified after Slice 1.

Slice 1 also intentionally fails closed on compiler features that need later scheduling or transport
work: property tracks whose first keyframe is after time zero, partial object lifetimes,
hold/custom-Bezier segments, audio clips/tracks, and raster/SVG asset transport. Browser preview
remains exact for delayed tracks and opacity-only assets, but these cases are not claimed as
renderable until the final timeline/compiler and asset/audio milestones implement them.

## Milestone 2 — private persistence and project dashboard

Acceptance criteria: AC-03, AC-04, parts of AC-05 and AC-18.

- Add private owner authentication, signed expiring sessions, CSRF protection, and logout.
- Add a SQLite-backed repository abstraction, migrations, optimistic revisions, autosave,
  checkpoints, recovery, duplicate/delete, backup, and restore.
- Add dashboard CRUD and route the editor through a durable project ID.
- Prove cross-browser and process-restart persistence.

Slice 2 implements the engineering path: no-signup owner login; opaque expiring sessions and
session-bound CSRF; protected dashboard/editor/AI/render routes; a checksummed STRICT SQLite
repository; revision-CAS and idempotent mutations; autosave; explicit local recovery; checkpoints;
duplicate/soft delete; validated online backup and offline restore; and live/ready endpoints.
Automated Node/jsdom coverage proves repository reopen, two-connection CAS, API authentication,
autosave serialization, and recovery semantics. Fresh real-browser, container-restart, and hosted
persistent-volume evidence remains a Milestone 6 qualification item rather than an implementation
claim.

## Milestone 3 — professional editor and manual authoring

Acceptance criteria: AC-05, AC-06, remaining AC-07 and AC-08, AC-11, AC-16.

- Decompose the editor shell into resizable library, canvas, contextual inspector, shot sequence,
  multilayer timeline, top bar, dialogs, and subordinate assistant drawer.
- Add playback, ruler, zoom/scroll/snap, layered tracks, clip/keyframe selection and editing,
  lifetimes, markers, keyboard commands, marquee, guides, canvas zoom/pan, and exact inspector
  diamonds.
- Complete object/component/property coverage and Style Lab with three materially distinct styles.
- Validate required desktop and portrait-authoring viewports in a real browser.

### Milestone 3.1 — shared core and schema-v3 timeline

- Make logical frame dimensions authoritative for landscape, portrait, and square authoring while
  keeping geometry independent from editable project-local style starting points.
- Add typed document/shot/marker/style/easing operations, conservative split/merge, delayed and
  hold keyframe scheduling, partial lifetimes, and bounded custom cubic-Bezier compilation.
- Move compiler-bound persisted time from schema-v2 floats to schema-v3 10 ns ticks. The database
  migration preserves exact canonical V2 bytes and rewrites a project or checkpoint only when all
  authored temporal relations remain injective and ordered after quantization.
- Quarantine only the individual loss-prone document. A current project becomes read-only with an
  authenticated byte-exact JSON export; a loss-prone historical checkpoint blocks only its own
  recovery and export remains available even if its ready parent project is later soft-deleted.
- Keep legacy render-unsupported easing combinations loadable, but reject them at every new
  authoring/copy/provider ingress. Permit unrelated edits, deletion, or the exact easing-only repair.

## Milestone 4 — assets, packages, audio, and captions

Acceptance criteria: AC-09 and AC-10.

- Add content-sniffed project-local assets, SVG sanitisation, hash deduplication, safe storage, and
  bounded portable `.proofcanvas` import/export.
- Add waveform generation, audio placement/trim/split/volume/fades/keyframes, synchronized playback,
  captions, SRT/VTT handling, and deterministic fixtures.

## Milestone 5 — complete rendering and representative project

Acceptance criteria: AC-13, AC-14, AC-15.

- Extend the private render protocol for V2 profiles, trusted assets, safe audio muxing, captions,
  cancellation/retry, stills, durable recent results, and verified A/V metadata.
- Expand the editable Cantor project to the required 45–60 second, five-shot V1 example.
- Add and measure the deterministic stress fixture before optimizing hot paths.

## Milestone 6 — qualification, deployment, and publication

Acceptance criteria: AC-12 and AC-16 through AC-20.

- Run fresh correctness, test, timeline, compiler, security, UX, performance, and visual-authorship
  reviews; repair all confirmed P0/P1 and adjudicate P2 findings.
- Complete local production qualification, retained evidence, documentation, secret scans, genuine
  landscape/portrait A/V renders, package round trip, accessibility checks, and clean-clone proof.
- Attempt the authorized deployment flow only after local gates pass.

## Deployment blocker context

No hosted deployment has been attempted in Milestone 1. Railway authentication, project access,
persistent-volume availability, private service networking, and production secrets have not yet
been verified. This is currently an untested external-deployment prerequisite, not the single
credential blocker allowed by AC-17. ProofCanvas must not be described as hosted or production-ready
until the deployment milestone proves the exact blocker or qualifies a live HTTPS installation.
