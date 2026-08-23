from __future__ import annotations

import hashlib
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import proofcanvas_render.jobs as jobs_module
from proofcanvas_render.jobs import JOB_TTL_SECONDS, MAX_LOG_BYTES, QueueFullError, RenderQueue, VideoUnavailableError, _process_group_exists, _wait_with_bounded_log
from proofcanvas_render.policy import validate_generated_source


def _mp4_bytes() -> bytes:
    return b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64


def _wait_for(queue: RenderQueue, job_id: str, status: str, timeout: float = 2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = queue.get(job_id)
        if job.status == status:
            return job
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not reach {status}")


def test_queue_allows_one_running_and_one_pending(tmp_path: Path, generated_source: str, generated_sha: str) -> None:
    started = threading.Event()
    release = threading.Event()

    def runner(source, quality, job_dir):
        started.set()
        assert release.wait(2)
        video = job_dir / "proofcanvas-output.mp4"
        video.write_bytes(_mp4_bytes())
        data = video.read_bytes()
        return video, hashlib.sha256(data).hexdigest(), len(data)

    queue = RenderQueue(root=tmp_path, runner=runner)
    validated = validate_generated_source(generated_source, generated_sha)
    try:
        first = queue.submit(validated, "preview")
        assert started.wait(1)
        second = queue.submit(validated, "production")

        with pytest.raises(QueueFullError):
            queue.submit(validated, "preview")

        assert queue.get(first.id).status == "running"
        assert queue.get(second.id).status == "pending"
        with pytest.raises(VideoUnavailableError):
            queue.video(second.id)

        release.set()
        first_done = _wait_for(queue, first.id, "succeeded")
        second_done = _wait_for(queue, second.id, "succeeded")
        assert first_done.video_bytes == len(_mp4_bytes())
        assert second_done.quality == "production"
        stream, video_sha, size, source_sha = queue.video(first.id)
        try:
            assert stream.read() == _mp4_bytes()
            assert video_sha == hashlib.sha256(_mp4_bytes()).hexdigest()
            assert size == len(_mp4_bytes())
            assert source_sha == generated_sha
        finally:
            stream.close()
    finally:
        release.set()
        queue.shutdown()


def test_failed_job_is_sanitized(tmp_path: Path, generated_source: str, generated_sha: str) -> None:
    def runner(source, quality, job_dir):
        raise RuntimeError("secret renderer internals")

    queue = RenderQueue(root=tmp_path, runner=runner)
    try:
        job = queue.submit(validate_generated_source(generated_source, generated_sha), "preview")
        failed = _wait_for(queue, job.id, "failed")
        assert failed.error_code == "render-failed"
        assert failed.error_message == "Manim could not render this generated scene."
        assert "secret" not in str(failed.public())
    finally:
        queue.shutdown()


def test_completed_jobs_expire_after_ttl(tmp_path: Path, generated_source: str, generated_sha: str) -> None:
    now = [1000.0]

    def runner(source, quality, job_dir):
        video = job_dir / "proofcanvas-output.mp4"
        video.write_bytes(_mp4_bytes())
        return video, hashlib.sha256(_mp4_bytes()).hexdigest(), len(_mp4_bytes())

    queue = RenderQueue(root=tmp_path, runner=runner, clock=lambda: now[0])
    try:
        job = queue.submit(validate_generated_source(generated_source, generated_sha), "preview")
        _wait_for(queue, job.id, "succeeded")
        directory = next(tmp_path.iterdir())
        now[0] += JOB_TTL_SECONDS
        assert queue.cleanup_expired() == 1
        assert not directory.exists()
    finally:
        queue.shutdown()


def test_renderer_log_capture_keeps_only_a_bounded_tail() -> None:
    marker = b"proofcanvas-log-tail"
    process = subprocess.Popen(
        [sys.executable, "-c", f'import os; os.write(1, b"x" * {MAX_LOG_BYTES * 3}); os.write(1, {marker!r})'],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    output = _wait_with_bounded_log(process, 5)

    assert process.returncode == 0
    assert len(output) == MAX_LOG_BYTES
    assert output.endswith(marker)


def test_renderer_timeout_kills_signal_ignoring_process_group() -> None:
    child = (
        'import signal,time; '
        'signal.signal(signal.SIGTERM, signal.SIG_IGN); '
        'print("child-ready", flush=True); '
        'time.sleep(60)'
    )
    parent = (
        'import signal,subprocess,sys,time; '
        'signal.signal(signal.SIGTERM, signal.SIG_IGN); '
        f'child_process = subprocess.Popen([sys.executable, "-c", {child!r}], stdout=subprocess.PIPE, text=True); '
        'assert child_process.stdout is not None; '
        'assert child_process.stdout.readline() == "child-ready\\n"; '
        'print("group-ready", flush=True); '
        'time.sleep(60)'
    )
    process = subprocess.Popen(
        [sys.executable, "-c", parent],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
        start_new_session=True,
    )
    process_group_id = process.pid
    assert process.stdout is not None
    assert process.stdout.readline() == b"group-ready\n"

    with pytest.raises(RuntimeError, match="Render timed out"):
        _wait_with_bounded_log(process, 0.05, termination_grace_seconds=0.1)

    assert not _process_group_exists(process_group_id)


def test_renderer_rejects_and_kills_process_group_that_outlives_leader() -> None:
    child = (
        'import signal,time; '
        'signal.signal(signal.SIGTERM, signal.SIG_IGN); '
        'print("child-ready", flush=True); '
        'time.sleep(60)'
    )
    parent = (
        'import subprocess,sys; '
        f'child_process = subprocess.Popen([sys.executable, "-c", {child!r}], stdout=subprocess.PIPE, text=True); '
        'assert child_process.stdout is not None; '
        'assert child_process.stdout.readline() == "child-ready\\n"; '
        'print("group-ready", flush=True)'
    )
    process = subprocess.Popen(
        [sys.executable, "-c", parent],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
        start_new_session=True,
    )
    process_group_id = process.pid
    assert process.stdout is not None
    assert process.stdout.readline() == b"group-ready\n"
    assert _process_group_exists(process_group_id)

    with pytest.raises(RuntimeError, match="process group outlived its leader"):
        _wait_with_bounded_log(process, 5, termination_grace_seconds=0.1)

    assert process.returncode == 0
    assert not _process_group_exists(process_group_id)


def test_failed_expiry_deletion_is_retained_and_retried(
    tmp_path: Path,
    generated_source: str,
    generated_sha: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = [1000.0]

    def runner(source, quality, job_dir):
        video = job_dir / "proofcanvas-output.mp4"
        video.write_bytes(_mp4_bytes())
        return video, hashlib.sha256(_mp4_bytes()).hexdigest(), len(_mp4_bytes())

    queue = RenderQueue(root=tmp_path, runner=runner, clock=lambda: now[0])
    try:
        job = queue.submit(validate_generated_source(generated_source, generated_sha), "preview")
        _wait_for(queue, job.id, "succeeded")
        directory = next(tmp_path.iterdir())
        now[0] += JOB_TTL_SECONDS
        real_rmtree = jobs_module.shutil.rmtree

        def refuse_delete(path: Path) -> None:
            raise OSError("simulated cleanup failure")

        monkeypatch.setattr(jobs_module.shutil, "rmtree", refuse_delete)
        assert queue.cleanup_expired() == 0
        assert directory.exists()
        assert queue.get(job.id).status == "succeeded"

        monkeypatch.setattr(jobs_module.shutil, "rmtree", real_rmtree)
        assert queue.cleanup_expired() == 1
        assert not directory.exists()
    finally:
        queue.shutdown()
