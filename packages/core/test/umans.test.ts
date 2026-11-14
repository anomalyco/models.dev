import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  buildUmansModel,
  fetchUmansModels,
  labModelID,
  parseUmansModels,
  reasoningOptions,
  type UmansCard,
  umansAI,
  umansAICodingPlan,
  umansCost,
  umansLimit,
} from "../src/sync/providers/umans.js";

function context(authored: Record<string, ExistingModel>) {
  return { existing: (id: string) => authored[id], authored: (id: string) => authored[id] };
}

// A trimmed mirror of one `GET /v1/models/info` card.
function card(overrides: Partial<UmansCard> = {}): UmansCard {
  return {
    display_name: "Umans Kimi K3.1 Pro",
    capabilities: {
      context_window: 1_048_576,
      max_completion_tokens: 131_072,
      recommended_max_tokens: 131_071,
      supports_vision: true,
      supports_tools: true,
      reasoning: { supported: true, can_disable: true, levels: ["none", "low", "high", "max"] },
    },
    weights: { hf_url: "https://huggingface.co/moonshotai/Kimi-K3.1-Pro" },
    pricing: { input: 2, output: 10, cache_read: 0.2, cache_write: 0 },
    ...overrides,
  };
}

function withReasoning(reasoning: UmansCard["capabilities"]["reasoning"]): UmansCard {
  const base = card();
  return { ...base, capabilities: { ...base.capabilities, reasoning } };
}

function source(info: Record<string, UmansCard>, past: Record<string, unknown> = {}) {
  return parseUmansModels({ info, past });
}

const lineup = {
  "umans-kimi-k3.1-pro": card(),
  "umans-glm-5.3": card({ weights: { hf_url: "https://huggingface.co/zai-org/GLM-5.3" } }),
  "umans-coder": card({
    weights: { hf_url: "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017" },
    pricing: { input: 0.15, output: 0.6, cache_read: 0.028, cache_write: 0 },
  }),
};

// The hand-authored umans-coder file before it moved off GLM-5.3-Flash.
const coderOnGLM = {
  base_model: "zhipuai/glm-5.3-flash",
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
  limit: { output: 131_071 },
} as unknown as ExistingModel;

function listed(id: keyof typeof lineup | string, info: Record<string, UmansCard> = lineup) {
  return source(info).find((model) => model.id === id)!;
}

test("maps a served checkpoint's Hugging Face repo to its lab entry", () => {
  expect(labModelID("https://huggingface.co/moonshotai/Kimi-K3.1-Pro")).toBe("moonshotai/kimi-k3.1-pro");
  expect(labModelID("https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017"))
    .toBe("deepseek/deepseek-v4.1-flash-1017");
  expect(labModelID("https://huggingface.co/zai-org/GLM-5.3")).toBe("zhipuai/glm-5.3");
  expect(labModelID("https://huggingface.co/Qwen/Qwen3.6-35B-A3B-FP8")).toBe("alibaba/qwen3.6-35b-a3b");
  expect(labModelID("https://example.com/weights")).toBeUndefined();
  expect(labModelID(undefined)).toBeUndefined();
});

test("publishes the pay-per-token price and leaves an unbilled cache write out", () => {
  expect(umansCost(card(), false)).toEqual({ input: 2, output: 10, cache_read: 0.2 });
});

test("rounds away the API's floating point artifacts", () => {
  const cost = umansCost(card({ pricing: { input: 0.15, output: 0.6, cache_read: 0.028000000000000004 } }), false);
  expect(cost?.cache_read).toBe(0.028);
});

test("prices every coding plan model at zero, the plan being flat-fee", () => {
  expect(umansCost(card(), true)).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
});

test("caps the output one below max_completion_tokens, which the API rejects", () => {
  expect(umansLimit(card())).toEqual({ context: 1_048_576, output: 131_071 });
  const unadvised = card();
  delete unadvised.capabilities.recommended_max_tokens;
  expect(umansLimit(unadvised).output).toBe(131_071);
});

test("keeps a fast-tier budget below the cap when the card recommends it", () => {
  const flash = card();
  flash.capabilities = { ...flash.capabilities, context_window: 262_144, max_completion_tokens: 262_144, recommended_max_tokens: 32_768 };
  expect(umansLimit(flash)).toEqual({ context: 262_144, output: 32_768 });
});

test("turns the card's levels into a toggle and efforts, none being the toggle", () => {
  expect(reasoningOptions(card())).toEqual([{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }]);
});

test("gives an always-thinking model efforts without a toggle", () => {
  expect(reasoningOptions(withReasoning({ supported: true, can_disable: false, levels: ["low", "high", "max"] })))
    .toEqual([{ type: "effort", values: ["low", "high", "max"] }]);
});

test("sorts efforts low to high so a reordered card never rewrites files", () => {
  expect(reasoningOptions(withReasoning({ supported: true, can_disable: true, levels: ["max", "none", "low", "high"] })))
    .toEqual([{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }]);
});

test("writes no caller control only when the card publishes an empty list", () => {
  expect(reasoningOptions(withReasoning({ supported: true, can_disable: false, levels: [] }))).toEqual([]);
});

test("reads an omitted or unknown level list as unknown, not as no control", () => {
  expect(reasoningOptions(withReasoning({ supported: true, can_disable: true }))).toBeUndefined();
  expect(reasoningOptions(withReasoning({ supported: true, can_disable: true, levels: ["low", "turbo"] })))
    .toBeUndefined();
});

test("keeps the authored controls when the card omits its levels", () => {
  const coder = { ...lineup["umans-coder"], capabilities: { ...lineup["umans-coder"].capabilities, reasoning: { supported: true } } };
  const model = buildUmansModel("umans-coder", coder, false, coderOnGLM) as Record<string, unknown>;
  expect(model.reasoning_options).toEqual([{ type: "effort", values: ["low", "high", "max"] }]);
});

test("routes a new reasoner without published levels to the missing-model flow", () => {
  const unknown = withReasoning({ supported: true, can_disable: true });
  expect(() => buildUmansModel("umans-kimi-k3.1-pro", unknown, false, undefined)).toThrow(MissingReasoningOptionsError);
});

test("refuses a truncated listing rather than retiring the lineup", () => {
  expect(() => source({ "umans-coder": card() })).toThrow(/below the 3 needed/);
});

test("fails the run rather than syncing from a degraded response", async () => {
  const unavailable = () => Promise.resolve(new Response("", { status: 503, statusText: "Service Unavailable" }));
  await expect(fetchUmansModels(unavailable as unknown as typeof fetch)).rejects.toThrow(/503 Service Unavailable/);
});

test("skips a seat-gated lab most users cannot call", () => {
  const lab = listed("umans-kimi-k3.1-pro-lab", { ...lineup, "umans-kimi-k3.1-pro-lab": card({ stage: "playground" }) });
  expect(umansAI.translateModel(lab, context({}))).toBeUndefined();
  expect(umansAI.sourceID(lab)).toBeUndefined();
});

test("creates a new model as an overlay on its lab with the API's facts", () => {
  const translated = umansAI.translateModel(listed("umans-kimi-k3.1-pro"), context({}));
  const model = (translated as { model: Record<string, unknown> }).model;
  expect(model.base_model).toBe("moonshotai/kimi-k3.1-pro");
  expect(model.cost).toEqual({ input: 2, output: 10, cache_read: 0.2 });
  expect(model.reasoning_options).toEqual([{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }]);
  // Vision keeps the lab's documented inputs, and nothing unsourced is asserted.
  expect(model.modalities).toBeUndefined();
  expect(model.structured_output).toBeUndefined();
  expect((translated as { header?: string }).header).toContain("# Toggle: thinking.type = enabled|disabled");
});

test("narrows a new model to text input only when the card says no vision", () => {
  const textOnly = card({ capabilities: { ...card().capabilities, supports_vision: false } });
  const model = buildUmansModel("umans-kimi-k3.1-pro", textOnly, false, undefined) as Record<string, unknown>;
  expect(model.modalities).toEqual({ input: ["text"] });
  const indirect = card({ capabilities: { ...card().capabilities, supports_vision: "via-handoff" } });
  expect((buildUmansModel("umans-kimi-k3.1-pro", indirect, false, undefined) as Record<string, unknown>).modalities)
    .toBeUndefined();
});

test("creates the same model at zero cost on the coding plan", () => {
  const model = (umansAICodingPlan.translateModel(listed("umans-kimi-k3.1-pro"), context({})) as {
    model: Record<string, unknown>;
  }).model;
  expect(model.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
});

test("moves an alias to the weights it now serves, factored from its own fields", () => {
  const model = buildUmansModel("umans-coder", lineup["umans-coder"], false, coderOnGLM) as Record<string, unknown>;
  expect(model.base_model).toBe("deepseek/deepseek-v4.1-flash-1017");
  expect(model.description).toBeUndefined();
  expect(model.family).toBeUndefined();
  expect(model.release_date).toBeUndefined();
  expect(model.cost).toEqual({ input: 0.15, output: 0.6, cache_read: 0.028 });
});

test("keeps the authored price when the card publishes none", () => {
  const unpriced = { ...lineup["umans-coder"], pricing: undefined };
  const model = buildUmansModel("umans-coder", unpriced, false, coderOnGLM) as Record<string, unknown>;
  expect(model.cost).toEqual({ input: 0.15, output: 0.5, cache_read: 0.03 });
});

test("keeps a curated status unless the card announces a retirement", () => {
  const beta = { ...coderOnGLM, status: "beta" } as unknown as ExistingModel;
  expect((buildUmansModel("umans-coder", lineup["umans-coder"], false, beta) as Record<string, unknown>).status)
    .toBe("beta");
  const retiring = { ...lineup["umans-coder"], deprecation: { sunset_date: "2026-12-01", replacement: "umans-flash" } };
  expect((buildUmansModel("umans-coder", retiring, false, beta) as Record<string, unknown>).status).toBe("deprecated");
});

test("marks a retired id deprecated and leaves the rest of its file as authored", () => {
  const retired = source(lineup, { "umans-kimi-k3": { retired_on: "2026-11-09", replacement: "umans-kimi-k3.1-pro" } })
    .find((model) => model.id === "umans-kimi-k3")!;
  const authored = { base_model: "moonshotai/kimi-k3", cost: { input: 3, output: 15, cache_read: 0.3 } } as unknown as ExistingModel;
  const translated = umansAI.translateModel(retired, context({ "umans-kimi-k3": authored }));
  expect((translated as { model: Record<string, unknown> }).model).toEqual({ ...authored, status: "deprecated" });
});

test("ignores a retired id that has no local file", () => {
  const retired = source(lineup, { "umans-glm-5.1": { retired_on: "2026-08-13" } })
    .find((model) => model.id === "umans-glm-5.1")!;
  expect(umansAI.translateModel(retired, context({}))).toBeUndefined();
  expect(umansAI.sourceID(retired)).toBeUndefined();
});

test("never lists a retired id twice when the past feed and the listing overlap", () => {
  const models = source(lineup, { "umans-coder": { retired_on: "2026-09-10" } });
  expect(models.filter((model) => model.id === "umans-coder")).toHaveLength(1);
});
