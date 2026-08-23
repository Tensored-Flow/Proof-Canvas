import { allocateId, collectProjectIds } from "./ids";
import { describeOperations, effectiveLockOwner, validateOperations } from "./operations";
import {
  ProjectDocumentSchema,
  SceneOperationSchema,
  type ProjectDocument,
  type SceneAnimation,
  type SceneObject,
  type SceneOperation,
} from "./schema";
import { EDITORIAL_INK_STYLE_ID } from "./styles";

export const REQUIRED_AI_COMMANDS = Object.freeze([
  "Move the title into the upper-left margin, but do not move the interval diagram.",
  "Make the second removal the main moment of emphasis and slow that animation down.",
  "Add a brace beneath the surviving intervals labelled ‘2^n pieces’ and reveal it after the third split.",
  "Make the composition less centred and more editorial without changing the mathematical content.",
  "Keep the equation locked and make everything else quieter.",
] as const);

export interface AiCommandRequest {
  project: ProjectDocument;
  shotId: string;
  selectedObjectIds: readonly string[];
  instruction: string;
}

export interface AiProposal {
  provider: "deterministic-demo" | "configured-provider";
  demoMode: boolean;
  intention: string;
  summary: string[];
  operations: SceneOperation[];
}

export interface SceneAiProvider {
  readonly id: string;
  readonly demoMode: boolean;
  propose(request: AiCommandRequest): Promise<AiProposal>;
}

export class UnsupportedDemoCommandError extends Error {
  constructor(instruction: string) {
    super(`The deterministic demo interpreter does not support: “${instruction}”`);
    this.name = "UnsupportedDemoCommandError";
  }
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9^' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function byRole(objects: readonly SceneObject[], role: string): SceneObject | undefined {
  return objects.find((object) => object.semanticRole === role);
}

function byName(objects: readonly SceneObject[], name: RegExp): SceneObject | undefined {
  return objects.find((object) => name.test(object.name));
}

function animationByName(animations: readonly SceneAnimation[], name: RegExp): SceneAnimation | undefined {
  return animations.find((animation) => name.test(animation.id));
}

function proposal(
  project: ProjectDocument,
  shotId: string,
  intention: string,
  operations: SceneOperation[],
): AiProposal {
  if (operations.some(({ type }) => type === "unlock-object")) {
    throw new Error("AI proposals may not unlock objects; unlock explicitly before requesting an edit");
  }
  const parsed = operations.map((operation) => SceneOperationSchema.parse(operation));
  const validation = validateOperations(project, shotId, parsed);
  if (!validation.valid) throw validation.error;
  return {
    provider: "deterministic-demo",
    demoMode: true,
    intention,
    summary: describeOperations(parsed),
    operations: parsed,
  };
}

function selectedObjects(project: ProjectDocument, shotId: string, selectedIds: readonly string[]): SceneObject[] {
  const shot = project.shots.find(({ id }) => id === shotId);
  if (!shot) throw new Error(`Shot not found: ${shotId}`);
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error("Selection contains duplicate IDs");
  return selectedIds.map((id) => {
    const object = shot.objects.find((candidate) => candidate.id === id);
    if (!object) throw new Error(`Selected object not found: ${id}`);
    return object;
  });
}

export function interpretDemoCommand(request: AiCommandRequest): AiProposal {
  const project = ProjectDocumentSchema.parse(request.project);
  const shot = project.shots.find(({ id }) => id === request.shotId);
  if (!shot) throw new Error(`Shot not found: ${request.shotId}`);
  const selected = selectedObjects(project, request.shotId, request.selectedObjectIds);
  const instruction = normalized(request.instruction);
  const ids = collectProjectIds(project);

  if (instruction.includes("title") && instruction.includes("upper-left") && instruction.includes("interval diagram")) {
    const title = byRole(shot.objects, "title") ?? byName(shot.objects, /title/i);
    if (!title) throw new Error("The current shot has no title");
    return proposal(project, shot.id, "Move only the title to the upper-left editorial margin.", [
      { type: "update-object", objectId: title.id, patch: { transform: { x: 250, y: 70 }, style: { textAlign: "left" } } },
    ]);
  }

  if (instruction.includes("second removal") && instruction.includes("emphasis") && instruction.includes("slow")) {
    const removal = byRole(shot.objects, "second-removal") ?? byName(shot.objects, /second removal/i);
    const removalAnimation = animationByName(shot.animations, /second-removal/i);
    if (!removal || !removalAnimation) throw new Error("The current shot has no second-removal moment");
    const emphasisId = allocateId("animation", ids, "second-removal-emphasis");
    const slowerDuration = Math.min(Math.max(removalAnimation.duration * 1.8, 1.8), shot.duration - removalAnimation.start);
    const emphasisDuration = Math.min(1.2, Math.max(0.4, removalAnimation.start));
    const emphasisStart = Math.max(0, removalAnimation.start - emphasisDuration - 0.15);
    return proposal(project, shot.id, "Slow the second removal and make it the focal beat.", [
      { type: "update-animation", animationId: removalAnimation.id, patch: { duration: slowerDuration, easing: "ease-in-out" } },
      { type: "add-animation", animation: { id: emphasisId, type: "emphasise", targetIds: [removal.id], start: emphasisStart, duration: emphasisDuration, easing: "editorial", properties: { scale: 1.16 } } },
    ]);
  }

  if (instruction.includes("brace") && instruction.includes("2^n pieces") && instruction.includes("third split")) {
    const diagram = byRole(shot.objects, "interval-diagram") ?? byName(shot.objects, /interval diagram/i);
    const split = animationByName(shot.animations, /third-split/i);
    if (!diagram || !split) throw new Error("The current shot has no interval diagram and third split");
    const braceId = allocateId("object", ids, "surviving-intervals-brace");
    ids.add(braceId);
    const animationId = allocateId("animation", ids, "brace-reveal");
    const afterSplit = animationByName(shot.animations, /third-removals/i) ?? split;
    const revealStart = Math.min(afterSplit.start + afterSplit.duration + 0.15, shot.duration - 0.8);
    return proposal(project, shot.id, "Add an editable brace after the third split.", [
      {
        type: "add-object",
        object: {
          id: braceId,
          type: "brace",
          name: "Surviving intervals brace",
          parentId: diagram.id,
          locked: false,
          visible: true,
          transform: { x: 480, y: 355, width: 570, height: 34, rotation: 0, scaleX: 1, scaleY: 1 },
          style: { stroke: "#71402d", fontSize: 20 },
          semanticRole: "surviving-intervals-brace",
          properties: { label: "2^n pieces", orientation: "below" },
        },
      },
      { type: "add-animation", animation: { id: animationId, type: "fade-in", targetIds: [braceId], start: revealStart, duration: 0.8, easing: "editorial", properties: {} } },
    ]);
  }

  if (instruction.includes("less centred") && instruction.includes("more editorial") && instruction.includes("mathematical content")) {
    const movable = shot.objects.filter((object) => !effectiveLockOwner(shot, object) && !object.parentId && object.type !== "group");
    const operations: SceneOperation[] = [{ type: "set-style", styleId: EDITORIAL_INK_STYLE_ID }];
    movable.forEach((object, index) => {
      const direction = index % 2 === 0 ? -1 : 1;
      operations.push({ type: "update-object", objectId: object.id, patch: { transform: { x: Math.max(70, Math.min(890, object.transform.x + direction * (32 + index * 7))) }, style: { textAlign: "left" } } });
    });
    const title = byRole(shot.objects, "title");
    if (title && !effectiveLockOwner(shot, title) && !operations.some((operation) => operation.type === "update-object" && operation.objectId === title.id)) {
      operations.push({ type: "update-object", objectId: title.id, patch: { transform: { x: 250, y: 70 }, style: { textAlign: "left" } } });
    }
    return proposal(project, shot.id, "Apply Editorial Ink and introduce quiet asymmetry without changing object content.", operations);
  }

  if (instruction.includes("equation locked") && instruction.includes("everything else quieter")) {
    const equation = byRole(shot.objects, "equation-chain") ?? byName(shot.objects, /equation/i);
    if (!equation) throw new Error("The current shot has no equation group");
    const equationFamily = new Set([equation.id, ...shot.objects.filter(({ parentId }) => parentId === equation.id).map(({ id }) => id)]);
    const operations: SceneOperation[] = [];
    if (!equation.locked) operations.push({ type: "lock-object", objectId: equation.id });
    for (const object of shot.objects) {
      if (equationFamily.has(object.id) || effectiveLockOwner(shot, object)) continue;
      const currentOpacity = object.style.opacity ?? 1;
      operations.push({ type: "update-object", objectId: object.id, patch: { style: { opacity: Math.min(currentOpacity, object.semanticRole === "title" ? 0.82 : 0.62) } } });
    }
    if (!operations.length) throw new Error("There are no unlocked non-equation objects to quiet");
    return proposal(project, shot.id, "Preserve the locked equation while lowering the visual weight of every unlocked supporting object.", operations);
  }

  if (selected.length) {
    if (instruction.includes("unlock")) throw new Error("AI proposals may not unlock objects; unlock explicitly before requesting an edit");
    const unlocked = selected.filter((object) => !effectiveLockOwner(shot, object));
    if (!unlocked.length) throw new Error("Every selected object is locked");
    if (/\b(move|nudge)\b/.test(instruction)) {
      const dx = instruction.includes("left") ? -40 : instruction.includes("right") ? 40 : 0;
      const dy = instruction.includes("up") ? -40 : instruction.includes("down") ? 40 : 0;
      if (!dx && !dy) throw new UnsupportedDemoCommandError(request.instruction);
      return proposal(project, shot.id, "Move the current unlocked selection.", unlocked.map((object) => ({ type: "update-object", objectId: object.id, patch: { transform: { x: object.transform.x + dx, y: object.transform.y + dy } } })));
    }
    if (instruction.includes("quieter")) {
      return proposal(project, shot.id, "Lower the visual weight of the current unlocked selection.", unlocked.map((object) => ({ type: "update-object", objectId: object.id, patch: { style: { opacity: Math.min(object.style.opacity ?? 1, 0.55) } } })));
    }
    if (/\bdelete\b/.test(instruction)) {
      return proposal(project, shot.id, "Delete the current unlocked selection.", unlocked.map((object) => ({ type: "delete-object", objectId: object.id })));
    }
    if (/\block\b/.test(instruction) && !instruction.includes("unlock")) {
      return proposal(project, shot.id, "Lock the current selection.", unlocked.map((object) => ({ type: "lock-object", objectId: object.id })));
    }
  }

  throw new UnsupportedDemoCommandError(request.instruction);
}

export const DETERMINISTIC_DEMO_PROVIDER: SceneAiProvider = {
  id: "deterministic-demo",
  demoMode: true,
  async propose(request) {
    return interpretDemoCommand(request);
  },
};
