#!/usr/bin/env bash
set -euo pipefail

readonly repository_root="$(git rev-parse --show-toplevel)"
readonly artifact_directory="$repository_root/examples/proofcanvas"
readonly project_path="$artifact_directory/uncountable-yet-zero-length.proofcanvas.json"
readonly source_path="$artifact_directory/uncountable-yet-zero-length.py"
readonly wav_path="$artifact_directory/proofcanvas-deterministic-pulse-90s.wav"
readonly package_path="$artifact_directory/uncountable-yet-zero-length.proofcanvas"
readonly evidence_directory="$artifact_directory/render-evidence"
readonly runner_path="$repository_root/scripts/proofcanvas/render-retained-artifact.py"
readonly renderer_image='proofcanvas-render:retained-artifact'
readonly run_directory="$(mktemp -d /tmp/proofcanvas-render-example.XXXXXX)"

cleanup() {
  case "$run_directory" in
    /tmp/proofcanvas-render-example.*) rm -rf -- "$run_directory" ;;
    *) echo 'refusing to remove an unexpected render directory' >&2; return 1 ;;
  esac
}
trap cleanup EXIT INT TERM

for required in "$project_path" "$source_path" "$wav_path" "$package_path" "$runner_path"; do
  if [[ ! -f "$required" || -L "$required" ]]; then
    echo "Missing regular retained-render input: $required" >&2
    exit 2
  fi
done

npx tsx scripts/proofcanvas/artifact-render-request.ts \
  "$project_path" "$source_path" "$wav_path" "$run_directory/render-request.json"

docker build --target proofcanvas-render-runtime \
  --tag "$renderer_image" \
  "$repository_root/services/proofcanvas-render"

timeout --signal=TERM --kill-after=15s 600s docker run --rm --init \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 \
  --memory=3g \
  --memory-swap=3g \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=700,uid=1000,gid=1000 \
  --volume "$runner_path:/runner/render-retained-artifact.py:ro" \
  --volume "$run_directory/render-request.json:/input/render-request.json:ro" \
  --volume "$source_path:/input/generated_scene.py:ro" \
  --volume "$wav_path:/input/fixture.wav:ro" \
  --volume "$project_path:/input/project.json:ro" \
  --volume "$package_path:/input/project.proofcanvas:ro" \
  --volume "$run_directory:/output:rw" \
  --env PYTHONPATH=/app \
  --workdir /app \
  "$renderer_image" \
  python /runner/render-retained-artifact.py

for output in uncountable-yet-zero-length.mp4 proofcanvas-manim-frame-12s.png render-metadata.json; do
  if [[ ! -f "$run_directory/$output" || -L "$run_directory/$output" ]]; then
    echo "Trusted sidecar did not produce $output" >&2
    exit 1
  fi
done

mkdir -p -- "$evidence_directory"
install -m 0644 -- "$run_directory/uncountable-yet-zero-length.mp4" "$artifact_directory/uncountable-yet-zero-length.mp4"
install -m 0644 -- "$run_directory/proofcanvas-manim-frame-12s.png" "$evidence_directory/proofcanvas-manim-frame-12s.png"
install -m 0644 -- "$run_directory/render-metadata.json" "$artifact_directory/render-metadata.json"

echo "Rendered $artifact_directory/uncountable-yet-zero-length.mp4 with trusted video and audio streams"
