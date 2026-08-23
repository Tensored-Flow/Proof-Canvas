from __future__ import annotations

import hashlib

import pytest

from proofcanvas_render.policy import MAX_SOURCE_BYTES, SourcePolicyError, validate_generated_source


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


def validate(source: str) -> None:
    validate_generated_source(source, hashlib.sha256(source.encode("utf-8")).hexdigest())


def test_accepts_safe_mathtex_compiler_dialect() -> None:
    validate(source_with('        pc_math = MathTex(r"\\\\frac{1}{2} \\le \\pi", font_size=34.0)\n'))


@pytest.mark.parametrize("command", ["input", "include", "write", "openin", "openout", "read", "special"])
def test_rejects_file_and_process_latex_commands(command: str) -> None:
    source = source_with(f'        pc_math = MathTex(r"\\\\{command}{{/etc/hostname}}", font_size=34.0)\n')

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
        ", font_size=1.0",
        ", font_size=pc_font_size",
        ", font_size=34.0, tex_template=None",
    ],
)
def test_rejects_mathtex_arguments_outside_compiler_dialect(arguments: str) -> None:
    prefix = "        pc_font_size = 34.0\n" if "pc_font_size" in arguments else ""
    source = source_with(prefix + f'        pc_math = MathTex(r"\\\\frac{{1}}{{2}}"{arguments})\n')

    with pytest.raises(SourcePolicyError, match="arguments are outside"):
        validate(source)
