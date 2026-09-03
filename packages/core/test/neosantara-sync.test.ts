import { expect, test } from "bun:test";

import {
  buildNeosantaraModel,
  mergeNeosantaraCatalogs,
  neosantara,
  neosantaraFxHeader,
  neosantaraInputModalities,
  neosantaraReasoningControls,
  neosantaraReasoningHeader,
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
  expect(merged[0]?.exchange_rate_source).toBe("test");
  expect(merged[0]?.exchange_rate_updated_at).toBe("2026-09-02T16:32:29.553Z");
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
    // Uniform host effort enum — the catalog exposes reasoning capability, not grades.
    reasoning_options: [
      { type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh"] },
    ],
    // This host streams reasoning in `reasoning_content`.
    interleaved: { field: "reasoning_content" },
    limit: { context: 1_000_000 },
    cost: { input: 0.75, output: 3.75, cache_read: 0.075, cache_write: 0.75 },
  });

  // The host's own capability list decides whether reasoning is served here: it rejects
  // `reasoning_effort` with HTTP 400 for a model that does not advertise `reasoning`, however
  // the lab entry describes the underlying model.
  const idr = buildNeosantaraModel(merged[1]!, undefined);
  expect(idr).toMatchObject({
    base_model: "openai/gpt-oss-20b",
    reasoning: false,
    cost: { input: 0.02, output: 0.08 },
  });
  expect(idr.reasoning_options).toBeUndefined();
  expect(idr.interleaved).toBeUndefined();
});

test("writes FX provenance only for IDR-derived USD prices", () => {
  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  );
  const usd = merged[0]!;
  const idr = merged[1]!;

  expect(neosantaraFxHeader(usd)).toBeUndefined();
  expect(neosantaraFxHeader(idr)).toBe(
    "# FX: IDR prices converted to USD at 1 USD = 20000 IDR (test, 2026-09-02).\n",
  );

  const translated = neosantara.translateModel(idr, {
    existing: () => undefined,
    authored: () => undefined,
  });
  expect(translated?.header).toBe(neosantaraFxHeader(idr));
});

test("never advertises a control this host cannot send", () => {
  const source = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  )[0]!;

  // Whatever the upstream lab, the host maps effort onto the same accepted enum: only effort,
  // no budget_tokens or toggle, and every value inside the host enum.
  for (const id of ["gpt-5.6-terra", "claude-sonnet-5", "glm-5.3-flash", "gemini-3.7-flash"]) {
    const options = neosantaraReasoningControls({ ...source, id });
    expect(options.some((option) => option.type === "budget_tokens")).toBe(false);
    expect(options.some((option) => option.type === "toggle")).toBe(false);
    expect(neosantaraReasoningHeader(options)).toContain("reasoning_effort");
    for (const value of options.flatMap((o) => ("values" in o ? o.values : []))) {
      expect(["none", "minimal", "low", "medium", "high", "xhigh"]).toContain(value);
    }
  }

  // The full host enum is what a reasoning model advertises, including the `none` off value.
  const built = buildNeosantaraModel({ ...source, id: "gpt-5.6-terra" }, undefined);
  expect(built.reasoning_options).toEqual([
    { type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  ]);
});

test("syncs a reasoning model with no per-model configuration in the module", () => {
  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  );

  const reasoner = {
    ...merged[1]!,
    capabilities: [...merged[1]!.capabilities, "reasoning"],
  };

  expect(shouldSyncNeosantaraModel(reasoner)).toBe(true);
  expect(buildNeosantaraModel(reasoner, undefined).reasoning_options?.length).toBeGreaterThan(0);
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

test("reports models skipped for want of a canonical entry", () => {
  const merged = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  );

  const unknown = { ...merged[1]!, id: "not-in-the-canonical-tree" };

  expect(shouldSyncNeosantaraModel(unknown)).toBe(false);
  expect(neosantara.sourceID(unknown)).toBe("not-in-the-canonical-tree");
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

test("advertises the host effort enum uniformly for every reasoning model", () => {
  const source = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  )[0]!;
  const enumEffort = [
    { type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  ];

  // Anthropic (lab uses budgets), OpenAI (native effort), and relayed DeepSeek (lab toggle) all
  // resolve to the same mapped surface — the module reads capability, not lab shape.
  for (const id of ["claude-fable-5", "gpt-5.6-terra", "deepseek-v4-pro", "deepseek-v4-flash"]) {
    expect(neosantaraReasoningControls({ ...source, id })).toEqual(enumEffort);
  }
});

test("honors catalog-published effort levels when they appear, filtered to the host enum", () => {
  const source = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  )[0]!;

  // Future catalog: a per-model effort list is honored, and values the host cannot send (`max`)
  // are dropped rather than published.
  const future = { ...source, reasoning_efforts: ["low", "high", "max"] };
  expect(neosantaraReasoningControls(future)).toEqual([
    { type: "effort", values: ["low", "high"] },
  ]);

  // An empty or all-invalid catalog list falls back to the full host enum, never to `[]`.
  expect(neosantaraReasoningControls({ ...source, reasoning_efforts: ["max"] })).toEqual([
    { type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  ]);
});

test("stamps every reasoning TOML with the note explaining the mapped surface", () => {
  const source = mergeNeosantaraCatalogs(
    NeosantaraModelsResponse.parse(modelsResponse),
    NeosantaraPricingResponse.parse(pricingResponse),
  )[0]!;
  const context = { existing: () => undefined, authored: () => undefined };

  // A reasoning model (gemini here) carries the note so a reviewer sees why the shape differs
  // from the upstream provider's own entry.
  const reasoning = neosantara.translateModel(source, context);
  expect(reasoning?.header).toContain("Neosantara relays this model");
  expect(reasoning?.header).toContain("reasoning_effort");

  // A non-reasoning model carries no reasoning note.
  const plain = neosantara.translateModel(
    mergeNeosantaraCatalogs(
      NeosantaraModelsResponse.parse(modelsResponse),
      NeosantaraPricingResponse.parse(pricingResponse),
    )[1]!,
    context,
  );
  expect(plain?.header ?? "").not.toContain("Neosantara relays this model");
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
