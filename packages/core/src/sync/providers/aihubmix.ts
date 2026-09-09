import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://aihubmix.com/api/v1/models?type=llm";

/** AIHubMix quotes USD per 1M tokens directly, matching the catalog unit. */
const Pricing = z
  .object({
    input: z.number().nullish(),
    output: z.number().nullish(),
    cache_read: z.number().nullish(),
    cache_write: z.number().nullish(),
  })
  .passthrough();

export const AihubmixModel = z
  .object({
    model_id: z.string().min(1),
    model_name: z.string().nullish(),
    pricing: Pricing.nullish(),
    retire_stage: z.string().nullish(),
  })
  .passthrough();

export const AihubmixResponse = z
  .object({
    success: z.boolean().nullish(),
    data: z.array(AihubmixModel).min(1),
  })
  .passthrough();

export type AihubmixModel = z.infer<typeof AihubmixModel>;

/**
 * AIHubMix relays ~400 upstream models while the catalog curates a much smaller
 * hand-verified subset, so this sync only updates existing TOMLs
 * (`skipCreates`) and treats the AIHubMix endpoint as authoritative for pricing
 * and deprecation status only.
 *
 * Everything else in the authored TOMLs is preserved as hand-authored, because
 * the endpoint reports the relay's own conservative defaults rather than the
 * upstream model's real capabilities: `context_length` is capped per relay
 * (Claude Opus 4.6 reports 200K against its 1M window), `max_output` is quoted
 * per default request rather than per model, and `input_modalities` never lists
 * `pdf` even for models the provider does accept PDFs for. Its free-text
 * `features` list likewise mixes synonyms (`thinking` vs `reasoning`, `tools`
 * vs `tool_calling`) and never exposes accepted reasoning effort levels, so
 * capability flags, `reasoning_options`, `base_model` inheritance, and the
 * per-model `[provider]` protocol overrides all stay authored.
 *
 * Routing aliases such as `alicloud-glm-5.1` and `deep-deepseek-v4-pro` are
 * served but not listed by the endpoint, so local files missing from the
 * response are retained (`deleteMissing: false`).
 */
export const aihubmix = {
  id: "aihubmix",
  name: "AIHubMix",
  modelsDir: "providers/aihubmix/models",
  skipCreates: true,
  trackMissingModels: true,
  deleteMissing: false,
  sourceID(model) {
    // Deprecated relays are not catalog additions worth an issue.
    return model.retire_stage === "deprecated" ? undefined : model.model_id;
  },
  missingNotice(paths) {
    return paths.map(
      (file) =>
        `AIHubMix no longer lists ${file}; confirm it is still a served routing alias or deprecate it.`,
    );
  },
  async fetchModels() {
    const response = await fetch(process.env.AIHUBMIX_MODELS_URL ?? API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`AIHubMix models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return AihubmixResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const authored = context.authored(model.model_id);
    if (authored === undefined) return undefined;
    return {
      id: model.model_id,
      model: buildAihubmixModel(model, authored),
    };
  },
} satisfies SyncProvider<AihubmixModel>;

export function buildAihubmixModel(model: AihubmixModel, authored: ExistingModel): SyncedModel {
  const { id: _id, ...preserved } = authored;
  return {
    ...preserved,
    cost: buildCost(model.pricing, authored.cost),
    status: model.retire_stage === "deprecated" ? "deprecated" : authored.status,
  } as SyncedModel;
}

/**
 * AIHubMix omits a price field when the model has no such rate, but a partial
 * authored `[cost]` (tiers, reasoning, audio rates) still carries values the
 * endpoint does not model, so those are kept.
 */
function buildCost(
  pricing: AihubmixModel["pricing"],
  authored: ExistingModel["cost"],
): SyncedFullModel["cost"] {
  if (pricing == null) return authored;
  const input = price(pricing.input);
  const output = price(pricing.output);
  if (input === undefined || output === undefined) return authored;

  const cacheRead = price(pricing.cache_read);
  return {
    ...authored,
    input,
    output,
    // AIHubMix echoes the input price into `cache_read` for models it has no
    // cached rate for (35 of the 301 priced entries carry a nonzero price this
    // way; 51 more are free models reporting 0 across the board, where this is
    // a no-op), so an equal value means "not quoted" rather than "cached reads
    // cost full price" — taking it literally would overstate e.g. Gemini 3.1
    // Flash Lite by 10x against the $0.025 every other provider lists.
    cache_read: cacheRead === input ? authored?.cache_read : (cacheRead ?? authored?.cache_read),
    cache_write: price(pricing.cache_write) ?? authored?.cache_write,
  };
}

function price(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000) / 1_000_000;
}
