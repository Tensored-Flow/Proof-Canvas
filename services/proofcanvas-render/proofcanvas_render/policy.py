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
ASSET_PATH_PATTERN = re.compile(r"^assets/[0-9a-f]{64}\.(?:png|jpg|webp|svg)$")
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


CAP_STYLE_MEMBERS = frozenset({"BUTT", "ROUND", "SQUARE"})
LINE_JOINT_MEMBERS = frozenset({"MITER", "ROUND", "BEVEL"})
ARROW_TIP_SHAPE_NAMES = frozenset(
    {"ArrowTriangleFilledTip", "StealthTip", "ArrowCircleFilledTip", "ArrowSquareFilledTip"}
)
BRACE_DIRECTION_NAMES = frozenset({"UP", "DOWN", "LEFT", "RIGHT"})


ALLOWED_CONSTRUCTORS = frozenset(
    {
        "AnimationGroup",
        "Arrow",
        "Axes",
        "BraceBetweenPoints",
        "Circle",
        "Create",
        "DashedLine",
        "DoubleArrow",
        "Ellipse",
        "FadeIn",
        "FadeOut",
        "Group",
        "Indicate",
        "ImageMobject",
        "Line",
        "MathTex",
        "Polygon",
        "proofcanvas_image",
        "Tex",
        "max",
        "min",
        "Rectangle",
        "RoundedRectangle",
        "Succession",
        "SVGMobject",
        "Text",
        "Transform",
        "VGroup",
        "VMobject",
        "Wait",
        "Write",
    }
)
ALLOWED_CONSTANT_NAMES = frozenset(
    {
        "DEGREES",
        "DOWN",
        "UP",
        "LEFT",
        "RIGHT",
        "ORIGIN",
        "CapStyleType",
        "LineJointType",
        *ARROW_TIP_SHAPE_NAMES,
        "linear",
        "rush_into",
        "rush_from",
        "smooth",
    }
)
ALLOWED_ATTRIBUTES = frozenset(
    {
        "add",
        "add_cubic_bezier_curve_to",
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
        "BUTT",
        "BEVEL",
        "MITER",
        "ROUND",
        "SQUARE",
        "scale",
        "scale_to_fit_height",
        "scale_to_fit_width",
        "set_color",
        "set_cap_style",
        "set_fill",
        "set_opacity",
        "set_points_as_corners",
        "set_stroke",
        "shift",
        "stretch",
        "stretch_to_fit_height",
        "stretch_to_fit_width",
        "start_new_path",
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
# One schema-valid editor unit in the square frame, rounded by compiler.pyNumber.
MIN_DIRECT_MANIM_DIMENSION = 0.01111111
MAX_DIRECT_MANIM_CORNER_RADIUS = MAX_DIRECT_MANIM_DIMENSION / 8
MIN_ARROW_TIP_LENGTH_RATIO = 0.02
MAX_ARROW_TIP_LENGTH_RATIO = 0.45
MIN_DASHED_RATIO = 0.05
MAX_DASHED_RATIO = 0.95
# Mirrored from lib/proofcanvas/shapeGeometry.ts. The compiler may nudge these
# two Manim constructor literals only far enough to keep a width-dependent
# dash count on the browser-authoritative side of an eight-decimal ceil bin.
MAX_COMPILER_DASHED_RATIO_DRIFT = 0.000_000_645_000_001
MAX_COMPILER_DASH_LENGTH_RELATIVE_DRIFT = 0.000_002
MAX_NATIVE_SHAPE_POINTS = 64
MAX_DASH_SEGMENTS = MAX_NATIVE_SHAPE_POINTS * 4
MAX_NATIVE_GEOMETRY_WORK = 4_096
MAX_NORMALIZED_SHAPE_COORDINATE = 0.5
MAX_BRACE_LABEL_SHIFT = MAX_DIRECT_MANIM_DIMENSION * 2
MAX_EMITTED_DECIMAL_ROUNDING = 0.00000001
MIN_COPY_DIMENSION_RATIO = 0.00024414
MAX_COPY_DIMENSION_RATIO = 4_096
MAX_COPY_SHIFT = MAX_DIRECT_MANIM_COORDINATE * 2
MAX_DIRECT_ROTATION = 3_600
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
        "DashedLine",
        "DoubleArrow",
        "Ellipse",
        "Group",
        "ImageMobject",
        "Line",
        "MathTex",
        "Polygon",
        "proofcanvas_image",
        "Rectangle",
        "RoundedRectangle",
        "Tex",
        "Text",
        "SVGMobject",
        "VGroup",
        "VMobject",
    }
)
SENSITIVE_METHOD_ATTRIBUTES = frozenset(
    {
        "add",
        "add_cubic_bezier_curve_to",
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
        "set_cap_style",
        "set_fill",
        "set_opacity",
        "set_points_as_corners",
        "set_stroke",
        "shift",
        "stretch",
        "stretch_to_fit_height",
        "stretch_to_fit_width",
        "start_new_path",
        "wait",
    }
)
ANIMATION_CONSTRUCTORS = frozenset(
    {"AnimationGroup", "Create", "FadeIn", "FadeOut", "Indicate", "Succession", "Transform", "Wait", "Write"}
)
RESERVED_CONSTRUCT_BINDINGS = ALLOWED_CONSTRUCTORS | ALLOWED_CONSTANT_NAMES | frozenset(
    {"MovingCameraScene", "config", "math", "np", "proofcanvas_cubic_bezier", "proofcanvas_image", "rate_functions", "self", "x"}
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
PROOFCANVAS_IMAGE_HELPER = '''def proofcanvas_image(path, crop_x, crop_y, crop_width, crop_height, fit, preserve, target_width, target_height, mask, radius):
    image = Image.open(path).convert("RGBA")
    source_width, source_height = image.size
    left = max(0, min(source_width - 1, int(math.floor(crop_x * source_width))))
    top = max(0, min(source_height - 1, int(math.floor(crop_y * source_height))))
    right = max(left + 1, min(source_width, int(math.ceil((crop_x + crop_width) * source_width))))
    bottom = max(top + 1, min(source_height, int(math.ceil((crop_y + crop_height) * source_height))))
    image = image.crop((left, top, right, bottom))
    if preserve and fit != "fill":
        scale = min(target_width / image.width, target_height / image.height) if fit == "contain" else max(target_width / image.width, target_height / image.height)
        resized_width = max(1, int(round(image.width * scale)))
        resized_height = max(1, int(round(image.height * scale)))
        image = image.resize((resized_width, resized_height), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (target_width, target_height), (0, 0, 0, 0))
        canvas.alpha_composite(image, ((target_width - resized_width) // 2, (target_height - resized_height) // 2))
        image = canvas
    else:
        image = image.resize((target_width, target_height), Image.Resampling.LANCZOS)
    if mask != "none":
        alpha = Image.new("L", image.size, 0)
        draw = ImageDraw.Draw(alpha)
        if mask == "circle":
            diameter = min(target_width, target_height)
            offset_x = (target_width - diameter) // 2
            offset_y = (target_height - diameter) // 2
            draw.ellipse((offset_x, offset_y, offset_x + diameter, offset_y + diameter), fill=255)
        else:
            draw.rounded_rectangle((0, 0, target_width - 1, target_height - 1), radius=radius, fill=255)
        image.putalpha(ImageChops.multiply(image.getchannel("A"), alpha))
    return ImageMobject(np.array(image))
'''
PROOFCANVAS_IMAGE_HELPER_AST = ast.parse(PROOFCANVAS_IMAGE_HELPER).body[0]


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


def _is_exact_image_helper(node: ast.stmt) -> bool:
    return isinstance(node, ast.FunctionDef) and ast.dump(node, include_attributes=False) == ast.dump(PROOFCANVAS_IMAGE_HELPER_AST, include_attributes=False)


def _validate_structure(tree: ast.Module) -> None:
    if not 3 <= len(tree.body) <= 7:
        raise SourcePolicyError("Generated source has an unsupported top-level structure")
    manim_import, math_import = tree.body[:2]
    scene_class = tree.body[-1]
    middle = tree.body[2:-1]
    image_imports = middle[:2] if len(middle) >= 2 and isinstance(middle[0], ast.Import) and isinstance(middle[1], ast.ImportFrom) else []
    if image_imports:
        numpy_import, pillow_import = image_imports
        if not (
            len(numpy_import.names) == 1 and numpy_import.names[0].name == "numpy" and numpy_import.names[0].asname == "np"
            and pillow_import.module == "PIL" and pillow_import.level == 0
            and [(name.name, name.asname) for name in pillow_import.names] == [("Image", None), ("ImageChops", None), ("ImageDraw", None)]
        ):
            raise SourcePolicyError("Generated source has unsupported image helper imports")
    helpers = middle[len(image_imports):]
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
    if any(not (_is_exact_cubic_bezier_helper(helper) or _is_exact_image_helper(helper)) for helper in helpers) or len(helpers) != len({getattr(helper, "name", "") for helper in helpers}):
        raise SourcePolicyError("Generated source has an altered or unsupported compiler helper")
    if bool(image_imports) != any(_is_exact_image_helper(helper) for helper in helpers):
        raise SourcePolicyError("Generated source image imports and helper disagree")
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
    native_geometry_work = 0
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

    def validate_vector(node: ast.expr, maximum: float, message: str) -> tuple[float, float, float]:
        if not isinstance(node, ast.List) or len(node.elts) != 3:
            raise SourcePolicyError(message)
        coordinates = [direct_number(coordinate) for coordinate in node.elts]
        if any(coordinate is None for coordinate in coordinates):
            raise SourcePolicyError(message)
        x_value, y_value, z_value = coordinates
        assert x_value is not None and y_value is not None and z_value is not None
        if abs(x_value) > maximum or abs(y_value) > maximum or z_value != 0:
            raise SourcePolicyError(message)
        return x_value, y_value, z_value

    def validate_rotation(node: ast.expr, maximum: float, message: str) -> float:
        if not (
            isinstance(node, ast.BinOp)
            and isinstance(node.op, ast.Mult)
            and isinstance(node.right, ast.Name)
            and node.right.id == "DEGREES"
        ):
            raise SourcePolicyError(message)
        return bounded_number(node.left, -maximum, maximum, message)

    def has_exact_origin_keyword(call: ast.Call) -> bool:
        return (
            len(call.keywords) == 1
            and call.keywords[0].arg == "about_point"
            and isinstance(call.keywords[0].value, ast.Name)
            and call.keywords[0].value.id == "ORIGIN"
        )

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

    def consume_native_geometry_work(work: int) -> None:
        nonlocal native_geometry_work
        native_geometry_work += work
        if native_geometry_work > MAX_NATIVE_GEOMETRY_WORK:
            raise SourcePolicyError("Native shape geometry exceeds the compiler work budget")

    def validate_enum_attribute(
        node: ast.expr,
        owner: str,
        members: frozenset[str],
        message: str,
    ) -> str:
        if (
            not isinstance(node, ast.Attribute)
            or _attribute_parts(node) != [owner, node.attr]
            or node.attr not in members
        ):
            raise SourcePolicyError(message)
        return node.attr

    def validate_normalized_shape_point(node: ast.expr, message: str) -> tuple[float, float, float]:
        point = validate_vector(node, MAX_NORMALIZED_SHAPE_COORDINATE, message)
        return point

    def shape_point_orientation(
        left: tuple[float, float, float],
        middle: tuple[float, float, float],
        right: tuple[float, float, float],
    ) -> float:
        return (middle[0] - left[0]) * (right[1] - left[1]) - (middle[1] - left[1]) * (right[0] - left[0])

    def shape_point_on_segment(
        left: tuple[float, float, float],
        point: tuple[float, float, float],
        right: tuple[float, float, float],
    ) -> bool:
        epsilon = 1e-9
        return (
            abs(shape_point_orientation(left, point, right)) <= epsilon
            and point[0] >= min(left[0], right[0]) - epsilon
            and point[0] <= max(left[0], right[0]) + epsilon
            and point[1] >= min(left[1], right[1]) - epsilon
            and point[1] <= max(left[1], right[1]) + epsilon
        )

    def shape_segments_intersect(
        left_start: tuple[float, float, float],
        left_end: tuple[float, float, float],
        right_start: tuple[float, float, float],
        right_end: tuple[float, float, float],
    ) -> bool:
        epsilon = 1e-9
        first = shape_point_orientation(left_start, left_end, right_start)
        second = shape_point_orientation(left_start, left_end, right_end)
        third = shape_point_orientation(right_start, right_end, left_start)
        fourth = shape_point_orientation(right_start, right_end, left_end)
        if (
            ((first > epsilon and second < -epsilon) or (first < -epsilon and second > epsilon))
            and ((third > epsilon and fourth < -epsilon) or (third < -epsilon and fourth > epsilon))
        ):
            return True
        return (
            abs(first) <= epsilon and shape_point_on_segment(left_start, right_start, left_end)
            or abs(second) <= epsilon and shape_point_on_segment(left_start, right_end, left_end)
            or abs(third) <= epsilon and shape_point_on_segment(right_start, left_start, right_end)
            or abs(fourth) <= epsilon and shape_point_on_segment(right_start, left_end, right_end)
        )

    def validate_intrinsic_dimension_stretch(call: ast.Call, axis: int, message: str) -> float:
        if (
            len(call.args) != 2
            or direct_number(call.args[1]) != axis
            or not has_exact_origin_keyword(call)
        ):
            raise SourcePolicyError(message)
        value = bounded_number(
            call.args[0],
            MIN_DIRECT_MANIM_DIMENSION,
            MAX_DIRECT_MANIM_DIMENSION,
            message,
        )
        approved_sensitive_call_ids.add(id(call))
        return value

    def validate_freeform_fill(call: ast.Call) -> str:
        if (
            len(call.args) != 1
            or direct_hex(call.args[0]) is None
            or [keyword.arg for keyword in call.keywords] != ["opacity"]
            or direct_number(call.keywords[0].value) != 0
        ):
            raise SourcePolicyError("Freeform fill requires the exact transparent compiler paint")
        approved_sensitive_call_ids.add(id(call))
        color = direct_hex(call.args[0])
        assert color is not None
        return color

    def validate_freeform_stroke(call: ast.Call) -> str:
        if (
            len(call.args) != 1
            or direct_hex(call.args[0]) is None
            or [keyword.arg for keyword in call.keywords] != ["width", "opacity"]
        ):
            raise SourcePolicyError("Freeform stroke requires the exact compiler paint")
        bounded_number(
            call.keywords[0].value,
            0,
            MAX_LITERAL_GRAPH_STROKE_WIDTH,
            "Freeform stroke width is outside the schema bounds",
        )
        bounded_number(
            call.keywords[1].value,
            0,
            1,
            "Freeform stroke opacity is outside the schema bounds",
        )
        approved_sensitive_call_ids.add(id(call))
        color = direct_hex(call.args[0])
        assert color is not None
        return color

    def validate_freeform_opacity_override(call: ast.Call) -> None:
        if (
            call.args
            or [keyword.arg for keyword in call.keywords] != ["opacity"]
        ):
            raise SourcePolicyError("Freeform become opacity requires the exact stroke-only compiler override")
        bounded_number(
            call.keywords[0].value,
            0,
            1,
            "Freeform become opacity is outside the schema bounds",
        )
        approved_sensitive_call_ids.add(id(call))

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

    def validate_symmetric_linear_endpoints(call: ast.Call, axis: str) -> None:
        if len(call.args) != 2:
            raise SourcePolicyError("Linear primitive arguments are outside the exact compiler dialect")
        for endpoint in call.args:
            validate_vector(endpoint, MAX_DIRECT_MANIM_DIMENSION / 2, "Linear primitive endpoints are outside the compiler bounds")
        start = call.args[0]
        end = call.args[1]
        assert isinstance(start, ast.List) and isinstance(end, ast.List)
        primary_index = 0 if axis == "horizontal" else 1
        secondary_index = 1 if axis == "horizontal" else 0
        start_primary = direct_number(start.elts[primary_index])
        end_primary = direct_number(end.elts[primary_index])
        if (
            start_primary is None
            or end_primary is None
            or not MIN_DIRECT_MANIM_DIMENSION / 2 <= end_primary <= MAX_DIRECT_MANIM_DIMENSION / 2
            or start_primary != -end_primary
            or direct_number(start.elts[secondary_index]) != 0
            or direct_number(end.elts[secondary_index]) != 0
        ):
            raise SourcePolicyError("Linear primitive endpoints are outside the exact compiler dialect")

    def validate_linear_constructor(call: ast.Call, *, arrow: bool = False) -> bool:
        keyword_names = [keyword.arg for keyword in call.keywords]
        current_arrow = arrow and keyword_names == ["buff", "max_tip_length_to_length_ratio", "tip_shape"]
        legacy_arrow = arrow and keyword_names == ["buff"]
        if (not arrow and keyword_names) or (arrow and not (legacy_arrow or current_arrow)):
            raise SourcePolicyError("Linear primitive arguments are outside the exact compiler dialect")
        validate_symmetric_linear_endpoints(call, "horizontal")
        if not arrow:
            return False
        if direct_number(call.keywords[0].value) != 0:
            raise SourcePolicyError("Arrow buff is outside the exact compiler dialect")
        if current_arrow:
            bounded_number(
                call.keywords[1].value,
                MIN_ARROW_TIP_LENGTH_RATIO,
                MAX_ARROW_TIP_LENGTH_RATIO,
                "Arrow tip ratio is outside the schema bounds",
            )
            tip_shape = call.keywords[2].value
            if not isinstance(tip_shape, ast.Name) or tip_shape.id not in ARROW_TIP_SHAPE_NAMES:
                raise SourcePolicyError("Arrow tip shape is outside the exact compiler dialect")
        return current_arrow

    def validate_brace_constructor(call: ast.Call) -> tuple[str, bool]:
        keyword_names = [keyword.arg for keyword in call.keywords]
        legacy_brace = keyword_names == ["direction"]
        current_brace = keyword_names == ["direction", "buff"]
        if len(call.args) != 2 or not (legacy_brace or current_brace):
            raise SourcePolicyError("Brace arguments are outside the exact compiler dialect")
        direction_node = call.keywords[0].value
        if not isinstance(direction_node, ast.Name) or direction_node.id not in BRACE_DIRECTION_NAMES:
            raise SourcePolicyError("Brace direction is outside the exact compiler dialect")
        direction = direction_node.id
        if legacy_brace and direction != "DOWN":
            raise SourcePolicyError("Legacy brace direction is outside the exact compiler dialect")
        validate_symmetric_linear_endpoints(
            call,
            "horizontal" if direction in {"UP", "DOWN"} else "vertical",
        )
        if current_brace:
            bounded_number(
                call.keywords[1].value,
                0,
                MAX_DIRECT_MANIM_DIMENSION,
                "Brace spacing is outside the compiler bounds",
            )
        return direction, current_brace

    def validate_cap_style_method(call: ast.Call) -> None:
        if (
            call.keywords
            or len(call.args) != 1
            or not isinstance(call.args[0], ast.Attribute)
            or _attribute_parts(call.args[0]) != ["CapStyleType", call.args[0].attr]
            or call.args[0].attr not in CAP_STYLE_MEMBERS
        ):
            raise SourcePolicyError("Line cap is outside the exact compiler dialect")
        approved_sensitive_call_ids.add(id(call))

    def validate_filled_native_paint(methods: list[tuple[str, ast.Call]], start: int) -> int:
        names = [name for name, _ in methods[start:]]
        if names not in (["set_fill", "set_stroke"], ["set_fill", "set_stroke", "set_opacity"]):
            raise SourcePolicyError("Filled native shape requires the exact compiler paint chain")
        for name, call in methods[start:]:
            validate_style_method(name, call)
            approved_sensitive_call_ids.add(id(call))
        return len(methods)

    def validate_stroked_native_paint(methods: list[tuple[str, ast.Call]], start: int) -> int:
        names = [name for name, _ in methods[start:]]
        if names not in (["set_stroke"], ["set_stroke", "set_opacity"]):
            raise SourcePolicyError("Stroked native shape requires the exact compiler paint chain")
        for name, call in methods[start:]:
            validate_style_method(name, call)
            approved_sensitive_call_ids.add(id(call))
        return len(methods)

    def validate_arrow_native_paint(methods: list[tuple[str, ast.Call]], start: int) -> int:
        names = [name for name, _ in methods[start:]]
        if names not in (["set_color", "set_stroke"], ["set_color", "set_stroke", "set_opacity"]):
            raise SourcePolicyError("Arrow native shape requires the exact compiler paint chain")
        for name, call in methods[start:]:
            validate_style_method(name, call)
            approved_sensitive_call_ids.add(id(call))
        color = direct_hex(methods[start][1].args[0])
        stroke = direct_hex(methods[start + 1][1].args[0])
        if color is None or color != stroke:
            raise SourcePolicyError("Arrow tip and stroke colours must match the compiler paint")
        return len(methods)

    def validate_ellipse_constructor(call: ast.Call, methods: list[tuple[str, ast.Call]]) -> int:
        if call.args or [keyword.arg for keyword in call.keywords] != ["width", "height"]:
            raise SourcePolicyError("Ellipse arguments are outside the exact compiler dialect")
        for keyword in call.keywords:
            bounded_number(
                keyword.value,
                MIN_DIRECT_MANIM_DIMENSION,
                MAX_DIRECT_MANIM_DIMENSION,
                "Ellipse dimensions are outside the compiler bounds",
            )
        consume_native_geometry_work(1)
        return validate_filled_native_paint(methods, 0)

    def validate_polygon_constructor(call: ast.Call, methods: list[tuple[str, ast.Call]]) -> int:
        if (
            not 3 <= len(call.args) <= MAX_NATIVE_SHAPE_POINTS
            or [keyword.arg for keyword in call.keywords] != ["joint_type"]
        ):
            raise SourcePolicyError("Polygon arguments are outside the exact compiler dialect")
        validate_enum_attribute(
            call.keywords[0].value,
            "LineJointType",
            LINE_JOINT_MEMBERS,
            "Polygon line join is outside the exact compiler dialect",
        )
        vertices = [
            validate_normalized_shape_point(vertex, "Polygon vertices are outside the normalized compiler bounds")
            for vertex in call.args
        ]
        if any(left == right for left, right in zip(vertices, vertices[1:], strict=False)) or vertices[0] == vertices[-1]:
            raise SourcePolicyError("Polygon vertices are outside the exact compiler topology")
        origin = vertices[0]
        axis = next((point for point in vertices if point != origin), None)
        if axis is None or not any(
            abs((axis[0] - origin[0]) * (point[1] - origin[1]) - (axis[1] - origin[1]) * (point[0] - origin[0]))
            >= 0.000_001
            for point in vertices
        ):
            raise SourcePolicyError("Polygon vertices must not all be collinear")
        for left_index in range(len(vertices)):
            left_next = (left_index + 1) % len(vertices)
            for right_index in range(left_index + 1, len(vertices)):
                right_next = (right_index + 1) % len(vertices)
                if left_index == right_index or left_next == right_index or right_next == left_index:
                    continue
                if shape_segments_intersect(
                    vertices[left_index],
                    vertices[left_next],
                    vertices[right_index],
                    vertices[right_next],
                ):
                    raise SourcePolicyError("Polygon edges must not intersect outside adjacent vertices")
        if len(methods) < 2 or [name for name, _ in methods[:2]] != ["stretch", "stretch"]:
            raise SourcePolicyError("Polygon dimensions require the exact compiler stretch chain")
        validate_intrinsic_dimension_stretch(methods[0][1], 0, "Polygon width is outside the exact compiler dialect")
        validate_intrinsic_dimension_stretch(methods[1][1], 1, "Polygon height is outside the exact compiler dialect")
        consume_native_geometry_work(len(vertices))
        return validate_filled_native_paint(methods, 2)

    def validate_dashed_line_constructor(call: ast.Call, methods: list[tuple[str, ast.Call]]) -> int:
        if [keyword.arg for keyword in call.keywords] != ["dash_length", "dashed_ratio", "cap_style"]:
            raise SourcePolicyError("DashedLine arguments are outside the exact compiler dialect")
        validate_symmetric_linear_endpoints(call, "horizontal")
        dash_length = bounded_number(
            call.keywords[0].value,
            MIN_DIRECT_MANIM_DIMENSION,
            MAX_DIRECT_MANIM_DIMENSION,
            "DashedLine dash length is outside the compiler bounds",
        )
        dashed_ratio = bounded_number(
            call.keywords[1].value,
            MIN_DASHED_RATIO,
            MAX_DASHED_RATIO,
            "DashedLine ratio is outside the schema bounds",
        )
        validate_enum_attribute(
            call.keywords[2].value,
            "CapStyleType",
            CAP_STYLE_MEMBERS,
            "DashedLine cap is outside the exact compiler dialect",
        )
        end = call.args[1]
        assert isinstance(end, ast.List)
        half_width = direct_number(end.elts[0])
        assert half_width is not None
        dash_count = max(2, math.ceil(((2 * half_width) / dash_length) * dashed_ratio))
        if dash_count > MAX_DASH_SEGMENTS:
            raise SourcePolicyError("DashedLine creates too many rendered dashes")
        consume_native_geometry_work(dash_count)
        return validate_stroked_native_paint(methods, 0)

    def validate_double_arrow_constructor(call: ast.Call, methods: list[tuple[str, ast.Call]]) -> int:
        if [keyword.arg for keyword in call.keywords] != [
            "buff",
            "max_tip_length_to_length_ratio",
            "tip_shape_start",
            "tip_shape_end",
        ]:
            raise SourcePolicyError("DoubleArrow arguments are outside the exact compiler dialect")
        validate_symmetric_linear_endpoints(call, "horizontal")
        if direct_number(call.keywords[0].value) != 0:
            raise SourcePolicyError("DoubleArrow buff is outside the exact compiler dialect")
        bounded_number(
            call.keywords[1].value,
            MIN_ARROW_TIP_LENGTH_RATIO,
            MAX_ARROW_TIP_LENGTH_RATIO,
            "DoubleArrow tip ratio is outside the schema bounds",
        )
        for keyword in call.keywords[2:]:
            if not isinstance(keyword.value, ast.Name) or keyword.value.id not in ARROW_TIP_SHAPE_NAMES:
                raise SourcePolicyError("DoubleArrow tip shape is outside the exact compiler dialect")
        if not methods or methods[0][0] != "set_cap_style":
            raise SourcePolicyError("DoubleArrow requires the exact compiler cap")
        validate_cap_style_method(methods[0][1])
        consume_native_geometry_work(1)
        return validate_arrow_native_paint(methods, 1)

    def validate_freeform_constructor(call: ast.Call, methods: list[tuple[str, ast.Call]]) -> int:
        keyword_names = [keyword.arg for keyword in call.keywords]
        open_path = keyword_names == ["joint_type", "cap_style"]
        if call.args or keyword_names not in (["joint_type"], ["joint_type", "cap_style"]):
            raise SourcePolicyError("Freeform VMobject arguments are outside the exact compiler dialect")
        validate_enum_attribute(
            call.keywords[0].value,
            "LineJointType",
            LINE_JOINT_MEMBERS,
            "Freeform line join is outside the exact compiler dialect",
        )
        if open_path:
            validate_enum_attribute(
                call.keywords[1].value,
                "CapStyleType",
                CAP_STYLE_MEMBERS,
                "Freeform line cap is outside the exact compiler dialect",
            )

        names = [name for name, _ in methods]
        try:
            first_stretch = names.index("stretch")
        except ValueError as error:
            raise SourcePolicyError("Freeform dimensions require the exact compiler stretch chain") from error
        segment_count = first_stretch - 1
        geometry_names = [
            "start_new_path",
            *(["add_cubic_bezier_curve_to"] * segment_count),
            "stretch",
            "stretch",
        ]
        paint_names = names[len(geometry_names):]
        if (
            not 1 <= segment_count <= MAX_NATIVE_SHAPE_POINTS
            or names[:len(geometry_names)] != geometry_names
            or (open_path and paint_names != ["set_fill", "set_stroke"])
            or (not open_path and paint_names not in (
                ["set_fill", "set_stroke"],
                ["set_fill", "set_stroke", "set_opacity"],
            ))
        ):
            raise SourcePolicyError("Freeform methods are outside the exact compiler dialect")
        start_call = methods[0][1]
        if start_call.keywords or len(start_call.args) != 1:
            raise SourcePolicyError("Freeform start point is outside the exact compiler dialect")
        start = validate_normalized_shape_point(
            start_call.args[0],
            "Freeform start point is outside the normalized compiler bounds",
        )
        approved_sensitive_call_ids.add(id(start_call))
        previous_end = start
        for _, curve_call in methods[1:first_stretch]:
            if curve_call.keywords or len(curve_call.args) != 3:
                raise SourcePolicyError("Freeform cubic segment is outside the exact compiler dialect")
            points = [
                validate_normalized_shape_point(
                    point,
                    "Freeform cubic point is outside the normalized compiler bounds",
                )
                for point in curve_call.args
            ]
            if points[2] == previous_end:
                raise SourcePolicyError("Freeform segment endpoints must be distinct")
            previous_end = points[2]
            approved_sensitive_call_ids.add(id(curve_call))
        if open_path:
            if segment_count > MAX_NATIVE_SHAPE_POINTS - 1:
                raise SourcePolicyError("Open freeform path contains too many compiler segments")
        elif segment_count < 3 or previous_end != start:
            raise SourcePolicyError("Closed freeform path requires the exact implicit closing segment")
        validate_intrinsic_dimension_stretch(
            methods[first_stretch][1],
            0,
            "Freeform width is outside the exact compiler dialect",
        )
        validate_intrinsic_dimension_stretch(
            methods[first_stretch + 1][1],
            1,
            "Freeform height is outside the exact compiler dialect",
        )
        if open_path:
            fill_color = validate_freeform_fill(methods[first_stretch + 2][1])
            stroke_color = validate_freeform_stroke(methods[first_stretch + 3][1])
            if fill_color != stroke_color:
                raise SourcePolicyError("Freeform transparent fill and stroke colours must match the compiler paint")
        else:
            # Closed paths are filled native shapes. Their fill and stroke may
            # be authored independently, and one aggregate opacity controls
            # both paints. The generic validator keeps this exact and bounded.
            validate_filled_native_paint(methods, first_stretch + 2)
        consume_native_geometry_work(1 + 3 * segment_count)
        return len(methods)

    def validate_directional_shift(call: ast.Call, direction: str, *, legacy: bool = False) -> None:
        if call.keywords or len(call.args) != 1:
            raise SourcePolicyError("Brace label shift is outside the exact compiler dialect")
        offset = call.args[0]
        if not (
            isinstance(offset, ast.BinOp)
            and isinstance(offset.op, ast.Mult)
            and isinstance(offset.left, ast.Name)
            and offset.left.id == direction
        ):
            raise SourcePolicyError("Brace label shift direction is outside the exact compiler dialect")
        if legacy:
            if direct_number(offset.right) != 0.45:
                raise SourcePolicyError("Legacy brace label shift is outside the exact compiler dialect")
        else:
            bounded_number(
                offset.right,
                0,
                MAX_BRACE_LABEL_SHIFT,
                "Brace label shift is outside the compiler bounds",
            )
        approved_sensitive_call_ids.add(id(call))

    def validate_axes_range(node: ast.expr, name: str) -> None:
        if not isinstance(node, ast.List) or len(node.elts) != 3:
            raise SourcePolicyError(f"Axes {name} is outside the exact compiler dialect")
        minimum = bounded_number(node.elts[0], -MAX_LITERAL_GRAPH_COORDINATE, MAX_LITERAL_GRAPH_COORDINATE, f"Axes {name} is outside the compiler bounds")
        maximum = bounded_number(node.elts[1], -MAX_LITERAL_GRAPH_COORDINATE, MAX_LITERAL_GRAPH_COORDINATE, f"Axes {name} is outside the compiler bounds")
        if minimum >= maximum or direct_number(node.elts[2]) != 1:
            raise SourcePolicyError(f"Axes {name} is outside the exact compiler dialect")

    def rounded_rectangle_corner_descriptor(
        root: ast.Call,
        width: float,
        height: float,
    ) -> tuple[str, float]:
        corner_node = root.keywords[0].value
        direct_corner = direct_number(corner_node)
        if direct_corner is not None:
            corner_radius = bounded_number(
                corner_node,
                0,
                MAX_DIRECT_MANIM_CORNER_RADIUS,
                "RoundedRectangle corner radius is outside the compiler bounds",
            )
            if corner_radius - min(width, height) / 2 > MAX_EMITTED_DECIMAL_ROUNDING:
                raise SourcePolicyError("RoundedRectangle corner radius exceeds its exact compiler dimensions")
            return ("literal", corner_radius)

        if not (
            isinstance(corner_node, ast.Call)
            and isinstance(corner_node.func, ast.Name)
            and corner_node.func.id == "min"
            and not corner_node.keywords
            and len(corner_node.args) == 3
        ):
            raise SourcePolicyError("RoundedRectangle corner radius is outside the exact compiler descriptor protocol")
        authored_radius = bounded_number(
            corner_node.args[0],
            0,
            MAX_DIRECT_MANIM_CORNER_RADIUS,
            "RoundedRectangle authored corner radius is outside the compiler bounds",
        )
        if authored_radius <= 0:
            raise SourcePolicyError("RoundedRectangle derived corner radius requires a positive authored origin")
        for expression, dimension in zip(corner_node.args[1:], (width, height), strict=True):
            if not (
                isinstance(expression, ast.BinOp)
                and isinstance(expression.op, ast.Div)
                and direct_number(expression.left) == dimension
                and direct_number(expression.right) == 2
            ):
                raise SourcePolicyError("RoundedRectangle derived corner radius must repeat its exact compiler dimensions")
        approved_utility_call_ids.add(id(corner_node))
        return ("authored", authored_radius)

    def validate_object_constructor(root: ast.Call, methods: list[tuple[str, ast.Call]], known_objects: set[str]) -> tuple[str, int]:
        assert isinstance(root.func, ast.Name)
        constructor = root.func.id
        if constructor == "proofcanvas_image":
            if root.keywords or len(root.args) != 11:
                raise SourcePolicyError("Trusted image preprocessing arguments are malformed")
            path = root.args[0]
            if not isinstance(path, ast.Constant) or not isinstance(path.value, str) or not re.fullmatch(r"assets/[0-9a-f]{64}\.(?:png|jpg|webp)", path.value):
                raise SourcePolicyError("Trusted image preprocessing path is invalid")
            crop_values = [bounded_number(argument, 0, 1, "Trusted image crop is outside bounds") for argument in root.args[1:5]]
            crop_x, crop_y, crop_width, crop_height = crop_values
            if crop_width < 0.001 or crop_height < 0.001 or crop_x + crop_width > 1 or crop_y + crop_height > 1:
                raise SourcePolicyError("Trusted image crop is outside bounds")
            fit, preserve, target_width, target_height, mask, radius = root.args[5:]
            if not isinstance(fit, ast.Constant) or fit.value not in {"contain", "cover", "fill"}:
                raise SourcePolicyError("Trusted image fit is invalid")
            if not isinstance(preserve, ast.Constant) or not isinstance(preserve.value, bool):
                raise SourcePolicyError("Trusted image aspect flag is invalid")
            for dimension, label in ((target_width, "width"), (target_height, "height")):
                if not isinstance(dimension, ast.Constant) or isinstance(dimension.value, bool) or not isinstance(dimension.value, int) or not 1 <= dimension.value <= 4096:
                    raise SourcePolicyError(f"Trusted image target {label} is outside bounds")
            if not isinstance(mask, ast.Constant) or mask.value not in {"none", "circle", "rounded-rectangle"}:
                raise SourcePolicyError("Trusted image mask is invalid")
            radius_value = bounded_number(radius, 0, 2048, "Trusted image radius is outside bounds")
            if (mask.value != "rounded-rectangle" and radius_value != 0) or (mask.value == "rounded-rectangle" and radius_value > min(target_width.value, target_height.value) / 2):
                raise SourcePolicyError("Trusted image radius disagrees with its mask")
        elif constructor == "Text":
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
        elif constructor == "RoundedRectangle":
            if root.args or [keyword.arg for keyword in root.keywords] != ["corner_radius", "width", "height"]:
                raise SourcePolicyError("RoundedRectangle arguments are outside the exact compiler dialect")
            width = bounded_number(
                root.keywords[1].value,
                MIN_DIRECT_MANIM_DIMENSION,
                MAX_DIRECT_MANIM_DIMENSION,
                "RoundedRectangle width is outside the compiler bounds",
            )
            height = bounded_number(
                root.keywords[2].value,
                MIN_DIRECT_MANIM_DIMENSION,
                MAX_DIRECT_MANIM_DIMENSION,
                "RoundedRectangle height is outside the compiler bounds",
            )
            rounded_rectangle_corner_descriptor(root, width, height)
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
        elif constructor == "Ellipse":
            return "leaf", validate_ellipse_constructor(root, methods)
        elif constructor == "Polygon":
            return "leaf", validate_polygon_constructor(root, methods)
        elif constructor == "Line":
            validate_linear_constructor(root)
            if methods and methods[0][0] == "set_cap_style":
                validate_cap_style_method(methods[0][1])
                return "leaf", 1
        elif constructor == "Arrow":
            current_arrow = validate_linear_constructor(root, arrow=True)
            if current_arrow:
                if [name for name, _ in methods[:3]] != ["set_cap_style", "set_color", "set_stroke"]:
                    raise SourcePolicyError("Current Arrow requires the exact cap and paint chain")
                validate_cap_style_method(methods[0][1])
                validate_style_method("set_color", methods[1][1])
                validate_style_method("set_stroke", methods[2][1])
                color = direct_hex(methods[1][1].args[0])
                stroke = direct_hex(methods[2][1].args[0])
                if color is None or color != stroke:
                    raise SourcePolicyError("Arrow tip and stroke colours must match the compiler paint")
                return "leaf", 1
            if any(name == "set_cap_style" for name, _ in methods):
                raise SourcePolicyError("Legacy Arrow cannot contain a current-dialect cap setter")
        elif constructor == "DashedLine":
            return "leaf", validate_dashed_line_constructor(root, methods)
        elif constructor == "DoubleArrow":
            return "leaf", validate_double_arrow_constructor(root, methods)
        elif constructor == "Axes":
            if root.args or [keyword.arg for keyword in root.keywords] != ["x_range", "y_range", "x_length", "y_length", "tips"]:
                raise SourcePolicyError("Axes arguments are outside the exact compiler dialect")
            validate_axes_range(root.keywords[0].value, "x_range")
            validate_axes_range(root.keywords[1].value, "y_range")
            bounded_number(root.keywords[2].value, MIN_DIRECT_MANIM_DIMENSION, MAX_DIRECT_MANIM_DIMENSION, "Axes x_length is outside the compiler bounds")
            bounded_number(root.keywords[3].value, MIN_DIRECT_MANIM_DIMENSION, MAX_DIRECT_MANIM_DIMENSION, "Axes y_length is outside the compiler bounds")
            if not (isinstance(root.keywords[4].value, ast.Constant) and root.keywords[4].value.value is False):
                raise SourcePolicyError("Axes tips are outside the exact compiler dialect")
        elif constructor in {"ImageMobject", "SVGMobject"}:
            expected_suffixes = (".png", ".jpg", ".webp") if constructor == "ImageMobject" else (".svg",)
            if (
                root.keywords
                or len(root.args) != 1
                or not isinstance(root.args[0], ast.Constant)
                or not isinstance(root.args[0].value, str)
                or not ASSET_PATH_PATTERN.fullmatch(root.args[0].value)
                or not root.args[0].value.endswith(expected_suffixes)
            ):
                raise SourcePolicyError(f"{constructor} path is outside the trusted asset protocol")
        elif constructor in {"Group", "VGroup"}:
            if root.keywords or not root.args or len(root.args) > MAX_OBJECTS_PER_SHOT:
                raise SourcePolicyError("Compiler group arguments are outside the exact dialect")
            if not all(isinstance(argument, ast.Name) and argument.id in known_objects for argument in root.args):
                raise SourcePolicyError("Compiler group bindings require proven direct object names")
            if methods:
                raise SourcePolicyError("Compiler group bindings cannot contain post-construction decorators")
            return "group", 0
        elif constructor == "VMobject":
            if root.keywords:
                return "leaf", validate_freeform_constructor(root, methods)
            if root.args:
                raise SourcePolicyError("VMobject arguments are outside the exact compiler dialect")
        else:
            raise SourcePolicyError("Generated source contains an unsupported object constructor")
        return "leaf", 0

    def validate_brace_aggregate(root: ast.Call, methods: list[tuple[str, ast.Call]]) -> int:
        if root.keywords or len(root.args) != 2:
            raise SourcePolicyError("Brace aggregate is outside the exact compiler dialect")
        brace_root, brace_methods = method_chain(root.args[0])
        label_root, label_methods = method_chain(root.args[1])
        if not (
            isinstance(brace_root, ast.Call)
            and isinstance(brace_root.func, ast.Name)
            and brace_root.func.id == "BraceBetweenPoints"
            and isinstance(label_root, ast.Call)
            and isinstance(label_root.func, ast.Name)
            and label_root.func.id == "Text"
        ):
            raise SourcePolicyError("Brace aggregate requires exact direct compiler children")

        direction, current_brace = validate_brace_constructor(brace_root)
        validate_text_constructor(label_root, MAX_BRACE_LABEL_CHARS)
        approved_mobject_constructor_call_ids.update({id(brace_root), id(label_root)})

        brace_method_names = [name for name, _ in brace_methods]
        label_method_names = [name for name, _ in label_methods]
        outer_method_names = [name for name, _ in methods]
        if current_brace:
            if brace_method_names != ["set_color", "set_stroke"]:
                raise SourcePolicyError("Brace body requires the exact compiler paint chain")
            if label_method_names != ["set_color", "shift"]:
                raise SourcePolicyError("Brace label requires the exact compiler colour and shift chain")
            if outer_method_names not in ([], ["set_opacity"]):
                raise SourcePolicyError("Brace aggregate permits only the exact optional compiler opacity")

            validate_style_method("set_color", brace_methods[0][1])
            validate_style_method("set_stroke", brace_methods[1][1])
            body_color = direct_hex(brace_methods[0][1].args[0])
            body_stroke = direct_hex(brace_methods[1][1].args[0])
            if body_color is None or body_color != body_stroke:
                raise SourcePolicyError("Brace body colour and stroke must match the compiler paint")
            validate_style_method("set_color", label_methods[0][1])
            validate_directional_shift(label_methods[1][1], direction)
            approved_sensitive_call_ids.update(
                {id(brace_methods[0][1]), id(brace_methods[1][1]), id(label_methods[0][1])}
            )
            if methods:
                validate_style_method("set_opacity", methods[0][1])
                approved_sensitive_call_ids.add(id(methods[0][1]))
            return len(methods)

        if brace_method_names or label_method_names != ["shift"]:
            raise SourcePolicyError("Legacy brace children are outside the exact compiler dialect")
        if outer_method_names not in ([], ["set_stroke"], ["set_stroke", "set_opacity"]):
            raise SourcePolicyError("Legacy brace decorators are outside the exact compiler dialect")
        validate_directional_shift(label_methods[0][1], direction, legacy=True)
        for name, call in methods:
            validate_style_method(name, call)
            approved_sensitive_call_ids.add(id(call))
        return len(methods)

    def validate_initialization_expression(expression: ast.expr, known_objects: set[str]) -> str | None:
        root, methods = method_chain(expression)
        if not (isinstance(root, ast.Call) and isinstance(root.func, ast.Name) and root.func.id in MOBJECT_CONSTRUCTORS):
            return None
        approved_mobject_constructor_call_ids.add(id(root))

        if id(root) in literal_geometries:
            return "leaf"

        first_child_root, _ = method_chain(root.args[0]) if root.args else (None, [])
        second_child_root, _ = method_chain(root.args[1]) if len(root.args) > 1 else (None, [])
        brace_group = (
            root.func.id == "VGroup"
            and not root.keywords
            and len(root.args) == 2
            and isinstance(first_child_root, ast.Call)
            and isinstance(first_child_root.func, ast.Name)
            and first_child_root.func.id == "BraceBetweenPoints"
            and isinstance(second_child_root, ast.Call)
            and isinstance(second_child_root.func, ast.Name)
            and second_child_root.func.id == "Text"
        )
        if brace_group:
            kind, method_index = "leaf", validate_brace_aggregate(root, methods)
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

    def exact_current_shape_kind(root: ast.expr, methods: list[tuple[str, ast.Call]]) -> str | None:
        if not isinstance(root, ast.Call) or not isinstance(root.func, ast.Name):
            return None
        constructor = root.func.id
        method_names = [name for name, _ in methods]
        shape_kind: str | None = None
        style_names: list[str]
        if constructor in {"Rectangle", "RoundedRectangle"}:
            shape_kind = "rectangle"
            style_names = method_names
        elif constructor == "Circle" and method_names[:2] == ["stretch_to_fit_width", "stretch_to_fit_height"]:
            shape_kind = "circle"
            style_names = method_names[2:]
        elif constructor == "Ellipse":
            shape_kind = "ellipse"
            style_names = method_names
        elif constructor == "Polygon" and method_names[:2] == ["stretch", "stretch"]:
            shape_kind = "polygon"
            style_names = method_names[2:]
        elif constructor == "Line" and method_names[:1] == ["set_cap_style"]:
            shape_kind = "line"
            style_names = method_names[1:]
        elif constructor == "DashedLine":
            shape_kind = "dashed-line"
            style_names = method_names
        elif (
            constructor == "Arrow"
            and [keyword.arg for keyword in root.keywords]
            == ["buff", "max_tip_length_to_length_ratio", "tip_shape"]
            and method_names[:1] == ["set_cap_style"]
        ):
            shape_kind = "arrow"
            style_names = method_names[1:]
        elif (
            constructor == "DoubleArrow"
            and [keyword.arg for keyword in root.keywords]
            == ["buff", "max_tip_length_to_length_ratio", "tip_shape_start", "tip_shape_end"]
            and method_names[:1] == ["set_cap_style"]
        ):
            shape_kind = "double-arrow"
            style_names = method_names[1:]
        elif (
            constructor == "VMobject"
            and [keyword.arg for keyword in root.keywords]
            in (["joint_type"], ["joint_type", "cap_style"])
            and method_names[:1] == ["start_new_path"]
        ):
            shape_kind = "freeform-path"
            first_style = method_names.index("set_fill") if "set_fill" in method_names else len(method_names)
            style_names = method_names[first_style:]
        elif constructor == "VGroup" and len(root.args) == 2:
            brace_root, _ = method_chain(root.args[0])
            if (
                isinstance(brace_root, ast.Call)
                and isinstance(brace_root.func, ast.Name)
                and brace_root.func.id == "BraceBetweenPoints"
                and [keyword.arg for keyword in brace_root.keywords] == ["direction", "buff"]
                and method_names in ([], ["set_opacity"])
            ):
                return "brace"
            return None
        else:
            return None

        opacity_suffix = style_names[-1:] == ["set_opacity"]
        paint_names = style_names[:-1] if opacity_suffix else style_names
        exact_paint_names = {
            "rectangle": (["set_fill", "set_stroke"],),
            "circle": (["set_fill", "set_stroke"],),
            "ellipse": (["set_fill", "set_stroke"],),
            "polygon": (["set_fill", "set_stroke"],),
            "line": (["set_stroke"],),
            "dashed-line": (["set_stroke"],),
            "arrow": (["set_color", "set_stroke"],),
            "double-arrow": (["set_color", "set_stroke"],),
            "freeform-path": (["set_fill", "set_stroke"],),
        }
        return shape_kind if paint_names in exact_paint_names[shape_kind] else None

    def current_shape_descriptor(
        root: ast.expr,
        methods: list[tuple[str, ast.Call]],
        shape_kind: str,
    ) -> tuple[object, ...]:
        assert isinstance(root, ast.Call) and isinstance(root.func, ast.Name)
        if shape_kind == "rectangle":
            if root.func.id == "RoundedRectangle":
                width = direct_number(root.keywords[1].value)
                height = direct_number(root.keywords[2].value)
                assert width is not None and height is not None
                corner_descriptor = rounded_rectangle_corner_descriptor(root, width, height)
            else:
                corner_descriptor = None
            return (shape_kind, root.func.id, corner_descriptor)
        if shape_kind == "circle":
            return (shape_kind, "Circle")
        if shape_kind == "ellipse":
            return (shape_kind, "Ellipse")
        if shape_kind == "polygon":
            joint = root.keywords[0].value
            assert isinstance(joint, ast.Attribute)
            vertices = tuple(
                tuple(direct_number(coordinate) for coordinate in vertex.elts)
                for vertex in root.args
                if isinstance(vertex, ast.List)
            )
            return (shape_kind, joint.attr, vertices)
        if shape_kind == "line":
            cap = methods[0][1].args[0]
            assert isinstance(cap, ast.Attribute)
            return (shape_kind, cap.attr)
        if shape_kind == "arrow":
            cap = methods[0][1].args[0]
            tip_shape = root.keywords[2].value
            assert isinstance(cap, ast.Attribute) and isinstance(tip_shape, ast.Name)
            return (
                shape_kind,
                cap.attr,
                direct_number(root.keywords[1].value),
                tip_shape.id,
            )
        if shape_kind == "dashed-line":
            cap = root.keywords[2].value
            assert isinstance(cap, ast.Attribute)
            return (
                shape_kind,
                cap.attr,
                direct_number(root.keywords[0].value),
                direct_number(root.keywords[1].value),
            )
        if shape_kind == "double-arrow":
            cap = methods[0][1].args[0]
            start_tip = root.keywords[2].value
            end_tip = root.keywords[3].value
            assert isinstance(cap, ast.Attribute) and isinstance(start_tip, ast.Name) and isinstance(end_tip, ast.Name)
            return (
                shape_kind,
                cap.attr,
                direct_number(root.keywords[1].value),
                start_tip.id,
                end_tip.id,
            )
        if shape_kind == "freeform-path":
            joint = root.keywords[0].value
            assert isinstance(joint, ast.Attribute)
            cap = root.keywords[1].value if len(root.keywords) == 2 else None
            assert cap is None or isinstance(cap, ast.Attribute)
            start_call = methods[0][1]
            start = start_call.args[0]
            assert isinstance(start, ast.List)
            curves = tuple(
                tuple(
                    tuple(direct_number(coordinate) for coordinate in point.elts)
                    for point in curve_call.args
                    if isinstance(point, ast.List)
                )
                for name, curve_call in methods
                if name == "add_cubic_bezier_curve_to"
            )
            return (
                shape_kind,
                joint.attr,
                cap.attr if isinstance(cap, ast.Attribute) else None,
                tuple(direct_number(coordinate) for coordinate in start.elts),
                curves,
            )
        assert shape_kind == "brace"
        brace_root, brace_methods = method_chain(root.args[0])
        label_root, label_methods = method_chain(root.args[1])
        assert isinstance(brace_root, ast.Call) and isinstance(label_root, ast.Call)
        direction = brace_root.keywords[0].value
        assert isinstance(direction, ast.Name)
        assert isinstance(label_root.args[0], ast.Constant) and isinstance(label_root.args[0].value, str)
        return (
            shape_kind,
            direction.id,
            direct_number(brace_root.keywords[1].value),
            label_root.args[0].value,
            direct_number(label_root.keywords[0].value),
        )

    def current_shape_descriptors_match(
        expected: tuple[object, ...],
        actual: tuple[object, ...],
    ) -> bool:
        if expected[:1] != ("dashed-line",) or actual[:1] != ("dashed-line",):
            return actual == expected
        if len(expected) != 4 or len(actual) != 4 or actual[1] != expected[1]:
            return False

        expected_dash, expected_ratio = expected[2:]
        actual_dash, actual_ratio = actual[2:]
        if not all(isinstance(value, float) for value in (
            expected_dash,
            expected_ratio,
            actual_dash,
            actual_ratio,
        )):
            return False

        # dashLength/gapLength are immutable authored data. DashedLine's
        # emitted dash_length is nevertheless width-derived: the compiler may
        # move it inside a safe Manim ceil bin. Require the two literals'
        # possible rounded-authored origins to overlap, rather than accepting
        # an unbounded descriptor change.
        expected_dash_origin = (
            expected_dash / (1 + MAX_COMPILER_DASH_LENGTH_RELATIVE_DRIFT),
            expected_dash / (1 - MAX_COMPILER_DASH_LENGTH_RELATIVE_DRIFT),
        )
        actual_dash_origin = (
            actual_dash / (1 + MAX_COMPILER_DASH_LENGTH_RELATIVE_DRIFT),
            actual_dash / (1 - MAX_COMPILER_DASH_LENGTH_RELATIVE_DRIFT),
        )
        if max(expected_dash_origin[0], actual_dash_origin[0]) > min(
            expected_dash_origin[1], actual_dash_origin[1]
        ):
            return False

        # dashed_ratio is the emitted representation of dash/(dash+gap).
        # Overlapping compiler-drift intervals therefore prove a single
        # bounded authored ratio; a cap change remains exactly forbidden.
        expected_ratio_origin = (
            expected_ratio - MAX_COMPILER_DASHED_RATIO_DRIFT,
            expected_ratio + MAX_COMPILER_DASHED_RATIO_DRIFT,
        )
        actual_ratio_origin = (
            actual_ratio - MAX_COMPILER_DASHED_RATIO_DRIFT,
            actual_ratio + MAX_COMPILER_DASHED_RATIO_DRIFT,
        )
        return max(expected_ratio_origin[0], actual_ratio_origin[0]) <= min(
            expected_ratio_origin[1], actual_ratio_origin[1]
        )

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

    def validate_direct_object_call(call: ast.Call, object_name: str) -> tuple[str, object | None]:
        root, methods = method_chain(call)
        if not isinstance(root, ast.Name) or root.id != object_name:
            raise SourcePolicyError("Direct object mutation requires the current compiler object")
        names = [name for name, _ in methods]
        detail: object | None = None
        if names == ["shift"]:
            if call.keywords or len(call.args) != 1:
                raise SourcePolicyError("Object position is outside the exact compiler dialect")
            detail = validate_vector(
                call.args[0],
                MAX_DIRECT_MANIM_COORDINATE,
                "Object position is outside the compiler bounds",
            )
            operation = "shift"
        elif names == ["rotate"]:
            if len(call.args) != 1 or not has_exact_origin_keyword(call):
                raise SourcePolicyError("Object rotation is outside the exact compiler dialect")
            detail = validate_rotation(
                call.args[0],
                MAX_DIRECT_ROTATION,
                "Object rotation is outside the compiler bounds",
            )
            operation = "rotate"
        elif names == ["stretch", "stretch"]:
            scales: list[float] = []
            for (name, stretch_call), axis in zip(methods, (0, 1), strict=True):
                assert name == "stretch"
                if (
                    len(stretch_call.args) != 2
                    or direct_number(stretch_call.args[1]) != axis
                    or not has_exact_origin_keyword(stretch_call)
                ):
                    raise SourcePolicyError("Object scale stretch is outside the exact compiler dialect")
                scales.append(
                    bounded_nonzero_magnitude(
                        stretch_call.args[0],
                        MIN_AUTHORED_SCALE_MAGNITUDE,
                        MAX_AUTHORED_SCALE_MAGNITUDE,
                        "Object scale is outside the schema bounds",
                    )
                )
            detail = tuple(scales)
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
        return operation, detail

    def is_exact_local_stretch(
        call: ast.Call,
        axis: int,
        minimum: float,
        maximum: float,
        *,
        reject_identity: bool = True,
    ) -> bool:
        value = direct_number(call.args[0]) if len(call.args) == 2 else None
        return (
            value is not None
            and minimum <= abs(value) <= maximum
            and (not reject_identity or value != 1)
            and direct_number(call.args[1]) == axis
            and has_exact_origin_keyword(call)
        )

    def is_exact_dimension_phase(methods: list[tuple[str, ast.Call]]) -> bool:
        if len(methods) > 2:
            return False
        axes: list[int] = []
        for name, call in methods:
            if name == "stretch":
                axis = int(direct_number(call.args[1])) if len(call.args) == 2 and direct_number(call.args[1]) in {0, 1} else -1
                if axis < 0 or not is_exact_local_stretch(
                    call,
                    axis,
                    MIN_COPY_DIMENSION_RATIO,
                    MAX_COPY_DIMENSION_RATIO,
                ):
                    return False
            elif name in {"stretch_to_fit_width", "stretch_to_fit_height"}:
                axis = 0 if name == "stretch_to_fit_width" else 1
                value = direct_number(call.args[0]) if len(call.args) == 1 else None
                if call.keywords or value is None or not MIN_DIRECT_MANIM_DIMENSION <= value <= MAX_DIRECT_MANIM_DIMENSION:
                    return False
            else:
                return False
            axes.append(axis)
        return axes == sorted(set(axes))

    def is_exact_target_scale_phase(methods: list[tuple[str, ast.Call]]) -> bool:
        if len(methods) > 2:
            return False
        axes: list[int] = []
        for name, call in methods:
            axis = int(direct_number(call.args[1])) if len(call.args) == 2 and direct_number(call.args[1]) in {0, 1} else -1
            if (
                name != "stretch"
                or axis < 0
                or not is_exact_local_stretch(
                    call,
                    axis,
                    MIN_AUTHORED_SCALE_MAGNITUDE,
                    MAX_AUTHORED_SCALE_MAGNITUDE,
                )
            ):
                return False
            axes.append(axis)
        return axes == sorted(set(axes))

    def reciprocal_matches_emitted(start: float, inverse: float) -> bool:
        tolerance = MAX_EMITTED_DECIMAL_ROUNDING * (abs(start) + abs(inverse) + 1)
        return abs(start * inverse - 1) <= tolerance

    def validate_generic_rebuild_geometry(
        geometry: list[tuple[str, ast.Call]],
        owner: str,
    ) -> None:
        pose = initialization_poses[owner]
        index = 0
        start_shift = pose["shift"]
        assert isinstance(start_shift, tuple)
        if start_shift[:2] != (0.0, 0.0):
            if index >= len(geometry) or geometry[index][0] != "shift":
                raise SourcePolicyError("Copy rebuild must first reset the proven compiler position")
            reset_call = geometry[index][1]
            reset = validate_vector(reset_call.args[0], MAX_DIRECT_MANIM_COORDINATE, "Copy reset is outside the compiler bounds") if not reset_call.keywords and len(reset_call.args) == 1 else None
            if reset != (-start_shift[0], -start_shift[1], 0.0):
                raise SourcePolicyError("Copy rebuild position reset does not match its proven compiler owner")
            index += 1

        start_rotation = pose["rotation"]
        assert isinstance(start_rotation, float)
        if start_rotation != 0:
            if index >= len(geometry) or geometry[index][0] != "rotate":
                raise SourcePolicyError("Copy rebuild must invert the proven compiler rotation")
            rotate_call = geometry[index][1]
            if len(rotate_call.args) != 1 or not has_exact_origin_keyword(rotate_call):
                raise SourcePolicyError("Copy inverse rotation requires the exact local origin")
            inverse_rotation = validate_rotation(
                rotate_call.args[0],
                MAX_DIRECT_ROTATION,
                "Copy inverse rotation is outside the compiler bounds",
            )
            if inverse_rotation != -start_rotation:
                raise SourcePolicyError("Copy inverse rotation does not match its proven compiler owner")
            index += 1

        for axis, key in ((0, "scale_x"), (1, "scale_y")):
            start_scale = pose[key]
            assert isinstance(start_scale, float)
            if start_scale == 1:
                continue
            if index >= len(geometry) or geometry[index][0] != "stretch":
                raise SourcePolicyError("Copy rebuild must invert the proven compiler local scale")
            stretch_call = geometry[index][1]
            if not is_exact_local_stretch(
                stretch_call,
                axis,
                MIN_AUTHORED_SCALE_MAGNITUDE,
                MAX_AUTHORED_SCALE_MAGNITUDE,
                reject_identity=False,
            ):
                raise SourcePolicyError("Copy inverse scale requires the exact local origin and axis order")
            inverse_scale = direct_number(stretch_call.args[0])
            assert inverse_scale is not None
            if not reciprocal_matches_emitted(start_scale, inverse_scale):
                raise SourcePolicyError("Copy inverse scale does not match its proven compiler owner")
            index += 1

        if index >= len(geometry) or geometry[-1][0] != "shift":
            raise SourcePolicyError("Copy rebuild requires one final compiler shift")
        final_shift = geometry[-1][1]
        if final_shift.keywords or len(final_shift.args) != 1:
            raise SourcePolicyError("Copy target shift is outside the exact compiler dialect")
        validate_vector(final_shift.args[0], MAX_DIRECT_MANIM_COORDINATE, "Copy target shift is outside the compiler bounds")

        target_methods = geometry[index:-1]
        target_rotation: tuple[str, ast.Call] | None = None
        if target_methods and target_methods[-1][0] == "rotate":
            target_rotation = target_methods.pop()
            rotate_call = target_rotation[1]
            if len(rotate_call.args) != 1 or not has_exact_origin_keyword(rotate_call):
                raise SourcePolicyError("Copy target rotation requires the exact local origin")
            angle = validate_rotation(
                rotate_call.args[0],
                MAX_DIRECT_ROTATION,
                "Copy target rotation is outside the compiler bounds",
            )
            if angle == 0:
                raise SourcePolicyError("Compiler copy targets omit an identity rotation")

        phase_split = next(
            (
                split
                for split in range(len(target_methods) + 1)
                if is_exact_dimension_phase(target_methods[:split])
                and is_exact_target_scale_phase(target_methods[split:])
            ),
            None,
        )
        if phase_split is None:
            raise SourcePolicyError("Copy local dimension and scale phases are outside the exact compiler order")
        approved_sensitive_call_ids.update(id(call) for _, call in geometry)

    def validate_current_shape_payload(
        expression: ast.expr,
        expected_kind: str,
        expected_descriptor: tuple[object, ...],
    ) -> None:
        payload_root, payload_methods = method_chain(expression)
        if not payload_methods or payload_methods[-1][0] != "shift":
            raise SourcePolicyError("Current shape targets require one final local placement shift")
        placement_start = len(payload_methods) - 1
        shift_call = payload_methods[-1][1]
        if shift_call.keywords or len(shift_call.args) != 1:
            raise SourcePolicyError("Current shape target shift is outside the exact compiler dialect")
        validate_vector(shift_call.args[0], MAX_DIRECT_MANIM_COORDINATE, "Current shape target shift is outside the compiler bounds")

        if placement_start and payload_methods[placement_start - 1][0] == "rotate":
            placement_start -= 1
            rotate_call = payload_methods[placement_start][1]
            if len(rotate_call.args) != 1 or not has_exact_origin_keyword(rotate_call):
                raise SourcePolicyError("Current shape target rotation requires the exact local origin")
            angle = validate_rotation(
                rotate_call.args[0],
                MAX_DIRECT_ROTATION,
                "Current shape target rotation is outside the compiler bounds",
            )
            if angle == 0:
                raise SourcePolicyError("Compiler current shape targets omit an identity rotation")

        local_stretches: list[tuple[str, ast.Call]] = []
        while placement_start and payload_methods[placement_start - 1][0] == "stretch" and len(local_stretches) < 2:
            placement_start -= 1
            local_stretches.insert(0, payload_methods[placement_start])
        if not is_exact_target_scale_phase(local_stretches):
            raise SourcePolicyError("Current shape target scale is outside the exact local-axis order")

        prefix_expression: ast.expr = payload_methods[placement_start - 1][1] if placement_start else payload_root
        if validate_initialization_expression(prefix_expression, object_names) != "leaf":
            raise SourcePolicyError("Current shape target payload is not an exact compiler primitive")
        prefix_root, prefix_methods = method_chain(prefix_expression)
        actual_kind = exact_current_shape_kind(prefix_root, prefix_methods)
        if actual_kind != expected_kind:
            raise SourcePolicyError("Current shape target kind does not match its proven compiler owner")
        if not current_shape_descriptors_match(
            expected_descriptor,
            current_shape_descriptor(prefix_root, prefix_methods, actual_kind),
        ):
            raise SourcePolicyError("Current shape target descriptor does not match its proven compiler owner")
        approved_sensitive_call_ids.update(id(call) for _, call in payload_methods[placement_start:])

    def validate_copy_target(expression: ast.expr, references: dict[str, str]) -> str:
        root, methods = method_chain(expression)
        if not isinstance(root, ast.Name) or root.id not in references or not methods or methods[0][0] != "copy":
            raise SourcePolicyError("Transform targets require an exact compiler reference copy")
        copy_call = methods[0][1]
        if copy_call.args or copy_call.keywords:
            raise SourcePolicyError("Compiler reference copy cannot accept arguments")
        owner = references[root.id]
        approved_sensitive_call_ids.add(id(copy_call))

        current_shape_kind = object_shape_kinds.get(owner)
        method_names = [name for name, _ in methods]
        if current_shape_kind is not None and "become" in method_names:
            current_shape_descriptor_value = object_shape_descriptors[owner]
            open_freeform = (
                current_shape_kind == "freeform-path"
                and len(current_shape_descriptor_value) > 2
                and current_shape_descriptor_value[2] is not None
            )
            final_method = "set_stroke" if open_freeform else "set_opacity"
            if method_names != ["copy", "become", final_method]:
                raise SourcePolicyError("Current shape become copies require the exact compiler target")
            become_call = methods[1][1]
            if become_call.keywords or len(become_call.args) != 1:
                raise SourcePolicyError("Current shape become arguments are outside the exact compiler dialect")
            validate_current_shape_payload(
                become_call.args[0],
                current_shape_kind,
                object_shape_descriptors[owner],
            )
            if open_freeform:
                validate_freeform_opacity_override(methods[2][1])
            else:
                validate_style_method("set_opacity", methods[2][1])
                approved_sensitive_call_ids.add(id(methods[2][1]))
            approved_sensitive_call_ids.add(id(become_call))
            return owner

        style_names = {"set_color", "set_fill", "set_stroke", "set_opacity"}
        style_index = next(
            (index for index in range(1, len(methods)) if methods[index][0] in style_names),
            len(methods),
        )
        geometry = methods[1:style_index]
        if len(geometry) == 1 and geometry[0][0] == "shift":
            shift_call = geometry[0][1]
            if shift_call.keywords or len(shift_call.args) != 1:
                raise SourcePolicyError("Pure copy shift is outside the exact compiler dialect")
            delta = validate_vector(shift_call.args[0], MAX_COPY_SHIFT, "Pure copy shift is outside the compiler bounds")
            if delta[:2] == (0.0, 0.0):
                raise SourcePolicyError("Compiler copy targets omit an identity shift")
            approved_sensitive_call_ids.add(id(shift_call))
        elif geometry:
            validate_generic_rebuild_geometry(geometry, owner)

        index = style_index
        if current_shape_kind == "arrow":
            if index < len(methods) and methods[index][0] == "set_color":
                color_call = methods[index][1]
                if index + 1 >= len(methods) or methods[index + 1][0] != "set_stroke":
                    raise SourcePolicyError("Current Arrow copy colour requires the exact compiler stroke pair")
                stroke_call = methods[index + 1][1]
                validate_style_method("set_color", color_call)
                validate_style_method("set_stroke", stroke_call)
                if direct_hex(color_call.args[0]) != direct_hex(stroke_call.args[0]):
                    raise SourcePolicyError("Arrow copy tip and stroke colours must match the compiler paint")
                approved_sensitive_call_ids.update({id(color_call), id(stroke_call)})
                index += 2
            elif index < len(methods) and methods[index][0] in {"set_fill", "set_stroke"}:
                raise SourcePolicyError("Current Arrow copy paint requires the exact compiler colour and stroke pair")
        elif index < len(methods) and methods[index][0] == "set_color":
            raise SourcePolicyError("Copy set_color is reserved for proven current Arrow references")
        else:
            for style_name in ("set_fill", "set_stroke"):
                if index < len(methods) and methods[index][0] == style_name:
                    validate_style_method(style_name, methods[index][1])
                    approved_sensitive_call_ids.add(id(methods[index][1]))
                    index += 1
        if index >= len(methods) or methods[index][0] != "set_opacity" or index != len(methods) - 1:
            raise SourcePolicyError("Compiler Transform copy targets require one final opacity setter")
        validate_style_method("set_opacity", methods[index][1])
        approved_sensitive_call_ids.add(id(methods[index][1]))
        return owner

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
    object_shape_kinds: dict[str, str] = {}
    object_shape_descriptors: dict[str, tuple[object, ...]] = {}
    reference_owners: dict[str, str] = {}
    reference_by_owner: dict[str, str] = {}
    group_children: dict[str, tuple[str, ...]] = {}
    group_constructors: dict[str, str] = {}
    initialization_states: dict[str, dict[str, bool]] = {}
    initialization_poses: dict[str, dict[str, object]] = {}
    claimed_bindings: set[str] = set()

    def new_initialization_state() -> dict[str, bool]:
        return {
            "dimension": False,
            "stretch": False,
            "rotate": False,
            "shift": False,
            "reference": False,
            "opacity": False,
        }

    def new_initialization_pose() -> dict[str, object]:
        return {
            "scale_x": 1.0,
            "scale_y": 1.0,
            "rotation": 0.0,
            "shift": (0.0, 0.0, 0.0),
        }

    def apply_initialization_operation(object_name: str, operation: str, detail: object | None) -> None:
        state = initialization_states[object_name]
        if operation == "dimension":
            if any(state.values()):
                raise SourcePolicyError("Object dimension fitting must be the first direct compiler initialization")
        elif operation == "stretch":
            if state["stretch"] or state["rotate"] or state["shift"] or state["reference"] or state["opacity"]:
                raise SourcePolicyError("Object stretch is outside the compiler initialization order")
            assert isinstance(detail, tuple) and len(detail) == 2
            if detail == (1.0, 1.0):
                raise SourcePolicyError("Compiler object initialization omits an identity scale pair")
            initialization_poses[object_name]["scale_x"] = detail[0]
            initialization_poses[object_name]["scale_y"] = detail[1]
        elif operation == "rotate":
            if state["rotate"] or state["shift"] or state["reference"] or state["opacity"]:
                raise SourcePolicyError("Object rotate is outside the compiler initialization order")
            assert isinstance(detail, float)
            if detail == 0:
                raise SourcePolicyError("Compiler object initialization omits an identity rotation")
            initialization_poses[object_name]["rotation"] = detail
        elif operation == "shift":
            if state["shift"] or state["reference"] or state["opacity"]:
                raise SourcePolicyError("Object shift is duplicated or outside the compiler initialization order")
            assert isinstance(detail, tuple) and len(detail) == 3
            initialization_poses[object_name]["shift"] = detail
        elif operation == "opacity":
            if not state["shift"] or not state["reference"] or state["opacity"]:
                raise SourcePolicyError("Object hidden opacity is outside the compiler initialization order")
        state[operation] = True

    def require_initialized_leaves(names: set[str] | None = None) -> None:
        candidates = object_names if names is None else names
        if any(object_kinds.get(name) == "leaf" and not initialization_states[name]["shift"] for name in candidates):
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
        object_shape_kinds.clear()
        object_shape_descriptors.clear()
        reference_owners.clear()
        reference_by_owner.clear()
        group_children.clear()
        group_constructors.clear()
        initialization_states.clear()
        initialization_poses.clear()

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
                    or (object_kinds.get(copy_root.id) == "leaf" and (state is None or not state["shift"] or state["opacity"]))
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
                initialization_poses[target.id] = new_initialization_pose()
                claimed_bindings.add(target.id)
                root, methods = method_chain(statement.value)
                shape_kind = exact_current_shape_kind(root, methods)
                if shape_kind is not None:
                    object_shape_kinds[target.id] = shape_kind
                    object_shape_descriptors[target.id] = current_shape_descriptor(root, methods, shape_kind)
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
                require_initialized_leaves()
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
                require_initialized_leaves()
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
        operation, detail = validate_direct_object_call(call, current_object)
        apply_initialization_operation(current_object, operation, detail)

    require_initialized_leaves()

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
