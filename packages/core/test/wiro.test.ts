import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type ExistingModel } from "../src/sync/index.js";
import {
  buildWiroModel,
  factorInForce,
  fetchWiroModels,
  wiro,
  wiroLimit,
  type WiroModel,
  type WiroSourceModel,
} from "../src/sync/providers/wiro.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");

// Monday 02:30 UTC is inside DeepSeek's peak window; 05:00 is between its two parts.
const PEAK = "2026-11-16T02:30:00.000Z";
const OFF_PEAK = "2026-11-16T05:00:00.000Z";

const PEAK_MULTIPLIER = {
  when: {
    utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] },
    any: [
      { all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] },
      { all: [{ utc_hours: { gte: "06:00" } }, { utc_hours: { lt: "10:00" } }] },
    ],
  },
  factor: 2,
};

function row(overrides: Partial<WiroModel> = {}, at = OFF_PEAK): WiroSourceModel {
  return {
    id: "openai/gpt-5-4-mini",
    context_length: 400_000,
    max_tokens: 65_536,
    pricing: { prompt: "0.00000075", completion: "0.0000045" },
    capabilities: { structured_output_modes: ["json_object", "json_schema"] },
    x_wiro: { pricing_tiers: null },
    ...overrides,
    fetched: { from: at, to: at },
  };
}

const gptMini: ExistingModel = {
  base_model: "openai/gpt-5.4-mini",
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  structured_output: true,
  temperature: false,
  limit: { output: 65_536 } as ExistingModel["limit"],
  cost: { input: 0.75, output: 4.5 },
};

test("converts per-token catalog prices to per-1M prices without float noise", () => {
  const built = buildWiroModel(
    row({ pricing: { prompt: "0.000008", completion: "0.00004", input_cache_read: "0.0000002", input_cache_write: "0.00001" } }),
    gptMini,
    undefined,
  ) as Record<string, any>;
  expect(built.cost).toEqual({ input: 8, output: 40, cache_read: 0.2, cache_write: 10 });
  expect(buildWiroModel(row({ pricing: { prompt: "1.5e-7", completion: "6e-7" } }), gptMini, undefined).cost)
    .toEqual({ input: 0.15, output: 0.6 });
});

test("keeps everything the catalog does not own", () => {
  const built = buildWiroModel(row(), gptMini, undefined) as Record<string, any>;
  expect(built).toEqual(gptMini as Record<string, any>);
});

test("turns the later pricing_tiers bands into context tiers", () => {
  const built = buildWiroModel(
    row({
      pricing: { prompt: "0.0000005", completion: "0.000003" },
      x_wiro: {
        pricing_tiers: [
          { maxInputTokens: 128_000, prompt: "0.0000005", completion: "0.000003" },
          { minInputTokensExclusive: 128_000, prompt: "0.000001", completion: "0.000006" },
        ],
      },
    }),
    gptMini,
    undefined,
  ) as Record<string, any>;
  expect(built.cost).toEqual({
    input: 0.5,
    output: 3,
    tiers: [{ tier: { type: "context", size: 128_000 }, input: 1, output: 6 }],
  });
});

test("keeps the file's prices when the bands do not start at the catalog price", () => {
  const notices: string[] = [];
  const built = buildWiroModel(
    row({
      x_wiro: {
        pricing_tiers: [
          { maxInputTokens: 128_000, prompt: "0.000001", completion: "0.000003" },
          { minInputTokensExclusive: 128_000, prompt: "0.000002", completion: "0.000006" },
        ],
      },
    }),
    gptMini,
    undefined,
    notices,
  ) as Record<string, any>;
  expect(built.cost).toEqual(gptMini.cost);
  expect(notices[0]).toContain("pricing_tiers");
});

test("keeps the authored prices of models the catalog does not price per token", () => {
  const grok: ExistingModel = { base_model: "xai/grok-4.5", cost: { input: 2, output: 6, cache_read: 0.2 } };
  expect(buildWiroModel(row({ id: "xai/grok-4-5", pricing: null }), grok, undefined).cost).toEqual(grok.cost);
  const qwen: ExistingModel = { base_model: "alibaba/qwen3-32b", limit: { context: 17_408, output: 4096 } };
  expect(buildWiroModel(row({ id: "qwen/qwen3-32b", pricing: null, context_length: 17_408, max_tokens: 4096 }), qwen, undefined).cost)
    .toBeUndefined();
});

test("divides the catalog's quote by the multipliers in force when it answered", () => {
  const doc = { cost: { multipliers: [PEAK_MULTIPLIER] } };
  const peak = row({ id: "deepseek/v4-1-flash", pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" } }, PEAK);
  const offPeak = row({ id: "deepseek/v4-1-flash", pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003" } });
  const deepseek: ExistingModel = { base_model: "deepseek/deepseek-v4.1-flash-1017", cost: { input: 0.15, output: 0.6, cache_read: 0.003 } };
  expect(buildWiroModel(peak, deepseek, doc).cost).toEqual(deepseek.cost);
  expect(buildWiroModel(offPeak, deepseek, doc).cost).toEqual(deepseek.cost);
});

test("evaluates peak hours, dated changes and request conditions", () => {
  const at = (time: string) => ({ from: time, to: time });
  const peak = { cost: { multipliers: [PEAK_MULTIPLIER] } };
  expect(factorInForce(peak, at(PEAK))).toBe(2);
  expect(factorInForce(peak, at(OFF_PEAK))).toBe(1);
  expect(factorInForce(peak, at("2026-11-16T06:00:00.000Z"))).toBe(2);
  expect(factorInForce(peak, at("2026-11-16T10:00:00.000Z"))).toBe(1);
  expect(factorInForce(peak, at("2026-11-14T02:30:00.000Z"))).toBe(1); // Saturday
  const dated = { cost: { multipliers: [{ when: { date: { gte: "2026-12-01" } }, factor: 2 }] } };
  expect(factorInForce(dated, at("2026-11-30T23:59:00.000Z"))).toBe(1);
  expect(factorInForce(dated, at("2026-12-01T00:00:00.000Z"))).toBe(2);
  // A long-prompt surcharge does not apply to the plain quote.
  const request = { cost: { multipliers: [{ when: { context: { gt: 200_000 } }, factor: 2 }] } };
  expect(factorInForce(request, at(PEAK))).toBe(1);
  expect(factorInForce(undefined, at(PEAK))).toBe(1);
});

test("refuses to guess a factor it can't evaluate or that changed during the request", () => {
  const holiday = { cost: { multipliers: [{ when: { holiday: { equals: "christmas" } }, factor: 2 }] } };
  expect(factorInForce(holiday, { from: PEAK, to: PEAK })).toBeUndefined();
  const peak = { cost: { multipliers: [PEAK_MULTIPLIER] } };
  expect(factorInForce(peak, { from: "2026-11-16T03:59:59.000Z", to: "2026-11-16T04:00:01.000Z" })).toBeUndefined();
  const notices: string[] = [];
  const deepseek: ExistingModel = { base_model: "deepseek/deepseek-v4.1-flash-1017", cost: { input: 0.15, output: 0.6 } };
  const straddling = { ...row({ id: "deepseek/v4-1-flash" }), fetched: { from: "2026-11-16T03:59:59.000Z", to: "2026-11-16T04:00:01.000Z" } };
  expect(buildWiroModel(straddling, deepseek, peak, notices).cost).toEqual(deepseek.cost);
  expect(notices[0]).toContain("deepseek/v4-1-flash");
});

test("publishes catalog limits up to the lab's and inherits equal ones", () => {
  const lab = { context: 400_000, input: 272_000, output: 128_000 };
  expect(wiroLimit(row(), { output: 65_536 }, lab)).toEqual({ output: 65_536 });
  expect(wiroLimit(row({ max_tokens: 128_000 }), { output: 65_536 }, lab)).toBeUndefined();
  expect(wiroLimit(row({ context_length: 17_408, max_tokens: 4096 }), undefined, { context: 131_072, output: 16_384 }))
    .toEqual({ context: 17_408, output: 4096 });
  expect(wiroLimit(row({ context_length: 17_408, max_tokens: null }), undefined, undefined)).toEqual({ context: 17_408 });
});

test("publishes a limit above the lab's only when the file already states it", () => {
  const lab = { context: 1_000_000, output: 30_000 };
  // Nothing checked by hand: the lab's limits stay.
  expect(wiroLimit(row({ context_length: 2_000_000, max_tokens: 65_536 }), undefined, lab)).toBeUndefined();
  // A hand-checked value above the lab stays, and the catalog can still lower it.
  expect(wiroLimit(row({ context_length: 1_048_576, max_tokens: 30_000 }), { context: 1_048_576 }, lab)).toEqual({ context: 1_048_576 });
  expect(wiroLimit(row({ context_length: 2_000_000, max_tokens: 30_000 }), { context: 1_048_576 }, lab)).toEqual({ context: 1_048_576 });
  expect(wiroLimit(row({ context_length: 1_024_000, max_tokens: 30_000 }), { context: 1_048_576 }, lab)).toEqual({ context: 1_024_000 });
});

test("counts JSON schema output as structured output, not JSON mode alone", () => {
  const plain: ExistingModel = { base_model: "alibaba/qwen3-32b" };
  const jsonMode = row({ id: "qwen/qwen3-32b", pricing: null, capabilities: { structured_output_modes: ["json_object"] } });
  expect((buildWiroModel(jsonMode, plain, undefined) as Record<string, any>).structured_output).toBeUndefined();
  const schema = row({ capabilities: { structured_output_modes: ["json_schema"] } });
  expect((buildWiroModel(schema, plain, undefined) as Record<string, any>).structured_output).toBe(true);
  const dropped = row({ capabilities: { structured_output_modes: ["json_object"] } });
  expect((buildWiroModel(dropped, gptMini, undefined) as Record<string, any>).structured_output).toBe(false);
});

test("reports catalog models without a file instead of creating them", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  expect(wiro.translateModel(row({ id: "moonshot/kimi-k3-1-pro" }), context)).toBeUndefined();
  expect(wiro.sourceID(row({ id: "moonshot/kimi-k3-1-pro" }))).toBe("moonshot/kimi-k3-1-pro");
});

test("marks implicit caching when the catalog starts quoting a cache price", () => {
  const context = { existing: () => gptMini, authored: () => gptMini, v2: () => ({}) };
  const cached = wiro.translateModel(row({ pricing: { prompt: "0.00000075", completion: "0.0000045", input_cache_read: "0.000000075" } }), context);
  const setCache = (cached as { v2Set?: Record<string, (current: unknown) => unknown> }).v2Set?.["capabilities.cache"];
  expect(setCache?.(undefined)).toEqual({ implicit: true });
  expect(setCache?.({ implicit: { ttl: "5m" } })).toEqual({ implicit: { ttl: "5m" } });
  expect((wiro.translateModel(row(), context) as { v2Set?: unknown }).v2Set).toBeUndefined();
});

test("refuses short, partial and duplicated catalogs", () => {
  const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ ...row({ id: `lab/model-${index}` }), fetched: undefined }));
  const fetched = { from: OFF_PEAK, to: OFF_PEAK };
  expect(() => wiro.parseModels({ data: rows(19), fetched })).toThrow("fewer than 20");
  expect(() => wiro.parseModels({ data: rows(20), total_count: 21, fetched })).toThrow("partial catalog");
  expect(() => wiro.parseModels({ data: [...rows(20), rows(1)[0]], fetched })).toThrow("duplicate");
  expect(wiro.parseModels({ data: rows(20), total_count: 20, fetched })[0]?.fetched).toEqual(fetched);
});

test("fetches with the API key and follows the next page on the same host", async () => {
  const requests: Array<{ url: string; auth?: string }> = [];
  const pages: Record<string, unknown> = {
    "https://llm.wiro.ai/v1/models": { data: [row({ id: "a/one" })], has_more: true, links: { next: "/v1/models?after=a/one" }, total_count: 2 },
    "https://llm.wiro.ai/v1/models?after=a/one": { data: [row({ id: "b/two" })], has_more: false, links: { next: null } },
  };
  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization });
    return new Response(JSON.stringify(pages[url]));
  }) as unknown as typeof fetch;
  const catalog = await fetchWiroModels(fetcher, "test-key");
  expect(catalog.data.map((model) => model.id)).toEqual(["a/one", "b/two"]);
  expect(catalog.total_count).toBe(2);
  expect(requests).toEqual([
    { url: "https://llm.wiro.ai/v1/models", auth: "Bearer test-key" },
    { url: "https://llm.wiro.ai/v1/models?after=a/one", auth: "Bearer test-key" },
  ]);

  const offHost = (async () => new Response(JSON.stringify({ data: [], has_more: true, links: { next: "https://example.com/v1/models" } }))) as unknown as typeof fetch;
  await expect(fetchWiroModels(offHost, "test-key")).rejects.toThrow("another host");
});

test("names the missing key when the catalog refuses an anonymous request", async () => {
  const fetcher = (async (_url: string, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>)?.Authorization).toBeUndefined();
    return new Response("{}", { status: 401, statusText: "Unauthorized" });
  }) as unknown as typeof fetch;
  await expect(fetchWiroModels(fetcher, undefined)).rejects.toThrow("WIRO_API_KEY");
  const down = (async () => new Response("", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;
  await expect(fetchWiroModels(down, "test-key")).rejects.toThrow("503");
});

test("sync keeps base rates at peak, updates changed prices and removes models the catalog dropped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-wiro-"));
  const modelsDir = path.join(dir, "providers", "wiro", "models");
  const labs = ["deepseek/deepseek-v4.1-flash-1017", "openai/gpt-5.4-mini", "zhipuai/glm-5.2"];
  for (const lab of labs) {
    await mkdir(path.join(dir, "models", path.dirname(lab)), { recursive: true });
    await copyFile(path.join(ROOT, "models", `${lab}.toml`), path.join(dir, "models", `${lab}.toml`));
  }
  const deepseek = path.join(modelsDir, "deepseek", "v4-1-flash.toml");
  const mini = path.join(modelsDir, "openai", "gpt-5-4-mini.toml");
  const retired = path.join(modelsDir, "glm", "5-2.toml");
  await mkdir(path.dirname(deepseek), { recursive: true });
  await mkdir(path.dirname(mini), { recursive: true });
  await mkdir(path.dirname(retired), { recursive: true });
  const deepseekText = [
    "# Prices: base rates are off-peak; peak hours cost twice as much.",
    "schema = 2",
    'base_model = "deepseek/deepseek-v4.1-flash-1017"',
    "",
    "[capabilities]",
    'reasoning = { supported = true, toggle = true, effort = ["minimal", "low", "medium", "high"] }',
    "cache = { implicit = true }",
    "",
    "[cost.text.input]",
    "price = 0.15",
    "cache = { read = 0.003 }",
    "",
    "[cost.text.output]",
    "price = 0.6",
    "",
    "[[cost.multipliers]]",
    'when = { utc_days = { in = ["mon", "tue", "wed", "thu", "fri"] }, any = [{ all = [{ utc_hours = { gte = "01:00" } }, { utc_hours = { lt = "04:00" } }] }, { all = [{ utc_hours = { gte = "06:00" } }, { utc_hours = { lt = "10:00" } }] }] }',
    "factor = 2",
    "",
  ].join("\n");
  await Bun.write(deepseek, deepseekText);
  await Bun.write(mini, [
    "# Source: https://llm.wiro.ai/v1/models",
    "schema = 2",
    'base_model = "openai/gpt-5.4-mini"',
    "",
    "[capabilities]",
    'reasoning = { supported = true, effort = ["none", "low", "medium", "high", "xhigh"] }',
    "",
    "[limit]",
    "output = 65_536",
    "",
    "[cost.text.input]",
    "price = 0.75",
    "",
    "[cost.text.output]",
    "price = 4.5",
    "",
  ].join("\n"));
  await Bun.write(retired, [
    "schema = 2",
    'base_model = "zhipuai/glm-5.2"',
    "",
    "[capabilities]",
    "reasoning = { supported = true, toggle = true }",
    "",
    "[cost.text.input]",
    "price = 0.6",
    "",
    "[cost.text.output]",
    "price = 2.2",
    "",
  ].join("\n"));

  // DeepSeek is quoted at its peak rate; GPT-5.4 mini got cheaper; GLM-5.2 is
  // gone; the other rows have no file.
  const catalog = [
    row({ id: "deepseek/v4-1-flash", context_length: 1_000_000, max_tokens: 384_000, pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" }, capabilities: {} }),
    row({ pricing: { prompt: "0.0000007", completion: "0.0000042" }, capabilities: {} }),
    ...Array.from({ length: 18 }, (_, index) => row({ id: `lab/new-${index}` })),
  ].map(({ fetched: _fetched, ...model }) => model);

  try {
    const result = await syncProvider({
      ...wiro,
      modelsDir,
      async fetchModels() {
        return { data: catalog, total_count: catalog.length, fetched: { from: PEAK, to: PEAK } };
      },
    });

    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 1 });
    expect(await readFile(deepseek, "utf8")).toBe(deepseekText);
    const updated = await readFile(mini, "utf8");
    expect(updated.startsWith("# Source: https://llm.wiro.ai/v1/models\n")).toBe(true);
    expect(updated).toContain("price = 0.7\n");
    expect(updated).toContain("price = 4.2\n");
    expect(updated).toContain("output = 65_536");
    expect(existsSync(retired)).toBe(false);
    expect(existsSync(path.join(modelsDir, "lab"))).toBe(false);
    expect(result.notices.join("\n")).toContain("`lab/new-0`");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
