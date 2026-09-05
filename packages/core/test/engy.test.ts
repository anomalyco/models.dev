import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeDeep } from "remeda";

import { syncProvider, type ExistingModel, type SyncedModel, type SyncProvider } from "../src/sync/index.js";
import { buildEngyModel, engy, type EngyModel } from "../src/sync/providers/engy.js";
import { modelMetadata } from "../src/sync/providers/openrouter.js";

const REPO = path.join(import.meta.dirname, "..", "..", "..");
const SHIPPED_DIR = path.join(REPO, "providers", "engy", "models");
const LAB_DIR = path.join(REPO, "models");

// Two rows of GET https://api.engy.ai/v1/models (2026-08-31), trimmed to the
// fields the sync reads. Prices are per-token USD strings, two of which are
// inexact once multiplied to per-1M, and modalities come image-first.
const PUBLIC_LIST = {
  object: "list",
  data: [
    {
      id: "glm-5.2",
      input_modalities: ["text"],
      output_modalities: ["text"],
      context_length: 262_144,
      pricing: { prompt: "0.00000068", completion: "0.0000015", input_cache_read: "0.00000018" },
    },
    {
      id: "glm-5.3-flash",
      input_modalities: ["image", "text"],
      output_modalities: ["text"],
      context_length: 262_144,
      pricing: { prompt: "0.000000135", completion: "0.00000045", input_cache_read: "0.000000027" },
    },
  ],
};
const [GLM52_ROW, FLASH_ROW] = engy.parseModels(PUBLIC_LIST) as [EngyModel, EngyModel];

function perToken(usdPerMillion: number | undefined) {
  return usdPerMillion === undefined ? undefined : (usdPerMillion / 1e6).toFixed(12).replace(/0+$/, "");
}

// The row engy's list has to serve for the sync to leave a file alone.
function wireRow(id: string, model: ExistingModel, prompt = perToken(model.cost?.input)): EngyModel {
  return {
    id,
    // engy lists image before text.
    input_modalities: [...(model.modalities?.input ?? [])].reverse(),
    output_modalities: model.modalities?.output,
    context_length: model.limit?.context,
    pricing: { prompt, completion: perToken(model.cost?.output), input_cache_read: perToken(model.cost?.cache_read) },
  };
}

// Every shipped file as the runner sees it: the text, its comment header, the
// file merged over its lab base, and its wire row. Read from the file so an
// hourly repricing cannot make the round trips stale.
type Shipped = { text: string; header: string; resolved: ExistingModel; wire: EngyModel };

const SHIPPED: Record<string, Shipped> = Object.fromEntries(
  readdirSync(SHIPPED_DIR).map((file) => {
    const id = file.slice(0, -".toml".length);
    const text = readFileSync(path.join(SHIPPED_DIR, file), "utf8");
    const authored = Bun.TOML.parse(text) as ExistingModel;
    const { benchmarks: _benchmarks, weights: _weights, ...base } = modelMetadata(authored.base_model!);
    const resolved = mergeDeep(base, authored) as ExistingModel;
    return [id, { text, header: text.slice(0, text.indexOf("base_model =")), resolved, wire: wireRow(id, resolved) }];
  }),
);
const GLM52 = SHIPPED["glm-5.2"]!;
const KIMI_K3 = SHIPPED["kimi-k3"]!;
// The same file with no pointer: what the runner hands over for an inline file.
const { base_model: _pointer, ...GLM52_INLINE } = GLM52.resolved;

function baseModelOf(model: SyncedModel) {
  return "base_model" in model ? model.base_model : undefined;
}

test("parses the public list", () => {
  const models = engy.parseModels(PUBLIC_LIST);
  expect(models.map((model) => model.id)).toEqual(["glm-5.2", "glm-5.3-flash"]);
  expect(models.map((model) => engy.sourceID(model))).toEqual(["glm-5.2", "glm-5.3-flash"]);
});

test("is update-only: no creates, no deletes, a notice for each", () => {
  expect(engy).toMatchObject({ skipCreates: true, trackMissingModels: true, deleteMissing: false });
  // The runner's preserveBaseModel step stays on, so a translated model that
  // lost its pointer gets it back from the existing file.
  expect((engy as SyncProvider<EngyModel>).preserveBaseModels).toBeUndefined();
  expect(engy.skippedNotice([])).toEqual([]);
  expect(engy.missingNotice([])).toEqual([]);
});

test("converts per-token price strings to per-1M and rounds away the float error", () => {
  // Unrounded, these two files would be rewritten on every hourly run.
  expect(Number("0.00000068") * 1e6).toBe(0.6799999999999999);
  expect(Number("0.00000045") * 1e6).toBe(0.44999999999999996);
  expect(buildEngyModel(GLM52_ROW, undefined).cost).toEqual({ input: 0.68, output: 1.5, cache_read: 0.18 });
  expect(buildEngyModel(FLASH_ROW, undefined).cost).toEqual({ input: 0.135, output: 0.45, cache_read: 0.027 });
});

test("writes modalities in catalog order, de-duplicated, unknown names dropped", () => {
  // Factored against zhipuai/glm-5.3-flash, whose output already matches.
  expect(buildEngyModel(FLASH_ROW, undefined).modalities).toEqual({ input: ["text", "image"] });
  const model = buildEngyModel(
    {
      id: "engy-unlisted-preview",
      input_modalities: ["PDF", "video", "image", "text", "audio", "text", "telepathy"],
      output_modalities: [],
    },
    undefined,
  );
  // An empty list is not "no modalities"; it degrades to text.
  expect(model.modalities).toEqual({ input: ["text", "image", "audio", "video", "pdf"], output: ["text"] });
});

test("keeps the authored modalities when the list omits them", () => {
  // A missing list is "not reported", not text-only: a field rename upstream
  // must not narrow every file on the hourly run.
  const row = {
    ...KIMI_K3.wire,
    id: "engy-unlisted-preview",
    input_modalities: undefined,
    output_modalities: undefined,
  };
  const authored: ExistingModel = { modalities: { input: ["text", "image"], output: ["text", "image"] } };
  expect(buildEngyModel(row, authored).modalities).toEqual(authored.modalities);
  expect(buildEngyModel(row, undefined).modalities).toEqual({ input: ["text"], output: ["text"] });
});

test("derives attachment from the input engy serves", () => {
  // Text-only on engy while alibaba/qwen3.6-35b-a3b takes images: written out.
  const qwen = buildEngyModel(SHIPPED["qwen3.6-35b-a3b"]!.wire, undefined);
  expect(qwen).toMatchObject({ attachment: false, modalities: { input: ["text"] } });
  // Image-capable on engy and on the base: nothing to write.
  expect(buildEngyModel(FLASH_ROW, undefined)).not.toHaveProperty("attachment");
  // No base to inherit from: written either way.
  const bare = buildEngyModel({ id: "engy-unlisted-preview", input_modalities: ["image", "text"] }, undefined);
  expect(bare.attachment).toBe(true);
});

test("resolves engy's bare slugs to the lab file each shipped entry points at", () => {
  for (const [id, { resolved }] of Object.entries(SHIPPED)) {
    expect(baseModelOf(buildEngyModel({ id }, undefined))).toBe(resolved.base_model);
  }
  expect(buildEngyModel({ id: "engy-unlisted-preview" }, undefined)).not.toHaveProperty("base_model");
});

test("an authored base_model wins on a resolver miss", () => {
  // The resolver has nothing for this slug, as it has nothing for an ambiguous
  // one. The committed pointer must win, or the file is rewritten as an inline
  // copy of the lab entry.
  const model = buildEngyModel({ ...GLM52.wire, id: "engy-unlisted-preview" }, GLM52.resolved);
  expect(baseModelOf(model)).toBe("zhipuai/glm-5.2");
  expect(model).not.toHaveProperty("description");
  expect(model).not.toHaveProperty("family");
  expect(model).toMatchObject({ cost: GLM52.resolved.cost, limit: GLM52.resolved.limit });
});

test("carries every field the list does not report through an inline file", () => {
  // Nothing factors these away on the inline path, so each must be copied over
  // or the rewrite drops it.
  const existing: ExistingModel = {
    ...GLM52_INLINE,
    knowledge: "2026-03",
    status: "beta",
    provider: { body: { chat_template_kwargs: { enable_thinking: true } } },
    experimental: { modes: { fast: { cost: { input: 1.36, output: 3 } } } },
  };
  const model = buildEngyModel({ ...GLM52.wire, id: "engy-unlisted-preview" }, existing);
  expect(model).not.toHaveProperty("base_model");
  for (const key of [
    "name", "description", "family", "release_date", "last_updated", "reasoning", "temperature", "tool_call",
    "structured_output", "open_weights", "knowledge", "status", "interleaved", "provider", "experimental",
  ] as const) {
    expect(existing[key]).toBeDefined();
    expect(model[key]).toEqual(existing[key]);
  }
  // reasoning_options are the runner's to carry (preserveReasoningOptions).
  expect(model).not.toHaveProperty("reasoning_options");
});

test("passes an authored base_model_omit through", () => {
  const model = buildEngyModel(GLM52.wire, { ...GLM52.resolved, base_model_omit: ["limit.input"] });
  expect(model).toMatchObject({ base_model: "zhipuai/glm-5.2", base_model_omit: ["limit.input"] });
});

test("treats an absent or zero context as not reported and never guesses the split", () => {
  // `??` alone would write context = 0 under the authored input/output split
  // from one bad row.
  for (const context_length of [undefined, 0]) {
    const model = buildEngyModel({ ...GLM52.wire, id: "engy-unlisted-preview", context_length }, GLM52_INLINE);
    expect(model.limit).toEqual(GLM52.resolved.limit);
  }
  // The split lives behind auth on engy.ai/api/v1/models, and the advertised
  // context is max_input + max_output, so an unseen split stays unset.
  const bare = buildEngyModel({ ...GLM52.wire, id: "engy-unlisted-preview" }, undefined);
  expect(bare.limit).toEqual({ context: GLM52.wire.context_length, input: undefined, output: 0 });
});

test("falls back to the authored cost when the list quotes no prices", () => {
  const model = buildEngyModel({ ...GLM52.wire, pricing: undefined }, GLM52.resolved);
  expect(model.cost).toEqual(GLM52.resolved.cost);
});

test("keeps the authored cache_read when the list quotes none", () => {
  const model = buildEngyModel(
    { ...GLM52.wire, pricing: { prompt: "0.0000007", completion: GLM52.wire.pricing?.completion } },
    GLM52.resolved,
  );
  expect(model.cost).toEqual({ ...GLM52.resolved.cost, input: 0.7 });
});

test("a repricing keeps the authored cost fields the list never quotes", () => {
  const cost: ExistingModel["cost"] = {
    ...GLM52.resolved.cost!,
    cache_write: 0.85,
    reasoning: 1.5,
    input_audio: 2,
    output_audio: 4,
    tiers: [{ tier: { type: "context", size: 200_000 }, input: 1.36, output: 3, cache_read: 0.36 }],
  };
  const model = buildEngyModel(wireRow("glm-5.2", GLM52.resolved, "0.0000007"), { ...GLM52.resolved, cost });
  expect(model.cost).toEqual({ ...cost, input: 0.7 });
});

// A throwaway checkout: the engy files plus the lab files they point at, so the
// runner resolves base_model exactly as it does in the repo.
async function inRoot(files: Record<string, string>, run: (modelsDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-engy-"));
  const modelsDir = path.join(root, "providers", "engy", "models");
  await mkdir(modelsDir, { recursive: true });
  try {
    for (const [file, text] of Object.entries(files)) {
      await writeFile(path.join(modelsDir, file), text);
      const base = (Bun.TOML.parse(text) as ExistingModel).base_model;
      if (base === undefined) continue;
      await mkdir(path.join(root, "models", path.dirname(base)), { recursive: true });
      await copyFile(path.join(LAB_DIR, `${base}.toml`), path.join(root, "models", `${base}.toml`));
    }
    await run(modelsDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function engyAt(modelsDir: string, source: () => unknown): SyncProvider<EngyModel> {
  return { ...engy, modelsDir, async fetchModels() { return source(); } };
}

// Every shipped model as engy would list it, with any prompt price overridden.
function list(prompt: Record<string, string> = {}) {
  return {
    object: "list",
    data: Object.entries(SHIPPED).map(([id, { resolved }]) => wireRow(id, resolved, prompt[id])),
  };
}

function read(modelsDir: string, file: string) {
  return readFile(path.join(modelsDir, file), "utf8");
}

// Doubling a price is exact in binary, so the rewritten line is predictable.
function doubled(shipped: Shipped) {
  const input = shipped.resolved.cost!.input;
  return {
    prompt: perToken(input * 2)!,
    rewrite: (text: string) => text.replace(`input = ${input}\n`, `input = ${input * 2}\n`),
  };
}

test("the shipped files are a fixed point, and unauthored models are only reported", async () => {
  await inRoot({ "glm-5.2.toml": GLM52.text, "kimi-k3.toml": KIMI_K3.text }, async (modelsDir) => {
    const provider = engyAt(modelsDir, () => list());
    const first = await syncProvider(provider);
    const second = await syncProvider(provider);
    for (const result of [first, second]) {
      expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2, files: [] });
    }
    expect(await read(modelsDir, "glm-5.2.toml")).toBe(GLM52.text);
    expect(await read(modelsDir, "kimi-k3.toml")).toBe(KIMI_K3.text);

    // skipCreates: a created file would ship limit.output = 0, so the models
    // with no local file are named instead.
    expect(first.notices).toEqual([expect.stringContaining("not created")]);
    for (const id of Object.keys(SHIPPED).filter((id) => id !== "glm-5.2" && id !== "kimi-k3")) {
      expect(await Bun.file(path.join(modelsDir, `${id}.toml`)).exists()).toBe(false);
      expect(first.notices[0]).toContain(`\`${id}\``);
    }
    expect(first.notices[0]).not.toContain("`kimi-k3`");
  });
});

test("a repricing changes the price line and nothing else", async () => {
  // Shipped kimi-k3, plus a glm-5.2 that overrides two intrinsic fields of its
  // base. An exact match proves the header, reasoning_options, the authored
  // limit split, the overrides and the modality order all survive the rewrite.
  const glm52 = GLM52.text.replace("\n\n[interleaved]", "\ntemperature = false\ntool_call = false\n\n[interleaved]");
  await inRoot({ "glm-5.2.toml": glm52, "kimi-k3.toml": KIMI_K3.text }, async (modelsDir) => {
    let catalog = list();
    const provider = engyAt(modelsDir, () => catalog);
    expect(await syncProvider(provider)).toMatchObject({ updated: 0, unchanged: 2 });

    const glm = doubled(GLM52);
    const kimi = doubled(KIMI_K3);
    catalog = list({ "glm-5.2": glm.prompt, "kimi-k3": kimi.prompt });
    expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 2, deleted: 0 });
    expect(await read(modelsDir, "glm-5.2.toml")).toBe(glm.rewrite(glm52));
    expect(await read(modelsDir, "kimi-k3.toml")).toBe(kimi.rewrite(KIMI_K3.text));
  });
});

test("a committed file stays factored when its slug no longer resolves", async () => {
  // The same shape as an ambiguous slug: the resolver has nothing, but the file
  // already points at zhipuai/glm-5.2.
  await inRoot({ "engy-unlisted-preview.toml": GLM52.text }, async (modelsDir) => {
    const row = (prompt?: string) => ({
      object: "list",
      data: [{ ...wireRow("glm-5.2", GLM52.resolved, prompt), id: "engy-unlisted-preview" }],
    });
    let catalog = row();
    const provider = engyAt(modelsDir, () => catalog);
    expect(await syncProvider(provider)).toMatchObject({ updated: 0, unchanged: 1 });

    const glm = doubled(GLM52);
    catalog = row(glm.prompt);
    expect(await syncProvider(provider)).toMatchObject({ updated: 1 });
    expect(await read(modelsDir, "engy-unlisted-preview.toml")).toBe(glm.rewrite(GLM52.text));
  });
});

test("an empty list deletes nothing and names the retained files", async () => {
  // {"data":[]} is a valid response from the unauthenticated endpoint, and
  // skipCreates could not bring a deleted file back.
  await inRoot({ "glm-5.2.toml": GLM52.text, "kimi-k3.toml": KIMI_K3.text }, async (modelsDir) => {
    const result = await syncProvider(engyAt(modelsDir, () => ({ object: "list", data: [] })));
    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2, files: [] });
    expect(await read(modelsDir, "glm-5.2.toml")).toBe(GLM52.text);
    expect(result.notices).toEqual([expect.stringContaining("retained")]);
    expect(result.notices[0]).toContain("`glm-5.2.toml`");
    expect(result.notices[0]).toContain("`kimi-k3.toml`");
  });
});
