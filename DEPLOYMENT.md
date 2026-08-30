# ProofCanvas deployment runbook

ProofCanvas V1 is a private, single-owner, single-writer system. A production deployment consists of
one HTTPS web application, one local-locking persistent data volume, and one private render sidecar.
It is not a stateless or horizontally scalable SaaS.

## Current deployment status

No remote production deployment has been performed and no public URL has been verified from this
release payload. An isolated local production-TLS Compose qualification passed; it is not a hosted-service
receipt.

Read-only inspection on 2026-08-30 found Docker `29.7.1` and Docker Compose `v5.3.1`, but the
`railway` command was absent, so Railway authentication/project access could not be checked. No
Caddy, nginx, or Traefik executable, authorized public domain, TLS certificate, or existing
ProofCanvas HTTPS ingress was identified on the host.

Local AC-01 through AC-19 qualification and fresh independent review are complete with no P0/P1/P2.
Under AC-17, the remaining deployment condition is exactly an authenticated, authorized target. The
preferred one-time action is to install/authenticate Railway CLI and grant/select one project in
which two services, one persistent local-locking volume, one generated HTTPS domain, private
networking, health checks, and server-side secrets may be configured. An explicitly authorized HTTPS
host satisfying the topology below is an alternative. No DNS, provider, secret, or remote-service
write is authorized by the repository alone.

The final local slim-runtime maintenance gate backed up an asset-bearing 1,630,208-byte source
database (recorded SHA-256 prefix `e2edfe2e`), restored it through the runtime image, forced fresh
login by sanitizing session/rate state, and created a verified post-restore backup (recorded SHA-256
prefix `c086c0a3`). Its ephemeral containers, images, volume, credentials, and scratch were removed.
This proves the local image path, not Railway persistence.

Do not claim that ProofCanvas is live until the remote smoke section in this runbook passes and its
receipts are recorded in [`V1_AUDIT.md`](./V1_AUDIT.md).

## Required topology

```text
Public HTTPS ingress
  |
  +-- source-aware login throttling
  +-- exact host/protocol forwarding
  |
  +-- one ProofCanvas Next.js container
        +-- PROOFCANVAS_APP_ORIGIN=https://exact-public-origin
        +-- local-locking persistent volume at /var/lib/proofcanvas
        +-- private HTTP connection to renderer:8080
              |
              +-- one non-root renderer container
                    +-- no public port
                    +-- no outbound network route
                    +-- read-only root + bounded ephemeral /tmp
```

The web service may reach OpenAI when configured. The renderer must reach only the web-side private
network. Do not give the renderer a public domain, public port, persistent job root, user-controlled
mount, or general outbound internet access.

## Release gate before any deployment write

Deployment is allowed only after the exact candidate satisfies the local gate:

1. `npm ci`
2. `npm test -- --runInBand`
3. `npm run typecheck -- --pretty false`
4. `npm run build`
5. `npm run test:renderer`
6. `npm run test:e2e`
7. `npm run stress:benchmark`
8. `npm run render`
9. `npm run test:parity`
10. `npm run artifacts:verify`
11. `npm audit --omit=dev --audit-level=high`
12. final independent review with no unresolved P0/P1 and every P2 fixed or explicitly waived

Record exact counts, hashes, timestamp, commit, tree, and limitations in `V1_AUDIT.md`. A stale prior
run, focused suite, checked-in `PASS` label, or agent-reported count is not enough.

## Required secrets and configuration

All values are server-only. Do not use a `NEXT_PUBLIC_` name or commit a populated `.env` file.

| Variable | Service | Requirement |
|---|---|---|
| `NODE_ENV` | web | `production` |
| `PROOFCANVAS_APP_ORIGIN` | web | Exact public HTTPS origin, no trailing slash/path/query/credentials |
| `PROOFCANVAS_OWNER_PASSWORD_HASH` | web | Scrypt output from `npm run auth:hash-password`; never plaintext |
| `PROOFCANVAS_SESSION_SECRET` | web | Independent canonical 32-byte hex/base64url secret |
| `PROOFCANVAS_DATA_DIR` | web/maintenance | Persistent local-locking directory; `/var/lib/proofcanvas` in containers |
| `PROOFCANVAS_RENDER_URL` | web | Private renderer root origin, for example `http://proofcanvas-render:8080/` |
| `PROOFCANVAS_RENDER_TOKEN` | web/renderer | Same independent 32–256 character secret on both services |
| `OPENAI_API_KEY` | web | Optional; set with model or omit both |
| `PROOFCANVAS_OPENAI_MODEL` | web | Optional; set with key or omit both |
| `PROOFCANVAS_RENDER_ROOT` | renderer | Private ephemeral path, normally `/tmp/proofcanvas-render` |

Generate the password hash outside shell history by piping one private 16–256 byte passphrase through
stdin. Generate session and renderer secrets independently:

```bash
read -rsp 'ProofCanvas owner passphrase: ' PROOFCANVAS_DEPLOY_PASSWORD
printf '%s' "$PROOFCANVAS_DEPLOY_PASSWORD" | npm run auth:hash-password
unset PROOFCANVAS_DEPLOY_PASSWORD
openssl rand -hex 32
openssl rand -hex 32
```

Store the outputs directly in the platform secret manager or a mode-`0600` host `.env`; do not paste
them into logs, tickets, screenshots, documentation, Git, or a browser. Do not reuse one secret for
another purpose. The private final handoff may identify where a generated owner credential was
delivered, but public repository files must never contain it.

## Preferred Railway procedure

These steps are a runbook, not evidence that Railway access or controls currently exist.

1. Authenticate the Railway CLI as the owner and select the authorized project. Record only account,
   team, project, and service identifiers safe for the audit; never record tokens.
2. Create a web service from this repository's root `Dockerfile`. Pin one replica. Attach a persistent
   volume at `/var/lib/proofcanvas`. Configure `/api/health/ready` as readiness/health and expose only
   container port 3000 through a generated HTTPS domain.
3. Create a renderer service from `services/proofcanvas-render/Dockerfile`, target
   `proofcanvas-render-runtime`. Pin one replica and container port 8080. Enable private networking and
   do **not** generate a public domain.
4. Generate one renderer token in the secret manager and set it on both services. Set the web
   `PROOFCANVAS_RENDER_URL` to the exact private DNS root reported by Railway.
5. Set the owner hash, session secret, persistent data directory, and—only if available—both OpenAI
   values on the web service. Set `PROOFCANVAS_APP_ORIGIN` only after the final generated HTTPS domain
   is known; it must equal `new URL(remoteUrl).origin` exactly.
6. Prove that the selected Railway runtime can enforce a non-root renderer, read-only root,
   writable/bounded ephemeral job storage, PID/memory limits, private ingress, and blocked external
   egress. If any renderer isolation control cannot be enforced or independently demonstrated, leave
   `PROOFCANVAS_RENDER_URL`/token unset and do not offer remote MP4 rendering.
7. Start the renderer, verify its private `/health`, then start exactly one web replica. Web startup
   opens the repository and applies pending checksummed migrations transactionally; there is no
   separate destructive migration command.
8. Verify public `/api/health/live` and `/api/health/ready`, then run the remote smoke checklist below
   from a clean browser. Verify the volume by restarting/redeploying the web service and reopening the
   same project and assets.
9. Execute the receipt-bound logical backup/export procedure below and retain it off-volume. Run the
   isolated Railway restore drill before qualifying persistence. Provider volume snapshots are
   supplemental and do not replace this application-level, independently downloaded backup.

Railway deployment remains unqualified until CLI/API receipts prove the actual service topology,
volume mount, domain, secrets, isolation, and remote behavior.

### Railway logical backup and off-volume export

The final/default `runtime` image deliberately contains the narrow `db:backup`/`db:restore`
TypeScript dependency graph, so the deployed web container can execute the logical maintenance
commands without carrying the rest of the application source. Railway's documented
[`ssh`](https://docs.railway.com/cli/ssh) command can run a single non-interactive command, and its
documented [`volume files`](https://docs.railway.com/cli/volume) commands can download and upload
files from the attached volume. These commands are a procedure to execute after authentication;
they are not evidence that the missing Railway project currently exists.

Link the intended project and environment, resolve the exact web service and volume names from
`railway status --json` and `railway volume list`, then create an encrypted, access-controlled local
directory on storage independent of Railway. The remote file API addresses the root of the mounted
volume, so the receipt path `/var/lib/proofcanvas/backups/<file>` maps to
`/backups/<file>` for the volume command:

```bash
set -euo pipefail

PROOFCANVAS_RAILWAY_WEB_SERVICE=proofcanvas
PROOFCANVAS_RAILWAY_VOLUME=proofcanvas-data
PROOFCANVAS_OFF_VOLUME_DIRECTORY=/absolute/path/to/encrypted-off-volume-backups
test -d "$PROOFCANVAS_OFF_VOLUME_DIRECTORY"
test "$(stat -c '%a' "$PROOFCANVAS_OFF_VOLUME_DIRECTORY")" = 700

PROOFCANVAS_BACKUP_RECEIPT="$(
  railway ssh --service "$PROOFCANVAS_RAILWAY_WEB_SERVICE" -- \
    npm run --silent db:backup | tail -n 1
)"
PROOFCANVAS_BACKUP_FILENAME="$(
  printf '%s' "$PROOFCANVAS_BACKUP_RECEIPT" |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);if(!/^proofcanvas-[A-Za-z0-9][A-Za-z0-9.-]*\.sqlite3$/.test(r.filename)||r.path!==`/var/lib/proofcanvas/backups/${r.filename}`)process.exit(1);process.stdout.write(r.filename)})'
)"
PROOFCANVAS_BACKUP_SHA256="$(
  printf '%s' "$PROOFCANVAS_BACKUP_RECEIPT" |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(r.sha256))process.exit(1);process.stdout.write(r.sha256)})'
)"
PROOFCANVAS_BACKUP_BYTES="$(
  printf '%s' "$PROOFCANVAS_BACKUP_RECEIPT" |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);if(!Number.isSafeInteger(r.bytes)||r.bytes<1)process.exit(1);process.stdout.write(String(r.bytes))})'
)"
PROOFCANVAS_REMOTE_BACKUP_PATH="/backups/$PROOFCANVAS_BACKUP_FILENAME"
PROOFCANVAS_LOCAL_BACKUP_PATH="$PROOFCANVAS_OFF_VOLUME_DIRECTORY/proofcanvas-$PROOFCANVAS_BACKUP_SHA256.sqlite3"
PROOFCANVAS_LOCAL_RECEIPT_PATH="$PROOFCANVAS_OFF_VOLUME_DIRECTORY/proofcanvas-$PROOFCANVAS_BACKUP_SHA256.receipt.json"
test ! -e "$PROOFCANVAS_LOCAL_BACKUP_PATH"
test ! -e "$PROOFCANVAS_LOCAL_RECEIPT_PATH"

railway volume files --volume "$PROOFCANVAS_RAILWAY_VOLUME" download \
  "$PROOFCANVAS_REMOTE_BACKUP_PATH" "$PROOFCANVAS_LOCAL_BACKUP_PATH"
chmod 600 "$PROOFCANVAS_LOCAL_BACKUP_PATH"
test "$(sha256sum "$PROOFCANVAS_LOCAL_BACKUP_PATH" | awk '{print $1}')" = "$PROOFCANVAS_BACKUP_SHA256"
test "$(stat -c '%s' "$PROOFCANVAS_LOCAL_BACKUP_PATH")" = "$PROOFCANVAS_BACKUP_BYTES"
(umask 077; printf '%s\n' "$PROOFCANVAS_BACKUP_RECEIPT" > "$PROOFCANVAS_LOCAL_RECEIPT_PATH")
unset PROOFCANVAS_BACKUP_RECEIPT PROOFCANVAS_BACKUP_FILENAME PROOFCANVAS_BACKUP_SHA256
unset PROOFCANVAS_BACKUP_BYTES PROOFCANVAS_REMOTE_BACKUP_PATH PROOFCANVAS_LOCAL_BACKUP_PATH
unset PROOFCANVAS_LOCAL_RECEIPT_PATH
```

Record the command timestamp, deployment/image identity, receipt, downloaded byte count, and
downloaded SHA-256. Never use provider-managed volume snapshots as the only recovery copy; Railway's
own [volume-backup documentation](https://docs.railway.com/volumes/backups) describes those snapshots
as attached to the project/environment rather than an independent application export.

### Railway restore drill and emergency restore

Exercise restore first in an isolated Railway environment with a separate volume and no public
traffic. Use the same reviewed runtime image digest and configuration shape as production. This
proves the image, mounted-volume paths, upload/download transport, restore program, migrations, and
post-restore startup without overwriting the live installation:

1. Independently verify the selected off-volume file against its retained receipt. Resolve the
   isolated volume by exact name/ID, then upload without overwrite:

   ```bash
   set -euo pipefail
   PROOFCANVAS_RAILWAY_DRILL_VOLUME=proofcanvas-restore-drill-data
   PROOFCANVAS_RESTORE_SHA256=replace-with-the-64-character-receipt-sha256
   PROOFCANVAS_RESTORE_LOCAL_PATH="/absolute/path/to/encrypted-off-volume-backups/proofcanvas-$PROOFCANVAS_RESTORE_SHA256.sqlite3"
   PROOFCANVAS_RESTORE_REMOTE_PATH="/restore-input-$PROOFCANVAS_RESTORE_SHA256.sqlite3"
   test "$(sha256sum "$PROOFCANVAS_RESTORE_LOCAL_PATH" | awk '{print $1}')" = "$PROOFCANVAS_RESTORE_SHA256"
   railway volume files --volume "$PROOFCANVAS_RAILWAY_DRILL_VOLUME" upload \
     "$PROOFCANVAS_RESTORE_LOCAL_PATH" "$PROOFCANVAS_RESTORE_REMOTE_PATH"
   ```

2. Keep every service attached to the drill volume at zero replicas. Configure the isolated web
   service temporarily with restart policy **Never** and this exact custom start command, substituting
   only the receipt SHA-256:

   ```text
   npm run --silent db:restore -- /var/lib/proofcanvas/restore-input-<receipt-sha256>.sqlite3
   ```

3. Start exactly one drill service replica. The command must print one successful restore receipt and
   exit zero. Capture its deployment/image ID and logs, then scale it back to zero before changing any
   setting. A restart loop, missing receipt, nonzero exit, or committed-status error is a failed drill;
   inspect it rather than retrying blindly. Restore deliberately clears every owner session and
   login-rate row before publication, so old cookies must be rejected and the smoke test must
   authenticate again with the configured owner credential.
4. Remove the custom start command so the Dockerfile default starts Next.js, restore the normal
   restart policy, and start one replica against the same drill volume. Verify readiness, login,
   project/checkpoint reopen, every referenced asset, package export, and a genuine render. Create a
   new logical backup, download it off-volume, and verify its receipt as above.
5. Record the exact source backup hash, uploaded path, restore receipt, drill image/deployment/volume
   IDs, post-restore checks, and cleanup decision. Do not promote a drill URL or drill credential as a
   production endpoint.

An emergency production restore uses the same one-shot start-command sequence only after traffic is
placed in explicit maintenance, a fresh receipt-bound backup is downloaded, and **all** web replicas
and any raw/maintenance writers are at zero. Restore the normal start command before returning to one
web replica. Railway UI/API evidence for those zero-writer boundaries is mandatory. The repository
cannot prove those provider-side facts locally, so production persistence remains unqualified until
both remote backup and isolated restore receipts exist.

## Hardened single-host Compose procedure

[`compose.yaml`](./compose.yaml) is the reference topology. It publishes only
`127.0.0.1:3000`, attaches the renderer solely to an `internal` Docker network, uses read-only roots,
tmpfs, dropped capabilities, `no-new-privileges`, init processes, health checks, memory/PID ceilings,
and a named data volume. The optional `maintenance` profile uses the explicit source-bearing
`maintenance` image target for backup and restore. The slim final/default web runtime retains only
the narrow maintenance scripts and their direct source dependency graph so Railway SSH maintenance
is possible; it does not contain the complete application source tree.

Prerequisites:

- an explicitly authorized host with Docker/Compose;
- a public DNS name controlled by the owner;
- a trusted same-host HTTPS reverse proxy with automatic or provisioned certificates;
- local disk with reliable SQLite locking (not NFS or eventually consistent storage);
- enough memory for the 4 GiB renderer ceiling, 3 GiB web ceiling, package decode peaks, and host;
- a mode-`0600` `.env` populated from [`.env.example`](./.env.example).

Validate interpolation without printing secrets, then build and start:

```bash
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:3000/api/health/ready
```

Do not attach a host port to `proofcanvas-render`. Confirm it has only the private network and that
the web container can reach its health endpoint:

```bash
docker compose exec proofcanvas node -e \
  "fetch('http://proofcanvas-render:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
docker inspect "$(docker compose ps -q proofcanvas-render)" --format '{{json .NetworkSettings.Networks}}'
```

Place the HTTPS reverse proxy on the same host and forward only to `127.0.0.1:3000`. Preserve the
original host/protocol, set HSTS after HTTPS is proven, cap request bodies above the app's 132 MiB
package limit without weakening its exact framing, and add source-aware throttling to the login
route. The application intentionally ignores forwarding headers for identity/rate authority.

The repository does not ship a proxy/domain certificate because none is authorized. Do not expose
port 3000 on `0.0.0.0` as a substitute for HTTPS.

## Health, startup, and migrations

- `GET /api/health/live` reports only Next.js process liveness.
- `GET /api/health/ready` validates auth configuration, opens/migrates SQLite, performs exact schema
  and migration-manifest checks on every probe, and performs one full persisted-row/content pass per
  opened application connection.
- Renderer `GET /health` is unauthenticated but private and returns 503 unless a valid renderer token
  is configured.

Startup applies checksummed migrations in a transaction and fails closed on changed checksums,
unknown newer migrations, invalid canonical documents, corrupt asset authority, or lease conflicts.
There is no safe multi-replica migration mode. Start one web process only.

## Single-host Compose backup

Create an online point-in-time backup through the source-bearing maintenance profile while the web
service is running:

```bash
docker compose --profile maintenance run --rm --no-deps \
  proofcanvas-maintenance npm run db:backup
```

The command reads the active database through SQLite's online backup API, performs full integrity,
foreign-key, migration, project, checkpoint, mutation, session, asset-content, and rate-limit
validation, fsyncs staged data and directories, and prints a JSON receipt with private path, byte
length, and SHA-256. Private validation snapshots are created and removed on the persistent
local-locking volume, not the bounded container `/tmp`. Provision free volume space for the live
database, retained backups, and multiple full-size transactional validation/restore copies; for an
offline restore, budget at least five times the largest accepted database plus every retained
on-volume backup and operational headroom.

Publish the receipt-bound backup atomically into a pre-created, encrypted, access-controlled host
directory on a different storage system. The directory must be mode `0700`, writable by the
maintenance container's UID/GID, and have at least the receipt byte count free. This example refuses
an existing destination, verifies both byte count and SHA-256 before publication, fsyncs the file and
directory, and removes only its task-owned partial file on failure:

```bash
set -euo pipefail

PROOFCANVAS_BACKUP_RECEIPT="$(
  docker compose --profile maintenance run --rm --no-deps -T \
    proofcanvas-maintenance npm run --silent db:backup | tail -n 1
)"
PROOFCANVAS_BACKUP_PATH="$(
  printf '%s' "$PROOFCANVAS_BACKUP_RECEIPT" |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);if(!/^\/var\/lib\/proofcanvas\/backups\/proofcanvas-.*\.sqlite3$/.test(r.path))process.exit(1);process.stdout.write(r.path)})'
)"
PROOFCANVAS_BACKUP_SHA256="$(
  printf '%s' "$PROOFCANVAS_BACKUP_RECEIPT" |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(r.sha256))process.exit(1);process.stdout.write(r.sha256)})'
)"
PROOFCANVAS_BACKUP_BYTES="$(
  printf '%s' "$PROOFCANVAS_BACKUP_RECEIPT" |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);if(!Number.isSafeInteger(r.bytes)||r.bytes<1)process.exit(1);process.stdout.write(String(r.bytes))})'
)"
PROOFCANVAS_EXPORT_DIRECTORY=/absolute/path/to/encrypted-off-volume-backups
test -d "$PROOFCANVAS_EXPORT_DIRECTORY"
test "$(stat -c '%a' "$PROOFCANVAS_EXPORT_DIRECTORY")" = 700

docker compose --profile maintenance run --rm --no-deps -T \
  --volume "$PROOFCANVAS_EXPORT_DIRECTORY:/export:rw" \
  proofcanvas-maintenance node -e '
    const fs = require("node:fs")
    const crypto = require("node:crypto")
    const hashFile = (file) => new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256")
      const input = fs.createReadStream(file)
      input.on("error", reject)
      input.on("data", (chunk) => hash.update(chunk))
      input.on("end", () => resolve(hash.digest("hex")))
    })
    const [source, expectedSha, expectedBytes] = process.argv.slice(1)
    const destination = `/export/proofcanvas-${expectedSha}.sqlite3`
    const partial = `/export/.proofcanvas-${expectedSha}.${process.pid}.partial`
    ;(async () => {
      try {
        if (fs.existsSync(destination)) throw new Error("destination already exists")
        fs.copyFileSync(source, partial, fs.constants.COPYFILE_EXCL)
        fs.chmodSync(partial, 0o600)
        const bytes = fs.statSync(partial).size
        const sha256 = await hashFile(partial)
        if (String(bytes) !== expectedBytes || sha256 !== expectedSha) throw new Error("export verification failed")
        const file = fs.openSync(partial, "r"); fs.fsyncSync(file); fs.closeSync(file)
        fs.linkSync(partial, destination)
        fs.unlinkSync(partial)
        const directory = fs.openSync("/export", "r"); fs.fsyncSync(directory); fs.closeSync(directory)
        process.stdout.write(`${JSON.stringify({ destination, bytes, sha256 })}\n`)
      } catch (error) {
        try { fs.unlinkSync(partial) } catch (cleanup) { if (cleanup.code !== "ENOENT") throw new AggregateError([error, cleanup]) }
        throw error
      }
    })().catch((error) => { console.error(error); process.exit(1) })
  ' "$PROOFCANVAS_BACKUP_PATH" "$PROOFCANVAS_BACKUP_SHA256" "$PROOFCANVAS_BACKUP_BYTES"

test "$(sha256sum "$PROOFCANVAS_EXPORT_DIRECTORY/proofcanvas-${PROOFCANVAS_BACKUP_SHA256}.sqlite3" | awk '{print $1}')" \
  = "$PROOFCANVAS_BACKUP_SHA256"
test "$(stat -c '%s' "$PROOFCANVAS_EXPORT_DIRECTORY/proofcanvas-${PROOFCANVAS_BACKUP_SHA256}.sqlite3")" \
  = "$PROOFCANVAS_BACKUP_BYTES"
unset PROOFCANVAS_BACKUP_RECEIPT PROOFCANVAS_BACKUP_PATH PROOFCANVAS_BACKUP_SHA256 PROOFCANVAS_BACKUP_BYTES
```

Retain or prune the original on-volume backup only under an explicit retention policy after the
off-volume hash/byte checks succeed. Test restores regularly on a separate authorized installation.

## Single-host Compose restore

Restore is offline and replaces the database. Resolve the exact source path first, take and export a
fresh backup, then stop the web service. Bind the selected backup read-only into the one-shot
maintenance container:

```bash
docker compose stop proofcanvas
docker compose --profile maintenance run --rm --no-deps \
  --volume /absolute/path/to/proofcanvas-backup.sqlite3:/restore/input.sqlite3:ro \
  proofcanvas-maintenance npm run db:restore -- /restore/input.sqlite3
docker compose up -d proofcanvas
curl --fail --silent --show-error http://127.0.0.1:3000/api/health/ready
```

The restore validates a private copy, migrates that copy if required, checkpoints the old target,
publishes a byte-verified `backups/pre-restore-*.sqlite3`, fsyncs, and atomically renames the stage over
the target. Its machine-readable error distinguishes pre-publication failure, publication with
durability uncertainty, and durable publication with cleanup failure. Do not retry blindly after a
committed status; inspect the receipt and pre-restore backup.

Every restore intentionally deletes all staged `sessions` and `auth_rate_limits` rows before the
atomic rename. This prevents a rollback from resurrecting a cookie revoked after the backup was
taken. It also means every browser session is invalid after restore and the owner must log in again;
source-aware ingress throttling remains required while the fresh application rate window begins.

The ProofCanvas lease only coordinates code using the supported database module. It cannot exclude a
raw SQLite writer. Stop the web app and all maintenance/raw database processes; never copy directly
over an open database.

## Upgrade and rollback

1. Bind the candidate deployment to one reviewed Git commit and immutable image digest.
2. Export and verify an off-volume application backup immediately before upgrade.
3. Stop the prior web process; keep the renderer private. Deploy one new web process and wait for
   readiness/migrations.
4. Run authentication, project reopen, asset fetch, package, and render smoke tests.

Database migrations are forward-only. An older image may reject a database with newer migration
records, so application rollback after a migration may require stopping the app and restoring the
pre-upgrade database before redeploying the old image. Never run old and new writers concurrently.
Renderer rollback does not restore lost jobs; resubmit from durable project source after the new
sidecar is healthy.

## Secret rotation

- **Owner password hash:** replace the hash and restart the single web service. Deliver the new
  plaintext credential privately; never store it in Git.
- **Session secret:** replacing it invalidates signed cookies. Restart the web service and expect the
  owner to log in again.
- **Renderer token:** update renderer and web atomically enough to avoid public partial operation;
  restart renderer first, then web, and expect process-local jobs to be lost.
- **OpenAI key/model:** update both together. A provider failure remains visible and does not become a
  successful fallback.

Revoke and rotate immediately after suspected disclosure, then scan Git history, build logs, browser
bundles, container metadata, and deployment logs. Do not paste secret values into an incident record.

## Remote smoke checklist

Run from a clean browser and an independent command environment against the generated HTTPS domain:

1. TLS validates without bypass; HTTP redirects to HTTPS; the URL origin exactly matches
   `PROOFCANVAS_APP_ORIGIN`.
2. Unauthenticated dashboard/editor/project/asset/package/AI/render boundaries refuse access.
3. Login succeeds with the privately delivered owner credential; cookies are Secure,
   `SameSite=Strict`, and session `HttpOnly`; logout revokes the session.
4. Create and save a project; upload an image and deterministic audio; create captions; refresh and
   reopen in a fresh browser context.
5. Export/import `.proofcanvas`; verify internal IDs and assets/media/captions survive under a fresh
   project ID.
6. Render landscape A/V, cancel a separate job, retry, download MP4 and still, and independently
   ffprobe/full-decode exact dimensions/fps/duration/video/audio.
7. Create a portrait project, render, and independently verify exact portrait dimensions/fps.
8. Restart/redeploy the web service against the same volume; authenticate and reopen the saved
   projects/assets. Record that renderer jobs are lost rather than claiming persistence.
9. Exercise configured live AI only if an authorized key/model exists; otherwise verify the labelled
   deterministic fallback and report live AI as untested.
10. Capture bounded screenshots, health responses, service/volume/domain identifiers, commit/image
    digests, and artifact hashes without credentials or private project content.

Record exact results in `V1_AUDIT.md`. Only then may the final report name a hosted URL/provider and
health status.

## Operational limits

- One web replica and one Uvicorn worker.
- One active plus one pending render; 429 beyond that.
- Render jobs and artifacts are process-local, expire after 600 seconds, and are lost on restart.
- 2 MiB canonical project JSON; 64 MiB per asset; 128 MiB distinct asset/package aggregate;
  132 MiB package archive; 128 MiB renderer asset aggregate; 256 MiB MP4; 16 MiB still.
- Maximum selected authored/compiler-estimated render duration is 300 seconds; sidecar artifact
  envelope is 310 seconds; Manim wall timeout is 180 seconds.
- Active project listing is the newest 500; checkpoint listing is the newest 100. No automated
  retention or asset garbage collection is included.

## Decommissioning

Before removal, export canonical projects/packages and at least two independently verified encrypted
database backups, then test one restore. Revoke OpenAI/renderer/session secrets, remove DNS and HTTPS
routes, stop both services, and only then retire the volume according to the owner's retention policy.
Renderer tmpfs/job data is ephemeral; do not treat it as a backup source.
