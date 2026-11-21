import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import { buildZeroGModel, fetchZeroGModels, zerog, type ZeroGModel } from "../src/sync/providers/0g.js";

function context(entries: Record<string, ExistingModel>, v2: Record<string, Record<string, unknown>> = {}) {
  return { existing: (id: string) => entries[id], authored: (id: string) => entries[id], v2: (id: string) => v2[id] };
}

function zeroGModel(overrides: Partial<ZeroGModel> = {}): ZeroGModel {
  return {
    id: "gpt-4.1",
    object: "model",
    owned_by: "0G Foundation",
    name: "GPT-4.1",
    type: "chatbot",
    context_length: 1_047_576,
    pricing_usd: { prompt: "0.000002", completion: "0.000008" },
    supported_parameters: ["tools", "tool_choice", "stream"],
    ...overrides,
  };
}

test("creates a non-reasoning model as a cost-only base_model overlay", () => {
  const translated = zerog.translateModel(zeroGModel(), context({}));

  expect(translated?.model as unknown).toEqual({
    base_model: "openai/gpt-4.1",
    cost: { input: 2, output: 8 },
  });
});

test("resolves a bare catalog id to its lab entry by normalized match", () => {
  const translated = zerog.translateModel(
    zeroGModel({ id: "gpt-4.1-nano", name: "GPT-4.1 Nano", pricing_usd: { prompt: "0.0000001", completion: "0.0000004" } }),
    context({}),
  );

  expect(translated?.model).toMatchObject({ base_model: "openai/gpt-4.1-nano" });
});

test("publishes the 5-minute cache write price and rounds float artifacts", () => {
  const translated = zerog.translateModel(
    zeroGModel({ pricing_usd: { prompt: "0.0000001234567891", completion: "0.000008", cache_write: "0.0000025", cache_write_1h: "0.000004" } }),
    context({}),
  );

  expect(translated?.model as unknown).toEqual({
    base_model: "openai/gpt-4.1",
    cost: { input: 0.123457, output: 8, cache_write: 2.5 },
  });
});

test("opens a research issue instead of creating a reasoning model", () => {
  const model = zeroGModel({ id: "glm-5.3-flash", name: "GLM-5.3 Flash" });

  expect(() => zerog.translateModel(model, context({}))).toThrow(MissingReasoningOptionsError);
  expect(zerog.missingModelID(model)).toBe("glm-5.3-flash");
});

test("reports a chat model with no lab entry as missing rather than creating it", () => {
  const model = zeroGModel({ id: "0gm-9.9-unknown", name: "0GM 9.9 Unknown" });

  expect(zerog.translateModel(model, context({}))).toBeUndefined();
  expect(zerog.missingModelID(model)).toBe("0gm-9.9-unknown");
});

test("skips media models silently", () => {
  const model = zeroGModel({ id: "flux-2-pro", type: "text-to-image", pricing_usd: {} });

  expect(zerog.sourceID(model)).toBeUndefined();
  expect(zerog.missingModelID(model)).toBeUndefined();
  expect(zerog.parseModels({ data: [model, zeroGModel()] }).map((m) => m.id)).toEqual(["gpt-4.1"]);
});

test("updates only the price of an existing overlay", () => {
  const built = buildZeroGModel(
    zeroGModel({ pricing_usd: { prompt: "0.0000025", completion: "0.00001" } }),
    { base_model: "openai/gpt-4.1", cost: { input: 2, output: 8 } } as ExistingModel,
  );

  expect(built).toMatchObject({ base_model: "openai/gpt-4.1", cost: { input: 2.5, output: 10 } });
});

test("keeps the published entry when the catalog garbles its price", () => {
  const entry = { base_model: "openai/gpt-4.1", cost: { input: 2, output: 8 } } as ExistingModel;
  const translated = zerog.translateModel(
    zeroGModel({ pricing_usd: { prompt: "n/a", completion: "0.000008" } }),
    context({ "gpt-4.1": entry }),
  );

  expect(translated?.model as unknown).toEqual(entry);
});

test("refuses a truncated catalog rather than deleting the models it omits", async () => {
  const truncated = () =>
    Promise.resolve(new Response(JSON.stringify({ data: [zeroGModel()] }), { headers: { "content-type": "application/json" } }));

  await expect(fetchZeroGModels(truncated as unknown as typeof fetch))
    .rejects.toThrow(/below the 20 needed to distinguish a retirement from a truncated response/);
});

test("fails the run rather than syncing from a degraded catalog response", async () => {
  const unavailable = () => Promise.resolve(new Response("", { status: 503, statusText: "Service Unavailable" }));

  await expect(fetchZeroGModels(unavailable as unknown as typeof fetch)).rejects.toThrow(/503 Service Unavailable/);
});

test("skips a listed model that does not serve, without opening an issue", () => {
  const model = zeroGModel({ id: "qwen2.5-vl-72b-instruct", name: "Qwen2.5-VL-72B-Instruct" });

  expect(zerog.sourceID(model)).toBeUndefined();
  expect(zerog.missingModelID(model)).toBeUndefined();
  expect(zerog.parseModels({ data: [model, zeroGModel()] }).map((m) => m.id)).toEqual(["gpt-4.1"]);
});

test("keeps the published entry when the catalog leaves the price out", () => {
  const entry = { base_model: "openai/gpt-4.1", cost: { input: 2, output: 8 } } as ExistingModel;
  const model = zeroGModel({ pricing_usd: {} });

  expect(zerog.parseModels({ data: [model] }).map((m) => m.id)).toEqual(["gpt-4.1"]);
  expect(zerog.translateModel(model, context({ "gpt-4.1": entry }))?.model as unknown).toEqual(entry);
});

test("does not create or report a new row that has no price", () => {
  const model = zeroGModel({ id: "gpt-4.1-nano", name: "GPT-4.1 Nano", pricing_usd: {} });

  expect(zerog.translateModel(model, context({}))).toBeUndefined();
  expect(zerog.missingModelID(model)).toBeUndefined();
  // Not listed by skippedNotice as lacking a lab entry, which it does not.
  expect(zerog.sourceID(model)).toBeUndefined();
});

test("publishes the 1h cache write price when the file lists the default and 1h TTLs", () => {
  const entry = { base_model: "openai/gpt-4.1", cost: { input: 2, output: 8, cache_write: 2.5 } } as ExistingModel;
  const model = zeroGModel({ pricing_usd: { prompt: "0.000002", completion: "0.000008", cache_write: "0.0000025", cache_write_1h: "0.000004" } });

  const listed = zerog.translateModel(model, context({ "gpt-4.1": entry }, { "gpt-4.1": { capabilities: { cache: { explicit: { ttl: ["5m", "1h"] } } } } }));
  expect(listed && "v2Set" in listed ? listed.v2Set : undefined).toEqual({ "cost.text.input.cache.write": { "5m": 2.5, "1h": 4 } });

  const unlisted = zerog.translateModel(model, context({ "gpt-4.1": entry }));
  expect(unlisted && "v2Set" in unlisted ? unlisted.v2Set : undefined).toBeUndefined();
});
