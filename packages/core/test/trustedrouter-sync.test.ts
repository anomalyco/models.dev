import { expect, test } from "bun:test";

import { syncProviderMatrix } from "../src/sync/index.js";
import {
  fetchTrustedRouterModels,
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
