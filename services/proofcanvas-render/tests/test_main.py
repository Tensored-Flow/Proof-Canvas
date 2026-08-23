from __future__ import annotations

import hashlib
import time
from pathlib import Path

from fastapi.testclient import TestClient

from proofcanvas_render.jobs import RenderQueue
from proofcanvas_render.main import create_app


TOKEN = "proofcanvas-test-token-that-is-long-enough"


def _mp4_bytes() -> bytes:
    return b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64


def _runner(source, quality, job_dir):
    video = job_dir / "proofcanvas-output.mp4"
    video.write_bytes(_mp4_bytes())
    data = video.read_bytes()
    return video, hashlib.sha256(data).hexdigest(), len(data)


def _wait_for_success(client: TestClient, job_id: str) -> dict[str, object]:
    for _ in range(100):
        response = client.get(f"/v1/render/{job_id}", headers={"Authorization": f"Bearer {TOKEN}"})
        assert response.status_code == 200
        job = response.json()["job"]
        if job["status"] == "succeeded":
            return job
        time.sleep(0.01)
    raise AssertionError("render did not finish")


def test_authenticated_render_lifecycle(
    tmp_path: Path,
    monkeypatch,
    generated_source: str,
    generated_sha: str,
) -> None:
    monkeypatch.setenv("PROOFCANVAS_RENDER_TOKEN", TOKEN)
    queue = RenderQueue(root=tmp_path, runner=_runner)
    try:
        with TestClient(create_app(queue)) as client:
            submitted = client.post(
                "/v1/render",
                headers={"Authorization": f"Bearer {TOKEN}"},
                json={"source": generated_source, "sourceSha256": generated_sha, "quality": "preview"},
            )
            assert submitted.status_code == 202
            job_id = submitted.json()["job"]["id"]
            job = _wait_for_success(client, job_id)
            assert job["sourceSha256"] == generated_sha

            video = client.get(f"/v1/render/{job_id}/video", headers={"Authorization": f"Bearer {TOKEN}"})
            assert video.status_code == 200
            assert video.headers["content-type"] == "video/mp4"
            assert video.headers["x-proofcanvas-source-sha256"] == generated_sha
            assert video.headers["x-proofcanvas-video-sha256"] == hashlib.sha256(_mp4_bytes()).hexdigest()
            assert video.content == _mp4_bytes()
    finally:
        queue.shutdown()


def test_auth_and_configuration_fail_closed(tmp_path: Path, monkeypatch) -> None:
    queue = RenderQueue(root=tmp_path, runner=_runner)
    try:
        monkeypatch.delenv("PROOFCANVAS_RENDER_TOKEN", raising=False)
        with TestClient(create_app(queue)) as client:
            assert client.get("/health").status_code == 503
            unavailable = client.get("/v1/render/abcdefghijklmnopqrstuvwx")
            assert unavailable.status_code == 503
            assert unavailable.json()["code"] == "render-unavailable"

        monkeypatch.setenv("PROOFCANVAS_RENDER_TOKEN", TOKEN)
        with TestClient(create_app(queue)) as client:
            unauthorized = client.get("/v1/render/abcdefghijklmnopqrstuvwx")
            assert unauthorized.status_code == 401
            assert unauthorized.json()["code"] == "unauthorized"
    finally:
        queue.shutdown()


def test_source_policy_errors_are_sanitized(
    tmp_path: Path,
    monkeypatch,
    generated_source: str,
) -> None:
    monkeypatch.setenv("PROOFCANVAS_RENDER_TOKEN", TOKEN)
    queue = RenderQueue(root=tmp_path, runner=_runner)
    try:
        with TestClient(create_app(queue)) as client:
            response = client.post(
                "/v1/render",
                headers={"Authorization": f"Bearer {TOKEN}"},
                json={"source": generated_source, "sourceSha256": "0" * 64, "quality": "preview"},
            )
            assert response.status_code == 422
            assert response.json() == {
                "ok": False,
                "code": "source-rejected",
                "message": "Generated source failed the renderer policy.",
            }
    finally:
        queue.shutdown()


def test_negative_content_length_is_rejected(
    tmp_path: Path,
    monkeypatch,
    generated_source: str,
    generated_sha: str,
) -> None:
    monkeypatch.setenv("PROOFCANVAS_RENDER_TOKEN", TOKEN)
    queue = RenderQueue(root=tmp_path, runner=_runner)
    try:
        with TestClient(create_app(queue)) as client:
            response = client.post(
                "/v1/render",
                headers={"Authorization": f"Bearer {TOKEN}", "Content-Length": "-1"},
                content=(
                    '{"source":'
                    + repr(generated_source)
                    + ',"sourceSha256":"'
                    + generated_sha
                    + '","quality":"preview"}'
                ),
            )
            assert response.status_code == 422
            assert response.json()["code"] == "source-rejected"
    finally:
        queue.shutdown()
