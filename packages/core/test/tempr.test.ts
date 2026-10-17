import { expect, test } from "bun:test";

import { buildTemprModel, encodeOptions, header, perMillion, TemprCatalog, TemprModel, tempr } from "../src/sync/providers/tempr.js";

function catalogModel(overrides: Record<string, unknown> = {}, temprOverrides: Record<string, unknown> = {}) {
  return TemprModel.parse({
    id: "deepinfra/Qwen/Qwen3.7-Max",
    name: "Qwen3.7 Max",
    pricing: { prompt: "0.0000025", completion: "0.0000075" },
    supported_parameters: ["max_tokens", "tools", "tool_choice"],
    ...overrides,
    tempr: {
      provider: "deepinfra",
      model: "Qwen/Qwen3.7-Max",
      type: "language",
      status: null,
      price_source: "models.dev",
      reasoning_forwarded: true,
      models_dev: { provider: "deepinfra", model: "Qwen/Qwen3.7-Max", canonical_model_id: "alibaba/qwen3.7-max" },
      ...temprOverrides,
    },
  });
}

// Files the adapter reads, keyed by repo-relative path.
function files(entries: Record<string, Record<string, unknown>>) {
  return (relative: string) => entries[relative];
}

const counterpart = {
  base_model: "alibaba/qwen3.7-max",
  last_updated: "2026-09-01",
  cost: { input: 2.5, output: 7.5 },
  limit: { output: 32_768 },
  provider: { npm: "@ai-sdk/deepinfra" },
};

test("mirrors the provider entry's own overrides on the same base_model", () => {
  const built = buildTemprModel(catalogModel(), files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": counterpart }));

  // Its dates and description are catalogue metadata the lab file already has.
  expect(built?.model).toEqual({
    base_model: "alibaba/qwen3.7-max",
    cost: { input: 2.5, output: 7.5 },
    limit: { output: 32_768 },
  } as never);
  expect(built?.header).toBe("");
});

test("takes Tempr's price where Tempr's host catalog confirms the model", () => {
  const model = catalogModel(
    { pricing: { prompt: "0.000002", completion: "0.000006", input_cache_read: "0.0000004", overrides: [{ min_prompt_tokens: 32_000, prompt: "0.000005", completion: "0.000015" }] } },
    { price_source: "tempr" },
  );

  const built = buildTemprModel(model, files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": counterpart }));

  expect((built?.model as { cost: unknown }).cost).toEqual({
    input: 2,
    output: 6,
    cache_read: 0.4,
    tiers: [{ input: 5, output: 15, tier: { type: "context", size: 32_000 } }],
  });
});

test("keeps the provider entry's cost when Tempr's price is the same", () => {
  const built = buildTemprModel(catalogModel({}, { price_source: "tempr" }), files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": counterpart }));

  expect((built?.model as { cost: unknown }).cost).toBe(counterpart.cost);
});

test("skips a model whose provider entry has no base_model", () => {
  const { base_model: _, ...hostDefined } = counterpart;

  expect(buildTemprModel(catalogModel(), files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": hostDefined }))).toBeUndefined();
  expect(buildTemprModel(catalogModel(), files({}))).toBeUndefined();
});

test("writes Tempr's reasoning controls, and the request fields that set them", () => {
  const model = catalogModel(
    { supported_parameters: ["reasoning"] },
    { reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }] },
  );

  const built = buildTemprModel(model, files({
    "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": { ...counterpart, reasoning_options: [{ type: "effort", values: ["high"] }] },
  }));

  expect((built?.model as { reasoning_options: unknown }).reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "high", "max"] },
  ]);
  expect(built?.header.split("\n")).toEqual([
    "# Tempr Gateway: https://temprhq.io/docs/gateway-chat-completions#reasoning",
    '# Toggle: reasoning.enabled = true|false (reasoning.effort = "none" also turns it off)',
    "# Effort: reasoning.effort = none|low|high|max (alias: top-level reasoning_effort)",
    "# /v1/messages: thinking.type = enabled|disabled; output_config.effort = low|high|max",
    "# /v1/responses: reasoning.effort = none|low|high|max",
    "",
  ]);
});

test("writes no controls for a host Tempr sends no reasoning settings to", () => {
  const model = catalogModel(
    { supported_parameters: ["reasoning"] },
    { reasoning_forwarded: false, reasoning_options: [] },
  );

  const built = buildTemprModel(model, files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": counterpart }));

  expect((built?.model as { reasoning_options: unknown }).reasoning_options).toEqual([]);
  expect(built?.header).toContain("Tempr forwards no reasoning settings to this host");
});

test("encodes off the way the provider entry does", () => {
  const temprOptions = [{ type: "toggle" as const }, { type: "effort" as const, values: ["high"] }];

  expect(encodeOptions(temprOptions, [{ type: "effort", values: ["none", "high"] }])).toEqual([{ type: "effort", values: ["none", "high"] }]);
  expect(encodeOptions(temprOptions, [])).toEqual([{ type: "toggle" }, { type: "effort", values: ["high"] }]);
});

test("explains an empty control set, for a host or the lab's own API", () => {
  expect(header([], true, true).join("\n")).toContain("deliberately");
  expect(header([], true, false).join("\n")).toContain("for this model on this host: it reasons at its own depth");
  expect(header([], true, false, false).join("\n")).toContain("for this model: it reasons at its own depth");
});

test("inherits the lab's description rather than the provider entry's", () => {
  const built = buildTemprModel(catalogModel(), files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": { ...counterpart, description: "Host blurb" } }));

  expect((built?.model as { description?: string }).description).toBeUndefined();
});

test("converts per-token prices without float noise", () => {
  expect(perMillion("0.00000125")).toBe(1.25);
  expect(perMillion("0.0000004")).toBe(0.4);
  expect(perMillion(undefined)).toBeUndefined();
});

test("refuses a partial catalog", () => {
  expect(() => tempr.parseModels({ schema: 1, data: [] })).toThrow(/refusing/);
  expect(() => TemprCatalog.parse({ schema: 2, data: [] })).toThrow();
});

test("reads only plain provider and model ids from the catalog", () => {
  const read = files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": counterpart });
  for (const models_dev of [
    { provider: "deepinfra", model: "../../providers/other/models/x" },
    { provider: "../providers", model: "x" },
    { provider: "deepinfra", model: "/etc/passwd" },
  ]) {
    expect(buildTemprModel(catalogModel({}, { models_dev }), read)).toBeUndefined();
  }
});

test("keeps the authored controls when the catalog omits them, and writes none only when it says none", () => {
  const read = files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": counterpart });

  const omitted = buildTemprModel(catalogModel({ supported_parameters: ["reasoning"] }), read);
  expect((omitted?.model as { reasoning_options?: unknown }).reasoning_options).toBeUndefined();
  expect(omitted?.header).toBe("");
  expect(omitted?.controlsUnknown).toBe(true);

  const none = buildTemprModel(catalogModel({ supported_parameters: ["reasoning"] }, { reasoning_options: [] }), read);
  expect((none?.model as { reasoning_options?: unknown }).reasoning_options).toEqual([]);
});

test("treats include_reasoning as reasoning, as the OpenRouter sync does", () => {
  const built = buildTemprModel(
    catalogModel({ supported_parameters: ["include_reasoning"] }, { reasoning_options: [{ type: "effort", values: ["low", "high"] }] }),
    files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": counterpart }),
  );

  expect((built?.model as { reasoning_options?: unknown }).reasoning_options).toEqual([{ type: "effort", values: ["low", "high"] }]);
});

test("keeps the mirrored entry's reasoning rate when Tempr's price replaces the rest", () => {
  const built = buildTemprModel(
    catalogModel({ pricing: { prompt: "0.000002", completion: "0.000006" } }, { price_source: "tempr" }),
    files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": { ...counterpart, cost: { input: 2.5, output: 7.5, reasoning: 7.5 } } }),
  );

  expect((built?.model as { cost: unknown }).cost).toEqual({ input: 2, output: 6, reasoning: 7.5 });
});

test("describes only the controls it lists: a budget-only model gets no effort line", () => {
  const lines = header([{ type: "toggle" }, { type: "budget_tokens", min: 1_024 }], true, true);

  const text = lines.join("\n");
  expect(text).not.toContain("reasoning.effort = none|low");
  expect(text).toContain("/v1/messages: thinking.type = enabled|disabled; thinking.budget_tokens");
});

test("a skipped model keeps its entry instead of being deleted", () => {
  expect(tempr.missingModelID?.(catalogModel())).toBe("deepinfra/Qwen/Qwen3.7-Max");
});

test("does not publish effort values the schema doesn't know", () => {
  const built = buildTemprModel(
    catalogModel({ supported_parameters: ["reasoning"] }, { reasoning_options: [{ type: "effort", values: ["low", "turbo"] }] }),
    files({ "providers/deepinfra/models/Qwen/Qwen3.7-Max.toml": counterpart }),
  );

  expect(built?.controlsUnknown).toBe(true);
  expect((built?.model as { reasoning_options?: unknown }).reasoning_options).toBeUndefined();
});

test("does not write a file for an unsafe catalog id", () => {
  const unsafe = catalogModel({ id: "deepinfra/../../etc/x" });

  expect(tempr.translateModel(unsafe, { existing: () => undefined, authored: () => undefined })).toBeUndefined();
  expect(tempr.missingModelID?.(unsafe)).toBeUndefined();
});
