import { expect, test } from "bun:test";

import { groups, providers, type ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  buildMistralModel,
  fetchMistralModels,
  mistral,
  parseMistralModels,
  parseSupportedEfforts,
  type MistralModel,
} from "../src/sync/providers/mistral.js";

function model(overrides: Partial<MistralModel> = {}): MistralModel {
  return {
    id: "mistral-small-2603",
    name: "mistral-small-2603",
    capabilities: {
      completion_chat: true,
      function_calling: true,
      reasoning: true,
      vision: true,
      audio: false,
    },
    max_context_length: 262_144,
    aliases: ["mistral-small-latest"],
    deprecation: null,
    ...overrides,
  };
}

const existingSmall: ExistingModel = {
  name: "Mistral Small 4",
  family: "mistral-small",
  release_date: "2026-03-16",
  last_updated: "2026-03-16",
  attachment: true,
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["none", "high"] }],
  temperature: true,
  tool_call: true,
  open_weights: true,
  cost: { input: 0.15, output: 0.6, cache_read: 0.015 },
  limit: { context: 256_000, output: 256_000 },
  modalities: { input: ["text", "image"], output: ["text"] },
};

const context = (models: Record<string, ExistingModel>) => ({
  existing: (id: string) => models[id],
  authored: (id: string) => models[id],
});

test("Mistral sync is registered for direct and hourly runs", () => {
  expect(providers.mistral).toBe(mistral);
  expect(groups.direct).toContain("mistral");
  expect(mistral.skipCreates).toBe(true);
  expect(mistral.deleteMissing).toBe(false);
});

test("fetches /v1/models with MISTRAL_API_KEY and fails without one", async () => {
  const requests: Array<{ url: string; auth: string | null }> = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ object: "list", data: [model({ capabilities: { ...model().capabilities, reasoning: false } })] });
  }) as typeof fetch;

  await expect(fetchMistralModels("test-key", fetcher)).resolves.toMatchObject({ reasoning_efforts: {} });
  expect(requests).toEqual([{ url: "https://api.mistral.ai/v1/models", auth: "Bearer test-key" }]);
  await expect(fetchMistralModels("", fetcher)).rejects.toThrow("MISTRAL_API_KEY");

  const key = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  try {
    await expect(fetchMistralModels(undefined, fetcher)).rejects.toThrow("MISTRAL_API_KEY");
  } finally {
    if (key !== undefined) process.env.MISTRAL_API_KEY = key;
  }
});

test("probes reasoning efforts once per model and attaches them to every alias", async () => {
  const probes: Array<Record<string, unknown>> = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [
          model(),
          model({ id: "mistral-small-latest" }),
          model({ id: "glm-5-2", name: "glm-5-2" }),
          model({
            id: "mistral-embed",
            name: "mistral-embed",
            capabilities: { ...model().capabilities, completion_chat: false },
          }),
        ],
      });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    probes.push(body);
    if (body.model === "glm-5-2") return Response.json({ choices: [] });
    return Response.json({
      object: "error",
      message: "reasoning_effort minimal is not supported for this model, supported values: [<ReasoningEffort.high: 'high'>, <ReasoningEffort.none: 'none'>]",
    }, { status: 400 });
  }) as typeof fetch;

  const parsed = parseMistralModels(await fetchMistralModels("test-key", fetcher));

  expect(probes).toEqual([
    {
      model: "mistral-small-2603",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "minimal",
      max_tokens: 1,
    },
    expect.objectContaining({ model: "glm-5-2" }),
  ]);
  expect(parsed.map((row) => [row.id, row.reasoning_efforts])).toEqual([
    ["mistral-small-2603", ["none", "high"]],
    ["mistral-small-latest", ["none", "high"]],
    ["glm-5-2", undefined],
    ["mistral-embed", undefined],
  ]);
});

test("parses each reasoning_effort rejection format Mistral returns", () => {
  expect(parseSupportedEfforts(
    "reasoning_effort minimal is not supported for this model, supported values: [<ReasoningEffort.high: 'high'>, <ReasoningEffort.none: 'none'>]",
  )).toEqual(["none", "high"]);
  expect(parseSupportedEfforts(
    "reasoning_effort 'minimal' is not supported for this model; supported values: ['low', 'high', 'max']",
  )).toEqual(["low", "high", "max"]);
  expect(parseSupportedEfforts(
    "reasoning_effort='minimal' is not supported for this model. Must be one of (<ReasoningEffort.none: 'none'>, <ReasoningEffort.high: 'high'>)",
  )).toEqual(["none", "high"]);
  expect(parseSupportedEfforts("reasoning_effort is not enabled for this model")).toEqual([]);
  expect(parseSupportedEfforts("Rate limit exceeded")).toBeUndefined();
  expect(parseSupportedEfforts("supported values: ['turbo']")).toBeUndefined();
});

test("reports each missing chat model once under its canonical row", () => {
  expect(mistral.sourceID(model())).toBe("mistral-small-2603");
  expect(mistral.sourceID(model({ id: "mistral-small-latest" }))).toBeUndefined();
  expect(mistral.sourceID(model({
    id: "mistral-embed-2312",
    name: "mistral-embed-2312",
    capabilities: { ...model().capabilities, completion_chat: false },
  }))).toBeUndefined();
});

test("does not create TOMLs for remote-only models", () => {
  expect(mistral.translateModel(model(), context({}))).toBeUndefined();
});

test("keeps authored non-chat entries untouched", () => {
  const embed: ExistingModel = { ...existingSmall, name: "Mistral Embed", reasoning: false };
  const row = model({
    id: "mistral-embed",
    name: "mistral-embed-2312",
    capabilities: { ...model().capabilities, completion_chat: false, vision: false },
    max_context_length: 8_192,
  });

  expect(mistral.translateModel(row, context({ "mistral-embed": embed }))).toMatchObject({
    id: "mistral-embed",
    model: embed,
  });
});

test("syncs context, tool calling, and image input while preserving pricing and output limits", () => {
  const synced = buildMistralModel(
    model({ capabilities: { ...model().capabilities, function_calling: false } }),
    { ...existingSmall, attachment: false, modalities: { input: ["text"], output: ["text"] } },
  );

  expect(synced).toMatchObject({
    attachment: true,
    tool_call: false,
    cost: existingSmall.cost,
    limit: { context: 262_144, output: 256_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
  });
});

test("removes image input when Mistral no longer reports vision", () => {
  const synced = buildMistralModel(
    model({ capabilities: { ...model().capabilities, vision: false, audio: true } }),
    existingSmall,
  );

  expect(synced).toMatchObject({
    attachment: true,
    modalities: { input: ["text", "audio"] },
  });
});

test("requires authored reasoning controls instead of inventing them", () => {
  const { reasoning_options: _, ...withoutControls } = existingSmall;

  expect(() => buildMistralModel(model(), { ...withoutControls, reasoning: false }))
    .toThrow(MissingReasoningOptionsError);
  expect(buildMistralModel(
    model({ capabilities: { ...model().capabilities, reasoning: false } }),
    existingSmall,
  )).toMatchObject({ reasoning: false, reasoning_options: undefined });
});

test("flags authored reasoning controls that disagree with the live API", () => {
  expect(() => buildMistralModel(
    model({ reasoning_efforts: ["none", "high"] }),
    { ...existingSmall, reasoning_options: [] },
  )).toThrow("Mistral accepts reasoning_effort [none, high] for mistral-small-2603, but the authored reasoning_options effort values are []");
  expect(() => buildMistralModel(
    model({ reasoning_efforts: ["low", "high", "max"] }),
    existingSmall,
  )).toThrow(MissingReasoningOptionsError);

  expect(buildMistralModel(
    model({ reasoning_efforts: ["none", "high"] }),
    { ...existingSmall, reasoning_options: [{ type: "effort", values: ["high", "none"] }] },
  )).toMatchObject({ reasoning: true });
  expect(buildMistralModel(model({ reasoning_efforts: undefined }), existingSmall))
    .toMatchObject({ reasoning: true });
  expect(buildMistralModel(model({ reasoning_efforts: [] }), { ...existingSmall, reasoning_options: [] }))
    .toMatchObject({ reasoning_options: [] });
});

test("maps Mistral deprecation to catalog status", () => {
  expect(buildMistralModel(model({ deprecation: "2026-12-31T00:00:00Z" }), existingSmall))
    .toMatchObject({ status: "deprecated" });
  expect(buildMistralModel(model(), { ...existingSmall, status: "deprecated" }))
    .toMatchObject({ status: undefined });
  expect(buildMistralModel(model(), { ...existingSmall, status: "beta" }))
    .toMatchObject({ status: "beta" });
});

test("keeps docs-deprecated models deprecated when /v1/models omits deprecation", () => {
  const leanstral = model({ id: "labs-leanstral-1-5-1", name: "labs-leanstral-1-5-1", aliases: [] });
  expect(buildMistralModel(leanstral, { ...existingSmall, status: "deprecated" }))
    .toMatchObject({ status: "deprecated" });
  const glm = model({ id: "zai-glm-5-2", name: "glm-5-2", aliases: ["zai-glm-5-2"] });
  expect(buildMistralModel(glm, { ...existingSmall, status: "beta" }))
    .toMatchObject({ status: "deprecated" });
});

test("writes only provider overrides for base_model entries", () => {
  const synced = buildMistralModel(
    model({
      id: "zai-glm-5-3",
      name: "zai-glm-5-3",
      capabilities: { ...model().capabilities, vision: false },
      max_context_length: 1_048_576,
    }),
    {
      ...existingSmall,
      base_model: "zhipuai/glm-5.3",
      name: "GLM-5.3",
      family: "glm",
      release_date: "2026-08-14",
      last_updated: "2026-08-14",
      attachment: false,
      open_weights: true,
      structured_output: true,
      reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      cost: { input: 1.4, output: 4.4, cache_read: 0.14 },
      limit: { context: 1_000_000, output: 131_072 },
      modalities: { input: ["text"], output: ["text"] },
    },
  );

  expect(synced).toMatchObject({
    base_model: "zhipuai/glm-5.3",
    limit: { context: 1_048_576 },
    cost: { input: 1.4, output: 4.4, cache_read: 0.14 },
  });
  expect(synced).not.toHaveProperty("name");
});
