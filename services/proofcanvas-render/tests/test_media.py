from __future__ import annotations

import base64
import hashlib
import io
import os
import struct
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from proofcanvas_render.jobs import _audio_filter_graph, _mux_audio, run_manim
from proofcanvas_render.media import AudioClip, AudioKeyframe, SourcePolicyError, materialize_assets, validate_render_payload
from proofcanvas_render.policy import PROOFCANVAS_IMAGE_HELPER


def _source_with(statement: str) -> str:
    return "from manim import *\nimport math\n\nclass GeneratedScene(MovingCameraScene):\n    def construct(self):\n" + statement


def _asset(path: str, mime_type: str, content: bytes) -> dict[str, object]:
    digest = hashlib.sha256(content).hexdigest()
    assert digest in path
    return {
        "path": path,
        "mimeType": mime_type,
        "sha256": digest,
        "bytes": len(content),
        "contentBase64": base64.b64encode(content).decode("ascii"),
    }


def _wav(seconds: int = 1) -> bytes:
    sample_rate = 8_000
    data = b"\0\0" * (sample_rate * seconds)
    return (
        b"RIFF"
        + struct.pack("<I", 36 + len(data))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", len(data))
        + data
    )


def _raster(format_name: str) -> bytes:
    output = io.BytesIO()
    options = {"lossless": True} if format_name == "WEBP" else {"quality": 90}
    Image.new("RGB", (4, 3), (18, 52, 86)).save(output, format=format_name, **options)
    return output.getvalue()


def _mp3(tmp_path: Path, seconds: int = 1) -> bytes:
    destination = tmp_path / "fixture.mp3"
    created = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
            "-t", str(seconds), "-c:a", "libmp3lame", "-b:a", "64k",
            "-write_xing", "0", "-map_metadata", "-1", str(destination),
        ],
        cwd=tmp_path,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=30,
    )
    assert created.returncode == 0, created.stdout.decode(errors="replace")
    return destination.read_bytes()


def test_validates_and_materializes_hash_addressed_svg(tmp_path: Path) -> None:
    content = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="8"><rect x="0" y="0" width="10" height="8" fill="#123456"/></svg>'
    digest = hashlib.sha256(content).hexdigest()
    path = f"assets/{digest}.svg"
    source = _source_with(
        f'        pc_asset = SVGMobject("{path}").set_opacity(0.75)\n'
        "        pc_asset.stretch_to_fit_width(1.0).stretch_to_fit_height(0.8)\n"
        "        pc_asset.shift([0.0, 0.0, 0])\n"
        "        self.add(pc_asset)\n"
    )
    render, quality = validate_render_payload({
        "source": source,
        "sourceSha256": hashlib.sha256(source.encode()).hexdigest(),
        "quality": "preview",
        "output": {"width": 854, "height": 480, "fps": 15, "expectedDurationSeconds": 2},
        "assets": [_asset(path, "image/svg+xml", content)],
        "audio": {"durationSeconds": 1, "clips": []},
    })
    assert quality == "preview"
    job_dir = tmp_path / "job"
    job_dir.mkdir(mode=0o700)
    materialize_assets(render, job_dir)
    written = job_dir / path
    assert written.read_bytes() == content
    assert os.stat(written).st_mode & 0o777 == 0o600


@pytest.mark.parametrize(("mime_type", "suffix", "format_name"), [
    ("image/jpeg", "jpg", "JPEG"),
    ("image/webp", "webp", "WEBP"),
])
def test_fully_decodes_hash_addressed_jpeg_and_webp(
    tmp_path: Path,
    mime_type: str,
    suffix: str,
    format_name: str,
) -> None:
    content = _raster(format_name)
    digest = hashlib.sha256(content).hexdigest()
    path = f"assets/{digest}.{suffix}"
    source = _source_with(
        f'        pc_asset = ImageMobject("{path}").set_opacity(1.0)\n'
        "        pc_asset.stretch_to_fit_width(1.0).stretch_to_fit_height(0.8)\n"
        "        pc_asset.shift([0.0, 0.0, 0])\n"
        "        self.add(pc_asset)\n"
    )
    payload = {
        "source": source,
        "sourceSha256": hashlib.sha256(source.encode()).hexdigest(),
        "quality": "preview",
        "output": {"width": 854, "height": 480, "fps": 15, "expectedDurationSeconds": 1},
        "assets": [_asset(path, mime_type, content)],
        "audio": {"durationSeconds": 0, "clips": []},
    }
    render, _ = validate_render_payload(payload)
    job_dir = tmp_path / suffix
    job_dir.mkdir(mode=0o700)
    materialize_assets(render, job_dir)
    assert (job_dir / path).read_bytes() == content
    tampered = content[:-1]
    bad_digest = hashlib.sha256(tampered).hexdigest()
    bad_path = f"assets/{bad_digest}.{suffix}"
    bad_source = source.replace(path, bad_path)
    with pytest.raises(SourcePolicyError):
        validate_render_payload({
            **payload,
            "source": bad_source,
            "sourceSha256": hashlib.sha256(bad_source.encode()).hexdigest(),
            "assets": [_asset(bad_path, mime_type, tampered)],
        })


def test_validates_bounded_wav_audio_plan(generated_source: str, generated_sha: str) -> None:
    content = _wav()
    digest = hashlib.sha256(content).hexdigest()
    path = f"assets/{digest}.wav"
    render, quality = validate_render_payload({
        "source": generated_source,
        "sourceSha256": generated_sha,
        "quality": "production",
        "output": {"width": 1280, "height": 720, "fps": 30, "expectedDurationSeconds": 2},
        "assets": [_asset(path, "audio/wav", content)],
        "audio": {
            "durationSeconds": 2,
            "clips": [{
                "assetPath": path,
                "start": 0.5,
                "duration": 1,
                "sourceStart": 0,
                "sourceEnd": 1,
                "volume": 0.8,
                "fadeIn": 0.1,
                "fadeOut": 0.2,
                "keyframes": [
                    {"time": 0, "value": 0.8, "interpolation": "linear"},
                    {"time": 1, "value": 0.4, "interpolation": "hold"},
                ],
            }],
        },
    })
    assert quality == "production"
    assert render.audio.clips[0].asset_path == path
    assert render.audio.clips[0].keyframes[-1].value == 0.4


@pytest.mark.parametrize("mutation", ["hash", "path", "base64", "unreferenced", "expression"])
def test_media_protocol_rejects_tampering_and_extra_authority(
    mutation: str,
    generated_source: str,
    generated_sha: str,
) -> None:
    content = _wav()
    digest = hashlib.sha256(content).hexdigest()
    path = f"assets/{digest}.wav"
    asset = _asset(path, "audio/wav", content)
    clip: dict[str, object] = {
        "assetPath": path,
        "start": 0,
        "duration": 1,
        "sourceStart": 0,
        "sourceEnd": 1,
        "volume": 1,
        "fadeIn": 0,
        "fadeOut": 0,
        "keyframes": [],
    }
    if mutation == "hash":
        asset["sha256"] = "0" * 64
    elif mutation == "path":
        asset["path"] = f"assets/../{digest}.wav"
    elif mutation == "base64":
        asset["contentBase64"] = str(asset["contentBase64"])[:-1] + "!"
    elif mutation == "unreferenced":
        clip = {}
    elif mutation == "expression":
        clip["volumeExpression"] = "evil(t)"
    payload = {
        "source": generated_source,
        "sourceSha256": generated_sha,
        "quality": "preview",
        "output": {"width": 854, "height": 480, "fps": 15, "expectedDurationSeconds": 2 / 15},
        "assets": [asset],
        "audio": {"durationSeconds": 1, "clips": [] if mutation == "unreferenced" else [clip]},
    }
    with pytest.raises(SourcePolicyError):
        validate_render_payload(payload)


def test_audio_filter_graph_is_deterministic_service_generated_only() -> None:
    clip = AudioClip(
        "assets/" + "a" * 64 + ".wav",
        0.5,
        1,
        0,
        1,
        0.8,
        0.1,
        0.2,
        (AudioKeyframe(0, 0.8, "linear"), AudioKeyframe(1, 0.4, "hold")),
    )
    first = _audio_filter_graph((clip,), 2)
    assert _audio_filter_graph((clip,), 2) == first
    assert "atrim=start=0:end=1" in first
    assert "adelay=24000S:all=1" in first
    assert "amix=inputs=1" in first
    assert "evil" not in first


def test_output_profile_is_exact_and_bounded(generated_source: str, generated_sha: str) -> None:
    base = {
        "source": generated_source,
        "sourceSha256": generated_sha,
        "quality": "production",
        "assets": [],
        "audio": {"durationSeconds": 0, "clips": []},
    }
    render, _ = validate_render_payload({**base, "output": {"width": 480, "height": 854, "fps": 24, "expectedDurationSeconds": 2}})
    assert (render.output.width, render.output.height, render.output.fps) == (480, 854, 24)
    for output in (
        {"width": 481, "height": 854, "fps": 24, "expectedDurationSeconds": 2},
        {"width": 1920, "height": 1920, "fps": 30, "expectedDurationSeconds": 2},
        {"width": 1280, "height": 720, "fps": 25, "expectedDurationSeconds": 2},
        {"width": 1280, "height": 720, "fps": 30, "expectedDurationSeconds": 2, "expression": "unsafe"},
    ):
        with pytest.raises(SourcePolicyError):
            validate_render_payload({**base, "output": output})


@pytest.mark.parametrize("mime_type", ["audio/wav", "audio/mpeg"])
def test_safe_mux_produces_verified_h264_aac_mp4(
    tmp_path: Path,
    generated_source: str,
    generated_sha: str,
    mime_type: str,
) -> None:
    job_dir = tmp_path / "job"
    job_dir.mkdir(mode=0o700)
    for child in ("home", "tmp", "cache", "config", "media"):
        (job_dir / child).mkdir(mode=0o700)
    base_video = job_dir / "base.mp4"
    created = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=854x480:r=15:d=2",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(base_video),
        ],
        cwd=job_dir,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=30,
    )
    assert created.returncode == 0, created.stdout.decode(errors="replace")

    content = _wav() if mime_type == "audio/wav" else _mp3(tmp_path)
    digest = hashlib.sha256(content).hexdigest()
    suffix = "wav" if mime_type == "audio/wav" else "mp3"
    path = f"assets/{digest}.{suffix}"
    render, _ = validate_render_payload({
        "source": generated_source,
        "sourceSha256": generated_sha,
        "quality": "preview",
        "output": {"width": 854, "height": 480, "fps": 15, "expectedDurationSeconds": 2},
        "assets": [_asset(path, mime_type, content)],
        "audio": {
            "durationSeconds": 2,
            "clips": [{
                "assetPath": path,
                "start": 0.5,
                "duration": 1,
                "sourceStart": 0,
                "sourceEnd": 1,
                "volume": 0.8,
                "fadeIn": 0.1,
                "fadeOut": 0.2,
                "keyframes": [
                    {"time": 0, "value": 0.8, "interpolation": "linear"},
                    {"time": 1, "value": 0.4, "interpolation": "hold"},
                ],
            }],
        },
    })
    materialize_assets(render, job_dir)
    output = _mux_audio(base_video, render, job_dir)
    assert output.name == "proofcanvas-final.mp4"
    assert output.stat().st_size > 32


def test_trusted_png_and_svg_render_through_pinned_manim(tmp_path: Path) -> None:
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="8"><rect x="0" y="0" width="10" height="8" fill="#123456"/></svg>'
    png_digest = hashlib.sha256(png).hexdigest()
    svg_digest = hashlib.sha256(svg).hexdigest()
    png_path = f"assets/{png_digest}.png"
    svg_path = f"assets/{svg_digest}.svg"
    source = _source_with(
        "        self.next_section(\"Trusted media\")\n"
        "        self.camera.background_color = \"#000000\"\n"
        "        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([0.0, 0.0, 0]).rotate(0.0 * DEGREES))\n"
        f'        pc_png = ImageMobject("{png_path}").set_opacity(1.0)\n'
        "        pc_png.stretch_to_fit_width(1.0).stretch_to_fit_height(1.0)\n"
        "        pc_png.shift([-0.6, 0.0, 0])\n"
        f'        pc_svg = SVGMobject("{svg_path}").set_opacity(1.0)\n'
        "        pc_svg.stretch_to_fit_width(1.0).stretch_to_fit_height(0.8)\n"
        "        pc_svg.shift([0.6, 0.0, 0])\n"
        "        self.add(pc_png, pc_svg)\n"
        "        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))\n"
    )
    render, _ = validate_render_payload({
        "source": source,
        "sourceSha256": hashlib.sha256(source.encode()).hexdigest(),
        "quality": "preview",
        "output": {"width": 854, "height": 480, "fps": 15, "expectedDurationSeconds": 2 / 15},
        "assets": [
            _asset(png_path, "image/png", png),
            _asset(svg_path, "image/svg+xml", svg),
        ],
        "audio": {"durationSeconds": 0.1, "clips": []},
    })
    job_dir = tmp_path / "render"
    job_dir.mkdir(mode=0o700)
    output, digest, size, verification = run_manim(render, "preview", job_dir)
    assert output.is_file()
    assert digest == hashlib.sha256(output.read_bytes()).hexdigest()
    assert size == output.stat().st_size
    assert verification.decoded_frames == 2


def test_crop_cover_and_circle_mask_render_through_exact_helper(tmp_path: Path) -> None:
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
    digest = hashlib.sha256(png).hexdigest()
    path = f"assets/{digest}.png"
    source = (
        "from manim import *\nimport math\nimport numpy as np\nfrom PIL import Image, ImageChops, ImageDraw\n\n"
        + PROOFCANVAS_IMAGE_HELPER
        + "\nclass GeneratedScene(MovingCameraScene):\n"
        "    def construct(self):\n"
        f'        pc_asset = proofcanvas_image("{path}", 0.0, 0.0, 1.0, 1.0, "cover", True, 64, 48, "circle", 0.0).set_opacity(1.0)\n'
        "        pc_asset.stretch_to_fit_width(2.0).stretch_to_fit_height(1.5)\n"
        "        pc_asset.shift([0.0, 0.0, 0])\n"
        "        self.add(pc_asset)\n"
        "        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))\n"
    )
    render, _ = validate_render_payload({
        "source": source,
        "sourceSha256": hashlib.sha256(source.encode()).hexdigest(),
        "quality": "preview",
        "output": {"width": 854, "height": 480, "fps": 15, "expectedDurationSeconds": 2 / 15},
        "assets": [_asset(path, "image/png", png)],
        "audio": {"durationSeconds": 0.1, "clips": []},
    })
    job_dir = tmp_path / "masked-render"
    job_dir.mkdir(mode=0o700)
    output, _, _, verification = run_manim(render, "preview", job_dir)
    assert output.is_file()
    assert verification.decoded_frames == 2
