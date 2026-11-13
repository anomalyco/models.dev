import { afterEach, beforeEach, expect, test } from "bun:test";

import { syncProviderMatrix } from "../src/sync/index.js";
import {
  ExchangeRateResponse,
  fetchSovereignEGModels,
  resolveSovereignEGBaseModel,
  sovereigneg,
  SovereignEGResponse,
  usd,
} from "../src/sync/providers/sovereigneg.js";

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "claude-sonnet-5.5",
    display_name: "Claude Sonnet 5.5",
    provider_handle: "anthropic",
    modality: "chat",
    status: "live",
    visibility: "public",
    context_window: 1_000_000,
    max_output_tokens: 128_000,
    deprecated_at: null,
    pricing: { input_per_1m_egp: 117.7495, output_per_1m_egp: 588.7475, cache_read_per_1m_egp: 11.775 },
    supported_parameters: ["tools", "reasoning_effort", "structured_outputs", "max_tokens"],
    input_modalities: ["text", "image", "file"],
    output_modalities: ["text"],
    ...overrides,
  };
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.SOVEREIGNEG_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.SOVEREIGNEG_API_KEY;
  else process.env.SOVEREIGNEG_API_KEY = savedKey;
});

test("SovereignEG is registered for scheduled sync and sends its key only to its own catalog", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === sovereigneg.id)).toBe(true);

  process.env.SOVEREIGNEG_API_KEY = "test-key";
  const requests: Request[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    requests.push(request);
    return request.url.includes("open.er-api.com")
      ? Response.json({ result: "success", rates: { EGP: 53.35 } })
      : Response.json({ object: "list", data: [model()] });
  }) as unknown as typeof fetch;

  const source = await fetchSovereignEGModels(fetcher);
  expect(source.egp_per_usd).toBe(53.35);
  expect(source.catalog.data).toHaveLength(1);

  const catalog = requests.find((request) => request.url === "https://backend.sovereigneg.com/v1/models")!;
  const rate = requests.find((request) => request.url === "https://open.er-api.com/v6/latest/USD")!;
  expect(catalog.headers.get("authorization")).toBe("Bearer test-key");
  expect(rate.headers.get("authorization")).toBeNull();
});

test("a missing key, a failed request and a bad rate fail before any catalog writes", async () => {
  delete process.env.SOVEREIGNEG_API_KEY;
  expect(fetchSovereignEGModels()).rejects.toThrow("SOVEREIGNEG_API_KEY is required");

  process.env.SOVEREIGNEG_API_KEY = "test-key";
  const unauthorized = (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;
  expect(fetchSovereignEGModels(unauthorized)).rejects.toThrow("401");

  expect(() => ExchangeRateResponse.parse({ result: "success", rates: { EGP: 0 } })).toThrow();
  expect(() => ExchangeRateResponse.parse({ result: "success", rates: { EGP: 5_000 } })).toThrow();
  expect(() => ExchangeRateResponse.parse({ result: "error", rates: { EGP: 53.35 } })).toThrow();
  expect(() => ExchangeRateResponse.parse({ result: "success", rates: {} })).toThrow();
});

test("empty, duplicate and malformed inventories are rejected", () => {
  expect(() => SovereignEGResponse.parse({ data: [] })).toThrow("empty catalog");
  expect(() => SovereignEGResponse.parse({ data: [model(), model()] })).toThrow("duplicate model IDs");
  expect(() => SovereignEGResponse.parse({ data: [model({ context_window: -1 })] })).toThrow();
  expect(() => SovereignEGResponse.parse({ data: [model({ pricing: { input_per_1m_egp: -1 } })] })).toThrow();
});

test("EGP prices convert to three significant figures and keep an authored price inside the tolerance", () => {
  expect(usd(117.7495, 53.349909)).toBe(2.21);
  expect(usd(588.7475, 53.349909)).toBe(11);
  expect(usd(2.1784, 53.349909)).toBe(0.0408);
  expect(usd(0, 53.349909)).toBe(0);

  // A 1% rate move keeps the authored price; a 5% move replaces it.
  expect(usd(117.7495, 53.349909 * 1.01, 2.21)).toBe(2.21);
  expect(usd(117.7495, 53.349909 * 1.05, 2.21)).toBe(2.1);
});

test("bare IDs resolve through the lab named in provider_handle", () => {
  expect(resolveSovereignEGBaseModel({ id: "claude-sonnet-5.5", provider_handle: "anthropic" }))
    .toBe("anthropic/claude-sonnet-5-5");
  expect(resolveSovereignEGBaseModel({ id: "SovereignEG/Qwen3.8-27B-FP8", provider_handle: "Qwen" }))
    .toBe("alibaba/qwen3.8-27b");
  expect(resolveSovereignEGBaseModel({ id: "no-such-model-anywhere", provider_handle: "nobody" })).toBeUndefined();
});

test("only live, public, tool-capable chat routes with a price, a context window and a lab base are translated", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  const source = (overrides: Record<string, unknown> = {}) =>
    sovereigneg.parseModels({ catalog: { data: [model(overrides)] }, egp_per_usd: 53.349909 })[0]!;

  const translated = sovereigneg.translateModel(source(), context);
  expect(translated).toBeDefined();
  expect(translated!.id).toBe("claude-sonnet-5.5");
  const synced = translated!.model as { base_model?: string; cost?: { input?: number; output?: number; cache_read?: number } };
  expect(synced.base_model).toBe("anthropic/claude-sonnet-5-5");
  expect(synced.cost).toMatchObject({ input: 2.21, output: 11, cache_read: 0.221 });

  expect(sovereigneg.translateModel(source({ modality: "embed" }), context)).toBeUndefined();
  expect(sovereigneg.translateModel(source({ status: "offline" }), context)).toBeUndefined();
  expect(sovereigneg.translateModel(source({ visibility: "private" }), context)).toBeUndefined();
  expect(sovereigneg.translateModel(source({ supported_parameters: ["max_tokens"] }), context)).toBeUndefined();
  expect(sovereigneg.translateModel(source({ context_window: null }), context)).toBeUndefined();
  expect(sovereigneg.translateModel(source({ pricing: null }), context)).toBeUndefined();
  expect(sovereigneg.translateModel(source({ id: "no-such-model-anywhere", provider_handle: "nobody" }), context))
    .toBeUndefined();

  // Skipped chat routes are reported; routes of other kinds are not.
  expect(sovereigneg.sourceID(source({ id: "no-such-model-anywhere" }))).toBe("no-such-model-anywhere");
  expect(sovereigneg.sourceID(source({ modality: "embed" }))).toBeUndefined();
});
