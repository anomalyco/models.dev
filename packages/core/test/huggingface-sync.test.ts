import { expect, test } from "bun:test";

import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type ExistingModel } from "../src/sync/index.js";
import {
  aggregateProviders,
  huggingface,
  refreshHuggingFaceModel,
  syncedHeader,
  type HuggingFaceModel,
  type HuggingFaceProvider,
} from "../src/sync/providers/huggingface.js";

const SYNCED =
  "# Price and context: synced from https://router.huggingface.co/v1/models (cheapest live provider's price, largest live context).";

function provider(overrides: Partial<HuggingFaceProvider>): HuggingFaceProvider {
  return { provider: "p", status: "live", context_length: 131_072, pricing: { input: 1, output: 1 }, throughput: 50, ...overrides };
}

function routerModel(providers: HuggingFaceProvider[], id = "Qwen/Qwen3.5-122B-A10B"): HuggingFaceModel {
  return { id, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, providers };
}

test("price is the cheapest live provider's and context the largest live one, like OpenRouter's model-level values", () => {
  const aggregate = aggregateProviders(routerModel([
    provider({ provider: "fast", pricing: { input: 0.4, output: 3.2 }, throughput: 90, context_length: 131_072 }),
    provider({ provider: "cheap", pricing: { input: 0.3, output: 2 }, throughput: 10, context_length: 65_536 }),
    provider({ provider: "wide", pricing: { input: 0.5, output: 4 }, context_length: 262_144 }),
    // Not live: neither its price nor its context counts.
    provider({ provider: "down", status: "staging", pricing: { input: 0.01, output: 0.01 }, context_length: 1_000_000 }),
  ]));
  expect(aggregate.cost).toEqual({ input: 0.3, output: 2 });
  expect(aggregate.context).toBe(262_144);
});

test("ties on price go to the faster provider, then the provider id", () => {
  const same = { pricing: { input: 0.2, output: 0.8 } };
  expect(aggregateProviders(routerModel([
    provider({ ...same, provider: "a", throughput: 10, context_length: 1 }),
    provider({ ...same, provider: "b", throughput: 20, pricing: { input: 0.1, output: 0.9 } }),
  ])).cost).toEqual({ input: 0.1, output: 0.9 });
  expect(aggregateProviders(routerModel([
    provider({ ...same, provider: "b", throughput: undefined }),
    provider({ provider: "a", throughput: undefined, pricing: { input: 0.3, output: 0.7 } }),
  ])).cost).toEqual({ input: 0.3, output: 0.7 });
  expect(aggregateProviders(routerModel([provider({ pricing: undefined })])).cost).toBeUndefined();
});

test("models without a live provider are left alone", () => {
  expect(huggingface.translateModel(routerModel([]), { existing: () => undefined, authored: () => undefined })).toBeUndefined();
});

test("the synced header line replaces earlier router price lines in place and is stable", () => {
  const header = [
    "# Effort: reasoning_effort = low|high",
    "# Price: https://router.huggingface.co/v1/models (2026-11-24). The highest-throughput live provider (groq) lists no price, so this is the",
    "#   fastest priced one (amazon-bedrock).",
    "# max_tokens_field: documented",
    "",
  ].join("\n");
  const synced = syncedHeader(header, true);
  expect(synced).toBe(`# Effort: reasoning_effort = low|high\n${SYNCED}\n# max_tokens_field: documented\n`);
  expect(syncedHeader(synced, true)).toBe(synced);

  // Created by an earlier sync: the note stays on its own line.
  const created = syncedHeader("# Created by the Hugging Face sync. Price and context: https://router.huggingface.co/v1/models (2026-11-24), highest-throughput live provider (mancer).\n", true);
  expect(created).toBe(`# Created by the Hugging Face sync.\n${SYNCED}\n`);
  expect(syncedHeader(created, true)).toBe(created);

  // No router line yet: appended. No priced provider: the line says the price was kept.
  expect(syncedHeader("# Lab identity: x\n", true)).toBe(`# Lab identity: x\n${SYNCED}\n`);
  expect(syncedHeader("", false)).toContain("price kept, no live provider lists one");
});

test("existing files take the router's price and context and keep the rest", () => {
  const existing = {
    base_model: "alibaba/qwen3.5-122b-a10b",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    cost: { input: 9, output: 9, cache_read: 0.5 },
    limit: { context: 262_144, output: 65_536 },
  } as ExistingModel;
  const refreshed = refreshHuggingFaceModel("Qwen/Qwen3.5-122B-A10B", existing, { base_model: existing.base_model } as ExistingModel, {
    cost: { input: 0.3, output: 2 },
    context: 131_072,
    tools: true,
    structuredOutput: true,
  });
  expect(refreshed).toMatchObject({
    base_model: "alibaba/qwen3.5-122b-a10b",
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    cost: { input: 0.3, output: 2, cache_read: 0.5 },
    limit: { context: 131_072 },
  });
});

test("an output cap set at the old context follows the new context; a hand-set cap stays", () => {
  const aggregate = (context: number) => ({ cost: { input: 1, output: 1 }, context, tools: false, structuredOutput: false });
  // The lab (meta/llama-3.2-3b-instruct) outputs more than 80,000.
  const capped = { base_model: "meta/llama-3.2-3b-instruct", limit: { context: 80_000, output: 80_000 } } as ExistingModel;
  expect(refreshHuggingFaceModel("m", capped, capped, aggregate(60_000)).limit).toMatchObject({ context: 60_000, output: 60_000 });

  const own = { base_model: "alibaba/qwen3.5-122b-a10b", limit: { context: 131_072, output: 16_384 } } as ExistingModel;
  expect(refreshHuggingFaceModel("m", own, own, aggregate(262_144)).limit).toMatchObject({ output: 16_384 });
  expect(refreshHuggingFaceModel("m", own, own, aggregate(8_192)).limit).toMatchObject({ context: 8_192, output: 8_192 });
});

test("a context below the lab's drops the lab's input limit so it can't exceed the context", () => {
  const aggregate = (context: number) => ({ cost: { input: 1, output: 1 }, context, tools: false, structuredOutput: false });
  // tencent/hy4: context 1,048,576, input 983,040, output 65,536. The resolved file carries the lab's input.
  const hy4 = { base_model: "tencent/hy4", limit: { context: 1_048_576, input: 983_040, output: 65_536 } } as ExistingModel;
  const shrunk = refreshHuggingFaceModel("tencent/Hy4", hy4, { base_model: "tencent/hy4" } as ExistingModel, aggregate(262_144));
  expect(shrunk).toMatchObject({ base_model_omit: ["limit.input"], limit: { context: 262_144 } });
  expect(shrunk.limit).not.toHaveProperty("input");
  // Back at the lab's context: inherited again, nothing omitted.
  const same = refreshHuggingFaceModel("tencent/Hy4", hy4, { base_model: "tencent/hy4" } as ExistingModel, aggregate(1_048_576));
  expect(same.base_model_omit).toEqual([]);
  expect(same.limit).toBeUndefined();
  // Also after an earlier run omitted it; other omitted keys stay.
  const omitted = { ...hy4, base_model_omit: ["limit.input", "cost.reasoning"], limit: { context: 262_144, output: 65_536 } } as ExistingModel;
  expect(refreshHuggingFaceModel("tencent/Hy4", omitted, omitted, aggregate(1_048_576)).base_model_omit)
    .toEqual(["cost.reasoning"]);
  // A file's own input stays, capped at the context.
  const own = { base_model: "tencent/hy4", limit: { input: 500_000 } } as ExistingModel;
  expect(refreshHuggingFaceModel("tencent/Hy4", hy4, own, aggregate(262_144)).limit).toMatchObject({ context: 262_144, input: 262_144 });
});

test("a sync run removes an input omit once the context matches the lab's again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-huggingface-omit-"));
  try {
    const modelsDir = path.join(root, "providers", "huggingface", "models");
    const file = path.join(modelsDir, "tencent", "Hy4.toml");
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.join(root, "models", "tencent"), { recursive: true });
    await copyFile(path.join(import.meta.dirname, "..", "..", "..", "providers", "huggingface", "provider.toml"), path.join(root, "providers", "huggingface", "provider.toml"));
    await copyFile(path.join(import.meta.dirname, "..", "..", "..", "models", "tencent", "hy4.toml"), path.join(root, "models", "tencent", "hy4.toml"));
    await Bun.write(file, `${SYNCED}
schema = 2
base_model = "tencent/hy4"
base_model_omit = ["limit.input"]

[limit]
context = 262_144

[api.chat-completions]
compatibility = { max_tokens_field = "max_tokens" }

[api.responses]
sdk = { aisdk = "@ai-sdk/openai", opencodeai = "@opencode/ai/providers/openai-compatible/responses" }

[cost.text.input]
price = 1

[cost.text.output]
price = 1
`);
    const source = { data: [routerModel([provider({ pricing: { input: 1, output: 1 }, context_length: 1_048_576 })], "tencent/Hy4")] };
    const host = { ...huggingface, modelsDir, fetchModels: async () => source };
    await syncProvider(host, { openIssues: false });
    const written = await readFile(file, "utf8");
    expect(written).not.toContain("base_model_omit");
    expect(written).not.toContain("[limit]");
    expect((await syncProvider(host, { openIssues: false, dryRun: true })).updated).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const LAB = "alibaba/qwen3.5-122b-a10b";
const EXISTING = `# Effort: reasoning_effort = low|high, as on the lab's API.
# Price and context: https://router.huggingface.co/v1/models (2026-11-24), highest-throughput live provider (fast).
schema = 2
base_model = "${LAB}"

[modalities]
input = ["text", "image/png"]
output = ["text"]

[capabilities]
reasoning = { supported = true, effort = ["low", "high"] }

[limit]
context = 131_072

[api.chat-completions]
compatibility = { reasoning_field = "reasoning_content", max_tokens_field = "max_tokens" }

[api.responses]
sdk = { aisdk = "@ai-sdk/openai", opencodeai = "@opencode/ai/providers/openai-compatible/responses" }

[cost.text.input]
price = 0.4
cache = { read = 0.1 }

[cost.text.output]
price = 3.2
`;

test("a sync run refreshes an existing file's price and context, then finds nothing to change", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-huggingface-"));
  try {
    const modelsDir = path.join(root, "providers", "huggingface", "models");
    const file = path.join(modelsDir, "Qwen", "Qwen3.5-122B-A10B.toml");
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.join(root, "models", "alibaba"), { recursive: true });
    await copyFile(path.join(import.meta.dirname, "..", "..", "..", "providers", "huggingface", "provider.toml"), path.join(root, "providers", "huggingface", "provider.toml"));
    await copyFile(path.join(import.meta.dirname, "..", "..", "..", "models", `${LAB}.toml`), path.join(root, "models", `${LAB}.toml`));
    await Bun.write(file, EXISTING);
    const source = {
      data: [routerModel([
        provider({ provider: "fast", pricing: { input: 0.4, output: 3.2 }, throughput: 90, context_length: 131_072 }),
        provider({ provider: "cheap", pricing: { input: 0.25, output: 1.5 }, throughput: 10, context_length: 196_608 }),
      ])],
    };
    const host = { ...huggingface, modelsDir, fetchModels: async () => source };

    const first = await syncProvider(host, { openIssues: false });
    expect(first.updated).toBe(1);
    const written = await readFile(file, "utf8");
    expect(written).toBe(EXISTING
      .replace(/^# Price and context: .*$/m, SYNCED)
      .replace("context = 131_072", "context = 196_608")
      .replace("price = 0.4", "price = 0.25")
      .replace("price = 3.2", "price = 1.5"));

    const second = await syncProvider(host, { openIssues: false, dryRun: true });
    expect(second.updated).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
