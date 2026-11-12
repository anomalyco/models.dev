import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AGENT_FIELDS, agentBrief, parseObservations } from "../src/sync2/agent.js";
import { readProviderFiles, REPO_ROOT } from "../src/sync2/catalog.js";
import { plan } from "../src/sync2/engine.js";
import { agents, modules } from "../src/sync2/index.js";
import { amazonBedrock } from "../src/sync2/providers/amazon-bedrock.js";
import { azure } from "../src/sync2/providers/azure.js";
import { cohere } from "../src/sync2/providers/cohere.js";
import { googleVertex } from "../src/sync2/providers/google-vertex.js";
import { minimax } from "../src/sync2/providers/minimax.js";
import { zai } from "../src/sync2/providers/zai.js";
import { zhipuai } from "../src/sync2/providers/zhipuai.js";
import type { AgentModule } from "../src/sync2/types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const lab = (type = "chat") => `schema = 2
name = "Example"
description = "Example model"
open_weights = false
release_date = "2026-01-01"
${type === "chat" ? "" : `type = "${type}"\n`}
[modalities]
input = ["text"]
output = ["text"]

[capabilities]
tools = { supported = true }
reasoning = { supported = false }
temperature = true
top_p = true
top_k = false

[limit]
context = 200_000
output = 64_000
`;

const priced = (base: string, input: number, extra = "") => `# Source: hand-written
schema = 2
base_model = "${base}"
${extra}
[cost.text.input]
price = ${input}
cache = { read = ${input / 10} }

[cost.text.output]
price = ${input * 5}
`;

async function catalog(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "sync2-agent-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) await Bun.write(path.join(root, file), content);
  return root;
}

const read = (root: string, file: string) => Bun.file(path.join(root, file)).text();

async function run(module: AgentModule, root: string, batch: unknown) {
  const observed = await parseObservations(module, batch, root);
  return plan(module, { root, observed });
}

test("an agent module only runs from observations", async () => {
  const root = await catalog({ "models/openai/gpt-5.4.toml": lab() });
  await expect(plan(azure, { root })).rejects.toThrow("agent provider");
});

test("the schema rejects the whole file for any bad observation", async () => {
  const root = await catalog({
    "models/openai/gpt-5.4.toml": lab(),
    "models/openai/text-embedding-3-large.toml": lab("embedding"),
    "providers/azure/models/gpt-5.4.toml": priced("openai/gpt-5.4", 2.5),
    "providers/azure/models/text-embedding-3-large.toml": priced("openai/text-embedding-3-large", 0.13),
  });
  const quote = { url: "https://azure.microsoft.com/en-us/pricing/details/azure-openai/", quote: "GPT-5.4 Global Input $2.50", fields: ["cost.text.input.price"] };
  const good = { id: "gpt-5.4", fields: { "cost.text.input.price": 2.5 }, evidence: [quote] };
  const batch = (...observations: unknown[]) => ({ provider: "azure", complete: false, observations: [good, ...observations] });
  const rejects = async (input: unknown, message: string) => {
    const error = await parseObservations(azure, input, root).then(() => undefined, (caught: Error) => caught);
    expect(error?.message).toContain("Rejected the observation file for Azure");
    expect(error?.message).toContain(message);
  };

  expect((await parseObservations(azure, batch(), root)).observations).toEqual([{ id: "gpt-5.4", cost: { text: { input: { price: 2.5 } } } }]);
  await rejects({ ...batch(), provider: "openai" }, "provider");
  await rejects({ ...batch(), extra: true }, "Unrecognized key");
  await rejects({ provider: "azure", observations: [good] }, "complete");
  await rejects(batch({ ...good, id: "gpt-5.5", fields: { "capabilities.reasoning.supported": true }, evidence: [{ ...quote, fields: ["capabilities.reasoning.supported"] }] }), "isn't a field Azure syncs");
  await rejects(batch({ ...good, id: "gpt-5.5", fields: { "cost.text.output.price": 15 } }), "no evidence quote backs this field");
  await rejects(batch({ ...good, id: "gpt-5.5", fields: { "cost.text.input.price": -1 } }), "fields.cost.text.input.price");
  await rejects(batch({ ...good, id: "gpt-5.5", fields: { "limit.context": "1M" }, evidence: [{ ...quote, fields: ["limit.context"] }] }), "fields.limit.context");
  await rejects(batch({ ...good, id: "gpt-5.5", fields: { "cost.text.input.price": null } }), "fields.cost.text.input.price");
  await rejects(batch({ ...good, id: "gpt-5.5", evidence: [{ ...quote, url: "https://example.com/prices" }] }), "must be https on");
  await rejects(batch({ ...good, id: "gpt-5.5", evidence: [{ ...quote, url: "http://azure.microsoft.com/en-us/pricing/details/azure-openai/" }] }), "must be https on");
  await rejects(batch({ ...good, id: "gpt-5.5", evidence: [{ ...quote, quote: "  " }] }), "evidence.0.quote");
  await rejects(batch({ ...good, id: "gpt-5.5", evidence: [] }), "evidence");
  await rejects(batch({ ...good, id: "gpt-5.5", evidence: [{ ...quote, fields: ["cost.text.input.price", "limit.output"] }] }), "limit.output isn't stated in fields");
  await rejects(batch({ ...good, id: "GPT 5.5!" }), "observations.1.id");
  await rejects(batch({ ...good, id: "../gpt-5.5" }), "observations.1.id");
  await rejects(batch({ ...good, id: "Gpt-5.5" }), "doesn't look like a Azure ID");
  await rejects(batch({ ...good, id: "gpt-5.4" }), "listed twice");
  await rejects(batch({ ...good, id: "text-embedding-3-large" }), "don't cover text-embedding-3-large");
  await rejects(batch({ ...good, id: "gpt-5.5", base: ["gpt-5.5"] }), "lab model ID");
  await rejects(batch({ ...good, id: "gpt-5.5", fields: { ...good.fields, "cost.text.input.overrides": [{ when: { context: { lt: 1 } }, price: 5 }] }, evidence: [{ ...quote, fields: ["cost.text.input.price", "cost.text.input.overrides"] }] }), "fields.cost.text.input.overrides");
});

test("amazon-bedrock: updates prices and the cache write TTLs, and a new profile is a gap", async () => {
  const root = await catalog({
    "models/anthropic/claude-opus-4-6.toml": lab(),
    "providers/amazon-bedrock/models/global.anthropic.claude-opus-4-6-v1.toml": priced("anthropic/claude-opus-4-6", 5),
    "providers/amazon-bedrock/models/eu.anthropic.claude-opus-4-6-v1.toml": priced("anthropic/claude-opus-4-6", 5.5),
  });
  const pricing = "https://aws.amazon.com/bedrock/pricing/";
  const { result, writes } = await run(amazonBedrock, root, {
    provider: "amazon-bedrock",
    observed_at: "2026-11-10",
    complete: false,
    observations: [
      {
        id: "global.anthropic.claude-opus-4-6-v1",
        fields: { "cost.text.input.price": 4.5, "cost.text.input.cache.write": { "5m": 5.625, "1h": 9 }, "limit.output": 128_000 },
        evidence: [
          { url: pricing, quote: "Claude Opus 4.6 Global Cross Region Input $4.50 5m cache write $5.625 1h cache write $9.00", fields: ["cost.text.input.price", "cost.text.input.cache.write"] },
          { url: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html", quote: "Max output tokens 128K", fields: ["limit.output"] },
        ],
      },
      { id: "eu.anthropic.claude-opus-4-6-v1", fields: { "cost.text.input.price": 5.5 }, evidence: [{ url: pricing, quote: "In-Region Input $5.50", fields: ["cost.text.input.price"] }] },
      {
        id: "us.anthropic.claude-opus-6",
        base: ["anthropic/claude-opus-6", "anthropic/claude-opus-4-6"],
        fields: { "cost.text.input.price": 5.5 },
        evidence: [{ url: "https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html", quote: "US Anthropic Claude Opus 6 us.anthropic.claude-opus-6", fields: [] }, { url: pricing, quote: "Claude Opus 6 Input $5.50", fields: ["cost.text.input.price"] }],
      },
    ],
  });

  expect(await read(root, "providers/amazon-bedrock/models/global.anthropic.claude-opus-4-6-v1.toml")).toBe(priced("anthropic/claude-opus-4-6", 5));
  expect(writes.get("providers/amazon-bedrock/models/global.anthropic.claude-opus-4-6-v1.toml")).toBe(`# Source: hand-written
schema = 2
base_model = "anthropic/claude-opus-4-6"

[limit]
output = 128_000

[cost.text.input]
price = 4.5
cache = { read = 0.5, write = { "5m" = 5.625, "1h" = 9 } }

[cost.text.output]
price = 25
`);
  expect(writes.size).toBe(1);
  expect(result.changes.map((change) => [change.model, change.fields.map((field) => field.path)])).toEqual([
    ["global.anthropic.claude-opus-4-6-v1", ["cost.text.input.price", "cost.text.input.cache.write", "limit.output"]],
  ]);
  expect(result.gaps).toMatchObject([{ model: "us.anthropic.claude-opus-6", kind: "new", reason: "new models are added by hand for this provider" }]);
  expect(result.risk.safe).toBe(false);
  expect(result.risk.reasons).toEqual(["agent-observed"]);
  expect(result.evidence?.map((item) => [item.model, item.url])).toEqual([
    ["global.anthropic.claude-opus-4-6-v1", pricing],
    ["global.anthropic.claude-opus-4-6-v1", "https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html"],
    ["us.anthropic.claude-opus-6", "https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html"],
    ["us.anthropic.claude-opus-6", pricing],
  ]);
});

test("google-vertex: deprecates a Claude version, replaces Gemini bands, and a new model is a gap", async () => {
  const bands = `
[[cost.text.input.overrides]]
when = { context = { gt = 200_000 } }
price = 2.5

[[cost.text.output.overrides]]
when = { context = { gt = 200_000 } }
price = 15
`;
  const root = await catalog({
    "models/anthropic/claude-sonnet-4-5.toml": lab(),
    "models/google/gemini-2.5-pro.toml": lab(),
    "providers/google-vertex/models/claude-sonnet-4-5@20250929.toml": priced("anthropic/claude-sonnet-4-5", 3),
    "providers/google-vertex/models/gemini-2.5-pro.toml": priced("google/gemini-2.5-pro", 1.25) + bands,
  });
  const versions = "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions";
  const pricing = "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing";
  const { result, writes } = await run(googleVertex, root, {
    provider: "google-vertex",
    complete: false,
    observations: [
      { id: "claude-sonnet-4-5@20250929", fields: { status: "deprecated" }, evidence: [{ url: versions, quote: "claude-sonnet-4-5@20250929 Retirement date: not sooner than September 29, 2026", fields: ["status"] }] },
      {
        id: "gemini-2.5-pro",
        fields: { "cost.text.input.overrides": [{ when: { context: { gt: 200_000 } }, price: 3 }] },
        evidence: [{ url: pricing, quote: "Gemini 2.5 Pro Input (> 200K input tokens) $3", fields: ["cost.text.input.overrides"] }],
      },
      { id: "gemini-9-flash", base: ["google/gemini-9-flash"], fields: {}, evidence: [{ url: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/google-models", quote: "Gemini 9 Flash gemini-9-flash", fields: [] }] },
    ],
  });

  expect(writes.get("providers/google-vertex/models/claude-sonnet-4-5@20250929.toml")).toBe(priced("anthropic/claude-sonnet-4-5", 3, 'status = "deprecated"\n'));
  expect(writes.get("providers/google-vertex/models/gemini-2.5-pro.toml")).toBe(`# Source: hand-written
schema = 2
base_model = "google/gemini-2.5-pro"

[cost.text.input]
price = 1.25
cache = { read = 0.125 }

[[cost.text.input.overrides]]
when = { context = { gt = 200_000 } }
price = 3

[cost.text.output]
price = 6.25

[[cost.text.output.overrides]]
when = { context = { gt = 200_000 } }
price = 15
`);
  expect(result.changes.map((change) => change.model)).toEqual(["claude-sonnet-4-5@20250929", "gemini-2.5-pro"]);
  expect(result.gaps).toMatchObject([{ model: "gemini-9-flash", kind: "new", reason: "new models are added by hand for this provider" }]);
  expect(result.gaps[0]!.missing[0]).toBe("base_model");
  expect(result.risk.safe).toBe(false);
  expect(result.risk.reasons).toContain("agent-observed");
});

test("azure: a complete file reports what it leaves out, and nothing is ever deleted", async () => {
  const root = await catalog({
    "models/openai/gpt-5.4.toml": lab(),
    "models/openai/gpt-4o.toml": lab(),
    "models/openai/gpt-image-2.toml": lab("image"),
    "providers/azure/models/gpt-5.4.toml": priced("openai/gpt-5.4", 2.5),
    "providers/azure/models/gpt-4o.toml": priced("openai/gpt-4o", 2.5),
    "providers/azure/models/gpt-image-2.toml": priced("openai/gpt-image-2", 5),
  });
  const { result, writes } = await run(azure, root, {
    provider: "azure",
    complete: true,
    observations: [
      {
        id: "gpt-5.4",
        fields: { "cost.text.output.price": 15, "limit.context": 1_050_000, "limit.output": 128_000 },
        evidence: [
          { url: "https://azure.microsoft.com/en-us/pricing/details/azure-openai/", quote: "GPT-5.4 Global Output $15", fields: ["cost.text.output.price"] },
          { url: "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure", quote: "gpt-5.4 Context window 1,050,000 Max output tokens 128,000", fields: ["limit.context", "limit.output"] },
        ],
      },
      { id: "gpt-9", base: ["openai/gpt-9"], fields: {}, evidence: [{ url: "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure", quote: "gpt-9", fields: [] }] },
    ],
  });

  expect(writes.get("providers/azure/models/gpt-5.4.toml")).toBe(`# Source: hand-written
schema = 2
base_model = "openai/gpt-5.4"

[limit]
context = 1_050_000
output = 128_000

[cost.text.input]
price = 2.5
cache = { read = 0.25 }

[cost.text.output]
price = 15
`);
  expect(writes.size).toBe(1);
  // gpt-image-2 is out of scope, so it isn't reported as dropped.
  expect(result.gaps.map((gap) => [gap.model, gap.kind])).toEqual([["gpt-4o", "removal"], ["gpt-9", "new"]]);
  expect(result.risk.safe).toBe(false);
  expect(result.evidence?.map((item) => item.model)).toEqual(["gpt-5.4", "gpt-5.4", "gpt-9"]);
});

test("minimax: a discounted price and a long-prompt band; zai: a USD price on a lowercased ID", async () => {
  const root = await catalog({
    "models/minimax/MiniMax-M3.toml": lab(),
    "models/zhipuai/glm-5.3.toml": lab(),
    "providers/minimax/models/MiniMax-M3.toml": priced("minimax/MiniMax-M3", 0.3),
    "providers/zai/models/glm-5.3.toml": priced("zhipuai/glm-5.3", 1.4),
  });
  const pricing = "https://platform.minimax.io/docs/guides/pricing-paygo";
  const { result, writes } = await run(minimax, root, {
    provider: "minimax",
    complete: false,
    observations: [{
      id: "MiniMax-M3",
      fields: { "cost.text.input.price": 0.25, "cost.text.input.overrides": [{ when: { context: { gt: 512_000 } }, price: 0.5, cache: { read: 0.1 } }] },
      evidence: [{ url: pricing, quote: "MiniMax-M3 ≤ 512k input tokens ~~$0.60~~ $0.25 | > 512k input tokens ~~$1.20~~ $0.50 ... $0.10", fields: ["cost.text.input.price", "cost.text.input.overrides"] }],
    }],
  });
  expect(result.changes.map((change) => [change.model, change.fields.map((field) => field.path)])).toEqual([["MiniMax-M3", ["cost.text.input.price", "cost.text.input.overrides"]]]);
  expect(writes.get("providers/minimax/models/MiniMax-M3.toml")).toContain("when = { context = { gt = 512_000 } }\nprice = 0.5\ncache = { read = 0.1 }");

  const zaiResult = await run(zai, root, {
    provider: "zai",
    complete: false,
    observations: [{ id: "glm-5.3", fields: { "cost.text.output.price": 4.8 }, evidence: [{ url: "https://docs.z.ai/guides/overview/pricing", quote: "GLM-5.3 | $1.4 | $0.26 | Limited-time Free | $4.8", fields: ["cost.text.output.price"] }] }],
  });
  expect(zaiResult.result.changes.map((change) => change.fields)).toEqual([[{ path: "cost.text.output.price", before: 7, after: 4.8 }]]);
});

test("zhipuai states limits and deprecation only; cohere evidence must come from Cohere's pages", async () => {
  const root = await catalog({
    "models/zhipuai/glm-5.1.toml": lab(),
    "models/cohere/command-r-08-2024.toml": lab(),
    "providers/zhipuai/models/glm-5.1.toml": priced("zhipuai/glm-5.1", 0.9),
    "providers/cohere/models/command-r-08-2024.toml": priced("cohere/command-r-08-2024", 0.15),
  });
  const overview = "https://docs.bigmodel.cn/cn/guide/start/model-overview";
  await expect(parseObservations(zhipuai, {
    provider: "zhipuai",
    complete: false,
    observations: [{ id: "glm-5.1", fields: { "cost.text.input.price": 0.9 }, evidence: [{ url: overview, quote: "GLM-5.1 6 元", fields: ["cost.text.input.price"] }] }],
  }, root)).rejects.toThrow("cost.text.input.price isn't a field Zhipu AI syncs");
  const { result } = await run(zhipuai, root, {
    provider: "zhipuai",
    complete: false,
    observations: [{ id: "glm-5.1", fields: { "limit.context": 1_000_000, status: "deprecated" }, evidence: [{ url: overview, quote: "GLM-5.1 上下文 1M；2027 年 1 月 31 日下线", fields: ["limit.context", "status"] }] }],
  });
  expect(result.changes.map((change) => change.fields.map((field) => field.path))).toEqual([["limit.context", "status"]]);

  await expect(parseObservations(cohere, {
    provider: "cohere",
    complete: false,
    observations: [{ id: "command-r-08-2024", fields: { status: "deprecated" }, evidence: [{ url: "https://openrouter.ai/cohere", quote: "deprecated", fields: ["status"] }] }],
  }, root)).rejects.toThrow("must be https on cohere.com, docs.cohere.com");
  const deprecated = await run(cohere, root, {
    provider: "cohere",
    complete: false,
    observations: [{ id: "command-r-08-2024", fields: { status: "deprecated" }, evidence: [{ url: "https://docs.cohere.com/docs/deprecations", quote: "command-r-08-2024 Deprecated, shutdown 2027-03-01", fields: ["status"] }] }],
  });
  expect(deprecated.result.changes.map((change) => change.kind)).toEqual(["update"]);
});

test("agent results are never safe, even with nothing to change", async () => {
  const root = await catalog({ "models/openai/gpt-5.4.toml": lab(), "providers/azure/models/gpt-5.4.toml": priced("openai/gpt-5.4", 2.5) });
  const { result } = await run(azure, root, {
    provider: "azure",
    complete: false,
    observations: [{ id: "gpt-5.4", fields: { "cost.text.input.price": 2.5 }, evidence: [{ url: "https://azure.microsoft.com/en-us/pricing/details/azure-openai/", quote: "Input $2.50", fields: ["cost.text.input.price"] }] }],
  });
  expect(result.changes).toEqual([]);
  expect(result.evidence).toEqual([]);
  expect(result.risk).toMatchObject({ safe: false, reasons: ["agent-observed"] });
});

test("an API module can apply an observation file in place of its source", async () => {
  const root = await catalog({ "models/xai/grok-5.toml": lab(), "providers/xai/models/grok-5.toml": priced("xai/grok-5", 2) });
  const observed = await parseObservations(modules.xai!, {
    provider: "xai",
    complete: false,
    observations: [{ id: "grok-5", fields: { "cost.text.input.price": 3 }, evidence: [{ url: "https://docs.x.ai/docs/models", quote: "grok-5 $3.00", fields: ["cost.text.input.price"] }] }],
  }, root);
  const { result } = await plan(modules.xai!, { root, observed });
  expect(result.changes.map((change) => change.fields.map((field) => [field.path, field.after]))).toEqual([[["cost.text.input.price", 3]]]);
  expect(result.risk.reasons).toEqual(["observations from a file, not the source"]);
});

test("agent modules: every owned field is one agents can state, and every catalog file has a plausible ID", async () => {
  expect(Object.keys(agents).sort()).toEqual(["amazon-bedrock", "azure", "cohere", "google-vertex", "minimax", "zai", "zhipuai"]);
  for (const module of Object.values(agents)) {
    for (const owned of module.policy.owns) expect(Object.keys(AGENT_FIELDS)).toContain(typeof owned === "string" ? owned : owned.path);
    expect(module.policy.creates).toBe("gap");
    expect(module.policy.removals).toBe("keep");
    for (const source of module.sources) expect(source.url.startsWith("https://")).toBe(true);
    const bad = [...(await readProviderFiles(REPO_ROOT, module.id)).keys()].filter((id) => !module.ids.test(id));
    expect(bad).toEqual([]);
  }
});

test("the brief lists sources, owned fields, the schema and the files' current values", async () => {
  const root = await catalog({
    "models/anthropic/claude-opus-4-6.toml": lab(),
    "providers/amazon-bedrock/models/global.anthropic.claude-opus-4-6-v1.toml": priced("anthropic/claude-opus-4-6", 5, 'status = "deprecated"\n'),
  });
  const brief = await agentBrief(amazonBedrock, root);
  expect(brief.sources).toBe(amazonBedrock.sources);
  expect(brief.evidenceHosts).toEqual(["aws.amazon.com", "pricing.us-east-1.amazonaws.com", "docs.aws.amazon.com"]);
  expect(Object.keys(brief.schema.properties.observations.items.properties.fields.properties)).toEqual(amazonBedrock.policy.owns.map((owned) => (typeof owned === "string" ? owned : owned.path)));
  expect(brief.files).toEqual([{
    id: "global.anthropic.claude-opus-4-6-v1",
    base_model: "anthropic/claude-opus-4-6",
    values: { "cost.text.input.price": 5, "cost.text.output.price": 25, "cost.text.input.cache.read": 0.5, "limit.context": 200_000, "limit.output": 64_000, status: "deprecated" },
  }]);
});
