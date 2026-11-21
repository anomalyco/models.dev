import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { providerModelToV2 } from "../../model-file-v2.js";
import type { SyncProvider, SyncedV2Model } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.concentrate.ai/v1/models";
const ROOT = path.join(import.meta.dir, "..", "..", "..", "..", "..");
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

const Money = z.object({ price: z.object({ USD: z.number().nonnegative() }), units: z.number().positive() });
const Tokens = z.object({
  input: Money,
  output: Money,
  cache: z.object({ read: Money.optional(), write: z.record(Money).optional() }).optional(),
});
const Price = z.object({
  condition: z.record(z.unknown()).optional(),
  tokens: Tokens.optional(),
  tool_calls: z.object({ web_search: Money.optional() }).passthrough().optional(),
});
const Formats = z.union([z.boolean(), z.record(z.boolean())]).optional();
const Route = z.object({
  pricing: z.array(Price),
  supports: z.object({
    endpoint: z.object({ chat: z.boolean(), decisions: z.boolean().optional() }).passthrough(),
    tools: z.object({ function_calling: z.boolean(), custom_tools: z.boolean().optional() }).passthrough(),
    reasoning: z.object({ effort: z.record(z.boolean()).optional() }).passthrough().optional(),
    input: z.object({ image: Formats, file: Formats }).passthrough(),
  }).passthrough(),
}).passthrough();
const Supported = z.object({ supported: z.boolean() }).passthrough();
export const ConcentrateModel = z.object({
  id: z.string(),
  author: z.object({ slug: z.string() }),
  max_input_tokens: z.number().int().positive(),
  max_tokens: z.number().int().positive(),
  capabilities: z.object({ effort: Supported, thinking: Supported, structured_outputs: Supported }).passthrough(),
  providers: z.record(Route),
}).passthrough();

export type ConcentrateModel = z.infer<typeof ConcentrateModel>;
type Route = z.infer<typeof Route>;
type Tokens = z.infer<typeof Tokens>;
type Money = z.infer<typeof Money>;

// IDs whose lab ID differs beyond dots-for-dashes and an `-it` / `-instruct` suffix.
// Fast, highspeed and contributor IDs serve the same weights on other capacity or pricing.
const BASE_MODEL_ALIASES: Record<string, string> = {
  "codestral": "mistral/codestral-2508",
  "deepseek-r1-distill-32b": "deepseek/deepseek-r1-distill-qwen-32b",
  "deepseek-v4-1-fast": "deepseek/deepseek-v4.1-flash-1017",
  "deepseek-v4-1-flash-fast": "deepseek/deepseek-v4.1-flash",
  "gemma-4-26b": "google/gemma-4-26b-a4b-it",
  "grok-4.20-non-reasoning": "xai/grok-4.20-0309-non-reasoning",
  "ibm-granite-micro": "ibm/granite-4-h-micro",
  "kimi-k3-1-pro-highspeed": "moonshotai/kimi-k3.1-pro",
  "llama-4-maverick": "meta/llama-4-maverick-17b-instruct",
  "llama-4-scout": "meta/llama-4-scout-17b-instruct",
  "minimax-m2-1-highspeed": "minimax/MiniMax-M2.1",
  "ministral-3-3b": "mistral/ministral-3-3b-instruct-2512",
  "ministral-3-8b": "mistral/ministral-3-8b-instruct-2512",
  "ministral-3-14b": "mistral/ministral-3-14b-instruct-2512",
  "mistral-large-3": "mistral/mistral-large-2512",
  "mistral-small-3.1": "mistral/mistral-small-3.1-24b-instruct",
  "mistral-small-3.2": "mistral/mistral-small-3.2-24b-instruct",
  "muse-ember": "meta/muse-ember-1.0",
  "muse-spark-1.2-contributor": "meta/muse-spark-1.2",
  "muse-spark-1.3-contributor": "meta/muse-spark-1.3",
  "muse-wonder": "meta/muse-wonder-1.0",
  "nemotron-3-120b": "nvidia/nemotron-3-super-120b-a12b",
  "nemotron-3-nano-30b": "nvidia/nemotron-3-nano-30b-a3b",
  "nemotron-3-ultra-nvfp4": "nvidia/nemotron-3-ultra-550b-a55b",
  "nemotron-3.5-super-vl": "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "nemotron-lightning-3.5-30b": "nvidia/nemotron-3.5-lightning",
  "qwen3-235b-a22b-instruct": "alibaba/qwen3-235b-a22b-instruct-2507",
  "qwen3-30b": "alibaba/qwen3-30b-a3b",
  "qwen3-30b-a3b-instruct": "alibaba/qwen3-30b-a3b-instruct-2507",
  "qwen3.6-35b": "alibaba/qwen3.6-35b-a3b",
};
// Not synced: Concentrate's PII redaction service (not a language model), and models whose
// Concentrate catalog entry is being corrected (effort levels, cache price, tool or structured-output support),
// models that didn't complete a tool call end to end in OpenCode, Claude Opus 4.1, which Anthropic has retired, and
// models whose reasoning showed up inconsistently live, and older models with edge-case data.
const NOT_MODELS = new Set([
  "redact-v1", "claude-opus-4-1", "deepseek-v3-2", "glm-4.7-flash",
  "command-a", "deepseek-r1-distill-32b", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemma-4-e4b",
  "gpt-4o", "gpt-5.2", "gpt-5.3-codex", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-oss-safeguard-120b",
  "glm-5.2", "gpt-oss-20b", "hy4-preview", "magistral-small-1.2", "qwen3-max-thinking",
  "muse-spark-1.3", "muse-spark-1.3-contributor",
  "gemma-3-4b", "gemma-3-27b", "gpt-oss-120b", "kimi-k2-thinking", "llama-3.1-8b-instruct", "llama-3.1-70b-instruct",
  "llama-3.2-1b-instruct", "llama-3.2-3b-instruct", "llama-3.3-70b-instruct", "llama-4-maverick", "llama-4-scout",
  "ministral-3-14b", "mistral-large-3", "mistral-nemo", "palmyra-x4", "palmyra-x5", "qwen3-32b", "qwen3-coder-30b-a3b",
]);

// Live probes on Concentrate, the evidence AGENTS.md asks for: a regex grammar (`ZZ[0-9]{3}`) enforced on custom tools,
// and reasoning that stays on at effort `none` where the routes take no other level. Other models publish neither
// until probed.
const PROBED = "2026-11-13";
const GRAMMAR_ENFORCED = new Set([
  "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5.1", "gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol",
  "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra",
]);
const ALWAYS_ON = new Set(["gpt-oss-safeguard-20b", "mistral-large-4"]);

export const concentrate = {
  id: "concentrate",
  name: "Concentrate",
  modelsDir: "providers/concentrate/models",
  authoritativeHeaders: true,
  sourceID: (model) => model.id,
  missingModelID: (model) => (NOT_MODELS.has(model.id) ? undefined : model.id),
  fetchModels: () => fetch(API_ENDPOINT).then((response) => response.json()),
  parseModels: (raw) => z.object({ data: z.array(ConcentrateModel), has_more: z.literal(false) }).parse(raw).data,
  translateModel: (model) => buildConcentrateModel(model),
} satisfies SyncProvider<ConcentrateModel>;

export function resolveConcentrateBaseModel(model: ConcentrateModel) {
  const owner = ({ mistral: "mistralai", stepfunai: "stepfun" } as Record<string, string>)[model.author.slug] ?? model.author.slug;
  const dotted = model.id.replace(/(\d)-(\d)(?=$|-|[a-z])/g, "$1.$2");
  return BASE_MODEL_ALIASES[model.id] ?? resolveCanonicalBaseModel(`${owner}/${model.id}`)
    ?? [model.id, dotted, `${model.id}-it`, `${dotted}-it`, `${model.id}-instruct`, `${dotted}-instruct`]
      .map((id) => resolveModelMetadataBaseModel(id)).find((id) => id !== undefined);
}

export function buildConcentrateModel(model: ConcentrateModel): SyncedV2Model | undefined {
  const chat = Object.entries(model.providers).filter(([, route]) => route.supports.endpoint.chat);
  const routes = chat.length > 0 ? chat : Object.entries(model.providers).filter(([, route]) => route.supports.endpoint.decisions);
  const base = resolveConcentrateBaseModel(model);
  if (NOT_MODELS.has(model.id) || routes.length === 0 || base === undefined) return undefined;

  // Concentrate picks a route per request, so each price is the highest any route charges at that prompt size: an
  // upper bound at the default tier.
  const lab = base.split("/")[0]!;
  const top = (size: number) => {
    const prices = routes.map(([, route]) => priceAt(route, size)).filter((price) => price?.tokens !== undefined) as z.infer<typeof Price>[];
    return prices.length === 0 ? undefined : highestPrices(prices);
  };
  const chosen = top(0);
  const labFile = readToml(path.join(ROOT, "models", `${base}.toml`));
  // A relay serves no more than the model takes; the catalog can over-report a route's limit.
  const limit = { context: capped(model.max_input_tokens, labFile?.limit?.context), output: capped(model.max_tokens, labFile?.limit?.output) };
  const firstParty = labCapabilities(base);
  const thresholds = [...new Set(routes.flatMap(([, route]) => tiers(route).map((tier) => Number(tier.condition!.input_gte))))];
  const price = chosen && cost(chosen, thresholds.filter((size) => size < limit.context).sort((a, b) => a - b).map((size) => [size, top(size)!] as const), firstParty?.cache?.explicit?.ttl ?? firstParty?.cache?.implicit?.ttl);

  // Decision models answer TypeSafe's System One format at /v1/systemone.
  if (chat.length === 0) {
    const systemone = { sdk: { aisdk: "@ai-sdk/typesafe-ai", opencodeai: "@opencode/ai/providers/typesafe-ai/decisions" } };
    // System One takes model, state and questions only (no sampling parameters), and answers are structured.
    const sampling = Object.fromEntries(["temperature", "top_p", "top_k"].filter((key) => labFile?.capabilities?.[key] === true).map((key) => [key, false]));
    const capabilities = { structured_output: true, ...sampling };
    const decisionLimit = clean({ context: limit.context === labFile?.limit?.context ? undefined : limit.context });
    return { id: model.id, v2: clean({ schema: 2, v2_only: labFile?.v2_only, base_model: base, modalities: modalities(routes.map(([, route]) => route.supports), labFile, false), capabilities, limit: decisionLimit, api: { systemone }, cost: price }), ...(Object.keys(decisionLimit).length ? { header: `# Limit: max_input_tokens ${model.max_input_tokens} at ${API_ENDPOINT}, capped at the lab's` } : {}) };
  }

  // Concentrate routes each request to a route serving the features it uses, so a capability holds if any route serves it.
  const supports = routes.map(([, route]) => route.supports);
  const efforts = EFFORTS.filter((level) => supports.some((s) => s.reasoning?.effort?.[level] === true));
  const doc = providerModelToV2(factorBaseModel(base, {
    tool_call: supports.some((s) => s.tools.function_calling),
    structured_output: model.capabilities.structured_outputs.supported || undefined,
    limit,
  }), "responses", "@ai-sdk/openai") as Record<string, any>;
  delete doc.api;

  const input = modalities(supports, labFile, true);
  if (input) doc.modalities = input;

  // Claude uses the Messages API, where prompt caching and Anthropic's thinking fields are native.
  const claude = lab === "anthropic";
  const thinks = model.capabilities.thinking.supported || model.capabilities.effort.supported || labFile?.capabilities?.reasoning?.supported === true;
  doc.capabilities = clean({
    ...doc.capabilities,
    reasoning: thinks ? reasoning(firstParty?.reasoning, efforts, claude) : undefined,
    cache: chosen?.tokens?.cache?.read === undefined ? undefined : typeof firstParty?.cache === "object" ? firstParty.cache : { implicit: true },
  });
  // A reasoning model left with no controls where the reference has them needs an always-on probe; until then it's
  // left out rather than published as having no caller control.
  const controls = (value: Record<string, any> | undefined) => Boolean(value?.toggle || value?.effort || value?.budget);
  const ownReasoning = doc.capabilities.reasoning;
  if (ownReasoning?.supported && !controls(ownReasoning) && controls(firstParty?.reasoning) && !ALWAYS_ON.has(model.id)) return undefined;
  // Custom tools (free-form and grammar formats) take the lab's formats where a route accepts them.
  const freeform = GRAMMAR_ENFORCED.has(model.id) && supports.some((s) => s.tools.custom_tools === true) ? firstParty?.freeform : undefined;
  if (freeform !== undefined) doc.capabilities.tools = { ...doc.capabilities.tools, supported: true, freeform };
  if (claude) doc.api = { messages: { sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic-compatible" } } };
  if (price === undefined) delete doc.cost;
  else doc.cost = price;
  const header = [
    doc.capabilities.reasoning?.toggle === true
      ? claude ? "# Toggle: thinking.type = enabled|disabled" : "# Toggle: reasoning.effort = none (off) | omitted (on); reasoning_effort on Chat Completions"
      : undefined,
    ALWAYS_ON.has(model.id) && doc.capabilities.reasoning?.supported && !doc.capabilities.reasoning.toggle && !doc.capabilities.reasoning.effort
      ? `# Always on: reasons even at reasoning.effort none, and the routes take no other level (live probe ${PROBED})` : undefined,
    doc.limit ? `# Limit: max_input_tokens ${model.max_input_tokens}, max_tokens ${model.max_tokens} at ${API_ENDPOINT}, capped at the lab's` : undefined,
    freeform !== undefined ? `# Custom tools: regex grammar ZZ[0-9]{3} enforced on Responses (live probe ${PROBED})` : undefined,
  ].filter(Boolean).join("\n");
  return { id: model.id, v2: doc, ...(header ? { header } : {}) };
}


// The lab's controls on the levels this host accepts, never the full list the routes take: a lab toggle becomes
// `none`, and Claude keeps Anthropic's fields.
function reasoning(lab: Record<string, any> | undefined, efforts: string[], claude: boolean) {
  const labEffort: string[] = lab?.effort ?? [];
  const effort = efforts.filter((level) => labEffort.includes(level) || (level === "none" && lab?.toggle === true && !claude));
  // An off switch with no graded levels is a toggle (`none` off, omitted on), as relays such as Bothub publish it.
  const onOff = effort.length === 1 && effort[0] === "none";
  return clean({
    supported: true,
    toggle: claude ? lab?.toggle : onOff || undefined,
    effort: effort.length > 0 && !onOff ? effort : undefined,
    budget: claude ? lab?.budget : undefined,
  });
}

// Capabilities (reasoning, cache, tools) from the lab's own provider file, else OpenRouter's, else another peer's.
let peerCapabilities: Map<string, Record<string, any>> | undefined;
function labCapabilities(base: string) {
  if (peerCapabilities === undefined) {
    peerCapabilities = new Map();
    const dir = path.join(ROOT, "providers");
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((file) => file.endsWith(".toml") && file.includes("/models/") && !file.startsWith("concentrate/"));
    // OpenRouter first, and a peer that reasons over one that marks the model as not reasoning (e.g. a local quantized build).
    const peers = files.map((file) => ({ file, toml: readToml(path.join(dir, file)) }))
      .filter(({ toml }) => typeof toml?.base_model === "string" && toml.capabilities?.reasoning !== undefined)
      .sort((a, b) => Number(b.toml!.capabilities.reasoning.supported === true) - Number(a.toml!.capabilities.reasoning.supported === true)
        || Number(b.file.startsWith("openrouter/")) - Number(a.file.startsWith("openrouter/")));
    for (const { toml } of peers) if (!peerCapabilities.has(toml!.base_model)) peerCapabilities.set(toml!.base_model, capabilitiesOf(toml));
  }
  const [lab, ...rest] = base.split("/");
  return capabilitiesOf(readToml(path.join(ROOT, "providers", lab!, "models", `${rest.join("/")}.toml`))) ?? peerCapabilities.get(base);
}
// Free-form formats sit on the top-level tools or on the Responses table (e.g. OpenAI's gpt-6-luna).
const capabilitiesOf = (toml: Record<string, any> | undefined) => toml?.capabilities && {
  ...toml.capabilities,
  freeform: toml.capabilities.tools?.freeform ?? toml.api?.responses?.capabilities?.tools?.freeform,
};

// The standard price: no condition, or a scheduled change that has already started.
function standardPrice(route: Route): z.infer<typeof Price> | undefined {
  return route.pricing
    .filter((price) => price.tokens !== undefined && Number(price.condition?.date_gte ?? 0) <= Date.now()
      && Object.keys(price.condition ?? {}).every((key) => key === "date_gte" || key === "description"))
    .sort((a, b) => Number(b.condition?.date_gte ?? 0) - Number(a.condition?.date_gte ?? 0))[0];
}

// A route's `input_gte` tiers at the default tier, lowest first; `input_gte` is where a band starts (inclusive).
const tiers = (route: Route) => route.pricing
  .filter((price) => price.tokens !== undefined && typeof price.condition?.input_gte === "number"
    && Object.keys(price.condition).every((key) => key === "input_gte" || key === "description"))
  .sort((a, b) => Number(a.condition!.input_gte) - Number(b.condition!.input_gte));
const priceAt = (route: Route, size: number) => tiers(route).filter((tier) => Number(tier.condition!.input_gte) <= size).at(-1) ?? standardPrice(route);

// The highest input, output, cache and web search prices across routes.
function highestPrices(prices: z.infer<typeof Price>[]): z.infer<typeof Price> {
  const tokens = prices.map((price) => price.tokens!);
  const writes = [...new Set(tokens.flatMap((price) => Object.keys(price.cache?.write ?? {})))];
  return {
    tokens: {
      input: highest(tokens.map((price) => price.input))!,
      output: highest(tokens.map((price) => price.output))!,
      cache: clean({ read: highest(tokens.map((price) => price.cache?.read)), write: clean(Object.fromEntries(writes.map((key) => [key, highest(tokens.map((price) => price.cache?.write?.[key]))]))) as Record<string, Money> }),
    },
    tool_calls: clean({ web_search: highest(prices.map((price) => price.tool_calls?.web_search)) }),
  };
}
const highest = (moneys: (Money | undefined)[]) => moneys.filter((money) => money !== undefined).sort((a, b) => perMillion(b!) - perMillion(a!))[0];

// Standard prices, context overrides where a band costs more, and web search per 1,000 calls.
function cost(standard: z.infer<typeof Price>, bands: (readonly [number, z.infer<typeof Price>])[], ttls?: string[]) {
  const tokens = standard.tokens!;
  // Write prices are keyed by the reference's cache TTLs (an unnamed one takes the first), leaving out TTLs it doesn't
  // offer; when it lists no TTLs, the write price is a plain price, as the lab publishes it.
  const cache = (cached: Tokens["cache"]) => {
    const first = Object.values(cached?.write ?? {})[0];
    return clean({
      read: cached?.read && perMillion(cached.read),
      write: ttls === undefined ? first && perMillion(first) : clean(Object.fromEntries(Object.entries(cached?.write ?? {}).flatMap(([key, money]) => {
        const ttl = key.match(/^ephemeral_(\w+)_input_tokens$/)?.[1] ?? (key === "cache_write_tokens" ? ttls?.[0] : undefined);
        return ttl === undefined || !ttls.includes(ttl) ? [] : [[ttl, perMillion(money)]];
      }))),
    });
  };
  // A band that costs the same as the one below it adds nothing.
  const band = (price: z.infer<typeof Price>) => JSON.stringify(cache(price.tokens!.cache)) + [price.tokens!.input, price.tokens!.output].map(perMillion);
  const overrides = bands.filter(([, price], index) => band(price) !== band(index === 0 ? standard : bands[index - 1]![1]));
  const search = standard.tool_calls?.web_search;
  return clean({
    text: {
      input: clean({
        price: perMillion(tokens.input),
        cache: cache(tokens.cache),
        overrides: overrides.length === 0 ? undefined : overrides.map(([gte, price]) => clean({ when: { context: { gte } }, price: perMillion(price.tokens!.input), cache: cache(price.tokens!.cache) })),
      }),
      output: clean({
        price: perMillion(tokens.output),
        overrides: overrides.length === 0 ? undefined : overrides.map(([gte, price]) => ({ when: { context: { gte } }, price: perMillion(price.tokens!.output) })),
      }),
    },
    web_search: search && { price: round(search.price.USD * 1000 / search.units) },
  });
}

// The image types (and PDFs) any route takes, when they differ from the lab's. Routes read PDFs natively or the gateway
// extracts their text; the router sends a PDF to a route that takes one. System One takes no files.
function modalities(supports: Route["supports"][], labFile: Record<string, any> | undefined, files: boolean) {
  const input = ["text", ...Object.entries(IMAGE_TYPES).filter(([format]) => supports.some((s) => accepts(s.input.image, format))).map(([, type]) => type)];
  if (files && supports.some((s) => accepts(s.input.file, "pdf"))) input.push("application/pdf");
  const labInput: string[] = labFile?.modalities?.input ?? [];
  return input.length !== labInput.length || input.some((type) => !labInput.includes(type)) ? { input, output: ["text"] } : undefined;
}

function readToml(file: string | undefined): Record<string, any> | undefined {
  return file !== undefined && existsSync(file) ? Bun.TOML.parse(readFileSync(file, "utf8")) as any : undefined;
}
const accepts = (formats: z.infer<typeof Formats>, format: string) => (typeof formats === "object" ? formats[format] === true : formats === true);
const capped = (value: number, lab: unknown) => (typeof lab === "number" ? Math.min(value, lab) : value);
const perMillion = (money: Money) => round(money.price.USD * 1_000_000 / money.units);
const round = (value: number) => Math.round(value * 1e6) / 1e6;
function clean<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined
    && !(typeof item === "object" && item !== null && !Array.isArray(item) && Object.keys(item).length === 0))) as T;
}
