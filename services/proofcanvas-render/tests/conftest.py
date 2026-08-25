from __future__ import annotations

import hashlib

import pytest


@pytest.fixture
def generated_source() -> str:
    return """from manim import *
import math

class GeneratedScene(MovingCameraScene):
    def construct(self):
        self.next_section("ProofCanvas")
        self.camera.background_color = "#f3eedf"
        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([0.0, 0.0, 0]).rotate(0.0 * DEGREES))
        pc_title = Text("ProofCanvas", font_size=28.0).set_color("#252722").set_opacity(1.0)
        pc_title.scale(min(3.0 / max(pc_title.width, 0.001), 1.0 / max(pc_title.height, 0.001)))
        pc_title.shift([0.0, 1.0, 0])
        pc_graph = VGroup(VMobject().set_points_as_corners([[-2.0, -0.9, 0.0], [0.0, 0.0, 0.0], [2.0, 0.9, 0.0]])).set_stroke("#316b83", width=2.0)
        pc_graph.shift([0.0, 0.0, 0])
        self.add(pc_title, pc_graph)
        self.play(AnimationGroup(
            Succession(Wait(0.0), FadeIn(pc_title, run_time=0.1, rate_func=rate_functions.ease_out_quart), group=Group(), run_time=0.1),
            Indicate(pc_title, color="#71402d", scale_factor=1.08, run_time=0.1, rate_func=rate_functions.there_and_back),
            Succession(Wait(0.1), group=Group(), run_time=0.1),
            group=Group(),
            lag_ratio=0,
            run_time=0.1,
        ))
"""


@pytest.fixture
def generated_sha(generated_source: str) -> str:
    return hashlib.sha256(generated_source.encode("utf-8")).hexdigest()
