import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata } from "./openrouter.js";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

const API_ENDPOINT = "https://api.inference.net/v1/models";

const TOKENS_PER_PRICING_UNIT = 1_000_000;

const MIN_LIVE_MODELS = 20;

// Namespaced IDs whose namespace differs from the lab directory under models/.
const LAB_NAMESPACE: Record<string, string> = {
  "z-ai": "zhipuai",
};

// Most IDs carry no namespace; the lab is read from the model family prefix.
const LAB_BY_PREFIX: [prefix: string, lab: string][] = [
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
  ["gemini-", "google"],
  ["gemma-", "google"],
  ["deepseek-", "deepseek"],
  ["glm-", "zhipuai"],
  ["kimi-", "moonshotai"],
  ["grok-", "xai"],
  ["qwen", "alibaba"],
  ["llama-", "meta"],
  ["nemotron-", "nvidia"],
];

// Levels the catalog schema can describe; others are dropped so one new level
// cannot fail the whole sync.
const ReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Modalities the catalog schema can describe; others are dropped.
const Modality = z.enum(["text", "audio", "image", "video", "pdf"]);

const InferencePricing = z.object({
  prompt: z.string(),
  completion: z.string(),
  input_cache_read: z.string().optional(),
}).passthrough();

export const InferenceModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  // The endpoint omits limits and pricing it does not know.
  context_length: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  reasoning_efforts: z.array(z.string()).optional(),
  input_modalities: z.array(z.string()).optional(),
  pricing: InferencePricing.optional(),
}).passthrough();

export const InferenceResponse = z.object({
  object: z.literal("list"),
  data: z.array(InferenceModel),
}).passthrough();

export type InferenceModel = z.infer<typeof InferenceModel>;

export const inference = {
  id: "inference",
  name: "Inference",
  modelsDir: "providers/inference/models",
  // A create is only skipped when no lab entry exists to base it on.
  missingModelID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Inference models have no lab entry under models/ to base them on: `
        + ids.map((id) => `\`${id}\``).join(", "),
    ];
  },
  async fetchModels() {
    return fetchInferenceModels();
  },
  parseModels(raw) {
    return InferenceResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    // A live model the endpoint cannot price or bound is republished unchanged
    // rather than dropped, because dropping it would delete a served route.
    if (!isComplete(model)) {
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored as SyncedModel };
    }
    if (existing !== undefined) return { id: model.id, model: buildInferenceModel(model, existing) };
    const baseModel = labModelID(model.id);
    if (!existsSync(path.join(MODELS_DIR, `${baseModel}.toml`))) return undefined;
    return { id: model.id, model: buildInferenceModel(model, { base_model: baseModel } as ExistingModel) };
  },
} satisfies SyncProvider<InferenceModel>;

type CompleteInferenceModel = InferenceModel & Required<
  Pick<InferenceModel, "context_length" | "max_completion_tokens" | "pricing">
>;

function isComplete(model: InferenceModel): model is CompleteInferenceModel {
  return model.context_length !== undefined
    && model.max_completion_tokens !== undefined
    && model.pricing !== undefined;
}

export async function fetchInferenceModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Inference models request failed: ${response.status} ${response.statusText}`);
  }
  const parsed = InferenceResponse.parse(await response.json());
  if (parsed.data.length < MIN_LIVE_MODELS) {
    throw new Error(
      `Inference returned ${parsed.data.length} models, below the ${MIN_LIVE_MODELS} needed to`
        + ` distinguish a retirement from a truncated response`,
    );
  }
  return parsed;
}

export function labModelID(id: string): string {
  const lowered = id.toLowerCase();
  const separator = lowered.lastIndexOf("/");
  if (separator !== -1) {
    const namespace = lowered.slice(0, separator);
    return `${LAB_NAMESPACE[namespace] ?? namespace}${lowered.slice(separator)}`;
  }
  const lab = LAB_BY_PREFIX.find(([prefix]) => lowered.startsWith(prefix))?.[1];
  return lab === undefined ? lowered : `${lab}/${lowered}`;
}

// Pricing strings are USD per token; the catalog stores USD per million tokens.
function perMillion(value: string): number {
  return Number((Number(value) * TOKENS_PER_PRICING_UNIT).toFixed(6));
}

// The endpoint is authoritative for price, context window, input modalities,
// and reasoning controls on this host. `reasoning_efforts` is the exact set
// `reasoning_effort` accepts, with `none` turning reasoning off; routes without
// `none` are not known to expose a separate off switch, so no toggle is
// published. `max_completion_tokens` is advisory (several routes report the
// whole context window), so output only ever tightens the lab figure.
export function buildInferenceModel(model: CompleteInferenceModel, existing: ExistingModel): SyncedModel {
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const inherited = baseModel === undefined ? {} : modelMetadata(baseModel);

  const input = perMillion(model.pricing.prompt);
  // A cache price no lower than input is no discount, so it is not published.
  const cacheRead = model.pricing.input_cache_read === undefined
    ? undefined
    : perMillion(model.pricing.input_cache_read);
  // Cost is exactly what the endpoint meters; nothing authored survives, so a
  // price the host stops publishing is removed rather than left stale.
  const cost = {
    input,
    output: perMillion(model.pricing.completion),
    ...(cacheRead === undefined || cacheRead >= input ? {} : { cache_read: cacheRead }),
  };

  const labOutput = (inherited.limit as { output?: number } | undefined)?.output ?? Number.POSITIVE_INFINITY;
  const limit = {
    ...current.limit,
    context: model.context_length,
    output: Math.min(model.max_completion_tokens, model.context_length, labOutput),
  };

  const inputModalities = (model.input_modalities ?? []).filter(
    (modality): modality is z.infer<typeof Modality> => Modality.safeParse(modality).success,
  );
  const modalities = inputModalities.length === 0
    ? current.modalities
    : { ...current.modalities, input: inputModalities } as SyncedFullModel["modalities"];

  const reasons = (current.reasoning ?? inherited.reasoning) === true;
  const efforts = (model.reasoning_efforts ?? []).filter(
    (effort): effort is z.infer<typeof ReasoningEffort> => ReasoningEffort.safeParse(effort).success,
  );
  let reasoning: Pick<SyncedFullModel, "reasoning" | "reasoning_options">;
  if (efforts.some((effort) => effort !== "none")) {
    reasoning = { reasoning: true, reasoning_options: [{ type: "effort", values: efforts }] };
  } else if (!reasons) {
    reasoning = { reasoning: false, reasoning_options: undefined };
  } else if (current.reasoning_options !== undefined) {
    reasoning = { reasoning: true, reasoning_options: current.reasoning_options };
  } else {
    throw new MissingReasoningOptionsError(
      model.id,
      `reasoning model (base ${baseModel}) that Inference's /v1/models lists no reasoning_efforts`
        + " for; probe the route and author its reasoning_options by hand",
    );
  }

  const values = { ...current, cost, limit, modalities, ...reasoning } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
