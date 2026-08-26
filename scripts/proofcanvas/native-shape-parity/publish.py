from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path


ARTIFACT_FILES = {
    "project.proofcanvas.json",
    "generated.py",
    "compiler.json",
    "browser-stage.png",
    "browser-stage.svg",
    "browser-capture.json",
    "browser-authoring.json",
    "browser-report.json",
    "authoring-desktop-1440x900.png",
    "authoring-locked-1440x900.png",
    "authoring-playback-1440x900.png",
    "authoring-portrait-1024x1366.png",
    "manim-frame.png",
    "manim-render.log",
    "parity-report.json",
    "comparison-ellipse.png",
    "comparison-polygon.png",
    "comparison-dashed-line.png",
    "comparison-double-arrow.png",
    "comparison-freeform-path.png",
    "evidence-manifest.json",
}
AT_FDCWD = -100
RENAME_EXCHANGE = 2


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def validate_exact_directory(directory: Path, label: str) -> None:
    require(directory.exists() and directory.is_dir() and not directory.is_symlink(), f"{label} is not a regular directory")
    entries = list(directory.iterdir())
    require({entry.name for entry in entries} == ARTIFACT_FILES, f"{label} does not contain the exact parity evidence set")
    require(all(entry.is_file() and not entry.is_symlink() for entry in entries), f"{label} contains a non-regular entry")


def fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exchange_directories(left: Path, right: Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    require(renameat2 is not None, "atomic directory exchange is unavailable on this host")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(AT_FDCWD, os.fsencode(left), AT_FDCWD, os.fsencode(right), RENAME_EXCHANGE)
    if result != 0:
        error_number = ctypes.get_errno()
        if error_number in {errno.ENOSYS, errno.EINVAL, errno.ENOTSUP}:
            raise RuntimeError("the evidence filesystem does not support atomic directory exchange")
        raise OSError(error_number, os.strerror(error_number), f"{left} <-> {right}")


def unlink_exact_directory(directory: Path) -> None:
    validate_exact_directory(directory, "exchanged prior evidence")
    for name in sorted(ARTIFACT_FILES):
        (directory / name).unlink()
    directory.rmdir()


def validate_paths(repository_arg: Path, staged_arg: Path, destination_arg: Path, state_arg: Path) -> tuple[Path, Path, Path, Path]:
    repository = repository_arg.resolve(strict=True)
    expected_parent = (repository / "examples" / "proofcanvas").resolve(strict=True)
    staged = staged_arg.absolute()
    destination = destination_arg.absolute()
    state = state_arg.absolute()
    require(destination == expected_parent / "native-shape-parity", "refusing an unexpected parity evidence destination")
    require(staged.parent == expected_parent and staged.name.startswith(".native-shape-parity.publish."),
            "refusing an unexpected parity staging directory")
    require(state.parent.name.startswith("proofcanvas-native-shape-parity.")
            and state.parent.parent == Path("/tmp") and state.name == "publication-state.json",
            "refusing an unexpected publication state path")
    return repository, staged, destination, state


def write_state(state: Path, value: dict[str, object]) -> None:
    require(not state.exists() and not state.is_symlink(), "publication state already exists")
    state.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    descriptor = os.open(state, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(state.parent)


def load_state(state: Path) -> dict[str, object]:
    require(state.is_file() and not state.is_symlink(), "publication state is missing or invalid")
    value = json.loads(state.read_text(encoding="utf-8"))
    require(isinstance(value, dict) and set(value) == {
        "schemaVersion", "candidateManifestSha256", "originalExisted", "originalManifestSha256",
    }, "publication state has an unexpected shape")
    require(value.get("schemaVersion") == 1, "publication state schema changed")
    require(isinstance(value.get("candidateManifestSha256"), str), "publication state candidate hash is invalid")
    require(isinstance(value.get("originalExisted"), bool), "publication state original marker is invalid")
    original_hash = value.get("originalManifestSha256")
    require(original_hash is None or isinstance(original_hash, str), "publication state original hash is invalid")
    return value


def remove_state(state: Path) -> None:
    state.unlink()
    fsync_directory(state.parent)


def manifest_hash(directory: Path) -> str:
    return sha256(directory / "evidence-manifest.json")


def prepare_publication(staged: Path, destination: Path, state: Path) -> None:
    validate_exact_directory(staged, "staged evidence")
    fsync_directory(staged)
    candidate_hash = manifest_hash(staged)
    original_existed = destination.exists() or destination.is_symlink()
    original_hash: str | None = None
    if original_existed:
        validate_exact_directory(destination, "existing evidence")
        original_hash = manifest_hash(destination)
    write_state(state, {
        "schemaVersion": 1,
        "candidateManifestSha256": candidate_hash,
        "originalExisted": original_existed,
        "originalManifestSha256": original_hash,
    })

    if original_existed:
        exchange_directories(staged, destination)
    else:
        os.rename(staged, destination)
    fsync_directory(destination.parent)
    validate_exact_directory(destination, "published candidate evidence")
    require(manifest_hash(destination) == candidate_hash, "published candidate bytes changed during publication")


def finalize_publication(staged: Path, destination: Path, state: Path) -> None:
    publication = load_state(state)
    validate_exact_directory(destination, "verified published evidence")
    require(manifest_hash(destination) == publication["candidateManifestSha256"],
            "verified published evidence is not the prepared candidate")
    if publication["originalExisted"]:
        validate_exact_directory(staged, "exchanged prior evidence")
        require(manifest_hash(staged) == publication["originalManifestSha256"],
                "exchanged prior evidence changed before finalization")
    else:
        require(not staged.exists() and not staged.is_symlink(), "unexpected staging path after first publication")
    # Removing the state is the commit point. From here onward the fully
    # verified candidate stays public even if cleanup of the prior directory is
    # interrupted; the EXIT trap cannot exchange a partially deleted prior
    # directory back into the destination.
    remove_state(state)
    if publication["originalExisted"]:
        unlink_exact_directory(staged)
    print(f"Finalized exact native-shape parity evidence: {destination}")


def rollback_publication(staged: Path, destination: Path, state: Path) -> None:
    if not state.exists() and not state.is_symlink():
        return
    publication = load_state(state)
    candidate_hash = publication["candidateManifestSha256"]
    original_existed = publication["originalExisted"]
    original_hash = publication["originalManifestSha256"]

    destination_hash = manifest_hash(destination) if destination.is_dir() and not destination.is_symlink() else None
    staged_hash = manifest_hash(staged) if staged.is_dir() and not staged.is_symlink() else None
    if original_existed:
        if destination_hash == candidate_hash and staged_hash == original_hash:
            exchange_directories(staged, destination)
            fsync_directory(destination.parent)
            validate_exact_directory(destination, "restored prior evidence")
            require(manifest_hash(destination) == original_hash, "prior evidence rollback changed bytes")
            validate_exact_directory(staged, "rolled-back candidate evidence")
            unlink_exact_directory(staged)
        else:
            require(destination_hash == original_hash and staged_hash == candidate_hash,
                    "publication state is ambiguous; refusing an unsafe rollback")
    else:
        if destination_hash == candidate_hash and staged_hash is None:
            os.rename(destination, staged)
            fsync_directory(destination.parent)
            validate_exact_directory(staged, "rolled-back first candidate evidence")
            unlink_exact_directory(staged)
        else:
            require(destination_hash is None and staged_hash == candidate_hash,
                    "first-publication state is ambiguous; refusing an unsafe rollback")
    remove_state(state)
    print("Rolled back unverified native-shape parity publication.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Atomically publish an exact ProofCanvas parity evidence directory")
    parser.add_argument("action", choices=("prepare", "finalize", "rollback"))
    parser.add_argument("repository_root", type=Path)
    parser.add_argument("staged_directory", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("state_file", type=Path)
    args = parser.parse_args()

    _, staged, destination, state = validate_paths(
        args.repository_root, args.staged_directory, args.destination, args.state_file,
    )
    if args.action == "prepare":
        prepare_publication(staged, destination, state)
        print(f"Prepared exact native-shape parity evidence: {destination}")
    elif args.action == "finalize":
        finalize_publication(staged, destination, state)
    else:
        rollback_publication(staged, destination, state)


if __name__ == "__main__":
    main()
