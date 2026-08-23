#!/usr/bin/env bash
set -euo pipefail

readonly playwright_image='mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e'
readonly manim_base='manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3'
readonly render_token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
readonly repository_root="$(git rev-parse --show-toplevel)"
readonly run_directory="$(mktemp -d /tmp/proofcanvas-browser-e2e.XXXXXX)"
readonly acceptance_container="proofcanvas-acceptance-${UID}-$$"
readonly renderer_container="proofcanvas-renderer-${UID}-$$"
readonly renderer_image="proofcanvas-render-e2e:${UID}-$$"
readonly evidence_directory="$repository_root/examples/proofcanvas/evidence"
readonly host_uid="$(id -u)"
readonly host_gid="$(id -g)"

cleanup() {
  docker container rm --force "$renderer_container" >/dev/null 2>&1 || true
  docker container rm --force "$acceptance_container" >/dev/null 2>&1 || true
  docker image rm "$renderer_image" >/dev/null 2>&1 || true
  case "$run_directory" in
    /tmp/proofcanvas-browser-e2e.*) rm -rf -- "$run_directory" ;;
    *) echo 'Refusing to remove an unexpected ProofCanvas run directory.' >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null 2>&1 || { echo 'Docker is required for the ProofCanvas browser acceptance journey.' >&2; exit 2; }
[[ -f "$repository_root/package.json" && -f "$repository_root/services/proofcanvas-render/Dockerfile" ]] || { echo 'Run this command from the ProofCanvas repository.' >&2; exit 2; }
rg -Fqx "FROM $manim_base AS proofcanvas-render-base" "$repository_root/services/proofcanvas-render/Dockerfile" || { echo 'The render service base image is not pinned to the accepted Manim digest.' >&2; exit 2; }

if docker container inspect "$acceptance_container" >/dev/null 2>&1 || docker container inspect "$renderer_container" >/dev/null 2>&1; then
  echo 'A task-owned ProofCanvas container name is already in use.' >&2
  exit 2
fi

echo 'Building the production Next.js application on the host (browser execution remains Docker-only).'
(cd "$repository_root" && npm run build)

echo 'Building the pinned ProofCanvas render sidecar image.'
docker build --tag "$renderer_image" "$repository_root/services/proofcanvas-render"

docker run --detach --name "$acceptance_container" --init \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=512 \
  --memory=3g \
  --memory-swap=3g \
  --tmpfs "/tmp:rw,nosuid,nodev,size=1g,mode=1777" \
  --tmpfs "/dev/shm:rw,nosuid,nodev,size=512m,mode=1777" \
  --tmpfs "/workspace/.next/cache:rw,nosuid,nodev,size=128m,mode=700,uid=$host_uid,gid=$host_gid" \
  --user "$host_uid:$host_gid" \
  --volume "$repository_root:/workspace:ro" \
  --volume "$run_directory:/evidence:rw" \
  --workdir /workspace \
  --env CI=1 \
  --env HOME=/tmp \
  --env NEXT_TELEMETRY_DISABLED=1 \
  --env PROOFCANVAS_BASE_URL=http://127.0.0.1:3217 \
  --env PROOFCANVAS_EVIDENCE_DIR=/evidence \
  --env PROOFCANVAS_TEST_RESULTS_DIR=/tmp/proofcanvas-test-results \
  --env PROOFCANVAS_RENDER_URL=http://127.0.0.1:8080 \
  --env PROOFCANVAS_RENDER_TOKEN="$render_token" \
  "$playwright_image" sleep infinity >/dev/null

docker run --detach --name "$renderer_container" --init \
  --network="container:$acceptance_container" \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=512 \
  --memory=4g \
  --memory-swap=4g \
  --tmpfs "/tmp:rw,nosuid,nodev,size=3g,mode=1777" \
  --env PROOFCANVAS_RENDER_TOKEN="$render_token" \
  "$renderer_image" >/dev/null

echo 'Running both viewport projects in the externally networkless acceptance namespace.'
timeout --signal=TERM --kill-after=20s 20m docker exec "$acceptance_container" bash -lc '
  set -euo pipefail
  for attempt in $(seq 1 80); do
    if curl --fail --silent --show-error http://127.0.0.1:8080/health >/dev/null; then break; fi
    if [[ "$attempt" -eq 80 ]]; then echo "ProofCanvas renderer did not become ready." >&2; exit 1; fi
    sleep 0.25
  done

  python3 scripts/proofcanvas/assert-port-released.py 3217
  set +m
  setsid node_modules/.bin/next start --hostname 127.0.0.1 --port 3217 >/tmp/proofcanvas-next.log 2>&1 &
  next_pid=$!
  next_pgid="$(ps -o pgid= -p "$next_pid" | tr -d " ")"
  next_sid="$(ps -o sid= -p "$next_pid" | tr -d " ")"
  if [[ "$next_pgid" != "$next_pid" || "$next_sid" != "$next_pid" ]]; then
    echo "ProofCanvas Next.js process ownership could not be proven." >&2
    exit 1
  fi
  cleanup_next() {
    kill -- -"$next_pid" >/dev/null 2>&1 || true
    wait "$next_pid" >/dev/null 2>&1 || true
    python3 scripts/proofcanvas/assert-port-released.py 3217
  }
  trap cleanup_next EXIT INT TERM
  for attempt in $(seq 1 160); do
    if curl --fail --silent --show-error http://127.0.0.1:3217/ >/dev/null; then break; fi
    if ! kill -0 "$next_pid" 2>/dev/null; then tail -n 120 /tmp/proofcanvas-next.log >&2; exit 1; fi
    if [[ "$attempt" -eq 160 ]]; then tail -n 120 /tmp/proofcanvas-next.log >&2; exit 1; fi
    sleep 0.25
  done
  node_modules/.bin/playwright test --config=playwright.config.ts
'

node "$repository_root/scripts/proofcanvas/validate-e2e.mjs" "$run_directory" "$evidence_directory"
echo "Retained bounded ProofCanvas browser evidence in $evidence_directory"
