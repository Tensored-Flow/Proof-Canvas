jest.mock("server-only", () => ({}), { virtual: true });

import type OpenAI from "openai";
import { createCantorDemoProject } from "../demo";
import {
  ProofCanvasProviderOutputError,
  proofCanvasOpenAiConfiguration,
  proposeWithOpenAi,
} from "../openaiProvider";

const SHOT = "shot-cantor-construction";
const CONFIGURATION = { apiKey: "server-secret", model: "configured-proofcanvas-model" };

function request(project = createCantorDemoProject()) {
  return {
    project,
    shotId: SHOT,
    selectedObjectIds: ["object-title"],
    instruction: "Move the selected title left.",
  };
}

function clientReturning(output_parsed: unknown) {
  const parse = jest.fn().mockResolvedValue({ output_parsed });
  return {
    parse,
    client: { responses: { parse } } as unknown as Pick<OpenAI, "responses">,
  };
}

test("configuration requires both a server key and an environment-selected model", () => {
  expect(proofCanvasOpenAiConfiguration({ OPENAI_API_KEY: "key" })).toBeNull();
  expect(proofCanvasOpenAiConfiguration({ PROOFCANVAS_OPENAI_MODEL: "model" })).toBeNull();
  expect(proofCanvasOpenAiConfiguration({
    OPENAI_API_KEY: " key ",
    PROOFCANVAS_OPENAI_MODEL: " model-from-env ",
  })).toEqual({ apiKey: "key", model: "model-from-env" });
});

test("uses Responses structured parsing and returns locally validated operations", async () => {
  const { client, parse } = clientReturning({
    intention: "Move the selected title into the margin.",
    summary: ["This model-authored summary is not trusted."],
    operations: [{
      type: "update-object",
      objectId: "object-title",
      patch: [
        { field: "transform.x", value: 180 },
        { field: "style.opacity", value: 0.8 },
      ],
    }],
  });

  const proposal = await proposeWithOpenAi(request(), CONFIGURATION, client);

  expect(proposal).toMatchObject({
    provider: "configured-provider",
    demoMode: false,
    intention: "Move the selected title into the margin.",
    operations: [{
      type: "update-object",
      objectId: "object-title",
      patch: { transform: { x: 180 }, style: { opacity: 0.8 } },
    }],
  });
  expect(proposal.summary).toEqual(["Update object-title: transform, style"]);
  expect(parse).toHaveBeenCalledTimes(1);
  const call = parse.mock.calls[0][0];
  expect(call.model).toBe("configured-proofcanvas-model");
  expect(call.store).toBe(false);
  expect(call.max_output_tokens).toBe(6_000);
  expect(call.text.format.type).toBe("json_schema");
  const serializedInput = JSON.stringify(call.input);
  expect(serializedInput).toContain("shot-cantor-construction");
  expect(serializedInput).toContain("object-title");
  expect(serializedInput).not.toContain(CONFIGURATION.apiKey);
  expect(serializedInput).not.toContain("shot-cantor-conclusion");
});

test("rejects inherited-lock mutations even when the child itself is unlocked", async () => {
  const project = createCantorDemoProject();
  project.shots[0].objects.find(({ id }) => id === "object-interval-diagram")!.locked = true;
  const { client } = clientReturning({
    intention: "Move a child of the locked diagram.",
    summary: ["Move the child."],
    operations: [{
      type: "update-object",
      objectId: "object-interval-left-1",
      patch: [{ field: "transform.x", value: 330 }],
    }],
  });

  await expect(proposeWithOpenAi({
    project,
    shotId: SHOT,
    selectedObjectIds: ["object-interval-left-1"],
    instruction: "Move this right.",
  }, CONFIGURATION, client)).rejects.toThrow(/locked object/);
});

test("rejects provider-authored malformed LaTeX through the shared operation authority", async () => {
  const project = createCantorDemoProject();
  project.shots[0].objects.find(({ id }) => id === "object-equation-chain")!.locked = false;
  project.shots[0].objects.find(({ id }) => id === "object-equation-length")!.locked = false;
  const { client } = clientReturning({
    intention: "Replace the selected equation.",
    summary: ["Replace the equation."],
    operations: [{
      type: "update-object",
      objectId: "object-equation-length",
      patch: [{ field: "property", key: "content", value: { kind: "string", value: "\\frac{1" } }],
    }],
  });

  await expect(proposeWithOpenAi({
    project,
    shotId: SHOT,
    selectedObjectIds: ["object-equation-length"],
    instruction: "Replace this equation.",
  }, CONFIGURATION, client)).rejects.toThrow(/character 6/);
});

test.each([0.99, 257])("rejects provider-authored font size %s outside the shared authoring bounds", async (fontSize) => {
  const project = createCantorDemoProject();
  project.shots[0].objects.find(({ id }) => id === "object-equation-chain")!.locked = false;
  project.shots[0].objects.find(({ id }) => id === "object-equation-length")!.locked = false;
  const { client } = clientReturning({
    intention: "Resize the selected equation.",
    summary: ["Resize the equation."],
    operations: [{
      type: "update-object",
      objectId: "object-equation-length",
      patch: [{ field: "style.fontSize", value: fontSize }],
    }],
  });

  await expect(proposeWithOpenAi({
    project,
    shotId: SHOT,
    selectedObjectIds: ["object-equation-length"],
    instruction: "Resize this equation.",
  }, CONFIGURATION, client)).rejects.toThrow(/no valid structured operation proposal/);
});

test("rejects every provider-authored unlock operation", async () => {
  const { client } = clientReturning({
    intention: "Unlock the equation.",
    summary: ["Unlock the equation."],
    operations: [{ type: "unlock-object", objectId: "object-equation-chain" }],
  });

  await expect(proposeWithOpenAi(request(), CONFIGURATION, client)).rejects.toThrow(
    new ProofCanvasProviderOutputError("AI proposals may not unlock objects"),
  );
});

test("fails closed when parsed provider output does not match the strict schema", async () => {
  const { client } = clientReturning({
    intention: "Narrate a change without an operation.",
    summary: ["No operation."],
    operations: [],
  });
  await expect(proposeWithOpenAi(request(), CONFIGURATION, client)).rejects.toThrow(
    /no valid structured operation proposal/,
  );
});

test.each([
  { operations: [{
    type: "add-animation",
    animation: {
      id: "animation-provider-duplicate-target",
      type: "move",
      targetIds: ["object-title", "object-title"],
      start: 1,
      duration: 1,
      easing: "linear",
      properties: [
        { key: "deltaX", value: { kind: "number", value: 10 } },
      ],
    },
  }] },
  { operations: [{
    type: "update-animation",
    animationId: "animation-title-write",
    patch: [{ field: "targetIds", value: ["object-title", "object-title"] }],
  }] },
])("rejects provider-authored duplicate animation targets through shared operation validation", async ({ operations }) => {
  const { client } = clientReturning({
    intention: "Repeat the same animation target.",
    summary: ["Repeat the target."],
    operations,
  });

  await expect(proposeWithOpenAi(request(), CONFIGURATION, client)).rejects.toThrow(
    /Duplicate animation target object-title; first targeted at index 0/,
  );
});

test.each([
  { type: "emphasise", easing: "editorial", properties: [{ key: "scale", value: { kind: "number", value: 1.1 } }] },
  { type: "write", easing: "there-and-back", properties: [] },
] as const)("rejects newly provider-authored unsupported $type easing combinations", async ({ type, easing, properties }) => {
  const { client } = clientReturning({
    intention: "Add an unsupported animation.",
    summary: ["Unsupported animation."],
    operations: [{
      type: "add-animation",
      animation: {
        id: `animation-provider-${type}`,
        type,
        targetIds: ["object-title"],
        start: 1,
        duration: 1,
        easing,
        properties,
      },
    }],
  });
  await expect(proposeWithOpenAi(request(), CONFIGURATION, client)).rejects.toThrow(/no valid structured operation proposal/);
});

test("rejects a configured-provider patch that would turn a supported animation into a legacy-only combination", async () => {
  const { client } = clientReturning({
    intention: "Make the title write return.",
    summary: ["Change easing."],
    operations: [{
      type: "update-animation",
      animationId: "animation-title-write",
      patch: [{ field: "easing", value: "there-and-back" }],
    }],
  });
  await expect(proposeWithOpenAi(request(), CONFIGURATION, client)).rejects.toThrow(/there-and-back|not valid/);
});
