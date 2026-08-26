from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from source_snapshot import HARNESS_FILES, build_input_snapshot


CANONICAL_SIZE = (480, 270)
SHAPE_SIGNATURES = {
    "ellipse": np.array([1.0, 0.0, 0.0]),
    "polygon": np.array([0.0, 1.0, 0.0]),
    "dashed-line": np.array([0.0, 0.0, 1.0]),
    "double-arrow": np.array([1.0, 0.0, 1.0]),
    "freeform-path": np.array([0.0, 1.0, 1.0]),
}
THRESHOLDS = {
    "ellipse": {"coverage": 0.94, "p95": 2.5, "bbox": 0.012, "centroid": 0.010, "area_min": 0.78, "area_max": 1.28},
    "polygon": {"coverage": 0.91, "p95": 3.0, "bbox": 0.014, "centroid": 0.011, "area_min": 0.76, "area_max": 1.30},
    "dashed-line": {"coverage": 0.72, "p95": 4.0, "bbox": 0.016, "centroid": 0.014, "area_min": 0.60, "area_max": 1.55},
    "double-arrow": {"coverage": 0.76, "p95": 4.0, "bbox": 0.016, "centroid": 0.014, "area_min": 0.60, "area_max": 1.55},
    "freeform-path": {"coverage": 0.74, "p95": 4.0, "bbox": 0.016, "centroid": 0.014, "area_min": 0.60, "area_max": 1.55},
}
EVIDENCE_ARTIFACT_FILES = [
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
]
EVIDENCE_MANIFEST_FILE = "evidence-manifest.json"
PUBLIC_TEXT_ARTIFACT_FILES = [
    "project.proofcanvas.json",
    "generated.py",
    "compiler.json",
    "browser-stage.svg",
    "browser-capture.json",
    "browser-authoring.json",
    "browser-report.json",
    "manim-render.log",
    "parity-report.json",
    EVIDENCE_MANIFEST_FILE,
]
PRIVATE_TEXT_MARKERS = [
    "/home/",
    "/Users/",
    "/workspace/",
    "/tmp/proofcanvas",
    "PROOFCANVAS_PARITY_OWNER_PASSWORD",
    "PROOFCANVAS_OWNER_PASSWORD_HASH",
    "PROOFCANVAS_SESSION_SECRET",
    "C:\\Users\\",
]
EXPECTED_SHAPE_PRESET_IDS = [
    "rectangle", "rounded-rectangle", "circle", "ellipse", "polygon", "line",
    "dashed-line", "arrow", "double-arrow", "brace", "bracket", "freeform-path",
    "highlight-box", "underline", "cross-out", "dot-point",
]
AUTHORING_SCREENSHOTS = {
    "desktop": ("authoring-desktop-1440x900.png", 1440, 900),
    "locked": ("authoring-locked-1440x900.png", 1440, 900),
    "playback": ("authoring-playback-1440x900.png", 1440, 900),
    "portrait": ("authoring-portrait-1024x1366.png", 1024, 1366),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_json(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def validate_public_text_artifacts(evidence: Path) -> None:
    for name in PUBLIC_TEXT_ARTIFACT_FILES:
        path = evidence / name
        require(path.is_file() and not path.is_symlink(), f"public text artifact is not one regular file: {name}")
        text = path.read_text(encoding="utf-8")
        require("\x00" not in text, f"public text artifact contains a NUL byte: {name}")
        for marker in PRIVATE_TEXT_MARKERS:
            require(marker not in text, f"public text artifact retained a private path or credential marker: {name}")


def validate_cross_file_identity(evidence: Path) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    project_path = evidence / "project.proofcanvas.json"
    source_path = evidence / "generated.py"
    browser_path = evidence / "browser-stage.png"
    svg_path = evidence / "browser-stage.svg"
    compiler = load_json(evidence / "compiler.json")
    browser_capture = load_json(evidence / "browser-capture.json")
    browser_authoring_path = evidence / "browser-authoring.json"
    browser_authoring = load_json(browser_authoring_path)
    browser_report = load_json(evidence / "browser-report.json")
    project = load_json(project_path)
    require(isinstance(compiler, dict), "compiler.json must contain one object")
    require(isinstance(browser_capture, dict), "browser-capture.json must contain one object")
    require(isinstance(browser_authoring, dict), "browser-authoring.json must contain one object")
    require(isinstance(browser_report, dict), "browser-report.json must contain one object")
    require(isinstance(project, dict), "project.proofcanvas.json must contain one object")

    canonical_project = json.dumps(project, indent=2, sort_keys=True) + "\n"
    require(project_path.read_text(encoding="utf-8") == canonical_project, "parity project JSON is not canonical")
    metadata = project.get("metadata")
    require(project.get("schemaVersion") == 4 and isinstance(metadata, dict), "parity project must be schema v4")
    project_id = metadata.get("id")
    require(project_id == "project-4e4154495645534841504553", "parity project identity changed")
    project_sha = sha256(project_path)
    source_sha = sha256(source_path)
    expected_types = list(SHAPE_SIGNATURES)
    require(compiler.get("schemaVersion") == 4, "compiler record schema version changed")
    require(compiler.get("projectId") == project_id and compiler.get("revision") == 2, "compiler record durable identity changed")
    require(compiler.get("projectSha256") == project_sha, "compiler record project hash does not match retained bytes")
    require(compiler.get("sourceSha256") == source_sha, "compiler record source hash does not match retained bytes")
    require(compiler.get("compilerDeterministic") is True, "compiler determinism probe did not pass")
    require(compiler.get("objectTypes") == expected_types, "compiler record native object set changed")
    diagnostics = compiler.get("diagnostics")
    require(isinstance(diagnostics, list) and not any(
        isinstance(diagnostic, dict) and diagnostic.get("severity") == "error"
        for diagnostic in diagnostics
    ), "compiler record contains an error diagnostic")

    require(browser_capture.get("schemaVersion") == 1, "browser capture schema version changed")
    require(browser_capture.get("projectId") == project_id, "browser capture project identity changed")
    require(browser_capture.get("projectSha256") == project_sha, "browser capture project hash does not match retained bytes")
    require(browser_capture.get("screenshotSha256") == sha256(browser_path), "browser capture PNG hash does not match retained bytes")
    require(browser_capture.get("svgSha256") == sha256(svg_path), "browser capture SVG hash does not match retained bytes")
    for error_key in ("consoleErrors", "pageErrors", "failedRequests", "serverErrors"):
        require(browser_capture.get(error_key) == [], f"browser capture retained {error_key}")
    objects = browser_capture.get("objects")
    require(isinstance(objects, list) and [item.get("type") for item in objects if isinstance(item, dict)] == expected_types,
            "browser capture native object set changed")
    require(isinstance(browser_capture.get("expectedDashCount"), int), "browser capture is missing an exact dash count")

    require(browser_authoring.get("schemaVersion") == 1, "browser authoring schema version changed")
    require(browser_authoring.get("projectId") == project_id, "browser authoring project identity changed")
    require(browser_authoring.get("parityProjectSha256") == project_sha,
            "browser authoring project hash does not match the parity input")
    require(browser_authoring.get("projectSchemaVersion") == 4, "browser authoring did not retain schema v4")
    require(browser_authoring.get("initialObjectCount") == 5 and browser_authoring.get("authoredObjectCount") == 10,
            "browser authoring object-count journey changed")
    require(browser_authoring.get("paletteCount") == len(EXPECTED_SHAPE_PRESET_IDS),
            "browser authoring palette count changed")
    require(browser_authoring.get("palettePresetIds") == EXPECTED_SHAPE_PRESET_IDS,
            "browser authoring palette identities or order changed")
    require(browser_authoring.get("insertionModes") == ["click", "drag-and-drop"],
            "browser authoring did not retain click and drag/drop insertion")
    require(browser_authoring.get("editedNativeShapes") == expected_types,
            "browser authoring native control coverage changed")
    require(browser_authoring.get("controls") == {
        "ellipse": {"width": 176, "height": 92},
        "polygon": {"lineJoin": "bevel", "vertex1X": -0.42, "vertexCount": 6},
        "dashedLine": {"lineCap": "round", "dashLength": 10.5, "gapLength": 6.25, "endY": 294, "startXPreserved": True},
        "doubleArrow": {"lineCap": "square", "startTip": "circle", "endTip": "square", "tipSizeRatio": 0.36, "endY": 332},
        "freeformPath": {
            "lineCapBeforeClose": "square", "lineJoin": "bevel", "node2X": 0.12,
            "node2IncomingHandleX": -0.08, "closed": True, "closureChangedPath": True,
        },
    }, "browser authoring exact native controls changed")

    history = browser_authoring.get("history")
    require(isinstance(history, dict), "browser authoring history record is missing")
    require(history.get("undoHeight") == "84" and history.get("redoHeight") == "92",
            "browser authoring undo/redo values changed")
    require(isinstance(history.get("historyAfterEllipse"), int)
            and history.get("historyAfterRedo") == history.get("historyAfterEllipse"),
            "browser authoring redo did not restore the exact history depth")

    locked = browser_authoring.get("lockedMutationRefusal")
    require(isinstance(locked, dict), "browser authoring locked-refusal record is missing")
    require(isinstance(locked.get("historyBeforeLock"), int)
            and locked.get("historyAfterLockedAttempt") == locked.get("historyBeforeLock") + 1,
            "locked pointer attempt changed history beyond the lock operation")
    require(locked.get("inspectorDisabled") is True and locked.get("transformUnchanged") is True,
            "locked browser authoring mutation was not refused")
    require(isinstance(locked.get("notice"), str) and "Locked objects remain selectable" in locked["notice"],
            "locked browser authoring refusal notice changed")

    playback = browser_authoring.get("playbackRefusal")
    require(isinstance(playback, dict), "browser authoring playback-refusal record is missing")
    require(isinstance(playback.get("historyBeforePlayback"), int)
            and playback.get("historyAfterPlaybackDrop") == playback.get("historyBeforePlayback"),
            "playback shape drop mutated browser history")
    require(playback.get("paletteDisabled") is True and playback.get("inspectorDisabled") is True
            and playback.get("undoDisabled") is True and playback.get("stageDropEnabled") is False,
            "playback did not disable every recorded authoring surface")
    require(isinstance(playback.get("notice"), str) and "Pause playback before dropping a shape" in playback["notice"],
            "playback drop refusal notice changed")

    portrait = browser_authoring.get("portrait")
    require(isinstance(portrait, dict), "browser authoring portrait record is missing")
    require(portrait.get("viewport") == {"width": 1024, "height": 1366}
            and portrait.get("authoredFrame") == {"width": 540, "height": 960},
            "browser authoring portrait viewport or authored frame changed")
    layout = portrait.get("layout")
    require(isinstance(layout, dict), "browser authoring portrait layout is missing")
    require(layout.get("innerWidth") == 1024 and layout.get("innerHeight") == 1366,
            "browser authoring portrait browser bounds changed")
    require(isinstance(layout.get("documentWidth"), (int, float)) and layout["documentWidth"] <= 1024
            and isinstance(layout.get("documentHeight"), (int, float)) and layout["documentHeight"] <= 1366,
            "browser authoring portrait page overflowed")
    require(isinstance(layout.get("stageAspect"), (int, float)) and abs(layout["stageAspect"] - 9 / 16) <= 0.01,
            "browser authoring portrait stage aspect changed")
    require(isinstance(layout.get("stageWidth"), (int, float)) and layout["stageWidth"] > 180
            and isinstance(layout.get("stageHeight"), (int, float)) and layout["stageHeight"] > 320
            and isinstance(layout.get("inspectorClientWidth"), (int, float)) and layout["inspectorClientWidth"] > 250
            and isinstance(layout.get("libraryClientWidth"), (int, float)) and layout["libraryClientWidth"] > 220,
            "browser authoring portrait controls are not materially usable")

    screenshots = browser_authoring.get("screenshots")
    require(isinstance(screenshots, dict) and set(screenshots) == set(AUTHORING_SCREENSHOTS),
            "browser authoring screenshot record set changed")
    for key, (name, width, height) in AUTHORING_SCREENSHOTS.items():
        record = screenshots.get(key)
        screenshot_path = evidence / name
        require(isinstance(record, dict) and record == {
            "path": name, "sha256": sha256(screenshot_path), "width": width, "height": height,
        }, f"browser authoring screenshot record changed: {key}")
        with Image.open(screenshot_path) as retained_screenshot:
            require(retained_screenshot.size == (width, height), f"browser authoring screenshot dimensions changed: {key}")
    authoring_record = browser_capture.get("authoring")
    require(isinstance(authoring_record, dict)
            and authoring_record.get("summarySha256") == sha256(browser_authoring_path)
            and authoring_record.get("screenshots") == screenshots,
            "browser capture does not bind the exact authoring summary and screenshots")
    authoring_text = browser_authoring_path.read_text(encoding="utf-8")
    require("/tmp/" not in authoring_text and "/workspace/" not in authoring_text
            and "PROOFCANVAS_PARITY_OWNER_PASSWORD" not in authoring_text,
            "browser authoring summary retained a private runtime path or credential name")
    require(browser_authoring.get("errors") == {
        "consoleErrors": [], "pageErrors": [], "failedRequests": [], "serverErrors": [],
    }, "browser authoring summary retained browser or network errors")

    stats = browser_report.get("stats")
    require(isinstance(stats, dict), "browser report is missing stats")
    require(stats.get("expected") == 1 and stats.get("unexpected") == 0 and stats.get("flaky") == 0,
            "browser report did not retain one clean expected test")
    statuses = [
        result.get("status")
        for suite in browser_report.get("suites", []) if isinstance(suite, dict)
        for spec in suite.get("specs", []) if isinstance(spec, dict)
        for test in spec.get("tests", []) if isinstance(test, dict)
        for result in test.get("results", []) if isinstance(result, dict)
    ]
    require(statuses == ["passed"], "browser report did not retain exactly one passing result")
    return compiler, browser_capture, browser_report


def manifest_records(evidence: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for name in EVIDENCE_ARTIFACT_FILES:
        path = evidence / name
        require(path.is_file() and not path.is_symlink(), f"retained parity artifact is not a regular file: {name}")
        records.append({"path": name, "bytes": path.stat().st_size, "sha256": sha256(path)})
    return records


def write_evidence_manifest(evidence: Path, repository: Path) -> None:
    report = load_json(evidence / "parity-report.json")
    require(isinstance(report, dict) and report.get("passed") is True and report.get("failures") == [],
            "cannot manifest a failing parity report")
    harness_directory = repository / "scripts" / "proofcanvas" / "native-shape-parity"
    build_inputs = build_input_snapshot(repository)
    require(report.get("buildInputs") == build_inputs, "parity report does not bind the current build inputs")
    manifest = {
        "schemaVersion": 1,
        "generatedBy": "scripts/proofcanvas/native-shape-parity/analyze.py",
        "passed": True,
        "reportSha256": sha256(evidence / "parity-report.json"),
        "harnessSha256": {name: sha256(harness_directory / name) for name in HARNESS_FILES},
        "buildInputs": build_inputs,
        "files": manifest_records(evidence),
    }
    (evidence / EVIDENCE_MANIFEST_FILE).write_text(
        canonical_json(manifest),
        encoding="utf-8",
    )
    validate_public_text_artifacts(evidence)


def verify_retained_evidence(evidence: Path, repository: Path) -> None:
    expected_names = set(EVIDENCE_ARTIFACT_FILES) | {EVIDENCE_MANIFEST_FILE}
    actual_entries = list(evidence.iterdir())
    require({entry.name for entry in actual_entries} == expected_names, "retained parity evidence set is not exact")
    require(all(entry.is_file() and not entry.is_symlink() for entry in actual_entries),
            "retained parity evidence contains a non-regular entry")
    validate_cross_file_identity(evidence)
    report = load_json(evidence / "parity-report.json")
    manifest = load_json(evidence / EVIDENCE_MANIFEST_FILE)
    require(isinstance(report, dict) and report.get("passed") is True and report.get("failures") == [],
            "retained parity report does not pass")
    harness_directory = repository / "scripts" / "proofcanvas" / "native-shape-parity"
    current_harness = {name: sha256(harness_directory / name) for name in HARNESS_FILES}
    current_build_inputs = build_input_snapshot(repository)
    require(report.get("harnessSha256") == current_harness, "parity report does not match the current harness revision")
    require(report.get("buildInputs") == current_build_inputs, "parity report does not match the current runtime inputs")
    expected_manifest = {
        "schemaVersion": 1,
        "generatedBy": "scripts/proofcanvas/native-shape-parity/analyze.py",
        "passed": True,
        "reportSha256": sha256(evidence / "parity-report.json"),
        "harnessSha256": current_harness,
        "buildInputs": current_build_inputs,
        "files": manifest_records(evidence),
    }
    require(manifest == expected_manifest, "retained parity manifest does not exactly match current inputs and bytes")
    require((evidence / EVIDENCE_MANIFEST_FILE).read_text(encoding="utf-8") == canonical_json(expected_manifest),
            "retained parity manifest bytes are not canonical")
    validate_public_text_artifacts(evidence)


def load_masks(path: Path) -> tuple[dict[str, np.ndarray], tuple[int, int]]:
    image = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    minimum = image.min(axis=2, keepdims=True)
    chroma = image.max(axis=2) - image.min(axis=2)
    normalized = (image - minimum) / np.maximum(chroma[:, :, None], 1.0)
    signatures = np.stack(list(SHAPE_SIGNATURES.values()))
    distances = ((normalized[:, :, None, :] - signatures[None, None, :, :]) ** 2).sum(axis=3)
    assignment = distances.argmin(axis=2)
    masks: dict[str, np.ndarray] = {}
    for index, name in enumerate(SHAPE_SIGNATURES):
        raw = (assignment == index) & (chroma >= 32.0) & (distances[:, :, index] <= 0.16)
        resized = Image.fromarray(raw.astype(np.uint8) * 255).resize(CANONICAL_SIZE, Image.Resampling.NEAREST)
        masks[name] = np.asarray(resized) > 0
    return masks, (image.shape[1], image.shape[0])


def mask_stats(mask: np.ndarray) -> dict[str, object]:
    rows, columns = np.nonzero(mask)
    if columns.size < 20:
        raise RuntimeError(f"mask retained only {columns.size} pixels")
    labels, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=np.uint8))
    sizes = np.bincount(labels.ravel())[1:]
    material_components = int((sizes >= 2).sum())
    width, height = mask.shape[1], mask.shape[0]
    return {
        "pixels": int(mask.sum()),
        "areaFraction": float(mask.mean()),
        "centroid": [float(columns.mean() / width), float(rows.mean() / height)],
        "bbox": [
            float(columns.min() / width),
            float(rows.min() / height),
            float((columns.max() + 1) / width),
            float((rows.max() + 1) / height),
        ],
        "components": material_components,
        "rawComponents": int(count),
    }


def compare_masks(left: np.ndarray, right: np.ndarray) -> dict[str, float]:
    dilation_left = ndimage.binary_dilation(left, iterations=2)
    dilation_right = ndimage.binary_dilation(right, iterations=2)
    left_covered = float((left & dilation_right).sum() / left.sum())
    right_covered = float((right & dilation_left).sum() / right.sum())
    distance_to_right = ndimage.distance_transform_edt(~right)[left]
    distance_to_left = ndimage.distance_transform_edt(~left)[right]
    distances = np.concatenate([distance_to_right, distance_to_left])
    left_stats = mask_stats(left)
    right_stats = mask_stats(right)
    left_bbox = np.asarray(left_stats["bbox"])
    right_bbox = np.asarray(right_stats["bbox"])
    left_centroid = np.asarray(left_stats["centroid"])
    right_centroid = np.asarray(right_stats["centroid"])
    return {
        "coverage": min(left_covered, right_covered),
        "symmetricMeanDistancePixels": float(distances.mean()),
        "symmetricP95DistancePixels": float(np.percentile(distances, 95)),
        "symmetricMaxDistancePixels": float(distances.max()),
        "bboxMaxDeltaNormalized": float(np.max(np.abs(left_bbox - right_bbox))),
        "centroidDistanceNormalized": float(np.linalg.norm(left_centroid - right_centroid)),
        "areaRatio": float(right.sum() / left.sum()),
    }


def write_comparison_image(
    path: Path,
    browser: np.ndarray,
    manim: np.ndarray,
) -> None:
    comparison = np.full((*browser.shape, 3), 18, dtype=np.uint8)
    comparison[browser & ~manim] = [255, 96, 0]
    comparison[manim & ~browser] = [0, 184, 255]
    comparison[browser & manim] = [255, 255, 255]
    Image.fromarray(comparison, mode="RGB").save(path, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare real browser and pinned-Manim native shape geometry")
    parser.add_argument("--verify-retained", action="store_true", help="verify an already-published exact evidence set")
    parser.add_argument("evidence_directory", type=Path)
    parser.add_argument("repository_root", type=Path)
    args = parser.parse_args()
    evidence = args.evidence_directory.resolve()
    repository = args.repository_root.resolve()

    if args.verify_retained:
        verify_retained_evidence(evidence, repository)
        print(json.dumps({"passed": True, "verified": str(evidence)}, sort_keys=True))
        return

    browser_path = evidence / "browser-stage.png"
    manim_path = evidence / "manim-frame.png"
    browser_masks, browser_size = load_masks(browser_path)
    manim_masks, manim_size = load_masks(manim_path)
    compiler, browser_capture, _ = validate_cross_file_identity(evidence)
    failures: list[str] = []
    shapes: dict[str, object] = {}

    for name in SHAPE_SIGNATURES:
        comparison_image = evidence / f"comparison-{name}.png"
        write_comparison_image(comparison_image, browser_masks[name], manim_masks[name])
        browser_stats = mask_stats(browser_masks[name])
        manim_stats = mask_stats(manim_masks[name])
        comparison = compare_masks(browser_masks[name], manim_masks[name])
        threshold = THRESHOLDS[name]
        checks = {
            "coverage": comparison["coverage"] >= threshold["coverage"],
            "p95Distance": comparison["symmetricP95DistancePixels"] <= threshold["p95"],
            "boundingBox": comparison["bboxMaxDeltaNormalized"] <= threshold["bbox"],
            "centroid": comparison["centroidDistanceNormalized"] <= threshold["centroid"],
            "areaRatio": threshold["area_min"] <= comparison["areaRatio"] <= threshold["area_max"],
        }
        if name == "dashed-line":
            expected = int(browser_capture["expectedDashCount"])
            browser_components = int(browser_stats["components"])
            manim_components = int(manim_stats["components"])
            checks["browserDashTopology"] = browser_components == expected
            checks["manimDashTopology"] = manim_components == expected
            checks["crossRendererDashTopology"] = browser_components == manim_components
        for check, passed in checks.items():
            if not passed:
                failures.append(f"{name}:{check}")
        shapes[name] = {
            "comparisonImage": {
                "path": comparison_image.name,
                "sha256": sha256(comparison_image),
            },
            "browser": browser_stats,
            "manim": manim_stats,
            "comparison": comparison,
            "thresholds": threshold,
            "checks": checks,
            "passed": all(checks.values()),
        }

    harness_directory = repository / "scripts" / "proofcanvas" / "native-shape-parity"
    build_inputs = build_input_snapshot(repository)
    captured_build_inputs = load_json(evidence / "build-input-snapshot.json")
    require(captured_build_inputs == build_inputs,
            "runtime inputs or harness changed after the pre-build snapshot")
    report = {
        "schemaVersion": 1,
        "method": {
            "canonicalMaskPixels": list(CANONICAL_SIZE),
            "segmentation": "nearest pure-chroma signature after white-blend normalization; chroma >= 32",
            "antialiasTolerance": "two-pixel symmetric dilation plus symmetric distance distribution",
            "comparisonImageLegend": "white=overlap, orange=browser-only, cyan=Manim-only, dark=background",
            "geometryGates": "per-shape normalized bbox, centroid, area ratio, coverage, p95 distance; dashed component topology",
            "dashTopology": "exact equality to authored data-dash-count and across renderers after 8-connected labeling; isolated one-pixel segmentation noise is discarded",
            "byteEqualityDeliberatelyExcluded": True,
        },
        "pinnedImages": {
            "playwright": "mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e",
            "manim": "manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3",
        },
        "inputs": {
            "projectSha256": compiler["projectSha256"],
            "sourceSha256": compiler["sourceSha256"],
            "compilerJsonSha256": sha256(evidence / "compiler.json"),
            "browserCaptureJsonSha256": sha256(evidence / "browser-capture.json"),
            "browserAuthoringJsonSha256": sha256(evidence / "browser-authoring.json"),
            "browserReportJsonSha256": sha256(evidence / "browser-report.json"),
            "authoringScreenshotSha256": {
                key: sha256(evidence / name)
                for key, (name, _, _) in AUTHORING_SCREENSHOTS.items()
            },
            "browserPngSha256": sha256(browser_path),
            "browserSvgSha256": sha256(evidence / "browser-stage.svg"),
            "manimPngSha256": sha256(manim_path),
            "manimRenderLogSha256": sha256(evidence / "manim-render.log"),
            "browserPixels": list(browser_size),
            "manimPixels": list(manim_size),
        },
        "harnessSha256": {name: sha256(harness_directory / name) for name in HARNESS_FILES},
        "buildInputs": build_inputs,
        "shapes": shapes,
        "failures": failures,
        "passed": not failures,
    }
    report_path = evidence / "parity-report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        raise SystemExit("native shape parity failed: " + ", ".join(failures))
    write_evidence_manifest(evidence, repository)
    print(json.dumps({"passed": True, "report": str(report_path), "shapes": list(shapes)}, sort_keys=True))


if __name__ == "__main__":
    main()
