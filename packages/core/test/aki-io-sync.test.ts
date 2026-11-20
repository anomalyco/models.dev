import { expect, test } from "bun:test";

import { syncProviderMatrix } from "../src/sync/index.js";
import {
  akiIo,
  AkiResponse,
  buildAkiModel,
  fetchAkiModels,
  type AkiModel,
} from "../src/sync/providers/aki-io.js";

function model(overrides: Partial<AkiModel> = {}): AkiModel {
  return AkiResponse.parse({
    object: "list",
    data: [{
      id: "deepseek-v4.1-flash-1017",
      openai: { id: "deepseek-v4.1-flash-1017-tl5" },
      pricing: {
        in_token_unit: 1_000_000,
        in_token_price: 0.25,
        out_token_unit: 1_000_000,
        out_token_price: 1,
        cached_token_unit: 1_000_000,
        cached_token_price: 0.1,
      },
      ...overrides,
    }],
  }).data[0]!;
}

function catalog(count: number): AkiModel[] {
  return Array.from({ length: count }, (_, index) => model({
    id: `model-${index}`,
    openai: { id: `model-${index}` },
  }));
}

const authored = {
  base_model: "deepseek/deepseek-v4.1-flash-1017",
  cost: { input: 9, output: 9, cache_read: 9 },
};

const context = {
  existing: () => undefined,
  authored: (id: string) => id === model().openai.id ? authored : undefined,
};

test("AKI.IO is registered for scheduled sync and fetches its public catalog without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === akiIo.id)).toBe(true);

  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ object: "list", data: catalog(20) });
  }) as unknown as typeof fetch;
  await fetchAkiModels(fetcher);
  expect(request!.url).toBe("https://aki.io/api/models");
  expect(request!.headers.get("authorization")).toBeNull();

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  expect(fetchAkiModels(unavailable)).rejects.toThrow("503");
});

test("a truncated catalog fails closed before deletions", async () => {
  const truncated = (async () => Response.json({ object: "list", data: catalog(19) })) as unknown as typeof fetch;
  expect(fetchAkiModels(truncated)).rejects.toThrow("truncated");
  expect(() => akiIo.parseModels({ object: "list", data: catalog(19) })).toThrow("truncated");
  expect(() => akiIo.parseModels({ object: "list", data: catalog(20) })).not.toThrow();
});

test("EUR prices per million tokens become USD per million tokens", () => {
  const translated = akiIo.translateModel(model(), context)!;
  expect(translated.model.cost).toEqual({
    input: 0.274725,
    output: 1.0989,
    cache_read: 0.10989,
  });
  expect(translated.model).toMatchObject({ base_model: "deepseek/deepseek-v4.1-flash-1017" });
});

test("the OpenAI model ID names the TOML, not the canonical catalog id", () => {
  const translated = akiIo.translateModel(model(), context)!;
  expect(translated.id).toBe("deepseek-v4.1-flash-1017-tl5");
  expect(akiIo.translateModel(model({ openai: { id: "deepseek-v4.1-flash-1017-tl1" } }), context)).toBeUndefined();
});

test("cache read is only written where the file declares it or the API charges for it", () => {
  const noCache = { base_model: "deepseek/deepseek-v4.1-flash-1017", cost: { input: 9, output: 9 } };
  // A positive cache price is added even when the file does not declare one.
  expect(buildAkiModel(model(), noCache).cost?.cache_read).toBe(0.10989);
  expect(buildAkiModel(model({ pricing: { in_token_price: 0.25, out_token_price: 1, cached_token_price: 0 } }), noCache).cost?.cache_read)
    .toBeUndefined();
  expect(buildAkiModel(model({ pricing: { in_token_price: 0.25, out_token_price: 1, cached_token_price: 0.2 } }), noCache).cost?.cache_read)
    .toBe(0.21978);
  // A reported 0 does not overwrite an authored cache price.
  expect(buildAkiModel(model({ pricing: { in_token_price: 0.25, out_token_price: 1, cached_token_price: 0 } }), authored).cost?.cache_read)
    .toBe(9);
});

test("a price unit other than one million tokens is scaled to per-1M", () => {
  expect(buildAkiModel(model({ pricing: { in_token_unit: 1_000, in_token_price: 0.25, out_token_price: 1 } }), authored).cost?.input)
    .toBe(274.725);
});

test("malformed responses fail before any catalog writes", () => {
  expect(() => AkiResponse.parse({ object: "list", data: [] })).toThrow();
  expect(() => AkiResponse.parse({ object: "list", data: [{ id: "missing-openai", pricing: {} }] })).toThrow();
  expect(() => AkiResponse.parse({
    object: "list",
    data: [{ id: "negative", openai: { id: "negative" }, pricing: { in_token_price: -1, out_token_price: 0 } }],
  })).toThrow();
});

test("a missing or empty price fails instead of being written as a free model", () => {
  for (const bad of [null, "", " ", Number.POSITIVE_INFINITY]) {
    expect(() => AkiResponse.parse({
      object: "list",
      data: [{ id: "bad", openai: { id: "bad" }, pricing: { in_token_price: bad, out_token_price: 1 } }],
    })).toThrow();
    expect(() => AkiResponse.parse({
      object: "list",
      data: [{ id: "bad", openai: { id: "bad" }, pricing: { in_token_price: 1, out_token_price: bad } }],
    })).toThrow();
    expect(() => AkiResponse.parse({
      object: "list",
      data: [{ id: "bad", openai: { id: "bad" }, pricing: { in_token_price: 1, out_token_price: 1, cached_token_price: bad } }],
    })).toThrow();
  }
});

test("numeric-string prices are still accepted", () => {
  const parsed = AkiResponse.parse({
    object: "list",
    data: [{
      id: "string-prices",
      openai: { id: "string-prices" },
      pricing: { in_token_price: "0.25", out_token_price: "1", cached_token_price: "0.1" },
    }],
  }).data[0]!;
  expect(parsed.pricing.in_token_price).toBe(0.25);
  expect(parsed.pricing.out_token_price).toBe(1);
  expect(parsed.pricing.cached_token_price).toBe(0.1);
});