import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";
import * as missingIssues from "../src/sync/missing-issues.js";
import {
  buildCloudflareAiGatewayMediaModel,
  buildCloudflareAiGatewayModel,
  cloudflareAiGateway,
  deriveReasoningOptions,
  gatewayApis,
  mediaCost,
  routeModalities,
} from "../src/sync/providers/cloudflare-ai-gateway.js";

test("missing reasoning controls open issues without deleting existing models or blocking valid ones", async () => {
  const dir = await mkdtemp(path.join(import.meta.dirname, "../../../providers/.reasoning-sync-"));
  const modelsDir = path.join(dir, "models");
  const ids = ["deepreinforce/ornith-1.0-9b", "deepreinforce/ornith-1.0-31b"];
  const file = path.join(modelsDir, `${ids[0]}.toml`);
  const content = '# Keep authored controls\nschema = 2\nbase_model = "deepreinforce/ornith-1.0-9b"\n\n[capabilities]\nreasoning = { supported = true, effort = ["high"] }\n';
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await writeFile(path.join(dir, "provider.toml"), 'name = "Test"\nnpm = "ai-gateway-provider"\nenv = []\n');
  const issues = spyOn(missingIssues, "openMissingModelIssues").mockResolvedValue([]);
  const provider = {
    ...cloudflareAiGateway, modelsDir,
    async fetchModels() {
      return [...ids, "openai/gpt-4.1"].map((model_id) => ({
        catalog: {
          model_id,
          task: "Text Generation",
          provider_details: providerDetails({ input_tokens: 1, output_tokens: 2 }),
        },
      }));
    },
  };
  try {
    const result = await syncProvider(provider, { openIssues: true });
    expect(result).toMatchObject({ created: 1, updated: 0, deleted: 0, unchanged: 1 });
    expect(await readFile(file, "utf8")).toBe(content);
    expect(await Bun.file(path.join(modelsDir, `${ids[1]}.toml`)).exists()).toBe(false);
    expect(issues.mock.calls[0]?.[1]).toEqual(ids);
    expect(issues.mock.calls[0]?.[2]?.reasons?.[ids[0]!]).toContain("reasoning_options");
    await expect(syncProvider({ ...provider, async fetchModels() { throw new Error("fetch failed"); } })).rejects.toThrow("fetch failed");
    expect(issues).toHaveBeenCalledTimes(1);
  } finally {
    issues.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("builds Cloudflare AI Gateway overrides from catalog metadata", () => {
  const model = buildCloudflareAiGatewayModel(
    {
      model_id: "openai/gpt-5.4",
      task: "Text Generation",
      context_length: 1_050_000,
      provider_details: providerDetails({
        under_200k_per_1m_input_tokens: 2.5,
        under_200k_per_1m_output_tokens: 15,
        under_200k_per_1m_input_cached_tokens: 0.25,
        over_200k_per_1m_input_tokens: 5,
        over_200k_per_1m_output_tokens: 22.5,
        over_200k_per_1m_input_cached_tokens: 0.5,
      }),
    },
    undefined,
    {
      reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
    },
  );

  expect(model).toEqual({
    base_model: "openai/gpt-5.4",
    reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
    cost: {
      input: 2.5,
      output: 15,
      cache_read: 0.25,
      tiers: [{
        tier: { type: "context", size: 200_000 },
        input: 5,
        output: 22.5,
        cache_read: 0.5,
      }],
    },
    limit: { context: 1_050_000 },
    provider: {
      npm: "@ai-sdk/openai",
      api: "https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}/openai",
    },
  });
});

test("maps structured provider pricing instead of display labels", () => {
  const model = buildCloudflareAiGatewayModel(
    {
      model_id: "openai/gpt-6-astra",
      task: "Text Generation",
      context_length: 1_050_000,
      pricing: { "Display label that may change": 999 },
      provider_details: providerDetails({
        long_context_threshold_tokens: 272_000,
        short_context_input_tokens: 10,
        short_context_input_cached_tokens: 1,
        short_context_input_cache_creation_tokens: 12,
        short_context_output_tokens: 50,
        long_context_input_tokens: 20,
        long_context_input_cached_tokens: 2,
        long_context_input_cache_creation_tokens: 25,
        long_context_output_tokens: 75,
      }),
    },
    undefined,
    {
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    },
  );

  expect(model.cost).toEqual({
    input: 10,
    output: 50,
    cache_read: 1,
    cache_write: 12,
    tiers: [{
      tier: { type: "context", size: 272_000 },
      input: 20,
      output: 75,
      cache_read: 2,
      cache_write: 25,
    }],
  });
});

test("drops a context tier whose prices equal the base", () => {
  const model = buildCloudflareAiGatewayModel({
    model_id: "unbiased/pareto",
    task: "Text Generation",
    provider_details: providerDetails({
      under_200k_per_1m_input_tokens: 0.5,
      under_200k_per_1m_input_cached_tokens: 0.05,
      under_200k_per_1m_output_tokens: 3,
      over_200k_per_1m_input_tokens: 0.5,
      over_200k_per_1m_input_cached_tokens: 0.05,
      over_200k_per_1m_output_tokens: 3,
    }),
  }, undefined);
  expect(model.cost).toEqual({ input: 0.5, output: 3, cache_read: 0.05 });
});

test("derives nested Cloudflare effort values without inventing a toggle", () => {
  expect(deriveReasoningOptions({
    properties: {
      thinking: { type: "boolean" },
      reasoning: {
        properties: {
          effort: {
            anyOf: [{ enum: ["low", "medium", "high"] }],
          },
        },
      },
    },
  })).toEqual([{ type: "effort", values: ["low", "medium", "high"] }]);
});

test("does not turn Opus 5.5's adaptive-only thinking schema into an off switch", () => {
  const schema = {
    properties: {
      thinking: {
        type: "object",
        properties: { type: { type: "string", const: "adaptive" } },
      },
      output_config: {
        properties: { effort: { enum: ["low", "medium", "high", "xhigh", "max"] } },
      },
    },
  };
  expect(deriveReasoningOptions(schema)).toEqual([
    { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
  ]);
  expect(buildCloudflareAiGatewayModel({
    model_id: "anthropic/claude-opus-5.5",
    task: "Text Generation",
    provider_details: providerDetails({ input_tokens: 4, output_tokens: 20 }),
  }, schema).reasoning_options).toEqual([
    { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
  ]);
});

test("requires curation rather than inferring a toggle from a thinking field", () => {
  expect(deriveReasoningOptions({
    properties: { thinking: { type: "object" } },
  })).toEqual([]);
  expect(deriveReasoningOptions({
    properties: { thinking: { properties: { type: { enum: ["adaptive", "disabled"] } } } },
  })).toEqual([]);
  expect(deriveReasoningOptions({
    properties: { enable_thinking: { type: "boolean" } },
  })).toEqual([]);
  expect(() => buildCloudflareAiGatewayModel({
    model_id: "anthropic/claude-opus-5.5",
    task: "Text Generation",
    provider_details: providerDetails({ input_tokens: 4, output_tokens: 20 }),
  }, { properties: { thinking: { type: "object" } } })).toThrow("no reasoning_options");
  expect(buildCloudflareAiGatewayModel({
    model_id: "alibaba/qwen3.7-plus",
    task: "Text Generation",
    provider_details: providerDetails({ input_tokens: 1, output_tokens: 2 }),
  }, { properties: { enable_thinking: { type: "boolean" } } }, {
    reasoning_options: [{ type: "toggle" }],
  }).reasoning_options).toEqual([{ type: "toggle" }]);
});

test("uses Cloudflare's curated route controls for Kimi K3 and Fireworks DeepSeek V4 Pro", () => {
  const translate = (model_id: string) => cloudflareAiGateway.translateModel({
    catalog: {
      model_id,
      task: "Text Generation" as const,
      provider_details: providerDetails({ input_tokens: 1, output_tokens: 2 }),
    },
  }, { authored: () => undefined, existing: () => undefined }).model.reasoning_options;

  expect(translate("moonshotai/kimi-k3")).toEqual([
    { type: "effort", values: ["none", "low", "high", "max"] },
  ]);
  // The catalog schema's generic reasoning.effort enum (none..max) is not what Muse Spark 1.1
  // accepts on this route; the curated list overrides it.
  expect(cloudflareAiGateway.translateModel({
    catalog: {
      model_id: "meta/muse-spark-1.1",
      task: "Text Generation" as const,
      provider_details: providerDetails({ input_tokens: 1, output_tokens: 2 }),
    },
    schemaInput: { properties: { reasoning: { properties: { effort: { enum: ["none", "low", "medium", "high", "xhigh", "max"] } } } } },
  }, { authored: () => undefined, existing: () => undefined }).model.reasoning_options).toEqual([
    { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] },
  ]);
  expect(translate("deepseek/deepseek-v4-pro")).toEqual([
    { type: "effort", values: ["none", "low", "high", "max"] },
  ]);
  expect(translate("anthropic/claude-sonnet-5")).toContainEqual({ type: "toggle" });
  expect(translate("alibaba/qwen3.8-max")).toContainEqual({ type: "toggle" });
});

test("writes family prefix notes before a model's own note", () => {
  const curation = Bun.TOML.parse(
    readFileSync(path.join(import.meta.dirname, "../../../providers/cloudflare-ai-gateway/curation.toml"), "utf8"),
  ) as { prefix_notes: Record<string, string[]>; models: Record<string, { note?: string[] }> };
  const header = (model_id: string) => cloudflareAiGateway.translateModel({
    catalog: {
      model_id,
      task: "Text Generation" as const,
      provider_details: providerDetails({ input_tokens: 1, output_tokens: 2 }),
    },
  }, { authored: () => undefined, existing: () => undefined }).header;
  const lines = (notes: string[]) => notes.map((line) => `# ${line}\n`).join("");

  expect(header("moonshotai/kimi-k3")).toBe(
    lines([...curation.prefix_notes["moonshotai/"]!, ...curation.models["moonshotai/kimi-k3"]!.note!]),
  );
  expect(header("meta/muse-spark-open")).toStartWith(lines(curation.prefix_notes["meta/muse-spark-open"]!));
  expect(header("xai/grok-4.20-0309-non-reasoning")).toBe(lines(curation.prefix_notes["xai/"]!));
});

test("ignores advertised reasoning controls for non-reasoning base models", () => {
  const model = buildCloudflareAiGatewayModel(
    {
      model_id: "openai/gpt-4.1",
      task: "Text Generation",
      context_length: 1_047_576,
      provider_details: providerDetails({ input_tokens: 2, output_tokens: 8 }),
    },
    {
      properties: {
        reasoning_effort: { enum: ["low", "medium", "high"] },
      },
    },
  );

  expect(model.reasoning_options).toBeUndefined();
});

test("uses curated cost only when provider_details is null", () => {
  const curated = {
    base_model: "reflection/beam-1.0-501b-a23b",
    reasoning_options: [{ type: "effort" as const, values: ["low" as const, "medium" as const, "high" as const, "xhigh" as const, "max" as const] }],
    interleaved: { field: "reasoning_content" as const },
    cost: { input: 0, output: 0, cache_read: 0 },
  };
  const catalog = {
    model_id: "reflection-ai/beam-1.0-501b-a23b",
    task: "Text Generation" as const,
    context_length: 262_144,
    provider_details: null,
    pricing: { "Input tokens (per 1M)": 999, "Output tokens (per 1M)": 999 },
  };

  expect(buildCloudflareAiGatewayModel(catalog, undefined, curated)).toEqual({
    base_model: "reflection/beam-1.0-501b-a23b",
    interleaved: { field: "reasoning_content" },
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    cost: { input: 0, output: 0, cache_read: 0 },
    limit: { context: 262_144 },
  });
  expect(() => buildCloudflareAiGatewayModel(catalog, undefined, { ...curated, cost: undefined }))
    .toThrow("no provider_details pricing; add a curated cost");
  expect(() => buildCloudflareAiGatewayModel({
    ...catalog,
    provider_details: providerDetails({ input_tokens: 1, output_tokens: 2 }),
  }, undefined, curated)).toThrow("remove the curated cost");
});

test("names the catalog model when an entry fails validation", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  globalThis.fetch = async () => new Response(JSON.stringify(catalogPage([{
    model_id: "openai/gpt-4.1",
    task: "Text Generation",
    provider_details: [],
  }])));

  try {
    await expect(cloudflareAiGateway.fetchModels()).rejects.toThrow("openai/gpt-4.1: invalid catalog entry");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("fails closed on unknown pricing fields", () => {
  expect(() => buildCloudflareAiGatewayModel({
    model_id: "openai/gpt-4.1",
    task: "Text Generation",
    context_length: 1_047_576,
    provider_details: providerDetails({
      input_tokens: 2,
      output_tokens: 8,
      new_billing_unit: 1,
    }),
  }, undefined)).toThrow("unsupported structured pricing");
});

test("fails closed when Cloudflare pagination is incomplete", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  let page = 0;
  globalThis.fetch = async () => new Response(JSON.stringify(catalogPage(
    page++ === 0
      ? [{
        model_id: "openai/gpt-4.1",
        task: "Text Generation",
        context_length: 1_047_576,
        pricing: {
          "Input tokens (per 1M)": 2,
          "Output tokens (per 1M)": 8,
        },
      }]
      : [],
    { page, total_count: 2 },
  )));

  try {
    await expect(cloudflareAiGateway.fetchModels()).rejects.toThrow("pagination ended at 1/2");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("rejects unsafe catalog model paths", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  globalThis.fetch = async () => new Response(JSON.stringify(catalogPage([{
      model_id: "../providers/openai/models/gpt-4.1",
      task: "Text Generation",
      context_length: 1_047_576,
      pricing: {
        "Input tokens (per 1M)": 2,
        "Output tokens (per 1M)": 8,
      },
    }])));

  try {
    await expect(cloudflareAiGateway.fetchModels()).rejects.toThrow("safe relative provider/model path");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("rejects a catalog with no eligible proxied models", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  globalThis.fetch = async () => new Response(JSON.stringify(catalogPage([{
    model_id: "@cf/meta/llama-3.1-8b-instruct",
    task: "Text Generation",
  }])));

  try {
    await expect(cloudflareAiGateway.fetchModels()).rejects.toThrow("no eligible proxied models");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("syncs Jev through shared TypeSafe metadata without inventing tool support", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/schema")) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(catalogPage([
      {
        model_id: "typesafe/jev",
        task: "Text Generation",
        context_length: 32_000,
        provider_details: providerDetails({ input_tokens: 0.042, output_tokens: 0 }),
      },
      {
        model_id: "openai/gpt-4.1",
        task: "Text Generation",
        context_length: 1_047_576,
        provider_details: providerDetails({ input_tokens: 2, output_tokens: 8 }),
      },
    ])));
  };

  try {
    const models = await cloudflareAiGateway.fetchModels();
    expect(models.map((model) => model.catalog.model_id)).toEqual(["typesafe/jev", "openai/gpt-4.1"]);
    expect(cloudflareAiGateway.translateModel(models[0]!, {
      existing: () => undefined,
      authored: () => undefined,
    }).model).toEqual({
      base_model: "typesafe/jev-latest",
      cost: { input: 0.042, output: 0 },
      limit: { context: 32_000 },
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("syncs Pareto through shared Unbiased metadata", () => {
  expect(buildCloudflareAiGatewayModel({
    model_id: "unbiased/pareto",
    task: "Text Generation",
    context_length: 262_144,
    provider_details: providerDetails({
      input_tokens: 2.5,
      output_tokens: 7.5,
      input_cached_tokens: 0.25,
    }),
  }, undefined)).toEqual({
    base_model: "unbiased/pareto",
    cost: { input: 2.5, output: 7.5, cache_read: 0.25 },
    limit: { context: 262_144 },
  });
});

test("validates Cloudflare page metadata", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  globalThis.fetch = async () => new Response(JSON.stringify(catalogPage([], { page: 2, total_count: 0 })));

  try {
    await expect(cloudflareAiGateway.fetchModels()).rejects.toThrow("expected page 1, got 2");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("retries transient Cloudflare responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  let catalogRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/schema")) return new Response(null, { status: 404 });
    catalogRequests++;
    if (catalogRequests === 1) return new Response(null, { status: 503, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify(catalogPage([{
      model_id: "openai/gpt-4.1",
      task: "Text Generation",
      context_length: 1_047_576,
      provider_details: providerDetails({ input_tokens: 2, output_tokens: 8 }),
    }])));
  };

  try {
    expect(await cloudflareAiGateway.fetchModels()).toHaveLength(1);
    expect(catalogRequests).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("replaces a stale generated base-model mapping", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".base-model-sync-"));
  const modelsDir = path.join(providerDir, "models");
  await mkdir(modelsDir);
  const file = path.join(modelsDir, "model.toml");
  await writeFile(file, 'schema = 2\nbase_model = "anthropic/claude-opus-4-6"\n');

  try {
    const provider = {
      id: "base-model-test",
      name: "Base-model test",
      modelsDir,
      async fetchModels() {
        return [{ id: "model" }];
      },
      parseModels(raw: unknown) {
        return raw as Array<{ id: string }>;
      },
      translateModel(model: { id: string }) {
        return { id: model.id, model: { base_model: "openai/gpt-4.1" } };
      },
    };
    await syncProvider(provider);
    expect(await readFile(file, "utf8")).toContain('base_model = "openai/gpt-4.1"');
  } finally {
    await rm(providerDir, { recursive: true, force: true });
  }
});

test("reconciles authoritative generated headers", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".cloudflare-ai-gateway-sync-"));
  const modelsDir = path.join(providerDir, "models");
  await mkdir(modelsDir);
  const file = path.join(modelsDir, "gpt-4.1.toml");
  await writeFile(file, "# Old note\n\nschema = 2\nbase_model = \"openai/gpt-4.1\"\n");

  try {
    const provider = {
      id: "cloudflare-ai-gateway-test",
      name: "Cloudflare AI Gateway test",
      modelsDir,
      authoritativeHeaders: true,
      async fetchModels() {
        return [{ id: "gpt-4.1" }];
      },
      parseModels() {
        return [{ id: "gpt-4.1" }];
      },
      translateModel(model) {
        return {
          id: model.id,
          model: { base_model: "openai/gpt-4.1" },
          header: "# New note\n\n",
        };
      },
    };
    const result = await syncProvider(provider);

    expect(result.updated).toBe(1);
    expect(await readFile(file, "utf8")).toStartWith("# New note\nschema = 2\nbase_model");
    expect((await syncProvider(provider)).updated).toBe(0);
  } finally {
    await rm(providerDir, { recursive: true, force: true });
  }
});

test("writes new native-route models as v2 files with their API protocol", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".cloudflare-ai-gateway-v2-"));
  const modelsDir = path.join(providerDir, "models");
  await mkdir(path.join(modelsDir, "openai"), { recursive: true });
  await writeFile(path.join(providerDir, "provider.toml"), 'name = "Test"\nnpm = "ai-gateway-provider"\nenv = []\n');
  const existing = 'schema = 2\nbase_model = "openai/gpt-4.1"\n\n[capabilities]\nsystem_updates = true\n\n'
    + '[api.responses]\nsdk = { aisdk = "@ai-sdk/openai" }\n';
  await writeFile(path.join(modelsDir, "openai", "gpt-4.1.toml"), existing);

  try {
    const provider = {
      ...cloudflareAiGateway,
      modelsDir,
      async fetchModels() {
        return ["openai/gpt-4.1", "anthropic/claude-opus-4.7", "openai/gpt-5.5"].map((model_id) => ({
          catalog: {
            model_id,
            task: "Text Generation",
            provider_details: providerDetails({ input_tokens: 1, output_tokens: 2 }),
          },
        }));
      },
    };
    const result = await syncProvider(provider);

    expect(result.notices ?? []).toEqual([]);
    const opus = await readFile(path.join(modelsDir, "anthropic", "claude-opus-4.7.toml"), "utf8");
    expect(opus).toContain("\nschema = 2\n");
    const opencodeai = 'opencodeai = "@opencode/ai/providers/cloudflare-ai-gateway"';
    const native = "https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}";
    expect(opus).toContain(`[api.messages]\nbase_url = "${native}/anthropic/v1"\nsdk = { aisdk = "@ai-sdk/anthropic", ${opencodeai} }`);
    const gpt = await readFile(path.join(modelsDir, "openai", "gpt-5.5.toml"), "utf8");
    expect(gpt).toContain(`[api.responses]\nbase_url = "${native}/openai"\nsdk = { aisdk = "@ai-sdk/openai", ${opencodeai} }`);
    // An existing table gets the OpenCode package too, and keeps its other v2 data.
    const updated = await readFile(path.join(modelsDir, "openai", "gpt-4.1.toml"), "utf8");
    expect(updated).toContain("system_updates = true");
    expect(updated).toContain(`base_url = "${native}/openai"\nsdk = { aisdk = "@ai-sdk/openai", ${opencodeai} }`);
    expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0 });
  } finally {
    await rm(providerDir, { recursive: true, force: true });
  }
});

test("refuses to write through a symlinked model directory", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".sync-symlink-"));
  const outsideDir = await mkdtemp(path.join(providersDir, ".sync-outside-"));
  const modelsDir = path.join(providerDir, "models");
  await mkdir(modelsDir);
  await symlink(outsideDir, path.join(modelsDir, "linked"));

  try {
    const provider = {
      id: "symlink-test",
      name: "Symlink test",
      modelsDir,
      async fetchModels() {
        return [{ id: "linked/model" }];
      },
      parseModels(raw: unknown) {
        return raw as Array<{ id: string }>;
      },
      translateModel(model: { id: string }) {
        return { id: model.id, model: { base_model: "openai/gpt-4.1" } };
      },
    };
    await expect(syncProvider(provider)).rejects.toThrow("Refusing to sync through symlink");
    expect(await Bun.file(path.join(outsideDir, "model.toml")).exists()).toBe(false);
  } finally {
    await rm(providerDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("refuses a symlinked models root", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".sync-root-"));
  const outsideDir = await mkdtemp(path.join(providersDir, ".sync-root-outside-"));
  const modelsDir = path.join(providerDir, "models");
  await symlink(outsideDir, modelsDir);

  try {
    const provider = testSyncProvider(modelsDir, "model");
    await expect(syncProvider(provider)).rejects.toThrow("Refusing to sync through symlink");
    expect(await Bun.file(path.join(outsideDir, "model.toml")).exists()).toBe(false);
  } finally {
    await rm(providerDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("syncs speech, transcription, image and video tasks as media sources and leaves other tasks out", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/schema")) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(catalogPage([
      { model_id: "openai/gpt-4.1", task: "Text Generation", provider_details: providerDetails({ input_tokens: 2, output_tokens: 8 }) },
      { model_id: "openai/tts-1", task: "Text-to-Speech", provider_details: providerDetails({ input_characters: 0.000015 }) },
      { model_id: "openai/gpt-4o-transcribe", task: "Automatic Speech Recognition", provider_details: providerDetails({ input_audio_minutes: 0.006 }) },
      { model_id: "openai/gpt-image-2", task: "Text-to-Image", provider_details: providerDetails({ output_image_tokens: 30 }) },
      { model_id: "elevenlabs/music-v2", task: "Music Generation", provider_details: providerDetails({ output_audio_seconds: 0.0025 }) },
      { model_id: "elevenlabs/eleven-flash-v2-5", task: "Text-to-Speech", provider_details: providerDetails({ input_characters: 0.00005 }) },
      { model_id: "example/hologram", task: "Text-to-Hologram", provider_details: providerDetails({}) },
    ])));
  };

  try {
    const models = await cloudflareAiGateway.fetchModels();
    expect(models.map((model) => model.catalog.model_id)).toEqual([
      "openai/gpt-4.1",
      "openai/tts-1",
      "openai/gpt-4o-transcribe",
      "openai/gpt-image-2",
    ]);
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      "warning: unknown Cloudflare AI Gateway catalog task: Text-to-Hologram",
    );
    const context = { existing: () => undefined, authored: () => undefined };
    const speech = cloudflareAiGateway.translateModel(models[1]!, context) as { v2: Record<string, unknown>; header?: string };
    expect(speech.v2).toEqual({
      schema: 2,
      v2_only: true,
      base_model: "openai/tts-1",
      api: {
        "workers-ai-run": {
          base_url: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai",
          sdk: { opencodeai: "none" },
        },
      },
      cost: { text: { input: { unit: "character", price: 15 } } },
    });
    expect(speech.header).toContain("POST /ai/run");
    const transcription = cloudflareAiGateway.translateModel(models[2]!, context) as { v2: Record<string, unknown> };
    expect(transcription.v2.cost).toEqual({ audio: { input: { unit: "minute", price: 0.006 } } });
  } finally {
    globalThis.fetch = originalFetch;
    warn.mockRestore();
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("maps media catalog ids to labs of the task's type", () => {
  const build = (model_id: string, task: string, curated = {}) => buildCloudflareAiGatewayMediaModel(
    { model_id, task, name: "Catalog name", provider_details: providerDetails({ input_characters: 0.0001 }) },
    undefined,
    curated,
  ).doc;
  // Punctuation-insensitive match inside the lab directory; same slug, so no name override.
  expect(build("elevenlabs/eleven-v3", "Text-to-Speech").base_model).toBe("elevenlabs/eleven_v3");
  expect(build("elevenlabs/eleven-v3", "Text-to-Speech").name).toBeUndefined();
  // A curated alias keeps Cloudflare's name, since its id doesn't match the lab's.
  expect(build("xai/grok-stt", "Automatic Speech Recognition", { base_model: "xai/grok-voice-transcribe-2.0" }).name)
    .toBe("Catalog name");
  // ...but not when it's only the lab's name with a vendor prefix.
  expect(buildCloudflareAiGatewayMediaModel(
    { model_id: "inworld/tts-1.5-max", task: "Text-to-Speech", name: "Inworld TTS-1.5 Max", provider_details: providerDetails({ input_characters: 0.000035 }) },
    undefined,
    { base_model: "inworld/inworld-tts-1.5-max" },
  ).doc.name).toBeUndefined();
  expect(() => build("openai/gpt-4.1", "Text-to-Speech")).toThrow("is a chat model, not speech");
  expect(() => build("example/unknown-voice", "Text-to-Speech")).toThrow("no lab file and no curated base_model");
});

test("skips a new catalog model with no lab file instead of failing the sync", () => {
  const translate = (model_id: string, authored?: object) => cloudflareAiGateway.translateModel({
    catalog: { model_id, task: "Text Generation" as const, provider_details: providerDetails({ input_tokens: 1, output_tokens: 2 }) },
  }, { authored: () => authored as never, existing: () => undefined });
  expect(translate("example/unknown-model")).toBeUndefined();
  expect(() => translate("example/unknown-model", { base_model: "example/gone" })).toThrow("no lab file and no curated base_model");
});

test("reads route modalities from the media request schema", () => {
  const lab = { modalities: { input: ["text"], output: ["audio/wav", "audio/mpeg", "audio/ogg", "audio/flac"] } };
  // Format names map to the lab's own MIME spelling (Ogg Opus is audio/ogg here).
  expect(routeModalities("speech", {
    properties: { output_format: { type: "string", enum: ["mp3", "opus", "wav", "flac"] } },
  }, lab)).toEqual({ input: ["text"], output: ["audio/mpeg", "audio/ogg", "audio/wav", "audio/flac"] });
  expect(routeModalities("speech", {
    properties: { output_format: { enum: ["mp3_44100_128", "opus_48000_64"] } },
  }, { modalities: { input: ["text"], output: ["audio/opus"] } })).toEqual({ input: ["text"], output: ["audio/mpeg", "audio/opus"] });
  expect(routeModalities("speech", {
    properties: { output_format: { type: "object", properties: { codec: { enum: ["mp3", "mulaw", "ulaw", "alaw"] } } } },
  }, lab)).toEqual({ input: ["text"], output: ["audio/mpeg", "audio/basic", "audio/alaw"] });
  expect(routeModalities("speech", { properties: { text: { type: "string" } } }, lab)).toBeUndefined();
  expect(() => routeModalities("speech", { properties: { format: { enum: ["midi"] } } }, lab)).toThrow('unknown audio output format "midi"');

  expect(routeModalities("transcription", {
    properties: {
      file: { description: "Audio as a data URI or HTTPS URL. Supported formats: flac, mp3, mpga, m4a, wav." },
      prompt: { type: "string" },
    },
  }, { modalities: { input: ["text", "audio/pcm"], output: ["text"] } })).toEqual({
    input: ["text", "audio/flac", "audio/mpeg", "audio/mp4", "audio/wav"],
    output: ["text"],
  });
  expect(routeModalities("transcription", {
    properties: { file: { description: "Supported container formats: ogg, aac. Raw formats (pcm, mulaw) also accepted." } },
  }, { modalities: { input: ["audio/ogg"], output: ["text"] } })).toEqual({
    input: ["audio/ogg", "audio/aac", "audio/pcm", "audio/basic"],
    output: ["text"],
  });
  expect(routeModalities("transcription", { properties: { audio_url: { description: "The URL of the audio." } } }, lab))
    .toBeUndefined();
});

test("maps media pricing patterns to typed v2 costs", () => {
  expect(mediaCost({ input_characters: 0.00005 })).toEqual({
    cost: { text: { input: { unit: "character", price: 50 } } },
  });
  // Mode prices replace the per-minute base.
  expect(mediaCost({ input_audio_minutes: 0.001667, input_audio_minutes_streaming: 0.003334 })).toEqual({
    cost: { audio: { input: { unit: "minute", price: 0.001667, overrides: [{ when: { websocket: { equals: true } }, price: 0.003334 }] } } },
  });
  // Feature surcharges add up, so each combination gets its total.
  expect(mediaCost({
    input_audio_minutes: 0.0035,
    input_audio_minutes_speaker_diarization: 0.0003,
    input_audio_minutes_keyterms: 0.00083,
  }).cost?.audio?.input?.overrides).toEqual([
    { when: { speaker_labels: { equals: true } }, price: 0.0038 },
    { when: { keyterms_prompt: { min_items: 1 } }, price: 0.00433 },
    { when: { all: [{ speaker_labels: { equals: true } }, { keyterms_prompt: { min_items: 1 } }] }, price: 0.00463 },
  ]);
  // Token prices are already per 1M tokens.
  expect(mediaCost({
    input_text_tokens: 0.5,
    input_cached_tokens: 0.125,
    input_audio_tokens: 3,
    output_audio_tokens: 9,
    output_text_tokens: 4.5,
    output_reasoning_tokens: 4.5,
  })).toEqual({
    cost: {
      text: { input: { price: 0.5, cache: { read: 0.125 } }, output: { price: 4.5, reasoning: 4.5 } },
      audio: { input: { price: 3 }, output: { price: 9 } },
    },
  });
  // Anything that doesn't map leaves the whole cost out and is reported.
  expect(mediaCost({ total_audio_minutes: 0.05, input_text_messages: 0.004 })).toEqual({
    unpriced: ["total_audio_minutes", "input_text_messages"],
  });
  expect(mediaCost({ input_characters: 0.00001, units: 0.12 })).toEqual({ unpriced: ["units"] });
  expect(mediaCost({ input_cached_tokens: 0.1, output_audio_tokens: 9 })).toEqual({ unpriced: ["input_cached_tokens"] });
  expect(mediaCost({ input_audio_minutes_medical: 0.0025 })).toEqual({ unpriced: ["input_audio_minutes_medical"] });
});

test("writes media models as v2-only files and a second sync is a no-op", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".cloudflare-ai-gateway-media-"));
  const modelsDir = path.join(providerDir, "models");
  await mkdir(path.join(modelsDir, "openai"), { recursive: true });
  await writeFile(path.join(providerDir, "provider.toml"), 'name = "Test"\nnpm = "ai-gateway-provider"\nenv = []\n');
  await writeFile(
    path.join(modelsDir, "openai", "gpt-4.1.toml"),
    'schema = 2\nbase_model = "openai/gpt-4.1"\n\n[api.responses]\nsdk = { aisdk = "@ai-sdk/openai" }\n',
  );

  try {
    const provider = {
      ...cloudflareAiGateway,
      modelsDir,
      async fetchModels() {
        return [
          { catalog: { model_id: "openai/gpt-4.1", task: "Text Generation", provider_details: providerDetails({ input_tokens: 2, output_tokens: 8 }) } },
          {
            catalog: { model_id: "openai/tts-1", task: "Text-to-Speech", provider_details: providerDetails({ input_characters: 0.000015 }) },
            schemaInput: { properties: { response_format: { enum: ["mp3", "wav"] } } },
          },
        ];
      },
    };
    const first = await syncProvider(provider);
    expect(first.notices).toEqual([]);
    expect(first.created).toBe(1);
    const tts = await readFile(path.join(modelsDir, "openai", "tts-1.toml"), "utf8");
    expect(tts).toContain('\nschema = 2\nv2_only = true\nbase_model = "openai/tts-1"\n');
    expect(tts).toContain('[modalities]\ninput = ["text"]\noutput = ["audio/mpeg", "audio/wav"]');
    expect(tts).toContain("[api.workers-ai-run]");
    expect(tts).toContain('[api.workers-ai-run]\nbase_url = "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai"\nsdk = { opencodeai = "none" }\n');
    expect(tts).toContain('[cost.text.input]\nunit = "character"\nprice = 15\n');
    const second = await syncProvider(provider);
    expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0 });
  } finally {
    await rm(providerDir, { recursive: true, force: true });
  }
});

test("turns off tools and reasoning controls the /ai/run image route doesn't take", () => {
  const { doc } = buildCloudflareAiGatewayMediaModel(
    { model_id: "google/nano-banana-2-lite", task: "Text-to-Image", provider_details: providerDetails({ input_tokens: 0.25, output_tokens: 30 }) },
    { properties: { prompt: {}, image_input: {}, output_format: { enum: ["jpg", "png"] } } },
    { base_model: "google/gemini-3.1-flash-lite-image", output_tokens: "image" },
  );
  expect(doc.capabilities).toEqual({ tools: { supported: false }, reasoning: { supported: true } });
  expect(doc.cost).toEqual({ text: { input: { price: 0.25 } }, image: { output: { price: 30 } } });
});

test("maps image pricing patterns to typed v2 costs", () => {
  expect(mediaCost({ output_image_count: 0.04, input_image_count: 0.01 }, "image")).toEqual({
    cost: { image: { input: { unit: "image", price: 0.01 }, output: { unit: "image", price: 0.04 } } },
  });
  // Size prices become resolution overrides, spelled as the request schema spells them.
  expect(mediaCost(
    { output_image_count: 0.03, output_size_1k: 0.03, output_size_2k: 0.06 },
    "image",
    undefined,
    { properties: { resolution: { enum: ["1K", "2K"] } } },
  )).toEqual({
    cost: { image: { output: { unit: "image", price: 0.03, overrides: [{ when: { resolution: { equals: "2K" } }, price: 0.06 }] } } },
  });
  expect(mediaCost({ first_output_megapixel: 0.05, subsequent_output_megapixel: 0.05, input_megapixel: 0.05 }, "image")).toEqual({
    cost: { image: { input: { unit: "megapixel", price: 0.05 }, output: { unit: "megapixel", price: 0.05 } } },
  });
  // A first megapixel priced apart from the rest has no unit.
  expect(mediaCost({ first_output_megapixel: 0.07, subsequent_output_megapixel: 0.03, input_megapixel: 0.03 }, "image")).toEqual({
    unpriced: ["first_output_megapixel", "subsequent_output_megapixel"],
  });
  expect(mediaCost({ mp_1_4: 0.005, mp_5_8: 0.01, mp_9_16: 0.02 }, "image")).toEqual({
    cost: {
      image: {
        output: {
          unit: "image",
          price: 0.005,
          overrides: [{ when: { megapixels: { gte: 5 } }, price: 0.01 }, { when: { megapixels: { gte: 9 } }, price: 0.02 }],
        },
      },
    },
  });
  // A bare output_tokens price on an image model needs curation to say which modality it bills.
  expect(mediaCost({ input_tokens: 0.3, output_tokens: 30 }, "image")).toEqual({ unpriced: ["output_tokens"] });
  expect(mediaCost({ input_tokens: 0.3, output_tokens: 30 }, "image", "image")).toEqual({
    cost: { text: { input: { price: 0.3 } }, image: { output: { price: 30 } } },
  });
});

test("maps video pricing patterns to per-second costs with overrides", () => {
  expect(mediaCost({ default: 0.4, "720p": 0.2, "720p_audio": 0.4, "4k_audio": 0.6 }, "video")).toEqual({
    cost: {
      video: {
        output: {
          unit: "second",
          price: 0.4,
          overrides: [
            { when: { all: [{ resolution: { equals: "720p" } }, { generate_audio: { equals: false } }] }, price: 0.2 },
            { when: { all: [{ resolution: { equals: "4k" } }, { generate_audio: { equals: true } }] }, price: 0.6 },
          ],
        },
      },
    },
  });
  // Clip prices for fixed lengths become per-second prices for that length; input video and
  // draft mode are conditions too.
  expect(mediaCost(
    { default: 0.047, "768p_6s": 0.28, "720p_video_in": 0.372, "720p_non_video_in": 0.15, "720p_draft": 0.005 },
    "video",
    undefined,
    { properties: { resolution: { enum: ["768P", "720p"] } } },
  ).cost?.video?.output?.overrides).toEqual([
    { when: { all: [{ resolution: { equals: "768P" } }, { duration: { equals: 6 } }] }, price: 0.0466666667 },
    { when: { all: [{ resolution: { equals: "720p" } }, { input_video: { equals: true } }] }, price: 0.372 },
    { when: { all: [{ resolution: { equals: "720p" } }, { input_video: { equals: false } }] }, price: 0.15 },
    { when: { all: [{ resolution: { equals: "720p" } }, { mode: { equals: "draft" } }] }, price: 0.005 },
  ]);
  // Overrides at the base price are dropped, unless they undo a broader one.
  expect(mediaCost({ default: 0.08, "768p": 0.08, "2k": 0.13 }, "video").cost?.video?.output?.overrides).toEqual([
    { when: { resolution: { equals: "2k" } }, price: 0.13 },
  ]);
  expect(mediaCost({ default: 0.4, "720p": 0.2, "720p_audio": 0.4 }, "video").cost?.video?.output?.overrides).toEqual([
    { when: { all: [{ resolution: { equals: "720p" } }, { generate_audio: { equals: false } }] }, price: 0.2 },
  ]);
  expect(mediaCost({ default: 0.05, "480p": 0.05 }, "video")).toEqual({ cost: { video: { output: { unit: "second", price: 0.05 } } } });
  // Without a per-second base, or with keys of unknown unit, there's no cost.
  expect(mediaCost({ hd: 0.17, fhd: 0.29 }, "video")).toEqual({ unpriced: ["hd", "fhd"] });
  expect(mediaCost({ "720p": 0.1 }, "video")).toEqual({ unpriced: ["720p"] });
  expect(mediaCost({ units: 0.12 }, "video")).toEqual({ unpriced: ["units"] });
  expect(mediaCost({ precise: 0.07, creative: 0.1 }, "video")).toEqual({ unpriced: ["precise", "creative"] });
});

test("reads image and video route modalities from the request schema", () => {
  const lab = {
    modalities: {
      input: ["text", "image/jpeg", "image/png", "video/mp4", "audio/wav"],
      output: ["text", "image/png", "image/jpeg"],
    },
  };
  expect(routeModalities("image", {
    properties: { prompt: {}, image_input: {}, output_format: { enum: ["jpg", "png", "webp"] } },
  }, lab)).toEqual({ input: ["text", "image/jpeg", "image/png"], output: ["image/jpeg", "image/png", "image/webp"] });
  // No format enum: the lab's image outputs, without its text output.
  expect(routeModalities("image", { properties: { prompt: {} } }, lab)).toEqual({ input: ["text"], output: ["image/png", "image/jpeg"] });
  expect(routeModalities("video", {
    properties: { prompt: {}, reference_video: {}, reference_audio: {}, output_format: { enum: ["mp4", "mov"] } },
  }, lab)).toEqual({ input: ["text", "video/mp4", "audio/wav"], output: ["video/mp4", "video/quicktime"] });
  expect(() => routeModalities("video", { properties: { prompt: {}, video: {} } }, { modalities: { input: ["text"], output: ["video/mp4"] } }))
    .toThrow("the route takes video input but the lab lists no video MIME types");
  // Inputs carried in a content-parts array aren't read; the lab's modalities apply.
  expect(routeModalities("video", { properties: { content: {}, duration: {} } }, lab)).toBeUndefined();
});

function testSyncProvider(modelsDir: string, id: string) {
  return {
    id: "symlink-test",
    name: "Symlink test",
    modelsDir,
    async fetchModels() {
      return [{ id }];
    },
    parseModels(raw: unknown) {
      return raw as Array<{ id: string }>;
    },
    translateModel(model: { id: string }) {
      return { id: model.id, model: { base_model: "openai/gpt-4.1" } };
    },
  };
}

function catalogPage(
  result: Array<Record<string, unknown>>,
  resultInfo: Partial<{ page: number; per_page: number; total_count: number; total_pages: number }> = {},
) {
  const page = resultInfo.page ?? 1;
  const perPage = resultInfo.per_page ?? 50;
  const totalCount = resultInfo.total_count ?? result.length;
  return {
    success: true,
    result,
    result_info: {
      page,
      per_page: perPage,
      count: result.length,
      total_count: totalCount,
      total_pages: resultInfo.total_pages ?? Math.max(1, Math.ceil(totalCount / perPage)),
    },
  };
}

function providerDetails(pricing: Record<string, number>) {
  return [{ id: "test-provider", pricing }];
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("lists a REST table for every other request format the catalog gives a gateway model", () => {
  const main = "@opencode/ai/providers/cloudflare-ai-gateway";
  const base_url = "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1";
  // OpenAI: the native Responses route stays first; Chat Completions goes through REST.
  const openai = gatewayApis({ responses: { sdk: { aisdk: "@ai-sdk/openai" } } }, "responses", ["responses", "chat-completions"]);
  expect(openai).toEqual({
    responses: { sdk: { aisdk: "@ai-sdk/openai", opencodeai: main } },
    "chat-completions": { base_url, sdk: { aisdk: "@ai-sdk/openai-compatible", opencodeai: main } },
  });
  expect(gatewayApis(openai, "responses", ["responses", "chat-completions"])).toEqual(openai);
  // A Responses-only model keeps its default Chat Completions table first.
  expect(gatewayApis(undefined, undefined, ["responses"])).toEqual({
    "chat-completions": {},
    responses: { base_url, sdk: { aisdk: "@ai-sdk/openai", opencodeai: main } },
  });
  expect(gatewayApis(undefined, undefined, ["chat-completions", "anthropic-messages"])).toEqual({
    "chat-completions": {},
    messages: { base_url, sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: main } },
  });
  // One format and no table: nothing to write. An existing first table is kept.
  expect(gatewayApis(undefined, undefined, ["chat-completions"])).toBeUndefined();
  const systemone = { systemone: { sdk: { aisdk: "none" } } };
  expect(gatewayApis(systemone, undefined, null)).toEqual(systemone);
});

test("lists decision models on the /ai/run API", () => {
  const translated = cloudflareAiGateway.translateModel({
    catalog: {
      model_id: "typesafe/jev-1.14.0",
      task: "Text Generation" as const,
      provider_details: providerDetails({ input_tokens: 0.042, output_tokens: 0 }),
      request_formats: ["chat-completions"],
    },
  }, { authored: () => undefined, existing: () => undefined }) as { v2Set: { api: (current: unknown) => unknown } };
  const run = {
    "workers-ai-run": {
      base_url: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai",
      sdk: { opencodeai: "none" },
    },
  };
  expect(translated.v2Set.api(undefined)).toEqual(run);
  expect(translated.v2Set.api({ systemone: { sdk: { aisdk: "none" } } })).toEqual(run);
});
