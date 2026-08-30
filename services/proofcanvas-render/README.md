# ProofCanvas render sidecar

This FastAPI service renders only Python emitted by the ProofCanvas compiler. It is the private,
authenticated execution boundary behind the Next.js application—not a public arbitrary-Manim,
arbitrary-Python, asset-conversion, or user-script API.

## Configuration

The container requires one server-side secret:

```dotenv
PROOFCANVAS_RENDER_TOKEN=
```

The token must be 32–256 characters and exactly match the token configured for Next.js.
`PROOFCANVAS_RENDER_ROOT` is optional and defaults to `/tmp/proofcanvas-render`; it must be private,
writable, ephemeral storage owned by the non-root service user. Never expose either value through a
`NEXT_PUBLIC_` name.

Next.js requires:

```dotenv
PROOFCANVAS_RENDER_URL=http://renderer-private-name:8080/
PROOFCANVAS_RENDER_TOKEN=<same independent token>
```

The URL must be one root HTTP(S) origin with no credentials, path, query, or fragment. Use a private
service address. Use TLS whenever traffic crosses a trusted host or container boundary.

## Local build, test, and run

From the repository root:

```bash
docker build --target proofcanvas-render-test -t proofcanvas-render:test services/proofcanvas-render
docker run --rm --init proofcanvas-render:test \
  /opt/venv/bin/python -m pytest -q /app/tests
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

Then set `PROOFCANVAS_RENDER_URL=http://127.0.0.1:8080/` and the same token in the host-run Next.js
environment. The loopback command is convenient local isolation from public ingress, but it does not
deny renderer egress and is not a production topology. Use [`../../compose.yaml`](../../compose.yaml)
or an equivalent private, no-egress service network for production.

The final runtime image pins Manim Community 0.21.0 by base-image digest, installs separately locked
runtime dependencies with binary-only hash enforcement, runs Uvicorn as `manimuser`, disables access
logs and proxy-header trust, and does not copy tests. Run the complete production browser/render and
restart journey separately:

```bash
npm run test:e2e
```

Do not copy a historical or focused test count into release documentation. The final exact count
belongs in [`../../V1_AUDIT.md`](../../V1_AUDIT.md) after rerunning on the stabilized candidate.

## Private API

`GET /health` is unauthenticated for private readiness checks and returns 503 until a valid token is
configured. It reports only bounded service/version/capacity data.

Every `/v1/render` endpoint requires exact `Authorization: Bearer <token>` authentication:

- `POST /v1/render` accepts exactly
  `{source, sourceSha256, quality, output, assets, audio}` and returns an asynchronous job.
- `GET /v1/render/{jobId}` returns sanitized, process-local status, output authority, and—after
  success—verified video metadata.
- `DELETE /v1/render/{jobId}` cancels queued/running work. Repeating cancellation is idempotent;
  succeeded or failed work is no longer cancellable.
- `GET /v1/render/{jobId}/video` streams the successful MP4 with exact length plus source/video
  SHA-256 headers.
- `GET /v1/render/{jobId}/still?time=<seconds>` decodes the successful video around the requested
  time and returns the playhead-containing frame as PNG with exact length, selected time, and hashes.

The browser never calls the sidecar directly. Next.js authenticates the owner, checks Origin/CSRF on
state changes, loads the exact canonical revision and project-scoped assets, compiles it, and proxies
the bounded job lifecycle through `/api/proofcanvas/render/**`.

### Submission envelope

- `source` is UTF-8 compiler output, at most 512 KiB; `sourceSha256` binds its exact bytes.
- `quality` is exactly `preview` or `production`.
- `output` is exactly `{width, height, fps, expectedDurationSeconds}`. Dimensions are even integers
  from 240 through 1920, total pixels cannot exceed 1920×1080, FPS is one of 15/24/30/60, and the
  positive duration is frame-aligned and at most 310 seconds. The web boundary applies a stricter
  300-second selected-timeline limit.
- `assets` contains at most 64 exact envelopes. Paths are content-derived
  `assets/<sha256>.<extension>` names and each envelope binds MIME, SHA-256, byte length, and canonical
  base64. Accepted media are PNG/JPEG/WebP up to 32 MiB, sanitized SVG up to 2 MiB, and WAV/MP3 up to
  64 MiB, with a 128 MiB aggregate. The complete JSON request is capped at 258 MiB.
- `audio` is exactly `{durationSeconds, clips}`. At most 64 clips refer to submitted audio assets and
  contain only finite numeric placement, trim, gain, fade, playback-rate, and ordered hold/linear
  volume-keyframe authority. Aggregate keyframes are capped at 2,048 and source duration at 7,200
  seconds.

The sidecar independently revalidates hashes, base64, filenames, media structure/decode, dimensions,
duration, compiler AST references, exact MIME/path agreement, and the absence of unreferenced assets.
It never fetches a remote asset and never extracts an archive.

## Security and execution model

The service fails closed through:

- constant-time bearer-token comparison with no unauthenticated render fallback;
- bounded request/source/media sizes and exact JSON envelope keys;
- a narrow Python AST allowlist for the compiler dialect, excluding arbitrary imports and calls,
  private attributes, filesystem/network/process APIs, dynamic names, user control flow, and nested
  definitions;
- private `0700` per-job directories and `0600` source/asset files with path/hash confinement;
- shell-free argv execution, sanitized proxy/HOME/TMP/XDG environment, deterministic seeds, and one
  new process group per render;
- CPU, wall-time, address-space, output-file, open-file, PID, queue, and bounded-log limits;
- process-group TERM/KILL cancellation and timeout escalation, plus rejection if descendants survive
  their leader;
- FFmpeg filter graphs constructed only from validated finite numbers and fixed labels, never request
  filter text or filenames; and
- confinement and complete independent decode of the final artifact before publication.

Raster contain/cover/fill, fractional crop, aspect handling, circle masks, and rounded masks compile
to one AST-pinned Pillow/NumPy helper. Ordinary sanitized SVG placement uses `SVGMobject`; advanced
SVG crop, cover/fill, and masks fail closed in the compiler because no bounded pinned SVG rasterizer
is trusted for that subset.

Before success, the sidecar requires exactly one non-symlink MP4 in the job directory, exactly one
H.264 video stream, authored dimensions/FPS, exact decoded frame count and frame-aligned duration,
and a complete video decode. When audible clips exist it also requires exactly one 48 kHz AAC stream,
bounded decoded samples matching the numeric audio plan, and a complete fresh audio decode. It
publishes the final SHA-256 and verified stream metadata only after those checks.

AST validation and child resource limits do not replace container isolation. Production must retain:

- the digest-pinned image and non-root user;
- a read-only root filesystem with bounded writable tmpfs for the job root, home, and caches;
- all Linux capabilities dropped, `no-new-privileges`, an init/subreaper, and explicit memory/swap/PID
  limits;
- one Uvicorn process and one service instance;
- no external egress and only a private Next.js-to-sidecar route; and
- the bearer token in a platform secret manager, rotated on both services together.

Do not expose port 8080 publicly or mount a persistent, shared, or user-controlled render root. If the
hosting platform cannot prove these controls, leave remote rendering unavailable.

## Capacity, cancellation, and restart loss

One job runs while at most one waits; additional submissions receive 429. The Manim subprocess has a
180-second wall timeout. MP4 output is capped at 256 MiB and decoded stills at 16 MiB. A completed job
is retained for 600 seconds; failed directory deletion keeps the bookkeeping so a bounded cleanup pass
can retry.

The queue, job metadata, MP4s, and still availability are process-local. A sidecar restart loses
pending, running, succeeded, failed, and cancelled jobs and their results. Durable projects and asset
blobs remain in the web service's SQLite repository, but render jobs do not. After a restart the owner
must submit a new render from that durable source. Multiple Uvicorn workers create independent queues
and are unsupported.

## Operator responses

- 401 means the private bearer tokens do not agree.
- 422 means the exact generated source or media envelope failed policy; do not retry it unchanged.
- 429 means one job is active and one is pending; retry later through a bounded admission layer.
- 409 on video/still means no successful retained artifact is available; 409 on cancellation means
  the job is already terminal.
- Render failures expose only a stable sanitized message. Subprocess output and local paths are never
  returned to clients.

See [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) for health checks, backup/restore, upgrade, secret
rotation, and the explicit external hosting blocker.
