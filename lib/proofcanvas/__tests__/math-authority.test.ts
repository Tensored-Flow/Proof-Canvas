import { compileManim } from "../compiler";
import { createCantorDemoProject } from "../demo";
import { analyzeLatex, type MathRenderer } from "../latex";
import { applyOperations } from "../operations";
import latexConformance from "../../../services/proofcanvas-render/tests/latex_conformance.json";
import {
  PROJECT_SCHEMA_VERSION,
  ProjectDocumentSchema,
  canonicalProjectJson,
  cloneSerializable,
  mathPropertiesFor,
  parseProjectDocument,
} from "../schema";

function editableMathProject() {
  const project = cloneSerializable(createCantorDemoProject());
  const shot = project.shots[0];
  const math = shot.objects.find(({ type }) => type === "math")!;
  math.locked = false;
  if (math.parentId) shot.objects.find(({ id }) => id === math.parentId)!.locked = false;
  return { project: ProjectDocumentSchema.parse(project), shotId: shot.id, objectId: math.id };
}

test.each(latexConformance.vectors)("shared LaTeX conformance: $id", ({ renderer, content, accepted }) => {
  expect(analyzeLatex(content, { renderer: renderer as MathRenderer }).ok).toBe(accepted);
});

test("bounded LaTeX analysis accepts nested math and ordinary Tex but diagnoses malformed and dangerous content precisely", () => {
  expect(analyzeLatex("\\frac{1}{\\sqrt{x^{2} + 1}}", { renderer: "mathtex" })).toEqual({ ok: true });
  expect(analyzeLatex("Euler wrote $e^{i\\pi}+1=0$.", { renderer: "tex" })).toEqual({ ok: true });
  expect(analyzeLatex("The price is \\$5.", { renderer: "tex" })).toEqual({ ok: true });
  expect(analyzeLatex("The price is 50%.", { renderer: "tex" })).toEqual({
    ok: false,
    code: "LATEX_SYNTAX_INVALID",
    message: 'Tex special character "%" must be escaped at character 16.',
    offset: 15,
  });
  expect(analyzeLatex("\\frac{1", { renderer: "mathtex" })).toEqual({
    ok: false,
    code: "LATEX_SYNTAX_INVALID",
    message: 'Unclosed "{" at character 6.',
    offset: 5,
  });
  expect(analyzeLatex("\\input{/etc/passwd}", { renderer: "mathtex" })).toEqual({
    ok: false,
    code: "LATEX_COMMAND_FORBIDDEN",
    message: "LaTeX command \\input is forbidden at character 1.",
    offset: 0,
  });
  expect(analyzeLatex("x\\\\*y", { renderer: "mathtex" })).toEqual({
    ok: false,
    code: "LATEX_SYNTAX_INVALID",
    message: "LaTeX linebreak modifiers are outside the supported dialect at character 4.",
    offset: 3,
  });
});

test("schema-v3 legacy math normalization is deterministic without a version bump", () => {
  const legacyShape = cloneSerializable(createCantorDemoProject());
  for (const shot of legacyShape.shots) for (const object of shot.objects) {
    if (object.type !== "math") continue;
    delete object.properties.renderer;
    delete object.properties.mode;
  }
  const parsed = parseProjectDocument(legacyShape);
  expect(parsed.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  const math = parsed.shots.flatMap(({ objects }) => objects).find(({ type }) => type === "math")!;
  expect(mathPropertiesFor(math)).toEqual({ content: math.properties.content, renderer: "mathtex", mode: "display" });
  expect(canonicalProjectJson(parseProjectDocument(parsed))).toBe(canonicalProjectJson(parsed));

  const invalidRenderer = cloneSerializable(parsed);
  invalidRenderer.shots[0].objects.find(({ type }) => type === "math")!.properties.renderer = "html";
  expect(ProjectDocumentSchema.safeParse(invalidRenderer).success).toBe(false);

  const malformed = cloneSerializable(parsed);
  malformed.shots[0].objects.find(({ type }) => type === "math")!.properties.content = "\\frac{1";
  const result = ProjectDocumentSchema.safeParse(malformed);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.some(({ message }) => message === 'Unclosed "{" at character 6.')).toBe(true);
});

test("manual operation ingress rejects malformed math atomically with the shared diagnostic", () => {
  const { project, shotId, objectId } = editableMathProject();
  const before = canonicalProjectJson(project);
  expect(() => applyOperations(project, shotId, [{
    type: "update-object",
    objectId,
    patch: { properties: { content: "\\frac{1", renderer: "mathtex", mode: "display" } },
  }])).toThrow(/character 6/);
  expect(canonicalProjectJson(project)).toBe(before);
});

test("font-size authoring and compiler bounds preserve the existing 1..256 schema contract", () => {
  const { project, shotId, objectId } = editableMathProject();
  for (const fontSize of [1, 256]) {
    const updated = applyOperations(project, shotId, [{ type: "update-object", objectId, patch: { style: { fontSize } } }]).project;
    expect(updated.shots[0].objects.find(({ id }) => id === objectId)?.style.fontSize).toBe(fontSize);
    expect(compileManim(updated).python).toContain(`font_size=${fontSize.toFixed(1)}`);
  }
  for (const fontSize of [0.99, 257]) {
    expect(() => applyOperations(project, shotId, [{ type: "update-object", objectId, patch: { style: { fontSize } } }])).toThrow();
  }
});

test("compiler selects Tex and MathTex deterministically and reports the bounded inline layout difference", () => {
  const display = editableMathProject();
  const displayMath = display.project.shots[0].objects.find(({ id }) => id === display.objectId)!;
  displayMath.properties = { content: "\\frac{1}{2}", renderer: "mathtex", mode: "display" };
  const mathtex = compileManim(ProjectDocumentSchema.parse(display.project));
  expect(mathtex.python).toContain('MathTex("\\\\frac{1}{2}"');
  expect(mathtex.diagnostics.some(({ code }) => code === "MATH_INLINE_LAYOUT_BOUNDED_DIFFERENCE")).toBe(false);

  const inline = cloneSerializable(display.project);
  inline.shots[0].objects.find(({ id }) => id === display.objectId)!.properties = {
    content: "Euler wrote $e^{i\\pi}+1=0$.", renderer: "tex", mode: "inline",
  };
  const tex = compileManim(ProjectDocumentSchema.parse(inline));
  expect(tex.python).toContain('Tex("Euler wrote $e^{i\\\\pi}+1=0$."');
  expect(tex.python).not.toContain('MathTex("Euler wrote');
  expect(tex.diagnostics).toContainEqual(expect.objectContaining({
    severity: "warning",
    code: "MATH_INLINE_LAYOUT_BOUNDED_DIFFERENCE",
    objectId: display.objectId,
  }));
});

test("compiler defense returns stable syntax diagnostics and emits no invalid math constructor", () => {
  const { project, objectId } = editableMathProject();
  project.shots[0].objects.find(({ id }) => id === objectId)!.properties.content = "\\frac{1";
  const result = compileManim(project);
  expect(result.diagnostics).toEqual([{
    severity: "error",
    code: "LATEX_SYNTAX_INVALID",
    message: 'Unclosed "{" at character 6.',
    objectId,
  }]);
  expect(result.python).not.toMatch(/\b(?:MathTex|Tex)\(/);
  expect(result.python).not.toContain("\\frac{1");
  expect(result.python).toContain("self.wait(0.0)");
});
