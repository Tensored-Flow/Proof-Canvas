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


LATEX_CONFORMANCE = json.loads((Path(__file__).with_name("latex_conformance.json")).read_text(encoding="utf-8"))["vectors"]


@pytest.mark.parametrize("vector", LATEX_CONFORMANCE, ids=lambda vector: vector["id"])
def test_shared_latex_conformance(vector: dict[str, object]) -> None:
    renderer = "MathTex" if vector["renderer"] == "mathtex" else "Tex"
    statement = f"        pc_math = {renderer}({json.dumps(vector['content'])}, font_size=34.0)\n"
    if vector["accepted"]:
        validate(source_with(statement))
    else:
        with pytest.raises(SourcePolicyError, match="safe compiler dialect"):
            validate(source_with(statement))


def test_accepts_safe_mathtex_compiler_dialect() -> None:
    validate(source_with('        pc_math = MathTex(r"\\\\frac{1}{2} \\le \\pi", font_size=34.0)\n'))


def test_accepts_safe_tex_compiler_dialect() -> None:
    validate(source_with('        pc_text = Tex(r"Euler wrote $e^{i\\\\pi}+1=0$.", font_size=34.0)\n'))


@pytest.mark.parametrize("font_size", [1.0, 256.0])
def test_accepts_schema_font_size_boundaries(font_size: float) -> None:
    validate(source_with(f'        pc_math = MathTex(r"x", font_size={font_size})\n'))


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
        "        self.play(Transform(pc_box, pc_box.copy(), run_time=1.0, "
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
        "        pc_graph = FunctionGraph(lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.3, 0.8, 0.9), x_range=[-1.0, 1.0])\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.play(Transform(pc_box, pc_box.copy(), lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.3, 0.8, 0.9)))\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.play(Transform(pc_box, pc_box.copy(), path_func=lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.3, 0.8, 0.9)))\n",
        "        pc_box = Rectangle(width=1.0, height=1.0)\n        self.play(FadeIn(pc_box, rate_func=lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.3, 0.8, 0.9)))\n",
    ],
)
def test_rejects_cubic_lambda_outside_exact_transform_rate_keyword(statement: str) -> None:
    with pytest.raises(SourcePolicyError, match="Transform rate_func"):
        validate(source_with_cubic_helper(statement))


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


def test_enforces_the_independent_custom_easing_lambda_budget() -> None:
    def source_for(count: int) -> str:
        transforms = ",\n".join(
            "            Transform(pc_box, pc_box.copy(), run_time=1.0, "
            "rate_func=lambda x: proofcanvas_cubic_bezier(x, 0.2, 0.0, 0.8, 1.0))"
            for _ in range(count)
        )
        return source_with_cubic_helper(
            "        pc_box = Rectangle(width=1.0, height=1.0)\n"
            "        self.play(AnimationGroup(\n"
            f"{transforms},\n"
            "            group=Group(), lag_ratio=0))\n"
        )

    validate(source_for(MAX_RATE_LAMBDAS))
    with pytest.raises(SourcePolicyError, match="too many custom easing lambdas"):
        validate(source_for(MAX_RATE_LAMBDAS + 1))
