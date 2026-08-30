import { createHash } from "node:crypto";
import { compileManim } from "../compiler";
import {
  DETERMINISTIC_AUDIO_FIXTURE,
  createCantorDemoProject,
  createCantorV1Project,
  createDeterministicAudioFixtureBytes,
} from "../demo";
import { applyOperations } from "../operations";
import { ProjectDocumentSchema, canonicalProjectJson, projectDurationSeconds } from "../schema";

describe("Uncountable, Yet Zero Length V1 representative project", () => {
  test("retains the frozen compatibility demo while exposing a complete editable V1 project", () => {
    const legacy = createCantorDemoProject();
    const project = createCantorV1Project();

    expect(legacy.shots.map(({ id }) => id)).toEqual([
      "shot-cantor-construction",
      "shot-cantor-conclusion",
    ]);
    expect(project.shots).toHaveLength(5);
    expect(project.shots[0].id).toBe("shot-cantor-construction");
    expect(project.shots.at(-1)?.id).toBe("shot-cantor-conclusion");
    expect(projectDurationSeconds(project)).toBe(52);
    expect(ProjectDocumentSchema.parse(project)).toEqual(project);
    expect(canonicalProjectJson(createCantorV1Project())).toBe(canonicalProjectJson(project));

    const objects = project.shots.flatMap(({ objects }) => objects);
    const animations = project.shots.flatMap(({ animations }) => animations);
    const keyframes = project.shots.flatMap(({ propertyTracks }) => propertyTracks.flatMap(({ keyframes }) => keyframes));
    expect(objects.some(({ type }) => type === "text")).toBe(true);
    expect(objects.some(({ type }) => type === "math")).toBe(true);
    expect(objects.some(({ type }) => type === "arrow")).toBe(true);
    expect(objects.some(({ type }) => type === "brace")).toBe(true);
    expect(objects.some(({ semanticRole }) => semanticRole === "interval-diagram")).toBe(true);
    expect(objects.some(({ semanticRole }) => semanticRole === "numerical-bar")).toBe(true);
    expect(objects.some(({ style }) => Object.keys(style).length > 0)).toBe(true);
    expect(animations.some(({ type }) => type === "camera-focus")).toBe(true);
    expect(animations.map(({ type }) => type)).toEqual(expect.arrayContaining([
      "write", "create", "fade-in", "fade-out", "emphasise", "camera-focus",
    ]));
    expect(keyframes.some(({ interpolation }) => interpolation.kind === "custom-bezier")).toBe(true);
    expect(project.customEasings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "easing-cantor-settle" }),
    ]));
    expect(project.shots.every(({ captionClips, markers }) => captionClips.length > 0 && markers.length > 0)).toBe(true);
    expect(project.shots.every(({ audioClips }) => audioClips.length === 1)).toBe(true);

    const editable = applyOperations(project, "shot-cantor-bookkeeping", [{
      type: "update-object",
      objectId: "object-v1-bookkeeping-note",
      patch: { properties: { content: "A deliberate, reversible edit." } },
    }]).project;
    expect(editable.shots[1].objects.find(({ id }) => id === "object-v1-bookkeeping-note")?.properties.content)
      .toBe("A deliberate, reversible edit.");
    expect(project.shots[1].objects.find(({ id }) => id === "object-v1-bookkeeping-note")?.properties.content)
      .not.toBe("A deliberate, reversible edit.");
  });

  test("binds every audio clip to the exact deterministic WAV authority", () => {
    const bytes = createDeterministicAudioFixtureBytes();
    expect(bytes.byteLength).toBe(DETERMINISTIC_AUDIO_FIXTURE.metadata.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(DETERMINISTIC_AUDIO_FIXTURE.metadata.sha256);
    expect([...bytes.slice(0, 4)].map((value) => String.fromCharCode(value)).join("")).toBe("RIFF");
    expect([...bytes.slice(8, 12)].map((value) => String.fromCharCode(value)).join("")).toBe("WAVE");

    const project = createCantorV1Project();
    expect(project.assets).toEqual([DETERMINISTIC_AUDIO_FIXTURE.metadata]);
    const clips = project.shots.flatMap(({ audioClips }) => audioClips);
    expect(clips.map(({ sourceStart, sourceEnd }) => [sourceStart, sourceEnd])).toEqual([
      [0, 21], [21, 29], [29, 37], [37, 45], [45, 52],
    ]);
    expect(clips.reduce((seconds, clip) => seconds + clip.duration, 0)).toBe(52);
  });

  test("compiles without error diagnostics when the trusted renderer supplies audio transport", () => {
    const compiled = compileManim(createCantorV1Project(), { audioTransport: true });
    expect(compiled.python).toContain("class GeneratedScene(MovingCameraScene)");
    expect(compiled.python.length).toBeGreaterThan(30_000);
    expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  });
});
