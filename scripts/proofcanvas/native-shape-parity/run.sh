#!/usr/bin/env bash
set -euo pipefail

readonly playwright_image='mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e'
readonly manim_image='manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3'

if [[ "${1:-}" == '--help' ]]; then
  cat <<'USAGE'
Usage: bash scripts/proofcanvas/native-shape-parity/run.sh

Builds the production app, seeds one deterministic schema-v4 project, compiles
that exact persisted document with compileManim, captures its real CanvasStage
SVG/PNG in digest-pinned Chromium, renders the compiler Python in digest-pinned
Manim 0.21/Cairo, and compares per-shape normalized masks. The comparison gates
bounding boxes, centroids, area ratios, symmetric coverage/distance, and dashed
component topology with antialias tolerances recorded in parity-report.json.
The same authenticated production-browser test then proves the 16-card shape
palette, click and drag/drop authoring, exact native controls, history, locked
and playback refusal, and the supported 1024x1366 portrait editor layout.

The default npm/Jest and browser suites do not discover this dedicated harness.
Passing evidence is retained in examples/proofcanvas/native-shape-parity/.
USAGE
  exit 0
fi
if [[ $# -ne 0 ]]; then echo 'This harness accepts only --help.' >&2; exit 2; fi

readonly repository_root="$(git rev-parse --show-toplevel)"
readonly run_directory="$(mktemp -d /tmp/proofcanvas-native-shape-parity.XXXXXX)"
readonly evidence_parent="$repository_root/examples/proofcanvas"
readonly evidence_directory="$evidence_parent/native-shape-parity"
readonly owner_password="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
readonly host_uid="$(id -u)"
readonly host_gid="$(id -g)"
publish_directory=''
publication_state="$run_directory/publication-state.json"
publication_pending=0

cleanup() {
  local exit_status=$?
  local rollback_failed=0
  if [[ "$publication_pending" == '1' ]]; then
    python3 "$repository_root/scripts/proofcanvas/native-shape-parity/publish.py" rollback \
      "$repository_root" "$publish_directory" "$evidence_directory" "$publication_state" || {
        echo 'Native-shape parity publication rollback failed; manual recovery is required.' >&2
        rollback_failed=1
      }
  fi
  if [[ "$rollback_failed" == '1' ]]; then
    echo "Preserved publication recovery state: $publication_state" >&2
    echo "Preserved publication staging path: $publish_directory" >&2
    return "$exit_status"
  fi
  if [[ -n "$publish_directory" && -e "$publish_directory" ]]; then
    case "$publish_directory" in
      "$evidence_parent"/.native-shape-parity.publish.*) rm -rf -- "$publish_directory" ;;
      *) echo 'Refusing to remove an unexpected parity publication directory.' >&2 ;;
    esac
  fi
  if [[ "$exit_status" -ne 0 && "${PROOFCANVAS_PARITY_KEEP_FAILED:-0}" == '1' ]]; then
    echo "Native-shape parity failed; retained diagnostics: $run_directory" >&2
    return
  fi
  case "$run_directory" in
    /tmp/proofcanvas-native-shape-parity.*) rm -rf -- "$run_directory" ;;
    *) echo 'Refusing to remove an unexpected native-shape parity directory.' >&2 ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

command -v docker >/dev/null 2>&1 || { echo 'Docker is required for native-shape parity.' >&2; exit 2; }
[[ -f "$repository_root/package.json" && -f "$repository_root/services/proofcanvas-render/Dockerfile" ]] || {
  echo 'Run this command from the ProofCanvas repository.' >&2
  exit 2
}
[[ -d "$evidence_parent" && ! -L "$evidence_parent" && "$(realpath -e "$evidence_parent")" == "$evidence_parent" ]] || {
  echo 'The ProofCanvas evidence parent must be one real repository directory.' >&2
  exit 2
}
rg -Fqx "FROM $manim_image AS proofcanvas-render-base" "$repository_root/services/proofcanvas-render/Dockerfile" || {
  echo 'The repository renderer is not pinned to the parity harness Manim digest.' >&2
  exit 2
}

python3 "$repository_root/scripts/proofcanvas/native-shape-parity/source_snapshot.py" \
  "$repository_root" "$run_directory/build-input-snapshot.json"

echo 'Building the production Next.js bundle used by the browser capture.'
(cd "$repository_root" && timeout --signal=TERM --kill-after=15s 8m npm run build)

echo 'Capturing the exact seeded project in digest-pinned Chromium.'
timeout --signal=TERM --kill-after=15s 8m docker run --rm --init \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=512 \
  --memory=3g \
  --memory-swap=3g \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g,mode=1777 \
  --tmpfs /dev/shm:rw,nosuid,nodev,size=512m,mode=1777 \
  --tmpfs "/workspace/.next/cache:rw,nosuid,nodev,size=128m,mode=700,uid=$host_uid,gid=$host_gid" \
  --user "$host_uid:$host_gid" \
  --volume "$repository_root:/workspace:ro" \
  --volume "$run_directory:/evidence:rw" \
  --workdir /workspace \
  --env CI=1 \
  --env HOME=/tmp \
  --env NEXT_TELEMETRY_DISABLED=1 \
  --env NODE_ENV=production \
  --env PROOFCANVAS_DATA_DIR=/tmp/proofcanvas-parity-data \
  --env PROOFCANVAS_PARITY_OWNER_PASSWORD="$owner_password" \
  --env PROOFCANVAS_PARITY_EVIDENCE_DIR=/evidence \
  "$playwright_image" \
  bash scripts/proofcanvas/native-shape-parity/run-browser-inner.sh

echo 'Rendering the real compiler source in digest-pinned Manim 0.21/Cairo.'
timeout --signal=TERM --kill-after=15s 8m docker run --rm --init \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 \
  --memory=2g \
  --memory-swap=2g \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
  --tmpfs /manim:rw,nosuid,nodev,size=512m,mode=700,uid="$host_uid",gid="$host_gid" \
  --user "$host_uid:$host_gid" \
  --volume "$run_directory:/evidence:rw" \
  --workdir /manim \
  --env HOME=/tmp \
  "$manim_image" \
  python -m manim render \
    --renderer cairo \
    --disable_caching \
    --seed 0 \
    --progress_bar none \
    --verbosity warning \
    --save_last_frame \
    --resolution 960,540 \
    --media_dir /evidence/manim-media \
    --output_file native-shape-parity \
    /evidence/generated.py GeneratedScene \
  2>&1 | tee "$run_directory/manim-render.log"

python3 -c 'from pathlib import Path; path = Path(__import__("sys").argv[1]); path.write_text(path.read_text(encoding="utf-8").rstrip() + "\n", encoding="utf-8")' \
  "$run_directory/manim-render.log"

mapfile -t rendered_frames < <(find "$run_directory/manim-media" -type f -name '*.png' -print)
if [[ "${#rendered_frames[@]}" -ne 1 ]]; then
  echo "Expected exactly one retained Manim PNG, found ${#rendered_frames[@]}." >&2
  exit 1
fi
install -m 0600 -- "${rendered_frames[0]}" "$run_directory/manim-frame.png"

python3 "$repository_root/scripts/proofcanvas/native-shape-parity/source_snapshot.py" \
  "$repository_root" "$run_directory/build-input-snapshot-after.json"
cmp --silent "$run_directory/build-input-snapshot.json" "$run_directory/build-input-snapshot-after.json" || {
  echo 'Runtime inputs or harness changed while parity evidence was being generated.' >&2
  exit 1
}

echo 'Comparing normalized per-shape visible geometry.'
timeout --signal=TERM --kill-after=15s 2m docker run --rm --init \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=64 \
  --memory=1g \
  --memory-swap=1g \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
  --user "$host_uid:$host_gid" \
  --volume "$repository_root:/workspace:ro" \
  --volume "$run_directory:/evidence:rw" \
  --workdir /workspace \
  --env HOME=/tmp \
  "$manim_image" \
  python scripts/proofcanvas/native-shape-parity/analyze.py /evidence /workspace

publish_directory="$(mktemp -d "$evidence_parent/.native-shape-parity.publish.XXXXXX")"
for artifact in \
  project.proofcanvas.json generated.py compiler.json \
  browser-stage.png browser-stage.svg browser-capture.json browser-authoring.json browser-report.json \
  authoring-desktop-1440x900.png authoring-locked-1440x900.png \
  authoring-playback-1440x900.png authoring-portrait-1024x1366.png \
  manim-frame.png manim-render.log parity-report.json evidence-manifest.json \
  comparison-ellipse.png comparison-polygon.png comparison-dashed-line.png \
  comparison-double-arrow.png comparison-freeform-path.png; do
  [[ -f "$run_directory/$artifact" ]] || { echo "Missing parity artifact $artifact" >&2; exit 1; }
  install -m 0644 -- "$run_directory/$artifact" "$publish_directory/$artifact"
done

echo 'Verifying the exact staged parity evidence manifest.'
timeout --signal=TERM --kill-after=15s 2m docker run --rm --init \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=64 \
  --memory=1g \
  --memory-swap=1g \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
  --user "$host_uid:$host_gid" \
  --volume "$repository_root:/workspace:ro" \
  --volume "$publish_directory:/evidence:ro" \
  --workdir /workspace \
  --env HOME=/tmp \
  "$manim_image" \
  python scripts/proofcanvas/native-shape-parity/analyze.py --verify-retained /evidence /workspace

publication_pending=1
python3 "$repository_root/scripts/proofcanvas/native-shape-parity/publish.py" prepare \
  "$repository_root" "$publish_directory" "$evidence_directory" "$publication_state"

echo 'Re-verifying the published parity evidence from its final path.'
timeout --signal=TERM --kill-after=15s 2m docker run --rm --init \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=64 \
  --memory=1g \
  --memory-swap=1g \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
  --user "$host_uid:$host_gid" \
  --volume "$repository_root:/workspace:ro" \
  --volume "$evidence_directory:/evidence:ro" \
  --workdir /workspace \
  --env HOME=/tmp \
  "$manim_image" \
  python scripts/proofcanvas/native-shape-parity/analyze.py --verify-retained /evidence /workspace

python3 "$repository_root/scripts/proofcanvas/native-shape-parity/publish.py" finalize \
  "$repository_root" "$publish_directory" "$evidence_directory" "$publication_state"
publication_pending=0
publish_directory=''

echo "Native-shape parity PASS. Evidence: $evidence_directory"
node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({passed:p.passed,inputs:p.inputs,failures:p.failures},null,2))' "$evidence_directory/parity-report.json"
