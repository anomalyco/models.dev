import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  fetchLLMTRModels,
  llmtr,
  modelID,
  resolveLLMTRBaseModel,
  type LLMTRModel,
} from "../src/sync/providers/llmtr.js";

const none = { existing: () => undefined, authored: () => undefined };

// One row of GET https://llmtr.com/v1/models (2026-10-22), trimmed to the
// fields the sync reads.
function row(overrides: Partial<LLMTRModel> = {}): LLMTRModel {
  return {
    id: "zai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    supported_endpoints: ["/v1/chat/completions"],
    context_length: 202_752,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    pricing: { prompt: "0.000000135", completion: "0.00000045", input_cache_read: "0.000000027" },
    top_provider: { context_length: 202_752, max_completion_tokens: 202_752 },
    supported_parameters: ["max_tokens", "reasoning", "reasoning_effort", "temperature", "tools"],
    reasoning: { mandatory: true, default_enabled: true, supported_efforts: ["max", "none", "low", "high"] },
    ...overrides,
  };
}

function translate(model: LLMTRModel, existing?: ExistingModel) {
  const context = { existing: () => existing, authored: () => existing };
  return llmtr.translateModel(model, existing === undefined ? none : context);
}

test("publishes the effort ladder in order, without none on a mandatory route", () => {
  const built = translate(row());

  expect(built).toMatchObject({
    model: {
      base_model: "zhipuai/glm-5.3-flash",
      reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    },
    header: expect.stringContaining("# Effort: reasoning_effort = low|high|max"),
  });
});

test("treats a ladder of only none as an on/off switch", () => {
  const built = translate(row({
    reasoning: { mandatory: false, default_enabled: true, supported_efforts: ["none"] },
  }));

  expect(built?.model).toMatchObject({ reasoning_options: [{ type: "toggle" }] });
});

test("publishes a toggle for a route that takes the boolean reasoning field", () => {
  const built = translate(row({
    supported_parameters: ["reasoning", "tools"],
    reasoning: { mandatory: false, default_enabled: true, supported_efforts: [] },
  }));

  expect(built).toMatchObject({
    model: { reasoning_options: [{ type: "toggle" }] },
    header: expect.stringContaining("# Toggle: reasoning = true|false"),
  });
});

test("publishes no control for a route that always reasons", () => {
  const built = translate(row({
    supported_parameters: ["tools"],
    reasoning: { mandatory: true, default_enabled: true, supported_efforts: [] },
  }));

  expect(built?.model).toMatchObject({ reasoning_options: [] });
});

test("turns reasoning off where LLMTR serves the route without it", () => {
  const built = translate(row({
    supported_parameters: ["tools"],
    reasoning: { mandatory: false, default_enabled: false, supported_efforts: [] },
  }));

  expect(built?.model).toMatchObject({ reasoning: false });
  expect(built?.model).not.toHaveProperty("reasoning_options");
});

test("leaves a reasoning route with no listed control to be measured", () => {
  expect(() => translate(row({ reasoning: null }))).toThrow(MissingReasoningOptionsError);
});

test("leaves routes that forward the lab's own thinking fields to be measured", () => {
  expect(() => translate(row({ id: "qwen/qwen3.7-max" }))).toThrow(MissingReasoningOptionsError);
  expect(() => translate(row({ id: "greenpt/deepseek-v4.1-flash" }))).toThrow(MissingReasoningOptionsError);
});

test("creates a non-reasoning route the list says nothing about", () => {
  const built = translate(row({ id: "openai/gpt-4.1-mini", reasoning: null }));

  expect(built?.model).not.toHaveProperty("reasoning");
  expect(built?.model).not.toHaveProperty("reasoning_options");
});

test("drops an output cap that only repeats the context window", () => {
  const built = translate(row({ top_provider: { context_length: 128_000, max_completion_tokens: 128_000 } }));

  expect(built?.model).toMatchObject({ limit: { context: 128_000 } });
  expect(built?.model).not.toHaveProperty("limit.output");
});

test("keeps only the input kinds the lab model also reads", () => {
  const built = translate(row({
    id: "openai/gpt-5.4-mini",
    architecture: { input_modalities: ["text", "image", "file", "audio"], output_modalities: ["text"] },
  }));

  // The lab entry reads text and images, so the file inherits its exact formats.
  expect(built?.model).not.toHaveProperty("modalities");
});

test("converts per-token prices to dollars per million tokens", () => {
  const built = translate(row());

  expect(built?.model).toMatchObject({ cost: { input: 0.135, output: 0.45, cache_read: 0.027 } });
});

test("fails on a price that is not a non-negative number", () => {
  expect(() => translate(row({ pricing: { prompt: "-1", completion: "0.0000001" } }))).toThrow();
});

test("does not create a route whose price is not quoted", () => {
  expect(translate(row({ pricing: { prompt: "0.000000135" } }))).toBeUndefined();
});

test("publishes an explicitly quoted zero price", () => {
  const built = translate(row({ pricing: { prompt: "0", completion: "0" } }));

  expect(built?.model).toMatchObject({ cost: { input: 0, output: 0 } });
});

test("refreshes only prices and limits on a hand-authored file", () => {
  const authored = {
    base_model: "zhipuai/glm-5.3-flash",
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    structured_output: true,
    cost: { input: 1, output: 2, cache_write: 0.5 },
  } as ExistingModel;
  const built = translate(row({ supported_parameters: [] }), authored);

  expect(built?.model).toMatchObject({
    reasoning_options: [{ type: "toggle" }],
    structured_output: true,
    cost: { input: 0.135, output: 0.45, cache_read: 0.027, cache_write: 0.5 },
  });
  expect(built?.model).not.toHaveProperty("tool_call");
});

test("skips routes the catalog cannot describe", () => {
  expect(translate(row({ id: "evren/evren-pro" }))).toBeUndefined();
  expect(translate(row({ id: "zai/glm-5.3-flash:think" }))).toBeUndefined();
  expect(translate(row({ supported_endpoints: ["/v1/images/generations"] }))).toBeUndefined();
});

test("resolves host, region and free routes to the lab entry", () => {
  expect(resolveLLMTRBaseModel("greenpt/glm-5.3-flash-eu")).toBe("zhipuai/glm-5.3-flash");
  expect(resolveLLMTRBaseModel("moonshot/kimi-k3")).toBe("moonshotai/kimi-k3");
  expect(modelID("llmtr/gemma-4")).toBe("gemma-4");
});

test("refuses a list too short to tell a retirement from truncation", async () => {
  const fetcher = (async () => Response.json({ object: "list", data: [row()] })) as unknown as typeof fetch;

  await expect(fetchLLMTRModels(fetcher)).rejects.toThrow("below the 100");
});
