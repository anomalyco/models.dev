import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.verathos.ai/v1/models";

// USD per 1M tokens. A missing or negative price must fail the run, not be
// written as a free model.
const Price = z
  .object({
    usd_per_million_input_tokens: z.number().nonnegative(),
    usd_per_million_output_tokens: z.number().nonnegative(),
  })
  .passthrough();

export const VerathosModel = z
  .object({
    id: z.string(),
    max_state_tokens: z.number().int().optional(),
    input_modalities: z.array(z.string()).nullish(),
    price: Price.optional(),
    available: z.boolean().optional(),
  })
  .passthrough();

export const VerathosResponse = z.object({ data: z.array(VerathosModel) }).passthrough();

export type VerathosModel = z.infer<typeof VerathosModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

export const verathos = {
  id: "verathos",
  name: "Verathos",
  modelsDir: "providers/verathos/models",
  // The list has no name, description or lab facts, and every model needs a
  // decision-type lab entry first. Unseen ids are reported for a human to author.
  skipCreates: true,
  trackMissingModels: true,
  // The list is unauthenticated and an empty `data` passes the schema; one
  // truncated 200 must not delete the authored files.
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Verathos models have no local catalog file and were not created because the list carries no lab metadata; author a decision-type lab entry and a provider file: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Verathos models are missing from the public list and were retained; a human removes retired models: ${paths.map((path) => `\`${path}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchVerathosModels();
  },
  parseModels(raw) {
    return parseVerathosModels(raw);
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildVerathosModel(model, context.existing(model.id), context.authored(model.id)),
    };
  },
} satisfies SyncProvider<VerathosModel>;

export async function fetchVerathosModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Verathos models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function parseVerathosModels(raw: unknown): VerathosModel[] {
  const rows = VerathosResponse.parse(raw).data;
  // A row without an id maps to no file and would open a nameless missing-model issue.
  const unnamed = rows.filter((model) => model.id.trim() === "").length;
  if (unnamed > 0) console.warn(`verathos: ignored ${unnamed} model row(s) with an empty id`);
  return rows.filter((model) => model.id.trim() !== "");
}

export function buildVerathosModel(
  model: VerathosModel,
  existing: ExistingModel | undefined,
  authored?: ExistingModel,
): SyncedModel {
  // An absent, empty or unrecognised modality list means "not reported", not text-only.
  const input = normalizeModalities(model.input_modalities) ?? existing?.modalities?.input ?? ["text"];
  const output = existing?.modalities?.output ?? ["text"];

  // max_state_tokens is the largest state Verathos accepts (413 above it). A
  // non-positive value is a bad row, not a smaller window.
  const apiContext = model.max_state_tokens ?? 0;
  const limit = {
    context: apiContext > 0 ? apiContext : existing?.limit?.context ?? 0,
    input: existing?.limit?.input,
    // Decision models generate no text.
    output: existing?.limit?.output ?? 0,
  };

  const cost =
    model.price === undefined
      ? existing?.cost
      : {
          ...existing?.cost,
          input: round(model.price.usd_per_million_input_tokens),
          output: round(model.price.usd_per_million_output_tokens),
        };

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

  // An authored pointer wins: a resolver miss must not de-factor a committed file.
  const baseModel = authoredBase ?? resolveModelMetadataBaseModel(model.id);
  if (baseModel === undefined) return values as SyncedModel;
  const factored = factorBaseModel(baseModel, values, limit, baseModelOmit);
  // A v2 file's modalities (MIME types, output "decision") read as plain v1 values
  // equal to the lab's, so factoring drops them and the runner would delete the
  // table. While the list agrees with the authored values, keep them.
  if (authored?.modalities !== undefined && sameJSON(authored.modalities, values.modalities)) {
    return { ...factored, attachment: authored.attachment, modalities: authored.modalities } as SyncedModel;
  }
  return factored;
}

function sameJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Prices are already per-1M; round to micro-dollars so a float in the JSON
// never rewrites a file.
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function normalizeModalities(values: string[] | null | undefined): Modality[] | undefined {
  if (values === undefined || values === null) return undefined;
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .filter((value): value is Modality => allowed.has(value as Modality));
  const unique = [...new Set(result)];
  if (unique.length === 0) return undefined;
  // Wire order is arbitrary; sort so a rewrite for any other reason keeps catalogue order.
  const order: Modality[] = ["text", "image", "audio", "video", "pdf"];
  return unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
