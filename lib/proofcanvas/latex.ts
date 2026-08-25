import katex from "katex";

export const PROOFCANVAS_LATEX_MAX_CHARS = 500;

export const MATH_RENDERERS = ["mathtex", "tex"] as const;
export const MATH_MODES = ["display", "inline"] as const;

export type MathRenderer = (typeof MATH_RENDERERS)[number];
export type MathMode = (typeof MATH_MODES)[number];

export type MathProperties = Readonly<{
  content: string;
  renderer: MathRenderer;
  mode: MathMode;
}>;

export type LatexDiagnosticCode =
  | "LATEX_CONTENT_TOO_LONG"
  | "LATEX_CHARACTER_UNSUPPORTED"
  | "LATEX_COMMAND_FORBIDDEN"
  | "LATEX_COMMAND_UNSUPPORTED"
  | "LATEX_SYNTAX_INVALID";

export type LatexAnalysis =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: LatexDiagnosticCode; message: string; offset?: number }>;

export type MathPropertiesAnalysis =
  | Readonly<{ ok: true; properties: MathProperties }>
  | Readonly<{ ok: false; code: "MATH_PROPERTIES_INVALID" | LatexDiagnosticCode; message: string; offset?: number }>;

export type TexContentSegment = Readonly<{ kind: "text" | "math"; content: string }>;

const FORBIDDEN_COMMANDS = new Set([
  "catcode", "csname", "def", "include", "input", "newcommand", "openin", "openout",
  "read", "renewcommand", "special", "usepackage", "write",
]);

/**
 * Deliberately bounded common subset understood by the editor preview and the
 * pinned Manim renderer. Extending this set is a reviewed compiler change, not
 * an escape hatch for arbitrary TeX packages or process/file primitives.
 */
const ALLOWED_COMMANDS = new Set([
  "alpha", "bar", "beta", "cdot", "cos", "delta", "displaystyle",
  "emph", "epsilon", "frac", "gamma", "ge", "hat", "infty", "int", "lambda",
  "le", "left", "lim", "ln", "log", "mathbb", "mathbf", "mathrm", "neq",
  "operatorname", "overline", "pi", "prod", "right", "sin", "sqrt", "sum",
  "tan", "text", "textbf", "textit", "textstyle", "theta", "times", "to",
  "underline", "varphi", "vec",
]);

const ESCAPED_LITERAL_CHARACTERS = new Set(["\\", "{", "}", "_", "%", "$", "#", "&", ",", ";", ":", "!", " "]);
const TEX_PLAIN_TEXT_PUNCTUATION = new Set([" ", ".", ",", ";", ":", "!", "?", '"', "'", "(", ")", "[", "]", "-", "+", "=", "/", "*", "@"]);
const SCRIPT_SYMBOL_COMMANDS = new Set(["alpha", "beta", "delta", "epsilon", "gamma", "infty", "lambda", "pi", "theta", "varphi"]);
const TEXT_MODE_COMMANDS = new Set(["emph", "text", "textbf", "textit"]);
const TEXT_MODE_ESCAPES = new Set(["{", "}", "_", "%", "$", "#", "&", ",", ";", ":", "!", " "]);

const BRACED_COMMAND_ARITY = new Map<string, number>([
  ["bar", 1], ["emph", 1], ["frac", 2], ["hat", 1], ["mathbb", 1],
  ["mathbf", 1], ["mathrm", 1], ["operatorname", 1], ["overline", 1],
  ["text", 1], ["textbf", 1], ["textit", 1], ["underline", 1], ["vec", 1],
]);
const LEFT_DELIMITER_MATCH = new Map([
  ["(", ")"], ["[", "]"], ["<", ">"], ["|", "|"], ["\\{", "\\}"],
]);

function isTexPlainTextCharacter(character: string): boolean {
  return /[a-zA-Z0-9]/.test(character) || ["\t", "\n", "\r"].includes(character) || TEX_PLAIN_TEXT_PUNCTUATION.has(character);
}

function invalid(
  code: LatexDiagnosticCode,
  message: string,
  offset?: number,
): LatexAnalysis {
  return { ok: false, code, message, ...(offset === undefined ? {} : { offset }) };
}

function skipLatexWhitespace(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length && /\s/.test(value[cursor])) cursor += 1;
  return cursor;
}

function balancedDelimiterEnd(value: string, start: number, open: string, close: string): number | undefined {
  if (value[start] !== open) return undefined;
  let depth = 1;
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    if (value[cursor] === "\\" && cursor + 1 < value.length) {
      cursor += 1;
      continue;
    }
    if (value[cursor] === open) depth += 1;
    else if (value[cursor] === close) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return undefined;
}

function latexDelimiterAt(value: string, start: number): Readonly<{ token: string; end: number }> | null {
  const cursor = skipLatexWhitespace(value, start);
  const direct = value[cursor];
  if ([".", "(", ")", "[", "]", "<", ">", "|"].includes(direct)) return { token: direct, end: cursor + 1 };
  const escaped = value.slice(cursor, cursor + 2);
  if (escaped === "\\{" || escaped === "\\}") return { token: escaped, end: cursor + 2 };
  return null;
}

function scriptSyntaxDiagnostic(value: string): LatexAnalysis | null {
  const scan = (start: number, end: number): LatexAnalysis | null => {
    let index = start;
    while (index < end) {
      index = skipLatexWhitespace(value, index);
      if (index >= end) break;
      const character = value[index];
      if (character === "^" || character === "_") {
        return invalid("LATEX_SYNTAX_INVALID", `Missing base before "${character}" at character ${index + 1}.`, index);
      }

      if (character === "{") {
        const groupEnd = balancedDelimiterEnd(value, index, "{", "}");
        if (groupEnd === undefined) return null;
        const nested = scan(index + 1, groupEnd - 1);
        if (nested) return nested;
        index = groupEnd;
      } else if (character === "\\") {
        const next = value[index + 1];
        if (next === undefined) return null;
        if (/[a-zA-Z]/.test(next)) {
          index += 2;
          while (index < end && /[a-zA-Z]/.test(value[index])) index += 1;
        } else index += 2;
      } else index += 1;

      const scripts = new Set<string>();
      while (index < end) {
        const markerOffset = skipLatexWhitespace(value, index);
        const marker = value[markerOffset];
        if (marker !== "^" && marker !== "_") {
          index = markerOffset;
          break;
        }
        if (scripts.has(marker)) {
          return invalid("LATEX_SYNTAX_INVALID", `Duplicate "${marker}" script at character ${markerOffset + 1}.`, markerOffset);
        }
        scripts.add(marker);
        const argumentOffset = skipLatexWhitespace(value, markerOffset + 1);
        const argument = value[argumentOffset];
        if (argument === undefined || argumentOffset >= end || argument === "}" || argument === "$" || argument === "^" || argument === "_") {
          return invalid("LATEX_SYNTAX_INVALID", `Missing argument after "${marker}" at character ${markerOffset + 1}.`, markerOffset);
        }
        if (argument === "{") {
          const groupEnd = balancedDelimiterEnd(value, argumentOffset, "{", "}");
          if (groupEnd === undefined) return null;
          const nested = scan(argumentOffset + 1, groupEnd - 1);
          if (nested) return nested;
          index = groupEnd;
        } else if (argument === "\\") {
          const next = value[argumentOffset + 1];
          if (next === undefined) return null;
          if (!/[a-zA-Z]/.test(next)) {
            return invalid(
              "LATEX_SYNTAX_INVALID",
              `An unbraced script argument must be one ASCII letter, digit, or supported symbol command at character ${argumentOffset + 1}.`,
              argumentOffset,
            );
          }
          let commandEnd = argumentOffset + 2;
          while (commandEnd < end && /[a-zA-Z]/.test(value[commandEnd])) commandEnd += 1;
          const command = value.slice(argumentOffset + 1, commandEnd);
          if (!SCRIPT_SYMBOL_COMMANDS.has(command)) {
            return invalid(
              "LATEX_SYNTAX_INVALID",
              `LaTeX command \\${command} must be braced when used as a script argument at character ${argumentOffset + 1}.`,
              argumentOffset,
            );
          }
          index = commandEnd;
        } else {
          if (!/[a-zA-Z0-9]/.test(argument)) {
            return invalid(
              "LATEX_SYNTAX_INVALID",
              `An unbraced script argument must be one ASCII letter, digit, or supported symbol command at character ${argumentOffset + 1}.`,
              argumentOffset,
            );
          }
          index = argumentOffset + 1;
        }
      }
    }
    return null;
  };
  return scan(0, value.length);
}

function commandArgumentsDiagnostic(
  value: string,
  command: Readonly<{ name: string; start: number; end: number }>,
): LatexAnalysis | null {
  let cursor = command.end;
  if (command.name === "sqrt") {
    cursor = skipLatexWhitespace(value, cursor);
    if (value[cursor] === "[") {
      const indexEnd = balancedDelimiterEnd(value, cursor, "[", "]");
      if (indexEnd === undefined) {
        return invalid("LATEX_SYNTAX_INVALID", `LaTeX command \\sqrt has an unclosed optional index at character ${cursor + 1}.`, cursor);
      }
      if (!value.slice(cursor + 1, indexEnd - 1).trim()) {
        return invalid("LATEX_SYNTAX_INVALID", `LaTeX command \\sqrt requires a nonempty optional index at character ${cursor + 1}.`, cursor);
      }
      if (scriptSyntaxDiagnostic(value.slice(cursor + 1, indexEnd - 1))) {
        return invalid("LATEX_SYNTAX_INVALID", `LaTeX command \\sqrt has an invalid optional index at character ${cursor + 1}.`, cursor);
      }
      cursor = indexEnd;
    }
  }
  const arity = command.name === "sqrt" ? 1 : BRACED_COMMAND_ARITY.get(command.name) ?? 0;
  for (let argument = 0; argument < arity; argument += 1) {
    cursor = skipLatexWhitespace(value, cursor);
    if (value[cursor] !== "{") {
      return invalid(
        "LATEX_SYNTAX_INVALID",
        `LaTeX command \\${command.name} requires ${arity === 1 ? "a braced argument" : `${arity} braced arguments`} at character ${command.start + 1}.`,
        command.start,
      );
    }
    const groupEnd = balancedDelimiterEnd(value, cursor, "{", "}");
    if (groupEnd === undefined) return null;
    if (TEXT_MODE_COMMANDS.has(command.name)) {
      for (let offset = cursor + 1; offset < groupEnd - 1; offset += 1) {
        const character = value[offset];
        if (character === "\\") {
          const escaped = value[offset + 1];
          if (escaped === undefined || !TEXT_MODE_ESCAPES.has(escaped)) {
            return invalid(
              "LATEX_SYNTAX_INVALID",
              `LaTeX command \\${command.name} contains an unsupported text escape at character ${offset + 1}.`,
              offset,
            );
          }
          offset += 1;
          continue;
        }
        if (!isTexPlainTextCharacter(character)) {
          return invalid(
            "LATEX_SYNTAX_INVALID",
            `LaTeX command \\${command.name} contains an unsupported text character at character ${offset + 1}.`,
            offset,
          );
        }
      }
    }
    cursor = groupEnd;
  }
  return null;
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Splits only unescaped Tex math shifts; escaped dollar literals stay text. */
export function texContentSegments(value: string): TexContentSegment[] {
  const segments: TexContentSegment[] = [];
  let kind: TexContentSegment["kind"] = "text";
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "$" || isEscaped(value, index)) continue;
    segments.push({ kind, content: value.slice(start, index) });
    kind = kind === "text" ? "math" : "text";
    start = index + 1;
  }
  segments.push({ kind, content: value.slice(start) });
  return segments;
}

function katexSyntaxDiagnostic(content: string): LatexAnalysis {
  try {
    katex.renderToString(content, {
      displayMode: false,
      maxExpand: 256,
      output: "html",
      strict: "error",
      throwOnError: true,
      trust: false,
    });
    return { ok: true };
  } catch (error) {
    const position = error && typeof error === "object" && "position" in error && typeof error.position === "number"
      ? error.position
      : undefined;
    const detail = error instanceof Error
      ? error.message.replace(/^KaTeX parse error:\s*/i, "").replace(/\s+at position \d+:?[\s\S]*$/i, "").trim()
      : "The expression could not be parsed.";
    return invalid(
      "LATEX_SYNTAX_INVALID",
      position === undefined
        ? `LaTeX syntax is invalid: ${detail}`
        : `LaTeX syntax is invalid at character ${position + 1}: ${detail}`,
      position,
    );
  }
}

/**
 * One deterministic, non-expanding LaTeX analysis authority for every
 * untrusted ingress and render surface. This is intentionally a safe dialect
 * checker, not a TeX interpreter: it performs a single bounded scan, never
 * opens files, imports packages, expands macros, evaluates code, or performs
 * network work.
 */
export function analyzeLatex(
  value: string,
  options: Readonly<{ renderer?: MathRenderer }> = {},
): LatexAnalysis {
  if (value.length > PROOFCANVAS_LATEX_MAX_CHARS) {
    return invalid(
      "LATEX_CONTENT_TOO_LONG",
      `LaTeX content may contain at most ${PROOFCANVAS_LATEX_MAX_CHARS} characters.`,
      PROOFCANVAS_LATEX_MAX_CHARS,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    if (codePoint > 0x7e) {
      return invalid("LATEX_CHARACTER_UNSUPPORTED", `LaTeX content must use the renderer-safe ASCII dialect (character ${index + 1}).`, index);
    }
    if (codePoint > 0xffff) index += 1;
  }
  const unsafeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(value);
  if (unsafeControl) {
    return invalid("LATEX_SYNTAX_INVALID", `Unsupported control character at character ${unsafeControl.index + 1}.`, unsafeControl.index);
  }
  const traversal = /(?:\.\.[/\\]|\^\^)/.exec(value);
  if (traversal) {
    return invalid("LATEX_SYNTAX_INVALID", `Unsafe path-like sequence at character ${traversal.index + 1}.`, traversal.index);
  }

  const braces: number[] = [];
  const leftCommands: Array<Readonly<{ offset: number; delimiter: string; braceDepth: number; dollarScope?: number }>> = [];
  const commands: Array<Readonly<{ name: string; start: number; end: number }>> = [];
  let dollarOffset: number | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      const commandStart = index;
      const next = value[index + 1];
      if (next === undefined) {
        return invalid("LATEX_SYNTAX_INVALID", `Dangling "\\" at character ${index + 1}.`, index);
      }
      if (next === "\\") {
        const modifierOffset = index + 2;
        if (value[modifierOffset] === "[" || value[modifierOffset] === "*") {
          return invalid(
            "LATEX_SYNTAX_INVALID",
            `LaTeX linebreak modifiers are outside the supported dialect at character ${modifierOffset + 1}.`,
            modifierOffset,
          );
        }
        index += 1;
        continue;
      }
      if (!/[a-zA-Z]/.test(next)) {
        if (!ESCAPED_LITERAL_CHARACTERS.has(next)) {
          return invalid("LATEX_SYNTAX_INVALID", `Unsupported escape \\${next} at character ${index + 1}.`, index);
        }
        index += 1;
        continue;
      }
      let end = index + 2;
      while (end < value.length && /[a-zA-Z]/.test(value[end])) end += 1;
      const command = value.slice(index + 1, end);
      if (FORBIDDEN_COMMANDS.has(command.toLowerCase())) {
        return invalid("LATEX_COMMAND_FORBIDDEN", `LaTeX command \\${command} is forbidden at character ${commandStart + 1}.`, commandStart);
      }
      if (!ALLOWED_COMMANDS.has(command)) {
        return invalid("LATEX_COMMAND_UNSUPPORTED", `LaTeX command \\${command} is outside the supported dialect at character ${commandStart + 1}.`, commandStart);
      }
      if (options.renderer === "tex" && dollarOffset === undefined) {
        return invalid("LATEX_SYNTAX_INVALID", `Tex commands such as \\${command} must appear inside "$" delimiters (character ${commandStart + 1}).`, commandStart);
      }
      commands.push({ name: command, start: commandStart, end });
      if (command === "left" || command === "right") {
        const delimiter = latexDelimiterAt(value, end);
        if (!delimiter) {
          return invalid("LATEX_SYNTAX_INVALID", `LaTeX command \\${command} requires a supported delimiter at character ${commandStart + 1}.`, commandStart);
        }
        if (command === "left") {
          if (delimiter.token !== "." && !LEFT_DELIMITER_MATCH.has(delimiter.token)) {
            return invalid("LATEX_SYNTAX_INVALID", `LaTeX command \\left has an invalid opening delimiter at character ${commandStart + 1}.`, commandStart);
          }
          leftCommands.push({
            offset: commandStart,
            delimiter: delimiter.token,
            braceDepth: braces.length,
            ...(dollarOffset === undefined ? {} : { dollarScope: dollarOffset }),
          });
        } else {
          const validRight = delimiter.token === "." || [...LEFT_DELIMITER_MATCH.values()].includes(delimiter.token);
          if (!validRight) {
            return invalid("LATEX_SYNTAX_INVALID", `LaTeX command \\right has an invalid closing delimiter at character ${commandStart + 1}.`, commandStart);
          }
          const left = leftCommands.pop();
          if (!left) {
            return invalid("LATEX_SYNTAX_INVALID", `LaTeX command \\right has no preceding \\left at character ${commandStart + 1}.`, commandStart);
          }
          if (left.braceDepth !== braces.length || left.dollarScope !== dollarOffset) {
            return invalid("LATEX_SYNTAX_INVALID", `LaTeX command \\right crosses a brace or Tex math-segment boundary at character ${commandStart + 1}.`, commandStart);
          }
          if (left.delimiter !== "." && delimiter.token !== "." && LEFT_DELIMITER_MATCH.get(left.delimiter) !== delimiter.token) {
            return invalid("LATEX_SYNTAX_INVALID", `LaTeX \\left and \\right delimiters do not match at character ${commandStart + 1}.`, commandStart);
          }
        }
      }
      index = end - 1;
      continue;
    }
    if (character === "{") {
      if (options.renderer === "tex" && dollarOffset === undefined) {
        return invalid("LATEX_SYNTAX_INVALID", `Tex special character "{" must be escaped at character ${index + 1}.`, index);
      }
      braces.push(index);
    }
    else if (character === "}") {
      if (options.renderer === "tex" && dollarOffset === undefined) {
        return invalid("LATEX_SYNTAX_INVALID", `Tex special character "}" must be escaped at character ${index + 1}.`, index);
      }
      if (!braces.length) return invalid("LATEX_SYNTAX_INVALID", `Unexpected "}" at character ${index + 1}.`, index);
      const unclosedScopedLeft = leftCommands.find(({ braceDepth, dollarScope }) => braceDepth === braces.length && dollarScope === dollarOffset);
      if (unclosedScopedLeft) {
        return invalid("LATEX_SYNTAX_INVALID", `Brace closes before the matching \\right for \\left at character ${unclosedScopedLeft.offset + 1}.`, index);
      }
      braces.pop();
    } else if ((character === "^" || character === "_") && !isEscaped(value, index)) {
      if (options.renderer === "tex" && dollarOffset === undefined) {
        return invalid("LATEX_SYNTAX_INVALID", `Tex mathematical marker "${character}" must appear inside "$" delimiters (character ${index + 1}).`, index);
      }
      const next = value[index + 1];
      if (next === undefined || next === "}" || next === "$" || next === "^" || next === "_" || /\s/.test(next)) {
        return invalid("LATEX_SYNTAX_INVALID", `Missing argument after "${character}" at character ${index + 1}.`, index);
      }
    } else if (["#", "%", "&"].includes(character) && !isEscaped(value, index)) {
      return invalid(
        "LATEX_SYNTAX_INVALID",
        options.renderer === "tex" && dollarOffset === undefined
          ? `Tex special character "${character}" must be escaped at character ${index + 1}.`
          : `LaTeX special character "${character}" must be escaped at character ${index + 1}.`,
        index,
      );
    } else if (character === "$" && !isEscaped(value, index)) {
      if (options.renderer === "mathtex") {
        return invalid("LATEX_SYNTAX_INVALID", `MathTex content must not include "$" delimiters (character ${index + 1}).`, index);
      }
      if (value[index + 1] === "$") {
        return invalid("LATEX_SYNTAX_INVALID", `Use the math mode field instead of "$$" delimiters (character ${index + 1}).`, index);
      }
      if (dollarOffset === undefined) dollarOffset = index;
      else {
        const unclosedSegmentLeft = leftCommands.find(({ dollarScope }) => dollarScope === dollarOffset);
        if (unclosedSegmentLeft) {
          return invalid("LATEX_SYNTAX_INVALID", `Tex math segment closes before the matching \\right for \\left at character ${unclosedSegmentLeft.offset + 1}.`, index);
        }
        dollarOffset = undefined;
      }
    } else if (options.renderer === "tex" && dollarOffset === undefined && !isTexPlainTextCharacter(character)) {
      return invalid("LATEX_CHARACTER_UNSUPPORTED", `Tex plain text uses an unsupported character at character ${index + 1}.`, index);
    }
  }

  if (braces.length) {
    const offset = braces.at(-1)!;
    return invalid("LATEX_SYNTAX_INVALID", `Unclosed "{" at character ${offset + 1}.`, offset);
  }
  if (leftCommands.length) {
    const offset = leftCommands.at(-1)!.offset;
    return invalid("LATEX_SYNTAX_INVALID", `LaTeX command \\left has no following \\right at character ${offset + 1}.`, offset);
  }
  if (dollarOffset !== undefined) {
    return invalid("LATEX_SYNTAX_INVALID", `Unclosed "$" delimiter at character ${dollarOffset + 1}.`, dollarOffset);
  }
  const scriptDiagnostic = scriptSyntaxDiagnostic(value);
  if (scriptDiagnostic) return scriptDiagnostic;
  for (const command of commands) {
    const commandDiagnostic = commandArgumentsDiagnostic(value, command);
    if (commandDiagnostic) return commandDiagnostic;
  }
  const texSegments = options.renderer === "tex" ? texContentSegments(value) : [];
  if (texSegments.some(({ kind }) => kind === "math")) {
    for (const segment of texSegments) {
      if (segment.kind !== "math") continue;
      const parsed = katexSyntaxDiagnostic(segment.content);
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }
  if (options.renderer === "tex") return { ok: true };
  return katexSyntaxDiagnostic(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Backward-compatible schema-v3 defaults for math objects created before this contract. */
export function normalizeLegacyMathProperties(value: unknown): unknown {
  const properties = record(value);
  if (!properties) return value;
  return {
    ...properties,
    ...(properties.renderer === undefined ? { renderer: "mathtex" } : {}),
    ...(properties.mode === undefined ? { mode: "display" } : {}),
  };
}

export function analyzeMathProperties(value: unknown): MathPropertiesAnalysis {
  const properties = record(value);
  if (!properties) return { ok: false, code: "MATH_PROPERTIES_INVALID", message: "Math properties must be an object." };
  if (typeof properties.content !== "string") {
    return { ok: false, code: "MATH_PROPERTIES_INVALID", message: "Math content must be a string." };
  }
  if (properties.renderer !== "mathtex" && properties.renderer !== "tex") {
    return { ok: false, code: "MATH_PROPERTIES_INVALID", message: 'Math renderer must be "mathtex" or "tex".' };
  }
  if (properties.mode !== "display" && properties.mode !== "inline") {
    return { ok: false, code: "MATH_PROPERTIES_INVALID", message: 'Math mode must be "display" or "inline".' };
  }
  const analysis = analyzeLatex(properties.content, { renderer: properties.renderer });
  if (!analysis.ok) return analysis;
  return {
    ok: true,
    properties: {
      content: properties.content,
      renderer: properties.renderer,
      mode: properties.mode,
    },
  };
}
