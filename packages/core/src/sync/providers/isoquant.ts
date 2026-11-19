import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// Isoquant publishes its model catalog without authentication, including nano-USD
// prices, context/output limits and published reasoning efforts.
const API_ENDPOINT = "https://api.isoquant.ai/v1/models";

const NanoUsdPerToken = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === "string" ? value.trim() : value))
  .refine(
    (value) => typeof value === "number"
      ? Number.isFinite(value) && value >= 0
      : /^\d+(?:\.\d+)?$/.test(value),
    "Isoquant prices must be non-negative decimal numbers",
  )
  .transform((value) => Number(value));

// Nano USD per token to USD per million tokens.
const perMillion = (nanoUsdPerToken: number) => nanoUsdPerToken / 1_000;

const IsoquantReasoning = z
  .object({
    default_effort: z.string().nullish(),
    efforts: z.array(z.string()).nullish(),
  })
  .passthrough();

const IsoquantModel = z
  .object({
    id: z.string().min(1),
    isoquant: z
      .object({
        context_length: z.number().int().positive().nullish(),
        output_limit: z
          .object({
            max_tokens: z.number().int().positive().nullish(),
            policy: z.string().nullish(),
          })
          .passthrough()
          .nullish(),
        pricing: z
          .object({
            input_nano_usd_per_token: NanoUsdPerToken,
            output_nano_usd_per_token: NanoUsdPerToken,
            cached_input_nano_usd_per_token: NanoUsdPerToken.nullish(),
          })
          .passthrough(),
        reasoning: IsoquantReasoning.nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export const IsoquantResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(IsoquantModel).min(1, "Isoquant returned an empty catalog; refusing to sync"),
  })
  .passthrough()
  .refine(
    (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
    "Isoquant returned duplicate model IDs",
  );

export type IsoquantModel = z.infer<typeof IsoquantModel>;

export const isoquant = {
  id: "isoquant",
  name: "Isoquant",
  modelsDir: "providers/isoquant/models",
  // New models need hand-authored input formats, store support and tool details
  // that this module does not sync, so they open a missing-model issue.
  skipCreates: true,
  // The catalog is small, so entries absent from a response are retained instead
  // of removed; this also makes a truncated response harmless.
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Isoquant model${ids.length === 1 ? " was" : "s were"} not created because input formats, store support and tool details need hand-authored metadata.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Isoquant model${paths.length === 1 ? " was" : "s were"} not synced from the catalog and retained for manual review.`,
      `Retained local paths: ${paths.map((path) => `\`${path}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchIsoquantModels();
  },
  parseModels(raw) {
    return IsoquantResponse.parse(raw).data;
  },
  translateModel(model, context) {
    // An existing local file is always kept; incomplete local metadata throws
    // below instead of deleting the entry.
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildIsoquantModel(model, existing),
      v2Set: defaultEffortSet(model, existing),
    };
  },
} satisfies SyncProvider<IsoquantModel>;

export async function fetchIsoquantModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Isoquant models request failed: ${response.status} ${response.statusText}`);
  }
  return IsoquantResponse.parse(await response.json());
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];

// The catalog's efforts are the request values this host accepts, so they
// replace an authored effort list. Other authored controls are kept. An absent,
// empty or unknown value leaves the authored list untouched instead of
// inventing one, and both callers use the same resolved set so a default
// effort can only be published alongside a list that contains it.
function publishedEfforts(model: IsoquantModel) {
  const efforts = model.isoquant.reasoning?.efforts;
  if (efforts == null || efforts.length === 0) return undefined;
  if (!efforts.every((value) => EFFORT_ORDER.includes(value))) return undefined;
  return [...new Set(efforts)].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

function isoquantReasoningOptions(model: IsoquantModel, existing: ExistingModel) {
  const values = publishedEfforts(model);
  if (values === undefined) return existing.reasoning_options;
  const option = ReasoningOption.safeParse({ type: "effort", values });
  if (!option.success) return existing.reasoning_options;
  const merged = [
    ...(existing.reasoning_options ?? []).filter((entry) => entry.type !== "effort"),
    option.data,
  ];
  // An effort of "none" already disables reasoning, so a preserved toggle would
  // duplicate the off control and can make clients send contradictory fields.
  return option.data.values.includes("none")
    ? merged.filter((entry) => entry.type !== "toggle")
    : merged;
}

// The published default follows the same resolved list. When the catalog stops
// publishing a valid default, it is not written; a changed effort list drops the
// authored default rather than carrying a value the new list may not contain.
function defaultEffortSet(model: IsoquantModel, existing: ExistingModel) {
  if (existing.reasoning === false) return undefined;
  const value = model.isoquant.reasoning?.default_effort;
  const values = publishedEfforts(model);
  if (value == null || values === undefined || !values.includes(value)) return undefined;
  return { "capabilities.reasoning.default": { type: "effort", value } };
}

export function buildIsoquantModel(model: IsoquantModel, existing: ExistingModel): SyncedModel {
  if (existing.cost === undefined || existing.limit?.context === undefined) {
    throw new Error(`Isoquant model ${model.id} has incomplete local pricing or limits required for sync`);
  }
  const metadata = model.isoquant;
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const cost = {
    ...existing.cost,
    input: perMillion(metadata.pricing.input_nano_usd_per_token),
    output: perMillion(metadata.pricing.output_nano_usd_per_token),
    cache_read: metadata.pricing.cached_input_nano_usd_per_token == null
      ? undefined
      : perMillion(metadata.pricing.cached_input_nano_usd_per_token),
  };
  const limit = {
    ...existing.limit,
    context: metadata.context_length ?? existing.limit.context,
    // A host without a fixed output cap reports only `remaining_context`.
    output: metadata.output_limit?.max_tokens ?? existing.limit.output,
  };
  const values = {
    ...current,
    reasoning_options: isoquantReasoningOptions(model, existing),
    cost,
    limit,
  } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
