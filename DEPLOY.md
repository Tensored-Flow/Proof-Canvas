# ProofCanvas private deployment

ProofCanvas V1 is a private, single-owner service. Run exactly one Next.js application process
against one persistent local volume. It is not a multi-tenant deployment.

## Required configuration

Use Node.js 24 and keep every value server-only:

```dotenv
NODE_ENV=production
PROOFCANVAS_APP_ORIGIN=https://proofcanvas.example
PROOFCANVAS_OWNER_PASSWORD_HASH=scrypt$32768$8$1$...
PROOFCANVAS_SESSION_SECRET=<64 hex characters from openssl rand -hex 32>
PROOFCANVAS_DATA_DIR=/var/lib/proofcanvas
```

`PROOFCANVAS_APP_ORIGIN` must exactly match the public HTTPS Origin, with no trailing slash. Generate
the password hash by piping a private passphrase of at least 16 UTF-8 bytes into
`npm run auth:hash-password`; a generated password or a longer multi-word passphrase is recommended.
Do not reuse that password or hash as the session secret. Restrict `.env` and the data directory to
the service account. The database, sessions, checkpoints, mutation receipts, and backups live under
the configured directory.

Optional OpenAI and renderer variables are documented in [README.md](./README.md). They must never
use a `NEXT_PUBLIC_` name. Keep the renderer on a private network.

## Startup and health

`npm run build` must complete before `npm run start`. Startup applies pending checksummed migrations
transactionally and fails closed on changed or unknown-newer migrations. `/api/health/live` reports
process liveness. `/api/health/ready` checks authentication configuration, SQLite quick integrity,
foreign keys, and the exact tables, indexes, columns, constraints, and migration manifest on every
probe; it also performs one complete persisted-row validation per opened application connection.
Backup and restore always run the uncached full SQLite and repository validation. Use readiness for
traffic admission.

Terminate the prior process before starting a replacement. Supported writers hold a persistent
`.proofcanvas-instance-lease.sqlite3` connection with `BEGIN EXCLUSIVE` in the canonical real data
directory; the transaction is released automatically when its process exits. This is a local SQLite
lease, not a distributed coordination mechanism. Never place either database on NFS, an
eventually-consistent filesystem, or another volume without reliable local SQLite locking, and never
scale the app above one replica.

The included `compose.yaml` pins the application to one named container, binds only to host loopback,
mounts a named persistent volume, uses a read-only root filesystem, drops capabilities, and probes
readiness. Put an HTTPS reverse proxy on the same host in front of port 3000 and set the canonical
public origin accordingly. Do not use `docker compose up --scale` or share its volume with another
application container.

ProofCanvas admits at most two scrypt verifications at once without queueing and applies a global
ten-attempt, 15-minute login window. The application intentionally ignores client-controlled
forwarding headers. Configure source-aware login throttling at the trusted same-host reverse proxy;
without it, an attacker who can reach the login endpoint can temporarily lock out the owner by
exhausting the global window.

## Backup and restore

Create an online, point-in-time SQLite backup while the app is running:

```bash
npm run db:backup
```

The command writes a private file under `$PROOFCANVAS_DATA_DIR/backups`, validates full SQLite
integrity, foreign keys, the complete schema and migration manifest, and every stored project,
checkpoint, mutation receipt, session, and rate-limit row. It fsyncs the staged file and publication
directories before printing its path, size, and SHA-256. Copy verified backups off the application
volume according to the owner's retention policy.

Restore only while the app is fully stopped:

```bash
npm run db:restore -- /absolute/path/to/proofcanvas-backup.sqlite3
```

Restore checks source identity before making any validation copy and refuses every writable target
opened through ProofCanvas's supported database module, including same-process filesystem aliases
and other processes holding the canonical data-directory lease. Existing target symlinks resolve to
their real file and directory; hardlinked targets are rejected. It then stages and fully validates
the copy, checkpoints the old database, publishes a byte-verified and fully validated old copy under
`backups/pre-restore-*.sqlite3`, fsyncs both files and directories, and atomically renames the stage
over the still-present target. Every post-rename failure is reported as committed: the machine-readable
status distinguishes durability uncertainty before directory fsync from a durable publication whose
final cleanup failed. Inspect the reported pre-restore backup before retrying.

The lease and open-connection registry govern only ProofCanvas's supported module; they are not
mandatory exclusion against a raw SQLite writer. A raw-module bypass and filesystems without reliable
SQLite locking are outside the deployment model. Fully stop the application and any maintenance
process before restore; never overwrite or copy directly onto an open database. Dashboard and checkpoint list endpoints currently return the newest
500 active projects and 100 checkpoints respectively; pagination and retention automation remain
future storage work.
