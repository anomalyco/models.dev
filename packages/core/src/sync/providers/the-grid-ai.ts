import { z } from "zod";

import type { ExistingModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.thegrid.ai/v1/models";

export const TheGridAiModel = z
  .object({
    id: z.string().min(1),
    context_length: z.number().int().positive().nullable().optional(),
    max_input_tokens: z.number().int().positive().nullable().optional(),
    max_completion_tokens: z.number().int().positive().nullable().optional(),
    attachments: z.boolean().optional(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).optional(),
        output_modalities: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type TheGridAiModel = z.infer<typeof TheGridAiModel>;

export async function fetchTheGridAiModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`The Grid models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function parseTheGridAiModels(raw: unknown): TheGridAiModel[] {
  const rows = z.object({ data: z.array(TheGridAiModel).nonempty() }).parse(raw).data;
  if (new Set(rows.map((model) => model.id)).size !== rows.length) {
    throw new Error("The Grid returned duplicate model IDs");
  }
  return rows;
}

export function buildTheGridAiModel(model: TheGridAiModel, existing: ExistingModel): SyncedModel {
  // Tokens on The Grid trade on an open market, so `cost` is intentionally
  // omitted from the catalog (see providers/the-grid-ai/provider.toml). Only
  // the served limits, attachment support, and modalities are synced; pricing
  // and reasoning tiers stay hand-authored.
  const limit = {
    ...existing.limit,
    context: model.context_length ?? existing.limit?.context,
    input: model.max_input_tokens ?? existing.limit?.input,
    output: model.max_completion_tokens ?? existing.limit?.output,
  };
  const input = normalizeModalities(model.architecture?.input_modalities) ?? existing.modalities?.input;
  const output = normalizeModalities(model.architecture?.output_modalities) ?? existing.modalities?.output;
  const { base_model: baseModel, base_model_omit: omit, ...current } = existing;
  const values = {
    ...current,
    ...(model.attachments === undefined ? {} : { attachment: model.attachments }),
    limit,
    ...(input === undefined ? {} : { modalities: { input, output: output ?? ["text"] } }),
  } as Parameters<typeof factorBaseModel>[1];

  return baseModel === undefined ? (values as SyncedModel) : factorBaseModel(baseModel, values, limit, omit);
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

// Authored grid files end with the market-pricing note, and TOML rewrites do
// not preserve trailing comments, so seed the same explanation as a leading
// header. Existing leading comments win (authoritativeHeaders is not set).
function pricingHeader() {
  return [
    "# Tokens on The Grid trade on an open market, so cost is intentionally omitted",
    "# here; the live price is the `usd_per_1m_tokens` field of",
    "# https://api.thegrid.ai/v1/models.",
    "",
  ].join("\n");
}

function normalizeModalities(values: string[] | undefined): Modality[] | undefined {
  if (values === undefined) return undefined;
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  const unique = [...new Set(result)];
  if (unique.length === 0) return undefined;
  // Wire order is arbitrary; sort so rewrites for other reasons keep catalog order.
  const order: Modality[] = ["text", "image", "audio", "video", "pdf"];
  return unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export const theGridAi = {
  id: "the-grid-ai",
  name: "The Grid AI",
  modelsDir: "providers/the-grid-ai/models",
  // New instruments need hand-authored descriptions and the per-tier reasoning
  // enums from the instrument-specification docs, so unseen IDs open deduped
  // missing-model issues instead of being written from the catalog alone.
  skipCreates: true,
  trackMissingModels: true,
  // A truncated response must not delete files, and retired instruments also
  // drop out of the listing.
  deleteMissing: false,
  async fetchModels() {
    return fetchTheGridAiModels();
  },
  parseModels(raw) {
    return parseTheGridAiModels(raw);
  },
  sourceID(model) {
    return model.id;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return { id: model.id, model: buildTheGridAiModel(model, existing), header: pricingHeader() };
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} The Grid instruments have no local catalog file and were not created because their descriptions and reasoning tiers need hand-authoring: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local The Grid instruments are missing from the listing and were retained: ${paths.map((file) => `\`${file}\``).join(", ")}`,
    ];
  },
} satisfies SyncProvider<TheGridAiModel>;
