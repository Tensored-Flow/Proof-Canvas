from __future__ import annotations

import ast
import hashlib
import math
import re
from dataclasses import dataclass

MAX_SOURCE_BYTES = 512 * 1024
SOURCE_SHA_PATTERN = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,95}$")
SAFE_LATEX_BLOCKLIST = re.compile(
    r"\\(?:input|include|write|openin|openout|read|usepackage|catcode|csname|newcommand|renewcommand|def|special)\b",
    re.IGNORECASE,
)
SAFE_LATEX_COMMAND_PATTERN = re.compile(r"\\([A-Za-z]+)")
SAFE_LATEX_COMMANDS = frozenset(
    {
        "abs",
        "alpha",
        "beta",
        "cdot",
        "cos",
        "delta",
        "epsilon",
        "frac",
        "gamma",
        "ge",
        "infty",
        "int",
        "lambda",
        "le",
        "left",
        "lim",
        "ln",
        "log",
        "mathbb",
        "mathbf",
        "mathrm",
        "neq",
        "overline",
        "pi",
        "prod",
        "right",
        "sin",
        "sqrt",
        "sum",
        "tan",
        "text",
        "theta",
        "times",
        "to",
        "underline",
        "varphi",
    }
)


class SourcePolicyError(ValueError):
    """A generated-source envelope failed the renderer's fail-closed policy."""


@dataclass(frozen=True)
class ValidatedSource:
    source: str
    sha256: str


ALLOWED_CONSTRUCTORS = frozenset(
    {
        "AnimationGroup",
        "Arrow",
        "Axes",
        "BraceBetweenPoints",
        "Circle",
        "Create",
        "FadeIn",
        "FadeOut",
        "FunctionGraph",
        "Group",
        "Indicate",
        "Line",
        "MathTex",
        "max",
        "min",
        "Rectangle",
        "Succession",
        "Text",
        "Transform",
        "VGroup",
        "VMobject",
        "Wait",
        "Write",
        "abs",
    }
)
ALLOWED_CONSTANT_NAMES = frozenset(
    {"DEGREES", "DOWN", "UP", "LEFT", "RIGHT", "ORIGIN", "linear", "rush_into", "rush_from", "smooth"}
)
ALLOWED_ATTRIBUTES = frozenset(
    {
        "add",
        "animate",
        "background_color",
        "become",
        "camera",
        "clear",
        "copy",
        "ease_out_back",
        "ease_out_quart",
        "frame",
        "frame_height",
        "frame_width",
        "height",
        "move_to",
        "next_section",
        "play",
        "rotate",
        "scale",
        "scale_to_fit_height",
        "scale_to_fit_width",
        "set_color",
        "set_fill",
        "set_opacity",
        "set_stroke",
        "shift",
        "stretch",
        "stretch_to_fit_height",
        "stretch_to_fit_width",
        "there_and_back",
        "wait",
        "width",
        "sin",
        "cos",
    }
)
FORBIDDEN_NODES = (
    ast.AsyncFor,
    ast.AsyncFunctionDef,
    ast.AsyncWith,
    ast.Await,
    ast.Break,
    ast.Continue,
    ast.Delete,
    ast.DictComp,
    ast.For,
    ast.GeneratorExp,
    ast.Global,
    ast.If,
    ast.IfExp,
    ast.ListComp,
    ast.Match,
    ast.NamedExpr,
    ast.Nonlocal,
    ast.Raise,
    ast.Return,
    ast.SetComp,
    ast.Try,
    ast.TryStar,
    ast.While,
    ast.With,
    ast.Yield,
    ast.YieldFrom,
)


def _attribute_parts(node: ast.Attribute) -> list[str]:
    parts: list[str] = [node.attr]
    cursor: ast.expr = node.value
    while isinstance(cursor, ast.Attribute):
        parts.append(cursor.attr)
        cursor = cursor.value
    if isinstance(cursor, ast.Name):
        parts.append(cursor.id)
    return list(reversed(parts))


def _is_safe_latex(value: str) -> bool:
    """Mirror the browser schema's deliberately small LaTeX dialect."""
    if len(value) > 500 or SAFE_LATEX_BLOCKLIST.search(value):
        return False
    if "../" in value or "..\\" in value or "^^" in value:
        return False
    if any(ord(character) < 32 for character in value):
        return False
    return all(command in SAFE_LATEX_COMMANDS for command in SAFE_LATEX_COMMAND_PATTERN.findall(value))


def _validate_structure(tree: ast.Module) -> None:
    if len(tree.body) != 3:
        raise SourcePolicyError("Generated source must contain exactly two imports and one scene class")
    manim_import, math_import, scene_class = tree.body
    if not (
        isinstance(manim_import, ast.ImportFrom)
        and manim_import.module == "manim"
        and manim_import.level == 0
        and len(manim_import.names) == 1
        and manim_import.names[0].name == "*"
        and manim_import.names[0].asname is None
    ):
        raise SourcePolicyError("Generated source has an unsupported Manim import")
    if not (
        isinstance(math_import, ast.Import)
        and len(math_import.names) == 1
        and math_import.names[0].name == "math"
        and math_import.names[0].asname is None
    ):
        raise SourcePolicyError("Generated source has an unsupported standard-library import")
    if not (
        isinstance(scene_class, ast.ClassDef)
        and scene_class.name == "GeneratedScene"
        and not scene_class.decorator_list
        and len(scene_class.bases) == 1
        and isinstance(scene_class.bases[0], ast.Name)
        and scene_class.bases[0].id == "MovingCameraScene"
        and len(scene_class.body) == 1
    ):
        raise SourcePolicyError("Generated source must define only GeneratedScene")
    construct = scene_class.body[0]
    if not (
        isinstance(construct, ast.FunctionDef)
        and construct.name == "construct"
        and not construct.decorator_list
        and len(construct.args.args) == 1
        and construct.args.args[0].arg == "self"
        and construct.args.vararg is None
        and construct.args.kwarg is None
        and not construct.args.kwonlyargs
        and not construct.args.defaults
    ):
        raise SourcePolicyError("GeneratedScene must expose only construct(self)")


def _validate_nodes(tree: ast.Module) -> None:
    manim_import, math_import, scene_class = tree.body
    assert isinstance(scene_class, ast.ClassDef)
    construct = scene_class.body[0]
    permitted_definitions = {id(manim_import), id(math_import), id(scene_class), id(construct)}
    permitted_statements = permitted_definitions | {
        id(statement)
        for statement in construct.body
        if isinstance(statement, (ast.Assign, ast.Expr))
    }
    assigned = {
        node.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)
    }
    permitted_loads = (
        assigned
        | ALLOWED_CONSTANT_NAMES
        | ALLOWED_CONSTRUCTORS
        | {"MovingCameraScene", "config", "math", "rate_functions", "self", "x"}
    )
    lambda_depth = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.stmt) and id(node) not in permitted_statements:
            raise SourcePolicyError(f"Generated source contains an unsupported statement: {type(node).__name__}")
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.ClassDef, ast.FunctionDef)) and id(node) not in permitted_definitions:
            raise SourcePolicyError(f"Generated source contains a nested definition: {type(node).__name__}")
        if isinstance(node, FORBIDDEN_NODES):
            raise SourcePolicyError(f"Generated source contains forbidden syntax: {type(node).__name__}")
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str) and len(node.value) > 16_384:
                raise SourcePolicyError("Generated source contains an oversized string literal")
            if isinstance(node.value, float) and not math.isfinite(node.value):
                raise SourcePolicyError("Generated source contains a non-finite number")
            if isinstance(node.value, (int, float)) and not isinstance(node.value, bool) and abs(node.value) > 1_000_000_000:
                raise SourcePolicyError("Generated source contains an out-of-range number")
        if isinstance(node, ast.Name):
            if not IDENTIFIER_PATTERN.fullmatch(node.id) or node.id.startswith("_"):
                raise SourcePolicyError("Generated source contains an unsafe identifier")
            if isinstance(node.ctx, ast.Load) and node.id not in permitted_loads:
                raise SourcePolicyError(f"Generated source reads an unsupported name: {node.id}")
        if isinstance(node, ast.Attribute):
            parts = _attribute_parts(node)
            if any(not part or part.startswith("_") for part in parts):
                raise SourcePolicyError("Generated source contains a private attribute")
            if node.attr not in ALLOWED_ATTRIBUTES:
                raise SourcePolicyError(f"Generated source contains an unsupported attribute: {node.attr}")
        if isinstance(node, ast.Assign):
            if len(node.targets) != 1:
                raise SourcePolicyError("Generated source contains a multiple-target assignment")
            target = node.targets[0]
            if not isinstance(target, (ast.Name, ast.Attribute)):
                raise SourcePolicyError("Generated source contains an unsafe assignment target")
            if isinstance(target, ast.Attribute) and _attribute_parts(target) != ["self", "camera", "background_color"]:
                raise SourcePolicyError("Generated source can assign only the camera background")
        if isinstance(node, ast.Call):
            if any(keyword.arg is None for keyword in node.keywords):
                raise SourcePolicyError("Generated source cannot expand keyword arguments")
            if isinstance(node.func, ast.Name):
                if node.func.id not in ALLOWED_CONSTRUCTORS:
                    raise SourcePolicyError(f"Generated source calls an unsupported function: {node.func.id}")
                if node.func.id == "MathTex":
                    if (
                        len(node.args) != 1
                        or not isinstance(node.args[0], ast.Constant)
                        or not isinstance(node.args[0].value, str)
                        or not _is_safe_latex(node.args[0].value)
                    ):
                        raise SourcePolicyError("MathTex content is outside the safe compiler dialect")
                    if (
                        len(node.keywords) != 1
                        or node.keywords[0].arg != "font_size"
                        or not isinstance(node.keywords[0].value, ast.Constant)
                        or isinstance(node.keywords[0].value.value, bool)
                        or not isinstance(node.keywords[0].value.value, (int, float))
                        or not 6 <= node.keywords[0].value.value <= 160
                    ):
                        raise SourcePolicyError("MathTex arguments are outside the compiler dialect")
            elif not isinstance(node.func, ast.Attribute):
                raise SourcePolicyError("Generated source contains an unsupported callable")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow):
            exponent: object
            if isinstance(node.right, ast.Constant):
                exponent = node.right.value
            elif (
                isinstance(node.right, ast.UnaryOp)
                and isinstance(node.right.op, ast.USub)
                and isinstance(node.right.operand, ast.Constant)
                and isinstance(node.right.operand.value, int)
            ):
                exponent = -node.right.operand.value
            else:
                raise SourcePolicyError("Generated source contains an unsupported power")
            if not isinstance(exponent, int) or not -8 <= exponent <= 8:
                raise SourcePolicyError("Generated source contains an out-of-range power")
        if isinstance(node, ast.Lambda):
            lambda_depth += 1
            if (
                len(node.args.args) != 1
                or node.args.args[0].arg != "x"
                or node.args.vararg is not None
                or node.args.kwarg is not None
                or node.args.kwonlyargs
            ):
                raise SourcePolicyError("Restricted graph lambdas must accept only x")
    if lambda_depth > 8:
        raise SourcePolicyError("Generated source contains too many restricted graph lambdas")


def validate_generated_source(source: str, expected_sha256: str) -> ValidatedSource:
    if not isinstance(source, str) or not isinstance(expected_sha256, str):
        raise SourcePolicyError("Generated source and SHA must be strings")
    encoded = source.encode("utf-8")
    if not encoded or len(encoded) > MAX_SOURCE_BYTES:
        raise SourcePolicyError("Generated source exceeds the renderer limit")
    if not SOURCE_SHA_PATTERN.fullmatch(expected_sha256):
        raise SourcePolicyError("Expected source SHA is malformed")
    actual_sha256 = hashlib.sha256(encoded).hexdigest()
    if actual_sha256 != expected_sha256:
        raise SourcePolicyError("Generated source SHA does not match")
    try:
        tree = ast.parse(source, filename="generated_scene.py", mode="exec")
    except SyntaxError as error:
        raise SourcePolicyError("Generated source is not valid Python") from error
    _validate_structure(tree)
    _validate_nodes(tree)
    return ValidatedSource(source=source, sha256=actual_sha256)
