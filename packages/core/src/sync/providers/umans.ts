import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
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

// Effort values the catalog schema knows, low to high. `none` is how the API
// turns thinking off (the toggle), not an effort.
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_ORDER)[number];

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
    // Older cards used a string ("via-handoff") for indirect vision: only an
    // explicit boolean is treated as a statement about image input.
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

function isEffort(level: string): level is Effort {
  return (EFFORT_ORDER as readonly string[]).includes(level);
}

// The controls the card publishes, or undefined when it publishes none (no
// `levels` list) or a level the schema doesn't know: absence is not "no caller
// control", so the caller keeps the authored controls. An explicit empty list
// with no toggle is written as `[]`.
export function reasoningOptions(card: UmansCard): SyncedFullModel["reasoning_options"] {
  const reasoning = card.capabilities.reasoning;
  if (reasoning?.supported !== true || reasoning.levels === undefined) return undefined;
  const efforts = reasoning.levels.filter((level) => level !== "none");
  if (!efforts.every(isEffort)) return undefined;
  const sorted = [...new Set(efforts)].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return [
    ...(reasoning.can_disable === true ? [{ type: "toggle" as const }] : []),
    ...(sorted.length > 0 ? [{ type: "effort" as const, values: sorted }] : []),
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

// Only what the card states. A field it leaves out is not written, so the
// file's own authored value (never the base-resolved one) stays.
function ownedFields(card: UmansCard, plan: boolean) {
  const { reasoning, supports_tools: tools } = card.capabilities;
  const options = reasoningOptions(card);
  const cost = umansCost(card, plan);
  return {
    ...(reasoning === undefined ? {} : { reasoning: reasoning.supported }),
    ...(options === undefined ? {} : { reasoning_options: options }),
    ...(tools === undefined ? {} : { tool_call: tools }),
    ...(cost === undefined ? {} : { cost }),
    limit: umansLimit(card),
    // A curated status survives a card that announces no retirement.
    ...(card.deprecation === undefined ? {} : { status: "deprecated" as const }),
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

function missingControls(id: string, card: UmansCard) {
  return new MissingReasoningOptionsError(
    id,
    "reasoning model whose /v1/models/info card publishes no schema-valid levels"
      + ` (${JSON.stringify(card.capabilities.reasoning?.levels ?? null)}); author its reasoning_options by hand`,
  );
}

export function buildUmansModel(
  id: string,
  card: UmansCard,
  plan: boolean,
  authored: ExistingModel | undefined,
): SyncedModel | undefined {
  const served = labModelID(card.weights?.hf_url);
  const owned = ownedFields(card, plan);
  const reasoner = card.capabilities.reasoning?.supported === true;

  if (authored !== undefined) {
    // Start from the file's own fields, not the resolved model: when an alias
    // moves to new weights, values inherited from the old base must not turn
    // into overrides on the new one.
    const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = authored;
    if (reasoner && owned.reasoning_options === undefined && current.reasoning_options === undefined) {
      throw missingControls(id, card);
    }
    const values = { ...current, ...owned, limit: { ...current.limit, ...owned.limit } } as SyncedFullModel;
    // The card names the weights each id serves, so an alias that moves to new
    // weights moves its base_model with it.
    const base = labExists(served) ? served : baseModel;
    if (base === undefined) return values;
    return factorBaseModel(base, values, values.limit, base === baseModel ? baseModelOmit : undefined);
  }

  // A new id needs a lab entry to base it on and a price to publish.
  if (!labExists(served) || owned.cost === undefined) return undefined;
  if (reasoner && owned.reasoning_options === undefined) throw missingControls(id, card);
  const values = {
    ...owned,
    // Chat completions return reasoning in `reasoning_content` (the provider
    // doc linked from providers/umans-ai/provider.toml).
    ...(reasoner ? { interleaved: { field: "reasoning_content" as const } } : {}),
    // Vision inherits the lab's documented inputs; only an explicit "no" narrows them.
    ...(card.capabilities.supports_vision === false ? { modalities: { input: ["text"] } } : {}),
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
        `${ids.length} Umans AI models have no lab entry under models/ or no published price: `
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
      const built = buildUmansModel(model.id, model.card, plan, context.authored(model.id));
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
