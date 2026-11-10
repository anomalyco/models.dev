// AI/ML API: the public catalog (https://api.aimlapi.com/v1/models?include=pricing,modalities),
// the lifecycle feed (https://api.aimlapi.com/v1/models/deprecations) and each
// reasoning model's request schema (https://api.aimlapi.com/docs-json?model=<id>),
// which is the only place the host states which reasoning_effort values it takes.
// Only text-output chat-completions rows are synced; new models are reported,
// never created (the catalog can't state a lab model). Authoritative for files
// on disk: token and cache prices (cache write per TTL where the file's explicit
// cache lists them), the display name, the context window and output cap,
// deprecation, the reasoning field, and reasoning efforts: the schema's enum
// intersected with the lab's (or OpenRouter's) ladder, narrowed by the probes
// recorded below. Every file's leading comment is generated. Rows the host stops
// serving are deleted; a row sync can't state keeps its file.
//
// The probe evidence behind each table lives in the old module
// (packages/core/src/sync/providers/aimlapi.ts) with dates and token counts.

import path from "node:path";

import { z } from "zod";

import { readProviderModel } from "../../translate.js";
import { Labs, REPO_ROOT } from "../catalog.js";
import { fetchJSON } from "../http.js";
import { labHints } from "../labs.js";
import { getPath, isTable } from "../fields.js";
import type { Doc, Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.aimlapi.com/v1/models?include=pricing,modalities";
const DEPRECATIONS_ENDPOINT = "https://api.aimlapi.com/v1/models/deprecations";
const DOCS_ENDPOINT = "https://api.aimlapi.com/docs-json";
const CHAT_COMPLETIONS_TYPE = "openai/chat-completions";
const DOCS_CONCURRENCY = 8;

const EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];

// Listed with prices, but inference answers 404 "No endpoints found".
const NOT_CALLABLE = new Set(["anthropic/claude-opus-4.7-fast", "anthropic/claude-opus-4.8-fast", "sakana/sakana-namazu"]);

// reasoning_effort is validated (an invalid value is a 400) but the levels don't
// order reasoning tokens: published with no controls.
const EFFORT_VALIDATED_BUT_INERT = new Set([
  "moonshotai/kimi-k2-thinking",
  "z-ai/glm-4.7-flash",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.5",
  "alibaba/qwen3.6-max-preview",
  "google/gemma-4-31b-it",
  "xiaomi/mimo-v2.5-pro",
  "xiaomi/mimo-v2.5",
  "z-ai/glm-4.5v",
  "z-ai/glm-4.6v",
]);

// reasoning_effort is not read at all (an invalid value returns 200): no controls.
const EFFORT_NOT_HONOURED = new Set([
  "google/gemini-3.1-pro-preview",
  "google/gemma-4-26b-a4b-it",
  "z-ai/glm-5v-turbo",
  "z-ai/glm-5-turbo",
  "alibaba/qwen-plus",
]);

// Ladders measured to be accepted and honoured, where the schema says more.
const MEASURED_EFFORTS: Record<string, readonly string[]> = {
  "google/gemini-3.7-flash": ["low", "medium", "high", "max"],
  "google/gemini-3.6-flash": ["minimal", "low", "medium", "high", "max"],
  "openai/gpt-5.2-pro": ["medium", "high"],
  "openai/gpt-5.5-pro": ["medium", "high"],
  "openai/gpt-5.4-pro": ["medium", "high"],
  "alibaba/qwen3.8-max": ["low", "medium", "high"],
  "anthropic/claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "deepseek/deepseek-v4-pro": ["none", "low", "high"],
  "deepseek/deepseek-v4-pro-0813": ["none", "low", "high"],
  "openai/o1": ["low", "medium", "high"],
  "openai/o3-mini": ["low", "medium", "high"],
};

// The response field each model's reasoning arrives on (probed per ID).
const REASONING_CONTENT = [
  "alibaba/qwen3.5-flash", "alibaba/qwen3.6-27b", "alibaba/qwen3.6-35b-a3b", "alibaba/qwen3.6-max-preview", "alibaba/qwen3.7-max",
  "alibaba/qwen3.8-flash", "alibaba/qwen3.8-max", "anthropic/claude-fable-5", "anthropic/claude-sonnet-5", "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-vision-exp", "deepseek/deepseek-v4-pro", "moonshot/kimi-k3", "z-ai/glm-5.3-flash",
];
const REASONING_DETAILS = [
  "alibaba/qwen3.8-2.4t-a95b", "alibaba/qwen3.8-27b", "arcee-ai/trinity-large-thinking", "bytedance-seed/seed-2.0-code",
  "bytedance-seed/seed-2.0-lite", "bytedance-seed/seed-2.0-mini", "deepseek/deepseek-v4-pro-0813", "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3.1-pro-preview-customtools", "google/gemini-flash-latest", "inclusionai/ling-3.0-flash-fin", "meta/muse-glimmer-30b",
  "meta/muse-spark-1.1", "meta/muse-spark-1.2", "openai/gpt-5", "openai/gpt-5-mini", "openai/gpt-5-nano", "openai/gpt-5-pro",
  "openai/gpt-5.1-codex", "openai/gpt-5.1-codex-max", "openai/gpt-5.1-codex-mini", "openai/gpt-5.2-codex", "openai/gpt-5.2-pro",
  "openai/gpt-5.3-codex", "openai/gpt-5.4-pro", "openai/gpt-5.5-pro", "openai/gpt-5.6-luna-pro", "openai/gpt-5.6-sol-pro",
  "openai/gpt-5.6-terra-pro", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "openai/o1-pro", "openai/o3-pro", "poolside/laguna-s-2.1",
  "poolside/laguna-xs-2.1", "tencent/hy3", "tencent/hy4-preview", "thinkingmachines/inkling", "thinkingmachines/inkling-small",
  "xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5-pro", "z-ai/glm-4.5v", "z-ai/glm-4.6v", "z-ai/glm-4.7-flash",
];
const REASONING_FIELD: Record<string, string> = Object.fromEntries([
  ...REASONING_CONTENT.map((id) => [id, "reasoning_content"]),
  ...REASONING_DETAILS.map((id) => [id, "reasoning_details"]),
]);

// Dated snapshots, moving -latest aliases and duplicate spellings of published models.
const BLACKLISTED = new Set([
  "deepseek/deepseek-v4-flash-latest", "anthropic/claude-fable-latest", "openai/gpt-chat-latest", "anthropic/claude-haiku-latest",
  "anthropic/claude-sonnet-latest", "google/gemini-pro-latest", "moonshotai/kimi-latest", "openai/gpt-latest", "openai/gpt-mini-latest",
  "openai/gpt-5.5-2026-04-23", "anthropic/claude-opus-latest", "minimax/m2-7-20260402", "openai/gpt-5.4-2026-03-05",
  "alibaba/qwen3.5-plus-20260218", "minimax/m2-5-20260218", "minimax/m2-5-highspeed-20260218", "openai/gpt-5.2-2025-12-11",
  "openai/gpt-5.1-2025-11-13", "openai/gpt-5-2025-08-07", "openai/gpt-5-mini-2025-08-07", "openai/gpt-5-nano-2025-08-07",
  "openai/o3-2025-04-16", "openai/o4-mini-2025-04-16", "openai/gpt-4.1-2025-04-14", "openai/gpt-4.1-mini-2025-04-14",
  "openai/gpt-4.1-nano-2025-04-14", "openai/o3-mini-2025-01-31", "openai/o1-2024-12-17", "openai/gpt-4o-mini-2024-07-18",
  "openai/gpt-4-turbo-2024-04-09", "google/gemini-3-7-flash", "google/gemini-3-6-flash", "bytedance/seed-2-0-lite",
  "bytedance/seed-2-0-mini", "google/gemini-3-1-flash-lite-preview", "anthropic/claude-haiku-4-5-20251001",
  "anthropic/claude-sonnet-4-5-20250929", "anthropic/claude-opus-4-5-20251101", "openai/gpt-3.5-turbo-0125",
]);

// The host row's name and limits contradict the lab model it routes to.
const STALE_HOST_ROW = new Set(["deepseek/deepseek-chat"]);
// The host's display name is left over from a preview.
const STALE_HOST_NAME = new Set(["google/gemini-2.5-flash-lite"]);

const BASE_MODEL_OVERRIDES: Record<string, string> = {
  "deepseek/deepseek-chat": "deepseek/deepseek-v4-flash",
  "google/gemini-3-8-flash": "google/gemini-3.8-flash",
  "zhipu/glm-5.3": "zhipuai/glm-5.3",
  "bytedance-seed/seed-2-1-turbo": "bytedance-seed/seed-2.1-turbo",
  "x-ai/grok-4-6": "xai/grok-4.6",
  "x-ai/grok-4-5": "xai/grok-4.5",
  "moonshot/kimi-k2-7-code-highspeed": "moonshotai/kimi-k2.7-code-highspeed",
  "alibaba/glm-5.2": "zhipuai/glm-5.2",
  "zhipu/glm-5.2": "zhipuai/glm-5.2",
  "moonshot/kimi-k2-7-code": "moonshotai/kimi-k2.7-code",
  "x-ai/grok-build-0-1": "xai/grok-build-0.1",
  "x-ai/grok-4-3": "xai/grok-4.3",
  "bytedance/seed-2-0-pro": "bytedance-seed/seed-2.0-pro",
  "openai/gpt-5-5": "openai/gpt-5.5",
  "moonshot/kimi-k2-6": "moonshotai/kimi-k2.6",
  "x-ai/grok-4-20-0309-non-reasoning": "xai/grok-4.20-0309-non-reasoning",
  "x-ai/grok-4-20-0309-reasoning": "xai/grok-4.20-0309-reasoning",
  "zhipu/glm-5.1": "zhipuai/glm-5.1",
  "openai/gpt-5-4": "openai/gpt-5.4",
  "zhipu/glm-5": "zhipuai/glm-5",
  "upstage/solar-pro-3": "upstage/solar-pro3",
  "bytedance/seed-1-8": "bytedance-seed/seed-1-8",
  "bytedance-seed/seed-1.6": "bytedance-seed/seed-1-6",
  "bytedance-seed/seed-1.6-flash": "bytedance-seed/seed-1-6-flash",
  "zhipu/glm-4.7": "zhipuai/glm-4.7",
  "openai/gpt-5-2": "openai/gpt-5.2",
  "x-ai/grok-4-1-fast-reasoning": "xai/grok-4.1-fast-reasoning",
  "openai/gpt-5-1": "openai/gpt-5.1",
  "zhipu/glm-4.6": "zhipuai/glm-4.6",
  "zhipu/glm-4.5": "zhipuai/glm-4.5",
  "zhipu/glm-4.5-air": "zhipuai/glm-4.5-air",
  "minimax/m2-her": "minimax/MiniMax-M2-Her",
  "anthropic/claude-sonnet-4": "anthropic/claude-sonnet-4-20250514",
  "ibm-granite/granite-4.2-8b": "ibm/granite-4.2-8b",
  "ibm-granite/granite-4.0-h-micro": "ibm/granite-4-h-micro",
  "meta-llama/Llama-3.3-70B-Instruct-Turbo": "meta/llama-3.3-70b-instruct",
};

// IDs that answer as another host ID on the wire and share its measurements.
const WIRE_ALIAS_OF: Record<string, string> = { "deepseek/deepseek-chat": "deepseek/deepseek-v4-flash" };
const measuredAs = (id: string) => WIRE_ALIAS_OF[id] ?? id;

// `reasoning_effort = none` measured as a real off switch (0 reasoning tokens).
const NONE_IS_REAL_OFF = new Set([
  "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro-0813", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-vision-exp",
  "openai/gpt-5.3-codex", "openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-terra-pro",
  "anthropic/claude-opus-4.7", "anthropic/claude-opus-4.8",
]);

// Lab directories under providers/ for a metadata lab, and OpenRouter's directories for it.
// (A lab not listed uses its own name for both.)
const PROVIDER_DIRS: Record<string, string> = { meta: "llama", zhipuai: "zai" };
const OPENROUTER_DIRS: Record<string, string[]> = {
  alibaba: ["alibaba", "qwen"],
  meta: ["meta", "meta-llama"],
  mistral: ["mistralai"],
  moonshotai: ["moonshot", "moonshotai"],
  stepfun: ["stepfun", "stepfun-ai"],
  xai: ["x-ai", "xai", "spacexai"],
  zhipuai: ["zai", "z-ai", "zai-org"],
};

const CACHE_LINE = `# Cache: the chat-completions catalog row prices cache writes at 5m (cache_write) and 1h (cache_write_1h), and the request schema takes cache_control { type: ephemeral, ttl: 5m | 1h }. ${API_ENDPOINT}`;

const Unit = z.object({
  name: z.string().nullish(),
  content: z.string().nullish(),
  origin: z.string().nullish(),
  price: z.number().nullish(),
  per: z.number().nullish(),
}).passthrough();
type Unit = z.infer<typeof Unit>;

const Model = z.object({
  id: z.string().min(1),
  type: z.string().nullish(),
  info: z.object({ name: z.string().nullish(), contextLength: z.number().int().nonnegative().nullish(), outputMax: z.number().int().nonnegative().nullish() }).passthrough().nullish(),
  modalities: z.object({ input: z.array(z.string()).nullish(), output: z.array(z.string()).nullish() }).passthrough().nullish(),
  pricing: z.object({ units: z.array(Unit).nullish() }).passthrough().nullish(),
  // The host's accepted efforts, resolved against the lab ladder at fetch time.
  reasoningEffort: z.array(z.string()).nullish(),
}).passthrough();
type Model = z.infer<typeof Model>;

const Deprecation = z.object({
  id: z.string(),
  aliases: z.array(z.string()),
  status: z.enum(["deprecated", "superseded", "withdrawn"]),
  shutdown_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

const Raw = z.object({ data: z.array(Model).min(1), deprecations: z.array(Deprecation).optional() }).passthrough();

let labs: Labs | undefined;
const lab = (id: string) => (labs ??= new Labs(REPO_ROOT)).get(id);

export const aimlapi: SyncModule<unknown> = {
  id: "aimlapi",
  name: "AI/ML API",
  policy: {
    owns: [
      "name",
      "status",
      "limit.context",
      "limit.output",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.budget",
      "api.chat-completions.compatibility.reasoning_field",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
    ],
    creates: "never",
    removals: "delete",
    headers: "replace",
  },
  async fetch() {
    const [catalog, deprecations] = await Promise.all([
      fetchJSON(API_ENDPOINT, { source: "AI/ML API models" }),
      fetchJSON(DEPRECATIONS_ENDPOINT, { source: "AI/ML API deprecations" }),
    ]);
    const raw = { ...(catalog as Doc), deprecations: z.object({ data: z.array(Deprecation) }).parse(deprecations).data };
    const models = active(Raw.parse(raw));
    // Only models whose lab reasons need their schema read.
    const pending = models.chat.filter((model) => {
      const base = baseModelFor(model.id);
      return base !== undefined && lab(base) !== undefined && getPath(lab(base), "capabilities.reasoning.supported") === true;
    });
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(DOCS_CONCURRENCY, pending.length) }, async () => {
      while (cursor < pending.length) {
        const model = pending[cursor++]!;
        model.reasoningEffort = await reasoningEffort(model.id, baseModelFor(model.id)!);
      }
    }));
    return raw;
  },
  observe(raw) {
    const { chat } = active(Raw.parse(raw));
    return chat.map(observe);
  },
  refine(observation, file) {
    if (file === undefined) return observation;
    const base = typeof file.base_model === "string" ? file.base_model : baseModelFor(observation.id);
    if (base === undefined) return { id: observation.id, updateOnly: true };
    const extra = observed.get(observation.id)!;
    const reasons = getPath(lab(base), "capabilities.reasoning.supported") === true;
    let efforts: string[] | undefined;
    if (reasons && !EFFORT_NOT_HONOURED.has(measuredAs(observation.id)) && !EFFORT_VALIDATED_BUT_INERT.has(measuredAs(observation.id))) {
      efforts = extra.efforts;
      // A model that reasons with no effort the schema states is left as it is.
      if (efforts === undefined || efforts.length === 0) return { id: observation.id, updateOnly: true };
    }
    const prices = observation.cost?.text;
    // A row the host lists but doesn't price can't be written.
    if ((prices?.input?.price ?? getPath(file, "cost.text.input.price")) === undefined || (prices?.output?.price ?? getPath(file, "cost.text.output.price")) === undefined) {
      return { id: observation.id, updateOnly: true };
    }
    const write = cacheWrite(observation.id, extra.units, file.capabilities);
    const capabilities = file.capabilities;
    return {
      ...observation,
      header: () => header(observation.id, reasons && efforts === undefined, capabilities),
      capabilities: { reasoning: { effort: efforts ?? null, toggle: null, budget: null } },
      cost: { text: { ...prices, input: { ...prices?.input, cache: { ...prices?.input?.cache, write: write ?? null } } } },
    } as Observation;
  },
};

// What refine needs that isn't an observed field: resolved efforts and the raw price units.
const observed = new Map<string, { efforts?: string[]; units: Unit[] }>();

function active(raw: z.infer<typeof Raw>) {
  const retired = new Map((raw.deprecations ?? []).flatMap((entry) => [entry.id, ...entry.aliases].map((id) => [id, entry] as const)));
  const today = new Date().toISOString().slice(0, 10);
  const models = raw.data.flatMap((model) => {
    const entry = retired.get(model.id);
    if (entry?.status === "withdrawn") return [];
    if (entry?.status === "deprecated" && entry.shutdown_at !== null && entry.shutdown_at <= today) return [];
    // Superseded IDs still resolve; only a sunset removes them.
    return [{ ...model, deprecated: entry?.status === "deprecated" }];
  });
  // An ID served on a media surface too isn't a text chat model, whatever its chat row says.
  const media = new Set(models.filter((model) => kinds(model.modalities?.output).some((kind) => kind !== "text") && (model.modalities?.output ?? []).length > 0).map((model) => model.id));
  // A dashed ID with the same name as a dotted one in the same payload is an alias.
  const names = new Map(models.map((model) => [model.id, model.info?.name ?? undefined]));
  const alias = (id: string) => {
    const dotted = id.replace(/-(\d+)-(\d+)$/, "-$1.$2");
    return dotted !== id && names.has(dotted) && names.get(dotted) === names.get(id);
  };
  const chat = models.filter((model) => {
    if (BLACKLISTED.has(model.id) || NOT_CALLABLE.has(model.id) || alias(model.id)) return false;
    if (model.type !== CHAT_COMPLETIONS_TYPE || media.has(model.id)) return false;
    return kinds(model.modalities?.output).join() === "text";
  });
  return { chat };
}

function kinds(values: readonly string[] | null | undefined) {
  const seen = new Set((values ?? []).map((value) => value.toLowerCase()).filter((value) => ["text", "audio", "image", "video", "pdf"].includes(value)));
  return seen.size === 0 ? ["text"] : [...seen];
}

function observe(model: Model & { deprecated: boolean }): Observation {
  const units = model.pricing?.units ?? [];
  const info = model.info ?? {};
  const context = positive(info.contextLength);
  const output = positive(info.outputMax);
  const efforts = model.reasoningEffort?.filter((value) => EFFORT_VALUES.includes(value));
  observed.set(model.id, { efforts, units });
  const stale = STALE_HOST_ROW.has(model.id);
  const input = perMillion(units, "provided");
  const outputPrice = perMillion(units, "generated");
  const read = perMillion(units, "cached");
  return {
    id: model.id,
    ...(stale || STALE_HOST_NAME.has(model.id) || info.name == null ? {} : { name: info.name }),
    status: model.deprecated ? "deprecated" : null,
    ...(stale ? {} : { limit: { ...(context === undefined ? {} : { context }), ...(output === undefined ? {} : { output }) } }),
    api: { "chat-completions": { compatibility: { reasoning_field: REASONING_FIELD[measuredAs(model.id)] ?? null } } },
    cost: {
      text: {
        input: { ...(input === undefined ? {} : { price: input }), ...(read === undefined ? {} : { cache: { read } }) },
        output: outputPrice === undefined ? {} : { price: outputPrice },
      },
    },
  } as Observation;
}

const positive = (value: number | null | undefined) => (value != null && value > 0 ? value : undefined);

// `price` per `per` tokens of text, by origin: provided (input), generated (output), cached, cache_write[_<ttl>].
function perMillion(units: readonly Unit[], origin: string) {
  const unit = units.find((candidate) => candidate.name === "token" && candidate.content === "text" && candidate.origin === origin);
  if (!unit || unit.price == null || !unit.per) return undefined;
  return Math.round(((unit.price / unit.per) * 1_000_000) * 1e6) / 1e6;
}

// The default write price is the first TTL of the file's explicit cache, and
// `cache_write_<ttl>` prices the rest. Without a match, only the default is written.
function cacheWrite(id: string, units: readonly Unit[], capabilities: unknown) {
  const base = perMillion(units, "cache_write");
  const byTtl = new Map<string, number>();
  for (const unit of units) {
    const ttl = /^cache_write_(\d+(?:ms|s|m|h|d))$/.exec(unit.origin ?? "")?.[1];
    const price = ttl === undefined ? undefined : perMillion(units, unit.origin!);
    if (ttl !== undefined && price !== undefined) byTtl.set(ttl, price);
  }
  if (base === undefined || byTtl.size === 0) return base;
  const ttls = getPath(capabilities, "cache.explicit.ttl");
  const [first, ...rest] = Array.isArray(ttls) ? (ttls as string[]) : [];
  const matches = first !== undefined && !byTtl.has(first) && rest.length === byTtl.size && rest.every((ttl) => byTtl.has(ttl));
  if (!matches) return base;
  return Object.fromEntries([[first, base], ...rest.map((ttl) => [ttl, byTtl.get(ttl)!])]) as Record<string, number>;
}

// The leading comment, for cards whose control story isn't plain "lab ladder ∩ host enum".
function header(id: string, noControls: boolean, capabilities: unknown) {
  const measured = measuredAs(id);
  const lines: string[] = [];
  if (measured !== id) lines.push(`# Alias: answers "model" as ${measured.slice(measured.indexOf("/") + 1)}; measured through that id.`);
  if (noControls) {
    lines.push(
      EFFORT_NOT_HONOURED.has(measured)
        ? "# No caller control: reasoning_effort is not read (an invalid value returns 200),"
        : "# No caller control: reasoning_effort is validated (invalid value -> 400) but low/high",
      EFFORT_NOT_HONOURED.has(measured)
        ? "# and toggle/budget fields are dropped by the gateway (unknown top-level keys -> 200)."
        : "# do not order reasoning tokens; toggle/budget fields are dropped by the gateway.",
    );
  }
  if (NONE_IS_REAL_OFF.has(measured)) lines.push("# Off: reasoning_effort = none (0 reasoning tokens); no toggle field on this surface.");
  if (JSON.stringify(getPath(capabilities, "cache.explicit.ttl")) === JSON.stringify(["5m", "1h"])) lines.push(CACHE_LINE);
  return lines.join("\n");
}

function baseModelFor(id: string) {
  const override = BASE_MODEL_OVERRIDES[id];
  if (override !== undefined) return override;
  for (const hint of labHints(id)) {
    const found = (labs ??= new Labs(REPO_ROOT)).find(hint);
    if (found !== undefined) return found;
  }
  return undefined;
}

// The union of every reasoning_effort enum in the model's request schema,
// resolved against the lab's ladder. Undefined when the schema states none.
async function reasoningEffort(id: string, base: string) {
  let payload: unknown;
  try {
    payload = await fetchJSON(`${DOCS_ENDPOINT}?model=${encodeURIComponent(id)}&endpoint=${encodeURIComponent(CHAT_COMPLETIONS_TYPE)}`, { source: "AI/ML API docs" });
  } catch {
    return undefined;
  }
  if (EFFORT_NOT_HONOURED.has(measuredAs(id)) || EFFORT_VALIDATED_BUT_INERT.has(measuredAs(id))) return undefined;
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isTable(node)) return;
    const values = getPath(node, "reasoning_effort.enum");
    if (Array.isArray(values) && values.every((value) => typeof value === "string")) values.forEach((value) => found.add(value));
    Object.values(node).forEach(walk);
  };
  walk(payload);
  const host = [...found].filter((value) => EFFORT_VALUES.includes(value)).sort((a, b) => EFFORT_VALUES.indexOf(a) - EFFORT_VALUES.indexOf(b));
  return host.length === 0 ? undefined : resolveLadder(id, base, host);
}

// Lab ∩ host. `none` only where the lab lists it or a probe showed a real off
// switch; a measured ladder narrows the result. Undefined when the lab (or
// OpenRouter, failing it) has no effort ladder or none of its rungs is accepted.
export function resolveLadder(id: string, base: string, host: readonly string[]) {
  const ladder = labLadder(base);
  if (ladder.kind !== "effort") return undefined;
  let values = host.filter((value) => ladder.values.includes(value));
  if (values.length === 0) return undefined;
  const noneAllowed = (ladder.source === "lab" && ladder.values.includes("none")) || NONE_IS_REAL_OFF.has(measuredAs(id));
  if (!noneAllowed) values = values.filter((value) => value !== "none");
  else if (host.includes("none") && !values.includes("none")) values = ["none", ...values];
  const measured = MEASURED_EFFORTS[measuredAs(id)];
  if (measured) values = values.filter((value) => measured.includes(value));
  return values.length > 0 ? values : undefined;
}

type Ladder = { kind: "effort"; values: readonly string[]; source: "lab" | "peer" } | { kind: "no-effort" | "no-entry" };

// The effort ladder on the lab's first-party provider file (a dated snapshot
// borrows its undated model's), else on OpenRouter's file for the same model.
function labLadder(base: string): Ladder {
  const slash = base.indexOf("/");
  if (slash === -1) return { kind: "no-entry" };
  const metadataLab = base.slice(0, slash);
  const name = base.slice(slash + 1);
  const names = [...new Set([name, name.replace(/-\d{4}$/, "")])];
  for (const dir of new Set([PROVIDER_DIRS[metadataLab] ?? metadataLab, metadataLab])) {
    const own = readLadder(dir, names, "lab");
    if (own.kind !== "no-entry") return own;
  }
  const peers = (OPENROUTER_DIRS[metadataLab] ?? [metadataLab]).flatMap((dir) => names.map((candidate) => `${dir}/${candidate}`));
  return readLadder("openrouter", peers, "peer");
}

function readLadder(provider: string, ids: readonly string[], source: "lab" | "peer"): Ladder {
  for (const id of ids) {
    let model: Record<string, unknown>;
    try {
      model = readProviderModel(path.join(REPO_ROOT, "providers", provider, "models", `${id}.toml`));
    } catch {
      continue;
    }
    const options = model.reasoning_options;
    if (!Array.isArray(options)) return { kind: "no-entry" };
    const effort = options.find((option) => isTable(option) && option.type === "effort");
    return Array.isArray(effort?.values) ? { kind: "effort", values: effort.values as string[], source } : { kind: "no-effort" };
  }
  return { kind: "no-entry" };
}
