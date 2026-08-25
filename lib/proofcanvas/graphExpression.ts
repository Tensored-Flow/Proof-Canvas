import { RestrictedExpressionSchema, type RestrictedExpression } from "./schema";

/**
 * One bounded graph VM for authoring, browser preview, and Manim compilation.
 * The persisted schema remains the existing RestrictedExpression AST; this
 * module only derives deterministic diagnostics and literal geometry from it.
 */
export const GRAPH_EXPRESSION_LIMITS = Object.freeze({
  // A 64-node canonical AST is bounded below 4 KiB even when every leaf is a
  // longest-form binary64 literal. Tokens/nodes/depth remain the computational
  // limits; this larger text envelope guarantees format -> parse closure.
  sourceChars: 4_096,
  // Every formatter-emitted AST occurrence costs at most five lexical tokens.
  // The extra grouping around a negative/negated power base is paid by that
  // child's unused token budget, so 5 * 64 closes format -> parse for the
  // complete current grammar (the exact enumerated maximum is 304).
  tokens: 320,
  nodes: 64,
  depth: 12,
  evaluations: 4_096,
  initialSamplePoints: 33,
  rangeSamplePoints: 257,
  samplePoints: 257,
  samplingDepth: 18,
  unsafeSamplingDepth: 3,
  segments: 128,
  magnitude: 1_000_000,
} as const);

export type GraphExpressionDiagnosticCode =
  | "GRAPH_SOURCE_TOO_LONG"
  | "GRAPH_TOKEN_LIMIT_EXCEEDED"
  | "GRAPH_SYNTAX_INVALID"
  | "GRAPH_AST_INVALID"
  | "GRAPH_NODE_LIMIT_EXCEEDED"
  | "GRAPH_DEPTH_LIMIT_EXCEEDED"
  | "GRAPH_DOMAIN_INVALID"
  | "GRAPH_CONSTANT_DIVISION_BY_ZERO"
  | "GRAPH_CONSTANT_POWER_UNDEFINED"
  | "GRAPH_CONSTANT_NONFINITE"
  | "GRAPH_CONSTANT_MAGNITUDE_EXCEEDED"
  | "GRAPH_EVALUATION_LIMIT_EXCEEDED"
  | "GRAPH_SAMPLING_BUDGET_EXCEEDED"
  | "GRAPH_SEGMENT_LIMIT_EXCEEDED"
  | "GRAPH_NO_DRAWABLE_SEGMENTS"
  | "GRAPH_OPERATIONAL_RANGE_UNCERTIFIED"
  | "GRAPH_DISCONTINUITIES_SEGMENTED"
  | "GRAPH_SAMPLES_OMITTED";

export interface GraphExpressionDiagnostic {
  severity: "error" | "warning";
  code: GraphExpressionDiagnosticCode;
  message: string;
  position?: number;
}

export interface GraphPoint {
  x: number;
  y: number;
}

export interface NormalizedGraphPoint {
  /** Local horizontal coordinate, from -0.5 through 0.5. */
  x: number;
  /** Local mathematical vertical coordinate, from -0.5 through 0.5. */
  y: number;
}

export interface GraphExpressionAnalysis {
  ok: boolean;
  canonical: string;
  analysisHash: string;
  diagnostics: readonly GraphExpressionDiagnostic[];
  segments: readonly (readonly GraphPoint[])[];
  normalizedSegments: readonly (readonly NormalizedGraphPoint[])[];
  evaluations: number;
  nodeCount: number;
  maxDepth: number;
  yRange: Readonly<{ min: number; max: number }> | null;
}

export type GraphExpressionParseResult =
  | Readonly<{ ok: true; expression: RestrictedExpression; canonical: string }>
  | Readonly<{ ok: false; diagnostic: GraphExpressionDiagnostic }>;

type TokenKind = "number" | "identifier" | "+" | "-" | "*" | "/" | "^" | "(" | ")" | "eof";
type Token = Readonly<{ kind: TokenKind; text: string; position: number }>;

class GraphParseFailure extends Error {
  constructor(readonly diagnostic: GraphExpressionDiagnostic) {
    super(diagnostic.message);
  }
}

function diagnostic(
  code: GraphExpressionDiagnosticCode,
  message: string,
  position?: number,
): GraphExpressionDiagnostic {
  return position === undefined
    ? { severity: "error", code, message }
    : { severity: "error", code, message, position };
}

function losslessSourceNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  // ECMAScript's number string is the shortest decimal that round-trips to
  // the same binary64 value. Canonical authority must never use display
  // quantization or merge two distinct constants.
  return value.toString();
}

const GRAPH_GEOMETRY_HASH_VERSION = "graph-v3-q12";
const GRAPH_GEOMETRY_HASH_DECIMALS = 12;

/** Geometry hashing is deliberately quantized; source/canonical text is not. */
function geometryHashNumber(value: number): string {
  const serialized = value.toFixed(GRAPH_GEOMETRY_HASH_DECIMALS);
  return serialized === "-0.000000000000" ? "0.000000000000" : serialized;
}

function tokenize(source: string): Token[] {
  if (source.length > GRAPH_EXPRESSION_LIMITS.sourceChars) {
    throw new GraphParseFailure(diagnostic(
      "GRAPH_SOURCE_TOO_LONG",
      `Graph expression may contain at most ${GRAPH_EXPRESSION_LIMITS.sourceChars} characters.`,
    ));
  }
  const tokens: Token[] = [];
  let cursor = 0;
  const append = (token: Token) => {
    tokens.push(token);
    if (tokens.length > GRAPH_EXPRESSION_LIMITS.tokens) {
      throw new GraphParseFailure(diagnostic(
        "GRAPH_TOKEN_LIMIT_EXCEEDED",
        `Graph expression may contain at most ${GRAPH_EXPRESSION_LIMITS.tokens} tokens.`,
        token.position,
      ));
    }
  };
  while (cursor < source.length) {
    const character = source[cursor];
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    const number = source.slice(cursor).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u)?.[0];
    if (number) {
      append({ kind: "number", text: number, position: cursor });
      cursor += number.length;
      continue;
    }
    const identifier = source.slice(cursor).match(/^[a-zA-Z]+/u)?.[0];
    if (identifier) {
      append({ kind: "identifier", text: identifier.toLowerCase(), position: cursor });
      cursor += identifier.length;
      continue;
    }
    if (["+", "-", "*", "/", "^", "(", ")"].includes(character)) {
      append({ kind: character as TokenKind, text: character, position: cursor });
      cursor += 1;
      continue;
    }
    throw new GraphParseFailure(diagnostic(
      "GRAPH_SYNTAX_INVALID",
      `Unexpected character “${character}” at character ${cursor + 1}.`,
      cursor,
    ));
  }
  tokens.push({ kind: "eof", text: "", position: source.length });
  return tokens;
}

class Parser {
  private cursor = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): RestrictedExpression {
    const expression = this.additive();
    const trailing = this.peek();
    if (trailing.kind !== "eof") this.fail(trailing, `Unexpected token “${trailing.text}”`);
    return expression;
  }

  private peek(): Token {
    return this.tokens[this.cursor] ?? this.tokens[this.tokens.length - 1];
  }

  private consume(kind?: TokenKind): Token {
    const token = this.peek();
    if (kind && token.kind !== kind) this.fail(token, `Expected “${kind}”`);
    this.cursor += 1;
    return token;
  }

  private fail(token: Token, message: string): never {
    throw new GraphParseFailure(diagnostic(
      "GRAPH_SYNTAX_INVALID",
      `${message} at character ${token.position + 1}.`,
      token.position,
    ));
  }

  private additive(): RestrictedExpression {
    let expression = this.multiplicative();
    while (this.peek().kind === "+" || this.peek().kind === "-") {
      const operator = this.consume().kind;
      expression = {
        kind: operator === "+" ? "add" : "subtract",
        left: expression,
        right: this.multiplicative(),
      };
    }
    return expression;
  }

  private multiplicative(): RestrictedExpression {
    let expression = this.unary();
    while (this.peek().kind === "*" || this.peek().kind === "/") {
      const operator = this.consume().kind;
      expression = {
        kind: operator === "*" ? "multiply" : "divide",
        left: expression,
        right: this.unary(),
      };
    }
    return expression;
  }

  private unary(): RestrictedExpression {
    if (this.peek().kind === "+") {
      this.consume("+");
      return this.unary();
    }
    if (this.peek().kind === "-") {
      this.consume("-");
      // Keep a signed literal (`-2`) distinct from an explicitly authored
      // unary node (`-(2)`). The formatter relies on that distinction for
      // structural round trips and GraphInspector domain-only edits.
      const operandStartsWithNumber = this.peek().kind === "number";
      const value = this.unary();
      if (operandStartsWithNumber && value.kind === "constant") {
        const negated = -value.value;
        return { kind: "constant", value: Object.is(negated, -0) ? 0 : negated };
      }
      return { kind: "negate", value };
    }
    return this.power();
  }

  private power(): RestrictedExpression {
    const base = this.primary();
    if (this.peek().kind !== "^") return base;
    this.consume("^");
    let sign = 1;
    if (this.peek().kind === "+" || this.peek().kind === "-") sign = this.consume().kind === "-" ? -1 : 1;
    const token = this.consume("number");
    const parsedExponent = sign * Number(token.text);
    const exponent = Object.is(parsedExponent, -0) ? 0 : parsedExponent;
    if (!Number.isInteger(exponent) || exponent < -8 || exponent > 8) {
      this.fail(token, "A power exponent must be an integer from -8 through 8");
    }
    return { kind: "power", base, exponent };
  }

  private primary(): RestrictedExpression {
    const token = this.peek();
    if (token.kind === "number") {
      this.consume();
      const value = Number(token.text);
      if (!Number.isFinite(value) || Math.abs(value) > GRAPH_EXPRESSION_LIMITS.magnitude) {
        this.fail(token, `A constant must be finite with magnitude at most ${GRAPH_EXPRESSION_LIMITS.magnitude}`);
      }
      return { kind: "constant", value };
    }
    if (token.kind === "identifier") {
      this.consume();
      if (token.text === "x") return { kind: "variable" };
      if (!["sin", "cos", "abs"].includes(token.text)) this.fail(token, `Unknown function or variable “${token.text}”`);
      this.consume("(");
      const value = this.additive();
      this.consume(")");
      return { kind: token.text as "sin" | "cos" | "abs", value };
    }
    if (token.kind === "(") {
      this.consume("(");
      const expression = this.additive();
      this.consume(")");
      return expression;
    }
    this.fail(token, token.kind === "eof" ? "Expected a graph expression" : `Unexpected token “${token.text}”`);
  }
}

export function parseGraphExpression(source: string): GraphExpressionParseResult {
  try {
    // Parsing is syntax authority only. Domain-sensitive mathematical
    // normalization belongs to evaluation/analysis, where the original AST is
    // retained as its operational-failure shadow.
    const expression = new Parser(tokenize(source)).parse();
    const bounded = validateStructure(expression);
    if (bounded.diagnostic) return { ok: false, diagnostic: bounded.diagnostic };
    return { ok: true, expression, canonical: formatGraphExpression(expression) };
  } catch (error) {
    if (error instanceof GraphParseFailure) return { ok: false, diagnostic: error.diagnostic };
    return { ok: false, diagnostic: diagnostic("GRAPH_SYNTAX_INVALID", "Graph expression could not be parsed.") };
  }
}

export function formatGraphExpression(expression: RestrictedExpression): string {
  switch (expression.kind) {
    case "constant": return losslessSourceNumber(expression.value);
    case "variable": return "x";
    case "add": return `(${formatGraphExpression(expression.left)} + ${formatGraphExpression(expression.right)})`;
    case "subtract": return `(${formatGraphExpression(expression.left)} - ${formatGraphExpression(expression.right)})`;
    case "multiply": return `(${formatGraphExpression(expression.left)} * ${formatGraphExpression(expression.right)})`;
    case "divide": return `(${formatGraphExpression(expression.left)} / ${formatGraphExpression(expression.right)})`;
    case "power": {
      const formattedBase = formatGraphExpression(expression.base);
      const baseRequiresGrouping = expression.base.kind === "negate"
        || (expression.base.kind === "constant" && expression.base.value < 0);
      return `(${baseRequiresGrouping ? `(${formattedBase})` : formattedBase} ^ ${expression.exponent})`;
    }
    case "sin": return `sin(${formatGraphExpression(expression.value)})`;
    case "cos": return `cos(${formatGraphExpression(expression.value)})`;
    case "abs": return `abs(${formatGraphExpression(expression.value)})`;
    case "negate": return `-(${formatGraphExpression(expression.value)})`;
  }
}

function graphExpressionsEqual(left: RestrictedExpression, right: RestrictedExpression): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "constant": return right.kind === "constant" && left.value === right.value;
    case "variable": return true;
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
      return right.kind === left.kind
        && graphExpressionsEqual(left.left, right.left)
        && graphExpressionsEqual(left.right, right.right);
    case "power": return right.kind === "power"
      && left.exponent === right.exponent
      && graphExpressionsEqual(left.base, right.base);
    case "sin":
    case "cos":
    case "abs":
    case "negate": return right.kind === left.kind && graphExpressionsEqual(left.value, right.value);
  }
}

function intervalExcludesZero(value: Interval): boolean {
  return Number.isFinite(value.min)
    && Number.isFinite(value.max)
    && (value.max < 0 || value.min > 0);
}

function pythagoreanInner(
  left: RestrictedExpression,
  right: RestrictedExpression,
): RestrictedExpression | null {
  const squaredInner = (candidate: RestrictedExpression, kind: "sin" | "cos") => (
    candidate.kind === "power"
      && candidate.exponent === 2
      && candidate.base.kind === kind
      ? candidate.base.value
      : null
  );
  const leftSin = squaredInner(left, "sin");
  const rightCos = squaredInner(right, "cos");
  if (leftSin && rightCos && graphExpressionsEqual(leftSin, rightCos)) return leftSin;
  const leftCos = squaredInner(left, "cos");
  const rightSin = squaredInner(right, "sin");
  return leftCos && rightSin && graphExpressionsEqual(leftCos, rightSin) ? leftCos : null;
}

type AdditiveTerm = Readonly<{ sign: 1 | -1; expression: RestrictedExpression }>;

function additiveTerms(
  expression: RestrictedExpression,
  sign: 1 | -1 = 1,
  terms: AdditiveTerm[] = [],
): AdditiveTerm[] {
  if (expression.kind === "add") {
    additiveTerms(expression.left, sign, terms);
    additiveTerms(expression.right, sign, terms);
  } else if (expression.kind === "subtract") {
    additiveTerms(expression.left, sign, terms);
    additiveTerms(expression.right, sign === 1 ? -1 : 1, terms);
  } else if (expression.kind === "negate") {
    additiveTerms(expression.value, sign === 1 ? -1 : 1, terms);
  } else {
    terms.push({ sign, expression });
  }
  return terms;
}

/**
 * Cancel only byte-for-byte identical additive terms. There is deliberately no
 * distributive expansion or approximate coefficient collection: both would
 * enlarge the proof surface and could erase operational intermediate failures.
 */
function cancelIdenticalAdditiveTerms(expression: RestrictedExpression): RestrictedExpression {
  const terms = additiveTerms(expression);
  const removed = new Set<number>();
  for (let left = 0; left < terms.length; left += 1) {
    if (removed.has(left)) continue;
    for (let right = left + 1; right < terms.length; right += 1) {
      if (removed.has(right)
        || terms[left].sign === terms[right].sign
        || !graphExpressionsEqual(terms[left].expression, terms[right].expression)) continue;
      removed.add(left);
      removed.add(right);
      break;
    }
  }
  if (!removed.size) return expression;
  const remaining = terms.filter((_, index) => !removed.has(index));
  if (!remaining.length) return { kind: "constant", value: 0 };
  let rebuilt = remaining[0].sign === 1
    ? remaining[0].expression
    : { kind: "negate", value: remaining[0].expression } as RestrictedExpression;
  for (const term of remaining.slice(1)) {
    rebuilt = term.sign === 1
      ? { kind: "add", left: rebuilt, right: term.expression }
      : { kind: "subtract", left: rebuilt, right: term.expression };
  }
  return rebuilt;
}

/**
 * Mathematical normalization is explicitly secondary to the original AST's
 * operational proof. Callers must scalar-check the original at sample points
 * and edge-check it over intervals before using this derived expression.
 */
function normalizeGraphExpression(
  expression: RestrictedExpression,
  cancellationDomain: Interval,
): RestrictedExpression {
  const originalFacts = operationalFacts(expression, cancellationDomain);
  switch (expression.kind) {
    case "constant": return { kind: "constant", value: Object.is(expression.value, -0) ? 0 : expression.value };
    case "variable": return { kind: "variable" };
    case "add": {
      const left = normalizeGraphExpression(expression.left, cancellationDomain);
      const right = normalizeGraphExpression(expression.right, cancellationDomain);
      const sharedInner = pythagoreanInner(left, right);
      if (sharedInner && originalFacts.safe) return { kind: "constant", value: 1 };
      const candidate: RestrictedExpression = { kind: "add", left, right };
      return originalFacts.safe ? cancelIdenticalAdditiveTerms(candidate) : candidate;
    }
    case "multiply": return {
      kind: "multiply",
      left: normalizeGraphExpression(expression.left, cancellationDomain),
      right: normalizeGraphExpression(expression.right, cancellationDomain),
    };
    case "divide": {
      const left = normalizeGraphExpression(expression.left, cancellationDomain);
      const right = normalizeGraphExpression(expression.right, cancellationDomain);
      return graphExpressionsEqual(left, right)
        && originalFacts.safe
        ? { kind: "constant", value: 1 }
        : { kind: "divide", left, right };
    }
    case "subtract": {
      const left = normalizeGraphExpression(expression.left, cancellationDomain);
      const right = normalizeGraphExpression(expression.right, cancellationDomain);
      const candidate: RestrictedExpression = { kind: "subtract", left, right };
      return originalFacts.safe ? cancelIdenticalAdditiveTerms(candidate) : candidate;
    }
    case "power": return { kind: "power", base: normalizeGraphExpression(expression.base, cancellationDomain), exponent: Object.is(expression.exponent, -0) ? 0 : expression.exponent };
    case "sin":
    case "cos":
    case "abs":
    case "negate": return { kind: expression.kind, value: normalizeGraphExpression(expression.value, cancellationDomain) };
  }
}

function children(expression: RestrictedExpression): readonly RestrictedExpression[] {
  if (["add", "subtract", "multiply", "divide"].includes(expression.kind)) {
    const binary = expression as Extract<RestrictedExpression, { left: RestrictedExpression }>;
    return [binary.left, binary.right];
  }
  if (expression.kind === "power") return [expression.base];
  if (["sin", "cos", "abs", "negate"].includes(expression.kind)) {
    return [(expression as Extract<RestrictedExpression, { value: RestrictedExpression }>).value];
  }
  return [];
}

function validateStructure(expression: RestrictedExpression): Readonly<{ nodeCount: number; maxDepth: number; diagnostic?: GraphExpressionDiagnostic }> {
  let nodeCount = 0;
  let maxDepth = 0;
  let failure: GraphExpressionDiagnostic | undefined;
  const visit = (node: RestrictedExpression, depth: number) => {
    if (failure) return;
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    if (nodeCount > GRAPH_EXPRESSION_LIMITS.nodes) {
      failure = diagnostic("GRAPH_NODE_LIMIT_EXCEEDED", `Graph expression may contain at most ${GRAPH_EXPRESSION_LIMITS.nodes} AST nodes.`);
      return;
    }
    if (depth > GRAPH_EXPRESSION_LIMITS.depth) {
      failure = diagnostic("GRAPH_DEPTH_LIMIT_EXCEEDED", `Graph expression depth may not exceed ${GRAPH_EXPRESSION_LIMITS.depth}.`);
      return;
    }
    children(node).forEach((child) => visit(child, depth + 1));
  };
  visit(expression, 0);
  return failure ? { nodeCount, maxDepth, diagnostic: failure } : { nodeCount, maxDepth };
}

function preflightCandidate(candidate: unknown): Readonly<{ nodeCount: number; maxDepth: number; diagnostic?: GraphExpressionDiagnostic }> {
  const stack: Array<Readonly<{ value: unknown; depth: number }>> = [{ value: candidate, depth: 0 }];
  let nodeCount = 0;
  let maxDepth = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    if (nodeCount > GRAPH_EXPRESSION_LIMITS.nodes) return {
      nodeCount,
      maxDepth,
      diagnostic: diagnostic("GRAPH_NODE_LIMIT_EXCEEDED", `Graph expression may contain at most ${GRAPH_EXPRESSION_LIMITS.nodes} AST nodes.`),
    };
    if (depth > GRAPH_EXPRESSION_LIMITS.depth) return {
      nodeCount,
      maxDepth,
      diagnostic: diagnostic("GRAPH_DEPTH_LIMIT_EXCEEDED", `Graph expression depth may not exceed ${GRAPH_EXPRESSION_LIMITS.depth}.`),
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) return {
      nodeCount,
      maxDepth,
      diagnostic: diagnostic("GRAPH_AST_INVALID", "Graph requires a valid restricted expression AST."),
    };
    const record = value as Record<string, unknown>;
    if (typeof record.kind !== "string") return {
      nodeCount,
      maxDepth,
      diagnostic: diagnostic("GRAPH_AST_INVALID", "Graph requires a valid restricted expression AST."),
    };
    if (["add", "subtract", "multiply", "divide"].includes(record.kind)) {
      stack.push({ value: record.right, depth: depth + 1 }, { value: record.left, depth: depth + 1 });
    } else if (record.kind === "power") {
      stack.push({ value: record.base, depth: depth + 1 });
    } else if (["sin", "cos", "abs", "negate"].includes(record.kind)) {
      stack.push({ value: record.value, depth: depth + 1 });
    } else if (record.kind !== "constant" && record.kind !== "variable") return {
      nodeCount,
      maxDepth,
      diagnostic: diagnostic("GRAPH_AST_INVALID", "Graph requires a valid restricted expression AST."),
    };
  }
  return { nodeCount, maxDepth };
}

type ScalarResult = Readonly<{ ok: true; value: number }> | Readonly<{ ok: false; reason: "division" | "power" | "nonfinite" | "magnitude" }>;

function scalar(expression: RestrictedExpression, x: number): ScalarResult {
  const finish = (value: number): ScalarResult => {
    if (!Number.isFinite(value)) return { ok: false, reason: "nonfinite" };
    if (Math.abs(value) > GRAPH_EXPRESSION_LIMITS.magnitude) return { ok: false, reason: "magnitude" };
    return { ok: true, value: Object.is(value, -0) ? 0 : value };
  };
  switch (expression.kind) {
    case "constant": return finish(expression.value);
    case "variable": return finish(x);
    case "negate": {
      const value = scalar(expression.value, x);
      return value.ok ? finish(-value.value) : value;
    }
    case "sin": {
      const value = scalar(expression.value, x);
      return value.ok ? finish(Math.sin(value.value)) : value;
    }
    case "cos": {
      const value = scalar(expression.value, x);
      return value.ok ? finish(Math.cos(value.value)) : value;
    }
    case "abs": {
      const value = scalar(expression.value, x);
      return value.ok ? finish(Math.abs(value.value)) : value;
    }
    case "power": {
      const base = scalar(expression.base, x);
      if (!base.ok) return base;
      if (base.value === 0 && expression.exponent <= 0) return { ok: false, reason: "power" };
      return finish(base.value ** expression.exponent);
    }
    case "add":
    case "subtract":
    case "multiply":
    case "divide": {
      const left = scalar(expression.left, x);
      if (!left.ok) return left;
      const right = scalar(expression.right, x);
      if (!right.ok) return right;
      if (expression.kind === "divide" && right.value === 0) return { ok: false, reason: "division" };
      if (expression.kind === "add") return finish(left.value + right.value);
      if (expression.kind === "subtract") return finish(left.value - right.value);
      if (expression.kind === "multiply") return finish(left.value * right.value);
      return finish(left.value / right.value);
    }
  }
}

/** Exact bounded scalar evaluation; it never executes source text. */
export function evaluateRestrictedExpression(expression: RestrictedExpression, x: number): ScalarResult {
  if (preflightCandidate(expression).diagnostic) return { ok: false, reason: "nonfinite" };
  const parsed = RestrictedExpressionSchema.safeParse(expression);
  if (!parsed.success || !Number.isFinite(x) || Math.abs(x) > 10_000) return { ok: false, reason: "nonfinite" };
  const structure = validateStructure(parsed.data);
  if (structure.diagnostic) return { ok: false, reason: "nonfinite" };
  const original = scalar(parsed.data, x);
  if (!original.ok) return original;
  return scalar(normalizeGraphExpression(parsed.data, { min: x, max: x }), x);
}

function constantValue(expression: RestrictedExpression): ScalarResult | null {
  if (expression.kind === "variable") return null;
  if (children(expression).some((child) => constantValue(child) === null)) return null;
  return scalar(expression, 0);
}

function constantDiagnostic(expression: RestrictedExpression): GraphExpressionDiagnostic | undefined {
  for (const child of children(expression)) {
    const nested = constantDiagnostic(child);
    if (nested) return nested;
  }
  const value = constantValue(expression);
  if (value?.ok !== false) return undefined;
  if (value.reason === "division") return diagnostic("GRAPH_CONSTANT_DIVISION_BY_ZERO", "Graph expression contains a constant division by zero.");
  if (value.reason === "power") return diagnostic("GRAPH_CONSTANT_POWER_UNDEFINED", "Graph expression contains an undefined constant power such as 0^0 or zero to a negative exponent.");
  if (value.reason === "magnitude") return diagnostic("GRAPH_CONSTANT_MAGNITUDE_EXCEEDED", `A constant graph result exceeds magnitude ${GRAPH_EXPRESSION_LIMITS.magnitude}.`);
  return diagnostic("GRAPH_CONSTANT_NONFINITE", "Graph expression contains a non-finite constant result.");
}

type Interval = Readonly<{ min: number; max: number }>;
type IntervalJet = Readonly<{ value: Interval; derivative: Interval }>;
type OperationalSign = "positive" | "negative" | "zero" | "nonnegative" | "nonpositive" | "unknown";
type OperationalFacts = Readonly<{ safe: boolean; range: Interval; sign: OperationalSign }>;

const UNBOUNDED_INTERVAL: Interval = Object.freeze({ min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY });
const FLOAT_BUFFER = new ArrayBuffer(8);
const FLOAT_VIEW = new DataView(FLOAT_BUFFER);
const TRIG_CRITICAL_POINT_CAP = 4;

function adjacentFloat(value: number, direction: "up" | "down"): number {
  if (Number.isNaN(value)) return value;
  if (value === Number.POSITIVE_INFINITY) return direction === "up" ? value : Number.MAX_VALUE;
  if (value === Number.NEGATIVE_INFINITY) return direction === "down" ? value : -Number.MAX_VALUE;
  if (value === 0) return direction === "up" ? Number.MIN_VALUE : -Number.MIN_VALUE;
  FLOAT_VIEW.setFloat64(0, value, false);
  let bits = FLOAT_VIEW.getBigUint64(0, false);
  const incrementBits = (value > 0) === (direction === "up");
  bits = incrementBits ? bits + BigInt(1) : bits - BigInt(1);
  FLOAT_VIEW.setBigUint64(0, bits, false);
  return FLOAT_VIEW.getFloat64(0, false);
}

function roundDown(value: number): number {
  return Number.isFinite(value) ? adjacentFloat(value, "down") : value;
}

function roundUp(value: number): number {
  return Number.isFinite(value) ? adjacentFloat(value, "up") : value;
}

function interval(min: number, max: number): Interval {
  return min <= max ? { min, max } : { min: max, max: min };
}

function outwardInterval(min: number, max: number, sign?: "nonnegative" | "nonpositive"): Interval {
  if (Number.isNaN(min) || Number.isNaN(max)) return UNBOUNDED_INTERVAL;
  const ordered = interval(min, max);
  return {
    min: sign === "nonnegative" ? Math.max(0, roundDown(ordered.min)) : roundDown(ordered.min),
    max: sign === "nonpositive" ? Math.min(0, roundUp(ordered.max)) : roundUp(ordered.max),
  };
}

function addIntervals(left: Interval, right: Interval): Interval {
  return outwardInterval(left.min + right.min, left.max + right.max);
}

function subtractIntervals(left: Interval, right: Interval): Interval {
  return outwardInterval(left.min - right.max, left.max - right.min);
}

function multiplyIntervals(left: Interval, right: Interval): Interval {
  const values = [left.min * right.min, left.min * right.max, left.max * right.min, left.max * right.max];
  return values.some(Number.isNaN)
    ? UNBOUNDED_INTERVAL
    : outwardInterval(Math.min(...values), Math.max(...values));
}

function divideIntervals(left: Interval, right: Interval): Interval {
  if (!intervalExcludesZero(right)) return UNBOUNDED_INTERVAL;
  const values = [left.min / right.min, left.min / right.max, left.max / right.min, left.max / right.max];
  return values.some(Number.isNaN)
    ? UNBOUNDED_INTERVAL
    : outwardInterval(Math.min(...values), Math.max(...values));
}

function scaleInterval(value: Interval, scale: number): Interval {
  if (scale === 0) return { min: 0, max: 0 };
  return multiplyIntervals(value, { min: scale, max: scale });
}

/**
 * Binary64 VM extrema are separate from the outward real-calculus envelope.
 * IEEE arithmetic is monotone over each zero-free interval branch, so direct
 * corner evaluation bounds the actual values produced by the restricted VM
 * without treating a proof-padding ULP as an authored magnitude violation.
 */
function vmAddIntervals(left: Interval, right: Interval): Interval {
  return interval(left.min + right.min, left.max + right.max);
}

function vmSubtractIntervals(left: Interval, right: Interval): Interval {
  return interval(left.min - right.max, left.max - right.min);
}

function vmMultiplyIntervals(left: Interval, right: Interval): Interval {
  const values = [left.min * right.min, left.min * right.max, left.max * right.min, left.max * right.max];
  return values.some(Number.isNaN)
    ? UNBOUNDED_INTERVAL
    : interval(Math.min(...values), Math.max(...values));
}

function vmDivideIntervals(left: Interval, right: Interval): Interval {
  if (!intervalExcludesZero(right)) return UNBOUNDED_INTERVAL;
  const values = [left.min / right.min, left.min / right.max, left.max / right.min, left.max / right.max];
  return values.some(Number.isNaN)
    ? UNBOUNDED_INTERVAL
    : interval(Math.min(...values), Math.max(...values));
}

function vmPowerInterval(base: Interval, exponent: number): Interval {
  if (exponent === 0) return { min: 1, max: 1 };
  if (exponent % 2 !== 0) return interval(base.min ** exponent, base.max ** exponent);
  const maximum = Math.max(Math.abs(base.min), Math.abs(base.max)) ** exponent;
  const minimum = base.min <= 0 && base.max >= 0
    ? 0
    : Math.min(Math.abs(base.min), Math.abs(base.max)) ** exponent;
  return interval(minimum, maximum);
}

function vmIntegerPowerInterval(base: Interval, exponent: number): Interval {
  if (exponent >= 0) return vmPowerInterval(base, exponent);
  if (!intervalExcludesZero(base)) return UNBOUNDED_INTERVAL;
  return vmDivideIntervals({ min: 1, max: 1 }, vmPowerInterval(base, -exponent));
}

/** Bounded trigonometric range reduction; unsafe phases fail to the full range. */
export function boundedTrigInterval(input: Readonly<{ min: number; max: number }>, cosine = false): Interval {
  if (!Number.isFinite(input.min) || !Number.isFinite(input.max) || input.min > input.max) return { min: -1, max: 1 };
  const left = input.min;
  const right = input.max;
  const span = roundUp(right - left);
  if (!Number.isFinite(span)
    || Math.abs(left) > Number.MAX_SAFE_INTEGER
    || Math.abs(right) > Number.MAX_SAFE_INTEGER
    || span >= Math.PI * 2) return { min: -1, max: 1 };
  // Evaluate cosine directly. Rewriting it as sin(x + pi/2) loses phase bits;
  // expanding only the final result by one ULP cannot recover that loss and
  // can falsely certify a sign. Critical-index arithmetic is rounded outward
  // at each operation so an extremum may be included conservatively but never
  // skipped by phase reduction.
  const endpoint = cosine ? Math.cos : Math.sin;
  let min = Math.min(endpoint(left), endpoint(right));
  let max = Math.max(endpoint(left), endpoint(right));
  const criticalOffset = cosine ? 0 : Math.PI / 2;
  const firstCritical = Math.ceil(roundDown(roundDown(left - criticalOffset) / Math.PI));
  const lastCritical = Math.floor(roundUp(roundUp(right - criticalOffset) / Math.PI));
  if (!Number.isSafeInteger(firstCritical)
    || !Number.isSafeInteger(lastCritical)
    || lastCritical - firstCritical + 1 > TRIG_CRITICAL_POINT_CAP) return { min: -1, max: 1 };
  let iterations = 0;
  for (let index = firstCritical; index <= lastCritical && iterations < TRIG_CRITICAL_POINT_CAP; index += 1) {
    const value = Math.abs(index % 2) === 0 ? 1 : -1;
    min = Math.min(min, value);
    max = Math.max(max, value);
    iterations += 1;
  }
  return {
    min: Math.max(-1, roundDown(min)),
    max: Math.min(1, roundUp(max)),
  };
}

function powerInterval(base: Interval, exponent: number): Interval {
  if (exponent === 0) return { min: 1, max: 1 };
  if (exponent % 2 !== 0) return outwardInterval(base.min ** exponent, base.max ** exponent);
  const maximum = Math.max(Math.abs(base.min), Math.abs(base.max)) ** exponent;
  const minimum = base.min <= 0 && base.max >= 0
    ? 0
    : Math.min(Math.abs(base.min), Math.abs(base.max)) ** exponent;
  return outwardInterval(minimum, maximum, "nonnegative");
}

function integerPowerInterval(base: Interval, exponent: number): Interval {
  if (exponent >= 0) return powerInterval(base, exponent);
  if (!intervalExcludesZero(base)) return UNBOUNDED_INTERVAL;
  return divideIntervals({ min: 1, max: 1 }, powerInterval(base, -exponent));
}

function signFromRange(range: Interval): OperationalSign {
  if (range.min === 0 && range.max === 0) return "zero";
  if (range.min > 0) return "positive";
  if (range.max < 0) return "negative";
  if (range.min >= 0) return "nonnegative";
  if (range.max <= 0) return "nonpositive";
  return "unknown";
}

function signIsStrict(sign: OperationalSign): boolean {
  return sign === "positive" || sign === "negative";
}

function signIsNonnegative(sign: OperationalSign): boolean {
  return sign === "positive" || sign === "nonnegative" || sign === "zero";
}

function signIsNonpositive(sign: OperationalSign): boolean {
  return sign === "negative" || sign === "nonpositive" || sign === "zero";
}

function rangeIsOperationallyBounded(range: Interval): boolean {
  return Number.isFinite(range.min)
    && Number.isFinite(range.max)
    && range.min >= -GRAPH_EXPRESSION_LIMITS.magnitude
    && range.max <= GRAPH_EXPRESSION_LIMITS.magnitude;
}

function conservativeSpacingBound(range: Interval, increment: number): number {
  const magnitude = Math.max(
    Math.abs(range.min),
    Math.abs(range.max),
    Math.abs(range.min + increment),
    Math.abs(range.max + increment),
  );
  if (!Number.isFinite(magnitude)) return Number.POSITIVE_INFINITY;
  if (magnitude === 0) return Number.MIN_VALUE;
  const exponent = Math.ceil(Math.log2(magnitude));
  return Math.max(Number.MIN_VALUE, 2 ** (exponent - 52));
}

type BinaryGraphExpression = Readonly<{
  kind: "add" | "subtract" | "multiply" | "divide";
  left: RestrictedExpression;
  right: RestrictedExpression;
}>;

type IncrementDifferenceProof = Readonly<{ sign: "positive" | "negative"; range: Interval }>;

function incrementDifferenceProof(expression: BinaryGraphExpression & { kind: "subtract" }, domain: Interval): IncrementDifferenceProof | null {
  let shared: RestrictedExpression | null = null;
  let increment: number | null = null;
  if (expression.left.kind === "add") {
    const addition = expression.left as BinaryGraphExpression & { kind: "add" };
    if (graphExpressionsEqual(addition.left, expression.right) && addition.right.kind === "constant") {
      shared = expression.right;
      increment = addition.right.value;
    } else if (graphExpressionsEqual(addition.right, expression.right) && addition.left.kind === "constant") {
      shared = expression.right;
      increment = addition.left.value;
    }
  } else if (expression.right.kind === "subtract") {
    const subtraction = expression.right as BinaryGraphExpression & { kind: "subtract" };
    if (graphExpressionsEqual(expression.left, subtraction.left) && subtraction.right.kind === "constant") {
      shared = expression.left;
      increment = subtraction.right.value;
    }
  }
  if (!shared || increment === null || increment === 0 || !Number.isFinite(increment)) return null;
  const sharedFacts = operationalFacts(shared, domain);
  if (!sharedFacts.safe) return null;
  // `fl(e + c) - e` need not equal c. Four maximum spacings conservatively
  // cover addition and subtraction rounding; the envelope is used only as an
  // operational safety/nonzero proof. Mathematical cancellation remains the
  // explicitly separate normalized semantics.
  const error = Math.max(
    Number.MIN_VALUE,
    conservativeSpacingBound(sharedFacts.range, increment),
    conservativeSpacingBound({ min: increment, max: increment }, 0),
  ) * 4;
  if (!Number.isFinite(error) || Math.abs(increment) <= error) return null;
  const range = outwardInterval(increment - error, increment + error);
  return { sign: increment > 0 ? "positive" : "negative", range };
}

function operationalFacts(expression: RestrictedExpression, domain: Interval): OperationalFacts {
  const unsafe = (range: Interval = UNBOUNDED_INTERVAL): OperationalFacts => ({ safe: false, range, sign: "unknown" });
  if (expression.kind === "constant") {
    const value = Object.is(expression.value, -0) ? 0 : expression.value;
    const range = { min: value, max: value };
    return { safe: rangeIsOperationallyBounded(range), range, sign: signFromRange(range) };
  }
  if (expression.kind === "variable") {
    return { safe: rangeIsOperationallyBounded(domain), range: domain, sign: signFromRange(domain) };
  }
  if (expression.kind === "negate") {
    const value = operationalFacts(expression.value, domain);
    if (!value.safe) return unsafe(value.range);
    const range = { min: -value.range.max, max: -value.range.min };
    const sign: OperationalSign = value.sign === "positive" ? "negative"
      : value.sign === "negative" ? "positive"
        : value.sign === "nonnegative" ? "nonpositive"
          : value.sign === "nonpositive" ? "nonnegative"
            : value.sign;
    return { safe: rangeIsOperationallyBounded(range), range, sign };
  }
  if (expression.kind === "sin" || expression.kind === "cos") {
    const value = operationalFacts(expression.value, domain);
    if (!value.safe) return unsafe();
    const range = boundedTrigInterval(value.range, expression.kind === "cos");
    return { safe: true, range, sign: signFromRange(range) };
  }
  if (expression.kind === "abs") {
    const value = operationalFacts(expression.value, domain);
    if (!value.safe) return unsafe();
    const maximum = Math.max(Math.abs(value.range.min), Math.abs(value.range.max));
    const minimum = value.range.min <= 0 && value.range.max >= 0
      ? 0
      : Math.min(Math.abs(value.range.min), Math.abs(value.range.max));
    const range = { min: minimum, max: maximum };
    const sign = signIsStrict(value.sign) ? "positive" : signFromRange(range);
    return { safe: rangeIsOperationallyBounded(range), range, sign };
  }
  if (expression.kind === "power") {
    const base = operationalFacts(expression.base, domain);
    if (!base.safe || (expression.exponent <= 0 && !signIsStrict(base.sign))) return unsafe();
    const range = vmIntegerPowerInterval(base.range, expression.exponent);
    let sign = signFromRange(range);
    if (expression.exponent > 0 && expression.exponent % 2 === 0 && !signIsStrict(sign)) sign = "nonnegative";
    return { safe: rangeIsOperationallyBounded(range), range, sign };
  }

  const binary = expression as BinaryGraphExpression;
  const left = operationalFacts(binary.left, domain);
  const right = operationalFacts(binary.right, domain);
  if (!left.safe || !right.safe) return unsafe();
  if (expression.kind === "add") {
    const range = vmAddIntervals(left.range, right.range);
    let sign = signFromRange(range);
    if (signIsNonnegative(left.sign) && signIsNonnegative(right.sign)) {
      sign = left.sign === "positive" || right.sign === "positive" ? "positive" : "nonnegative";
    } else if (signIsNonpositive(left.sign) && signIsNonpositive(right.sign)) {
      sign = left.sign === "negative" || right.sign === "negative" ? "negative" : "nonpositive";
    }
    return { safe: rangeIsOperationallyBounded(range), range, sign };
  }
  if (expression.kind === "subtract") {
    if (graphExpressionsEqual(binary.left, binary.right)) {
      return { safe: true, range: { min: 0, max: 0 }, sign: "zero" };
    }
    const increment = incrementDifferenceProof(binary as BinaryGraphExpression & { kind: "subtract" }, domain);
    const range = increment?.range ?? vmSubtractIntervals(left.range, right.range);
    const sign = increment?.sign ?? signFromRange(range);
    return { safe: rangeIsOperationallyBounded(range), range, sign };
  }
  if (expression.kind === "multiply") {
    const range = graphExpressionsEqual(binary.left, binary.right)
      ? vmPowerInterval(left.range, 2)
      : vmMultiplyIntervals(left.range, right.range);
    let sign = signFromRange(range);
    if (left.sign === "zero" || right.sign === "zero") sign = "zero";
    else if ((signIsNonnegative(left.sign) && signIsNonnegative(right.sign))
      || (signIsNonpositive(left.sign) && signIsNonpositive(right.sign))) {
      sign = intervalExcludesZero(range) ? "positive" : "nonnegative";
    } else if ((signIsNonnegative(left.sign) && signIsNonpositive(right.sign))
      || (signIsNonpositive(left.sign) && signIsNonnegative(right.sign))) {
      sign = intervalExcludesZero(range) ? "negative" : "nonpositive";
    }
    return { safe: rangeIsOperationallyBounded(range), range, sign };
  }
  if (!signIsStrict(right.sign)) return unsafe();
  const range = vmDivideIntervals(left.range, right.range);
  return { safe: rangeIsOperationallyBounded(range), range, sign: signFromRange(range) };
}

function intervalJet(expression: RestrictedExpression, domain: Interval): IntervalJet {
  switch (expression.kind) {
    case "constant": return { value: { min: expression.value, max: expression.value }, derivative: { min: 0, max: 0 } };
    case "variable": return { value: domain, derivative: { min: 1, max: 1 } };
    case "add": {
      const left = intervalJet(expression.left, domain);
      const right = intervalJet(expression.right, domain);
      return { value: addIntervals(left.value, right.value), derivative: addIntervals(left.derivative, right.derivative) };
    }
    case "subtract": {
      const left = intervalJet(expression.left, domain);
      const right = intervalJet(expression.right, domain);
      return { value: subtractIntervals(left.value, right.value), derivative: subtractIntervals(left.derivative, right.derivative) };
    }
    case "multiply": {
      const left = intervalJet(expression.left, domain);
      if (graphExpressionsEqual(expression.left, expression.right)) {
        return {
          value: powerInterval(left.value, 2),
          derivative: scaleInterval(multiplyIntervals(left.value, left.derivative), 2),
        };
      }
      const right = intervalJet(expression.right, domain);
      return {
        value: multiplyIntervals(left.value, right.value),
        derivative: addIntervals(
          multiplyIntervals(left.derivative, right.value),
          multiplyIntervals(left.value, right.derivative),
        ),
      };
    }
    case "divide": {
      const left = intervalJet(expression.left, domain);
      const right = intervalJet(expression.right, domain);
      if (!intervalExcludesZero(right.value)) return { value: UNBOUNDED_INTERVAL, derivative: UNBOUNDED_INTERVAL };
      const reciprocal = divideIntervals({ min: 1, max: 1 }, right.value);
      const denominatorSquared = powerInterval(right.value, 2);
      const reciprocalDerivative = scaleInterval(
        multiplyIntervals(right.derivative, divideIntervals({ min: 1, max: 1 }, denominatorSquared)),
        -1,
      );
      return {
        value: multiplyIntervals(left.value, reciprocal),
        derivative: addIntervals(
          multiplyIntervals(left.derivative, reciprocal),
          multiplyIntervals(left.value, reciprocalDerivative),
        ),
      };
    }
    case "negate": {
      const value = intervalJet(expression.value, domain);
      return { value: scaleInterval(value.value, -1), derivative: scaleInterval(value.derivative, -1) };
    }
    case "abs": {
      const input = intervalJet(expression.value, domain);
      const value = input.value.min <= 0 && input.value.max >= 0
        ? outwardInterval(0, Math.max(Math.abs(input.value.min), Math.abs(input.value.max)), "nonnegative")
        : outwardInterval(
          Math.min(Math.abs(input.value.min), Math.abs(input.value.max)),
          Math.max(Math.abs(input.value.min), Math.abs(input.value.max)),
          "nonnegative",
        );
      if (input.value.min >= 0) return { value, derivative: input.derivative };
      if (input.value.max <= 0) return { value, derivative: scaleInterval(input.derivative, -1) };
      const derivativeMagnitude = Math.max(Math.abs(input.derivative.min), Math.abs(input.derivative.max));
      return { value, derivative: outwardInterval(-derivativeMagnitude, derivativeMagnitude) };
    }
    case "sin": {
      const input = intervalJet(expression.value, domain);
      return { value: boundedTrigInterval(input.value), derivative: multiplyIntervals(boundedTrigInterval(input.value, true), input.derivative) };
    }
    case "cos": {
      const input = intervalJet(expression.value, domain);
      return { value: boundedTrigInterval(input.value, true), derivative: scaleInterval(multiplyIntervals(boundedTrigInterval(input.value), input.derivative), -1) };
    }
    case "power": {
      const base = intervalJet(expression.base, domain);
      if (expression.exponent === 0) return { value: { min: 1, max: 1 }, derivative: { min: 0, max: 0 } };
      return {
        value: integerPowerInterval(base.value, expression.exponent),
        derivative: multiplyIntervals(
          scaleInterval(integerPowerInterval(base.value, expression.exponent - 1), expression.exponent),
          base.derivative,
        ),
      };
    }
  }
}

function hashText(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ (code & 0xff), 0x01000193);
    left = Math.imul(left ^ (code >>> 8), 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
    right ^= right >>> 13;
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

function analysisHash(
  sourceCanonical: string,
  canonical: string,
  xMin: number,
  xMax: number,
  segments: readonly (readonly GraphPoint[])[],
  diagnostics: readonly GraphExpressionDiagnostic[],
): string {
  const geometry = segments.map((segment) => segment.map(({ x, y }) => [geometryHashNumber(x), geometryHashNumber(y)]));
  return `${GRAPH_GEOMETRY_HASH_VERSION}-${hashText(JSON.stringify({
    sourceCanonical,
    canonical,
    xMin: losslessSourceNumber(xMin),
    xMax: losslessSourceNumber(xMax),
    geometry,
    diagnostics: diagnostics.map(({ code }) => code),
  }))}`;
}

function failedAnalysis(
  sourceCanonical: string,
  canonical: string,
  xMin: number,
  xMax: number,
  failure: GraphExpressionDiagnostic,
  nodeCount = 0,
  maxDepth = 0,
  evaluations = 0,
): GraphExpressionAnalysis {
  return {
    ok: false,
    canonical,
    analysisHash: analysisHash(sourceCanonical, canonical, xMin, xMax, [], [failure]),
    diagnostics: [failure],
    segments: [],
    normalizedSegments: [],
    evaluations,
    nodeCount,
    maxDepth,
    yRange: null,
  };
}

/**
 * Derive shared line segments. Range-discovery samples never authorize a
 * connection: every emitted edge is admitted only when interval analysis
 * proves it singularity-free and bounds its chord error. Any otherwise
 * drawable edge that cannot be certified within the deterministic budgets
 * makes the whole result fatal.
 */
export function analyzeGraphExpression(
  candidate: unknown,
  xMin: number,
  xMax: number,
): GraphExpressionAnalysis {
  const preflight = preflightCandidate(candidate);
  if (preflight.diagnostic) return failedAnalysis("invalid", "invalid", xMin, xMax, preflight.diagnostic, preflight.nodeCount, preflight.maxDepth);
  const parsed = RestrictedExpressionSchema.safeParse(candidate);
  if (!parsed.success) return failedAnalysis("invalid", "invalid", xMin, xMax, diagnostic("GRAPH_AST_INVALID", "Graph requires a valid restricted expression AST."));
  const sourceExpression = parsed.data;
  const sourceCanonical = formatGraphExpression(sourceExpression);
  const sourceStructure = validateStructure(sourceExpression);
  if (sourceStructure.diagnostic) return failedAnalysis(sourceCanonical, sourceCanonical, xMin, xMax, sourceStructure.diagnostic, sourceStructure.nodeCount, sourceStructure.maxDepth);
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMin >= xMax || Math.abs(xMin) > 10_000 || Math.abs(xMax) > 10_000) {
    return failedAnalysis(sourceCanonical, sourceCanonical, xMin, xMax, diagnostic("GRAPH_DOMAIN_INVALID", "Graph xMax must be greater than xMin and both must be finite within ±10000."), sourceStructure.nodeCount, sourceStructure.maxDepth);
  }
  const graphDomain = interval(xMin, xMax);
  const expression = normalizeGraphExpression(sourceExpression, graphDomain);
  const canonical = formatGraphExpression(expression);
  const staticFailure = constantDiagnostic(sourceExpression) ?? constantDiagnostic(expression);
  if (staticFailure) return failedAnalysis(sourceCanonical, canonical, xMin, xMax, staticFailure, sourceStructure.nodeCount, sourceStructure.maxDepth);

  type SampleLeaf =
    | Readonly<{ kind: "edge"; left: GraphPoint; right: GraphPoint }>
    | Readonly<{ kind: "gap"; unsafe: boolean }>;

  const keyForX = (x: number) => Object.is(x, -0) ? 0 : x;
  const evaluated = new Map<number, ScalarResult>();
  let samplingBudgetExceeded = false;
  const evaluateAt = (x: number): ScalarResult | null => {
    const key = keyForX(x);
    const cached = evaluated.get(key);
    if (cached) return cached;
    if (evaluated.size >= GRAPH_EXPRESSION_LIMITS.evaluations) {
      samplingBudgetExceeded = true;
      return null;
    }
    // Original operational semantics owns every failure. Mathematical
    // normalization supplies a value only after the original point succeeds.
    const original = scalar(sourceExpression, key);
    const result = original.ok
      ? scalar(normalizeGraphExpression(sourceExpression, { min: key, max: key }), key)
      : original;
    evaluated.set(key, result);
    return result;
  };

  const deterministicX = (index: number, pointCount: number) => keyForX(index === pointCount - 1
    ? xMax
    : xMin + (xMax - xMin) * index / (pointCount - 1));

  // These samples discover a deterministic candidate finite y range only.
  // They never create geometry: every emitted edge still passes the separate
  // interval/derivative certification below.
  const rangeSamples: Array<Readonly<{ x: number; result: ScalarResult }>> = [];
  for (let index = 0; index < GRAPH_EXPRESSION_LIMITS.rangeSamplePoints; index += 1) {
    const x = deterministicX(index, GRAPH_EXPRESSION_LIMITS.rangeSamplePoints);
    const result = evaluateAt(x);
    if (!result) break;
    if (rangeSamples.at(-1)?.x !== x) rangeSamples.push({ x, result });
  }
  if (samplingBudgetExceeded || rangeSamples.length < 2) {
      return failedAnalysis(sourceCanonical, canonical, xMin, xMax, diagnostic("GRAPH_SAMPLING_BUDGET_EXCEEDED", "Graph geometry could not be certified within its deterministic sampling budget."), sourceStructure.nodeCount, sourceStructure.maxDepth, evaluated.size);
  }

  const initialSamples: Array<Readonly<{ x: number; result: ScalarResult }>> = [];
  for (let index = 0; index < GRAPH_EXPRESSION_LIMITS.initialSamplePoints; index += 1) {
    const x = deterministicX(index, GRAPH_EXPRESSION_LIMITS.initialSamplePoints);
    const result = evaluateAt(x);
    if (!result) break;
    if (initialSamples.at(-1)?.x !== x) initialSamples.push({ x, result });
  }
  if (samplingBudgetExceeded || initialSamples.length < 2) {
    return failedAnalysis(sourceCanonical, canonical, xMin, xMax, diagnostic("GRAPH_SAMPLING_BUDGET_EXCEEDED", "Graph geometry could not be certified within its deterministic sampling budget."), sourceStructure.nodeCount, sourceStructure.maxDepth, evaluated.size);
  }

  // Seed samples discover a candidate display/error scale only. They never
  // certify an edge, so retaining every successful original-guarded sample is
  // safe and avoids a zero tolerance when coarse intervals merely straddle a
  // narrow magnitude boundary.
  const finiteRangeValues = rangeSamples.flatMap(({ result }) => result.ok ? [result.value] : []);
  const sampledSpan = finiteRangeValues.length
    ? Math.max(...finiteRangeValues) - Math.min(...finiteRangeValues)
    : 0;
  // A dependency-inflated interval span must never loosen the error bound:
  // cancellation could otherwise make a sampled oscillation look flat while
  // the unrelated interval overestimate supplies a very large tolerance.
  const sampledScale = Math.max(0, ...finiteRangeValues.map(Math.abs));
  const chordTolerance = Math.max(
    sampledSpan / 512,
    Number.EPSILON * sampledScale * 64,
  );

  const leaves: SampleLeaf[] = [];
  const refine = (
    leftX: number,
    leftResult: ScalarResult,
    rightX: number,
    rightResult: ScalarResult,
    depth: number,
  ): void => {
    if (samplingBudgetExceeded) return;
    const edgeDomain = interval(leftX, rightX);
    if (!operationalFacts(sourceExpression, edgeDomain).safe) {
      if (depth >= GRAPH_EXPRESSION_LIMITS.unsafeSamplingDepth) {
        leaves.push({ kind: "gap", unsafe: true });
        return;
      }
      const midpoint = keyForX((leftX + rightX) / 2);
      if (!(midpoint > leftX && midpoint < rightX)) {
        leaves.push({ kind: "gap", unsafe: true });
        return;
      }
      const midpointResult = evaluateAt(midpoint);
      if (!midpointResult) return;
      // A coarse uncertain interval never becomes geometry or an immediate
      // gap. Both halves must independently prove safety; any uncertainty
      // remaining at the bounded refinement depth is omitted as one gap.
      refine(leftX, leftResult, midpoint, midpointResult, depth + 1);
      refine(midpoint, midpointResult, rightX, rightResult, depth + 1);
      return;
    }

    // An identity may be total on this edge even when it is partial elsewhere
    // in the graph domain. The original expression above still owns the
    // discontinuity check, so local dependency reduction cannot erase a hole.
    const edgeExpression = normalizeGraphExpression(sourceExpression, edgeDomain);
    const edgeFacts = operationalFacts(edgeExpression, edgeDomain);
    const edge = intervalJet(edgeExpression, edgeDomain);
    const finiteRange = Number.isFinite(edge.value.min) && Number.isFinite(edge.value.max);
    const entirelyOutsideMagnitude = Number.isFinite(edgeFacts.range.min) && Number.isFinite(edgeFacts.range.max)
      && (edgeFacts.range.min > GRAPH_EXPRESSION_LIMITS.magnitude || edgeFacts.range.max < -GRAPH_EXPRESSION_LIMITS.magnitude);
    if (entirelyOutsideMagnitude) {
      leaves.push({ kind: "gap", unsafe: false });
      return;
    }

    const rangeWithinMagnitude = finiteRange && edgeFacts.safe;
    if (leftResult.ok && rightResult.ok && rangeWithinMagnitude) {
      const width = rightX - leftX;
      const chordSlope = (rightResult.value - leftResult.value) / width;
      const derivativeDeviation = Math.max(
        Math.abs(edge.derivative.min - chordSlope),
        Math.abs(edge.derivative.max - chordSlope),
      );
      const maximumChordError = derivativeDeviation * width / 2;
      if (Number.isFinite(maximumChordError) && maximumChordError <= chordTolerance) {
        leaves.push({
          kind: "edge",
          left: { x: leftX, y: leftResult.value },
          right: { x: rightX, y: rightResult.value },
        });
        return;
      }
    }

    if (depth >= GRAPH_EXPRESSION_LIMITS.samplingDepth) {
      if (!leftResult.ok || !rightResult.ok) leaves.push({ kind: "gap", unsafe: false });
      else samplingBudgetExceeded = true;
      return;
    }
    const midpoint = keyForX((leftX + rightX) / 2);
    if (!(midpoint > leftX && midpoint < rightX)) {
      if (!leftResult.ok || !rightResult.ok) leaves.push({ kind: "gap", unsafe: false });
      else samplingBudgetExceeded = true;
      return;
    }
    const midpointResult = evaluateAt(midpoint);
    if (!midpointResult) return;
    refine(leftX, leftResult, midpoint, midpointResult, depth + 1);
    refine(midpoint, midpointResult, rightX, rightResult, depth + 1);
  };

  for (let index = 1; index < initialSamples.length && !samplingBudgetExceeded; index += 1) {
    const left = initialSamples[index - 1];
    const right = initialSamples[index];
    refine(left.x, left.result, right.x, right.result, 0);
  }

  const samplingFailure = () => failedAnalysis(
    sourceCanonical,
    canonical,
    xMin,
    xMax,
    diagnostic("GRAPH_SAMPLING_BUDGET_EXCEEDED", "Graph geometry could not be certified within its deterministic sampling budget."),
    sourceStructure.nodeCount,
    sourceStructure.maxDepth,
    evaluated.size,
  );
  if (samplingBudgetExceeded) return samplingFailure();

  const omitted = { division: 0, power: 0, nonfinite: 0, magnitude: 0 };
  evaluated.forEach((result) => {
    if (!result.ok) omitted[result.reason] += 1;
  });
  const segments: GraphPoint[][] = [];
  let current: GraphPoint[] = [];
  let unsafeConnections = 0;
  const flush = () => {
    if (current.length >= 2) segments.push(current);
    current = [];
  };
  for (const leaf of leaves) {
    if (leaf.kind === "gap") {
      if (leaf.unsafe) unsafeConnections += 1;
      flush();
      continue;
    }
    const previous = current.at(-1);
    if (!previous || previous.x !== leaf.left.x || previous.y !== leaf.left.y) {
      flush();
      current.push(leaf.left);
    }
    current.push(leaf.right);
  }
  flush();
  const emittedPoints = segments.reduce((total, segment) => total + segment.length, 0);
  if (emittedPoints > GRAPH_EXPRESSION_LIMITS.samplePoints) return samplingFailure();
  if (segments.length > GRAPH_EXPRESSION_LIMITS.segments) {
    return failedAnalysis(sourceCanonical, canonical, xMin, xMax, diagnostic("GRAPH_SEGMENT_LIMIT_EXCEEDED", `Graph sampling may produce at most ${GRAPH_EXPRESSION_LIMITS.segments} drawable segments.`), sourceStructure.nodeCount, sourceStructure.maxDepth, evaluated.size);
  }
  if (!segments.length) {
    const failure = unsafeConnections > 0
      ? diagnostic("GRAPH_OPERATIONAL_RANGE_UNCERTIFIED", "Graph geometry was omitted because the bounded structural analyzer could not certify every original intermediate operation. Distributive algebra is intentionally not assumed.")
      : diagnostic("GRAPH_NO_DRAWABLE_SEGMENTS", "Graph expression has no safely drawable line segment in this domain.");
    return failedAnalysis(sourceCanonical, canonical, xMin, xMax, failure, sourceStructure.nodeCount, sourceStructure.maxDepth, evaluated.size);
  }
  const yValues = segments.flatMap((segment) => segment.map(({ y }) => y));
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const ySpan = yMax - yMin;
  const normalizedSegments = segments.map((segment) => segment.map(({ x, y }) => ({
    x: (x - xMin) / (xMax - xMin) - 0.5,
    // Subtract the lower bound before scaling. `(min + max) / 2` can
    // underflow for adjacent subnormals and violate the documented ±0.5 box.
    y: ySpan === 0 ? 0 : (y - yMin) / ySpan - 0.5,
  })));
  const diagnostics: GraphExpressionDiagnostic[] = [];
  const singularSamples = omitted.division + omitted.power;
  if (singularSamples || unsafeConnections) diagnostics.push({
    severity: "warning",
    code: "GRAPH_DISCONTINUITIES_SEGMENTED",
    message: `Graph geometry was split at ${singularSamples} undefined sample${singularSamples === 1 ? "" : "s"} and ${unsafeConnections} conservatively unsafe connection${unsafeConnections === 1 ? "" : "s"}; no segment bridges them.`,
  });
  const boundedSamples = omitted.nonfinite + omitted.magnitude;
  if (boundedSamples) diagnostics.push({
    severity: "warning",
    code: "GRAPH_SAMPLES_OMITTED",
    message: `${boundedSamples} sample${boundedSamples === 1 ? " was" : "s were"} omitted for exceeding the finite magnitude envelope of ${GRAPH_EXPRESSION_LIMITS.magnitude}.`,
  });
  return {
    ok: true,
    canonical,
    analysisHash: analysisHash(sourceCanonical, canonical, xMin, xMax, segments, diagnostics),
    diagnostics,
    segments,
    normalizedSegments,
    evaluations: evaluated.size,
    nodeCount: sourceStructure.nodeCount,
    maxDepth: sourceStructure.maxDepth,
    yRange: { min: yMin, max: yMax },
  };
}
