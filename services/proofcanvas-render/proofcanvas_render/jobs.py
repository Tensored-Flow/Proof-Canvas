from __future__ import annotations

import hashlib
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

from .policy import ValidatedSource

Quality = Literal["preview", "production"]
JobStatus = Literal["pending", "running", "succeeded", "failed"]
MAX_VIDEO_BYTES = 256 * 1024 * 1024
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


@dataclass
class RenderJob:
    id: str
    quality: Quality
    source_sha256: str
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

    def public(self) -> dict[str, object]:
        return {
            "id": self.id,
            "quality": self.quality,
            "sourceSha256": self.source_sha256,
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
                {"sha256": self.video_sha256, "bytes": self.video_bytes}
                if self.status == "succeeded"
                else None
            ),
        }


Runner = Callable[[ValidatedSource, Quality, Path], tuple[Path, str, int]]


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
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        timeout_error = error
        try:
            _terminate_process_group(process, termination_grace_seconds)
        except RuntimeError as group_error:
            termination_error = group_error
    else:
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
    if orphaned_group:
        raise RuntimeError("Renderer process group outlived its leader")
    if reader.is_alive() or reader_errors:
        raise RuntimeError("Renderer log capture did not terminate cleanly")
    return bytes(tail)


def _apply_child_limits(pid: int) -> None:
    resource.prlimit(pid, resource.RLIMIT_CPU, (RENDER_TIMEOUT_SECONDS, RENDER_TIMEOUT_SECONDS))
    resource.prlimit(pid, resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.prlimit(pid, resource.RLIMIT_FSIZE, (MAX_VIDEO_BYTES, MAX_VIDEO_BYTES))
    resource.prlimit(pid, resource.RLIMIT_NOFILE, (64, 64))


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


def _validate_video_stream(video: Path, quality: Quality) -> None:
    import av

    expected_fps, expected_width, expected_height = (15, 854, 480) if quality == "preview" else (30, 1280, 720)
    try:
        with av.open(str(video), mode="r") as container:
            streams = list(container.streams)
            video_streams = list(container.streams.video)
            if len(streams) != 1 or len(video_streams) != 1 or "mp4" not in container.format.name.split(","):
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
                frame_count += 1
                if frame.width != expected_width or frame.height != expected_height:
                    raise RuntimeError("Renderer output contains an invalid frame")
                if frame_count > expected_fps * MAX_RENDER_DURATION_SECONDS + 1:
                    raise RuntimeError("Renderer output contains too many frames")
            if frame_count == 0:
                raise RuntimeError("Renderer output contains no decodable frames")
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError("Renderer output could not be decoded as MP4") from error


def _find_video(job_dir: Path, quality: Quality) -> Path:
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
    _validate_video_stream(video, quality)
    return video


def run_manim(source: ValidatedSource, quality: Quality, job_dir: Path) -> tuple[Path, str, int]:
    for child in ("home", "tmp", "cache", "config", "media"):
        (job_dir / child).mkdir(mode=0o700, exist_ok=True)
    source_path = job_dir / "generated_scene.py"
    source_path.write_text(source.source, encoding="utf-8")
    source_path.chmod(0o600)
    profile = ("15", "854,480") if quality == "preview" else ("30", "1280,720")
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
    bounded_log = _wait_with_bounded_log(process, RENDER_TIMEOUT_SECONDS).decode("utf-8", errors="replace")
    if process.returncode != 0:
        raise RuntimeError(f"Manim exited with status {process.returncode}: {bounded_log[-800:]}")
    video = _find_video(job_dir, quality)
    digest = hashlib.sha256()
    with video.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return video, digest.hexdigest(), video.stat().st_size


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
        self.clock = clock
        self._jobs: dict[str, RenderJob] = {}
        self._directories: dict[str, Path] = {}
        self._cleanup_in_progress: set[str] = set()
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="proofcanvas-render")
        self._stop_janitor = threading.Event()
        self._janitor = threading.Thread(target=self._cleanup_loop, name="proofcanvas-render-janitor", daemon=True)
        self._janitor.start()

    def _cleanup_loop(self) -> None:
        while not self._stop_janitor.wait(JANITOR_INTERVAL_SECONDS):
            self.cleanup_expired()

    def submit(self, source: ValidatedSource, quality: Quality) -> RenderJob:
        self.cleanup_expired()
        with self._lock:
            inflight = sum(job.status in {"pending", "running"} for job in self._jobs.values())
            if inflight >= 2:
                raise QueueFullError("The renderer already has one running and one queued job")
            now = self.clock()
            job_id = secrets.token_urlsafe(18)
            job_dir = Path(tempfile.mkdtemp(prefix=f"job-{job_id}-", dir=self.root))
            job_dir.chmod(0o700)
            job = RenderJob(job_id, quality, source.sha256, "pending", now, now)
            self._jobs[job_id] = job
            self._directories[job_id] = job_dir
            self._executor.submit(self._run, job_id, source, quality, job_dir)
            return RenderJob(**job.__dict__)

    def _run(self, job_id: str, source: ValidatedSource, quality: Quality, job_dir: Path) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job_id in self._cleanup_in_progress:
                return
            now = self.clock()
            job.status = "running"
            job.started_at = now
            job.updated_at = now
        try:
            video, digest, size = self.runner(source, quality, job_dir)
            with self._lock:
                job = self._jobs[job_id]
                job.status = "succeeded"
                job.video_path = video
                job.video_sha256 = digest
                job.video_bytes = size
                job.completed_at = self.clock()
                job.updated_at = job.completed_at
        except Exception:
            with self._lock:
                job = self._jobs.get(job_id)
                if job:
                    job.status = "failed"
                    job.error_code = "render-failed"
                    job.error_message = "Manim could not render this generated scene."
                    job.completed_at = self.clock()
                    job.updated_at = job.completed_at

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
                    removed += 1
                self._cleanup_in_progress.discard(job_id)
        return removed

    def shutdown(self) -> None:
        self._stop_janitor.set()
        self._janitor.join(timeout=5)
        self._executor.shutdown(wait=True, cancel_futures=True)
