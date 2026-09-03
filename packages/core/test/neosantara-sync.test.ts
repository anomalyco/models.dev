import { expect, test } from "bun:test";

import {
  buildNeosantaraModel,
  mergeNeosantaraCatalogs,
  neosantara,
  neosantaraInputModalities,
  NeosantaraModelsResponse,
  NeosantaraPricingResponse,
  resolveNeosantaraBaseModel,
  shouldSyncNeosantaraModel,
} from "../src/sync/providers/neosantara.js";

const modelsResponse = {
  object: "list",
  data: [
    {
      id: "gemini-3.7-flash",
      object: "model",
      created: 1_700_000_000,
      owned_by: "Neosantara",
      description: "Fast reasoning model",
      context_window: 1_000_000,
      max_output_tokens: 8_192,
      pricing: {
        currency: "USD",
        prompt: 1.5,
        completion: 7.5,
        cache_read: 0.15,
        cache_write: 1.5,
      },
      discount: 50,
      capabilities: ["text_generation", "function_calling", "json_mode", "vision", "reasoning"],
      deprecated: false,
      deprecation_alternatives: [],
    },
    {
      id: "gpt-oss-20b",
      object: "model",
      created: 1_700_000_000,
      owned_by: "Neosantara",
      description: "IDR-priced open model",
      context_window: 131_072,
      max_output_tokens: 8_192,
      pricing: { currency: "IDR", prompt: 400, completion: 1_600 },
      capabilities: ["text_generation", "function_calling"],
      deprecated: false,
      deprecation_alternatives: [],
    },
    {
      id: "too-small",
      object: "model",
      created: 1_700_000_000,
      owned_by: "Neosantara",
      description: "Too small",
      context_window: 32_000,
      max_output_tokens: 4_096,
      pricing: { currency: "USD", prompt: 1, completion: 2 },
      capabilities: ["function_calling"],
      deprecated: false,
      deprecation_alternatives: [],
    },
    {
      id: "no-tools",
      object: "model",
      created: 1_700_000_000,
      owned_by: "Neosantara",
      description: "No tools",
      context_window: 128_000,
      max_output_tokens: 4_096,
      pricing: { currency: "USD", prompt: 1, completion: 2 },
      capabilities: ["text_generation"],
      deprecated: false,
      deprecation_alternatives: [],
    },
  ],
};

const pricingResponse = {
  data: modelsResponse.data.map((model) => ({
    name: model.id,
    provider: "Neosantara",
    category: "standard",
    type: "text",
    input: "-",
    output: "-",
    capabilities: model.capabilities,
    context_window: model.context_window,
    description: model.description,
    raw_pricing: {
      currency: model.pricing.currency,
      per_million_tokens: {
        input: model.pricing.prompt,
        output: model.pricing.completion,
        cache_read: "cache_read" in model.pricing ? model.pricing.cache_read : undefined,
        cache_write: "cache_write" in model.pricing ? model.pricing.cache_write : undefined,
      },
    },
  })),
  meta: {
    count: modelsResponse.data.length,
    updated_at: "2026-09-02T16:32:29.553Z",
    exchange_rate: { usd_idr: 20_000, currency: "IDR", source: "test" },
  },
};

test("parses and merges both public Neosantara endpoints", () => {
  const models = NeosantaraModelsResponse.parse(modelsResponse);
  const pricing = NeosantaraPricingResponse.parse(pricingResponse);
  const merged = mergeNeosantaraCatalogs(models, pricing);

  expect(merged).toHaveLength(4);
  expect(merged[0]?.exchange_rate).toBe(20_000);
  expect(merged[0]?.pricing.prompt).toBe(1.5);
});

test("filters to 100k+ context, function calling, and known canonical base models", () => {
  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  );

  expect(shouldSyncNeosantaraModel(merged[0]!)).toBe(true);
  expect(shouldSyncNeosantaraModel(merged[2]!)).toBe(false);
  expect(shouldSyncNeosantaraModel(merged[3]!)).toBe(false);
  expect(resolveNeosantaraBaseModel("gemini-3.7-flash")).toBe("google/gemini-3.7-flash");
  expect(resolveNeosantaraBaseModel("unknown-model")).toBeUndefined();
});

test("builds override-only models with effective USD pricing and host reasoning controls", () => {
  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  );

  const gemini = buildNeosantaraModel(merged[0]!, undefined);
  expect(gemini).toMatchObject({
    base_model: "google/gemini-3.7-flash",
    reasoning_options: [],
    limit: { context: 1_000_000 },
    cost: { input: 0.75, output: 3.75, cache_read: 0.075, cache_write: 0.75 },
  });

  const idr = buildNeosantaraModel(merged[1]!, undefined);
  expect(idr).toMatchObject({
    base_model: "openai/gpt-oss-20b",
    reasoning: false,
    cost: { input: 0.02, output: 0.08 },
  });
});

test("authors reviewed per-host reasoning controls instead of dumping the request enum", () => {
  const source = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  )[0]!;
  const build = (id: string) => buildNeosantaraModel({ ...source, id }, undefined);

  expect(build("gpt-5.6-terra").reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "medium", "high", "xhigh"] },
  ]);
  expect(build("claude-opus-5").reasoning_options).toEqual([
    { type: "effort", values: ["low", "medium", "high", "xhigh"] },
  ]);
  expect(build("claude-fable-5").reasoning_options).toEqual([
    { type: "toggle" },
    { type: "budget_tokens", min: 1_024 },
  ]);
  expect(build("glm-4.6v-flash").reasoning_options).toEqual([{ type: "toggle" }]);
  expect(build("kimi-k2-thinking").reasoning_options).toEqual([]);
  expect(build("gpt-5.4").reasoning_options).toEqual([]);

  for (const id of ["gpt-5.6-terra", "claude-opus-5", "glm-5.3-flash", "laguna-s-2.1"]) {
    const values = build(id).reasoning_options?.flatMap((option) =>
      "values" in option ? option.values : [],
    );
    expect(values).not.toContain("minimal");
    expect(values).not.toContain("max");
  }
});

test("refuses to sync a reasoning model that has no reviewed control set", () => {
  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  );

  const unreviewed = {
    ...merged[1]!,
    capabilities: [...merged[1]!.capabilities, "reasoning"],
  };

  expect(shouldSyncNeosantaraModel(merged[1]!)).toBe(true);
  expect(shouldSyncNeosantaraModel(unreviewed)).toBe(false);
});

test("keeps model pricing when the public pricing entry is only partially populated", () => {
  const partial = structuredClone(pricingResponse) as typeof pricingResponse;
  const entry = partial.data.find((row) => row.name === "gemini-3.7-flash")!;
  delete (entry.raw_pricing.per_million_tokens as { output?: number }).output;

  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(partial),
  );

  const gemini = merged.find((model) => model.id === "gemini-3.7-flash")!;
  expect(gemini.pricing.prompt).toBe(1.5);
  expect(gemini.pricing.completion).toBe(7.5);

  expect(buildNeosantaraModel(gemini, undefined).cost).toMatchObject({
    input: 0.75,
    output: 3.75,
  });
});

test("derives input modalities from every advertised understanding capability", () => {
  expect(neosantaraInputModalities(["text_generation"])).toEqual(["text"]);
  expect(neosantaraInputModalities(["text_generation", "vision"])).toEqual(["text", "image"]);
  expect(neosantaraInputModalities(["vision", "video_understanding"])).toEqual([
    "text",
    "image",
    "video",
  ]);

  const source = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  )[0]!;

  // zhipuai/glm-4.6v-flash accepts video upstream, so the host must not narrow the lab entry.
  const video = buildNeosantaraModel(
    {
      ...source,
      id: "glm-4.6v-flash",
      capabilities: [...source.capabilities, "video_understanding"],
    },
    undefined,
  );
  expect(video.modalities).toBeUndefined();
});

const imageModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-image-2",
      object: "model",
      created: 1_700_000_000,
      owned_by: "Neosantara",
      description: "Image generation and editing",
      context_window: 0,
      max_output_tokens: 0,
      pricing: { currency: "USD", per_image: { "1024x1024": 0.04 } },
      capabilities: ["image_generation"],
      deprecated: false,
      deprecation_alternatives: [],
    },
    {
      id: "imagen-4.0-fast",
      object: "model",
      created: 1_700_000_000,
      owned_by: "Neosantara",
      description: "Image generation without a canonical lab entry",
      context_window: 0,
      max_output_tokens: 0,
      pricing: { currency: "USD", per_image: { "1024x1024": 0.02 } },
      capabilities: ["image_generation"],
      deprecated: false,
      deprecation_alternatives: [],
    },
  ],
};

const imagePricingResponse = {
  data: imageModelsResponse.data.map((model) => ({
    name: model.id,
    provider: "Neosantara",
    category: "standard",
    type: "image",
    input: "-",
    output: "-",
    capabilities: model.capabilities,
    context_window: model.context_window,
    description: model.description,
    raw_pricing: { currency: "USD", per_image: model.pricing.per_image },
  })),
  meta: {
    count: imageModelsResponse.data.length,
    updated_at: "2026-09-02T16:32:29.553Z",
    exchange_rate: { usd_idr: 16_000, currency: "IDR", source: "test" },
  },
};

test("syncs image generation models on per-image pricing without token costs", () => {
  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(imageModelsResponse),
    NeosantaraPricingResponse.parse(imagePricingResponse),
  );

  const image = merged[0]!;
  expect(shouldSyncNeosantaraModel(image)).toBe(true);

  const built = buildNeosantaraModel(image, undefined);
  expect("base_model" in built && built.base_model).toBe("openai/gpt-image-2");
  expect(built.cost).toBeUndefined();
  expect(built.reasoning_options).toBeUndefined();
  expect(built.tool_call).toBeUndefined();
});

test("reports image models that still lack a canonical lab entry", () => {
  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(imageModelsResponse),
    NeosantaraPricingResponse.parse(imagePricingResponse),
  );

  const context = { existing: () => undefined, authored: () => undefined };

  // The mapped model syncs, so it is never handed to the skip reporter.
  expect(neosantara.translateModel(merged[0]!, context)?.id).toBe("gpt-image-2");

  expect(shouldSyncNeosantaraModel(merged[1]!)).toBe(false);
  expect(neosantara.translateModel(merged[1]!, context)).toBeUndefined();
  expect(neosantara.sourceID(merged[1]!)).toBe("imagen-4.0-fast");
});

test("preserves model cache pricing when the public entry omits it in the same currency", () => {
  const partial = structuredClone(pricingResponse) as typeof pricingResponse;
  const entry = partial.data.find((row) => row.name === "gemini-3.7-flash")!;
  const tokens = entry.raw_pricing.per_million_tokens as {
    cache_read?: number;
    cache_write?: number;
  };
  delete tokens.cache_read;
  delete tokens.cache_write;

  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(partial),
  );

  const gemini = merged.find((model) => model.id === "gemini-3.7-flash")!;
  expect(gemini.pricing.cache_read).toBe(0.15);
  expect(gemini.pricing.cache_write).toBe(1.5);
});

test("never carries cache pricing across a currency change between the two endpoints", () => {
  const crossCurrency = structuredClone(pricingResponse) as typeof pricingResponse;
  const entry = crossCurrency.data.find((row) => row.name === "gemini-3.7-flash")!;
  entry.raw_pricing.currency = "IDR";
  const tokens = entry.raw_pricing.per_million_tokens as {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  tokens.input = 24_000;
  tokens.output = 120_000;
  delete tokens.cache_read;
  delete tokens.cache_write;

  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(crossCurrency),
  );

  const gemini = merged.find((model) => model.id === "gemini-3.7-flash")!;
  expect(gemini.pricing.currency).toBe("IDR");
  expect(gemini.pricing.cache_read).toBeUndefined();
  expect(gemini.pricing.cache_write).toBeUndefined();
});

test("tolerates public pricing entries that omit fields the sync never reads", () => {
  const sparse = {
    data: [
      { name: "gemini-3.7-flash", raw_pricing: { per_image: 0, currency: "USD" } },
      ...pricingResponse.data.filter((row) => row.name !== "gemini-3.7-flash"),
    ],
    meta: pricingResponse.meta,
  };

  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(sparse),
  );

  const gemini = merged.find((model) => model.id === "gemini-3.7-flash")!;
  expect(gemini.pricing.prompt).toBe(1.5);
  expect(gemini.pricing.completion).toBe(7.5);
});

test("resolves base models from the canonical metadata tree, aliasing only ambiguous ids", () => {
  // No alias entry needed: the canonical filename is unique under models/.
  expect(resolveNeosantaraBaseModel("gpt-5.6-terra")).toBe("openai/gpt-5.6-terra");
  expect(resolveNeosantaraBaseModel("kimi-k2.5")).toBe("moonshotai/kimi-k2.5");
  expect(resolveNeosantaraBaseModel("gpt-image-2")).toBe("openai/gpt-image-2");

  // Aliases cover ids the tree cannot resolve on its own.
  expect(resolveNeosantaraBaseModel("grok-code-fast")).toBe("xai/grok-4.3");
  expect(resolveNeosantaraBaseModel("claude-opus-7")).toBe("anthropic/claude-opus-4-7");
  expect(resolveNeosantaraBaseModel("qwen3-235b-wse")).toBe(
    "alibaba/qwen3-235b-a22b-instruct-2507",
  );

  expect(resolveNeosantaraBaseModel("definitely-not-a-model")).toBeUndefined();
});

test("reports reasoning models held back for control review instead of dropping them silently", () => {
  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  );

  const unreviewed = {
    ...merged[1]!,
    capabilities: [...merged[1]!.capabilities, "reasoning"],
  };

  expect(shouldSyncNeosantaraModel(unreviewed)).toBe(false);
  expect(neosantara.sourceID(unreviewed)).toBe("gpt-oss-20b");
});

test("surfaces skipped models in the sync notice so they are not collected and discarded", () => {
  expect(neosantara.skippedNotice([])).toEqual([]);

  const notice = neosantara.skippedNotice(["gemini-3.1-pro", "imagen-4.0-fast"]);
  expect(notice.length).toBeGreaterThan(0);
  expect(notice.join("\n")).toContain("gemini-3.1-pro");
  expect(notice.join("\n")).toContain("imagen-4.0-fast");
});

test("skips a model with unusable upstream pricing instead of aborting the whole sync", () => {
  const broken = {
    object: "list",
    data: [
      {
        ...modelsResponse.data[0]!,
        id: "kimi-k2.5",
        pricing: { currency: "USD" },
        discount: undefined,
        capabilities: ["text_generation", "function_calling"],
      },
    ],
  };

  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(broken),
    NeosantaraPricingResponse.parse({ data: [], meta: pricingResponse.meta }),
  );

  const context = { existing: () => undefined, authored: () => undefined };
  expect(() => neosantara.translateModel(merged[0]!, context)).not.toThrow();
  expect(neosantara.translateModel(merged[0]!, context)).toBeUndefined();
  expect(neosantara.sourceID(merged[0]!)).toBe("kimi-k2.5");
});

test("filters deprecated models and never treats the gateway runtime cap as an output limit", () => {
  const model = {
    ...mergeNeosantaraCatalogs(
      NeosantaraModelsResponse.parse(modelsResponse),
      NeosantaraPricingResponse.parse(pricingResponse),
    )[0]!,
    deprecated: true,
    max_output_tokens: 2_048,
  };

  expect(shouldSyncNeosantaraModel(model)).toBe(false);

  const built = buildNeosantaraModel({ ...model, deprecated: false }, undefined);
  expect(built).toMatchObject({
    base_model: "google/gemini-3.7-flash",
    limit: { context: 1_000_000 },
  });
  expect((built as { limit?: { output?: number } }).limit?.output).toBeUndefined();
});
