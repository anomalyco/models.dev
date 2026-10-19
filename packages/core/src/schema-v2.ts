import { z } from "zod";

import { ModelFamily, ModelFamilyValues } from "./family.js";
import { DateString, JsonValue } from "./schema.js";

/**
 * Creates an open-ended string union for public API / OpenAPI schemas.
 *
 * Why: Fields like `type`, `family`, and `modalities` will gain new values over
 * time (new MIME types, new model families, new model categories). Exposing
 * them as `z.enum(...) | (string & {})` gives TypeScript and OpenAPI consumers
 * autocomplete and documentation for all known values without making future
 * additions a breaking schema change.
 *
 * Strict allowlist checks and cross-field lint rules (e.g. forbidding `"image"`
 * alongside `"image/png"`) belong in catalog validation (`bun validate`), not
 * in the public API schema.
 */
function openEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.union([z.enum(values), z.string() as z.ZodType<string & {}>]);
}

export const ModelTypeV2Values = [
  "chat",
  "image",
  "video",
  "embedding",
  "reranking",
  "decision",
  "transcription",
  "speech",
  "realtime",
] as const;

export const KnownModelTypeV2 = z.enum(ModelTypeV2Values);
export const ModelTypeV2 = openEnum(ModelTypeV2Values);
export type ModelTypeV2 = z.infer<typeof ModelTypeV2>;

export const MediaModalityV2Values = [
  "text",
  "image",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
  "image/avif",
  "audio",
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/flac",
  "audio/aac",
  "audio/mp4",
  "audio/webm",
  "video",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/mpeg",
  "video/x-msvideo",
  "application/pdf",
] as const;

export const InputModalityV2Values = MediaModalityV2Values;
export const KnownInputModalityV2 = z.enum(InputModalityV2Values);
export const InputModalityV2 = openEnum(InputModalityV2Values);
export type InputModalityV2 = z.infer<typeof InputModalityV2>;

export const OutputModalityV2Values = [
  ...MediaModalityV2Values,
  "decision",
  "embedding",
  "reranking",
] as const;
export const KnownOutputModalityV2 = z.enum(OutputModalityV2Values);
export const OutputModalityV2 = openEnum(OutputModalityV2Values);
export type OutputModalityV2 = z.infer<typeof OutputModalityV2>;

export const ModalitiesV2 = z
  .object({
    input: z.array(InputModalityV2),
    output: z.array(OutputModalityV2),
  })
  .strict();

export type ModalitiesV2 = z.infer<typeof ModalitiesV2>;

export const KnownModelFamilyV2 = ModelFamily;
export const ModelFamilyV2 = openEnum(ModelFamilyValues);
export type ModelFamilyV2 = z.infer<typeof ModelFamilyV2>;

export const ToolChoiceV2 = z.enum(["auto", "none", "required", "tool"]);
export type ToolChoiceV2 = z.infer<typeof ToolChoiceV2>;

export const ToolGrammarV2Values = [
  "lark",
  "regex",
] as const;

export const KnownToolGrammarV2 = z.enum(ToolGrammarV2Values);
export const ToolGrammarV2 = openEnum(ToolGrammarV2Values);
export type ToolGrammarV2 = z.infer<typeof ToolGrammarV2>;

export const ToolsSupportV2 = z.discriminatedUnion("supported", [
  z
    .object({
      supported: z.literal(false),
    })
    .strict(),
  z
    .object({
      supported: z.literal(true),
      strict: z.boolean().optional(),
      choice: z.array(ToolChoiceV2).optional(),
      search: z.boolean().optional(),
      grammar: z.array(ToolGrammarV2).optional(),
      updates: z.boolean().optional(),
    })
    .strict(),
]);

export type ToolsSupportV2 = z.infer<typeof ToolsSupportV2>;

export const ReasoningEffortV2Values = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
] as const;

export const KnownReasoningEffortV2 = z.enum(ReasoningEffortV2Values);
export const ReasoningEffortV2 = openEnum(ReasoningEffortV2Values);
export type ReasoningEffortV2 = z.infer<typeof ReasoningEffortV2>;

export const ReasoningDefaultV2 = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("toggle"),
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("effort"),
      value: ReasoningEffortV2,
    })
    .strict(),
  z
    .object({
      type: z.literal("budget"),
      value: z.number(),
    })
    .strict(),
]);

export type ReasoningDefaultV2 = z.infer<typeof ReasoningDefaultV2>;

export const ReasoningSupportV2 = z.discriminatedUnion("supported", [
  z
    .object({
      supported: z.literal(false),
    })
    .strict(),
  z
    .object({
      supported: z.literal(true),
      default: ReasoningDefaultV2.optional(),
      toggle: z.boolean().optional(),
      effort: z.array(ReasoningEffortV2).optional(),
      budget: z
        .object({
          min: z.number().optional(),
          max: z.number().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

export type ReasoningSupportV2 = z.infer<typeof ReasoningSupportV2>;

export type DurationUnitV2 = "ms" | "s" | "m" | "h" | "d";
export type DurationStringV2 = `${number}${DurationUnitV2}`;

export const DurationStringV2 = z
  .string()
  .regex(
    /^\d+(ms|s|m|h|d)$/,
    "Must be a duration like 5m, 30m, 1h, 24h",
  ) as z.ZodType<DurationStringV2>;

export const CacheTargetV2Values = [
  "tools",
  "system",
  "messages",
] as const;

export const KnownCacheTargetV2 = z.enum(CacheTargetV2Values);
export const CacheTargetV2 = openEnum(CacheTargetV2Values);
export type CacheTargetV2 = z.infer<typeof CacheTargetV2>;

export const ImplicitCacheV2 = z.union([
  z.boolean(),
  z
    .object({
      ttl: z.array(DurationStringV2).optional(),
      min_tokens: z.number().int().min(0).optional(),
    })
    .strict(),
]);

export type ImplicitCacheV2 = z.infer<typeof ImplicitCacheV2>;

export const ExplicitCacheV2 = z.union([
  z.boolean(),
  z
    .object({
      ttl: z.array(DurationStringV2).optional(),
      max_breakpoints: z.number().int().min(1).optional(),
      targets: z.array(CacheTargetV2).optional(),
      min_tokens: z.number().int().min(0).optional(),
    })
    .strict(),
]);

export type ExplicitCacheV2 = z.infer<typeof ExplicitCacheV2>;

export const CacheSupportV2 = z.discriminatedUnion("supported", [
  z
    .object({
      supported: z.literal(false),
    })
    .strict(),
  z
    .object({
      supported: z.literal(true),
      implicit: ImplicitCacheV2.optional(),
      explicit: ExplicitCacheV2.optional(),
    })
    .strict(),
]);

export type CacheSupportV2 = z.infer<typeof CacheSupportV2>;

export const ServiceTierV2Values = [
  "flex",
  "priority",
  "fast",
  "ultrafast",
] as const;

export const KnownServiceTierV2 = z.enum(ServiceTierV2Values);
export const ServiceTierV2 = openEnum(ServiceTierV2Values);
export type ServiceTierV2 = z.infer<typeof ServiceTierV2>;

export const CapabilitiesV2 = z
  .object({
    tools: ToolsSupportV2,
    reasoning: ReasoningSupportV2,
    cache: CacheSupportV2.optional(),
    structured_output: z.boolean().optional(),
    temperature: z.boolean().optional(),
    top_p: z.boolean().optional(),
    top_k: z.boolean().optional(),
    system_updates: z.boolean().optional(),
    effort_updates: z.boolean().optional(),
    store: z.boolean().optional(),
    stream_usage: z.boolean().optional(),
    prompt_cache_key: z.boolean().optional(),
    service_tier: z.array(ServiceTierV2).optional(),
  })
  .strict();

export type CapabilitiesV2 = z.infer<typeof CapabilitiesV2>;

export const ImageLimitV2 = z
  .object({
    max_per_message: z.number().min(0).optional(),
    max_per_request: z.number().min(0).optional(),
    max_bytes: z.number().min(0).optional(),
    min_width: z.number().min(0).optional(),
    min_height: z.number().min(0).optional(),
    max_width: z.number().min(0).optional(),
    max_height: z.number().min(0).optional(),
  })
  .strict();

export type ImageLimitV2 = z.infer<typeof ImageLimitV2>;

export const PdfLimitV2 = z
  .object({
    max_per_request: z.number().min(0).optional(),
    max_bytes: z.number().min(0).optional(),
    max_pages: z.number().min(0).optional(),
  })
  .strict();

export type PdfLimitV2 = z.infer<typeof PdfLimitV2>;

export const LimitV2 = z
  .object({
    context: z.number().min(0).optional(),
    input: z.number().min(0).optional(),
    output: z.number().min(0).optional(),
    request_bytes: z.number().min(0).optional(),
    image: ImageLimitV2.optional(),
    pdf: PdfLimitV2.optional(),
  })
  .strict();

export type LimitV2 = z.infer<typeof LimitV2>;

export const SdkV2 = z
  .object({
    aisdk: z.string().optional(),
    opencodeai: z.string().optional(),
  })
  .strict();

export type SdkV2 = z.infer<typeof SdkV2>;

export const ReasoningFieldV2Values = [
  "reasoning",
  "reasoning_content",
  "reasoning_text",
] as const;

export const KnownReasoningFieldV2 = z.enum(ReasoningFieldV2Values);
export const ReasoningFieldV2 = openEnum(ReasoningFieldV2Values);
export type ReasoningFieldV2 = z.infer<typeof ReasoningFieldV2>;

export const MaxTokensFieldV2Values = [
  "max_completion_tokens",
  "max_tokens",
] as const;

export const KnownMaxTokensFieldV2 = z.enum(MaxTokensFieldV2Values);
export const MaxTokensFieldV2 = openEnum(MaxTokensFieldV2Values);
export type MaxTokensFieldV2 = z.infer<typeof MaxTokensFieldV2>;

export const CompatibilityV2 = z
  .object({
    reasoning_field: ReasoningFieldV2.optional(),
    replay_reasoning: z.boolean().optional(),
    max_tokens_field: MaxTokensFieldV2.optional(),
  })
  .strict();

export type CompatibilityV2 = z.infer<typeof CompatibilityV2>;

export const CapabilitiesOverrideV2 = CapabilitiesV2.partial();
export type CapabilitiesOverrideV2 = z.infer<typeof CapabilitiesOverrideV2>;

export const ApiBaseUrlV2 = z.union([
  z.string().url("Must be a valid URL"),
  z.string().regex(/^\$\{[A-Z0-9_]+\}/, "Must be a valid URL or env var template"),
]);

export const ApiEntryV2 = z
  .object({
    base_url: ApiBaseUrlV2,
    sdk: SdkV2.optional(),
    compatibility: CompatibilityV2.optional(),
    capabilities: CapabilitiesOverrideV2.optional(),
  })
  .strict();

export type ApiEntryV2 = z.infer<typeof ApiEntryV2>;

export const ApiProtocolV2Values = [
  "chat-completions",
  "responses",
  "messages",
  "converse",
  "generate-content",
  "interactions",
  "cohere-chat",
  "systemone",
  "decisions",
  "evaluate",
  "workers-ai-run",
  "images",
  "videos",
  "realtime",
  "live",
  "rerank",
  "speech",
  "transcriptions",
  "embeddings",
  "embed-content",
] as const;

export const KnownApiProtocolV2 = z.enum(ApiProtocolV2Values);
export const ApiProtocolV2 = openEnum(ApiProtocolV2Values);
export type ApiProtocolV2 = z.infer<typeof ApiProtocolV2>;

export const ApiV2 = z.record(ApiProtocolV2, ApiEntryV2);
export type ApiV2 = z.infer<typeof ApiV2>;

// Prices are USD per 1M for `token` and `character`, and per 1 unit otherwise.
export const CostUnitV2Values = [
  "token",
  "character",
  "image",
  "megapixel",
  "second",
  "minute",
] as const;

export const KnownCostUnitV2 = z.enum(CostUnitV2Values);
export const CostUnitV2 = openEnum(CostUnitV2Values);
export type CostUnitV2 = z.infer<typeof CostUnitV2>;

export const CostConditionKeyV2Values = [
  "context",
  "duration",
  "megapixels",
  "input_images",
  "service_tier",
  "region",
  "date",
  "utc_days",
  "utc_hours",
  "holiday",
  "thinking",
  "resolution",
  "quality",
  "aspect_ratio",
  "generate_audio",
  "mode",
  "input_video",
  "fps",
  "steps",
] as const;

export const KnownCostConditionKeyV2 = z.enum(CostConditionKeyV2Values);
export const CostConditionKeyV2 = openEnum(CostConditionKeyV2Values);
export type CostConditionKeyV2 = z.infer<typeof CostConditionKeyV2>;

export const HolidayV2Values = ["CN", "US", "CA"] as const;

export const KnownHolidayV2 = z.enum(HolidayV2Values);
export const HolidayV2 = openEnum(HolidayV2Values);
export type HolidayV2 = z.infer<typeof HolidayV2>;

const PriceV2 = z.number().min(0, "Price cannot be negative");

const CostConditionValueV2 = z.union([z.string(), z.number(), z.boolean()]);

export const CostConditionV2 = z
  .object({
    equals: CostConditionValueV2.optional(),
    in: z.array(CostConditionValueV2).optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    min_items: z.number().int().min(0).optional(),
  })
  .strict();

export type CostConditionV2 = z.infer<typeof CostConditionV2>;

export type CostWhenV2 = {
  all?: CostWhenV2[];
  any?: CostWhenV2[];
  not?: CostWhenV2;
  [key: string]: CostConditionV2 | CostWhenV2[] | CostWhenV2 | undefined;
};

export const CostWhenV2: z.ZodType<CostWhenV2> = z.lazy(() =>
  z
    .object({
      all: z.array(CostWhenV2).optional(),
      any: z.array(CostWhenV2).optional(),
      not: CostWhenV2.optional(),
    })
    .catchall(CostConditionV2),
);

export const CachePricesV2 = z
  .object({
    read: PriceV2.optional(),
    write: z.union([PriceV2, z.record(DurationStringV2, PriceV2)]).optional(),
    storage: PriceV2.optional(),
  })
  .strict();

export type CachePricesV2 = z.infer<typeof CachePricesV2>;

export const CacheCostV2 = CachePricesV2.extend({
  explicit: CachePricesV2.optional(),
}).strict();

export type CacheCostV2 = z.infer<typeof CacheCostV2>;

const InputPricesV2 = z
  .object({
    price: PriceV2,
    cache: CacheCostV2.optional(),
  })
  .strict();

export const InputCostV2 = z
  .object({ unit: CostUnitV2.optional() })
  .extend(InputPricesV2.shape)
  .extend({
    overrides: z
      .array(
        z
          .object({ when: CostWhenV2 })
          .extend(InputPricesV2.partial().shape)
          .strict(),
      )
      .optional(),
  })
  .strict();

export type InputCostV2 = z.infer<typeof InputCostV2>;

const OutputPricesV2 = z
  .object({
    price: PriceV2,
    reasoning: PriceV2.optional(),
  })
  .strict();

export const OutputCostV2 = z
  .object({ unit: CostUnitV2.optional() })
  .extend(OutputPricesV2.shape)
  .extend({
    overrides: z
      .array(
        z
          .object({ when: CostWhenV2 })
          .extend(OutputPricesV2.partial().shape)
          .strict(),
      )
      .optional(),
  })
  .strict();

export type OutputCostV2 = z.infer<typeof OutputCostV2>;

export const ModalityCostV2 = z
  .object({
    input: InputCostV2.optional(),
    output: OutputCostV2.optional(),
  })
  .strict();

export type ModalityCostV2 = z.infer<typeof ModalityCostV2>;

export type CostFactorV2 = number | { [key: string]: CostFactorV2 };

export const CostFactorV2: z.ZodType<CostFactorV2> = z.lazy(() =>
  z.union([
    z.number().min(0, "Factor cannot be negative"),
    z.record(CostFactorV2),
  ]),
);

export const CostMultiplierV2 = z
  .object({
    when: CostWhenV2,
    factor: CostFactorV2,
  })
  .strict();

export type CostMultiplierV2 = z.infer<typeof CostMultiplierV2>;

export const CostV2 = z
  .object({
    text: ModalityCostV2.optional(),
    image: ModalityCostV2.optional(),
    audio: ModalityCostV2.optional(),
    video: ModalityCostV2.optional(),
    multipliers: z.array(CostMultiplierV2).optional(),
  })
  .strict();

export type CostV2 = z.infer<typeof CostV2>;

export const ExperimentalModeV2 = z
  .object({
    cost: CostV2.optional(),
    capabilities: CapabilitiesOverrideV2.optional(),
    body: z.record(JsonValue).optional(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

export type ExperimentalModeV2 = z.infer<typeof ExperimentalModeV2>;

export const ExperimentalV2 = z
  .object({
    modes: z.record(ExperimentalModeV2).optional(),
  })
  .catchall(JsonValue);

export type ExperimentalV2 = z.infer<typeof ExperimentalV2>;

export const ModelV2 = z
  .object({
    id: z.string(),
    canonical_id: z.string().optional(),
    type: ModelTypeV2,
    name: z.string().min(1, "Model name cannot be empty"),
    description: z.string().min(1, "Model description cannot be empty"),
    family: ModelFamilyV2.optional(),
    open_weights: z.boolean(),
    knowledge: DateString.optional(),
    release_date: DateString,
    last_updated: DateString,
    deprecation_date: DateString.optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    modalities: ModalitiesV2,
    capabilities: CapabilitiesV2,
    limit: LimitV2.optional(),
    cost: CostV2.optional(),
    api: ApiV2,
    experimental: ExperimentalV2.optional(),
    metadata: z.record(JsonValue).optional(),
  })
  .strict();

export type ModelV2 = z.infer<typeof ModelV2>;

export const ProviderV2 = z
  .object({
    id: z.string(),
    name: z.string().min(1, "Provider name cannot be empty"),
    doc: z
      .string()
      .min(
        1,
        "Please provide a link to the provider documentation where models are listed",
      ),
    env: z.array(z.string()),
    models: z.record(ModelV2),
  })
  .strict();

export type ProviderV2 = z.infer<typeof ProviderV2>;
