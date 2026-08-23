# ProofCanvas

ProofCanvas is a structured, style-first editor for mathematical animation. Build scenes on an SVG
canvas, organize them into shots, edit a timeline, and export a validated project or deterministic,
readable Manim Python. The included **Uncountable, Yet Zero Length** project demonstrates a
multi-shot Cantor-set construction.

The versioned `ProjectDocument` is the source of truth. Generated Python is an output, not a second
editable format, and AI suggestions are validated scene operations rather than executable code.

## Quick start

Editor quick-start requirements: Node.js 20.9+ and npm. The documented renderer, browser, and
genuine-Manim verification commands additionally target an x86_64 Linux host with Docker, Git, Python 3,
ripgrep, Bash 4+, and GNU `timeout`. Those exact shell workflows are not currently portable to the
stock macOS command-line environment.

```bash
npm ci
npm run dev
```

Open <http://localhost:3000/>. `/proofcanvas` redirects to `/` for compatibility.

Without credentials or a render service, the editor still supports structured editing, multiple
shots, timeline playback, components, undo/redo, browser-local save/load, JSON import/export,
Manim Python export, critique, and the visibly labelled deterministic AI demo.

The shared format contract caps canonical project JSON and browser imports at 2 MiB. Oversized files
are rejected before the browser reads them, and every schema-valid project remains exportable and
importable under the same limit.

## Commands

Run all commands from the repository root:

```bash
npm ci             # install the locked dependency graph
npm run dev        # start the editor at http://localhost:3000/
npm test           # run unit and API-boundary tests
npm run typecheck  # check TypeScript without emitting files
npm run build      # create the production Next.js build
npm run test:renderer # build the sidecar and run its policy/API tests
npm run test:e2e   # run the Docker-isolated browser and renderer journey
npm run artifacts  # regenerate canonical JSON, Python, AI evidence, and hashes
npm run artifacts:verify # reject missing, changed, or stale retained evidence
npm run render     # regenerate source, render it, then refresh and verify evidence
```

`npm run artifacts` requires `python3`. `npm run render` requires Docker and consumes the generated
canonical Python. It uses a digest-pinned Manim Community image without network access.
`npm run test:e2e` builds the app and render sidecar, tests 1440×900 and 1280×800 viewports,
performs accessibility and overflow checks, and downloads a genuine MP4 through the UI.
Both evidence-producing commands refresh and verify the artifact manifest before returning.

Generated examples and bounded visual evidence live in [`examples/proofcanvas/`](./examples/proofcanvas/).
Reproducible implementation evidence and known limitations are recorded in [`AUDIT.md`](./AUDIT.md).

## Optional structured AI editing

Set both server-only variables in `.env.local` before starting Next.js:

```dotenv
OPENAI_API_KEY=
PROOFCANVAS_OPENAI_MODEL=
```

When configured, the server uses the OpenAI Responses API with strict structured output. The model
receives bounded scene context and may return at most 32 typed `SceneOperation` values. The server
rejects malformed operations, unlock attempts, inherited-lock violations, and proposals that do
not produce a valid project.

If either variable is absent, the UI clearly identifies deterministic demo mode. That fallback
supports a small command vocabulary; it is not a general natural-language model. Provider failures
do not silently become successful demo responses.

## Optional render sidecar

The editor exports Manim Python without the sidecar. To render MP4 from the UI, build the service
and give it a private 32–256 character bearer token:

```bash
docker build -t proofcanvas-render:local services/proofcanvas-render
export PROOFCANVAS_LOCAL_RENDER_TOKEN="$(openssl rand -hex 32)"
docker run --rm --init --name proofcanvas-render \
  -p 127.0.0.1:8080:8080 \
  -e PROOFCANVAS_RENDER_TOKEN="$PROOFCANVAS_LOCAL_RENDER_TOKEN" \
  proofcanvas-render:local
```

Configure the Next.js server with the same token:

```dotenv
PROOFCANVAS_RENDER_URL=http://127.0.0.1:8080/
PROOFCANVAS_RENDER_TOKEN=<same token>
```

Restart `npm run dev` after changing `.env.local`. `PROOFCANVAS_RENDER_URL` must be a root HTTP(S)
origin without embedded credentials, query, or fragment. `PROOFCANVAS_RENDER_ROOT` optionally sets
the sidecar's private ephemeral job directory; its default is `/tmp/proofcanvas-render`.

The command above is for single-host development. Production deployment must keep the sidecar on a
private network, use a read-only container filesystem with bounded writable temporary storage,
drop Linux capabilities, deny external network access, and inject the shared token through a secret
store. See the [render-service guide](./services/proofcanvas-render/README.md).

The default `dev` and `start` commands bind only to `127.0.0.1`. Deliberate network exposure must
be an explicit deployment decision and requires authenticated admission, rate limits, quotas, and
appropriate TLS/network controls in front of the application.

## Product model

- Scene objects, groups, shots, animations, styles, and cameras have stable IDs in a versioned,
  globally validated schema.
- Direct manipulation and AI proposals use atomic transactions. One proposal creates one undo
  entry; a failed operation publishes nothing.
- Locks are inherited through groups. AI cannot unlock objects.
- The browser preview is deterministic but approximate. SVG/KaTeX typography, paths, easing,
  graphs, group geometry, and camera motion do not promise frame parity with Manim.
- Browser persistence is single-device `localStorage`. There are no accounts, server persistence,
  collaboration, autosave, or conflict resolution.
- Arbitrary Python import or execution is unsupported. Only compiler-generated source may cross the
  authenticated renderer boundary.

For module boundaries and trust flows, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Security and deployment status

The AI and render proxy routes validate and bound their inputs, but they do **not** authenticate an
end user, authorize a tenant, enforce per-user quotas, or provide billing controls. The render
sidecar's one-running-plus-one-pending capacity is overload protection, not public admission
control. Do not expose the current application as an untrusted multi-tenant service without an
authenticated admission and rate-limiting layer.

Renderer jobs are process-local, ephemeral, and lost on restart. Render requests transfer generated
source only; checked-in image paths need a future trusted asset-packaging design. The direct editor
is demonstrated for 16:9 desktop layouts; 9:16 is accepted by the schema but not browser-validated.
Automated tests and accessibility scans do not replace human usability or assistive-technology
review.

## License

No license file is currently included. Do not assume permission to redistribute or modify this
project beyond rights granted by applicable law.
