import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://inference.maxlayer.cloud/v1/models";
const ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "..");
const MODELS_DIR = path.join(ROOT, "models");
const OPENROUTER_MODELS_DIR = path.join(ROOT, "providers", "openrouter", "models");

const Pricing = z
  .object({
    currency: z.string(),
    input_per_million_tokens: z.string().nullable().optional(),
    output_per_million_tokens: z.string().nullable().optional(),
    cached_input_per_million_tokens: z.string().nullable().optional(),
    cache_write_per_million_tokens: z.string().nullable().optional(),
  })
  .passthrough();

export const MaxlayerModel = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    category: z.string(),
    billing_mode: z.string(),
    context_window: z.number().nullable().optional(),
    max_output_tokens: z.number().nullable().optional(),
    pricing: Pricing.optional(),
  })
  .passthrough();

export const MaxlayerResponse = z
  .object({
    data: z.array(MaxlayerModel),
  })
  .passthrough();

export type MaxlayerModel = z.infer<typeof MaxlayerModel>;

/**
 * Maxlayer is an OpenRouter-fronted gateway. It routes every request to
 * OpenRouter and keeps OpenRouter's `publisher/model` IDs verbatim, so
 * `resolveCanonicalBaseModel` maps a Maxlayer ID onto the same canonical
 * metadata file the OpenRouter sync uses, and the sibling OpenRouter provider
 * TOML describes the same wire surface a Maxlayer request reaches.
 *
 * That inheritance is doing real work, because `GET /v1/models` here publishes
 * almost nothing about what a model *is*: one `category` string, and a
 * `capabilities` array that is empty on every synced row. There is no
 * `supported_parameters`, no modality list, no reasoning metadata. A model with
 * no canonical match is therefore skipped rather than authored from guesses.
 *
 * What this sync is authoritative for is price. Maxlayer's published rate is
 * the sell price — upstream's rate plus the credit fee and the platform markup,
 * derived on every read — so `pricing.input_per_million_tokens` is what a
 * customer is billed and is written to `[cost]` verbatim. The sibling
 * `base_*_per_million_tokens` fields carry upstream's own rate for display
 * only, and are deliberately not read here: quoting those would undercharge
 * every model on the list.
 */
export const maxlayer = {
  id: "maxlayer",
  name: "Maxlayer",
  modelsDir: "providers/maxlayer/models",
  trackMissingModels: true,
  deleteMissing: false,
  sourceID(model) {
    // Only rate-carded text models are catalog targets, so only those are worth
    // reporting when they are skipped. `upstream_cost` models (image, video,
    // multimodal embeddings) bill what the request actually cost and publish no
    // rate card at all, and plain embedding models are not in scope for this
    // provider yet — neither is a gap anyone should open an issue about.
    return isCatalogTarget(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    return ids.map(
      (id) =>
        `Maxlayer lists ${id} but no canonical model metadata matches it; ` +
        `add models/<lab>/<model>.toml before it can be synced.`,
    );
  },
  missingNotice(paths) {
    return paths.map(
      (file) => `Maxlayer no longer lists ${file}; review for manual deprecation or removal.`,
    );
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Maxlayer request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return MaxlayerResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (!isCatalogTarget(model)) return undefined;

    const existing = context.existing(model.id);
    const canonical = existing?.base_model ?? resolveCanonicalBaseModel(model.id);
    if (canonical === undefined) return undefined;

    const translated = buildMaxlayerModel(model, canonical, existing);
    return {
      id: model.id,
      model: translated,
      header: toggleHeader(translated),
    };
  },
} satisfies SyncProvider<MaxlayerModel>;

function isCatalogTarget(model: MaxlayerModel) {
  return model.billing_mode === "token" && model.category === "text";
}

// Every toggle needs the wire path on the file, and sync keeps only a leading
// block. The controls are OpenRouter's because that is the API a Maxlayer
// request reaches: the body is forwarded unchanged, so the field names a caller
// sends here are the ones OpenRouter documents. A hand-written header on an
// existing file always wins over this.
const TOGGLE_HEADER = `# Reasoning is controlled with OpenRouter's fields — Maxlayer forwards the
# request body unchanged.
# Toggle: reasoning.enabled = true|false
# Effort: reasoning.effort (top-level reasoning_effort is an alias)
# Budget: reasoning.max_tokens (integer reasoning tokens)
# https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
`;

function toggleHeader(model: SyncedModel) {
  return model.reasoning_options?.some((option) => option.type === "toggle")
    ? TOGGLE_HEADER
    : undefined;
}

/**
 * Rates arrive as decimal strings already denominated per million tokens, which
 * is the unit `[cost]` wants — unlike the per-token strings most gateway APIs
 * return. Null is meaningful and distinct from zero: it means the model
 * publishes no rate on that axis, so the field is left off rather than written
 * as free.
 */
function price(value: string | null | undefined) {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.round(number * 1_000_000) / 1_000_000;
}

interface SiblingCuration {
  reasoning_options?: SyncedFullModel["reasoning_options"];
  interleaved?: SyncedFullModel["interleaved"];
  output?: number;
}

const siblingCurationByID = new Map<string, SiblingCuration>();
const canonicalOutputLimitByID = new Map<string, number | undefined>();

/**
 * Reasoning controls and the reasoning side-channel come from the OpenRouter
 * provider file for the same ID. Maxlayer forwards the request body to
 * OpenRouter unchanged, so the controls a caller sends are OpenRouter's,
 * model-for-model — and `reasoning_options` is required on any resolved
 * provider model whose base declares `reasoning = true`, which nothing in
 * Maxlayer's own response could supply.
 */
function siblingCuration(modelID: string): SiblingCuration {
  let curation = siblingCurationByID.get(modelID);
  if (curation === undefined) {
    const filePath = path.join(OPENROUTER_MODELS_DIR, `${modelID}.toml`);
    const authored = existsSync(filePath)
      ? (Bun.TOML.parse(readFileSync(filePath, "utf8")) as SiblingCuration & {
          limit?: { output?: number };
        })
      : undefined;
    curation = {
      reasoning_options: authored?.reasoning_options?.length
        ? authored.reasoning_options
        : undefined,
      interleaved: authored?.interleaved,
      output: authored?.limit?.output,
    };
    siblingCurationByID.set(modelID, curation);
  }
  return curation;
}

/**
 * Whether the canonical metadata declares `limit.output`. Providers must
 * resolve both `limit.context` and `limit.output`, and 60-odd Maxlayer rows
 * publish a null `max_output_tokens`, so those need an inherited value to
 * exist before the file can validate.
 */
function canonicalOutputLimit(modelID: string) {
  if (!canonicalOutputLimitByID.has(modelID)) {
    const filePath = path.join(MODELS_DIR, `${modelID}.toml`);
    const metadata = existsSync(filePath)
      ? (Bun.TOML.parse(readFileSync(filePath, "utf8")) as { limit?: { output?: number } })
      : undefined;
    canonicalOutputLimitByID.set(modelID, metadata?.limit?.output);
  }
  return canonicalOutputLimitByID.get(modelID);
}

export function buildMaxlayerModel(
  model: MaxlayerModel,
  canonical: string,
  existing: ExistingModel | undefined,
): SyncedModel {
  const sibling = siblingCuration(model.id);
  const input = price(model.pricing?.input_per_million_tokens);
  const output = price(model.pricing?.output_per_million_tokens);

  const limit = {
    context: model.context_window ?? undefined,
    // Fall back to the sibling OpenRouter file only when the canonical metadata
    // has no output limit to inherit; when it does, `factorBaseModel` drops a
    // restated value and the file stays override-only.
    output:
      model.max_output_tokens ??
      (canonicalOutputLimit(canonical) === undefined ? sibling.output : undefined),
  };

  return factorBaseModel(
    canonical,
    {
      cost: {
        input: input ?? 0,
        output: output ?? 0,
        cache_read: price(model.pricing?.cached_input_per_million_tokens),
        cache_write: price(model.pricing?.cache_write_per_million_tokens),
      },
      limit,
      reasoning_options: existing?.reasoning_options ?? sibling.reasoning_options,
      interleaved: existing?.interleaved ?? sibling.interleaved,
    },
    limit,
    existing?.base_model === canonical ? existing.base_model_omit : undefined,
  );
}
