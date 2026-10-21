import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generate } from "../src/generate.js";
import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import { fetchPrimeModels, prime, PrimeResponse, type PrimeModel } from "../src/sync/providers/prime.js";

function model(overrides: Partial<PrimeModel> = {}): PrimeModel {
  return {
    id: "openai/gpt-5.4",
    display_name: "GPT-5.4 Hosted",
    pricing: { input_usd_per_mtok: 0.4, output_usd_per_mtok: 0.8, cache_read_usd_per_mtok: 0, cache_write_usd_per_mtok: null },
    specs: {
      context_window: 128_000,
      max_output_tokens: 8192,
      supports_reasoning: true,
      modalities: { input: ["text", "image", "file"], output: ["text"] },
    },
    supported_parameters: ["tools", "temperature", "response_format", "reasoning_effort"],
    reasoning: { supported_efforts: ["low", "high", "none"] },
    ...overrides,
  };
}

test("Prime is registered for scheduled sync and fetches its public catalog without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === prime.id)).toBe(true);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ object: "list", data: [model()] });
  }) as unknown as typeof fetch;
  await fetchPrimeModels(fetcher);
  expect(request!.url).toBe("https://api.pinference.ai/api/v1/models");
  expect(request!.headers.get("authorization")).toBeNull();

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  expect(fetchPrimeModels(unavailable)).rejects.toThrow("503");
});

test("empty, duplicate and malformed upstream inventories fail before any catalog writes", () => {
  expect(() => PrimeResponse.parse({ object: "list", data: [] })).toThrow("empty catalog");
  expect(() => PrimeResponse.parse({ object: "list", data: [model(), model()] })).toThrow("duplicate model IDs");
  expect(() => PrimeResponse.parse({ object: "list", data: [model({ context_window: -1 })] })).toThrow();
  expect(() => PrimeResponse.parse({ object: "list", data: [model({ pricing: { input_usd_per_mtok: -1 } })] })).toThrow();
});

test("unknown lab identities and unsupported or unpublished reasoning controls are never invented", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  for (const source of [
    model({ id: "example/unknown-chat" }),
    model({ reasoning: null }),
    model({ reasoning: { supported_efforts: [] } }),
    model({ reasoning: { supported_efforts: ["future-effort"] } }),
  ]) {
    expect(prime.translateModel(source, context)).toBeUndefined();
    expect(prime.missingModelID(source)).toBe(source.id);
  }
  for (const source of [
    model({ id: "internal/private" }),
    model({ id: "frontier/private" }),
    model({ id: "Qwen/case-sensitive-route" }),
    model({ id: "openai/gpt-5.4:deployment" }),
    model({ supported_parameters: [] }),
    model({ specs: { modalities: { input: ["text"], output: ["decisions"] } } }),
  ]) {
    expect(prime.translateModel(source, context)).toBeUndefined();
    expect(prime.missingModelID(source)).toBeUndefined();
  }
});

test("discovery generates an empty provider, updates prices, preserves incomplete live rows and removes retired models", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-prime-sync-"));
  const modelsDir = path.join(root, "providers/prime/models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models/openai"), { recursive: true });
  await copyFile(path.join(import.meta.dirname, "../../../models/openai/gpt-5.4.toml"), path.join(root, "models/openai/gpt-5.4.toml"));
  await copyFile(path.join(import.meta.dirname, "../../../providers/prime/provider.toml"), path.join(root, "providers/prime/provider.toml"));
  let data = [model()];
  const provider = { ...prime, modelsDir, fetchModels: async () => ({ object: "list", data }) };
  const file = Bun.file(path.join(modelsDir, "openai/gpt-5.4.toml"));
  try {
    const first = await syncProvider(provider, { openIssues: false });
    expect(first.created).toBe(1);
    const authored = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
    expect(authored.base_model).toBe("openai/gpt-5.4");
    expect(authored.release_date).toBeUndefined();
    expect(authored.name).toBe(model().display_name);
    const generated = (await generate(path.join(root, "providers"))).prime!.models[model().id]!;
    expect(generated.limit).toEqual({ context: 128_000, output: 8192 });
    expect(generated.cost).toEqual({ input: 0.4, output: 0.8, cache_read: 0 });
    expect(generated.modalities.input).toEqual(["text", "image"]);
    expect(generated.reasoning_options?.[0]?.type).toBe("effort");
    const effort = generated.reasoning_options?.[0];
    expect(effort?.type === "effort" ? new Set<string | null>(effort.values) : undefined)
      .toEqual(new Set(model().reasoning!.supported_efforts!));
    const second = await syncProvider(provider, { openIssues: false });
    expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 1 });

    data = [model({ context_window: 256_000, max_output_tokens: 16_384, pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } })];
    expect((await syncProvider(provider, { openIssues: false })).updated).toBe(1);
    const updated = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
    expect(updated.cost).toEqual({ input: 1, output: 2 });
    expect(updated.limit).toEqual({ context: 256_000, output: 16_384 });
    const previous = await file.text();

    data = [model({ reasoning: null })];
    expect((await syncProvider(provider, { openIssues: false })).deleted).toBe(0);
    expect(await file.text()).toBe(previous);
    data = [];
    expect(syncProvider(provider, { openIssues: false })).rejects.toThrow("empty catalog");
    expect(await file.text()).toBe(previous);

    data = [{ id: "example/new-unresolved-route" }];
    expect((await syncProvider(provider, { openIssues: false })).deleted).toBe(1);
    expect(await file.exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 files keep their effort order and MIME lists through a sync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-prime-v2-"));
  const modelsDir = path.join(root, "providers/prime/models");
  await mkdir(path.join(modelsDir, "openai"), { recursive: true });
  await mkdir(path.join(root, "models/openai"), { recursive: true });
  await copyFile(path.join(import.meta.dirname, "../../../models/openai/gpt-5.4.toml"), path.join(root, "models/openai/gpt-5.4.toml"));
  await copyFile(path.join(import.meta.dirname, "../../../providers/prime/provider.toml"), path.join(root, "providers/prime/provider.toml"));
  const file = Bun.file(path.join(modelsDir, "openai/gpt-5.4.toml"));
  await Bun.write(file, [
    "schema = 2",
    'base_model = "openai/gpt-5.4"',
    'name = "GPT-5.4 Hosted"',
    "",
    "[modalities]",
    'input = ["text", "image/jpeg", "image/png"]',
    'output = ["text"]',
    "",
    "[capabilities]",
    'reasoning = { supported = true, effort = ["none", "low", "high"] }',
    "structured_output = true",
    "",
    "[limit]",
    "context = 128_000",
    "output = 8_192",
    "",
    "[cost.text.input]",
    "price = 0.4",
    "cache = { read = 0 }",
    "",
    "[cost.text.output]",
    "price = 0.8",
    "",
  ].join("\n"));
  let data = [model({ reasoning: { supported_efforts: ["high", "none", "low"] } })];
  const provider = { ...prime, modelsDir, fetchModels: async () => ({ object: "list", data }) };
  try {
    expect((await syncProvider(provider, { openIssues: false })).updated).toBe(1);
    const text = await file.text();
    expect(text).toContain("# Effort: top-level reasoning_effort = none|low|high.");
    expect(text).toContain("# Mid-conversation: system_updates, effort_updates and tools.updates are unset");
    expect(text).toContain("https://api.pinference.ai/openapi.json");
    expect(text).toContain("# Input MIME types: the lab's entries");
    expect((await syncProvider(provider, { openIssues: false })).unchanged).toBe(1);

    data = [model({ pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 }, reasoning: { supported_efforts: ["low", "high", "none"] } })];
    expect((await syncProvider(provider, { openIssues: false })).updated).toBe(1);
    const updated = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(updated.cost.text).toEqual({ input: { price: 1 }, output: { price: 2 } });
    expect(updated.modalities.input).toEqual(["text", "image/jpeg", "image/png"]);
    expect(updated.capabilities).toEqual({
      reasoning: { supported: true, effort: ["none", "low", "high"] },
      structured_output: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
