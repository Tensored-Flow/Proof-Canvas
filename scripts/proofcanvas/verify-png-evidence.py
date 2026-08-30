#!/usr/bin/env python3
"""Fully decode one bounded ProofCanvas PNG inside the pinned renderer image."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


MAX_PNG_BYTES = 16 * 1024 * 1024


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    args = parser.parse_args()

    supplied_path = args.image
    if supplied_path.is_symlink():
        raise SystemExit("PNG evidence must not be a symbolic link")
    path = supplied_path.resolve(strict=True)
    stat = path.stat()
    if not path.is_file() or not 32 <= stat.st_size <= MAX_PNG_BYTES:
        raise SystemExit("PNG evidence is not a bounded regular file")

    with Image.open(path) as image:
        if (
            image.format != "PNG"
            or image.size != (args.width, args.height)
            or image.mode not in {"RGB", "RGBA"}
            or getattr(image, "n_frames", 1) != 1
        ):
            raise SystemExit("PNG evidence does not match its exact output profile")
        image.verify()

    # Pillow's verify() validates the container without retaining decoded pixel
    # data. Reopen and force a complete decode so a valid header/truncated IDAT
    # cannot become release evidence.
    with Image.open(path) as image:
        image.load()
        pixel_bytes = image.tobytes()
        channels = 3 if image.mode == "RGB" else 4
        if len(pixel_bytes) != args.width * args.height * channels:
            raise SystemExit("PNG evidence did not fully decode to its expected pixel buffer")

    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    print(json.dumps({
        "bytes": stat.st_size,
        "decoder": "pillow-pinned-renderer-image",
        "format": "png",
        "fullDecodeVerified": True,
        "height": args.height,
        "path": str(path),
        "sha256": digest,
        "width": args.width,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
