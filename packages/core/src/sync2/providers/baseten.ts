// Baseten Model APIs: https://inference.baseten.co/v1/models (BASETEN_API_KEY).
// Authoritative for display names, token and cache-read prices, the context
// window, input and output kinds and temperature; tool calling, reasoning and
// structured output are only ever turned on. A file keeps its output limit
// (the catalog has listed a context window as one); a new file takes the
// catalog's. Chat models are also served on Messages, and cache prompts
// automatically when a cached price is listed. Decision models
// (`decision-models/...`) are v2-only System One models whose lab is
// `baseten/<name>`. New models are created from a lab file when priced;
// dropped models are kept for review.

import { z } from "zod";

import { fetchJSON, requireEnv } from "../http.js";
import { namespaceHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://inference.baseten.co/v1/models";
const DECISION_PREFIX = "decision-models/";
const DECISION_HEADER = "# Decision model: POST /v1/systemone (https://docs.baseten.co/inference/model-apis/decision-models)\n"
  + "# Images go as image_url parts in a user message inside state.messages, which no media_input value describes (https://docs.baseten.co/reference/inference-api/system-one.md).";

// Model APIs also serve the Anthropic Messages API (beta) at POST /v1/messages,
// for the same model slugs: https://docs.baseten.co/inference/model-apis/overview
const MESSAGES_API = { sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic-compatible" } };

// Both packages post to `${baseURL}/systemone`. OpenCode's baseten/decisions entry, not
// the generic System One protocol (which sends images as `assets`), puts images
// where Baseten reads them: parts of a user message in state.messages.
const SYSTEMONE_API = { sdk: { aisdk: "@ai-sdk/typesafe-ai", opencodeai: "@opencode/ai/providers/baseten/decisions" } };

const NAMESPACES: Record<string, string> = {
  "deepseek-ai": "deepseek",
  MiniMaxAI: "minimax",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  "zai-org": "zai",
};

const KINDS = ["text", "audio", "image", "video", "pdf"];

const Price = z.union([z.string(), z.number()]);
const BasetenModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  context_length: z.number().int().positive(),
  // Decision models generate no text, so they list no completion limit.
  max_completion_tokens: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  pricing: z.object({ prompt: Price, completion: Price, input_cache_read: Price.optional() }).passthrough(),
  supported_features: z.array(z.string()),
  supported_sampling_parameters: z.array(z.string()),
}).passthrough();
type BasetenModel = z.infer<typeof BasetenModel>;

const BasetenResponse = z.object({ data: z.array(BasetenModel) }).passthrough();

export const baseten: SyncModule<unknown> = {
  id: "baseten",
  name: "Baseten",
  policy: {
    owns: [
      { path: "v2_only", createOnly: true },
      "name",
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.structured_output",
      "capabilities.temperature",
      "capabilities.cache",
      "limit.context",
      { path: "limit.output", createOnly: true },
      { path: "api", merge: "tables" },
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.output.price",
    ],
    creates: "auto",
    removals: "keep",
    omitLabInput: true,
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Baseten models", headers: { Authorization: `Api-Key ${requireEnv("Baseten", "BASETEN_API_KEY")}` } }),
  observe: (raw) => BasetenResponse.parse(raw).data.map((model) => (model.id.startsWith(DECISION_PREFIX) ? observeDecision(model) : observe(model))),
};

function observe(model: BasetenModel): Observation {
  const features = new Set(model.supported_features);
  const input = price(model.pricing.prompt);
  const output = price(model.pricing.completion);
  const cacheRead = price(model.pricing.input_cache_read);
  const inputKinds = kinds(model.input_modalities);
  const outputKinds = kinds(model.output_modalities);
  if (model.max_completion_tokens === undefined) throw new Error(`Baseten model ${model.id} has incomplete token limits required for sync`);
  return {
    id: model.id,
    base: baseHints(model.id),
    // A new model needs a price.
    ...(input === undefined || output === undefined ? { updateOnly: true } : {}),
    name: model.name,
    ...(inputKinds.length > 0 || outputKinds.length > 0 ? { modalities: { ...(inputKinds.length > 0 && { input: inputKinds }), ...(outputKinds.length > 0 && { output: outputKinds }) } } : {}),
    capabilities: {
      ...(features.has("tools") ? { tools: { supported: true } } : {}),
      ...(features.has("reasoning") ? { reasoning: { supported: true } } : {}),
      ...(features.has("structured_outputs") ? { structured_output: true } : {}),
      temperature: model.supported_sampling_parameters.includes("temperature"),
      // Model APIs cache prompt prefixes automatically ("Caching is automatic and
      // requires no request flags") and bill cached input at input_cache_read.
      ...(cacheRead === undefined ? {} : { cache: { implicit: true } }),
    },
    limit: { context: model.context_length, output: model.max_completion_tokens },
    api: { messages: MESSAGES_API },
    ...(input === undefined || output === undefined ? {} : {
      cost: { text: { input: { price: input, ...(cacheRead === undefined ? {} : { cache: { read: cacheRead } }) }, output: { price: output } } },
    }),
  };
}

// Decision models are served on POST /v1/systemone, not Chat Completions. The
// catalog's `name` is the Base Labs lab model ID.
function observeDecision(model: BasetenModel): Observation {
  const input = price(model.pricing.prompt);
  const output = price(model.pricing.completion);
  return {
    id: model.id,
    base: [`baseten/${model.name}`],
    header: DECISION_HEADER,
    ...(input === undefined || output === undefined ? { updateOnly: true } : {}),
    v2_only: true,
    limit: { context: model.context_length },
    api: { "chat-completions": null, messages: null, systemone: SYSTEMONE_API },
    ...(input === undefined || output === undefined ? {} : { cost: { text: { input: { price: input }, output: { price: output } } } }),
  };
}

function price(value: string | number | undefined) {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000_000_000) / 1_000_000 : undefined;
}

function kinds(values: string[]) {
  return [...new Set(values.map((value) => value.toLowerCase()).filter((value) => KINDS.includes(value)))]
    .map((value) => (value === "pdf" ? "application/pdf" : value));
}

function baseHints(id: string) {
  const [org, ...rest] = id.split("/");
  if (org === undefined || rest.length === 0) return [];
  const namespace = NAMESPACES[org];
  return namespace === undefined ? namespaceHints(id) : namespaceHints(`${namespace}/${rest.join("/").toLowerCase()}`);
}
