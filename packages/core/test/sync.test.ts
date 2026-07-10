import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatToml, preserveReasoningOptions, syncProvider, type SyncProvider } from "../src/sync/index.js";
import {
  anthropic,
  buildAnthropicModel,
  parseAnthropicPricing,
  type AnthropicModel,
} from "../src/sync/providers/anthropic.js";
import { buildDeepInfraModel, type DeepInfraModel } from "../src/sync/providers/deepinfra.js";
import {
  buildDigitalOceanModel,
  digitalocean,
  fetchDigitalOceanModels,
  parseDigitalOceanModels,
  resolveDigitalOceanBaseModel,
  type DigitalOceanSourceModel,
} from "../src/sync/providers/digitalocean.js";
import {
  buildOpenRouterModel,
  openrouter,
  resolveCanonicalBaseModel,
  type OpenRouterModel,
} from "../src/sync/providers/openrouter.js";
import { buildLLMGatewayModel, type LLMGatewayModel } from "../src/sync/providers/llmgateway.js";
import { openai, parseOpenAIModels } from "../src/sync/providers/openai.js";
import { resolveVeniceBaseModel } from "../src/sync/providers/venice.js";
import { buildVercelModel, vercel } from "../src/sync/providers/vercel.js";
import { buildWandbModel, type WandbModel } from "../src/sync/providers/wandb.js";
import { buildXAIModel } from "../src/sync/providers/xai.js";

function anthropicModel(overrides: Partial<AnthropicModel> = {}): AnthropicModel {
  return {
    id: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    created_at: "2026-06-30T00:00:00Z",
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: {
        supported: true,
        types: { adaptive: { supported: true } },
      },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: true },
        max: { supported: true },
      },
    },
    ...overrides,
  };
}

const anthropicPricingMarkdown = `
## Model pricing

| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.1 ([deprecated](/deprecated)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 [through August 31, 2026](/pricing) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4.5 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |

## Cloud platform pricing
`;

test("parses current and future Anthropic pricing rows", () => {
  const introductory = parseAnthropicPricing(anthropicPricingMarkdown, new Date("2026-07-04T00:00:00Z"));
  expect(introductory.get("claude sonnet 5")).toMatchObject({
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  });
  expect(introductory.get("claude opus 4.1")?.deprecated).toBe(true);

  const standard = parseAnthropicPricing(anthropicPricingMarkdown, new Date("2026-09-01T00:00:00Z"));
  expect(standard.get("claude sonnet 5")).toMatchObject({ input: 3, output: 15 });
});

test("syncs Anthropic capabilities and exact effort levels", () => {
  const model = buildAnthropicModel(anthropicModel(), {
    name: "Claude Sonnet 5",
    description: "Balanced Claude model for coding and agentic workflows",
    release_date: "2026-06-30",
    last_updated: "2026-06-30",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 1_024 }],
    tool_call: true,
    open_weights: false,
    cost: { input: 2, output: 10 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning: true,
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
    ],
    structured_output: true,
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });
});

test("adds manual budget control for new Anthropic models", () => {
  const model = buildAnthropicModel(anthropicModel({
    capabilities: {
      thinking: {
        supported: true,
        types: { enabled: { supported: true } },
      },
    },
  }), undefined, "anthropic/claude-sonnet-5");

  expect(model.reasoning_options).toEqual([{ type: "budget_tokens" }]);
});

test("labels Anthropic aliases as latest", () => {
  const model = buildAnthropicModel(anthropicModel({
    id: "claude-sonnet-5",
    canonical_id: "claude-sonnet-5-20260630",
  }), undefined, "anthropic/claude-sonnet-5");

  expect(model.name).toBe("Claude Sonnet 5 (latest)");
});

test("Anthropic sync preserves base model inheritance", () => {
  const resolved = {
    base_model: "anthropic/claude-opus-4-5",
    name: "Claude Opus 4.5 (latest)",
    description: "Flagship Claude model",
    release_date: "2025-11-24",
    last_updated: "2025-11-24",
    attachment: true,
    reasoning: true,
    tool_call: true,
    knowledge: "2025-05",
    open_weights: false,
    cost: { input: 5, output: 25 },
    limit: { context: 200_000, output: 64_000 },
    modalities: { input: ["text" as const, "image" as const], output: ["text" as const] },
  };
  const translated = anthropic.translateModel(anthropicModel({
    id: "claude-opus-4-5",
    canonical_id: "claude-opus-4-5-20251101",
    display_name: "Claude Opus 4.5",
    created_at: "2025-11-24T00:00:00Z",
    max_input_tokens: 200_000,
    max_tokens: 64_000,
  }), {
    existing: () => resolved,
    authored: () => ({ base_model: "anthropic/claude-opus-4-5" }),
  });

  expect(translated?.model).toMatchObject({
    base_model: "anthropic/claude-opus-4-5",
    name: "Claude Opus 4.5 (latest)",
  });
  expect(translated?.model).not.toHaveProperty("knowledge");
  expect(translated?.model).not.toHaveProperty("release_date");
});

test("filters customer-owned OpenAI models from availability tracking", () => {
  expect(parseOpenAIModels({
    object: "list",
    data: [
      { id: "gpt-5.5", object: "model", created: 1, owned_by: "system" },
      { id: "ft:gpt-5.5:org:custom", object: "model", created: 2, owned_by: "org-example" },
      { id: "custom-model", object: "model", created: 3, owned_by: "org-example" },
    ],
  }).map((model) => model.id)).toEqual(["gpt-5.5"]);
});

test("OpenAI availability sync preserves authored metadata", () => {
  const authored = {
    base_model: "openai/gpt-5.5",
    cost: { input: 5, output: 30 },
  };
  expect(openai.translateModel(
    { id: "gpt-5.5", object: "model", created: 1, owned_by: "system" },
    { existing: () => authored as never, authored: () => authored },
  )).toEqual({ id: "gpt-5.5", model: authored });
});

test("OpenAI availability sync retains models absent from a scoped response", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-openai-"));
  const modelsDir = path.join(dir, "providers", "openai", "models");
  await Bun.write(path.join(modelsDir, "gpt-existing.toml"), [
    'name = "Existing GPT"',
    'release_date = "2026-01-01"',
    'last_updated = "2026-01-01"',
    "attachment = false",
    "reasoning = false",
    "tool_call = true",
    "open_weights = false",
    "",
    "[cost]",
    "input = 1",
    "output = 2",
    "",
    "[limit]",
    "context = 1_000",
    "output = 100",
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
  ].join("\n"));

  try {
    const result = await syncProvider({
      ...openai,
      modelsDir,
      async fetchModels() {
        return {
          object: "list",
          data: [{ id: "gpt-scoped", object: "model", created: 1, owned_by: "system" }],
        };
      },
    });
    expect(result.deleted).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(await Bun.file(path.join(modelsDir, "gpt-existing.toml")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function digitalOceanModel(overrides: Partial<DigitalOceanSourceModel> = {}): DigitalOceanSourceModel {
  return {
    id: "anthropic-claude-4.6-sonnet",
    name: "Claude Sonnet 4.6",
    lifecycle_status: "available",
    type: "chat",
    thinking: true,
    context_window: 1_000_000,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    settings: [{ name: "max_tokens", max: 64_000 }],
    created_at: "2026-02-17T00:00:00Z",
    pricing: {
      input: 3,
      output: 15,
      inputOver200k: 6,
      outputOver200k: 22.5,
    },
    ...overrides,
  };
}

test("syncs DigitalOcean pricing and preserves curated cache tiers", () => {
  const model = buildDigitalOceanModel(digitalOceanModel(), {
    name: "Claude Sonnet 4.6",
    description: "Curated DigitalOcean description",
    family: "claude-sonnet",
    release_date: "2026-02-17",
    last_updated: "2026-03-13",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    temperature: true,
    tool_call: true,
    open_weights: false,
    status: "beta",
    cost: {
      input: 2,
      output: 10,
      cache_read: 0.3,
      cache_write: 3.75,
      tiers: [{
        tier: { type: "context", size: 200_000 },
        input: 4,
        output: 15,
        cache_read: 0.6,
        cache_write: 7.5,
      }],
    },
    limit: { context: 200_000, output: 64_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    description: "Curated DigitalOcean description",
    last_updated: "2026-03-13",
    status: "beta",
    cost: {
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
      tiers: [{
        tier: { type: "context", size: 200_000 },
        input: 6,
        output: 22.5,
        cache_read: 0.6,
        cache_write: 7.5,
      }],
    },
    limit: { context: 1_000_000, output: 64_000 },
  });
});

test("skips existing dedicated-only DigitalOcean models without token pricing", () => {
  const existing = {
    name: "Mistral 7B Instruct v0.3",
    description: "Mistral model for multilingual chat and dedicated inference",
    family: "mistral" as const,
    release_date: "2024-05-22",
    last_updated: "2024-05-22",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    open_weights: true,
    limit: { context: 32_768, output: 32_768 },
    modalities: { input: ["text" as const], output: ["text" as const] },
  };
  const translated = digitalocean.translateModel(digitalOceanModel({
    id: "mistral-7b-instruct-v0.3",
    name: "Mistral 7B Instruct v0.3",
    thinking: false,
    context_window: 32_768,
    modalities: { input: ["text"], output: ["text"] },
    settings: [{ name: "max_tokens", max: 8_192 }],
    pricing: undefined,
  }), {
    existing: () => existing,
    authored: () => existing,
  });

  expect(translated).toBeUndefined();
});

test("syncs existing DigitalOcean image models with zero token limits", () => {
  const existing = {
    name: "GPT Image 1.5",
    description: "Image generation model",
    family: "gpt-image" as const,
    release_date: "2025-11-25",
    last_updated: "2025-11-25",
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: false,
    open_weights: false,
    cost: { input: 5, output: 10 },
    limit: { context: 0, output: 0 },
    modalities: { input: ["text" as const, "image" as const], output: ["image" as const] },
  };
  const translated = digitalocean.translateModel(digitalOceanModel({
    id: "openai-gpt-image-1.5",
    name: "GPT Image 1.5",
    context_window: undefined,
    modalities: { input: ["text", "image"], output: ["text", "image"] },
    settings: [],
    pricing: { input: 6, output: 12 },
  }), {
    existing: () => existing,
    authored: () => existing,
  });

  expect(translated?.model).toMatchObject({
    cost: { input: 6, output: 12 },
    limit: { context: 0, output: 0 },
  });
});

test("filters unmanaged DigitalOcean models and joins pricing names", () => {
  const models = parseDigitalOceanModels({
    models: [
      digitalOceanModel({ id: "kimi-k2.5", name: "Kimi K2", pricing: undefined }),
      digitalOceanModel({
        id: "bge-m3",
        name: "BGE M3",
        type: "embedding",
        modalities: { input: ["text"], output: ["text"] },
        pricing: undefined,
      }),
    ],
    pricing: [
      { name: "Kimi K2.5 Input Tokens", slug: "input", model: "DigitalOcean-Hosted Models", price: { rate: 0.5 } },
      { name: "Kimi K2.5 Output Tokens", slug: "output", model: "DigitalOcean-Hosted Models", price: { rate: 2.4 } },
    ],
  });

  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({
    id: "kimi-k2.5",
    pricing: { input: 0.5, output: 2.4 },
  });
});

test("resolves DigitalOcean IDs to canonical model metadata", () => {
  expect(resolveDigitalOceanBaseModel("openai-gpt-5.5")).toBe("openai/gpt-5.5");
  expect(resolveDigitalOceanBaseModel("deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
});

test("new DigitalOcean base models inherit intrinsic capabilities", () => {
  const model = buildDigitalOceanModel(
    digitalOceanModel({
      id: "openai-gpt-5.5",
      name: "GPT-5.5",
      thinking: undefined,
    }),
    undefined,
    "openai/gpt-5.5",
  );

  expect(model).toMatchObject({ base_model: "openai/gpt-5.5" });
  expect(model).not.toHaveProperty("open_weights");
  expect(model).not.toHaveProperty("family");
  expect(model).not.toHaveProperty("release_date");
  expect(model).not.toHaveProperty("knowledge");
  expect(model).not.toHaveProperty("reasoning");
  expect(model).not.toHaveProperty("temperature");
});

test("xAI sync factors inherited base model fields", () => {
  const model = buildXAIModel(
    {
      id: "grok-4.5",
      created: Date.parse("2026-06-29T00:00:00Z") / 1000,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      prompt_text_token_price: 20_000,
      cached_prompt_text_token_price: 5_000,
      completion_text_token_price: 60_000,
      max_prompt_length: 500_000,
    },
    {
      base_model: "xai/grok-4.5",
      name: "Grok 4.5",
      description: "xAI's latest Grok for chat, coding, agentic tools, and lower hallucination risk",
      family: "grok",
      release_date: "2026-07-08",
      last_updated: "2026-07-08",
      attachment: true,
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      temperature: true,
      tool_call: true,
      structured_output: true,
      open_weights: false,
      cost: {
        input: 2,
        output: 6,
        cache_read: 0.5,
        tiers: [{ tier: { size: 200_000 }, input: 4, output: 12, cache_read: 1 }],
      },
      limit: { context: 500_000, output: 500_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
    },
  );

  expect(model).toMatchObject({
    base_model: "xai/grok-4.5",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    cost: {
      input: 2,
      output: 6,
      cache_read: 0.5,
      tiers: [{ tier: { size: 200_000 }, input: 4, output: 12, cache_read: 1 }],
    },
  });
  expect(model).not.toHaveProperty("name");
  expect(model).not.toHaveProperty("family");
  expect(model).not.toHaveProperty("release_date");
  expect(model).not.toHaveProperty("last_updated");
  expect(model).not.toHaveProperty("limit");
});

test("skips new DigitalOcean models with incomplete pricing or limits", () => {
  const translated = digitalocean.translateModel(
    digitalOceanModel({ pricing: undefined }),
    { existing: () => undefined, authored: () => undefined },
  );
  expect(translated).toBeUndefined();
});

test("fetches every page of the DigitalOcean catalog", async () => {
  const requests: string[] = [];
  const first = digitalOceanModel({ id: "first", pricing: undefined });
  const second = digitalOceanModel({ id: "second", pricing: undefined });
  const fetcher = ((input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("static-content")) {
      return Promise.resolve(new Response(JSON.stringify({ gradient: { models: [] } })));
    }
    if (url.includes("?page=2")) {
      return Promise.resolve(new Response(JSON.stringify({ models: [second] })));
    }
    return Promise.resolve(new Response(JSON.stringify({
      models: [first],
      links: { pages: { next: "https://api.digitalocean.com/v2/gen-ai/models?page=2" } },
    })));
  }) as typeof fetch;

  const result = await fetchDigitalOceanModels("test-key", fetcher);
  expect(result.models.map((model) => model.id)).toEqual(["first", "second"]);
  expect(requests).toHaveLength(3);
});

function deepInfraModel(model_name: string, tags: string[]): DeepInfraModel {
  return {
    model_name,
    type: "text-generation",
    tags,
    pricing: {
      cents_per_input_token: 0.00001,
      cents_per_output_token: 0.00002,
    },
    max_tokens: 262_144,
  };
}

test("formats interleaved as a root field before reasoning option tables", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    description: "Example model for sync formatting regression tests",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    interleaved: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    interleaved: true,
    reasoning_options: [{ type: "toggle" }],
  });
});

test("formats empty reasoning options outside the interleaved table", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    description: "Example model for sync formatting regression tests",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    interleaved: { field: "reasoning_content" },
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    interleaved: { field: "reasoning_content" },
    reasoning_options: [],
  });
});

test("formats provider overrides and experimental modes", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    description: "Example model for sync formatting regression tests",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: false,
    tool_call: true,
    open_weights: false,
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
    provider: { body: { custom_flag: true } },
    experimental: {
      modes: {
        fast: {
          cost: { input: 2, output: 4 },
          provider: {
            body: { speed: "fast" },
            headers: { "anthropic-beta": "fast-mode-2026-02-01" },
          },
        },
      },
    },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    provider: { body: { custom_flag: true } },
    experimental: {
      modes: {
        fast: {
          cost: { input: 2, output: 4 },
          provider: {
            body: { speed: "fast" },
            headers: { "anthropic-beta": "fast-mode-2026-02-01" },
          },
        },
      },
    },
  });
});

test("DeepInfra preserves live modalities for new base models", () => {
  const model = buildDeepInfraModel(
    deepInfraModel("Qwen/Qwen3.5-9B", ["multimodal", "input-video"]),
    undefined,
    "alibaba/qwen3.5-9b",
  );

  expect(model).toMatchObject({
    attachment: true,
    modalities: { input: ["text", "image", "video"] },
  });
});

test("DeepInfra excludes incorrectly tagged Gemma 4 audio input", () => {
  const model = buildDeepInfraModel(
    deepInfraModel("google/gemma-4-31B-it", ["multimodal", "input-audio", "input-video"]),
    { modalities: { input: ["text", "image", "audio", "video"] } },
    "google/gemma-4-31b-it",
  );

  expect(model).toMatchObject({
    modalities: { input: ["text", "image", "video"] },
  });
});

test("DeepInfra preserves descriptions for standalone models", () => {
  const model = buildDeepInfraModel(
    deepInfraModel("example/model", []),
    {
      name: "Example Model",
      description: "Authored standalone model description",
      release_date: "2026-01-01",
      last_updated: "2026-01-01",
      attachment: false,
      reasoning: false,
      tool_call: false,
      open_weights: true,
      cost: { input: 1, output: 2 },
      limit: { context: 262_144, output: 8_192 },
      modalities: { input: ["text"], output: ["text"] },
    },
  );

  expect(model).toMatchObject({
    description: "Authored standalone model description",
  });
});

test("W&B preserves curated model dates", () => {
  const model: WandbModel = {
    id: "example/model",
    name: "Example Model",
    description: "Example model used to verify W&B date preservation",
    attachment: false,
    reasoning: false,
    tool_call: true,
    release_date: "2024-07-01",
    last_updated: "2024-07-01",
    open_weights: true,
  };

  expect(buildWandbModel(model, {
    release_date: "2024-07-23",
    last_updated: "2024-07-23",
  })).toMatchObject({
    release_date: "2024-07-23",
    last_updated: "2024-07-23",
  });
});

test("formats reasoning efforts from lowest to highest", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    description: "Example model for sync formatting regression tests",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{
      type: "effort",
      values: ["max", "xhigh", "high", "medium", "low", "minimal", "none", "default"],
    }],
    tool_call: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(content).toContain(
    'values = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]',
  );
});

test("defaults new reasoning models to empty reasoning options", () => {
  expect(preserveReasoningOptions({ reasoning: true }, undefined)).toEqual({
    reasoning: true,
    reasoning_options: [],
  });
});

test("syncs OpenRouter reasoning efforts from model metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    reasoning: {
      mandatory: false,
      supported_efforts: ["max", "xhigh", "high", "medium", "low"],
    },
  }), undefined);

  expect(model).toMatchObject({
    base_model: "anthropic/claude-sonnet-5",
    reasoning_options: [
      { type: "effort", values: ["max", "xhigh", "high", "medium", "low"] },
    ],
  });
});

test("uses OpenRouter model context when top provider reports a shorter context", () => {
  const model = buildOpenRouterModel(openRouterModel({
    context_length: 1_048_576,
    top_provider: {
      context_length: 32_000,
      max_completion_tokens: 8_192,
    },
  }), undefined);

  expect(model).toMatchObject({
    limit: {
      context: 1_048_576,
      output: 8_192,
    },
  });
});

test("factors OpenRouter Pro routes against canonical OpenAI metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    id: "openai/gpt-5.6-sol-pro",
    name: "OpenAI: GPT-5.6 Sol Pro",
    knowledge_cutoff: "2026-02-16",
    context_length: 1_050_000,
    top_provider: {
      context_length: 1_050_000,
      max_completion_tokens: 128_000,
    },
  }), undefined);

  expect([
    resolveCanonicalBaseModel("openai/gpt-5.6-luna-pro"),
    resolveCanonicalBaseModel("openai/gpt-5.6-sol-pro"),
    resolveCanonicalBaseModel("openai/gpt-5.6-terra-pro"),
  ]).toEqual([
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
  ]);
  expect(model).toMatchObject({
    base_model: "openai/gpt-5.6-sol",
    name: "GPT-5.6 Sol Pro",
  });
  expect("family" in model).toBe(false);
  expect("release_date" in model).toBe(false);
});

test("resolves Venice Pro routes to canonical OpenAI metadata", () => {
  expect([
    resolveVeniceBaseModel("openai-gpt-56-luna-pro", "GPT-5.6 Luna Pro"),
    resolveVeniceBaseModel("openai-gpt-56-sol-pro", "GPT-5.6 Sol Pro"),
    resolveVeniceBaseModel("openai-gpt-56-terra-pro", "GPT-5.6 Terra Pro"),
  ]).toEqual([
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
  ]);
});

test("preserves authored OpenRouter reasoning options over model metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    reasoning: {
      mandatory: false,
      supported_efforts: ["max", "xhigh", "high", "medium", "low"],
    },
  }), {
    name: "Claude Sonnet 5",
    description: "Balanced Claude model for coding and agentic workflows",
    release_date: "2026-06-30",
    last_updated: "2026-06-30",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    open_weights: false,
    cost: { input: 2, output: 10 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning_options: [{ type: "toggle" }],
  });
});

test("upgrades empty OpenRouter reasoning options from model metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    reasoning: {
      mandatory: false,
      supported_efforts: ["high", "medium", "low"],
    },
  }), {
    name: "Claude Sonnet 5",
    description: "Balanced Claude model for coding and agentic workflows",
    release_date: "2026-06-30",
    last_updated: "2026-06-30",
    attachment: true,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    open_weights: false,
    cost: { input: 2, output: 10 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning_options: [
      { type: "effort", values: ["high", "medium", "low"] },
    ],
  });
});

test("factors new LLM Gateway models against the canonical base metadata", () => {
  const model = buildLLMGatewayModel(llmGatewayModel(), undefined);

  expect(model).toEqual({
    base_model: "anthropic/claude-fable-5",
    cost: {
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    },
  });
  expect("name" in model).toBe(false);
  expect("modalities" in model).toBe(false);
});

test("factors aliased LLM Gateway routes against canonical metadata", () => {
  const model = buildLLMGatewayModel(llmGatewayModel({
    id: "glm-5-2",
    name: "GLM-5.2 (260617)",
    family: "bytedance",
    context_length: 1_024_000,
    pricing: {
      prompt: "1.4e-6",
      completion: "4.4e-6",
      input_cache_read: "0.26e-6",
    },
  }), undefined);

  expect(model).toEqual({
    base_model: "zhipuai/glm-5.2",
    cost: {
      input: 1.4,
      output: 4.4,
      cache_read: 0.26,
    },
    limit: {
      context: 1_024_000,
    },
  });
});

test("parses Vercel pricing tiers with an implicit zero minimum", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "openai/gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      created: 1_780_963_200,
      context_window: 1_050_000,
      max_tokens: 128_000,
      type: "language",
      pricing: {
        input: "0.000001",
        output: "0.000006",
        input_cache_read: "0.0000001",
        input_cache_read_tiers: [
          { cost: "0.0000001", max: 272_000 },
          { cost: "0.0000002", min: 272_000 },
        ],
      },
    }],
  });

  expect(model).toBeDefined();
  expect(buildVercelModel(model!, undefined)).toMatchObject({
    cost: { input: 1, output: 6, cache_read: 0.1 },
  });
});

test("skips LLM Gateway base_model factoring when no metadata entry exists", () => {
  const model = buildLLMGatewayModel(
    llmGatewayModel({ id: "claude-fable-does-not-exist" }),
    undefined,
  );

  expect("base_model" in model).toBe(false);
  expect(model).toMatchObject({ name: "Claude Fable 5" });
});

test("preserves the authored header comment block when rewriting a changed model", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-header-"));
  const modelsDir = path.join(dir, "providers", "example", "models");
  await Bun.write(path.join(modelsDir, "example-model.toml"), [
    "# Documented quirk: this route needs a manual note.",
    "# https://example.com/docs (accessed 2026-06-25)",
    'name = "Example Model"',
    'release_date = "2026-01-01"',
    'last_updated = "2026-01-01"',
    "attachment = false",
    "reasoning = false",
    "tool_call = true",
    "open_weights = false",
    "",
    "[cost]",
    "input = 1",
    "output = 2",
    "",
    "[limit]",
    "context = 1_000",
    "output = 100",
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
  ].join("\n"));

  const provider: SyncProvider<{ id: string }> = {
    id: "example",
    name: "Example",
    modelsDir,
    deleteMissing: false,
    async fetchModels() {
      return [{ id: "example-model" }];
    },
    parseModels(raw) {
      return raw as { id: string }[];
    },
    translateModel(model) {
      return {
        id: model.id,
        model: {
          name: "Example Model",
          description: "Example model used to verify sync formatting behavior",
          release_date: "2026-01-01",
          last_updated: "2026-01-01",
          attachment: false,
          reasoning: false,
          tool_call: true,
          open_weights: false,
          cost: { input: 3, output: 9 },
          limit: { context: 1_000, output: 100 },
          modalities: { input: ["text"], output: ["text"] },
        },
      };
    },
  };

  try {
    const result = await syncProvider(provider);
    expect(result.updated).toBe(1);
    const written = await readFile(path.join(modelsDir, "example-model.toml"), "utf8");
    expect(written).toStartWith(
      "# Documented quirk: this route needs a manual note.\n# https://example.com/docs (accessed 2026-06-25)\n",
    );
    expect(written).toContain("input = 3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retains authored data when OpenRouter reports an unavailable stub", () => {
  const authored = {
    name: "Claude Fable Latest",
    reasoning: true as const,
    reasoning_options: [{ type: "effort" as const, values: ["low", "high"] as const }],
    tool_call: true as const,
    structured_output: true as const,
  };
  const translated = openrouter.translateModel(unavailableStub(), {
    existing: () => undefined,
    authored: () => authored as never,
  });

  expect(translated).toEqual({ id: "~anthropic/claude-fable-latest", model: authored as never });
});

test("skips an unavailable OpenRouter stub with no authored file", () => {
  const translated = openrouter.translateModel(unavailableStub(), {
    existing: () => undefined,
    authored: () => undefined,
  });

  expect(translated).toBeUndefined();
});

function unavailableStub(): OpenRouterModel {
  return openRouterModel({
    id: "~anthropic/claude-fable-latest",
    name: "Anthropic: Claude Fable Latest",
    supported_parameters: [],
    pricing: { prompt: "-1", completion: "-1" },
    reasoning: { mandatory: true },
    top_provider: { context_length: null, max_completion_tokens: null },
  });
}

function llmGatewayModel(overrides: Partial<LLMGatewayModel> = {}): LLMGatewayModel {
  return {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    created: 1_780_963_200,
    family: "anthropic",
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    pricing: {
      prompt: "10.0e-6",
      completion: "50.0e-6",
      input_cache_read: "1.0e-6",
      input_cache_write: "12.5e-6",
      internal_reasoning: "0",
    },
    context_length: 1_000_000,
    supported_parameters: ["temperature", "max_tokens", "top_p", "effort", "reasoning"],
    structured_outputs: true,
    ...overrides,
  };
}

function openRouterModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: "anthropic/claude-sonnet-5",
    name: "Anthropic: Claude Sonnet 5",
    created: 1_782_777_600,
    hugging_face_id: null,
    knowledge_cutoff: "2026-01-31",
    context_length: 1_000_000,
    architecture: {
      input_modalities: ["text", "image", "file"],
      output_modalities: ["text"],
    },
    pricing: {
      prompt: "0.000002",
      completion: "0.00001",
      input_cache_read: "0.0000002",
      input_cache_write: "0.0000025",
    },
    top_provider: {
      context_length: 1_000_000,
      max_completion_tokens: 128_000,
    },
    supported_parameters: ["include_reasoning", "reasoning", "structured_outputs", "tools"],
    ...overrides,
  };
}
