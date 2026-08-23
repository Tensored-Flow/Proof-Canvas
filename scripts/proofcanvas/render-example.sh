#!/usr/bin/env bash
set -euo pipefail

readonly manim_image='manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3'
readonly repository_root="$(git rev-parse --show-toplevel)"
readonly source_path="$repository_root/examples/proofcanvas/uncountable-yet-zero-length.py"
readonly artifact_directory="$repository_root/examples/proofcanvas"
readonly evidence_directory="$artifact_directory/render-evidence"
readonly run_directory="$(mktemp -d /tmp/proofcanvas-render-example.XXXXXX)"

cleanup() {
  case "$run_directory" in
    /tmp/proofcanvas-render-example.*) rm -rf -- "$run_directory" ;;
    *) echo 'refusing to remove an unexpected render directory' >&2; return 1 ;;
  esac
}
trap cleanup EXIT INT TERM

if [[ ! -f "$source_path" ]]; then
  echo 'Generate ProofCanvas artifacts before rendering.' >&2
  exit 2
fi

mkdir -p -- "$evidence_directory"

timeout --signal=TERM --kill-after=10s 240s docker run --rm --init \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 \
  --memory=3g \
  --memory-swap=3g \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g,mode=700,uid=1000,gid=1000 \
  --tmpfs /manim:rw,nosuid,nodev,size=512m,mode=700,uid=1000,gid=1000 \
  --volume "$source_path:/input/generated_scene.py:ro" \
  --volume "$run_directory:/output:rw" \
  --workdir /input \
  "$manim_image" \
  python -m manim render \
    --renderer cairo \
    --disable_caching \
    --seed 0 \
    --progress_bar none \
    --verbosity warning \
    --max-inflight-encoders 1 \
    --format mp4 \
    --fps 15 \
    --resolution 854,480 \
    --media_dir /output \
    --output_file proofcanvas-demo \
    /input/generated_scene.py GeneratedScene

mapfile -t rendered_videos < <(rg --files "$run_directory" | rg '/proofcanvas-demo\.mp4$')
if [[ "${#rendered_videos[@]}" -ne 1 ]]; then
  echo 'Manim did not produce exactly one expected MP4.' >&2
  exit 1
fi

readonly rendered_video="${rendered_videos[0]}"

docker run --rm --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --pids-limit=64 --memory=512m --memory-swap=512m \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=700,uid=1000,gid=1000 \
  --tmpfs /manim:rw,nosuid,nodev,size=64m,mode=700,uid=1000,gid=1000 \
  --volume "$rendered_video:/input/video.mp4:ro" \
  --volume "$source_path:/input/generated_scene.py:ro" \
  --volume "$run_directory:/output:rw" \
  "$manim_image" \
  python -c '
import av, hashlib, json
from pathlib import Path

video_path = Path("/input/video.mp4")
source_path = Path("/input/generated_scene.py")
container = av.open(str(video_path))
streams = container.streams.video
if len(streams) != 1:
    raise SystemExit("expected exactly one video stream")
stream = streams[0]
duration = float(container.duration / av.time_base) if container.duration else 0.0
fps = float(stream.average_rate) if stream.average_rate else 0.0
if (stream.width, stream.height) != (854, 480):
    raise SystemExit("unexpected video dimensions")
if not 14.9 <= fps <= 15.1:
    raise SystemExit("unexpected frame rate")
if not 20.0 <= duration <= 35.0:
    raise SystemExit("unexpected demonstration duration")
target = min(12.5, max(0.0, duration - 0.5))
container.seek(int(target * av.time_base), backward=True)
frame = None
for candidate in container.decode(video=0):
    frame = candidate
    timestamp = float(candidate.pts * candidate.time_base) if candidate.pts is not None else 0.0
    if timestamp >= target:
        break
if frame is None:
    raise SystemExit("video contained no decodable frame")
frame.to_image().save("/output/proofcanvas-manim-frame-12s.png")
digest = hashlib.sha256(video_path.read_bytes()).hexdigest()
metadata = {
    "genuineManimRender": True,
    "manimVersion": "0.21.0",
    "image": "manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3",
    "codec": stream.codec_context.name,
    "width": stream.width,
    "height": stream.height,
    "fps": fps,
    "durationSeconds": duration,
    "frames": stream.frames,
    "evidenceFrameSeconds": timestamp,
    "bytes": video_path.stat().st_size,
    "sha256": digest,
    "sourceSha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
}
Path("/output/render-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
print(json.dumps(metadata, sort_keys=True))
'

install -m 0644 -- "$rendered_video" "$artifact_directory/uncountable-yet-zero-length.mp4"
install -m 0644 -- "$run_directory/proofcanvas-manim-frame-12s.png" "$evidence_directory/proofcanvas-manim-frame-12s.png"
install -m 0644 -- "$run_directory/render-metadata.json" "$artifact_directory/render-metadata.json"

echo "Rendered $artifact_directory/uncountable-yet-zero-length.mp4"
