// Eden AI: https://api.edenai.run/v3/models (public). Every route is
// `<upstream>/<model>`, and each is filed under its lab model. Authoritative
// for token, cache, reasoning and audio prices (context tiers as bands), the
// context window, input and output kinds, tools and structured output. Names
// are generated for regional, `-latest` and non-first-party routes; others
// inherit the lab's, and descriptions are always the lab's. Reasoning efforts
// come from the lab's first-party provider file, else OpenRouter's file for
// the same lab model (the module reads both). A route is skipped (and its file
// deleted) when it has no lab file, its lab has no output limit, a first-party
// route exists for the same lab, or it reasons with no known efforts.

import { readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { readProviderModel } from "../../translate.js";
import { Labs, REPO_ROOT } from "../catalog.js";
import { fetchJSON } from "../http.js";
import { labHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.edenai.run/v3/models";
const PROVIDERS_DIR = path.join(REPO_ROOT, "providers");
const ACCEPTED_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const REGION_SUFFIX = /@[a-z0-9-]+$/i;
const DOTTED_VENDOR = /^[a-z0-9-]+\./;
const VERSION_TAIL = /-v\d+:\d+$/;
const DATE_TAIL = /-\d{8}$/;
const DATABRICKS_PREFIX = "databricks-";
const TIER_KEY = /^input_cost_per_token_above_(\d+)k_tokens$/;
const MODALITY_BY_EDENAI: Record<string, string> = { text: "text", image: "image", audio: "audio", video: "video", file: "pdf" };

// Lab directory to the upstreams that are its first-party routes.
const LAB_UPSTREAMS: Record<string, readonly string[]> = {
  alibaba: ["qwen"],
  amazon: ["amazon"],
  anthropic: ["anthropic"],
  cohere: ["cohere"],
  deepseek: ["deepseek"],
  google: ["google", "vertex"],
  microsoft: ["microsoft"],
  minimax: ["minimax"],
  mistral: ["mistral"],
  moonshotai: ["moonshot"],
  openai: ["openai"],
  perplexity: ["perplexityai"],
  xai: ["xai"],
  zhipuai: ["zai"],
};

const ROUTE_LABELS: Record<string, string> = {
  amazon: "Amazon Bedrock",
  azure: "Azure",
  cerebras: "Cerebras",
  cloudflare: "Cloudflare",
  compactifai: "CompactifAI",
  databricks: "Databricks",
  deepinfra: "Deep Infra",
  fireworks_ai: "Fireworks AI",
  flexai: "FlexAI",
  groq: "Groq",
  infomaniak: "Infomaniak",
  ionos: "IONOS",
  lilac: "Lilac",
  nebius: "Nebius",
  ovhcloud: "OVHcloud",
  qwen: "Alibaba",
  scaleway: "Scaleway",
  tensorx: "TensorX",
  together_ai: "Together AI",
  vertex: "Vertex AI",
};

const Pricing = z.object({
  input_cost_per_token: z.number().nullish(),
  output_cost_per_token: z.number().nullish(),
  output_cost_per_reasoning_token: z.number().nullish(),
  cache_read_input_token_cost: z.number().nullish(),
  cache_creation_input_token_cost: z.number().nullish(),
  input_cost_per_audio_token: z.number().nullish(),
}).passthrough();
type Pricing = z.infer<typeof Pricing>;

const EdenAIModel = z.object({
  id: z.string().min(1),
  owned_by: z.string().min(1),
  model_name: z.string().min(1),
  context_length: z.number().nullish(),
  capabilities: z.object({
    input_modalities: z.array(z.string()).nullish(),
    output_modalities: z.array(z.string()).nullish(),
    supports_function_calling: z.boolean().optional(),
    supports_response_schema: z.boolean().optional(),
  }).passthrough(),
  pricing: Pricing.nullish(),
  list_pricing: Pricing.nullish(),
  alias_of: z.string().nullish(),
}).passthrough();
type EdenAIModel = z.infer<typeof EdenAIModel>;

const EdenAIResponse = z.object({ object: z.literal("list"), data: z.array(EdenAIModel) }).passthrough();

let labs: Labs | undefined;
// Reasoning models with no efforts known elsewhere: they keep their file's
// controls, and are skipped when there is no file.
const unknownEfforts = new WeakSet<Observation>();

export const edenai: SyncModule<unknown> = {
  id: "edenai",
  name: "Eden AI",
  policy: {
    owns: [
      "name",
      "description",
      "base_model_omit",
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      "limit.context",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      { path: "cost.text.input.overrides", merge: "bands" },
      "cost.text.output.price",
      "cost.text.output.reasoning",
      { path: "cost.text.output.overrides", merge: "bands" },
      "cost.audio.input.price",
    ],
    creates: "auto",
    removals: "delete",
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Eden AI models" }),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    // IDs differing only in case are one route: the lowercase one wins, and
    // a missing context window comes from the other.
    const unique = new Map<string, EdenAIModel>();
    for (const model of EdenAIResponse.parse(raw).data) {
      const key = model.id.toLowerCase();
      const previous = unique.get(key);
      const preferred = model.id === key ? model : previous ?? model;
      unique.set(key, { ...preferred, context_length: preferred.context_length ?? previous?.context_length ?? model.context_length });
    }
    const models = [...unique.values()];
    const resolved = new Map(models.map((model) => [model, resolveBase(model, labs!)]));
    const firstParty = new Set(models.flatMap((model) => {
      const base = resolved.get(model);
      return base !== undefined && isFirstPartyRoute(model, base) ? [base] : [];
    }));
    return models.flatMap((model) => observe(model, resolved.get(model), firstParty, labs!));
  },
  refine(observation, file) {
    if (!unknownEfforts.has(observation)) return observation;
    const controls = (file?.capabilities as { reasoning?: object } | undefined)?.reasoning;
    return controls === undefined ? { id: observation.id, updateOnly: true } : observation;
  },
};

function observe(model: EdenAIModel, base: string | undefined, firstParty: ReadonlySet<string>, labs: Labs): Observation[] {
  if (base === undefined) return [];
  const lab = labs.get(base)!;
  if (typeof (lab.limit as { output?: unknown } | undefined)?.output !== "number") return [];
  if (firstParty.has(base) && !isFirstPartyRoute(model, base)) return [];
  const labModalities = lab.modalities as { input?: string[]; output?: string[] } | undefined;
  const imageModel = lab.type === "image";
  const hasImage = (list: string[] | undefined) => list?.some((value) => value.startsWith("image")) ?? false;
  const input = withImage(kinds(model.capabilities.input_modalities), imageModel && hasImage(labModalities?.input));
  const output = withImage(kinds(model.capabilities.output_modalities), imageModel && hasImage(labModalities?.output));
  const reasoning = (lab.capabilities as { reasoning?: { supported?: boolean } } | undefined)?.reasoning?.supported === true;
  const efforts = reasoning ? reasoningFor(base) : undefined;
  const context = model.context_length != null && model.context_length > 0 ? model.context_length : undefined;
  const labInput = (lab.limit as { input?: number; context?: number } | undefined);
  const capabilities = model.capabilities;
  const observation = {
    id: model.id,
    base: [base],
    name: displayName(model, base, String(lab.name ?? "")) ?? null,
    description: null,
    ...({ base_model_omit: context !== undefined && labInput?.input !== undefined && labInput.context !== context ? ["limit.input"] : null } as object),
    ...(input !== undefined && output !== undefined ? { modalities: { input: mime(input), output: mime(output) } } : {}),
    capabilities: {
      ...(capabilities.supports_function_calling === undefined ? {} : { tools: { supported: capabilities.supports_function_calling } }),
      ...(reasoning && efforts !== undefined ? { reasoning: { toggle: null, budget: null, effort: efforts === "always-on" ? null : efforts as never } } : {}),
      ...(capabilities.supports_response_schema === undefined ? {} : { structured_output: capabilities.supports_response_schema }),
    },
    ...(context === undefined ? {} : { limit: { context } }),
    ...cost(model, reasoning),
  } as Observation;
  if (reasoning && efforts === undefined) unknownEfforts.add(observation);
  return [observation];
}

function cost(model: EdenAIModel, reasoning: boolean) {
  const pricing = model.list_pricing ?? model.pricing;
  if (pricing == null || pricing.input_cost_per_token == null || pricing.output_cost_per_token == null) return {};
  const raw = pricing as Record<string, unknown>;
  const thresholds = Object.keys(raw).map((key) => TIER_KEY.exec(key)?.[1]).filter((value): value is string => value !== undefined).map(Number).sort((a, b) => a - b);
  const bands = thresholds.flatMap((threshold) => {
    const suffix = `_above_${threshold}k_tokens`;
    const input = raw[`input_cost_per_token${suffix}`];
    const output = raw[`output_cost_per_token${suffix}`];
    if (typeof input !== "number" || typeof output !== "number") return [];
    const read = charged(raw[`cache_read_input_token_cost${suffix}`]);
    const write = charged(raw[`cache_creation_input_token_cost${suffix}`]);
    return [{ size: threshold * 1_000, input: perMillion(input), output: perMillion(output), read, write }];
  });
  const when = (size: number) => ({ context: { gt: size } });
  return {
    cost: {
      text: {
        input: {
          price: perMillion(pricing.input_cost_per_token),
          cache: { read: charged(pricing.cache_read_input_token_cost) ?? null, write: charged(pricing.cache_creation_input_token_cost) ?? null },
          overrides: bands.length === 0 ? null : bands.map((band) => ({
            when: when(band.size),
            price: band.input,
            ...(band.read === undefined && band.write === undefined ? {} : { cache: { ...(band.read === undefined ? {} : { read: band.read }), ...(band.write === undefined ? {} : { write: band.write }) } }),
          })),
        },
        output: {
          price: perMillion(pricing.output_cost_per_token),
          reasoning: (reasoning ? charged(pricing.output_cost_per_reasoning_token) : undefined) ?? null,
          overrides: bands.length === 0 ? null : bands.map((band) => ({ when: when(band.size), price: band.output })),
        },
      },
      audio: { input: { price: charged(pricing.input_cost_per_audio_token) ?? null } },
    },
  };
}

function resolveBase(model: EdenAIModel, labs: Labs) {
  const names = [model.model_name.replace(REGION_SUFFIX, "")];
  if (model.alias_of != null) {
    const target = model.alias_of.split("/").slice(1).join("/");
    if (target.length > 0) names.push(target);
  }
  for (const name of names) {
    for (const candidate of candidates(name)) {
      for (const hint of labHints(candidate)) {
        const found = labs.find(hint);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

function candidates(name: string) {
  const result = [name];
  if (DOTTED_VENDOR.test(name)) {
    const dotted = name.replace(".", "/");
    result.push(dotted, dotted.replace(VERSION_TAIL, "").replace(DATE_TAIL, ""));
  }
  const last = name.split("/").at(-1) ?? name;
  result.push(last);
  if (last.startsWith(DATABRICKS_PREFIX)) result.push(last.slice(DATABRICKS_PREFIX.length));
  result.push(last.replace(VERSION_TAIL, "").replace(DATE_TAIL, ""));
  return [...new Set(result)].filter((candidate) => candidate.length > 0);
}

function isFirstPartyRoute(model: EdenAIModel, base: string) {
  return (LAB_UPSTREAMS[base.split("/")[0] ?? ""] ?? []).includes(model.owned_by);
}

function titleCase(slug: string) {
  return slug.split(/[-_]/).filter((word) => word.length > 0)
    .map((word) => (word.toLowerCase() === "gpt" ? "GPT" : word[0]!.toUpperCase() + word.slice(1).toLowerCase())).join(" ");
}

function isLatestAlias(model: EdenAIModel) {
  if (model.alias_of == null) return false;
  const id = model.id.replace(REGION_SUFFIX, "");
  if (id.toLowerCase() === model.alias_of.replace(REGION_SUFFIX, "").toLowerCase()) return false;
  return /(?:^|-)latest$/i.test(id.split("/").at(-1) ?? id);
}

// "<Lab name> (<route>, <REGION>)" for routes that aren't the lab's plain first-party one.
function displayName(model: EdenAIModel, base: string, canonical: string) {
  const region = REGION_SUFFIX.exec(model.id)?.[0].slice(1);
  const latest = isLatestAlias(model);
  const primary = LAB_UPSTREAMS[base.split("/")[0] ?? ""]?.[0];
  const route = model.owned_by === primary ? undefined : ROUTE_LABELS[model.owned_by] ?? titleCase(model.owned_by);
  if (region === undefined && !latest && route === undefined) return undefined;
  if (canonical === "") return undefined;
  const head = latest ? titleCase(model.id.replace(REGION_SUFFIX, "").split("/").at(-1) ?? "") : canonical;
  const details = [...(latest ? [canonical] : []), ...(route === undefined ? [] : [route]), ...(region === undefined ? [] : [region.toUpperCase()])];
  return `${head} (${details.join(", ")})`;
}

// Effort values a provider file's reasoning options list; `always-on` for none.
function effortValues(options: unknown): string[] | "always-on" | undefined {
  if (!Array.isArray(options)) return undefined;
  if (options.length === 0) return "always-on";
  let toggled = false;
  let accepted: string[] | undefined;
  for (const option of options as Array<{ type?: unknown; values?: unknown }>) {
    if (option?.type === "toggle") toggled = true;
    if (option?.type !== "effort" || !Array.isArray(option.values)) continue;
    const filtered = option.values.filter((value): value is string => typeof value === "string" && ACCEPTED_EFFORTS.has(value));
    if (filtered.length > 0) accepted = filtered;
  }
  if (accepted === undefined) return undefined;
  return toggled && !accepted.includes("none") ? ["none", ...accepted] : accepted;
}

function read(file: string) {
  try {
    return readProviderModel(file);
  } catch {
    return undefined;
  }
}

function tomlFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => (entry.isDirectory() ? tomlFiles(path.join(dir, entry.name)) : entry.name.endsWith(".toml") ? [path.join(dir, entry.name)] : []));
}

let peers: Map<string, string[] | "always-on"> | undefined;

// The first OpenRouter file filed under each lab model, by its efforts.
function peerEfforts() {
  if (peers !== undefined) return peers;
  peers = new Map();
  for (const file of tomlFiles(path.join(PROVIDERS_DIR, "openrouter", "models"))) {
    const model = read(file);
    const base = model?.base_model;
    if (typeof base !== "string" || peers.has(base)) continue;
    const values = effortValues(model?.reasoning_options);
    if (values !== undefined) peers.set(base, values);
  }
  return peers;
}

function reasoningFor(base: string) {
  const [lab, ...rest] = base.split("/");
  return effortValues(read(path.join(PROVIDERS_DIR, lab ?? "", "models", `${rest.join("/")}.toml`))?.reasoning_options) ?? peerEfforts().get(base);
}

function perMillion(price: number) {
  return Math.round(price * 1_000_000 * 1_000_000) / 1_000_000;
}

function charged(price: unknown) {
  return typeof price === "number" && price > 0 ? perMillion(price) : undefined;
}

function kinds(values: readonly string[] | null | undefined) {
  if (values == null) return undefined;
  const mapped = [...new Set(values.map((value) => MODALITY_BY_EDENAI[value.toLowerCase()]).filter((value): value is string => value !== undefined))];
  return mapped.length > 0 ? mapped : undefined;
}

function withImage(values: string[] | undefined, add: boolean) {
  if (values === undefined || !add || values.includes("image")) return values;
  return [...values, "image"];
}

function mime(values: string[]) {
  return values.map((value) => (value === "pdf" ? "application/pdf" : value));
}
