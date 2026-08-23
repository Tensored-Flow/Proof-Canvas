# ProofCanvas render sidecar

This FastAPI service renders only Python emitted by the ProofCanvas compiler. It is the private,
authenticated execution boundary behind the Next.js application—not a public arbitrary-Manim or
arbitrary-Python API.

## Configuration

The container requires:

```dotenv
PROOFCANVAS_RENDER_TOKEN=
```

The token must be 32–256 characters and exactly match the server-only token configured for
Next.js. `PROOFCANVAS_RENDER_ROOT` is optional and defaults to `/tmp/proofcanvas-render`; it must be
private, writable, ephemeral storage owned by the non-root service user.

Next.js requires:

```dotenv
PROOFCANVAS_RENDER_URL=https://renderer.internal.example/
PROOFCANVAS_RENDER_TOKEN=<same token>
```

The URL must be a root HTTP(S) origin with no embedded credentials, query, or fragment. Use a
private service address. Use TLS whenever traffic crosses a trusted host or container boundary.
Never expose either variable through a `NEXT_PUBLIC_` name.

## Local build, test, and run

From the repository root:

```bash
docker build --target proofcanvas-render-test -t proofcanvas-render:test services/proofcanvas-render
docker run --rm --init proofcanvas-render:test \
  /opt/venv/bin/python -m pytest -q /app/tests
docker build -t proofcanvas-render:local services/proofcanvas-render

export PROOFCANVAS_LOCAL_RENDER_TOKEN="$(openssl rand -hex 32)"
docker run --rm --init --name proofcanvas-render \
  -p 127.0.0.1:8080:8080 \
  -e PROOFCANVAS_RENDER_TOKEN="$PROOFCANVAS_LOCAL_RENDER_TOKEN" \
  proofcanvas-render:local
```

Then set `PROOFCANVAS_RENDER_URL=http://127.0.0.1:8080/` and the same token in the Next.js
environment. The final runtime stage pins Manim Community 0.21.0 by digest, runs Uvicorn as
`manimuser`, does not copy the test suite, and does not install the separate test requirements.
The upstream Manim environment still contains some transitive development-capable libraries.
Runtime and test dependency closures are separately version- and wheel-hash-locked for the pinned
Linux x86_64 / CPython 3.14 base. `requirements.txt` and `requirements-test.txt` are the small
direct-dependency inputs; the Docker build first requires every direct pin to match its
corresponding `.lock` file, then installs the lock with binary-only hash enforcement.

For the complete hardened browser/render lifecycle, run:

```bash
npm run test:e2e
```

## API

All `/v1/render` endpoints require `Authorization: Bearer <token>`. `/health` is unauthenticated for
private readiness checks and returns 503 until a valid token is configured.

- `GET /health` reports the service, Manim version, queue capacity, and timeout.
- `POST /v1/render` accepts exactly `{ source, sourceSha256, quality }`, where `quality` is `preview`
  or `production`, and returns an asynchronous job.
- `GET /v1/render/{jobId}` returns bounded, process-local job state.
- `GET /v1/render/{jobId}/video` streams a successful MP4 with source and video SHA-256 headers.

The browser does not call this API directly. Next.js compiles the structured project and proxies
submission, status, and video bytes through `/api/proofcanvas/render/**`.

## Security model

The service fails closed through:

- constant-time bearer-token comparison with no unauthenticated fallback;
- bounded request/source sizes, exact envelope keys, and source SHA-256 verification;
- a narrow Python AST allowlist for the compiler dialect, excluding arbitrary imports, calls,
  private attributes, loops, conditionals, comprehensions, and nested definitions;
- a private `0700` directory per job, a `0600` source file, sanitized environment/proxy variables,
  deterministic seeds, shell-free execution, and a new process group;
- CPU/wall-time, address-space, file-size, open-file, output, and queue limits;
- validation of exactly one non-symlink MP4 inside the job directory, with H.264 codec, expected
  dimensions/FPS, bounded duration/frame count, and complete decode;
- a continuously drained fixed 64 KiB subprocess-log tail that is discarded at the sanitized job
  boundary, whole-process-group TERM/KILL timeout handling, rejection and cleanup when descendants
  outlive their leader, no-store responses, and ten-minute job expiry with retry after a filesystem
  cleanup failure.

AST validation and child resource limits do not replace container isolation. Production must keep:

- the digest-pinned base image and non-root user;
- a read-only root filesystem with bounded writable tmpfs for render root, home, and caches;
- all Linux capabilities dropped and `no-new-privileges` enabled;
- an init/subreaper so terminated subprocess descendants are promptly reaped;
- explicit container memory, swap, and PID limits;
- external network access denied, allowing only the private Next.js-to-sidecar path;
- the bearer token in a platform secret store, rotated on both services together;
- one Uvicorn process per service instance.

Do not expose port 8080 publicly. Do not mount a shared or user-controlled render root. If the
hosting platform cannot enforce the controls above, keep rendering unavailable rather than execute
generated code with weaker isolation.

## Capacity and lifecycle

One job runs while at most one waits; further submissions receive 429. Jobs are ephemeral and lost
on restart. Completed jobs expire after 600 seconds; failed directory cleanup retains the job for
the next bounded cleanup pass instead of forgetting residue. Preview output is 854×480 at 15 fps and
production output is 1280×720 at 30 fps. Both are H.264 MP4, capped at 310 seconds and 256 MiB. The
Manim subprocess has a 180-second timeout and a 2 GiB address-space limit.

The request transfers generated source only. It does not include checked-in or uploaded assets, so
local image/SVG paths require a future trusted asset-packaging design before remote rendering.

## Operations

- Use `/health` only on the private service boundary; 503 means authentication is not configured.
- A 429 means the bounded queue is full; retry later through an admission layer.
- A 422 means the generated source failed policy and should not be retried unchanged.
- Failed jobs expose only `Manim could not render this generated scene.` Subprocess output is not
  returned to clients.
- Multiple Uvicorn workers create independent queues; use one process per instance and scale with an
  external admission/queue design.
