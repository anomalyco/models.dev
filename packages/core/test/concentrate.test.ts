import { describe, expect, test } from "bun:test";

import { buildConcentrateModel, concentrate, type ConcentrateModel, resolveConcentrateBaseModel } from "../src/sync/providers/concentrate.js";

const usd = (USD: number, units = 1_000_000) => ({ price: { USD }, units });
const tokens = (input: number, output: number, read?: number) => ({ input: usd(input), output: usd(output), ...(read === undefined ? {} : { cache: { read: usd(read) } }) });
const route = (o: { pricing?: unknown[]; tools?: boolean; custom?: boolean; effort?: Record<string, boolean>; chat?: boolean } = {}) => ({
  pricing: o.pricing ?? [{ tokens: tokens(1, 2) }],
  supports: { endpoint: { chat: o.chat ?? true, decisions: !(o.chat ?? true) }, tools: { function_calling: o.tools ?? true, custom_tools: o.custom ?? false }, reasoning: { effort: o.effort ?? {} }, input: { image: {}, file: {} } },
});
const model = (id: string, author: string, providers: Record<string, unknown>, thinks = true) => ({
  id, author: { slug: author }, max_input_tokens: 10_000_000, max_tokens: 10_000_000, providers,
  capabilities: { effort: { supported: thinks }, thinking: { supported: false }, structured_outputs: { supported: true } },
}) as ConcentrateModel;
const v2 = (entry: ConcentrateModel) => (buildConcentrateModel(entry) as { v2: Record<string, any> }).v2;
const all = { none: true, low: true, medium: true, high: true, xhigh: true, max: true };

describe("Concentrate sync", () => {
  test("maps Concentrate IDs onto models.dev lab IDs", () => {
    const resolve = (id: string, author: string) => resolveConcentrateBaseModel(model(id, author, {}));
    expect(resolve("gpt-5.5", "openai")).toBe("openai/gpt-5.5");
    expect(resolve("kimi-k2-6", "moonshot")).toBe("moonshotai/kimi-k2.6");
    expect(resolve("gemma-3-12b", "google")).toBe("google/gemma-3-12b-it");
    expect(resolve("deepseek-v4-1-flash-fast", "deepseek")).toBe("deepseek/deepseek-v4.1-flash");
    expect(resolve("not-a-real-model", "nobody")).toBeUndefined();
  });

  test("prices from the most expensive route, with context tiers and web search", () => {
    const lab = route({ custom: true, effort: { ...all, none: false }, pricing: [
      { condition: { service_tier: "priority" }, tokens: tokens(10, 60) },
      { condition: { input_gte: 272_000 }, tokens: tokens(10, 45, 1) },
      // A tier above the context the model can take never applies, so it is left out.
      { condition: { input_gte: 50_000_000 }, tokens: tokens(20, 90) },
      { condition: { date_gte: Date.now() + 86_400_000 }, tokens: tokens(99, 99) },
      { condition: { date_gte: 0 }, tokens: tokens(5, 30, 0.5), tool_calls: { web_search: usd(14, 1000) } },
    ] });
    const doc = v2(model("gpt-5.5", "openai", { openai: lab, cheap: route({ tools: false, effort: { none: true }, pricing: [{ tokens: tokens(0.1, 0.2) }] }) }));
    expect(doc.cost).toEqual({
      text: {
        input: { price: 5, cache: { read: 0.5 }, overrides: [{ when: { context: { gte: 272_000 } }, price: 10, cache: { read: 1 } }] },
        output: { price: 30, overrides: [{ when: { context: { gte: 272_000 } }, price: 45 }] },
      },
      web_search: { price: 14 },
    });
    // Any route's levels count (Concentrate routes by feature), limited to the lab's own; limits capped to the lab's.
    expect(doc.capabilities.reasoning).toEqual({ supported: true, effort: ["none", "low", "medium", "high", "xhigh"] });
    // A route that takes custom tools gets the lab's free-form formats.
    expect(doc.capabilities.tools).toEqual({ supported: true, freeform: ["text", "lark", "regex"] });
    // Formats listed on the reference's Responses table count too (OpenAI's gpt-6-luna).
    expect(v2(model("gpt-6-luna", "openai", { openai: route({ custom: true }) })).capabilities.tools?.freeform).toEqual(["text", "lark", "regex"]);
    expect(doc.api).toBeUndefined();
    expect(doc.limit).toBeUndefined();
  });

  test("marks a host that bills cache reads as caching, implicitly when the reference has no details", () => {
    const priced = route({ pricing: [{ tokens: tokens(1, 2, 0.1) }] });
    expect(v2(model("kimi-k2-5", "moonshot", { moonshot: priced })).capabilities.cache).toEqual({ implicit: true });
    expect(v2(model("kimi-k2-5", "moonshot", { moonshot: route() })).capabilities.cache).toBeUndefined();
  });

  test("keys cache writes by the TTLs the reference offers, or a plain price when it lists none", () => {
    const write = (key: string, USD: number) => ({ tokens: { ...tokens(1, 2, 0.1), cache: { read: usd(0.1), write: { [key]: usd(USD) } } } });
    // OpenAI caches for 30m/12h; an unnamed write price is the first.
    expect(v2(model("gpt-5.6-luna", "openai", { openai: route({ pricing: [write("cache_write_tokens", 0.25)] }) })).cost.text.input.cache).toEqual({ read: 0.1, write: { "30m": 0.25 } });
    // MiniMax publishes its write price without a TTL.
    expect(v2(model("minimax-m2-7", "minimax", { minimax: route({ pricing: [write("ephemeral_5m_input_tokens", 0.375)] }) })).cost.text.input.cache).toEqual({ read: 0.1, write: 0.375 });
  });

  test("maps effort onto budget-only labs with graded low/medium/high, never the full list", () => {
    expect(v2(model("gemini-2.5-pro", "google", { vertex: route({ effort: all }) })).capabilities.reasoning).toEqual({ supported: true, effort: ["low", "medium", "high"] });
    expect(v2(model("gemini-2.5-flash", "google", { vertex: route({ effort: all }) })).capabilities.reasoning).toEqual({ supported: true, effort: ["none", "low", "medium", "high"] });
    // Fewer than two graded levels stays an on/off switch.
    expect(v2(model("gemini-2.5-flash", "google", { vertex: route({ effort: { none: true, medium: true } }) })).capabilities.reasoning).toEqual({ supported: true, toggle: true });
  });

  test("serves Claude over Messages with Anthropic's toggle", () => {
    const result = buildConcentrateModel(model("claude-sonnet-5", "anthropic", { anthropic: route({ effort: all }) }));
    expect(Object.keys((result as { v2: Record<string, any> }).v2.api)).toEqual(["messages"]);
    expect((result as { v2: Record<string, any> }).v2.capabilities.reasoning.toggle).toBe(true);
    expect((result as { header?: string }).header).toBe("# Toggle: thinking.type = enabled|disabled");
    // Budget-only Claude takes no effort levels, whatever the routes list (Messages rejects output_config.effort).
    expect(v2(model("claude-haiku-4-5", "anthropic", { anthropic: route({ effort: all }) })).capabilities.reasoning).toEqual({ supported: true, budget: { min: 1_024 } });
  });

  test("serves decision models over System One", () => {
    expect(Object.keys(v2(model("jev-1.14.0", "typesafe", { typesafe: route({ chat: false }) })).api)).toEqual(["systemone"]);
    // System One takes no sampling parameters, and its answers are structured.
    expect(v2(model("clef", "cloudflare", { cloudflare: route({ chat: false }) })).capabilities).toEqual({ structured_output: true, temperature: false, top_p: false, top_k: false });
  });

  test("skips services and unmapped models, and marks non-reasoners", () => {
    expect(buildConcentrateModel(model("redact-v1", "concentrate", { concentrate: route() }))).toBeUndefined();
    expect(buildConcentrateModel(model("not-a-real-model", "nobody", { nobody: route() }))).toBeUndefined();
    expect(concentrate.missingModelID?.(model("redact-v1", "concentrate", {}))).toBeUndefined();
    // A non-reasoning model inherits the lab's `reasoning = { supported = false }` instead of restating it.
    expect(v2(model("gpt-4.1", "openai", { openai: route() }, false)).capabilities?.reasoning).toBeUndefined();
    // A lab reasoner stays one even when Concentrate flags no reasoning control: always-on.
    expect(v2(model("deepseek-r1", "deepseek", { deepseek: route() }, false)).capabilities.reasoning).toEqual({ supported: true });
  });
});
