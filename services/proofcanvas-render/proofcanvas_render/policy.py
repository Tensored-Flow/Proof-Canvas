from __future__ import annotations

import ast
import hashlib
import math
import re
from dataclasses import dataclass

MAX_SOURCE_BYTES = 512 * 1024
SOURCE_SHA_PATTERN = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,95}$")
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
        "FunctionGraph",
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

MAX_GRAPH_LAMBDAS = 8
MAX_RATE_LAMBDAS = 1024
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
    rate_lambda_ids: set[int] = set()
    rate_call_ids: set[int] = set()
    rate_helper_load_ids: set[int] = set()
    graph_lambda_ids: set[int] = set()
    for node in ast.walk(construct):
        if not isinstance(node, ast.Lambda):
            continue
        if (
            len(node.args.args) != 1
            or node.args.args[0].arg != "x"
            or node.args.vararg is not None
            or node.args.kwarg is not None
            or node.args.kwonlyargs
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
        parent = parents.get(id(node))
        if not (
            isinstance(parent, ast.Call)
            and isinstance(parent.func, ast.Name)
            and parent.func.id == "FunctionGraph"
            and parent.args
            and parent.args[0] is node
        ):
            raise SourcePolicyError("Restricted graph lambdas are allowed only in FunctionGraph")
        graph_lambda_ids.add(id(node))
    if len(graph_lambda_ids) > MAX_GRAPH_LAMBDAS:
        raise SourcePolicyError("Generated source contains too many restricted graph lambdas")
    if len(rate_lambda_ids) > MAX_RATE_LAMBDAS:
        raise SourcePolicyError("Generated source contains too many custom easing lambdas")
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
