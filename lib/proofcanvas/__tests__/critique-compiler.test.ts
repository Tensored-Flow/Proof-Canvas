import { spawnSync } from "node:child_process";
import { compileManim, estimateManimTimelineDurationUpperBound } from "../compiler";
import { insertSemanticComponent } from "../components";
import { critiqueProject } from "../critique";
import { createCantorDemoProject } from "../demo";
import { previewShotAtTime } from "../preview";
import { ProjectDocumentSchema, cloneSerializable, type SceneObject } from "../schema";
import { EDITORIAL_INK_STYLE_ID, RAW_MANIM_STYLE_ID, styledTransform } from "../styles";

function validateWithRendererPolicy(source: string) {
  const script = [
    "import hashlib, importlib.util, sys",
    "path = 'services/proofcanvas-render/proofcanvas_render/policy.py'",
    "spec = importlib.util.spec_from_file_location('proofcanvas_policy_test', path)",
    "module = importlib.util.module_from_spec(spec)",
    "sys.modules[spec.name] = module",
    "spec.loader.exec_module(module)",
    "source = sys.stdin.read()",
    "module.validate_generated_source(source, hashlib.sha256(source.encode()).hexdigest())",
  ].join("; ");
  return spawnSync("python3", ["-c", script], { input: source, encoding: "utf8" });
}

describe("deterministic composition critic", () => {
  test("reports every required mechanical issue with actionable fields", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const title = shot.objects[0];
    title.transform.x = -20;
    title.transform.y = 20;
    title.style.fontSize = 10;
    title.style.color = "#f3eedf";
    delete title.semanticRole;
    shot.objects[1].transform = { ...title.transform };
    shot.objects[1].style.fontSize = 10;
    delete shot.objects[1].semanticRole;
    shot.objects[2].style.fontSize = 10;
    delete shot.objects[2].semanticRole;
    for (let index = 0; index < 4; index += 1) {
      shot.objects.push({
        id: `object-density-${index}`,
        type: "circle",
        name: `Density ${index}`,
        locked: false,
        visible: true,
        transform: { x: 15 + index, y: 15 + index, width: 30, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
        style: {},
        properties: {},
      });
    }
    shot.animations.push(
      { id: "animation-extra-one", type: "emphasise", targetIds: [title.id], start: 1.5, duration: 2, easing: "linear", properties: {} },
      { id: "animation-extra-two", type: "scale", targetIds: [shot.objects[1].id], start: 1.5, duration: 2, easing: "linear", properties: {} },
      { id: "animation-missing", type: "appear", targetIds: ["object-missing"], start: 1.5, duration: 1, easing: "linear", properties: {} },
    );
    title.locked = true;
    const kinds = new Set(critiqueProject(project, {
      shotId: shot.id,
      proposedOperations: [{ type: "update-object", objectId: title.id, patch: { name: "Unsafe" } }],
    }).map(({ kind }) => kind));
    expect(kinds).toEqual(new Set([
      "overlap",
      "outside-frame",
      "unreadable-text",
      "insufficient-contrast",
      "overcrowded-region",
      "inconsistent-margins",
      "simultaneous-animations",
      "weak-focal-hierarchy",
      "missing-animation-target",
      "locked-operation-target",
    ]));
    for (const result of critiqueProject(project, { shotId: shot.id })) {
      expect(result.id).toMatch(/^critique-/);
      expect(result.explanation.length).toBeGreaterThan(12);
      expect(result.proposedCorrection.length).toBeGreaterThan(12);
    }
  });

  test("uses rotated world-space AABBs and inherited locks", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    shot.objects[0].transform = { ...shot.objects[0].transform, x: 900, y: 270, width: 100, height: 300, rotation: 45 };
    const group: SceneObject = { id: "group-locked", type: "group", name: "Locked parent", locked: true, visible: true, transform: { x: 300, y: 300, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} };
    shot.objects.push(group);
    shot.objects[1].parentId = group.id;
    const results = critiqueProject(project, { shotId: shot.id, proposedOperations: [{ type: "update-object", objectId: shot.objects[1].id, patch: { name: "Unsafe" } }] });
    expect(results.some(({ kind, objectIds }) => kind === "outside-frame" && objectIds.includes(shot.objects[0].id))).toBe(true);
    expect(results.some(({ kind, objectIds }) => kind === "locked-operation-target" && objectIds.includes(shot.objects[1].id))).toBe(true);
  });

  test("uses active-style geometry and ignores inherited-hidden leaves", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const title = shot.objects[0];
    title.transform = { ...title.transform, x: 883, y: 270, width: 120, height: 40, rotation: 0, scaleX: 1, scaleY: 1 };
    project.activeStyleId = EDITORIAL_INK_STYLE_ID;
    expect(critiqueProject(project, { shotId: shot.id }).some(({ kind, objectIds }) => kind === "outside-frame" && objectIds.includes(title.id))).toBe(true);

    project.activeStyleId = RAW_MANIM_STYLE_ID;
    expect(critiqueProject(project, { shotId: shot.id }).some(({ kind, objectIds }) => kind === "outside-frame" && objectIds.includes(title.id))).toBe(false);

    const hiddenGroup: SceneObject = { id: "group-hidden-critic", type: "group", name: "Hidden critic group", locked: false, visible: false, transform: { x: 480, y: 270, width: 200, height: 80, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} };
    shot.objects.unshift(hiddenGroup);
    title.parentId = hiddenGroup.id;
    title.transform.x = -100;
    expect(critiqueProject(project, { shotId: shot.id }).some(({ kind, objectIds }) => kind === "outside-frame" && objectIds.includes(title.id))).toBe(false);
  });

  test("does not flag intentional focus-frame and content overlap", () => {
    const project = insertSemanticComponent(createCantorDemoProject(), "shot-cantor-conclusion", "focus-callout", { x: 480, y: 270 });
    const calloutIds = project.shots[1].objects.filter(({ semanticRole }) => semanticRole === "focus-frame" || semanticRole === "focus-callout").map(({ id }) => id);
    expect(calloutIds).toHaveLength(2);
    expect(critiqueProject(project, { shotId: "shot-cantor-conclusion" }).some(({ kind, objectIds }) => kind === "overlap" && calloutIds.every((id) => objectIds.includes(id)))).toBe(false);
  });
});

describe("Manim compiler", () => {
  test("is byte-deterministic, readable, parseable Python with objects and timing", () => {
    const project = createCantorDemoProject();
    const first = compileManim(project);
    const second = compileManim(cloneSerializable(project));
    expect(second.python).toBe(first.python);
    expect(first.python).toContain("class GeneratedScene(MovingCameraScene):");
    expect(first.python).toContain("MathTex(\"L_n = (2/3)^n\"");
    expect(first.python).toContain("Rectangle(width=");
    expect(first.python).toContain("Write(pc_uncountable_yet_zero_length, run_time=1.2");
    expect(first.python).toContain("pc_uncountable_yet_zero_length.scale(min(");
    expect(first.python).toContain("max(pc_uncountable_yet_zero_length.width, 0.001)");
    expect(first.python).toContain("max(pc_uncountable_yet_zero_length.height, 0.001)");
    expect(first.python).toContain("Indicate(pc_limit_of_surviving_length, color=\"#71402d\", scale_factor=1.08, run_time=1.3, rate_func=rate_functions.there_and_back)");
    expect(first.python).toContain("self.camera.frame.become(Rectangle(width=config.frame_width");
    expect(first.python).toContain("# Animation component 1: 0.0s to 1.5s");
    expect(first.python).toContain("Succession(Wait(0.7), FadeIn(pc_a_quiet_paradox");
    expect(first.python).toContain("group=Group())");
    expect(first.python).not.toContain("Succession(Wait(7.4)");
    expect(first.python).not.toMatch(/\beval\s*\(/);
    const parsed = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: first.python, encoding: "utf8" });
    expect(parsed.stderr).toBe("");
    expect(parsed.status).toBe(0);
  });

  test("keeps schema-valid control characters in shot names out of Python comments", () => {
    const project = cloneSerializable(createCantorDemoProject());
    project.shots[0].name = "First line\nnot_valid_python\u0000\u2028continued";
    const validated = ProjectDocumentSchema.parse(project);
    const python = compileManim(validated).python;

    expect(python).toContain("# Shot 1: First line not_valid_python continued");
    expect(python).toContain('self.next_section("First line\\nnot_valid_python\\u0000\\u2028continued")');
    const parsed = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: python, encoding: "utf8" });
    expect(parsed.stderr).toBe("");
    expect(parsed.status).toBe(0);
  });

  test("isolates future animation components while preserving distinct-object overlap timing", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.duration = 8;
    shot.animations = [
      { id: "animation-overlap-a", type: "fade-in", targetIds: [shot.objects[0].id], start: 0, duration: 2, easing: "linear", properties: {} },
      { id: "animation-overlap-b", type: "fade-in", targetIds: [shot.objects[1].id], start: 1, duration: 2, easing: "linear", properties: {} },
      { id: "animation-future-intro", type: "fade-in", targetIds: [shot.objects[2].id], start: 4, duration: 1, easing: "linear", properties: {} },
      { id: "animation-future-emphasis", type: "emphasise", targetIds: [shot.objects[2].id], start: 6, duration: 1, easing: "linear", properties: { scale: 1.1 } },
    ];

    const python = compileManim(ProjectDocumentSchema.parse(project)).python;
    const firstComponent = python.indexOf("# Animation component 1: 0.0s to 3.0s");
    const delayedOverlap = python.indexOf("Succession(Wait(1.0), FadeIn(pc_uncountable");
    const futureIntroComponent = python.indexOf("# Animation component 2: 4.0s to 5.0s");
    const futureIntro = python.indexOf("self.play(FadeIn(pc_zero_length");
    const futureEmphasisComponent = python.indexOf("# Animation component 3: 6.0s to 7.0s");
    const futureEmphasis = python.indexOf("self.play(Indicate(pc_zero_length");

    expect(firstComponent).toBeGreaterThan(-1);
    expect(delayedOverlap).toBeGreaterThan(firstComponent);
    expect(futureIntroComponent).toBeGreaterThan(delayedOverlap);
    expect(futureIntro).toBeGreaterThan(futureIntroComponent);
    expect(futureEmphasisComponent).toBeGreaterThan(futureIntro);
    expect(futureEmphasis).toBeGreaterThan(futureEmphasisComponent);
    expect(python.match(/self\.play\(/g)).toHaveLength(3);
    expect(python.match(/        self\.wait\(1\.0\)/g)).toHaveLength(3);
    expect(python).not.toContain("Succession(Wait(4.0)");
    expect(python).not.toContain("Succession(Wait(6.0)");
  });

  test("keeps bridged later non-introducers out of an overlap component's eager Manim group", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.duration = 3;
    shot.animations = [
      { id: "animation-a-intro", type: "fade-in", targetIds: [shot.objects[0].id], start: 0, duration: 1, easing: "linear", properties: {} },
      { id: "animation-b-bridge", type: "fade-in", targetIds: [shot.objects[1].id], start: 0.5, duration: 1.5, easing: "linear", properties: {} },
      { id: "animation-a-later", type: "emphasise", targetIds: [shot.objects[0].id], start: 1.2, duration: 0.6, easing: "linear", properties: { scale: 1.1 } },
    ];

    const python = compileManim(ProjectDocumentSchema.parse(project)).python;
    expect(python).toContain("# Animation component 1: 0.0s to 2.0s");
    expect(python).toContain("FadeIn(pc_the_contrast, run_time=1.0, rate_func=linear),");
    expect(python).toContain("Succession(Wait(0.5), FadeIn(pc_uncountable, run_time=1.5, rate_func=linear), group=Group()),");
    expect(python).toContain("Succession(Wait(1.2), Indicate(pc_the_contrast, color=\"#71402d\", scale_factor=1.1, run_time=0.6, rate_func=rate_functions.there_and_back), group=Group()),");
    expect(python).toContain("            group=Group(),\n            lag_ratio=0,");
    expect(python.match(/group=Group\(\)/g)).toHaveLength(3);
    expect(python).toContain("        self.wait(1.0)");
  });

  test("uses an empty lazy group with an absolute target for delayed camera transforms", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.animations = [
      { id: "animation-long-intro", type: "fade-in", targetIds: [shot.objects[0].id], start: 0, duration: 2, easing: "linear", properties: {} },
      { id: "animation-delayed-camera", type: "camera-focus", targetIds: [shot.objects[0].id], start: 0.5, duration: 1, easing: "linear", properties: { x: 500, y: 280, zoom: 1.08 } },
    ];
    const python = compileManim(ProjectDocumentSchema.parse(project)).python;
    expect(python).toMatch(/Succession\(Wait\(0\.5\), Transform\(self\.camera\.frame, Rectangle\(width=config\.frame_width \/ 1\.08.*group=Group\(\)\)/);
  });

  test("compiles sequential object and camera targets from their semantic state at animation start", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const object = shot.objects[0];
    project.shots = [shot];
    shot.objects = [object];
    shot.duration = 7;
    shot.camera = { x: 480, y: 270, zoom: 1, rotation: 0 };
    object.transform = { x: 480, y: 270, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1 };
    shot.animations = [
      { id: "animation-scale-first", type: "scale", targetIds: [object.id], start: 0, duration: 1, easing: "linear", properties: { scale: 2 } },
      { id: "animation-transform-next", type: "transform", targetIds: [object.id], start: 1, duration: 1, easing: "linear", properties: { x: 600, width: 150, height: 75, rotation: 10, scaleX: 3, scaleY: 4 } },
      { id: "animation-move-delta-next", type: "move", targetIds: [object.id], start: 2, duration: 1, easing: "linear", properties: { deltaX: 60, deltaY: -30 } },
      { id: "animation-transform-rotation-next", type: "transform", targetIds: [object.id], start: 3, duration: 1, easing: "linear", properties: { rotation: 20 } },
      { id: "animation-camera-first", type: "camera-focus", targetIds: [object.id], start: 4, duration: 1, easing: "linear", properties: { x: 540, y: 240, zoom: 2, rotation: 10 } },
      { id: "animation-camera-next", type: "camera-focus", targetIds: [object.id], start: 5, duration: 1, easing: "linear", properties: { zoom: 2, rotation: 20 } },
    ];

    const python = compileManim(ProjectDocumentSchema.parse(project)).python;

    const reference = python.match(/(pc_ref_[a-f0-9_]+) = pc_the_contrast\.copy\(\)/)?.[1];
    expect(reference).toBeDefined();
    expect(python).toContain(`${reference}.copy().stretch(2.0, 0).stretch(2.0, 1)`);
    expect(python).toContain(`${reference}.copy().stretch(4.5, 0).stretch(6.0, 1).rotate(10.0 * DEGREES).move_to([2.71111107, -0.62222221, 0])`);
    expect(python).toContain(`${reference}.copy().stretch(4.5, 0).stretch(6.0, 1).rotate(10.0 * DEGREES).move_to([3.59999994, -0.17777777, 0])`);
    expect(python).toContain(`${reference}.copy().stretch(4.5, 0).stretch(6.0, 1).rotate(20.0 * DEGREES).move_to([3.59999994, -0.17777777, 0])`);
    expect(python).toContain("Rectangle(width=config.frame_width / 2.0, height=config.frame_height / 2.0).move_to([0.88888888, 0.44444444, 0]).rotate(10.0 * DEGREES)");
    expect(python).toContain("Rectangle(width=config.frame_width / 2.0, height=config.frame_height / 2.0).move_to([0.88888888, 0.44444444, 0]).rotate(20.0 * DEGREES)");
  });

  test("keeps a delayed same-object target absolute when another object bridges the timeline component", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const scaled = shot.objects[0];
    const bridge = shot.objects[1];
    project.shots = [shot];
    shot.duration = 3;
    shot.objects = [scaled, bridge];
    shot.animations = [
      { id: "animation-scale-two", type: "scale", targetIds: [scaled.id], start: 0, duration: 1, easing: "linear", properties: { scale: 2 } },
      { id: "animation-bridge", type: "fade-in", targetIds: [bridge.id], start: 0.5, duration: 1.5, easing: "linear", properties: {} },
      { id: "animation-scale-four", type: "scale", targetIds: [scaled.id], start: 1.2, duration: 0.6, easing: "linear", properties: { scale: 4 } },
    ];

    expect(ProjectDocumentSchema.safeParse(project).success).toBe(true);
    expect(previewShotAtTime(shot, 3).objects.find(({ id }) => id === scaled.id)?.transform.scaleX).toBe(4);
    const python = compileManim(project).python;
    const reference = python.match(/(pc_ref_[a-f0-9_]+) = pc_the_contrast\.copy\(\)/)?.[1];
    expect(reference).toBeDefined();
    expect(python).toContain("# Animation component 1: 0.0s to 2.0s");
    expect(python).toContain(`Succession(Wait(1.2), Transform(pc_the_contrast, ${reference}.copy().stretch(4.0, 0).stretch(4.0, 1)`);
    expect(python).not.toContain("Transform(pc_the_contrast, pc_the_contrast.copy().stretch");
  });

  test("applies a multi-target move delta independently without collapsing spacing", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const rectangle = (id: string, name: string, x: number): SceneObject => ({
      id,
      type: "rectangle",
      name,
      locked: false,
      visible: true,
      transform: { x, y: 270, width: 60, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    });
    const left = rectangle("object-delta-left", "Delta left", 100);
    const right = rectangle("object-delta-right", "Delta right", 220);
    project.shots = [shot];
    shot.duration = 2;
    shot.objects = [left, right];
    shot.animations = [
      { id: "animation-multi-delta", type: "move", targetIds: [left.id, right.id], start: 0, duration: 1, easing: "linear", properties: { deltaX: 50, deltaY: 10 } },
    ];

    const final = previewShotAtTime(shot, 1).objects;
    expect(final.map(({ transform }) => [transform.x, transform.y])).toEqual([[150, 280], [270, 280]]);
    const python = compileManim(ProjectDocumentSchema.parse(project)).python;
    expect(python).toContain("AnimationGroup(Transform(pc_delta_left");
    expect(python).toContain(".move_to([-4.88888881, -0.14814815, 0]).set_opacity(1.0)");
    expect(python).toContain(".move_to([-3.11111106, -0.14814815, 0]).set_opacity(1.0)");
  });

  test("rejects overlapping camera tracks before preview's ambiguous composition reaches the compiler", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    project.shots = [shot];
    shot.animations = [
      { id: "animation-camera-a", type: "camera-focus", targetIds: [shot.objects[0].id], start: 0, duration: 2, easing: "linear", properties: { zoom: 2, rotation: 10 } },
      { id: "animation-camera-b", type: "camera-focus", targetIds: [shot.objects[1].id], start: 1, duration: 1, easing: "linear", properties: { zoom: 3, rotation: 20 } },
    ];

    expect(previewShotAtTime(shot, 1.5).camera.zoom).toBeCloseTo(2.375);
    expect(() => compileManim(project)).toThrow(/camera-focus animations must be sequential/);
  });

  test("preserves accumulated descendant state across child and group spatial animation orderings", () => {
    const base = cloneSerializable(createCantorDemoProject());
    const shot = base.shots[1];
    const group: SceneObject = {
      id: "group-sequenced",
      type: "group",
      name: "Sequenced group",
      locked: false,
      visible: true,
      transform: { x: 100, y: 270, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    const child: SceneObject = {
      id: "object-sequenced-child",
      parentId: group.id,
      type: "rectangle",
      name: "Sequenced child",
      locked: false,
      visible: true,
      transform: { x: 100, y: 270, width: 40, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    base.shots = [shot];
    shot.duration = 3;
    shot.objects = [group, child];
    shot.animations = [
      { id: "animation-child-first", type: "move", targetIds: [child.id], start: 0, duration: 1, easing: "linear", properties: { x: 200 } },
      { id: "animation-group-next", type: "move", targetIds: [group.id], start: 1, duration: 1, easing: "linear", properties: { x: 150 } },
    ];
    expect(previewShotAtTime(shot, 2).objects.find(({ id }) => id === child.id)?.transform.x).toBe(250);
    const childThenGroup = compileManim(ProjectDocumentSchema.parse(base)).python;
    const childReference = childThenGroup.match(/(pc_ref_[a-f0-9_]+) = pc_sequenced_child\.copy\(\)/)?.[1];
    expect(childReference).toBeDefined();
    expect(childThenGroup).toContain(`Transform(pc_sequenced_group, VGroup(${childReference}.copy().move_to([-3.40740735, 0.0, 0]).set_opacity(1.0))`);

    const reversed = cloneSerializable(base);
    reversed.shots[0].animations = [
      { id: "animation-group-first", type: "move", targetIds: [group.id], start: 0, duration: 1, easing: "linear", properties: { x: 150 } },
      { id: "animation-child-next", type: "move", targetIds: [child.id], start: 1, duration: 1, easing: "linear", properties: { deltaX: 100 } },
    ];
    expect(previewShotAtTime(reversed.shots[0], 2).objects.find(({ id }) => id === child.id)?.transform.x).toBe(250);
    const groupThenChild = compileManim(ProjectDocumentSchema.parse(reversed)).python;
    const reversedReference = groupThenChild.match(/(pc_ref_[a-f0-9_]+) = pc_sequenced_child\.copy\(\)/)?.[1];
    expect(groupThenChild).toContain(`Transform(pc_sequenced_child, ${reversedReference}.copy().move_to([-3.40740735, 0.0, 0])`);
  });

  test("keeps a later entrance from hiding an initially visible fade-out target", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const target = shot.objects[0];
    project.shots = [shot];
    shot.animations = [
      { id: "animation-visible-out", type: "fade-out", targetIds: [target.id], start: 1, duration: 1, easing: "linear", properties: {} },
      { id: "animation-visible-in", type: "fade-in", targetIds: [target.id], start: 3, duration: 1, easing: "linear", properties: {} },
    ];
    const python = compileManim(ProjectDocumentSchema.parse(project)).python;
    expect(python).toContain("self.add(pc_the_contrast");
    const reference = python.match(/(pc_ref_[a-f0-9_]+) = pc_the_contrast\.copy\(\)/)?.[1];
    expect(reference).toBeDefined();
    expect(python).toContain(`self.play(Transform(pc_the_contrast, ${reference}.copy().set_opacity(0.0)`);
    expect(python).toContain(`self.play(Transform(pc_the_contrast, ${reference}.copy().set_opacity(1.0)`);
  });

  test("samples an adjacent entrance from the prior fade-out target boundary", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const target = shot.objects[0];
    project.shots = [shot];
    shot.duration = 3;
    shot.objects = [target];
    shot.animations = [
      { id: "animation-boundary-out", type: "fade-out", targetIds: [target.id], start: 0, duration: 1, easing: "linear", properties: {} },
      { id: "animation-boundary-appear", type: "appear", targetIds: [target.id], start: 1, duration: 1, easing: "linear", properties: {} },
    ];

    expect(ProjectDocumentSchema.safeParse(project).success).toBe(true);
    expect(previewShotAtTime(shot, 0.999).objects[0].preview.opacity).toBeCloseTo(0.001);
    expect(previewShotAtTime(shot, 1).objects[0].preview.opacity).toBe(0);
    expect(previewShotAtTime(shot, 1.5).objects[0].preview.opacity).toBeCloseTo(0.5);
    const python = compileManim(project).python;
    const reference = python.match(/(pc_ref_[a-f0-9_]+) = pc_the_contrast\.copy\(\)/)?.[1];
    expect(python).toContain(`self.play(Transform(pc_the_contrast, ${reference}.copy().set_opacity(0.0), run_time=1.0`);
    expect(python).toContain(`self.play(Transform(pc_the_contrast, ${reference}.copy().set_opacity(1.0), run_time=1.0`);
  });

  test("keeps a faded object hidden through later spatial and emphasis tracks until re-entry", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const target: SceneObject = {
      id: "object-hidden-motion",
      type: "rectangle",
      name: "Hidden motion",
      locked: false,
      visible: true,
      transform: { x: 100, y: 270, width: 80, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    project.shots = [shot];
    shot.duration = 5;
    shot.objects = [target];
    shot.animations = [
      { id: "animation-hidden-motion-out", type: "fade-out", targetIds: [target.id], start: 0, duration: 1, easing: "linear", properties: {} },
      { id: "animation-hidden-motion-move", type: "move", targetIds: [target.id], start: 1.1, duration: 1, easing: "linear", properties: { x: 500 } },
      { id: "animation-hidden-motion-emphasis", type: "emphasise", targetIds: [target.id], start: 2.2, duration: 0.5, easing: "linear", properties: { scale: 1.1 } },
      { id: "animation-hidden-motion-in", type: "fade-in", targetIds: [target.id], start: 3, duration: 1, easing: "linear", properties: {} },
    ];

    expect(previewShotAtTime(shot, 2.1).objects[0]).toMatchObject({
      transform: expect.objectContaining({ x: 500 }),
      preview: expect.objectContaining({ opacity: 0 }),
    });
    expect(previewShotAtTime(shot, 4).objects[0]).toMatchObject({
      transform: expect.objectContaining({ x: 500 }),
      preview: expect.objectContaining({ opacity: 1 }),
    });

    const python = compileManim(ProjectDocumentSchema.parse(project)).python;
    const reference = python.match(/(pc_ref_[a-f0-9_]+) = pc_hidden_motion\.copy\(\)/)?.[1];
    expect(reference).toBeDefined();
    expect(python).toContain(`Transform(pc_hidden_motion, ${reference}.copy().set_opacity(0.0)`);
    expect(python).toContain(`${reference}.copy().move_to([0.29629629, 0.0, 0]).set_opacity(0.0)`);
    expect(python).toContain("# Animation component 3: 2.2s to 2.7s\n        self.wait(0.1)\n        self.play(Wait(0.5))");
    expect(python).toContain(`${reference}.copy().move_to([0.29629629, 0.0, 0]).set_opacity(1.0)`);
    expect(python).not.toContain("FadeOut(pc_hidden_motion");
    expect(python).not.toContain("FadeIn(pc_hidden_motion");
  });

  test("preserves descendant opacity and initial presence across child fade-out, group motion, and ancestor re-entry", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const group: SceneObject = {
      id: "group-visibility-sequence",
      type: "group",
      name: "Visibility sequence",
      locked: false,
      visible: true,
      transform: { x: 100, y: 270, width: 200, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    const fadedChild: SceneObject = {
      id: "object-faded-child",
      parentId: group.id,
      type: "rectangle",
      name: "Faded child",
      locked: false,
      visible: true,
      transform: { x: 100, y: 270, width: 50, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    const enteringSibling: SceneObject = {
      ...fadedChild,
      id: "object-entering-sibling",
      name: "Entering sibling",
      transform: { ...fadedChild.transform, x: 200 },
    };
    project.shots = [shot];
    shot.duration = 5;
    shot.objects = [group, fadedChild, enteringSibling];
    shot.animations = [
      { id: "animation-child-out-before-group", type: "fade-out", targetIds: [fadedChild.id], start: 0, duration: 1, easing: "linear", properties: {} },
      { id: "animation-group-hidden-move", type: "move", targetIds: [group.id], start: 1.1, duration: 1, easing: "linear", properties: { x: 150 } },
      { id: "animation-group-later-in", type: "fade-in", targetIds: [group.id], start: 3, duration: 1, easing: "linear", properties: {} },
    ];

    const hiddenState = previewShotAtTime(shot, 2.1);
    expect(hiddenState.objects.find(({ id }) => id === fadedChild.id)).toMatchObject({
      transform: expect.objectContaining({ x: 150 }),
      preview: expect.objectContaining({ opacity: 0 }),
    });
    expect(hiddenState.objects.find(({ id }) => id === enteringSibling.id)).toMatchObject({
      transform: expect.objectContaining({ x: 250 }),
      preview: expect.objectContaining({ opacity: 0 }),
    });

    const python = compileManim(ProjectDocumentSchema.parse(project)).python;
    const fadedReference = python.match(/(pc_ref_[a-f0-9_]+) = pc_faded_child\.copy\(\)/)?.[1];
    const siblingReference = python.match(/(pc_ref_[a-f0-9_]+) = pc_entering_sibling\.copy\(\)/)?.[1];
    expect(fadedReference).toBeDefined();
    expect(siblingReference).toBeDefined();
    expect(python).toContain(`${siblingReference} = pc_entering_sibling.copy()\n        pc_entering_sibling.set_opacity(0.0)`);
    expect(python).toContain(`self.add(pc_faded_child)`);
    expect(python).not.toContain("self.add(pc_entering_sibling");
    expect(python).toContain(`Transform(pc_visibility_sequence, VGroup(${fadedReference}.copy().move_to(`);
    expect(python).toContain(`.set_opacity(0.0), ${siblingReference}.copy().move_to(`);
    expect(python).toContain("self.play(Transform(pc_visibility_sequence, VGroup(");
    expect(python).not.toContain("FadeIn(pc_visibility_sequence");
    expect(validateWithRendererPolicy(python).status).toBe(0);
  });

  test("splits decimal-adjacent animations without emitting a phantom overlap or wait", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const target = shot.objects[0];
    project.shots = [shot];
    shot.duration = 0.5;
    shot.objects = [target];
    shot.animations = [
      { id: "animation-decimal-a", type: "move", targetIds: [target.id], start: 0.1, duration: 0.2, easing: "linear", properties: { x: 300 } },
      { id: "animation-decimal-b", type: "move", targetIds: [target.id], start: 0.3, duration: 0.2, easing: "linear", properties: { x: 400 } },
    ];

    const python = compileManim(ProjectDocumentSchema.parse(project)).python;
    expect(python).toContain("# Animation component 1: 0.1s to 0.3s");
    expect(python).toContain("# Animation component 2: 0.3s to 0.5s");
    expect(python.match(/        self\.play\(/g)).toHaveLength(2);
    expect(python).not.toContain("AnimationGroup(");
    expect(python).not.toMatch(/self\.wait\(-?0\.0\)/);
  });

  test("estimates emitted duration literals at frame boundaries and never serializes a positive runtime as zero", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const object = shot.objects[0];
    project.shots = [shot];
    shot.objects = [object];
    shot.duration = 1 / 15;
    shot.animations = [{
      id: "animation-one-frame-boundary",
      type: "move",
      targetIds: [object.id],
      start: 0,
      duration: 1 / 15,
      easing: "linear",
      properties: { deltaX: 1 },
    }];

    const parsed = ProjectDocumentSchema.parse(project);
    const boundarySource = compileManim(parsed).python;
    expect(boundarySource).toContain("run_time=0.06666667");
    expect(estimateManimTimelineDurationUpperBound(parsed, 15)).toBeCloseTo(2 / 15, 12);

    shot.duration = 1e-10;
    shot.animations[0].duration = 1e-10;
    const tiny = ProjectDocumentSchema.parse(project);
    const tinySource = compileManim(tiny).python;
    expect(tinySource).toContain("run_time=1e-8");
    expect(tinySource).not.toContain("run_time=0");
    expect(estimateManimTimelineDurationUpperBound(tiny, 15)).toBeCloseTo(1 / 15, 12);
    expect(validateWithRendererPolicy(tinySource).status).toBe(0);

    shot.animations = [];
    const tinyStatic = ProjectDocumentSchema.parse(project);
    expect(compileManim(tinyStatic).python).toContain("self.wait(1e-8)");
    expect(estimateManimTimelineDurationUpperBound(tinyStatic, 15)).toBeCloseTo(1 / 15, 12);
  });

  test("tweens appear consistently in preview and generated Manim", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const object = shot.objects[0];
    project.shots = [shot];
    shot.objects = [object];
    shot.duration = 2;
    shot.animations = [{
      id: "animation-appear-parity",
      type: "appear",
      targetIds: [object.id],
      start: 0,
      duration: 2,
      easing: "linear",
      properties: {},
    }];

    expect(previewShotAtTime(shot, 0).objects[0].preview.opacity).toBe(0);
    expect(previewShotAtTime(shot, 1).objects[0].preview.opacity).toBeCloseTo(0.5);
    expect(previewShotAtTime(shot, 2).objects[0].preview.opacity).toBe(1);
    expect(compileManim(ProjectDocumentSchema.parse(project)).python)
      .toContain("FadeIn(pc_the_contrast, run_time=2.0, rate_func=linear)");
  });

  test("fails closed with a stable diagnostic when derived group geometry exceeds renderer policy range", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const group: SceneObject = {
      id: "group-range",
      type: "group",
      name: "Range group",
      locked: false,
      visible: true,
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 0.01, scaleY: 0.01 },
      style: {},
      properties: {},
    };
    const child: SceneObject = {
      id: "object-range-child",
      parentId: group.id,
      type: "rectangle",
      name: "Range child",
      locked: false,
      visible: true,
      transform: { x: 4096, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    project.shots = [shot];
    shot.duration = 2;
    shot.objects = [group, child];
    shot.animations = [
      { id: "animation-range", type: "transform", targetIds: [group.id], start: 0, duration: 1, easing: "linear", properties: { width: 4096, height: 4096, scaleX: 100, scaleY: 100 } },
    ];
    expect(ProjectDocumentSchema.safeParse(project).success).toBe(true);
    expect(previewShotAtTime(shot, 1).objects.find(({ id }) => id === child.id)!.transform.x).toBeGreaterThan(1_000_000_000);
    const result = compileManim(project);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "DERIVED_NUMERIC_RANGE_EXCEEDED", objectId: child.id, animationId: "animation-range" }),
    ]));
    expect(validateWithRendererPolicy(result.python).status).toBe(0);
  });

  test("shares deterministic active-style transforms between preview semantics and compiled targets", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const editorial = project.styles.find(({ id }) => id === EDITORIAL_INK_STYLE_ID)!;
    const raw = project.styles.find(({ id }) => id === RAW_MANIM_STYLE_ID)!;
    const title: SceneObject = {
      id: "object-style-title",
      type: "text",
      name: "Style title",
      semanticRole: "title",
      locked: false,
      visible: true,
      transform: { x: 100, y: 50, width: 200, height: 40, rotation: 12, scaleX: 1, scaleY: 1 },
      style: {},
      properties: { content: "Style title" },
    };
    const annotation: SceneObject = {
      ...title,
      id: "object-style-note",
      name: "Style note",
      semanticRole: "annotation",
      transform: { ...title.transform, x: 700, y: 270 },
      properties: { content: "Style note" },
    };

    expect(styledTransform(title, editorial)).toEqual({ ...title.transform, x: 128, y: 55.6, scaleX: 1.28, scaleY: 1.28 });
    expect(styledTransform(annotation, editorial)).toEqual({ ...annotation.transform, x: 714, rotation: 10.72 });
    expect(styledTransform(annotation, raw)).toEqual({ ...annotation.transform, x: 660.4 });

    const shot = project.shots[1];
    project.activeStyleId = RAW_MANIM_STYLE_ID;
    project.shots = [shot];
    shot.duration = 2;
    shot.objects = [annotation];
    shot.animations = [
      { id: "animation-centred-note-move", type: "move", targetIds: [annotation.id], start: 0, duration: 1, easing: "linear", properties: { x: 800 } },
    ];
    const python = compileManim(ProjectDocumentSchema.parse(project)).python;
    expect(python).toContain("pc_style_note.move_to([2.67259255, 0.0, 0])");
    expect(python).toContain("pc_style_note.rotate(12.0 * DEGREES)");
    expect(python).toMatch(/Transform\(pc_style_note, pc_ref_[a-f0-9_]+\.copy\(\)\.move_to\(\[3\.88740735, 0\.0, 0\]\)\.set_opacity\(1\.0\), run_time=1\.0, rate_func=linear\)/);
  });

  test("bounds generated identifiers and disambiguates truncated and normalized name collisions", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const longPrefix = "A".repeat(114);
    const longAlphaName = `${longPrefix} alpha`;
    const longBetaName = `${longPrefix} beta!`;
    const rectangle = (id: string, name: string, x: number): SceneObject => ({
      id,
      type: "rectangle",
      name,
      locked: false,
      visible: true,
      transform: { x, y: 270, width: 80, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    });
    project.shots = [shot];
    shot.duration = 1;
    shot.objects = [
      rectangle("object-long-alpha", longAlphaName, 200),
      rectangle("object-long-beta", longBetaName, 360),
      rectangle("object-normalized-one", "Same name", 520),
      rectangle("object-normalized-two", "Same-name", 680),
    ];
    shot.animations = [];

    const python = compileManim(ProjectDocumentSchema.parse(project)).python;
    const identifiers = [...python.matchAll(/^ {8}(pc_[a-zA-Z0-9_]+) = /gm)].map((match) => match[1]);
    const hashedIdentifiers = identifiers.filter((identifier) => /_[0-9a-f]{8}$/.test(identifier));

    expect(longAlphaName).toHaveLength(120);
    expect(longBetaName).toHaveLength(120);
    expect(identifiers).toHaveLength(4);
    expect(new Set(identifiers).size).toBe(4);
    expect(identifiers.every((identifier) => identifier.length <= 80)).toBe(true);
    expect(hashedIdentifiers).toHaveLength(2);
    expect(hashedIdentifiers.every((identifier) => identifier.length === 72)).toBe(true);
    expect(identifiers).toEqual(expect.arrayContaining(["pc_same_name", "pc_same_name_2"]));
    const policy = validateWithRendererPolicy(python);
    expect(policy.stderr).toBe("");
    expect(policy.status).toBe(0);
  });

  test("keeps hidden objects and descendants out of Manim while preserving hidden animation timing", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const group: SceneObject = {
      id: "group-visible",
      type: "group",
      name: "Visible group",
      locked: false,
      visible: true,
      transform: { x: 480, y: 270, width: 300, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    const visibleChild: SceneObject = {
      id: "object-visible-child",
      parentId: group.id,
      type: "rectangle",
      name: "Visible child",
      locked: false,
      visible: true,
      transform: { x: 420, y: 270, width: 80, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
      style: {},
      properties: {},
    };
    const hiddenChild: SceneObject = {
      ...visibleChild,
      id: "object-hidden-child",
      name: "Hidden child",
      visible: false,
      transform: { ...visibleChild.transform, x: 540 },
    };
    const hiddenTop: SceneObject = {
      ...visibleChild,
      id: "object-hidden-top",
      name: "Hidden top",
      visible: false,
      parentId: undefined,
      transform: { ...visibleChild.transform, x: 700 },
    };
    const hiddenNestedGroup: SceneObject = {
      ...group,
      id: "group-hidden-nested",
      name: "Hidden nested group",
      visible: false,
      parentId: group.id,
      transform: { ...group.transform, x: 600 },
    };
    const inheritedHiddenChild: SceneObject = {
      ...visibleChild,
      id: "object-inherited-hidden-child",
      name: "Inherited hidden child",
      parentId: hiddenNestedGroup.id,
      transform: { ...visibleChild.transform, x: 600 },
    };
    project.shots = [shot];
    shot.duration = 3;
    shot.objects = [group, visibleChild, hiddenChild, hiddenTop, hiddenNestedGroup, inheritedHiddenChild];
    shot.animations = [
      { id: "animation-hidden-entrance", type: "fade-in", targetIds: [hiddenTop.id, hiddenChild.id, inheritedHiddenChild.id], start: 0, duration: 1, easing: "linear", properties: {} },
      { id: "animation-visible-group", type: "fade-in", targetIds: [group.id], start: 1, duration: 1, easing: "linear", properties: {} },
    ];

    const result = compileManim(ProjectDocumentSchema.parse(project));

    expect(result.python).toContain("pc_visible_group = VGroup(pc_visible_child)");
    expect(result.python).not.toContain("pc_hidden_child");
    expect(result.python).not.toContain("pc_hidden_top");
    expect(result.python).not.toContain("pc_hidden_nested_group");
    expect(result.python).not.toContain("pc_inherited_hidden_child");
    expect(result.python).toContain("self.play(Wait(1.0))");
    expect(result.python).toContain("self.play(FadeIn(pc_visible_group, run_time=1.0, rate_func=linear))");
    expect(result.python).toContain("self.wait(1.0)");
    expect(result.diagnostics.filter(({ code }) => code === "ANIMATION_TARGET_HIDDEN").map(({ objectId }) => objectId)).toEqual([
      hiddenTop.id,
      hiddenChild.id,
      inheritedHiddenChild.id,
    ]);
  });

  test("maps every supported object class and compiles restricted graph AST without evaluation", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const objects: SceneObject[] = [
      { id: "object-circle", type: "circle", name: "Circle mark", locked: false, visible: true, transform: { x: 100, y: 500, width: 80, height: 40, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} },
      { id: "object-default-rectangle", type: "rectangle", name: "Default rectangle", locked: false, visible: true, transform: { x: 125, y: 450, width: 80, height: 40, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} },
      { id: "object-line", type: "line", name: "Fine line", locked: false, visible: true, transform: { x: 160, y: 500, width: 60, height: 2, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} },
      { id: "object-arrow", type: "arrow", name: "Arrow mark", locked: false, visible: true, transform: { x: 240, y: 500, width: 60, height: 12, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} },
      { id: "object-brace", type: "brace", name: "Brace mark", locked: false, visible: true, transform: { x: 330, y: 500, width: 100, height: 25, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: { label: "n pieces" } },
      { id: "object-axes", type: "axes", name: "Coordinate axes", locked: false, visible: true, transform: { x: 500, y: 480, width: 160, height: 100, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: { xMin: -2, xMax: 2, yMin: -1, yMax: 4 } },
      { id: "object-graph", type: "graph", name: "Safe parabola", locked: false, visible: true, transform: { x: 500, y: 480, width: 160, height: 100, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: { expression: { kind: "power", base: { kind: "variable" }, exponent: 2 }, xMin: -2, xMax: 2 } },
      { id: "object-svg", type: "svg", name: "Local SVG", locked: false, visible: true, transform: { x: 700, y: 500, width: 70, height: 50, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: { source: "/proofcanvas/assets/example.svg" } },
      { id: "object-image", type: "image", name: "Inline image", locked: false, visible: true, transform: { x: 800, y: 500, width: 70, height: 50, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: { source: "data:image/png;base64,AAAA" } },
    ];
    shot.objects.push(...objects);
    const valid = ProjectDocumentSchema.parse(project);
    const result = compileManim(valid);
    expect(result.python).toContain("Circle(radius=1.0).stretch_to_fit_width(1.18518517).stretch_to_fit_height(0.59259258)");
    expect(result.python).toContain("pc_circle_mark = Circle(radius=1.0).stretch_to_fit_width(1.18518517).stretch_to_fit_height(0.59259258).set_color(\"#252722\").set_fill(\"#f3eedf\", opacity=1.0)");
    expect(result.python).toContain("pc_default_rectangle = Rectangle(width=1.18518517, height=0.59259258).set_color(\"#252722\").set_fill(\"#252722\", opacity=1.0)");
    expect(result.python).toContain("Line([");
    expect(result.python).toContain("Arrow([");
    expect(result.python).toContain("BraceBetweenPoints");
    expect(result.python).toContain("Text(\"n pieces\", font_size=22.0)");
    expect(result.python).toContain("Axes(x_range=");
    expect(result.python).toContain("FunctionGraph(lambda x: (x ** 2)");
    expect(result.python).toContain("SVGMobject(\"public/proofcanvas/assets/example.svg\")");
    expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining(["ASSET_PATH_REQUIRED", "INLINE_ASSET_BROWSER_ONLY"]));
  });

  test("preserves world-space groups, safe identifiers, transforms, opacity, camera resets, and diagnostics", () => {
    const project = cloneSerializable(createCantorDemoProject());
    const shot = project.shots[1];
    const group: SceneObject = { id: "group-mixed", type: "group", name: "self", locked: false, visible: true, transform: { x: 700, y: 400, width: 220, height: 120, rotation: 25, scaleX: 2, scaleY: 2 }, style: {}, properties: {} };
    const image: SceneObject = { id: "object-mixed-image", type: "image", name: "math", parentId: group.id, locked: false, visible: true, transform: { x: 660, y: 400, width: 80, height: 60, rotation: 15, scaleX: 1.2, scaleY: 0.8 }, style: { opacity: 0.45 }, properties: { source: "/proofcanvas/assets/example.png" } };
    const circle: SceneObject = { id: "object-mixed-circle", type: "circle", name: "class", parentId: group.id, locked: false, visible: true, transform: { x: 750, y: 400, width: 50, height: 40, rotation: 0, scaleX: 1, scaleY: 1 }, style: {}, properties: {} };
    shot.objects.push(group, image, circle);
    shot.animations.push({ id: "animation-mixed-create", type: "create", targetIds: [group.id], start: 0.2, duration: 0.5, easing: "linear", properties: {} });
    shot.animations.push({ id: "animation-transform-full", type: "transform", targetIds: [circle.id], start: 5.5, duration: 0.5, easing: "linear", properties: { x: 720, y: 380, width: 70, height: 45, rotation: 30, scaleX: 1.3, scaleY: 0.7 } });
    project.shots[1].camera = { x: 500, y: 280, zoom: 1.25, rotation: 7 };
    const result = compileManim(ProjectDocumentSchema.parse(project));
    expect(result.python).toContain("pc_self = Group(pc_math, pc_class)");
    expect(result.python).not.toContain("pc_self.move_to(");
    expect(result.python).toContain("pc_math.rotate(15.0 * DEGREES)");
    expect(result.python).toContain(".set_opacity(0.45)");
    expect(result.python).toContain("pc_math.stretch(1.2, 0).stretch(0.8, 1)");
    expect(result.python).toContain("stretch_to_fit_width(");
    expect(result.python).toContain("stretch_to_fit_height(");
    expect(result.python).toContain(".rotate(30.0 * DEGREES).move_to(");
    expect(result.python.match(/self\.camera\.frame\.become/g)).toHaveLength(2);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining(["GROUP_ANIMATION_FALLBACK"]));
    const parsed = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: result.python, encoding: "utf8" });
    expect(parsed.status).toBe(0);
  });

  test("rejects invalid animation properties before the preview-backed compiler seam", () => {
    const project = cloneSerializable(createCantorDemoProject());
    project.shots[0].animations.find(({ id }) => id === "animation-camera-focus")!.properties.zoom = 0;

    expect(() => compileManim(project)).toThrow();
  });
});
