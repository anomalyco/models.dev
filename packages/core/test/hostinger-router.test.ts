import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  hostingerRouter,
  type HostingerModel,
} from "../src/sync/providers/hostinger-router.js";

function context(entries: Record<string, ExistingModel> = {}) {
  return { existing: (id: string) => entries[id], authored: (id: string) => entries[id] };
}

function hostingerModel(overrides: Partial<HostingerModel> = {}): HostingerModel {
  return {
    id: "gpt-4.1",
    created: 1_744_704_000,
    name: "GPT-4.1",
    context_length: 1_047_576,
    max_output_tokens: 32_768,
    pricing: { prompt: "0.0002", completion: "0.0008", input_cache_read: "0.00005" },
    supported_parameters: ["tools", "structured_outputs", "temperature"],
    supported_endpoints: ["/v1/chat/completions"],
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    ...overrides,
  };
}

test("creates a non-reasoning lab-resolvable model as a factored base_model overlay", () => {
  const translated = hostingerRouter.translateModel(hostingerModel(), context());

  expect(translated?.id).toBe("gpt-4.1");
  expect(translated?.model).toEqual({
    base_model: "openai/gpt-4.1",
    attachment: false,
    structured_output: true,
    cost: { input: 2, output: 8, cache_read: 0.5 },
  });
});

test("reports a create with no lab base as missing rather than inventing a file", () => {
  const model = hostingerModel({ id: "hostinger-unique-9000" });

  expect(hostingerRouter.translateModel(model, context())).toBeUndefined();
  expect(hostingerRouter.missingModelID(model)).toBe("hostinger-unique-9000");
  expect(hostingerRouter.sourceID(model)).toBe("hostinger-unique-9000");
});

test("throws when the catalog lists reasoning parameters but no authored controls exist", () => {
  const model = hostingerModel({ id: "gpt-5", supported_parameters: ["reasoning"] });

  expect(() => hostingerRouter.translateModel(model, context()))
    .toThrow(MissingReasoningOptionsError);
  expect(() => hostingerRouter.translateModel(model, context()))
    .toThrow(/gpt-5: catalog lists reasoning parameters/);
});

test("throws when the lab base is reasoning-capable but the catalog row is silent", () => {
  const model = hostingerModel({ id: "claude-opus-4.8" });

  expect(() => hostingerRouter.translateModel(model, context()))
    .toThrow(/claude-opus-4\.8: lab model is reasoning-capable but the catalog row lists no reasoning parameters/);
});

test("skips the default-hostinger moving alias silently", () => {
  const model = hostingerModel({ id: "default-hostinger" });

  expect(hostingerRouter.translateModel(model, context())).toBeUndefined();
  expect(hostingerRouter.sourceID(model)).toBeUndefined();
  expect(hostingerRouter.missingModelID(model)).toBeUndefined();
});

test("skips a region-pinned duplicate silently", () => {
  const model = hostingerModel({ id: "gpt-4.1-eu" });

  expect(hostingerRouter.translateModel(model, context())).toBeUndefined();
  expect(hostingerRouter.sourceID(model)).toBeUndefined();
  expect(hostingerRouter.missingModelID(model)).toBeUndefined();
});

test("reports an embedding-only create for manual authoring, since dimensions are unknowable", () => {
  const model = hostingerModel({
    id: "text-embedding-3-large",
    supported_parameters: [],
    supported_endpoints: ["/v1/embeddings"],
  });

  expect(hostingerRouter.translateModel(model, context())).toBeUndefined();
  expect(hostingerRouter.missingModelID(model)).toBe("text-embedding-3-large");
});

test("keeps authored reasoning_options when the catalog lists reasoning parameters", () => {
  const entry = {
    base_model: "anthropic/claude-sonnet-4-6",
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
  } as ExistingModel;
  const model = hostingerModel({ id: "claude-sonnet-4.6", supported_parameters: ["reasoning"] });
  const translated = hostingerRouter.translateModel(model, context({ [model.id]: entry }));

  expect(translated?.model).toMatchObject({
    base_model: "anthropic/claude-sonnet-4-6",
    reasoning_options: [{ type: "toggle" }],
  });
  expect(translated?.header).toContain("Toggle");
});
