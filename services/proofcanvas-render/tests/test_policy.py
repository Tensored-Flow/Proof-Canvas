from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from proofcanvas_render.policy import (
    MAX_RATE_LAMBDAS,
    MAX_SOURCE_BYTES,
    PROOFCANVAS_CUBIC_BEZIER_HELPER,
    SourcePolicyError,
    validate_generated_source,
)


def test_accepts_compiler_dialect(generated_source: str, generated_sha: str) -> None:
    validated = validate_generated_source(generated_source, generated_sha)

    assert validated.source == generated_source
    assert validated.sha256 == generated_sha


@pytest.mark.parametrize(
    "unsafe_statement",
    [
        "        import os\n",
        "        from os import system as abs\n        abs(\"id\")\n",
        "        def abs(value):\n            return value\n        abs(\"id\")\n",
        "        pc_escape = globals\n        pc_escape()\n",
        "        pc_file = open(\"/etc/passwd\")\n",
        "        pc_asset = ImageMobject(\"/etc/passwd\")\n",
        "        while True:\n            pass\n",
    ],
)
def test_rejects_unsafe_python(unsafe_statement: str) -> None:
    source = "from manim import *\nimport math\n\nclass GeneratedScene(MovingCameraScene):\n    def construct(self):\n" + unsafe_statement
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()

    with pytest.raises(SourcePolicyError):
        validate_generated_source(source, digest)


@pytest.mark.parametrize(
    "statement",
    [
        "        1 / 0\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.width\n",
    ],
)
def test_rejects_noncompiler_expression_statements(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="noncompiler expression statement"):
        validate(source_with(statement))


def test_accepts_exact_zero_runtime_compiler_fallback_call() -> None:
    validate(source_with("        self.wait(0.0)\n"))


def test_rejects_sha_mismatch(generated_source: str) -> None:
    with pytest.raises(SourcePolicyError, match="does not match"):
        validate_generated_source(generated_source, "0" * 64)


def test_rejects_oversized_source() -> None:
    source = "x" * (MAX_SOURCE_BYTES + 1)
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()

    with pytest.raises(SourcePolicyError, match="exceeds"):
        validate_generated_source(source, digest)


def source_with(statement: str) -> str:
    return "from manim import *\nimport math\n\nclass GeneratedScene(MovingCameraScene):\n    def construct(self):\n" + statement


def source_with_cubic_helper(statement: str, helper: str = PROOFCANVAS_CUBIC_BEZIER_HELPER) -> str:
    return f"from manim import *\nimport math\n\n{helper}\nclass GeneratedScene(MovingCameraScene):\n    def construct(self):\n" + statement


def validate(source: str) -> None:
    validate_generated_source(source, hashlib.sha256(source.encode("utf-8")).hexdigest())


@pytest.mark.parametrize(
    "class_header",
    [
        'class GeneratedScene(MovingCameraScene, metaclass="x" * 1_000_000_000):',
        'class GeneratedScene(MovingCameraScene, junk="x" * 1_000_000_000):',
        'class GeneratedScene(MovingCameraScene, **{"junk": "x" * 1_000_000_000}):',
        'class GeneratedScene(*[MovingCameraScene]):',
        'class GeneratedScene[T: ("x" * 1_000_000_000)](MovingCameraScene):',
        'class GeneratedScene[T = int](MovingCameraScene):',
    ],
)
def test_rejects_executable_generated_scene_definition_contexts(class_header: str) -> None:
    source = source_with("        self.wait(0.0)\n").replace(
        "class GeneratedScene(MovingCameraScene):",
        class_header,
    )

    with pytest.raises(SourcePolicyError, match="define only GeneratedScene"):
        validate(source)


@pytest.mark.parametrize(
    "construct_header",
    [
        "    async def construct(self):",
        "    @staticmethod\n    def construct(self):",
        '    def construct(self="x" * 1_000_000_000):',
        '    def construct(self: "x" * 1_000_000_000):',
        '    def construct(self) -> "x" * 1_000_000_000:',
        "    def construct(self, /):",
        "    def construct(extra, /, self):",
        "    def construct(self, *extra):",
        '    def construct(self, *, extra="x" * 1_000_000_000):',
        "    def construct(self, **extra):",
        '    def construct[T: ("x" * 1_000_000_000)](self):',
        "    def construct[T = int](self):",
    ],
)
def test_rejects_executable_construct_definition_contexts(construct_header: str) -> None:
    source = source_with("        self.wait(0.0)\n").replace(
        "    def construct(self):",
        construct_header,
    )

    with pytest.raises(SourcePolicyError, match=r"only construct\(self\)"):
        validate(source)


def test_rejects_generated_scene_body_outside_exact_construct() -> None:
    source = source_with("        self.wait(0.0)\n").replace(
        "    def construct(self):",
        '    marker = "x" * 1_000_000_000\n    def construct(self):',
    )

    with pytest.raises(SourcePolicyError, match="define only GeneratedScene"):
        validate(source)


@pytest.mark.parametrize(
    "construct_definition",
    [
        "    def construct(self):\n        # type: (object) -> None\n",
        "    def construct(\n        self,  # type: object\n    ):\n",
    ],
)
def test_rejects_construct_type_comments(construct_definition: str) -> None:
    source = source_with("        self.wait(0.0)\n").replace(
        "    def construct(self):\n",
        construct_definition,
    )

    with pytest.raises(SourcePolicyError, match=r"only construct\(self\)"):
        validate(source)


LITERAL_GRAPH_SEGMENT = "VMobject().set_points_as_corners([[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]])"
LITERAL_GRAPH_BASE = f"VGroup({LITERAL_GRAPH_SEGMENT})"
LITERAL_GRAPH_STROKE = f'{LITERAL_GRAPH_BASE}.set_stroke("#ffffff", width=2.0)'


LATEX_CONFORMANCE = json.loads((Path(__file__).with_name("latex_conformance.json")).read_text(encoding="utf-8"))["vectors"]


@pytest.mark.parametrize("vector", LATEX_CONFORMANCE, ids=lambda vector: vector["id"])
def test_shared_latex_conformance(vector: dict[str, object]) -> None:
    renderer = "MathTex" if vector["renderer"] == "mathtex" else "Tex"
    statement = (
        f"        pc_math = {renderer}({json.dumps(vector['content'])}, font_size=34.0)\n"
        "        pc_math.shift([0.0, 0.0, 0])\n"
    )
    if vector["accepted"]:
        validate(source_with(statement))
    else:
        with pytest.raises(SourcePolicyError, match="safe compiler dialect"):
            validate(source_with(statement))


def test_accepts_safe_mathtex_compiler_dialect() -> None:
    validate(source_with(
        '        pc_math = MathTex(r"\\\\frac{1}{2} \\le \\pi", font_size=34.0)\n'
        "        pc_math.shift([0.0, 0.0, 0])\n"
    ))


def test_accepts_safe_tex_compiler_dialect() -> None:
    validate(source_with(
        '        pc_text = Tex(r"Euler wrote $e^{i\\\\pi}+1=0$.", font_size=34.0)\n'
        "        pc_text.shift([0.0, 0.0, 0])\n"
    ))


@pytest.mark.parametrize("font_size", [1.0, 256.0])
def test_accepts_schema_font_size_boundaries(font_size: float) -> None:
    validate(source_with(
        f'        pc_math = MathTex(r"x", font_size={font_size})\n'
        "        pc_math.shift([0.0, 0.0, 0])\n"
    ))


def test_rejects_unsafe_tex_content() -> None:
    content = r"\input{/etc/hostname}"
    with pytest.raises(SourcePolicyError, match="Tex content is outside"):
        validate(source_with(f"        pc_text = Tex({json.dumps(content)}, font_size=34.0)\n"))


@pytest.mark.parametrize("command", ["input", "include", "write", "openin", "openout", "read", "special"])
def test_rejects_file_and_process_latex_commands(command: str) -> None:
    content = f"\\{command}{{/etc/hostname}}"
    source = source_with(f"        pc_math = MathTex({json.dumps(content)}, font_size=34.0)\n")

    with pytest.raises(SourcePolicyError, match="safe compiler dialect"):
        validate(source)


def test_rejects_constructed_mathtex_content() -> None:
    source = source_with(
        '        pc_fragment = r"\\\\input"\n'
        '        pc_math = MathTex(pc_fragment + "{/etc/hostname}", font_size=34.0)\n'
    )

    with pytest.raises(SourcePolicyError, match="safe compiler dialect"):
        validate(source)


def test_rejects_constructor_alias_calls() -> None:
    source = source_with(
        "        pc_constructor = MathTex\n"
        '        pc_math = pc_constructor(r"\\\\frac{1}{2}", font_size=34.0)\n'
    )

    with pytest.raises(SourcePolicyError, match="unsupported function"):
        validate(source)


@pytest.mark.parametrize(
    "arguments",
    [
        "",
        ", color=\"#ffffff\"",
        ", font_size=0.99",
        ", font_size=257.0",
        ", font_size=pc_font_size",
        ", font_size=34.0, tex_template=None",
    ],
)
def test_rejects_mathtex_arguments_outside_compiler_dialect(arguments: str) -> None:
    prefix = "        pc_font_size = 34.0\n" if "pc_font_size" in arguments else ""
    source = source_with(prefix + f'        pc_math = MathTex(r"\\\\frac{{1}}{{2}}"{arguments})\n')

    with pytest.raises(SourcePolicyError, match="arguments are outside"):
        validate(source)


def test_accepts_exact_cubic_bezier_helper_only_in_transform_rate_func() -> None:
    validate(source_with_cubic_helper(
        "        pc_box = Rectangle(width=1.0, height=1.0)\n"
        "        pc_box.shift([0.0, 0.0, 0])\n"
        "        pc_ref = pc_box.copy()\n"
        "        self.play(Transform(pc_box, pc_ref.copy().set_opacity(1.0), run_time=1.0, "
        "rate_func=lambda x: proofcanvas_cubic_bezier(x, 0.25, -1.0, 0.75, 2.0)))\n"
    ))


@pytest.mark.parametrize(
    "mutation",
    [
        lambda helper: helper.replace("range(32)", "range(31)"),
        lambda helper: helper.replace("lower = 0.0", "lower = 0.1"),
        lambda helper: helper + "\nproofcanvas_extra = 1.0\n",
        lambda helper: helper.replace("proofcanvas_cubic_bezier", "proofcanvas_cubic_bezier_other", 1),
    ],
)
def test_rejects_any_cubic_helper_ast_mutation(mutation) -> None:
    source = source_with_cubic_helper("        self.wait(1.0)\n", mutation(PROOFCANVAS_CUBIC_BEZIER_HELPER))

    with pytest.raises(SourcePolicyError, match="helper|scene class"):
        validate(source)


@pytest.mark.parametrize(
    "statement",
    [
        "        pc_easing = lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.3, 0.8, 0.9)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.play(Transform(pc_box, pc_box.copy(), lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.3, 0.8, 0.9)))\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.play(Transform(pc_box, pc_box.copy(), path_func=lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.3, 0.8, 0.9)))\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.play(FadeIn(pc_box, rate_func=lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.3, 0.8, 0.9)))\n",
    ],
)
def test_rejects_cubic_lambda_outside_exact_transform_rate_keyword(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="Transform rate_func"):
        validate(source_with_cubic_helper(statement))


@pytest.mark.parametrize(
    "statement",
    [
        "        pc_graph = FunctionGraph(lambda x: math.sin(x), x_range=[-2.0, 2.0])\n",
        "        pc_graph = FunctionGraph(lambda x: 1 / 0, x_range=[-2.0, 2.0])\n",
        "        pc_lambda = lambda x: x\n",
    ],
)
def test_rejects_legacy_graph_and_non_easing_lambdas(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="custom-easing"):
        validate(source_with(statement))


@pytest.mark.parametrize(
    "arguments",
    [
        "pc_curve, 0.0, 0.8, 1.0",
        "1.1, 0.0, 0.8, 1.0",
        "0.2, -4.1, 0.8, 1.0",
        "0.2, 0.0, 0.8, float('nan')",
    ],
)
def test_rejects_nonliteral_or_out_of_bounds_cubic_arguments(arguments: str) -> None:
    prefix = "        pc_curve = 0.2\n" if "pc_curve" in arguments else ""
    source = source_with_cubic_helper(
        prefix
        + "        pc_box = Rectangle(width=1.0, height=1.0)\n"
        + f"        self.play(Transform(pc_box, pc_box.copy(), rate_func=lambda x: proofcanvas_cubic_bezier(x, {arguments})))\n"
    )

    with pytest.raises(SourcePolicyError, match="numeric literals|schema bounds"):
        validate(source)


def test_rejects_cubic_lambda_without_exact_helper() -> None:
    source = source_with(
        "        pc_box = Rectangle(width=1.0, height=1.0)\n"
        "        self.play(Transform(pc_box, pc_box.copy(), rate_func=lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.3, 0.8, 0.9)))\n"
    )

    with pytest.raises(SourcePolicyError, match="exact compiler helper"):
        validate(source)


def test_rejects_positional_only_custom_easing_lambda() -> None:
    source = source_with_cubic_helper(
        "        pc_box = Rectangle(width=1.0, height=1.0)\n"
        "        pc_box.shift([0.0, 0.0, 0])\n"
        "        pc_ref = pc_box.copy()\n"
        "        self.play(Transform(pc_box, pc_ref.copy().set_opacity(1.0), run_time=1.0, "
        "rate_func=lambda extra, /, x: proofcanvas_cubic_bezier(x, 0.2, 0.0, 0.8, 1.0)))\n"
    )

    with pytest.raises(SourcePolicyError, match="accept only x"):
        validate(source)


@pytest.mark.parametrize(
    "statement",
    [
        "        proofcanvas_cubic_bezier = min\n",
        "        Transform = FadeIn\n",
    ],
)
def test_rejects_shadowing_compiler_policy_names(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="shadows a reserved compiler name"):
        validate(source_with_cubic_helper(statement))


def test_rejects_bare_cubic_helper_reference() -> None:
    with pytest.raises(SourcePolicyError, match="may be read only"):
        validate(source_with_cubic_helper("        pc_easing = proofcanvas_cubic_bezier\n"))


@pytest.mark.parametrize(
    "decorators",
    [
        '.set_stroke("#ffffff", width=0.0)',
        '.set_stroke("#AbCdEf", width=64.0).set_opacity(0.0)',
        '.set_stroke("#316b83", width=2.0).set_opacity(1.0)',
    ],
)
def test_accepts_exact_literal_graph_geometry_dialect(decorators: str) -> None:
    validate(source_with(
        "        pc_graph = VGroup("
        "VMobject().set_points_as_corners([[-1.0, 0.5, 0.0], [0.0, 0.0, 0.0]]), "
        "VMobject().set_points_as_corners([[0.1, -0.2, 0.0], [1.0, 0.5, 0.0]])"
        f"){decorators}\n"
        "        pc_graph.shift([0.0, 0.0, 0])\n"
    ))


@pytest.mark.parametrize(
    "statement",
    [
        "        pc_graph = VMobject().set_points_as_corners([[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]])\n",
        "        pc_graph = VGroup(Rectangle(width=1.0, height=1.0), VMobject().set_points_as_corners([[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]]))\n",
        "        pc_points = [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]]\n        pc_graph = VGroup(VMobject().set_points_as_corners(pc_points))\n",
        "        pc_graph = VGroup(Rectangle(width=1.0, height=1.0).set_points_as_corners([[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]]))\n",
        "        pc_graph = VGroup(VMobject().set_points_as_corners([(0.0, 0.0, 0.0), (1.0, 1.0, 0.0)]))\n",
        "        pc_graph = VGroup(VMobject().set_points_as_corners([[0.0, 0.0, 0.0]]))\n",
        "        pc_graph = VGroup(VMobject().set_points_as_corners([[0.0, 0.0, 1.0], [1.0, 1.0, 0.0]]))\n",
        "        pc_graph = VGroup(VMobject().set_points_as_corners([[10000.1, 0.0, 0.0], [1.0, 1.0, 0.0]]))\n",
        "        pc_graph = VGroup(VMobject().set_points_as_corners(points=[[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]]))\n",
        "        pc_graph = VMobject()\n        pc_graph.shift([0.0, 0.0, 0])\n        pc_graph_method = pc_graph.set_points_as_corners\n",
    ],
)
def test_rejects_literal_graph_geometry_outside_exact_compiler_shape(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="Literal graph|exact compiler context"):
        validate(source_with(statement))


@pytest.mark.parametrize(
    "statement",
    [
        f"        pc_graph = VGroup({LITERAL_GRAPH_STROKE})\n",
        f"        pc_graph = VGroup({LITERAL_GRAPH_STROKE}, Rectangle(width=1.0, height=1.0))\n",
        f"        self.add({LITERAL_GRAPH_STROKE})\n",
        f"        pc_graph = {LITERAL_GRAPH_STROKE}.copy()\n",
        f'        pc_graph = {LITERAL_GRAPH_STROKE}.set_fill("#ffffff", opacity=1.0)\n',
        f'        pc_graph = {LITERAL_GRAPH_BASE}.set_opacity(0.5).set_stroke("#ffffff", width=2.0)\n',
        f"        pc_graph = {LITERAL_GRAPH_BASE}\n",
        f"        pc_graph = {LITERAL_GRAPH_STROKE}.set_opacity(0.5).set_opacity(0.4)\n",
        f'        pc_color = "#ffffff"\n        pc_graph = {LITERAL_GRAPH_BASE}.set_stroke(pc_color, width=2.0)\n',
        f'        pc_graph = {LITERAL_GRAPH_BASE}.set_stroke("#fff", width=2.0)\n',
        f'        pc_width = 2.0\n        pc_graph = {LITERAL_GRAPH_BASE}.set_stroke("#ffffff", width=pc_width)\n',
        f'        pc_graph = {LITERAL_GRAPH_BASE}.set_stroke("#ffffff", width=-0.1)\n',
        f'        pc_graph = {LITERAL_GRAPH_BASE}.set_stroke("#ffffff", width=64.1)\n',
        f'        pc_graph = {LITERAL_GRAPH_BASE}.set_stroke("#ffffff", 2.0)\n',
        f"        pc_opacity = 0.5\n        pc_graph = {LITERAL_GRAPH_STROKE}.set_opacity(pc_opacity)\n",
        f"        pc_graph = {LITERAL_GRAPH_STROKE}.set_opacity(-0.1)\n",
        f"        pc_graph = {LITERAL_GRAPH_STROKE}.set_opacity(1.1)\n",
        f"        pc_graph = {LITERAL_GRAPH_STROKE}.set_opacity(opacity=0.5)\n",
    ],
)
def test_rejects_literal_graph_geometry_outside_exact_assignment_chain(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="Literal graph"):
        validate(source_with(statement))


def test_enforces_literal_graph_point_and_geometry_budgets() -> None:
    oversized_points = ", ".join(f"[{index}.0, 0.0, 0.0]" for index in range(258))
    with pytest.raises(SourcePolicyError, match="point count"):
        validate(source_with(
            f'        pc_graph = VGroup(VMobject().set_points_as_corners([{oversized_points}])).set_stroke("#ffffff", width=2.0)\n'
        ))

    excessive_segments = ", ".join(LITERAL_GRAPH_SEGMENT for _ in range(129))
    with pytest.raises(SourcePolicyError, match="too many segments"):
        validate(source_with(f'        pc_graph = VGroup({excessive_segments}).set_stroke("#ffffff", width=2.0)\n'))

    geometries = "\n".join(
        f'        pc_graph_{index} = {LITERAL_GRAPH_BASE}.set_stroke("#ffffff", width=2.0)'
        for index in range(9)
    ) + "\n"
    with pytest.raises(SourcePolicyError, match="too many literal graph geometries"):
        validate(source_with(geometries))


def test_accepts_exact_scene_object_camera_and_copy_target_dialect() -> None:
    validate(source_with(
        '        self.next_section("Exact compiler dialect")\n'
        '        self.camera.background_color = "#ffffff"\n'
        '        self.camera.frame.become(Rectangle(width=config.frame_width / 0.05, height=config.frame_height / 0.05).move_to([68.0, -68.0, 0]).rotate(-3600.0 * DEGREES))\n'
        '        pc_box = VMobject().set_fill("#abcdef", opacity=1.0).set_stroke("#123456", width=64.0).set_opacity(1.0)\n'
        '        pc_box.stretch(-0.01, 0, about_point=ORIGIN).stretch(100.0, 1, about_point=ORIGIN)\n'
        '        pc_box.rotate(3600.0 * DEGREES, about_point=ORIGIN)\n'
        '        pc_box.shift([-68.0, 68.0, 0])\n'
        '        pc_ref = pc_box.copy()\n'
        '        pc_box.set_opacity(0.0)\n'
        '        pc_text = Text("fit", font_size=256.0).set_color("#ffffff")\n'
        '        pc_text.scale(min(0.02 / max(pc_text.width, 0.001), 60.68148148 / max(pc_text.height, 0.001)))\n'
        '        pc_text.shift([0.0, 0.0, 0])\n'
        '        pc_text_ref = pc_text.copy()\n'
        '        pc_group = VGroup(pc_box, pc_text)\n'
        '        self.add(pc_box, pc_text)\n'
        '        self.play(Transform(pc_group, VGroup(pc_ref.copy().shift([68.0, -68.0, 0]).rotate(-3600.0 * DEGREES, about_point=ORIGIN).stretch(-100.0, 0, about_point=ORIGIN).stretch(0.01, 1, about_point=ORIGIN).stretch(4096.0, 0, about_point=ORIGIN).stretch_to_fit_height(60.68148148).stretch(-1.0, 0, about_point=ORIGIN).rotate(3600.0 * DEGREES, about_point=ORIGIN).shift([68.0, -68.0, 0]).set_fill("#abcdef", opacity=1.0).set_stroke("#123456", width=64.0).set_opacity(1.0), pc_text_ref.copy().shift([1.0, -1.0, 0]).set_opacity(0.0)), run_time=1.0, rate_func=linear))\n'
        '        self.play(Transform(self.camera.frame, Rectangle(width=config.frame_width / 20.0, height=config.frame_height / 20.0).move_to([0.0, 0.0, 0]).rotate(3600.0 * DEGREES), run_time=1.0, rate_func=linear))\n'
        '        self.play(Transform(pc_box, pc_box.copy().set_opacity(0.0), run_time=0.0, rate_func=linear))\n'
        '        self.clear()\n'
    ))


def test_accepts_exact_current_arrow_become_target() -> None:
    validate(source_with(
        '        pc_arrow = Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)\n'
        '        pc_arrow.shift([0.0, 0.0, 0])\n'
        '        pc_arrow_ref = pc_arrow.copy()\n'
        '        self.add(pc_arrow)\n'
        '        self.play(Transform(pc_arrow, pc_arrow_ref.copy().become(Arrow([-1.5, 0.0, 0], [1.5, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#abcdef").set_stroke("#abcdef", width=3.0).stretch(-2.0, 0, about_point=ORIGIN).rotate(30.0 * DEGREES, about_point=ORIGIN).shift([1.0, -1.0, 0])).set_opacity(1.0), run_time=1.0, rate_func=linear))\n'
    ))


CURRENT_ROUNDED_RECTANGLE = (
    'RoundedRectangle(corner_radius=0.2, width=2.0, height=1.0)'
    '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
)
CURRENT_CIRCLE = (
    'Circle(radius=1.0).stretch_to_fit_width(2.0).stretch_to_fit_height(1.0)'
    '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
)
CURRENT_LINE = (
    'Line([-1.0, 0.0, 0], [1.0, 0.0, 0]).set_cap_style(CapStyleType.ROUND)'
    '.set_stroke("#222222", width=2.0)'
)
CURRENT_ARROW = (
    'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, '
    'max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip)'
    '.set_cap_style(CapStyleType.ROUND).set_color("#222222").set_stroke("#222222", width=2.0)'
)
CURRENT_BRACE = (
    'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2)'
    '.set_color("#222222").set_stroke("#222222", width=2.0), '
    'Text("label", font_size=22.0).set_color("#333333").shift(DOWN * 0.55))'
)


def current_shape_become_source(
    initializer: str,
    payload: str,
    *,
    opacity: float = 1.0,
) -> str:
    return source_with(
        f"        pc_shape = {initializer}\n"
        "        pc_shape.shift([0.0, 0.0, 0])\n"
        "        pc_shape_ref = pc_shape.copy()\n"
        "        self.add(pc_shape)\n"
        f"        self.play(Transform(pc_shape, pc_shape_ref.copy().become({payload}).set_opacity({opacity}), "
        "run_time=1.0, rate_func=linear))\n"
    )


CURRENT_SHAPE_PAINT_TARGETS = [
    pytest.param(
        CURRENT_ROUNDED_RECTANGLE,
        'RoundedRectangle(corner_radius=0.2, width=2.0, height=1.0)'
        '.set_fill("#abcdef", opacity=1.0).set_stroke("#654321", width=3.0)'
        '.shift([1.0, -1.0, 0])',
        id="rounded-rectangle",
    ),
    pytest.param(
        CURRENT_CIRCLE,
        'Circle(radius=1.0).stretch_to_fit_width(2.0).stretch_to_fit_height(1.0)'
        '.set_fill("#abcdef", opacity=1.0).set_stroke("#654321", width=3.0)'
        '.shift([1.0, -1.0, 0])',
        id="circle",
    ),
    pytest.param(
        CURRENT_LINE,
        'Line([-1.0, 0.0, 0], [1.0, 0.0, 0]).set_cap_style(CapStyleType.ROUND)'
        '.set_stroke("#654321", width=3.0).shift([1.0, -1.0, 0])',
        id="line",
    ),
    pytest.param(
        CURRENT_ARROW,
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, '
        'max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip)'
        '.set_cap_style(CapStyleType.ROUND).set_color("#654321").set_stroke("#654321", width=3.0)'
        '.shift([1.0, -1.0, 0])',
        id="arrow",
    ),
    pytest.param(
        CURRENT_BRACE,
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2)'
        '.set_color("#654321").set_stroke("#654321", width=3.0), '
        'Text("label", font_size=22.0).set_color("#abcdef").shift(DOWN * 0.55))'
        '.shift([1.0, -1.0, 0])',
        id="brace",
    ),
]


@pytest.mark.parametrize(("initializer", "payload"), CURRENT_SHAPE_PAINT_TARGETS)
def test_accepts_current_shape_become_targets_with_paint_only_changes(initializer: str, payload: str) -> None:
    validate(current_shape_become_source(initializer, payload))


@pytest.mark.parametrize(
    "initializer",
    [
        pytest.param(CURRENT_ROUNDED_RECTANGLE, id="rounded-rectangle"),
        pytest.param(CURRENT_CIRCLE, id="circle"),
        pytest.param(CURRENT_LINE, id="line"),
        pytest.param(CURRENT_ARROW, id="arrow"),
        pytest.param(CURRENT_BRACE, id="brace"),
    ],
)
def test_accepts_current_shape_become_targets_with_opacity_only_changes(initializer: str) -> None:
    payload = f"{initializer}.set_opacity(0.4).shift([1.0, -1.0, 0])"
    validate(current_shape_become_source(initializer, payload, opacity=0.4))


def test_rejects_current_shape_become_target_from_a_different_reference_owner() -> None:
    payload = f"{CURRENT_ARROW}.shift([1.0, -1.0, 0])"
    with pytest.raises(SourcePolicyError):
        validate(source_with(
            f"        pc_first = {CURRENT_ARROW}\n"
            "        pc_first.shift([-1.0, 0.0, 0])\n"
            "        pc_first_ref = pc_first.copy()\n"
            f"        pc_second = {CURRENT_ARROW}\n"
            "        pc_second.shift([1.0, 0.0, 0])\n"
            "        pc_second_ref = pc_second.copy()\n"
            "        self.add(pc_first, pc_second)\n"
            f"        self.play(Transform(pc_second, pc_first_ref.copy().become({payload}).set_opacity(1.0), "
            "run_time=1.0, rate_func=linear))\n"
        ))


@pytest.mark.parametrize(
    ("initializer", "payload"),
    [
        pytest.param(
            CURRENT_ROUNDED_RECTANGLE,
            f"{CURRENT_CIRCLE}.shift([1.0, -1.0, 0])",
            id="rectangle-to-circle",
        ),
        pytest.param(
            CURRENT_LINE,
            f"{CURRENT_ARROW}.shift([1.0, -1.0, 0])",
            id="line-to-arrow",
        ),
        pytest.param(
            CURRENT_ARROW,
            f"{CURRENT_BRACE}.shift([1.0, -1.0, 0])",
            id="arrow-to-brace",
        ),
    ],
)
def test_rejects_cross_kind_current_shape_become_targets(initializer: str, payload: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(current_shape_become_source(initializer, payload))


CURRENT_SHAPE_DESCRIPTOR_MUTATIONS = [
    pytest.param(
        CURRENT_ARROW,
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, '
        'tip_shape=StealthTip).set_cap_style(CapStyleType.SQUARE).set_color("#222222")'
        '.set_stroke("#222222", width=2.0).shift([1.0, -1.0, 0])',
        id="arrow-cap",
    ),
    pytest.param(
        CURRENT_ARROW,
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, '
        'tip_shape=ArrowCircleFilledTip).set_cap_style(CapStyleType.ROUND).set_color("#222222")'
        '.set_stroke("#222222", width=2.0).shift([1.0, -1.0, 0])',
        id="arrow-tip",
    ),
    pytest.param(
        CURRENT_ARROW,
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.3, '
        'tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#222222")'
        '.set_stroke("#222222", width=2.0).shift([1.0, -1.0, 0])',
        id="arrow-ratio",
    ),
    pytest.param(
        CURRENT_BRACE,
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=UP, buff=0.2)'
        '.set_color("#222222").set_stroke("#222222", width=2.0), '
        'Text("label", font_size=22.0).set_color("#333333").shift(UP * 0.55))'
        '.shift([1.0, -1.0, 0])',
        id="brace-direction",
    ),
    pytest.param(
        CURRENT_BRACE,
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.3)'
        '.set_color("#222222").set_stroke("#222222", width=2.0), '
        'Text("label", font_size=22.0).set_color("#333333").shift(DOWN * 0.65))'
        '.shift([1.0, -1.0, 0])',
        id="brace-spacing",
    ),
    pytest.param(
        CURRENT_BRACE,
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2)'
        '.set_color("#222222").set_stroke("#222222", width=2.0), '
        'Text("changed label", font_size=22.0).set_color("#333333").shift(DOWN * 0.55))'
        '.shift([1.0, -1.0, 0])',
        id="brace-label",
    ),
    pytest.param(
        CURRENT_ROUNDED_RECTANGLE,
        'Rectangle(width=2.0, height=1.0).set_fill("#111111", opacity=1.0)'
        '.set_stroke("#222222", width=2.0).shift([1.0, -1.0, 0])',
        id="rectangle-constructor",
    ),
    pytest.param(
        CURRENT_ROUNDED_RECTANGLE,
        'RoundedRectangle(corner_radius=0.3, width=2.0, height=1.0)'
        '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
        '.shift([1.0, -1.0, 0])',
        id="rectangle-corner",
    ),
]


@pytest.mark.parametrize(("initializer", "payload"), CURRENT_SHAPE_DESCRIPTOR_MUTATIONS)
def test_rejects_current_shape_become_descriptor_mutations(initializer: str, payload: str) -> None:
    with pytest.raises(SourcePolicyError, match="descriptor"):
        validate(current_shape_become_source(initializer, payload))


DERIVED_ROUNDED_RECTANGLE = (
    'RoundedRectangle(corner_radius=min(0.4, 2.0 / 2.0, 1.0 / 2.0), width=2.0, height=1.0)'
    '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
)


def test_accepts_dimension_clamped_rounded_rectangle_from_same_authored_radius() -> None:
    payload = (
        'RoundedRectangle(corner_radius=min(0.4, 0.4 / 2.0, 1.0 / 2.0), width=0.4, height=1.0)'
        '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
        '.shift([1.0, -1.0, 0])'
    )
    validate(current_shape_become_source(DERIVED_ROUNDED_RECTANGLE, payload))


@pytest.mark.parametrize(
    "corner",
    [
        pytest.param('min(0.3, 0.4 / 2.0, 1.0 / 2.0)', id="authored-radius"),
        pytest.param('min(0.4, 0.5 / 2.0, 1.0 / 2.0)', id="detached-width"),
        pytest.param('min(0.4, 0.4 / 3.0, 1.0 / 2.0)', id="noncompiler-divisor"),
        pytest.param('0.2', id="missing-authored-origin"),
    ],
)
def test_rejects_dimension_clamped_rounded_rectangle_corner_tampering(corner: str) -> None:
    payload = (
        f'RoundedRectangle(corner_radius={corner}, width=0.4, height=1.0)'
        '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
        '.shift([1.0, -1.0, 0])'
    )
    with pytest.raises(SourcePolicyError):
        validate(current_shape_become_source(DERIVED_ROUNDED_RECTANGLE, payload))


@pytest.mark.parametrize(
    "target",
    [
        pytest.param(
            f"pc_shape_ref.become({CURRENT_ROUNDED_RECTANGLE}.shift([1.0, -1.0, 0])).set_opacity(1.0)",
            id="missing-reference-copy",
        ),
        pytest.param(
            f"pc_shape_ref.copy().set_opacity(1.0).become({CURRENT_ROUNDED_RECTANGLE}.shift([1.0, -1.0, 0]))",
            id="outer-method-order",
        ),
        pytest.param(
            f"pc_shape_ref.copy().become({CURRENT_ROUNDED_RECTANGLE}.shift([1.0, -1.0, 0]))",
            id="missing-final-opacity",
        ),
        pytest.param(
            f"pc_shape_ref.copy().become({CURRENT_ROUNDED_RECTANGLE}.shift([1.0, -1.0, 0]), "
            "unexpected=True).set_opacity(1.0)",
            id="become-keyword",
        ),
        pytest.param(
            'pc_shape_ref.copy().become(RoundedRectangle(corner_radius=0.2, width=2.0, height=1.0)'
            '.set_stroke("#222222", width=2.0).set_fill("#111111", opacity=1.0)'
            '.shift([1.0, -1.0, 0])).set_opacity(1.0)',
            id="payload-paint-order",
        ),
        pytest.param(
            f"pc_shape_ref.copy().become({CURRENT_ROUNDED_RECTANGLE}.shift([1.0, -1.0, 0])"
            ".set_opacity(0.4)).set_opacity(0.4)",
            id="payload-placement-order",
        ),
        pytest.param(
            f"pc_shape_ref.copy().become({CURRENT_ROUNDED_RECTANGLE}.shift([1.0, -1.0, 0]))"
            '.set_stroke("#222222", width=2.0).set_opacity(1.0)',
            id="extra-outer-paint",
        ),
    ],
)
def test_rejects_malformed_current_shape_become_method_dialects(target: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(
            f"        pc_shape = {CURRENT_ROUNDED_RECTANGLE}\n"
            "        pc_shape.shift([0.0, 0.0, 0])\n"
            "        pc_shape_ref = pc_shape.copy()\n"
            "        self.add(pc_shape)\n"
            f"        self.play(Transform(pc_shape, {target}, run_time=1.0, rate_func=linear))\n"
        ))


@pytest.mark.parametrize(
    ("constructor", "target_chain"),
    [
        ('Rectangle(width=1.0, height=1.0)', '.set_color("#abcdef").set_opacity(1.0)'),
        (
            'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0)',
            '.set_color("#abcdef").set_stroke("#abcdef", width=3.0).set_opacity(1.0)',
        ),
        (
            'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
            '.set_color("#abcdef").set_opacity(1.0)',
        ),
        (
            'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
            '.set_stroke("#abcdef", width=3.0).set_opacity(1.0)',
        ),
        (
            'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
            '.set_color("#abcdef").set_stroke("#123456", width=3.0).set_opacity(1.0)',
        ),
        (
            'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
            '.set_color("#abcdef").set_stroke("#abcdef", width=3.0).set_fill("#abcdef", opacity=1.0).set_opacity(1.0)',
        ),
        (
            'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
            '.set_color("#abcdef").set_stroke("#abcdef", width=3.0).set_stroke("#abcdef", width=3.0).set_opacity(1.0)',
        ),
    ],
)
def test_rejects_copy_colour_outside_exact_current_arrow_pair(constructor: str, target_chain: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(
            f"        pc_object = {constructor}\n"
            "        pc_object.shift([0.0, 0.0, 0])\n"
            "        pc_ref = pc_object.copy()\n"
            "        self.add(pc_object)\n"
            f"        self.play(Transform(pc_object, pc_ref.copy(){target_chain}, run_time=1.0, rate_func=linear))\n"
        ))


@pytest.mark.parametrize(
    "statement",
    [
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_child = Circle(radius=1.0)\n        pc_box.add(pc_child)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_alias = pc_box\n        pc_child = Circle(radius=1.0)\n        pc_alias.add(pc_child)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.add(pc_box)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.clear()\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.become(Circle(radius=1.0))\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.camera.frame.become(pc_box)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.become(self.camera.frame)\n",
        "        pc_scene = self\n        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_scene.add(pc_box)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_ref = pc_box.copy()\n        pc_ref.set_opacity(0.0)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.copy().set_opacity(0.0)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_method = pc_box.add\n",
        "        self.add(pc_box)\n        pc_box = Rectangle(width=1.0, height=1.0)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_alias = pc_box\n        self.add(pc_alias)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.add(Rectangle(width=1.0, height=1.0))\n",
        "        self.clear(1.0)\n",
    ],
)
def test_rejects_noncompiler_sensitive_receivers_aliases_and_contexts(statement: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(statement))


@pytest.mark.parametrize(
    "statement",
    [
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.move_to([0.0, 0.0, 0])\n        pc_box.move_to([1.0, 0.0, 0])\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.move_to([0.0, 0.0, 0])\n        pc_box.set_opacity(0.0)\n        pc_box.rotate(1.0 * DEGREES)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.move_to([0.0, 0.0, 0])\n        pc_ref = pc_box.copy()\n        pc_box.move_to([1.0, 0.0, 0])\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.move_to([0.0, 0.0, 0])\n        pc_ref = pc_box.copy()\n        pc_ref_two = pc_box.copy()\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_ref = pc_box.copy()\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.add(pc_box)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.play(Create(pc_box, run_time=1.0, rate_func=linear))\n",
        "        pc_first = Rectangle(width=1.0, height=1.0)\n        pc_second = Rectangle(width=1.0, height=1.0)\n        pc_first.move_to([0.0, 0.0, 0])\n",
        "        pc_box.move_to([0.0, 0.0, 0])\n        pc_box = Rectangle(width=1.0, height=1.0)\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.move_to([0.0, 0.0, 0])\n        self.clear()\n        pc_box.move_to([1.0, 0.0, 0])\n",
    ],
)
def test_rejects_duplicate_reordered_forward_and_stale_initialization(statement: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(statement))


def test_rejects_copy_targets_nested_or_mixed_outside_the_animated_family() -> None:
    sources = [
        source_with(
            "        pc_box = Rectangle(width=1.0, height=1.0)\n"
            "        pc_box.shift([0.0, 0.0, 0])\n"
            "        pc_ref = pc_box.copy()\n"
            "        pc_target = VGroup(pc_ref.copy().set_opacity(1.0))\n"
        ),
        source_with(
            "        pc_box = Rectangle(width=1.0, height=1.0)\n"
            "        pc_box.shift([0.0, 0.0, 0])\n"
            "        pc_ref = pc_box.copy()\n"
            "        self.play(Transform(pc_box, VGroup(pc_ref.copy().set_opacity(1.0), Rectangle(width=1.0, height=1.0)), run_time=1.0, rate_func=linear))\n"
        ),
        source_with(
            "        pc_box = Rectangle(width=1.0, height=1.0)\n"
            "        pc_box.shift([0.0, 0.0, 0])\n"
            "        pc_box_ref = pc_box.copy()\n"
            "        pc_other = Rectangle(width=1.0, height=1.0)\n"
            "        pc_other.shift([1.0, 0.0, 0])\n"
            "        pc_other_ref = pc_other.copy()\n"
            "        self.play(Transform(pc_box, pc_other_ref.copy().set_opacity(1.0), run_time=1.0, rate_func=linear))\n"
        ),
    ]
    for source in sources:
        with pytest.raises(SourcePolicyError):
            validate(source)


NESTED_GROUP_PROVENANCE_PREFIX = (
    "        pc_rectangle = Rectangle(width=1.0, height=1.0)\n"
    "        pc_rectangle.shift([-1.0, 0.0, 0])\n"
    "        pc_rectangle_ref = pc_rectangle.copy()\n"
    "        pc_label = Text(\"label\", font_size=24.0)\n"
    "        pc_label.shift([1.0, 0.0, 0])\n"
    "        pc_label_ref = pc_label.copy()\n"
    "        pc_inner = VGroup(pc_rectangle)\n"
    "        pc_root = Group(pc_inner, pc_label)\n"
)


def test_accepts_exact_recursive_group_transform_hierarchy() -> None:
    validate(source_with(
        NESTED_GROUP_PROVENANCE_PREFIX
        + "        self.play(Transform(pc_root, Group(VGroup(pc_rectangle_ref.copy().set_opacity(1.0)), pc_label_ref.copy().set_opacity(1.0)), run_time=1.0, rate_func=linear))\n"
    ))


@pytest.mark.parametrize(
    "target",
    [
        "Group(VGroup(pc_rectangle_ref.copy().set_opacity(1.0)))",
        "Group(VGroup(pc_rectangle_ref.copy().set_opacity(1.0)), pc_rectangle_ref.copy().set_opacity(1.0))",
        "Group(pc_label_ref.copy().set_opacity(1.0), VGroup(pc_rectangle_ref.copy().set_opacity(1.0)))",
        "Group(pc_rectangle_ref.copy().set_opacity(1.0), pc_label_ref.copy().set_opacity(1.0))",
        "VGroup(VGroup(pc_rectangle_ref.copy().set_opacity(1.0)), pc_label_ref.copy().set_opacity(1.0))",
        "Group(Group(pc_rectangle_ref.copy().set_opacity(1.0)), pc_label_ref.copy().set_opacity(1.0))",
    ],
)
def test_rejects_group_transform_hierarchy_cardinality_order_and_constructor_mutations(target: str) -> None:
    with pytest.raises(SourcePolicyError, match="exact compiler hierarchy|exact compiler provenance"):
        validate(source_with(
            NESTED_GROUP_PROVENANCE_PREFIX
            + f"        self.play(Transform(pc_root, {target}, run_time=1.0, rate_func=linear))\n"
        ))


def test_accepts_distinct_compiler_bindings_across_two_shots() -> None:
    validate(source_with(
        "        self.next_section(\"First\")\n"
        "        pc_first = Rectangle(width=1.0, height=1.0)\n"
        "        pc_first.shift([0.0, 0.0, 0])\n"
        "        pc_first_ref = pc_first.copy()\n"
        "        self.add(pc_first)\n"
        "        self.clear()\n"
        "        self.next_section(\"Second\")\n"
        "        pc_second = Rectangle(width=1.0, height=1.0)\n"
        "        pc_second.shift([0.0, 0.0, 0])\n"
        "        pc_second_ref = pc_second.copy()\n"
        "        self.add(pc_second)\n"
    ))


@pytest.mark.parametrize(
    "boundary",
    [
        "        self.clear()\n",
        "        self.next_section(\"Second\")\n",
        "        self.clear()\n        self.next_section(\"Second\")\n",
    ],
)
@pytest.mark.parametrize(
    "second_shot",
    [
        "        self.add(pc_first)\n",
        (
            "        pc_second = Rectangle(width=1.0, height=1.0)\n"
            "        pc_second.shift([0.0, 0.0, 0])\n"
            "        self.play(Transform(pc_second, pc_first_ref.copy().set_opacity(1.0), run_time=1.0, rate_func=linear))\n"
        ),
        "        self.play(FadeIn(pc_first_group, run_time=1.0, rate_func=linear))\n",
        (
            "        pc_first = Rectangle(width=1.0, height=1.0)\n"
            "        pc_first.shift([0.0, 0.0, 0])\n"
        ),
    ],
)
def test_rejects_stale_or_redeclared_bindings_after_a_shot_boundary(boundary: str, second_shot: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(
            "        self.next_section(\"First\")\n"
            "        pc_first = Rectangle(width=1.0, height=1.0)\n"
            "        pc_first.shift([0.0, 0.0, 0])\n"
            "        pc_first_ref = pc_first.copy()\n"
            "        pc_first_group = VGroup(pc_first)\n"
            + boundary
            + second_shot
        ))


@pytest.mark.parametrize(
    "statement",
    [
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.add(*[pc_box])\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_group = VGroup(*[pc_box])\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_child = Circle(radius=1.0)\n        pc_box.add(*[pc_child])\n",
        "        self.clear(*[])\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.add(**{\"mobject\": pc_box})\n",
    ],
)
def test_rejects_all_positional_and_keyword_expansion(statement: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(statement))


def test_forbids_ast_starred_even_on_an_otherwise_allowed_constructor() -> None:
    with pytest.raises(SourcePolicyError, match="Starred"):
        validate(source_with("        pc_group = Group(*[])\n"))


@pytest.mark.parametrize(
    "mutation",
    [
        "pc_box.move_to([68.1, 0.0, 0])",
        "pc_box.move_to([0.0, 0.0, 1.0])",
        "pc_box.move_to(pc_point)",
        "pc_box.rotate(3600.1 * DEGREES)",
        "pc_box.rotate(1.0)",
        "pc_box.stretch(1.0, 1).stretch(1.0, 0)",
        "pc_box.stretch(0.0, 0).stretch(1.0, 1)",
        "pc_box.stretch(100.1, 0).stretch(1.0, 1)",
        "pc_box.stretch(1.0, 0)",
        "pc_box.scale_to_fit_width(0.0111111)",
        "pc_box.scale_to_fit_height(60.68148149)",
        "pc_box.scale(2.0)",
        "pc_box.scale(min(1.0 / max(pc_box.width, 0.01), 1.0 / max(pc_box.height, 0.001)))",
        "pc_box.set_opacity(0.5)",
        'pc_box.set_color("#ffffff")',
        'pc_box.set_fill("#ffffff", opacity=1.0)',
        'pc_box.set_stroke("#ffffff", width=1.0)',
    ],
)
def test_rejects_direct_object_mutations_outside_compiler_shape_and_bounds(mutation: str) -> None:
    prefix = "        pc_point = [0.0, 0.0, 0.0]\n" if "pc_point" in mutation else ""
    source = source_with(prefix + "        pc_box = Rectangle(width=1.0, height=1.0)\n" + f"        {mutation}\n")
    with pytest.raises(SourcePolicyError):
        validate(source)


@pytest.mark.parametrize(
    "target",
    [
        "pc_ref.copy()",
        "pc_ref.copy(copy=True).set_opacity(1.0)",
        "pc_ref.copy().set_opacity(1.0).move_to([0.0, 0.0, 0])",
        "pc_ref.copy().stretch(0.0, 0).set_opacity(1.0)",
        "pc_ref.copy().stretch(40960000.1, 0).set_opacity(1.0)",
        "pc_ref.copy().stretch(1.0, 2).set_opacity(1.0)",
        "pc_ref.copy().stretch_to_fit_width(0.0).set_opacity(1.0)",
        "pc_ref.copy().stretch_to_fit_width(6068.14814816).set_opacity(1.0)",
        "pc_ref.copy().rotate(7200.1 * DEGREES).set_opacity(1.0)",
        "pc_ref.copy().move_to([0.0, 0.0, 1.0]).set_opacity(1.0)",
        'pc_ref.copy().set_stroke("#ffffff", width=64.1).set_opacity(1.0)',
        'pc_ref.copy().set_opacity(1.0).set_fill("#ffffff", opacity=1.0)',
        "pc_box.copy().set_opacity(1.0)",
    ],
)
def test_rejects_copy_targets_outside_reference_provenance_order_and_bounds(target: str) -> None:
    source = source_with(
        "        pc_box = Rectangle(width=1.0, height=1.0)\n"
        "        pc_box.shift([0.0, 0.0, 0])\n"
        "        pc_ref = pc_box.copy()\n"
        f"        self.play(Transform(pc_box, {target}, run_time=1.0, rate_func=linear))\n"
    )
    with pytest.raises(SourcePolicyError):
        validate(source)


@pytest.mark.parametrize(
    "statement",
    [
        '        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 2.0).move_to([0.0, 0.0, 0]).rotate(0.0 * DEGREES))\n',
        '        self.camera.frame.become(Rectangle(width=config.frame_width / 0.049, height=config.frame_height / 0.049).move_to([0.0, 0.0, 0]).rotate(0.0 * DEGREES))\n',
        '        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([68.1, 0.0, 0]).rotate(0.0 * DEGREES))\n',
        '        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([0.0, 0.0, 0]).rotate(3600.1 * DEGREES))\n',
        '        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([0.0, 0.0, 0]))\n',
    ],
)
def test_rejects_camera_become_outside_exact_target_shape_and_bounds(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="Camera"):
        validate(source_with(statement))


@pytest.mark.parametrize(
    "decorators",
    [
        '.set_color("#ffffff").set_color("#ffffff")',
        '.set_stroke("#ffffff", width=1.0).set_fill("#ffffff", opacity=1.0)',
        '.set_fill("#ffffff", opacity=0.5)',
        '.set_stroke("#fff", width=1.0)',
        '.set_stroke("#ffffff", width=64.1)',
        '.set_opacity(1.1)',
        '.move_to([0.0, 0.0, 0])',
    ],
)
def test_rejects_constructor_decorators_outside_exact_style_chain(decorators: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(f"        pc_box = Rectangle(width=1.0, height=1.0){decorators}\n"))


@pytest.mark.parametrize(
    "expression",
    [
        'Text("bounded", font_size=1.0)',
        'Rectangle(width=0.01111111, height=60.68148148)',
        'Circle(radius=1.0).stretch_to_fit_width(0.01111111).stretch_to_fit_height(60.68148148)',
        'Line([-0.00555556, 0.0, 0], [0.00555556, 0.0, 0])',
        'Arrow([-30.34074074, 0.0, 0], [30.34074074, 0.0, 0], buff=0)',
        'Axes(x_range=[-10000.0, 10000.0, 1], y_range=[-1.0, 1.0, 1], x_length=0.01111111, y_length=60.68148148, tips=False)',
        'VMobject()',
        'VGroup(BraceBetweenPoints([-0.5, 0.0, 0], [0.5, 0.0, 0], direction=DOWN), Text("width", font_size=256.0).shift(DOWN * 0.45))',
    ],
)
def test_accepts_exact_object_constructor_argument_boundaries(expression: str) -> None:
    validate(source_with(
        f"        pc_object = {expression}\n"
        "        pc_object.shift([0.0, 0.0, 0])\n"
    ))


@pytest.mark.parametrize(
    "expression",
    [
        'Text("oversized", font_size=256.1)',
        'Text("oversized", color="#ffffff", font_size=24.0)',
        'Rectangle(height=1.0, width=1.0)',
        'Rectangle(width=0.0111111, height=1.0)',
        'Rectangle(width=1.0, height=60.68148149)',
        'Circle(radius=0.2)',
        'Circle(radius=1.0).stretch_to_fit_height(1.0).stretch_to_fit_width(1.0)',
        'Circle(radius=1.0).stretch_to_fit_width(1.0).stretch_to_fit_height(60.68148149)',
        'Line([-0.5, 0.0, 0], [0.6, 0.0, 0])',
        'Line([-30.34074075, 0.0, 0], [30.34074075, 0.0, 0])',
        'Arrow([-0.5, 0.0, 0], [0.5, 0.0, 0], buff=0.1)',
        'Axes(x_range=[1.0, 1.0, 1], y_range=[-1.0, 1.0, 1], x_length=1.0, y_length=1.0, tips=False)',
        'Axes(x_range=[-1.0, 1.0, 0.5], y_range=[-1.0, 1.0, 1], x_length=1.0, y_length=1.0, tips=False)',
        'Axes(x_range=[-1.0, 1.0, 1], y_range=[-1.0, 1.0, 1], x_length=1.0, y_length=1.0, tips=True)',
        'VMobject(1.0)',
        'VGroup(BraceBetweenPoints([-0.5, 0.0, 0], [0.5, 0.0, 0], direction=UP), Text("width", font_size=22.0).shift(DOWN * 0.45))',
        'VGroup(BraceBetweenPoints([-0.5, 0.0, 0], [0.5, 0.0, 0], direction=DOWN), Text("width", font_size=22.0).shift(DOWN * 0.46))',
    ],
)
def test_rejects_object_constructor_arguments_outside_exact_shape_and_bounds(expression: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(f"        pc_object = {expression}\n"))


@pytest.mark.parametrize(
    "expression",
    [
        'RoundedRectangle(corner_radius=0.0, width=0.01111111, height=0.01111111)',
        'RoundedRectangle(corner_radius=7.58518518, width=60.68148148, height=15.17037036)',
        'Line([-0.00555556, 0.0, 0], [0.00555556, 0.0, 0]).set_cap_style(CapStyleType.BUTT).set_stroke("#123456", width=0.0)',
        'Line([-1.0, 0.0, 0], [1.0, 0.0, 0]).set_cap_style(CapStyleType.ROUND).set_stroke("#123456", width=2.0)',
        'Line([-30.34074074, 0.0, 0], [30.34074074, 0.0, 0]).set_cap_style(CapStyleType.SQUARE).set_stroke("#123456", width=64.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.02, tip_shape=ArrowTriangleFilledTip).set_cap_style(CapStyleType.BUTT).set_color("#123456").set_stroke("#123456", width=0.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.3, tip_shape=ArrowCircleFilledTip).set_cap_style(CapStyleType.SQUARE).set_color("#123456").set_stroke("#123456", width=3.0).set_opacity(0.5)',
        'Arrow([-30.34074074, 0.0, 0], [30.34074074, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.45, tip_shape=ArrowSquareFilledTip).set_cap_style(CapStyleType.BUTT).set_color("#abcdef").set_stroke("#abcdef", width=64.0)',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=UP, buff=0.0).set_color("#654321").set_stroke("#654321", width=0.0), Text("up", font_size=1.0).set_color("#abcdef").shift(UP * 0.0))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=60.68148148).set_color("#654321").set_stroke("#654321", width=64.0), Text("down", font_size=256.0).set_color("#abcdef").shift(DOWN * 121.36296296)).set_opacity(0.0)',
        'VGroup(BraceBetweenPoints([0.0, -1.0, 0], [0.0, 1.0, 0], direction=LEFT, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("left", font_size=22.0).set_color("#abcdef").shift(LEFT * 0.55)).set_opacity(0.8)',
        'VGroup(BraceBetweenPoints([0.0, -1.0, 0], [0.0, 1.0, 0], direction=RIGHT, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("right", font_size=22.0).set_color("#abcdef").shift(RIGHT * 0.55))',
    ],
)
def test_accepts_exact_current_shape_compiler_dialect(expression: str) -> None:
    validate(source_with(
        f"        pc_object = {expression}\n"
        "        pc_object.shift([0.0, 0.0, 0])\n"
    ))


@pytest.mark.parametrize(
    "expression",
    [
        'RoundedRectangle(width=1.0, height=1.0, corner_radius=0.2)',
        'RoundedRectangle(0.2, width=1.0, height=1.0)',
        'RoundedRectangle(corner_radius=-0.01, width=1.0, height=1.0)',
        'RoundedRectangle(corner_radius=0.51, width=1.0, height=1.0)',
        'RoundedRectangle(corner_radius=0.50000002, width=1.0, height=1.0)',
        'RoundedRectangle(corner_radius=7.58518519, width=60.68148148, height=60.68148148)',
        'Line([-0.00555555, 0.0, 0], [0.00555555, 0.0, 0]).set_cap_style(CapStyleType.BUTT)',
        'Line([-1.0, 0.0, 0], [1.0, 0.0, 0]).set_cap_style(CapStyleType.AUTO)',
        'Line([-1.0, 0.0, 0], [1.0, 0.0, 0]).set_cap_style(ROUND)',
        'Line([-1.0, 0.0, 0], [1.0, 0.0, 0]).set_cap_style("ROUND")',
        'Line([-1.0, 0.0, 0], [1.0, 0.0, 0]).set_cap_style(CapStyleType.ROUND())',
        'Line([-1.0, 0.0, 0], [1.0, 0.0, 0]).set_stroke("#123456", width=2.0).set_cap_style(CapStyleType.ROUND)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], max_tip_length_to_length_ratio=0.25, buff=0, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0.1, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.0199, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.4501, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=ArrowTriangleTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip()).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape="StealthTip").set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#abcdef", width=2.0)',
        'Arrow([0.0, -1.0, 0], [0.0, 1.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.1, 0.0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=StealthTip).set_cap_style(CapStyleType.ROUND).set_color("#123456").set_stroke("#123456", width=2.0)',
        'Arrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0).set_cap_style(CapStyleType.ROUND)',
        'VGroup(BraceBetweenPoints([0.0, -1.0, 0], [0.0, 1.0, 0], direction=UP, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("wrong axis", font_size=22.0).set_color("#abcdef").shift(UP * 0.55))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=LEFT, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("wrong axis", font_size=22.0).set_color("#abcdef").shift(LEFT * 0.55))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=-0.01).set_color("#654321").set_stroke("#654321", width=2.0), Text("spacing", font_size=22.0).set_color("#abcdef").shift(DOWN * 0.55))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=60.68148149).set_color("#654321").set_stroke("#654321", width=2.0), Text("spacing", font_size=22.0).set_color("#abcdef").shift(DOWN * 0.55))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=ORIGIN, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("direction", font_size=22.0).set_color("#abcdef").shift(ORIGIN * 0.55))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("direction", font_size=22.0).set_color("#abcdef").shift(UP * 0.55))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("shift", font_size=22.0).set_color("#abcdef").shift(DOWN * -0.01))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("shift", font_size=22.0).set_color("#abcdef").shift(DOWN * 121.36296297))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2).set_stroke("#654321", width=2.0), Text("paint", font_size=22.0).set_color("#abcdef").shift(DOWN * 0.55))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2).set_color("#654321").set_stroke("#123456", width=2.0), Text("paint", font_size=22.0).set_color("#abcdef").shift(DOWN * 0.55))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("label", font_size=22.0).shift(DOWN * 0.55))',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("outer", font_size=22.0).set_color("#abcdef").shift(DOWN * 0.55)).set_stroke("#654321", width=2.0)',
        'VGroup(BraceBetweenPoints([-1.0, 0.0, 0], [1.0, 0.0, 0], direction=DOWN, buff=0.2).set_color("#654321").set_stroke("#654321", width=2.0), Text("extra", font_size=22.0).set_color("#abcdef").shift(DOWN * 0.55), Circle(radius=1.0))',
    ],
)
def test_rejects_current_shape_syntax_outside_exact_dialect_and_bounds(expression: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(f"        pc_object = {expression}\n"))


@pytest.mark.parametrize(
    "statement",
    [
        "        pc_tip = StealthTip()\n",
        "        pc_value = CapStyleType.ROUND\n",
        "        pc_line = Line([-1.0, 0.0, 0], [1.0, 0.0, 0])\n        pc_line.set_cap_style(CapStyleType.ROUND)\n",
    ],
)
def test_rejects_shape_classes_and_cap_mutation_outside_exact_initialization(statement: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(statement))


@pytest.mark.parametrize(
    "statement",
    [
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.shift([0.0, 0.0, 0])\n        pc_value = pc_box.width()\n",
        "        pc_value = self.camera.frame.width()\n",
        "        pc_value = rate_functions.there_and_back()\n",
    ],
)
def test_rejects_every_unapproved_attribute_call(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="attribute outside an exact compiler context"):
        validate(source_with(statement))


@pytest.mark.parametrize(
    "statement",
    [
        "        pc_value = Rectangle(width=1.0, height=1.0).width\n",
        "        pc_value = Text(\"inline\", font_size=24.0).height\n",
        "        pc_value = max(1.0, 2.0)\n",
        "        pc_value = min(1.0, 2.0)\n",
    ],
)
def test_rejects_object_and_utility_constructors_outside_exact_context(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="outside an exact compiler"):
        validate(source_with(statement))


@pytest.mark.parametrize(
    "statement",
    [
        "        pc_value = 1.0 / 0.0\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box = 1.0\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        pc_box.shift([0.0, 0.0, 0])\n        pc_ref = pc_box.copy()\n        pc_ref = 1.0\n",
    ],
)
def test_rejects_noncompiler_and_reassigned_bindings(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="noncompiler binding|cannot be reassigned"):
        validate(source_with(statement))


def test_enforces_compiler_shot_and_object_budgets() -> None:
    objects = "".join(f"        pc_object_{index} = VMobject()\n" for index in range(257))
    with pytest.raises(SourcePolicyError, match="too many compiler objects"):
        validate(source_with(objects))

    shots = "".join(f'        self.next_section("Shot {index}")\n' for index in range(65))
    with pytest.raises(SourcePolicyError, match="too many compiler shots"):
        validate(source_with(shots))


@pytest.mark.parametrize(
    "rate_func",
    [
        "linear",
        "rush_into",
        "rush_from",
        "smooth",
        "rate_functions.there_and_back",
        "rate_functions.ease_out_quart",
        "rate_functions.ease_out_back",
    ],
)
def test_accepts_exact_native_animation_rate_functions(rate_func: str) -> None:
    validate(source_with(
        "        pc_box = Rectangle(width=1.0, height=1.0)\n"
        "        pc_box.shift([0.0, 0.0, 0])\n"
        f"        self.play(FadeIn(pc_box, run_time=300.0, rate_func={rate_func}))\n"
    ))


def test_accepts_exact_animation_container_and_indicate_boundaries() -> None:
    validate(source_with(
        "        pc_box = Rectangle(width=1.0, height=1.0)\n"
        "        pc_box.shift([0.0, 0.0, 0])\n"
        "        self.play(AnimationGroup("
        "Succession(Wait(300.0), group=Group(), run_time=300.0), "
        "Indicate(pc_box, color=\"#ffffff\", scale_factor=0.01, run_time=0.0, rate_func=rate_functions.there_and_back), "
        "group=Group(), lag_ratio=0, run_time=300.0))\n"
    ))


@pytest.mark.parametrize(
    "animation",
    [
        "Wait(1.0)",
        "FadeOut(pc_box, run_time=1.0, rate_func=linear)",
        "FadeIn(pc_box, run_time=300.1, rate_func=linear)",
        "FadeIn(pc_box, run_time=1.0, rate_func=rate_functions.width)",
        "FadeIn(pc_box, rate_func=linear, run_time=1.0)",
        "Indicate(pc_box, color=\"#fff\", scale_factor=1.0, run_time=1.0, rate_func=linear)",
        "Indicate(pc_box, color=\"#ffffff\", scale_factor=100.1, run_time=1.0, rate_func=linear)",
        "Transform(pc_box, pc_ref.copy().set_opacity(1.0), run_time=300.1, rate_func=linear)",
        "Transform(pc_box, pc_ref.copy().set_opacity(1.0), run_time=1.0, rate_func=rate_functions.width)",
        "Succession(Wait(1.0), group=VGroup(), run_time=1.0)",
        "Succession(Wait(1.0), group=Group(), run_time=300.1)",
        "AnimationGroup(FadeIn(pc_box, run_time=1.0, rate_func=linear), lag_ratio=0.1, run_time=1.0)",
        "AnimationGroup(FadeIn(pc_box, run_time=1.0, rate_func=linear), group=Group(), lag_ratio=0)",
    ],
)
def test_rejects_animation_expressions_outside_exact_shape_and_bounds(animation: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(
            "        pc_box = Rectangle(width=1.0, height=1.0)\n"
            "        pc_box.shift([0.0, 0.0, 0])\n"
            "        pc_ref = pc_box.copy()\n"
            f"        self.play({animation})\n"
        ))


def test_rejects_animation_constructor_outside_self_play() -> None:
    with pytest.raises(SourcePolicyError, match="outside an exact self.play"):
        validate(source_with("        pc_animation = Wait(1.0)\n"))


def test_enforces_the_independent_custom_easing_lambda_budget() -> None:
    def source_for(count: int) -> str:
        transforms = ",\n".join(
            "            Transform(pc_box, pc_ref.copy().set_opacity(1.0), run_time=1.0, "
            "rate_func=lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.0, 0.8, 1.0))"
            for _ in range(count)
        )
        return source_with_cubic_helper(
            "        pc_box = Rectangle(width=1.0, height=1.0)\n"
            "        pc_box.shift([0.0, 0.0, 0])\n"
            "        pc_ref = pc_box.copy()\n"
                "        self.play(AnimationGroup(\n"
                f"{transforms},\n"
                "            group=Group(), lag_ratio=0, run_time=1.0))\n"
            )

    validate(source_for(MAX_RATE_LAMBDAS))
    with pytest.raises(SourcePolicyError, match="too many custom easing lambdas"):
        validate(source_for(MAX_RATE_LAMBDAS + 1))


V4_ELLIPSE = (
    'Ellipse(width=2.0, height=1.0).set_fill("#111111", opacity=1.0)'
    '.set_stroke("#222222", width=2.0)'
)
V4_POLYGON = (
    'Polygon([-0.5, 0.5, 0], [0.5, 0.5, 0], [0.0, -0.5, 0], joint_type=LineJointType.ROUND)'
    '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
    '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
)
V4_DASHED_LINE = (
    'DashedLine([-1.0, 0.0, 0], [1.0, 0.0, 0], dash_length=0.2, dashed_ratio=0.6, '
    'cap_style=CapStyleType.ROUND).set_stroke("#222222", width=2.0)'
)
V4_DOUBLE_ARROW = (
    'DoubleArrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, '
    'max_tip_length_to_length_ratio=0.25, tip_shape_start=StealthTip, '
    'tip_shape_end=ArrowCircleFilledTip).set_cap_style(CapStyleType.ROUND)'
    '.set_color("#222222").set_stroke("#222222", width=2.0)'
)
V4_FREEFORM_OPEN = (
    'VMobject(joint_type=LineJointType.ROUND, cap_style=CapStyleType.ROUND)'
    '.start_new_path([-0.5, 0.25, 0])'
    '.add_cubic_bezier_curve_to([-0.25, 0.25, 0], [-0.1, -0.25, 0], [0.0, -0.25, 0])'
    '.add_cubic_bezier_curve_to([0.1, -0.25, 0], [0.25, 0.25, 0], [0.5, 0.25, 0])'
    '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
    '.set_fill("#222222", opacity=0.0).set_stroke("#222222", width=2.0, opacity=0.8)'
)
V4_FREEFORM_CLOSED = (
    'VMobject(joint_type=LineJointType.BEVEL)'
    '.start_new_path([-0.5, 0.25, 0])'
    '.add_cubic_bezier_curve_to([-0.4, 0.1, 0], [-0.1, -0.25, 0], [0.0, -0.25, 0])'
    '.add_cubic_bezier_curve_to([0.1, -0.25, 0], [0.4, 0.1, 0], [0.5, 0.25, 0])'
    '.add_cubic_bezier_curve_to([0.25, 0.4, 0], [-0.25, 0.4, 0], [-0.5, 0.25, 0])'
    '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
    '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
)


def v4_polygon_expression(vertices: list[tuple[float, float]]) -> str:
    points = ", ".join(f"[{x}, {y}, 0]" for x, y in vertices)
    return (
        f"Polygon({points}, joint_type=LineJointType.ROUND)"
        '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
        '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
    )


@pytest.mark.parametrize(
    "expression",
    [
        pytest.param(V4_ELLIPSE, id="ellipse"),
        pytest.param(V4_ELLIPSE + ".set_opacity(0.5)", id="ellipse-opacity"),
        pytest.param(V4_POLYGON, id="polygon"),
        pytest.param(V4_DASHED_LINE, id="dashed-line"),
        pytest.param(V4_DASHED_LINE + ".set_opacity(0.5)", id="dashed-line-opacity"),
        pytest.param(V4_DOUBLE_ARROW, id="double-arrow"),
        pytest.param(V4_FREEFORM_OPEN, id="freeform-open"),
        pytest.param(V4_FREEFORM_CLOSED, id="freeform-closed"),
        pytest.param(V4_FREEFORM_CLOSED + ".set_opacity(0.5)", id="freeform-closed-opacity"),
    ],
)
def test_accepts_exact_schema_v4_native_shape_dialect(expression: str) -> None:
    validate(source_with(
        f"        pc_shape = {expression}\n"
        "        pc_shape.shift([0.0, 0.0, 0])\n"
    ))


@pytest.mark.parametrize(
    "vertices",
    [
        pytest.param(
            [(-0.5, -0.5), (0.5, 0.5), (-0.5, 0.5), (0.5, -0.5)],
            id="bow-tie",
        ),
        pytest.param(
            [(-0.5, -0.5), (0.5, -0.5), (0.0, 0.0), (0.5, 0.5), (-0.5, 0.5), (0.0, 0.0)],
            id="non-adjacent-shared-vertex",
        ),
        pytest.param(
            [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5), (-0.25, -0.5), (0.25, -0.5)],
            id="non-adjacent-collinear-overlap",
        ),
    ],
)
def test_rejects_schema_v4_polygon_non_adjacent_edge_intersections(
    vertices: list[tuple[float, float]],
) -> None:
    with pytest.raises(SourcePolicyError, match="edges must not intersect outside adjacent vertices"):
        validate(source_with(f"        pc_shape = {v4_polygon_expression(vertices)}\n"))


@pytest.mark.parametrize(
    "vertices",
    [
        pytest.param(
            [(-0.5, -0.5), (0.0, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)],
            id="adjacent-collinear-edges",
        ),
        pytest.param(
            [(-0.5, -0.5), (0.5, -0.5), (0.1, 0.0), (0.5, 0.5), (-0.5, 0.5)],
            id="simple-concave-with-closing-adjacency",
        ),
    ],
)
def test_accepts_schema_v4_simple_polygons_with_only_adjacent_contacts(
    vertices: list[tuple[float, float]],
) -> None:
    validate(source_with(
        f"        pc_shape = {v4_polygon_expression(vertices)}\n"
        "        pc_shape.shift([0.0, 0.0, 0])\n"
    ))


def v4_shape_become_source(initializer: str, payload: str, *, freeform: bool = False) -> str:
    final_paint = ".set_stroke(opacity=0.4)" if freeform else ".set_opacity(0.4)"
    return source_with(
        f"        pc_shape = {initializer}\n"
        "        pc_shape.shift([0.0, 0.0, 0])\n"
        "        pc_shape_ref = pc_shape.copy()\n"
        "        self.add(pc_shape)\n"
        f"        self.play(Transform(pc_shape, pc_shape_ref.copy().become({payload}){final_paint}, "
        "run_time=1.0, rate_func=linear))\n"
    )


@pytest.mark.parametrize(
    ("initializer", "payload", "freeform"),
    [
        pytest.param(
            V4_ELLIPSE,
            'Ellipse(width=3.0, height=2.0).set_fill("#abcdef", opacity=1.0)'
            '.set_stroke("#654321", width=3.0).shift([1.0, -1.0, 0])',
            False,
            id="ellipse-dimensions-and-paint",
        ),
        pytest.param(
            V4_POLYGON,
            'Polygon([-0.5, 0.5, 0], [0.5, 0.5, 0], [0.0, -0.5, 0], joint_type=LineJointType.ROUND)'
            '.stretch(3.0, 0, about_point=ORIGIN).stretch(2.0, 1, about_point=ORIGIN)'
            '.set_fill("#abcdef", opacity=1.0).set_stroke("#654321", width=3.0)'
            '.shift([1.0, -1.0, 0])',
            False,
            id="polygon-dimensions-and-paint",
        ),
        pytest.param(
            V4_DASHED_LINE,
            'DashedLine([-1.5, 0.0, 0], [1.5, 0.0, 0], dash_length=0.2, dashed_ratio=0.6, '
            'cap_style=CapStyleType.ROUND).set_stroke("#654321", width=3.0).shift([1.0, -1.0, 0])',
            False,
            id="dashed-line-dimensions-and-paint",
        ),
        pytest.param(
            V4_DOUBLE_ARROW,
            'DoubleArrow([-1.5, 0.0, 0], [1.5, 0.0, 0], buff=0, '
            'max_tip_length_to_length_ratio=0.25, tip_shape_start=StealthTip, '
            'tip_shape_end=ArrowCircleFilledTip).set_cap_style(CapStyleType.ROUND)'
            '.set_color("#654321").set_stroke("#654321", width=3.0).shift([1.0, -1.0, 0])',
            False,
            id="double-arrow-dimensions-and-paint",
        ),
        pytest.param(
            V4_FREEFORM_OPEN,
            'VMobject(joint_type=LineJointType.ROUND, cap_style=CapStyleType.ROUND)'
            '.start_new_path([-0.5, 0.25, 0])'
            '.add_cubic_bezier_curve_to([-0.25, 0.25, 0], [-0.1, -0.25, 0], [0.0, -0.25, 0])'
            '.add_cubic_bezier_curve_to([0.1, -0.25, 0], [0.25, 0.25, 0], [0.5, 0.25, 0])'
            '.stretch(3.0, 0, about_point=ORIGIN).stretch(2.0, 1, about_point=ORIGIN)'
            '.set_fill("#654321", opacity=0.0).set_stroke("#654321", width=3.0, opacity=0.4)'
            '.shift([1.0, -1.0, 0])',
            True,
            id="freeform-dimensions-and-paint",
        ),
        pytest.param(
            V4_FREEFORM_CLOSED,
            'VMobject(joint_type=LineJointType.BEVEL)'
            '.start_new_path([-0.5, 0.25, 0])'
            '.add_cubic_bezier_curve_to([-0.4, 0.1, 0], [-0.1, -0.25, 0], [0.0, -0.25, 0])'
            '.add_cubic_bezier_curve_to([0.1, -0.25, 0], [0.4, 0.1, 0], [0.5, 0.25, 0])'
            '.add_cubic_bezier_curve_to([0.25, 0.4, 0], [-0.25, 0.4, 0], [-0.5, 0.25, 0])'
            '.stretch(3.0, 0, about_point=ORIGIN).stretch(2.0, 1, about_point=ORIGIN)'
            '.set_fill("#abcdef", opacity=1.0).set_stroke("#654321", width=3.0)'
            '.set_opacity(0.4).shift([1.0, -1.0, 0])',
            False,
            id="freeform-closed-dimensions-fill-stroke-and-opacity",
        ),
    ],
)
def test_accepts_schema_v4_become_with_mutable_dimensions_and_paint(
    initializer: str,
    payload: str,
    freeform: bool,
) -> None:
    validate(v4_shape_become_source(initializer, payload, freeform=freeform))


@pytest.mark.parametrize(
    "expression",
    [
        pytest.param(
            V4_FREEFORM_OPEN.replace('opacity=0.0', 'opacity=1.0', 1),
            id="open-path-visible-fill",
        ),
        pytest.param(
            V4_FREEFORM_CLOSED.replace('opacity=1.0', 'opacity=0.0', 1),
            id="closed-path-transparent-fill",
        ),
        pytest.param(
            V4_FREEFORM_CLOSED.replace('width=2.0)', 'width=2.0, opacity=0.5)', 1),
            id="closed-path-stroke-only-opacity",
        ),
    ],
)
def test_rejects_freeform_paint_outside_open_closed_capability_grammar(expression: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(f"        pc_shape = {expression}\n"))


def test_accepts_compiler_safe_dashed_width_become_literal_drift() -> None:
    initializer = (
        'DashedLine([-1.28888887, 0.0, 0], [1.28888887, 0.0, 0], '
        'dash_length=0.26666671, dashed_ratio=0.62068966, cap_style=CapStyleType.ROUND)'
        '.set_stroke("#222222", width=2.0)'
    )
    payload = (
        'DashedLine([-0.42962962, 0.0, 0], [0.42962962, 0.0, 0], '
        'dash_length=0.2666668, dashed_ratio=0.62068966, cap_style=CapStyleType.ROUND)'
        '.set_stroke("#654321", width=3.0).shift([1.0, -1.0, 0])'
    )

    validate(v4_shape_become_source(initializer, payload))


def test_accepts_compiler_safe_dashed_width_become_ratio_drift() -> None:
    initializer = (
        'DashedLine([-0.22222222, 0.0, 0], [0.22222222, 0.0, 0], '
        'dash_length=0.01111111, dashed_ratio=0.05000003, cap_style=CapStyleType.ROUND)'
        '.set_stroke("#222222", width=2.0)'
    )
    payload = (
        'DashedLine([-0.22222222, 0.0, 0], [0.22222222, 0.0, 0], '
        'dash_length=0.01111112, dashed_ratio=0.05, cap_style=CapStyleType.ROUND)'
        '.set_stroke("#654321", width=3.0).shift([1.0, -1.0, 0])'
    )

    validate(v4_shape_become_source(initializer, payload))


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(
            'DashedLine([-0.42962962, 0.0, 0], [0.42962962, 0.0, 0], '
            'dash_length=0.266668, dashed_ratio=0.62068966, cap_style=CapStyleType.ROUND)'
            '.set_stroke("#654321", width=3.0).shift([1.0, -1.0, 0])',
            id="dash-length-outside-compiler-drift",
        ),
        pytest.param(
            'DashedLine([-0.42962962, 0.0, 0], [0.42962962, 0.0, 0], '
            'dash_length=0.2666668, dashed_ratio=0.620691, cap_style=CapStyleType.ROUND)'
            '.set_stroke("#654321", width=3.0).shift([1.0, -1.0, 0])',
            id="ratio-outside-compiler-drift",
        ),
        pytest.param(
            'DashedLine([-0.42962962, 0.0, 0], [0.42962962, 0.0, 0], '
            'dash_length=0.2666668, dashed_ratio=0.62068966, cap_style=CapStyleType.SQUARE)'
            '.set_stroke("#654321", width=3.0).shift([1.0, -1.0, 0])',
            id="immutable-cap",
        ),
    ],
)
def test_rejects_dashed_width_become_descriptor_tampering(payload: str) -> None:
    initializer = (
        'DashedLine([-1.28888887, 0.0, 0], [1.28888887, 0.0, 0], '
        'dash_length=0.26666671, dashed_ratio=0.62068966, cap_style=CapStyleType.ROUND)'
        '.set_stroke("#222222", width=2.0)'
    )

    with pytest.raises(SourcePolicyError, match="descriptor"):
        validate(v4_shape_become_source(initializer, payload))


@pytest.mark.parametrize(
    ("initializer", "payload", "freeform"),
    [
        pytest.param(
            V4_POLYGON,
            'Polygon([-0.5, 0.5, 0], [0.4, 0.5, 0], [0.0, -0.5, 0], joint_type=LineJointType.ROUND)'
            '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
            '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
            '.shift([1.0, -1.0, 0])',
            False,
            id="polygon-vertex",
        ),
        pytest.param(
            V4_POLYGON,
            V4_POLYGON.replace("LineJointType.ROUND", "LineJointType.BEVEL") + ".shift([1.0, -1.0, 0])",
            False,
            id="polygon-join",
        ),
        pytest.param(
            V4_DASHED_LINE,
            'DashedLine([-1.0, 0.0, 0], [1.0, 0.0, 0], dash_length=0.25, dashed_ratio=0.6, '
            'cap_style=CapStyleType.ROUND).set_stroke("#222222", width=2.0).shift([1.0, -1.0, 0])',
            False,
            id="dashed-pattern",
        ),
        pytest.param(
            V4_DASHED_LINE,
            V4_DASHED_LINE.replace("dashed_ratio=0.6", "dashed_ratio=0.5") + ".shift([1.0, -1.0, 0])",
            False,
            id="dashed-ratio",
        ),
        pytest.param(
            V4_DASHED_LINE,
            V4_DASHED_LINE.replace("CapStyleType.ROUND", "CapStyleType.SQUARE") + ".shift([1.0, -1.0, 0])",
            False,
            id="dashed-cap",
        ),
        pytest.param(
            V4_DOUBLE_ARROW,
            'DoubleArrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, '
            'max_tip_length_to_length_ratio=0.25, tip_shape_start=ArrowSquareFilledTip, '
            'tip_shape_end=ArrowCircleFilledTip).set_cap_style(CapStyleType.ROUND)'
            '.set_color("#222222").set_stroke("#222222", width=2.0).shift([1.0, -1.0, 0])',
            False,
            id="double-arrow-start-tip",
        ),
        pytest.param(
            V4_DOUBLE_ARROW,
            V4_DOUBLE_ARROW.replace("tip_shape_end=ArrowCircleFilledTip", "tip_shape_end=ArrowSquareFilledTip")
            + ".shift([1.0, -1.0, 0])",
            False,
            id="double-arrow-end-tip",
        ),
        pytest.param(
            V4_DOUBLE_ARROW,
            V4_DOUBLE_ARROW.replace("max_tip_length_to_length_ratio=0.25", "max_tip_length_to_length_ratio=0.3")
            + ".shift([1.0, -1.0, 0])",
            False,
            id="double-arrow-ratio",
        ),
        pytest.param(
            V4_DOUBLE_ARROW,
            V4_DOUBLE_ARROW.replace("CapStyleType.ROUND", "CapStyleType.BUTT") + ".shift([1.0, -1.0, 0])",
            False,
            id="double-arrow-cap",
        ),
        pytest.param(
            V4_FREEFORM_OPEN,
            'VMobject(joint_type=LineJointType.ROUND, cap_style=CapStyleType.SQUARE)'
            '.start_new_path([-0.5, 0.25, 0])'
            '.add_cubic_bezier_curve_to([-0.25, 0.25, 0], [-0.1, -0.25, 0], [0.0, -0.25, 0])'
            '.add_cubic_bezier_curve_to([0.1, -0.25, 0], [0.25, 0.25, 0], [0.5, 0.25, 0])'
            '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
            '.set_fill("#222222", opacity=0.0).set_stroke("#222222", width=2.0, opacity=0.4)'
            '.shift([1.0, -1.0, 0])',
            True,
            id="freeform-cap",
        ),
        pytest.param(
            V4_FREEFORM_OPEN,
            V4_FREEFORM_OPEN.replace("LineJointType.ROUND", "LineJointType.BEVEL") + ".shift([1.0, -1.0, 0])",
            True,
            id="freeform-join",
        ),
        pytest.param(
            V4_FREEFORM_OPEN,
            V4_FREEFORM_OPEN.replace("[-0.25, 0.25, 0]", "[-0.2, 0.25, 0]", 1)
            + ".shift([1.0, -1.0, 0])",
            True,
            id="freeform-control-point",
        ),
        pytest.param(
            V4_FREEFORM_OPEN,
            V4_FREEFORM_CLOSED + ".shift([1.0, -1.0, 0])",
            True,
            id="freeform-open-to-closed-topology",
        ),
        pytest.param(
            V4_ELLIPSE,
            V4_POLYGON + ".shift([1.0, -1.0, 0])",
            False,
            id="ellipse-to-polygon",
        ),
        pytest.param(
            V4_FREEFORM_OPEN,
            V4_DASHED_LINE + ".shift([1.0, -1.0, 0])",
            True,
            id="freeform-to-dashed-line",
        ),
    ],
)
def test_rejects_schema_v4_become_descriptor_and_kind_mutations(
    initializer: str,
    payload: str,
    freeform: bool,
) -> None:
    with pytest.raises(SourcePolicyError):
        validate(v4_shape_become_source(initializer, payload, freeform=freeform))


@pytest.mark.parametrize(
    "expression",
    [
        'Ellipse(height=1.0, width=2.0).set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)',
        'Ellipse(width=2.0, height=1.0).set_stroke("#222222", width=2.0)',
        'Polygon((-0.5, 0.5, 0), [0.5, 0.5, 0], [0.0, -0.5, 0], joint_type=LineJointType.ROUND)'
        '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
        '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)',
        'Polygon([-0.5, 0.5, 0], [0.5, 0.5, 0], [0.0, -0.5, 0], joint_type=LineJointType.ROUND)'
        '.stretch(1.0, 1, about_point=ORIGIN).stretch(2.0, 0, about_point=ORIGIN)'
        '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)',
        'DashedLine([-1.0, 0.0, 0], [1.0, 0.0, 0], dashed_ratio=0.6, dash_length=0.2, '
        'cap_style=CapStyleType.ROUND).set_stroke("#222222", width=2.0)',
        'DashedLine([-1.0, 0.0, 0], [1.0, 0.0, 0], dash_length=0.2, dashed_ratio=0.6, '
        'cap_style=CapStyleType.ROUND).set_cap_style(CapStyleType.ROUND).set_stroke("#222222", width=2.0)',
        'DoubleArrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, '
        'tip_shape_start=StealthTip, max_tip_length_to_length_ratio=0.25, '
        'tip_shape_end=ArrowCircleFilledTip).set_cap_style(CapStyleType.ROUND)'
        '.set_color("#222222").set_stroke("#222222", width=2.0)',
        'DoubleArrow([-1.0, 0.0, 0], [1.0, 0.0, 0], buff=0, '
        'max_tip_length_to_length_ratio=0.25, tip_shape_start=StealthTip(), '
        'tip_shape_end=ArrowCircleFilledTip).set_cap_style(CapStyleType.ROUND)'
        '.set_color("#222222").set_stroke("#222222", width=2.0)',
        'VMobject(joint_type=LineJointType.ROUND, cap_style=CapStyleType.ROUND)'
        '.start_new_path(ORIGIN)'
        '.add_cubic_bezier_curve_to([-0.25, 0.25, 0], [0.25, -0.25, 0], [0.5, 0.25, 0])'
        '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
        '.set_fill("#222222", opacity=0.0).set_stroke("#222222", width=2.0, opacity=1.0)',
        'VMobject(joint_type=LineJointType.ROUND, cap_style=CapStyleType.ROUND)'
        '.start_new_path([-0.5, 0.25, 0])'
        '.add_cubic_bezier_curve_to([-0.25, 0.25, 0], [0.25, -0.25, 0], [0.5, 0.25, 0])'
        '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
        '.set_fill("#222222", opacity=1.0).set_stroke("#222222", width=2.0, opacity=1.0)',
        'VMobject(joint_type=LineJointType.ROUND, cap_style=CapStyleType.ROUND)'
        '.start_new_path([-0.5, 0.25, 0])'
        '.add_cubic_bezier_curve_to([-0.25, 0.25, 0], [0.25, -0.25, 0], [0.5, 0.25, 0])'
        '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
        '.set_fill("#222222", opacity=0.0).set_stroke("#222222", opacity=1.0, width=2.0)',
    ],
)
def test_rejects_schema_v4_native_aliases_reordering_and_nonliterals(expression: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(f"        pc_shape = {expression}\n"))


def dashed_boundary_expression(half_width: float) -> str:
    return (
        f'DashedLine([-{half_width}, 0.0, 0], [{half_width}, 0.0, 0], '
        'dash_length=0.02, dashed_ratio=0.5, cap_style=CapStyleType.BUTT)'
        '.set_stroke("#222222", width=2.0)'
    )


def test_accepts_256_dashes_and_rejects_257_dashes_per_constructor() -> None:
    validate(source_with(
        f"        pc_shape = {dashed_boundary_expression(5.12)}\n"
        "        pc_shape.shift([0.0, 0.0, 0])\n"
    ))
    with pytest.raises(SourcePolicyError, match="too many rendered dashes"):
        validate(source_with(f"        pc_shape = {dashed_boundary_expression(5.14)}\n"))


def dashed_work_source(count: int) -> str:
    return source_with("".join(
        f"        pc_shape_{index} = {dashed_boundary_expression(5.12)}\n"
        f"        pc_shape_{index}.shift([0.0, 0.0, 0])\n"
        for index in range(count)
    ))


def test_enforces_aggregate_native_geometry_work_budget() -> None:
    validate(dashed_work_source(16))
    with pytest.raises(SourcePolicyError, match="work budget"):
        validate(dashed_work_source(17))


def closed_freeform_boundary_expression(segment_count: int) -> str:
    start = "[-0.5, 0.0, 0]"
    segments: list[str] = []
    for index in range(segment_count):
        if index == segment_count - 1:
            end = start
        else:
            x = -0.48 + (0.96 * (index + 1) / segment_count)
            y = 0.2 if index % 2 == 0 else -0.2
            end = f"[{x:.8f}, {y:.1f}, 0]"
        segments.append(
            ".add_cubic_bezier_curve_to([-0.25, 0.1, 0], [0.25, -0.1, 0], " + end + ")"
        )
    return (
        "VMobject(joint_type=LineJointType.MITER).start_new_path(" + start + ")"
        + "".join(segments)
        + '.stretch(2.0, 0, about_point=ORIGIN).stretch(1.0, 1, about_point=ORIGIN)'
        + '.set_fill("#111111", opacity=1.0).set_stroke("#222222", width=2.0)'
    )


def test_accepts_64_freeform_cubics_and_rejects_65() -> None:
    validate(source_with(
        f"        pc_shape = {closed_freeform_boundary_expression(64)}\n"
        "        pc_shape.shift([0.0, 0.0, 0])\n"
    ))
    with pytest.raises(SourcePolicyError, match="methods"):
        validate(source_with(f"        pc_shape = {closed_freeform_boundary_expression(65)}\n"))


@pytest.mark.parametrize(
    "target",
    [
        pytest.param(
            f"pc_shape_ref.copy().become({V4_FREEFORM_OPEN}.shift([1.0, -1.0, 0])).set_opacity(0.4)",
            id="generic-opacity",
        ),
        pytest.param(
            f"pc_shape_ref.copy().become({V4_FREEFORM_OPEN}.shift([1.0, -1.0, 0])).set_stroke(0.4)",
            id="positional-stroke-opacity",
        ),
        pytest.param(
            f'pc_shape_ref.copy().become({V4_FREEFORM_OPEN}.shift([1.0, -1.0, 0])).set_stroke("#ffffff", opacity=0.4)',
            id="stroke-colour-override",
        ),
    ],
)
def test_rejects_freeform_become_without_exact_stroke_opacity_override(target: str) -> None:
    with pytest.raises(SourcePolicyError):
        validate(source_with(
            f"        pc_shape = {V4_FREEFORM_OPEN}\n"
            "        pc_shape.shift([0.0, 0.0, 0])\n"
            "        pc_shape_ref = pc_shape.copy()\n"
            "        self.add(pc_shape)\n"
            f"        self.play(Transform(pc_shape, {target}, run_time=1.0, rate_func=linear))\n"
        ))


def test_rejects_closed_freeform_become_with_stroke_only_opacity_override() -> None:
    target = (
        f"pc_shape_ref.copy().become({V4_FREEFORM_CLOSED}.shift([1.0, -1.0, 0]))"
        ".set_stroke(opacity=0.4)"
    )
    with pytest.raises(SourcePolicyError, match="exact compiler target"):
        validate(source_with(
            f"        pc_shape = {V4_FREEFORM_CLOSED}\n"
            "        pc_shape.shift([0.0, 0.0, 0])\n"
            "        pc_shape_ref = pc_shape.copy()\n"
            "        self.add(pc_shape)\n"
            f"        self.play(Transform(pc_shape, {target}, run_time=1.0, rate_func=linear))\n"
        ))
