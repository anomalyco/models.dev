// Hand-written mirrors of the Zod schemas in @models.dev/core (src/schema.ts).
// Kept intentionally free of zod so the published .d.ts has zero dependencies.
// Drift against the schemas is caught by test/types.ts, which asserts
// exact mutual assignability with the z.infer types from @models.dev/core.

export type { ModelFamily } from "./generated.js"
import type { ModelFamily } from "./generated.js"

/** Any JSON-serializable value. */
export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[]

/**
 * Reasoning effort levels accepted by a model's `effort` reasoning option.
 * `null` means the provider accepts disabling reasoning explicitly.
 */
export type ReasoningEffort = null | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default"

/** Reasoning enabled/disabled via a simple boolean toggle. */
export interface ReasoningOptionToggle {
  type: "toggle"
}

/** Reasoning controlled by a named effort level. */
export interface ReasoningOptionEffort {
  type: "effort"
  /** Effort values the provider accepts for this model. */
  values: ReasoningEffort[]
}

/** Reasoning controlled by a token budget. */
export interface ReasoningOptionBudgetTokens {
  type: "budget_tokens"
  /** Minimum reasoning budget in tokens. `-1` means dynamic/unbounded. */
  min?: number
  /** Maximum reasoning budget in tokens. */
  max?: number
}

/** How reasoning can be configured for a model. */
export type ReasoningOption = ReasoningOptionToggle | ReasoningOptionEffort | ReasoningOptionBudgetTokens

/** Pricing in USD per million tokens. */
export interface Cost {
  /** Input (prompt) price, USD per 1M tokens. */
  input: number
  /** Output (completion) price, USD per 1M tokens. */
  output: number
  /** Reasoning token price, USD per 1M tokens. */
  reasoning?: number
  /** Cache read price, USD per 1M tokens. */
  cache_read?: number
  /** Cache write price, USD per 1M tokens. */
  cache_write?: number
  /** Audio input price, USD per 1M tokens. */
  input_audio?: number
  /** Audio output price, USD per 1M tokens. */
  output_audio?: number
}

/** Pricing that applies from a given context size upward. */
export interface CostTier extends Cost {
  tier: {
    type: "context"
    /** Context size (in tokens) at which this tier starts to apply. */
    size: number
  }
}

/** Pricing for a provider's model, including context-size tiers. */
export interface ModelCost extends Cost {
  /** Legacy compatibility field: pricing applied beyond 200K context. Prefer `tiers`. */
  context_over_200k?: Cost
  /** Context-size-based pricing tiers. */
  tiers?: CostTier[]
}

/** Input/output data types a model supports. */
export type Modality = "text" | "audio" | "image" | "video" | "pdf"

export interface Modalities {
  input: Modality[]
  output: Modality[]
}

/** Token limits for a provider's model. */
export interface Limit {
  /** Context window size in tokens. */
  context: number
  /** Maximum input tokens. */
  input?: number
  /** Maximum output tokens. */
  output: number
}

/** Token limits in provider-agnostic model metadata. */
export interface MetadataLimit {
  /** Context window size in tokens. */
  context: number
  /** Maximum input tokens. */
  input?: number
  /** Maximum output tokens. */
  output?: number
}

/** A link related to a model (announcement, paper, weights, ...). */
export interface ModelLink {
  label?: string
  url: string
  type?: "announcement" | "blog" | "docs" | "license" | "model_card" | "paper" | "weights" | "other"
}

/** Downloadable weights for an open-weights model. */
export interface ModelWeights {
  label?: string
  url: string
  /** Weights format, e.g. "safetensors" or "gguf". */
  format?: string
  quantization?: string
}

/** A reported benchmark result. */
export interface BenchmarkResult {
  name: string
  score: number | string
  metric?: string
  harness?: string
  variant?: string
  dataset?: string
  version?: string
  source?: string
  /** YYYY-MM or YYYY-MM-DD. */
  date?: string
}

/**
 * Provider-agnostic model metadata as published by the lab.
 * Served by `GET https://models.dev/models.json`, keyed by `<lab>/<model>` ID.
 * Carries no provider-specific pricing or limits; see {@link Model} for those.
 */
export interface ModelMetadata {
  /** Canonical model ID, e.g. "anthropic/claude-opus-4-6". */
  id: string
  name: string
  description: string
  family?: ModelFamily
  /** Supports file attachments. */
  attachment?: boolean
  /** Is a reasoning model. */
  reasoning?: boolean
  /** Supports tool/function calling. */
  tool_call?: boolean
  /** Supports structured output (JSON schema). */
  structured_output?: boolean
  /** Supports the temperature parameter. */
  temperature?: boolean
  /** Knowledge cutoff, YYYY-MM or YYYY-MM-DD. */
  knowledge?: string
  /** YYYY-MM or YYYY-MM-DD. */
  release_date?: string
  /** YYYY-MM or YYYY-MM-DD. */
  last_updated?: string
  modalities?: Modalities
  open_weights?: boolean
  limit?: MetadataLimit
  /** License identifier for open-weights models. */
  license?: string
  links?: ModelLink[]
  weights?: ModelWeights[]
  benchmarks?: BenchmarkResult[]
}

/** Per-mode overrides for experimental model modes. */
export interface ExperimentalMode {
  cost?: Cost
  provider?: {
    /** Extra request body fields enabling this mode. */
    body?: Record<string, JsonValue>
    /** Extra request headers enabling this mode. */
    headers?: Record<string, string>
  }
}

export interface ModelExperimental {
  modes?: Record<string, ExperimentalMode>
}

/** Provider-specific wiring for SDK routing. */
export interface ModelProviderConfig {
  /** Override of the provider-level npm package for this model. */
  npm?: string
  /** Override of the API endpoint for this model. */
  api?: string
  /** API shape when the npm package supports multiple. */
  shape?: "responses" | "completions"
  /** Extra request body fields required by this model. */
  body?: Record<string, JsonValue>
  /** Extra request headers required by this model. */
  headers?: Record<string, string>
}

/**
 * A model as offered by a specific provider, including that provider's
 * pricing and limits. Part of `GET https://models.dev/api.json`.
 */
export interface Model {
  /** Provider-scoped model ID, e.g. "claude-opus-4-6". */
  id: string
  name: string
  description: string
  family?: ModelFamily
  /** Supports file attachments. */
  attachment: boolean
  /** Is a reasoning model. */
  reasoning: boolean
  /** Present exactly when `reasoning` is true. */
  reasoning_options?: ReasoningOption[]
  /** Supports tool/function calling. */
  tool_call: boolean
  /** Supports interleaved thinking between tool calls. */
  interleaved?: true | { field: "reasoning_content" | "reasoning_details" }
  /** Supports structured output (JSON schema). */
  structured_output?: boolean
  /** Supports the temperature parameter. */
  temperature?: boolean
  /** Knowledge cutoff, YYYY-MM or YYYY-MM-DD. */
  knowledge?: string
  /** YYYY-MM or YYYY-MM-DD. */
  release_date: string
  /** YYYY-MM or YYYY-MM-DD. */
  last_updated: string
  modalities: Modalities
  open_weights: boolean
  limit: Limit
  /** Lifecycle status; absent means generally available. */
  status?: "alpha" | "beta" | "deprecated"
  experimental?: ModelExperimental
  provider?: ModelProviderConfig
  /** Absent for models with no published pricing (e.g. subscription-only). */
  cost?: ModelCost
}

/**
 * An inference provider and the models it offers.
 * Served by `GET https://models.dev/api.json`, keyed by provider ID.
 */
export interface Provider {
  /** Provider ID, e.g. "anthropic". */
  id: string
  /** Environment variables used for authentication, e.g. ["ANTHROPIC_API_KEY"]. */
  env: string[]
  /** AI SDK npm package implementing this provider. */
  npm: string
  /** Base API URL for openai-compatible providers. */
  api?: string
  /** Human-readable provider name. */
  name: string
  /** URL of the provider's model documentation. */
  doc: string
  /** Models offered by this provider, keyed by provider-scoped model ID. */
  models: Record<string, Model>
}

/** Response of `GET https://models.dev/api.json`: all providers keyed by provider ID. */
export type ProviderMap = Record<string, Provider>

/** Response of `GET https://models.dev/models.json`: provider-agnostic metadata keyed by canonical model ID. */
export type ModelMetadataMap = Record<string, ModelMetadata>

/** Response of `GET https://models.dev/catalog.json`: providers and model metadata in one payload. */
export interface Catalog {
  providers: ProviderMap
  models: ModelMetadataMap
}
