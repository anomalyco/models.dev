import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";
import { fetchSintaksModels, parseSintaksModels, sintaksDev } from "../src/sync/providers/sintaks-dev.js";

const current = {
  schema: 2,
  base_model: "openai/gpt-5.2-codex",
  capabilities: { reasoning: { supported: true, effort: ["low", "high", "xhigh"] } },
  cost: { text: { input: { price: 1, cache: { read: 0.1 } }, output: { price: 2 } } },
  limit: { output: 100 },
};
const row = {
  id: "openai/gpt-5.2-codex",
  type: "chat",
  context_window: 400_000,
  pricing: { input_usd_per_1m: 3, output_usd_per_1m: 4 },
};
const context = { existing: () => undefined, authored: () => undefined, v2: () => current };

test("updates reported prices and context while preserving authored metadata", () => {
  const result = sintaksDev.translateModel(row, context);
  expect(result?.v2).toEqual({
    ...current,
    cost: { text: { input: { price: 3, cache: { read: 0.1 } }, output: { price: 4 } } },
    limit: { context: 400_000, output: 100 },
  });
  expect(current.cost.text.input.price).toBe(1);
});

test("keeps missing rates and limits and does not create unknown models", () => {
  const result = sintaksDev.translateModel({ id: row.id }, context);
  expect(result?.v2).toEqual(current);
  expect(sintaksDev.translateModel(row, { ...context, v2: () => undefined })).toBeUndefined();
  expect(sintaksDev.deleteMissing).toBe(false);
  expect(sintaksDev.skipCreates).toBe(true);
  expect(sintaksDev.trackMissingModels).toBe(false);
});

test("does not invent output prices for embedding entries", () => {
  const embedding = { schema: 2, base_model: "openai/text-embedding-3-small", cost: { text: { input: { price: 0.1 } } } };
  const result = sintaksDev.translateModel({ ...row, type: "embedding" }, { ...context, v2: () => embedding });
  expect(result?.v2.cost).toEqual({ text: { input: { price: 3 } } });
});

test("clamps an inherited output limit that exceeds the gateway context", () => {
  const result = sintaksDev.translateModel({ ...row, context_window: 80 }, {
    ...context,
    existing: () => ({ limit: { context: 200, output: 100 } }),
    v2: () => ({ ...current, limit: undefined }),
  });
  expect(result?.v2.limit).toEqual({ context: 80, output: 80 });
});

test("rejects empty, duplicate, and invalid inventories", () => {
  expect(() => parseSintaksModels({ data: [] })).toThrow();
  expect(() => parseSintaksModels({ data: [row, row] })).toThrow("Duplicate");
  expect(() => parseSintaksModels({ data: [{ ...row, pricing: { input_usd_per_1m: -1 } }] })).toThrow();
});

test("fetches the public model list and fails on HTTP errors", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string) => { urls.push(url); return Response.json({ data: [row] }); }) as unknown as typeof fetch;
  expect(await fetchSintaksModels(fetcher)).toEqual({ data: [row] });
  expect(urls).toEqual(["https://api.sintaks.dev/v1/models"]);
  const failing = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  await expect(fetchSintaksModels(failing)).rejects.toThrow("503");
});

test("runner retains missing models and never creates unreviewed entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-sintaks-"));
  const modelsDir = path.join(root, "providers", "sintaks-dev", "models");
  try {
    await mkdir(path.join(modelsDir, "openai"), { recursive: true });
    await mkdir(path.join(root, "models", "openai"), { recursive: true });
    await Bun.write(path.join(root, "models", "openai", "gpt-5.2-codex.toml"), Bun.file("models/openai/gpt-5.2-codex.toml"));
    const source = await readFile("providers/sintaks-dev/models/openai/gpt-5.2-codex.toml", "utf8");
    const kept = path.join(modelsDir, "openai", "gpt-5.2-codex.toml");
    await writeFile(kept, source);
    const provider = { ...sintaksDev, modelsDir, fetchModels: async () => ({ data: [{ ...row, id: "openai/unreviewed" }] }) };
    const result = await syncProvider(provider);
    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 1 });
    expect(await readFile(kept, "utf8")).toBe(source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
