import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import { fetchKimchiModels, KimchiResponse, kimchi, type KimchiModel } from "../src/sync/providers/kimchi.js";

function model(overrides: Partial<KimchiModel> = {}): KimchiModel {
  return KimchiResponse.parse({ modelPrices: [{
    model: "kimi-k3.1-pro",
    displayName: "Kimi K3.1 Pro",
    type: "chat",
    inputModalities: ["text", "image"],
    toolCallSupported: true,
    reasoningSupported: true,
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    inputPriceUsd: "0.000002",
    outputPriceUsd: "0.00001",
    cachedInputPriceUsd: "0.0000002",
    status: "MODEL_STATUS_ACTIVE",
    sunsetTime: null,
    replacementModel: "",
    ...overrides,
  }] }).modelPrices[0]!;
}

test("Kimchi sync fetches public pricing with Accept JSON and supports number/string prices", async () => {
  expect(syncProviderMatrix().include.some((p) => p.provider === "kimchi")).toBe(true);
  let request: Request | undefined;
  const { modelPrices } = await Bun.file(path.join(import.meta.dir, "fixtures/kimchi-catalog.json")).json() as { modelPrices: KimchiModel[] };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    request = new Request(input instanceof Request ? input.url : input.toString(), init);
    return Response.json({ modelPrices: modelPrices.map((m) => ({ ...m, inputPriceUsd: 0.000002 })) });
  };
  const parsed = await fetchKimchiModels(fetcher as typeof fetch);
  expect(request!.headers.get("accept")).toBe("application/json");
  expect(request!.headers.get("authorization")).toBeNull();
  expect(parsed.modelPrices[0]!.inputPriceUsd).toBe(0.000002);
});

test("served prices have exact per-million token values", () => {
  const result = kimchi.translateModel(model(), { existing: () => undefined, authored: () => undefined });
  expect(result && "v2" in result ? result.v2.cost : undefined).toEqual({
    text: {
      input: { price: 2, cache: { read: 0.2 } },
      output: { price: 10 },
    },
  });
});

test("truncated and duplicate catalog responses fail instead of deleting models", async () => {
  expect(() => KimchiResponse.parse({ modelPrices: [] })).toThrow();
  expect(() => KimchiResponse.parse({ modelPrices: [model(), model()] })).toThrow("duplicate model IDs");
  expect(() => KimchiResponse.parse({ modelPrices: [{ ...model(), inputPriceUsd: -1 }] })).toThrow();
  await expect(fetchKimchiModels(async () => Response.json({ modelPrices: [model()] }))).rejects.toThrow("undersized catalog");
});

test("source does not erase authored protocol/status details or exceed lab limits", () => {
  const result = kimchi.translateModel(model({ model: "gemma-4-31b" }), {
    existing: () => undefined,
    authored: () => undefined,
    v2: () => ({
      schema: 2,
      status: "deprecated",
      limit: { input: 245760 },
      cost: { multipliers: [{ match: "provider", multiplier: 0.5 }] },
      api: { "chat-completions": { headers: { "X-Test": "kept" }, compatibility: { custom: true } } },
    }),
  });
  if (!result || !("v2" in result)) throw new Error("missing result");
  expect(result.v2.status).toBe("deprecated");
  expect(result.v2.limit).toEqual({ input: 245760 });
  expect(result.v2.capabilities.reasoning).toEqual({ supported: true, toggle: true });
  expect(result.v2.cost.multipliers).toBeDefined();
  expect(result.v2.api["chat-completions"].headers["X-Test"]).toBe("kept");
  expect(result.v2.api["chat-completions"].compatibility.custom).toBe(true);
  expect(() => kimchi.translateModel(model({ model: "unknown", reasoningSupported: true }), { existing: () => undefined, authored: () => undefined })).not.toThrow();
});

test("withdrawn feed cache prices remove implicit caching, not authored explicit details", () => {
  const v2 = () => ({
    schema: 2,
    capabilities: { cache: { implicit: true } },
    cost: { text: { input: { price: 1, cache: { read: 0.1 } } } },
  });
  for (const row of [model(), model({ cachedInputPriceUsd: undefined })]) {
    const cacheCost = row.cachedInputPriceUsd === undefined ? 1 : 0.2;
    const result = kimchi.translateModel(row, { existing: () => undefined, authored: () => undefined, v2 });
    if (!result || !("v2" in result)) throw new Error("missing result");
    expect(result.v2.capabilities.cache).toEqual(row.cachedInputPriceUsd === undefined ? undefined : { implicit: true });
    expect(result.v2.cost.text.input.price).toBe(2);
    expect(result.v2.cost.text.input.cache).toEqual(row.cachedInputPriceUsd === undefined ? undefined : { read: cacheCost });
  }
});

test("cache sync keeps authored implicit detail and preserves explicit when prices withdraw", () => {
  const contexts = [{ implicit: { ttl: ["5m"] } }, { explicit: true }, undefined!] as any[];
  for (const original of contexts) {
    const result = kimchi.translateModel(model({ cachedInputPriceUsd: undefined }), {
      existing: () => undefined,
      authored: () => undefined,
      v2: () => ({ schema: 2, capabilities: { cache: original } }),
    });
    if (!result || !("v2" in result)) throw new Error("missing result");
    expect(result.v2.capabilities.cache).toEqual(original?.explicit ? { explicit: true } : undefined);
  }
  const retained = kimchi.translateModel(model(), {
    existing: () => undefined,
    authored: () => undefined,
    v2: () => ({ schema: 2, capabilities: { cache: { implicit: { ttl: ["5m"] } } } }),
  });
  if (!retained || !("v2" in retained)) throw new Error("missing result");
  expect(retained.v2.capabilities.cache).toEqual({ implicit: { ttl: ["5m"] } });
});

test("live-style Kimchi fixture produces all eleven entries and an idempotent second sync", async () => {
  const { modelPrices } = KimchiResponse.parse(await Bun.file(path.join(import.meta.dir, "fixtures/kimchi-catalog.json")).json());
  const root = await mkdtemp(path.join(tmpdir(), "kimchi-sync-"));
  try {
    await mkdir(path.join(root, "providers/kimchi/models"), { recursive: true });
    await copyFile("providers/kimchi/provider.toml", path.join(root, "providers/kimchi/provider.toml"));
    for (const lab of ["deepseek", "google", "zhipuai", "moonshotai", "minimax", "meta"]) {
      await mkdir(path.join(root, "models", lab), { recursive: true });
      for (const file of await readdir(path.join("models", lab))) {
        if (["deepseek-v4-flash-0731.toml", "deepseek-v4.1-flash.toml", "deepseek-v4.1-flash-1017.toml", "gemma-4-31b-it.toml", "glm-5.3.toml", "glm-5.3-flash.toml", "kimi-k3.toml", "kimi-k3.1-pro.toml", "MiniMax-M3.toml", "MiniMax-M3.1-Flash.toml", "muse-spark-open.toml"].includes(file)) {
          await copyFile(path.join("models", lab, file), path.join(root, "models", lab, file));
        }
      }
    }
    const provider = { ...kimchi, skipCreates: false, modelsDir: path.join(root, "providers/kimchi/models"), fetchModels: async () => ({ modelPrices }) };
    const result = await syncProvider(provider, { openIssues: false, dir: root });
    expect(result.created).toBe(11);
    expect((await syncProvider(provider, { openIssues: false, dir: root })).unchanged).toBe(11);
    const content = await Bun.file(path.join(root, "providers/kimchi/models/kimi-k3.1-pro.toml")).text();
    expect(content).toContain('base_model = "moonshotai/kimi-k3.1-pro"');
    expect(content).toContain("image/png");
    expect(content).not.toContain("video");
    expect(content).toContain("price = 2");
    expect(content).not.toContain("0.19999999999999998");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
