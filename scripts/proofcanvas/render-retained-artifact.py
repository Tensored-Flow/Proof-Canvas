from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import av

from proofcanvas_render.jobs import run_manim
from proofcanvas_render.media import validate_render_payload

MANIM_IMAGE = "manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    request_path = Path("/input/render-request.json")
    source_path = Path("/input/generated_scene.py")
    wav_path = Path("/input/fixture.wav")
    project_path = Path("/input/project.json")
    package_path = Path("/input/project.proofcanvas")
    for path in (request_path, source_path, wav_path, project_path, package_path):
        if not path.is_file() or path.is_symlink() or path.stat().st_size <= 0:
            raise RuntimeError(f"Retained render input {path.name} is not a regular file")
    candidate = json.loads(
        request_path.read_bytes(),
        parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"non-finite JSON number {value}")),
    )
    render, quality = validate_render_payload(candidate)
    if quality != "preview" or len(render.assets) != 1 or render.assets[0].mime_type != "audio/wav" or not render.audio.clips:
        raise RuntimeError("Retained render request is outside the canonical preview audio fixture")
    if render.source.sha256 != sha256(source_path) or render.assets[0].sha256 != sha256(wav_path):
        raise RuntimeError("Retained render request does not match its source and WAV inputs")

    job_dir = Path("/output/job")
    job_dir.mkdir(mode=0o700)
    rendered_path, rendered_sha, rendered_bytes, verification = run_manim(render, quality, job_dir)
    if verification.audio_codec != "aac" or verification.decoded_audio_samples <= 0:
        raise RuntimeError("Sidecar did not return verified retained-render stream metadata")
    retained_path = Path("/output/uncountable-yet-zero-length.mp4")
    with rendered_path.open("rb") as source, retained_path.open("xb") as destination:
        shutil.copyfileobj(source, destination, 1024 * 1024)
    retained_path.chmod(0o600)
    if retained_path.stat().st_size != rendered_bytes or sha256(retained_path) != rendered_sha:
        raise RuntimeError("Copied retained MP4 does not match the sidecar-verified render")

    evidence_path = Path("/output/proofcanvas-manim-frame-12s.png")
    with av.open(str(retained_path), mode="r") as container:
        streams = list(container.streams)
        videos = list(container.streams.video)
        audios = list(container.streams.audio)
        if len(streams) != 2 or len(videos) != 1 or len(audios) != 1:
            raise RuntimeError("Retained MP4 does not contain exactly one video and one audio stream")
        video = videos[0]
        audio = audios[0]
        duration = float(container.duration / av.time_base) if container.duration else 0.0
        fps = float(video.average_rate) if video.average_rate else 0.0
        if (
            video.codec_context.name != "h264"
            or (video.codec_context.width, video.codec_context.height) != (render.output.width, render.output.height)
            or abs(fps - render.output.fps) > 0.01
            or audio.codec_context.name != "aac"
            or audio.codec_context.sample_rate != 48_000
            or audio.codec_context.channels != 2
            or not 45 <= duration <= 60
        ):
            raise RuntimeError("Retained MP4 stream metadata is outside the canonical V1 envelope")
        target = min(12.5, duration - 0.5)
        decoded_frames = 0
        evidence_seconds: float | None = None
        for frame in container.decode(video):
            decoded_frames += 1
            seconds = float(frame.pts * frame.time_base) if frame.pts is not None else 0.0
            if evidence_seconds is None and seconds >= target:
                frame.to_image().save(evidence_path)
                evidence_seconds = seconds
        if decoded_frames == 0 or evidence_seconds is None or not evidence_path.is_file():
            raise RuntimeError("Retained MP4 did not yield its decoded evidence frame")

    with av.open(str(retained_path), mode="r") as container:
        audio = list(container.streams.audio)[0]
        decoded_audio_frames = 0
        decoded_audio_samples = 0
        for frame in container.decode(audio):
            decoded_audio_frames += 1
            decoded_audio_samples += frame.samples
    expected_samples = round(render.audio.duration_seconds * 48_000)
    if decoded_audio_frames == 0 or abs(decoded_audio_samples - expected_samples) > 2_048:
        raise RuntimeError("Retained MP4 audio did not fully decode to the expected timeline duration")

    ffmpeg = subprocess.run(
        ["ffmpeg", "-version"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=True,
        timeout=10,
        text=True,
    ).stdout.splitlines()[0]
    metadata = {
        "genuineManimRender": True,
        "sidecarValidated": True,
        "manimVersion": "0.21.0",
        "image": MANIM_IMAGE,
        "ffmpegVersion": ffmpeg,
        "codec": "h264",
        "audioCodec": "aac",
        "videoStreams": 1,
        "audioStreams": 1,
        "audioSampleRate": 48_000,
        "audioChannels": 2,
        "width": render.output.width,
        "height": render.output.height,
        "fps": fps,
        "durationSeconds": duration,
        "audioDurationSeconds": decoded_audio_samples / 48_000,
        "frames": decoded_frames,
        "decodedAudioFrames": decoded_audio_frames,
        "decodedAudioSamples": decoded_audio_samples,
        "evidenceFrameSeconds": evidence_seconds,
        "evidenceFrameSha256": sha256(evidence_path),
        "bytes": retained_path.stat().st_size,
        "sha256": sha256(retained_path),
        "sourceSha256": sha256(source_path),
        "projectSha256": sha256(project_path),
        "packageSha256": sha256(package_path),
        "audioFixtureSha256": sha256(wav_path),
    }
    Path("/output/render-metadata.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, sort_keys=True))


if __name__ == "__main__":
    main()
