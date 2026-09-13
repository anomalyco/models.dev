import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  buildFireworksModel,
  FireworksResponse,
  fireworksAi,
  type FireworksModel,
} from "../src/sync/providers/fireworks-ai.js";

test("parses the Fireworks OpenAI-compatible model list", () => {
  const parsed = FireworksResponse.parse({
    object: "list",
    data: [fireworksModel()],
  });

  expect(parsed.data[0]).toMatchObject({
    id: "accounts/fireworks/models/example",
    context_length: 1_048_576,
    supports_tools: true,
  });
});

test("adds positive Fireworks capabilities while preserving authored facts", () => {
  const model = buildFireworksModel(
    fireworksModel({ supports_image_input: true, supports_tools: false }),
    existingModel(),
  );

  expect(model).toMatchObject({
    attachment: true,
    tool_call: true,
    cost: { input: 1, output: 2 },
    limit: { context: 1_048_573, output: 262_144 },
    modalities: { input: ["text", "image"], output: ["text"] },
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  });
});

test("does not remove image support from a false-negative Fireworks flag", () => {
  const model = buildFireworksModel(
    fireworksModel({ supports_image_input: false }),
    {
      ...existingModel(),
      attachment: true,
      modalities: { input: ["text", "image", "video"], output: ["text"] },
    },
  );

  expect(model.modalities?.input).toEqual(["text", "image", "video"]);
  expect(model.attachment).toBe(true);
});

test("uses Fireworks context length only as an upper bound", () => {
  const model = buildFireworksModel(
    fireworksModel({ context_length: 131_072 }),
    existingModel(),
  );

  expect(model.limit?.context).toBe(131_072);
  expect(model.limit?.output).toBe(131_072);
});

test("does not report Fireworks embedding rows as missing generation models", () => {
  const embedding = fireworksModel({ kind: "EMBEDDING_MODEL" });

  expect(fireworksAi.sourceID(embedding)).toBeUndefined();
  expect(fireworksAi.translateModel(embedding, {
    existing: () => existingModel(),
    authored: () => existingModel(),
  })).toBeUndefined();
});

function fireworksModel(overrides: Partial<FireworksModel> = {}): FireworksModel {
  return {
    id: "accounts/fireworks/models/example",
    object: "model",
    created: 1_788_566_400,
    owned_by: "fireworks",
    context_length: 1_048_576,
    kind: "HF_BASE_MODEL",
    supports_chat: true,
    supports_image_input: false,
    supports_tools: true,
    ...overrides,
  };
}

function existingModel(): ExistingModel {
  return {
    name: "Example",
    description: "Example reasoning model",
    release_date: "2026-09-01",
    last_updated: "2026-09-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    temperature: true,
    tool_call: true,
    structured_output: true,
    open_weights: true,
    cost: { input: 1, output: 2 },
    limit: { context: 1_048_573, output: 262_144 },
    modalities: { input: ["text"], output: ["text"] },
  };
}
