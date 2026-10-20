import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeDeep } from "remeda";

import { groups, providers, syncProvider, type ExistingModel, type SyncProvider } from "../src/sync/index.js";
import { buildVerathosModel, fetchVerathosModels, verathos, type VerathosModel } from "../src/sync/providers/verathos.js";
import { modelMetadata } from "../src/sync/providers/openrouter.js";
import { modelV2ToV1 } from "../src/translate.js";

const REPO = path.join(import.meta.dirname, "..", "..", "..");
const SHIPPED_DIR = path.join(REPO, "providers", "verathos", "models");
const LAB_DIR = path.join(REPO, "models");

// GET https://api.verathos.ai/v1/models (2026-10-20), trimmed to the fields the
// sync reads plus one it ignores. Prices are USD per 1M tokens.
const row = (id: string, max_state_tokens: number, input_modalities: string[], input: number): VerathosModel => ({
  id,
  object: "model",
  max_state_tokens,
  input_modalities,
  price: { usd_per_million_input_tokens: input, usd_per_million_output_tokens: 0 },
  available: true,
  latency_ms: { p50: 449, p95: 564, window_s: 72000 },
});
const LIVE = () => ({
  object: "list",
  data: [
    row("kev-4b", 65_536, ["text"], 0.015),
    row("clef-flash", 65_536, ["text", "image"], 0.02),
    row("d3-flash", 16_384, ["text"], 0.02),
    row("d3-mini", 16_384, ["text"], 0.015),
  ],
});

const SHIPPED: Record<string, string> = Object.fromEntries(
  readdirSync(SHIPPED_DIR).map((file) => [file, readFileSync(path.join(SHIPPED_DIR, file), "utf8")]),
);

// A shipped v2 file read as v1: what the runner hands the module as `authored`.
function authoredV1(file: string): ExistingModel {
  const raw = Bun.TOML.parse(SHIPPED[file]!) as Record<string, unknown>;
  return modelV2ToV1({ ...raw, id: file.slice(0, -5) }, { modelPath: file }) as ExistingModel;
}

// That file merged over its lab entry: what the runner hands the module as `existing`.
function resolved(file: string): ExistingModel {
  const authored = authoredV1(file);
  const { benchmarks: _benchmarks, weights: _weights, ...base } = modelMetadata(authored.base_model!);
  return mergeDeep(base, authored) as ExistingModel;
}

// A throwaway checkout: the Verathos files plus the lab files they point at, so
// the runner resolves base_model exactly as it does in the repo.
async function inRoot(files: Record<string, string>, run: (modelsDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-verathos-"));
  const modelsDir = path.join(root, "providers", "verathos", "models");
  await mkdir(modelsDir, { recursive: true });
  try {
    for (const [file, text] of Object.entries(files)) {
      await writeFile(path.join(modelsDir, file), text);
      const base = (Bun.TOML.parse(text) as ExistingModel).base_model!;
      await mkdir(path.join(root, "models", path.dirname(base)), { recursive: true });
      await copyFile(path.join(LAB_DIR, `${base}.toml`), path.join(root, "models", `${base}.toml`));
    }
    await run(modelsDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function at(modelsDir: string, source: () => unknown): SyncProvider<VerathosModel> {
  return { ...verathos, modelsDir, async fetchModels() { return source(); } };
}

const read = (modelsDir: string, file: string) => readFile(path.join(modelsDir, file), "utf8");

test("is update-only and registered in the direct group", () => {
  expect(verathos).toMatchObject({ skipCreates: true, trackMissingModels: true, deleteMissing: false });
  expect(providers.verathos).toBe(verathos);
  expect(groups.direct).toContain("verathos");
});

test("the shipped files are a fixed point against the live list", async () => {
  await inRoot(SHIPPED, async (modelsDir) => {
    const provider = at(modelsDir, LIVE);
    for (let run = 0; run < 2; run++) {
      expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 4, files: [] });
    }
    for (const [file, text] of Object.entries(SHIPPED)) expect(await read(modelsDir, file)).toBe(text);
  });
});

test("a repricing or a new cap changes that line and keeps the header and overrides", async () => {
  await inRoot(SHIPPED, async (modelsDir) => {
    const catalog = LIVE();
    catalog.data[1] = row("clef-flash", 32_768, ["text", "image"], 0.04);
    catalog.data[2] = row("d3-flash", 24_576, ["text"], 0.02);
    expect(await syncProvider(at(modelsDir, () => catalog))).toMatchObject({ created: 0, updated: 2, deleted: 0 });
    expect(await read(modelsDir, "clef-flash.toml")).toBe(
      SHIPPED["clef-flash.toml"]!.replace("price = 0.02\n", "price = 0.04\n").replace("context = 65_536", "context = 32_768"),
    );
    expect(await read(modelsDir, "d3-flash.toml")).toBe(SHIPPED["d3-flash.toml"]!.replace("context = 16_384", "context = 24_576"));
  });
});

test("D3 starting to read images widens its input and keeps the decision output", async () => {
  await inRoot({ "d3-mini.toml": SHIPPED["d3-mini.toml"]! }, async (modelsDir) => {
    const catalog = { object: "list", data: [row("d3-mini", 16_384, ["image", "text"], 0.015)] };
    expect(await syncProvider(at(modelsDir, () => catalog))).toMatchObject({ updated: 1 });
    const model = Bun.TOML.parse(await read(modelsDir, "d3-mini.toml")) as ExistingModel;
    // Input now matches the lab entry except video, so it stays an override.
    expect(model.modalities?.input).toEqual(["text", "image"]);
    expect(model.modalities?.output).toEqual(["decision"]);
  });
});

test("an unseen model is only reported, and an empty list deletes nothing", async () => {
  await inRoot({ "kev-4b.toml": SHIPPED["kev-4b.toml"]! }, async (modelsDir) => {
    const catalog = { object: "list", data: [row("kev-4b", 65_536, ["text"], 0.015), row("kev-5b", 65_536, ["text"], 0.02)] };
    const seen = await syncProvider(at(modelsDir, () => catalog));
    expect(seen).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(seen.notices).toEqual([expect.stringContaining("`kev-5b`")]);
    expect(await Bun.file(path.join(modelsDir, "kev-5b.toml")).exists()).toBe(false);

    const empty = await syncProvider(at(modelsDir, () => ({ object: "list", data: [] })));
    expect(empty).toMatchObject({ deleted: 0, unchanged: 1 });
    expect(empty.notices).toEqual([expect.stringContaining("`kev-4b.toml`")]);
  });
});

test("a missing or negative price fails the run instead of writing a free model", () => {
  const priced = (price: unknown) => ({ object: "list", data: [{ ...row("kev-4b", 65_536, ["text"], 0.015), price }] });
  expect(() => verathos.parseModels(priced({ usd_per_million_input_tokens: -1, usd_per_million_output_tokens: 0 }))).toThrow();
  expect(() => verathos.parseModels(priced({ usd_per_million_output_tokens: 0 }))).toThrow();
});

test("fetches the public list without auth and fails on an error status", async () => {
  let init: RequestInit | undefined;
  const ok = (async (_url: string, options?: RequestInit) => {
    init = options;
    return new Response(JSON.stringify(LIVE()));
  }) as unknown as typeof fetch;
  expect(await fetchVerathosModels(ok)).toEqual(LIVE());
  expect(init).toBeUndefined();
  const failing = (async () => new Response("", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;
  await expect(fetchVerathosModels(failing)).rejects.toThrow("503");
});

test("ignores a row with an empty id", () => {
  const catalog = { object: "list", data: [row("", 65_536, ["text"], 0.015), row("  ", 65_536, ["text"], 0.015), row("kev-4b", 65_536, ["text"], 0.015)] };
  expect(verathos.parseModels(catalog).map((model) => model.id)).toEqual(["kev-4b"]);
});

test("an absent, empty or unrecognised modality list keeps the authored input", () => {
  // clef-flash reads images, so a fallback to text-only would show.
  // An authored table that reads in v1 like the lab's, as MIME types and "decision" do.
  const authored = { ...authoredV1("clef-flash.toml"), attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } as ExistingModel;
  const existing = { ...resolved("clef-flash.toml"), ...authored };
  for (const input_modalities of [undefined, null, [], ["telepathy"]]) {
    const model = buildVerathosModel({ ...row("clef-flash", 65_536, [], 0.02), input_modalities }, existing, authored);
    expect(model.modalities).toEqual(authored.modalities);
    expect(model.attachment).toBe(true);
  }
});

test("a repricing keeps clef-flash's inherited modalities", async () => {
  await inRoot({ "clef-flash.toml": SHIPPED["clef-flash.toml"]! }, async (modelsDir) => {
    const catalog = { object: "list", data: [row("clef-flash", 65_536, ["image", "text"], 0.03)] };
    expect(await syncProvider(at(modelsDir, () => catalog))).toMatchObject({ updated: 1 });
    expect(await read(modelsDir, "clef-flash.toml")).toBe(SHIPPED["clef-flash.toml"]!.replace("price = 0.02\n", "price = 0.03\n"));
  });
});

test("falls back to the authored cost when the list quotes no price", () => {
  const { price: _price, ...unpriced } = row("kev-4b", 65_536, ["text"], 0.015);
  expect(buildVerathosModel(unpriced, { ...resolved("kev-4b.toml"), cost: { input: 0.03, output: 0 } }).cost).toEqual({ input: 0.03, output: 0 });
});

test("passes an authored base_model_omit through", () => {
  const existing = { ...resolved("kev-4b.toml"), base_model_omit: ["limit.input"] };
  expect(buildVerathosModel(row("kev-4b", 65_536, ["text"], 0.015), existing)).toMatchObject({
    base_model: "jaredpalmer/kev-4b",
    base_model_omit: ["limit.input"],
  });
});

test("a repricing keeps the authored cost keys the list never quotes", () => {
  const existing = { ...resolved("kev-4b.toml"), cost: { input: 0.015, output: 0, cache_read: 0.005 } };
  expect(buildVerathosModel(row("kev-4b", 65_536, ["text"], 0.03), existing).cost).toEqual({ input: 0.03, output: 0, cache_read: 0.005 });
});

test("rounds a float price to micro-dollars so the hourly run is a no-op", () => {
  expect(0.1 + 0.2).toBe(0.30000000000000004);
  expect(buildVerathosModel(row("kev-4b", 65_536, ["text"], 0.1 + 0.2), resolved("kev-4b.toml")).cost?.input).toBe(0.3);
});

test("treats an absent or zero max_state_tokens as not reported", () => {
  const existing = resolved("d3-flash.toml");
  for (const max_state_tokens of [undefined, 0, -1]) {
    expect(buildVerathosModel({ ...row("d3-flash", 0, ["text"], 0.02), max_state_tokens }, existing).limit).toEqual({ context: 16_384 });
  }
});

test("keeps an authored limit.output", () => {
  const existing = resolved("kev-4b.toml");
  const model = buildVerathosModel(row("kev-4b", 65_536, ["text"], 0.015), { ...existing, limit: { ...existing.limit!, output: 1 } });
  expect(model.limit).toEqual({ output: 1 });
});

test("an authored base_model wins over the slug resolver", () => {
  // clef-flash resolves to cloudflare/clef-flash; a committed pointer elsewhere must stand.
  const model = buildVerathosModel(row("clef-flash", 65_536, ["text"], 0.015), resolved("kev-4b.toml"));
  expect(model).toMatchObject({ base_model: "jaredpalmer/kev-4b" });
});
