import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { patchModelV2 } from "../src/model-file-v2.js";
import { preserveStructuredOutput, syncProvider, type ExistingModel } from "../src/sync/index.js";
import { aimlapi, labEffortValues, labLadder, resolveLadder } from "../src/sync/providers/aimlapi.js";
import { providerDirForMetadataLab } from "../src/sync/providers/openrouter.js";
import { modelV2ToV1 } from "../src/translate.js";

// The lookup that silently kept the host enum for every GLM id: `base_model`
// names the metadata lab, the ladder lives under the provider directory, and
// for these two they differ.
test("maps a metadata lab to its first-party provider directory", () => {
  expect(providerDirForMetadataLab("zhipuai")).toBe("zai");
  expect(providerDirForMetadataLab("deepseek")).toBe("deepseek");
  expect(providerDirForMetadataLab("no-such-lab")).toBe("no-such-lab");
});

test("a lab split across two provider directories is read from both", () => {
  // Meta's Llama cards live under `llama/`, its Muse cards under `meta/`.
  expect(providerDirForMetadataLab("meta")).toBe("llama");
  expect(labLadder("meta/muse-spark-1.1")).toEqual({
    kind: "effort",
    values: ["minimal", "low", "medium", "high", "xhigh"],
    source: "lab",
  });
  expect(resolveLadder("meta/muse-spark-1.1", "meta/muse-spark-1.1", ["low", "medium", "high"])).toEqual([
    "low",
    "medium",
    "high",
  ]);
});

test("reads the lab ladder through the provider directory, not the model record", () => {
  // `models/zhipuai/*.toml` has no reasoning_options; `providers/zai/models`
  // does. A lookup on the wrong one returns undefined and looks like "no lab
  // ladder", which is a different claim.
  expect(labEffortValues("zhipuai/glm-5.3-flash")).toEqual(["low", "high", "max"]);
  expect(labEffortValues("deepseek/deepseek-v4-pro")).toEqual(["low", "high", "max"]);
});

test("a dated snapshot borrows the ladder of the model it snapshots", () => {
  // There is no `deepseek-v4-pro-0813.toml` in the lab; without the borrow it
  // fell through to the host enum and came out wider than its own base.
  expect(labEffortValues("deepseek/deepseek-v4-pro-0813")).toEqual(labEffortValues("deepseek/deepseek-v4-pro"));
});

test("a lab entry with toggle only and no effort ladder yields undefined", () => {
  expect(labEffortValues("zhipuai/glm-4.7-flash")).toBeUndefined();
});

const HOST = ["none", "low", "medium", "high"] as const;

test("intersects the host enum with the lab ladder and drops the rest", () => {
  // lab low/high/max, host none..high: `medium` goes although the host
  // accepts it — that is the doctrine, and this test pins its cost.
  expect(resolveLadder("deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro", HOST)).toEqual(["none", "low", "high"]);
});

test("`none` survives only where measured as a real off switch", () => {
  // Same lab, same host enum; only the measurement differs.
  expect(resolveLadder("deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro", HOST)).toContain("none");
  expect(resolveLadder("deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash", HOST)).toContain("none");
});

test("`none` is kept where the lab itself lists it", () => {
  const host = ["none", "low", "medium", "high"];
  expect(resolveLadder("openai/gpt-5.6-luna", "openai/gpt-5.6-luna", host)).toContain("none");
});

test("a measurement narrows but never widens past the lab", () => {
  // gpt-5.4-pro: lab medium/high/xhigh, host low/medium/high, measured medium/high.
  expect(resolveLadder("openai/gpt-5.4-pro", "openai/gpt-5.4-pro", ["low", "medium", "high"])).toEqual(["medium", "high"]);
});

// The fallthrough the review found: a toggle-only lab must never turn into a
// host-schema L/M/H dump. Either the host field is measured live for that id,
// or the model is unresolved.
test("a toggle-only lab base never yields the host's effort dump", () => {
  const host = ["none", "minimal", "low", "medium", "high"];
  // glm-4.5v: lab toggle-only -> unresolved.
  expect(resolveLadder("z-ai/glm-4.5v", "zhipuai/glm-4.5v", host)).toBeUndefined();
  // qwen3.7-max: lab toggle+budget. The host's effort field measured live
  // (its names select the budget tiers), and it is still unresolved: a
  // toggle/budget baseline has no effort ladder to intersect with.
  expect(resolveLadder("alibaba/qwen3.7-max", "alibaba/qwen3.7-max", host)).toBeUndefined();
  expect(resolveLadder("google/gemini-2.5-flash-lite", "google/gemini-2.5-flash-lite", host)).toBeUndefined();
});

test("an empty intersection is unresolved, not the host enum", () => {
  // lab low/high/max, host offers none of them -> skip, do not republish.
  expect(resolveLadder("deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro", ["medium"])).toBeUndefined();
});

test("a base with no lab entry falls back to the OpenRouter peer's ladder, intersected", () => {
  // No `providers/tencent/models/hy3.toml`; OpenRouter lists none/low/high.
  expect(labLadder("tencent/hy3")).toEqual({ kind: "effort", values: ["none", "low", "high"], source: "peer" });
  expect(resolveLadder("tencent/hy3", "tencent/hy3", ["low", "medium", "high"])).toEqual(["low", "high"]);
  // A peer-listed `none` is not taken on trust the way a lab-listed one is.
  expect(resolveLadder("tencent/hy3", "tencent/hy3", ["none", "low", "medium", "high"])).toEqual(["low", "high"]);
  // OpenRouter files Alibaba under `qwen/`.
  expect(labLadder("alibaba/qwen3.8-27b")).toEqual({ kind: "effort", values: ["low", "medium", "xhigh"], source: "peer" });
});

test("a peer that is toggle-only counts as no effort ladder, not as a licence for the host enum", () => {
  // No lab entry for Opus 4.1; OpenRouter's card is toggle-only.
  expect(labLadder("anthropic/claude-opus-4.1")).toEqual({ kind: "no-effort", source: "peer" });
  expect(resolveLadder("anthropic/claude-opus-4.1", "anthropic/claude-opus-4.1", ["low", "medium", "high"])).toBeUndefined();
});

test("a base with neither a lab nor a peer entry is unresolved, not the host enum", () => {
  expect(labLadder("nolab/nothing-here")).toEqual({ kind: "no-entry" });
  expect(resolveLadder("some/model", "nolab/nothing-here", ["low", "high"])).toBeUndefined();
});

test("a wire alias resolves through the measurements of the id it answers as", () => {
  const host = ["none", "low", "medium", "high"];
  // `deepseek-chat` answers `"model": "deepseek-flash"` exactly as
  // `deepseek-v4-flash` does, so the probes run against the latter (`none`
  // switches reasoning off; `medium` is inert) apply to the alias too.
  expect(resolveLadder("deepseek/deepseek-chat", "deepseek/deepseek-v4-flash", host)).toEqual(
    resolveLadder("deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash", host),
  );
  expect(resolveLadder("deepseek/deepseek-chat", "deepseek/deepseek-v4-flash", host)).toEqual(["none", "low", "high"]);
});

// Sync owns updates and removals for models already on disk, but never
// creates: a new model goes through the missing-model issue flow, where its
// lab entry and provider card are authored and reviewed.
test("sync updates and removes existing models without opening backlog issues", () => {
  expect(aimlapi.skipCreates).toBe(true);
  expect(aimlapi.trackMissingModels).toBe(false);
  expect(aimlapi.deleteMissing).toBe(true);
});

test("lifecycle feed removes withdrawn and expired IDs, including aliases, but retains serving models", () => {
  const models = aimlapi.parseModels({
    data: ["withdrawn-alias", "expired", "future-sunset", "superseded-alias", "active"].map((id) => ({
      id,
      type: "openai/chat-completions",
    })),
    deprecations: [
      { id: "withdrawn", aliases: ["withdrawn-alias"], status: "withdrawn", shutdown_at: null },
      { id: "expired", aliases: [], status: "deprecated", shutdown_at: "2000-01-01" },
      { id: "future-sunset", aliases: [], status: "deprecated", shutdown_at: "2999-01-01" },
      { id: "superseded", aliases: ["superseded-alias"], status: "superseded", shutdown_at: null },
    ],
  });
  expect(models.map((model) => model.id)).toEqual(["future-sunset", "superseded-alias", "active"]);
  expect(models[0]?.deprecated).toBe(true);
  expect(models[1]?.deprecated).toBe(false);
  expect(models[2]?.deprecated).toBe(false);
});

test("the actual sync runner never admits aimlapi skips to issues, even with openIssues enabled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-aimlapi-issues-"));
  try {
    const result = await syncProvider({
      ...aimlapi,
      modelsDir: dir,
      async fetchModels() {
        return {
          data: [
            { id: "acme/unmapped", type: "openai/chat-completions" },
            {
              id: "openai/gpt-4",
              type: "openai/chat-completions",
              pricing: { units: [
                { name: "token", content: "text", origin: "provided", price: 1, per: 1_000_000 },
                { name: "token", content: "text", origin: "generated", price: 2, per: 1_000_000 },
              ] },
            },
          ],
        };
      },
    }, { dryRun: true, openIssues: true });
    expect(result.created).toBe(0);
    expect(result.notices.some((notice) => notice.includes("Would open GitHub issue"))).toBe(false);
    expect(result.notices.some((notice) => notice.includes("acme/unmapped"))).toBe(true);
    expect(result.notices.some((notice) => notice.includes("openai/gpt-4"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only chat candidates are reported for the missing-model issue flow", () => {
  const models = aimlapi.parseModels({
    data: [
      {
        id: "acme/chat-1",
        type: "openai/chat-completions",
        info: { name: "Chat 1" },
        modalities: { input: ["text"], output: ["text"] },
      },
      {
        id: "acme/image-1",
        type: "openai/image-generations",
        info: { name: "Image 1" },
        modalities: { input: ["text"], output: ["image"] },
      },
      {
        id: "anthropic/claude-opus-4.8",
        type: "openai/chat-completions",
        info: { name: "Claude Opus 4.8" },
        modalities: { input: ["text"], output: ["text"] },
      },
      {
        id: "anthropic/claude-opus-4-8",
        type: "openai/chat-completions",
        info: { name: "Claude Opus 4.8" },
        modalities: { input: ["text"], output: ["text"] },
      },
      {
        id: "anthropic/claude-opus-4.7-fast",
        type: "openai/chat-completions",
        info: { name: "Claude Opus 4.7 Fast" },
        modalities: { input: ["text"], output: ["text"] },
      },
    ],
  });
  const byID = new Map(models.map((model) => [model.id, model]));
  // A chat candidate a skip cannot fully populate is reported and routed to
  // an issue; intentional ignores (non-chat, alias duplicate, uncallable)
  // are neither, so sync can still delete those files when they go stale.
  expect(aimlapi.sourceID(byID.get("acme/chat-1")!)).toBe("acme/chat-1");
  expect(aimlapi.missingModelID(byID.get("acme/chat-1")!)).toBe("acme/chat-1");  expect(aimlapi.sourceID(byID.get("acme/image-1")!)).toBeUndefined();
  expect(aimlapi.missingModelID(byID.get("acme/image-1")!)).toBeUndefined();
  expect(aimlapi.sourceID(byID.get("anthropic/claude-opus-4-8")!)).toBeUndefined();
  expect(aimlapi.missingModelID(byID.get("anthropic/claude-opus-4-8")!)).toBeUndefined();
  expect(aimlapi.sourceID(byID.get("anthropic/claude-opus-4.7-fast")!)).toBeUndefined();
  expect(aimlapi.missingModelID(byID.get("anthropic/claude-opus-4.7-fast")!)).toBeUndefined();
});

test("a lab-backed model with no card and no statable control is reported, not issued", () => {
  // qwen3.7-max has a lab entry but publishes toggle/budget only, so sync
  // cannot state its thinking control on this host. An issue cannot fix
  // that; the model stays unlisted and is only reported. A candidate with
  // no lab entry at all (acme/chat-1 above) is issued, because an issue
  // can author the entry.
  const [model] = aimlapi.parseModels({
    data: [
      {
        id: "alibaba/qwen3.7-max",
        type: "openai/chat-completions",
        info: { name: "Qwen3.7 Max" },
        modalities: { input: ["text"], output: ["text"] },
      },
    ],
  });
  expect(aimlapi.sourceID(model!)).toBe("alibaba/qwen3.7-max");
  expect(aimlapi.missingModelID(model!)).toBeUndefined();
});

test("v2 files keep their mid-conversation flags, and the header cites them", () => {
  const [model] = aimlapi.parseModels({
    data: [{
      id: "openai/gpt-4o",
      type: "openai/chat-completions",
      info: { name: "GPT-4o", contextLength: 128_000, outputMax: 16_384 },
      modalities: { input: ["text", "image"], output: ["text"] },
      pricing: { units: [
        { name: "token", content: "text", origin: "provided", price: 4, per: 1_000_000 },
        { name: "token", content: "text", origin: "generated", price: 13, per: 1_000_000 },
        { name: "token", content: "text", origin: "cached", price: 1.625, per: 1_000_000 },
      ] },
    }],
  });
  const doc = {
    schema: 2,
    base_model: "openai/gpt-4o",
    capabilities: {
      structured_output: true,
      system_updates: false,
      effort_updates: false,
      tools: { supported: true, updates: false },
    },
    cost: { text: { input: { price: 3.25, cache: { read: 1.625 } }, output: { price: 13 } } },
  };
  const { id: _id, ...existing } = modelV2ToV1({ ...doc, id: "openai/gpt-4o" });
  const context = {
    existing: () => existing as ExistingModel,
    authored: () => existing as ExistingModel,
    v2: () => doc,
  };

  const translated = aimlapi.translateModel(model!, context) as { header?: string; model: Record<string, any> };
  expect(translated.header).toContain("effort_updates = false, tools.updates = false");
  expect(translated.header).toContain("docs-json?model=openai%2Fgpt-4o&endpoint=openai%2Fchat-completions");
  expect(translated.header).toContain("# system_updates = false:");
  expect(translated.header).not.toContain("# Cache:");
  const cached = aimlapi.translateModel(model!, {
    ...context,
    v2: () => ({ ...doc, capabilities: { ...doc.capabilities, cache: { supported: true, explicit: { ttl: ["5m", "1h"] } } } }),
  }) as { header?: string };
  expect(cached.header).toContain("# Cache: the chat-completions catalog row prices cache writes at 5m");
  // Model facts and the lab's description stay with the lab.
  for (const fact of ["family", "open_weights", "knowledge", "release_date", "last_updated", "description", "modalities"]) {
    expect(translated.model).not.toHaveProperty(fact);
  }

  // A price change patches the price and keeps the v2-only flags. The engine
  // carries structured_output over before patching, as it does here.
  const synced = preserveStructuredOutput(translated.model as never, existing as ExistingModel);
  const next = patchModelV2(doc, existing as ExistingModel, synced) as Record<string, any>;
  expect(next.cost.text.input.price).toBe(4);
  expect(next.capabilities).toMatchObject(doc.capabilities);

  // No flags in the file, no source lines for them.
  const bare = aimlapi.translateModel(model!, { ...context, v2: () => ({ schema: 2, base_model: "openai/gpt-4o" }) }) as { header?: string };
  expect(bare.header).toBeUndefined();
});
