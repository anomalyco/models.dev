// Venice: https://api.venice.ai/api/v1/models?type=text (public; VENICE_API_KEY optional).
// Authoritative for text models: name, image/audio/video input, limits,
// whether a model reasons and its effort values, tool calling, structured
// output (only ever turned on), token and cache prices with the long-context
// band, web search, deprecation, and the Responses API every text model has.
// On files without a base_model also family, release date and open weights.
// End-to-end encrypted models (Chat only) aren't synced. A new model is created
// when a lab file matches its ID or name.

import { readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { REPO_ROOT } from "../catalog.js";
import { bearer, fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";
import { inferFamily, reasoningControls } from "../units.js";

const API_ENDPOINT = "https://api.venice.ai/api/v1/models?type=text";

const Tier = z.object({ usd: z.number().nonnegative() }).passthrough();
const VeniceModel = z.object({
  created: z.number(),
  id: z.string().min(1),
  model_spec: z.object({
    pricing: z.object({
      input: Tier,
      output: Tier,
      cache_input: Tier.optional(),
      cache_write: Tier.optional(),
      extended: z.object({
        context_token_threshold: z.number().int().nonnegative(),
        input: Tier,
        output: Tier,
        cache_input: Tier.optional(),
        cache_write: Tier.optional(),
      }).passthrough().optional(),
    }).passthrough().optional(),
    deprecation: z.object({ date: z.string() }).passthrough().nullish(),
    availableContextTokens: z.number().int().nonnegative(),
    maxCompletionTokens: z.number().int().nonnegative().optional(),
    capabilities: z.object({
      supportsAudioInput: z.boolean().optional(),
      supportsE2EE: z.boolean().optional(),
      supportsFunctionCalling: z.boolean().optional(),
      supportsReasoning: z.boolean().optional(),
      reasoningEffortOptions: z.array(z.string()).optional(),
      supportsResponseSchema: z.boolean().optional(),
      supportsVideoInput: z.boolean().optional(),
      supportsVision: z.boolean().optional(),
      supportsWebSearch: z.boolean().optional(),
    }).passthrough(),
    name: z.string().min(1),
    modelSource: z.string().optional(),
  }).passthrough(),
}).passthrough();
type VeniceModel = z.infer<typeof VeniceModel>;

const VeniceResponse = z.object({ data: z.array(VeniceModel) }).passthrough();

// POST /responses serves every Venice text model, statelessly; E2EE models need Chat.
// https://docs.venice.ai/guides/features/responses-api
const RESPONSES_API = {
  base_url: "https://api.venice.ai/api/v1",
  sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" },
};
// $10.00 per 1K requests on models that support it: https://docs.venice.ai/overview/pricing#web-search-and-scraping
const WEB_SEARCH_PRICE = 10;

const BASE_MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4-6-fast": "anthropic/claude-opus-4-6",
  "claude-opus-4-7-fast": "anthropic/claude-opus-4-7",
  "claude-opus-4-8-fast": "anthropic/claude-opus-4-8",
  "openai-gpt-56-luna-pro": "openai/gpt-5.6-luna",
  "openai-gpt-56-sol-pro": "openai/gpt-5.6-sol",
  "openai-gpt-56-terra-pro": "openai/gpt-5.6-terra",
};

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const venice: SyncModule<unknown> = {
  id: "venice",
  name: "Venice",
  policy: {
    owns: [
      "name",
      { path: "family", standalone: true },
      { path: "release_date", standalone: true },
      { path: "open_weights", standalone: true },
      "status",
      { path: "modalities.input", merge: "kinds", only: ["image", "audio", "video"] },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.reasoning.effort",
      "capabilities.structured_output",
      "capabilities.temperature",
      "limit.context",
      "limit.output",
      { path: "api", merge: "tables" },
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.input.overrides",
      "cost.text.output.price",
      "cost.text.output.overrides",
      "cost.web_search",
    ],
    creates: "auto",
    removals: "delete",
  },
  fetch: () => {
    const key = process.env.VENICE_API_KEY;
    return fetchJSON(API_ENDPOINT, { source: "Venice models", headers: key ? bearer(key) : {} });
  },
  observe(raw) {
    return VeniceResponse.parse(raw).data.filter((model) => model.model_spec.capabilities.supportsE2EE !== true).map(observe);
  },
};

function observe(model: VeniceModel): Observation {
  const spec = model.model_spec;
  const caps = spec.capabilities;
  const effort = (caps.reasoningEffortOptions ?? []).filter((value) => EFFORTS.has(value));
  const base = resolveBase(model.id, spec.name);
  return {
    id: model.id.replaceAll("/", "-"),
    ...(base === undefined ? {} : { base: [base] }),
    name: spec.name,
    family: inferFamily(model.id, spec.name),
    release_date: new Date(model.created * 1000).toISOString().slice(0, 10),
    ...(spec.modelSource === undefined ? {} : { open_weights: spec.modelSource.toLowerCase().includes("huggingface") }),
    ...(spec.deprecation != null ? { status: "deprecated" } : {}),
    modalities: {
      input: ["text", ...(caps.supportsVision ? ["image"] : []), ...(caps.supportsAudioInput ? ["audio"] : []), ...(caps.supportsVideoInput ? ["video"] : [])],
      output: ["text"],
    },
    capabilities: {
      tools: { supported: caps.supportsFunctionCalling === true },
      reasoning: caps.supportsReasoning === true
        ? { supported: true, effort: effort.length > 0 ? reasoningControls({ effort }).effort! : null }
        : { supported: false },
      ...(caps.supportsResponseSchema === true ? { structured_output: true } : {}),
      temperature: null,
    },
    limit: { context: spec.availableContextTokens, output: spec.maxCompletionTokens ?? Math.floor(spec.availableContextTokens / 4) },
    api: { responses: RESPONSES_API },
    cost: {
      ...(spec.pricing === undefined ? {} : { text: textCost(spec.pricing) }),
      web_search: caps.supportsWebSearch === true ? { price: WEB_SEARCH_PRICE } : null,
    },
  };
}

function textCost(pricing: NonNullable<VeniceModel["model_spec"]["pricing"]>) {
  const extended = pricing.extended;
  const when = { context: { gt: extended?.context_token_threshold ?? 0 } };
  const cache = (read: number | undefined, write: number | undefined) => ({ read: read ?? null, write: write ?? null });
  return {
    input: {
      price: pricing.input.usd,
      cache: cache(pricing.cache_input?.usd, pricing.cache_write?.usd),
      ...(extended && { overrides: [{ when, price: extended.input.usd, ...cacheOverride(extended.cache_input?.usd, extended.cache_write?.usd) }] }),
    },
    output: {
      price: pricing.output.usd,
      ...(extended && { overrides: [{ when, price: extended.output.usd }] }),
    },
  };
}

function cacheOverride(read: number | undefined, write: number | undefined) {
  if (read === undefined && write === undefined) return {};
  return { cache: { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) } };
}

let labIndex: Array<{ id: string; full: string; file: string }> | undefined;

// A lab model whose `lab/file` or file name matches the ID or display name
// (ignoring case and punctuation, without a "fast" suffix), when only one does.
function resolveBase(id: string, name: string) {
  const alias = BASE_MODEL_ALIASES[id];
  if (alias !== undefined) return alias;
  labIndex ??= readdirSync(path.join(REPO_ROOT, "models"), { withFileTypes: true })
    .filter((lab) => lab.isDirectory())
    .flatMap((lab) => readdirSync(path.join(REPO_ROOT, "models", lab.name), { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith(".toml"))
      .map((file) => {
        const stem = file.name.slice(0, -".toml".length);
        return { id: `${lab.name}/${stem}`, full: normalize(`${lab.name}/${stem}`), file: normalize(stem) };
      }));
  const candidates = [id, name];
  for (const value of [id, name]) {
    if (value.toLowerCase().endsWith("-fast")) candidates.push(value.slice(0, -"-fast".length));
    const withoutFast = value.replace(/\s*\(?\s*fast\s*\)?\s*$/i, "").trim();
    if (withoutFast !== "" && withoutFast !== value) candidates.push(withoutFast);
  }
  for (const candidate of new Set(candidates)) {
    const key = normalize(candidate);
    for (const matches of [labIndex.filter((entry) => entry.full === key), labIndex.filter((entry) => entry.file === key)]) {
      if (matches.length === 1) return matches[0]!.id;
    }
  }
  return undefined;
}

const normalize = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
