import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// RunInfra lists its hosted catalog on an authenticated OpenAI-compatible
// endpoint. Every entry is additive over OpenAI's Model object: prices are
// already USD per one million tokens, context_length is the served window the
// gateway actually accepts, and max_output_tokens is the ceiling the gateway
// enforces by rejection rather than clamping. The endpoint quotes standing
// rates only; a promotional free window never appears as a zero price.
//
// The remote id is the product slug (for example "deepseek-v4-flash") while
// the local TOML path is the served checkpoint id (for example
// "deepseek-ai/DeepSeek-V4-Flash-0731"). Every RunInfra TOML carries its slug
// in the leading "# Source: https://runinfra.ai/inference-api/<slug>" comment,
// so that header is the join key: the sync updates exactly the files that
// declare a slug the API listed, and a TOML without the header is unreachable
// by sync on purpose.
//
// The sync is authoritative for cost.input, cost.output, cost.cache_read,
// limit.context, and limit.output. Everything else (name overrides,
// reasoning_options, modalities, attachment, descriptions, base_model
// pointers, and the probe-evidence comment headers) stays hand-authored:
// those fields were verified by live probes and the list endpoint is not
// authoritative for them.

const API_ENDPOINT = "https://api.runinfra.ai/v1/models";

const PROVIDER_MODELS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "providers",
  "runinfra",
  "models",
);

const SOURCE_SLUG_COMMENT = /^#\s*Source:\s*https:\/\/runinfra\.ai\/inference-api\/([A-Za-z0-9-]+)\/?\s*$/;

// Exactly two members by design on the RunInfra side: anything else the
// provider wants to disclose about price sits beside this object, never in it.
const RunInfraPricing = z.object({
  input: z.number().positive(),
  output: z.number().positive(),
}).passthrough();

export const RunInfraModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  owned_by: z.string().min(1),
  created: z.number().int().nonnegative(),
  // Present only for hosted catalog entries whose replica has reported a
  // served window; the two keys are one value under two reader conventions.
  context_window: z.number().int().positive().optional(),
  context_length: z.number().int().positive().optional(),
  // Present only for hosted catalog entries. The caller workspace's own
  // deployments are listed on the same surface without a price line.
  pricing: RunInfraPricing.optional(),
  // Beside pricing, not inside it, and zero is a real value (cached input
  // that costs nothing). Absent means no cached tier is currently offered.
  cached_input_price_usd_per_mtok: z.number().nonnegative().optional(),
  // Gateway-wide enforced ceiling, published on every entry.
  max_output_tokens: z.number().int().positive(),
}).passthrough().refine(
  (model) => model.context_window === undefined
    || model.context_length === undefined
    || model.context_window === model.context_length,
  {
    message: "context_window and context_length must match when both are present",
    path: ["context_length"],
  },
);

export const RunInfraResponse = z.object({
  object: z.literal("list"),
  data: z.array(RunInfraModel),
}).passthrough();

export type RunInfraModel = z.infer<typeof RunInfraModel>;

let slugIndex: Map<string, string> | undefined;

export const runinfra = {
  id: "runinfra",
  name: "RunInfra",
  modelsDir: "providers/runinfra/models",
  // Hosted TOMLs are hand-authored with per-model probe evidence in their
  // leading comment blocks; the list endpoint alone cannot author one safely.
  skipCreates: true,
  // Make the intended issue behavior explicit instead of relying on the
  // runner's current default.
  trackMissingModels: true,
  // A hosted model in a temporary capacity pause drops out of the list
  // entirely, and key policy can scope what a given key sees. Retain local
  // models missing from the response instead of deleting authored records.
  deleteMissing: false,
  sourceID(model) {
    // Hosted catalog entries always publish a price line. Entries without one
    // are the sync key's own workspace deployments and are skipped silently.
    return model.pricing === undefined ? undefined : model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} RunInfra hosted models have no local TOML declaring their slug in a leading "# Source: https://runinfra.ai/inference-api/<slug>" comment, so they were not updated. New hosted models need a hand-authored TOML with probe evidence.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local RunInfra models were absent from the catalog response (typically a temporary capacity pause or a key-visibility change) and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((file) => `\`${file}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchRunInfraModels();
  },
  parseModels(raw) {
    slugIndex = buildSlugIndex();
    return RunInfraResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const modelID = (slugIndex ??= buildSlugIndex()).get(model.id);
    if (modelID === undefined) return undefined;
    const existing = context.existing(modelID);
    if (existing === undefined) return undefined;
    return {
      id: modelID,
      model: buildRunInfraModel(model, existing),
    };
  },
} satisfies SyncProvider<RunInfraModel>;

export async function fetchRunInfraModels(
  fetcher: typeof fetch = fetch,
  apiKey = process.env.RUNINFRA_API_KEY ?? process.env.RUNINFRA_GATEWAY_KEY,
) {
  if (!apiKey) {
    throw new Error("RUNINFRA_API_KEY (or RUNINFRA_GATEWAY_KEY) is required to sync RunInfra models");
  }
  const response = await fetcher(API_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`RunInfra models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Map each catalog slug to the local TOML id that declares it in its leading
 * "# Source:" comment. The header is the only place the slug and the served
 * checkpoint id meet, and the runner already preserves that comment block on
 * every rewrite, so the join key survives the sync it powers.
 */
export function buildSlugIndex(dir = PROVIDER_MODELS_DIR): Map<string, string> {
  const index = new Map<string, string>();
  for (const filePath of tomlFilesIn(dir)) {
    const slug = headerSlug(filePath);
    if (slug === undefined) continue;
    const modelID = path
      .relative(dir, filePath)
      .split(path.sep)
      .join("/")
      .slice(0, -".toml".length);
    const claimed = index.get(slug);
    if (claimed !== undefined && claimed !== modelID) {
      throw new Error(`Duplicate RunInfra source slug "${slug}" claimed by ${claimed} and ${modelID}`);
    }
    index.set(slug, modelID);
  }
  if (index.size === 0) {
    throw new Error(`No RunInfra source slugs were found under ${dir}`);
  }
  return index;
}

function tomlFilesIn(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  return entries.flatMap((entry) =>
    entry.isDirectory()
      ? tomlFilesIn(path.join(dir, entry.name))
      : entry.name.endsWith(".toml")
        ? [path.join(dir, entry.name)]
        : [],
  );
}

function headerSlug(filePath: string): string | undefined {
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("#")) break;
    const match = SOURCE_SLUG_COMMENT.exec(trimmed);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

export function buildRunInfraModel(
  model: RunInfraModel,
  existing: ExistingModel,
): SyncedModel {
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;

  const cost = buildCost(model, existing.cost);
  const limit = buildLimit(model, existing.limit);

  const values = {
    ...current,
    ...(cost !== undefined ? { cost } : {}),
    ...(limit !== undefined ? { limit } : {}),
  } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}

/**
 * API prices win when the API states them; authored prices survive when it
 * does not. The cached rate in particular is served through a server-side
 * gate that can suppress a real standing price while a deployment condition
 * is unmet, so an absent cached rate preserves the authored one instead of
 * deleting it. Retiring a cached tier for good is a hand edit by design.
 */
function buildCost(
  model: RunInfraModel,
  existingCost: ExistingModel["cost"],
): SyncedFullModel["cost"] {
  if (model.pricing === undefined) return existingCost as SyncedFullModel["cost"];
  return {
    ...existingCost,
    input: model.pricing.input,
    output: model.pricing.output,
    cache_read: model.cached_input_price_usd_per_mtok ?? existingCost?.cache_read,
  };
}

/**
 * The served context window and the enforced output ceiling. A registered
 * model whose replica has not reported a window publishes no context field,
 * so the authored (or base-model) value is preserved rather than dropped.
 */
function buildLimit(
  model: RunInfraModel,
  existingLimit: ExistingModel["limit"],
): SyncedFullModel["limit"] {
  const context = model.context_length ?? model.context_window ?? existingLimit?.context;
  const output = model.max_output_tokens;
  return {
    ...existingLimit,
    ...(context !== undefined ? { context } : {}),
    output,
  } as SyncedFullModel["limit"];
}
