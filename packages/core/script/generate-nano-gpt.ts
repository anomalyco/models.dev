#!/usr/bin/env bun

/**
 * Generates NanoGPT model TOML files from NanoGPT's OpenAI-compatible models API.
 *
 * NanoGPT exposes most fields needed by models.dev through /api/v1/models?detailed=true.
 * This script preserves manually curated fields when the API does not provide them,
 * and only warns about orphaned files rather than deleting them automatically.
 */

import { z } from "zod";
import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { ModelFamilyValues } from "../src/family.js";

const API_ENDPOINT =
  process.env.NANO_GPT_MODELS_URL ??
  "https://nano-gpt.com/api/v1/models?detailed=true";

const modelsDir = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "providers",
  "nano-gpt",
  "models",
);

const Pricing = z
  .object({
    prompt: z.number().optional(),
    completion: z.number().optional(),
    currency: z.string().optional(),
    unit: z.string().optional(),
  })
  .passthrough();

const Architecture = z
  .object({
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
  })
  .passthrough();

const Capabilities = z
  .object({
    vision: z.boolean().optional(),
    video_input: z.boolean().optional(),
    audio_input: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tool_calling: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    pdf_upload: z.boolean().optional(),
  })
  .passthrough();

const NanoGptModel = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    created: z.number().optional(),
    context_length: z.number().nullable().optional(),
    max_output_tokens: z.number().nullable().optional(),
    architecture: Architecture.optional(),
    capabilities: Capabilities.optional(),
    pricing: Pricing.optional(),
  })
  .passthrough();

const NanoGptResponse = z
  .object({
    data: z.array(NanoGptModel),
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
    reasoning?: number;
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
  provider?: {
    npm?: string;
    api?: string;
    shape?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
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
  interleaved?: boolean | { field: string };
  status?: string;
  cost?: {
    input: number;
    output: number;
    reasoning?: number;
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
  provider?: ExistingModel["provider"];
}

interface Changes {
  field: string;
  oldValue: string;
  newValue: string;
}

function matchesFamily(target: string, family: string): boolean {
  const targetLower = target.toLowerCase();
  const familyLower = family.toLowerCase();
  return targetLower.includes(familyLower);
}

function inferFamily(modelId: string, modelName: string): string | undefined {
  const sortedFamilies = [...ModelFamilyValues].sort((a, b) => b.length - a.length);

  for (const family of sortedFamilies) {
    if (matchesFamily(modelId, family)) return family;
  }

  for (const family of sortedFamilies) {
    if (matchesFamily(modelName, family)) return family;
  }

  return undefined;
}

function modelFilePath(modelId: string): string {
  return path.join(modelsDir, `${modelId}.toml`);
}

function formatNumber(value: number): string {
  if (value >= 1000) {
    return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return value.toString();
}

function formatBooleanField(name: string, value: boolean | undefined): string[] {
  return value === undefined ? [] : [`${name} = ${value}`];
}

function formatString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function timestampToDate(timestamp: number | undefined): string | undefined {
  if (!timestamp) return undefined;
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeModalities(values: string[] | undefined): string[] {
  const allowed = new Set(["text", "audio", "image", "video", "pdf"]);
  const normalized = (values ?? ["text"]).filter((value) => allowed.has(value));
  return normalized.length > 0 ? Array.from(new Set(normalized)) : ["text"];
}

async function loadExistingModel(filePath: string): Promise<ExistingModel | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    return Bun.TOML.parse(await file.text()) as ExistingModel;
  } catch (error) {
    console.warn(`Warning: Failed to parse existing file ${filePath}:`, error);
    return null;
  }
}

function mergeModel(
  apiModel: z.infer<typeof NanoGptModel>,
  existing: ExistingModel | null,
): MergedModel {
  const capabilities = apiModel.capabilities;
  const inputModalities = normalizeModalities(
    apiModel.architecture?.input_modalities,
  );
  const outputModalities = normalizeModalities(
    apiModel.architecture?.output_modalities,
  );

  if (capabilities?.vision && !inputModalities.includes("image")) {
    inputModalities.push("image");
  }
  if (capabilities?.audio_input && !inputModalities.includes("audio")) {
    inputModalities.push("audio");
  }
  if (capabilities?.video_input && !inputModalities.includes("video")) {
    inputModalities.push("video");
  }
  if (capabilities?.pdf_upload && !inputModalities.includes("pdf")) {
    inputModalities.push("pdf");
  }
  if (existing?.modalities?.input?.includes("pdf") && !inputModalities.includes("pdf")) {
    inputModalities.push("pdf");
  }

  const contextLength =
    apiModel.context_length ??
    existing?.limit?.context ??
    0;
  const outputTokens =
    apiModel.max_output_tokens ??
    existing?.limit?.output ??
    Math.max(1, Math.floor(contextLength / 4));
  const releaseDate =
    existing?.release_date ??
    timestampToDate(apiModel.created) ??
    getTodayDate();

  const merged: MergedModel = {
    name: apiModel.name ?? existing?.name ?? apiModel.id,
    family: existing?.family ?? (existing ? undefined : inferFamily(apiModel.id, apiModel.name ?? "")),
    attachment: inputModalities.some((value) => value !== "text"),
    reasoning: capabilities?.reasoning ?? existing?.reasoning ?? false,
    tool_call: capabilities?.tool_calling ?? existing?.tool_call ?? false,
    release_date: releaseDate,
    last_updated: getTodayDate(),
    open_weights: existing?.open_weights ?? false,
    limit: {
      context: contextLength,
      ...(existing?.limit?.input !== undefined ? { input: existing.limit.input } : {}),
      output: outputTokens,
    },
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
  };

  if (capabilities?.structured_output === true || existing?.structured_output !== undefined) {
    merged.structured_output = capabilities?.structured_output ?? existing?.structured_output;
  }
  if (existing?.temperature !== undefined) {
    merged.temperature = existing.temperature;
  }
  if (existing?.knowledge) {
    merged.knowledge = existing.knowledge;
  }
  if (existing?.interleaved !== undefined) {
    merged.interleaved = existing.interleaved;
  }
  if (existing?.status !== undefined) {
    merged.status = existing.status;
  }
  if (existing?.provider !== undefined) {
    merged.provider = existing.provider;
  }

  if (
    apiModel.pricing?.prompt !== undefined &&
    apiModel.pricing?.completion !== undefined
  ) {
    merged.cost = {
      input: Number(apiModel.pricing.prompt.toFixed(12)),
      output: Number(apiModel.pricing.completion.toFixed(12)),
      ...(existing?.cost?.reasoning !== undefined ? { reasoning: existing.cost.reasoning } : {}),
      ...(existing?.cost?.cache_read !== undefined ? { cache_read: existing.cost.cache_read } : {}),
      ...(existing?.cost?.cache_write !== undefined ? { cache_write: existing.cost.cache_write } : {}),
    };
  } else if (existing?.cost?.input !== undefined && existing?.cost?.output !== undefined) {
    merged.cost = {
      input: existing.cost.input,
      output: existing.cost.output,
      ...(existing.cost.reasoning !== undefined ? { reasoning: existing.cost.reasoning } : {}),
      ...(existing.cost.cache_read !== undefined ? { cache_read: existing.cost.cache_read } : {}),
      ...(existing.cost.cache_write !== undefined ? { cache_write: existing.cost.cache_write } : {}),
    };
  }

  return merged;
}

function formatToml(model: MergedModel): string {
  const lines: string[] = [];

  lines.push(`name = "${formatString(model.name)}"`);
  if (model.family) {
    lines.push(`family = "${model.family}"`);
  }
  lines.push(`attachment = ${model.attachment}`);
  lines.push(`reasoning = ${model.reasoning}`);
  lines.push(`tool_call = ${model.tool_call}`);
  lines.push(...formatBooleanField("structured_output", model.structured_output));
  lines.push(...formatBooleanField("temperature", model.temperature));
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
      lines.push("interleaved = true");
    } else {
      lines.push("[interleaved]");
      lines.push(`field = "${model.interleaved.field}"`);
    }
  }

  if (model.cost) {
    lines.push("");
    lines.push("[cost]");
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
  }

  lines.push("");
  lines.push("[limit]");
  lines.push(`context = ${formatNumber(model.limit.context)}`);
  if (model.limit.input !== undefined) {
    lines.push(`input = ${formatNumber(model.limit.input)}`);
  }
  lines.push(`output = ${formatNumber(model.limit.output)}`);

  lines.push("");
  lines.push("[modalities]");
  lines.push(`input = [${model.modalities.input.map((m) => `"${m}"`).join(", ")}]`);
  lines.push(`output = [${model.modalities.output.map((m) => `"${m}"`).join(", ")}]`);

  if (model.provider) {
    lines.push("");
    lines.push("[provider]");
    if (model.provider.npm) lines.push(`npm = "${formatString(model.provider.npm)}"`);
    if (model.provider.api) lines.push(`api = "${formatString(model.provider.api)}"`);
    if (model.provider.shape) lines.push(`shape = "${formatString(model.provider.shape)}"`);
  }

  return lines.join("\n") + "\n";
}

function formatValue(value: unknown): string {
  if (typeof value === "number") return formatNumber(value);
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (value === undefined) return "(none)";
  return String(value);
}

function detectChanges(existing: ExistingModel | null, merged: MergedModel): Changes[] {
  if (!existing) return [];

  const changes: Changes[] = [];
  const compare = (field: string, oldValue: unknown, newValue: unknown) => {
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
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
  compare("open_weights", existing.open_weights, merged.open_weights);
  compare("release_date", existing.release_date, merged.release_date);
  compare("cost.input", existing.cost?.input, merged.cost?.input);
  compare("cost.output", existing.cost?.output, merged.cost?.output);
  compare("limit.context", existing.limit?.context, merged.limit.context);
  compare("limit.output", existing.limit?.output, merged.limit.output);
  compare("modalities.input", existing.modalities?.input, merged.modalities.input);
  compare("modalities.output", existing.modalities?.output, merged.modalities.output);

  return changes;
}

async function listExistingTomlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.name.endsWith(".toml")) {
        files.push(path.relative(dir, entryPath));
      }
    }
  }

  await walk(dir);
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const newOnly = args.includes("--new-only");

  console.log(
    `${dryRun ? "[DRY RUN] " : ""}Fetching NanoGPT models from ${API_ENDPOINT}...`,
  );

  const response = await fetch(API_ENDPOINT);
  if (!response.ok) {
    console.error(`Failed to fetch NanoGPT models: ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const parsed = NanoGptResponse.safeParse(await response.json());
  if (!parsed.success) {
    console.error("Invalid NanoGPT models response:", parsed.error.errors);
    process.exit(1);
  }

  await mkdir(modelsDir, { recursive: true });

  const apiModels = parsed.data.data;
  const existingFiles = new Set(await listExistingTomlFiles(modelsDir));
  const apiFiles = new Set<string>();

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const apiModel of apiModels) {
    const relativeFile = `${apiModel.id}.toml`;
    const filePath = modelFilePath(apiModel.id);
    apiFiles.add(relativeFile);

    const existing = await loadExistingModel(filePath);
    const merged = mergeModel(apiModel, existing);
    const changes = detectChanges(existing, merged);

    if (!existing) {
      created++;
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${relativeFile}`);
      } else {
        await mkdir(path.dirname(filePath), { recursive: true });
        await Bun.write(filePath, formatToml(merged));
        console.log(`Created: ${relativeFile}`);
      }
      continue;
    }

    if (newOnly) {
      skipped++;
      continue;
    }

    if (changes.length === 0) {
      unchanged++;
      continue;
    }

    updated++;
    if (dryRun) {
      console.log(`[DRY RUN] Would update: ${relativeFile}`);
    } else {
      await Bun.write(filePath, formatToml(merged));
      console.log(`Updated: ${relativeFile}`);
    }
    for (const change of changes) {
      console.log(`  ${change.field}: ${change.oldValue} -> ${change.newValue}`);
    }
    console.log("");
  }

  const orphaned = [...existingFiles]
    .filter((file) => !apiFiles.has(file))
    .sort((a, b) => a.localeCompare(b));

  for (const file of orphaned) {
    console.log(`Warning: Orphaned file (not in API): ${file}`);
  }

  console.log("");
  console.log(
    `Summary: ${created}${dryRun ? " would be created" : " created"}, ` +
      `${updated}${dryRun ? " would be updated" : " updated"}, ` +
      `${unchanged} unchanged, ${skipped} skipped, ${orphaned.length} orphaned`,
  );
}

await main();
