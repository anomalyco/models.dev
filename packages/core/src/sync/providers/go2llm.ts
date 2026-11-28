import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel, rawLabModel } from "./openrouter.js";

const PRICING_ENDPOINT = "https://go2llm.tech/api/pricing";
const MODELS_ENDPOINT = "https://api.go2llm.tech/v1/models";

const Price = z.number().finite().nonnegative();

// Token-priced models.
const TokenPrices = z
  .object({
    input: Price,
    output: Price,
    cacheRead: Price.optional(),
    cacheWrite: Price.optional(),
  })
  .passthrough();

// Image generation models quote a price per unit instead, e.g.
// `{ unit: "image", variants: { "size=1024x1024;quality=standard": { usdPerImage } } }`.
// They are not synced.
const PerUnitPrices = z
  .object({
    unit: z.string().min(1),
    variants: z.record(z.object({}).passthrough()),
  })
  .passthrough();

const CatalogModel = z
  .object({
    id: z.string(),
    lifecycle: z.string(),
    prices: z.record(z.unknown()),
  })
  .passthrough();

// The prices are only per-1M-token USD while the catalog says so; a change of
// unit must fail the run instead of being written as a price.
const PricingResponse = z
  .object({
    currency: z.literal("USD"),
    unitTokens: z.literal(1_000_000),
    version: z.number().int(),
    models: z.array(CatalogModel),
  })
  .passthrough();

const ServedModel = z
  .object({
    id: z.string(),
    modalities: z.object({ input: z.array(z.string()) }).passthrough(),
    max_prompt_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

const ModelsResponse = z.object({ data: z.array(ServedModel) }).passthrough();

export interface Go2llmModel {
  id: string;
  /** Undefined for a model that is not priced per token (image generation). */
  prices?: z.infer<typeof TokenPrices>;
  input: string[];
  maxPromptTokens?: number;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

export const go2llm = {
  id: "go2llm",
  name: "go2llm",
  modelsDir: "providers/go2llm/models",
  // Catalog ids include go2llm-specific variants (`*-tiered`, `*-low`) and
  // service models with no lab model of their own, and a file needs reasoning
  // controls the catalog doesn't state. New models are authored by hand.
  skipCreates: true,
  trackMissingModels: false,
  sourceID(model) {
    // Models priced per unit are skipped on purpose and not reported.
    return model.prices === undefined ? undefined : model.id;
  },
  missingModelID(model) {
    // A per-unit model is still published, so the runner keeps an existing
    // hand-authored file for it. trackMissingModels is false: no issue opens.
    return model.prices === undefined ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} published go2llm models have no local catalog file and were not created: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchGo2llmModels();
  },
  parseModels(raw) {
    return parseGo2llmModels(raw);
  },
  translateModel(model, context) {
    if (model.prices === undefined) return undefined;
    const existing = context.existing(model.id);
    const labInput = existing?.base_model === undefined
      ? undefined
      : (rawLabModel(existing.base_model)?.modalities as { input?: string[] } | undefined)?.input;
    return {
      id: model.id,
      model: buildGo2llmModel(model, existing),
      v2Set: { "modalities.input": (values: string[] | undefined) => exactInput(values, labInput) },
    };
  },
} satisfies SyncProvider<Go2llmModel>;

// A kind the file lists generically (a model that newly takes images) gets the
// lab's MIME types for that kind; exact entries already in the file are kept.
export function exactInput(values: string[] | undefined, labInput: string[] | undefined) {
  if (values === undefined || labInput === undefined) return values;
  return values.flatMap((value) => {
    if (value === "text" || value.includes("/")) return [value];
    const exact = labInput.filter((item) => item.includes("/") && kindOf(item) === value);
    return exact.length > 0 ? exact : [value];
  });
}

function kindOf(item: string) {
  return item === "application/pdf" ? "pdf" : item.split("/")[0]!;
}

export async function fetchGo2llmModels(fetcher: typeof fetch = fetch) {
  const [pricing, models] = await Promise.all([PRICING_ENDPOINT, MODELS_ENDPOINT].map(async (url) => {
    const response = await fetcher(url);
    if (!response.ok) {
      throw new Error(`go2llm request failed: ${url} ${response.status} ${response.statusText}`);
    }
    return response.json();
  }));
  return { pricing, models };
}

export function parseGo2llmModels(raw: unknown): Go2llmModel[] {
  const { pricing, models } = z.object({ pricing: z.unknown(), models: z.unknown() }).parse(raw);
  const catalog = PricingResponse.parse(pricing);
  const served = new Map(ModelsResponse.parse(models).data.map((model) => [model.id, model]));
  const published = catalog.models.filter((model) => model.lifecycle === "published");

  // The runner removes local files missing from the list, so an empty or
  // half-written catalog must fail the run rather than delete the provider.
  if (published.length === 0) throw new Error("go2llm pricing lists no published models");
  const unserved = published.filter((model) => !served.has(model.id)).map((model) => model.id);
  if (unserved.length > 0) {
    throw new Error(`go2llm pricing and /v1/models disagree; published but not served: ${unserved.join(", ")}`);
  }

  return published.map((model) => {
    const row = served.get(model.id)!;
    const prices = TokenPrices.safeParse(model.prices);
    // A row that is neither a token price nor a per-unit price is a bad row:
    // treating it as an image model would hide it.
    if (!prices.success && !PerUnitPrices.safeParse(model.prices).success) {
      throw new Error(`go2llm prices for ${model.id} are not valid: ${prices.error.message}`);
    }
    return {
      id: model.id,
      prices: prices.success ? prices.data : undefined,
      input: row.modalities.input,
      maxPromptTokens: row.max_prompt_tokens,
    };
  });
}

// The catalog owns prices, input modalities, `limit.input` and which models
// exist. Everything else in an existing file (base_model, reasoning controls,
// cache, output modalities, headers) is kept.
export function buildGo2llmModel(model: Go2llmModel, existing: ExistingModel | undefined): SyncedModel {
  const prices = model.prices!;
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing ?? {};
  const input = toModalities(model.id, model.input);

  // A cap at or above the served window narrows nothing.
  const context = current.limit?.context;
  const promptCap = model.maxPromptTokens !== undefined && (context === undefined || model.maxPromptTokens < context)
    ? model.maxPromptTokens
    : undefined;

  const values = {
    ...current,
    name: current.name ?? model.id,
    attachment: input.some((value) => value !== "text"),
    modalities: { input, output: current.modalities?.output ?? ["text"] },
    cost: {
      ...current.cost,
      input: prices.input,
      output: prices.output,
      // An unquoted cache price is not a free one; keep the file's.
      cache_read: prices.cacheRead ?? current.cost?.cache_read,
      cache_write: prices.cacheWrite ?? current.cost?.cache_write,
    },
    // Without a cap the file inherits the lab's limit.input.
    limit: { ...current.limit, input: promptCap },
  } as Parameters<typeof factorBaseModel>[1];

  return baseModel === undefined
    ? (values as SyncedModel)
    : factorBaseModel(baseModel, values, undefined, baseModelOmit);
}

// /v1/models lists the content types the gateway accepts; it rejects the rest
// with 400 (https://go2llm.tech/errors/400-unsupported-content-type).
function toModalities(id: string, values: string[]): Modality[] {
  const known = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = new Set<Modality>();
  for (const raw of values) {
    const value = raw.toLowerCase() === "file" ? "pdf" : raw.toLowerCase();
    if (!known.has(value as Modality)) throw new Error(`go2llm lists an unknown input modality for ${id}: ${raw}`);
    result.add(value as Modality);
  }
  if (!result.has("text")) throw new Error(`go2llm lists no text input for ${id}`);
  const order: Modality[] = ["text", "image", "audio", "video", "pdf"];
  return [...result].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
