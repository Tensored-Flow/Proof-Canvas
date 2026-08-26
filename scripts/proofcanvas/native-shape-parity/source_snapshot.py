from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path


HARNESS_FILES = [
    "project.ts",
    "seed-and-compile.ts",
    "playwright.config.ts",
    "browser.capture.ts",
    "run-browser-inner.sh",
    "sanitize-browser-report.mjs",
    "source_snapshot.py",
    "analyze.py",
    "publish.py",
    "run.sh",
]
RUNTIME_INPUT_ROOTS = [
    "app",
    "lib",
    "public",
    "services/proofcanvas-render/proofcanvas_render",
]
RUNTIME_INPUT_FILES = [
    "next-env.d.ts",
    "next.config.js",
    "package-lock.json",
    "package.json",
    "proxy.ts",
    "scripts/proofcanvas/hash-password.ts",
    "scripts/proofcanvas/https-proxy.mjs",
    "services/proofcanvas-render/Dockerfile",
    "services/proofcanvas-render/requirements.lock",
    "tsconfig.json",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def regular_file_record(repository: Path, relative_path: str) -> dict[str, object]:
    path = repository / relative_path
    require(path.is_file() and not path.is_symlink(), f"runtime input is not one regular file: {relative_path}")
    resolved = path.resolve(strict=True)
    require(os.path.commonpath((str(repository), str(resolved))) == str(repository),
            f"runtime input escaped the repository: {relative_path}")
    return {"path": relative_path, "bytes": path.stat().st_size, "sha256": sha256(path)}


def runtime_source_records(repository: Path) -> list[dict[str, object]]:
    relative_paths = set(RUNTIME_INPUT_FILES)
    for root_name in RUNTIME_INPUT_ROOTS:
        root = repository / root_name
        require(root.is_dir() and not root.is_symlink(), f"runtime input root is not one real directory: {root_name}")
        for path in root.rglob("*"):
            if path.is_dir() and not path.is_symlink():
                continue
            require(path.is_file() and not path.is_symlink(), f"runtime input tree contains a non-regular entry: {path}")
            relative_paths.add(path.relative_to(repository).as_posix())
    return [regular_file_record(repository, name) for name in sorted(relative_paths)]


def harness_hashes(repository: Path) -> dict[str, str]:
    directory = repository / "scripts" / "proofcanvas" / "native-shape-parity"
    return {
        name: str(regular_file_record(repository, (directory / name).relative_to(repository).as_posix())["sha256"])
        for name in HARNESS_FILES
    }


def build_input_snapshot(repository: Path) -> dict[str, object]:
    repository = repository.resolve(strict=True)
    return {
        "schemaVersion": 1,
        "harnessSha256": harness_hashes(repository),
        "runtimeSourceFiles": runtime_source_records(repository),
    }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: source_snapshot.py REPOSITORY OUTPUT_JSON")
    repository = Path(sys.argv[1]).resolve(strict=True)
    output = Path(sys.argv[2])
    snapshot = build_input_snapshot(repository)
    output.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
