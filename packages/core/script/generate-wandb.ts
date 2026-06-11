#!/usr/bin/env bun

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { inferKimiFamily, ModelFamilyValues } from "../src/family.js";

// This endpoint already returns data in the models.dev schema, so most fields
// map straight through. Only fields the catalog can't provide (family) are
// inferred, and manually-curated fields in existing TOMLs are preserved.
//const API_ENDPOINT = "https://trace.wandb.ai/inference/modelsdev/models";
const API_ENDPOINT = "http://localhost:8080/traces/inference/modelsdev/models";

const ApiCost = z
  .object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    input_audio: z.number().optional(),
    output_audio: z.number().optional(),
  })
  .passthrough();

const ApiLimit = z
  .object({
    context: z.number(),
    input: z.number(),
    output: z.number(),
  })
  .passthrough();

const ApiModalities = z
  .object({
    input: z.array(z.string()),
    output: z.array(z.string()),
  })
  .passthrough();

const ApiModel = z
  .object({
    id: z.string(),
    name: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    tool_call: z.boolean(),
    structured_output: z.boolean().optional(),
    temperature: z.boolean().optional(),
    knowledge: z.string().optional(),
    release_date: z.string(),
    last_updated: z.string(),
    open_weights: z.boolean(),
    status: z.string().optional(),
    interleaved: z
      .union([z.boolean(), z.object({ field: z.string() })])
      .optional(),
    cost: ApiCost.optional(),
    limit: ApiLimit.optional(),
    modalities: ApiModalities.optional(),
  })
  .passthrough();

const ApiProvider = z
  .object({
    id: z.string(),
    name: z.string(),
    npm: z.string(),
    env: z.array(z.string()),
    doc: z.string(),
    api: z.string().optional(),
    models: z.record(z.string(), ApiModel),
  })
  .passthrough();

// The models.dev `api.json` shape: a mapping of provider id -> provider.
const ApiResponse = z.record(z.string(), ApiProvider);

interface ExistingModel {
  base_model?: string;
  base_model_omit?: string[];
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
  base_model?: string;
  base_model_omit?: string[];
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
    input: SupportedModality[];
    output: SupportedModality[];
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

function inferFamily(modelId: string, modelName: string): string | undefined {
  const kimiFamily = inferKimiFamily(modelId, modelName);
  if (kimiFamily !== undefined) return kimiFamily;

  const sortedFamilies = [...ModelFamilyValues].sort(
    (a, b) => b.length - a.length,
  );

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

function normalizeName(apiModel: z.infer<typeof ApiModel>): string {
  const stripped = apiModel.name.replace(/^[^:]+:\s*/, "").trim();
  return stripped || path.basename(apiModel.id);
}

function normalizeModalities(values: string[]): SupportedModality[] {
  const normalized = values
    .map((value) => modalityMap[value.toLowerCase()])
    .filter((value): value is SupportedModality => value !== undefined);

  return [...new Set(normalized)];
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
  } catch (cause) {
    console.warn(`Warning: Failed to parse existing file ${filePath}:`, cause);
    return null;
  }
}

function mergeModel(
  apiModel: z.infer<typeof ApiModel>,
  existing: ExistingModel | null,
): MergedModel {
  const inputModalities = normalizeModalities(apiModel.modalities?.input ?? []);
  const outputModalities = normalizeModalities(
    apiModel.modalities?.output ?? [],
  );

  const merged: MergedModel = {
    ...(existing?.base_model ? { base_model: existing.base_model } : {}),
    ...(existing?.base_model_omit
      ? { base_model_omit: existing.base_model_omit }
      : {}),
    name: existing?.name ?? normalizeName(apiModel),
    family: existing?.family ?? inferFamily(apiModel.id, apiModel.name),
    attachment: existing?.attachment ?? apiModel.attachment,
    reasoning: existing?.reasoning ?? apiModel.reasoning,
    tool_call: existing?.tool_call ?? apiModel.tool_call,
    temperature: existing?.temperature ?? apiModel.temperature ?? true,
    release_date: existing?.release_date ?? apiModel.release_date,
    last_updated: getTodayDate(),
    open_weights: existing?.open_weights ?? apiModel.open_weights,
    ...(existing?.structured_output !== undefined
      ? { structured_output: existing.structured_output }
      : apiModel.structured_output
        ? { structured_output: true }
        : {}),
    ...((existing?.knowledge ?? apiModel.knowledge)
      ? { knowledge: existing?.knowledge ?? apiModel.knowledge }
      : {}),
    ...((existing?.interleaved ?? apiModel.interleaved)
      ? { interleaved: existing?.interleaved ?? apiModel.interleaved }
      : {}),
    ...((existing?.status ?? apiModel.status)
      ? { status: existing?.status ?? apiModel.status }
      : {}),
    limit: {
      context: apiModel.limit?.context ?? existing?.limit?.context ?? 0,
      output: apiModel.limit?.output ?? existing?.limit?.output ?? 0,
    },
    modalities: {
      input:
        inputModalities.length > 0
          ? inputModalities
          : ((existing?.modalities?.input as
              | SupportedModality[]
              | undefined) ?? ["text"]),
      output:
        outputModalities.length > 0
          ? outputModalities
          : ((existing?.modalities?.output as
              | SupportedModality[]
              | undefined) ?? ["text"]),
    },
  };

  if (apiModel.cost) {
    merged.cost = {
      input: apiModel.cost.input,
      output: apiModel.cost.output,
      ...(apiModel.cost.cache_read && apiModel.cost.cache_read > 0
        ? { cache_read: apiModel.cost.cache_read }
        : {}),
      ...(apiModel.cost.cache_write && apiModel.cost.cache_write > 0
        ? { cache_write: apiModel.cost.cache_write }
        : {}),
    };
  } else if (
    existing?.cost?.input !== undefined &&
    existing.cost.output !== undefined
  ) {
    merged.cost = {
      input: existing.cost.input,
      output: existing.cost.output,
      ...(existing.cost.cache_read !== undefined
        ? { cache_read: existing.cost.cache_read }
        : {}),
      ...(existing.cost.cache_write !== undefined
        ? { cache_write: existing.cost.cache_write }
        : {}),
    };
  }

  return merged;
}

function formatToml(model: MergedModel): string {
  const lines: string[] = [];

  if (model.base_model !== undefined) {
    lines.push(`base_model = "${model.base_model}"`);
  }
  if (model.base_model_omit !== undefined) {
    lines.push(
      `base_model_omit = [${model.base_model_omit.map((item) => `"${item}"`).join(", ")}]`,
    );
  }
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
    } else if (model.interleaved !== false) {
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
  lines.push(
    `input = [${model.modalities.input.map((m) => `"${m}"`).join(", ")}]`,
  );
  lines.push(
    `output = [${model.modalities.output.map((m) => `"${m}"`).join(", ")}]`,
  );

  return `${lines.join("\n")}\n`;
}

function detectChanges(
  existing: ExistingModel | null,
  merged: MergedModel,
): Changes[] {
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
      ? oldValue === undefined && newValue === undefined
        ? false
        : oldValue === undefined || newValue === undefined
          ? true
          : Math.abs((oldValue as number) - (newValue as number)) > epsilon
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
  compare(
    "structured_output",
    existing.structured_output,
    merged.structured_output,
  );
  compare("temperature", existing.temperature, merged.temperature);
  compare("tool_call", existing.tool_call, merged.tool_call);
  compare("open_weights", existing.open_weights, merged.open_weights);
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

  const modelsDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
    "wandb",
    "models",
  );

  console.log(
    `${dryRun ? "[DRY RUN] " : ""}${newOnly ? "[NEW ONLY] " : ""}Fetching WandB models from API...`,
  );

  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  const parsed = ApiResponse.safeParse(json);
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  // The response groups models by provider; flatten to a single list.
  const apiModels = Object.values(parsed.data).flatMap((provider) =>
    Object.values(provider.models),
  );
  const existingFiles = new Set<string>();

  for await (const file of new Bun.Glob("**/*.toml").scan({
    cwd: modelsDir,
    absolute: false,
  })) {
    existingFiles.add(file);
  }

  console.log(
    `Found ${apiModels.length} models in API, ${existingFiles.size} existing files\n`,
  );

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
