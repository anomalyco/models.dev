import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { groups, providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import { modelMetadata } from "../src/sync/providers/openrouter.js";
import { fetchVolcengineModels, parseVolcengineModels, volcengine } from "../src/sync/providers/volcengine.js";

const peerID = "doubao-seed-2-1-pro-260915";
const newID = "doubao-seed-2-1-pro-261101";
const unknownID = "new-model-family-261101";

function canonicalText(id: string) {
  return Bun.file(path.join(import.meta.dirname, "..", "..", "..", "models", `${id}.toml`)).text();
}

function modelRow(id: string, note = "", limits = ["1024k", "1024k", "256k"]) {
  return `|[${id}](https://ark.volcengine.com/region:cn-beijing/model/detail?Id=test) ${note} |深度思考 |上下文窗口: ${limits[0]} |最大 RPM: 500 | \\
| |文本生成 |最大输入: ${limits[1]} |最大 TPM: 1000000 | \\
| |工具调用 |[最大回答(默认 4k)](/docs/text-generation#limit): ${limits[2]} | | \\
| |结构化输出 |最大思维链: 256k | |`;
}

function modelDocs(rows: string[]) {
  return `# 模型列表
# 文本生成能力
## 推荐模型
|模型 ID (Model ID) |**能力支持** |**长度限制（token）** |限流 | \\
| | | |> 非刚性保障，受平台负载影响 |
|---|---|---|---|
${rows.join("\n")}

# 图片生成能力
|模型 ID (Model ID) |能力 |价格 |
|---|---|---|
|image-model |图片生成 |1 |
`;
}

const controls = [{ type: "effort" as const, values: ["minimal" as const, "low" as const, "medium" as const, "high" as const] }];
const authored: ExistingModel & { base_model: string } = {
  base_model: "bytedance-seed/seed-2.1-pro",
  reasoning_options: controls,
  interleaved: { field: "reasoning_content" },
  limit: { context: 1_048_576, input: 1_048_576, output: 262_144 },
  cost: { input: 9, output: 30, cache_read: 0.4, tiers: [{ tier: { type: "context", size: 32_000 }, input: 12, output: 40 }] },
};
const existing: ExistingModel = { ...authored, reasoning: true, tool_call: true };
const context = {
  authored: (id: string) => id === peerID ? authored : undefined,
  existing: (id: string) => id === peerID ? existing : undefined,
};

test("Volcengine is registered for existing hourly and direct sync runs", () => {
  expect(providers.volcengine).toBe(volcengine);
  expect(groups.direct).toContain("volcengine");
  expect("skipCreates" in volcengine).toBe(false);
  expect(volcengine.deleteMissing).toBe(false);
});

test("parses public text model continuations, capabilities, limits and retiring markers", () => {
  const result = parseVolcengineModels({ models: modelDocs([
    modelRow(newID), modelRow(peerID, "`即将下线`"), modelRow("private-model", "`白名单`"),
  ]) });
  expect(result).toEqual([
    { id: newID, tools: true, structured: true, reasoning: true, retiring: false, limits: { context: "1024k", input: "1024k", output: "256k" } },
    { id: peerID, tools: true, structured: true, reasoning: true, retiring: true, limits: { context: "1024k", input: "1024k", output: "256k" } },
  ]);
  // A document-level explanation of allowlisting must not hide public rows.
  expect(parseVolcengineModels({ models: modelDocs([modelRow(newID)]).replace("## 推荐模型", "白名单功能的说明\n## 推荐模型") })).toHaveLength(1);
});

test("rejects malformed inventories before any writes", () => {
  const valid = modelDocs([modelRow(newID)]);
  for (const models of [
    "<html>Unavailable</html>",
    modelDocs([]),
    modelDocs([modelRow(newID), modelRow(newID)]),
    valid.replace("|---|---|---|---|", "|---|---|"),
    valid.replace("| |工具调用 |", "| |工具调用 | broken |"),
    valid.replace(`[${newID}]`, "[../private]"),
    valid.replace("**能力支持**", "renamed-column"),
  ]) expect(() => parseVolcengineModels({ models })).toThrow();
});

test("creates a known-family version without copying prices or inventing zero prices", () => {
  const model = parseVolcengineModels({ models: modelDocs([modelRow(newID)]) })[0]!;
  const translated = volcengine.translateModel(model, context)!;
  expect("base_model" in translated.model && translated.model.base_model).toBe("bytedance-seed/seed-2.1-pro");
  expect(translated.model.cost).toBeUndefined();
  const baseLimits = modelMetadata("bytedance-seed/seed-2.1-pro").limit as Record<string, number>;
  expect({ ...baseLimits, ...translated.model.limit }).toEqual({ context: 1_048_576, input: 1_048_576, output: 262_144 });
  for (const [key, value] of Object.entries(translated.model.limit ?? {})) {
    expect(baseLimits[key]).not.toBe(value);
  }
  expect(translated.model.reasoning_options).toEqual(controls);
  expect(translated.header).toContain("Pricing is not provided");
  expect(authored.cost?.input).toBe(9);
});

test("new families, ambiguous limits and unknown host controls go to missing-model issues", () => {
  for (const row of [
    modelRow(unknownID),
    modelRow("glm-5-2-261101"),
    modelRow("doubao-seed-2-1-turbo-261101"),
    modelRow(newID, "", ["2048k", "2048k", "256k"]),
  ]) {
    const model = parseVolcengineModels({ models: modelDocs([row]) })[0]!;
    expect(volcengine.translateModel(model, context)).toBeUndefined();
    expect(volcengine.missingModelID(model)).toBe(model.id);
    expect(volcengine.skippedNotice([model.id]).join(" ")).toContain(model.id);
  }
  const model = parseVolcengineModels({ models: modelDocs([modelRow(newID)]) })[0]!;
  expect(volcengine.translateModel(model, { ...context, authored: (id: string) => id === peerID ? { ...authored, reasoning_options: undefined } : undefined })).toBeUndefined();
  // The sync PR can land before its catalog prerequisites: no peer means
  // a missing-model issue, never a dangling canonical reference or a stub.
  expect(volcengine.translateModel(model, { authored: () => undefined, existing: () => undefined })).toBeUndefined();
  expect(volcengine.translateModel({ ...model, retiring: true }, context)).toBeUndefined();
  expect(volcengine.missingModelID({ ...model, retiring: true })).toBeUndefined();
});

test("new Kimi versions preserve curated host MIME and sampling restrictions and APIs", () => {
  const kimiPeer = "kimi-k3-1-pro-261024";
  const kimiNew = "kimi-k3-1-pro-261101";
  const model = parseVolcengineModels({ models: modelDocs([modelRow(kimiNew)]) })[0]!;
  const modalities: NonNullable<ExistingModel["modalities"]> = { input: ["text", "image", "video"], output: ["text"] };
  const preciseModalities = { input: ["text", "image/png", "video/mp4"], output: ["text"] };
  const api = { "chat-completions": { compatibility: { reasoning_field: "reasoning_content" } }, messages: {} };
  const kimiAuthored: ExistingModel = {
    base_model: "moonshotai/kimi-k3.1-pro", reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    interleaved: { field: "reasoning_content" }, modalities,
  };
  const translated = volcengine.translateModel(model, {
    authored: (id: string) => id === kimiPeer ? kimiAuthored : undefined,
    existing: (id: string) => id === kimiPeer ? { ...kimiAuthored, reasoning: true, limit: existing.limit } : undefined,
    v2: (id: string) => id === kimiPeer ? {
      modalities: preciseModalities, api, capabilities: { top_k: false, cache: { implicit: true } }, cost: { text: { input: { price: 9 } } },
    } : undefined,
  })!;
  expect(translated.model.modalities).toEqual(modalities);
  expect(translated.v2Set).toEqual({ modalities: preciseModalities, api, "capabilities.top_k": false });
  expect(translated.model.cost).toBeUndefined();
});

test("updates exact limits and positive capabilities while preserving curated fields", () => {
  const model = parseVolcengineModels({ models: modelDocs([modelRow(peerID, "`即将下线`", ["1048576", "1048576", "270000"])]) })[0]!;
  const translated = volcengine.translateModel(model, context)!;
  expect(translated.model).toEqual({ ...authored, structured_output: true, status: "deprecated", limit: { ...authored.limit, output: 270_000 } });
  const ambiguous = volcengine.translateModel({ ...model, limits: { context: "2048k" } }, context)!;
  expect(ambiguous.model.limit).toEqual(authored.limit);
  expect(ambiguous.notices?.join(" ")).toContain("context=2048k");
  const noLabels = volcengine.translateModel({ ...model, tools: false, structured: false, reasoning: false, retiring: false, limits: {} }, context)!;
  expect(noLabels.model).toEqual(authored);
});

test("unknown limit units never become a numeric prefix", () => {
  for (const display of ["1M", "1 M", "1 MB", "1e6", "1024kB", "1.5M"]) {
    const model = parseVolcengineModels({ models: modelDocs([modelRow(peerID, "", [display, "1024k", "256k"])]) })[0]!;
    const token = display.replace(/\s/g, "");
    expect(model.limits.context).toBe(token);
    const translated = volcengine.translateModel(model, context)!;
    expect(translated.model.limit).toEqual(authored.limit);
    expect(translated.notices?.join(" ")).toContain(`context=${token}`);
    expect(volcengine.translateModel({ ...model, id: newID }, context)).toBeUndefined();
  }
});

test("fetches only the requested public model-list Markdown without credentials", async () => {
  const models = modelDocs([modelRow(newID)]);
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    expect(init).toBeUndefined();
    calls.push(url);
    return new Response(models);
  }) as typeof fetch;
  expect(await fetchVolcengineModels(fetcher)).toEqual({ models });
  expect(calls).toEqual(["https://ark.volcengine.com/region:cn-beijing/docs/model-list.md"]);
  await expect(fetchVolcengineModels((async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch)).rejects.toThrow("Volcengine docs request failed: 503");
});

test("runner preserves curated headers, prices and base models, creates new versions and is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-volcengine-"));
  const modelsDir = path.join(root, "providers", "volcengine", "models");
  const filename = path.join(modelsDir, `${peerID}.toml`);
  const absent = path.join(modelsDir, "older-version.toml");
  const original = `# Keep audited provenance and the existing exchange rate.
schema = 2
base_model = "bytedance-seed/seed-2.1-pro"

[capabilities]
reasoning = { supported = true, effort = ["minimal", "low", "medium", "high"] }
cache = { implicit = true, explicit = { ttl = ["5m", "1h"] } }

[limit]
context = 1048576
input = 1048576
output = 262144

[api.chat-completions]
compatibility = { reasoning_field = "reasoning_content" }

[cost.text.input]
price = 9
cache = { read = 0.4, write = { "5m" = 1, "1h" = 2 } }

[[cost.text.input.overrides]]
when = { context = { gt = 32000 } }
price = 12

[cost.text.output]
price = 30

[[cost.text.output.overrides]]
when = { context = { gt = 32000 } }
price = 40

[[cost.multipliers]]
when = { service_tier = { equals = "fast" } }
factor = 2
`;
  try {
    // factorBaseModel reads repository canonical metadata. Use that same
    // canonical file in the isolated runner so resolved-limit checks agree.
    const canonical = await canonicalText("bytedance-seed/seed-2.1-pro");
    const base = Bun.TOML.parse(canonical) as Record<string, any>;
    await Bun.write(path.join(root, "models", "bytedance-seed", "seed-2.1-pro.toml"), canonical);
    await Bun.write(path.join(path.dirname(modelsDir), "provider.toml"), `name = "Volcengine Ark"
npm = "@ai-sdk/openai-compatible"
api = "https://ark.cn-beijing.volces.com/api/v3"
env = ["ARK_API_KEY"]
doc = "https://ark.volcengine.com/region:cn-beijing/docs/model-list"
`);
    await Bun.write(filename, original);
    await Bun.write(absent, original);
    const provider = { ...volcengine, modelsDir, fetchModels: async () => ({ models: modelDocs([modelRow(peerID), modelRow(newID), modelRow(unknownID)]) }) };
    const dry = await syncProvider(provider, { dryRun: true, openIssues: false });
    expect(dry).toMatchObject({ created: 1, updated: 1, deleted: 0 });
    expect(await Bun.file(filename).text()).toBe(original);
    expect(await Bun.file(path.join(modelsDir, `${newID}.toml`)).exists()).toBe(false);
    const first = await syncProvider(provider, { openIssues: false });
    expect(first).toMatchObject({ created: 1, updated: 1, deleted: 0 });
    expect(first.notices.join(" ")).toContain(unknownID);
    const text = await Bun.file(filename).text();
    const updated = Bun.TOML.parse(text) as Record<string, any>;
    const before = Bun.TOML.parse(original) as Record<string, any>;
    expect(text).toStartWith("# Keep audited provenance and the existing exchange rate.");
    expect(updated.base_model).toBe(before.base_model);
    expect(updated.cost).toEqual(before.cost);
    expect(updated.api).toEqual(before.api);
    expect((updated.capabilities as any).reasoning).toEqual((before.capabilities as any).reasoning);
    expect((updated.capabilities as any).cache).toEqual((before.capabilities as any).cache);
    expect(await Bun.file(absent).text()).toBe(original);
    const created = Bun.TOML.parse(await Bun.file(path.join(modelsDir, `${newID}.toml`)).text()) as Record<string, any>;
    expect(created.base_model).toBe(before.base_model);
    expect(created.cost).toBeUndefined();
    expect({ ...base.limit, ...created.limit }).toEqual({ context: 1_048_576, input: 1_048_576, output: 262_144 });
    for (const [key, value] of Object.entries(created.limit ?? {})) {
      expect(base.limit[key]).not.toBe(value);
    }
    const second = await syncProvider(provider, { openIssues: false });
    expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 3 });
    expect(await Bun.file(filename).text()).toBe(text);
    await expect(syncProvider({ ...provider, fetchModels: async () => ({ models: "Unavailable" }) }, { openIssues: false })).rejects.toThrow();
    expect(await Bun.file(filename).text()).toBe(text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner creates a Kimi version with the host's exact MIME restrictions and protocols", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-volcengine-kimi-"));
  const modelsDir = path.join(root, "providers", "volcengine", "models");
  const kimiPeer = "kimi-k3-1-pro-261024";
  const kimiNew = "kimi-k3-1-pro-261101";
  try {
    const canonical = await canonicalText("moonshotai/kimi-k3.1-pro");
    const base = Bun.TOML.parse(canonical) as Record<string, any>;
    await Bun.write(path.join(root, "models", "moonshotai", "kimi-k3.1-pro.toml"), canonical);
    await Bun.write(path.join(path.dirname(modelsDir), "provider.toml"), `name = "Volcengine Ark"
npm = "@ai-sdk/openai-compatible"
api = "https://ark.cn-beijing.volces.com/api/v3"
env = ["ARK_API_KEY"]
doc = "https://ark.volcengine.com/region:cn-beijing/docs/model-list"
`);
    await Bun.write(path.join(modelsDir, `${kimiPeer}.toml`), `schema = 2
base_model = "moonshotai/kimi-k3.1-pro"
[modalities]
input = ["text", "image/png", "video/mp4"]
output = ["text"]
[capabilities]
reasoning = { supported = true, effort = ["low", "high", "max"] }
top_k = false
[api.chat-completions]
compatibility = { reasoning_field = "reasoning_content" }
[api.messages]
[cost.text.input]
price = 9
[cost.text.output]
price = 30
`);
    const limits = { context: base.limit.context, input: base.limit.input ?? base.limit.context, output: base.limit.output };
    const displays = [limits.context, limits.input, limits.output].map(String);
    const provider = { ...volcengine, modelsDir, fetchModels: async () => ({ models: modelDocs([modelRow(kimiNew, "", displays)]) }) };
    const first = await syncProvider(provider, { openIssues: false });
    expect(first).toMatchObject({ created: 1, updated: 0, deleted: 0 });
    expect(first.notices.join(" ")).not.toContain("Could not write");
    const created = Bun.TOML.parse(await Bun.file(path.join(modelsDir, `${kimiNew}.toml`)).text()) as Record<string, any>;
    expect(created.modalities).toEqual({ input: ["text", "image/png", "video/mp4"], output: ["text"] });
    expect((created.capabilities as any).top_k).toBe(false);
    expect(Object.keys(created.api as object)).toEqual(["chat-completions", "messages"]);
    expect(created.cost).toBeUndefined();
    expect({ ...base.limit, ...created.limit }).toEqual(limits);
    expect(await syncProvider(provider, { openIssues: false })).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
