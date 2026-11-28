import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  buildTinkerModel,
  fetchTinkerModels,
  MODELS_ENDPOINT,
  parseTinkerModels,
  SERVERLESS_ENDPOINT,
  thinkingmachines,
} from "../src/sync/providers/thinkingmachines.js";

function trainingRow(overrides: Record<string, unknown> = {}) {
  return {
    name: "Qwen3-8B",
    tinker_id: "Qwen/Qwen3-8B",
    type: "Hybrid",
    context: "32K",
    prefill: "$0.195",
    cached_prefill: "$0.039",
    sample: "$0.60",
    train: "$0.44",
    ...overrides,
  };
}

function serverlessRow(overrides: Record<string, unknown> = {}) {
  return {
    name: "Inkling",
    tinker_id: "thinkingmachines/Inkling:peft:262144:sampling-nvfp4",
    context: "256K",
    input: "$1.00",
    cached_input: "$0.17",
    output: "$4.05",
    ...overrides,
  };
}

// A full definition rather than a base_model overlay, so these assert the
// mapping itself instead of how factorBaseModel diffs against a lab file.
function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    name: "Qwen3 8B",
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    open_weights: true,
    cost: { input: 0.1, output: 0.3, cache_read: 0.02 },
    limit: { context: 40_960, output: 32_768 },
    modalities: { input: ["text"], output: ["text"] },
    ...overrides,
  } as ExistingModel;
}

test("reads sampling prices and context from both tables", () => {
  expect(parseTinkerModels({ models: [trainingRow()], serverless: [serverlessRow()] })).toEqual([
    { id: "Qwen/Qwen3-8B", context: 32_768, input: 0.195, cacheRead: 0.039, output: 0.6 },
    { id: "thinkingmachines/Inkling:peft:262144:sampling-nvfp4", context: 262_144, input: 1, cacheRead: 0.17, output: 4.05 },
  ]);
});

test("takes the sampling context from the row name when it exceeds the training context", () => {
  const [model] = parseTinkerModels({
    models: [trainingRow({ name: "Inkling 2 Mini (256K train / 1M sample)", tinker_id: "thinkingmachines/Inkling-2-Mini:peft:262144", context: "256K" })],
    serverless: [],
  });
  expect(model?.context).toBe(1_048_576);
});

test("fails on malformed prices, an empty table and duplicate IDs", () => {
  expect(() => parseTinkerModels({ models: [trainingRow({ sample: "1.2" })], serverless: [] })).toThrow();
  expect(() => parseTinkerModels({ models: [], serverless: [serverlessRow()] })).toThrow();
  expect(() => parseTinkerModels({ models: [trainingRow(), trainingRow()], serverless: [] })).toThrow("lists Qwen/Qwen3-8B twice");
});

test("updates prices and context, keeping the rest of the file", () => {
  const [model] = parseTinkerModels({ models: [trainingRow()], serverless: [] });
  expect(buildTinkerModel(model!, authored())).toMatchObject({
    reasoning_options: [{ type: "toggle" }],
    cost: { input: 0.195, output: 0.6, cache_read: 0.039 },
    limit: { context: 32_768, output: 32_768 },
  });
});

test("reports IDs without a hand-authored file instead of creating one", () => {
  const [model] = parseTinkerModels({ models: [trainingRow({ tinker_id: "Qwen/Qwen9-1B" })], serverless: [] });
  expect(thinkingmachines.translateModel(model!, { existing: () => undefined, authored: () => undefined })).toBeUndefined();
  expect(thinkingmachines.sourceID(model!)).toBe("Qwen/Qwen9-1B");
});

test("keeps the hand-authored MIME list that the v1 view would collapse", () => {
  const [model] = parseTinkerModels({ models: [trainingRow()], serverless: [] });
  const modalities = { input: ["text", "image/png", "image/jpeg"], output: ["text"] };
  const existing = authored({ modalities: { input: ["text", "image"], output: ["text"] } });
  const translated = thinkingmachines.translateModel(model!, {
    existing: () => existing,
    authored: () => existing,
    v2: () => ({ schema: 2, modalities }),
  });
  expect(translated?.v2Set).toEqual({ modalities });
  expect(translated && "model" in translated ? translated.model.modalities : undefined).toEqual(existing.modalities);
});

test("fetches both tables and fails on an HTTP error", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    return Response.json(url === MODELS_ENDPOINT ? [trainingRow()] : [serverlessRow()]);
  }) as unknown as typeof fetch;
  const raw = await fetchTinkerModels(fetcher);
  expect(urls).toEqual([MODELS_ENDPOINT, SERVERLESS_ENDPOINT]);
  expect(parseTinkerModels(raw).map((model) => model.id)).toEqual([
    "Qwen/Qwen3-8B",
    "thinkingmachines/Inkling:peft:262144:sampling-nvfp4",
  ]);

  const failing = (async () => new Response("", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;
  await expect(fetchTinkerModels(failing)).rejects.toThrow("503");
});
