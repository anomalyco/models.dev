import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.engy.ai/v1/models";

// Per-token USD, usually a string. An empty or non-numeric string must fail the
// run, not be written as a free model.
const Price = z.union([
  z.number().nonnegative(),
  z.string().regex(/^\d+(\.\d+)?(e[-+]?\d+)?$/i, "engy price is not a non-negative number"),
]);

const Pricing = z
  .object({
    prompt: Price.optional(),
    completion: Price.optional(),
    input_cache_read: Price.optional(),
  })
  .passthrough();

export const EngyModel = z
  .object({
    id: z.string(),
    pricing: Pricing.optional(),
    context_length: z.number().int().optional(),
    max_model_len: z.number().int().optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
  })
  .passthrough();

export const EngyResponse = z.object({ data: z.array(EngyModel) }).passthrough();

export type EngyModel = z.infer<typeof EngyModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

export const engy = {
  id: "engy",
  name: "engy",
  modelsDir: "providers/engy/models",
  // The public list omits the input/output split, so a created file would ship
  // limit.output = 0. Unseen ids are reported for a human to author.
  skipCreates: true,
  trackMissingModels: true,
  // The list is unauthenticated and an empty `data` passes the schema; one
  // truncated 200 must not delete the hand-measured files.
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} engy models have no local catalog file and were not created because the public list omits the input/output split; author them after measuring the cap: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local engy models are missing from the public list and were retained; a human removes retired models: ${paths.map((path) => `\`${path}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchEngyModels();
  },
  parseModels(raw) {
    return parseEngyModels(raw);
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildEngyModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<EngyModel>;

export async function fetchEngyModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`engy models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function parseEngyModels(raw: unknown): EngyModel[] {
  const rows = EngyResponse.parse(raw).data;
  // A row without an id maps to no file and would open a nameless missing-model issue.
  const unnamed = rows.filter((model) => model.id.trim() === "").length;
  if (unnamed > 0) console.warn(`engy: ignored ${unnamed} model row(s) with an empty id`);
  return rows.filter((model) => model.id.trim() !== "");
}

export function buildEngyModel(model: EngyModel, existing: ExistingModel | undefined): SyncedModel {
  // An absent, empty or unrecognised modality list means "not reported", not text-only.
  const input = normalizeModalities(model.input_modalities) ?? existing?.modalities?.input ?? ["text"];
  const output = normalizeModalities(model.output_modalities) ?? existing?.modalities?.output ?? ["text"];

  // A non-positive window is a bad row, not a smaller window.
  const apiContext = model.context_length ?? model.max_model_len ?? 0;
  const context = apiContext > 0 ? apiContext : existing?.limit?.context ?? 0;
  const authoredInput = existing?.limit?.input;
  const authoredOutput = existing?.limit?.output;
  if (apiContext > 0 && authoredInput !== undefined && authoredOutput !== undefined
    && apiContext !== authoredInput + authoredOutput) {
    // The new window means the authored split is stale, and the public list cannot
    // say which half moved. Leave the file alone and open an issue for a human.
    throw new MissingReasoningOptionsError(
      model.id,
      `engy's context_length is now ${apiContext}, but the authored limit.input + limit.output is ${authoredInput + authoredOutput}; re-read max_input_tokens and max_output_tokens from the authenticated https://engy.ai/api/v1/models`,
    );
  }
  const limit = {
    context,
    // engy's context is max_input + max_output, so the split stays hand-authored.
    input: existing?.limit?.input,
    output: existing?.limit?.output ?? 0,
  };

  const cost =
    model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined
      ? {
          ...existing?.cost,
          input: perMillion(model.pricing.prompt),
          output: perMillion(model.pricing.completion),
          cache_read:
            model.pricing.input_cache_read === undefined
              ? existing?.cost?.cache_read
              : perMillion(model.pricing.input_cache_read),
        }
      : existing?.cost;

  // Keep every authored field and overwrite only what the list is authoritative for.
  const { base_model: authoredBase, base_model_omit: baseModelOmit, ...current } = existing ?? {};
  const values = {
    ...current,
    name: current.name ?? model.id,
    attachment: input.some((value) => value !== "text"),
    cost,
    limit,
    modalities: { input, output },
  } as Parameters<typeof factorBaseModel>[1];

  // An authored pointer wins: a resolver miss (absent or ambiguous slug) must
  // not de-factor a committed file.
  const baseModel = authoredBase ?? resolveModelMetadataBaseModel(model.id);
  return baseModel === undefined
    ? (values as SyncedModel)
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}

// Wire prices are per-token USD strings. Two of them pick up float error when
// multiplied to per-1M (0.00000068 * 1e6), so round to micro-dollars.
function perMillion(value: string | number): number {
  return Math.round(Number(value) * 1_000_000 * 1e6) / 1e6;
}

function normalizeModalities(values: string[] | undefined): Modality[] | undefined {
  if (values === undefined) return undefined;
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => value === "file" ? "pdf" : value)
    .filter((value): value is Modality => allowed.has(value as Modality));
  const unique = [...new Set(result)];
  if (unique.length === 0) return undefined;
  // Wire order is arbitrary; sort so a rewrite for any other reason keeps catalogue order.
  const order: Modality[] = ["text", "image", "audio", "video", "pdf"];
  return unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
