from __future__ import annotations

import ast
import hashlib
import math
import re
from dataclasses import dataclass

MAX_SOURCE_BYTES = 512 * 1024
SOURCE_SHA_PATTERN = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,95}$")
HEX_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
FORBIDDEN_LATEX_COMMANDS = frozenset(
    {"catcode", "csname", "def", "include", "input", "newcommand", "openin", "openout", "read", "renewcommand", "special", "usepackage", "write"}
)
SAFE_LATEX_COMMANDS = frozenset(
    {
        "alpha",
        "beta",
        "cdot",
        "cos",
        "delta",
        "displaystyle",
        "emph",
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
        "operatorname",
        "overline",
        "pi",
        "prod",
        "right",
        "sin",
        "sqrt",
        "sum",
        "tan",
        "text",
        "textbf",
        "textit",
        "textstyle",
        "theta",
        "times",
        "to",
        "underline",
        "varphi",
        "vec",
        "bar",
        "hat",
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
        "Group",
        "Indicate",
        "Line",
        "MathTex",
        "Tex",
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
        "set_points_as_corners",
        "set_stroke",
        "shift",
        "stretch",
        "stretch_to_fit_height",
        "stretch_to_fit_width",
        "there_and_back",
        "wait",
        "width",
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
    ast.Starred,
    ast.Try,
    ast.TryStar,
    ast.While,
    ast.With,
    ast.Yield,
    ast.YieldFrom,
)

MAX_LITERAL_GRAPH_GEOMETRIES = 8
MAX_LITERAL_GRAPH_SEGMENTS = 128
MAX_LITERAL_GRAPH_POINTS = 257
MAX_LITERAL_GRAPH_TOTAL_POINTS = MAX_LITERAL_GRAPH_GEOMETRIES * MAX_LITERAL_GRAPH_POINTS
MAX_LITERAL_GRAPH_COORDINATE = 10_000
MAX_LITERAL_GRAPH_STROKE_WIDTH = 64
MAX_RATE_LAMBDAS = 1024
MAX_OBJECTS_PER_SHOT = 256
MAX_DIRECT_MANIM_COORDINATE = 68
MAX_DIRECT_MANIM_DIMENSION = 60.68148148
MIN_DIRECT_MANIM_DIMENSION = 0.02
MIN_COPY_STRETCH = 0.00000001
MAX_COPY_STRETCH = 40_960_000
MAX_COPY_FIT_DIMENSION = 6068.14814815
MIN_COPY_FIT_DIMENSION = 0.0002
MAX_DIRECT_ROTATION = 3_600
MAX_COPY_ROTATION = 7_200
MIN_AUTHORED_SCALE_MAGNITUDE = 0.01
MAX_AUTHORED_SCALE_MAGNITUDE = 100
MIN_CAMERA_ZOOM = 0.05
MAX_CAMERA_ZOOM = 20
MAX_DERIVED_NUMERIC_LITERAL = 1_000_000_000
MAX_TEXT_CONTENT_CHARS = 4_096
MAX_BRACE_LABEL_CHARS = 500
MAX_ANIMATION_EXPRESSIONS = 4_096
MAX_ANIMATION_NESTING = 16
MAX_COMPILER_SHOTS = 64
MOBJECT_CONSTRUCTORS = frozenset(
    {
        "Arrow",
        "Axes",
        "BraceBetweenPoints",
        "Circle",
        "Group",
        "Line",
        "MathTex",
        "Rectangle",
        "Tex",
        "Text",
        "VGroup",
        "VMobject",
    }
)
SENSITIVE_METHOD_ATTRIBUTES = frozenset(
    {
        "add",
        "become",
        "clear",
        "copy",
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
        "set_points_as_corners",
        "set_stroke",
        "shift",
        "stretch",
        "stretch_to_fit_height",
        "stretch_to_fit_width",
        "wait",
    }
)
ANIMATION_CONSTRUCTORS = frozenset(
    {"AnimationGroup", "Create", "FadeIn", "FadeOut", "Indicate", "Succession", "Transform", "Wait", "Write"}
)
RESERVED_CONSTRUCT_BINDINGS = ALLOWED_CONSTRUCTORS | ALLOWED_CONSTANT_NAMES | frozenset(
    {"MovingCameraScene", "config", "math", "proofcanvas_cubic_bezier", "rate_functions", "self", "x"}
)
PROOFCANVAS_CUBIC_BEZIER_HELPER = """def proofcanvas_cubic_bezier(x, x1, y1, x2, y2):
    x = min(1.0, max(0.0, x))
    if x == 0.0 or x == 1.0:
        return x
    lower = 0.0
    upper = 1.0
    for iteration in range(32):
        candidate = (lower + upper) / 2.0
        inverse = 1.0 - candidate
        value = 3.0 * inverse * inverse * candidate * x1 + 3.0 * inverse * candidate * candidate * x2 + candidate * candidate * candidate
        if value < x:
            lower = candidate
        else:
            upper = candidate
    candidate = (lower + upper) / 2.0
    inverse = 1.0 - candidate
    return 3.0 * inverse * inverse * candidate * y1 + 3.0 * inverse * candidate * candidate * y2 + candidate * candidate * candidate
"""
PROOFCANVAS_CUBIC_BEZIER_HELPER_AST = ast.parse(PROOFCANVAS_CUBIC_BEZIER_HELPER).body[0]


def _attribute_parts(node: ast.Attribute) -> list[str]:
    parts: list[str] = [node.attr]
    cursor: ast.expr = node.value
    while isinstance(cursor, ast.Attribute):
        parts.append(cursor.attr)
        cursor = cursor.value
    if isinstance(cursor, ast.Name):
        parts.append(cursor.id)
    return list(reversed(parts))


LATEX_ESCAPED_LITERALS = frozenset({"\\", "{", "}", "_", "%", "$", "#", "&", ",", ";", ":", "!", " "})
TEX_PLAIN_TEXT_PUNCTUATION = frozenset({" ", ".", ",", ";", ":", "!", "?", '"', "'", "(", ")", "[", "]", "-", "+", "=", "/", "*", "@"})
LATEX_SCRIPT_SYMBOL_COMMANDS = frozenset({"alpha", "beta", "delta", "epsilon", "gamma", "infty", "lambda", "pi", "theta", "varphi"})
LATEX_TEXT_MODE_COMMANDS = frozenset({"emph", "text", "textbf", "textit"})
LATEX_TEXT_MODE_ESCAPES = frozenset({"{", "}", "_", "%", "$", "#", "&", ",", ";", ":", "!", " "})
LATEX_BRACED_COMMAND_ARITY = {
    "bar": 1,
    "emph": 1,
    "frac": 2,
    "hat": 1,
    "mathbb": 1,
    "mathbf": 1,
    "mathrm": 1,
    "operatorname": 1,
    "overline": 1,
    "text": 1,
    "textbf": 1,
    "textit": 1,
    "underline": 1,
    "vec": 1,
}
LEFT_DELIMITER_MATCH = {"(": ")", "[": "]", "<": ">", "|": "|", "\\{": "\\}"}


def _skip_latex_whitespace(value: str, start: int) -> int:
    cursor = start
    while cursor < len(value) and value[cursor].isspace():
        cursor += 1
    return cursor


def _balanced_delimiter_end(value: str, start: int, opening: str, closing: str) -> int | None:
    if start >= len(value) or value[start] != opening:
        return None
    depth = 1
    cursor = start + 1
    while cursor < len(value):
        if value[cursor] == "\\" and cursor + 1 < len(value):
            cursor += 2
            continue
        if value[cursor] == opening:
            depth += 1
        elif value[cursor] == closing:
            depth -= 1
            if depth == 0:
                return cursor + 1
        cursor += 1
    return None


def _latex_delimiter_at(value: str, start: int) -> tuple[str, int] | None:
    cursor = _skip_latex_whitespace(value, start)
    if cursor < len(value) and value[cursor] in ".()[]<>|":
        return value[cursor], cursor + 1
    escaped = value[cursor:cursor + 2]
    if escaped in {"\\{", "\\}"}:
        return escaped, cursor + 2
    return None


def _script_structure_error(value: str) -> str | None:
    def scan(start: int, end: int) -> str | None:
        index = start
        while index < end:
            index = _skip_latex_whitespace(value, index)
            if index >= end:
                break
            character = value[index]
            if character in {"^", "_"}:
                return "math marker is missing a base"

            if character == "{":
                group_end = _balanced_delimiter_end(value, index, "{", "}")
                if group_end is None:
                    return None
                nested_error = scan(index + 1, group_end - 1)
                if nested_error:
                    return nested_error
                index = group_end
            elif character == "\\":
                if index + 1 >= end:
                    return None
                index += 2
                if value[index - 1].isascii() and value[index - 1].isalpha():
                    while index < end and value[index].isascii() and value[index].isalpha():
                        index += 1
            else:
                index += 1

            scripts: set[str] = set()
            while index < end:
                marker_offset = _skip_latex_whitespace(value, index)
                marker = value[marker_offset] if marker_offset < end else None
                if marker not in {"^", "_"}:
                    index = marker_offset
                    break
                if marker in scripts:
                    return f"duplicate script marker: {marker}"
                scripts.add(marker)
                argument_offset = _skip_latex_whitespace(value, marker_offset + 1)
                argument = value[argument_offset] if argument_offset < end else None
                if argument is None or argument in {"}", "$", "^", "_"}:
                    return "math marker is missing an argument"
                if argument == "{":
                    group_end = _balanced_delimiter_end(value, argument_offset, "{", "}")
                    if group_end is None:
                        return None
                    nested_error = scan(argument_offset + 1, group_end - 1)
                    if nested_error:
                        return nested_error
                    index = group_end
                elif argument == "\\":
                    if argument_offset + 1 >= end:
                        return None
                    next_character = value[argument_offset + 1]
                    if not next_character.isascii() or not next_character.isalpha():
                        return "unbraced script argument is not an ASCII alphanumeric or supported symbol command"
                    command_end = argument_offset + 2
                    while command_end < end and value[command_end].isascii() and value[command_end].isalpha():
                        command_end += 1
                    if value[argument_offset + 1:command_end] not in LATEX_SCRIPT_SYMBOL_COMMANDS:
                        return "script command requires braces"
                    index = command_end
                else:
                    if not argument.isascii() or not argument.isalnum():
                        return "unbraced script argument is not an ASCII alphanumeric or supported symbol command"
                    index = argument_offset + 1
        return None

    return scan(0, len(value))


def _text_mode_argument_error(value: str, start: int, end: int) -> str | None:
    index = start
    while index < end:
        character = value[index]
        if character == "\\":
            if index + 1 >= end or value[index + 1] not in LATEX_TEXT_MODE_ESCAPES:
                return "text-mode command contains an unsupported escape"
            index += 2
            continue
        if not (
            character.isascii()
            and (character.isalnum() or character in "\t\n\r" or character in TEX_PLAIN_TEXT_PUNCTUATION)
        ):
            return "text-mode command contains an unsupported character"
        index += 1
    return None


def _command_arguments_error(value: str, command: str, command_start: int, command_end: int) -> str | None:
    cursor = command_end
    if command == "sqrt":
        cursor = _skip_latex_whitespace(value, cursor)
        if cursor < len(value) and value[cursor] == "[":
            index_end = _balanced_delimiter_end(value, cursor, "[", "]")
            if index_end is None:
                return "sqrt has an unclosed optional index"
            if not value[cursor + 1:index_end - 1].strip():
                return "sqrt has an empty optional index"
            if _script_structure_error(value[cursor + 1:index_end - 1]):
                return "sqrt has an invalid optional index"
            cursor = index_end
    arity = 1 if command == "sqrt" else LATEX_BRACED_COMMAND_ARITY.get(command, 0)
    for _ in range(arity):
        cursor = _skip_latex_whitespace(value, cursor)
        if cursor >= len(value) or value[cursor] != "{":
            return f"command requires braced arguments: {command} at {command_start}"
        group_end = _balanced_delimiter_end(value, cursor, "{", "}")
        if group_end is None:
            return None
        if command in LATEX_TEXT_MODE_COMMANDS:
            text_error = _text_mode_argument_error(value, cursor + 1, group_end - 1)
            if text_error:
                return text_error
        cursor = group_end
    return None


def _latex_dialect_error(value: str, renderer: str) -> str | None:
    """Bounded structural mirror of the TypeScript LaTeX authority."""
    if len(value) > 500:
        return "content is too long"
    if any(ord(character) > 126 for character in value):
        return "content is outside the renderer-safe ASCII dialect"
    if any(ord(character) < 32 and character not in "\t\n\r" for character in value):
        return "content contains a control character"
    if "../" in value or "..\\" in value or "^^" in value:
        return "content contains an unsafe path-like sequence"

    braces: list[int] = []
    left_commands: list[tuple[int, str, int, int | None]] = []
    commands: list[tuple[str, int, int]] = []
    dollar_offset: int | None = None
    index = 0
    while index < len(value):
        character = value[index]
        if character == "\\":
            if index + 1 >= len(value):
                return "content has a dangling backslash"
            next_character = value[index + 1]
            if next_character == "\\":
                if index + 2 < len(value) and value[index + 2] in {"[", "*"}:
                    return "linebreak modifiers are outside the supported dialect"
                index += 2
                continue
            if not next_character.isascii() or not next_character.isalpha():
                if next_character not in LATEX_ESCAPED_LITERALS:
                    return "content contains an unsupported escape"
                index += 2
                continue
            end = index + 2
            while end < len(value) and value[end].isascii() and value[end].isalpha():
                end += 1
            command = value[index + 1:end]
            if command.lower() in FORBIDDEN_LATEX_COMMANDS:
                return f"forbidden command: {command}"
            if command not in SAFE_LATEX_COMMANDS:
                return f"unsupported command: {command}"
            if renderer == "Tex" and dollar_offset is None:
                return "Tex commands must appear inside dollar delimiters"
            commands.append((command, index, end))
            if command in {"left", "right"}:
                delimiter = _latex_delimiter_at(value, end)
                if delimiter is None:
                    return f"{command} requires a supported delimiter"
                delimiter_token, _ = delimiter
                if command == "left":
                    if delimiter_token != "." and delimiter_token not in LEFT_DELIMITER_MATCH:
                        return "left has an invalid opening delimiter"
                    left_commands.append((index, delimiter_token, len(braces), dollar_offset))
                else:
                    if delimiter_token != "." and delimiter_token not in LEFT_DELIMITER_MATCH.values():
                        return "right has an invalid closing delimiter"
                    if not left_commands:
                        return "right has no preceding left"
                    _, left_delimiter, left_brace_depth, left_dollar_scope = left_commands.pop()
                    if left_brace_depth != len(braces) or left_dollar_scope != dollar_offset:
                        return "right crosses a brace or Tex math-segment boundary"
                    if (
                        left_delimiter != "."
                        and delimiter_token != "."
                        and LEFT_DELIMITER_MATCH.get(left_delimiter) != delimiter_token
                    ):
                        return "left and right delimiters do not match"
            index = end
            continue
        if character == "{":
            if renderer == "Tex" and dollar_offset is None:
                return "raw Tex opening braces must be escaped"
            braces.append(index)
        elif character == "}":
            if renderer == "Tex" and dollar_offset is None:
                return "raw Tex closing braces must be escaped"
            if not braces:
                return "unexpected closing brace"
            scoped_left = next(
                (
                    left
                    for left in left_commands
                    if left[2] == len(braces) and left[3] == dollar_offset
                ),
                None,
            )
            if scoped_left is not None:
                return "brace closes before the matching right command"
            braces.pop()
        elif character in {"^", "_"}:
            if renderer == "Tex" and dollar_offset is None:
                return "Tex math markers must appear inside dollar delimiters"
            next_character = value[index + 1] if index + 1 < len(value) else None
            if next_character is None or next_character in {"}", "$", "^", "_"} or next_character.isspace():
                return "math marker is missing an argument"
        elif character in {"#", "%", "&"}:
            return "raw LaTeX special character must be escaped"
        elif character == "$":
            if renderer == "MathTex":
                return "MathTex content cannot include dollar delimiters"
            if index + 1 < len(value) and value[index + 1] == "$":
                return "double dollar delimiters are unsupported"
            if dollar_offset is None:
                dollar_offset = index
            else:
                if any(left[3] == dollar_offset for left in left_commands):
                    return "Tex math segment closes before the matching right command"
                dollar_offset = None
        elif renderer == "Tex" and dollar_offset is None:
            if not (character.isascii() and character.isalnum()) and character not in "\t\n\r" and character not in TEX_PLAIN_TEXT_PUNCTUATION:
                return "Tex plain text contains an unsupported character"
        index += 1

    if braces:
        return "content has an unclosed opening brace"
    if left_commands:
        return "left has no following right"
    if dollar_offset is not None:
        return "Tex content has an unclosed dollar delimiter"
    script_error = _script_structure_error(value)
    if script_error:
        return script_error
    for command, command_start, command_end in commands:
        argument_error = _command_arguments_error(value, command, command_start, command_end)
        if argument_error:
            return argument_error
    return None


def _is_safe_latex(value: str, renderer: str = "MathTex") -> bool:
    return _latex_dialect_error(value, renderer) is None


def _is_exact_cubic_bezier_helper(node: ast.stmt) -> bool:
    return (
        isinstance(node, ast.FunctionDef)
        and ast.dump(node, include_attributes=False)
        == ast.dump(PROOFCANVAS_CUBIC_BEZIER_HELPER_AST, include_attributes=False)
    )


def _validate_structure(tree: ast.Module) -> None:
    if len(tree.body) not in {3, 4}:
        raise SourcePolicyError("Generated source must contain two imports, one optional exact compiler helper, and one scene class")
    manim_import, math_import = tree.body[:2]
    scene_class = tree.body[-1]
    helpers = tree.body[2:-1]
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
    if helpers and (len(helpers) != 1 or not _is_exact_cubic_bezier_helper(helpers[0])):
        raise SourcePolicyError("Generated source has an altered or unsupported compiler helper")
    if not (
        isinstance(scene_class, ast.ClassDef)
        and scene_class.name == "GeneratedScene"
        and not scene_class.decorator_list
        and len(scene_class.bases) == 1
        and isinstance(scene_class.bases[0], ast.Name)
        and scene_class.bases[0].id == "MovingCameraScene"
        and not scene_class.keywords
        and not scene_class.type_params
        and len(scene_class.body) == 1
    ):
        raise SourcePolicyError("Generated source must define only GeneratedScene")
    construct = scene_class.body[0]
    if not (
        isinstance(construct, ast.FunctionDef)
        and construct.name == "construct"
        and not construct.decorator_list
        and not construct.args.posonlyargs
        and len(construct.args.args) == 1
        and construct.args.args[0].arg == "self"
        and construct.args.args[0].annotation is None
        and construct.args.args[0].type_comment is None
        and construct.args.vararg is None
        and construct.args.kwarg is None
        and not construct.args.kwonlyargs
        and not construct.args.kw_defaults
        and not construct.args.defaults
        and construct.returns is None
        and construct.type_comment is None
        and not construct.type_params
    ):
        raise SourcePolicyError("GeneratedScene must expose only construct(self)")


def _validate_nodes(tree: ast.Module) -> None:
    manim_import, math_import = tree.body[:2]
    scene_class = tree.body[-1]
    helpers = tree.body[2:-1]
    assert isinstance(scene_class, ast.ClassDef)
    construct = scene_class.body[0]
    helper_node_ids = {id(node) for helper in helpers for node in ast.walk(helper)}
    permitted_definitions = {id(manim_import), id(math_import), id(scene_class), id(construct), *(id(helper) for helper in helpers)}
    permitted_statements = permitted_definitions | {
        id(statement)
        for statement in construct.body
        if isinstance(statement, (ast.Assign, ast.Expr))
    }
    assigned = {
        node.id
        for node in ast.walk(construct)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)
    }
    shadowed = sorted(assigned & RESERVED_CONSTRUCT_BINDINGS)
    if shadowed:
        raise SourcePolicyError(f"Generated source shadows a reserved compiler name: {shadowed[0]}")
    helper_names = {helper.name for helper in helpers if isinstance(helper, ast.FunctionDef)}
    permitted_loads = (
        assigned
        | ALLOWED_CONSTANT_NAMES
        | ALLOWED_CONSTRUCTORS
        | helper_names
        | {"MovingCameraScene", "config", "math", "rate_functions", "self", "x"}
    )
    parents = {id(child): parent for parent in ast.walk(construct) for child in ast.iter_child_nodes(parent)}
    approved_sensitive_call_ids: set[int] = set()
    approved_animation_call_ids: set[int] = set()
    approved_mobject_constructor_call_ids: set[int] = set()
    approved_utility_call_ids: set[int] = set()
    if any(isinstance(node, ast.Starred) for node in ast.walk(construct)):
        raise SourcePolicyError("Generated source contains forbidden syntax: Starred")

    def direct_number(node: ast.expr) -> float | None:
        value: object
        if isinstance(node, ast.Constant):
            value = node.value
        elif (
            isinstance(node, ast.UnaryOp)
            and isinstance(node.op, (ast.USub, ast.UAdd))
            and isinstance(node.operand, ast.Constant)
            and isinstance(node.operand.value, (int, float))
            and not isinstance(node.operand.value, bool)
        ):
            value = -node.operand.value if isinstance(node.op, ast.USub) else node.operand.value
        else:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        return float(value)

    def literal_graph_decorator(receiver: ast.expr, attribute_name: str) -> ast.Call | None:
        attribute = parents.get(id(receiver))
        if not (
            isinstance(attribute, ast.Attribute)
            and attribute.value is receiver
            and attribute.attr == attribute_name
        ):
            return None
        call = parents.get(id(attribute))
        if not (isinstance(call, ast.Call) and call.func is attribute):
            return None
        return call

    def validate_literal_graph_assignment(geometry: ast.Call) -> None:
        stroke_call = literal_graph_decorator(geometry, "set_stroke")
        if stroke_call is None:
            raise SourcePolicyError("Literal graph geometry requires the exact compiler set_stroke assignment")
        if (
            len(stroke_call.args) != 1
            or not isinstance(stroke_call.args[0], ast.Constant)
            or not isinstance(stroke_call.args[0].value, str)
            or not HEX_COLOR_PATTERN.fullmatch(stroke_call.args[0].value)
            or len(stroke_call.keywords) != 1
            or stroke_call.keywords[0].arg != "width"
        ):
            raise SourcePolicyError("Literal graph set_stroke arguments are outside the compiler dialect")
        stroke_width = direct_number(stroke_call.keywords[0].value)
        if stroke_width is None or not 0 <= stroke_width <= MAX_LITERAL_GRAPH_STROKE_WIDTH:
            raise SourcePolicyError("Literal graph stroke width is outside the compiler bounds")
        approved_sensitive_call_ids.add(id(stroke_call))

        decorated: ast.expr = stroke_call
        opacity_call = literal_graph_decorator(decorated, "set_opacity")
        if opacity_call is not None:
            if opacity_call.keywords or len(opacity_call.args) != 1:
                raise SourcePolicyError("Literal graph set_opacity arguments are outside the compiler dialect")
            opacity = direct_number(opacity_call.args[0])
            if opacity is None or not 0 <= opacity <= 1:
                raise SourcePolicyError("Literal graph opacity is outside the compiler bounds")
            approved_sensitive_call_ids.add(id(opacity_call))
            decorated = opacity_call

        assignment = parents.get(id(decorated))
        if not (
            isinstance(assignment, ast.Assign)
            and assignment.value is decorated
            and len(assignment.targets) == 1
            and isinstance(assignment.targets[0], ast.Name)
        ):
            raise SourcePolicyError("Literal graph geometry must be rooted in one direct compiler assignment")

    literal_segment_calls = [
        node
        for node in ast.walk(construct)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "set_points_as_corners"
    ]
    literal_geometries: dict[int, ast.Call] = {}
    total_literal_points = 0
    for call in literal_segment_calls:
        receiver = call.func.value
        if not (
            isinstance(receiver, ast.Call)
            and isinstance(receiver.func, ast.Name)
            and receiver.func.id == "VMobject"
            and not receiver.args
            and not receiver.keywords
        ):
            raise SourcePolicyError("Literal graph segments require a direct empty VMobject receiver")
        parent = parents.get(id(call))
        if not (
            isinstance(parent, ast.Call)
            and isinstance(parent.func, ast.Name)
            and parent.func.id == "VGroup"
            and call in parent.args
            and not parent.keywords
            and parent.args
            and all(
                isinstance(argument, ast.Call)
                and isinstance(argument.func, ast.Attribute)
                and argument.func.attr == "set_points_as_corners"
                for argument in parent.args
            )
        ):
            raise SourcePolicyError("Literal graph segments are allowed only as direct VGroup arguments")
        literal_geometries[id(parent)] = parent
        if call.keywords or len(call.args) != 1 or not isinstance(call.args[0], ast.List):
            raise SourcePolicyError("Literal graph segments require one direct point list")
        points = call.args[0].elts
        if not 2 <= len(points) <= MAX_LITERAL_GRAPH_POINTS:
            raise SourcePolicyError("Literal graph segments contain an invalid point count")
        total_literal_points += len(points)
        for point in points:
            if not isinstance(point, ast.List) or len(point.elts) != 3:
                raise SourcePolicyError("Literal graph points must be direct three-coordinate lists")
            coordinates = [direct_number(coordinate) for coordinate in point.elts]
            if any(coordinate is None for coordinate in coordinates):
                raise SourcePolicyError("Literal graph coordinates must be direct finite numeric literals")
            x, y, z = coordinates
            assert x is not None and y is not None and z is not None
            if abs(x) > MAX_LITERAL_GRAPH_COORDINATE or abs(y) > MAX_LITERAL_GRAPH_COORDINATE or z != 0:
                raise SourcePolicyError("Literal graph coordinates are outside the compiler geometry envelope")
    if len(literal_geometries) > MAX_LITERAL_GRAPH_GEOMETRIES:
        raise SourcePolicyError("Generated source contains too many literal graph geometries")
    if total_literal_points > MAX_LITERAL_GRAPH_TOTAL_POINTS:
        raise SourcePolicyError("Generated source contains too many literal graph points")
    for geometry in literal_geometries.values():
        if len(geometry.args) > MAX_LITERAL_GRAPH_SEGMENTS:
            raise SourcePolicyError("A literal graph contains too many segments")
        geometry_points = sum(len(argument.args[0].elts) for argument in geometry.args)
        if geometry_points > MAX_LITERAL_GRAPH_POINTS:
            raise SourcePolicyError("A literal graph contains too many sampled points")
        validate_literal_graph_assignment(geometry)
        approved_mobject_constructor_call_ids.add(id(geometry))

    literal_segment_call_ids = {id(call) for call in literal_segment_calls}
    approved_sensitive_call_ids.update(literal_segment_call_ids)
    approved_mobject_constructor_call_ids.update(
        id(call.func.value)
        for call in literal_segment_calls
        if isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Call)
    )

    rate_lambda_ids: set[int] = set()
    rate_call_ids: set[int] = set()
    rate_helper_load_ids: set[int] = set()
    for node in ast.walk(construct):
        if not isinstance(node, ast.Lambda):
            continue
        if (
            node.args.posonlyargs
            or len(node.args.args) != 1
            or node.args.args[0].arg != "x"
            or node.args.args[0].annotation is not None
            or node.args.args[0].type_comment is not None
            or node.args.vararg is not None
            or node.args.kwarg is not None
            or node.args.kwonlyargs
            or node.args.kw_defaults
            or node.args.defaults
        ):
            raise SourcePolicyError("Restricted lambdas must accept only x")
        if isinstance(node.body, ast.Call) and isinstance(node.body.func, ast.Name) and node.body.func.id == "proofcanvas_cubic_bezier":
            if "proofcanvas_cubic_bezier" not in helper_names:
                raise SourcePolicyError("Custom easing lambda requires the exact compiler helper")
            lambda_parent = parents.get(id(node))
            rate_call = parents.get(id(lambda_parent)) if isinstance(lambda_parent, ast.keyword) else None
            if not (
                isinstance(lambda_parent, ast.keyword)
                and lambda_parent.arg == "rate_func"
                and isinstance(rate_call, ast.Call)
                and isinstance(rate_call.func, ast.Name)
                and rate_call.func.id == "Transform"
            ):
                raise SourcePolicyError("Custom easing lambda is allowed only as a Transform rate_func")
            if node.body.keywords or len(node.body.args) != 5 or not isinstance(node.body.args[0], ast.Name) or node.body.args[0].id != "x":
                raise SourcePolicyError("Custom easing lambda is outside the compiler dialect")
            numeric_values: list[float] = []
            for argument in node.body.args[1:]:
                value: object
                if isinstance(argument, ast.Constant):
                    value = argument.value
                elif (
                    isinstance(argument, ast.UnaryOp)
                    and isinstance(argument.op, (ast.USub, ast.UAdd))
                    and isinstance(argument.operand, ast.Constant)
                    and isinstance(argument.operand.value, (int, float))
                    and not isinstance(argument.operand.value, bool)
                ):
                    value = -argument.operand.value if isinstance(argument.op, ast.USub) else argument.operand.value
                else:
                    raise SourcePolicyError("Custom easing arguments must be direct numeric literals")
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise SourcePolicyError("Custom easing arguments must be finite numeric literals")
                numeric_values.append(float(value))
            x1, y1, x2, y2 = numeric_values
            if not (0 <= x1 <= 1 and 0 <= x2 <= 1 and -4 <= y1 <= 4 and -4 <= y2 <= 4):
                raise SourcePolicyError("Custom easing arguments exceed the schema bounds")
            rate_lambda_ids.add(id(node))
            rate_call_ids.add(id(node.body))
            rate_helper_load_ids.add(id(node.body.func))
            continue
        raise SourcePolicyError("Only exact compiler custom-easing lambdas are allowed")
    if len(rate_lambda_ids) > MAX_RATE_LAMBDAS:
        raise SourcePolicyError("Generated source contains too many custom easing lambdas")

    def method_chain(expression: ast.expr) -> tuple[ast.expr, list[tuple[str, ast.Call]]]:
        methods: list[tuple[str, ast.Call]] = []
        receiver = expression
        while isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Attribute):
            methods.append((receiver.func.attr, receiver))
            receiver = receiver.func.value
        methods.reverse()
        return receiver, methods

    def direct_hex(node: ast.expr) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and HEX_COLOR_PATTERN.fullmatch(node.value):
            return node.value
        return None

    def receiver_parts(node: ast.expr) -> list[str]:
        if isinstance(node, ast.Name):
            return [node.id]
        if isinstance(node, ast.Attribute):
            return _attribute_parts(node)
        return []

    def bounded_number(node: ast.expr, minimum: float, maximum: float, message: str) -> float:
        value = direct_number(node)
        if value is None or not minimum <= value <= maximum:
            raise SourcePolicyError(message)
        return value

    def bounded_nonzero_magnitude(node: ast.expr, minimum: float, maximum: float, message: str) -> float:
        value = direct_number(node)
        if value is None or not minimum <= abs(value) <= maximum:
            raise SourcePolicyError(message)
        return value

    def validate_vector(node: ast.expr, maximum: float, message: str) -> None:
        if not isinstance(node, ast.List) or len(node.elts) != 3:
            raise SourcePolicyError(message)
        coordinates = [direct_number(coordinate) for coordinate in node.elts]
        if any(coordinate is None for coordinate in coordinates):
            raise SourcePolicyError(message)
        x_value, y_value, z_value = coordinates
        assert x_value is not None and y_value is not None and z_value is not None
        if abs(x_value) > maximum or abs(y_value) > maximum or z_value != 0:
            raise SourcePolicyError(message)

    def validate_rotation(node: ast.expr, maximum: float, message: str) -> None:
        if not (
            isinstance(node, ast.BinOp)
            and isinstance(node.op, ast.Mult)
            and isinstance(node.right, ast.Name)
            and node.right.id == "DEGREES"
        ):
            raise SourcePolicyError(message)
        bounded_number(node.left, -maximum, maximum, message)

    def validate_style_method(name: str, call: ast.Call) -> None:
        if name == "set_color":
            if call.keywords or len(call.args) != 1 or direct_hex(call.args[0]) is None:
                raise SourcePolicyError("Compiler set_color arguments are outside the exact dialect")
        elif name == "set_fill":
            if (
                len(call.args) != 1
                or direct_hex(call.args[0]) is None
                or len(call.keywords) != 1
                or call.keywords[0].arg != "opacity"
                or direct_number(call.keywords[0].value) != 1
            ):
                raise SourcePolicyError("Compiler set_fill arguments are outside the exact dialect")
        elif name == "set_stroke":
            if (
                len(call.args) != 1
                or direct_hex(call.args[0]) is None
                or len(call.keywords) != 1
                or call.keywords[0].arg != "width"
            ):
                raise SourcePolicyError("Compiler set_stroke arguments are outside the exact dialect")
            bounded_number(call.keywords[0].value, 0, MAX_LITERAL_GRAPH_STROKE_WIDTH, "Compiler stroke width is outside the schema bounds")
        elif name == "set_opacity":
            if call.keywords or len(call.args) != 1:
                raise SourcePolicyError("Compiler set_opacity arguments are outside the exact dialect")
            bounded_number(call.args[0], 0, 1, "Compiler opacity is outside the schema bounds")
        else:  # pragma: no cover - callers use the fixed compiler style set
            raise SourcePolicyError("Generated source contains an unsupported style method")

    def validate_text_constructor(call: ast.Call, maximum_chars: int = MAX_TEXT_CONTENT_CHARS) -> None:
        if (
            len(call.args) != 1
            or not isinstance(call.args[0], ast.Constant)
            or not isinstance(call.args[0].value, str)
            or len(call.args[0].value) > maximum_chars
            or [keyword.arg for keyword in call.keywords] != ["font_size"]
        ):
            raise SourcePolicyError("Text arguments are outside the exact compiler dialect")
        bounded_number(call.keywords[0].value, 1, 256, "Text font size is outside the schema bounds")

    def validate_linear_constructor(call: ast.Call, *, arrow: bool = False, brace: bool = False) -> None:
        expected_keywords = ["buff"] if arrow else ["direction"] if brace else []
        if len(call.args) != 2 or [keyword.arg for keyword in call.keywords] != expected_keywords:
            raise SourcePolicyError("Linear primitive arguments are outside the exact compiler dialect")
        for endpoint in call.args:
            validate_vector(endpoint, MAX_DIRECT_MANIM_DIMENSION / 2, "Linear primitive endpoints are outside the compiler bounds")
        start = call.args[0]
        end = call.args[1]
        assert isinstance(start, ast.List) and isinstance(end, ast.List)
        start_x = direct_number(start.elts[0])
        end_x = direct_number(end.elts[0])
        if (
            start_x is None
            or end_x is None
            or not MIN_DIRECT_MANIM_DIMENSION / 2 <= end_x <= MAX_DIRECT_MANIM_DIMENSION / 2
            or start_x != -end_x
            or direct_number(start.elts[1]) != 0
            or direct_number(end.elts[1]) != 0
        ):
            raise SourcePolicyError("Linear primitive endpoints are outside the exact compiler dialect")
        if arrow and direct_number(call.keywords[0].value) != 0:
            raise SourcePolicyError("Arrow buff is outside the exact compiler dialect")
        if brace and not (isinstance(call.keywords[0].value, ast.Name) and call.keywords[0].value.id == "DOWN"):
            raise SourcePolicyError("Brace direction is outside the exact compiler dialect")

    def validate_axes_range(node: ast.expr, name: str) -> None:
        if not isinstance(node, ast.List) or len(node.elts) != 3:
            raise SourcePolicyError(f"Axes {name} is outside the exact compiler dialect")
        minimum = bounded_number(node.elts[0], -MAX_LITERAL_GRAPH_COORDINATE, MAX_LITERAL_GRAPH_COORDINATE, f"Axes {name} is outside the compiler bounds")
        maximum = bounded_number(node.elts[1], -MAX_LITERAL_GRAPH_COORDINATE, MAX_LITERAL_GRAPH_COORDINATE, f"Axes {name} is outside the compiler bounds")
        if minimum >= maximum or direct_number(node.elts[2]) != 1:
            raise SourcePolicyError(f"Axes {name} is outside the exact compiler dialect")

    def validate_object_constructor(root: ast.Call, methods: list[tuple[str, ast.Call]], known_objects: set[str]) -> tuple[str, int]:
        assert isinstance(root.func, ast.Name)
        constructor = root.func.id
        if constructor == "Text":
            validate_text_constructor(root)
        elif constructor in {"MathTex", "Tex"}:
            if (
                len(root.args) != 1
                or not isinstance(root.args[0], ast.Constant)
                or not isinstance(root.args[0].value, str)
            ):
                raise SourcePolicyError(f"{constructor} content is outside the safe compiler dialect")
            if not _is_safe_latex(root.args[0].value, constructor):
                raise SourcePolicyError(f"{constructor} content is outside the safe compiler dialect")
            if [keyword.arg for keyword in root.keywords] != ["font_size"]:
                raise SourcePolicyError(f"{constructor} arguments are outside the compiler dialect")
            bounded_number(root.keywords[0].value, 1, 256, f"{constructor} arguments are outside the compiler dialect")
        elif constructor == "Rectangle":
            if root.args or [keyword.arg for keyword in root.keywords] != ["width", "height"]:
                raise SourcePolicyError("Rectangle arguments are outside the exact compiler dialect")
            for keyword in root.keywords:
                bounded_number(
                    keyword.value,
                    MIN_DIRECT_MANIM_DIMENSION,
                    MAX_DIRECT_MANIM_DIMENSION,
                    "Rectangle dimensions are outside the compiler bounds",
                )
        elif constructor == "Circle":
            if root.args or [keyword.arg for keyword in root.keywords] != ["radius"] or direct_number(root.keywords[0].value) != 1:
                raise SourcePolicyError("Circle arguments are outside the exact compiler dialect")
            if len(methods) < 2 or [name for name, _ in methods[:2]] != ["stretch_to_fit_width", "stretch_to_fit_height"]:
                raise SourcePolicyError("Circle dimensions require the exact compiler fit chain")
            for expected_name, (name, call) in zip(("stretch_to_fit_width", "stretch_to_fit_height"), methods[:2], strict=True):
                if name != expected_name or call.keywords or len(call.args) != 1:
                    raise SourcePolicyError("Circle dimensions are outside the exact compiler dialect")
                bounded_number(
                    call.args[0],
                    MIN_DIRECT_MANIM_DIMENSION,
                    MAX_DIRECT_MANIM_DIMENSION,
                    "Circle dimensions are outside the compiler bounds",
                )
                approved_sensitive_call_ids.add(id(call))
            return "leaf", 2
        elif constructor == "Line":
            validate_linear_constructor(root)
        elif constructor == "Arrow":
            validate_linear_constructor(root, arrow=True)
        elif constructor == "Axes":
            if root.args or [keyword.arg for keyword in root.keywords] != ["x_range", "y_range", "x_length", "y_length", "tips"]:
                raise SourcePolicyError("Axes arguments are outside the exact compiler dialect")
            validate_axes_range(root.keywords[0].value, "x_range")
            validate_axes_range(root.keywords[1].value, "y_range")
            bounded_number(root.keywords[2].value, MIN_DIRECT_MANIM_DIMENSION, MAX_DIRECT_MANIM_DIMENSION, "Axes x_length is outside the compiler bounds")
            bounded_number(root.keywords[3].value, MIN_DIRECT_MANIM_DIMENSION, MAX_DIRECT_MANIM_DIMENSION, "Axes y_length is outside the compiler bounds")
            if not (isinstance(root.keywords[4].value, ast.Constant) and root.keywords[4].value.value is False):
                raise SourcePolicyError("Axes tips are outside the exact compiler dialect")
        elif constructor in {"Group", "VGroup"}:
            if root.keywords or not root.args or len(root.args) > MAX_OBJECTS_PER_SHOT:
                raise SourcePolicyError("Compiler group arguments are outside the exact dialect")
            if not all(isinstance(argument, ast.Name) and argument.id in known_objects for argument in root.args):
                raise SourcePolicyError("Compiler group bindings require proven direct object names")
            if methods:
                raise SourcePolicyError("Compiler group bindings cannot contain post-construction decorators")
            return "group", 0
        elif constructor == "VMobject":
            if root.args or root.keywords:
                raise SourcePolicyError("VMobject arguments are outside the exact compiler dialect")
        else:
            raise SourcePolicyError("Generated source contains an unsupported object constructor")
        return "leaf", 0

    def validate_brace_label_shift(call: ast.Call, assignment_root: ast.Call) -> None:
        if call.keywords or len(call.args) != 1:
            raise SourcePolicyError("Brace label shift is outside the exact compiler dialect")
        root, methods = method_chain(call)
        if (
            not isinstance(root, ast.Call)
            or not isinstance(root.func, ast.Name)
            or root.func.id != "Text"
            or [name for name, _ in methods] != ["shift"]
        ):
            raise SourcePolicyError("Brace label shift requires the direct compiler Text receiver")
        offset = call.args[0]
        if not (
            isinstance(offset, ast.BinOp)
            and isinstance(offset.op, ast.Mult)
            and isinstance(offset.left, ast.Name)
            and offset.left.id == "DOWN"
            and direct_number(offset.right) == 0.45
            and isinstance(assignment_root.func, ast.Name)
            and assignment_root.func.id == "VGroup"
            and len(assignment_root.args) == 2
            and assignment_root.args[1] is call
            and isinstance(assignment_root.args[0], ast.Call)
            and isinstance(assignment_root.args[0].func, ast.Name)
            and assignment_root.args[0].func.id == "BraceBetweenPoints"
        ):
            raise SourcePolicyError("Brace label shift is outside the exact compiler dialect")
        assert isinstance(root, ast.Call)
        validate_text_constructor(root, MAX_BRACE_LABEL_CHARS)
        brace = assignment_root.args[0]
        assert isinstance(brace, ast.Call)
        validate_linear_constructor(brace, brace=True)
        approved_mobject_constructor_call_ids.update({id(root), id(brace)})
        approved_sensitive_call_ids.add(id(call))

    def validate_initialization_expression(expression: ast.expr, known_objects: set[str]) -> str | None:
        root, methods = method_chain(expression)
        if not (isinstance(root, ast.Call) and isinstance(root.func, ast.Name) and root.func.id in MOBJECT_CONSTRUCTORS):
            return None
        approved_mobject_constructor_call_ids.add(id(root))

        if id(root) in literal_geometries:
            return "leaf"

        for nested in ast.walk(root):
            if (
                isinstance(nested, ast.Call)
                and isinstance(nested.func, ast.Attribute)
                and nested.func.attr == "shift"
            ):
                validate_brace_label_shift(nested, root)

        brace_group = (
            root.func.id == "VGroup"
            and not root.keywords
            and len(root.args) == 2
            and isinstance(root.args[0], ast.Call)
            and isinstance(root.args[0].func, ast.Name)
            and root.args[0].func.id == "BraceBetweenPoints"
            and isinstance(root.args[1], ast.Call)
            and isinstance(root.args[1].func, ast.Attribute)
            and root.args[1].func.attr == "shift"
        )
        if brace_group:
            if not any(
                isinstance(nested, ast.Call)
                and isinstance(nested.func, ast.Attribute)
                and nested.func.attr == "shift"
                for nested in ast.walk(root)
            ):
                raise SourcePolicyError("Brace aggregate is outside the exact compiler dialect")
            kind, method_index = "leaf", 0
        else:
            kind, method_index = validate_object_constructor(root, methods, known_objects)

        style_order = {"set_color": 0, "set_fill": 1, "set_stroke": 2, "set_opacity": 3}
        last_style = -1
        for name, call in methods[method_index:]:
            position = style_order.get(name)
            if position is None or position <= last_style:
                raise SourcePolicyError("Object initialization decorators are outside the exact compiler order")
            validate_style_method(name, call)
            approved_sensitive_call_ids.add(id(call))
            last_style = position
        return kind

    def validate_camera_dimension(node: ast.expr, attribute_name: str) -> float:
        if not (
            isinstance(node, ast.BinOp)
            and isinstance(node.op, ast.Div)
            and isinstance(node.left, ast.Attribute)
            and _attribute_parts(node.left) == ["config", attribute_name]
        ):
            raise SourcePolicyError("Camera frame dimensions are outside the exact compiler dialect")
        return bounded_number(node.right, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM, "Camera zoom is outside the schema bounds")

    def validate_camera_target(expression: ast.expr) -> None:
        root, methods = method_chain(expression)
        if (
            not isinstance(root, ast.Call)
            or not isinstance(root.func, ast.Name)
            or root.func.id != "Rectangle"
            or root.args
            or [keyword.arg for keyword in root.keywords] != ["width", "height"]
            or [name for name, _ in methods] != ["move_to", "rotate"]
        ):
            raise SourcePolicyError("Camera frame target is outside the exact compiler dialect")
        width_zoom = validate_camera_dimension(root.keywords[0].value, "frame_width")
        height_zoom = validate_camera_dimension(root.keywords[1].value, "frame_height")
        if width_zoom != height_zoom:
            raise SourcePolicyError("Camera frame dimensions must use the same compiler zoom")
        approved_mobject_constructor_call_ids.add(id(root))
        move_call = methods[0][1]
        rotate_call = methods[1][1]
        if move_call.keywords or len(move_call.args) != 1:
            raise SourcePolicyError("Camera frame position is outside the exact compiler dialect")
        validate_vector(move_call.args[0], MAX_DIRECT_MANIM_COORDINATE, "Camera frame position is outside the compiler bounds")
        if rotate_call.keywords or len(rotate_call.args) != 1:
            raise SourcePolicyError("Camera frame rotation is outside the exact compiler dialect")
        validate_rotation(rotate_call.args[0], MAX_DIRECT_ROTATION, "Camera frame rotation is outside the compiler bounds")
        approved_sensitive_call_ids.update({id(move_call), id(rotate_call)})

    def validate_direct_scale(call: ast.Call, object_name: str) -> None:
        if call.keywords or len(call.args) != 1:
            raise SourcePolicyError("Text fit scale is outside the exact compiler dialect")
        minimum = call.args[0]
        if not (
            isinstance(minimum, ast.Call)
            and isinstance(minimum.func, ast.Name)
            and minimum.func.id == "min"
            and not minimum.keywords
            and len(minimum.args) == 2
        ):
            raise SourcePolicyError("Text fit scale is outside the exact compiler dialect")
        for quotient, dimension in zip(minimum.args, ("width", "height"), strict=True):
            if not (
                isinstance(quotient, ast.BinOp)
                and isinstance(quotient.op, ast.Div)
                and isinstance(quotient.right, ast.Call)
                and isinstance(quotient.right.func, ast.Name)
                and quotient.right.func.id == "max"
                and not quotient.right.keywords
                and len(quotient.right.args) == 2
                and isinstance(quotient.right.args[0], ast.Attribute)
                and _attribute_parts(quotient.right.args[0]) == [object_name, dimension]
                and direct_number(quotient.right.args[1]) == 0.001
            ):
                raise SourcePolicyError("Text fit scale must read the same compiler object dimensions")
            bounded_number(
                quotient.left,
                MIN_DIRECT_MANIM_DIMENSION,
                MAX_DIRECT_MANIM_DIMENSION,
                "Text fit dimensions are outside the compiler bounds",
            )
            assert isinstance(quotient, ast.BinOp) and isinstance(quotient.right, ast.Call)
            approved_utility_call_ids.add(id(quotient.right))
        approved_utility_call_ids.add(id(minimum))

    def validate_direct_object_call(call: ast.Call, object_name: str) -> str:
        root, methods = method_chain(call)
        if not isinstance(root, ast.Name) or root.id != object_name:
            raise SourcePolicyError("Direct object mutation requires the current compiler object")
        names = [name for name, _ in methods]
        if names == ["move_to"]:
            if call.keywords or len(call.args) != 1:
                raise SourcePolicyError("Object position is outside the exact compiler dialect")
            validate_vector(call.args[0], MAX_DIRECT_MANIM_COORDINATE, "Object position is outside the compiler bounds")
            operation = "move"
        elif names == ["rotate"]:
            if call.keywords or len(call.args) != 1:
                raise SourcePolicyError("Object rotation is outside the exact compiler dialect")
            validate_rotation(call.args[0], MAX_DIRECT_ROTATION, "Object rotation is outside the compiler bounds")
            operation = "rotate"
        elif names == ["stretch", "stretch"]:
            for (name, stretch_call), axis in zip(methods, (0, 1), strict=True):
                assert name == "stretch"
                if stretch_call.keywords or len(stretch_call.args) != 2 or direct_number(stretch_call.args[1]) != axis:
                    raise SourcePolicyError("Object scale stretch is outside the exact compiler dialect")
                bounded_nonzero_magnitude(
                    stretch_call.args[0],
                    MIN_AUTHORED_SCALE_MAGNITUDE,
                    MAX_AUTHORED_SCALE_MAGNITUDE,
                    "Object scale is outside the schema bounds",
                )
            operation = "stretch"
        elif names in (["scale_to_fit_width"], ["scale_to_fit_height"]):
            if call.keywords or len(call.args) != 1:
                raise SourcePolicyError("Object fit dimension is outside the exact compiler dialect")
            bounded_number(
                call.args[0],
                MIN_DIRECT_MANIM_DIMENSION,
                MAX_DIRECT_MANIM_DIMENSION,
                "Object fit dimension is outside the compiler bounds",
            )
            operation = "dimension"
        elif names in (
            ["stretch_to_fit_width"],
            ["stretch_to_fit_height"],
            ["stretch_to_fit_width", "stretch_to_fit_height"],
        ):
            for _, fit_call in methods:
                if fit_call.keywords or len(fit_call.args) != 1:
                    raise SourcePolicyError("Object stretch-to-fit dimension is outside the exact compiler dialect")
                bounded_number(
                    fit_call.args[0],
                    MIN_DIRECT_MANIM_DIMENSION,
                    MAX_DIRECT_MANIM_DIMENSION,
                    "Object stretch-to-fit dimension is outside the compiler bounds",
                )
            operation = "dimension"
        elif names == ["scale"]:
            validate_direct_scale(call, object_name)
            operation = "dimension"
        elif names == ["set_opacity"]:
            if call.keywords or len(call.args) != 1 or direct_number(call.args[0]) != 0:
                raise SourcePolicyError("Direct compiler opacity mutation must be exact zero")
            operation = "opacity"
        else:
            raise SourcePolicyError("Generated source contains a noncompiler direct object mutation")
        approved_sensitive_call_ids.update(id(method_call) for _, method_call in methods)
        return operation

    def validate_copy_target(expression: ast.expr, references: dict[str, str]) -> str:
        root, methods = method_chain(expression)
        if not isinstance(root, ast.Name) or root.id not in references or not methods or methods[0][0] != "copy":
            raise SourcePolicyError("Transform targets require an exact compiler reference copy")
        copy_call = methods[0][1]
        if copy_call.args or copy_call.keywords:
            raise SourcePolicyError("Compiler reference copy cannot accept arguments")
        approved_sensitive_call_ids.add(id(copy_call))
        index = 1

        if index < len(methods) and methods[index][0] in {"stretch", "stretch_to_fit_width"}:
            name, geometry_call = methods[index]
            if geometry_call.keywords:
                raise SourcePolicyError("Horizontal copy geometry is outside the exact compiler dialect")
            if name == "stretch":
                if len(geometry_call.args) != 2 or direct_number(geometry_call.args[1]) != 0:
                    raise SourcePolicyError("Horizontal copy stretch requires axis zero")
                bounded_nonzero_magnitude(geometry_call.args[0], MIN_COPY_STRETCH, MAX_COPY_STRETCH, "Horizontal copy stretch is outside the compiler bounds")
            else:
                if len(geometry_call.args) != 1:
                    raise SourcePolicyError("Horizontal copy fit is outside the exact compiler dialect")
                bounded_number(geometry_call.args[0], MIN_COPY_FIT_DIMENSION, MAX_COPY_FIT_DIMENSION, "Horizontal copy fit is outside the compiler bounds")
            approved_sensitive_call_ids.add(id(geometry_call))
            index += 1
            if name == "stretch_to_fit_width" and index < len(methods) and methods[index][0] == "stretch":
                reflection = methods[index][1]
                if reflection.keywords or len(reflection.args) != 2 or direct_number(reflection.args[0]) != -1 or direct_number(reflection.args[1]) != 0:
                    raise SourcePolicyError("Horizontal reflection is outside the exact compiler dialect")
                approved_sensitive_call_ids.add(id(reflection))
                index += 1

        if index < len(methods) and methods[index][0] in {"stretch", "stretch_to_fit_height"}:
            name, geometry_call = methods[index]
            if geometry_call.keywords:
                raise SourcePolicyError("Vertical copy geometry is outside the exact compiler dialect")
            if name == "stretch":
                if len(geometry_call.args) != 2 or direct_number(geometry_call.args[1]) != 1:
                    raise SourcePolicyError("Vertical copy stretch requires axis one")
                bounded_nonzero_magnitude(geometry_call.args[0], MIN_COPY_STRETCH, MAX_COPY_STRETCH, "Vertical copy stretch is outside the compiler bounds")
            else:
                if len(geometry_call.args) != 1:
                    raise SourcePolicyError("Vertical copy fit is outside the exact compiler dialect")
                bounded_number(geometry_call.args[0], MIN_COPY_FIT_DIMENSION, MAX_COPY_FIT_DIMENSION, "Vertical copy fit is outside the compiler bounds")
            approved_sensitive_call_ids.add(id(geometry_call))
            index += 1
            if name == "stretch_to_fit_height" and index < len(methods) and methods[index][0] == "stretch":
                reflection = methods[index][1]
                if reflection.keywords or len(reflection.args) != 2 or direct_number(reflection.args[0]) != -1 or direct_number(reflection.args[1]) != 1:
                    raise SourcePolicyError("Vertical reflection is outside the exact compiler dialect")
                approved_sensitive_call_ids.add(id(reflection))
                index += 1

        if index < len(methods) and methods[index][0] == "rotate":
            rotate_call = methods[index][1]
            if rotate_call.keywords or len(rotate_call.args) != 1:
                raise SourcePolicyError("Copy rotation is outside the exact compiler dialect")
            validate_rotation(rotate_call.args[0], MAX_COPY_ROTATION, "Copy rotation is outside the compiler bounds")
            approved_sensitive_call_ids.add(id(rotate_call))
            index += 1

        if index < len(methods) and methods[index][0] == "move_to":
            move_call = methods[index][1]
            if move_call.keywords or len(move_call.args) != 1:
                raise SourcePolicyError("Copy position is outside the exact compiler dialect")
            validate_vector(move_call.args[0], MAX_DERIVED_NUMERIC_LITERAL, "Copy position is outside the compiler bounds")
            approved_sensitive_call_ids.add(id(move_call))
            index += 1

        for style_name in ("set_fill", "set_stroke"):
            if index < len(methods) and methods[index][0] == style_name:
                validate_style_method(style_name, methods[index][1])
                approved_sensitive_call_ids.add(id(methods[index][1]))
                index += 1
        if index >= len(methods) or methods[index][0] != "set_opacity" or index != len(methods) - 1:
            raise SourcePolicyError("Compiler Transform copy targets require one final opacity setter")
        validate_style_method("set_opacity", methods[index][1])
        approved_sensitive_call_ids.add(id(methods[index][1]))
        return references[root.id]

    def validate_rate_expression(expression: ast.expr) -> None:
        if isinstance(expression, ast.Name) and expression.id in {"linear", "rush_into", "rush_from", "smooth"}:
            return
        if isinstance(expression, ast.Attribute) and tuple(_attribute_parts(expression)) in {
            ("rate_functions", "there_and_back"),
            ("rate_functions", "ease_out_quart"),
            ("rate_functions", "ease_out_back"),
        }:
            return
        if isinstance(expression, ast.Lambda) and id(expression) in rate_lambda_ids:
            return
        raise SourcePolicyError("Animation rate_func is outside the exact compiler dialect")

    def exact_transform_keywords(call: ast.Call) -> tuple[float, ast.expr]:
        if [keyword.arg for keyword in call.keywords] != ["run_time", "rate_func"]:
            raise SourcePolicyError("Transform keywords are outside the exact compiler dialect")
        run_time = bounded_number(call.keywords[0].value, 0, 300, "Transform runtime is outside the compiler bounds")
        rate_func = call.keywords[1].value
        validate_rate_expression(rate_func)
        return run_time, rate_func

    object_names: set[str] = set()
    object_kinds: dict[str, str] = {}
    reference_owners: dict[str, str] = {}
    reference_by_owner: dict[str, str] = {}
    group_children: dict[str, tuple[str, ...]] = {}
    group_constructors: dict[str, str] = {}
    initialization_states: dict[str, dict[str, bool]] = {}
    claimed_bindings: set[str] = set()

    def new_initialization_state() -> dict[str, bool]:
        return {
            "dimension": False,
            "move": False,
            "rotate": False,
            "stretch": False,
            "reference": False,
            "opacity": False,
        }

    def apply_initialization_operation(object_name: str, operation: str) -> None:
        state = initialization_states[object_name]
        if operation == "dimension":
            if any(state.values()):
                raise SourcePolicyError("Object dimension fitting must be the first direct compiler initialization")
        elif operation == "move":
            if state["move"] or state["rotate"] or state["stretch"] or state["reference"] or state["opacity"]:
                raise SourcePolicyError("Object move_to is duplicated or outside the compiler initialization order")
        elif operation == "rotate":
            if not state["move"] or state["rotate"] or state["stretch"] or state["reference"] or state["opacity"]:
                raise SourcePolicyError("Object rotate is outside the compiler initialization order")
        elif operation == "stretch":
            if not state["move"] or state["stretch"] or state["reference"] or state["opacity"]:
                raise SourcePolicyError("Object stretch is outside the compiler initialization order")
        elif operation == "opacity":
            if not state["move"] or state["opacity"]:
                raise SourcePolicyError("Object hidden opacity is outside the compiler initialization order")
        state[operation] = True

    def require_initialized_leaves(names: set[str] | None = None) -> None:
        candidates = object_names if names is None else names
        if any(object_kinds.get(name) == "leaf" and not initialization_states[name]["move"] for name in candidates):
            raise SourcePolicyError("Compiler leaf objects must be positioned before scene operations")

    def validate_transform_target(expression: ast.expr, target_name: str) -> None:
        if object_kinds.get(target_name) == "group":
            expected_constructor = group_constructors.get(target_name)
            expected_children = group_children.get(target_name)
            if (
                expected_constructor is None
                or expected_children is None
                or not isinstance(expression, ast.Call)
                or not isinstance(expression.func, ast.Name)
                or expression.func.id != expected_constructor
                or expression.keywords
                or len(expression.args) != len(expected_children)
            ):
                raise SourcePolicyError("Group Transform targets must preserve the exact compiler hierarchy")
            approved_mobject_constructor_call_ids.add(id(expression))
            for child_expression, child_name in zip(expression.args, expected_children, strict=True):
                if object_kinds.get(child_name) == "group":
                    validate_transform_target(child_expression, child_name)
                else:
                    owner = validate_copy_target(child_expression, reference_owners)
                    if owner != child_name:
                        raise SourcePolicyError("Group Transform target leaves must preserve exact compiler provenance")
            return
        owner = validate_copy_target(expression, reference_owners)
        if owner != target_name:
            raise SourcePolicyError("Transform target copy does not belong to the animated object")

    def validate_transform_call(call: ast.Call) -> None:
        approved_animation_call_ids.add(id(call))
        if len(call.args) != 2:
            raise SourcePolicyError("Transform arguments are outside the exact compiler dialect")
        run_time, rate_func = exact_transform_keywords(call)
        target, expression = call.args
        if isinstance(target, ast.Attribute) and _attribute_parts(target) == ["self", "camera", "frame"]:
            validate_camera_target(expression)
            return
        if not isinstance(target, ast.Name) or target.id not in object_names:
            raise SourcePolicyError("Transform requires a proven compiler object target")
        root, methods = method_chain(expression)
        if (
            isinstance(root, ast.Name)
            and root.id == target.id
            and [name for name, _ in methods] == ["copy", "set_opacity"]
            and methods[0][1].args == []
            and methods[0][1].keywords == []
            and methods[1][1].keywords == []
            and len(methods[1][1].args) == 1
            and direct_number(methods[1][1].args[0]) == 0
            and run_time == 0
            and isinstance(rate_func, ast.Name)
            and rate_func.id == "linear"
        ):
            approved_sensitive_call_ids.update({id(methods[0][1]), id(methods[1][1])})
            return
        validate_transform_target(expression, target.id)

    def validate_empty_animation_group(call: ast.expr) -> None:
        if not (
            isinstance(call, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id == "Group"
            and not call.args
            and not call.keywords
        ):
            raise SourcePolicyError("Animation group metadata is outside the exact compiler dialect")
        assert isinstance(call, ast.Call)
        approved_mobject_constructor_call_ids.add(id(call))

    def validate_animation_expression(expression: ast.expr, depth: int = 0, *, top_level: bool = False) -> None:
        if depth > MAX_ANIMATION_NESTING:
            raise SourcePolicyError("Generated animation nesting exceeds the compiler budget")
        if not isinstance(expression, ast.Call) or not isinstance(expression.func, ast.Name):
            raise SourcePolicyError("self.play requires one exact compiler animation expression")
        constructor = expression.func.id
        if constructor not in ANIMATION_CONSTRUCTORS:
            raise SourcePolicyError("self.play contains a noncompiler animation constructor")
        approved_animation_call_ids.add(id(expression))

        if constructor == "Transform":
            validate_transform_call(expression)
            return
        if constructor == "Wait":
            if top_level or expression.keywords or len(expression.args) != 1:
                raise SourcePolicyError("Wait is outside the exact compiler animation context")
            bounded_number(expression.args[0], 0, 300, "Wait duration is outside the compiler bounds")
            return
        if constructor in {"FadeIn", "Write", "Create"}:
            if (
                len(expression.args) != 1
                or not isinstance(expression.args[0], ast.Name)
                or expression.args[0].id not in object_names
                or [keyword.arg for keyword in expression.keywords] != ["run_time", "rate_func"]
            ):
                raise SourcePolicyError(f"{constructor} arguments are outside the exact compiler dialect")
            bounded_number(expression.keywords[0].value, 0, 300, f"{constructor} runtime is outside the compiler bounds")
            validate_rate_expression(expression.keywords[1].value)
            return
        if constructor == "Indicate":
            if (
                len(expression.args) != 1
                or not isinstance(expression.args[0], ast.Name)
                or expression.args[0].id not in object_names
                or [keyword.arg for keyword in expression.keywords] != ["color", "scale_factor", "run_time", "rate_func"]
                or direct_hex(expression.keywords[0].value) is None
            ):
                raise SourcePolicyError("Indicate arguments are outside the exact compiler dialect")
            bounded_number(expression.keywords[1].value, MIN_AUTHORED_SCALE_MAGNITUDE, MAX_AUTHORED_SCALE_MAGNITUDE, "Indicate scale is outside the schema bounds")
            bounded_number(expression.keywords[2].value, 0, 300, "Indicate runtime is outside the compiler bounds")
            validate_rate_expression(expression.keywords[3].value)
            return
        if constructor == "FadeOut":
            raise SourcePolicyError("FadeOut is not emitted by the current compiler dialect")

        if not 1 <= len(expression.args) <= MAX_ANIMATION_EXPRESSIONS:
            raise SourcePolicyError(f"{constructor} contains an invalid compiler animation count")
        for child in expression.args:
            validate_animation_expression(child, depth + 1)
        keyword_names = [keyword.arg for keyword in expression.keywords]
        if constructor == "Succession":
            if keyword_names != ["group", "run_time"]:
                raise SourcePolicyError("Succession keywords are outside the exact compiler dialect")
            validate_empty_animation_group(expression.keywords[0].value)
            bounded_number(expression.keywords[1].value, 0, 300, "Succession runtime is outside the compiler bounds")
            return
        if keyword_names == ["lag_ratio", "run_time"]:
            if direct_number(expression.keywords[0].value) != 0:
                raise SourcePolicyError("AnimationGroup lag ratio is outside the exact compiler dialect")
            bounded_number(expression.keywords[1].value, 0, 300, "AnimationGroup runtime is outside the compiler bounds")
            return
        if keyword_names == ["group", "lag_ratio", "run_time"]:
            validate_empty_animation_group(expression.keywords[0].value)
            if direct_number(expression.keywords[1].value) != 0:
                raise SourcePolicyError("AnimationGroup lag ratio is outside the exact compiler dialect")
            bounded_number(expression.keywords[2].value, 0, 300, "AnimationGroup runtime is outside the compiler bounds")
            return
        raise SourcePolicyError("AnimationGroup keywords are outside the exact compiler dialect")

    current_object: str | None = None
    noncompiler_name_assignments: list[str] = []
    shot_object_count = 0
    shot_count = 0

    def reset_active_shot_provenance() -> None:
        object_names.clear()
        object_kinds.clear()
        reference_owners.clear()
        reference_by_owner.clear()
        group_children.clear()
        group_constructors.clear()
        initialization_states.clear()

    for statement in construct.body:
        if isinstance(statement, ast.Assign):
            target = statement.targets[0] if len(statement.targets) == 1 else None
            if isinstance(target, ast.Attribute):
                if (
                    _attribute_parts(target) != ["self", "camera", "background_color"]
                    or direct_hex(statement.value) is None
                ):
                    raise SourcePolicyError("Camera background assignment is outside the exact compiler dialect")
                current_object = None
                continue
            if not isinstance(target, ast.Name):
                current_object = None
                continue
            if target.id in claimed_bindings:
                raise SourcePolicyError("Compiler bindings cannot be reassigned")

            copy_root, copy_methods = method_chain(statement.value)
            if (
                isinstance(copy_root, ast.Name)
                and copy_root.id in object_names
                and [name for name, _ in copy_methods] == ["copy"]
            ):
                copy_call = copy_methods[0][1]
                state = initialization_states.get(copy_root.id)
                if (
                    current_object != copy_root.id
                    or copy_call.args
                    or copy_call.keywords
                    or copy_root.id in reference_by_owner
                    or (object_kinds.get(copy_root.id) == "leaf" and (state is None or not state["move"] or state["opacity"]))
                ):
                    raise SourcePolicyError("Reference copies must immediately snapshot the current compiler object")
                reference_owners[target.id] = copy_root.id
                reference_by_owner[copy_root.id] = target.id
                claimed_bindings.add(target.id)
                if state is not None:
                    state["reference"] = True
                approved_sensitive_call_ids.add(id(copy_call))
                continue

            kind = validate_initialization_expression(statement.value, object_names)
            if kind is not None:
                shot_object_count += 1
                if shot_object_count > MAX_OBJECTS_PER_SHOT:
                    raise SourcePolicyError("Generated source contains too many compiler objects in one shot")
                object_names.add(target.id)
                object_kinds[target.id] = kind
                initialization_states[target.id] = new_initialization_state()
                claimed_bindings.add(target.id)
                root, methods = method_chain(statement.value)
                if kind == "group" and isinstance(root, ast.Call):
                    group_children[target.id] = tuple(argument.id for argument in root.args if isinstance(argument, ast.Name))
                    assert isinstance(root.func, ast.Name)
                    group_constructors[target.id] = root.func.id
                current_object = target.id
            else:
                noncompiler_name_assignments.append(target.id)
                current_object = None
            continue

        if isinstance(statement, ast.Expr) and not isinstance(statement.value, ast.Call):
            raise SourcePolicyError("Generated source contains a noncompiler expression statement")
        if not isinstance(statement, ast.Expr):
            current_object = None
            continue
        call = statement.value
        if isinstance(call.func, ast.Attribute) and receiver_parts(call.func.value) == ["self"]:
            method = call.func.attr
            if method == "add":
                if (
                    call.keywords
                    or not 1 <= len(call.args) <= MAX_OBJECTS_PER_SHOT
                    or any(not isinstance(argument, ast.Name) or object_kinds.get(argument.id) != "leaf" for argument in call.args)
                ):
                    raise SourcePolicyError("self.add arguments are outside the exact compiler dialect")
                require_initialized_leaves({argument.id for argument in call.args if isinstance(argument, ast.Name)})
            elif method == "clear":
                if call.args or call.keywords:
                    raise SourcePolicyError("self.clear must be the exact zero-argument compiler statement")
                reset_active_shot_provenance()
            elif method == "next_section":
                if (
                    call.keywords
                    or len(call.args) != 1
                    or not isinstance(call.args[0], ast.Constant)
                    or not isinstance(call.args[0].value, str)
                    or not 1 <= len(call.args[0].value) <= 120
                ):
                    raise SourcePolicyError("self.next_section is outside the exact compiler dialect")
                shot_count += 1
                if shot_count > MAX_COMPILER_SHOTS:
                    raise SourcePolicyError("Generated source contains too many compiler shots")
                shot_object_count = 0
                reset_active_shot_provenance()
            elif method == "wait":
                if call.keywords or len(call.args) != 1 or direct_number(call.args[0]) != 0:
                    raise SourcePolicyError("self.wait is reserved for the exact zero-runtime compiler fallback")
            elif method == "play":
                if call.keywords or len(call.args) != 1:
                    raise SourcePolicyError("self.play is outside the exact compiler dialect")
                require_initialized_leaves()
                validate_animation_expression(call.args[0], top_level=True)
            else:
                raise SourcePolicyError("Generated source calls a noncompiler self method")
            approved_sensitive_call_ids.add(id(call))
            current_object = None
            continue

        if isinstance(call.func, ast.Attribute) and receiver_parts(call.func.value) == ["self", "camera", "frame"] and call.func.attr == "become":
            if call.keywords or len(call.args) != 1:
                raise SourcePolicyError("Camera frame become is outside the exact compiler dialect")
            validate_camera_target(call.args[0])
            approved_sensitive_call_ids.add(id(call))
            current_object = None
            continue

        if current_object is None or object_kinds.get(current_object) != "leaf":
            raise SourcePolicyError("Direct object calls require the current compiler leaf binding")
        operation = validate_direct_object_call(call, current_object)
        apply_initialization_operation(current_object, operation)

    for node in ast.walk(tree):
        if id(node) in helper_node_ids:
            continue
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
            if (
                isinstance(node.ctx, ast.Load)
                and node.id == "proofcanvas_cubic_bezier"
                and id(node) not in rate_helper_load_ids
            ):
                raise SourcePolicyError("The cubic Bezier helper may be read only by an approved Transform rate_func")
            if isinstance(node.ctx, ast.Load) and node.id not in permitted_loads:
                raise SourcePolicyError(f"Generated source reads an unsupported name: {node.id}")
        if isinstance(node, ast.Attribute):
            parts = _attribute_parts(node)
            if any(not part or part.startswith("_") for part in parts):
                raise SourcePolicyError("Generated source contains a private attribute")
            if node.attr not in ALLOWED_ATTRIBUTES:
                raise SourcePolicyError(f"Generated source contains an unsupported attribute: {node.attr}")
            if node.attr in SENSITIVE_METHOD_ATTRIBUTES:
                parent = parents.get(id(node))
                if not (isinstance(parent, ast.Call) and parent.func is node and id(parent) in approved_sensitive_call_ids):
                    raise SourcePolicyError(f"Generated source uses {node.attr} outside an exact compiler context")
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
                if id(node) in rate_call_ids:
                    pass
                elif node.func.id not in ALLOWED_CONSTRUCTORS:
                    raise SourcePolicyError(f"Generated source calls an unsupported function: {node.func.id}")
                elif node.func.id in ANIMATION_CONSTRUCTORS and id(node) not in approved_animation_call_ids:
                    raise SourcePolicyError(f"Generated source uses {node.func.id} outside an exact self.play expression")
                elif node.func.id in MOBJECT_CONSTRUCTORS and id(node) not in approved_mobject_constructor_call_ids:
                    raise SourcePolicyError(f"Generated source uses {node.func.id} outside an exact compiler object context")
                elif node.func.id in {"max", "min"} and id(node) not in approved_utility_call_ids:
                    raise SourcePolicyError(f"Generated source uses {node.func.id} outside an exact compiler scale expression")
                if node.func.id in {"MathTex", "Tex"}:
                    if (
                        len(node.args) != 1
                        or not isinstance(node.args[0], ast.Constant)
                        or not isinstance(node.args[0].value, str)
                        or not _is_safe_latex(node.args[0].value, node.func.id)
                    ):
                        raise SourcePolicyError(f"{node.func.id} content is outside the safe compiler dialect")
                    if (
                        len(node.keywords) != 1
                        or node.keywords[0].arg != "font_size"
                        or not isinstance(node.keywords[0].value, ast.Constant)
                        or isinstance(node.keywords[0].value.value, bool)
                        or not isinstance(node.keywords[0].value.value, (int, float))
                        or not 1 <= node.keywords[0].value.value <= 256
                    ):
                        raise SourcePolicyError(f"{node.func.id} arguments are outside the compiler dialect")
            elif isinstance(node.func, ast.Attribute):
                if id(node) not in approved_sensitive_call_ids:
                    raise SourcePolicyError("Generated source calls an attribute outside an exact compiler context")
            else:
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
    if noncompiler_name_assignments:
        raise SourcePolicyError(f"Generated source assigns a noncompiler binding: {noncompiler_name_assignments[0]}")


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
        tree = ast.parse(source, filename="generated_scene.py", mode="exec", type_comments=True)
    except SyntaxError as error:
        raise SourcePolicyError("Generated source is not valid Python") from error
    _validate_structure(tree)
    _validate_nodes(tree)
    return ValidatedSource(source=source, sha256=actual_sha256)
