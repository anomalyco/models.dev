import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatToml, preserveReasoningOptions, syncProvider, type SyncProvider } from "../src/sync/index.js";
import {
  buildAnthropicModel,
  parseAnthropicPricing,
  type AnthropicModel,
} from "../src/sync/providers/anthropic.js";
import { buildDeepInfraModel, type DeepInfraModel } from "../src/sync/providers/deepinfra.js";
import { buildOpenRouterModel, openrouter, type OpenRouterModel } from "../src/sync/providers/openrouter.js";
import { buildLLMGatewayModel, type LLMGatewayModel } from "../src/sync/providers/llmgateway.js";

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
