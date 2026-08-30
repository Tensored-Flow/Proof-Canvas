# ProofCanvas V1 plan

This plan maps the implemented release payload to the frozen acceptance contract summarized in
[`V1_AUDIT.md`](./V1_AUDIT.md). The local AC-01 through AC-19 qualification packet and fresh
independent review are complete as of 2026-08-30 UTC with no P0/P1/P2 findings. AC-17 uses the
contract's exact unavailable external deployment-target blocker. AC-20 receipts are intentionally
external to this self-identifying payload and must be verified from the remote refs.

## Status vocabulary

- **Locally qualified** — implementation and reproduced local evidence pass within the stated scope.
- **Externally blocked** — an authenticated, authorized deployment target is unavailable.
- **External publication receipts** — the remote branch, clean clone, `main` fast-forward, and
  annotated tag are verified outside the immutable release payload.

## Milestone 0 — standalone baseline and contract

Acceptance criteria: AC-01 and the working constraints. Status: **locally qualified; publication
identity recorded externally**.

- The standalone repository, `main`, `codex/proofcanvas-v1`, and immutable annotated
  `v0.1-autonomous-benchmark` baseline exist.
- No unrelated workspace, package, remote, style, dependency, or source path is part of ProofCanvas.
- The final release SHA/tree cannot be self-recorded by its own commit; AC-20 must record it from the
  pushed refs and tag object after that commit exists.

## Milestone 1 — authoritative document and time foundation

Acceptance criteria: AC-02, AC-07, AC-08. Status: **locally qualified**.

- `ProjectDocument` V4 is the sole editable authority and preserves registered V1/V2/V3 migration
  semantics with loss-aware archival/quarantine.
- Integer ticks, global references, lifetimes, clips, property tracks, keyframes, cameras, media,
  captions, markers, easings, and output settings share one strict schema.
- Preview and compiler share deterministic ordering, conflict, interpolation, gap, and duration
  authority; unsupported combinations fail closed at authoring/render ingress.

## Milestone 2 — private auth, persistence, and dashboard

Acceptance criteria: AC-03, AC-04. Status: **locally qualified**.

- Owner-only scrypt authentication, signed opaque sessions, exact Origin, session-bound CSRF,
  logout revocation, and bounded login admission are implemented and exercised.
- Checksummed STRICT SQLite provides durable CRUD, revision CAS, idempotency, checkpoints/recovery,
  soft deletion, migrations, integrity, online backup, and offline atomic restore.
- Fresh-context and controlled-process-restart journeys reopened server-owned project and asset state.

## Milestone 3 — professional manual authoring

Acceptance criteria: AC-05 through AC-08, AC-11, AC-16. Status: **locally qualified within the
desktop-first V1 boundary**.

- The editor provides direct canvas manipulation, library, inspector, layers, storyboard, layered
  timeline, exact keyframes, camera, project settings, focus-canvas mode, zoom, shortcuts, snapping,
  groups/layout, styles, and manual operation with AI disabled.
- Landscape, narrower-laptop, and portrait-output journeys passed automated overflow, console,
  request, and serious/critical axe checks. These do not certify assistive-technology conformance,
  universal usability, or subjective visual quality.
- Independent retained-evidence review found no P0/P1 visual defect. Its P2 evidence-scope finding is
  resolved by distinguishing the exact five-object browser/Manim parity fixture from the later
  ten-object authoring/control/refusal/layout screenshots; the latter are not post-edit render proof.

## Milestone 4 — assets, packages, audio, and captions

Acceptance criteria: AC-09, AC-10 and media portions of AC-13. Status: **locally qualified**.

- Trusted project-local PNG, JPEG, WebP, sanitized SVG, WAV, and MP3 storage is bounded by content,
  structure, decode, metadata, hash, aggregate, and filename authority. M4A remains unsupported.
- Canonical `.proofcanvas` packages preserve internal IDs and assets/media while allocating a fresh
  imported project identity; adversarial path/type/size/archive grammar and replay cases fail closed.
- Audio waveform/edit/playback/mux and SRT/VTT caption editing/import/export are exercised through
  unit, browser, restart, package, and decoded-output evidence.

## Milestone 5 — render/export and representative V1 project

Acceptance criteria: AC-13 through AC-15. Status: **locally qualified**.

- The private sidecar validates generated source, referenced assets, numeric audio plans, output
  settings, resource bounds, queue/cancel/retry/still behavior, and H.264/AAC decode metadata.
- The retained five-shot, 52-second example includes canonical JSON, package, WAV, SRT, generated
  Python, genuine Manim MP4, decoded frame, parity evidence, and a 50-member root manifest.
- The deterministic stress fixture is 10 shots, 150 objects, 250 clips, 400 keyframes, and 90 audio
  seconds. Its measurements are headless shared-core evidence, not browser-frame-rate or human-
  usability proof.

## Milestone 6 — AI, deployment, docs, review, and publication

Acceptance criteria: AC-12, AC-16 through AC-20. Status: **local qualification and independent review
complete; deployment externally blocked; publication receipts external**.

- Manual operation is complete without AI. The optional configured path accepts only bounded typed
  operations; the fallback is visibly labelled deterministic demonstration. No live-provider claim
  is made.
- Documentation, artifacts, dependency/security gates, production browser/restart journeys, parity,
  and local production-TLS Compose qualification have current receipts in `V1_AUDIT.md`.
- No Railway CLI/authenticated project, authorized host/domain/certificate, or production secret
  context is available. AC-17 therefore passes only through the exact blocker path and makes no live
  persistence, health, or hosted-URL claim.
- Fresh final independent review passed with no P0/P1/P2 findings.

## Acceptance-state summary

| Contract area | Embedded qualification state |
|---|---|
| AC-01–16 | **Locally qualified** within the evidence and human-review boundaries in `V1_AUDIT.md` |
| AC-17 deployment | **PASS only via exact external blocker**; no remote production deployment or URL |
| AC-18 documentation | **Locally qualified**; current receipts and limitations reconciled |
| AC-19 full quality gate | **PASS** — local executable gates and fresh independent review complete; no P0/P1/P2 |
| AC-20 publication | **EXTERNAL RECEIPT** — branch push, clean clone, `main` fast-forward, annotated `v1.0.0`, remote verification |

## Publication runbook

1. Stage only intended repository files, excluding secrets, databases, caches, local environments,
   and ignored agent state; commit and push `codex/proofcanvas-v1` without rewriting history.
2. Clone that exact remote candidate into a fresh directory and rerun the documented install,
   typecheck, build, artifact-verification, and ref checks.
3. Re-fetch and require the documented remote `main` baseline, then fast-forward `main` without
   force. Create one annotated `v1.0.0` only at the verified release commit.
4. Verify remote candidate/main/tag commit equality plus tag object/peeled target, and record the
   immutable release SHA/tree/tag receipt outside the self-identifying release commit.
