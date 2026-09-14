import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://zenmux.ai/api/frontend/model/listByFilter";

const PricingComponent = z.object({
  code: z.string(),
  value: z.string().optional(),
}).passthrough();

const PricingRecord = z.object({
  feeRate: z.number().finite().nonnegative(),
  components: z.array(PricingComponent).optional(),
}).passthrough();

const PricingItem = z.object({
  feeItemCode: z.string().min(1),
  feeRecords: z.array(PricingRecord),
}).passthrough();

const ZenmuxModel = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  input_modalities: z.string(),
  output_modalities: z.string(),
  context_length: z.number().nonnegative(),
  max_completion_tokens: z.number().nonnegative().nullable(),
  pricing_prompt: z.string().optional(),
  pricing_completion: z.string().optional(),
  publish_time: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  suitable_api: z.string(),
  supported_parameters: z.string(),
  supports_reasoning: z.number().int().nonnegative(),
  variable_pricings: z.string().nullish(),
}).passthrough();

const ZenmuxResponse = z.object({
  success: z.literal(true),
  data: z.array(ZenmuxModel),
}).passthrough();

type ZenmuxModel = z.infer<typeof ZenmuxModel>;

type TierMap = Map<number, number>;

const OWNER_METADATA_ALIASES: Record<string, string[]> = {
  qwen: ["alibaba"],
  bytedance: ["bytedance-seed"],
  "x-ai": ["xai"],
  "z-ai": ["zhipuai"],
};

const OWNER_PROVIDER_OVERRIDES: Record<string, { npm: string; api: string }> = {
  anthropic: {
    npm: "@ai-sdk/anthropic",
    api: "https://zenmux.ai/api/anthropic/v1",
  },
  minimax: {
    npm: "@ai-sdk/anthropic",
    api: "https://zenmux.ai/api/anthropic/v1",
  },
};

const metadataDirCache = new Map<string, string[] | undefined>();
const SUPPORTED_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);

function normalizeModalities(value: string) {
  const normalized = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .map((item) => item === "file" ? "pdf" : item)
    .filter((value) => SUPPORTED_MODALITIES.has(value));
  return Array.from(new Set(normalized));
}

function normalizeToken(value: number, unit?: string) {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (unit === "tokens") return Math.trunc(value);
  if (unit === "kTokens" || unit === "k_tokens") return Math.trunc(value * 1000);
  return Math.trunc(value);
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function listMetadataFiles(owner: string): string[] {
  const cached = metadataDirCache.get(owner);
  if (cached !== undefined) return cached;

  const dir = path.join("models", owner);
  if (!existsSync(dir)) {
    metadataDirCache.set(owner, []);
    return [];
  }

  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => entry.name.slice(0, -5));
  metadataDirCache.set(owner, files);
  return files;
}

function hasMetadata(id: string) {
  const file = path.join("models", `${id}.toml`);
  return existsSync(file);
}

function resolveMetadataId(model: ZenmuxModel) {
  const [owner, rawId] = model.slug.split("/");

  const suffixes = new Set<string>([rawId, rawId.replaceAll(".", "-")]);
  if (owner === "bytedance" && rawId.startsWith("doubao-")) {
    const stripped = rawId.replace(/^doubao-/, "");
    suffixes.add(stripped);
    suffixes.add(stripped.replace(/(\d+)\.(\d+)/, "$1-$2"));
  }

  const owners = [owner, ...(OWNER_METADATA_ALIASES[owner] ?? [])];

  for (const candidateOwner of owners) {
    for (const suffix of suffixes) {
      const candidate = `${candidateOwner}/${suffix}`;
      if (hasMetadata(candidate)) return candidate;
    }
  }

  for (const candidateOwner of owners) {
    const normalizedCandidates = Array.from(suffixes).map(normalizeName);
    const known = listMetadataFiles(candidateOwner);
    const direct = new Map(known.map((name) => [normalizeName(name), name]));
    for (const normalized of normalizedCandidates) {
      const match = direct.get(normalized);
      if (match !== undefined) return `${candidateOwner}/${match}`;
    }
  }

  return undefined;
}

function parseVariablePricings(model: ZenmuxModel) {
  if (model.variable_pricings == null || model.variable_pricings.trim() === "") return [];

  let raw: unknown;
  try {
    raw = JSON.parse(model.variable_pricings);
  } catch (error) {
    throw new Error(`ZenMux variable pricing is not valid JSON for ${model.slug}`, { cause: error });
  }
  return z.array(PricingItem).parse(raw);
}

function extractPromptThreshold(components: z.infer<typeof PricingComponent>[] | undefined) {
  const raw = components?.find((component) => component.code === "promptKToken")?.value;
  if (raw === undefined) return undefined;

  let range: unknown;
  try {
    range = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof range !== "object" || range === null) return undefined;
  const lowerLimit = (range as Record<string, unknown>).lowerLimit;
  if (typeof lowerLimit !== "number" || !Number.isFinite(lowerLimit)) return undefined;
  return normalizeToken(lowerLimit, "kTokens");
}

type RateRow = { value: number; threshold: number | undefined };

function parseRateRows(model: ZenmuxModel, keys: string[]): RateRow[] {
  const items = parseVariablePricings(model);
  for (const key of keys) {
    const item = items.find((candidate) => candidate.feeItemCode === key);
    if (item === undefined) continue;

    const rows = item.feeRecords
      .map((record) => ({
        value: record.feeRate,
        unit: record.components?.find((component) => component.code === "chargeUnit")?.value,
        threshold: extractPromptThreshold(record.components),
      }))
      .filter((row): row is RateRow & { unit: string } =>
        (row.unit === "millionTokens" || row.unit === "perMTokens")
        && Number.isFinite(row.value)
        && row.value >= 0,
      );
    if (rows.length > 0) return rows;
  }
  return [];
}

function buildRateMap(model: ZenmuxModel, keys: string[]):
  { base: number | undefined; tiers: TierMap } {
  const rows = parseRateRows(model, keys);
  if (rows.length === 0) return { base: undefined, tiers: new Map() };

  const base = rows.find((row) => row.threshold === undefined || row.threshold === 0)?.value;
  const tiers = new Map<number, number>();

  for (const row of rows) {
    if (row.threshold !== undefined && row.threshold > 0) {
      tiers.set(row.threshold, row.value);
    }
  }

  return { base, tiers };
}

function buildCost(model: ZenmuxModel): SyncedModel["cost"] | undefined {
  const outputModalities = model.output_modalities.toLowerCase();
  const input = buildRateMap(model, ["prompt", "image_input"]);
  const output = outputModalities.includes("image")
    ? buildRateMap(model, ["image_output", "completion"])
    : outputModalities.includes("speech")
      ? buildRateMap(model, ["audio", "completion"])
      : buildRateMap(model, ["completion"]);
  const cacheRead = buildRateMap(model, ["input_cache_read"]);
  const cacheWrite = buildRateMap(model, ["input_cache_write"]);

  if (input.base === undefined || output.base === undefined) return undefined;

  const base = {
    input: input.base,
    output: output.base,
    cache_read: cacheRead.base,
    cache_write: cacheWrite.base,
  } as Record<string, number | undefined>;

  const allTierSizes = new Set<number>();
  for (const m of [input.tiers, output.tiers, cacheRead.tiers, cacheWrite.tiers]) {
    for (const key of m.keys()) allTierSizes.add(key);
  }

  if (allTierSizes.size === 0) {
    if (Object.values(base).every((value) => value === undefined)) return undefined;
    return {
      input: base.input,
      output: base.output,
      cache_read: base.cache_read,
      cache_write: base.cache_write,
    };
  }

  const tiers = Array.from(allTierSizes).sort((a, b) => a - b).map((size) => {
    const entry: { tier: { size: number }; input?: number; output?: number; cache_read?: number; cache_write?: number } = {
      tier: { size },
    };
    const inputValue = input.tiers.get(size);
    const outputValue = output.tiers.get(size);
    const cacheReadValue = cacheRead.tiers.get(size);
    const cacheWriteValue = cacheWrite.tiers.get(size);

    const resolvedInput = inputValue ?? base.input;
    const resolvedOutput = outputValue ?? base.output;
    if (resolvedInput === undefined || resolvedOutput === undefined) return undefined;

    entry.input = resolvedInput;
    entry.output = resolvedOutput;

    if (cacheReadValue !== undefined) entry.cache_read = cacheReadValue;
    if (cacheWriteValue !== undefined) entry.cache_write = cacheWriteValue;
    return entry;
  }).filter((tier): tier is NonNullable<typeof tier> => tier !== undefined);

  return {
    input: base.input,
    output: base.output,
    cache_read: base.cache_read,
    cache_write: base.cache_write,
    tiers: tiers.length > 0 ? tiers : undefined,
  };
}

function stripDisplayOwner(displayName: string) {
  return displayName.includes(":") ? displayName.split(":").slice(1).join(":").trim() : displayName.trim();
}

function inferOutputLimit(model: ZenmuxModel) {
  return model.max_completion_tokens ?? 0;
}

function inferToolCall(model: ZenmuxModel) {
  const supported = model.supported_parameters.split(",").map((value) => value.trim());
  return supported.includes("tools") || supported.includes("tool_choice");
}

function inferTemperature(model: ZenmuxModel) {
  return model.supported_parameters.split(",").map((value) => value.trim()).includes("temperature");
}

function buildMetadata(model: ZenmuxModel): {
  name: string;
  description: string;
  release_date: string;
  last_updated: string;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  open_weights: false;
  modalities: { input: string[]; output: string[] };
  limit: { context: number; output: number };
} {
  const display = model.name.trim();
  const inputModalities = normalizeModalities(model.input_modalities);
  const outputModalities = normalizeModalities(model.output_modalities);

  return {
    name: stripDisplayOwner(display) || display,
    description: model.description.trim() || display,
    release_date: model.publish_time,
    last_updated: model.publish_time,
    attachment: inputModalities.some((value) => value !== "text"),
    reasoning: model.supports_reasoning > 0,
    temperature: inferTemperature(model),
    tool_call: inferToolCall(model),
    open_weights: false,
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
    limit: {
      context: model.context_length,
      output: inferOutputLimit(model),
    },
  };
}

function providerOverride(owner: string) {
  return OWNER_PROVIDER_OVERRIDES[owner];
}

export const zenzmux = {
  id: "zenmux",
  name: "ZenMux",
  modelsDir: "providers/zenmux/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`ZenMux models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw: unknown) {
    return ZenmuxResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.slug);
    const cost = buildCost(model);
    const [owner] = model.slug.split("/");

    if (existing !== undefined) {
      if (cost !== undefined && typeof existing.cost === "object" && existing.cost !== null) {
        return {
          id: model.slug,
          model: {
            ...existing,
            cost: {
              ...existing.cost,
              ...cost,
              tiers: cost.tiers ?? existing.cost.tiers,
            } as ExistingModel["cost"],
          } as SyncedModel,
        };
      }

      if (cost !== undefined) {
        return {
          id: model.slug,
          model: {
            ...existing,
            cost,
          } as SyncedModel,
        };
      }

      return { id: model.slug, model: existing as SyncedModel };
    }

    const baseModel = resolveMetadataId(model);

    if (baseModel !== undefined) {
      const nextModel: SyncedModel = {
        base_model: baseModel,
      };
      if (cost !== undefined) nextModel.cost = cost;
      const provider = providerOverride(owner);
      if (provider !== undefined) {
        nextModel.provider = provider;
      }
      return { id: model.slug, model: nextModel };
    }

    const nextModel: SyncedModel = {
      base_model: model.slug,
    };
    if (cost !== undefined) nextModel.cost = cost;
    const provider = providerOverride(owner);
    if (provider !== undefined) {
      nextModel.provider = provider;
    }

    return {
      id: model.slug,
      model: nextModel,
      metadata: {
        id: model.slug,
        model: buildMetadata(model),
      },
    };
  },
} satisfies SyncProvider<ZenmuxModel>;
