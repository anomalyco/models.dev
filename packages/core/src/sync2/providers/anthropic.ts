// Anthropic: https://api.anthropic.com/v1/models (ANTHROPIC_API_KEY), plus
// GET /v1/models/{alias} for each undated alias, and the pricing page
// https://platform.claude.com/docs/en/about-claude/pricing (as markdown).
// Authoritative: display name, release date (files without a base_model),
// context and output limits, image and PDF input, structured output, whether a
// model thinks, its effort levels, whether it takes a token budget, token and
// cache prices, and a deprecated or retired label on the pricing table.
// A new model is created when models/anthropic has it.

import { z } from "zod";

import { fetchJSON, fetchText, requireEnv } from "../http.js";
import type { Observation, SyncModule } from "../types.js";
import { reasoningControls } from "../units.js";

const API_ENDPOINT = "https://api.anthropic.com/v1/models";
const PRICING_ENDPOINT = "https://platform.claude.com/docs/en/about-claude/pricing";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const Support = z.object({ supported: z.boolean() }).passthrough();

const AnthropicModel = z.object({
  id: z.string(),
  canonical_id: z.string().optional(),
  display_name: z.string(),
  created_at: z.string(),
  max_input_tokens: z.number().int().nonnegative(),
  max_tokens: z.number().int().nonnegative(),
  capabilities: z.object({
    effort: z.object({
      supported: z.boolean(),
      low: Support.optional(),
      medium: Support.optional(),
      high: Support.optional(),
      xhigh: Support.optional(),
      max: Support.optional(),
    }).passthrough().optional(),
    image_input: Support.optional(),
    pdf_input: Support.optional(),
    structured_outputs: Support.optional(),
    thinking: z.object({
      supported: z.boolean(),
      types: z.object({ adaptive: Support.optional(), enabled: Support.optional() }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
type AnthropicModel = z.infer<typeof AnthropicModel>;

const AnthropicPage = z.object({
  data: z.array(AnthropicModel),
  has_more: z.boolean(),
  last_id: z.string().nullable().optional(),
}).passthrough();

const AnthropicResponse = z.object({ models: z.array(AnthropicModel), pricing: z.string() });

export interface AnthropicPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  deprecated: boolean;
}

export const anthropic: SyncModule<unknown> = {
  id: "anthropic",
  name: "Anthropic",
  policy: {
    owns: [
      "name",
      { path: "release_date", standalone: true },
      "status",
      "limit.context",
      "limit.output",
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.reasoning.supported",
      "capabilities.reasoning.effort",
      { path: "capabilities.reasoning.budget", merge: "tables" },
      "capabilities.structured_output",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
    ],
    creates: "auto",
    removals: "delete",
  },
  async fetch() {
    const key = requireEnv("Anthropic", "ANTHROPIC_API_KEY");
    const [models, pricing] = await Promise.all([fetchAllModels(key), fetchText(PRICING_ENDPOINT, { source: "Anthropic pricing", headers: { Accept: "text/markdown" } })]);
    return { models: [...models, ...await fetchAliases(key, models)], pricing };
  },
  observe(raw) {
    const response = AnthropicResponse.parse(raw);
    const pricing = parseAnthropicPricing(response.pricing);
    return response.models.map((model) => observe(model, pricing.get(normalizeModelName(model.display_name))));
  },
};

const headers = (key: string) => ({ "anthropic-version": "2023-06-01", "x-api-key": key });

async function fetchAllModels(key: string) {
  const models: AnthropicModel[] = [];
  let afterID: string | undefined;
  do {
    const url = new URL(API_ENDPOINT);
    url.searchParams.set("limit", "1000");
    if (afterID !== undefined) url.searchParams.set("after_id", afterID);
    const page = AnthropicPage.parse(await fetchJSON(url.toString(), { source: "Anthropic models", headers: headers(key) }));
    models.push(...page.data);
    if (page.has_more && page.last_id === undefined) throw new Error("Anthropic models response has_more without last_id");
    afterID = page.has_more ? page.last_id ?? undefined : undefined;
  } while (afterID !== undefined);
  return models;
}

// The list has dated IDs only; an undated alias (claude-haiku-4-5) answers on its own URL.
async function fetchAliases(key: string, models: AnthropicModel[]) {
  const listed = new Set(models.map((model) => model.id));
  const candidates = [...new Set(models.map((model) => model.id.replace(/-\d{8}$/, "")).filter((id) => !listed.has(id)))];
  const aliases = await Promise.all(candidates.map(async (id) => {
    const response = await fetch(`${API_ENDPOINT}/${id}`, { headers: headers(key) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Anthropic model alias request failed for ${id}: ${response.status} ${response.statusText}`);
    const model = AnthropicModel.parse(await response.json());
    return { ...model, id, canonical_id: model.id };
  }));
  return aliases.filter((model) => model !== undefined);
}

function observe(model: AnthropicModel, pricing: AnthropicPricing | undefined): Observation {
  const { capabilities } = model;
  const alias = model.canonical_id !== undefined;
  const created = Date.parse(model.created_at);
  return {
    id: model.id,
    base: [`anthropic/${model.id}`],
    name: alias && !model.display_name.endsWith("(latest)") ? `${model.display_name} (latest)` : model.display_name,
    ...(Number.isFinite(created) && created > 0 ? { release_date: new Date(created).toISOString().slice(0, 10) } : {}),
    ...(pricing?.deprecated ? { status: "deprecated" } : {}),
    limit: {
      ...(model.max_input_tokens > 0 ? { context: model.max_input_tokens } : {}),
      ...(model.max_tokens > 0 ? { output: model.max_tokens } : {}),
    },
    modalities: {
      input: ["text", ...(capabilities.image_input?.supported ? ["image"] : []), ...(capabilities.pdf_input?.supported ? ["application/pdf"] : [])],
      output: ["text"],
    },
    capabilities: {
      ...(capabilities.structured_outputs === undefined ? {} : { structured_output: capabilities.structured_outputs.supported }),
      ...(capabilities.thinking === undefined ? {} : { reasoning: reasoning(model) }),
    },
    ...(pricing === undefined ? {} : {
      cost: {
        text: {
          input: { price: pricing.input, cache: { read: pricing.cacheRead, write: { "5m": pricing.cacheWrite5m, "1h": pricing.cacheWrite1h } } },
          output: { price: pricing.output },
        },
      },
    }),
  };
}

// Effort levels come from capabilities.effort; a budget from thinking type
// "enabled" (the file keeps its own minimum). A toggle stays as authored.
function reasoning(model: AnthropicModel) {
  const { thinking, effort } = model.capabilities;
  if (thinking?.supported !== true) return { supported: false };
  const levels = effort?.supported ? EFFORTS.filter((value) => effort[value]?.supported === true) : [];
  return {
    supported: true,
    effort: levels.length > 0 ? reasoningControls({ effort: levels }).effort! : null,
    budget: thinking.types?.enabled?.supported === true ? {} : null,
  };
}

function markdownText(value: string) {
  return value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replaceAll("**", "").replaceAll("`", "").trim();
}

function effectiveOn(label: string, now: Date) {
  const through = label.match(/\bthrough ([A-Z][a-z]+ \d{1,2}, \d{4})/i)?.[1];
  if (through !== undefined && now.getTime() > Date.parse(`${through} 23:59:59 UTC`)) return false;
  const starting = label.match(/\bstarting ([A-Z][a-z]+ \d{1,2}, \d{4})/i)?.[1];
  if (starting !== undefined && now.getTime() < Date.parse(`${starting} 00:00:00 UTC`)) return false;
  return true;
}

export function normalizeModelName(value: string) {
  return markdownText(value)
    .replace(/\s*\([^)]*(?:deprecated|retired|limited availability)[^)]*\)/gi, "")
    .replace(/\s+(?:through|starting) [A-Z][a-z]+ \d{1,2}, \d{4}.*$/i, "")
    .trim()
    .toLowerCase();
}

function price(value: string) {
  const match = markdownText(value).match(/\$([\d.]+)\s*\/\s*MTok/i);
  return match === null ? undefined : Number(match[1]);
}

/** The "Model pricing" table, by normalized model name. Rows not in effect today are skipped. */
export function parseAnthropicPricing(markdown: string, now = new Date()) {
  const section = markdown.split(/^## Model pricing\s*$/m)[1]?.split(/^## /m)[0];
  if (section === undefined) throw new Error("Anthropic pricing page is missing the Model pricing section");

  const rows = section.split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = rows[0]?.map((cell) => markdownText(cell).toLowerCase().replaceAll("&", "and"));
  if (header === undefined) throw new Error("Anthropic pricing page is missing the model pricing table");
  const indexes = {
    model: header.indexOf("model"),
    input: header.indexOf("base input tokens"),
    cacheWrite5m: header.indexOf("5m cache writes"),
    cacheWrite1h: header.indexOf("1h cache writes"),
    cacheRead: header.indexOf("cache hits and refreshes"),
    output: header.indexOf("output tokens"),
  };
  if (Object.values(indexes).some((index) => index < 0)) throw new Error("Anthropic model pricing table has unexpected columns");

  const result = new Map<string, AnthropicPricing>();
  for (const row of rows.slice(2)) {
    const label = markdownText(row[indexes.model] ?? "");
    if (label === "" || !effectiveOn(label, now)) continue;
    const prices = {
      input: price(row[indexes.input] ?? ""),
      output: price(row[indexes.output] ?? ""),
      cacheRead: price(row[indexes.cacheRead] ?? ""),
      cacheWrite5m: price(row[indexes.cacheWrite5m] ?? ""),
      cacheWrite1h: price(row[indexes.cacheWrite1h] ?? ""),
    };
    if (Object.values(prices).some((value) => value === undefined)) throw new Error(`Anthropic pricing row has invalid prices: ${label}`);
    result.set(normalizeModelName(label), { ...(prices as Omit<AnthropicPricing, "deprecated">), deprecated: /\b(?:deprecated|retired)\b/i.test(label) });
  }
  if (result.size < 5) throw new Error(`Anthropic pricing table returned only ${result.size} active models`);
  return result;
}
