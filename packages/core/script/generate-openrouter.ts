#!/usr/bin/env bun

/**
 * Generates OpenRouter model TOML files from the OpenRouter models API.
 *
 * Flags:
 * --dry-run: Preview changes without writing files
 * --new-only: Only create new models, skip updating existing ones
 * --delete-orphaned: Delete local model files not present in the API response
 */

import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { z } from "zod";
import { ModelFamilyValues } from "../src/family.js";

const API_ENDPOINT = "https://openrouter.ai/api/v1/models";

const Pricing = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  request: z.string().optional(),
  image: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
  input_audio: z.string().optional(),
  output_audio: z.string().optional(),
  reasoning: z.string().optional(),
}).passthrough();

const Architecture = z.object({
  modality: z.string().nullable().optional(),
  input_modalities: z.array(z.string()).optional().default(["text"]),
  output_modalities: z.array(z.string()).optional().default(["text"]),
  tokenizer: z.string().nullable().optional(),
  instruct_type: z.string().nullable().optional(),
}).passthrough();

const OpenRouterModel = z.object({
  id: z.string(),
  canonical_slug: z.string().optional(),
  hugging_face_id: z.string().nullable().optional(),
  name: z.string(),
  created: z.number().optional(),
  context_length: z.number().nullable().optional(),
  architecture: Architecture.optional(),
  pricing: Pricing.optional(),
  top_provider: z.object({
    context_length: z.number().nullable().optional(),
    max_completion_tokens: z.number().nullable().optional(),
    is_moderated: z.boolean().optional(),
  }).optional(),
  supported_parameters: z.array(z.string()).optional().default([]),
  knowledge_cutoff: z.string().nullable().optional(),
}).passthrough();

const OpenRouterResponse = z.object({
  data: z.array(OpenRouterModel),
}).passthrough();

interface ExistingModel {
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  status?: string;
  cost?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
    input_audio?: number;
    output_audio?: number;
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
}

interface MergedModel {
  name: string;
  family?: string;
  attachment: boolean;
  reasoning: boolean;
  tool_call: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date: string;
  last_updated: string;
  open_weights: boolean;
  status?: string;
  cost?: {
    input: number;
    output: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
    input_audio?: number;
    output_audio?: number;
  };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  modalities: {
    input: string[];
    output: string[];
  };
}

interface Changes {
  field: string;
  oldValue: string;
  newValue: string;
}

function timestampToDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatNumber(n: number): string {
  if (n >= 1000) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return n.toString();
}

function formatCostNumber(n: number): string {
  if (Number.isInteger(n)) {
    return n.toFixed(2);
  }

  const asHundredths = Number(n.toFixed(2));
  if (Math.abs(n - asHundredths) < 1e-9) {
    return n.toFixed(2);
  }

  return n.toString();
}

function containsFamilyToken(target: string, family: string): boolean {
  const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  return regex.test(target);
}

function isSubstring(target: string, family: string): boolean {
  return target.toLowerCase().includes(family.toLowerCase());
}

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
    if (
      family.length >= 3
      && (isSubstring(modelId, family) || isSubstring(modelName, family))
    ) {
      return family;
    }

    if (
      family.length < 3
      && (containsFamilyToken(modelId, family) || containsFamilyToken(modelName, family))
    ) {
      return family;
    }
  }

  for (const family of sortedFamilies) {
    if (family.length < 3) {
      continue;
    }
    if (matchesFamily(modelId, family) || matchesFamily(modelName, family)) {
      return family;
    }
  }

  return undefined;
}

function sanitizeModalities(values: string[] | undefined, fallback: string[]): string[] {
  const allowed = new Map<string, string>([
    ["text", "text"],
    ["image", "image"],
    ["video", "video"],
    ["audio", "audio"],
    ["file", "pdf"],
    ["pdf", "pdf"],
  ]);

  const source = values && values.length > 0 ? values : fallback;
  const normalized = source
    .map((value) => allowed.get(value.toLowerCase()))
    .filter((value): value is string => value !== undefined);

  return normalized.length > 0 ? [...new Set(normalized)] : ["text"];
}

function boolFromParams(params: string[], keys: string[]): boolean {
  const set = new Set(params.map((param) => param.toLowerCase()));
  return keys.some((key) => set.has(key.toLowerCase()));
}

function pricingToPerMillion(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value) * 1_000_000;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function hasOpenWeights(huggingFaceId: string | null | undefined): boolean {
  return huggingFaceId !== null && huggingFaceId !== undefined && huggingFaceId.trim() !== "";
}

async function loadExistingModel(filePath: string): Promise<ExistingModel | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return null;
    }
    const toml = await import(filePath, { with: { type: "toml" } }).then((mod) => mod.default);
    return toml as ExistingModel;
  } catch (error) {
    console.warn(`Warning: Failed to parse existing file ${filePath}:`, error);
    return null;
  }
}

function mergeModel(
  apiModel: z.infer<typeof OpenRouterModel>,
  existing: ExistingModel | null,
): MergedModel {
  const supportedParameters = apiModel.supported_parameters ?? [];
  const inputModalities = sanitizeModalities(apiModel.architecture?.input_modalities, ["text"]);
  const outputModalities = sanitizeModalities(apiModel.architecture?.output_modalities, ["text"]);

  const releaseDate = existing?.release_date
    ?? (apiModel.created ? timestampToDate(apiModel.created) : getTodayDate());
  const contextLimit = existing?.limit?.context
    ?? apiModel.top_provider?.context_length
    ?? apiModel.context_length
    ?? 0;
  const outputLimit = existing?.limit?.output
    ?? apiModel.top_provider?.max_completion_tokens
    ?? 0;
  const knowledge = existing?.knowledge ?? apiModel.knowledge_cutoff?.slice(0, 10);

  const costInput = existing?.cost?.input ?? pricingToPerMillion(apiModel.pricing?.prompt);
  const costOutput = existing?.cost?.output ?? pricingToPerMillion(apiModel.pricing?.completion);
  const costReasoning = existing?.cost?.reasoning ?? pricingToPerMillion(apiModel.pricing?.reasoning);
  const costCacheRead = existing?.cost?.cache_read ?? pricingToPerMillion(apiModel.pricing?.input_cache_read);
  const costCacheWrite = existing?.cost?.cache_write ?? pricingToPerMillion(apiModel.pricing?.input_cache_write);
  const costInputAudio = existing?.cost?.input_audio ?? pricingToPerMillion(apiModel.pricing?.input_audio);
  const costOutputAudio = existing?.cost?.output_audio ?? pricingToPerMillion(apiModel.pricing?.output_audio);

  const merged: MergedModel = {
    name: existing?.name ?? apiModel.name,
    family: existing?.family ?? inferFamily(apiModel.id, apiModel.name),
    attachment: existing?.attachment ?? inputModalities.some((modality) => modality !== "text"),
    reasoning: existing?.reasoning ?? boolFromParams(supportedParameters, ["reasoning", "include_reasoning"]),
    tool_call: existing?.tool_call ?? boolFromParams(supportedParameters, ["tools", "tool_choice"]),
    structured_output: existing?.structured_output
      ?? boolFromParams(supportedParameters, ["structured_outputs", "response_format"]),
    temperature: existing?.temperature ?? boolFromParams(supportedParameters, ["temperature"]),
    knowledge,
    release_date: releaseDate,
    last_updated: getTodayDate(),
    open_weights: existing?.open_weights ?? hasOpenWeights(apiModel.hugging_face_id),
    status: existing?.status,
    limit: {
      context: contextLimit,
      input: existing?.limit?.input,
      output: outputLimit,
    },
    modalities: {
      input: existing?.modalities?.input ?? inputModalities,
      output: existing?.modalities?.output ?? outputModalities,
    },
  };

  if (costInput !== undefined && costOutput !== undefined) {
    merged.cost = {
      input: costInput,
      output: costOutput,
      ...(costReasoning !== undefined && { reasoning: costReasoning }),
      ...(costCacheRead !== undefined && { cache_read: costCacheRead }),
      ...(costCacheWrite !== undefined && { cache_write: costCacheWrite }),
      ...(costInputAudio !== undefined && { input_audio: costInputAudio }),
      ...(costOutputAudio !== undefined && { output_audio: costOutputAudio }),
    };
  }

  return merged;
}

function formatToml(model: MergedModel): string {
  const lines: string[] = [];

  lines.push(`name = "${model.name.replace(/"/g, '\\"')}"`);
  if (model.family) {
    lines.push(`family = "${model.family}"`);
  }
  lines.push(`release_date = "${model.release_date}"`);
  lines.push(`last_updated = "${model.last_updated}"`);
  lines.push(`attachment = ${model.attachment}`);
  lines.push(`reasoning = ${model.reasoning}`);
  if (model.temperature !== undefined) {
    lines.push(`temperature = ${model.temperature}`);
  }
  if (model.knowledge) {
    lines.push(`knowledge = "${model.knowledge}"`);
  }
  lines.push(`tool_call = ${model.tool_call}`);
  if (model.structured_output !== undefined) {
    lines.push(`structured_output = ${model.structured_output}`);
  }
  lines.push(`open_weights = ${model.open_weights}`);
  if (model.status) {
    lines.push(`status = "${model.status}"`);
  }

  if (model.cost) {
    lines.push("");
    lines.push(`[cost]`);
    lines.push(`input = ${formatCostNumber(model.cost.input)}`);
    lines.push(`output = ${formatCostNumber(model.cost.output)}`);
    if (model.cost.reasoning !== undefined) {
      lines.push(`reasoning = ${formatCostNumber(model.cost.reasoning)}`);
    }
    if (model.cost.cache_read !== undefined) {
      lines.push(`cache_read = ${formatCostNumber(model.cost.cache_read)}`);
    }
    if (model.cost.cache_write !== undefined) {
      lines.push(`cache_write = ${formatCostNumber(model.cost.cache_write)}`);
    }
    if (model.cost.input_audio !== undefined) {
      lines.push(`input_audio = ${formatCostNumber(model.cost.input_audio)}`);
    }
    if (model.cost.output_audio !== undefined) {
      lines.push(`output_audio = ${formatCostNumber(model.cost.output_audio)}`);
    }
  }

  lines.push("");
  lines.push(`[limit]`);
  lines.push(`context = ${formatNumber(model.limit.context)}`);
  if (model.limit.input !== undefined) {
    lines.push(`input = ${formatNumber(model.limit.input)}`);
  }
  lines.push(`output = ${formatNumber(model.limit.output)}`);

  lines.push("");
  lines.push(`[modalities]`);
  lines.push(`input = [${model.modalities.input.map((modality) => `"${modality}"`).join(", ")}]`);
  lines.push(`output = [${model.modalities.output.map((modality) => `"${modality}"`).join(", ")}]`);

  return lines.join("\n") + "\n";
}

function detectChanges(existing: ExistingModel | null, merged: MergedModel): Changes[] {
  if (!existing) return [];

  const changes: Changes[] = [];
  const epsilon = 0.001;

  const formatValue = (value: unknown): string => {
    if (typeof value === "number") return formatNumber(value);
    if (Array.isArray(value)) return `[${value.join(", ")}]`;
    if (value === undefined) return "(none)";
    return String(value);
  };

  const compare = (field: string, oldValue: unknown, newValue: unknown) => {
    const isDiff = typeof oldValue === "number" && typeof newValue === "number"
      ? Math.abs(oldValue - newValue) > epsilon
      : JSON.stringify(oldValue) !== JSON.stringify(newValue);

    if (isDiff) {
      changes.push({
        field,
        oldValue: formatValue(oldValue),
        newValue: formatValue(newValue),
      });
    }
  };

  compare("name", existing.name, merged.name);
  compare("family", existing.family, merged.family);
  compare("attachment", existing.attachment, merged.attachment);
  compare("reasoning", existing.reasoning, merged.reasoning);
  compare("tool_call", existing.tool_call, merged.tool_call);
  compare("structured_output", existing.structured_output, merged.structured_output);
  compare("temperature", existing.temperature, merged.temperature);
  compare("knowledge", existing.knowledge, merged.knowledge);
  compare("open_weights", existing.open_weights, merged.open_weights);
  compare("release_date", existing.release_date, merged.release_date);
  compare("cost.input", existing.cost?.input, merged.cost?.input);
  compare("cost.output", existing.cost?.output, merged.cost?.output);
  compare("cost.reasoning", existing.cost?.reasoning, merged.cost?.reasoning);
  compare("cost.cache_read", existing.cost?.cache_read, merged.cost?.cache_read);
  compare("cost.cache_write", existing.cost?.cache_write, merged.cost?.cache_write);
  compare("cost.input_audio", existing.cost?.input_audio, merged.cost?.input_audio);
  compare("cost.output_audio", existing.cost?.output_audio, merged.cost?.output_audio);
  compare("limit.context", existing.limit?.context, merged.limit.context);
  compare("limit.input", existing.limit?.input, merged.limit.input);
  compare("limit.output", existing.limit?.output, merged.limit.output);
  compare("modalities.input", existing.modalities?.input, merged.modalities.input);
  compare("modalities.output", existing.modalities?.output, merged.modalities.output);

  return changes;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const newOnly = args.includes("--new-only");
  const deleteOrphaned = args.includes("--delete-orphaned");

  const modelsDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
    "openrouter",
    "models",
  );

  const modeLabels = [
    dryRun ? "[DRY RUN]" : "",
    newOnly ? "[NEW ONLY]" : "",
    deleteOrphaned ? "[DELETE ORPHANED]" : "",
  ].filter(Boolean).join(" ");

  console.log(`${modeLabels ? `${modeLabels} ` : ""}Fetching OpenRouter models from API...\n`);

  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  const parsed = OpenRouterResponse.safeParse(json);
  if (!parsed.success) {
    parsed.error.cause = json;
    console.error("Invalid API response:", parsed.error.errors);
    console.error("When parsing:", parsed.error.cause);
    process.exit(1);
  }

  const apiModels = parsed.data.data;
  const existingFiles = new Set<string>();
  for await (const file of new Bun.Glob("**/*.toml").scan({
    cwd: modelsDir,
    absolute: false,
  })) {
    existingFiles.add(file);
  }

  console.log(`Found ${apiModels.length} models in API, ${existingFiles.size} existing files\n`);

  const apiModelIds = new Set<string>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const apiModel of apiModels) {
    const relativePath = `${apiModel.id}.toml`;
    const filePath = path.join(modelsDir, relativePath);
    const dirPath = path.dirname(filePath);

    apiModelIds.add(relativePath);

    const existing = await loadExistingModel(filePath);
    const merged = mergeModel(apiModel, existing);
    const tomlContent = formatToml(merged);

    if (existing === null) {
      created++;
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${relativePath}`);
      } else {
        await mkdir(dirPath, { recursive: true });
        await Bun.write(filePath, tomlContent);
        console.log(`Created: ${relativePath}`);
      }
      continue;
    }

    if (newOnly) {
      unchanged++;
      continue;
    }

    const changes = detectChanges(existing, merged);
    if (changes.length === 0) {
      unchanged++;
      continue;
    }

    updated++;
    if (dryRun) {
      console.log(`[DRY RUN] Would update: ${relativePath}`);
    } else {
      await mkdir(dirPath, { recursive: true });
      await Bun.write(filePath, tomlContent);
      console.log(`Updated: ${relativePath}`);
    }
    for (const change of changes) {
      console.log(`  ${change.field}: ${change.oldValue} → ${change.newValue}`);
    }
    console.log("");
  }

  const orphaned: string[] = [];
  for (const file of existingFiles) {
    if (!apiModelIds.has(file)) {
      orphaned.push(file);
      if (deleteOrphaned) {
        const filePath = path.join(modelsDir, file);
        if (dryRun) {
          console.log(`[DRY RUN] Would delete orphaned: ${file}`);
        } else {
          await unlink(filePath);
          console.log(`Deleted orphaned: ${file}`);
        }
      } else {
        console.log(`Warning: Orphaned file (not in API): ${file}`);
      }
    }
  }

  console.log("");
  const orphanedSummary = deleteOrphaned
    ? `${orphaned.length} orphaned${dryRun ? " would be deleted" : " deleted"}`
    : `${orphaned.length} orphaned`;
  if (dryRun) {
    console.log(
      `Summary: ${created} would be created, ${updated} would be updated, ${unchanged} unchanged, ${orphanedSummary}`,
    );
  } else {
    console.log(
      `Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphanedSummary}`,
    );
  }
}

await main();
