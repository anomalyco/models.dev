import { expect, test } from "bun:test";

import { syncProviderMatrix } from "../src/sync/index.js";
import { buildIsoquantModel, fetchIsoquantModels, isoquant, IsoquantResponse, type IsoquantModel } from "../src/sync/providers/isoquant.js";

function model(overrides: Partial<IsoquantModel> = {}): IsoquantModel {
  return {
    id: "glm-5.3-flash",
    isoquant: {
      context_length: 1_048_576,
      output_limit: { policy: "remaining_context" },
      pricing: {
        input_nano_usd_per_token: 70,
        output_nano_usd_per_token: 150,
        cached_input_nano_usd_per_token: 25,
      },
      reasoning: { default_effort: "max", efforts: ["low", "high", "max"] },
    },
    ...overrides,
  };
}

const existing = {
  cost: { input: 0.07, output: 0.15, cache_read: 0.025 },
  limit: { context: 1_048_576, output: 131_072 },
};

test("Isoquant is registered for scheduled sync and fetches its public catalog without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === isoquant.id)).toBe(true);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ object: "list", data: [model()] });
  }) as unknown as typeof fetch;
  await fetchIsoquantModels(fetcher);
  expect(request!.url).toBe("https://api.isoquant.ai/v1/models");
  expect(request!.headers.get("authorization")).toBeNull();

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  expect(fetchIsoquantModels(unavailable)).rejects.toThrow("503");
});

test("empty, duplicate and malformed upstream inventories fail before any catalog writes", () => {
  expect(() => IsoquantResponse.parse({ object: "list", data: [] })).toThrow("empty catalog");
  expect(() => IsoquantResponse.parse({ object: "list", data: [model(), model()] })).toThrow("duplicate model IDs");
  expect(() => IsoquantResponse.parse({ object: "list", data: [model({ id: "" })] })).toThrow();
  expect(() => IsoquantResponse.parse({
    object: "list",
    data: [model({ isoquant: { ...model().isoquant, pricing: { ...model().isoquant.pricing, input_nano_usd_per_token: -1 } } })],
  })).toThrow("non-negative");
  for (const value of ["", " ", "0x10", "free"]) {
    expect(() => IsoquantResponse.parse({
      object: "list",
      data: [model({ isoquant: { ...model().isoquant, pricing: { ...model().isoquant.pricing, input_nano_usd_per_token: value as unknown as number } } })],
    })).toThrow("non-negative decimal");
  }
});

test("nano-USD prices convert to USD per million tokens and limits are API-authoritative", () => {
  const glm = buildIsoquantModel(model(), existing);
  expect(glm).toMatchObject({
    cost: { input: 0.07, output: 0.15, cache_read: 0.025 },
    limit: { context: 1_048_576, output: 131_072 },
  });

  const deepseek = buildIsoquantModel(model({
    id: "deepseek-v4.1-flash-1017-fast",
    isoquant: {
      context_length: 1_048_576,
      output_limit: { max_tokens: 943_718, policy: "remaining_context" },
      pricing: {
        input_nano_usd_per_token: 35,
        output_nano_usd_per_token: 370,
        cached_input_nano_usd_per_token: 5,
      },
      reasoning: { default_effort: "high", efforts: ["none", "low", "high"] },
    },
  }), existing);
  expect(deepseek).toMatchObject({
    cost: { input: 0.035, output: 0.37, cache_read: 0.005 },
    limit: { context: 1_048_576, output: 943_718 },
  });
});

test("a remaining_context policy without max_tokens keeps the authored output limit", () => {
  const built = buildIsoquantModel(model(), { ...existing, limit: { context: 1_048_576, output: 32_768 } });
  expect(built).toMatchObject({ limit: { output: 32_768 } });
});

test("published efforts replace the authored effort list and an unknown value leaves it untouched", () => {
  const authored = { ...existing, reasoning_options: [{ type: "toggle" as const }] };
  const published = buildIsoquantModel(model(), authored);
  expect(published.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "high", "max"] },
  ]);

  const unknown = model({
    isoquant: { ...model().isoquant, reasoning: { default_effort: "future", efforts: ["future"] } },
  });
  expect(buildIsoquantModel(unknown, authored).reasoning_options).toEqual([{ type: "toggle" }]);

  const unsorted = model({
    isoquant: { ...model().isoquant, reasoning: { default_effort: "max", efforts: ["high", "low", "low", "default"] } },
  });
  expect(buildIsoquantModel(unsorted, authored).reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "high", "default"] },
  ]);
});

test("a published effort list containing none drops an authored toggle", () => {
  const authored = { ...existing, reasoning_options: [{ type: "toggle" as const }] };
  const deepseek = model({
    id: "deepseek-v4.1-flash-1017-fast",
    isoquant: {
      context_length: 1_048_576,
      output_limit: { max_tokens: 943_718, policy: "remaining_context" },
      pricing: {
        input_nano_usd_per_token: 35,
        output_nano_usd_per_token: 370,
        cached_input_nano_usd_per_token: 5,
      },
      reasoning: { default_effort: "high", efforts: ["none", "low", "high"] },
    },
  });
  expect(buildIsoquantModel(deepseek, authored).reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "high"] },
  ]);
});

test("the published default effort is carried through v2Set", () => {
  const translated = isoquant.translateModel(model(), { existing: () => existing, authored: () => existing });
  expect(translated?.v2Set).toEqual({ "capabilities.reasoning.default": { type: "effort", value: "max" } });
  expect(isoquant.translateModel(model({
    isoquant: { ...model().isoquant, reasoning: null },
  }), { existing: () => existing, authored: () => existing })?.v2Set).toBeUndefined();

  const notPublished = model({
    isoquant: { ...model().isoquant, reasoning: { default_effort: "max", efforts: ["low", "high"] } },
  });
  expect(isoquant.translateModel(notPublished, { existing: () => existing, authored: () => existing })?.v2Set).toBeUndefined();

  const disabled = { ...existing, reasoning: false };
  expect(isoquant.translateModel(model(), { existing: () => disabled, authored: () => disabled })?.v2Set).toBeUndefined();
});

test("absent local files are skipped for hand authoring, while incomplete local metadata throws", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  expect(isoquant.translateModel(model(), context)).toBeUndefined();
  expect(() => buildIsoquantModel(model(), { limit: { context: 1_048_576, output: 131_072 } })).toThrow("incomplete local pricing");
});

test("models absent from the catalog are retained rather than deleted", () => {
  expect(isoquant.deleteMissing).toBe(false);
});
