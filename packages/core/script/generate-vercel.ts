#!/usr/bin/env bun

/**
 * Generates Vercel model TOML files from the AI Gateway API.
 *
 * Flags:
 * --dry-run: Preview changes without writing files
 * --new-only: Only create new models, skip updating existing ones
 */

import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { ModelFamilyValues } from "../src/family.js";

const API_ENDPOINT = "https://ai-gateway.vercel.sh/v1/models";

enum ModelType {
  Language = "language",
  Image = "image",
  Video = "video",
  Embedding = "embedding",
}

const PricingTier = z.object({
  cost: z.string(),
  min: z.number(),
  max: z.number().optional(),
});

const Pricing = z.object({
  input: z.string().optional(),
  output: z.string().optional(),
  cache_read: z.string().optional(),
  cache_write: z.string().optional(),
  input_tiers: z.array(PricingTier).optional(),
  output_tiers: z.array(PricingTier).optional(),
}).passthrough();

const VercelModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  released: z.number().optional(),
  context_window: z.number(),
  max_tokens: z.number(),
  type: z.nativeEnum(ModelType),
  tags: z.array(z.string()).optional().default([]),
  pricing: Pricing.optional(),
}).passthrough();

const VercelResponse = z.object({
  data: z.array(VercelModel),
}).passthrough();

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

function buildInputModalities(tags: string[]): string[] {
  const mods: string[] = ["text"];
  const tagSet = new Set(tags);

  if (tagSet.has("vision")) mods.push("image");
  if (tagSet.has("file-input")) mods.push("pdf");

  return mods;
}

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
  apiModel: z.infer<typeof VercelModel>,
  existing: ExistingModel | null,
): MergedModel {
  const tagSet = new Set(apiModel.tags);
  const inputModalities = buildInputModalities(apiModel.tags);

  // Preserve existing values when available  
  const name = existing?.name ?? apiModel.name;
  const attachment = existing?.attachment ?? (tagSet.has("vision") || tagSet.has("file-input"));
  const reasoning = existing?.reasoning ?? tagSet.has("reasoning");
  const toolCall = existing?.tool_call ?? tagSet.has("tool-use");
  const openWeights = existing?.open_weights ?? false;

  // Use API, fallback to existing, then today
  const releaseDate = apiModel.released
    ? timestampToDate(apiModel.released)
    : (existing?.release_date ?? getTodayDate());

  // Preserve existing if API returns 0 (indicates missing/invalid data)
  const contextLimit = apiModel.context_window > 0
    ? apiModel.context_window
    : (existing?.limit?.context ?? 0);
  const outputLimit = apiModel.max_tokens > 0
    ? apiModel.max_tokens
    : (existing?.limit?.output ?? 0);

  // Deduce output modalities from model type
  const outputModalities: string[] = ["text"];
  if (apiModel.type === ModelType.Image) {
    outputModalities.push("image");
  } else if (apiModel.type === ModelType.Video) {
    outputModalities.push("video");
  }

  const merged: MergedModel = {
    name,
    attachment,
    reasoning,
    tool_call: toolCall,
    temperature: true,
    release_date: releaseDate,
    last_updated: getTodayDate(),
    open_weights: openWeights,
    limit: {
      context: contextLimit,
      output: outputLimit,
    },
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
  };

  if (tagSet.has("structured-output")) {
    merged.structured_output = true;
  } else if (existing?.structured_output !== undefined) {
    merged.structured_output = existing.structured_output;
  }

  if (apiModel.pricing?.input && apiModel.pricing?.output) {
    merged.cost = {
      input: parseFloat(apiModel.pricing.input) * 1_000_000,
      output: parseFloat(apiModel.pricing.output) * 1_000_000,
      ...(apiModel.pricing.cache_read && {
        cache_read: parseFloat(apiModel.pricing.cache_read) * 1_000_000,
      }),
      ...(apiModel.pricing.cache_write && {
        cache_write: parseFloat(apiModel.pricing.cache_write) * 1_000_000,
      }),
    };
  }

  merged.family = existing?.family ?? inferFamily(apiModel.id, apiModel.name);

  if (existing?.knowledge) {
    merged.knowledge = existing.knowledge;
  }
  if (existing?.interleaved !== undefined) {
    merged.interleaved = existing.interleaved;
  }
  if (existing?.status !== undefined) {
    merged.status = existing.status;
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

interface Changes {
  field: string;
  oldValue: string;
  newValue: string;
}

enum SkipZeroFields {
  LimitContext = "limit.context",
  LimitOutput = "limit.output",
}

function detectChanges(
  existing: ExistingModel | null,
  merged: MergedModel,
): Changes[] {
  if (!existing) return [];

  const changes: Changes[] = [];
  const EPSILON = 0.0001;

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
    // undefined → 0 is material (cost added)
    if (oldPrice === 0 && newPrice === undefined) return false;

    if (typeof oldPrice === "number" && typeof newPrice === "number") {
      return Math.abs(oldPrice - newPrice) > EPSILON;
    }
    return JSON.stringify(oldPrice) !== JSON.stringify(newPrice);
  };

  const compare = (field: string, oldVal: unknown, newVal: unknown) => {
    if (shouldSkipZero(field, oldVal, newVal)) return;

    if (isMaterialPriceDiff(oldVal, newVal)) {
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
    "vercel",
    "models",
  );

  console.log(`${dryRun ? "[DRY RUN] " : ""}${newOnly ? "[NEW ONLY] " : ""}Fetching Vercel models from API...`);

  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  const parsed = VercelResponse.safeParse(json);
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  const apiModels = parsed.data.data;

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
