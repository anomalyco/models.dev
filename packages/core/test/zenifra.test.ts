import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  buildZenifraModel,
  fetchZenifraModels,
  parseZenifraModels,
  resolveZenifraBaseModel,
  zenifra,
  type ZenifraModel,
} from "../src/sync/providers/zenifra.js";

function zenifraModel(overrides: Partial<ZenifraModel> = {}): ZenifraModel {
  return {
    id: "zenifra/qwen3.8-flash",
    object: "model",
    owned_by: "zenifra",
    created: 1_677_610_602,
    context_length: 1_000_000,
    max_output_tokens: 131_072,
    pricing: {
      input: 0.6,
      output: 2,
      cache_read_input: 0.1,
      unit: "per_million_tokens",
      context_tiers: [
        {
          min_input_tokens: 0,
          max_input_tokens: 256_000,
          input: 0.6,
          output: 2,
          cache_read_input: 0.1,
        },
        {
          min_input_tokens: 256_001,
          max_input_tokens: 1_000_000,
          input: 3.4,
          output: 20.4,
          cache_read_input: 0.34,
        },
      ],
    },
    capabilities: {
      system_messages: true,
      response_schema: true,
      vision: true,
      function_calling: true,
      tool_choice: true,
      structured_outputs: true,
      reasoning: {
        supported: true,
        always_on: false,
        effort_levels: ["low", "medium", "xhigh"],
      },
    },
    input_modalities: ["text", "image", "video"],
    output_modalities: ["text"],
    supported_operations: ["/v1/chat/completions", "/v1/responses"],
    supported_parameters: [
      "max_tokens",
      "temperature",
      "tools",
      "tool_choice",
    ],
    ...overrides,
  };
}

function existingModel(overrides: ExistingModel = {}): ExistingModel {
  return {
    base_model: "alibaba/qwen3.8-flash",
    reasoning: true,
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "xhigh"] },
    ],
    cost: {
      input: 1,
      output: 2,
      cache_read: 0.1,
      tiers: [{ tier: { type: "context", size: 256_001 }, input: 2, output: 4 }],
    },
    limit: { context: 100_000, output: 8_000 },
    ...overrides,
  };
}

test("fetches the public Zenifra catalog without authentication", async () => {
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
    return Response.json({ object: "list", data: [zenifraModel()] });
  }) as unknown as typeof fetch;

  const raw = await fetchZenifraModels(undefined, fetcher);

  expect(request?.url).toBe("https://ai.zenifra.com/v1/models");
  expect(request?.headers.get("authorization")).toBeNull();
  expect(raw.data).toHaveLength(1);
});

test("adds optional bearer authentication when a Zenifra key is configured", async () => {
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
    return Response.json({ object: "list", data: [zenifraModel()] });
  }) as unknown as typeof fetch;

  await fetchZenifraModels("test-key", fetcher);

  expect(request?.headers.get("authorization")).toBe("Bearer test-key");
});

test("rejects an empty Zenifra catalog before destructive sync", () => {
  expect(() => parseZenifraModels({ object: "list", data: [] })).toThrow(
    "Zenifra returned an empty model catalog; refusing to sync",
  );
});

test("maps Zenifra prices, tiers, limits, capabilities, and modalities", () => {
  const result = buildZenifraModel(
    zenifraModel({ id: "zenifra/test" }),
    existingModel({ base_model: undefined }),
  );

  expect(result).toMatchObject({
    attachment: true,
    reasoning: true,
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "xhigh"] },
    ],
    temperature: true,
    tool_call: true,
    structured_output: true,
    provider: { shape: "completions" },
    limit: { context: 1_000_000, output: 131_072 },
    modalities: { input: ["text", "image", "video"], output: ["text"] },
    cost: {
      input: 0.115385,
      output: 0.384615,
      cache_read: 0.019231,
      tiers: [{
        tier: { type: "context", size: 256_001 },
        input: 0.653846,
        output: 3.923077,
        cache_read: 0.065385,
      }],
    },
  });
});

test("derives temperature support from the API parameters", () => {
  const result = buildZenifraModel(
    zenifraModel({ supported_parameters: ["temperature"] }),
    existingModel({ temperature: false }),
  );

  expect(result.temperature).toBe(true);
});

test("resolves Zenifra routes to canonical model metadata", () => {
  expect(resolveZenifraBaseModel("zenifra/qwen3.8-flash")).toBe("alibaba/qwen3.8-flash");
  expect(resolveZenifraBaseModel("zenifra/deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro-0813");
});

test("reports new Zenifra routes without canonical metadata", () => {
  const model = zenifraModel({ id: "zenifra/new-model" });

  expect(zenifra.translateModel(model, {
    existing: () => undefined,
    authored: () => undefined,
  })).toBeUndefined();
  expect(zenifra.missingModelID?.(model)).toBe("zenifra/new-model");
});

test("requires authored controls for an inline reasoner with no safe feed controls", () => {
  const model = zenifraModel({
    id: "zenifra/inline-reasoner",
    capabilities: { reasoning: { supported: true } },
  });

  expect(() => buildZenifraModel(
    model,
    existingModel({ base_model: undefined, reasoning_options: undefined }),
  )).toThrow(MissingReasoningOptionsError);
});

test("preserves authored capabilities when optional feed fields are absent", () => {
  const result = buildZenifraModel(
    zenifraModel({
      id: "zenifra/inline-model",
      capabilities: undefined,
      input_modalities: undefined,
      output_modalities: undefined,
      supported_parameters: undefined,
    }),
    existingModel({
      base_model: undefined,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      temperature: true,
      tool_call: true,
      structured_output: true,
      reasoning_options: [],
    }),
  );

  expect(result).toMatchObject({
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    temperature: true,
    tool_call: true,
    structured_output: true,
    reasoning_options: [],
  });
});

test("retains missing Zenifra routes instead of deleting on feed omission", () => {
  expect(zenifra.deleteMissing).toBe(false);
  expect(zenifra.missingNotice?.(["kimi-k3.toml"])).toEqual([
    "1 local Zenifra models were absent from the live API and were retained for manual lifecycle review.",
    "Retained local paths: `kimi-k3.toml`",
  ]);
});
