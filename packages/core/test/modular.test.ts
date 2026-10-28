import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";
import { buildModularModel, fetchModularModels, isPublic, modular, ModularModel } from "../src/sync/providers/modular.js";

const model = ModularModel.parse({
  model_id: "deepseek-ai/DeepSeek-V4.1-Flash",
  gateway_model_id: "deepseek/deepseek-v4.1-flash",
  shared_endpoint: true,
  billing_type: "token",
  context_window: "1M",
  pricing: { cached_input: "0.00000002", input: "0.00000017", output: "0.0000012" },
});

const existing = {
  base_model: "deepseek/deepseek-v4.1-flash",
  cost: { input: 0.1, output: 1, cache_read: 0.01 },
  limit: { context: 1_048_576, output: 393_216 },
};

const context = {
  existing: (id: string) => (id === model.gateway_model_id ? existing : undefined),
  authored: (id: string) => (id === model.gateway_model_id ? existing : undefined),
};

test("converts per-token catalog prices to per-1M prices without float noise", () => {
  const built = buildModularModel(model, { cost: existing.cost, limit: existing.limit }) as Record<string, any>;
  expect(built.cost).toEqual({ input: 0.17, output: 1.2, cache_read: 0.02 });
  expect(built.limit).toEqual(existing.limit);
});

test("keeps measured limits instead of the catalog's rounded context window", () => {
  const built = buildModularModel(model, { cost: existing.cost, limit: { context: 1_000_000, output: 8192 } }) as Record<string, any>;
  expect(built.limit).toEqual({ context: 1_000_000, output: 8192 });
});

test("updates an existing model under its served ID", () => {
  expect(modular.translateModel(model, context)?.id).toBe("deepseek/deepseek-v4.1-flash");
});

test("skips a public model with no local file", () => {
  expect(modular.translateModel({ ...model, gateway_model_id: "new/model" }, context)).toBeUndefined();
});

test("treats unpriced, dedicated, and unrouted rows as not public", () => {
  expect(isPublic(model)).toBe(true);
  expect(isPublic({ ...model, pricing: { cached_input: "0", input: "0", output: "0" } })).toBe(false);
  expect(isPublic({ ...model, shared_endpoint: false })).toBe(false);
  expect(isPublic({ ...model, gateway_model_id: "" })).toBe(false);
  expect(isPublic({ ...model, billing_type: "megapixels" })).toBe(false);
  expect(modular.translateModel({ ...model, shared_endpoint: false }, context)).toBeUndefined();
  expect(modular.sourceID({ ...model, gateway_model_id: "" })).toBeUndefined();
});

test("rejects a catalog with no public models", () => {
  expect(() => modular.parseModels({ models: [] })).toThrow("no public models");
  expect(() => modular.parseModels({ models: [{ ...model, shared_endpoint: false }] })).toThrow("no public models");
});

test("fails without a catalog when the endpoint is down or returns something else", async () => {
  const respond = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  await expect(fetchModularModels(respond("", 503))).rejects.toThrow("503");
  await expect(fetchModularModels(respond("<html>maintenance</html>"))).rejects.toThrow();
  await expect(fetchModularModels(respond(JSON.stringify({ data: [] })))).rejects.toThrow();
});

test("never creates models or opens issues for them", () => {
  expect(modular.skipCreates).toBe(true);
  expect(modular.trackMissingModels).toBe(false);
});

test("sync updates prices of listed models and removes models that leave the public set", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-modular-"));
  const modelsDir = path.join(dir, "providers", "modular", "models");
  const kept = path.join(modelsDir, "ai21", "jamba-mini.toml");
  const retired = path.join(modelsDir, "ai21", "jamba-large.toml");
  await mkdir(path.dirname(kept), { recursive: true });
  await mkdir(path.join(dir, "models", "ai21"), { recursive: true });
  for (const id of ["jamba-mini", "jamba-large"]) {
    await copyFile(path.join("models", "ai21", `${id}.toml`), path.join(dir, "models", "ai21", `${id}.toml`));
    await Bun.write(path.join(modelsDir, "ai21", `${id}.toml`), [
      "schema = 2",
      `base_model = "ai21/${id}"`,
      "",
      "[cost.text.input]",
      "price = 0.1",
      "",
      "[cost.text.output]",
      "price = 1",
      "",
    ].join("\n"));
  }
  const row = (id: string, shared: boolean) => ({
    ...model,
    gateway_model_id: `ai21/${id}`,
    shared_endpoint: shared,
  });

  try {
    const result = await syncProvider({
      ...modular,
      modelsDir,
      async fetchModels() {
        return { models: [row("jamba-mini", true), row("jamba-large", false)] };
      },
    });

    expect(result).toMatchObject({ updated: 1 });
    const content = await readFile(kept, "utf8");
    expect(content).toContain("price = 0.17");
    expect(content).toContain("price = 1.2");
    expect(existsSync(retired)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
