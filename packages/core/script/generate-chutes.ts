#!/usr/bin/env bun

/**
 * Generates Chutes model TOML files from the Chutes LLM API.
 *
 * Flags:
 * --dry-run: Preview changes without writing files
 * --new-only: Only create new models, skip updating existing ones
 * --keep-orphans: Don't delete TOML files for models no longer in the API
 */

import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { ModelFamilyValues } from "../src/family.js";

const API_ENDPOINT = "https://llm.chutes.ai/v1/models";

enum SkipZeroFields {
  LimitContext = "limit.context",
  LimitOutput = "limit.output",
}

const Pricing = z.object({
  prompt: z.number().optional(),
  completion: z.number().optional(),
  input_cache_read: z.number().optional(),
}).passthrough();

const ChutesModel = z.object({
  id: z.string(),
  created: z.number(),
  pricing: Pricing.optional(),
  context_length: z.number().optional(),
  max_output_length: z.number().optional(),
  max_model_len: z.number().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  supported_features: z.array(z.string()).optional(),
  supported_sampling_parameters: z.array(z.string()).optional(),
  quantization: z.string().optional(),
}).passthrough();

const ChutesResponse = z.object({
  data: z.array(ChutesModel),
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

// ── Utility functions ────────────────────────────────────────────────

function timestampToDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toISOString().slice(0, 10);
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

/**
 * Humanize a model ID into a readable name.
 * Strips the org prefix and replaces hyphens with spaces.
 * e.g. "Qwen/Qwen3-32B-TEE" → "Qwen3 32B TEE"
 */
function humanizeModelName(modelId: string): string {
  const parts = modelId.split("/");
  const modelPart = parts[parts.length - 1];
  return modelPart.replace(/-/g, " ");
}

// ── Family inference (same approach as generate-vercel.ts) ───────────

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

// ── Load existing TOML ───────────────────────────────────────────────

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

// ── Merge API data with existing TOML ────────────────────────────────

function mergeModel(
  apiModel: z.infer<typeof ChutesModel>,
  existing: ExistingModel | null,
): MergedModel {
  const features = new Set(apiModel.supported_features ?? []);
  const samplingParams = new Set(apiModel.supported_sampling_parameters ?? []);
  const inputMods = apiModel.input_modalities ?? ["text"];
  const outputMods = apiModel.output_modalities ?? ["text"];

  // Capabilities from API features
  const hasAttachment = inputMods.some((m) =>
    m === "image" || m === "video" || m === "pdf",
  );
  const hasReasoning = features.has("reasoning");
  const hasToolCall = features.has("tools");
  const hasStructuredOutput = features.has("structured_outputs");
  const hasTemperature = samplingParams.size > 0
    ? samplingParams.has("temperature")
    : true; // default true if no sampling params info

  // Preserve existing values when available (manually specified)
  const modelName = existing?.name ?? humanizeModelName(apiModel.id);
  const family = existing?.family ?? inferFamily(apiModel.id, modelName);
  const knowledge = existing?.knowledge;
  const interleaved = existing?.interleaved;
  const status = existing?.status;

  // Release date: existing > API created timestamp > today
  const releaseDate = existing?.release_date
    ?? timestampToDate(apiModel.created)
    ?? getTodayDate();

  // Context limit: prefer context_length, fallback to max_model_len
  const apiContext = apiModel.context_length ?? apiModel.max_model_len ?? 0;
  const contextLimit = apiContext > 0
    ? apiContext
    : (existing?.limit?.context ?? 0);

  // Output limit: prefer max_output_length, fallback to existing
  const apiOutput = apiModel.max_output_length ?? 0;
  const outputLimit = apiOutput > 0
    ? apiOutput
    : (existing?.limit?.output ?? 0);

  const merged: MergedModel = {
    name: modelName,
    family,
    attachment: hasAttachment,
    reasoning: hasReasoning,
    tool_call: hasToolCall,
    temperature: hasTemperature,
    release_date: releaseDate,
    last_updated: getTodayDate(),
    open_weights: true, // Chutes hosts open-weight models
    ...(hasStructuredOutput && { structured_output: hasStructuredOutput }),
    ...(knowledge && { knowledge }),
    ...(interleaved !== undefined && { interleaved }),
    ...(status && { status }),
    limit: {
      context: contextLimit,
      output: outputLimit,
    },
    modalities: {
      input: inputMods,
      output: outputMods,
    },
  };

  // Cost: API values are already in USD per 1M tokens — use directly
  if (apiModel.pricing) {
    const inputPrice = apiModel.pricing.prompt;
    const outputPrice = apiModel.pricing.completion;
    const cacheReadPrice = apiModel.pricing.input_cache_read;

    if (inputPrice !== undefined && outputPrice !== undefined) {
      merged.cost = {
        input: inputPrice,
        output: outputPrice,
        ...(cacheReadPrice !== undefined && { cache_read: cacheReadPrice }),
      };
    }
  }

  return merged;
}

// ── TOML formatting ──────────────────────────────────────────────────

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
  lines.push(`temperature = ${model.temperature}`);
  lines.push(`tool_call = ${model.tool_call}`);
  if (model.structured_output !== undefined) {
    lines.push(`structured_output = ${model.structured_output}`);
  }
  lines.push(`open_weights = ${model.open_weights}`);
  if (model.knowledge) {
    lines.push(`knowledge = "${model.knowledge}"`);
  }
  if (model.status) {
    lines.push(`status = "${model.status}"`);
  }

  if (model.cost) {
    lines.push("");
    lines.push(`[cost]`);
    lines.push(`input = ${model.cost.input}`);
    lines.push(`output = ${model.cost.output}`);
    if (model.cost.cache_read !== undefined) {
      lines.push(`cache_read = ${model.cost.cache_read}`);
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

  if (model.interleaved !== undefined) {
    lines.push("");
    if (model.interleaved === true) {
      lines.push(`interleaved = true`);
    } else if (typeof model.interleaved === "object") {
      lines.push(`[interleaved]`);
      lines.push(`field = "${model.interleaved.field}"`);
    }
  }

  return lines.join("\n") + "\n";
}

// ── Change detection ─────────────────────────────────────────────────

function detectChanges(
  existing: ExistingModel | null,
  merged: MergedModel,
): Changes[] {
  if (!existing) return [];

  const changes: Changes[] = [];
  const EPSILON = 0.001;

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
  compare("limit.context", existing.limit?.context, merged.limit.context);
  compare("limit.output", existing.limit?.output, merged.limit.output);
  compare("modalities.input", existing.modalities?.input, merged.modalities.input);
  compare("modalities.output", existing.modalities?.output, merged.modalities.output);

  return changes;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const newOnly = args.includes("--new-only");
  const keepOrphans = args.includes("--keep-orphans");

  const modelsDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
    "chutes",
    "models",
  );

  console.log(`${dryRun ? "[DRY RUN] " : ""}${newOnly ? "[NEW ONLY] " : ""}${keepOrphans ? "[KEEP ORPHANS] " : ""}Fetching Chutes models from API...`);

  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  const parsed = ChutesResponse.safeParse(json);
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  const apiModels = parsed.data.data;

  // Scan existing TOML files
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
        console.log(`  name = "${merged.name}"`);
        if (merged.family) {
          console.log(`  family = "${merged.family}" (inferred)`);
        }
        console.log("");
      } else {
        await mkdir(dirPath, { recursive: true });
        await Bun.write(filePath, tomlContent);
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
          await Bun.write(filePath, tomlContent);
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

  // Handle orphaned files (on disk but not in API)
  const orphaned: string[] = [];
  for (const file of existingFiles) {
    if (!apiModelIds.has(file)) {
      orphaned.push(file);
      const orphanPath = path.join(modelsDir, file);
      if (keepOrphans) {
        console.log(`Orphaned (kept): ${file}`);
      } else if (dryRun) {
        console.log(`[DRY RUN] Would delete: ${file}`);
      } else {
        await Bun.file(orphanPath).delete();
        console.log(`Deleted: ${file}`);

        // Clean up empty parent directories
        const parentDir = path.dirname(orphanPath);
        try {
          const remaining = [];
          for await (const entry of new Bun.Glob("*").scan({ cwd: parentDir })) {
            remaining.push(entry);
          }
          if (remaining.length === 0) {
            const { rmdir } = await import("node:fs/promises");
            await rmdir(parentDir);
            console.log(`  Removed empty directory: ${path.basename(parentDir)}/`);
          }
        } catch {
          // Directory not empty or other error, ignore
        }
      }
    }
  }

  console.log("");
  if (dryRun) {
    console.log(
      `Summary: ${created} would be created, ${updated} would be updated, ${unchanged} unchanged, ${orphaned.length} would be deleted`,
    );
  } else if (keepOrphans) {
    console.log(
      `Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphaned.length} orphaned (kept)`,
    );
  } else {
    console.log(
      `Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphaned.length} deleted`,
    );
  }
}

await main();
