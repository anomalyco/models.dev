import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { readdirSync } from "node:fs";
import path from "node:path";

import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.aiand.com/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// ai& serves open-weight models from several labs but prefixes them with its
// own organization labels. Map those labels to the canonical metadata namespace
// used in models/ so synced routes can factor onto shared base models.
const CANONICAL_PREFIX_ALIASES: Record<string, string> = {
  "deepseek-ai": "deepseek",
  qwen: "alibaba",
  "zai-org": "zhipuai",
};

const AiandModel = z.object({
  id: z.string(),
  object: z.literal("model"),
  name: z.string(),
  owned_by: z.string(),
  provider: z.string(),
  context_window: z.number().int().nonnegative(),
  capabilities: z.array(z.string()).default([]),
  description: z.string().nullable().optional(),
  currency: z.string(),
  input_per_1m: z.string(),
  output_per_1m: z.string(),
  created: z.number().int().nonnegative(),
}).passthrough();

const AiandResponse = z.object({
  object: z.literal("list"),
  data: z.array(AiandModel),
}).passthrough();

export type AiandModel = z.infer<typeof AiandModel>;

export const aiand = {
  id: "aiand",
  name: "ai&",
  modelsDir: "providers/aiand/models",
  // The endpoint is too thin to be authoritative for lifecycle (no output limit,
  // open_weights, temperature, etc.) and existing routes carry hand-probed
  // overrides. Never delete local TOMLs automatically.
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} ai& models were not created because they have no local file and no resolvable \`models/\` entry, and the API does not supply the required curated fields.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
      "Add a matching `models/<provider>/<model>.toml` entry (or a full provider TOML) to include them in the next sync.",
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local ai& models were absent from the live API and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.AIAND_API_KEY;
    if (key === undefined) throw new Error("ai& sync requires AIAND_API_KEY");
    const response = await fetch(API_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      throw new Error(`ai& models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return AiandResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    // ai&'s API is not rich enough to author complete standalone catalog rows
    // (no output limit, open_weights, temperature, structured_output, or full
    // reasoning controls). Only update existing routes or create factored routes
    // against known model metadata.
    if (existing === undefined && resolveAiandBaseModel(model) === undefined) {
      return undefined;
    }
    return {
      id: model.id,
      model: buildAiandModel(model, existing),
    };
  },
} satisfies SyncProvider<AiandModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(capabilities: Set<string>): { input: Modality[]; output: Modality[] } {
  const input: Modality[] = ["text"];
  if (capabilities.has("vision")) input.push("image");
  if (capabilities.has("video")) input.push("video");
  if (capabilities.has("document")) input.push("pdf");
  return { input: [...new Set(input)], output: ["text"] };
}

function resolveAiandBaseModel(model: AiandModel) {
  const prefix = CANONICAL_PREFIX_ALIASES[model.provider] ?? model.provider;
  const modelId = model.id.split("/").slice(1).join("/");
  if (metadataModelExists(prefix, modelId)) return `${prefix}/${modelId}`;
  return undefined;
}

const metadataFilesByProvider = new Map<string, Set<string>>();

function metadataModelExists(provider: string, modelId: string) {
  let files = metadataFilesByProvider.get(provider);
  if (files === undefined) {
    try {
      files = new Set(readdirSync(path.join(MODELS_DIR, provider)));
    } catch {
      files = new Set();
    }
    metadataFilesByProvider.set(provider, files);
  }
  return files.has(`${modelId}.toml`);
}

function inferFamily(model: AiandModel) {
  const kimiFamily = inferKimiFamily(model.id, model.name);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${model.id} ${model.name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

export function buildAiandModel(
  model: AiandModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const capabilities = new Set(model.capabilities.map((value) => value.toLowerCase()));
  const apiModalities = modalities(capabilities);
  const apiAttachment = apiModalities.input.some((value) => value !== "text");
  const reasoning = capabilities.has("reasoning");
  const toolCall = capabilities.has("tool_calling");
  const context = model.context_window;
  const canonical = resolveAiandBaseModel(model);

  // ai& reports prices in the org's billing currency. Only trust USD figures;
  // preserve existing cost for any other currency.
  const isUsd = model.currency.toLowerCase() === "usd";
  const inputPrice = isUsd ? price(model.input_per_1m) : undefined;
  const outputPrice = isUsd ? price(model.output_per_1m) : undefined;
  const cost = inputPrice !== undefined && outputPrice !== undefined
    ? {
        input: inputPrice,
        output: outputPrice,
        reasoning: existing?.cost?.reasoning,
        cache_read: existing?.cost?.cache_read,
        cache_write: existing?.cost?.cache_write,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;

  // The API only exposes a combined context window. Never infer input/output
  // limits from it; preserve authored values so we do not wipe output limits.
  const limit = {
    context,
    input: existing?.limit?.input,
    output: existing?.limit?.output,
  };

  const releaseDate = dateFromTimestamp(model.created);

  // Modalities are model-intrinsic and the ai& capability tags are too thin
  // to be additive authority. Preserve authored/existing values exactly; only
  // use API-derived modalities for brand-new standalone models.
  const { modalities: resolvedModalities, attachment: resolvedAttachment } = resolveModalities(
    existing,
    apiModalities,
    apiAttachment,
    canonical,
  );

  // Existing factored model: refresh cost and context only; keep all curated
  // capability/metadata overrides.
  if (existing?.base_model !== undefined) {
    return factorBaseModel(
      existing.base_model,
      {
        description: existing.description ?? describeModel({
          id: model.id,
          name: existing.name ?? humanizeName(model),
          family: existing.family,
          reasoning: existing.reasoning,
          tool_call: existing.tool_call,
          structured_output: existing.structured_output,
          open_weights: existing.open_weights,
          limit,
          modalities: resolvedModalities ?? apiModalities,
        }),
        reasoning: existing.reasoning,
        reasoning_options: existing.reasoning_options,
        temperature: existing.temperature,
        tool_call: existing.tool_call,
        structured_output: existing.structured_output,
        status: existing.status,
        interleaved: existing.interleaved,
        knowledge: existing.knowledge,
        limit,
        cost,
        ...(resolvedModalities !== undefined && {
          attachment: resolvedAttachment,
          modalities: resolvedModalities,
        }),
      },
      limit,
      existing.base_model_omit,
    );
  }

  // Existing full model: refresh cost and context; preserve all curated
  // capability/metadata, but merge API capability tags onto authored modalities.
  if (existing !== undefined) {
    return {
      name: existing.name ?? humanizeName(model),
      description: existing.description ?? model.description ?? describeModel({
        id: model.id,
        name: existing.name ?? humanizeName(model),
        family: existing.family,
        reasoning: existing.reasoning,
        tool_call: existing.tool_call,
        structured_output: existing.structured_output,
        open_weights: existing.open_weights,
        limit,
        modalities: resolvedModalities ?? apiModalities,
      }),
      family: existing.family,
      release_date: existing.release_date ?? releaseDate,
      last_updated: existing.last_updated ?? releaseDate,
      attachment: resolvedAttachment ?? apiAttachment,
      reasoning: existing.reasoning,
      reasoning_options: existing.reasoning_options,
      temperature: existing.temperature,
      tool_call: existing.tool_call,
      structured_output: existing.structured_output,
      knowledge: existing.knowledge,
      open_weights: existing.open_weights,
      status: existing.status,
      interleaved: existing.interleaved,
      cost,
      limit,
      modalities: resolvedModalities ?? apiModalities,
    } satisfies SyncedFullModel;
  }

  // New model with a reviewed metadata entry: factor it against the canonical
  // base so name/family/capability facts inherit from models/. Only cost and
  // context come from the API; everything else stays with the shared metadata.
  if (canonical !== undefined) {
    const factoredLimit = { context, input: undefined, output: undefined };
    return factorBaseModel(
      canonical,
      { limit: factoredLimit, cost },
      factoredLimit,
    );
  }

  // Best-effort fallback for unknown standalone models. This path is only
  // reachable in tests or manual calls; translateModel skips remote IDs with
  // no local file and no resolvable base_model so the hourly sync does not
  // author incomplete rows.
  return {
    name: humanizeName(model),
    description: model.description ?? describeModel({
      id: model.id,
      name: humanizeName(model),
      family: inferFamily(model),
      reasoning,
      tool_call: toolCall,
      structured_output: false,
      open_weights: false,
      limit,
      modalities: apiModalities,
    }),
    family: inferFamily(model),
    release_date: releaseDate,
    last_updated: releaseDate,
    attachment: apiAttachment,
    reasoning,
    reasoning_options: reasoning ? [] : undefined,
    temperature: false,
    tool_call: toolCall,
    structured_output: false,
    open_weights: false,
    cost,
    // The API only exposes a combined context window, so new models have no
    // authoritative output limit. Fall back to the context window so the model
    // satisfies AuthoredModel / ProviderModelLimit; this should be reviewed and
    // corrected by hand when the real output limit is known.
    limit: { ...limit, output: limit.output ?? context },
    modalities: apiModalities,
  } satisfies SyncedFullModel;
}

function resolveModalities(
  existing: ExistingModel | undefined,
  apiModalities: { input: Modality[]; output: Modality[] },
  apiAttachment: boolean,
  canonical: string | undefined,
): { modalities?: { input: Modality[]; output: Modality[] }; attachment?: boolean } {
  if (existing !== undefined) {
    // context.existing() returns the base-resolved model, so modalities and
    // attachment are always present. Pass them through unchanged; factorBaseModel
    // will strip values that match the shared metadata.
    return {
      modalities: existing.modalities,
      attachment: existing.attachment,
    };
  }
  // Factored routes inherit modalities from the shared base model.
  if (canonical !== undefined) {
    return {};
  }
  return {
    modalities: apiModalities,
    attachment: apiAttachment,
  };
}

function humanizeName(model: AiandModel) {
  const last = model.id.split("/").at(-1) ?? model.id;
  return last
    .replace(/[:._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
