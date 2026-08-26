#!/usr/bin/env bash
set -euo pipefail

: "${PROOFCANVAS_PARITY_OWNER_PASSWORD:?missing parity owner password}"
: "${PROOFCANVAS_PARITY_EVIDENCE_DIR:?missing parity evidence directory}"

cleanup() {
  [[ -n "${proxy_pid:-}" ]] && kill "$proxy_pid" >/dev/null 2>&1 || true
  [[ -n "${next_pid:-}" ]] && kill "$next_pid" >/dev/null 2>&1 || true
  [[ -n "${proxy_pid:-}" ]] && wait "$proxy_pid" >/dev/null 2>&1 || true
  [[ -n "${next_pid:-}" ]] && wait "$next_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node_modules/.bin/tsx scripts/proofcanvas/native-shape-parity/seed-and-compile.ts "$PROOFCANVAS_PARITY_EVIDENCE_DIR"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" \
  -keyout /tmp/proofcanvas-parity-key.pem -out /tmp/proofcanvas-parity-cert.pem \
  >/tmp/proofcanvas-parity-openssl.log 2>&1
chmod 600 /tmp/proofcanvas-parity-key.pem

owner_hash="$(printf %s "$PROOFCANVAS_PARITY_OWNER_PASSWORD" | node_modules/.bin/tsx scripts/proofcanvas/hash-password.ts)"
session_secret="$(openssl rand -hex 32)"

env -u PROOFCANVAS_PARITY_OWNER_PASSWORD \
  PROOFCANVAS_APP_ORIGIN=https://127.0.0.1:3217 \
  PROOFCANVAS_OWNER_PASSWORD_HASH="$owner_hash" \
  PROOFCANVAS_SESSION_SECRET="$session_secret" \
  node_modules/.bin/next start --hostname 127.0.0.1 --port 3218 \
  >/tmp/proofcanvas-parity-next.log 2>&1 &
next_pid=$!

env -u PROOFCANVAS_PARITY_OWNER_PASSWORD \
  PROOFCANVAS_HTTPS_CERT=/tmp/proofcanvas-parity-cert.pem \
  PROOFCANVAS_HTTPS_KEY=/tmp/proofcanvas-parity-key.pem \
  node scripts/proofcanvas/https-proxy.mjs 3217 3218 \
  >/tmp/proofcanvas-parity-https.log 2>&1 &
proxy_pid=$!

for attempt in $(seq 1 160); do
  if curl --insecure --fail --silent --show-error https://127.0.0.1:3217/login >/dev/null; then break; fi
  if ! kill -0 "$next_pid" >/dev/null 2>&1; then tail -n 120 /tmp/proofcanvas-parity-next.log >&2; exit 1; fi
  if ! kill -0 "$proxy_pid" >/dev/null 2>&1; then tail -n 120 /tmp/proofcanvas-parity-https.log >&2; exit 1; fi
  if [[ "$attempt" -eq 160 ]]; then
    tail -n 120 /tmp/proofcanvas-parity-next.log >&2
    tail -n 120 /tmp/proofcanvas-parity-https.log >&2
    exit 1
  fi
  sleep 0.25
done

PROOFCANVAS_BASE_URL=https://127.0.0.1:3217 \
  node_modules/.bin/playwright test \
  --config=scripts/proofcanvas/native-shape-parity/playwright.config.ts

node scripts/proofcanvas/native-shape-parity/sanitize-browser-report.mjs \
  "$PROOFCANVAS_PARITY_EVIDENCE_DIR/browser-report.json"
