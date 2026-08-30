# ProofCanvas

ProofCanvas is a private, single-owner editor for authoring mathematical motion visually and exporting
deterministic, readable Manim Python and genuine MP4 video. The versioned `ProjectDocument` is the
only editable source of truth: generated Python is output, and optional AI returns validated scene
operations rather than executable code.

## Release status

This tree is the **ProofCanvas V1.0.0 release payload**. Local AC-01 through AC-19 qualification and
fresh independent review pass with no P0/P1/P2 findings. AC-17 passes only through the contract's
exact unavailable-credential/host blocker: no production URL has been verified and no live-service
claim is made. GitHub publication receipts are external to this self-identifying payload and remain
intentionally unembedded: verify that its branch was pushed, verified from a clean clone,
fast-forwarded to `main`, and named by one annotated `v1.0.0` tag. Exact local receipts and
limitations are in
[`V1_AUDIT.md`](./V1_AUDIT.md).

The checked-in **Uncountable, Yet Zero Length** project is a five-shot, 52-second editable example
with deterministic audio and captions. Retained source, package, media, stress, and visual evidence
live under [`examples/proofcanvas/`](./examples/proofcanvas/).

## What the owner can do

- Sign in to a no-sign-up owner workspace and create, rename, duplicate, checkpoint, recover, and
  soft-delete durable projects.
- Author text, safe mathematical notation, axes, restricted function graphs, sixteen shape presets,
  nested groups, and twelve editable semantic components on a direct-manipulation SVG canvas.
- Arrange ordered shots and edit object lifetimes, semantic animation clips, camera motion, property
  tracks, exact keyframes, easing, markers, captions, and layered audio on a sequence timeline.
- Import project-local PNG, JPEG, WebP, sanitized SVG, WAV, and MP3 assets. M4A is deliberately
  rejected until browser, validator, and renderer semantics are reliable end to end.
- Edit raster position, size, rotation, opacity, fit, crop, aspect preservation, and simple masks.
  Sanitized SVG renders support ordinary placement and contain-style aspect preservation; SVG crop,
  cover/fill, and masking fail closed at compilation because no bounded SVG rasterizer is trusted.
- Trim, move, split, mute, solo, fade, and keyframe audio volume; preview it against the playhead; and
  mux the audible result into a verified MP4.
- Create or import SRT/VTT captions, edit timing/text/basic styling, and export one project-sequence
  SRT. Captions are a separate deliverable and are not automatically burned into MP4 pixels.
- Export canonical JSON, readable Manim Python, a hash-bound `.proofcanvas` package, SRT, a decoded
  still PNG, and H.264/AAC MP4. Render jobs expose progress, cancellation, retry, source hash, and
  verified stream metadata while retained.
- Use the complete manual workflow with AI disabled. When configured, the OpenAI Responses route
  proposes bounded typed edits for explicit review and apply; without credentials, the UI labels its
  narrow deterministic demonstration mode.

## Local quick start

The editor requires Node.js 24 and npm. Renderer, parity, retained-artifact generation/verification,
and browser-acceptance commands additionally target an x86_64 Linux host with Docker, Git, Python 3,
ripgrep, Bash 4+, and GNU `timeout`.

```bash
npm ci
cp .env.example .env.local
```

Generate an owner password hash by piping exactly one private passphrase of 16–256 UTF-8 bytes into
the non-interactive helper. Generate an independent session secret with `openssl rand -hex 32`, then
put only the hash and secret in `.env.local`; never store the plaintext password in the repository.

```bash
read -rsp 'ProofCanvas owner passphrase: ' PROOFCANVAS_LOCAL_PASSWORD
printf '%s' "$PROOFCANVAS_LOCAL_PASSWORD" | npm run auth:hash-password
unset PROOFCANVAS_LOCAL_PASSWORD
openssl rand -hex 32
```

For local HTTP development, keep `PROOFCANVAS_APP_ORIGIN=http://127.0.0.1:3000`. Point
`PROOFCANVAS_DATA_DIR` at storage you intend to retain, then start the app:

```bash
npm run dev
```

Open <http://127.0.0.1:3000/>. `/proofcanvas` remains an authenticated compatibility redirect to the
project dashboard.

## Commands

Run commands from the repository root:

```bash
npm ci                    # install the locked dependency graph
npm run dev               # loopback-only development server
npm test                  # Jest unit, component, repository, and API-boundary tests
npm run typecheck         # TypeScript check without output
npm run build             # production Next.js webpack build
npm run test:renderer     # build and test the pinned private renderer image
npm run test:runtime-maintenance # final-image asset backup/restore and integrity drill
npm run test:e2e          # Docker-isolated production browser/render/restart journeys
npm run test:parity       # regenerate and verify bounded browser/Manim parity evidence
npm run artifacts         # regenerate canonical source/package/evidence manifests
npm run artifacts:verify  # reject missing, changed, or stale retained evidence
npm run render            # regenerate and genuinely render the retained V1 example
npm run auth:hash-password # hash one password supplied through stdin
npm run db:backup         # online, fully validated SQLite backup
npm run db:restore -- /absolute/backup.sqlite3 # offline validated restore
```

Offline restore deliberately invalidates every owner session and resets application login-rate state
before atomic publication. Restart the single web process and log in again after every restore.

`npm run test:e2e` builds the production app and sidecar, runs the checked-in Chromium journeys,
fully decodes downloaded landscape and portrait MP4s, and performs a controlled app-process restart
against the same data directory. A passing automated run is engineering evidence; it does not by
itself establish human usability, mathematical correctness, accessibility conformance, or visual
taste. See [`V1_AUDIT.md`](./V1_AUDIT.md) for exact local receipts and the external publication
receipt requirements.

## Private render sidecar

Python export works without the sidecar. UI MP4/still export requires the pinned private service and
one shared 32–256 character bearer token:

```bash
docker build -t proofcanvas-render:local services/proofcanvas-render
export PROOFCANVAS_LOCAL_RENDER_TOKEN="$(openssl rand -hex 32)"
docker run --rm --init --name proofcanvas-render \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=512 --memory=4g --memory-swap=4g \
  --tmpfs /tmp:rw,nosuid,nodev,size=3g,mode=1777 \
  -p 127.0.0.1:8080:8080 \
  -e PROOFCANVAS_RENDER_TOKEN="$PROOFCANVAS_LOCAL_RENDER_TOKEN" \
  proofcanvas-render:local
```

Configure Next.js with the same token and `PROOFCANVAS_RENDER_URL=http://127.0.0.1:8080/`, then
restart it. This convenience command binds the renderer only to host loopback, but it does **not**
deny renderer egress and is not the production isolation topology. Production must use a private
service network with no renderer egress or public port; [`compose.yaml`](./compose.yaml) demonstrates
that boundary. The exact protocol, limits, and isolation requirements are in
[`services/proofcanvas-render/README.md`](./services/proofcanvas-render/README.md).

Renderer state is process-local: one job runs, one may wait, completed artifacts expire after ten
minutes, and restart loses every pending/running/completed job. Projects and asset blobs remain in
SQLite; render artifacts do not.

## Assets, packages, and persistence

ProofCanvas stores project documents and content-addressed asset blobs in one checksummed STRICT
SQLite repository. Writes use compare-and-swap revisions and idempotent mutation IDs. Browser
`localStorage` is only an explicit, project-scoped recovery bridge and is never silently made
authoritative.

Asset upload and package import authenticate before reading the body, require exact byte framing,
sniff and decode supported content, sanitize names/SVG, bind SHA-256 and metadata, and commit project,
blob, reference, and mutation receipt atomically. A `.proofcanvas` file is a canonical, uncompressed
ZIP dialect with exact entries, CRC-32, hashes, stable internal IDs, and no filesystem extraction.
Import allocates a fresh top-level project ID and timestamps while preserving shot, object, track,
clip, caption, marker, style, easing, and asset IDs.

The transport archive ceiling is 132 MiB; one asset is at most 64 MiB; both package asset content and
durable distinct asset content are limited to 128 MiB per project; and the decoded-raster admission
sum is capped at 512 MiB per package. Distinct durable asset-blob content across one installation is
capped at 4 GiB; database metadata, sessions, histories, and retained backups consume additional
volume capacity. Package handling is intentionally in-memory and can require substantially more
memory than the archive itself; deploy with the documented memory budget and use smaller packages. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the complete limits and lifecycle.

## Optional structured AI

Set both server-only values or neither:

```dotenv
OPENAI_API_KEY=
PROOFCANVAS_OPENAI_MODEL=
```

The configured route uses strict Responses structured output and bounded scene/screenshot context.
Provider output is parsed as `SceneOperation[]`, revalidated against stable IDs and inherited locks,
applied to a clone, and shown as a diff. Provider failure is surfaced; it is never silently relabelled
as a successful fallback. No live-provider claim is made without a real retained call receipt.

## Security and deployment

All dashboard, editor, project, asset, package, AI, render-status, still, and video routes perform
owner authentication. State changes also require the exact configured Origin and a session-bound
double-submit CSRF token. Sessions use opaque signed cookies, `HttpOnly`, `SameSite=Strict`, Secure in
production, hashed server-side storage, and a maximum 12-hour lifetime. Login has bounded scrypt
admission and a global failure window; a trusted same-host ingress must add source-aware throttling.

Production is one Next.js process on local-locking persistent storage plus one private non-root render
service behind HTTPS. Do not scale the SQLite writer or Uvicorn queue horizontally. Use
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for the deployment gate, Railway/container topology, health checks,
backup/restore, and rollback procedure. [`compose.yaml`](./compose.yaml) is a hardened single-host
reference; it deliberately publishes only the web service on host loopback.

No hosted URL has been verified from this tree. The environment inspected for this release payload has
Docker and Compose but no Railway CLI/authenticated project context and no configured HTTPS ingress,
domain, or certificate. This is an external deployment prerequisite, not evidence that the site is
live.

## Important boundaries

- ProofCanvas is private single-owner software, not a multi-tenant SaaS.
- Browser SVG/KaTeX preview is deterministic but not pixel-identical to Manim. Retained parity tests
  are bounded to the cases they actually compare. The five-object base fixture is the exact
  browser/Manim comparison; the ten-object screenshots continue into a separate manual-authoring
  journey and are not represented as a render of that later document state.
- Arbitrary Python import/execution, Python round-tripping, remote asset fetching, collaboration,
  public rendering, mobile editing, 3D, physics, and traditional footage editing are out of scope.
- Automated tests do not replace human mathematical review, assistive-technology testing, privacy or
  rights review, or subjective editorial approval.

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — trust boundaries, data flow, storage, packages, renderer
- [`V1_PLAN.md`](./V1_PLAN.md) — milestone and release-gate state
- [`V1_AUDIT.md`](./V1_AUDIT.md) — current qualification ledger and external publication receipt requirements
- [`CHANGELOG.md`](./CHANGELOG.md) — V1.0.0 changes
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — production topology and operator runbook

## License

No license file is currently included. Do not assume permission to redistribute or modify this
project beyond rights granted by applicable law.
