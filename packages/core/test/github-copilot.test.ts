import { expect, test } from "bun:test";

import {
  buildGitHubCopilotCost,
  githubCopilotModelSlug,
  githubCopilot,
  parseGitHubCopilotPricing,
  type GitHubCopilotPricingRow,
} from "../src/sync/providers/github-copilot.js";
import type { ExistingModel } from "../src/sync/index.js";

function row(overrides: Partial<GitHubCopilotPricingRow>): GitHubCopilotPricingRow {
  return {
    model: "GPT-5.6 Terra",
    provider: "openai",
    release_status: "GA",
    category: "Versatile",
    input: "$2.00",
    cached_input: "$0.20",
    output: "$12.00",
    ...overrides,
  };
}

test("slugifies display names into catalog filenames", () => {
  expect(githubCopilotModelSlug("GPT-5.6 Sol[^gpt-56-sol-promo]")).toBe("gpt-5.6-sol");
  expect(githubCopilotModelSlug("GPT-5 mini")).toBe("gpt-5-mini");
  expect(githubCopilotModelSlug("GPT-5.3-Codex")).toBe("gpt-5.3-codex");
  expect(githubCopilotModelSlug("Claude Opus 4.8 (fast mode) (preview)")).toBe("claude-opus-4.8-fast-mode-preview");
  expect(githubCopilotModelSlug("MAI-Code-1.1-Flash")).toBe("mai-code-1.1-flash");
  expect(githubCopilotModelSlug("Kimi K2.7 Code")).toBe("kimi-k2.7-code");
});

test("groups tier rows under one model", () => {
  const models = parseGitHubCopilotPricing([
    row({ threshold: "≤ 272K", tier: "Default" }),
    row({ threshold: "> 272K", tier: "Long context", input: "$4.00", cached_input: "$0.40", output: "$18.00" }),
    row({ model: "Claude Sonnet 5", provider: "anthropic", input: "$2.00", output: "$10.00", cache_write: "$2.50" }),
  ]);
  expect(models.map((model) => model.slug)).toEqual(["gpt-5.6-terra", "claude-sonnet-5"]);
  expect(models[0]?.rows).toHaveLength(2);
});

test("builds flat cost with cache_write and Not applicable handling", () => {
  const [model] = parseGitHubCopilotPricing([
    row({ model: "GPT-5.4 mini", input: "$0.75", cached_input: "$0.075", output: "$4.50", cache_write: "Not applicable" }),
  ]);
  expect(buildGitHubCopilotCost(model!)).toEqual({
    input: 0.75,
    output: 4.5,
    cache_read: 0.075,
    cache_write: undefined,
    tiers: undefined,
  });
});

test("builds long-context tiers from threshold rows", () => {
  const [model] = parseGitHubCopilotPricing([
    row({ threshold: "≤ 272K", tier: "Default", cache_write: "$2.50" }),
    row({ threshold: "> 272K", tier: "Long context", input: "$4.00", cached_input: "$0.40", output: "$18.00", cache_write: "$5.00" }),
  ]);
  expect(buildGitHubCopilotCost(model!)).toEqual({
    input: 2,
    output: 12,
    cache_read: 0.2,
    cache_write: 2.5,
    tiers: [{
      tier: { type: "context", size: 272_000 },
      input: 4,
      output: 18,
      cache_read: 0.4,
      cache_write: 5,
    }],
  });
});

test("rejects malformed tables instead of writing garbage", () => {
  const build = (rows: GitHubCopilotPricingRow[]) => {
    const models = parseGitHubCopilotPricing(rows);
    return models.map((model) => buildGitHubCopilotCost(model));
  };
  // Unknown tier label.
  expect(() => build([row({ tier: "Standard" })])).toThrow(/Unknown pricing tier/u);
  // Two default rows for one model.
  expect(() => build([row({}), row({})])).toThrow(/exactly one default pricing row/u);
  // Long-context row without a parseable threshold.
  expect(() => build([
    row({ threshold: "≤ 272K", tier: "Default" }),
    row({ threshold: "272K+", tier: "Long context" }),
  ])).toThrow(/Unparseable long-context threshold/u);
  // Price strings are schema-validated before translation.
  expect(() => build([row({ input: "$1,000.00" })])).toThrow();
  expect(() => build([row({ input: "Included" })])).toThrow();
});

function translationContext(files: Record<string, ExistingModel>) {
  return {
    existing: (id: string) => files[id],
    authored: (id: string) => files[id],
  };
}

const authoredTerra: ExistingModel = {
  base_model: "openai/gpt-5.6-terra",
  cost: { input: 1, output: 1, cache_read: 1 },
};

test("updates cost on the authored file and preserves audio rates", () => {
  const [model] = parseGitHubCopilotPricing([row({ cache_write: "$2.50" })]);
  const translated = githubCopilot.translateModel(model!, translationContext({
    "gpt-5.6-terra": {
      ...authoredTerra,
      cost: { input: 1, output: 1, reasoning: 3, cache_read: 1, input_audio: 1.5, output_audio: 6 },
    },
  }));
  expect(translated?.id).toBe("gpt-5.6-terra");
  expect(translated?.model.cost).toMatchObject({
    input: 2,
    output: 12,
    reasoning: 3,
    cache_read: 0.2,
    cache_write: 2.5,
    input_audio: 1.5,
    output_audio: 6,
  });
  expect((translated?.model as ExistingModel).base_model).toBe("openai/gpt-5.6-terra");
});

test("clears authored tiers and cache_write the table no longer lists", () => {
  const [model] = parseGitHubCopilotPricing([row({ cache_write: "Not applicable" })]);
  const translated = githubCopilot.translateModel(model!, translationContext({
    "gpt-5.6-terra": {
      ...authoredTerra,
      cost: {
        input: 1,
        output: 1,
        cache_read: 1,
        cache_write: 9,
        tiers: [{ tier: { type: "context", size: 272_000 }, input: 9, output: 9 }],
      },
    },
  }));
  const cost = translated?.model.cost;
  expect(cost?.input).toBe(2);
  // Stale authored values must not survive the spread; the runner strips the
  // explicit undefineds before writing.
  expect(cost?.cache_write).toBeUndefined();
  expect(cost?.tiers).toBeUndefined();
});

test("resolves preview and alias filenames", () => {
  const preview = parseGitHubCopilotPricing([
    row({ model: "Example Model", release_status: "Public preview" }),
  ]);
  expect(githubCopilot.translateModel(preview[0]!, translationContext({
    "example-model-preview": authoredTerra,
  }))?.id).toBe("example-model-preview");

  const alias = parseGitHubCopilotPricing([row({ model: "MAI-Code-1-Flash", provider: "microsoft" })]);
  expect(githubCopilot.translateModel(alias[0]!, translationContext({
    "mai-code-1-flash-picker": authoredTerra,
  }))?.id).toBe("mai-code-1-flash-picker");

  // An exact slug match wins over both fallbacks.
  expect(githubCopilot.translateModel(preview[0]!, translationContext({
    "example-model": authoredTerra,
    "example-model-preview": authoredTerra,
  }))?.id).toBe("example-model");
  expect(githubCopilot.translateModel(alias[0]!, translationContext({
    "mai-code-1-flash": authoredTerra,
    "mai-code-1-flash-picker": authoredTerra,
  }))?.id).toBe("mai-code-1-flash");
});

test("skips ignored rows silently and unmatched rows with an ID", () => {
  const [fastMode] = parseGitHubCopilotPricing([
    row({ model: "Claude Opus 4.8 (fast mode) (preview)", provider: "anthropic" }),
  ]);
  expect(githubCopilot.translateModel(fastMode!, translationContext({}))).toBeUndefined();
  expect(githubCopilot.sourceID(fastMode!)).toBeUndefined();

  const [unmatched] = parseGitHubCopilotPricing([row({ model: "Brand New Model" })]);
  expect(githubCopilot.translateModel(unmatched!, translationContext({}))).toBeUndefined();
  expect(githubCopilot.sourceID(unmatched!)).toBe("brand-new-model");
});

test.each([
  "Claude Sonnet 4",
  "Claude Sonnet 4.5",
  "Claude Opus 4.5",
  "Claude Opus 4.6",
  "Gemini 3.1 Pro",
  "GPT-4.1",
  "GPT-5.2",
  "GPT-5.2-Codex",
  "Raptor mini",
])("ignores retired %s for translation and missing-model discovery", (name) => {
  const [model] = parseGitHubCopilotPricing([row({ model: name, release_status: "Public preview" })]);
  expect(githubCopilot.sourceID(model!)).toBeUndefined();
  expect(githubCopilot.translateModel(model!, translationContext({}))).toBeUndefined();
  expect(githubCopilot.translateModel(model!, translationContext({
    [model!.slug]: authoredTerra,
  }))).toBeUndefined();
  expect(githubCopilot.translateModel(model!, translationContext({
    [`${model!.slug}-preview`]: authoredTerra,
  }))).toBeUndefined();
});

test("keeps Sonnet 4.6 eligible for annual-plan subscribers", () => {
  const [model] = parseGitHubCopilotPricing([row({ model: "Claude Sonnet 4.6", provider: "anthropic" })]);
  expect(githubCopilot.sourceID(model!)).toBe("claude-sonnet-4.6");
  expect(githubCopilot.translateModel(model!, translationContext({
    "claude-sonnet-4.6": authoredTerra,
  }))?.id).toBe("claude-sonnet-4.6");
});

const pricingYaml = `
- model: 'GPT-5.6 Sol[^gpt-56-sol-promo]'
  provider: openai
  release_status: GA
  category: Powerful
  threshold: '≤ 272K'
  tier: Default
  input: $2.00
  cached_input: $0.20
  output: $10.00
  cache_write: $2.50

- model: 'GPT-5.6 Sol[^gpt-56-sol-promo]'
  provider: openai
  release_status: GA
  category: Powerful
  threshold: '> 272K'
  tier: 'Long context'
  input: $4.00
  cached_input: $0.40
  output: $15.00
  cache_write: $5.00
`;

test("parses rows straight from the docs YAML format", () => {
  const models = parseGitHubCopilotPricing(Bun.YAML.parse(pricingYaml));
  expect(models).toHaveLength(1);
  expect(models[0]?.slug).toBe("gpt-5.6-sol");
  expect(buildGitHubCopilotCost(models[0]!)).toEqual({
    input: 2,
    output: 10,
    cache_read: 0.2,
    cache_write: 2.5,
    tiers: [{
      tier: { type: "context", size: 272_000 },
      input: 4,
      output: 15,
      cache_read: 0.4,
      cache_write: 5,
    }],
  });
});
