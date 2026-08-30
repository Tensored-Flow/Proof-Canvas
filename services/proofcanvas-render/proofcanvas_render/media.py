from __future__ import annotations

import ast
import base64
import binascii
import hashlib
import io
import math
import re
import struct
import xml.etree.ElementTree as ET
import zlib
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .policy import SourcePolicyError, ValidatedSource, validate_generated_source

AssetMime = Literal["image/png", "image/jpeg", "image/webp", "image/svg+xml", "audio/wav", "audio/mpeg"]
Quality = Literal["preview", "production"]

MAX_RENDER_ASSETS = 64
MAX_RENDER_ASSET_BYTES = 128 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_SVG_BYTES = 2 * 1024 * 1024
MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_IMAGE_DIMENSION = 16_384
MAX_IMAGE_PIXELS = 64 * 1024 * 1024
MAX_AUDIO_CLIPS = 64
MAX_AUDIO_KEYFRAMES = 2_048
MAX_RENDER_DURATION_SECONDS = 310
MAX_AUDIO_SOURCE_SECONDS = 7_200
ASSET_PATH_PATTERN = re.compile(r"^assets/([0-9a-f]{64})\.(png|jpg|webp|svg|wav|mp3)$")

MIME_EXTENSION: dict[AssetMime, str] = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
}


@dataclass(frozen=True)
class ValidatedAsset:
    path: str
    mime_type: AssetMime
    sha256: str
    content: bytes


@dataclass(frozen=True)
class AudioKeyframe:
    time: float
    value: float
    interpolation: Literal["hold", "linear"]


@dataclass(frozen=True)
class AudioClip:
    asset_path: str
    start: float
    duration: float
    source_start: float
    source_end: float
    volume: float
    fade_in: float
    fade_out: float
    keyframes: tuple[AudioKeyframe, ...]


@dataclass(frozen=True)
class AudioPlan:
    duration_seconds: float
    clips: tuple[AudioClip, ...]


@dataclass(frozen=True)
class RenderOutput:
    width: int
    height: int
    fps: int
    expected_duration_seconds: float


@dataclass(frozen=True)
class ValidatedRender:
    source: ValidatedSource
    assets: tuple[ValidatedAsset, ...]
    audio: AudioPlan
    output: RenderOutput


def empty_render(source: ValidatedSource) -> ValidatedRender:
    return ValidatedRender(source, (), AudioPlan(0.0, ()), RenderOutput(854, 480, 15, 1 / 15))


def _exact_dict(candidate: object, keys: set[str], message: str) -> dict[str, object]:
    if not isinstance(candidate, dict) or set(candidate) != keys:
        raise SourcePolicyError(message)
    return candidate


def _number(candidate: object, minimum: float, maximum: float, message: str) -> float:
    if isinstance(candidate, bool) or not isinstance(candidate, (int, float)):
        raise SourcePolicyError(message)
    value = float(candidate)
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise SourcePolicyError(message)
    return value


def _validate_dimensions(width: int, height: int) -> None:
    if (
        width <= 0
        or height <= 0
        or width > MAX_IMAGE_DIMENSION
        or height > MAX_IMAGE_DIMENSION
        or width > MAX_IMAGE_PIXELS // height
    ):
        raise SourcePolicyError("Render image dimensions exceed the safe envelope")


def _validate_png(content: bytes) -> None:
    if len(content) > MAX_IMAGE_BYTES or content[:8] != b"\x89PNG\r\n\x1a\n" or len(content) < 33:
        raise SourcePolicyError("Render PNG is malformed")
    length = struct.unpack_from(">I", content, 8)[0]
    if length != 13 or content[12:16] != b"IHDR":
        raise SourcePolicyError("Render PNG is malformed")
    width, height = struct.unpack_from(">II", content, 16)
    _validate_dimensions(width, height)
    offset = 8
    chunks = 0
    saw_data = False
    saw_end = False
    saw_palette = False
    data_ended = False
    ancillary_bytes = 0
    compressed_parts: list[bytes] = []
    bit_depth = content[24]
    color_type = content[25]
    interlace = content[28]
    valid_depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
    if bit_depth not in valid_depths.get(color_type, set()) or content[26] != 0 or content[27] != 0 or interlace not in {0, 1}:
        raise SourcePolicyError("Render PNG encoding fields are unsupported")
    allowed_ancillary = {b"tEXt", b"tRNS", b"cHRM", b"gAMA", b"pHYs", b"sRGB", b"tIME"}
    while offset < len(content):
        if saw_end:
            raise SourcePolicyError("Render PNG contains data after its end chunk")
        if offset + 12 > len(content):
            raise SourcePolicyError("Render PNG contains a truncated chunk")
        size = struct.unpack_from(">I", content, offset)[0]
        end = offset + 12 + size
        if end > len(content):
            raise SourcePolicyError("Render PNG contains a truncated chunk")
        kind = content[offset + 4:offset + 8]
        data_start = offset + 8
        data_end = data_start + size
        expected_crc = struct.unpack_from(">I", content, data_end)[0]
        if zlib.crc32(content[offset + 4:data_end]) & 0xFFFFFFFF != expected_crc:
            raise SourcePolicyError("Render PNG contains an invalid chunk checksum")
        chunks += 1
        if chunks > 4096:
            raise SourcePolicyError("Render PNG contains too many chunks")
        if kind == b"IHDR" and offset != 8:
            raise SourcePolicyError("Render PNG contains a duplicate header")
        if kind not in {b"IHDR", b"PLTE", b"IDAT", b"IEND"} and kind not in allowed_ancillary:
            raise SourcePolicyError("Render PNG contains an unsupported chunk")
        if kind == b"PLTE":
            if saw_palette or saw_data or color_type in {0, 4} or size == 0 or size > 768 or size % 3:
                raise SourcePolicyError("Render PNG palette is invalid")
            saw_palette = True
        if kind == b"IDAT":
            if data_ended or size == 0 or color_type == 3 and not saw_palette:
                raise SourcePolicyError("Render PNG image data is invalid")
            saw_data = True
            compressed_parts.append(content[data_start:data_end])
        elif saw_data and kind != b"IEND":
            data_ended = True
        if kind == b"IEND":
            if size != 0 or end != len(content):
                raise SourcePolicyError("Render PNG end chunk is invalid")
            saw_end = True
        elif kind in allowed_ancillary:
            ancillary_bytes += size
            if ancillary_bytes > 256 * 1024:
                raise SourcePolicyError("Render PNG ancillary metadata exceeds the safe envelope")
        offset = end
    if not saw_data or not saw_end:
        raise SourcePolicyError("Render PNG is incomplete")

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    bits_per_pixel = channels * bit_depth
    passes = [(0, 0, 1, 1)] if interlace == 0 else [
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2),
    ]
    layouts: list[tuple[int, int]] = []
    decoded_bytes = 0
    for x, y, dx, dy in passes:
        pass_width = 0 if width <= x else math.ceil((width - x) / dx)
        pass_height = 0 if height <= y or pass_width == 0 else math.ceil((height - y) / dy)
        row_bytes = math.ceil(pass_width * bits_per_pixel / 8)
        layouts.append((row_bytes, pass_height))
        decoded_bytes += pass_height * (row_bytes + 1)
    if decoded_bytes <= 0 or decoded_bytes > 256 * 1024 * 1024:
        raise SourcePolicyError("Render PNG decoded bytes exceed the safe envelope")
    decoder = zlib.decompressobj()
    try:
        inflated = decoder.decompress(b"".join(compressed_parts), decoded_bytes + 1)
        if len(inflated) <= decoded_bytes:
            inflated += decoder.flush(decoded_bytes + 1 - len(inflated))
    except zlib.error as error:
        raise SourcePolicyError("Render PNG compressed image data is invalid") from error
    if len(inflated) != decoded_bytes or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise SourcePolicyError("Render PNG compressed image data is invalid")
    decoded_offset = 0
    for row_bytes, rows in layouts:
        for _ in range(rows):
            if inflated[decoded_offset] > 4:
                raise SourcePolicyError("Render PNG scanline filter is invalid")
            decoded_offset += row_bytes + 1


def _validate_decoder_backed_raster(content: bytes, mime_type: str) -> None:
    from PIL import Image, UnidentifiedImageError

    expected_format = "JPEG" if mime_type == "image/jpeg" else "WEBP"
    if mime_type == "image/jpeg" and not (content.startswith(b"\xff\xd8\xff") and content.endswith(b"\xff\xd9")):
        raise SourcePolicyError("Render JPEG is malformed")
    if mime_type == "image/webp" and not (len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP"):
        raise SourcePolicyError("Render WebP is malformed")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as image:
                if image.format != expected_format or getattr(image, "n_frames", 1) != 1:
                    raise SourcePolicyError("Render raster encoding is unsupported")
                width, height = image.size
                _validate_dimensions(width, height)
                image.verify()
            with Image.open(io.BytesIO(content)) as image:
                image.load()
                image.convert("RGBA").tobytes()
    except SourcePolicyError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning, UnidentifiedImageError, OSError, ValueError) as error:
        raise SourcePolicyError("Render raster could not be fully decoded") from error


SVG_NAMESPACE = "http://www.w3.org/2000/svg"
SVG_ELEMENTS = frozenset({"svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon"})
SVG_ATTRIBUTES = frozenset({
    "width", "height", "viewBox", "preserveAspectRatio", "fill", "stroke", "stroke-width",
    "opacity", "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "fill-rule",
    "clip-rule", "transform", "d", "points", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy",
    "r", "rx", "ry",
})


def _validate_svg(content: bytes) -> None:
    if len(content) > MAX_SVG_BYTES:
        raise SourcePolicyError("Render SVG exceeds its safe byte limit")
    try:
        source = content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise SourcePolicyError("Render SVG must be UTF-8") from error
    if "<!" in source or "<?" in source or "&" in source or "url(" in source.lower():
        raise SourcePolicyError("Render SVG contains active or external content")
    try:
        root = ET.fromstring(source)
    except ET.ParseError as error:
        raise SourcePolicyError("Render SVG is malformed") from error
    stack: list[tuple[ET.Element, int]] = [(root, 1)]
    elements = 0
    drawables = 0
    while stack:
        element, depth = stack.pop()
        if depth > 64:
            raise SourcePolicyError("Render SVG nesting exceeds the safe envelope")
        elements += 1
        if elements > 10_000:
            raise SourcePolicyError("Render SVG contains too many elements")
        tag = element.tag
        prefix = f"{{{SVG_NAMESPACE}}}"
        if not isinstance(tag, str) or not tag.startswith(prefix) or tag[len(prefix):] not in SVG_ELEMENTS:
            raise SourcePolicyError("Render SVG contains an unsupported element")
        local = tag[len(prefix):]
        if element.text and element.text.strip() or element.tail and element.tail.strip():
            raise SourcePolicyError("Render SVG text nodes are forbidden")
        if local not in {"svg", "g"}:
            drawables += 1
        for name, value in element.attrib.items():
            if name not in SVG_ATTRIBUTES or name.lower().startswith("on") or ":" in name:
                raise SourcePolicyError("Render SVG contains an unsupported attribute")
            if len(value) > 8192 or any(ord(char) < 32 and char not in "\t\n\r" for char in value):
                raise SourcePolicyError("Render SVG contains an unsafe attribute value")
            lowered = value.lower()
            if any(fragment in lowered for fragment in ("url(", "javascript:", "data:", "file:")):
                raise SourcePolicyError("Render SVG contains an external reference")
        stack.extend((child, depth + 1) for child in reversed(list(element)))
    if drawables == 0:
        raise SourcePolicyError("Render SVG contains no drawable geometry")
    width = root.attrib.get("width", "").removesuffix("px")
    height = root.attrib.get("height", "").removesuffix("px")
    try:
        if bool(width) != bool(height):
            raise ValueError("paired dimensions")
        if width and height:
            numeric_width, numeric_height = float(width), float(height)
        else:
            view_box = [float(part) for part in re.split(r"[\s,]+", root.attrib.get("viewBox", "").strip()) if part]
            if len(view_box) != 4:
                raise ValueError("viewBox")
            numeric_width, numeric_height = view_box[2], view_box[3]
        if not numeric_width.is_integer() or not numeric_height.is_integer():
            raise ValueError("integer dimensions")
        parsed_width, parsed_height = int(numeric_width), int(numeric_height)
    except (ValueError, OverflowError) as error:
        raise SourcePolicyError("Render SVG dimensions are invalid") from error
    _validate_dimensions(parsed_width, parsed_height)


def _validate_wav(content: bytes) -> None:
    if len(content) > MAX_AUDIO_BYTES or len(content) < 44 or content[:4] != b"RIFF" or content[8:12] != b"WAVE":
        raise SourcePolicyError("Render WAV is malformed")
    if struct.unpack_from("<I", content, 4)[0] != len(content) - 8:
        raise SourcePolicyError("Render WAV length is invalid")
    offset = 12
    fmt: tuple[int, int] | None = None
    data_bytes: int | None = None
    chunks = 0
    ancillary_bytes = 0
    while offset < len(content):
        if offset + 8 > len(content):
            raise SourcePolicyError("Render WAV chunk is truncated")
        kind = content[offset:offset + 4]
        length = struct.unpack_from("<I", content, offset + 4)[0]
        start = offset + 8
        end = start + length
        padded = end + (length & 1)
        if end > len(content) or padded > len(content):
            raise SourcePolicyError("Render WAV chunk exceeds the file")
        if length & 1 and content[end] != 0:
            raise SourcePolicyError("Render WAV chunk padding is invalid")
        chunks += 1
        if chunks > 4096:
            raise SourcePolicyError("Render WAV contains too many chunks")
        if kind == b"fmt ":
            if fmt is not None or length != 16:
                raise SourcePolicyError("Render WAV format chunk is invalid")
            audio_format, channels, sample_rate, byte_rate, block_align, bits = struct.unpack_from("<HHIIHH", content, start)
            valid_bits = {8, 16, 24, 32} if audio_format == 1 else {32, 64} if audio_format == 3 else set()
            if channels not in range(1, 9) or not 8_000 <= sample_rate <= 192_000 or bits not in valid_bits:
                raise SourcePolicyError("Render WAV format is unsupported")
            if block_align != channels * bits // 8 or byte_rate != sample_rate * block_align:
                raise SourcePolicyError("Render WAV format is inconsistent")
            fmt = (byte_rate, block_align)
        elif kind == b"data":
            if data_bytes is not None or length == 0:
                raise SourcePolicyError("Render WAV data chunk is invalid")
            data_bytes = length
        elif kind not in {b"LIST", b"JUNK", b"PAD ", b"fact", b"bext"}:
            raise SourcePolicyError("Render WAV contains an unsupported chunk")
        else:
            ancillary_bytes += length
            if ancillary_bytes > 1024 * 1024:
                raise SourcePolicyError("Render WAV ancillary data exceeds the safe envelope")
        offset = padded
    if fmt is None or data_bytes is None or data_bytes % fmt[1] or data_bytes / fmt[0] > MAX_AUDIO_SOURCE_SECONDS:
        raise SourcePolicyError("Render WAV duration or alignment is invalid")


MP3_BITRATES = {
    (1, 1): (0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448),
    (1, 2): (0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384),
    (1, 3): (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),
    (2, 1): (0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256),
    (2, 2): (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
    (2, 3): (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
}


def _synchsafe(content: bytes, offset: int) -> int:
    if offset + 4 > len(content) or any(byte & 0x80 for byte in content[offset:offset + 4]):
        raise SourcePolicyError("Render MP3 ID3 length is invalid")
    return (content[offset] << 21) | (content[offset + 1] << 14) | (content[offset + 2] << 7) | content[offset + 3]


def _validate_mp3(content: bytes) -> None:
    if len(content) > MAX_AUDIO_BYTES or len(content) < 48:
        raise SourcePolicyError("Render MP3 is malformed")
    offset = 0
    if content[:3] == b"ID3":
        if len(content) < 10 or content[3] not in {3, 4} or content[4] == 0xFF or content[5] != 0:
            raise SourcePolicyError("Render MP3 ID3 header is invalid")
        tag_size = _synchsafe(content, 6)
        tag_end = 10 + tag_size
        if tag_size > 1024 * 1024 or tag_end > len(content):
            raise SourcePolicyError("Render MP3 ID3 metadata is oversized")
        offset = 10
        id3_frames = 0
        while offset < tag_end:
            if content[offset] == 0:
                if any(content[offset:tag_end]):
                    raise SourcePolicyError("Render MP3 ID3 padding is invalid")
                offset = tag_end
                break
            if offset + 10 > tag_end:
                raise SourcePolicyError("Render MP3 ID3 frame is truncated")
            identifier = content[offset:offset + 4]
            if not re.fullmatch(rb"(?:T[A-Z0-9]{3}|COMM)", identifier):
                raise SourcePolicyError("Render MP3 ID3 frame is unsupported")
            frame_size = _synchsafe(content, offset + 4) if content[3] == 4 else struct.unpack_from(">I", content, offset + 4)[0]
            if frame_size <= 0 or content[offset + 8:offset + 10] != b"\0\0" or offset + 10 + frame_size > tag_end:
                raise SourcePolicyError("Render MP3 ID3 frame is invalid")
            offset += 10 + frame_size
            id3_frames += 1
            if id3_frames > 4096:
                raise SourcePolicyError("Render MP3 contains too many ID3 frames")
        offset = tag_end

    frame_end = len(content) - 128 if len(content) >= offset + 128 and content[-128:-125] == b"TAG" else len(content)
    frames = 0
    total_samples = 0
    stream_key: tuple[float, int, int] | None = None
    sample_rate = 0
    while offset < frame_end:
        if offset + 4 > frame_end:
            raise SourcePolicyError("Render MP3 frame header is truncated")
        header = struct.unpack_from(">I", content, offset)[0]
        if header >> 21 != 0x7FF:
            raise SourcePolicyError("Render MP3 frame sync is invalid")
        version_bits = (header >> 19) & 3
        layer_bits = (header >> 17) & 3
        bitrate_index = (header >> 12) & 15
        sample_index = (header >> 10) & 3
        padding = (header >> 9) & 1
        if version_bits == 1 or layer_bits == 0 or bitrate_index in {0, 15} or sample_index == 3 or header & 3 == 2:
            raise SourcePolicyError("Render MP3 frame header is invalid")
        version = 1 if version_bits == 3 else 2 if version_bits == 2 else 2.5
        layer = 4 - layer_bits
        rate_base = (44_100, 48_000, 32_000)[sample_index]
        sample_rate = int(rate_base if version == 1 else rate_base / 2 if version == 2 else rate_base / 4)
        table_version = 1 if version == 1 else 2
        bitrate = MP3_BITRATES[(table_version, layer)][bitrate_index] * 1000
        frame_length = (12 * bitrate // sample_rate + padding) * 4 if layer == 1 else ((72 if layer == 3 and version != 1 else 144) * bitrate // sample_rate + padding)
        if frame_length < 24 or offset + frame_length > frame_end:
            raise SourcePolicyError("Render MP3 frame length exceeds the stream")
        next_key = (version, layer, sample_rate)
        if stream_key is not None and next_key != stream_key:
            raise SourcePolicyError("Render MP3 stream parameters change between frames")
        stream_key = next_key
        frames += 1
        if frames > 1_000_000:
            raise SourcePolicyError("Render MP3 contains too many frames")
        total_samples += 384 if layer == 1 else 1152 if layer == 2 or version == 1 else 576
        if total_samples / sample_rate > MAX_AUDIO_SOURCE_SECONDS:
            raise SourcePolicyError("Render MP3 duration exceeds the safe envelope")
        offset += frame_length
    if offset != frame_end or frames < 2 or total_samples <= 0:
        raise SourcePolicyError("Render MP3 is incomplete")


def _validated_asset(candidate: object, aggregate_before: int) -> ValidatedAsset:
    record = _exact_dict(candidate, {"path", "mimeType", "sha256", "bytes", "contentBase64"}, "Render asset envelope is malformed")
    path, mime_type, sha256 = record["path"], record["mimeType"], record["sha256"]
    if not isinstance(path, str) or not isinstance(mime_type, str) or mime_type not in MIME_EXTENSION or not isinstance(sha256, str):
        raise SourcePolicyError("Render asset fields are malformed")
    match = ASSET_PATH_PATTERN.fullmatch(path)
    if not match or match.group(1) != sha256 or match.group(2) != MIME_EXTENSION[mime_type]:
        raise SourcePolicyError("Render asset path does not match its hash and media type")
    declared = record["bytes"]
    limit = MAX_SVG_BYTES if mime_type == "image/svg+xml" else MAX_IMAGE_BYTES if mime_type.startswith("image/") else MAX_AUDIO_BYTES
    if isinstance(declared, bool) or not isinstance(declared, int) or declared <= 0 or declared > limit or declared > MAX_RENDER_ASSET_BYTES - aggregate_before:
        raise SourcePolicyError("Render asset byte count exceeds the safe envelope")
    encoded = record["contentBase64"]
    if not isinstance(encoded, str) or len(encoded) != 4 * ((declared + 2) // 3):
        raise SourcePolicyError("Render asset base64 length is invalid")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise SourcePolicyError("Render asset base64 is invalid") from error
    if len(content) != declared or base64.b64encode(content).decode("ascii") != encoded or hashlib.sha256(content).hexdigest() != sha256:
        raise SourcePolicyError("Render asset content does not match its envelope")
    if mime_type == "image/png":
        _validate_png(content)
    elif mime_type in {"image/jpeg", "image/webp"}:
        _validate_decoder_backed_raster(content, mime_type)
    elif mime_type == "image/svg+xml":
        _validate_svg(content)
    elif mime_type == "audio/wav":
        _validate_wav(content)
    else:
        _validate_mp3(content)
    return ValidatedAsset(path, mime_type, sha256, content)  # type: ignore[arg-type]


def _validated_audio(candidate: object, assets: dict[str, ValidatedAsset]) -> AudioPlan:
    record = _exact_dict(candidate, {"durationSeconds", "clips"}, "Render audio envelope is malformed")
    duration = _number(record["durationSeconds"], 0, MAX_RENDER_DURATION_SECONDS, "Render audio duration is invalid")
    candidates = record["clips"]
    if not isinstance(candidates, list) or len(candidates) > MAX_AUDIO_CLIPS:
        raise SourcePolicyError("Render audio clip count exceeds the safe envelope")
    clips: list[AudioClip] = []
    total_keyframes = 0
    for candidate_clip in candidates:
        clip = _exact_dict(candidate_clip, {"assetPath", "start", "duration", "sourceStart", "sourceEnd", "volume", "fadeIn", "fadeOut", "keyframes"}, "Render audio clip is malformed")
        asset_path = clip["assetPath"]
        if not isinstance(asset_path, str) or asset_path not in assets or assets[asset_path].mime_type not in {"audio/wav", "audio/mpeg"}:
            raise SourcePolicyError("Render audio clip has no trusted audio asset")
        start = _number(clip["start"], 0, duration, "Render audio clip start is invalid")
        clip_duration = _number(clip["duration"], 0.01, duration, "Render audio clip duration is invalid")
        source_start = _number(clip["sourceStart"], 0, MAX_AUDIO_SOURCE_SECONDS, "Render audio source range is invalid")
        source_end = _number(clip["sourceEnd"], 0, MAX_AUDIO_SOURCE_SECONDS, "Render audio source range is invalid")
        volume = _number(clip["volume"], 0, 4, "Render audio volume is invalid")
        fade_in = _number(clip["fadeIn"], 0, clip_duration, "Render audio fade is invalid")
        fade_out = _number(clip["fadeOut"], 0, clip_duration, "Render audio fade is invalid")
        if source_end - source_start < 0.01 or start + clip_duration > duration + 1e-8 or fade_in + fade_out > clip_duration + 1e-8:
            raise SourcePolicyError("Render audio timing is invalid")
        rate = (source_end - source_start) / clip_duration
        if not 1 / 16 <= rate <= 16:
            raise SourcePolicyError("Render audio playback rate exceeds the safe envelope")
        raw_keyframes = clip["keyframes"]
        if not isinstance(raw_keyframes, list):
            raise SourcePolicyError("Render audio keyframes are malformed")
        keyframes: list[AudioKeyframe] = []
        for raw_keyframe in raw_keyframes:
            frame = _exact_dict(raw_keyframe, {"time", "value", "interpolation"}, "Render audio keyframe is malformed")
            frame_time = _number(frame["time"], -MAX_RENDER_DURATION_SECONDS, MAX_RENDER_DURATION_SECONDS, "Render audio keyframe time is invalid")
            frame_value = _number(frame["value"], 0, 4, "Render audio keyframe value is invalid")
            interpolation = frame["interpolation"]
            if interpolation not in {"hold", "linear"} or keyframes and frame_time <= keyframes[-1].time:
                raise SourcePolicyError("Render audio keyframes are unordered or unsupported")
            keyframes.append(AudioKeyframe(frame_time, frame_value, interpolation))  # type: ignore[arg-type]
            total_keyframes += 1
            if total_keyframes > MAX_AUDIO_KEYFRAMES:
                raise SourcePolicyError("Render audio keyframe count exceeds the safe envelope")
        clips.append(AudioClip(asset_path, start, clip_duration, source_start, source_end, volume, fade_in, fade_out, tuple(keyframes)))
    return AudioPlan(duration, tuple(clips))


def _validated_output(candidate: object) -> RenderOutput:
    record = _exact_dict(candidate, {"width", "height", "fps", "expectedDurationSeconds"}, "Render output envelope is malformed")
    width, height, fps = record["width"], record["height"], record["fps"]
    expected_duration = _number(record["expectedDurationSeconds"], 1 / 60, MAX_RENDER_DURATION_SECONDS, "Render expected duration is invalid")
    if (
        isinstance(width, bool)
        or not isinstance(width, int)
        or isinstance(height, bool)
        or not isinstance(height, int)
        or isinstance(fps, bool)
        or not isinstance(fps, int)
        or width < 240
        or height < 240
        or width > 1920
        or height > 1920
        or width * height > 1920 * 1080
        or width % 2
        or height % 2
        or fps not in {15, 24, 30, 60}
    ):
        raise SourcePolicyError("Render output profile exceeds the safe renderer envelope")
    if abs(expected_duration * fps - round(expected_duration * fps)) > 1e-6:
        raise SourcePolicyError("Render expected duration is not frame-aligned")
    return RenderOutput(width, height, fps, expected_duration)


def validate_render_payload(candidate: object) -> tuple[ValidatedRender, Quality]:
    record = _exact_dict(candidate, {"source", "sourceSha256", "quality", "assets", "audio", "output"}, "Render request envelope is malformed")
    source, source_sha, quality = record["source"], record["sourceSha256"], record["quality"]
    if not isinstance(source, str) or not isinstance(source_sha, str) or quality not in {"preview", "production"}:
        raise SourcePolicyError("Render request fields are malformed")
    validated_source = validate_generated_source(source, source_sha)
    raw_assets = record["assets"]
    if not isinstance(raw_assets, list) or len(raw_assets) > MAX_RENDER_ASSETS:
        raise SourcePolicyError("Render asset count exceeds the safe envelope")
    assets: list[ValidatedAsset] = []
    asset_map: dict[str, ValidatedAsset] = {}
    aggregate = 0
    for raw_asset in raw_assets:
        asset = _validated_asset(raw_asset, aggregate)
        if asset.path in asset_map:
            raise SourcePolicyError("Render assets contain a duplicate path")
        aggregate += len(asset.content)
        assets.append(asset)
        asset_map[asset.path] = asset
    audio = _validated_audio(record["audio"], asset_map)
    output = _validated_output(record["output"])

    source_paths: dict[str, str] = {}
    tree = ast.parse(validated_source.source, mode="exec")
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"ImageMobject", "SVGMobject", "proofcanvas_image"}:
            if not node.args or not isinstance(node.args[0], ast.Constant) or not isinstance(node.args[0].value, str):
                continue
            path = node.args[0].value
            source_paths[path] = (
                "image/svg+xml" if node.func.id == "SVGMobject"
                else "image/jpeg" if path.endswith(".jpg")
                else "image/webp" if path.endswith(".webp")
                else "image/png"
            )
    for path, mime_type in source_paths.items():
        if path not in asset_map or asset_map[path].mime_type != mime_type:
            raise SourcePolicyError("Generated source references an absent or mismatched render asset")
    used_paths = set(source_paths) | {clip.asset_path for clip in audio.clips}
    if used_paths != set(asset_map):
        raise SourcePolicyError("Render request contains unreferenced asset content")
    return ValidatedRender(validated_source, tuple(assets), audio, output), quality  # type: ignore[return-value]


def materialize_assets(render: ValidatedRender, job_dir: Path) -> None:
    asset_root = job_dir / "assets"
    asset_root.mkdir(mode=0o700, exist_ok=False)
    resolved_root = asset_root.resolve(strict=True)
    for asset in render.assets:
        destination = job_dir / asset.path
        if destination.parent.resolve(strict=True) != resolved_root or destination.exists() or destination.is_symlink():
            raise RuntimeError("Render asset path escaped the isolated job directory")
        with destination.open("xb") as stream:
            stream.write(asset.content)
            stream.flush()
        destination.chmod(0o600)
        if destination.stat().st_size != len(asset.content):
            raise RuntimeError("Render asset materialization was incomplete")
        digest = hashlib.sha256()
        with destination.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != asset.sha256:
            raise RuntimeError("Render asset materialization changed trusted bytes")
