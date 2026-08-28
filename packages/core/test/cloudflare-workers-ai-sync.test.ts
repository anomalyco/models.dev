import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import { formatToml, syncProvider, type ExistingModel } from "../src/sync/index.js";
import { cloudflareWorkersAi } from "../src/sync/providers/cloudflare-workers-ai.js";

// Synthetic metadata exercises the sync contract, not a real model's controls.
const model = {
  id: "@cf/example/reasoner",
  name: "Example Reasoner",
  created: 1_787_702_400,
  hugging_face_id: null,
  knowledge_cutoff: null,
  context_length: 128_000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000002" },
  top_provider: { context_length: 128_000, max_completion_tokens: 16_000 },
  supported_parameters: ["reasoning", "tools", "temperature"],
};

function translate(raw: unknown, existing?: ExistingModel) {
  const [parsed] = cloudflareWorkersAi.parseModels(raw);
  return cloudflareWorkersAi.translateModel(parsed!, {
    existing: () => existing,
    authored: () => existing,
  }).model;
}

const inputSchema = {
  anyOf: [{ oneOf: [{
    type: "object",
    properties: {
      reasoning_effort: { anyOf: [{ type: "string", enum: ["low", "medium", "high"] }, { type: "null" }] },
      chat_template_kwargs: {
        type: "object",
        properties: { enable_thinking: { type: "boolean", default: true } },
      },
      max_tokens: { type: "integer", maximum: 16_000 },
    },
  }] }],
};

test("derives effort and toggle controls from the model input schema", () => {
  const synced = translate({ data: [{ ...model, input_schema: inputSchema }] }, { reasoning_options: [] });
  expect(synced.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "medium", "high"] },
  ]);

  const [parsed] = cloudflareWorkersAi.parseModels({ data: [{ ...model, input_schema: inputSchema }] });
  const translated = cloudflareWorkersAi.translateModel(parsed!, {
    existing: () => undefined,
    authored: () => undefined,
  });
  expect(translated.header).toContain("chat_template_kwargs.enable_thinking = true|false");
});

test("reads nested Responses API effort enums without inventing a toggle", () => {
  const synced = translate({ data: [{ ...model, input_schema: {
    oneOf: [{ type: "object", properties: { reasoning: {
      type: "object", properties: { effort: { type: "string", enum: ["low", "high"] } },
    } } }],
  } }] });
  expect(synced.reasoning_options).toEqual([{ type: "effort", values: ["low", "high"] }]);
});

test("refreshes serialized control comments without losing unrelated notes or resyncing forever", async () => {
  const directory = await mkdtemp("/tmp/opencode/workers-schema-");
  const raw = { data: [{ ...model, input_schema: inputSchema }] };
  const file = `${directory}/${model.id}.toml`;
  try {
    await mkdir(`${directory}/@cf/example`, { recursive: true });
    await Bun.write(file, "# Context limit verified separately.\n# Toggle: thinking.type = enabled|disabled\n# Effort: reasoning_effort = high|max\n" + formatToml({ id: model.id, ...translate(raw) }));
    const provider = { ...cloudflareWorkersAi, modelsDir: directory, fetchModels: async () => raw };
    expect((await syncProvider(provider)).updated).toBe(1);
    const written = await Bun.file(file).text();
    expect(written).toContain("# Context limit verified separately.");
    expect(written).toContain("# Toggle: chat_template_kwargs.enable_thinking = true|false");
    expect(written).toContain("# Effort: reasoning_effort = low|medium|high");
    expect(written).not.toContain("thinking.type");
    expect(written).not.toContain("high|max");
    expect((await syncProvider(provider)).updated).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema effort none replaces a separate toggle", () => {
  const synced = translate({ data: [{ ...model, input_schema: { properties: {
    reasoning_effort: { type: "string", enum: ["none", "low", "high"] },
    chat_template_kwargs: { properties: { enable_thinking: { type: "boolean" } } },
  } } }] });
  expect(synced.reasoning_options).toEqual([{ type: "effort", values: ["none", "low", "high"] }]);
});

test.each([
  {},
  { properties: { reasoning_effort: { type: "string" }, max_tokens: { type: "integer", maximum: 1000 } } },
  { properties: { reasoning_effort: { enum: [null, "unsupported"] } } },
  { properties: { chat_template_kwargs: { properties: { enable_thinking: { type: "boolean", const: true } } } } },
])("preserves curated options when schema has no usable controls: %j", (schema) => {
  const options = [{ type: "effort", values: ["high", "max"] }] satisfies ExistingModel["reasoning_options"];
  expect(translate({ data: [{ ...model, input_schema: schema }] }, { reasoning_options: options }).reasoning_options).toEqual(options);
});

test("does not infer reasoning capability from generic schema fields", () => {
  const synced = translate({ data: [{ ...model, supported_parameters: ["tools"], input_schema: inputSchema }] });
  expect(synced.reasoning).toBe(false);
  expect(synced.reasoning_options).toBeUndefined();
});

test.each([
  { name: "success", status: 200, body: { success: true, result: { input: inputSchema } } },
  { name: "HTTP failure", status: 403, body: {} },
  { name: "API failure", status: 200, body: { success: false } },
  { name: "missing input schema", status: 200, body: { success: true, result: {} } },
])("fetches each model schema and fails closed on $name", async ({ status, body }) => {
  const account = process.env.CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN;
  process.env.CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN = "test-token";
  const requested: string[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search")) {
      return Response.json({ data: [model, { ...model, id: "@cf/example/other" }] });
    }
    requested.push(url.searchParams.get("model")!);
    return Response.json(body, { status });
  }) as typeof globalThis.fetch);
  try {
    if (status !== 200 || !("result" in body) || !body.result || !("input" in body.result)) {
      await expect(cloudflareWorkersAi.fetchModels()).rejects.toThrow();
      return;
    }
    const raw = await cloudflareWorkersAi.fetchModels();
    expect(requested.toSorted()).toEqual(["@cf/example/other", model.id]);
    expect(translate(raw).reasoning_options).toEqual([
      { type: "toggle" }, { type: "effort", values: ["low", "medium", "high"] },
    ]);
  } finally {
    fetch.mockRestore();
    if (account === undefined) delete process.env.CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID;
    else process.env.CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID = account;
    if (token === undefined) delete process.env.CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN;
    else process.env.CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN = token;
  }
});

test.each([
  ["direct", (value: unknown) => ({ data: [value] })],
  ["wrapped", (value: unknown) => ({ result: { data: [value] } })],
  ["wrapped array", (value: unknown) => ({ result: [value] })],
] as const)("imports explicit Workers AI reasoning metadata from %s responses", (_, wrap) => {
  const synced = translate(wrap({
    ...model,
    reasoning: { mandatory: true, supported_efforts: ["low", "high", "max"] },
  }));

  expect(synced.reasoning_options).toEqual([
    { type: "effort", values: ["low", "high", "max"] },
  ]);
});

test.each([
  { name: "empty", options: [] },
  { name: "stale", options: [{ type: "effort", values: ["low", "medium", "high"] }] },
] satisfies { name: string; options: ExistingModel["reasoning_options"] }[])("refreshes $name Workers AI options from API metadata", ({ options }) => {
  const synced = translate({ data: [{
    ...model,
    reasoning: { mandatory: true, supported_efforts: ["high", "max"] },
  }] }, {
    reasoning_options: options,
    name: "Curated name",
    limit: { context: 128_000, output: 8_000 },
  });

  expect(synced.reasoning_options).toEqual([{ type: "effort", values: ["high", "max"] }]);
  expect(synced.name).toBe("Curated name");
  expect(synced.limit?.output).toBe(8_000);
});

test("preserves curated Workers AI options when API metadata is absent", () => {
  const options = [{ type: "toggle" }, { type: "budget_tokens", min: 1_024 }] satisfies ExistingModel["reasoning_options"];
  const synced = translate({ data: [model] }, { reasoning_options: options });

  expect(synced.reasoning_options).toEqual(options);
  expect(translate({ data: [model] }).reasoning_options).toBeUndefined();
});

test("imports explicit toggle and budget support without treating completion limits as budgets", () => {
  const synced = translate({ data: [{
    ...model,
    reasoning: {
      mandatory: false,
      supported_efforts: ["low", "high"],
      supports_max_tokens: true,
    },
  }] });

  expect(synced.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "high"] },
    { type: "budget_tokens" },
  ]);
});

test("retains reasoning metadata when normalizing the native Cloudflare response", () => {
  const synced = translate({ data: [{
    id: model.id,
    name: model.name,
    created: model.created,
    context_length: model.context_length,
    max_output_length: 16_000,
    pricing: model.pricing,
    supported_features: ["reasoning", "tools"],
    supported_sampling_parameters: ["temperature"],
    reasoning: { mandatory: false, supported_efforts: ["none", "low", "high"] },
  }] });

  expect(synced.reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "high"] },
  ]);
});

test("does not expand null Cloudflare efforts into OpenRouter's full effort enum", () => {
  const raw = { result: { data: [{
    ...model,
    reasoning: { mandatory: true, supported_efforts: null },
  }] } };
  const options = [{ type: "effort", values: ["low", "high"] }] satisfies ExistingModel["reasoning_options"];

  expect(translate(raw, { reasoning_options: options }).reasoning_options).toEqual(options);
  expect(translate(raw).reasoning_options).toBeUndefined();
});

test.each([
  { reasoning: null },
  { reasoning: { supported_efforts: ["low", "high"] } },
])("preserves curated options for unusable native reasoning metadata: %j", ({ reasoning }) => {
  const options = [{ type: "toggle" }] satisfies ExistingModel["reasoning_options"];
  const synced = translate({ data: [{
    id: model.id,
    name: model.name,
    created: model.created,
    context_length: model.context_length,
    max_output_length: 16_000,
    pricing: model.pricing,
    supported_features: ["reasoning"],
    reasoning,
  }] }, { reasoning_options: options });

  expect(synced.reasoning_options).toEqual(options);
});
