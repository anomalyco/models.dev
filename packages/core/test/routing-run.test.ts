import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import {
  buildRoutingRunModel,
  fetchRoutingRunModels,
  parseRoutingRunModels,
  routingRun,
  type RoutingRunModel,
} from "../src/sync/providers/routing-run.js";

const row = (overrides: Partial<RoutingRunModel> = {}): RoutingRunModel => ({
  id: "gpt-5.6-luna",
  attachment: true,
  pricing: { prompt: "2.0000000000000002e-07", completion: "1.2e-06" },
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1_050_000, output: 128_000 },
  ...overrides,
});

const authored: ExistingModel = {
  name: "GPT-5.6 Luna",
  reasoning_options: [],
  cost: { input: 9, output: 9 },
  limit: { context: 1, output: 1 },
};

test("registers an update-only hourly sync and never deletes absent entries", () => {
  expect(providers["routing-run"]).toBe(routingRun);
  expect(routingRun.skipCreates).toBe(true);
  expect(routingRun.trackMissingModels).toBe(true);
  expect(routingRun.deleteMissing).toBe(false);
});

test("fetches the public catalog and rejects HTTP failures", async () => {
  let request: string | undefined;
  const fetcher = (async (input) => {
    request = String(input);
    return Response.json({ data: [row()] });
  }) as typeof fetch;
  await expect(fetchRoutingRunModels(fetcher)).resolves.toMatchObject({ data: [row()] });
  expect(request).toBe("https://api.routing.run/v1/models");
  await expect(
    fetchRoutingRunModels((async () => new Response("bad gateway", { status: 502 })) as typeof fetch),
  ).rejects.toThrow("502");
});

test("rejects empty, duplicate, and malformed catalogs", () => {
  expect(() => parseRoutingRunModels({ data: [] })).toThrow();
  expect(() => parseRoutingRunModels({ data: [row(), row()] })).toThrow("duplicate");
  expect(() =>
    parseRoutingRunModels({ data: [row({ pricing: { prompt: "-1", completion: "1" } })] }),
  ).toThrow();
  expect(() =>
    parseRoutingRunModels({ data: [row({ pricing: { prompt: "", completion: "1" } })] }),
  ).toThrow();
  expect(parseRoutingRunModels({ data: [row({ precision: "fp8" } as Partial<RoutingRunModel>)] })).toHaveLength(1);
});

test("converts per-token prices to per-1M-token and applies served limits", () => {
  const synced = buildRoutingRunModel(row(), authored);
  expect(synced).toMatchObject({
    name: "GPT-5.6 Luna",
    cost: { input: 0.2, output: 1.2 },
    limit: { context: 1_050_000, output: 128_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    attachment: true,
    reasoning_options: [],
  });
});

test("keeps authored values when the listing omits pricing or limits", () => {
  const synced = buildRoutingRunModel(row({ pricing: undefined, limit: undefined }), authored);
  expect(synced).toMatchObject({ cost: { input: 9, output: 9 }, limit: { context: 1, output: 1 } });
  const noModalities = buildRoutingRunModel(row({ modalities: undefined, attachment: undefined }), authored);
  expect(noModalities).not.toHaveProperty("modalities");
  expect(noModalities).not.toHaveProperty("attachment");
});

test("applies served prices through the base-model overlay", () => {
  const synced = buildRoutingRunModel(
    row({ pricing: { prompt: "3.3e-06", completion: "7.7e-06" } }),
    { ...authored, base_model: "openai/gpt-5.6-luna" },
  );
  expect(synced).toMatchObject({
    base_model: "openai/gpt-5.6-luna",
    cost: { input: 3.3, output: 7.7 },
  });
});

test("tracks priced chat rows and skips unpriced services", () => {
  expect(routingRun.sourceID(row())).toBe("gpt-5.6-luna");
  expect(routingRun.sourceID(row({ pricing: undefined }))).toBeUndefined();
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("runner updates authored entries, reports new models, and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routing-run-sync-test-"));
  roots.push(root);
  const modelsDir = path.join(root, "providers/routing-run/models");
  await mkdir(modelsDir, { recursive: true });
  const metadataDir = path.join(root, "models/openai");
  await mkdir(metadataDir, { recursive: true });
  await Bun.write(
    path.join(metadataDir, "gpt-5.6-sol.toml"),
    'name = "GPT-5.6 Sol"\n\n[limit]\ncontext = 1_000_000\noutput = 128_000\n',
  );
  const file = path.join(modelsDir, "gpt-5.6-sol.toml");
  const initial = await Bun.file("providers/routing-run/models/gpt-5.6-sol.toml").text();
  await Bun.write(file, initial);
  const retired = path.join(modelsDir, "retired-route.toml");
  await Bun.write(retired, initial);
  const model = row({
    id: "gpt-5.6-sol",
    pricing: { prompt: "5e-06", completion: "3e-05" },
    limit: { context: 1_050_000, output: 128_000 },
  });
  const provider = {
    ...routingRun,
    modelsDir,
    fetchModels: async () => ({ data: [model, row({ id: "vendor/new-model" })] }),
  };
  const result = await syncProvider(provider);
  expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0, unchanged: 1 });
  expect(result.notices.join("\n")).toContain("vendor/new-model");
  expect(await Bun.file(path.join(modelsDir, "vendor/new-model.toml")).exists()).toBe(false);
  expect(await Bun.file(retired).text()).toBe(initial);
  expect(Bun.TOML.parse(await Bun.file(file).text())).toMatchObject({
    cost: { input: 5, output: 30 },
    modalities: { input: ["text", "image"] },
  });
  expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
});
