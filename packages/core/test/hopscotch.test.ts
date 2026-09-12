import { expect, test } from "bun:test";

import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  HopscotchModel,
  hopscotch,
  reasoningOptionsFor,
  resolveHopscotchBaseModel,
} from "../src/sync/providers/hopscotch.js";

function model(overrides: Record<string, unknown> = {}) {
  const uniblock = {
    model_id: "claude-opus-4-6",
    author_slug: "anthropic",
    context_window_tokens: 200_000,
    max_output_tokens: 64_000,
    input_rate_thousandths: 5_000,
    output_rate_thousandths: 25_000,
    endpoint_families: ["chat_completions"],
    provider_families: ["anthropic"],
    capabilities: {},
    ...((overrides.uniblock as Record<string, unknown>) ?? {}),
  };
  return HopscotchModel.parse({
    id: "anthropic/claude-opus-4-6",
    created: Date.parse("2026-02-04") / 1_000,
    ...overrides,
    uniblock,
  });
}

test.each([
  ["deepseek-ai/DeepSeek-V3.2", "deepseek", "deepseek/deepseek-v3.2"],
  ["zai-org/GLM-4.6", "zhipu", "zhipuai/glm-4.6"],
  ["claude-opus-4-6", "anthropic", "anthropic/claude-opus-4-6"],
])("resolves %s to its canonical metadata", (id, author, expected) => {
  expect(resolveHopscotchBaseModel(id, author)).toBe(expected);
});

test("keeps only the controls the family forwards: thinking carries a budget, not an effort", () => {
  // The lab documents both a graded effort and a budget for Opus 4.6, and the
  // anthropic map forwards `thinking` alone, so only the budget survives.
  const resolved = reasoningOptionsFor("anthropic/claude-opus-4-6", "anthropic");
  expect(resolved?.options.map((option) => option.type)).toEqual([
    "budget_tokens",
  ]);
});

test("reports rather than publishes when every documented control is unreachable", () => {
  // Opus 4.7 documents an adaptive effort and no budget. An effort needs
  // `reasoning_effort`, which the anthropic map does not carry, so the
  // controls that could reach this host are unknown rather than absent.
  expect(reasoningOptionsFor("anthropic/claude-opus-4-7", "anthropic")).toBeUndefined();
});

test("the same base model answers differently under two serving families", () => {
  const effortFamily = reasoningOptionsFor("openai/gpt-5", "openai");
  expect(effortFamily?.options.some((option) => option.type === "effort")).toBe(
    true,
  );

  // deepinfra's map carries no reasoning parameter of any spelling, so the
  // same model exposes nothing here, which is a claim rather than a gap.
  const noControlFamily = reasoningOptionsFor("openai/gpt-5", "deepinfra");
  expect(noControlFamily).toEqual({ options: [], togglesThinking: false });
});

test("falls back to the same-surface relay when the lab documents no options", () => {
  // bytedance-seed/seed-2.0-lite has no first-party entry; OpenRouter's does.
  const resolved = reasoningOptionsFor("bytedance-seed/seed-2.0-lite", "openai");
  expect(resolved?.options.some((option) => option.type === "effort")).toBe(true);
});

test("an unread family is reported, never assumed to have no control", () => {
  expect(reasoningOptionsFor("openai/gpt-5", "a-family-nobody-has-read")).toBeUndefined();
});

test("translateModel raises the missing-options error rather than dropping the model", () => {
  // Returning undefined would read as "the host stopped serving this model"
  // and delete an already-synced file on the next hourly run.
  expect(() =>
    hopscotch.translateModel(
      model({
        id: "anthropic/claude-opus-4-7",
        uniblock: { model_id: "claude-opus-4-7" },
      }),
      { existing: () => undefined, authored: () => undefined },
    ),
  ).toThrow(MissingReasoningOptionsError);
});

test("a model served on a non-chat endpoint is skipped", () => {
  expect(
    hopscotch.translateModel(
      model({ uniblock: { endpoint_families: ["embeddings"] } }),
      { existing: () => undefined, authored: () => undefined },
    ),
  ).toBeUndefined();
});

test("a missing max output is left to the base model rather than filled with the context window", () => {
  const translated = hopscotch.translateModel(
    model({ uniblock: { max_output_tokens: null } }),
    { existing: () => undefined, authored: () => undefined },
  );
  const limit = (translated?.model as { limit?: Record<string, number> }).limit;
  expect(limit?.output).toBeUndefined();
  expect(limit?.context).toBe(200_000);
});

test("prices are thousandths of the currency unit per million tokens", () => {
  const translated = hopscotch.translateModel(model(), {
    existing: () => undefined,
    authored: () => undefined,
  });
  expect((translated?.model as { cost?: Record<string, number> }).cost).toMatchObject({
    input: 5,
    output: 25,
  });
});

test("a proven vision = no takes image input off the model", () => {
  const translated = hopscotch.translateModel(
    model({ uniblock: { capabilities: { vision: "no" } } }),
    { existing: () => undefined, authored: () => undefined },
  );
  const built = translated?.model as {
    attachment?: boolean;
    modalities?: { input?: string[] };
  };
  expect(built.attachment).toBe(false);
  expect(built.modalities?.input).toEqual(["text"]);
});

test("an unknown vision leaves the base model's modalities alone", () => {
  const translated = hopscotch.translateModel(
    model({ uniblock: { capabilities: { vision: "unknown" } } }),
    { existing: () => undefined, authored: () => undefined },
  );
  const built = translated?.model as {
    attachment?: boolean;
    modalities?: unknown;
  };
  expect(built.attachment).toBeUndefined();
  expect(built.modalities).toBeUndefined();
});

test("a cache rate equal to the input rate is published, because it is charged", () => {
  // This host charges the input rate for a cache read where no distinct rate
  // was ever decided, so dropping it would let the base model supply a cheaper
  // figure and understate what a caller pays.
  const translated = hopscotch.translateModel(
    model({
      uniblock: {
        input_rate_thousandths: 5_000,
        cache_read_rate_thousandths: 5_000,
      },
    }),
    { existing: () => undefined, authored: () => undefined },
  );
  const cost = (translated?.model as { cost?: Record<string, number> }).cost;
  expect(cost?.input).toBe(5);
  expect(cost?.cache_read).toBe(5);
});

test("a cache rate that differs from the input rate is published", () => {
  const translated = hopscotch.translateModel(
    model({
      uniblock: {
        input_rate_thousandths: 5_000,
        cache_read_rate_thousandths: 500,
      },
    }),
    { existing: () => undefined, authored: () => undefined },
  );
  expect(
    (translated?.model as { cost?: Record<string, number> }).cost?.cache_read,
  ).toBe(0.5);
});

test("a window matching the base model's input ceiling does not shrink its context", () => {
  // Hopscotch reports 272,000 for GPT-5, which is the lab's `limit.input`
  // beside a `limit.context` of 400,000.
  const translated = hopscotch.translateModel(
    model({
      id: "openai-main/gpt-5",
      uniblock: {
        model_id: "gpt-5",
        author_slug: "openai",
        provider_families: ["openai"],
        context_window_tokens: 272_000,
        max_output_tokens: 128_000,
      },
    }),
    { existing: () => undefined, authored: () => undefined },
  );
  // The base's own 400,000 window stands, so no context override is written.
  // Its output matches the base too, which factorBaseModel then drops, leaving
  // no limit block at all.
  const limit = (translated?.model as { limit?: Record<string, number> }).limit;
  expect(limit?.context).toBeUndefined();
});

test("a window the base model does not already state is published", () => {
  const translated = hopscotch.translateModel(
    model({ uniblock: { context_window_tokens: 123_456 } }),
    { existing: () => undefined, authored: () => undefined },
  );
  expect(
    (translated?.model as { limit?: Record<string, number> }).limit?.context,
  ).toBe(123_456);
});

test("a vision claim that contradicts a text-only base is left unresolved", () => {
  // deepseek/deepseek-v4-pro takes text alone upstream while this host reports
  // vision. Writing attachment = true beside a text-only input would publish a
  // file that contradicts itself.
  const translated = hopscotch.translateModel(
    model({
      id: "deepinfra/DeepSeek-V4-Pro",
      uniblock: {
        model_id: "deepseek-ai/DeepSeek-V4-Pro",
        author_slug: "deepseek",
        provider_families: ["deepinfra"],
        capabilities: { vision: "yes" },
      },
    }),
    { existing: () => undefined, authored: () => undefined },
  );
  expect(
    (translated?.model as { attachment?: boolean }).attachment,
  ).toBeUndefined();
});

test("a withdrawn model says so", () => {
  const translated = hopscotch.translateModel(
    model({ uniblock: { deprecated_at: 1_780_000_000 } }),
    { existing: () => undefined, authored: () => undefined },
  );
  expect((translated?.model as { status?: string }).status).toBe("deprecated");
});

test("the header names only the controls the file publishes", () => {
  // A file publishing a toggle alone must not advertise a budget field.
  const toggleOnly = hopscotch.translateModel(
    model({
      id: "anthropic/claude-sonnet-5",
      uniblock: { model_id: "claude-sonnet-5" },
    }),
    { existing: () => undefined, authored: () => undefined },
  );
  expect(toggleOnly?.header).toContain("# Toggle: thinking.type = enabled|disabled");
  expect(toggleOnly?.header).not.toContain("Budget");

  const budgetOnly = hopscotch.translateModel(model(), {
    existing: () => undefined,
    authored: () => undefined,
  });
  expect(budgetOnly?.header).toContain("# Budget: thinking.budget_tokens");
  expect(budgetOnly?.header).not.toContain("Toggle");
});

test("an effort ladder names its own wire path", () => {
  const translated = hopscotch.translateModel(
    model({
      id: "openai-main/gpt-5",
      uniblock: {
        model_id: "gpt-5",
        author_slug: "openai",
        provider_families: ["openai"],
      },
    }),
    { existing: () => undefined, authored: () => undefined },
  );
  expect(translated?.header).toContain("# Effort: reasoning_effort =");
});
