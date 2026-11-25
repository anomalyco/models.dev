import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  fetchTrustedRouterModels,
  FREEFORM_REJECTED,
  GPT5_FREEFORM_UNSTATED,
  isGpt5Plus,
  PROBED,
  PROBED_REASONING,
  labDocumentedKinds,
  labMimeInput,
  trustedrouter,
  TrustedRouterResponse,
  type TrustedRouterModel,
} from "../src/sync/providers/trustedrouter.js";

function model(overrides: Partial<TrustedRouterModel> = {}): TrustedRouterModel {
  return {
    id: "anthropic/claude-sonnet-4.5",
    name: "Anthropic: Claude Sonnet 4.5",
    created: 0,
    context_length: 1_000_000,
    architecture: { input_modalities: ["image", "text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000003165", completion: "0.000015825", input_cache_read: "0.0000003165" },
    top_provider: { context_length: 1_000_000, max_completion_tokens: null },
    supported_parameters: ["tools", "tool_choice", "temperature", "reasoning", "structured_outputs"],
    reasoning: { mandatory: false, supported_efforts: ["high", "low"] },
    trustedrouter: { route_kind: "model", internal_only: false, configuration_hidden: false, synthetic_monitor: false },
    ...overrides,
  };
}

const none = { existing: () => undefined, authored: () => undefined };

test("TrustedRouter is registered for scheduled sync and fetches its public catalog without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === trustedrouter.id)).toBe(true);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ data: [model()] });
  }) as unknown as typeof fetch;
  await fetchTrustedRouterModels(fetcher);
  expect(request!.url).toBe("https://api.trustedrouter.com/v1/models");
  expect(request!.headers.get("authorization")).toBeNull();

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  expect(fetchTrustedRouterModels(unavailable)).rejects.toThrow("503");
});

test("empty and duplicate inventories fail before any catalog writes", () => {
  expect(() => TrustedRouterResponse.parse({ data: [] })).toThrow("empty catalog");
  expect(() => TrustedRouterResponse.parse({ data: [model(), model()] })).toThrow("duplicate model IDs");
});

test("only public, tool-capable text chat models with prices are synced", () => {
  for (const source of [
    model({ supported_parameters: ["temperature"] }),
    model({ architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] } }),
    model({ pricing: {} }),
    model({ context_length: null }),
    model({ trustedrouter: { internal_only: true } }),
    model({ trustedrouter: { synthetic_monitor: true } }),
    model({ id: "example/unknown-chat" }),
  ]) {
    expect(trustedrouter.translateModel(source, none)).toBeUndefined();
  }
});

test("models factor onto the lab base and keep TrustedRouter's prices and published efforts", () => {
  const translated = trustedrouter.translateModel(model(), none)!;
  expect(translated.model).toMatchObject({
    base_model: "anthropic/claude-sonnet-4-5",
    cost: { input: 3.165, output: 15.825, cache_read: 0.3165 },
    reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }],
  });
});

test("an empty or missing effort list is on/off only, never an empty effort control", () => {
  for (const reasoning of [{ mandatory: false, supported_efforts: [] }, { mandatory: false, supported_efforts: null }]) {
    const translated = trustedrouter.translateModel(model({ reasoning }), none)!;
    expect((translated.model as { reasoning_options?: unknown }).reasoning_options).toEqual([{ type: "toggle" }]);
  }
});

test("trustedrouter/* routes keep their authored files and are never generated", () => {
  const route = model({ id: "trustedrouter/zdr", supported_parameters: [], trustedrouter: { route_kind: "zdr_pool" } });
  expect(trustedrouter.sourceID!(route)).toBe("trustedrouter/zdr");
  expect(trustedrouter.translateModel(route, none)).toBeUndefined();
  const authored = { name: "ZDR" } as never;
  expect(trustedrouter.translateModel(route, { existing: () => authored, authored: () => authored })).toEqual({
    id: "trustedrouter/zdr",
    model: authored,
    keepHeader: true,
  });
});

test("a hand-authored route file keeps its header through a sync", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-trustedrouter-route-"));
  try {
    const authored = await readFile(path.join(import.meta.dir, "../../../providers/trustedrouter/models/trustedrouter/zdr.toml"), "utf8");
    const header = "# Hand-authored routing alias; see https://trustedrouter.com/docs.\n";
    await mkdir(path.join(dir, "trustedrouter"));
    await Bun.write(path.join(dir, "trustedrouter/zdr.toml"), header + authored);
    const route = model({ id: "trustedrouter/zdr", supported_parameters: [], trustedrouter: { route_kind: "zdr_pool" } });
    const result = await syncProvider({ ...trustedrouter, modelsDir: dir, async fetchModels() { return { data: [route] }; } });
    expect(result.deleted).toBe(0);
    expect(await readFile(path.join(dir, "trustedrouter/zdr.toml"), "utf8")).toStartWith(header);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generic input kinds take the lab's MIME entries, and match the lab list by inheriting it", () => {
  const lab = ["text", "image/jpeg", "image/png", "application/pdf"];
  expect(labMimeInput(["text", "image"], lab)).toEqual(["text", "image/jpeg", "image/png"]);
  expect(labMimeInput(["text", "image", "pdf"], lab)).toBeUndefined();
  expect(labMimeInput(["text"], undefined)).toEqual(["text"]);
});

test("input kinds the lab does not document are dropped, never published as raw kinds", () => {
  const lab = ["text", "image/jpeg", "image/png", "application/pdf"];
  expect(labMimeInput(["text", "audio"], lab)).toEqual(["text"]);
  // A text-only lab (GLM 5.3) whose row lists `image` inherits the lab's list.
  expect(labMimeInput(["text", "image"], ["text"])).toBeUndefined();
  const glm = trustedrouter.translateModel(model({
    id: "z-ai/glm-5.3",
    name: "Z.ai: GLM 5.3",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"] },
  }), none)!;
  expect(JSON.stringify((glm.model as { modalities?: unknown }).modalities ?? {})).not.toContain("image");
  const input = glm.v2Set!["modalities.input"] as (current: unknown) => unknown;
  expect(input(["text", "image"])).toBeUndefined();
});

test("headers state the reasoning wire fields each file uses", () => {
  const header = trustedrouter.translateModel(model(), none)!.header!;
  expect(header).toContain("# Toggle: reasoning.enabled = true|false\n");
  expect(header).toContain("# Effort: reasoning.effort = low|high\n");
  const mandatory = trustedrouter.translateModel(
    model({ reasoning: { mandatory: true, supported_efforts: ["high"] } }),
    none,
  )!.header!;
  expect(mandatory).not.toContain("# Toggle:");
});

test("a passed-through reasoning parameter does not make a non-reasoning lab model a reasoner", () => {
  // Gemma 3 lists `reasoning` but publishes no controls; its lab file says it does not reason.
  const gemma = model({ id: "google/gemma-3-12b-it", name: "Google: Gemma 3 12B", reasoning: undefined });
  const translated = trustedrouter.translateModel(gemma, none)!.model as { reasoning?: boolean; reasoning_options?: unknown };
  expect(translated.reasoning).not.toBe(true);
  expect(translated.reasoning_options).toBeUndefined();
});

test("a row that omits reasoning does not make a reasoning lab model a non-reasoner", () => {
  // Hermes 4 405B's row lists only tools and max_tokens; its lab file says it reasons.
  const hermes = model({
    id: "NousResearch/Hermes-4-405B",
    name: "Hermes 4 405B",
    supported_parameters: ["tools", "max_tokens"],
    reasoning: undefined,
  });
  expect(() => trustedrouter.translateModel(hermes, none)).toThrow(MissingReasoningOptionsError);
  expect(() => trustedrouter.translateModel(hermes, none)).toThrow("the lab model reasons");
  // A non-reasoning lab model with the same row is still written, as a non-reasoner.
  const gemma = model({
    id: "google/gemma-3-12b-it",
    name: "Google: Gemma 3 12B",
    supported_parameters: ["tools", "max_tokens"],
    reasoning: undefined,
  });
  expect((trustedrouter.translateModel(gemma, none)!.model as { reasoning?: boolean }).reasoning).not.toBe(true);
});

test("a reasoner without stated controls is left for hand authoring, never written as always-on", () => {
  // No `reasoning` object: TrustedRouter states nothing (e.g. dashed Claude aliases OpenRouter has no metadata for).
  const alias = model({ id: "anthropic/claude-opus-4-7", name: "Anthropic: Claude Opus 4.7", reasoning: undefined });
  expect(() => trustedrouter.translateModel(alias, none)).toThrow(MissingReasoningOptionsError);
  // Mandatory with no efforts while the row still takes reasoning_effort (o3): contradictory, not always-on.
  const o4 = model({
    id: "openai/o4-mini",
    name: "OpenAI: o4 Mini",
    supported_parameters: ["tools", "reasoning", "reasoning_effort", "include_reasoning"],
    reasoning: { mandatory: true, supported_efforts: [] },
  });
  expect(() => trustedrouter.translateModel(o4, none)).toThrow("accepts reasoning_effort");
});

test("mandatory reasoning with no efforts on a row that refuses effort is an affirmative always-on claim", () => {
  const r1 = model({
    id: "deepseek/deepseek-r1-0528",
    name: "DeepSeek: R1 0528",
    supported_parameters: ["tools", "reasoning", "include_reasoning"],
    reasoning: { mandatory: true, supported_efforts: [] },
  });
  const translated = trustedrouter.translateModel(r1, none)!;
  // No controls from the module; the runner writes `reasoning = { supported = true }`.
  expect((translated.model as { reasoning_options?: unknown[] }).reasoning_options ?? []).toEqual([]);
  expect(translated.header).toContain("# Always-on: the object marks reasoning mandatory with no efforts");
  expect(translated.header).not.toContain("# Toggle:");
});

test("GPT-5+ OpenAI models are left for hand authoring: TrustedRouter states no freeform formats", () => {
  expect(isGpt5Plus("openai/gpt-5")).toBe(true);
  expect(isGpt5Plus("openai/gpt-5.4-mini")).toBe(true);
  expect(isGpt5Plus("openai/gpt-6.1-sol")).toBe(true);
  expect(isGpt5Plus("openai/gpt-4.1")).toBe(false);
  expect(isGpt5Plus("openai/gpt-oss-120b")).toBe(false);
  expect(isGpt5Plus("anthropic/claude-sonnet-4-5")).toBe(false);

  // gpt-5.4-pro (over the probe price cap) was not probed.
  const gpt = model({
    id: "openai/gpt-5.4-pro",
    name: "OpenAI: GPT-5.4 Pro",
    reasoning: { mandatory: true, supported_efforts: ["xhigh", "high", "medium"] },
  });
  expect(FREEFORM_REJECTED.has(gpt.id)).toBe(false);
  expect(() => trustedrouter.translateModel(gpt, none)).toThrow(MissingReasoningOptionsError);
  expect(() => trustedrouter.translateModel(gpt, none)).toThrow(GPT5_FREEFORM_UNSTATED);
  const gpt41 = trustedrouter.translateModel(model({ id: "openai/gpt-4.1", name: "OpenAI: GPT-4.1", reasoning: undefined, supported_parameters: ["tools"] }), none)!;
  expect(gpt41.id).toBe("openai/gpt-4.1");
  expect(gpt41.header).not.toContain("freeform");
});

test("rows that price cache reads publish the cache kind, Anthropic as explicit", () => {
  const anthropic = trustedrouter.translateModel(model(), none)!;
  const fill = (translated: { v2Set?: Record<string, unknown> }) =>
    (translated.v2Set?.["capabilities.cache"] as ((current: unknown) => unknown) | undefined)?.(undefined);
  expect(fill(anthropic)).toEqual({ explicit: true });
  expect(anthropic.header).toContain("# Cache: explicit;");

  const gpt = trustedrouter.translateModel(model({
    id: "openai/gpt-4.1",
    name: "OpenAI: GPT-4.1",
    supported_parameters: ["tools"],
    reasoning: undefined,
  }), none)!;
  expect(fill(gpt)).toEqual({ implicit: true });
  expect(gpt.header).toContain("# Cache: implicit;");

  const uncached = trustedrouter.translateModel(
    model({ pricing: { prompt: "0.000003", completion: "0.000015" } }),
    none,
  )!;
  expect(uncached.v2Set?.["capabilities.cache"]).toBeUndefined();
  expect(uncached.header).not.toContain("# Cache:");
});

test("a lab output cap above the row's context is bounded by that context", () => {
  // DeepSeek V3 0324's lab file allows 163,840 output tokens; TrustedRouter serves a 128,000-token context.
  const deepseek = model({
    id: "deepseek/deepseek-chat-v3-0324",
    name: "DeepSeek: DeepSeek V3 0324",
    context_length: 128_000,
    top_provider: { context_length: 128_000, max_completion_tokens: null },
    reasoning: undefined,
  });
  const translated = trustedrouter.translateModel(deepseek, none)!.model as { limit?: { context?: number; output?: number } };
  expect(translated.limit?.context).toBe(128_000);
  expect(translated.limit?.output).toBe(128_000);
});

test("GPT-5+ models whose custom tools were probed and rejected publish without freeform, citing the probe", () => {
  const gpt = trustedrouter.translateModel(model({
    id: "openai/gpt-5.4",
    name: "OpenAI: GPT-5.4",
    reasoning: { mandatory: false, supported_efforts: ["xhigh", "high", "medium", "low", "none"] },
  }), none)!;
  expect(JSON.stringify(gpt.model)).not.toContain("freeform");
  expect(JSON.stringify(gpt.v2Set ?? {})).not.toContain("freeform");
  expect((gpt.model as { reasoning_options?: unknown }).reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "medium", "high", "xhigh"] },
  ]);
  expect(gpt.header).toContain(`# tools.freeform left out: Chat Completions, the only API listed, rejects custom tools.`);
  expect(gpt.header).toContain(`501 not_supported_in_alpha on tools[0].type (live ${PROBED} on this model)`);
});

test("a probed toggle publishes the toggle for a row that omitted reasoning, with the probe in the header", () => {
  expect(PROBED_REASONING["qwen/qwen3.5-plus"]).toMatchObject({ mandatory: false });
  const qwen = model({
    id: "qwen/qwen3.5-plus",
    name: "Qwen: Qwen3.5 Plus",
    supported_parameters: ["tools", "max_tokens"],
    reasoning: undefined,
  });
  const translated = trustedrouter.translateModel(qwen, none)!;
  // The lab reasons, so the factored file inherits `supported` and adds the toggle.
  expect((translated.model as { reasoning?: boolean }).reasoning).not.toBe(false);
  expect((translated.model as { reasoning_options?: unknown }).reasoning_options).toEqual([{ type: "toggle" }]);
  expect(translated.header).toContain("# Toggle: reasoning.enabled = true|false\n");
  expect(translated.header).toContain(`# Reasoning probed live ${PROBED} on POST https://api.trustedrouter.com/v1/chat/completions:`);
  expect(translated.header).not.toContain("# Effort:");
});

test("probed provider-validated efforts replace a contradictory catalog object", () => {
  // o3's row marks reasoning mandatory with no efforts but takes reasoning_effort.
  const o3 = trustedrouter.translateModel(model({
    id: "openai/o3",
    name: "OpenAI: o3",
    supported_parameters: ["tools", "reasoning", "reasoning_effort", "include_reasoning"],
    reasoning: { mandatory: true, supported_efforts: [] },
  }), none)!;
  expect((o3.model as { reasoning_options?: unknown }).reasoning_options).toEqual([{ type: "effort", values: ["low", "medium", "high"] }]);
  expect(o3.header).toContain("# Effort: reasoning.effort = low|medium|high\n");
  expect(o3.header).not.toContain("# Toggle:");
});

test("a probed always-on model publishes no controls even though its row takes reasoning_effort", () => {
  const kimi = trustedrouter.translateModel(model({
    id: "moonshotai/kimi-k2.7-code",
    name: "MoonshotAI: Kimi K2.7 Code",
    supported_parameters: ["tools", "reasoning", "reasoning_effort", "include_reasoning"],
    reasoning: { mandatory: true, supported_efforts: [] },
  }), none)!;
  expect((kimi.model as { reasoning?: boolean }).reasoning).not.toBe(false);
  expect((kimi.model as { reasoning_options?: unknown[] }).reasoning_options ?? []).toEqual([]);
  expect(kimi.header).toContain("Always-on: reasoning came back on every request");
  expect(kimi.header).not.toContain("# Always-on: the object marks");
});

test("an OpenAI o-series row marked mandatory with no efforts is held back, not written as always-on", () => {
  const o3pro = model({
    id: "openai/o3-pro",
    name: "OpenAI: o3 Pro",
    supported_parameters: ["tools", "reasoning", "include_reasoning"],
    reasoning: { mandatory: true, supported_efforts: [] },
  });
  expect(PROBED_REASONING[o3pro.id]).toBeUndefined();
  expect(() => trustedrouter.translateModel(o3pro, none)).toThrow(MissingReasoningOptionsError);
  expect(() => trustedrouter.translateModel(o3pro, none)).toThrow("o-series");
});

test("models whose probes were inconclusive or failed to route stay held back", () => {
  for (const id of ["anthropic/claude-opus-4-7", "qwen/qwen3.8-max", "NousResearch/Hermes-4-405B"]) {
    expect(PROBED_REASONING[id]).toBeUndefined();
  }
  const opus = model({ id: "anthropic/claude-opus-4-7", name: "Anthropic: Claude Opus 4.7", reasoning: undefined });
  expect(() => trustedrouter.translateModel(opus, none)).toThrow(MissingReasoningOptionsError);
});

test("a hand-authored cache table survives a sync; the row's claim fills only a file with no cache kinds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-trustedrouter-cache-"));
  const dir = path.join(root, "providers", "trustedrouter", "models");
  const lab = "anthropic/claude-sonnet-4-5";
  try {
    // The runner resolves base_model against the models/ next to providers/.
    await mkdir(path.join(root, "models", "anthropic"), { recursive: true });
    await copyFile(path.join(import.meta.dir, "../../../models", `${lab}.toml`), path.join(root, "models", `${lab}.toml`));
    await mkdir(dir, { recursive: true });
    let source = model();
    const sync = () => syncProvider({ ...trustedrouter, modelsDir: dir, async fetchModels() { return { data: [source] }; } });
    expect((await sync()).created).toBe(1);
    const file = path.join(dir, "anthropic/claude-sonnet-4.5.toml");
    const created = Bun.TOML.parse(await readFile(file, "utf8")) as { capabilities?: { cache?: unknown } };
    expect(created.capabilities?.cache).toEqual({ explicit: true });

    const authored = (await readFile(file, "utf8"))
      .replace(/\[capabilities\.cache\]\nexplicit = true\n|cache = \{ explicit = true \}\n/, "")
      + "\n[capabilities.cache.explicit]\nttl = [\"5m\", \"1h\"]\nmax_breakpoints = 4\nmin_tokens = 1024\n";
    await Bun.write(file, authored);
    const before = Bun.TOML.parse(authored) as { capabilities?: { cache?: unknown } };
    expect(before.capabilities?.cache).toEqual({ explicit: { ttl: ["5m", "1h"], max_breakpoints: 4, min_tokens: 1024 } });

    // A price change forces a rewrite; the authored cache details ride through it.
    source = model({ pricing: { ...model().pricing, prompt: "0.000004" } });
    expect(await sync()).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    const after = Bun.TOML.parse(await readFile(file, "utf8")) as { capabilities?: { cache?: unknown }; cost?: { text?: { input?: { price?: number } } } };
    expect(after.cost?.text?.input?.price).toBe(4);
    expect(after.capabilities?.cache).toEqual({ explicit: { ttl: ["5m", "1h"], max_breakpoints: 4, min_tokens: 1024 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a probe stands in only while the row is unstated: a probed id whose row now states efforts publishes the catalog's", () => {
  expect(PROBED_REASONING["mistralai/mistral-large-4"]?.supported_efforts).toEqual(["high", "medium", "low"]);
  const translated = trustedrouter.translateModel(model({
    id: "mistralai/mistral-large-4",
    name: "Mistral: Mistral Large 4",
    pricing: { prompt: "0.000002", completion: "0.000006" },
    supported_parameters: ["tools", "reasoning", "reasoning_effort", "include_reasoning"],
    reasoning: { mandatory: false, supported_efforts: ["high", "low", "none"] },
  }), none)!;
  // `none` among the efforts is the off switch, so no separate toggle is written.
  expect((translated.model as { reasoning_options?: unknown }).reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "high"] },
  ]);
  expect(translated.header).toContain("# Effort: reasoning.effort = none|low|high\n");
  expect(translated.header).not.toContain("Reasoning probed live");
  expect(translated.header).toContain("TrustedRouter's published `reasoning` object");
});

test("the catalog's `file` input kind is PDF input, mapped to the lab's PDF entry", () => {
  const lab = ["text", "image/jpeg", "image/png", "application/pdf"];
  expect(labDocumentedKinds(["text", "file"], lab)).toEqual(["text", "file"]);
  expect(labDocumentedKinds(["text", "file"], ["text"])).toEqual(["text"]);
  expect(labMimeInput(["text", "file"], lab)).toEqual(["text", "application/pdf"]);
  expect(labMimeInput(["text", "image", "file"], lab)).toBeUndefined();
});

test("an update reads the MIME types already in the file as their kinds, so the list is kept", () => {
  const lab = ["text", "image/jpeg", "image/png", "application/pdf"];
  expect(labMimeInput(["text", "image/jpeg", "image/png"], lab)).toEqual(["text", "image/jpeg", "image/png"]);
  expect(labMimeInput(["text", "image/jpeg", "application/pdf"], lab)).toBeUndefined();
});
