import path from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.anthropic.com/v1/models";
const PRICING_ENDPOINT = "https://platform.claude.com/docs/en/about-claude/pricing";
const METADATA_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models", "anthropic");

const CapabilitySupport = z.object({ supported: z.boolean() }).passthrough();

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
      low: CapabilitySupport.optional(),
      medium: CapabilitySupport.optional(),
      high: CapabilitySupport.optional(),
      xhigh: CapabilitySupport.optional(),
      max: CapabilitySupport.optional(),
    }).passthrough().optional(),
    image_input: CapabilitySupport.optional(),
    pdf_input: CapabilitySupport.optional(),
    structured_outputs: CapabilitySupport.optional(),
    thinking: z.object({
      supported: z.boolean(),
      types: z.object({
        adaptive: CapabilitySupport.optional(),
        enabled: CapabilitySupport.optional(),
      }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

const AnthropicPage = z.object({
  data: z.array(AnthropicModel),
  has_more: z.boolean(),
  last_id: z.string().nullable().optional(),
}).passthrough();

const AnthropicResponse = z.object({
  models: z.array(AnthropicModel),
  pricing: z.string(),
});

export type AnthropicModel = z.infer<typeof AnthropicModel>;

export interface AnthropicPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  deprecated: boolean;
}

interface AnthropicSourceModel extends AnthropicModel {
  pricing?: AnthropicPricing;
}

export const anthropic = {
  id: "anthropic",
  name: "Anthropic",
  modelsDir: "providers/anthropic/models",
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Anthropic models were not created because no matching canonical models/anthropic metadata entry exists.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Anthropic sync requires ANTHROPIC_API_KEY");

    const [models, pricing] = await Promise.all([
      fetchAllModels(key),
      fetchPricing(),
    ]);
    return { models: [...models, ...await fetchAliases(key, models)], pricing };
  },
  parseModels(raw) {
    const response = AnthropicResponse.parse(raw);
    const pricing = parseAnthropicPricing(response.pricing);
    return response.models.map((model) => ({
      ...model,
      pricing: pricing.get(normalizeModelName(model.display_name)),
    }));
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing !== undefined) {
      const baseModel = context.authored(model.id)?.base_model;
      return { id: model.id, model: buildAnthropicModel(model, existing, baseModel) };
    }

    const baseModel = `anthropic/${model.id}`;
    if (!existsSync(path.join(METADATA_DIR, `${model.id}.toml`))) return undefined;
    const canonical = model.canonical_id === undefined ? undefined : context.existing(model.canonical_id);
    return { id: model.id, model: buildAnthropicModel(model, canonical, baseModel) };
  },
} satisfies SyncProvider<AnthropicSourceModel>;

async function fetchAllModels(key: string) {
  const models: AnthropicModel[] = [];
  let afterID: string | undefined;

  do {
    const url = new URL(API_ENDPOINT);
    url.searchParams.set("limit", "1000");
    if (afterID !== undefined) url.searchParams.set("after_id", afterID);

    const response = await fetch(url, {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": key,
      },
    });
    if (!response.ok) {
      throw new Error(`Anthropic models request failed: ${response.status} ${response.statusText}`);
    }

    const page = AnthropicPage.parse(await response.json());
    models.push(...page.data);
    if (page.has_more && page.last_id === undefined) {
      throw new Error("Anthropic models response has_more without last_id");
    }
    afterID = page.has_more ? page.last_id ?? undefined : undefined;
  } while (afterID !== undefined);

  return models;
}

async function fetchAliases(key: string, models: AnthropicModel[]) {
  const canonicalIDs = new Set(models.map((model) => model.id));
  const candidates = [...new Set(models
    .map((model) => model.id.replace(/-\d{8}$/, ""))
    .filter((id) => !canonicalIDs.has(id)))];

  const aliases = await Promise.all(candidates.map(async (id) => {
    const response = await fetch(`${API_ENDPOINT}/${id}`, {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": key,
      },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Anthropic model alias request failed for ${id}: ${response.status} ${response.statusText}`);
    }
    const model = AnthropicModel.parse(await response.json());
    return { ...model, id, canonical_id: model.id };
  }));

  return aliases.filter((model): model is AnthropicModel => model !== undefined);
}

async function fetchPricing() {
  const response = await fetch(PRICING_ENDPOINT, {
    headers: { Accept: "text/markdown" },
  });
  if (!response.ok) {
    throw new Error(`Anthropic pricing request failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function markdownText(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replaceAll("**", "")
    .replaceAll("`", "")
    .trim();
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

export function parseAnthropicPricing(markdown: string, now = new Date()) {
  const section = markdown.split(/^## Model pricing\s*$/m)[1]?.split(/^## /m)[0];
  if (section === undefined) throw new Error("Anthropic pricing page is missing the Model pricing section");

  const table = section.split("\n").filter((line) => line.trimStart().startsWith("|"));
  const rows = table.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = rows[0]?.map(markdownText);
  if (header === undefined) throw new Error("Anthropic pricing page is missing the model pricing table");

  const indexes = {
    model: header.indexOf("Model"),
    input: header.indexOf("Base Input Tokens"),
    cacheWrite: header.indexOf("5m Cache Writes"),
    cacheRead: header.indexOf("Cache Hits & Refreshes"),
    output: header.indexOf("Output Tokens"),
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    throw new Error("Anthropic model pricing table has unexpected columns");
  }

  const result = new Map<string, AnthropicPricing>();
  for (const row of rows.slice(2)) {
    const label = markdownText(row[indexes.model] ?? "");
    if (label === "" || !effectiveOn(label, now)) continue;
    const input = price(row[indexes.input] ?? "");
    const output = price(row[indexes.output] ?? "");
    const cacheRead = price(row[indexes.cacheRead] ?? "");
    const cacheWrite = price(row[indexes.cacheWrite] ?? "");
    if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
      throw new Error(`Anthropic pricing row has invalid prices: ${label}`);
    }
    result.set(normalizeModelName(label), {
      input,
      output,
      cacheRead,
      cacheWrite,
      deprecated: /\b(?:deprecated|retired)\b/i.test(label),
    });
  }

  if (result.size < 5) throw new Error(`Anthropic pricing table returned only ${result.size} active models`);
  return result;
}

function releaseDate(value: string, fallback: string | undefined) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return fallback;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function reasoningOptions(model: AnthropicModel, existing: ExistingModel | undefined) {
  if (model.capabilities.thinking?.supported !== true) return undefined;
  const enabled = model.capabilities.thinking.types?.enabled?.supported === true;
  const options = (existing?.reasoning_options ?? []).filter((option) => {
    if (option.type === "effort") return false;
    if (option.type === "budget_tokens") return enabled;
    return true;
  });
  if (enabled && !options.some((option) => option.type === "budget_tokens")) {
    options.push({ type: "budget_tokens" });
  }
  const effort = model.capabilities.effort;
  if (effort?.supported) {
    const values = (["low", "medium", "high", "xhigh", "max"] as const)
      .filter((value) => effort[value]?.supported === true);
    if (values.length > 0) {
      const budgetIndex = options.findIndex((option) => option.type === "budget_tokens");
      options.splice(budgetIndex < 0 ? options.length : budgetIndex, 0, { type: "effort", values });
    }
  }
  return options;
}

function syncedCost(model: AnthropicSourceModel, existing: ExistingModel | undefined) {
  if (model.pricing === undefined) return existing?.cost;
  return {
    input: model.pricing.input,
    output: model.pricing.output,
    cache_read: model.pricing.cacheRead,
    cache_write: model.pricing.cacheWrite,
    reasoning: existing?.cost?.reasoning,
    input_audio: existing?.cost?.input_audio,
    output_audio: existing?.cost?.output_audio,
    tiers: existing?.cost?.tiers,
  };
}

export function buildAnthropicModel(
  model: AnthropicSourceModel,
  existing: ExistingModel | undefined,
  baseModel?: string,
): SyncedModel {
  const name = model.canonical_id !== undefined && !model.display_name.endsWith("(latest)")
    ? `${model.display_name} (latest)`
    : model.display_name;
  const reasoning = model.capabilities.thinking?.supported ?? existing?.reasoning ?? false;
  const input = [
    "text" as const,
    ...(model.capabilities.image_input?.supported ? ["image" as const] : []),
    ...(model.capabilities.pdf_input?.supported ? ["pdf" as const] : []),
  ];
  const context = model.max_input_tokens > 0
    ? model.max_input_tokens
    : existing?.limit?.context;
  const output = model.max_tokens > 0 ? model.max_tokens : existing?.limit?.output;
  const cost = syncedCost(model, existing);
  const options = reasoningOptions(model, existing);
  // Models API has no fast-mode surface; preserve authored experimental/provider config.
  const experimental = existing?.experimental;
  const provider = existing?.provider;
  const status = model.pricing?.deprecated ? "deprecated" as const : existing?.status;
  const structured_output = model.capabilities.structured_outputs?.supported
    ?? existing?.structured_output;
  const limit = context !== undefined || output !== undefined || existing?.limit !== undefined
    ? {
        context: context ?? existing?.limit?.context ?? 0,
        input: existing?.limit?.input,
        output: output ?? existing?.limit?.output ?? 0,
      }
    : undefined;
  const modalities = { input, output: ["text" as const] };

  if (baseModel !== undefined) {
    const overrides: Partial<SyncedFullModel> = {
      name: model.canonical_id === undefined ? undefined : name,
      attachment: input.length > 1,
      reasoning,
      reasoning_options: options,
      structured_output,
      status,
      interleaved: existing?.interleaved,
      experimental,
      provider,
      cost,
      limit,
      modalities,
    };
    return factorBaseModel(
      baseModel,
      overrides,
      limit ?? { context: 0, output: 0 },
      existing?.base_model_omit,
    );
  }

  if (
    existing?.description === undefined
    || existing.release_date === undefined
    || existing.last_updated === undefined
    || existing.tool_call === undefined
    || existing.open_weights === undefined
    || context === undefined
    || output === undefined
  ) {
    throw new Error(`Anthropic model ${model.id} has incomplete local TOML metadata required for sync`);
  }

  return {
    name,
    description: existing.description,
    family: existing.family,
    release_date: releaseDate(model.created_at, existing.release_date) ?? existing.release_date,
    last_updated: existing.last_updated,
    attachment: input.length > 1,
    reasoning,
    reasoning_options: options,
    temperature: existing.temperature,
    tool_call: existing.tool_call,
    structured_output,
    knowledge: existing.knowledge,
    open_weights: existing.open_weights,
    status,
    interleaved: existing.interleaved,
    experimental,
    provider,
    cost,
    limit: { context, input: existing.limit?.input, output },
    modalities,
  };
}
