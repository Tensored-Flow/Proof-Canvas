import { REQUIRED_AI_COMMANDS, UnsupportedDemoCommandError, interpretDemoCommand } from "../ai";
import { createCantorDemoProject } from "../demo";
import { applyOperations } from "../operations";
import { previewShotAtAnimationEnd, previewShotAtTime } from "../preview";
import { cloneSerializable } from "../schema";

const SHOT = "shot-cantor-construction";

describe("timeline preview", () => {
  test("samples semantic visibility, transforms, emphasis, and camera deterministically", () => {
    const project = createCantorDemoProject();
    const shot = project.shots[0];
    const before = previewShotAtTime(shot, 0);
    const during = previewShotAtTime(shot, 0.6);
    const after = previewShotAtTime(shot, 20);
    expect(before.objects.find(({ id }) => id === "object-title")?.preview.opacity).toBe(0);
    expect(during.objects.find(({ id }) => id === "object-title")!.preview.opacity).toBeGreaterThan(0);
    expect(after.objects.find(({ id }) => id === "object-equation-limit")?.preview.opacity).toBe(1);
    expect(previewShotAtTime(shot, 999).time).toBe(shot.duration);
    expect(previewShotAtTime(shot, 13.6).camera.zoom).toBeGreaterThan(1);
    expect(previewShotAtTime(shot, 12)).toEqual(previewShotAtTime(shot, 12));
  });

  test("uses stable start-time then animation-ID overlap ordering", () => {
    const project = createCantorDemoProject();
    const shot = cloneSerializable(project.shots[1]);
    shot.animations = [
      { id: "animation-z", type: "move", targetIds: ["object-conclusion-title"], start: 0, duration: 1, easing: "linear", properties: { x: 300 } },
      { id: "animation-a", type: "move", targetIds: ["object-conclusion-title"], start: 0, duration: 1, easing: "linear", properties: { x: 500 } },
    ];
    expect(previewShotAtTime(shot, 1).objects.find(({ id }) => id === "object-conclusion-title")?.transform.x).toBe(300);
  });

  test("applies non-unit style opacity exactly once through fades", () => {
    const shot = cloneSerializable(createCantorDemoProject().shots[1]);
    shot.objects[0].style.opacity = 0.4;
    shot.animations = [{ id: "animation-opacity", type: "fade-in", targetIds: [shot.objects[0].id], start: 0, duration: 2, easing: "linear", properties: {} }];
    expect(previewShotAtTime(shot, 1).objects[0].preview.opacity).toBeCloseTo(0.2);
    expect(previewShotAtTime(shot, 2).objects[0].preview.opacity).toBeCloseTo(0.4);
  });

  test("keeps hidden objects and descendants hidden through entrance animations", () => {
    const shot = cloneSerializable(createCantorDemoProject().shots[0]);
    shot.objects.find(({ id }) => id === "object-title")!.visible = false;
    shot.objects.find(({ id }) => id === "object-interval-left-1")!.visible = false;

    expect(previewShotAtTime(shot, 2).objects.find(({ id }) => id === "object-title")?.preview.opacity).toBe(0);
    expect(previewShotAtTime(shot, 7).objects.find(({ id }) => id === "object-interval-left-1")?.preview.opacity).toBe(0);

    shot.objects.find(({ id }) => id === "object-interval-diagram")!.visible = false;
    expect(previewShotAtTime(shot, 12).objects.find(({ id }) => id === "object-interval-third-1-left")?.preview.opacity).toBe(0);
  });

  test("starts from the earliest visibility event and carries opacity across fade-out then fade-in", () => {
    const shot = cloneSerializable(createCantorDemoProject().shots[1]);
    const targetId = shot.objects[0].id;
    shot.animations = [
      { id: "animation-visible-out", type: "fade-out", targetIds: [targetId], start: 1, duration: 1, easing: "linear", properties: {} },
      { id: "animation-visible-in", type: "fade-in", targetIds: [targetId], start: 3, duration: 1, easing: "linear", properties: {} },
    ];
    const opacityAt = (time: number) => previewShotAtTime(shot, time).objects[0].preview.opacity;

    expect(opacityAt(0)).toBe(1);
    expect(opacityAt(1.5)).toBeCloseTo(0.5);
    expect(opacityAt(2.5)).toBe(0);
    expect(opacityAt(3.5)).toBeCloseTo(0.5);
    expect(opacityAt(4)).toBe(1);
  });

  test("keeps an adjacent appear at zero progress on the prior animation boundary", () => {
    const shot = cloneSerializable(createCantorDemoProject().shots[1]);
    const targetId = shot.objects[0].id;
    const fadeOut = { id: "animation-boundary-out", type: "fade-out" as const, targetIds: [targetId], start: 0, duration: 1, easing: "linear" as const, properties: {} };
    shot.animations = [
      fadeOut,
      { id: "animation-boundary-appear", type: "appear", targetIds: [targetId], start: 1, duration: 1, easing: "linear", properties: {} },
    ];

    expect(previewShotAtTime(shot, 1).objects[0].preview.opacity).toBe(0);
    expect(previewShotAtTime(shot, 1.5).objects[0].preview.opacity).toBeCloseTo(0.5);
    expect(previewShotAtAnimationEnd(shot, fadeOut).objects[0].preview.opacity).toBe(0);
  });
});

describe("deterministic AI interpreter", () => {
  test.each(REQUIRED_AI_COMMANDS)("returns a valid atomic proposal for: %s", (instruction) => {
    const project = createCantorDemoProject();
    const proposal = interpretDemoCommand({ project, shotId: SHOT, selectedObjectIds: [], instruction });
    expect(proposal.demoMode).toBe(true);
    expect(proposal.operations.length).toBeGreaterThan(0);
    expect(() => applyOperations(project, SHOT, proposal.operations)).not.toThrow();
  });

  test("preserves the interval diagram in the title command and creates a timed editable brace", () => {
    const project = createCantorDemoProject();
    const titleProposal = interpretDemoCommand({ project, shotId: SHOT, selectedObjectIds: [], instruction: REQUIRED_AI_COMMANDS[0] });
    expect(titleProposal.operations.some((operation) => "objectId" in operation && operation.objectId === "object-interval-diagram")).toBe(false);

    const braceProposal = interpretDemoCommand({ project, shotId: SHOT, selectedObjectIds: [], instruction: REQUIRED_AI_COMMANDS[2] });
    const applied = applyOperations(project, SHOT, braceProposal.operations).project.shots[0];
    const brace = applied.objects.find(({ semanticRole }) => semanticRole === "surviving-intervals-brace")!;
    const reveal = applied.animations.find(({ targetIds }) => targetIds.includes(brace.id))!;
    const split = applied.animations.find(({ id }) => id === "animation-third-split")!;
    const removals = applied.animations.find(({ id }) => id === "animation-third-removals")!;
    expect(brace.properties.label).toBe("2^n pieces");
    expect(reveal.start).toBeGreaterThan(split.start + split.duration);
    expect(reveal.start).toBeGreaterThan(removals.start + removals.duration);
    expect(split.type).toBe("create");
    expect(split.targetIds).toHaveLength(12);
  });

  test("uses selection for generic commands and refuses locked or unsupported edits", () => {
    const project = createCantorDemoProject();
    const proposal = interpretDemoCommand({ project, shotId: SHOT, selectedObjectIds: ["object-subtitle"], instruction: "Move this right" });
    expect(proposal.operations).toEqual([{ type: "update-object", objectId: "object-subtitle", patch: { transform: { x: 284, y: 116 } } }]);
    expect(() => interpretDemoCommand({ project, shotId: SHOT, selectedObjectIds: ["object-equation-length"], instruction: "Move this right" })).toThrow(/locked/);
    expect(() => interpretDemoCommand({ project, shotId: SHOT, selectedObjectIds: ["object-equation-length"], instruction: "Unlock this" })).toThrow(/may not unlock/);
    expect(() => interpretDemoCommand({ project, shotId: SHOT, selectedObjectIds: [], instruction: "Invent a proof of the Riemann hypothesis" })).toThrow(UnsupportedDemoCommandError);
  });

  test("keeps the required second-removal emphasis disjoint from its slowed fade", () => {
    const project = createCantorDemoProject();
    const proposal = interpretDemoCommand({ project, shotId: SHOT, selectedObjectIds: [], instruction: REQUIRED_AI_COMMANDS[1] });
    const shot = applyOperations(project, SHOT, proposal.operations).project.shots[0];
    const target = "object-removal-second";
    const animations = shot.animations.filter(({ targetIds }) => targetIds.includes(target)).sort((left, right) => left.start - right.start);
    for (let index = 1; index < animations.length; index += 1) expect(animations[index - 1].start + animations[index - 1].duration).toBeLessThanOrEqual(animations[index].start);
  });
});
