import { z } from "zod";

import { AuthoredModelShape, ReasoningOption } from "../../schema.js";
import type { SyncProvider } from "../index.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.pinference.ai/api/v1/models";
const TokenLimit = z.number().int().positive().nullish();
const Price = z.number().nonnegative().nullish();

export const PrimeModel = z.object({
  id: z.string().min(1),
  display_name: z.string().nullish(),
  pricing: z.object({
    input_usd_per_mtok: Price,
    output_usd_per_mtok: Price,
    cache_read_usd_per_mtok: Price,
    cache_write_usd_per_mtok: Price,
  }).passthrough().nullish(),
  specs: z.object({
    context_window: TokenLimit,
    max_output_tokens: TokenLimit,
    supports_reasoning: z.boolean().nullish(),
    modalities: z.object({
      input: z.array(z.string()).nullish(),
      output: z.array(z.string()).nullish(),
    }).passthrough().nullish(),
  }).passthrough().nullish(),
  context_window: TokenLimit,
  max_output_tokens: TokenLimit,
  supported_parameters: z.array(z.string()).nullish(),
  reasoning: z.object({
    supported_efforts: z.array(z.string()).nullish(),
  }).passthrough().nullish(),
}).passthrough();

export const PrimeResponse = z.object({
  object: z.literal("list"),
  data: z.array(PrimeModel).min(1, "Prime returned an empty catalog; refusing to remove local models"),
}).passthrough().refine(
  (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
  "Prime returned duplicate model IDs",
);

export type PrimeModel = z.infer<typeof PrimeModel>;

// These are inventory routes rather than public model identities. Lowercase
// namespaces also preserve exact IDs on case-insensitive development filesystems.
function publicChatRoute(model: PrimeModel) {
  const [namespace = ""] = model.id.split("/");
  if (namespace !== namespace.toLowerCase() || ["internal", "frontier"].includes(namespace) || model.id.includes(":")) {
    return false;
  }
  const modalities = model.specs?.modalities;
  return !(
    (model.supported_parameters != null && !model.supported_parameters.includes("tools"))
    || (modalities?.input != null && !modalities.input.includes("text"))
    || (modalities?.output != null && !modalities.output.includes("text"))
  );
}

export const prime = {
  id: "prime",
  name: "Prime Inference",
  modelsDir: "providers/prime/models",
  preserveBaseModels: false,
  preserveDescriptions: false,
  authoritativeHeaders: true,
  // Sparse upstream rows need provider metadata, not an issue for every row.
  // Report them and retain existing files until that metadata is available.
  trackMissingModels: false,
  fetchModels: fetchPrimeModels,
  parseModels(raw) {
    return PrimeResponse.parse(raw).data;
  },
  sourceID(model) {
    return publicChatRoute(model) ? model.id : undefined;
  },
  missingModelID(model) {
    return publicChatRoute(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `Prime models awaiting complete API metadata, published effort controls or a lab base: ${ids.join(", ")}`,
    ];
  },
  translateModel(model, context) {
    if (!publicChatRoute(model)) return undefined;
    const parameters = model.supported_parameters;
    const modalities = model.specs?.modalities;
    const contextLimit = model.context_window ?? model.specs?.context_window;
    const outputLimit = model.max_output_tokens ?? model.specs?.max_output_tokens;
    const pricing = model.pricing;
    const reasoning = model.specs?.supports_reasoning;
    if (
      !parameters?.includes("tools") || !modalities?.input?.includes("text") || !modalities.output?.includes("text")
      || contextLimit == null || outputLimit == null
      || pricing?.input_usd_per_mtok == null || pricing.output_usd_per_mtok == null
      || reasoning == null
    ) return undefined;

    const efforts = sortEfforts(model.reasoning?.supported_efforts);
    const effort = reasoning && efforts?.length
      ? ReasoningOption.safeParse({ type: "effort", values: efforts })
      : undefined;
    if (reasoning && !effort?.success) return undefined;

    const baseModel = context.authored(model.id)?.base_model ?? resolveModelMetadataBaseModel(model.id);
    if (baseModel === undefined) return undefined;
    const baseLimit = modelMetadata(baseModel).limit as { input?: number } | undefined;
    const limit = { context: contextLimit, output: outputLimit };
    const schema = AuthoredModelShape.shape.modalities;
    const input = modalities.input.flatMap((value) => {
      const parsed = schema.shape.input.element.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    const output = modalities.output.flatMap((value) => {
      const parsed = schema.shape.output.element.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    const translated = factorBaseModel(baseModel, {
      name: model.display_name?.trim() || undefined,
      attachment: input.some((value) => value !== "text"),
      tool_call: true,
      reasoning,
      reasoning_options: effort?.success ? [effort.data] : undefined,
      temperature: parameters.includes("temperature"),
      structured_output: parameters.some((value) => ["response_format", "structured_outputs"].includes(value)),
      cost: {
        input: pricing.input_usd_per_mtok,
        output: pricing.output_usd_per_mtok,
        cache_read: pricing.cache_read_usd_per_mtok ?? undefined,
        cache_write: pricing.cache_write_usd_per_mtok ?? undefined,
      },
      limit,
      modalities: { input, output },
    }, limit, baseLimit?.input === undefined ? undefined : ["limit.input"]);

    // The MIME line cites the file's own v2 modalities, which sync keeps as is.
    const v2 = context.v2?.(model.id) as { modalities?: { input?: string[] } } | undefined;
    return {
      id: model.id,
      model: translated,
      header: "# Generated by bun models:sync prime from https://api.pinference.ai/api/v1/models.\n"
        + "# Prices are USD per million tokens; lab facts are inherited via base_model.\n"
        + (reasoning ? `# Effort: top-level reasoning_effort = ${efforts!.join("|")}.\n` : "")
        + (modalities.input.includes("file") ? "# Generic file input is omitted; it does not imply PDF support.\n" : "")
        + `${MID_CONVERSATION_LINES}\n`
        + (v2?.modalities?.input?.some((value) => value.includes("/")) ? `${MIME_LINE}\n` : ""),
    };
  },
} satisfies SyncProvider<PrimeModel>;

const MID_CONVERSATION_LINES = [
  "# Mid-conversation: system_updates, effort_updates and tools.updates are unset; Prime documents none of them and they weren't tested live.",
  "# Prime serves Chat Completions, Anthropic Messages (translated onto chat completions) and Responses (https://api.pinference.ai/openapi.json).",
].join("\n");
const MIME_LINE = "# Input MIME types: the lab's entries for each kind Prime lists (Prime documents no formats).";

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];

// Low to high, so a reordered catalog never rewrites the files.
function sortEfforts(efforts: string[] | null | undefined) {
  return efforts == null
    ? efforts
    : [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

export async function fetchPrimeModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Prime catalog request failed: ${response.status} ${response.statusText}`);
  }
  return PrimeResponse.parse(await response.json());
}
