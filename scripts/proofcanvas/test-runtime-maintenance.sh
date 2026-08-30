#!/usr/bin/env bash
set -euo pipefail

readonly repository_root="$(git rev-parse --show-toplevel)"
readonly run_directory="$(mktemp -d /tmp/proofcanvas-runtime-maintenance.XXXXXX)"
readonly source_directory="$run_directory/source"
readonly restore_directory="$run_directory/restore"
readonly runtime_image="proofcanvas-runtime-maintenance:${UID}-$$"
readonly host_uid="$(id -u)"
readonly host_gid="$(id -g)"

cleanup() {
  docker image rm "$runtime_image" >/dev/null 2>&1 || true
  case "$run_directory" in
    /tmp/proofcanvas-runtime-maintenance.*) rm -rf -- "$run_directory" ;;
    *) echo 'Refusing to remove an unexpected ProofCanvas runtime-maintenance directory.' >&2 ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

command -v docker >/dev/null 2>&1 || {
  echo 'Docker is required for the ProofCanvas runtime-maintenance test.' >&2
  exit 2
}
[[ -f "$repository_root/Dockerfile" && -x "$repository_root/node_modules/.bin/tsx" ]] || {
  echo 'Run npm ci and execute this command from the ProofCanvas repository.' >&2
  exit 2
}

mkdir -p "$source_directory" "$restore_directory"

echo 'Seeding an asset-bearing project in an isolated source data directory.'
NODE_OPTIONS=--conditions=react-server \
PROOFCANVAS_DATA_DIR="$source_directory" \
  "$repository_root/node_modules/.bin/tsx" -e '
  import { openProofCanvasDatabase } from "./lib/proofcanvas/database.server";
  import { SqliteProjectRepository } from "./lib/proofcanvas/repository.server";
  const database = openProofCanvasDatabase();
  try {
    const receipt = new SqliteProjectRepository(database).createProject({
      kind: "sample",
      title: "Runtime maintenance asset proof",
      mutationId: "mutation-runtime-maintenance-seed",
    });
    if (receipt.value.revision !== 1) throw new Error("Seed project revision was not created.");
  } finally {
    database.close();
  }
'

echo 'Building the final ProofCanvas runtime image.'
docker build --target runtime --tag "$runtime_image" "$repository_root"

echo 'Running an online asset-bearing backup inside the final runtime image.'
docker run --rm --init --read-only \
  --user "$host_uid:$host_gid" \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  --volume "$source_directory:/data:rw" \
  --env PROOFCANVAS_DATA_DIR=/data \
  --env npm_config_cache=/tmp/npm-cache \
  "$runtime_image" npm run db:backup

mapfile -t source_backups < <(find "$source_directory/backups" -maxdepth 1 -type f -name '*.sqlite3' -print | sort)
if [[ "${#source_backups[@]}" -ne 1 ]]; then
  echo "Expected one runtime-created backup, found ${#source_backups[@]}." >&2
  exit 1
fi
readonly source_backup="${source_backups[0]}"
readonly source_backup_name="$(basename "$source_backup")"

echo 'Restoring the asset-bearing backup inside a fresh final runtime container.'
docker run --rm --init --read-only \
  --user "$host_uid:$host_gid" \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  --volume "$source_directory/backups:/backup:ro" \
  --volume "$restore_directory:/data:rw" \
  --env PROOFCANVAS_DATA_DIR=/data \
  --env npm_config_cache=/tmp/npm-cache \
  "$runtime_image" npm run db:restore -- "/backup/$source_backup_name"

echo 'Revalidating the restored asset-bearing database through the final runtime image.'
docker run --rm --init --read-only \
  --user "$host_uid:$host_gid" \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  --volume "$restore_directory:/data:rw" \
  --env PROOFCANVAS_DATA_DIR=/data \
  --env npm_config_cache=/tmp/npm-cache \
  "$runtime_image" npm run db:backup

PROOFCANVAS_DATA_DIR="$restore_directory" "$repository_root/node_modules/.bin/tsx" -e '
  import Database from "better-sqlite3";
  import { join } from "node:path";
  const database = new Database(join(process.env.PROOFCANVAS_DATA_DIR!, "proofcanvas.sqlite3"), { readonly: true });
  try {
    const blobs = database.prepare("SELECT COUNT(*) AS count FROM asset_blobs").get() as { count: number };
    const refs = database.prepare("SELECT COUNT(*) AS count FROM project_asset_refs WHERE blob_sha256 IS NOT NULL").get() as { count: number };
    if (blobs.count < 1 || refs.count < 1) throw new Error("Restored database lost its asset authority.");
  } finally {
    database.close();
  }
'

printf 'ProofCanvas final runtime asset backup/restore verified: %s bytes, SHA-256 %s\n' \
  "$(stat -c %s "$source_backup")" \
  "$(sha256sum "$source_backup" | awk '{print $1}')"
