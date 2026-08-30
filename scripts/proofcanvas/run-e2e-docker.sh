#!/usr/bin/env bash
set -euo pipefail

readonly playwright_image='mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e'
readonly manim_base='manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3'
readonly render_token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
readonly owner_password="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
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
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
  --env PROOFCANVAS_BASE_URL=https://127.0.0.1:3217 \
  --env PROOFCANVAS_E2E_OWNER_PASSWORD="$owner_password" \
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
  --volume "$run_directory:/evidence:ro" \
  --volume "$repository_root/scripts/proofcanvas/verify-png-evidence.py:/verify-png-evidence.py:ro" \
  --volume "$repository_root/scripts/proofcanvas/verify-video-evidence.py:/verify-video-evidence.py:ro" \
  --env PROOFCANVAS_RENDER_TOKEN="$render_token" \
  "$renderer_image" >/dev/null

echo 'Running both viewport projects in the externally networkless acceptance namespace.'
timeout --signal=TERM --kill-after=20s 25m docker exec "$acceptance_container" bash -lc '
  set -euo pipefail
  for attempt in $(seq 1 80); do
    if curl --fail --silent --show-error http://127.0.0.1:8080/health >/dev/null; then break; fi
    if [[ "$attempt" -eq 80 ]]; then echo "ProofCanvas renderer did not become ready." >&2; exit 1; fi
    sleep 0.25
  done

  python3 scripts/proofcanvas/assert-port-released.py 3217 3218
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" \
    -keyout /tmp/proofcanvas-e2e-key.pem -out /tmp/proofcanvas-e2e-cert.pem \
    >/tmp/proofcanvas-openssl.log 2>&1
  chmod 600 /tmp/proofcanvas-e2e-key.pem
  owner_hash="$(printf %s "$PROOFCANVAS_E2E_OWNER_PASSWORD" | node_modules/.bin/tsx scripts/proofcanvas/hash-password.ts)"
  session_secret="$(openssl rand -hex 32)"
  mkdir -p /tmp/proofcanvas-data
  set +m
  next_pid=""
  next_wait_pid=""
  proxy_pid=""
  proxy_wait_pid=""
  stop_group() {
    owned_pid="$1"
    waiter_pid="$2"
    if [[ -n "$owned_pid" ]]; then
      kill -- -"$owned_pid" >/dev/null 2>&1 || true
      for _attempt in $(seq 1 30); do
        if ! kill -0 -- -"$owned_pid" >/dev/null 2>&1; then break; fi
        sleep 0.1
      done
      if kill -0 -- -"$owned_pid" >/dev/null 2>&1; then
        kill -KILL -- -"$owned_pid" >/dev/null 2>&1 || true
      fi
    fi
    if [[ -n "$waiter_pid" ]]; then
      # A failed discovery deliberately leaves owned_pid empty. Terminate the
      # known wrapper by PID so cleanup cannot block on its still-running child;
      # container teardown remains the fail-closed boundary for any unproven
      # orphan, and the port assertion below makes that state visible.
      if [[ -z "$owned_pid" ]]; then kill "$waiter_pid" >/dev/null 2>&1 || true; fi
      for _attempt in $(seq 1 30); do
        if ! kill -0 "$waiter_pid" >/dev/null 2>&1; then break; fi
        sleep 0.1
      done
      if kill -0 "$waiter_pid" >/dev/null 2>&1; then kill -KILL "$waiter_pid" >/dev/null 2>&1 || true; fi
      wait "$waiter_pid" >/dev/null 2>&1 || true
    fi
  }
  owned_session_leader() {
    waiter_pid="$1"
    log_path="$2"
    owned_pid=""
    for _attempt in $(seq 1 30); do
      owned_pid="$(ps -o pid= --ppid "$waiter_pid" | awk "NF { count += 1; pid = \$1 } END { if (count == 1) print pid }")"
      [[ -n "$owned_pid" ]] && break
      if ! kill -0 "$waiter_pid" >/dev/null 2>&1; then
        tail -n 120 "$log_path" >&2
        return 1
      fi
      sleep 0.05
    done
    if [[ -z "$owned_pid" ]]; then
      echo "ProofCanvas process session leader did not appear." >&2
      tail -n 120 "$log_path" >&2
      return 1
    fi
    owned_pgid="$(ps -o pgid= -p "$owned_pid" | tr -d " ")"
    owned_sid="$(ps -o sid= -p "$owned_pid" | tr -d " ")"
    if [[ "$owned_pgid" != "$owned_pid" || "$owned_sid" != "$owned_pid" ]]; then
      echo "ProofCanvas process ownership could not be proven: pid=$owned_pid pgid=$owned_pgid sid=$owned_sid." >&2
      tail -n 120 "$log_path" >&2
      return 1
    fi
    printf %s "$owned_pid"
  }
  cleanup_next() {
    stop_group "$proxy_pid" "$proxy_wait_pid"
    stop_group "$next_pid" "$next_wait_pid"
    python3 scripts/proofcanvas/assert-port-released.py 3217 3218
  }
  trap cleanup_next EXIT
  trap "exit 130" INT
  trap "exit 143" TERM
  env -u PROOFCANVAS_E2E_OWNER_PASSWORD \
  PROOFCANVAS_APP_ORIGIN=https://127.0.0.1:3217 \
  PROOFCANVAS_OWNER_PASSWORD_HASH="$owner_hash" \
  PROOFCANVAS_SESSION_SECRET="$session_secret" \
  PROOFCANVAS_DATA_DIR=/tmp/proofcanvas-data \
  setsid --fork --wait node_modules/.bin/next start --hostname 127.0.0.1 --port 3218 >/tmp/proofcanvas-next.log 2>&1 &
  next_wait_pid=$!
  if ! next_pid="$(owned_session_leader "$next_wait_pid" /tmp/proofcanvas-next.log)"; then exit 1; fi
  env -u PROOFCANVAS_E2E_OWNER_PASSWORD -u PROOFCANVAS_RENDER_TOKEN \
  PROOFCANVAS_HTTPS_CERT=/tmp/proofcanvas-e2e-cert.pem \
  PROOFCANVAS_HTTPS_KEY=/tmp/proofcanvas-e2e-key.pem \
  setsid --fork --wait node scripts/proofcanvas/https-proxy.mjs 3217 3218 >/tmp/proofcanvas-https.log 2>&1 &
  proxy_wait_pid=$!
  if ! proxy_pid="$(owned_session_leader "$proxy_wait_pid" /tmp/proofcanvas-https.log)"; then exit 1; fi
  for attempt in $(seq 1 160); do
    if curl --insecure --fail --silent --show-error https://127.0.0.1:3217/login >/dev/null; then break; fi
    if ! kill -0 "$next_pid" 2>/dev/null; then tail -n 120 /tmp/proofcanvas-next.log >&2; exit 1; fi
    if ! kill -0 "$proxy_pid" 2>/dev/null; then tail -n 120 /tmp/proofcanvas-https.log >&2; exit 1; fi
    if [[ "$attempt" -eq 160 ]]; then tail -n 120 /tmp/proofcanvas-next.log >&2; tail -n 120 /tmp/proofcanvas-https.log >&2; exit 1; fi
    sleep 0.25
  done
  node_modules/.bin/playwright test --config=playwright.config.ts

  echo "Restarting the production Next.js process against the same durable volume."
  stop_group "$next_pid" "$next_wait_pid"
  next_pid=""
  next_wait_pid=""
  python3 scripts/proofcanvas/assert-port-released.py 3218
  env -u PROOFCANVAS_E2E_OWNER_PASSWORD \
  PROOFCANVAS_APP_ORIGIN=https://127.0.0.1:3217 \
  PROOFCANVAS_OWNER_PASSWORD_HASH="$owner_hash" \
  PROOFCANVAS_SESSION_SECRET="$session_secret" \
  PROOFCANVAS_DATA_DIR=/tmp/proofcanvas-data \
  setsid --fork --wait node_modules/.bin/next start --hostname 127.0.0.1 --port 3218 >/tmp/proofcanvas-next-restart.log 2>&1 &
  next_wait_pid=$!
  if ! next_pid="$(owned_session_leader "$next_wait_pid" /tmp/proofcanvas-next-restart.log)"; then exit 1; fi
  for attempt in $(seq 1 160); do
    if curl --insecure --fail --silent --show-error https://127.0.0.1:3217/login >/dev/null; then break; fi
    if ! kill -0 "$next_pid" 2>/dev/null; then tail -n 120 /tmp/proofcanvas-next-restart.log >&2; exit 1; fi
    if [[ "$attempt" -eq 160 ]]; then tail -n 120 /tmp/proofcanvas-next-restart.log >&2; exit 1; fi
    sleep 0.25
  done
  PROOFCANVAS_RESTART_PHASE=1 \
  PROOFCANVAS_REPORT_FILE=/evidence/restart-report.json \
  node_modules/.bin/playwright test --config=playwright.config.ts \
    --project=proofcanvas-chromium-1440 \
    --grep "controlled application process restart"
'

echo 'Fully decoding both UI-downloaded MP4s inside the pinned renderer image.'
docker exec "$renderer_container" /opt/venv/bin/python /verify-video-evidence.py \
  /evidence/ui-download/proofcanvas-render.mp4 \
  --width 1280 --height 720 --fps 30 --audio required --min-duration 45 --max-duration 60 \
  > "$run_directory/landscape-video-verification.json"
docker exec "$renderer_container" /opt/venv/bin/python /verify-video-evidence.py \
  /evidence/ui-download/proofcanvas-portrait-480x854-24fps.mp4 \
  --width 480 --height 854 --fps 24 --audio forbidden --min-duration 1 --max-duration 310 \
  > "$run_directory/portrait-video-verification.json"

echo 'Fully decoding the UI-downloaded still inside the pinned renderer image.'
docker exec "$renderer_container" /opt/venv/bin/python /verify-png-evidence.py \
  /evidence/ui-download/proofcanvas-still-current.png \
  --width 1280 --height 720 \
  > "$run_directory/still-verification.json"

node "$repository_root/scripts/proofcanvas/validate-e2e.mjs" "$run_directory" "$evidence_directory"
echo "Retained bounded ProofCanvas browser evidence in $evidence_directory"
