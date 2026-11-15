import { expect, test } from "bun:test";

import { syncProviderMatrix } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  fetchTrustedRouterModels,
  isGpt5Plus,
  labMimeInput,
  trustedrouter,
  TrustedRouterResponse,
  type TrustedRouterModel,
} from "../src/sync/providers/trustedrouter.js";

function model(overrides: Partial<TrustedRouterModel> = {}): TrustedRouterModel {
  return {
    id: "anthropic/claude-sonnet-4.5",
    name: "Anthropic: Claude Sonnet 4.5",
    created: 0,
    context_length: 1_000_000,
    architecture: { input_modalities: ["image", "text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000003165", completion: "0.000015825", input_cache_read: "0.0000003165" },
    top_provider: { context_length: 1_000_000, max_completion_tokens: null },
    supported_parameters: ["tools", "tool_choice", "temperature", "reasoning", "structured_outputs"],
    reasoning: { mandatory: false, supported_efforts: ["high", "low"] },
    trustedrouter: { route_kind: "model", internal_only: false, configuration_hidden: false, synthetic_monitor: false },
    ...overrides,
  };
}

const none = { existing: () => undefined, authored: () => undefined };

test("TrustedRouter is registered for scheduled sync and fetches its public catalog without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === trustedrouter.id)).toBe(true);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ data: [model()] });
  }) as unknown as typeof fetch;
  await fetchTrustedRouterModels(fetcher);
  expect(request!.url).toBe("https://api.trustedrouter.com/v1/models");
  expect(request!.headers.get("authorization")).toBeNull();

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  expect(fetchTrustedRouterModels(unavailable)).rejects.toThrow("503");
});

test("empty and duplicate inventories fail before any catalog writes", () => {
  expect(() => TrustedRouterResponse.parse({ data: [] })).toThrow("empty catalog");
  expect(() => TrustedRouterResponse.parse({ data: [model(), model()] })).toThrow("duplicate model IDs");
});

test("only public, tool-capable text chat models with prices are synced", () => {
  for (const source of [
    model({ supported_parameters: ["temperature"] }),
    model({ architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] } }),
    model({ pricing: {} }),
    model({ context_length: null }),
    model({ trustedrouter: { internal_only: true } }),
    model({ trustedrouter: { synthetic_monitor: true } }),
    model({ id: "example/unknown-chat" }),
  ]) {
    expect(trustedrouter.translateModel(source, none)).toBeUndefined();
  }
});

test("models factor onto the lab base and keep TrustedRouter's prices and published efforts", () => {
  const translated = trustedrouter.translateModel(model(), none)!;
  expect(translated.model).toMatchObject({
    base_model: "anthropic/claude-sonnet-4-5",
    cost: { input: 3.165, output: 15.825, cache_read: 0.3165 },
    reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }],
  });
});

test("an empty or missing effort list is on/off only, never an empty effort control", () => {
  for (const reasoning of [{ mandatory: false, supported_efforts: [] }, { mandatory: false, supported_efforts: null }]) {
    const translated = trustedrouter.translateModel(model({ reasoning }), none)!;
    expect((translated.model as { reasoning_options?: unknown }).reasoning_options).toEqual([{ type: "toggle" }]);
  }
});

test("trustedrouter/* routes keep their authored files and are never generated", () => {
  const route = model({ id: "trustedrouter/zdr", supported_parameters: [], trustedrouter: { route_kind: "zdr_pool" } });
  expect(trustedrouter.sourceID!(route)).toBe("trustedrouter/zdr");
  expect(trustedrouter.translateModel(route, none)).toBeUndefined();
  const authored = { name: "ZDR" } as never;
  expect(trustedrouter.translateModel(route, { existing: () => authored, authored: () => authored })).toEqual({
    id: "trustedrouter/zdr",
    model: authored,
  });
});

test("generic input kinds take the lab's MIME entries, and match the lab list by inheriting it", () => {
  const lab = ["text", "image/jpeg", "image/png", "application/pdf"];
  expect(labMimeInput(["text", "image"], lab)).toEqual(["text", "image/jpeg", "image/png"]);
  expect(labMimeInput(["text", "image", "pdf"], lab)).toBeUndefined();
  expect(labMimeInput(["text", "audio"], lab)).toEqual(["text", "audio"]);
  expect(labMimeInput(["text"], undefined)).toEqual(["text"]);
});

test("headers state the reasoning wire fields each file uses", () => {
  const header = trustedrouter.translateModel(model(), none)!.header!;
  expect(header).toContain("# Toggle: reasoning.enabled = true|false\n");
  expect(header).toContain("# Effort: reasoning.effort = low|high\n");
  const mandatory = trustedrouter.translateModel(
    model({ reasoning: { mandatory: true, supported_efforts: ["high"] } }),
    none,
  )!.header!;
  expect(mandatory).not.toContain("# Toggle:");
});

test("a passed-through reasoning parameter does not make a non-reasoning lab model a reasoner", () => {
  // Gemma 3 lists `reasoning` but publishes no controls; its lab file says it does not reason.
  const gemma = model({ id: "google/gemma-3-12b-it", name: "Google: Gemma 3 12B", reasoning: undefined });
  const translated = trustedrouter.translateModel(gemma, none)!.model as { reasoning?: boolean; reasoning_options?: unknown };
  expect(translated.reasoning).not.toBe(true);
  expect(translated.reasoning_options).toBeUndefined();
});

test("a reasoner without stated controls is left for hand authoring, never written as always-on", () => {
  // No `reasoning` object: TrustedRouter states nothing (e.g. dashed Claude aliases OpenRouter has no metadata for).
  const alias = model({ id: "anthropic/claude-opus-4-7", name: "Anthropic: Claude Opus 4.7", reasoning: undefined });
  expect(() => trustedrouter.translateModel(alias, none)).toThrow(MissingReasoningOptionsError);
  // Mandatory with no efforts while the row still takes reasoning_effort (o3): contradictory, not always-on.
  const o3 = model({
    id: "openai/o3",
    name: "OpenAI: o3",
    supported_parameters: ["tools", "reasoning", "reasoning_effort", "include_reasoning"],
    reasoning: { mandatory: true, supported_efforts: [] },
  });
  expect(() => trustedrouter.translateModel(o3, none)).toThrow("accepts reasoning_effort");
});

test("mandatory reasoning with no efforts on a row that refuses effort is an affirmative always-on claim", () => {
  const r1 = model({
    id: "deepseek/deepseek-r1-0528",
    name: "DeepSeek: R1 0528",
    supported_parameters: ["tools", "reasoning", "include_reasoning"],
    reasoning: { mandatory: true, supported_efforts: [] },
  });
  const translated = trustedrouter.translateModel(r1, none)!;
  // No controls from the module; the runner writes `reasoning = { supported = true }`.
  expect((translated.model as { reasoning_options?: unknown[] }).reasoning_options ?? []).toEqual([]);
  expect(translated.header).toContain("# Always-on: the object marks reasoning mandatory with no efforts");
  expect(translated.header).not.toContain("# Toggle:");
});

test("GPT-5+ files leave freeform out and say so in the header; other models carry no such note", () => {
  expect(isGpt5Plus("openai/gpt-5")).toBe(true);
  expect(isGpt5Plus("openai/gpt-5.4-mini")).toBe(true);
  expect(isGpt5Plus("openai/gpt-6.1-sol")).toBe(true);
  expect(isGpt5Plus("openai/gpt-4.1")).toBe(false);
  expect(isGpt5Plus("openai/gpt-oss-120b")).toBe(false);
  expect(isGpt5Plus("anthropic/claude-sonnet-4-5")).toBe(false);

  const gpt = trustedrouter.translateModel(model({
    id: "openai/gpt-5.4",
    name: "OpenAI: GPT-5.4",
    reasoning: { mandatory: false, supported_efforts: ["xhigh", "high", "medium", "low", "none"] },
  }), none)!;
  expect(gpt.header).toContain("# Custom tools: freeform is left out;");
  expect(JSON.stringify(gpt.model)).not.toContain("freeform");
  expect(trustedrouter.translateModel(model(), none)!.header).not.toContain("freeform");
});

test("rows that price cache reads publish the cache kind, Anthropic as explicit", () => {
  const anthropic = trustedrouter.translateModel(model(), none)!;
  expect(anthropic.v2Set?.["capabilities.cache"]).toEqual({ explicit: true });
  expect(anthropic.header).toContain("# Cache: explicit;");

  const gpt = trustedrouter.translateModel(model({
    id: "openai/gpt-5.4",
    name: "OpenAI: GPT-5.4",
    reasoning: { mandatory: false, supported_efforts: ["high", "low"] },
  }), none)!;
  expect(gpt.v2Set?.["capabilities.cache"]).toEqual({ implicit: true });
  expect(gpt.header).toContain("# Cache: implicit;");

  const uncached = trustedrouter.translateModel(
    model({ pricing: { prompt: "0.000003", completion: "0.000015" } }),
    none,
  )!;
  expect(uncached.v2Set?.["capabilities.cache"]).toBeUndefined();
  expect(uncached.header).not.toContain("# Cache:");
});
