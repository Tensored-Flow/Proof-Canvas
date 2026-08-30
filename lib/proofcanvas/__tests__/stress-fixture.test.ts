import { compileManim } from "../compiler";
import { objectSelection } from "../editorSelection";
import { applyOperations } from "../operations";
import { previewShotAtTime } from "../preview";
import { ProjectDocumentSchema, canonicalProjectJson, cloneSerializable, projectDurationSeconds } from "../schema";
import { PROOFCANVAS_STRESS_INVENTORY, createProofCanvasStressProject } from "../stressFixture";
import { indexPropertyTracks, samplePropertyTracks } from "../timeline";

function elapsed(action: () => unknown): number {
  const startedAt = performance.now();
  action();
  return performance.now() - startedAt;
}

describe("ProofCanvas deterministic V1 stress fixture", () => {
  test("matches its exact capacity inventory and remains byte-deterministic", () => {
    const first = createProofCanvasStressProject();
    const second = createProofCanvasStressProject();
    expect(canonicalProjectJson(first)).toBe(canonicalProjectJson(second));
    expect(first.shots).toHaveLength(PROOFCANVAS_STRESS_INVENTORY.shots);
    expect(first.shots.flatMap(({ objects }) => objects)).toHaveLength(PROOFCANVAS_STRESS_INVENTORY.objects);
    expect(first.shots.flatMap(({ animations }) => animations)).toHaveLength(PROOFCANVAS_STRESS_INVENTORY.animations);
    expect(first.shots.flatMap(({ propertyTracks }) => propertyTracks.flatMap(({ keyframes }) => keyframes)))
      .toHaveLength(PROOFCANVAS_STRESS_INVENTORY.keyframes);
    expect(projectDurationSeconds(first)).toBe(PROOFCANVAS_STRESS_INVENTORY.audioSeconds);
    expect(ProjectDocumentSchema.parse(first)).toEqual(first);

    const clips = first.shots.flatMap(({ audioClips }) => audioClips);
    expect(clips.reduce((seconds, clip) => seconds + clip.duration, 0)).toBe(PROOFCANVAS_STRESS_INVENTORY.audioSeconds);
    expect(clips.map(({ sourceStart, sourceEnd }) => [sourceStart, sourceEnd])).toEqual(
      Array.from({ length: 10 }, (_, index) => [index * 9, (index + 1) * 9]),
    );
    expect(clips.every(({ assetId }) => assetId === first.assets[0].id)).toBe(true);
  });

  test("keeps measured core editor workflows inside generous regression ceilings", () => {
    let project = createProofCanvasStressProject();
    const metrics = {
      editorLoad: elapsed(() => { project = ProjectDocumentSchema.parse(cloneSerializable(project)); }),
      timelineInteraction: elapsed(() => {
        for (const shot of project.shots) {
          const index = indexPropertyTracks(shot);
          expect(index.byId.size).toBe(8);
          expect(samplePropertyTracks(shot, 5.5)).toHaveLength(8);
        }
      }),
      playback: elapsed(() => {
        for (const shot of project.shots) {
          expect(previewShotAtTime(shot, 4.5).objects).toHaveLength(15);
        }
      }),
      selection: elapsed(() => {
        for (const shot of project.shots) {
          expect(objectSelection(shot, shot.objects.slice(0, 10).map(({ id }) => id)).kind).toBe("objects");
        }
      }),
      inspectorUpdate: elapsed(() => {
        const shot = project.shots[0];
        const target = shot.objects[14];
        const result = applyOperations(project, shot.id, [{
          type: "update-object",
          objectId: target.id,
          patch: { style: { opacity: 0.75 } },
        }]);
        expect(result.project.shots[0].objects[14].style.opacity).toBe(0.75);
      }),
      autosaveSerialization: elapsed(() => {
        expect(canonicalProjectJson(project).length).toBeGreaterThan(100_000);
      }),
      compilation: elapsed(() => {
        const compiled = compileManim(project, { audioTransport: true });
        expect(compiled.python.length).toBeGreaterThan(200_000);
        expect(compiled.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
      }),
    };

    // These are regression tripwires, not benchmark claims. Each ceiling is
    // deliberately much larger than normal local timings so shared CI noise
    // cannot turn a useful capacity test into a micro-benchmark.
    expect(metrics.editorLoad).toBeLessThan(5_000);
    expect(metrics.timelineInteraction).toBeLessThan(2_000);
    expect(metrics.playback).toBeLessThan(3_000);
    expect(metrics.selection).toBeLessThan(2_000);
    expect(metrics.inspectorUpdate).toBeLessThan(5_000);
    expect(metrics.autosaveSerialization).toBeLessThan(2_000);
    expect(metrics.compilation).toBeLessThan(10_000);
  });
});
