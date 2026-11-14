// First-party lab modules with no old-sync counterpart: their recorded sources
// (test/fixtures/sync2/<id>.json) and the ways they fail closed.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { plan } from "../src/sync2/engine.js";
import { alibaba } from "../src/sync2/providers/alibaba.js";
import { deepseek, parseDeepSeekPricing } from "../src/sync2/providers/deepseek.js";
import { moonshotai, parseMoonshotPricing } from "../src/sync2/providers/moonshotai.js";
import type { Observation } from "../src/sync2/types.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "sync2");
const fixture = (id: string) => Bun.file(path.join(FIXTURES, `${id}.json`)).json();

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function catalog(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "sync2-labs-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) await Bun.write(path.join(root, file), content);
  return root;
}

const read = (root: string, file: string) => Bun.file(path.join(root, file)).text();
const byID = (observations: Observation[]) => new Map(observations.map((item) => [item.id, item]));

const lab = (input = `["text"]`) => `schema = 2
name = "Example"
description = "Example model"
open_weights = true
release_date = "2026-01-01"

[modalities]
input = ${input}
output = ["text"]

[capabilities]
tools = { supported = true }
reasoning = { supported = true }
temperature = true
top_p = true
top_k = false

[limit]
context = 1_000_000
output = 64_000
`;

test("deepseek: off-peak prices from the pricing table, efforts and limits from /models, legacy names follow their model", async () => {
  const observations = byID(deepseek.observe(await fixture("deepseek")));
  expect(observations.get("deepseek-v4-pro")).toEqual({
    id: "deepseek-v4-pro",
    limit: { context: 1_048_576, output: 393_216 },
    modalities: { input: ["text"] },
    capabilities: { reasoning: { effort: ["low", "high", "max"], default: { type: "effort", value: "high" } } },
    cost: { text: { input: { price: 0.66, cache: { read: 0.022 } }, output: { price: 1.98, reasoning: 1.98 } } },
  });
  expect(observations.get("deepseek-flash")?.cost?.text?.input?.price).toBe(0.15);
  for (const alias of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    expect(observations.get(alias)).toEqual({ ...observations.get("deepseek-flash")!, id: alias, updateOnly: true });
  }
});

test("deepseek: the pricing parser fails closed on a changed table or a peak price that isn't 2x", async () => {
  const { pricing } = await fixture("deepseek");
  expect(parseDeepSeekPricing(pricing).prices.size).toBe(2);
  expect(() => parseDeepSeekPricing(pricing.replace("| $1.32 ", "| $1.50 "))).toThrow("isn't twice off-peak");
  expect(() => parseDeepSeekPricing(pricing.replace("1M OUTPUT TOKENS", "1M OUTPUT TOKENS (CHANGED)"))).toThrow("expected one 1M OUTPUT TOKENS");
  expect(() => parseDeepSeekPricing(pricing.replace("| $0.66 ", "| ¥0.66 "))).toThrow("isn't a dollar price");
  expect(() => parseDeepSeekPricing("# Models & Pricing\n")).toThrow("no model table");
});

test("deepseek: updates a file, deprecates one /models drops, and a new model is a gap", async () => {
  const raw = await fixture("deepseek");
  raw.models.data[1] = { ...raw.models.data[1], id: "deepseek-v5" };
  const root = await catalog({
    "providers/deepseek/provider.toml": `name = "DeepSeek"\nnpm = "@ai-sdk/openai-compatible"\napi = "https://api.deepseek.com"\n`,
    "models/deepseek/flash.toml": lab(`["text", "image/png"]`),
    "models/deepseek/pro.toml": lab(),
    "providers/deepseek/models/deepseek-flash.toml": `# Hand-written
schema = 2
base_model = "deepseek/flash"

[capabilities]
reasoning = { supported = true, default = { type = "effort", value = "high" }, toggle = true, effort = ["low", "high", "max"] }

[limit]
context = 1_048_576
output = 393_216

[cost.text.input]
price = 0.14
cache = { read = 0.003 }

[cost.text.output]
price = 0.6
reasoning = 0.6
`,
    "providers/deepseek/models/deepseek-v4-pro.toml": `schema = 2
base_model = "deepseek/pro"

[capabilities]
reasoning = { supported = true, toggle = true, effort = ["low", "high", "max"] }

[cost.text.input]
price = 0.66

[cost.text.output]
price = 1.98
`,
  });
  const { result } = await plan(deepseek, { root, raw });
  expect(result.changes.map((change) => [change.kind, change.model])).toEqual([["update", "deepseek-flash"], ["deprecate", "deepseek-v4-pro"]]);
  expect(result.changes[0]!.fields).toEqual([{ path: "cost.text.input.price", before: 0.14, after: 0.15 }]);
  expect(result.gaps.map((gap) => [gap.kind, gap.model])).toEqual([["new", "deepseek-v5"]]);
});

test("moonshotai: prices per TTL from the compiled pricing tables, efforts only where /models lists them", async () => {
  const observations = byID(moonshotai.observe(await fixture("moonshotai")));
  expect(observations.get("kimi-k3")).toEqual({
    id: "kimi-k3",
    limit: { context: 1_048_576 },
    modalities: { input: ["text", "image", "video"] },
    capabilities: { reasoning: { effort: ["low", "high", "max"], default: { type: "effort", value: "max" } } },
    cost: { text: { input: { price: 3, cache: { read: 0.3, write: { "5m": 3, "1h": 6 } } }, output: { price: 15 } } },
  });
  // K2 has no efforts and no cache write price.
  expect(observations.get("kimi-k2.6")).toEqual({
    id: "kimi-k2.6",
    limit: { context: 262_144 },
    modalities: { input: ["text", "image", "video"] },
    cost: { text: { input: { price: 0.95, cache: { read: 0.16, write: null } }, output: { price: 4 } } },
  });
  // Not on the pricing page yet: no cost, so its file keeps its own.
  expect(observations.get("kimi-k2.8-preview")?.cost).toBeUndefined();
});

test("moonshotai: the pricing parser fails closed on changed columns or cells", async () => {
  const { pricing } = await fixture("moonshotai");
  expect([...parseMoonshotPricing(pricing).keys()].sort()).toEqual(["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]);
  expect(() => parseMoonshotPricing(pricing.replace("{title:`Output`,width:`15%`}", "{title:`Output (CNY)`,width:`15%`}"))).toThrow("unexpected columns");
  expect(() => parseMoonshotPricing(pricing.replace("`$3.00 / MTok`", "`¥3.00 / MTok`"))).toThrow("isn't a dollar price");
  expect(() => parseMoonshotPricing(pricing.replace("`$15.00 / MTok`,", ""))).toThrow("5 columns");
  expect(() => parseMoonshotPricing("<html></html>")).toThrow("no price tables");
});

test("alibaba: context tiers become bands, peak prices need a half-price off-peak, and unmappable prices are left out", async () => {
  const raw = await fixture("alibaba");
  const observations = byID(alibaba.observe(raw));
  expect(observations.get("qwen3.7-plus")).toEqual({
    id: "qwen3.7-plus",
    status: null,
    limit: { context: 1_000_000, output: 131_072 },
    modalities: { input: ["image", "text", "video"], output: ["text"] },
    cost: {
      text: {
        input: {
          price: 0.4,
          cache: { read: 0.08, explicit: { read: 0.04, write: 0.5 } },
          overrides: [{ when: { context: { gt: 256_000 } }, price: 1.2, cache: { read: 0.24, explicit: { read: 0.12, write: 1.5 } } }],
        },
        output: { price: 1.6, reasoning: null, overrides: [{ when: { context: { gt: 256_000 } }, price: 4.8 }] },
      },
    },
  });
  // A separate thinking output price is the reasoning price.
  expect(observations.get("qwen-plus")?.cost?.text?.output).toEqual({
    price: 1.2,
    reasoning: 4,
    overrides: [{ when: { context: { gt: 256_000 } }, price: 3.6, reasoning: 12 }],
  });
  // Peak and off-peak: the peak price, since files hold the off-peak multiplier.
  expect(observations.get("deepseek-v4.1-flash")?.cost?.text?.input).toEqual({ price: 0.3, cache: { read: 0.006, explicit: null }, overrides: null });
  // A retirement date deprecates; omni prices (audio tokens) aren't mapped.
  expect(observations.get("qwen3.5-plus")?.status).toBe("deprecated");
  expect(observations.get("qwen3.8-omni-flash")?.cost).toBeUndefined();
  // Snapshots, namespaced copies and media models only update files that exist.
  for (const id of ["qwen3.7-plus-2026-05-26", "ZHIPU/GLM-5.3", "wan2.7-t2v", "qwen-plus-latest"]) expect(observations.get(id)?.updateOnly).toBe(true);
  expect(observations.get("kimi-k3.1-pro")?.updateOnly).toBeUndefined();

  const flash = raw.models.find((model: any) => model.model === "deepseek-v4.1-flash");
  flash.prices[0].prices.find((price: any) => price.type === "input_token" && price.time_band === "offpeak").price = "0.2";
  expect(byID(alibaba.observe(raw)).get("deepseek-v4.1-flash")?.cost).toBeUndefined();
});

test("alibaba: keeps a file's unrounded price and a spelled-out reasoning price, and doesn't report deprecated files it drops", async () => {
  const raw = { models: (await fixture("alibaba")).models.filter((model: any) => ["qwen-flash", "qwen3.5-plus"].includes(model.model)) };
  const header = `name = "Alibaba"\nnpm = "@ai-sdk/openai-compatible"\napi = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"\n`;
  const root = await catalog({
    "providers/alibaba/provider.toml": header,
    "models/alibaba/qwen-flash.toml": lab(),
    "models/alibaba/qwen3.5-plus.toml": lab(`["text", "image/png", "video/mp4"]`),
    "models/alibaba/qwen-turbo.toml": lab(),
    "models/alibaba/qwen3-max.toml": lab(),
    "providers/alibaba/models/qwen-flash.toml": `schema = 2
base_model = "alibaba/qwen-flash"

[limit]
context = 1_000_000
output = 32_768

[cost.text.input]
price = 0.05
cache = { read = 0.01, explicit = { read = 0.005, write = 0.0625 } }

[[cost.text.input.overrides]]
when = { context = { gt = 256_000 } }
price = 0.25
cache = { read = 0.05, explicit = { read = 0.025, write = 0.3125 } }

[cost.text.output]
price = 0.4

[[cost.text.output.overrides]]
when = { context = { gt = 256_000 } }
price = 2
`,
    "providers/alibaba/models/qwen3.5-plus.toml": `schema = 2
base_model = "alibaba/qwen3.5-plus"

[limit]
context = 1_000_000
output = 65_536

[cost.text.input]
price = 0.4
cache = { explicit = { read = 0.04, write = 0.5 } }

[[cost.text.input.overrides]]
when = { context = { gt = 256_000 } }
price = 0.5
cache = { explicit = { read = 0.05, write = 0.625 } }

[cost.text.output]
price = 2.4
reasoning = 2.4

[[cost.text.output.overrides]]
when = { context = { gt = 256_000 } }
price = 3
`,
    "providers/alibaba/models/qwen-turbo.toml": `schema = 2\nbase_model = "alibaba/qwen-turbo"\nstatus = "deprecated"\n`,
    "providers/alibaba/models/qwen3-max.toml": `schema = 2\nbase_model = "alibaba/qwen3-max"\n`,
  });
  const { result } = await plan(alibaba, { root, raw });
  expect(result.changes.map((change) => [change.model, change.fields.map((field) => field.path)])).toEqual([["qwen3.5-plus", ["status"]]]);
  expect(result.gaps.map((gap) => [gap.kind, gap.model])).toEqual([["removal", "qwen3-max"]]);
});
