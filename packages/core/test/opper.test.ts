import { expect, test } from "bun:test";

import {
  assignLabels,
  buildOpperModel,
  resolveOpperBaseModel,
  type OpperModel,
} from "../src/sync/providers/opper.js";

function route(overrides: Partial<OpperModel> = {}): OpperModel {
  return {
    id: "tensorx/deepseek/deepseek-v4-flash",
    type: "llm",
    name: "DeepSeek V4 Flash",
    model: "deepseek-v4-flash",
    maker: "deepseek",
    provider: "tensorx",
    provider_display_name: "TensorX",
    region: "EU",
    capabilities: ["text", "tools"],
    context_window: 200_000,
    max_output_tokens: 32_000,
    ...overrides,
  } as OpperModel;
}

function build(model: OpperModel, base = "deepseek/deepseek-v4-flash", existing?: unknown) {
  assignLabels([model]);
  return buildOpperModel(model, base, existing as never) as Record<string, unknown>;
}

test("the lab comes from `maker`, not from the route ID's provider prefix", () => {
  // `tensorx/deepseek/deepseek-v4-flash` names the host, not the lab, so a
  // prefix-based resolver would look for a `tensorx` namespace that cannot exist.
  expect(resolveOpperBaseModel(route())).toBe("deepseek/deepseek-v4-flash");
});

test.each([
  { maker: "zai", model: "glm-5.2", expected: "zhipuai/glm-5.2" },
  { maker: "moonshot", model: "kimi-k3", expected: "moonshotai/kimi-k3" },
])("maps the $maker namespace onto models.dev's", ({ maker, model, expected }) => {
  expect(resolveOpperBaseModel(route({ maker, model }))).toBe(expected);
});

test("a lab with no models.dev entry resolves to nothing rather than inventing one", () => {
  expect(resolveOpperBaseModel(route({ maker: "nobody", model: "no-such-model" }))).toBeUndefined();
});

test("prices pass through per million tokens, with float noise rounded away", () => {
  // A derived cached rate arrives as 0.029759999999999998; the TOML writer
  // would otherwise emit that verbatim.
  const built = build(route({
    pricing: {
      billing_unit: "per_mtok",
      input: [0.1488],
      output: [0.2976],
      cached_input: [0.029759999999999998],
    },
  }));
  expect(built.cost).toEqual({ input: 0.1488, output: 0.2976, cache_read: 0.02976 });
});

test("a route quoting no price gets no cost section rather than a fabricated zero", () => {
  expect(build(route()).cost).toBeUndefined();
});

test("banded thresholds become context tiers priced at the band past the boundary", () => {
  const built = build(route({
    pricing: {
      billing_unit: "per_mtok",
      thresholds: [131_072],
      input: [0.05, 0.12],
      output: [0.4, 0.96],
    },
  }));
  expect((built.cost as { tiers: unknown }).tiers).toEqual([
    { tier: { type: "context", size: 131_072 }, input: 0.12, output: 0.96 },
  ]);
});

test("a full-request surcharge becomes a tier, multiplying each side by its own factor", () => {
  // Distinct from banded thresholds: crossing the boundary reprices the WHOLE
  // request, and cache reads are input-side so they take the input multiplier.
  const built = build(route({
    pricing: {
      billing_unit: "per_mtok",
      input: [5],
      output: [30],
      cached_input: [0.5],
      input_surcharge_threshold_tokens: 272_000,
      input_surcharge_multiplier: 2,
      output_surcharge_multiplier: 1.5,
    },
  }));
  expect((built.cost as { tiers: unknown }).tiers).toEqual([
    { tier: { type: "context", size: 272_000 }, input: 10, output: 45, cache_read: 1 },
  ]);
});

test("an authored long-context tier survives a route that quotes none", () => {
  // Opper does not record the surcharge on every route that has one, so silence
  // must not delete a rate a human established.
  const tiers = [{ tier: { type: "context" as const, size: 272_000 }, input: 60, output: 270 }];
  const built = build(
    route({ pricing: { billing_unit: "per_mtok", input: [30], output: [180] } }),
    "openai/gpt-5.5-pro",
    { cost: { tiers } },
  );
  expect((built.cost as { tiers: unknown }).tiers).toEqual(tiers);
});

test("the effort ladder is taken from the route, which differs between hosts", () => {
  const built = build(route({
    capabilities: ["text", "tools", "reasoning"],
    params: { reasoning: { supported: ["none", "low", "high"] } },
  }));
  expect(built.reasoning_options).toEqual([{ type: "effort", values: ["none", "low", "high"] }]);
});

test("a route stating no ladder states nothing, so the field is left for the runner", () => {
  // Grok 4.6 reasons and takes an effort, but carries no params entry. Stamping
  // [] here would shadow an authored ladder with "no controls".
  const built = build(route({ capabilities: ["text", "tools", "reasoning"] }));
  expect("reasoning_options" in built).toBe(false);
});

test.each([
  { label: "the reasoning capability", capabilities: ["text", "reasoning"] },
  { label: "the thinking capability", capabilities: ["text", "thinking"] },
])("$label marks a reasoner", ({ capabilities }) => {
  // Against a base that does not reason, so the override is actually written
  // rather than dropped as inherited.
  expect(build(route({ capabilities }), "alibaba/qwen-max").reasoning).toBe(true);
});

test("a capability Opper has not recorded is never asserted as absent", () => {
  // Opper records a capability once verified for a route, so its absence is
  // silence. Writing `false` would contradict the lab entry and, for reasoning,
  // strip the base model's effort controls.
  const built = build(route({ capabilities: ["text"] }));
  expect("reasoning" in built).toBe(false);
  expect("tool_call" in built).toBe(false);
  expect("structured_output" in built).toBe(false);
});

test("modalities widen the lab entry and never narrow it", () => {
  // deepseek-v4-flash declares text input upstream; a route adding PDF widens it.
  const built = build(route({ capabilities: ["text", "pdf"] }));
  expect((built.modalities as { input: string[] }).input).toEqual(["text", "pdf"]);
});

test("an unstated output cap falls back to an authored figure before the whole window", () => {
  // Opper leaves max_output_tokens at 0 for many routes, which says nothing
  // about generation length; claiming the full 1M window would be a fiction.
  const built = build(route({ max_output_tokens: 0 }), "deepseek/deepseek-v4-flash", {
    limit: { output: 64_000 },
  });
  expect((built.limit as { output: number }).output).toBe(64_000);
});

test("labels qualify only as far as they must to stay unique", () => {
  const solo = route({ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" });
  const eu = route({ id: "alibaba:eu/qwen3-vl-flash", name: "Qwen3-VL-Flash", provider: "alibaba:eu", provider_display_name: "Alibaba Cloud", region: "EU" });
  const global = route({ id: "alibaba:global/qwen3-vl-flash", name: "Qwen3-VL-Flash", provider: "alibaba:global", provider_display_name: "Alibaba Cloud", region: "GLOBAL" });
  // Same display name AND same region: only the provider slug separates them.
  const zdr = route({ id: "azure-zdr/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "azure-zdr", provider_display_name: "Azure", region: "EU" });
  const azure = route({ id: "azure/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "azure", provider_display_name: "Azure", region: "EU" });

  const labels = assignLabels([solo, eu, global, zdr, azure]);
  expect(labels.get("anthropic/claude-sonnet-5")).toBe("Claude Sonnet 5");
  expect(labels.get("alibaba:eu/qwen3-vl-flash")).toBe("Qwen3-VL-Flash (Alibaba Cloud, EU)");
  expect(labels.get("alibaba:global/qwen3-vl-flash")).toBe("Qwen3-VL-Flash (Alibaba Cloud)");
  expect(labels.get("azure-zdr/gpt-5.6-sol")).toBe("GPT-5.6 Sol (azure-zdr)");
  expect(labels.get("azure/gpt-5.6-sol")).toBe("GPT-5.6 Sol (azure)");
  expect(new Set(labels.values()).size).toBe(5);
});
