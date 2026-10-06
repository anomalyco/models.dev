import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { syncProvider, type ExistingModel } from "../src/sync/index.js";
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

  const raw = parseZenifraModels(await fetchZenifraModels(undefined, fetcher));

  expect(request?.url).toBe("https://ai.zenifra.com/v1/models");
  expect(request?.headers.get("authorization")).toBeNull();
  expect(raw).toHaveLength(1);
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

test("rejects Zenifra pricing units that are not per million tokens", () => {
  const invalidCatalog: unknown = {
    object: "list",
    data: [zenifraModel({
      pricing: {
        input: 0.6,
        output: 2,
        unit: "per_image",
      },
    })],
  };

  expect(() => parseZenifraModels(invalidCatalog)).toThrow();
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
      input: 0.113208,
      output: 0.377358,
      cache_read: 0.018868,
      tiers: [{
        tier: { type: "context", size: 256_001 },
        input: 0.641509,
        output: 3.849057,
        cache_read: 0.064151,
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

test("refreshes authored reasoning effort values from the explicit API control set", () => {
  const result = buildZenifraModel(
    zenifraModel({
      supported_parameters: ["reasoning_effort"],
      capabilities: {
        reasoning: {
          supported: true,
          always_on: false,
          effort_levels: ["high", "max"],
        },
      },
    }),
    existingModel({
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: ["low", "medium", "xhigh"] },
      ],
    }),
  );

  expect(result.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["high", "max"] },
  ]);
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

test("skips a new canonical route when reasoning metadata is omitted", () => {
  const model = zenifraModel({ capabilities: undefined });

  expect(zenifra.translateModel(model, {
    existing: () => undefined,
    authored: () => undefined,
  })).toBeUndefined();
});

test("requires authored controls for an inline reasoner with no safe feed controls", () => {
  const model = zenifraModel({
    id: "zenifra/inline-reasoner",
    capabilities: {
      reasoning: {
        supported: true,
        effort_levels: ["low", "medium", "xhigh"],
      },
    },
    supported_parameters: ["temperature"],
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

test("does not stamp defaults when a new canonical route omits optional fields", () => {
  const result = buildZenifraModel(zenifraModel({
    input_modalities: undefined,
    output_modalities: undefined,
    context_length: undefined,
    max_output_tokens: undefined,
    capabilities: undefined,
    supported_parameters: undefined,
  }), undefined);

  expect(result).toMatchObject({ base_model: "alibaba/qwen3.8-flash" });
  expect(result).not.toHaveProperty("attachment");
  expect(result).not.toHaveProperty("limit");
  expect(result).not.toHaveProperty("modalities");
  expect(result).not.toHaveProperty("tool_call");
  expect(result).not.toHaveProperty("temperature");
});

test("preserves authored pricing fields omitted by a partial feed", () => {
  const result = buildZenifraModel(
    zenifraModel({
      id: "zenifra/partial-pricing",
      pricing: { input: 0.6, output: 2, unit: "per_million_tokens" },
    }),
    existingModel({
      base_model: undefined,
      reasoning_options: [],
      cost: {
        input: 1,
        output: 2,
        cache_read: 0.5,
        cache_write: 0.2,
        input_audio: 3,
        output_audio: 4,
        tiers: [{ tier: { type: "context", size: 256_001 }, input: 2, output: 4 }],
      },
    }),
  );

  expect(result.cost).toMatchObject({
    input: 0.113208,
    output: 0.377358,
    cache_read: 0.5,
    cache_write: 0.2,
    input_audio: 3,
    output_audio: 4,
    tiers: [{ tier: { type: "context", size: 256_001 }, input: 2, output: 4 }],
  });
});

test("clears reasoning cost when the feed disables reasoning", () => {
  const result = buildZenifraModel(
    zenifraModel({
      id: "zenifra/non-reasoning",
      capabilities: { reasoning: { supported: false } },
      pricing: undefined,
    }),
    existingModel({
      base_model: undefined,
      reasoning: true,
      reasoning_options: undefined,
      cost: { input: 1, output: 2, reasoning: 0.5 },
    }),
  );

  expect(result.reasoning).toBe(false);
  expect(result.cost?.reasoning).toBeUndefined();
});

test("retains missing Zenifra routes instead of deleting on feed omission", () => {
  expect(zenifra.deleteMissing).toBe(false);
  expect(zenifra.missingNotice?.(["kimi-k3.toml"])).toEqual([
    "1 local Zenifra models were absent from the live API and were retained for manual lifecycle review.",
    "Retained local paths: `kimi-k3.toml`",
  ]);
});

test("sync runner retains local files absent from the Zenifra feed", async () => {
  const root = await mkdtemp(path.join(import.meta.dirname, "zenifra-sync-"));
  const modelsDir = path.join(root, "models");
  await mkdir(modelsDir, { recursive: true });
  await Bun.write(path.join(modelsDir, "legacy.toml"), `name = "Legacy"
description = "Legacy model retained for lifecycle review"
attachment = false
reasoning = false
tool_call = false
open_weights = false
release_date = "2026-01-01"
last_updated = "2026-01-01"

[limit]
context = 1000
output = 100

[modalities]
input = ["text"]
output = ["text"]

[cost]
input = 1
output = 1
`);

  try {
    const result = await syncProvider({
      ...zenifra,
      modelsDir,
      fetchModels: async () => ({
        object: "list",
        data: [zenifraModel({
          id: "zenifra/unknown",
          capabilities: { reasoning: { supported: false } },
          supported_parameters: [],
        })],
      }),
    }, { dryRun: true, openIssues: false });

    expect(result.deleted).toBe(0);
    expect(result.notices).toContain(
      "1 local Zenifra models were absent from the live API and were retained for manual lifecycle review.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
