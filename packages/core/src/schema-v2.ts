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

export const CapabilitiesV2 = z
  .object({
    tools: ToolsSupportV2,
    reasoning: ReasoningSupportV2,
    structured_output: z.boolean().optional(),
    temperature: z.boolean().optional(),
    top_p: z.boolean().optional(),
    top_k: z.boolean().optional(),
    system_updates: z.boolean().optional(),
    effort_updates: z.boolean().optional(),
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

export const SanitizerV2Values = [
  "gemini",
  "moonshot",
  "none",
] as const;

export const KnownSanitizerV2 = z.enum(SanitizerV2Values);
export const SanitizerV2 = openEnum(SanitizerV2Values);
export type SanitizerV2 = z.infer<typeof SanitizerV2>;

export const CompatibilityV2 = z
  .object({
    sanitizer: SanitizerV2.optional(),
    reasoning_field: ReasoningFieldV2.optional(),
    require_reasoning: z.boolean().optional(),
    max_tokens_field: MaxTokensFieldV2.optional(),
    require_finish_reason: z.boolean().optional(),
    require_assistant_after_tool: z.boolean().optional(),
    supports_store: z.boolean().optional(),
    supports_streaming_usage: z.boolean().optional(),
    supports_prompt_cache_key: z.boolean().optional(),
    zai_tool_stream: z.boolean().optional(),
    require_signature: z.boolean().optional(),
  })
  .strict();

export type CompatibilityV2 = z.infer<typeof CompatibilityV2>;

export const CapabilitiesOverrideV2 = CapabilitiesV2.partial();
export type CapabilitiesOverrideV2 = z.infer<typeof CapabilitiesOverrideV2>;

export const ApiEntryV2 = z
  .object({
    base_url: z.string(),
    path: z.string(),
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
  "system-one",
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

// TODO(v2): Revisit pricing design to support:
// - service tiers (fast, priority, flex, ultrafast, batch)
// - more pricing capabilities (e.g. 5m vs 1h cache TTLs, non-token media pricing)
export const BaseCostV2 = z
  .object({
    input: z.number().min(0, "Input price cannot be negative"),
    output: z.number().min(0, "Output price cannot be negative"),
    reasoning: z.number().min(0, "Reasoning price cannot be negative").optional(),
    cache_read: z
      .number()
      .min(0, "Cache read price cannot be negative")
      .optional(),
    cache_write: z
      .number()
      .min(0, "Cache write price cannot be negative")
      .optional(),
    input_audio: z
      .number()
      .min(0, "Audio input price cannot be negative")
      .optional(),
    output_audio: z
      .number()
      .min(0, "Audio output price cannot be negative")
      .optional(),
  })
  .strict();

export type BaseCostV2 = z.infer<typeof BaseCostV2>;

export const CostTierV2 = BaseCostV2.extend({
  tier: z
    .object({
      type: z.literal("context").default("context"),
      size: z.number().int().min(0, "Context tier size cannot be negative"),
    })
    .strict(),
}).strict();

export type CostTierV2 = z.infer<typeof CostTierV2>;

export const CostV2 = BaseCostV2.extend({
  tiers: z.array(CostTierV2).optional(),
}).strict();

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
