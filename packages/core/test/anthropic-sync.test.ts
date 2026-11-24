import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";

import { anthropic, buildAnthropicModel, parseAnthropicPricing, type AnthropicModel } from "../src/sync/providers/anthropic.js";

function anthropicModel(overrides: Partial<AnthropicModel> = {}): AnthropicModel {
  return {
    id: "claude-opus-5",
    display_name: "Claude Opus 5",
    created_at: "2026-07-24T00:00:00Z",
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
      thinking: {
        supported: true,
        types: { adaptive: { supported: true }, enabled: { supported: false }, disabled: { supported: true } },
      },
      effort: {
        supported: true,
        low: { supported: true },
        high: { supported: true },
      },
    },
    ...overrides,
  };
}

function thinking(disabled: boolean | undefined, enabled = false): AnthropicModel["capabilities"] {
  return {
    thinking: {
      supported: true,
      types: {
        adaptive: { supported: true },
        enabled: { supported: enabled },
        ...(disabled === undefined ? {} : { disabled: { supported: disabled } }),
      },
    },
    effort: { supported: true, low: { supported: true }, high: { supported: true } },
  };
}

test("adds the thinking toggle when the API accepts thinking.type disabled", () => {
  const model = buildAnthropicModel(anthropicModel(), { reasoning: true, reasoning_options: [] }, "anthropic/claude-opus-5");
  expect(model.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "high"] },
  ]);

  // Alongside a manual budget, too.
  const budget = buildAnthropicModel(anthropicModel({ capabilities: thinking(true, true) }), undefined, "anthropic/claude-opus-4-6");
  expect(budget.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "high"] },
    { type: "budget_tokens" },
  ]);
});

test("keeps an authored toggle once and drops it when the API rejects disabled", () => {
  const existing = { reasoning: true, reasoning_options: [{ type: "toggle" as const }] };
  expect(buildAnthropicModel(anthropicModel(), existing, "anthropic/claude-opus-5").reasoning_options)
    .toEqual([{ type: "toggle" }, { type: "effort", values: ["low", "high"] }]);
  // No disabled flag in the response: keep what the file says.
  expect(buildAnthropicModel(anthropicModel({ capabilities: thinking(undefined) }), existing, "anthropic/claude-opus-5").reasoning_options)
    .toEqual([{ type: "toggle" }, { type: "effort", values: ["low", "high"] }]);
  // Always-on thinking (Opus 5.5, Fable 5.x): no toggle.
  expect(buildAnthropicModel(anthropicModel({ capabilities: thinking(false) }), existing, "anthropic/claude-opus-5-5").reasoning_options)
    .toEqual([{ type: "effort", values: ["low", "high"] }]);
});

const pricingMarkdown = `
## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |
| Claude Sonnet 4.5 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |

## Cloud platform pricing
`;

test("matches Haiku 5.5's prompt-length rows as a base price and a context tier", () => {
  const pricing = parseAnthropicPricing(pricingMarkdown);
  expect(pricing.get("claude haiku 5.5")).toEqual({
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    deprecated: false,
    tiers: [{ size: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
  });
  expect(pricing.get("claude haiku 4.5")?.tiers).toBeUndefined();

  const model = buildAnthropicModel(
    { ...anthropicModel({ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }), pricing: pricing.get("claude haiku 5.5") } as AnthropicModel,
    undefined,
    "anthropic/claude-haiku-5-5",
  );
  expect(model.cost).toMatchObject({
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    cache_write: 0.125,
    tiers: [{ input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625, tier: { type: "context", size: 100_000 } }],
  });
});

test("rejects a prompt-length band without its base row", () => {
  const markdown = pricingMarkdown.replace(/^\| Claude Haiku 5\.5 \(for prompts up to.*\n/m, "");
  expect(() => parseAnthropicPricing(markdown)).toThrow("prompt-length band but no base row: claude haiku 5.5");
});

test("marks models the API lists as deprecated", () => {
  const deprecated = anthropicModel({
    id: "claude-sonnet-4-5-20250929",
    display_name: "Claude Sonnet 4.5",
    lifecycle: "deprecated",
    deprecated_at: "2026-09-30T18:30:00Z",
    retires_at: "2026-11-30T17:00:00Z",
  });
  expect(buildAnthropicModel(deprecated, undefined, "anthropic/claude-sonnet-4-5").status).toBe("deprecated");
  // A retirement date alone is enough.
  expect(buildAnthropicModel(anthropicModel({ retires_at: "2026-11-30T17:00:00Z" }), undefined, "anthropic/claude-opus-5").status)
    .toBe("deprecated");
  // Active models keep the file's status.
  const active = anthropicModel({ lifecycle: "active", deprecated_at: null, retires_at: null });
  expect(buildAnthropicModel(active, undefined, "anthropic/claude-opus-5").status).toBeUndefined();
  expect(buildAnthropicModel(active, { status: "beta" }, "anthropic/claude-opus-5").status).toBe("beta");
});

test("writes the toggle's wire path as the file header", () => {
  const existing = { base_model: "anthropic/claude-opus-5", reasoning: true, reasoning_options: [] };
  const context = { existing: () => existing, authored: () => existing };
  expect(anthropic.translateModel(anthropicModel(), context)).toMatchObject({
    header: "# Toggle: thinking.type = adaptive|disabled. Models API (GET https://api.anthropic.com/v1/models/claude-opus-5): capabilities.thinking.types.disabled.supported = true\n",
  });
  expect(anthropic.translateModel(anthropicModel({ capabilities: thinking(true, true) }), context)?.header)
    .toStartWith("# Toggle: thinking.type = adaptive|enabled|disabled.");
  // No toggle, no header.
  expect(anthropic.translateModel(anthropicModel({ capabilities: thinking(false) }), context)?.header).toBeUndefined();
});

test("a toggle file the sync creates starts with the toggle's wire path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-anthropic-toggle-"));
  const modelsDir = path.join(root, "providers", "anthropic", "models");
  const repo = path.join(import.meta.dirname, "..", "..", "..");
  try {
    await mkdir(modelsDir, { recursive: true });
    await mkdir(path.join(root, "models", "anthropic"), { recursive: true });
    await copyFile(
      path.join(repo, "models", "anthropic", "claude-opus-5.toml"),
      path.join(root, "models", "anthropic", "claude-opus-5.toml"),
    );
    const result = await syncProvider({
      ...anthropic,
      modelsDir,
      fetchModels: async () => ({ models: [anthropicModel()], pricing: pricingMarkdown }),
    });

    expect(result).toMatchObject({ created: 1 });
    const content = await readFile(path.join(modelsDir, "claude-opus-5.toml"), "utf8");
    expect(content.split("\n")[0]).toBe(
      "# Toggle: thinking.type = adaptive|disabled. Models API (GET https://api.anthropic.com/v1/models/claude-opus-5): capabilities.thinking.types.disabled.supported = true",
    );
    expect(content).toContain('reasoning = { supported = true, toggle = true, effort = ["low", "high"] }');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
