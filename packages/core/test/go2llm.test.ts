import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeDeep } from "remeda";

import { groups, providers, syncProvider, type ExistingModel, type SyncProvider } from "../src/sync/index.js";
import { exactInput, fetchGo2llmModels, go2llm, type Go2llmModel } from "../src/sync/providers/go2llm.js";
import { modelMetadata } from "../src/sync/providers/openrouter.js";
import { modelV2ToV1 } from "../src/translate.js";

const REPO = path.join(import.meta.dirname, "..", "..", "..");
const SHIPPED_DIR = path.join(REPO, "providers", "go2llm", "models");
const LAB_DIR = path.join(REPO, "models");

// Every shipped file with the row the two public endpoints have to serve for
// the sync to leave it alone. Rows are built from the files, so a repricing
// of the live catalog cannot make the round trips stale.
type Shipped = { text: string; authored: ExistingModel; resolved: ExistingModel };

const SHIPPED: Record<string, Shipped> = Object.fromEntries(
  readdirSync(SHIPPED_DIR).map((file) => {
    const id = file.slice(0, -".toml".length);
    const text = readFileSync(path.join(SHIPPED_DIR, file), "utf8");
    const raw = Bun.TOML.parse(text) as Record<string, unknown>;
    const { id: _id, ...authored } = modelV2ToV1({ ...raw, id }) as ExistingModel & { id?: string };
    const { benchmarks: _benchmarks, weights: _weights, ...base } = modelMetadata(authored.base_model!);
    return [id, { text, authored, resolved: mergeDeep(base, authored) as ExistingModel }];
  }),
);

type Catalog = { pricing: { models: Record<string, unknown>[] } & Record<string, unknown>; models: { data: Record<string, unknown>[] } };

function catalog(ids = Object.keys(SHIPPED)): Catalog {
  const pricing = ids.map((id) => {
    const cost = SHIPPED[id]!.resolved.cost!;
    return {
      id,
      lifecycle: "published",
      prices: { input: cost.input, output: cost.output, cacheRead: cost.cache_read, cacheWrite: cost.cache_write, cacheWritePolicy: "explicit_rate" },
    };
  });
  const served = ids.map((id) => ({
    id,
    object: "model",
    modalities: { input: SHIPPED[id]!.resolved.modalities!.input, output: ["text", "tool"] },
    ...(SHIPPED[id]!.authored.limit?.input === undefined ? {} : { max_prompt_tokens: SHIPPED[id]!.authored.limit!.input }),
  }));
  return {
    pricing: { currency: "USD", unitTokens: 1_000_000, version: 54, models: pricing },
    models: { object: "list", data: served },
  };
}

// Image generation models are listed with a per-image price.
const IMAGE_MODEL = {
  pricing: { id: "gpt-image-2", lifecycle: "published", prices: { unit: "image", variants: [{ size: "1024x1024", price: 0.04 }] } },
  served: { id: "gpt-image-2", object: "model", modalities: { input: ["text", "image"], output: ["image"] } },
};

function row(source: Catalog, list: "pricing" | "models", id: string) {
  const rows = list === "pricing" ? source.pricing.models : source.models.data;
  return rows.find((model) => model.id === id) as Record<string, any>;
}

// The runner resolves base_model against `<root>/models`, so each temp root
// gets the lab files its models point at.
async function inRoot(run: (modelsDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-go2llm-"));
  const modelsDir = path.join(root, "providers", "go2llm", "models");
  await mkdir(modelsDir, { recursive: true });
  try {
    for (const [id, shipped] of Object.entries(SHIPPED)) {
      await writeFile(path.join(modelsDir, `${id}.toml`), shipped.text);
      const base = shipped.authored.base_model!;
      await mkdir(path.join(root, "models", path.dirname(base)), { recursive: true });
      await copyFile(path.join(LAB_DIR, `${base}.toml`), path.join(root, "models", `${base}.toml`));
    }
    await run(modelsDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function go2llmAt(modelsDir: string, source: () => unknown): SyncProvider<Go2llmModel> {
  return { ...go2llm, modelsDir, async fetchModels() { return source(); } };
}

function read(modelsDir: string, id: string) {
  return readFile(path.join(modelsDir, `${id}.toml`), "utf8");
}

test("is registered as an update-only aggregator sync", () => {
  expect(providers.go2llm).toBe(go2llm);
  expect(groups.aggregators).toContain("go2llm");
  expect(go2llm).toMatchObject({ skipCreates: true, trackMissingModels: false });
  expect((go2llm as SyncProvider<Go2llmModel>).deleteMissing).toBeUndefined();
});

test("joins the price list with /v1/models and keeps only published models", () => {
  const source = catalog(["claude-haiku-5-5", "kimi-k2.6"]);
  source.pricing.models.push({ id: "kimi-k2.6-preview", lifecycle: "hidden", prices: { input: 1, output: 2 } });
  const models = go2llm.parseModels(source);
  expect(models.map((model) => model.id)).toEqual(["claude-haiku-5-5", "kimi-k2.6"]);
  expect(models[0]).toMatchObject({ input: ["text"], maxPromptTokens: 100_000, prices: { input: 0.06, output: 0.3 } });
  expect(models[1]!.maxPromptTokens).toBeUndefined();
});

test("skips models without token prices silently", () => {
  const source = catalog(["kimi-k2.6"]);
  source.pricing.models.push(IMAGE_MODEL.pricing);
  source.models.data.push(IMAGE_MODEL.served);
  const image = go2llm.parseModels(source).find((model) => model.id === "gpt-image-2")!;
  expect(image.prices).toBeUndefined();
  expect(go2llm.sourceID(image)).toBeUndefined();
  expect(go2llm.translateModel(image, { existing: () => undefined, authored: () => undefined })).toBeUndefined();
});

test("fails closed on a catalog it cannot trust", () => {
  const empty = catalog([]);
  expect(() => go2llm.parseModels(empty)).toThrow("no published models");

  const unserved = catalog(["kimi-k2.6", "kimi-k3"]);
  unserved.models.data = unserved.models.data.filter((model) => model.id !== "kimi-k3");
  expect(() => go2llm.parseModels(unserved)).toThrow("published but not served: kimi-k3");

  const perThousand = catalog(["kimi-k2.6"]);
  perThousand.pricing.unitTokens = 1_000;
  expect(() => go2llm.parseModels(perThousand)).toThrow();

  const badPrice = catalog(["kimi-k2.6"]);
  row(badPrice, "pricing", "kimi-k2.6").prices.input = -1;
  expect(() => go2llm.parseModels(badPrice)).toThrow("prices for kimi-k2.6 are not valid");
});

test("rejects an input modality it cannot map", () => {
  const source = catalog(["kimi-k2.6"]);
  row(source, "models", "kimi-k2.6").modalities.input = ["text", "hologram"];
  const [model] = go2llm.parseModels(source);
  expect(() => go2llm.translateModel(model!, { existing: () => SHIPPED["kimi-k2.6"]!.resolved, authored: () => undefined }))
    .toThrow("unknown input modality");
});

test("expands a generic kind to the lab's MIME types and keeps exact entries", () => {
  const lab = ["text", "image/jpeg", "image/png", "application/pdf"];
  expect(exactInput(["text", "image"], lab)).toEqual(["text", "image/jpeg", "image/png"]);
  expect(exactInput(["text", "image/png"], lab)).toEqual(["text", "image/png"]);
  expect(exactInput(["text", "video"], lab)).toEqual(["text", "video"]);
  expect(exactInput(undefined, lab)).toBeUndefined();
});

test("fetches both public endpoints without auth and fails on an error status", async () => {
  const urls: string[] = [];
  const ok = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    expect(init?.headers).toBeUndefined();
    return Response.json({});
  }) as typeof fetch;
  expect(await fetchGo2llmModels(ok)).toEqual({ pricing: {}, models: {} });
  expect(urls.sort()).toEqual(["https://api.go2llm.tech/v1/models", "https://go2llm.tech/api/pricing"]);

  const down = (async () => new Response("", { status: 502, statusText: "Bad Gateway" })) as typeof fetch;
  await expect(fetchGo2llmModels(down)).rejects.toThrow("502");
});

test("the shipped files are a fixed point of their own catalog rows", async () => {
  await inRoot(async (modelsDir) => {
    const source = catalog();
    source.pricing.models.push(IMAGE_MODEL.pricing, { id: "gemini-3.8-flash-tiered", lifecycle: "published", prices: { input: 1, output: 2 } });
    source.models.data.push(IMAGE_MODEL.served, { id: "gemini-3.8-flash-tiered", modalities: { input: ["text"] } });
    const result = await syncProvider(go2llmAt(modelsDir, () => source));
    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: Object.keys(SHIPPED).length });
    // A token-priced model without a file is reported, not created; the image model is not reported.
    expect(result.notices).toEqual(["1 published go2llm models have no local catalog file and were not created: `gemini-3.8-flash-tiered`"]);
    for (const [id, shipped] of Object.entries(SHIPPED)) expect(await read(modelsDir, id)).toBe(shipped.text);
  });
});

test("owns prices, input modalities, the prompt cap and removals, and nothing else", async () => {
  await inRoot(async (modelsDir) => {
    const source = catalog();
    Object.assign(row(source, "pricing", "claude-fable-5-1").prices, { input: 4.7, cacheRead: 0.12 });
    // Text-only model that now takes images: the lab's image types, not its PDF.
    row(source, "models", "claude-fable-5").modalities.input = ["text", "image"];
    // Vision model that no longer takes images.
    row(source, "models", "kimi-k2.6").modalities.input = ["text"];
    // Inherited modalities narrowed for the first time.
    row(source, "models", "deepseek-v4.1-flash").modalities.input = ["text"];
    delete row(source, "models", "claude-haiku-5-5").max_prompt_tokens;
    row(source, "models", "gpt-5.4").max_prompt_tokens = 200_000;
    row(source, "pricing", "grok-4.5").lifecycle = "retired";
    source.pricing.models = source.pricing.models.filter((model) => model.id !== "grok-4.3");
    source.models.data = source.models.data.filter((model) => model.id !== "grok-4.3");

    const provider = go2llmAt(modelsDir, () => source);
    expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 6, deleted: 2 });
    expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0 });

    const replace = (id: string, from: string, to: string) => {
      expect(SHIPPED[id]!.text).toContain(from);
      return SHIPPED[id]!.text.replace(from, to);
    };
    expect(await read(modelsDir, "claude-fable-5-1")).toBe(
      replace("claude-fable-5-1", "price = 4.5\ncache = { read = 0.113,", "price = 4.7\ncache = { read = 0.12,"),
    );
    expect(await read(modelsDir, "claude-fable-5")).toBe(
      replace("claude-fable-5", 'input = ["text"]', 'input = ["text", "image/jpeg", "image/png", "image/gif", "image/webp"]'),
    );
    expect(await read(modelsDir, "kimi-k2.6")).toBe(
      replace("kimi-k2.6", 'input = ["text", "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/heic", "image/heif"]', 'input = ["text"]'),
    );
    expect(await read(modelsDir, "deepseek-v4.1-flash")).toContain('[modalities]\ninput = ["text"]\noutput = ["text"]\n');
    expect(await read(modelsDir, "claude-haiku-5-5")).toBe(replace("claude-haiku-5-5", "\n[limit]\ninput = 100_000\n", ""));
    expect(await read(modelsDir, "gpt-5.4")).toContain("[limit]\ninput = 200_000\n");
    for (const id of ["grok-4.3", "grok-4.5"]) {
      expect(await Bun.file(path.join(modelsDir, `${id}.toml`)).exists()).toBe(false);
    }

    // Back on the published catalog, every surviving file returns to what
    // shipped. The formatter writes a re-added [limit] in its own table order,
    // so the comparison is by value.
    const restored = catalog(Object.keys(SHIPPED).filter((id) => id !== "grok-4.3" && id !== "grok-4.5"));
    await syncProvider(go2llmAt(modelsDir, () => restored));
    for (const id of ["claude-fable-5-1", "claude-fable-5", "kimi-k2.6", "deepseek-v4.1-flash", "claude-haiku-5-5", "gpt-5.4"]) {
      const text = await read(modelsDir, id);
      expect(text.startsWith(SHIPPED[id]!.text.slice(0, SHIPPED[id]!.text.indexOf("schema = 2")))).toBe(true);
      expect(Bun.TOML.parse(text)).toEqual(Bun.TOML.parse(SHIPPED[id]!.text));
    }
  });
});

test("a prompt cap at or above the served window narrows nothing", async () => {
  await inRoot(async (modelsDir) => {
    const source = catalog();
    const context = SHIPPED["gpt-5.4"]!.resolved.limit!.context;
    row(source, "models", "gpt-5.4").max_prompt_tokens = context;
    expect(await syncProvider(go2llmAt(modelsDir, () => source))).toMatchObject({ updated: 0 });
    expect(await read(modelsDir, "gpt-5.4")).toBe(SHIPPED["gpt-5.4"]!.text);
  });
});
