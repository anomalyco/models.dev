import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateV2 } from "../src/generate-v2.js";
import { formatModelV2, patchModelV2 } from "../src/model-file-v2.js";
import { CostV2, CostWhenV2, type OutputCostV2 } from "../src/schema-v2.js";
import type { Model } from "../src/schema.js";
import { modelV2ToV1 } from "../src/translate.js";

const root = path.join(import.meta.dirname, "../../..");
const fixture = mkdtempSync(path.join(tmpdir(), "models-dev-decision-pricing-"));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));
const modelFile = "providers/openai/models/gpt-6-luna.toml";
for (const file of [modelFile, "providers/openai/provider.toml", "models/openai/gpt-6-luna.toml"]) {
  mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  copyFileSync(path.join(root, file), path.join(fixture, file));
}
const raw = Bun.TOML.parse(readFileSync(path.join(fixture, modelFile), "utf8")) as Record<string, any>;
const model = (await generateV2(path.join(fixture, "providers"))).openai!.models["gpt-6-luna"]!;

test("API cost conditions accept one protocol or a set of protocols", () => {
  const conditions: NonNullable<CostWhenV2["api"]>[] = [{ equals: "decisions" }, { in: ["responses", "chat-completions"] }];
  for (const api of conditions) {
    expect(CostWhenV2.parse({ api })).toEqual({ api });
  }
});

test("API cost conditions compose with context and other conditions", () => {
  const when: CostWhenV2 = { all: [{ api: { in: ["responses", "decisions"] } }, { context: { gt: 272_000 } }] };
  expect(CostWhenV2.parse(when)).toEqual(when);
  expect(CostV2.parse({ multipliers: [{ when, factor: { text: 2 } }] }).multipliers![0]!.when).toEqual(when);
});

test.each([
  { equals: "decision" },
  { equals: "/v1/decisions" },
  { equals: "https://api.openai.com/v1/decisions" },
  { equals: 1 },
  { in: ["responses", "unknown"] },
  { gt: "decisions" },
  { equals: "decisions", in: ["decisions"] },
])("API cost conditions reject invalid protocol choices: %j", (api) => {
  expect(CostWhenV2.safeParse({ api }).success).toBe(false);
  expect(CostWhenV2.safeParse({ all: [{ api }] }).success).toBe(false);
});

// The catalog publishes declarative prices, not an evaluator. Exercise the actual
// Luna output rules using their documented ordered-merge semantics. Fail on a new
// condition/operator so this oracle cannot silently ignore a future pricing rule.
function outputPrice(cost: OutputCostV2, api: string | undefined, context: number): number {
  let price = cost.price;
  for (const override of cost.overrides ?? []) {
    const matches = Object.entries(override.when).every(([key, condition]) => {
      if (key === "api" && condition && "equals" in condition) return api !== undefined && api === condition.equals;
      if (key === "context" && condition && "gt" in condition && typeof condition.gt === "number") return context > condition.gt;
      throw new Error(`Unhandled Luna pricing condition: ${key}`);
    });
    if (matches && override.price !== undefined) price = override.price;
  }
  return price;
}

test.each([0, 272_000, 272_001, 922_000])("Luna keeps generation prices and free Decisions output at %i input tokens", (context) => {
  const output = model.cost!.text!.output!;
  expect(outputPrice(output, "decisions", context)).toBe(0);
  for (const api of [undefined, "responses", "chat-completions"]) {
    expect(outputPrice(output, api, context)).toBe(context > 272_000 ? 0.75 : 0.5);
  }
});

test("v2 publishes the Decisions output rule after context pricing without changing input or caches", () => {
  expect(model.api.decisions).toBeDefined();
  expect(model.cost!.text!.output!.overrides!.at(-1)).toEqual({ when: { api: { equals: "decisions" } }, price: 0 });
  expect(model.cost!.text!.input).toEqual({
    price: 0.1,
    cache: { read: 0.01, write: 0.125 },
    overrides: [{ when: { context: { gt: 272_000 } }, price: 0.2, cache: { read: 0.02, write: 0.25 } }],
  });
});

test("API pricing leaves every v1 Luna field and generation tier unchanged", () => {
  const generationOnly = structuredClone(raw);
  generationOnly.cost.text.output.overrides = generationOnly.cost.text.output.overrides.filter((rule: any) => !rule.when.api);
  const current = modelV2ToV1({ ...raw, id: "gpt-6-luna" }, {}, "@ai-sdk/openai");
  expect(current).toEqual(modelV2ToV1({ ...generationOnly, id: "gpt-6-luna" }, {}, "@ai-sdk/openai"));
  expect(current.cost).toMatchObject({ input: 0.1, output: 0.5, tiers: [{ tier: { type: "context", size: 272_000 }, input: 0.2, output: 0.75 }] });
});

test("sync and TOML formatting preserve the Decisions rule after updated generation tiers", () => {
  const before = modelV2ToV1({ ...raw, id: "gpt-6-luna" }, {}, "@ai-sdk/openai");
  const costV1 = structuredClone(before.cost) as NonNullable<Model["cost"]>;
  costV1.output = 0.6;
  costV1.tiers![0]!.output = 0.9;
  const after = { ...before, cost: costV1 };
  const patched = patchModelV2(raw, before, after);
  const roundtrip = Bun.TOML.parse(formatModelV2(patched)) as Record<string, any>;
  expect(roundtrip.api).toEqual(raw.api);
  const cost = CostV2.parse(roundtrip.cost);
  for (const context of [272_000, 272_001]) {
    expect(outputPrice(cost.text!.output!, "decisions", context)).toBe(0);
    expect(outputPrice(cost.text!.output!, "responses", context)).toBe(context > 272_000 ? 0.9 : 0.6);
  }
  expect(modelV2ToV1({ ...roundtrip, id: "gpt-6-luna" }, {}, "@ai-sdk/openai")).toEqual(after);
});
