#!/usr/bin/env bun

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { ModelFamilyValues } from "../src/family.js";

const API_ENDPOINT = "https://trace.wandb.ai/inference/analysis/artificialanalysis/models";

const Pricing = z
  .object({
    prompt: z.string().optional(),
    completion: z.string().optional(),
    image: z.string().optional(),
    request: z.string().optional(),
    input_cache_reads: z.string().optional(),
    input_cache_writes: z.string().optional(),
  })
  .passthrough();

const WandbModel = z
  .object({
    id: z.string(),
    name: z.string(),
    created: z.number(),
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
    context_length: z.number(),
    max_output_length: z.number(),
    pricing: Pricing.optional(),
    supported_sampling_parameters: z.array(z.string()).default([]),
    supported_features: z.array(z.string()).default([]),
  })
  .passthrough();

const WandbResponse = z
  .object({
    data: z.array(WandbModel),
  })
  .strict();

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
    output: number;
  };
  modalities: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">;
    output: Array<"text" | "audio" | "image" | "video" | "pdf">;
  };
}

interface Changes {
  field: string;
  oldValue: string;
  newValue: string;
}

type SupportedModality = "text" | "audio" | "image" | "video" | "pdf";

const modalityMap: Record<string, SupportedModality | undefined> = {
  text: "text",
  image: "image",
  audio: "audio",
  video: "video",
  pdf: "pdf",
  file: "pdf",
  files: "pdf",
};

const openWeightsPrefixes = new Set([
  "deepseek-ai/",
  "meta-llama/",
  "microsoft/",
  "MiniMaxAI/",
  "moonshotai/",
  "nvidia/",
  "OpenPipe/",
  "Qwen/",
  "zai-org/",
]);

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

function formatDecimal(n: number): string {
  return Number(n.toFixed(6)).toString();
}

function priceToPerMillion(value: string): number {
  return Number((parseFloat(value) * 1_000_000).toFixed(6));
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
    if (isSubstring(modelId, family) || isSubstring(modelName, family)) {
      return family;
    }
  }

  for (const family of sortedFamilies) {
    if (matchesFamily(modelId, family) || matchesFamily(modelName, family)) {
      return family;
    }
  }

  return undefined;
}

function normalizeName(apiModel: z.infer<typeof WandbModel>): string {
  const stripped = apiModel.name.replace(/^[^:]+:\s*/, "").trim();
  return stripped || path.basename(apiModel.id);
}

function inferReasoning(apiModel: z.infer<typeof WandbModel>): boolean {
  const text = `${apiModel.id} ${apiModel.name}`.toLowerCase();
  return text.includes("thinking") || /\br1\b/.test(text) || text.includes("reasoning");
}

function inferOpenWeights(modelId: string): boolean {
  for (const prefix of openWeightsPrefixes) {
    if (modelId.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function normalizeModalities(values: string[]): SupportedModality[] {
  const normalized = values
    .map((value) => modalityMap[value.toLowerCase()])
    .filter((value): value is SupportedModality => value !== undefined);

  return [...new Set(normalized)];
}

async function loadExistingModel(filePath: string): Promise<ExistingModel | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return null;
    }

    const toml = await import(filePath, { with: { type: "toml" } }).then((mod) => mod.default);
    return toml as ExistingModel;
  } catch (cause) {
    console.warn(`Warning: Failed to parse existing file ${filePath}:`, cause);
    return null;
  }
}

function mergeModel(
  apiModel: z.infer<typeof WandbModel>,
  existing: ExistingModel | null,
): MergedModel {
  const featureSet = new Set(apiModel.supported_features);
  const samplingSet = new Set(apiModel.supported_sampling_parameters);
  const inputModalities = normalizeModalities(apiModel.input_modalities);
  const outputModalities = normalizeModalities(apiModel.output_modalities);

  const merged: MergedModel = {
    name: existing?.name ?? normalizeName(apiModel),
    family: existing?.family ?? inferFamily(apiModel.id, apiModel.name),
    attachment: existing?.attachment ?? inputModalities.some((m) => m !== "text"),
    reasoning: existing?.reasoning ?? inferReasoning(apiModel),
    tool_call: existing?.tool_call ?? featureSet.has("tools"),
    temperature: existing?.temperature ?? samplingSet.has("temperature"),
    release_date: existing?.release_date ?? timestampToDate(apiModel.created),
    last_updated: getTodayDate(),
    open_weights: existing?.open_weights ?? inferOpenWeights(apiModel.id),
    ...(existing?.structured_output !== undefined
      ? { structured_output: existing.structured_output }
      : featureSet.has("structured_outputs")
        ? { structured_output: true }
        : {}),
    ...(existing?.knowledge ? { knowledge: existing.knowledge } : {}),
    ...(existing?.interleaved !== undefined ? { interleaved: existing.interleaved } : {}),
    ...(existing?.status ? { status: existing.status } : {}),
    limit: {
      context: apiModel.context_length > 0 ? apiModel.context_length : (existing?.limit?.context ?? 0),
      output: apiModel.max_output_length > 0
        ? apiModel.max_output_length
        : (existing?.limit?.output ?? 0),
    },
    modalities: {
      input: inputModalities.length > 0
        ? inputModalities
        : ((existing?.modalities?.input as SupportedModality[] | undefined) ?? ["text"]),
      output: outputModalities.length > 0
        ? outputModalities
        : ((existing?.modalities?.output as SupportedModality[] | undefined) ?? ["text"]),
    },
  };

  const prompt = apiModel.pricing?.prompt;
  const completion = apiModel.pricing?.completion;
  const cacheRead = apiModel.pricing?.input_cache_reads;
  const cacheWrite = apiModel.pricing?.input_cache_writes;

  if (prompt && completion) {
    merged.cost = {
      input: priceToPerMillion(prompt),
      output: priceToPerMillion(completion),
      ...(cacheRead && parseFloat(cacheRead) > 0
        ? { cache_read: priceToPerMillion(cacheRead) }
        : {}),
      ...(cacheWrite && parseFloat(cacheWrite) > 0
        ? { cache_write: priceToPerMillion(cacheWrite) }
        : {}),
    };
  } else if (existing?.cost?.input !== undefined && existing.cost.output !== undefined) {
    merged.cost = {
      input: existing.cost.input,
      output: existing.cost.output,
      ...(existing.cost.cache_read !== undefined ? { cache_read: existing.cost.cache_read } : {}),
      ...(existing.cost.cache_write !== undefined ? { cache_write: existing.cost.cache_write } : {}),
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
  if (model.structured_output !== undefined) {
    lines.push(`structured_output = ${model.structured_output}`);
  }
  lines.push(`temperature = ${model.temperature}`);
  lines.push(`tool_call = ${model.tool_call}`);
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
      lines.push("interleaved = true");
    } else {
      lines.push("[interleaved]");
      lines.push(`field = "${model.interleaved.field}"`);
    }
  }

  if (model.cost) {
    lines.push("");
    lines.push("[cost]");
    lines.push(`input = ${formatDecimal(model.cost.input)}`);
    lines.push(`output = ${formatDecimal(model.cost.output)}`);
    if (model.cost.cache_read !== undefined) {
      lines.push(`cache_read = ${formatDecimal(model.cost.cache_read)}`);
    }
    if (model.cost.cache_write !== undefined) {
      lines.push(`cache_write = ${formatDecimal(model.cost.cache_write)}`);
    }
  }

  lines.push("");
  lines.push("[limit]");
  lines.push(`context = ${formatNumber(model.limit.context)}`);
  lines.push(`output = ${formatNumber(model.limit.output)}`);

  lines.push("");
  lines.push("[modalities]");
  lines.push(`input = [${model.modalities.input.map((m) => `"${m}"`).join(", ")}]`);
  lines.push(`output = [${model.modalities.output.map((m) => `"${m}"`).join(", ")}]`);

  return `${lines.join("\n")}\n`;
}

function detectChanges(existing: ExistingModel | null, merged: MergedModel): Changes[] {
  if (!existing) {
    return [];
  }

  const changes: Changes[] = [];
  const epsilon = 0.001;

  const formatValue = (value: unknown): string => {
    if (typeof value === "number") return formatNumber(value);
    if (Array.isArray(value)) return `[${value.join(", ")}]`;
    if (value === undefined) return "(none)";
    return String(value);
  };

  const compare = (field: string, oldValue: unknown, newValue: unknown) => {
    const changed = field.startsWith("cost.")
      ? (
          oldValue === undefined && newValue === undefined
            ? false
            : oldValue === undefined || newValue === undefined
              ? true
              : Math.abs((oldValue as number) - (newValue as number)) > epsilon
        )
      : JSON.stringify(oldValue) !== JSON.stringify(newValue);

    if (changed) {
      changes.push({
        field,
        oldValue: formatValue(oldValue),
        newValue: formatValue(newValue),
      });
    }
  };

  compare("name", existing.name, merged.name);
  compare("family", existing.family, merged.family);
  compare("release_date", existing.release_date, merged.release_date);
  compare("attachment", existing.attachment, merged.attachment);
  compare("reasoning", existing.reasoning, merged.reasoning);
  compare("structured_output", existing.structured_output, merged.structured_output);
  compare("temperature", existing.temperature, merged.temperature);
  compare("tool_call", existing.tool_call, merged.tool_call);
  compare("open_weights", existing.open_weights, merged.open_weights);
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

  const modelsDir = path.join(import.meta.dirname, "..", "..", "..", "providers", "wandb", "models");

  console.log(`${dryRun ? "[DRY RUN] " : ""}${newOnly ? "[NEW ONLY] " : ""}Fetching WandB models from API...`);

  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  const parsed = WandbResponse.safeParse(json);
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  const apiModels = parsed.data.data;
  const existingFiles = new Set<string>();

  for await (const file of new Bun.Glob("**/*.toml").scan({ cwd: modelsDir, absolute: false })) {
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
        console.log(`  name = "${merged.name}"`);
        if (merged.family) {
          console.log(`  family = "${merged.family}"`);
        }
        console.log("");
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

  const orphaned = [...existingFiles].filter((file) => !apiModelIds.has(file));
  for (const file of orphaned) {
    console.log(`Warning: Orphaned file (not in API): ${file}`);
  }

  console.log("");
  console.log(
    dryRun
      ? `Summary: ${created} would be created, ${updated} would be updated, ${unchanged} unchanged, ${orphaned.length} orphaned`
      : `Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphaned.length} orphaned`,
  );
}

await main();
