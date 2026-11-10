// Hugging Face Inference Providers: https://router.huggingface.co/v1/models
// (HF_TOKEN optional). The router aggregates several inference providers per
// model with their own prices, so existing files are curated by hand: the
// sync only keeps their APIs current (Chat Completions with `max_tokens`, and
// Responses). A new model is created from its lab file with the price and
// context of the provider the router routes to (the fastest), tool calling
// and structured output if any provider has them, and the router's input and
// output kinds. Reasoning controls depend on the provider, so a new
// reasoning model is a gap. Models the router drops are kept for review.

import { z } from "zod";

import { bearer, fetchJSON } from "../http.js";
import { namespaceHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://router.huggingface.co/v1/models";

// Hugging Face orgs as the namespaces the shared resolver knows.
const ORG_NAMESPACES: Record<string, string> = {
  CohereLabs: "cohere",
  "deepseek-ai": "deepseek",
  google: "google",
  "meta-llama": "meta-llama",
  MiniMaxAI: "minimax",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  Qwen: "qwen",
  "stepfun-ai": "stepfun",
  XiaomiMiMo: "xiaomi",
  "zai-org": "zai",
};

// The router serves every chat model on POST /v1/responses too ("All Inference
// Providers chat completion models should be compatible with the Responses API"):
// https://huggingface.co/docs/inference-providers/guides/responses-api
// Its Chat Completions API documents max_tokens, not max_completion_tokens:
// https://huggingface.co/docs/inference-providers/tasks/chat-completion (accessed 2026-10-24)
const APIS = {
  "chat-completions": { compatibility: { max_tokens_field: "max_tokens" as const } },
  responses: { sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" } },
};

const KINDS = ["text", "image", "audio", "video", "pdf"];

const Provider = z.object({
  provider: z.string(),
  status: z.string(),
  context_length: z.number().int().positive().optional(),
  pricing: z.object({ input: z.number(), output: z.number() }).passthrough().optional(),
  throughput: z.number().nonnegative().optional(),
  supports_tools: z.boolean().optional(),
  supports_structured_output: z.boolean().optional(),
}).passthrough();
type Provider = z.infer<typeof Provider>;

const HuggingFaceModel = z.object({
  id: z.string().min(1),
  architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }).passthrough(),
  providers: z.array(Provider),
}).passthrough();
type HuggingFaceModel = z.infer<typeof HuggingFaceModel>;

const HuggingFaceResponse = z.object({ data: z.array(HuggingFaceModel) }).passthrough();

export const huggingface: SyncModule<unknown> = {
  id: "huggingface",
  name: "Hugging Face",
  policy: {
    owns: [
      { path: "modalities.input", merge: "kinds", createOnly: true },
      { path: "modalities.output", merge: "kinds", createOnly: true },
      { path: "capabilities.tools.supported", createOnly: true },
      { path: "capabilities.structured_output", createOnly: true },
      { path: "limit.context", createOnly: true },
      { path: "api", merge: "tables" },
      { path: "cost.text.input.price", createOnly: true },
      { path: "cost.text.output.price", createOnly: true },
    ],
    creates: "auto",
    removals: "keep",
    omitLabInput: true,
  },
  fetch: () => {
    const key = process.env.HF_TOKEN;
    return fetchJSON(API_ENDPOINT, { source: "Hugging Face models", headers: key ? bearer(key) : {} });
  },
  observe: (raw) => HuggingFaceResponse.parse(raw).data
    .filter((model) => model.providers.some((provider) => provider.status === "live"))
    .map(observe),
};

function observe(model: HuggingFaceModel): Observation {
  const live = model.providers.filter((provider) => provider.status === "live");
  const byThroughput = (a: Provider, b: Provider) => (b.throughput ?? -Infinity) - (a.throughput ?? -Infinity);
  // The router sends traffic to the fastest provider: its price if it lists
  // one, else the fastest provider that does.
  const routed = [...live].sort(byThroughput).at(0);
  const priced = routed?.pricing !== undefined ? routed : [...live].filter((provider) => provider.pricing !== undefined).sort(byThroughput).at(0);
  const input = price(priced?.pricing?.input);
  const output = price(priced?.pricing?.output);
  const contexts = live.map((provider) => provider.context_length).filter((value): value is number => value !== undefined);
  const context = routed?.context_length ?? (contexts.length > 0 ? Math.max(...contexts) : undefined);
  const inputKinds = kinds(model.architecture.input_modalities);
  const outputKinds = kinds(model.architecture.output_modalities);
  return {
    id: model.id,
    base: baseHints(model.id),
    // A new model needs a price.
    ...(input === undefined || output === undefined ? { updateOnly: true } : {}),
    ...(inputKinds.length > 0 && outputKinds.length > 0 ? { modalities: { input: inputKinds, output: outputKinds } } : {}),
    capabilities: {
      // A caller can pin any live provider, so one is enough.
      ...(live.some((provider) => provider.supports_tools === true) ? { tools: { supported: true } } : {}),
      ...(live.some((provider) => provider.supports_structured_output === true) ? { structured_output: true } : {}),
    },
    ...(context === undefined ? {} : { limit: { context } }),
    api: APIS,
    ...(input === undefined || output === undefined ? {} : { cost: { text: { input: { price: input }, output: { price: output } } } }),
  };
}

function price(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) / 1_000_000 : undefined;
}

function kinds(values: string[]) {
  return [...new Set(values.map((value) => value.toLowerCase()).filter((value) => KINDS.includes(value)))]
    .map((value) => (value === "pdf" ? "application/pdf" : value));
}

function baseHints(id: string) {
  const [org, ...rest] = id.split("/");
  if (org === undefined || rest.length === 0) return [];
  const namespace = ORG_NAMESPACES[org];
  return namespace === undefined ? namespaceHints(id) : namespaceHints(`${namespace}/${rest.join("/").toLowerCase()}`);
}
