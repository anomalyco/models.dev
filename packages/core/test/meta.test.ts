import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { groups, providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import { fetchMetaModels, meta, parseMetaModels } from "../src/sync/providers/meta.js";

// Public docs format; intentionally exclude account-scoped API responses.
const models = `
# Models

| Use case | Model | Input | Output |
| :---- | :---- | :---- | :---- |
| Agentic work | [Muse Spark](https://dev.meta.ai/docs/models#muse-spark) | Text, image | Text |

## Muse Wonder

Muse Wonder takes text, image, video, audio, and PDF input, returns text, has a 1,048,576-token context window.

### Muse Wonder availability

| Variant | Model API (pay-as-you-go) | Muse Code |
| :---- | :---- | :---- |
| Muse Wonder (\`muse-wonder-1.0\`) | Available (Standard mode only) | Pay-as-you-go |
| Muse Wonder Full | Not available | [Power Usage](https://dev.meta.ai/docs/muse-code/subscriptions#power-usage) |

## Muse Spark

Muse Spark comes in two versions. All take text input, return text, and have a 1,048,576-token context window.

### Muse Spark availability

| Version | Model API (pay-as-you-go) | Muse Code |
| :---- | :---- | :---- |
| Muse Spark 1.2 (\`muse-spark-1.2\`) | Standard mode | Pay-as-you-go |
| Muse Spark 1.2 Contributor (\`muse-spark-1.2-contributor\`) | Contributor mode | Pay-as-you-go |

## Muse Image

| Model ID | Input | Output |
| :---- | :---- | :---- |
| \`muse-image-1.0\` | Text, image | Image |
`;

const pricing = `
## Model pricing

### Muse Wonder

| Usage | Standard mode (per 1M tokens) | Contributor mode (per 1M tokens) |
| :---- | :---- | :---- |
| Cached input | $0.20 | Not available |
| Input | $4.00 | Not available |
| Output | $20.00 | Not available |

### Muse Spark

| Usage | Standard mode (per 1M tokens) | Contributor mode (per 1M tokens) |
| :---- | :---- | :---- |
| Cached input | $0.15 | $0.002 |
| Input | $1.25 | $0.10 |
| Output | $4.25 | $0.20 |

### Muse Image

| Usage | Price |
| :---- | :---- |
| Generated image | $0.01 per image |
`;

const source = { models, pricing };

test("Meta sync is registered for direct and hourly runs", () => {
  expect(providers.meta).toBe(meta);
  expect(groups.direct).toContain("meta");
  expect(meta.skipCreates).toBe(true);
  expect(meta.deleteMissing).toBe(false);
});

test("parses documented token-priced models, mode prices in USD/MTok, and context windows", () => {
  expect(parseMetaModels(source)).toEqual([
    { id: "muse-wonder-1.0", context: 1_048_576, cost: { input: 4, output: 20, cache_read: 0.2 } },
    { id: "muse-spark-1.2", context: 1_048_576, cost: { input: 1.25, output: 4.25, cache_read: 0.15 } },
    { id: "muse-spark-1.2-contributor", context: 1_048_576, cost: { input: 0.1, output: 0.2, cache_read: 0.002 } },
  ]);
  expect(parseMetaModels({ ...source, pricing: pricing.replace("$0.002", "$0") })[2]?.cost.cache_read).toBe(0);
  expect(parseMetaModels({ ...source, models: models.replaceAll("1,048,576", "1048576") })[0]?.context).toBe(1_048_576);
  expect(parseMetaModels({
    ...source,
    pricing: pricing
      .replace("### Muse Wonder", "### Muse Wonder {#muse-wonder}")
      .replace("### Muse Spark", "### Muse Spark {#muse-spark}"),
  })).toHaveLength(3);
});

test("rejects incomplete or changed docs rather than guessing prices or limits", () => {
  for (const bad of [
    { ...source, models: "<html>Unavailable</html>" },
    { ...source, pricing: "" },
    { ...source, models: models.replace("1,048,576-token context window", "large context window") },
    { ...source, models: models.replace("have a 1,048,576-token", "have a 0-token") },
    { ...source, models: models.replace("have a 1,048,576-token", "have a 1,04,8576-token") },
    { ...source, models: models.replace("Muse Spark comes in two versions.", "Muse Spark has a 2,000,000-token context window.") },
    { ...source, models: models.replace("| Standard mode |", "| Batch only |") },
    { ...source, models: models.replace("| Contributor mode |", "| Standard mode |") },
    { ...source, models: models.replace("(`muse-spark-1.2`)", "") },
    { ...source, models: models.replace("`muse-spark-1.2`", "`../private`") },
    { ...source, models: models.replace("Contributor (`muse-spark-1.2-contributor`) | Contributor mode", "(`muse-spark-1.2`) | Standard mode") },
    { ...source, models: models.replace("| :---- | :---- | :---- |\n| Muse Spark 1.2", "| broken |\n| Muse Spark 1.2") },
    { ...source, models: models.replace("## Muse Spark", "## Muse Sparkle") },
    { ...source, pricing: pricing.replace("$1.25", "€1.25") },
    { ...source, pricing: pricing.replace("$1.25", "$-1") },
    { ...source, pricing: pricing.replace("| $0.002 |", "| Not available |") },
    { ...source, pricing: pricing.replaceAll("(per 1M tokens)", "(per 1K tokens)") },
    { ...source, pricing: pricing.replace("| Output | $4.25 | $0.20 |", "") },
    { ...source, pricing: pricing.replace("| Output | $4.25 | $0.20 |", "| Output | $4.25 | $0.20 |\n| Input | $2 | $2 |") },
    { ...source, pricing: pricing + pricing.slice(pricing.indexOf("### Muse Spark"), pricing.indexOf("### Muse Image")) },
  ]) {
    expect(() => parseMetaModels(bad)).toThrow();
  }
});

test("updates only authoritative fields without expanding inherited metadata", () => {
  const authored: ExistingModel = {
    base_model: "meta/muse-spark-1.2",
    base_model_omit: ["limit.input"],
    reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }],
    cost: { input: 9, output: 9, cache_read: 9, input_audio: 2, reasoning: 3 },
    status: "beta",
  };
  const existing: ExistingModel = {
    ...authored,
    name: "Muse Spark 1.2",
    reasoning: true,
    limit: { context: 1_048_576, output: 131_072 },
    modalities: { input: ["text", "image", "pdf", "video"], output: ["text"] },
  };
  const model = parseMetaModels(source)[1]!;
  const context = { authored: () => authored, existing: () => existing };
  const translated = meta.translateModel(model, context)!;
  expect(translated.model).toEqual({
    ...authored,
    limit: undefined,
    cost: { input: 1.25, output: 4.25, cache_read: 0.15, input_audio: 2, reasoning: 3 },
  });
  expect(meta.translateModel({ ...model, context: 2_000_000 }, context)?.model.limit).toEqual({ context: 2_000_000 });
  expect(authored.cost?.input).toBe(9);
});

test("unknown documented models are reported, never synthesized", () => {
  const model = parseMetaModels(source)[0]!;
  expect(meta.translateModel(model, { authored: () => undefined, existing: () => undefined })).toBeUndefined();
  expect(meta.sourceID(model)).toBe(model.id);
  expect(meta.skippedNotice([model.id]).join(" ")).toContain(model.id);
});

test("fetches only public docs without credentials and rejects HTTP failures", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    expect(init).toBeUndefined();
    return new Response(url.endsWith("/models.md") ? models : pricing);
  }) as typeof fetch;
  expect(await fetchMetaModels(fetcher)).toEqual(source);
  expect(urls).toEqual(["https://dev.meta.ai/docs/models.md", "https://dev.meta.ai/docs/pricing-rate-limits.md"]);
  const failing = (async () => new Response("Unavailable", { status: 503 })) as typeof fetch;
  await expect(fetchMetaModels(failing)).rejects.toThrow("Meta docs request failed: 503");
});

test("runner preserves inherited controls, retains absent models, and is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-meta-"));
  const modelsDir = path.join(root, "providers", "meta", "models");
  const filename = path.join(modelsDir, "muse-spark-1.2.toml");
  const original = `# Keep this authored source comment.
schema = 2
base_model = "meta/muse-spark-1.2"
base_model_omit = ["limit.input"]

[capabilities]
reasoning = { supported = true, effort = ["minimal", "low", "medium", "high", "xhigh"] }

[cost.text.input]
price = 9
cache = { read = 9 }

[cost.text.output]
price = 9
`;
  const absent = path.join(modelsDir, "muse-spark-1.1.toml");
  try {
    await Bun.write(path.join(root, "models", "meta", "muse-spark-1.2.toml"), `
schema = 2
name = "Muse Spark 1.2"
description = "Test fixture"
open_weights = false
release_date = "2026-01-01"

[modalities]
input = ["text", "image/png", "application/pdf", "video/mp4"]
output = ["text"]

[capabilities]
tools = { supported = true }
reasoning = { supported = true }
temperature = true
top_p = true
top_k = false

[limit]
context = 1048576
input = 1048576
output = 131072
`);
    await Bun.write(filename, original);
    await Bun.write(absent, original);
    const provider = { ...meta, modelsDir, fetchModels: async () => source };
    const dry = await syncProvider(provider, { dryRun: true, openIssues: false });
    expect(dry.updated).toBe(1);
    expect(await Bun.file(filename).text()).toBe(original);
    const first = await syncProvider(provider, { openIssues: false });
    expect(first).toMatchObject({ created: 0, updated: 1, deleted: 0, unchanged: 1 });
    expect(first.notices.join(" ")).toContain("muse-spark-1.2-contributor");
    expect(await Bun.file(absent).text()).toBe(original);
    const text = await Bun.file(filename).text();
    expect(text).toStartWith("# Keep this authored source comment.");
    const result = Bun.TOML.parse(text);
    expect(result.base_model).toBe("meta/muse-spark-1.2");
    expect(result.base_model_omit).toEqual(["limit.input"]);
    expect(result.capabilities).toEqual(Bun.TOML.parse(original).capabilities);
    expect(result.limit).toBeUndefined();
    expect(result.cost).toEqual({ text: { input: { price: 1.25, cache: { read: 0.15 } }, output: { price: 4.25 } } });
    const second = await syncProvider(provider, { openIssues: false });
    expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
    expect(await Bun.file(filename).text()).toBe(text);
    await expect(syncProvider({ ...provider, fetchModels: async () => ({ ...source, pricing: "" }) })).rejects.toThrow();
    expect(await Bun.file(filename).text()).toBe(text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
