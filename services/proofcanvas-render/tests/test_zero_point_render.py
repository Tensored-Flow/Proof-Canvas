from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

import av
import pytest

from proofcanvas_render.policy import validate_generated_source


def render_probe(tmp_path: Path, source: str, expected_frames: int, fps: int = 10) -> list:
    validate_generated_source(source, hashlib.sha256(source.encode("utf-8")).hexdigest())
    source_path = tmp_path / "generated_scene.py"
    source_path.write_text(source, encoding="utf-8")
    media_dir = tmp_path / "media"
    rendered = subprocess.run(
        [
            "manim",
            "-ql",
            "--disable_caching",
            "--media_dir",
            str(media_dir),
            "--fps",
            str(fps),
            "-r",
            "240,136",
            str(source_path),
            "GeneratedScene",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert rendered.returncode == 0, rendered.stdout + rendered.stderr
    videos = list(media_dir.rglob("GeneratedScene.mp4"))
    assert len(videos) == 1
    with av.open(str(videos[0])) as container:
        stream = container.streams.video[0]
        decoded = [frame.to_ndarray(format="rgb24") for frame in container.decode(stream)]
        duration = float(stream.duration * stream.time_base)
    assert len(decoded) == expected_frames
    assert duration == pytest.approx(expected_frames / fps, abs=0.001)
    return decoded


def test_isolated_lifetime_points_render_at_exact_frames(tmp_path: Path) -> None:
    source = """from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        pc_dot = Circle(radius=0.2).set_opacity(0.0)
        self.play(Succession(Wait(0.2), Succession(Transform(pc_dot, pc_dot.copy().set_opacity(1.0), run_time=0.0, rate_func=linear), FadeIn(pc_dot, run_time=0.0, rate_func=linear), group=Group(), run_time=0.0), group=Group(), run_time=0.2))
        self.play(Succession(Wait(0.2), Transform(pc_dot, pc_dot.copy().set_opacity(0.0), run_time=0.0, rate_func=linear), group=Group(), run_time=0.2))
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
"""
    render_probe(tmp_path, source, expected_frames=6)


def test_terminal_hold_point_renders_without_extending_the_timeline(tmp_path: Path) -> None:
    source = """from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        pc_dot = Circle(radius=0.2)
        self.add(pc_dot)
        self.play(Succession(Wait(0.4), Transform(pc_dot, pc_dot.copy().shift(RIGHT), run_time=0.0, rate_func=linear), group=Group(), run_time=0.4))
"""
    render_probe(tmp_path, source, expected_frames=4)


def test_naive_semantic_motion_inside_hold_authority_fails_to_restore_held_state(tmp_path: Path) -> None:
    source = """from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        pc_dot = Circle(radius=0.25).set_fill("#ffffff", opacity=1.0).set_stroke("#ffffff", width=0.0).move_to([-1.0, 0.0, 0])
        pc_ref = pc_dot.copy()
        self.add(pc_dot)
        self.play(Succession(Wait(0.1), Transform(pc_dot, pc_ref.copy().move_to([0.0, 0.0, 0]), run_time=0.3, rate_func=linear), group=Group(), run_time=0.4))
        self.play(Succession(Wait(0.2), Transform(pc_dot, pc_ref.copy().move_to([1.0, 0.0, 0]), run_time=0.0, rate_func=linear), group=Group(), run_time=0.2))
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
"""
    frames = render_probe(tmp_path, source, expected_frames=7)

    def white_centroid_x(frame) -> float:
        mask = (frame[:, :, 0] > 180) & (frame[:, :, 1] > 180) & (frame[:, :, 2] > 180)
        columns = mask.nonzero()[1]
        assert columns.size > 0
        return float(columns.mean())

    centroids = [white_centroid_x(frame) for frame in frames]
    # Preview owns the authored left value throughout the hold interval, so it
    # would return to frame-0 here. Manim retains the semantic Move endpoint
    # instead; the compiler therefore rejects this authority collision.
    assert centroids[4] > centroids[0] + 10
    assert centroids[5] > centroids[0] + 10
    assert centroids[6] > centroids[5] + 10


def test_there_and_back_property_endpoint_snap_precedes_following_tween(tmp_path: Path) -> None:
    source = """from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        pc_dot = Circle(radius=0.25).set_fill("#ffffff", opacity=1.0).set_stroke("#ffffff", width=0.0).move_to([-1.0, 0.0, 0])
        pc_ref = pc_dot.copy()
        self.add(pc_dot)
        self.play(Succession(Transform(pc_dot, pc_ref.copy().move_to([0.0, 0.0, 0]), run_time=0.2, rate_func=rate_functions.there_and_back), Transform(pc_dot, pc_ref.copy().move_to([0.0, 0.0, 0]), run_time=0.0, rate_func=linear), Transform(pc_dot, pc_ref.copy().move_to([1.0, 0.0, 0]), run_time=0.2, rate_func=linear), group=Group(), run_time=0.4))
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
"""
    frames = render_probe(tmp_path, source, expected_frames=5)

    def white_centroid_x(frame) -> float:
        mask = (frame[:, :, 0] > 180) & (frame[:, :, 1] > 180) & (frame[:, :, 2] > 180)
        columns = mask.nonzero()[1]
        assert columns.size > 0
        return float(columns.mean())

    centroids = [white_centroid_x(frame) for frame in frames]
    assert centroids[0] < 110  # authored left state at t=0
    assert centroids[1] > 115  # there-and-back peak near the centre
    assert centroids[2] > 115  # following tween captured the zero-snap centre
    assert centroids[3] > centroids[2]
    assert centroids[4] > 133  # exact right state after the following tween


def test_nested_expired_child_stays_hidden_through_group_motion_and_later_entrance(tmp_path: Path) -> None:
    source = """from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        pc_expiring = Rectangle(width=1.0, height=1.0).set_fill("#ff0000", opacity=1.0).set_stroke("#ff0000", width=0.0).move_to([-1.0, 0.0, 0])
        pc_expiring_ref = pc_expiring.copy()
        pc_sibling = Rectangle(width=1.0, height=1.0).set_fill("#0000ff", opacity=1.0).set_stroke("#0000ff", width=0.0).move_to([1.0, 0.0, 0])
        pc_sibling_ref = pc_sibling.copy()
        pc_group = VGroup(pc_expiring, pc_sibling)
        pc_expiring.set_opacity(0.0)
        pc_sibling.set_opacity(0.0)
        self.play(Transform(pc_group, VGroup(pc_expiring_ref.copy().move_to([-0.5, 0.0, 0]).set_opacity(0.0), pc_sibling_ref.copy().move_to([1.5, 0.0, 0]).set_opacity(0.0)), run_time=0.2, rate_func=linear))
        self.play(Succession(Wait(0.1), Transform(pc_expiring, pc_expiring.copy().set_opacity(0.0), run_time=0.0, rate_func=linear), group=Group(), run_time=0.1))
        self.play(Succession(Wait(0.1), Transform(pc_group, VGroup(pc_expiring_ref.copy().move_to([-0.5, 0.0, 0]).set_opacity(0.0), pc_sibling_ref.copy().move_to([1.5, 0.0, 0]).set_opacity(1.0)), run_time=0.2, rate_func=linear), group=Group(), run_time=0.3))
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
"""
    frames = render_probe(tmp_path, source, expected_frames=7)
    red_counts = [int(((frame[:, :, 0] > 160) & (frame[:, :, 1] < 80) & (frame[:, :, 2] < 80)).sum()) for frame in frames]
    blue_counts = [int(((frame[:, :, 2] > 160) & (frame[:, :, 0] < 80) & (frame[:, :, 1] < 80)).sum()) for frame in frames]
    assert max(red_counts) == 0
    assert max(blue_counts[:4]) == 0
    assert blue_counts[-1] > 50


@pytest.mark.parametrize("constructor", ["Create", "Write"])
def test_native_path_entrances_reach_the_full_there_and_back_peak_and_restore_hidden(
    tmp_path: Path,
    constructor: str,
) -> None:
    source = f"""from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        pc_shape = Rectangle(width=2.0, height=1.0).set_fill("#ffffff", opacity=1.0).set_stroke("#ffffff", width=4.0)
        self.play({constructor}(pc_shape, run_time=0.2, rate_func=rate_functions.there_and_back))
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
        pc_reference = Rectangle(width=2.0, height=1.0).set_fill("#ffffff", opacity=1.0).set_stroke("#ffffff", width=4.0)
        self.add(pc_reference)
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
"""
    frames = render_probe(tmp_path, source, expected_frames=4)

    def visible_mask(frame):
        return frame.max(axis=2) > 45

    def bounds(mask) -> tuple[int, int, int, int]:
        rows, columns = mask.nonzero()
        assert rows.size > 0
        return int(columns.min()), int(columns.max()), int(rows.min()), int(rows.max())

    start, peak, restored_endpoint, full_reference = map(visible_mask, frames)
    assert int(start.sum()) == 0
    assert int(restored_endpoint.sum()) == 0
    assert int(peak.sum()) > 0
    assert abs(int(peak.sum()) - int(full_reference.sum())) <= 1
    assert bounds(peak) == bounds(full_reference)


@pytest.mark.parametrize("constructor", ["Create", "Write"])
def test_native_there_and_back_path_entrance_leaks_hidden_follow_up_state(
    tmp_path: Path,
    constructor: str,
) -> None:
    source = f"""from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        pc_shape = Rectangle(width=2.0, height=1.0).set_fill("#ffffff", opacity=1.0).set_stroke("#ffffff", width=4.0)
        pc_reference = Rectangle(width=2.0, height=1.0).set_fill("#ffffff", opacity=1.0).set_stroke("#ffffff", width=4.0)
        self.play({constructor}(pc_shape, run_time=0.2, rate_func=rate_functions.there_and_back))
        self.play(Transform(pc_shape, pc_reference.copy().set_opacity(0.0), run_time=0.2, rate_func=linear))
        self.play(Transform(pc_shape, pc_reference.copy().set_opacity(1.0), run_time=0.2, rate_func=linear))
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
"""
    frames = render_probe(tmp_path, source, expected_frames=7)
    masks = [frame.max(axis=2) > 45 for frame in frames]
    counts = [int(mask.sum()) for mask in masks]
    assert counts[0] == 0
    assert counts[1] > 0
    assert counts[2] == 0
    # Pinned Manim restores a degenerate path state at the hidden endpoint.
    # Interpolating from it to another opacity-zero target leaks visible pixels,
    # which is why the compiler rejects this type/easing combination.
    assert counts[3] > 0
    assert counts[4] == 0
    assert 0 < counts[5] < counts[6]
    assert abs(counts[6] - counts[1]) <= 1

    def bounds(mask) -> tuple[int, int, int, int]:
        rows, columns = mask.nonzero()
        assert rows.size > 0
        return int(columns.min()), int(columns.max()), int(rows.min()), int(rows.max())

    assert bounds(masks[6]) == bounds(masks[1])


def test_emphasise_uses_one_there_and_back_scale_pulse(tmp_path: Path) -> None:
    source = """from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        pc_shape = Rectangle(width=1.0, height=1.0).set_fill("#ffffff", opacity=1.0).set_stroke("#ffffff", width=0.0)
        self.add(pc_shape)
        self.play(Indicate(pc_shape, color="#71402d", scale_factor=1.5, run_time=0.4, rate_func=rate_functions.there_and_back))
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
"""
    frames = render_probe(tmp_path, source, expected_frames=5)

    def visible_width(frame) -> int:
        mask = frame.max(axis=2) > 45
        columns = mask.nonzero()[1]
        assert columns.size > 0
        return int(columns.max() - columns.min() + 1)

    widths = [visible_width(frame) for frame in frames]
    # 10 fps samples alpha=0,.25,.5,.75 and the explicit final hold captures
    # alpha=1: one exact mirrored pulse with the authored endpoint restored.
    assert widths[2] > widths[1] > widths[0]
    assert widths[2] > widths[3] > widths[4]
    assert widths[1] == pytest.approx(widths[3], abs=2)
    assert widths[0] == pytest.approx(widths[4], abs=2)
    assert widths[2] / widths[4] == pytest.approx(1.5, abs=0.15)


def test_explicit_wait_wrapper_preserves_canonical_point_three_seconds(tmp_path: Path) -> None:
    source = """from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        self.play(Succession(Wait(0.3), group=Group(), run_time=0.3))
"""
    render_probe(tmp_path, source, expected_frames=3)


@pytest.mark.parametrize(
    ("fps", "runtime", "expected_frames"),
    [
        (15, "0.06666667", 2),
        (24, "0.04166667", 2),
        (30, "0.03333333", 1),
        (60, "0.01666667", 2),
    ],
)
def test_explicit_runtime_matches_pinned_sampling_at_supported_fps(
    tmp_path: Path,
    fps: int,
    runtime: str,
    expected_frames: int,
) -> None:
    source = f"""from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        self.play(Succession(Wait({runtime}), group=Group(), run_time={runtime}))
"""
    render_probe(tmp_path, source, expected_frames=expected_frames, fps=fps)
