import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generate } from "../src/generate.js";
import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import {
  fetchKelnModels,
  keln,
  kelnBaseModel,
  kelnReasoningControls,
  KelnResponse,
  type KelnModel,
} from "../src/sync/providers/keln.js";

function model(overrides: Partial<KelnModel> = {}): KelnModel {
  return {
    id: "deepseek-ai/deepseek-v4.1-flash",
    object: "model",
    context_length: 1_048_576,
    input_modalities: ["text", "image"],
    pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000036" },
    reasoning: { mandatory: false, supported_efforts: ["none", "low", "high", "max"], default_effort: "max" },
    ...overrides,
  };
}

const context = { existing: () => undefined, authored: () => undefined };

test("Keln is registered for scheduled sync and fetches its public catalog without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === keln.id)).toBe(true);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ object: "list", data: [model()] });
  }) as unknown as typeof fetch;
  await fetchKelnModels(fetcher);
  expect(request!.url).toBe("https://api.keln.ai/v1/models");
  expect(request!.headers.get("authorization")).toBeNull();

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  expect(fetchKelnModels(unavailable)).rejects.toThrow("503");
});

test("empty, duplicate and malformed upstream inventories fail before any catalog writes", () => {
  expect(() => KelnResponse.parse({ object: "list", data: [] })).toThrow("empty catalog");
  expect(() => KelnResponse.parse({ object: "list", data: [model(), model()] })).toThrow("duplicate model IDs");
  expect(() => KelnResponse.parse({ object: "list", data: [model({ context_length: -1 })] })).toThrow();
  expect(() => KelnResponse.parse({ object: "list", data: [model({ pricing: { prompt: "-0.1", completion: "0" } })] }))
    .toThrow();
  expect(() => KelnResponse.parse({ object: "list", data: [model({ pricing: { prompt: "1e-7", completion: "0" } })] }))
    .toThrow();
});

test("Hugging Face organisations resolve to the metadata labs", () => {
  expect(kelnBaseModel("deepseek-ai/deepseek-v4.1-flash")).toBe("deepseek/deepseek-v4.1-flash");
  expect(kelnBaseModel("minimaxai/minimax-m3")).toBe("minimax/MiniMax-M3");
  expect(kelnBaseModel("zai-org/glm-5.3")).toBe("zhipuai/glm-5.3");
  expect(kelnBaseModel("qwen/qwen3.8-27b")).toBe("alibaba/qwen3.8-27b");
  expect(kelnBaseModel("example/unknown-chat")).toBeUndefined();
});

test("reasoning options follow the published controls and are never invented", () => {
  // graded levels with an off switch: effort including "none", no separate toggle
  expect(kelnReasoningControls(model().reasoning)?.options)
    .toEqual([{ type: "effort", values: ["none", "low", "high", "max"] }]);
  // always on with levels: effort without "none"
  expect(kelnReasoningControls({ mandatory: true, supported_efforts: ["low", "high", "max"] })?.options)
    .toEqual([{ type: "effort", values: ["low", "high", "max"] }]);
  // on/off only: a toggle, and the header names the wire field
  const toggle = kelnReasoningControls({ mandatory: false });
  expect(toggle?.options).toEqual([{ type: "toggle" }]);
  expect(toggle?.header).toContain('reasoning_effort = "none"');
  expect(kelnReasoningControls({ mandatory: false, default_effort: "none" })?.header).toContain("off unless a level");
  // always on with no levels: no caller control
  expect(kelnReasoningControls({ mandatory: true })?.options).toEqual([]);
  // unknown or missing controls
  expect(kelnReasoningControls({ mandatory: false, supported_efforts: ["future-effort"] })).toBeUndefined();
  expect(kelnReasoningControls(null)).toBeUndefined();

  for (const source of [
    model({ id: "example/unknown-chat" }),
    model({ reasoning: null }),
    model({ reasoning: { mandatory: false, supported_efforts: ["future-effort"] } }),
    model({ input_modalities: ["image"] }),
  ]) {
    expect(keln.translateModel(source, context)).toBeUndefined();
    expect(keln.missingModelID(source)).toBe(source.id);
  }
});

test("prices convert exactly from per-token strings and only real overrides are written", () => {
  const translated = keln.translateModel(
    model({ id: "moonshotai/kimi-k2.7-code", context_length: 262_144, reasoning: { mandatory: true },
      pricing: { prompt: "0.00000095", completion: "0.000004", input_cache_read: "0.0000002375" } }),
    context,
  )!;
  expect(translated.model).toEqual({
    base_model: "moonshotai/kimi-k2.7-code",
    reasoning_options: [],
    cost: { input: 0.95, output: 4, cache_read: 0.2375 },
    modalities: { input: ["text", "image"] },
  });
  expect(translated.header).toContain("Always on");
});

test("discovery generates the provider, updates prices, keeps incomplete live rows and removes retired models", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-keln-sync-"));
  const modelsDir = path.join(root, "providers/keln/models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models/deepseek"), { recursive: true });
  await copyFile(
    path.join(import.meta.dirname, "../../../models/deepseek/deepseek-v4.1-flash.toml"),
    path.join(root, "models/deepseek/deepseek-v4.1-flash.toml"),
  );
  await copyFile(path.join(import.meta.dirname, "../../../providers/keln/provider.toml"), path.join(root, "providers/keln/provider.toml"));
  let data = [model()];
  const provider = { ...keln, modelsDir, fetchModels: async () => ({ object: "list", data }) };
  const file = Bun.file(path.join(modelsDir, "deepseek-ai/deepseek-v4.1-flash.toml"));
  try {
    const first = await syncProvider(provider, { openIssues: false });
    expect(first.created).toBe(1);
    const authored = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
    expect(authored.base_model).toBe("deepseek/deepseek-v4.1-flash");
    expect(authored.release_date).toBeUndefined();
    const generated = (await generate(path.join(root, "providers"))).keln!.models[model().id]!;
    expect(generated.limit.context).toBe(1_048_576);
    expect(generated.cost).toEqual({ input: 0.3, output: 1.2, cache_read: 0.036 });
    expect(generated.reasoning_options).toEqual([{ type: "effort", values: ["none", "low", "high", "max"] }]);
    const second = await syncProvider(provider, { openIssues: false });
    expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 1 });

    data = [model({ pricing: { prompt: "0.00000025", completion: "0.000001", input_cache_read: "0.00000003" } })];
    expect((await syncProvider(provider, { openIssues: false })).updated).toBe(1);
    const updated = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
    expect(updated.cost).toEqual({ input: 0.25, output: 1, cache_read: 0.03 });
    const previous = await file.text();

    data = [model({ reasoning: null })];
    expect((await syncProvider(provider, { openIssues: false })).deleted).toBe(0);
    expect(await file.text()).toBe(previous);
    data = [];
    expect(syncProvider(provider, { openIssues: false })).rejects.toThrow("empty catalog");
    expect(await file.text()).toBe(previous);

    data = [model({ id: "example/new-unresolved-route" })];
    expect((await syncProvider(provider, { openIssues: false })).deleted).toBe(1);
    expect(await file.exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
