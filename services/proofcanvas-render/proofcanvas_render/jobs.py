from __future__ import annotations

import hashlib
import inspect
import io
import json
import math
import os
import re
import resource
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Callable, Literal

from .media import AudioClip, RenderOutput, ValidatedRender, empty_render, materialize_assets
from .policy import ValidatedSource

Quality = Literal["preview", "production"]
JobStatus = Literal["pending", "running", "succeeded", "failed", "cancelled"]
MAX_VIDEO_BYTES = 256 * 1024 * 1024
MAX_STILL_BYTES = 16 * 1024 * 1024
MAX_LOG_BYTES = 64 * 1024
RENDER_TIMEOUT_SECONDS = 180
JOB_TTL_SECONDS = 600
JANITOR_INTERVAL_SECONDS = 30
JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{24}$")
MAX_RENDER_DURATION_SECONDS = 310


class QueueFullError(RuntimeError):
    pass


class JobNotFoundError(LookupError):
    pass


class VideoUnavailableError(RuntimeError):
    pass


class RenderCancelledError(RuntimeError):
    pass


class JobNotCancellableError(RuntimeError):
    pass


@dataclass
class RenderJob:
    id: str
    quality: Quality
    source_sha256: str
    output: RenderOutput
    status: JobStatus
    created_at: float
    updated_at: float
    started_at: float | None = None
    completed_at: float | None = None
    error_code: str | None = None
    error_message: str | None = None
    video_path: Path | None = None
    video_sha256: str | None = None
    video_bytes: int | None = None
    video_verification: VideoVerification | None = None

    def public(self) -> dict[str, object]:
        return {
            "id": self.id,
            "quality": self.quality,
            "sourceSha256": self.source_sha256,
            "output": {
                "width": self.output.width,
                "height": self.output.height,
                "fps": self.output.fps,
                "expectedDurationSeconds": self.output.expected_duration_seconds,
            },
            "status": self.status,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "startedAt": self.started_at,
            "completedAt": self.completed_at,
            "error": (
                {"code": self.error_code, "message": self.error_message}
                if self.error_code and self.error_message
                else None
            ),
            "video": (
                {
                    "sha256": self.video_sha256,
                    "bytes": self.video_bytes,
                    **(
                        {
                            "width": self.video_verification.width,
                            "height": self.video_verification.height,
                            "fps": self.video_verification.fps,
                            "durationSeconds": self.video_verification.duration_seconds,
                            "videoCodec": self.video_verification.video_codec,
                            "audioCodec": self.video_verification.audio_codec,
                            "videoStreams": 1,
                            "audioStreams": 1 if self.video_verification.audio_codec else 0,
                            "decodedFrames": self.video_verification.decoded_frames,
                            "decodedAudioSamples": self.video_verification.decoded_audio_samples,
                        }
                        if self.video_verification is not None
                        else {}
                    ),
                }
                if self.status == "succeeded"
                else None
            ),
        }


@dataclass(frozen=True)
class RenderStill:
    content: bytes
    sha256: str
    source_sha256: str
    time_seconds: float


@dataclass(frozen=True)
class VideoVerification:
    width: int
    height: int
    fps: float
    duration_seconds: float
    video_codec: str
    audio_codec: str | None
    decoded_frames: int
    decoded_audio_samples: int


Runner = Callable[..., tuple[Path, str, int]]


def _append_log_tail(tail: bytearray, chunk: bytes) -> None:
    if len(chunk) >= MAX_LOG_BYTES:
        tail[:] = chunk[-MAX_LOG_BYTES:]
        return
    overflow = len(tail) + len(chunk) - MAX_LOG_BYTES
    if overflow > 0:
        del tail[:overflow]
    tail.extend(chunk)


def _process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # killpg(0) also reports unreaped zombies. They cannot execute or retain
    # renderer resources, so do not mistake a dead group for a live escape.
    proc_root = Path("/proc")
    if proc_root.is_dir():
        live_member = False
        for entry in proc_root.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry / "stat").read_text(encoding="utf-8").split()
                if len(fields) > 4 and int(fields[4]) == process_group_id and fields[2] != "Z":
                    live_member = True
                    break
            except (OSError, ValueError):
                continue
        return live_member
    return True


def _wait_for_process_group_exit(process: subprocess.Popen[bytes], process_group_id: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        process.poll()
        if not _process_group_exists(process_group_id):
            return True
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
    process.poll()
    return not _process_group_exists(process_group_id)


def _terminate_process_group(process: subprocess.Popen[bytes], grace_seconds: float = 5) -> None:
    process_group_id = process.pid
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if not _wait_for_process_group_exit(process, process_group_id, grace_seconds):
        try:
            os.killpg(process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    if not _wait_for_process_group_exit(process, process_group_id, 2):
        raise RuntimeError("Renderer process group could not be terminated")


def _wait_with_bounded_log(
    process: subprocess.Popen[bytes],
    timeout: float,
    termination_grace_seconds: float = 5,
    cancel_event: threading.Event | None = None,
) -> bytes:
    if process.stdout is None:
        raise RuntimeError("Renderer log pipe was not created")
    tail = bytearray()
    reader_errors: list[Exception] = []

    def drain() -> None:
        try:
            while chunk := process.stdout.read(16 * 1024):
                _append_log_tail(tail, chunk)
        except (OSError, ValueError) as error:
            reader_errors.append(error)

    reader = threading.Thread(target=drain, name="proofcanvas-render-log", daemon=True)
    reader.start()
    process_group_id = process.pid
    timeout_error: subprocess.TimeoutExpired | None = None
    termination_error: RuntimeError | None = None
    orphaned_group = False
    cancelled = False
    deadline = time.monotonic() + timeout
    while process.poll() is None:
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            try:
                _terminate_process_group(process, termination_grace_seconds)
            except RuntimeError as group_error:
                termination_error = group_error
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timeout_error = subprocess.TimeoutExpired(process.args, timeout)
            try:
                _terminate_process_group(process, termination_grace_seconds)
            except RuntimeError as group_error:
                termination_error = group_error
            break
        try:
            process.wait(timeout=min(0.1, remaining))
        except subprocess.TimeoutExpired:
            continue
    if not cancelled and timeout_error is None and termination_error is None:
        if not _wait_for_process_group_exit(process, process_group_id, 0.1):
            orphaned_group = True
            try:
                _terminate_process_group(process, termination_grace_seconds)
            except RuntimeError as group_error:
                termination_error = group_error
    reader.join(timeout=5)
    if reader.is_alive():
        process.stdout.close()
        reader.join(timeout=1)
    else:
        process.stdout.close()
    if termination_error is not None:
        raise termination_error
    if timeout_error is not None:
        raise RuntimeError("Render timed out") from timeout_error
    if cancelled:
        raise RenderCancelledError("Render was cancelled")
    if orphaned_group:
        raise RuntimeError("Renderer process group outlived its leader")
    if reader.is_alive() or reader_errors:
        raise RuntimeError("Renderer log capture did not terminate cleanly")
    return bytes(tail)


def _apply_child_limits(pid: int) -> None:
    resource.prlimit(pid, resource.RLIMIT_CPU, (RENDER_TIMEOUT_SECONDS, RENDER_TIMEOUT_SECONDS))
    resource.prlimit(pid, resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.prlimit(pid, resource.RLIMIT_FSIZE, (MAX_VIDEO_BYTES, MAX_VIDEO_BYTES))
    # Up to 64 admitted audio clip inputs plus the video, output, libraries,
    # and bounded log pipe still fit inside this explicit descriptor ceiling.
    resource.prlimit(pid, resource.RLIMIT_NOFILE, (128, 128))


def _safe_environment(job_dir: Path) -> dict[str, str]:
    return {
        "HOME": str(job_dir / "home"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "MKL_NUM_THREADS": "1",
        "NUMEXPR_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "PATH": "/opt/venv/bin:/usr/local/texlive/bin/x86_64-linux:/usr/local/bin:/usr/bin:/bin",
        "PYTHONHASHSEED": "0",
        "TMPDIR": str(job_dir / "tmp"),
        "XDG_CACHE_HOME": str(job_dir / "cache"),
        "XDG_CONFIG_HOME": str(job_dir / "config"),
        "http_proxy": "",
        "https_proxy": "",
        "no_proxy": "*",
    }


def _run_bounded_command(argv: list[str], job_dir: Path, timeout: float, cancel_event: threading.Event | None = None) -> bytes:
    process = subprocess.Popen(
        argv,
        cwd=job_dir,
        env=_safe_environment(job_dir),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
        shell=False,
        start_new_session=True,
    )
    try:
        _apply_child_limits(process.pid)
    except (ProcessLookupError, PermissionError, OSError, ValueError) as error:
        try:
            _terminate_process_group(process, 0)
        except RuntimeError:
            process.kill()
            process.wait()
        if process.stdout is not None:
            process.stdout.close()
        raise RuntimeError("Renderer resource isolation could not be established") from error
    output = _wait_with_bounded_log(process, timeout, cancel_event=cancel_event)
    if process.returncode != 0:
        raise RuntimeError(f"Media command exited with status {process.returncode}: {output[-800:].decode('utf-8', errors='replace')}")
    return output


def _validate_video_stream(
    video: Path,
    output: RenderOutput,
    *,
    expect_audio: bool = False,
    expected_audio_duration: float | None = None,
    cancel_event: threading.Event | None = None,
) -> VideoVerification:
    import av

    expected_fps, expected_width, expected_height = output.fps, output.width, output.height
    try:
        with av.open(str(video), mode="r") as container:
            streams = list(container.streams)
            video_streams = list(container.streams.video)
            audio_streams = list(container.streams.audio)
            if (
                len(video_streams) != 1
                or len(audio_streams) != (1 if expect_audio else 0)
                or len(streams) != 1 + (1 if expect_audio else 0)
                or "mp4" not in container.format.name.split(",")
            ):
                raise RuntimeError("Renderer output has an unexpected stream layout")
            stream = video_streams[0]
            if stream.codec_context.name != "h264":
                raise RuntimeError("Renderer output has an unexpected video codec")
            if stream.codec_context.width != expected_width or stream.codec_context.height != expected_height:
                raise RuntimeError("Renderer output has unexpected dimensions")
            if stream.average_rate is None or abs(float(stream.average_rate) - expected_fps) > 0.001:
                raise RuntimeError("Renderer output has an unexpected frame rate")
            if container.duration is not None and container.duration / av.time_base > MAX_RENDER_DURATION_SECONDS:
                raise RuntimeError("Renderer output duration exceeds the limit")
            frame_count = 0
            for frame in container.decode(stream):
                if cancel_event is not None and cancel_event.is_set():
                    raise RenderCancelledError("Render was cancelled")
                frame_count += 1
                if frame.width != expected_width or frame.height != expected_height:
                    raise RuntimeError("Renderer output contains an invalid frame")
                if frame_count > expected_fps * MAX_RENDER_DURATION_SECONDS + 1:
                    raise RuntimeError("Renderer output contains too many frames")
            if frame_count == 0:
                raise RuntimeError("Renderer output contains no decodable frames")
            expected_frames = round(output.expected_duration_seconds * expected_fps)
            if abs(frame_count - expected_frames) > 1:
                raise RuntimeError("Renderer output duration does not match the authored timeline")
            audio_samples = 0
            if expect_audio:
                audio = audio_streams[0]
                if audio.codec_context.name != "aac" or audio.codec_context.sample_rate != 48_000 or audio.codec_context.channels not in {1, 2}:
                    raise RuntimeError("Renderer output has an unexpected audio codec")
        if expect_audio:
            # The full video decode consumes the first demuxer, so prove the
            # complete audio stream through a fresh container.
            with av.open(str(video), mode="r") as audio_container:
                audio = list(audio_container.streams.audio)[0]
                audio_frames = 0
                audio_samples = 0
                for frame in audio_container.decode(audio):
                    if cancel_event is not None and cancel_event.is_set():
                        raise RenderCancelledError("Render was cancelled")
                    audio_frames += 1
                    audio_samples += frame.samples
                    if audio_samples > 48_000 * (MAX_RENDER_DURATION_SECONDS + 1):
                        raise RuntimeError("Renderer output contains too many audio samples")
                if audio_frames == 0 or audio_samples == 0:
                    raise RuntimeError("Renderer output contains no decodable audio")
                if expected_audio_duration is None or abs(audio_samples - round(expected_audio_duration * 48_000)) > 2_048:
                    raise RuntimeError("Renderer audio duration does not match the authored audio plan")
        duration_seconds = frame_count / expected_fps
        return VideoVerification(
            expected_width,
            expected_height,
            float(expected_fps),
            duration_seconds,
            "h264",
            "aac" if expect_audio else None,
            frame_count,
            audio_samples,
        )
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError("Renderer output could not be decoded as MP4") from error


def _find_video(job_dir: Path, output: RenderOutput, cancel_event: threading.Event | None = None) -> Path:
    candidates = [path for path in job_dir.rglob("proofcanvas-output.mp4") if path.is_file() and not path.is_symlink()]
    if len(candidates) != 1:
        raise RuntimeError("Renderer did not produce exactly one MP4")
    video = candidates[0].resolve(strict=True)
    if job_dir.resolve() not in video.parents:
        raise RuntimeError("Renderer output escaped the job directory")
    size = video.stat().st_size
    if size < 32 or size > MAX_VIDEO_BYTES:
        raise RuntimeError("Renderer output size is invalid")
    with video.open("rb") as stream:
        header = stream.read(12)
    if len(header) < 12 or header[4:8] != b"ftyp":
        raise RuntimeError("Renderer output is not an MP4 container")
    _validate_video_stream(video, output, cancel_event=cancel_event)
    return video


def _finite_literal(value: float) -> str:
    if not math.isfinite(value):
        raise RuntimeError("Audio mux received a non-finite number")
    rendered = f"{value:.8f}".rstrip("0").rstrip(".")
    return rendered if rendered not in {"", "-0"} else "0"


def _atempo_filters(rate: float) -> list[str]:
    filters: list[str] = []
    while rate > 2:
        filters.append("atempo=2")
        rate /= 2
    while rate < 0.5:
        filters.append("atempo=0.5")
        rate /= 0.5
    filters.append(f"atempo={_finite_literal(rate)}")
    if len(filters) > 6:
        raise RuntimeError("Audio playback rate requires too many tempo stages")
    return filters


def _volume_expression(clip: AudioClip) -> str:
    frames = clip.keyframes
    if not frames:
        return _finite_literal(clip.volume)

    def conditional(condition: str, when_true: str, when_false: str) -> str:
        # Commas are escaped for FFmpeg's filter parser. Every token in this
        # expression is service-generated from already-bounded numeric fields.
        return f"if({condition}\\,{when_true}\\,{when_false})"

    expression = _finite_literal(frames[-1].value)
    for index in range(len(frames) - 2, -1, -1):
        left = frames[index]
        right = frames[index + 1]
        if left.interpolation == "hold":
            segment = _finite_literal(left.value)
        else:
            delta_value = right.value - left.value
            delta_time = right.time - left.time
            segment = f"{_finite_literal(left.value)}+{_finite_literal(delta_value)}*(t-{_finite_literal(left.time)})/{_finite_literal(delta_time)}"
        expression = conditional(f"lt(t\\,{_finite_literal(right.time)})", segment, expression)
    expression = conditional(f"lt(t\\,{_finite_literal(frames[0].time)})", _finite_literal(clip.volume), expression)
    if len(expression) > 32_768:
        raise RuntimeError("Audio volume envelope exceeds the mux expression limit")
    return expression


def _audio_filter_graph(clips: tuple[AudioClip, ...], duration: float) -> str:
    chains: list[str] = []
    labels: list[str] = []
    for index, clip in enumerate(clips):
        label = f"pc_audio_{index}"
        labels.append(f"[{label}]")
        rate = (clip.source_end - clip.source_start) / clip.duration
        source_span = clip.source_end - clip.source_start
        filters = [
            f"atrim=start=0:end={_finite_literal(source_span)}",
            "asetpts=PTS-STARTPTS",
            *_atempo_filters(rate),
            f"apad=pad_dur={_finite_literal(clip.duration)}",
            f"atrim=duration={_finite_literal(clip.duration)}",
            f"volume={_volume_expression(clip)}:eval=frame",
        ]
        if clip.fade_in > 0:
            filters.append(f"afade=t=in:st=0:d={_finite_literal(clip.fade_in)}")
        if clip.fade_out > 0:
            filters.append(f"afade=t=out:st={_finite_literal(clip.duration - clip.fade_out)}:d={_finite_literal(clip.fade_out)}")
        delay_samples = round(clip.start * 48_000)
        if delay_samples:
            filters.append(f"adelay={delay_samples}S:all=1")
        chains.append(f"[{index + 1}:a:0]{','.join(filters)}[{label}]")
    chains.append(f"{''.join(labels)}amix=inputs={len(clips)}:duration=longest:dropout_transition=0:normalize=0,apad=pad_dur={_finite_literal(duration)},atrim=duration={_finite_literal(duration)}[pc_audio_out]")
    graph = ";".join(chains)
    if len(graph.encode("utf-8")) > 256 * 1024:
        raise RuntimeError("Audio mux graph exceeds the safe byte limit")
    return graph


def _ffprobe(video: Path, output: RenderOutput, *, expect_audio: bool, job_dir: Path, cancel_event: threading.Event | None = None) -> None:
    argv = [
        "ffprobe",
        "-v", "error",
        "-of", "json",
        "-show_entries", "format=format_name,duration,size:stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
        str(video),
    ]
    raw = _run_bounded_command(argv, job_dir, 15, cancel_event)
    if len(raw) > 64 * 1024:
        raise RuntimeError("ffprobe output exceeds the safe byte limit")
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("ffprobe returned invalid metadata") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("format"), dict) or not isinstance(payload.get("streams"), list):
        raise RuntimeError("ffprobe returned an invalid metadata shape")
    streams = payload["streams"]
    videos = [stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "video"]
    audios = [stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "audio"]
    if len(videos) != 1 or len(audios) != (1 if expect_audio else 0) or len(streams) != 1 + (1 if expect_audio else 0):
        raise RuntimeError("ffprobe found an unexpected stream layout")
    expected_fps, expected_width, expected_height = output.fps, output.width, output.height
    video_stream = videos[0]
    if video_stream.get("codec_name") != "h264" or video_stream.get("width") != expected_width or video_stream.get("height") != expected_height:
        raise RuntimeError("ffprobe found unexpected video metadata")
    rate = video_stream.get("avg_frame_rate")
    try:
        numerator, denominator = (int(value) for value in str(rate).split("/", 1))
        actual_fps = numerator / denominator
    except (ValueError, ZeroDivisionError) as error:
        raise RuntimeError("ffprobe found an invalid frame rate") from error
    if abs(actual_fps - expected_fps) > 0.001:
        raise RuntimeError("ffprobe found an unexpected frame rate")
    if expect_audio:
        audio = audios[0]
        if audio.get("codec_name") != "aac" or str(audio.get("sample_rate")) != "48000" or audio.get("channels") not in {1, 2}:
            raise RuntimeError("ffprobe found unexpected audio metadata")
    format_info = payload["format"]
    try:
        duration = float(format_info["duration"])
        size = int(format_info["size"])
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError("ffprobe found invalid container metadata") from error
    tolerance = 1 / output.fps + (1024 / 48_000 if expect_audio else 0) + 0.01
    if (
        not math.isfinite(duration)
        or abs(duration - output.expected_duration_seconds) > tolerance
        or duration > MAX_RENDER_DURATION_SECONDS
        or size != video.stat().st_size
    ):
        raise RuntimeError("ffprobe found unsafe container metadata")


def _ffprobe_audio_asset(path: Path, mime_type: str, required_end: float, job_dir: Path, cancel_event: threading.Event | None = None) -> None:
    raw = _run_bounded_command([
        "ffprobe",
        "-v", "error",
        "-of", "json",
        "-show_entries", "format=duration,size:stream=codec_type,codec_name,sample_rate,channels",
        str(path),
    ], job_dir, 15, cancel_event)
    if len(raw) > 32 * 1024:
        raise RuntimeError("Audio ffprobe output exceeds the safe byte limit")
    try:
        payload = json.loads(raw)
        streams = payload["streams"]
        format_info = payload["format"]
        duration = float(format_info["duration"])
        size = int(format_info["size"])
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise RuntimeError("Audio ffprobe returned invalid metadata") from error
    if not isinstance(streams, list) or len(streams) != 1 or not isinstance(streams[0], dict) or streams[0].get("codec_type") != "audio":
        raise RuntimeError("Trusted audio asset has an unexpected stream layout")
    stream = streams[0]
    codec = stream.get("codec_name")
    if mime_type == "audio/wav" and (not isinstance(codec, str) or not codec.startswith("pcm_")):
        raise RuntimeError("Trusted WAV asset has an unexpected codec")
    if mime_type == "audio/mpeg" and codec != "mp3":
        raise RuntimeError("Trusted MP3 asset has an unexpected codec")
    try:
        sample_rate = int(stream["sample_rate"])
        channels = int(stream["channels"])
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError("Trusted audio asset has invalid stream metadata") from error
    if (
        not math.isfinite(duration)
        or duration <= 0
        or duration > 7_200
        or required_end > duration + (0.05 if mime_type == "audio/mpeg" else 0.001)
        or size != path.stat().st_size
        or not 8_000 <= sample_rate <= 192_000
        or not 1 <= channels <= 8
    ):
        raise RuntimeError("Trusted audio asset exceeds the decoder envelope")


def _mux_audio(video: Path, render: ValidatedRender, job_dir: Path, cancel_event: threading.Event | None = None) -> Path:
    output = job_dir / "proofcanvas-final.mp4"
    if output.exists() or output.is_symlink():
        raise RuntimeError("Audio mux output path is not fresh")
    argv = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-filter_complex_threads", "1", "-n", "-i", str(video),
    ]
    assets = {asset.path: asset for asset in render.assets}
    required_end_by_path: dict[str, float] = {}
    for clip in render.audio.clips:
        required_end_by_path[clip.asset_path] = max(required_end_by_path.get(clip.asset_path, 0), clip.source_end)
    for path, required_end in required_end_by_path.items():
        asset = assets.get(path)
        if asset is None:
            raise RuntimeError("Audio mux asset is absent")
        _ffprobe_audio_asset(job_dir / asset.path, asset.mime_type, required_end, job_dir, cancel_event)
    for clip in render.audio.clips:
        asset = assets.get(clip.asset_path)
        if asset is None:
            raise RuntimeError("Audio mux asset is absent")
        argv.extend([
            "-ss", _finite_literal(clip.source_start),
            "-t", _finite_literal(clip.source_end - clip.source_start),
            "-i", str(job_dir / asset.path),
        ])
    argv.extend([
        "-filter_complex", _audio_filter_graph(render.audio.clips, render.audio.duration_seconds),
        "-map", "0:v:0",
        "-map", "[pc_audio_out]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-threads", "1",
        "-b:a", "192k",
        "-ar", "48000",
        "-ac", "2",
        "-movflags", "+faststart",
        str(output),
    ])
    _run_bounded_command(argv, job_dir, RENDER_TIMEOUT_SECONDS, cancel_event)
    if output.is_symlink() or not output.is_file() or not 32 <= output.stat().st_size <= MAX_VIDEO_BYTES:
        raise RuntimeError("Audio mux did not produce a bounded MP4")
    _ffprobe(output, render.output, expect_audio=True, job_dir=job_dir, cancel_event=cancel_event)
    _validate_video_stream(
        output,
        render.output,
        expect_audio=True,
        expected_audio_duration=render.audio.duration_seconds,
        cancel_event=cancel_event,
    )
    return output


def run_manim(render: ValidatedRender, quality: Quality, job_dir: Path, cancel_event: threading.Event | None = None) -> tuple[Path, str, int, VideoVerification]:
    for child in ("home", "tmp", "cache", "config", "media"):
        (job_dir / child).mkdir(mode=0o700, exist_ok=True)
    materialize_assets(render, job_dir)
    source_path = job_dir / "generated_scene.py"
    source_path.write_text(render.source.source, encoding="utf-8")
    source_path.chmod(0o600)
    profile = (str(render.output.fps), f"{render.output.width},{render.output.height}")
    argv = [
        sys.executable,
        "-m",
        "manim",
        "render",
        "--renderer",
        "cairo",
        "--disable_caching",
        "--seed",
        "0",
        "--progress_bar",
        "none",
        "--verbosity",
        "warning",
        "--max-inflight-encoders",
        "1",
        "--format",
        "mp4",
        "--fps",
        profile[0],
        "--resolution",
        profile[1],
        "--media_dir",
        str(job_dir / "media"),
        "--output_file",
        "proofcanvas-output",
        str(source_path),
        "GeneratedScene",
    ]
    _run_bounded_command(argv, job_dir, RENDER_TIMEOUT_SECONDS, cancel_event)
    video = _find_video(job_dir, render.output, cancel_event)
    _ffprobe(video, render.output, expect_audio=False, job_dir=job_dir, cancel_event=cancel_event)
    if render.audio.clips:
        video = _mux_audio(video, render, job_dir, cancel_event)
    verification = _validate_video_stream(
        video,
        render.output,
        expect_audio=bool(render.audio.clips),
        expected_audio_duration=render.audio.duration_seconds if render.audio.clips else None,
        cancel_event=cancel_event,
    )
    digest = hashlib.sha256()
    with video.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return video, digest.hexdigest(), video.stat().st_size, verification


class RenderQueue:
    def __init__(
        self,
        *,
        root: Path | None = None,
        runner: Runner = run_manim,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.root = root or Path(os.environ.get("PROOFCANVAS_RENDER_ROOT", "/tmp/proofcanvas-render"))
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.runner = runner
        self._runner_accepts_cancel = len(inspect.signature(runner).parameters) >= 4
        self.clock = clock
        self._jobs: dict[str, RenderJob] = {}
        self._directories: dict[str, Path] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._active_job_ids: set[str] = set()
        self._futures: dict[str, object] = {}
        self._cleanup_in_progress: set[str] = set()
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="proofcanvas-render")
        self._stop_janitor = threading.Event()
        self._janitor = threading.Thread(target=self._cleanup_loop, name="proofcanvas-render-janitor", daemon=True)
        self._janitor.start()

    def _cleanup_loop(self) -> None:
        while not self._stop_janitor.wait(JANITOR_INTERVAL_SECONDS):
            self.cleanup_expired()

    def submit(self, source: ValidatedRender | ValidatedSource, quality: Quality) -> RenderJob:
        self.cleanup_expired()
        render = empty_render(source) if isinstance(source, ValidatedSource) else source
        with self._lock:
            if len(self._active_job_ids) >= 2:
                raise QueueFullError("The renderer already has one running and one queued job")
            now = self.clock()
            job_id = secrets.token_urlsafe(18)
            job_dir = Path(tempfile.mkdtemp(prefix=f"job-{job_id}-", dir=self.root))
            job_dir.chmod(0o700)
            job = RenderJob(job_id, quality, render.source.sha256, render.output, "pending", now, now)
            self._jobs[job_id] = job
            self._directories[job_id] = job_dir
            cancel_event = threading.Event()
            self._cancel_events[job_id] = cancel_event
            self._active_job_ids.add(job_id)
            self._futures[job_id] = self._executor.submit(self._run, job_id, render, quality, job_dir, cancel_event)
            return RenderJob(**job.__dict__)

    def _run(
        self,
        job_id: str,
        source: ValidatedRender,
        quality: Quality,
        job_dir: Path,
        cancel_event: threading.Event,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job_id in self._cleanup_in_progress or job.status == "cancelled":
                self._active_job_ids.discard(job_id)
                self._futures.pop(job_id, None)
                return
            now = self.clock()
            job.status = "running"
            job.started_at = now
            job.updated_at = now
        try:
            result = (
                self.runner(source, quality, job_dir, cancel_event)
                if self._runner_accepts_cancel
                else self.runner(source, quality, job_dir)
            )
            video, digest, size = result[:3]
            verification = result[3] if len(result) == 4 else None
            with self._lock:
                job = self._jobs[job_id]
                if cancel_event.is_set() or job.status == "cancelled":
                    self._mark_cancelled(job)
                else:
                    job.status = "succeeded"
                    job.video_path = video
                    job.video_sha256 = digest
                    job.video_bytes = size
                    job.video_verification = verification
                    job.completed_at = self.clock()
                    job.updated_at = job.completed_at
        except RenderCancelledError:
            with self._lock:
                job = self._jobs.get(job_id)
                if job:
                    self._mark_cancelled(job)
        except Exception:
            with self._lock:
                job = self._jobs.get(job_id)
                if job:
                    if cancel_event.is_set() or job.status == "cancelled":
                        self._mark_cancelled(job)
                    else:
                        job.status = "failed"
                        job.error_code = "render-failed"
                        job.error_message = "Manim could not render this generated scene."
                        job.completed_at = self.clock()
                        job.updated_at = job.completed_at
        finally:
            with self._lock:
                self._active_job_ids.discard(job_id)
                self._futures.pop(job_id, None)

    def _mark_cancelled(self, job: RenderJob) -> None:
        job.status = "cancelled"
        job.video_path = None
        job.video_sha256 = None
        job.video_bytes = None
        job.video_verification = None
        job.error_code = "render-cancelled"
        job.error_message = "Render was cancelled."
        if job.completed_at is None:
            job.completed_at = self.clock()
        job.updated_at = job.completed_at

    def cancel(self, job_id: str) -> RenderJob:
        self.cleanup_expired()
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job_id in self._cleanup_in_progress:
                raise JobNotFoundError(job_id)
            if job.status in {"succeeded", "failed"}:
                raise JobNotCancellableError(job.status)
            if job.status == "cancelled":
                return RenderJob(**job.__dict__)
            event = self._cancel_events[job_id]
            event.set()
            self._mark_cancelled(job)
            future = self._futures.get(job_id)
            if future is not None and getattr(future, "cancel")():
                self._active_job_ids.discard(job_id)
                self._futures.pop(job_id, None)
            return RenderJob(**job.__dict__)

    def get(self, job_id: str) -> RenderJob:
        self.cleanup_expired()
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job_id in self._cleanup_in_progress:
                raise JobNotFoundError(job_id)
            return RenderJob(**job.__dict__)

    def video(self, job_id: str) -> tuple[BinaryIO, str, int, str]:
        self.cleanup_expired()
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job_id in self._cleanup_in_progress:
                raise JobNotFoundError(job_id)
            if job.status != "succeeded" or not job.video_path or not job.video_sha256 or not job.video_bytes:
                raise VideoUnavailableError(job.status)
            try:
                video = job.video_path.resolve(strict=True)
                directory = self._directories[job_id].resolve(strict=True)
            except (KeyError, OSError) as error:
                raise VideoUnavailableError("invalid") from error
            if directory not in video.parents or video.is_symlink():
                raise VideoUnavailableError("invalid")
            try:
                stream = video.open("rb")
            except OSError as error:
                raise VideoUnavailableError("invalid") from error
            return stream, job.video_sha256, job.video_bytes, job.source_sha256

    def still(self, job_id: str, time_seconds: float) -> RenderStill:
        if not math.isfinite(time_seconds) or time_seconds < 0 or time_seconds > MAX_RENDER_DURATION_SECONDS:
            raise VideoUnavailableError("invalid-time")
        self.cleanup_expired()
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job_id in self._cleanup_in_progress:
                raise JobNotFoundError(job_id)
            if job.status != "succeeded" or not job.video_path:
                raise VideoUnavailableError(job.status)
            try:
                video = job.video_path.resolve(strict=True)
                directory = self._directories[job_id].resolve(strict=True)
            except (KeyError, OSError) as error:
                raise VideoUnavailableError("invalid") from error
            if directory not in video.parents or video.is_symlink():
                raise VideoUnavailableError("invalid")
            try:
                stream = video.open("rb")
            except OSError as error:
                raise VideoUnavailableError("invalid") from error
            source_sha = job.source_sha256
        try:
            import av

            with av.open(stream, mode="r") as container:
                videos = list(container.streams.video)
                if len(videos) != 1:
                    raise VideoUnavailableError("invalid")
                video_stream = videos[0]
                container.seek(int(time_seconds * av.time_base), backward=True, stream=None)
                selected = None
                selected_time = 0.0
                decoded = 0
                for frame in container.decode(video_stream):
                    decoded += 1
                    frame_time = float(frame.pts * frame.time_base) if frame.pts is not None else selected_time
                    if frame_time > time_seconds + 1e-8 and selected is not None:
                        break
                    selected = frame
                    selected_time = frame_time
                    if decoded > 720:
                        raise VideoUnavailableError("invalid")
                if selected is None:
                    raise VideoUnavailableError("invalid-time")
                output = io.BytesIO()
                selected.to_image().save(output, format="PNG", optimize=False, compress_level=9)
                content = output.getvalue()
        except VideoUnavailableError:
            raise
        except Exception as error:
            raise VideoUnavailableError("invalid") from error
        finally:
            stream.close()
        if not 32 <= len(content) <= MAX_STILL_BYTES or content[:8] != b"\x89PNG\r\n\x1a\n":
            raise VideoUnavailableError("invalid")
        return RenderStill(content, hashlib.sha256(content).hexdigest(), source_sha, selected_time)

    def cleanup_expired(self, *, now: float | None = None) -> int:
        instant = self.clock() if now is None else now
        candidates: list[tuple[str, Path]] = []
        with self._lock:
            for job_id, job in list(self._jobs.items()):
                if (
                    job_id not in self._cleanup_in_progress
                    and job.completed_at is not None
                    and instant - job.completed_at >= JOB_TTL_SECONDS
                ):
                    self._cleanup_in_progress.add(job_id)
                    candidates.append((job_id, self._directories[job_id]))
        removed = 0
        for job_id, directory in candidates:
            deleted = False
            try:
                shutil.rmtree(directory)
                deleted = True
            except FileNotFoundError:
                deleted = True
            except OSError:
                pass
            with self._lock:
                if deleted and self._directories.get(job_id) == directory:
                    self._directories.pop(job_id, None)
                    self._jobs.pop(job_id, None)
                    self._cancel_events.pop(job_id, None)
                    self._active_job_ids.discard(job_id)
                    self._futures.pop(job_id, None)
                    removed += 1
                self._cleanup_in_progress.discard(job_id)
        return removed

    def shutdown(self) -> None:
        self._stop_janitor.set()
        self._janitor.join(timeout=5)
        with self._lock:
            for event in self._cancel_events.values():
                event.set()
        self._executor.shutdown(wait=True, cancel_futures=True)
