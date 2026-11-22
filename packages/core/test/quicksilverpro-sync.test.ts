import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import {
  buildQuickSilverProModel,
  fetchQuickSilverProModels,
  quicksilverpro,
  QuickSilverProResponse,
  type QuickSilverProModel,
} from "../src/sync/providers/quicksilverpro.js";

function model(overrides: Partial<QuickSilverProModel> = {}): QuickSilverProModel {
  return {
    id: "gpt-5.6-sol",
    lifecycle: "active",
    pricing_unit: "tokens",
    capabilities: ["text_input", "text_output", "tools", "json_schema"],
    context_tokens: 1_048_576,
    max_output_tokens: 131_072,
    input_per_1m: 1.6,
    output_per_1m: 8,
    cached_input_per_1m: 0.16,
    cache_write_per_1m: 2,
    ...overrides,
  };
}
const response = (models = [model()]) => ({ currency: "USD", models });

test("registered sync fetches the public catalog without authentication and rejects HTTP errors", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === "quicksilverpro")).toBe(true);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = new Request(input, init);
    return Response.json(response());
  }) as unknown as typeof fetch;
  await fetchQuickSilverProModels(fetcher);
  expect(request!.url).toBe("https://quicksilverpro.io/pricing.json");
  expect(request!.headers.get("authorization")).toBeNull();
  await expect(fetchQuickSilverProModels((async () => new Response(null, { status: 503 })) as unknown as typeof fetch))
    .rejects.toThrow("503");
});

test("empty, duplicate, malformed, non-USD and incomplete text inventories fail closed", () => {
  for (const raw of [
    response([]), response([model(), model()]), response([model(), model({ id: "GPT-5.6-SOL" })]),
    response([model({ context_tokens: -1 })]), response([model({ input_per_1m: -1 })]),
    response([model({ output_per_1m: undefined })]), { ...response(), currency: "EUR" },
  ]) expect(() => QuickSilverProResponse.parse(raw)).toThrow();
});

test("only prices and lower caps change; host controls and lab inheritance survive", () => {
  const authored = { base_model: "openai/gpt-5.6-sol", reasoning_options: [{ type: "effort" as const, values: ["low" as const, "high" as const] }],
    limit: { context: 1_048_576 }, cost: { input: 2, output: 10, cache_read: 1, cache_write: 3 } };
  const existing = { ...authored, limit: { context: 1_048_576, input: 922_000, output: 128_000 } };
  const translated = buildQuickSilverProModel(model(), authored, existing);
  expect(translated.limit).toEqual({ context: 1_048_576 });
  expect(translated.cost).toEqual({ input: 1.6, output: 8, cache_read: 0.16, cache_write: 2 });
  expect(translated.base_model).toBe(authored.base_model);
  expect(translated.reasoning_options).toEqual(authored.reasoning_options);
  expect(buildQuickSilverProModel(model({ context_tokens: 64_000, max_output_tokens: null }), authored, existing).limit)
    .toEqual({ context: 64_000, input: 64_000, output: 64_000 });
  expect(buildQuickSilverProModel(model({ context_tokens: null, max_output_tokens: null }), authored, existing).limit)
    .toEqual(authored.limit);
  const noCache = buildQuickSilverProModel(model({ cached_input_per_1m: undefined, cache_write_per_1m: undefined }), authored, existing);
  expect(noCache.cost?.cache_read).toBe(1);
  expect(noCache.cost?.cache_write).toBe(3);
  expect(buildQuickSilverProModel(model({ lifecycle: "deprecated" }), authored, existing).status).toBe("deprecated");
  const kimi = { base_model: "moonshotai/kimi-k3.1-pro", limit: { output: 943_718 } };
  expect(buildQuickSilverProModel(model({ max_output_tokens: 943_718 }), kimi,
    { ...kimi, limit: { context: 1_048_576, output: 943_718 } }).limit?.output).toBe(943_718);
});

test("new models and non-token services are skipped without creating issues", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  expect(quicksilverpro.translateModel(model(), context)).toBeUndefined();
  expect(quicksilverpro.sourceID(model({ pricing_unit: "per_second" }))).toBeUndefined();
  expect(quicksilverpro.sourceID(model({ capabilities: ["image_output"] }))).toBeUndefined();
  expect(quicksilverpro.trackMissingModels).toBe(false);
});

test("runner keeps MIME types, header, Kimi cap and absent routes, and converges on a second sync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modelsdev-quicksilver-test-"));
  const repo = path.resolve(import.meta.dirname, "../../..");
  const modelsDir = path.join(root, "providers/quicksilverpro/models");
  try {
    await mkdir(modelsDir, { recursive: true });
    await copyFile(path.join(repo, "providers/quicksilverpro/provider.toml"), path.join(root, "providers/quicksilverpro/provider.toml"));
    for (const [id, lab] of [["gpt-5.6-sol", "openai"], ["kimi-k3.1-pro", "moonshotai"], ["glm-5.3", "zhipuai"], ["qwen3.8-max", "alibaba"]]) {
      await mkdir(path.join(root, "models", lab), { recursive: true });
      await copyFile(path.join(repo, `models/${lab}/${id}.toml`), path.join(root, `models/${lab}/${id}.toml`));
      await copyFile(path.join(repo, `providers/quicksilverpro/models/${id}.toml`), path.join(modelsDir, `${id}.toml`));
    }
    const kimiBefore = await readFile(path.join(modelsDir, "kimi-k3.1-pro.toml"), "utf8");
    const provider = { ...quicksilverpro, modelsDir, async fetchModels() {
      // Kimi's absence is not proof of retirement; it must remain byte-for-byte.
      return response([model({ input_per_1m: 1.7 }), model({ id: "unknown-new-route" }),
        model({ id: "glm-5.3" }), model({ id: "qwen3.8-max" })]);
    } };
    const first = await syncProvider(provider, { openIssues: false });
    expect(first.created).toBe(0);
    expect(first.deleted).toBe(0);
    expect(first.updated).toBe(3);
    const gpt = await readFile(path.join(modelsDir, "gpt-5.6-sol.toml"), "utf8");
    expect(gpt).toContain("# Output inherits the lab cap");
    const parsed = Bun.TOML.parse(gpt) as any;
    expect(parsed.base_model).toBe("openai/gpt-5.6-sol");
    expect(parsed.limit.output).toBeUndefined();
    expect(parsed.modalities).toEqual({ input: ["text"], output: ["text"] });
    expect(parsed.cost.text.input.price).toBe(1.7);
    expect(parsed.capabilities.reasoning.effort).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(await readFile(path.join(modelsDir, "kimi-k3.1-pro.toml"), "utf8")).toBe(kimiBefore);
    for (const id of ["glm-5.3", "qwen3.8-max"]) {
      const synced = Bun.TOML.parse(await readFile(path.join(modelsDir, `${id}.toml`), "utf8")) as any;
      expect(synced.limit?.context).toBeUndefined();
    }
    const second = await syncProvider(provider, { openIssues: false });
    expect(second.updated).toBe(0);
    expect(second.deleted).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner preserves authored cache prices and updates published TTLs independently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modelsdev-quicksilver-cache-"));
  const repo = path.resolve(import.meta.dirname, "../../..");
  const modelsDir = path.join(root, "providers/quicksilverpro/models");
  const id = "claude-opus-5-5";
  try {
    await mkdir(modelsDir, { recursive: true });
    await mkdir(path.join(root, "models/anthropic"), { recursive: true });
    await copyFile(path.join(repo, "providers/quicksilverpro/provider.toml"), path.join(root, "providers/quicksilverpro/provider.toml"));
    await copyFile(path.join(repo, `models/anthropic/${id}.toml`), path.join(root, `models/anthropic/${id}.toml`));
    await copyFile(path.join(repo, `providers/quicksilverpro/models/${id}.toml`), path.join(modelsDir, `${id}.toml`));
    let row = model({ id, input_per_1m: 1, output_per_1m: 5, cached_input_per_1m: 0.05,
      cache_write_per_1m: 1.25, cache_write_1h_per_1m: 2 });
    const provider = { ...quicksilverpro, modelsDir, async fetchModels() { return response([row]); } };
    const cache = async () => (Bun.TOML.parse(await readFile(path.join(modelsDir, `${id}.toml`), "utf8")) as any).cost.text.input.cache;
    expect((await syncProvider(provider, { openIssues: false })).updated).toBe(0);
    expect(await cache()).toEqual({ read: 0.05, write: { "5m": 1.25, "1h": 2 } });
    // A 1h-only change is invisible in v1, but must still update the file.
    row = { ...row, cache_write_1h_per_1m: 3 };
    expect((await syncProvider(provider, { openIssues: false })).updated).toBe(1);
    expect(await cache()).toEqual({ read: 0.05, write: { "5m": 1.25, "1h": 3 } });
    row = { ...row, cached_input_per_1m: 0.08, cache_write_per_1m: 1.5, cache_write_1h_per_1m: 2.75 };
    await syncProvider(provider, { openIssues: false });
    expect(await cache()).toEqual({ read: 0.08, write: { "5m": 1.5, "1h": 2.75 } });
    // A partial feed must not scale the unreported TTL with the 5m price.
    row = { ...row, cache_write_per_1m: 1.75, cache_write_1h_per_1m: undefined };
    await syncProvider(provider, { openIssues: false });
    expect(await cache()).toEqual({ read: 0.08, write: { "5m": 1.75, "1h": 2.75 } });
    // Exercise the canonical catalog's cache_read spelling as well.
    row = { ...row, cached_input_per_1m: undefined, cache_read_per_1m: 0.09 };
    await syncProvider(provider, { openIssues: false });
    expect(await cache()).toEqual({ read: 0.09, write: { "5m": 1.75, "1h": 2.75 } });
    // Change base prices too, forcing a patch when all cache fields are absent.
    const { cached_input_per_1m, cache_read_per_1m, cache_write_per_1m, cache_write_1h_per_1m, ...withoutCache } = row;
    row = { ...withoutCache, input_per_1m: 1.1, output_per_1m: 5.5 };
    expect((await syncProvider(provider, { openIssues: false })).updated).toBe(1);
    expect(await cache()).toEqual({ read: 0.09, write: { "5m": 1.75, "1h": 2.75 } });
    expect((await syncProvider(provider, { openIssues: false })).updated).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
