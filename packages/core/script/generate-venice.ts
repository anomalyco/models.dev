#!/usr/bin/env bun

import { z } from "zod";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { ModelFamilyValues } from "../src/family.js";

// Venice API endpoint
const API_ENDPOINT = "https://api.venice.ai/api/v1/models?type=text";

// Model metadata directory (shared with other generators)
const MODELS_METADATA_DIR = path.join(import.meta.dirname, "..", "..", "..", "models");

interface ModelMetadataEntry {
  lab: string;
  filename: string;
  normalizedFilename: string;
  normalizedFull: string;
}

const metadataIndex: ModelMetadataEntry[] = [];
const metadataByKey = new Map<string, Record<string, unknown>>();

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildMetadataIndex() {
  if (metadataIndex.length > 0) return;
  try {
    const labs = readdirSync(MODELS_METADATA_DIR, { withFileTypes: true });
    for (const lab of labs) {
      if (!lab.isDirectory()) continue;
      const labName = lab.name;
      const labPath = path.join(MODELS_METADATA_DIR, labName);
      const files = readdirSync(labPath, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".toml")) continue;
        const filename = file.name.slice(0, -".toml".length);
        metadataIndex.push({
          lab: labName,
          filename,
          normalizedFilename: normalize(filename),
          normalizedFull: normalize(labName + filename),
        });
      }
    }
  } catch {}
}

function loadMetadata(lab: string, filename: string): Record<string, unknown> {
  const key = `${lab}/${filename}`;
  let metadata = metadataByKey.get(key);
  if (metadata === undefined) {
    const filePath = path.join(MODELS_METADATA_DIR, lab, `${filename}.toml`);
    if (!existsSync(filePath)) return {};
    metadata = Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    metadataByKey.set(key, metadata);
  }
  return metadata;
}

function resolveBaseModel(veniceId: string, veniceName: string): string | undefined {
  const idKey = normalize(veniceId);
  const nameKey = normalize(veniceName);

  for (const entry of metadataIndex) {
    if (
      entry.normalizedFilename === idKey ||
      entry.normalizedFilename === nameKey ||
      entry.normalizedFull === idKey
    ) {
      return `${entry.lab}/${entry.filename}`;
    }
  }

  return undefined;
}

// Zod schemas for API response validation
const Capabilities = z
  .object({
    optimizedForCode: z.boolean().optional(),
    quantization: z.string().optional(),
    supportsAudioInput: z.boolean().optional(),
    supportsFunctionCalling: z.boolean().optional(),
    supportsLogProbs: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    reasoningEffortOptions: z.array(z.string()).optional(),
    supportsResponseSchema: z.boolean().optional(),
    supportsVideoInput: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    supportsWebSearch: z.boolean().optional(),
  })
  .passthrough();

const PricingTier = z.object({ usd: z.number(), diem: z.number().optional() }).passthrough();

const ExtendedPricing = z
  .object({
    context_token_threshold: z.number(),
    input: PricingTier,
    output: PricingTier,
    cache_input: PricingTier.optional(),
    cache_write: PricingTier.optional(),
  })
  .passthrough();

const Pricing = z
  .object({
    input: PricingTier,
    output: PricingTier,
    cache_input: PricingTier.optional(),
    cache_write: PricingTier.optional(),
    extended: ExtendedPricing.optional(),
  })
  .passthrough();

const ModelSpec = z
  .object({
    pricing: Pricing.optional(),
    availableContextTokens: z.number(),
    maxCompletionTokens: z.number().optional(),
    capabilities: Capabilities,
    constraints: z.any().optional(),
    name: z.string(),
    modelSource: z.string().optional(),
    offline: z.boolean().optional(),
    privacy: z.string().optional(),
    traits: z.array(z.string()).optional(),
  })
  .passthrough();

const VeniceModel = z
  .object({
    created: z.number(),
    id: z.string(),
    model_spec: ModelSpec,
    object: z.string(),
    owned_by: z.string(),
    type: z.string(),
  })
  .passthrough();

const VeniceResponse = z
  .object({
    data: z.array(VeniceModel),
    object: z.string(),
    type: z.string(),
  })
  .passthrough();

function matchesFamily(target: string, family: string): boolean {
  const targetLower = target.toLowerCase();
  const familyLower = family.toLowerCase();
  let familyIdx = 0;

  for (let i = 0; i < targetLower.length && familyIdx < familyLower.length; i++) {
    if (targetLower[i] === familyLower[familyIdx]) {
      familyIdx++;
    }
  }

  return familyIdx === familyLower.length;
}

function inferFamily(modelId: string, modelName: string): string | undefined {
  const sortedFamilies = [...ModelFamilyValues].sort((a, b) => b.length - a.length);

  for (const family of sortedFamilies) {
    if (matchesFamily(modelId, family)) {
      return family;
    }
  }

  for (const family of sortedFamilies) {
    if (matchesFamily(modelName, family)) {
      return family;
    }
  }

  return undefined;
}

function buildInputModalities(capabilities: z.infer<typeof Capabilities>): string[] {
  const mods: string[] = ["text"];
  if (capabilities.supportsVision) mods.push("image");
  if (capabilities.supportsAudioInput) mods.push("audio");
  if (capabilities.supportsVideoInput) mods.push("video");
  return mods;
}

function formatNumber(n: number): string {
  if (n >= 1000) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return n.toString();
}

function timestampToDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toISOString().slice(0, 10);
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ExistingModel {
  base_model?: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: Array<{
    type: "toggle" | "effort" | "budget_tokens";
    values?: Array<string | null>;
    min?: number;
    max?: number;
  }>;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  interleaved?: boolean | { field: string };
  status?: string;
  cost?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
    input_audio?: number;
    output_audio?: number;
    context_over_200k?: {
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
      context_min?: number;
    };
    tiers?: Array<{
      tier: {
        type?: "context";
        size: number;
      };
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
    }>;
  };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  provider?: {
    npm?: string;
    api?: string;
  };
}

async function loadExistingModel(filePath: string): Promise<ExistingModel | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return null;
    }
    const toml = await import(filePath, { with: { type: "toml" } }).then(
      (mod) => mod.default,
    );
    return toml as ExistingModel;
  } catch (e) {
    console.warn(`Warning: Failed to parse existing file ${filePath}:`, e);
    return null;
  }
}

function getExistingLongContextMin(existing: ExistingModel | null) {
  return (
    existing?.cost?.tiers?.find(
      (tier) =>
        (tier.tier.type === undefined || tier.tier.type === "context") &&
        tier.tier.size >= 200_000,
    )?.tier.size ?? 200_000
  );
}

function getExistingLongContextCost(existing: ExistingModel | null) {
  return (
    existing?.cost?.tiers?.find(
      (tier) =>
        (tier.tier.type === undefined || tier.tier.type === "context") &&
        tier.tier.size >= 200_000,
    ) ?? existing?.cost?.context_over_200k
  );
}

function getLongContextMin(cost: { context_min?: number }) {
  return cost.context_min ?? 200_000;
}

interface MergedModel {
  base_model?: string;
  name: string;
  family?: string;
  attachment: boolean;
  reasoning: boolean;
  reasoning_options?: Array<{
    type: "toggle" | "effort" | "budget_tokens";
    values?: Array<string | null>;
    min?: number;
    max?: number;
  }>;
  tool_call: boolean;
  structured_output?: boolean;
  temperature: boolean;
  knowledge?: string;
  release_date: string;
  last_updated: string;
  open_weights: boolean;
  interleaved?: boolean | { field: string };
  status?: string;
  cost?: {
    input: number;
    output: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
    input_audio?: number;
    output_audio?: number;
    context_over_200k?: {
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
      context_min?: number;
    };
  };
  limit: {
    context: number;
    output: number;
  };
  modalities: {
    input: string[];
    output: string[];
  };
}

function mergeModel(
  apiModel: z.infer<typeof VeniceModel>,
  existing: ExistingModel | null,
): MergedModel {
  const spec = apiModel.model_spec;
  const caps = spec.capabilities;

  const contextTokens = spec.availableContextTokens;
  const outputTokens = spec.maxCompletionTokens ?? Math.floor(contextTokens / 4);

  const openWeights = spec.modelSource?.toLowerCase().includes("huggingface") ?? false;

  const inputModalities = buildInputModalities(caps);

  if (existing?.modalities?.input?.includes("pdf") && !inputModalities.includes("pdf")) {
    inputModalities.push("pdf");
  }

  const attachment =
    caps.supportsVision === true ||
    caps.supportsAudioInput === true ||
    caps.supportsVideoInput === true;

  const baseModel = resolveBaseModel(apiModel.id, spec.name) ?? existing?.base_model;

  const merged: MergedModel = {
    ...(baseModel && { base_model: baseModel }),
    name: spec.name,
    attachment,
    reasoning: caps.supportsReasoning === true,
    tool_call: caps.supportsFunctionCalling === true,
    temperature: true,
    release_date: timestampToDate(apiModel.created),
    last_updated: getTodayDate(),
    open_weights: openWeights,
    limit: {
      context: contextTokens,
      output: outputTokens,
    },
    modalities: {
      input: inputModalities,
      output: ["text"],
    },
  };

  if (caps.supportsResponseSchema === true) {
    merged.structured_output = true;
  }

  if (caps.reasoningEffortOptions && caps.reasoningEffortOptions.length > 0) {
    merged.reasoning_options = [
      { type: "effort", values: caps.reasoningEffortOptions },
    ];
  }

  if (spec.pricing) {
    merged.cost = {
      input: spec.pricing.input.usd,
      output: spec.pricing.output.usd,
      ...(spec.pricing.cache_input && { cache_read: spec.pricing.cache_input.usd }),
      ...(spec.pricing.cache_write && { cache_write: spec.pricing.cache_write.usd }),
    };

    if (spec.pricing.extended) {
      merged.cost.context_over_200k = {
        input: spec.pricing.extended.input.usd,
        output: spec.pricing.extended.output.usd,
        context_min: spec.pricing.extended.context_token_threshold,
        ...(spec.pricing.extended.cache_input && { cache_read: spec.pricing.extended.cache_input.usd }),
        ...(spec.pricing.extended.cache_write && { cache_write: spec.pricing.extended.cache_write.usd }),
      };
    }
  }

  const inferred = inferFamily(apiModel.id, spec.name);
  merged.family = inferred ?? existing?.family;

  if (existing?.knowledge) {
    merged.knowledge = existing.knowledge;
  }
  if (existing?.interleaved !== undefined) {
    merged.interleaved = existing.interleaved;
  }
  if (existing?.status !== undefined) {
    merged.status = existing.status;
  }
  if (existing?.reasoning_options && !merged.reasoning_options) {
    merged.reasoning_options = existing.reasoning_options;
  }

  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableValue(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableValue(a) === stableValue(b);
}

function inheritedOverride(value: unknown, inherited: unknown): unknown {
  if (value === undefined) return undefined;
  if (sameValue(value, inherited)) return undefined;
  return value;
}

function baseModelOverrides(model: MergedModel): Record<string, unknown> {
  if (model.base_model === undefined) return {};
  const [lab, ...rest] = model.base_model.split("/");
  const filename = rest.join("/");
  const metadata = loadMetadata(lab, filename);

  const values: Record<string, unknown> = {
    name: model.name,
    attachment: model.attachment,
    reasoning: model.reasoning,
    reasoning_options: model.reasoning_options,
    tool_call: model.tool_call,
    structured_output: model.structured_output,
    knowledge: model.knowledge,
    open_weights: model.open_weights,
    status: model.status,
    interleaved: model.interleaved,
    modalities: model.modalities,
  };

  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, inheritedOverride(value, metadata[key])])
      .filter(([, value]) => value !== undefined),
  );
}

function formatReasoningOptionsToml(options: NonNullable<MergedModel["reasoning_options"]>): string[] {
  const lines: string[] = [];
  for (const opt of options) {
    lines.push("");
    lines.push(`[[reasoning_options]]`);
    lines.push(`type = "${opt.type}"`);
    if (opt.values) {
      lines.push(`values = [${opt.values.map((v) => (v === null ? "null" : `"${v}"`)).join(", ")}]`);
    }
    if (opt.min !== undefined) {
      lines.push(`min = ${opt.min}`);
    }
    if (opt.max !== undefined) {
      lines.push(`max = ${opt.max}`);
    }
  }
  return lines;
}

function formatCostToml(model: MergedModel, lines: string[]) {
  if (!model.cost) return;
  lines.push("");
  lines.push(`[cost]`);
  lines.push(`input = ${model.cost.input}`);
  lines.push(`output = ${model.cost.output}`);
  if (model.cost.reasoning !== undefined) {
    lines.push(`reasoning = ${model.cost.reasoning}`);
  }
  if (model.cost.cache_read !== undefined) {
    lines.push(`cache_read = ${model.cost.cache_read}`);
  }
  if (model.cost.cache_write !== undefined) {
    lines.push(`cache_write = ${model.cost.cache_write}`);
  }
  if (model.cost.input_audio !== undefined) {
    lines.push(`input_audio = ${model.cost.input_audio}`);
  }
  if (model.cost.output_audio !== undefined) {
    lines.push(`output_audio = ${model.cost.output_audio}`);
  }

  if (model.cost.context_over_200k) {
    lines.push("");
    lines.push(`[[cost.tiers]]`);
    lines.push(`tier = { size = ${formatNumber(getLongContextMin(model.cost.context_over_200k))} }`);
    lines.push(`input = ${model.cost.context_over_200k.input}`);
    lines.push(`output = ${model.cost.context_over_200k.output}`);
    if (model.cost.context_over_200k.cache_read !== undefined) {
      lines.push(`cache_read = ${model.cost.context_over_200k.cache_read}`);
    }
    if (model.cost.context_over_200k.cache_write !== undefined) {
      lines.push(`cache_write = ${model.cost.context_over_200k.cache_write}`);
    }
  }
}

function formatToml(model: MergedModel): string {
  if (model.base_model !== undefined) {
    return formatBaseModelToml(model);
  }
  return formatFullToml(model);
}

function formatFullToml(model: MergedModel): string {
  const lines: string[] = [];

  lines.push(`name = "${model.name.replace(/"/g, '\\"')}"`);
  if (model.family) {
    lines.push(`family = "${model.family}"`);
  }
  lines.push(`attachment = ${model.attachment}`);
  lines.push(`reasoning = ${model.reasoning}`);
  lines.push(`tool_call = ${model.tool_call}`);
  if (model.structured_output !== undefined) {
    lines.push(`structured_output = ${model.structured_output}`);
  }
  lines.push(`temperature = ${model.temperature}`);
  if (model.knowledge) {
    lines.push(`knowledge = "${model.knowledge}"`);
  }
  lines.push(`release_date = "${model.release_date}"`);
  lines.push(`last_updated = "${model.last_updated}"`);
  lines.push(`open_weights = ${model.open_weights}`);
  if (model.status) {
    lines.push(`status = "${model.status}"`);
  }

  if (model.reasoning_options && model.reasoning_options.length > 0) {
    lines.push(...formatReasoningOptionsToml(model.reasoning_options));
  }

  if (model.interleaved !== undefined) {
    lines.push("");
    if (model.interleaved === true) {
      lines.push(`interleaved = true`);
    } else if (typeof model.interleaved === "object") {
      lines.push(`[interleaved]`);
      lines.push(`field = "${model.interleaved.field}"`);
    }
  }

  formatCostToml(model, lines);

  lines.push("");
  lines.push(`[limit]`);
  lines.push(`context = ${formatNumber(model.limit.context)}`);
  lines.push(`output = ${formatNumber(model.limit.output)}`);

  lines.push("");
  lines.push(`[modalities]`);
  lines.push(`input = [${model.modalities.input.map((m) => `"${m}"`).join(", ")}]`);
  lines.push(`output = [${model.modalities.output.map((m) => `"${m}"`).join(", ")}]`);

  return lines.join("\n") + "\n";
}

function formatBaseModelToml(model: MergedModel): string {
  const overrides = baseModelOverrides(model);
  const lines: string[] = [];

  lines.push(`base_model = "${model.base_model}"`);

  if (typeof overrides.name === "string") {
    lines.push(`name = "${String(overrides.name).replace(/"/g, '\\"')}"`);
  }
  for (const field of [
    "attachment",
    "reasoning",
    "tool_call",
    "structured_output",
    "open_weights",
  ] as const) {
    if (overrides[field] !== undefined) {
      lines.push(`${field} = ${overrides[field]}`);
    }
  }
  if (overrides.knowledge !== undefined) {
    lines.push(`knowledge = "${overrides.knowledge}"`);
  }
  lines.push(`last_updated = "${model.last_updated}"`);
  if (overrides.status !== undefined) {
    lines.push(`status = "${overrides.status}"`);
  }

  if (Array.isArray(overrides.reasoning_options)) {
    lines.push(...formatReasoningOptionsToml(overrides.reasoning_options as NonNullable<MergedModel["reasoning_options"]>));
  }

  if (overrides.interleaved !== undefined) {
    lines.push("");
    if (overrides.interleaved === true) {
      lines.push(`interleaved = true`);
    } else if (isPlainObject(overrides.interleaved)) {
      lines.push(`[interleaved]`);
      lines.push(`field = "${overrides.interleaved.field}"`);
    }
  }

  formatCostToml(model, lines);

  const [lab, ...rest] = model.base_model.split("/");
  const metadata = loadMetadata(lab, rest.join("/"));
  const limitOverride = inheritedOverride(model.limit, metadata.limit);
  if (limitOverride !== undefined) {
    lines.push("");
    lines.push(`[limit]`);
    lines.push(`context = ${formatNumber(model.limit.context)}`);
    lines.push(`output = ${formatNumber(model.limit.output)}`);
  }

  if (isPlainObject(overrides.modalities)) {
    const input = overrides.modalities.input;
    const output = overrides.modalities.output;
    if (Array.isArray(input) && Array.isArray(output)) {
      lines.push("");
      lines.push(`[modalities]`);
      lines.push(`input = [${input.map((m) => `"${m}"`).join(", ")}]`);
      lines.push(`output = [${output.map((m) => `"${m}"`).join(", ")}]`);
    }
  }

  return lines.join("\n") + "\n";
}

interface Changes {
  field: string;
  oldValue: string;
  newValue: string;
}

function detectChanges(
  existing: ExistingModel | null,
  merged: MergedModel,
): Changes[] {
  if (!existing) return [];

  const changes: Changes[] = [];

  const compare = (field: string, oldVal: unknown, newVal: unknown) => {
    const oldStr = JSON.stringify(oldVal);
    const newStr = JSON.stringify(newVal);
    if (oldStr !== newStr) {
      changes.push({
        field,
        oldValue: formatValue(oldVal),
        newValue: formatValue(newVal),
      });
    }
  };

  const formatValue = (val: unknown): string => {
    if (typeof val === "number") return formatNumber(val);
    if (Array.isArray(val)) return `[${val.map(formatValue).join(", ")}]`;
    if (isPlainObject(val)) return JSON.stringify(val);
    if (val === undefined) return "(none)";
    return String(val);
  };

  if (merged.base_model !== undefined) {
    const overrides = baseModelOverrides(merged);

    compare("base_model", existing.base_model, merged.base_model);
    compare("name", existing.name, overrides.name);
    compare("attachment", existing.attachment, overrides.attachment);
    compare("reasoning", existing.reasoning, overrides.reasoning);
    compare("tool_call", existing.tool_call, overrides.tool_call);
    compare("structured_output", existing.structured_output, overrides.structured_output);
    compare("temperature", existing.temperature, overrides.temperature);
    compare("open_weights", existing.open_weights, overrides.open_weights);
    compare("knowledge", existing.knowledge, overrides.knowledge);
    compare("last_updated", existing.last_updated, merged.last_updated);
    compare("status", existing.status, overrides.status);
    compare("interleaved", existing.interleaved, overrides.interleaved);
    compare("reasoning_options", existing.reasoning_options, overrides.reasoning_options);
    compare("cost.input", existing.cost?.input, merged.cost?.input);
    compare("cost.output", existing.cost?.output, merged.cost?.output);
    compare("cost.cache_read", existing.cost?.cache_read, merged.cost?.cache_read);
    compare("cost.cache_write", existing.cost?.cache_write, merged.cost?.cache_write);
    const existingLongContextCost = getExistingLongContextCost(existing);
    compare("cost.context_over_200k.input", existingLongContextCost?.input, merged.cost?.context_over_200k?.input);
    compare("cost.context_over_200k.output", existingLongContextCost?.output, merged.cost?.context_over_200k?.output);
    compare("cost.context_over_200k.cache_read", existingLongContextCost?.cache_read, merged.cost?.context_over_200k?.cache_read);
    compare("cost.context_over_200k.cache_write", existingLongContextCost?.cache_write, merged.cost?.context_over_200k?.cache_write);
    const [baseLab, ...baseRest] = merged.base_model.split("/");
    const baseMetadata = loadMetadata(baseLab, baseRest.join("/"));
    const inheritedLimit = baseMetadata.limit as { context?: number; output?: number } | undefined;
    compare("limit.context", existing.limit?.context ?? inheritedLimit?.context, merged.limit.context);
    compare("limit.output", existing.limit?.output ?? inheritedLimit?.output, merged.limit.output);
    if (isPlainObject(overrides.modalities)) {
      compare("modalities.input", existing.modalities?.input, overrides.modalities.input);
      compare("modalities.output", existing.modalities?.output, overrides.modalities.output);
    }

    return changes;
  }

  compare("base_model", existing.base_model, merged.base_model);
  compare("name", existing.name, merged.name);
  compare("family", existing.family, merged.family);
  compare("attachment", existing.attachment, merged.attachment);
  compare("reasoning", existing.reasoning, merged.reasoning);
  compare("reasoning_options", existing.reasoning_options, merged.reasoning_options);
  compare("tool_call", existing.tool_call, merged.tool_call);
  compare("structured_output", existing.structured_output, merged.structured_output);
  compare("open_weights", existing.open_weights, merged.open_weights);
  compare("release_date", existing.release_date, merged.release_date);
  compare("cost.input", existing.cost?.input, merged.cost?.input);
  compare("cost.output", existing.cost?.output, merged.cost?.output);
  compare("cost.cache_read", existing.cost?.cache_read, merged.cost?.cache_read);
  compare("cost.cache_write", existing.cost?.cache_write, merged.cost?.cache_write);
  const existingLongContextCost = getExistingLongContextCost(existing);
  compare("cost.context_over_200k.input", existingLongContextCost?.input, merged.cost?.context_over_200k?.input);
  compare("cost.context_over_200k.output", existingLongContextCost?.output, merged.cost?.context_over_200k?.output);
  compare("cost.context_over_200k.cache_read", existingLongContextCost?.cache_read, merged.cost?.context_over_200k?.cache_read);
  compare("cost.context_over_200k.cache_write", existingLongContextCost?.cache_write, merged.cost?.context_over_200k?.cache_write);
  compare("limit.context", existing.limit?.context, merged.limit.context);
  compare("limit.output", existing.limit?.output, merged.limit.output);
  compare("modalities.input", existing.modalities?.input, merged.modalities.input);
  compare("modalities.output", existing.modalities?.output, merged.modalities.output);

  return changes;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const modelsDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
    "venice",
    "models",
  );

  let apiKey: string | null = null;

  const apiKeyArgIndex = args.findIndex((arg) => arg.startsWith("--api-key"));
  if (apiKeyArgIndex !== -1) {
    const arg = args[apiKeyArgIndex];
    if (arg?.includes("=")) {
      apiKey = arg.split("=")[1] ?? null;
    } else if (args[apiKeyArgIndex + 1]) {
      apiKey = args[apiKeyArgIndex + 1] ?? null;
    }
  }

  if (!apiKey) {
    apiKey = process.env.VENICE_API_KEY ?? null;
  }

  const includeAlpha = apiKey !== null;

  if (dryRun) {
    console.log(
      `[DRY RUN] Fetching Venice models from API${includeAlpha ? " (including alpha models)" : ""}...`,
    );
  } else {
    console.log(
      `Fetching Venice models from API${includeAlpha ? " (including alpha models)" : ""}...`,
    );
  }

  const fetchOptions: RequestInit = {};
  if (apiKey) {
    fetchOptions.headers = {
      Authorization: `Bearer ${apiKey}`,
    };
  }

  const res = await fetch(API_ENDPOINT, fetchOptions);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    if (res.status === 401) {
      console.error("Invalid API key. Please check your VENICE_API_KEY.");
    }
    process.exit(1);
  }

  const json = await res.json();
  const parsed = VeniceResponse.safeParse(json);
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  const apiModels = parsed.data.data;

  buildMetadataIndex();

  const existingFiles = new Set<string>();
  try {
    const files = await readdir(modelsDir);
    for (const file of files) {
      if (file.endsWith(".toml")) {
        existingFiles.add(file);
      }
    }
  } catch {
  }

  console.log(`Found ${apiModels.length} models in API, ${existingFiles.size} existing files\n`);

  const apiModelIds = new Set<string>();

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const apiModel of apiModels) {
    const safeId = apiModel.id.replace(/\//g, "-");
    const filename = `${safeId}.toml`;
    const filePath = path.join(modelsDir, filename);

    apiModelIds.add(filename);

    const existing = await loadExistingModel(filePath);
    const merged = mergeModel(apiModel, existing);
    const tomlContent = formatToml(merged);

    if (existing === null) {
      created++;
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${filename}`);
        console.log(`  name = "${merged.name}"`);
        if (merged.family) {
          console.log(`  family = "${merged.family}" (inferred)`);
        }
        console.log("");
      } else {
        await Bun.write(filePath, tomlContent);
        console.log(`Created: ${filename}`);
      }
    } else {
      const changes = detectChanges(existing, merged);

      if (changes.length > 0) {
        updated++;
        if (dryRun) {
          console.log(`[DRY RUN] Would update: ${filename}`);
        } else {
          await Bun.write(filePath, tomlContent);
          console.log(`Updated: ${filename}`);
        }
        for (const change of changes) {
          console.log(`  ${change.field}: ${change.oldValue} → ${change.newValue}`);
        }
        console.log("");
      } else {
        unchanged++;
      }
    }
  }

  const orphaned: string[] = [];
  for (const file of existingFiles) {
    if (!apiModelIds.has(file)) {
      orphaned.push(file);
      console.log(`Warning: Orphaned file (not in API): ${file}`);
    }
  }

  console.log("");
  if (dryRun) {
    console.log(
      `Summary: ${created} would be created, ${updated} would be updated, ${unchanged} unchanged, ${orphaned.length} orphaned`,
    );
  } else {
    console.log(
      `Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphaned.length} orphaned`,
    );
  }
}

await main();
