import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://zenmux.ai/api/frontend/model/listByFilter";
const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "..");

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
  const cacheWrite = buildRateMap(model, ["input_cache_write", "input_cache_write_5_min", "input_cache_write_1_h"]);

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

type ReasoningOptions = NonNullable<SyncedFullModel["reasoning_options"]>;
type ModelCost = NonNullable<SyncedFullModel["cost"]>;

const PEER_OWNER_ALIASES: Record<string, string[]> = {
  alibaba: ["qwen", "alibaba"],
  qwen: ["qwen", "alibaba"],
  "z-ai": ["z-ai", "zhipuai"],
  zhipuai: ["z-ai", "zhipuai"],
};

function readReasoningOptions(filePath: string): ReasoningOptions | undefined {
  if (!existsSync(filePath)) return undefined;

  try {
    const parsed = Bun.TOML.parse(readFileSync(filePath, "utf8")) as { reasoning_options?: unknown };
    return Array.isArray(parsed.reasoning_options)
      ? parsed.reasoning_options as ReasoningOptions
      : undefined;
  } catch {
    return undefined;
  }
}

function peerReasoningOptions(modelID: string): ReasoningOptions | undefined {
  const [owner, ...idParts] = modelID.split("/");
  if (owner === undefined || idParts.length === 0) return undefined;

  const rawID = idParts.join("/");
  const ids = [...new Set([
    rawID,
    rawID.toLowerCase(),
    rawID.replaceAll(".", "-"),
    rawID.replace(/^MiniMax-/i, "minimax-"),
    rawID.replace(/-flashx$/i, "-flash"),
    rawID.replace(/-free$/i, ""),
    rawID.replace(/-flash(?:-free)?$/i, ""),
    rawID.replace(/-flash$/i, "-flash-02-23"),
    ...(rawID.endsWith("-max") ? [`${rawID}-thinking`] : []),
  ])];
  const owners = PEER_OWNER_ALIASES[owner] ?? [owner];
  const roots = owners.flatMap((peerOwner) => [
    path.join(REPO_ROOT, "providers", "openrouter", "models", peerOwner),
    path.join(REPO_ROOT, "providers", peerOwner, "models"),
  ]);

  for (const root of roots) {
    for (const id of ids) {
      const options = readReasoningOptions(path.join(root, `${id}.toml`));
      if (options !== undefined) return options;
    }
  }

  return undefined;
}

function curatedReasoningOptions(modelID: string): ReasoningOptions | undefined {
  const [owner, id = ""] = modelID.split("/");

  if (owner === "deepseek") {
    if (id.includes("v4-flash")) {
      return [
        { type: "toggle" },
        { type: "effort", values: ["low", "high", "max"] },
      ];
    }
    if (id.includes("v4-pro")) {
      return [
        { type: "toggle" },
        { type: "effort", values: ["high", "max"] },
      ];
    }
  }

  if (owner === "z-ai" && id === "glm-5.3-flashx") {
    return [{ type: "effort", values: ["low", "high", "max"] }];
  }

  if (owner === "qwen" && id === "qwen3.5-flash") {
    return [{ type: "toggle" }, { type: "budget_tokens" }];
  }

  // MiniMax M2.x exposes reasoning as always-on on its first-party API;
  // an explicit empty set is therefore a known host capability, not feed uncertainty.
  if (owner === "minimax" && /^minimax-m2(?:[.]|$)/i.test(id)) return [];

  return undefined;
}

function reasoningOptionsFor(
  model: ZenmuxModel,
  baseModel: string | undefined,
  authored: ExistingModel | undefined,
): ReasoningOptions | undefined {
  if (model.supports_reasoning === 0) return undefined;

  const curated = curatedReasoningOptions(model.slug);
  if (curated !== undefined) return curated;

  const peer = peerReasoningOptions(baseModel ?? model.slug);
  if (peer !== undefined) return peer;

  // Keep a hand-authored non-empty control set when no peer catalog exists.
  // An authored [] is deliberately not enough: [] means no caller control.
  if (authored?.reasoning_options !== undefined && authored.reasoning_options.length > 0) {
    return authored.reasoning_options as ReasoningOptions;
  }

  throw new MissingReasoningOptionsError(
    model.slug,
    "ZenMux reports reasoning = true but no lab/peer reasoning controls are known; refusing to write reasoning_options = []",
  );
}

function reasoningHeader(model: ZenmuxModel, options: ReasoningOptions | undefined) {
  const [owner, id = ""] = model.slug.split("/");
  if (options === undefined) return undefined;
  if (options.length === 0) {
    if (owner === "minimax" && /^minimax-m2(?:[.]|$)/i.test(id)) {
      return "# MiniMax M2.x reasoning is always on; ZenMux exposes no caller control.\n# https://zenmux.ai/docs/guide/advanced/reasoning.html\n";
    }
    return undefined;
  }

  const lines: string[] = [];
  const effort = options.find((option) => option.type === "effort");
  const budget = options.find((option) => option.type === "budget_tokens");

  if (options.some((option) => option.type === "toggle")) {
    const togglePath = owner === "anthropic" || owner === "deepseek" || owner === "minimax"
      ? "thinking.type = enabled|disabled"
      : owner === "google" && id.startsWith("gemini-2.5")
        ? "thinking_budget = 0|positive integer"
        : owner === "qwen"
          ? "enable_thinking = true|false"
          : "reasoning.enabled = true|false";
    lines.push(`# Toggle: ${togglePath}`);
  }
  if (effort !== undefined) {
    const pathName = owner === "google" && id.startsWith("gemini-3")
      ? "thinking_level"
      : "reasoning_effort";
    lines.push(`# Effort: ${pathName} = ${effort.values.join("|")}`);
  }
  if (budget !== undefined) {
    const pathName = owner === "anthropic"
      ? "thinking.budget_tokens"
      : owner === "google" || owner === "qwen"
        ? "thinking_budget"
        : "reasoning.max_tokens";
    lines.push(`# Budget: ${pathName} (integer)`);
  }
  lines.push("# https://zenmux.ai/docs/guide/advanced/reasoning.html");
  return `${lines.join("\n")}\n`;
}

function mergeCosts(
  current: ExistingModel["cost"],
  next: ModelCost | undefined,
): ModelCost | undefined {
  if (next === undefined) return current as ModelCost | undefined;
  if (current === undefined) return next;

  return {
    ...current,
    ...next,
    reasoning: next.reasoning ?? current.reasoning,
    cache_read: next.cache_read ?? current.cache_read,
    cache_write: next.cache_write ?? current.cache_write,
    input_audio: next.input_audio ?? current.input_audio,
    output_audio: next.output_audio ?? current.output_audio,
    tiers: next.tiers ?? current.tiers,
  };
}

export const zenzmux = {
  id: "zenmux",
  name: "ZenMux",
  modelsDir: "providers/zenmux/models",
  preserveDescriptions: false,
  authoritativeHeaders: true,
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
    const authored = context.authored(model.slug);
    const [owner] = model.slug.split("/");
    const baseModel = authored?.base_model ?? resolveMetadataId(model);
    const reasoningOptions = reasoningOptionsFor(model, baseModel, authored);
    const cost = mergeCosts(authored?.cost, buildCost(model));
    const limit = {
      context: model.context_length,
      output: inferOutputLimit(model),
    };
    const modalities = {
      input: normalizeModalities(model.input_modalities),
      output: normalizeModalities(model.output_modalities),
    };
    const hostValues = {
      name: stripDisplayOwner(model.name) || model.name,
      attachment: modalities.input.some((value) => value !== "text"),
      reasoning: model.supports_reasoning > 0,
      reasoning_options: reasoningOptions,
      temperature: inferTemperature(model),
      tool_call: inferToolCall(model),
      cost,
      limit,
      modalities,
      provider: providerOverride(owner),
    } satisfies Partial<SyncedFullModel>;
    const header = reasoningHeader(model, reasoningOptions);

    if (baseModel !== undefined) {
      return {
        id: model.slug,
        model: factorBaseModel(
          baseModel,
          hostValues,
          limit,
          authored?.base_model === baseModel ? authored.base_model_omit : undefined,
        ),
        header,
      };
    }

    if (authored !== undefined) {
      return {
        id: model.slug,
        model: { ...authored, ...hostValues } as SyncedModel,
        header,
      };
    }

    const nextModel: SyncedModel = { base_model: model.slug };
    if (cost !== undefined) nextModel.cost = cost;
    if (reasoningOptions !== undefined) nextModel.reasoning_options = reasoningOptions;
    const provider = providerOverride(owner);
    if (provider !== undefined) nextModel.provider = provider;

    return {
      id: model.slug,
      model: nextModel,
      metadata: {
        id: model.slug,
        model: buildMetadata(model),
      },
      header,
    };
  },
} satisfies SyncProvider<ZenmuxModel>;
