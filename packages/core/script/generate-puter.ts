#!/usr/bin/env bun

/**
 * Generates Puter model TOML files from the Puter AI API.
 *
 * Flags:
 * --dry-run: Preview changes without writing files
 * --new-only: Only create new models, skip updating existing ones
 */

import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { ModelFamilyValues } from "../src/family.js";

const API_ENDPOINT = "https://puter.com/puterai/chat/models/details";

enum SkipZeroFields {
  LimitContext = "limit.context",
  LimitOutput = "limit.output",
}
const PuterModalities = z.object({
  input: z.array(z.string()).optional(),
  output: z.array(z.string()).optional(),
}).passthrough();

const PuterModel = z.object({
  puterId: z.string().optional(),
  id: z.string(),
  name: z.string().optional(),
  modalities: PuterModalities.optional(),
  open_weights: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  knowledge: z.string().optional(),
  release_date: z.string().optional(),
  succeeded_by: z.string().optional(),
  aliases: z.array(z.string()),
  costs_currency: z.string(),
  input_cost_key: z.string(),
  output_cost_key: z.string(),
  // costs can have any keys/values. we look up keys by the input_cost_key and output_cost_key
  costs: z.object({}).passthrough(),
  context: z.number().nullish(),
  max_tokens: z.number().nullish(),
  provider: z.string(),
  qualitative_speed: z.string().optional(),
  training_cutoff: z.string().optional(),
}).passthrough();

const PuterResponse = z.object({
  models: z.array(PuterModel),
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
  interleaved?: boolean | { field: string };
  status?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context?: number;
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
    cache_read?: number;
    cache_write?: number;
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

interface Changes {
  field: string;
  oldValue: string;
  newValue: string;
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Number utilities
function formatNumber(n: number): string {
  if (n >= 1000) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return n.toString();
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

  // First pass: try exact substring matches
  for (const family of sortedFamilies) {
    if (isSubstring(modelId, family)) {
      return family;
    }
  }

  for (const family of sortedFamilies) {
    if (isSubstring(modelName, family)) {
      return family;
    }
  }

  // Second pass: fall back to subsequence matching
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

/**
 * Parses a Puter model ID (e.g., "anthropic:anthropic/claude-3-5-sonnet")
 * Returns the file path for the model
 */
function parseModelId(puterId: string): string {
  // Format: "provider:namespace/model-name" or "provider:namespace/model-name:suffix"
  // The first colon separates provider from namespace/model, but colons in the model name should be preserved
  const firstColonIndex = puterId.indexOf(":");
  if (firstColonIndex === -1) {
    // No colon found, treat as simple path
    return puterId.replace(/\//g, "/");
  }

  const provider = puterId.slice(0, firstColonIndex);
  const namespaceModel = puterId.slice(firstColonIndex + 1);
  
  if (!namespaceModel) {
    return provider;
  }

  const namespaceParts = namespaceModel.split("/");
  const namespace = namespaceParts[0];
  const modelName = namespaceParts[namespaceParts.length - 1] || namespaceModel;

  // File path: if namespace matches provider, use "provider/rest-of-path/model-name.toml"
  // Otherwise use "provider/namespace/rest-of-path/model-name.toml"
  if (namespace === provider) {
    // Remove the first namespace part since it matches the provider
    const restOfPath = namespaceParts.slice(1).join("/");
    return restOfPath ? `${provider}/${restOfPath}` : `${provider}/${modelName}`;
  } else {
    // Keep the full namespace path
    return `${provider}/${namespaceModel}`;
  }
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

function mergeModel(
  apiModel: z.infer<typeof PuterModel>,
  existing: ExistingModel | null,
): MergedModel {
  const modelId = apiModel.puterId ?? apiModel.id;
  
  // use existing name if set, fall back to api name, then model id since some models don't have a name
  const name = existing?.name ?? apiModel.name ?? apiModel.id;
  
  // Determine attachment from modalities (has image or pdf)
  const hasImage = apiModel.modalities?.input?.includes("image") ?? false;
  const hasPdf = apiModel.modalities?.input?.includes("pdf") ?? false;
  const attachment = existing?.attachment ?? (hasImage || hasPdf);
  
  // puter api does not tell us whether a model has reasoning, so we can only use existing
  const reasoning = existing?.reasoning ?? false;

  const toolCall = existing?.tool_call ?? apiModel.tool_call ?? false;
  const openWeights = existing?.open_weights ?? apiModel.open_weights ?? false;
  const family = existing?.family ?? inferFamily(modelId, name);
  const structuredOutput = existing?.structured_output;
  const knowledge = existing?.knowledge ?? apiModel.knowledge;
  const interleaved = existing?.interleaved;
  const status = existing?.status;
  const releaseDate = existing?.release_date ?? apiModel.release_date ?? getTodayDate();
  // Context and output limits from API
  const contextLimit = apiModel.context ?? existing?.limit?.context ?? 128_000;
  const outputLimit = apiModel.max_tokens ?? existing?.limit?.output ?? 4_096;

  const inputModalities = existing?.modalities?.input ?? apiModel.modalities?.input ?? ["text"];
  const outputModalities = existing?.modalities?.output ?? apiModel.modalities?.output ?? ["text"];

  const merged: MergedModel = {
    name,
    family,
    attachment,
    reasoning,
    tool_call: toolCall,
    temperature: true,
    release_date: releaseDate,
    last_updated: getTodayDate(),
    open_weights: openWeights,
    ...(structuredOutput !== undefined && { structured_output: structuredOutput }),
    ...(knowledge && { knowledge }),
    ...(interleaved !== undefined && { interleaved }),
    ...(status && { status }),
    limit: {
      context: contextLimit,
      output: outputLimit,
    },
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
  };

  

  // Extract costs from API
  if (apiModel.costs_currency !== "usd-cents") {
    throw new Error(`Unsupported cost currency: ${apiModel.costs_currency}`);
  }

  const costs = apiModel.costs;
  const inputCost = costs[apiModel.input_cost_key] as number;
  const outputCost = costs[apiModel.output_cost_key] as number;

  const cacheReadCost = (costs.input_cache_read ?? costs.cache_read_input_tokens ?? costs.cached_tokens) as number | undefined;
  const cacheWriteCost = costs.input_cache_write as number | undefined;

  if (inputCost !== undefined && outputCost !== undefined) {
    merged.cost = {
        // convert cents to dollars
        input: inputCost / 100,
        output: outputCost / 100,
        ...(cacheReadCost !== undefined && { cache_read: cacheReadCost / 100 }),
        ...(cacheWriteCost !== undefined && { cache_write: cacheWriteCost / 100 }),
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

  if (model.interleaved !== undefined) {
    lines.push("");
    if (model.interleaved === true) {
      lines.push(`interleaved = true`);
    } else if (typeof model.interleaved === "object") {
      lines.push(`[interleaved]`);
      lines.push(`field = "${model.interleaved.field}"`);
    }
  }

  if (model.cost) {
    lines.push("");
    lines.push(`[cost]`);
    lines.push(`input = ${model.cost.input}`);
    lines.push(`output = ${model.cost.output}`);
    if (model.cost.cache_read !== undefined) {
      lines.push(`cache_read = ${model.cost.cache_read}`);
    }
    if (model.cost.cache_write !== undefined) {
      lines.push(`cache_write = ${model.cost.cache_write}`);
    }
  }

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

function detectChanges(
  existing: ExistingModel | null,
  merged: MergedModel,
): Changes[] {
  if (!existing) return [];

  const changes: Changes[] = [];
  const EPSILON = 0.001; // price diff to ignore (per million tokens)

  const shouldSkipZero = (field: string, oldVal: unknown, newVal: unknown): boolean => {
    if (!Object.values(SkipZeroFields).includes(field as SkipZeroFields)) {
      return false;
    }
    return (typeof oldVal === "number" && oldVal === 0) || (typeof newVal === "number" && newVal === 0);
  };

  const formatValue = (val: unknown): string => {
    if (typeof val === "number") return formatNumber(val);
    if (Array.isArray(val)) return `[${val.join(", ")}]`;
    if (val === undefined) return "(none)";
    return String(val);
  };

  const isMaterialPriceDiff = (oldPrice: unknown, newPrice: unknown): boolean => {
    // 0 → undefined is not material (cost removed)
    if (oldPrice === 0 && newPrice === undefined) return false;

    if (oldPrice !== undefined && newPrice !== undefined) {
      return Math.abs((oldPrice as number) - (newPrice as number)) > EPSILON;
    }

    return oldPrice !== newPrice;
  };

  const compare = (field: string, oldVal: unknown, newVal: unknown) => {
    if (shouldSkipZero(field, oldVal, newVal)) return;

    const isDiff = field.startsWith("cost.")
      ? isMaterialPriceDiff(oldVal, newVal)
      : JSON.stringify(oldVal) !== JSON.stringify(newVal);

    if (isDiff) {
      changes.push({
        field,
        oldValue: formatValue(oldVal),
        newValue: formatValue(newVal),
      });
    }
  };

  compare("name", existing.name, merged.name);
  compare("family", existing.family, merged.family);
  compare("attachment", existing.attachment, merged.attachment);
  compare("reasoning", existing.reasoning, merged.reasoning);
  compare("tool_call", existing.tool_call, merged.tool_call);
  compare("structured_output", existing.structured_output, merged.structured_output);
  compare("open_weights", existing.open_weights, merged.open_weights);
  compare("release_date", existing.release_date, merged.release_date);
  compare("cost.input", existing.cost?.input, merged.cost?.input);
  compare("cost.output", existing.cost?.output, merged.cost?.output);
  compare("cost.cache_read", existing.cost?.cache_read, merged.cost?.cache_read);
  compare("cost.cache_write", existing.cost?.cache_write, merged.cost?.cache_write);
  compare("limit.context", existing.limit?.context, merged.limit.context);
  compare("limit.output", existing.limit?.output, merged.limit.output);
  compare("modalities.input", existing.modalities?.input, merged.modalities.input);
  compare("modalities.output", existing.modalities?.output, merged.modalities.output);

  return changes;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const newOnly = args.includes("--new-only");

  const modelsDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
    "puter",
    "models",
  );

  console.log(`${dryRun ? "[DRY RUN] " : ""}${newOnly ? "[NEW ONLY] " : ""}Fetching Puter models from API...`);

  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  const parsed = PuterResponse.safeParse(json);
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  const apiModels = parsed.data.models;

  const existingFiles = new Set<string>();
  try {
    for await (const file of new Bun.Glob("**/*.toml").scan({
      cwd: modelsDir,
      absolute: false,
    })) {
      existingFiles.add(file);
    }
  } catch {
  }

  console.log(`Found ${apiModels.length} models in API, ${existingFiles.size} existing files\n`);

  const apiModelPaths = new Set<string>();

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const apiModel of apiModels) {
    // not all models need a set puterId, fall back to id
    const modelId = apiModel.puterId ?? apiModel.id;
    if (!modelId) {
      console.warn(`Skipping model without puterId or id:`, apiModel);
      continue;
    }

    const filePath = parseModelId(modelId);
    const relativePath = `${filePath}.toml`;
    const fullPath = path.join(modelsDir, relativePath);
    const dirPath = path.dirname(fullPath);

    apiModelPaths.add(relativePath);

    const existing = await loadExistingModel(fullPath);
    const merged = mergeModel(apiModel, existing);
    const tomlContent = formatToml(merged);

    if (existing === null) {
      created++;
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${relativePath}`);
        console.log(`  name = "${merged.name}"`);
        if (merged.family) {
          console.log(`  family = "${merged.family}" (inferred)`);
        }
        console.log("");
      } else {
        await mkdir(dirPath, { recursive: true });
        await Bun.write(fullPath, tomlContent);
        console.log(`Created: ${relativePath}`);
      }
    } else {
      if (newOnly) {
        unchanged++;
        continue;
      }

      const changes = detectChanges(existing, merged);

      if (changes.length > 0) {
        updated++;
        if (dryRun) {
          console.log(`[DRY RUN] Would update: ${relativePath}`);
        } else {
          await mkdir(dirPath, { recursive: true });
          await Bun.write(fullPath, tomlContent);
          console.log(`Updated: ${relativePath}`);
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
    if (!apiModelPaths.has(file)) {
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
