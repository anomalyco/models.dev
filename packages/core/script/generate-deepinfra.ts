#!/usr/bin/env bun

/**
 * Generates DeepInfra model TOML files from the OpenAI-compatible API.
 *
 * Flags:
 * --dry-run: Preview changes without writing files
 * --new-only: Only create new models, skip updating existing ones
 * --no-delete: Keep orphaned files instead of deleting them
 */

import { z } from "zod";
import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { ModelFamilyValues } from "../src/family.js";

const API_ENDPOINT = "https://api.deepinfra.com/v1/openai/models";

// Allowlist of providers to include - only these providers will be tracked
// This is intentionally restrictive since most models shouldn't be included
const PROVIDER_ALLOWLIST: string[] = [
  "anthropic",
  "deepseek-ai",
  "google",
  "meta-llama",
  "MiniMaxAI",
  "moonshotai",
  "nvidia",
  "openai",
  "Qwen",
  "stepfun-ai",
  "zai-org",
];

// Models/patterns to skip even from allowed providers (embeddings, image gen, etc.)
const MODEL_REGEX_DENYLIST: RegExp[] = [
  // Avoid most embedding models
  /embed/i,

  /(^|\/)FLUX/i,

  // Old Google models
  /gemini-1.5/i,
  /gemini-2.5/i,
  /gemma-3/i,

  // Old Llama models
  /Llama-3-/i,
  /Llama-3.1-/i,

  /Janus-Pro/i,
  /p-image/i,

  // Avoid any Qwen image generation models
  /Qwen-Image/i,

  // Qwen 2.5 models are obsolete
  /Qwen2.5/i,

  /Seedream/i,
];

function shouldSkipModel(modelId: string): boolean {
  const provider = modelId.split("/")[0];
  // Skip if provider is not in the allowlist
  if (!provider || !PROVIDER_ALLOWLIST.includes(provider)) {
    return true;
  }
  // Also skip models matching excluded patterns (embeddings, image gen, etc.)
  return MODEL_REGEX_DENYLIST.some((pattern) => pattern.test(modelId));
}

enum StubbedFields {
  ReleaseDate = "release_date",
  LastUpdated = "last_updated",
}

const DeepInfraModel = z
  .object({
    id: z.string(),
    object: z.string(),
    created: z.number(),
    owned_by: z.string(),
    root: z.string(),
    parent: z.string().nullable(),
    metadata: z
      .object({
        description: z.string().optional(),
        context_length: z.number().optional(),
        max_tokens: z.number().optional(),
        pricing: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            cache_read_tokens: z.number().optional(),
            cache_write_tokens: z.number().optional(),
          })
          .passthrough()
          .optional(),
        tags: z.array(z.string()).optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const DeepInfraResponse = z
  .object({
    object: z.string(),
    data: z.array(DeepInfraModel),
  })
  .passthrough();

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

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatNumber(n: number): string {
  if (n >= 1000) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return n.toString();
}

function formatCost(n: number): string {
  return n.toFixed(2);
}

function isSubstring(target: string, family: string): boolean {
  return target.toLowerCase().includes(family.toLowerCase());
}

function matchesFamily(target: string, family: string): boolean {
  const targetLower = target.toLowerCase();
  const familyLower = family.toLowerCase();
  let familyIdx = 0;

  for (
    let i = 0;
    i < targetLower.length && familyIdx < familyLower.length;
    i++
  ) {
    if (targetLower[i] === familyLower[familyIdx]) {
      familyIdx++;
    }
  }

  return familyIdx === familyLower.length;
}

function inferFamily(modelId: string): string | undefined {
  const sortedFamilies = [...ModelFamilyValues].sort(
    (a, b) => b.length - a.length,
  );

  for (const family of sortedFamilies) {
    if (isSubstring(modelId, family)) {
      return family;
    }
  }

  for (const family of sortedFamilies) {
    if (matchesFamily(modelId, family)) {
      return family;
    }
  }

  return undefined;
}

function buildInputModalities(
  metadata: z.infer<typeof DeepInfraModel>["metadata"],
): string[] {
  const mods: string[] = ["text"];
  const tags = new Set(metadata?.tags ?? []);

  if (tags.has("vision") || tags.has("image")) {
    mods.push("image");
  }
  if (tags.has("file-input")) {
    mods.push("pdf");
  }

  return mods;
}

function buildOutputModalities(
  metadata: z.infer<typeof DeepInfraModel>["metadata"],
): string[] {
  const mods: string[] = ["text"];
  const tags = new Set(metadata?.tags ?? []);

  if (tags.has("image-generation")) {
    mods.push("image");
  }

  return mods;
}

async function loadExistingModel(
  filePath: string,
): Promise<ExistingModel | null> {
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
  apiModel: z.infer<typeof DeepInfraModel>,
  existing: ExistingModel | null,
): MergedModel {
  const metadata = apiModel.metadata;
  const tags = new Set(metadata?.tags ?? []);

  const modelName = apiModel.id.split("/").pop() || apiModel.id;

  const name = existing?.name ?? modelName;
  const attachment =
    existing?.attachment ?? (tags.has("vision") || tags.has("file-input"));
  const reasoning = existing?.reasoning ?? tags.has("reasoning");
  const toolCall = existing?.tool_call ?? tags.has("tool-use");
  const openWeights =
    existing?.open_weights ?? apiModel.owned_by !== "deepinfra";
  const family = existing?.family ?? inferFamily(apiModel.id);
  const structuredOutput = existing?.structured_output;
  const knowledge = existing?.knowledge;
  const interleaved = existing?.interleaved;
  const status = existing?.status;

  const releaseDate = existing?.release_date ?? getTodayDate();
  const lastUpdated = existing?.last_updated ?? getTodayDate();

  const contextLimit = metadata?.context_length ?? 0;
  const outputLimit = metadata?.max_tokens ?? contextLimit;

  const merged: MergedModel = {
    name,
    family,
    attachment,
    reasoning,
    tool_call: toolCall,
    temperature: true,
    release_date: releaseDate,
    last_updated: lastUpdated,
    open_weights: openWeights,
    ...(structuredOutput !== undefined && {
      structured_output: structuredOutput,
    }),
    ...(knowledge && { knowledge }),
    ...(interleaved !== undefined && { interleaved }),
    ...(status && { status }),
    limit: {
      context: contextLimit,
      ...(contextLimit > outputLimit && { input: contextLimit - outputLimit }),
      output: outputLimit,
    },
    modalities: {
      input: buildInputModalities(metadata),
      output: buildOutputModalities(metadata),
    },
  };

  if (metadata?.pricing) {
    const pricing = metadata.pricing;
    if (
      pricing.input_tokens !== undefined &&
      pricing.output_tokens !== undefined
    ) {
      merged.cost = {
        input: pricing.input_tokens,
        output: pricing.output_tokens,
        ...(pricing.cache_read_tokens !== undefined && {
          cache_read: pricing.cache_read_tokens,
        }),
        ...(pricing.cache_write_tokens !== undefined && {
          cache_write: pricing.cache_write_tokens,
        }),
      };
    }
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
  lines.push(`tool_call = ${model.tool_call}`);
  if (model.structured_output !== undefined) {
    lines.push(`structured_output = ${model.structured_output}`);
  }
  lines.push(`temperature = ${model.temperature}`);
  if (model.knowledge) {
    lines.push(`knowledge = "${model.knowledge}"`);
  }
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
    lines.push(`input = ${formatCost(model.cost.input)}`);
    lines.push(`output = ${formatCost(model.cost.output)}`);
    if (model.cost.cache_read !== undefined) {
      lines.push(`cache_read = ${formatCost(model.cost.cache_read)}`);
    }
    if (model.cost.cache_write !== undefined) {
      lines.push(`cache_write = ${formatCost(model.cost.cache_write)}`);
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
  lines.push(
    `input = [${model.modalities.input.map((m) => `"${m}"`).join(", ")}]`,
  );
  lines.push(
    `output = [${model.modalities.output.map((m) => `"${m}"`).join(", ")}]`,
  );

  return lines.join("\n") + "\n";
}

function detectChanges(
  existing: ExistingModel | null,
  merged: MergedModel,
): Changes[] {
  if (!existing) return [];

  const changes: Changes[] = [];

  const shouldSkipStubbed = (field: string): boolean => {
    return (
      field === StubbedFields.ReleaseDate || field === StubbedFields.LastUpdated
    );
  };

  const formatValue = (val: unknown, isCost = false): string => {
    if (typeof val === "number") {
      return isCost ? formatCost(val) : formatNumber(val);
    }
    if (Array.isArray(val)) return `[${val.join(", ")}]`;
    if (val === undefined) return "(none)";
    return String(val);
  };

  const isMaterialPriceDiff = (
    oldPrice: unknown,
    newPrice: unknown,
  ): boolean => {
    if (oldPrice === 0 && newPrice === undefined) return false;

    if (oldPrice !== undefined && newPrice !== undefined) {
      return (
        (oldPrice as number).toFixed(2) !== (newPrice as number).toFixed(2)
      );
    }

    return oldPrice !== newPrice;
  };

  const compare = (field: string, oldVal: unknown, newVal: unknown) => {
    if (shouldSkipStubbed(field)) return;

    const isDiff = field.startsWith("cost.")
      ? isMaterialPriceDiff(oldVal, newVal)
      : JSON.stringify(oldVal) !== JSON.stringify(newVal);

    if (isDiff) {
      const isCostField = field.startsWith("cost.");
      changes.push({
        field,
        oldValue: formatValue(oldVal, isCostField),
        newValue: formatValue(newVal, isCostField),
      });
    }
  };

  compare("name", existing.name, merged.name);
  compare("family", existing.family, merged.family);
  compare("attachment", existing.attachment, merged.attachment);
  compare("reasoning", existing.reasoning, merged.reasoning);
  compare("tool_call", existing.tool_call, merged.tool_call);
  compare(
    "structured_output",
    existing.structured_output,
    merged.structured_output,
  );
  compare("open_weights", existing.open_weights, merged.open_weights);
  compare("release_date", existing.release_date, merged.release_date);
  compare("last_updated", existing.last_updated, merged.last_updated);
  compare("cost.input", existing.cost?.input, merged.cost?.input);
  compare("cost.output", existing.cost?.output, merged.cost?.output);
  compare(
    "cost.cache_read",
    existing.cost?.cache_read,
    merged.cost?.cache_read,
  );
  compare(
    "cost.cache_write",
    existing.cost?.cache_write,
    merged.cost?.cache_write,
  );
  compare("limit.context", existing.limit?.context, merged.limit.context);
  compare("limit.input", existing.limit?.input, merged.limit.input);
  compare("limit.output", existing.limit?.output, merged.limit.output);
  compare(
    "modalities.input",
    existing.modalities?.input,
    merged.modalities.input,
  );
  compare(
    "modalities.output",
    existing.modalities?.output,
    merged.modalities.output,
  );

  return changes;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const newOnly = args.includes("--new-only");
  const noDelete = args.includes("--no-delete");

  const modelsDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
    "deepinfra",
    "models",
  );

  console.log(
    `${dryRun ? "[DRY RUN] " : ""}${newOnly ? "[NEW ONLY] " : ""}${noDelete ? "[NO DELETE] " : ""}Fetching DeepInfra models from API...`,
  );

  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  const parsed = DeepInfraResponse.safeParse(json);
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
  } catch {}

  console.log(
    `Found ${apiModels.length} models in API, ${existingFiles.size} existing files\n`,
  );

  const apiModelIds = new Set<string>();

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let deleted = 0;
  let needsManualDates = 0;

  console.log("⚠️  WARNING: DeepInfra API returns incomplete metadata:");
  console.log(
    "   - created: 0 (stubbed) - release_date/last_updated need manual setting",
  );
  console.log(
    "   - open_weights, reasoning, attachment are inferred from tags",
  );
  console.log("   - Please verify these fields manually for new models\n");

  for (const apiModel of apiModels) {
    if (shouldSkipModel(apiModel.id)) {
      continue;
    }

    const relativePath = `${apiModel.id}.toml`;
    const filePath = path.join(modelsDir, relativePath);
    const dirPath = path.dirname(filePath);

    apiModelIds.add(relativePath);

    const existing = await loadExistingModel(filePath);
    const merged = mergeModel(apiModel, existing);
    const tomlContent = formatToml(merged);

    if (existing === null) {
      created++;
      if (apiModel.created === 0) {
        needsManualDates++;
      }
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${relativePath}`);
        console.log(`  name = "${merged.name}"`);
        if (merged.family) {
          console.log(`  family = "${merged.family}" (inferred)`);
        }
        if (apiModel.created === 0) {
          console.log(
            `  ⚠️  release_date = "${merged.release_date}" (stubbed - needs manual update)`,
          );
          console.log(
            `  ⚠️  last_updated = "${merged.last_updated}" (stubbed - needs manual update)`,
          );
        }
        console.log("");
      } else {
        await mkdir(dirPath, { recursive: true });
        await Bun.write(filePath, tomlContent);
        console.log(`Created: ${relativePath}`);
        if (apiModel.created === 0) {
          console.log(
            `  ⚠️  Please manually update release_date and last_updated`,
          );
        }
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
          console.log(
            `  ${change.field}: ${change.oldValue} → ${change.newValue}`,
          );
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
      const filePath = path.join(modelsDir, file);

      if (noDelete) {
        console.log(`Warning: Orphaned file (not in API): ${file}`);
      } else if (dryRun) {
        console.log(`[DRY RUN] Would delete: ${file}`);
      } else {
        try {
          await unlink(filePath);
          deleted++;
          console.log(`Deleted: ${file}`);
        } catch (e) {
          console.warn(`Warning: Failed to delete ${file}:`, e);
        }
      }
    }
  }

  console.log("");
  const orphanedInfo =
    noDelete && orphaned.length > 0 ? `, ${orphaned.length} orphaned` : "";
  if (dryRun) {
    console.log(
      `Summary: ${created} would be created (${needsManualDates} with stubbed dates), ${updated} would be updated, ${unchanged} unchanged, ${deleted} would be deleted${orphanedInfo}`,
    );
  } else {
    console.log(
      `Summary: ${created} created (${needsManualDates} with stubbed dates), ${updated} updated, ${unchanged} unchanged, ${deleted} deleted${orphanedInfo}`,
    );
  }

  if (created > 0) {
    console.log("\n⚠️  IMPORTANT: Please manually review new models for:");
    console.log(
      "   - release_date and last_updated (API returns stubbed values)",
    );
    console.log(
      "   - open_weights, reasoning, attachment (inferred from tags, may be inaccurate)",
    );
  }
}

await main();
