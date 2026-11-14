import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Public and unauthenticated. `/v1/models/info` is the live card of every model
// Umans AI lists: limits, reasoning controls, the served weights and the price.
// `/v1/models/past` names the retired ids, which keep serving for a grace
// period after they leave the listing.
const API_BASE = "https://api.code.umans.ai/v1";

// The lineup is small; fewer listed models than this is a truncated response,
// not a wave of retirements.
const MIN_LIVE_MODELS = 3;

// Seat-gated experiments ("labs") that most users can't call.
const GATED_STAGES = new Set(["playground", "prerelease"]);

// Hugging Face organizations whose lab id differs under models/.
const LAB_NAMESPACE: Record<string, string> = {
  "deepseek-ai": "deepseek",
  qwen: "alibaba",
  "zai-org": "zhipuai",
};

// Precision suffixes on a served checkpoint's repo name that the lab id omits.
const PRECISION_SUFFIX = /-(fp8|nvfp4|mxfp4|int4|int8|awq|gptq)$/;

const UmansReasoning = z.object({
  supported: z.boolean(),
  can_disable: z.boolean().optional(),
  levels: z.array(z.string()).optional(),
}).passthrough();

export const UmansCard = z.object({
  display_name: z.string().optional(),
  stage: z.string().optional(),
  deprecation: z.object({
    sunset_date: z.string().optional(),
    replacement: z.string().optional(),
  }).passthrough().optional(),
  capabilities: z.object({
    context_window: z.number().int().positive(),
    max_completion_tokens: z.number().int().positive(),
    recommended_max_tokens: z.number().int().positive().optional(),
    supports_vision: z.union([z.boolean(), z.string()]).optional(),
    supports_tools: z.boolean().optional(),
    reasoning: UmansReasoning.optional(),
  }).passthrough(),
  weights: z.object({ hf_url: z.string().optional() }).passthrough().optional(),
  // USD per 1M tokens.
  pricing: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache_read: z.number().nonnegative().optional(),
    cache_write: z.number().nonnegative().optional(),
  }).passthrough().optional(),
}).passthrough();

const UmansInfoResponse = z.record(UmansCard);

const UmansPastEntry = z.object({
  retired_on: z.string().optional(),
  replacement: z.string().optional(),
  stage: z.string().optional(),
}).passthrough();

const UmansPastResponse = z.record(UmansPastEntry);

export type UmansCard = z.infer<typeof UmansCard>;

export type UmansSourceModel =
  | { id: string; listed: true; card: UmansCard }
  | { id: string; listed: false; past: z.infer<typeof UmansPastEntry> };

export async function fetchUmansModels(fetcher: typeof fetch = fetch) {
  const [info, past] = await Promise.all(
    ["models/info", "models/past"].map(async (route) => {
      const response = await fetcher(`${API_BASE}/${route}`);
      if (!response.ok) {
        throw new Error(`Umans AI /v1/${route} request failed: ${response.status} ${response.statusText}`);
      }
      return response.json();
    }),
  );
  return { info, past };
}

export function parseUmansModels(raw: unknown): UmansSourceModel[] {
  const { info, past } = z.object({ info: UmansInfoResponse, past: UmansPastResponse }).parse(raw);
  const listed = Object.entries(info);
  if (listed.length < MIN_LIVE_MODELS) {
    throw new Error(
      `Umans AI listed ${listed.length} models, below the ${MIN_LIVE_MODELS} needed to`
        + " distinguish a retirement from a truncated response",
    );
  }
  return [
    ...listed.map(([id, card]) => ({ id, listed: true as const, card })),
    ...Object.entries(past)
      .filter(([id]) => !(id in info))
      .map(([id, entry]) => ({ id, listed: false as const, past: entry })),
  ];
}

export function isGated(model: UmansSourceModel): boolean {
  const stage = model.listed ? model.card.stage : model.past.stage;
  return stage !== undefined && GATED_STAGES.has(stage);
}

// `https://huggingface.co/moonshotai/Kimi-K3.1-Pro` -> `moonshotai/kimi-k3.1-pro`.
export function labModelID(hfURL: string | undefined): string | undefined {
  if (hfURL === undefined) return undefined;
  const match = /^https:\/\/huggingface\.co\/([^/]+)\/([^/?#]+)/.exec(hfURL);
  if (match === null) return undefined;
  const namespace = match[1]!.toLowerCase();
  const repo = match[2]!.toLowerCase().replace(PRECISION_SUFFIX, "");
  return `${LAB_NAMESPACE[namespace] ?? namespace}/${repo}`;
}

function labExists(modelID: string | undefined): modelID is string {
  return modelID !== undefined && existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

// Effort values are the card's levels without `none`, which is how the API
// turns thinking off (the toggle), not an effort.
export function reasoningOptions(card: UmansCard): SyncedFullModel["reasoning_options"] {
  const reasoning = card.capabilities.reasoning;
  if (reasoning?.supported !== true) return undefined;
  const effort = (reasoning.levels ?? []).filter((level) => level !== "none");
  return [
    ...(reasoning.can_disable === true ? [{ type: "toggle" as const }] : []),
    ...(effort.length > 0 ? [{ type: "effort" as const, values: effort as never[] }] : []),
  ];
}

export function umansCost(card: UmansCard, plan: boolean): SyncedFullModel["cost"] | undefined {
  // The coding plan is flat-fee: every model it serves costs nothing per token.
  if (plan) return { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const pricing = card.pricing;
  if (pricing === undefined) return undefined;
  return {
    input: price(pricing.input),
    output: price(pricing.output),
    ...(pricing.cache_read === undefined ? {} : { cache_read: price(pricing.cache_read) }),
    ...(pricing.cache_write ? { cache_write: price(pricing.cache_write) } : {}),
  };
}

// The API 400s `max_tokens >= max_completion_tokens`, so the published output
// cap is the card's recommended budget (cap minus one unless it says lower).
export function umansLimit(card: UmansCard): SyncedFullModel["limit"] {
  const { context_window: context, max_completion_tokens: cap, recommended_max_tokens: recommended } =
    card.capabilities;
  return { context, output: Math.min(recommended ?? cap - 1, cap - 1) };
}

// The fields this API is authoritative for. Everything else in an existing file
// (name, modalities, API compatibility, comments) stays hand-authored.
function ownedFields(card: UmansCard, plan: boolean, existing: ExistingModel | undefined) {
  const options = reasoningOptions(card);
  return {
    reasoning: card.capabilities.reasoning?.supported === true,
    reasoning_options: options,
    tool_call: card.capabilities.supports_tools ?? existing?.tool_call ?? true,
    cost: umansCost(card, plan) ?? existing?.cost,
    limit: umansLimit(card),
    status: card.deprecation === undefined ? undefined : ("deprecated" as const),
  };
}

export function header(card: UmansCard): string {
  const reasoning = card.capabilities.reasoning;
  const effort = (reasoning?.levels ?? []).filter((level) => level !== "none");
  return [
    ...(reasoning?.can_disable === true
      ? ['Toggle: thinking.type = enabled|disabled (reasoning_effort = "none" also disables)']
      : []),
    ...(effort.length > 0 ? [`Effort: reasoning_effort = ${effort.join("|")}`] : []),
    `Synced from ${API_BASE}/models/info (limits, reasoning levels, served weights, price).`,
  ].map((line) => `# ${line}`).join("\n");
}

export function buildUmansModel(
  card: UmansCard,
  plan: boolean,
  existing: ExistingModel | undefined,
  authored: ExistingModel | undefined = existing,
): SyncedModel | undefined {
  const served = labModelID(card.weights?.hf_url);
  const owned = ownedFields(card, plan, existing);

  if (existing !== undefined) {
    // Start from the file's own fields, not the resolved model: when an alias
    // moves to new weights, values inherited from the old base must not turn
    // into overrides on the new one.
    const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = authored ?? existing;
    const values = { ...current, ...owned, limit: { ...current.limit, ...owned.limit } } as SyncedFullModel;
    // The card names the weights each id serves, so an alias that moves to new
    // weights moves its base_model with it.
    const base = labExists(served) ? served : baseModel;
    if (base === undefined) return values;
    return factorBaseModel(base, values, values.limit, base === baseModel ? baseModelOmit : undefined);
  }

  // A new id needs a lab entry to base it on.
  if (!labExists(served)) return undefined;
  const vision = card.capabilities.supports_vision === true;
  const values = {
    ...owned,
    // Chat completions return reasoning in `reasoning_content`, and every route
    // accepts JSON schema output.
    interleaved: owned.reasoning ? { field: "reasoning_content" as const } : undefined,
    structured_output: true,
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
  } as SyncedFullModel;
  return factorBaseModel(served, values, values.limit);
}

function umansProvider(id: string, name: string, plan: boolean) {
  return {
    id,
    name,
    modelsDir: `providers/${id}/models`,
    preserveBaseModels: false,
    // Retired ids keep serving through a grace period; they are marked
    // deprecated from /v1/models/past and removed by hand once they stop.
    deleteMissing: false,
    sourceID(model) {
      return model.listed && !isGated(model) ? model.id : undefined;
    },
    missingModelID(model) {
      return model.listed && !isGated(model) ? model.id : undefined;
    },
    skippedNotice(ids) {
      if (ids.length === 0) return [];
      return [
        `${ids.length} Umans AI models have no lab entry under models/ to base them on: `
          + ids.map((modelID) => `\`${modelID}\``).join(", "),
      ];
    },
    async fetchModels() {
      return fetchUmansModels();
    },
    parseModels(raw) {
      return parseUmansModels(raw);
    },
    translateModel(model, context) {
      if (isGated(model)) return undefined;
      if (!model.listed) {
        const authored = context.authored(model.id);
        if (authored === undefined) return undefined;
        return { id: model.id, model: { ...authored, status: "deprecated" } as SyncedModel };
      }
      const existing = context.existing(model.id);
      const built = buildUmansModel(model.card, plan, existing, context.authored(model.id));
      if (built === undefined) return undefined;
      // An existing header wins; files without one get the wire-path header.
      return { id: model.id, model: built, header: header(model.card) };
    },
  } satisfies SyncProvider<UmansSourceModel>;
}

export const umansAI = umansProvider("umans-ai", "Umans AI", false);
export const umansAICodingPlan = umansProvider("umans-ai-coding-plan", "Umans AI Coding Plan", true);

// The API returns floats like 0.028000000000000004.
function price(value: number): number {
  return Number(value.toFixed(6));
}
