import { expect, test } from "bun:test";
import type { z } from "zod";

import { syncProviderMatrix } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import { bf16, BF16Model, BF16Response, buildBF16Model, fetchBF16Models } from "../src/sync/providers/bf16.js";

type BF16ModelInput = z.input<typeof BF16Model>;

function sampleModel(overrides: Partial<BF16ModelInput> = {}): BF16ModelInput {
  return {
    id: "moonshotai/kimi-k3.1-pro-uncensored",
    object: "model",
    context_window: 1_048_576,
    max_output_tokens: 131_072,
    supports_reasoning: true,
    supports_tools: true,
    supports_json_schema: true,
    bf16: {
      family: "kimi",
      modification_method: "uncensored",
      status: "active",
      context_window: 1_048_576,
      max_output_tokens: 131_072,
      supports_reasoning: true,
      supports_tools: true,
      supports_vision: true,
      supports_json_schema: true,
      pricing_usd_per_1m: {
        input: "1.95",
        cached_input: "0.28",
        output: "6.90",
      },
    },
    ...overrides,
  };
}

test("bf16 is registered for scheduled sync and fetches public /v1/models without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === bf16.id)).toBe(true);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ object: "list", data: [sampleModel()] });
  }) as unknown as typeof fetch;

  const parsed = await fetchBF16Models(fetcher);
  expect(request!.url).toBe("https://api.bf16.ai/v1/models");
  expect(request!.headers.get("authorization")).toBeNull();
  expect(parsed.data).toHaveLength(1);
  expect(parsed.data[0]!.bf16!.pricing_usd_per_1m).toEqual({
    input: 1.95,
    cached_input: 0.28,
    output: 6.9,
  });

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  await expect(fetchBF16Models(unavailable)).rejects.toThrow("503");
});

test("empty, duplicate, and negative-price catalogs fail closed", () => {
  expect(() => BF16Response.parse({ object: "list", data: [] })).toThrow("empty catalog");
  expect(() => BF16Response.parse({ object: "list", data: [sampleModel(), sampleModel()] })).toThrow("duplicate model IDs");
  expect(() =>
    BF16Response.parse({
      object: "list",
      data: [
        sampleModel({
          bf16: {
            ...sampleModel().bf16,
            pricing_usd_per_1m: { input: "-0.1", output: "1.0" },
          },
        }),
      ],
    }),
  ).toThrow();
});

test("router aliases and inactive entries are excluded by sourceID", () => {
  const router = BF16Response.parse({
    object: "list",
    data: [
      {
        id: "bf16/auto",
        object: "model",
        bf16: { family: "router", modification_method: "smart_router" },
      },
      sampleModel({ id: "bf16/inactive", bf16: { ...sampleModel().bf16, status: "deprecated" } }),
      sampleModel(),
    ],
  }).data;

  expect(bf16.sourceID(router[0]!)).toBeUndefined();
  expect(bf16.missingModelID(router[0]!)).toBeUndefined();
  expect(bf16.sourceID(router[1]!)).toBeUndefined();
  expect(bf16.missingModelID(router[1]!)).toBe("bf16/inactive");
  expect(bf16.sourceID(router[2]!)).toBe("moonshotai/kimi-k3.1-pro-uncensored");
});

test("buildBF16Model updates pricing and limits while preserving hand-authored reasoning_options", () => {
  const [parsed] = BF16Response.parse({ object: "list", data: [sampleModel()] }).data;
  const synced = buildBF16Model(parsed!, {
    name: "Kimi K3.1 Pro (Uncensored)",
    base_model: "moonshotai/kimi-k3.1-pro",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    tool_call: true,
    structured_output: true,
    cost: { input: 2.9, output: 9.9, cache_read: 0.45 },
    limit: { context: 1_048_576, output: 131_072 },
  });

  expect(synced).toMatchObject({
    base_model: "moonshotai/kimi-k3.1-pro",
    cost: { input: 1.95, output: 6.9, cache_read: 0.28 },
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  });
});

test("buildBF16Model strips stale cache_read when cached_input is absent from the catalog", () => {
  const [parsed] = BF16Response.parse({
    object: "list",
    data: [
      sampleModel({
        bf16: {
          ...sampleModel().bf16,
          pricing_usd_per_1m: { input: "1.95", output: "6.90" },
        },
      }),
    ],
  }).data;

  const synced = buildBF16Model(parsed!, {
    name: "Kimi K3.1 Pro (Uncensored)",
    base_model: "moonshotai/kimi-k3.1-pro",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    tool_call: true,
    structured_output: true,
    cost: { input: 2.9, output: 9.9, cache_read: 0.45 },
    limit: { context: 1_048_576, output: 131_072 },
  });

  expect(synced.cost?.cache_read).toBeUndefined();
});

test("non-active and pricing-less listed models are skipped and preserved via missingModelID", () => {
  const existingModel = {
    name: "Kimi K3.1 Pro (Uncensored)",
    base_model: "moonshotai/kimi-k3.1-pro",
    reasoning: true,
    reasoning_options: [{ type: "effort" as const, values: ["low" as const, "high" as const, "max" as const] }],
    tool_call: true,
    structured_output: true,
    cost: { input: 1.95, output: 6.9, cache_read: 0.28 },
    limit: { context: 1_048_576, output: 131_072 },
  };
  const context = {
    existing: () => existingModel,
    authored: () => existingModel,
  };

  const entries = BF16Response.parse({
    object: "list",
    data: [
      sampleModel({ bf16: { ...sampleModel().bf16, status: "deprecated" } }),
      sampleModel({
        id: "moonshotai/kimi-k3.1-pro-uncensored-no-price",
        bf16: { ...sampleModel().bf16, pricing_usd_per_1m: undefined },
      }),
    ],
  }).data;

  expect(bf16.translateModel(entries[0]!, context)).toBeUndefined();
  expect(bf16.missingModelID(entries[0]!)).toBe("moonshotai/kimi-k3.1-pro-uncensored");
  expect(bf16.translateModel(entries[1]!, context)).toBeUndefined();
  expect(bf16.missingModelID(entries[1]!)).toBe("moonshotai/kimi-k3.1-pro-uncensored-no-price");
});

test("zero-priced active models remain representable and sync prices", () => {
  const [freeModel] = BF16Response.parse({
    object: "list",
    data: [
      sampleModel({
        id: "bf16/free-preview",
        bf16: {
          ...sampleModel().bf16,
          pricing_usd_per_1m: { input: "0", output: "0" },
        },
      }),
    ],
  }).data;

  expect(bf16.sourceID(freeModel!)).toBe("bf16/free-preview");
  const existingModel = {
    name: "Free Preview",
    reasoning: true,
    reasoning_options: [{ type: "effort" as const, values: ["low" as const, "high" as const] }],
    tool_call: true,
    structured_output: true,
    cost: { input: 1, output: 2 },
    limit: { context: 1_048_576, output: 131_072 },
  };
  const translated = bf16.translateModel(freeModel!, {
    existing: () => existingModel,
    authored: () => existingModel,
  });
  expect(translated?.model.cost).toMatchObject({ input: 0, output: 0 });
});

test("buildBF16Model throws MissingReasoningOptionsError when a reasoner lacks authored controls", () => {
  const [parsed] = BF16Response.parse({ object: "list", data: [sampleModel()] }).data;
  expect(() =>
    buildBF16Model(parsed!, {
      name: "Kimi K3.1 Pro (Uncensored)",
      reasoning: true,
      tool_call: true,
      structured_output: true,
      cost: { input: 1.95, output: 6.9, cache_read: 0.28 },
      limit: { context: 1_048_576, output: 131_072 },
    }),
  ).toThrow(MissingReasoningOptionsError);
});
