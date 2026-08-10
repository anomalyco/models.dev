import { z } from "zod";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  ExistingModel,
  SyncProvider,
  SyncedFullModel,
  SyncedModel,
} from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const INTL_API_ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/models";
const BASE_PREFIX = "alibaba";
const API_PAGE_SIZE = 100;
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const modelMetadataByID = new Map<string, Record<string, unknown>>();

function baseModelMetadata(modelID: string): Record<string, unknown> {
  let metadata = modelMetadataByID.get(modelID);
  if (metadata === undefined) {
    metadata = Bun.TOML.parse(
      readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8"),
    ) as Record<string, unknown>;
    modelMetadataByID.set(modelID, metadata);
  }
  return metadata;
}

function resolveAlibabaBaseModel(modelID: string): string | undefined {
  const candidate = `${BASE_PREFIX}/${modelID}`;
  return canonicalExists(candidate) ? candidate : undefined;
}

function canonicalExists(candidate: string): boolean {
  const file = path.join(MODELS_DIR, `${candidate}.toml`);
  if (!existsSync(file)) return false;
  try {
    return readdirSync(path.dirname(file)).includes(path.basename(file));
  } catch {
    return false;
  }
}

const AlibabaPrice = z
  .object({
    type: z.string(),
    price: z.string(),
    price_unit: z.string(),
    price_name: z.string(),
    time_band: z.string().nullable().optional(),
  })
  .passthrough();

const AlibabaPriceRange = z
  .object({
    range_name: z.string(),
    prices: z.array(AlibabaPrice),
  })
  .passthrough();

const AlibabaModelInfo = z
  .object({
    context_window: z.number().int().nonnegative().nullable(),
    max_input_tokens: z.number().int().nonnegative().nullable(),
    max_output_tokens: z.number().int().nonnegative().nullable(),
    max_reasoning_tokens: z.number().int().nonnegative().nullable(),
    reasoning_max_input_tokens: z.number().int().nonnegative().nullable(),
    reasoning_max_output_tokens: z.number().int().nonnegative().nullable(),
  })
  .passthrough();

const AlibabaInferenceMetadata = z
  .object({
    request_modality: z.array(z.string()).optional(),
    response_modality: z.array(z.string()).optional(),
  })
  .passthrough();

const AlibabaModel = z
  .object({
    model: z.string(),
    name: z.string(),
    description: z.string(),
    features: z.array(z.string()),
    prices: z.array(AlibabaPriceRange),
    provider: z.string().nullable(),
    capabilities: z.array(z.string()),
    published_time: z.string(),
    inference_metadata: AlibabaInferenceMetadata,
    model_info: AlibabaModelInfo,
    inference_offline_info: z
      .object({
        announceUrl: z.string().optional(),
        offlineTime: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const AlibabaCatalogResponse = z
  .object({
    code: z.string().nullable(),
    message: z.string().nullable(),
    success: z.boolean(),
    output: z
      .object({
        total: z.number().int().nonnegative(),
        page_no: z.number().int().positive(),
        page_size: z.number().int().positive(),
        models: z.array(AlibabaModel),
      })
      .passthrough(),
  })
  .passthrough();

// Light envelope for pagination: validates transport/success fields without
// re-validating model bodies. parseModels does the single full
// AlibabaCatalogResponse parse so each model is validated exactly once.
const AlibabaCatalogPage = z
  .object({
    code: z.string().nullable(),
    message: z.string().nullable(),
    success: z.boolean(),
    output: z
      .object({
        total: z.number().int().nonnegative(),
        page_no: z.number().int().positive(),
        page_size: z.number().int().positive(),
        models: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

export type AlibabaModel = z.infer<typeof AlibabaModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

type Cost = NonNullable<ExistingModel["cost"]>;
type CostTier = NonNullable<Cost["tiers"]>[number];

export const alibaba = {
  id: "alibaba",
  name: "Alibaba",
  modelsDir: "providers/alibaba/models",
  // skipCreates stays false: new models with a matching
  // models/alibaba/<id>.toml base file are auto-minted as thin
  // stubs. Models without a base match are skipped by translateModel.
  deleteMissing: false,
  sourceID(model) {
    return model.model;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Alibaba models returned by the source were not created because no matching \`models/alibaba/<id>.toml\` base-metadata file exists for them. The DashScope API does not authoritatively expose \`family\`, \`temperature\`, \`open_weights\`, or \`knowledge\`, so a base-metadata file is required to mint a thin provider stub via inheritance. Add the file to enable auto-creation. Existing models are still updated from source-authoritative fields.`,
      "Skipped remote IDs:",
      ...ids.map((id) => `\`${id}\``),
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Alibaba model files were retained even though they were missing from the source. This is intentional because the current source snapshot is for the international deployment and the provider directory still contains deprecated or region-specific entries.`,
      `Retained local files: ${paths.map((path) => `\`${path}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const apiKey = process.env.ALIBABA_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error("ALIBABA_API_KEY is required to sync Alibaba models");
    }

    const first = await fetchModelsPage(INTL_API_ENDPOINT, apiKey, 1);
    const models = [...first.output.models];
    const totalPages = Math.ceil(first.output.total / first.output.page_size);

    for (
      let pageNo = first.output.page_no + 1;
      pageNo <= totalPages;
      pageNo++
    ) {
      const page = await fetchModelsPage(INTL_API_ENDPOINT, apiKey, pageNo);
      models.push(...page.output.models);
    }

    return {
      ...first,
      output: {
        ...first.output,
        models,
      },
    };
  },
  parseModels(raw) {
    const models = AlibabaCatalogResponse.parse(raw).output.models;
    const seen = new Set<string>();
    const deduped: AlibabaModel[] = [];

    for (const model of models) {
      if (seen.has(model.model)) continue;
      seen.add(model.model);
      deduped.push(model);
    }

    return deduped;
  },
  translateModel(model, context) {
    const existing = context.existing(model.model);
    const baseModel = existing?.base_model ?? resolveAlibabaBaseModel(model.model);
    // Alibaba provider TOMLs should always use base_model syntax. If no
    // canonical metadata exists, skip translation and retain any local file via
    // deleteMissing: false instead of minting an incomplete inline model.
    if (baseModel === undefined) return undefined;
    return {
      id: model.model,
      model: buildAlibabaModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<AlibabaModel>;

async function fetchModelsPage(
  apiEndpoint: string,
  apiKey: string,
  pageNo: number,
) {
  let url: URL;
  try {
    url = new URL(apiEndpoint);
  } catch (cause) {
    throw new Error(`Invalid Alibaba model catalog URL: ${apiEndpoint}`, { cause });
  }
  url.searchParams.set("page_no", String(pageNo));
  url.searchParams.set("page_size", String(API_PAGE_SIZE));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Alibaba model catalog request failed: ${response.status} ${response.statusText}: ${body}`,
    );
  }

  const page = AlibabaCatalogPage.parse(await response.json());
  if (!page.success) {
    throw new Error(
      `Alibaba model catalog request failed: ${page.code ?? "unknown"}: ${page.message ?? "unknown error"}`,
    );
  }
  return page;
}

function hasPriceType(prices: z.infer<typeof AlibabaPrice>[], ...types: string[]) {
  return types.some((type) => prices.some((price) => price.type === type));
}

function tokenPrice(prices: z.infer<typeof AlibabaPrice>[], ...types: string[]) {
  for (const type of types) {
    const value = prices.find((price) => price.type === type);
    if (value === undefined) continue;
    if (!/1\s*m\s*tokens/i.test(value.price_unit)) continue;
    const amount = Number(value.price);
    if (!Number.isFinite(amount) || amount < 0) continue;
    return amount;
  }
  return undefined;
}

function dateFromPublishedTime(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1];
}

function normalizedModalities(values: string[] | undefined) {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.toLowerCase())
        .filter((value): value is Modality => allowed.has(value as Modality)),
    ),
  ];
}

function costFromPrices(
  prices: z.infer<typeof AlibabaPrice>[],
  existing: Cost | undefined,
): Cost | undefined {
  const thinkingInput = tokenPrice(prices, "thinking_input_token");
  const thinkingOutput = tokenPrice(prices, "thinking_output_token");
  const standardInput = tokenPrice(
    prices,
    "input_token",
    "text_input_token",
    "vision_input_token",
    "translate_vision_input_token",
    "embedding_token",
    "omni_no_audio_input_token",
  );
  const standardOutput = tokenPrice(
    prices,
    "output_token",
    "purein_text_output_token",
    "multiin_text_output_token",
    "translate_multi_text_output_token",
    "omni_no_audio_output_token",
  );
  const input = standardInput ?? thinkingInput;
  const output = standardOutput ?? thinkingOutput;
  if (input === undefined && output === undefined) {
    if (
      hasPriceType(prices, "image_number", "image_standard", "image_thinking", "content_duration", "cosy_tts_number")
    ) {
      return existing;
    }
    return undefined;
  }

  return {
    input: input ?? existing?.input ?? 0,
    output: output ?? existing?.output ?? 0,
    reasoning: standardOutput !== undefined
      ? thinkingOutput ?? existing?.reasoning
      : existing?.reasoning,
    cache_read: tokenPrice(
      prices,
      "input_token_cache_read",
      "thinking_input_token_cache_read",
    ),
    cache_write: tokenPrice(
      prices,
      "input_token_cache_creation_5m",
      "thinking_input_token_cache_creation_5m",
    ),
    input_audio:
      tokenPrice(
        prices,
        "audio_input_token",
        "omni_audio_input_token",
        "translate_audio_input_token",
        "thinking_audio_input_token",
      ) ?? existing?.input_audio,
    output_audio:
      tokenPrice(
        prices,
        "multi_output_token",
        "omni_audio_output_token",
        "translate_multi_output_token",
      ) ?? existing?.output_audio,
  };
}

function tierLowerBound(rangeName: string) {
  if (/^(Default|Input\s*<=)/i.test(rangeName)) return 0;

  const match = /([0-9]+)\s*k\s*<\s*Input/i.exec(rangeName);
  if (match !== null) return Number(match[1]) * 1000;

  return undefined;
}

function cost(model: AlibabaModel, existing: ExistingModel | undefined) {
  const ranges = model.prices
    .map((range) => ({
      lowerBound: tierLowerBound(range.range_name),
      cost: costFromPrices(range.prices, existing?.cost),
    }))
    .filter((range): range is { lowerBound: number; cost: Cost } => {
      return range.lowerBound !== undefined && range.cost !== undefined;
    })
    .sort((left, right) => left.lowerBound - right.lowerBound);

  if (ranges.length === 0) return existing?.cost;

  const base = ranges[0]!.cost;
  // Build the API-derived tiers. Each tier carries its `lowerBound` as `size` —
  // a tier with `size: N` covers `N < context <= (next tier's size, or model
  // context_window)`. The base rate (the smallest range) is intentionally NOT
  // included here; it lives at the top level of `cost` so consumers can read
  // the default rate without indexing into `tiers[0]`.
  const aboveBase = ranges.slice(1);
  const apiTiers = aboveBase.map(
    (range): CostTier => ({
      tier: { type: "context", size: range.lowerBound },
      ...range.cost,
    }),
  );
  // API is the source of truth for tiers; hand-curated TOML tiers are never preserved.
  const tiers = apiTiers.length > 0 ? apiTiers : undefined;

  return {
    ...base,
    tiers,
  };
}

function limit(model: AlibabaModel, existing: ExistingModel | undefined) {
  const context = model.model_info.context_window ?? existing?.limit?.context;
  const output = model.model_info.max_output_tokens ?? existing?.limit?.output;
  const input = model.model_info.max_input_tokens ?? existing?.limit?.input;
  if (context === undefined && output === undefined && input === undefined) {
    return existing?.limit;
  }
  return { context, output, input };
}

function modalities(model: AlibabaModel, existing: ExistingModel | undefined) {
  const input = normalizedModalities(model.inference_metadata.request_modality);
  const isVision = model.capabilities.includes("VU")
    || /(^|[-_.])vl([-_.]|$)/i.test(model.model);
  if (isVision && !input.includes("pdf")) {
    input.push("pdf");
  }

  const output = normalizedModalities(
    model.inference_metadata.response_modality,
  );

  if (input.length === 0 && output.length === 0) return existing?.modalities;

  return {
    input: input.length > 0 ? input : existing?.modalities?.input ?? ["text"],
    output: output.length > 0 ? output : existing?.modalities?.output ?? ["text"],
  };
}

function status(model: AlibabaModel, existing: ExistingModel | undefined) {
  const offline = dateFromPublishedTime(model.inference_offline_info?.offlineTime ?? "");
  if (offline !== undefined && offline <= new Date().toISOString().slice(0, 10)) {
    return "deprecated" as const;
  }
  return existing?.status;
}

export function buildAlibabaModel(
  model: AlibabaModel,
  existing: ExistingModel | undefined,
  baseModel: string,
): SyncedModel {
  const publishedDate = dateFromPublishedTime(model.published_time);
  const translatedModalities = modalities(model, existing);
  const translatedCost = cost(model, existing);
  const translatedLimit = limit(model, existing);
  const reasoning = model.capabilities.includes("Reasoning");
  const input = translatedModalities?.input ?? existing?.modalities?.input;

  const baseMetadata = baseModelMetadata(baseModel);
  const baseLimit = baseMetadata.limit as SyncedFullModel["limit"] | undefined;
  const limitForOmit = (translatedLimit ?? baseLimit ?? {}) as SyncedFullModel["limit"];

  return factorBaseModel(
    baseModel,
    {
      name: existing?.name ?? model.name,
      family: existing?.family,
      release_date: existing?.release_date ?? publishedDate,
      last_updated: existing?.last_updated ?? publishedDate,
      attachment: existing?.attachment ?? input?.some((value) => value !== "text"),
      reasoning,
      reasoning_options: existing?.reasoning_options,
      temperature: existing?.temperature,
      tool_call: model.features.includes("function-calling")
        ? true
        : existing?.tool_call,
      structured_output: model.features.includes("structured-outputs")
        ? true
        : existing?.structured_output,
      knowledge: existing?.knowledge,
      open_weights: existing?.open_weights,
      status: status(model, existing),
      interleaved: existing?.interleaved,
      cost: translatedCost,
      limit: translatedLimit,
      modalities: translatedModalities,
    },
    limitForOmit,
    existing?.base_model_omit,
  );
}
