from __future__ import annotations

import hmac
import json
import os
from contextlib import asynccontextmanager
from typing import Any, BinaryIO, Iterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .jobs import JOB_ID_PATTERN, JobNotFoundError, QueueFullError, RenderQueue, VideoUnavailableError
from .policy import MAX_SOURCE_BYTES, SourcePolicyError, validate_generated_source

MAX_REQUEST_BYTES = 2 * MAX_SOURCE_BYTES + 16 * 1024


def _json(body: object, status: int = 200) -> JSONResponse:
    return JSONResponse(
        body,
        status_code=status,
        headers={"Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow"},
    )


def _error(status: int, code: str, message: str) -> JSONResponse:
    return _json({"ok": False, "code": code, "message": message}, status)


def _configured_token() -> str | None:
    token = os.environ.get("PROOFCANVAS_RENDER_TOKEN", "")
    return token if 32 <= len(token) <= 256 else None


def _authorized(request: Request) -> bool:
    token = _configured_token()
    authorization = request.headers.get("authorization", "")
    supplied = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    return token is not None and bool(supplied) and hmac.compare_digest(token, supplied)


async def _bounded_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            length = int(declared)
            if length < 0 or length > MAX_REQUEST_BYTES or str(length) != declared.strip():
                raise ValueError("too large")
        except ValueError as error:
            raise SourcePolicyError("Request body exceeds the renderer limit") from error
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_REQUEST_BYTES:
            raise SourcePolicyError("Request body exceeds the renderer limit")
        chunks.append(chunk)
    return b"".join(chunks)


def _request_payload(candidate: Any) -> tuple[str, str, str]:
    if not isinstance(candidate, dict) or set(candidate) != {"source", "sourceSha256", "quality"}:
        raise SourcePolicyError("Render request envelope is malformed")
    source = candidate.get("source")
    source_sha = candidate.get("sourceSha256")
    quality = candidate.get("quality")
    if not isinstance(source, str) or not isinstance(source_sha, str) or quality not in {"preview", "production"}:
        raise SourcePolicyError("Render request fields are malformed")
    return source, source_sha, quality


def _video_chunks(stream: BinaryIO) -> Iterator[bytes]:
    try:
        while chunk := stream.read(1024 * 1024):
            yield chunk
    finally:
        stream.close()


def create_app(queue: RenderQueue | None = None) -> FastAPI:
    owns_queue = queue is None
    jobs = queue or RenderQueue()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        if owns_queue:
            jobs.shutdown()

    service = FastAPI(
        title="ProofCanvas Render Service",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    service.state.render_queue = jobs

    @service.get("/health")
    async def health() -> JSONResponse:
        configured = _configured_token() is not None
        return _json(
            {
                "ok": configured,
                "service": "proofcanvas-render",
                "manim": "0.21.0",
                "queueCapacity": 2,
                "renderTimeoutSeconds": 180,
            },
            200 if configured else 503,
        )

    @service.post("/v1/render")
    async def submit(request: Request) -> JSONResponse:
        if _configured_token() is None:
            return _error(503, "render-unavailable", "Renderer authentication is not configured.")
        if not _authorized(request):
            return _error(401, "unauthorized", "Renderer authorization failed.")
        try:
            raw = await _bounded_body(request)
            candidate = json.loads(raw)
            source, source_sha, quality = _request_payload(candidate)
            validated = validate_generated_source(source, source_sha)
            job = jobs.submit(validated, quality)  # type: ignore[arg-type]
        except (UnicodeDecodeError, json.JSONDecodeError):
            return _error(400, "invalid-json", "Render request must be valid JSON.")
        except SourcePolicyError:
            return _error(422, "source-rejected", "Generated source failed the renderer policy.")
        except QueueFullError:
            return _error(429, "queue-full", "The renderer already has one running and one queued job.")
        return _json({"ok": True, "job": job.public()}, 202)

    @service.get("/v1/render/{job_id}")
    async def status(job_id: str, request: Request) -> JSONResponse:
        if _configured_token() is None:
            return _error(503, "render-unavailable", "Renderer authentication is not configured.")
        if not _authorized(request):
            return _error(401, "unauthorized", "Renderer authorization failed.")
        if not JOB_ID_PATTERN.fullmatch(job_id):
            return _error(404, "job-not-found", "Render job was not found.")
        try:
            job = jobs.get(job_id)
        except JobNotFoundError:
            return _error(404, "job-not-found", "Render job was not found.")
        return _json({"ok": True, "job": job.public()})

    @service.get("/v1/render/{job_id}/video")
    async def video(job_id: str, request: Request):
        if _configured_token() is None:
            return _error(503, "render-unavailable", "Renderer authentication is not configured.")
        if not _authorized(request):
            return _error(401, "unauthorized", "Renderer authorization failed.")
        if not JOB_ID_PATTERN.fullmatch(job_id):
            return _error(404, "job-not-found", "Render job was not found.")
        try:
            stream, digest, size, source_digest = jobs.video(job_id)
        except JobNotFoundError:
            return _error(404, "job-not-found", "Render job was not found.")
        except VideoUnavailableError:
            return _error(409, "video-unavailable", "Render video is not available yet.")
        return StreamingResponse(
            _video_chunks(stream),
            media_type="video/mp4",
            headers={
                "Cache-Control": "private, no-store, max-age=0",
                "Content-Disposition": f'inline; filename="proofcanvas-{job_id}.mp4"',
                "Content-Length": str(size),
                "X-ProofCanvas-Video-SHA256": digest,
                "X-ProofCanvas-Source-SHA256": source_digest,
                "X-Robots-Tag": "noindex, nofollow",
            },
        )

    return service


app = create_app()
