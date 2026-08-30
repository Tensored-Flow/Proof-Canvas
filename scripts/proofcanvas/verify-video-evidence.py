#!/usr/bin/env python3
"""Full-decode one browser-downloaded ProofCanvas MP4 with an exact profile."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import av


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--fps", type=int, required=True)
    parser.add_argument("--audio", choices=("required", "forbidden"), required=True)
    parser.add_argument("--min-duration", type=float, default=1 / 60)
    parser.add_argument("--max-duration", type=float, default=310)
    args = parser.parse_args()

    path = args.video.resolve(strict=True)
    if path.is_symlink() or not path.is_file() or not 32 <= path.stat().st_size <= 256 * 1024 * 1024:
        raise SystemExit("video evidence is not a bounded regular file")
    with path.open("rb") as stream:
        if stream.read(12)[4:8] != b"ftyp":
            raise SystemExit("video evidence is not an MP4 container")

    with av.open(str(path), mode="r") as container:
        streams = list(container.streams)
        videos = list(container.streams.video)
        audios = list(container.streams.audio)
        expected_audio = 1 if args.audio == "required" else 0
        if len(videos) != 1 or len(audios) != expected_audio or len(streams) != 1 + expected_audio:
            raise SystemExit("video evidence has an unexpected stream layout")
        video = videos[0]
        fps = float(video.average_rate) if video.average_rate else 0
        if (
            video.codec_context.name != "h264"
            or (video.codec_context.width, video.codec_context.height) != (args.width, args.height)
            or abs(fps - args.fps) > 0.001
        ):
            raise SystemExit("video evidence does not match its exact H264 output profile")
        duration = float(container.duration / av.time_base) if container.duration else 0
        if not math.isfinite(duration) or not args.min_duration <= duration <= args.max_duration:
            raise SystemExit("video evidence duration is outside its expected envelope")
        frames = sum(1 for _ in container.decode(video))
        if frames == 0 or abs(frames / fps - duration) > 1 / fps + (1024 / 48_000 if audios else 0) + 0.02:
            raise SystemExit("video evidence did not fully decode to its container duration")

    audio_samples = 0
    if args.audio == "required":
        with av.open(str(path), mode="r") as container:
            audio = list(container.streams.audio)[0]
            if audio.codec_context.name != "aac" or audio.codec_context.sample_rate != 48_000 or audio.codec_context.channels not in {1, 2}:
                raise SystemExit("video evidence audio is not bounded 48kHz AAC")
            audio_samples = sum(frame.samples for frame in container.decode(audio))
            if audio_samples == 0:
                raise SystemExit("video evidence contains no decodable audio")

    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    print(json.dumps({
        "path": str(path), "sha256": digest, "bytes": path.stat().st_size,
        "videoCodec": "h264", "audioCodec": "aac" if args.audio == "required" else None,
        "width": args.width, "height": args.height, "fps": fps,
        "durationSeconds": duration, "decodedFrames": frames, "decodedAudioSamples": audio_samples,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
