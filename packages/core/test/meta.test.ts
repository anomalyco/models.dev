import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { groups, providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import { fetchMetaModels, meta, parseMetaModels } from "../src/sync/providers/meta.js";

// Public docs format; intentionally exclude account-scoped API responses.
const models = `
## Muse Spark {#muse-spark}

| Model ID | Tier | Input modalities | Output modalities | Context window |
| :---- | :---- | :---- | :---- | :---- |
| \`muse-spark-1.2\` | [Standard](/docs/pricing-rate-limits#standard-tier) | Text, image, video, audio, PDF | Text | 1,048,576 tokens |
| \`muse-spark-1.2-contributor\` | [Contributor](/docs/pricing-rate-limits#contributor-tier) | Text, image, video, audio, PDF | Text | 1,048,576 tokens |

## Muse Image

| Model ID | Family | Input | Output |
| :---- | :---- | :---- | :---- |
| \`muse-image-1.0\` | Muse Image | Text, image | Image |
`;

const pricing = `
### Standard tier {#standard-tier}

| Usage | Price per 1M tokens |
| :---- | :---- |
| Cached input | $0.15 |
| Input | $1.25 |
| Output | $4.25 |

### Contributor tier {#contributor-tier}

| Usage | Price per 1M tokens |
| :---- | :---- |
| Cached input | $0.002 |
| Input | $0.10 |
| Output | $0.20 |

### Image generation

Muse Image costs $0.01 per image, not per token.
`;

const source = { models, pricing };

test("Meta sync is registered for direct and hourly runs", () => {
  expect(providers.meta).toBe(meta);
  expect(groups.direct).toContain("meta");
  expect(meta.skipCreates).toBe(true);
  expect(meta.deleteMissing).toBe(false);
});

test("parses public text models, tier prices in USD/MTok, and context windows", () => {
  expect(parseMetaModels(source)).toEqual([
    { id: "muse-spark-1.2", context: 1_048_576, cost: { input: 1.25, output: 4.25, cache_read: 0.15 } },
    { id: "muse-spark-1.2-contributor", context: 1_048_576, cost: { input: 0.1, output: 0.2, cache_read: 0.002 } },
  ]);
  expect(parseMetaModels({ ...source, pricing: pricing.replace("$0.002", "$0") })[1]?.cost.cache_read).toBe(0);
  expect(parseMetaModels({ ...source, models: models.replaceAll("1,048,576", "1048576") })[0]?.context).toBe(1_048_576);
});

test("rejects incomplete or changed docs rather than guessing prices or limits", () => {
  for (const bad of [
    { ...source, models: "<html>Unavailable</html>" },
    { ...source, pricing: "" },
    { ...source, models: models.replace("1,048,576 tokens", "Unknown") },
    { ...source, models: models.replace("1,048,576 tokens", "0 tokens") },
    { ...source, models: models.replace("1,048,576 tokens", "1,04,8576 tokens") },
    { ...source, models: models.replace("#standard-tier)", "#unknown-tier)") },
    { ...source, models: models.replace("`muse-spark-1.2`", "`../private`") },
    { ...source, pricing: pricing.replace("$1.25", "€1.25") },
    { ...source, pricing: pricing.replace("$1.25", "$-1") },
    { ...source, pricing: pricing.replace("Price per 1M tokens", "Price per 1K tokens") },
    { ...source, pricing: pricing.replace("| Output | $4.25 |", "") },
    { ...source, pricing: pricing.replace("| Output | $4.25 |", "| Output | $4.25 |\n| Input | $2 |") },
    { ...source, models: models.replace("muse-spark-1.2-contributor", "muse-spark-1.2") },
    { ...source, models: models.replace("| :---- | :---- | :---- | :---- | :---- |", "| broken |") },
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
  const model = parseMetaModels(source)[0]!;
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
base_model = "meta/muse-spark-1.2"
base_model_omit = ["limit.input"]
reasoning_options = [{ type = "effort", values = ["minimal", "low", "medium", "high", "xhigh"] }]
[cost]
input = 9
output = 9
cache_read = 9
`;
  const absent = path.join(modelsDir, "muse-spark-1.1.toml");
  try {
    await Bun.write(path.join(root, "models", "meta", "muse-spark-1.2.toml"), `
name = "Muse Spark 1.2"
description = "Test fixture"
release_date = "2026-01-01"
last_updated = "2026-01-01"
attachment = true
reasoning = true
tool_call = true
open_weights = false
[limit]
context = 1048576
input = 1048576
output = 131072
[modalities]
input = ["text", "image", "pdf", "video"]
output = ["text"]
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
    expect(result.reasoning_options).toEqual(Bun.TOML.parse(original).reasoning_options);
    expect(result.limit).toBeUndefined();
    expect(result.cost).toEqual({ input: 1.25, output: 4.25, cache_read: 0.15 });
    const second = await syncProvider(provider, { openIssues: false });
    expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
    expect(await Bun.file(filename).text()).toBe(text);
    await expect(syncProvider({ ...provider, fetchModels: async () => ({ ...source, pricing: "" }) })).rejects.toThrow();
    expect(await Bun.file(filename).text()).toBe(text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
