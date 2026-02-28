#!/usr/bin/env bun

import { z } from "zod";
import path from "node:path";
import { readdir } from "node:fs/promises";
import * as readline from "node:readline";
import { ModelFamilyValues } from "../src/family.js";

// Venice API endpoint
const API_ENDPOINT = "https://api.venice.ai/api/v1/models?type=text";

async function promptForApiKey(): Promise<string | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      "Enter Venice API key to include alpha models (or press Enter to skip): ",
      (answer) => {
        rl.close();
        const trimmed = answer.trim();
        resolve(trimmed.length > 0 ? trimmed : null);
      },
    );
  });
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
    // Format with underscores for readability (e.g., 131_072)
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
    context_over_200k?: {
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
    };
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
    context_over_200k?: {
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
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
  const proposedOutputTokens = Math.floor(contextTokens / 4);
  const outputTokens =
    existing?.limit?.output !== undefined && existing.limit.output < proposedOutputTokens
      ? existing.limit.output
      : proposedOutputTokens

  const openWeights = spec.modelSource
    ? spec.modelSource.toLowerCase().includes("huggingface")
    : spec.privacy === "private";

  const inputModalities = buildInputModalities(caps);

  if (existing?.modalities?.input?.includes("pdf") && !inputModalities.includes("pdf")) {
    inputModalities.push("pdf");
  }

  const attachment =
    caps.supportsVision === true ||
    caps.supportsAudioInput === true ||
    caps.supportsVideoInput === true;

  const merged: MergedModel = {
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

  // structured_output only if true
  if (caps.supportsResponseSchema === true) {
    merged.structured_output = true;
  }

  // Cost from API
  if (spec.pricing) {
    merged.cost = {
      input: spec.pricing.input.usd,
      output: spec.pricing.output.usd,
      ...(spec.pricing.cache_input && { cache_read: spec.pricing.cache_input.usd }),
      ...(spec.pricing.cache_write && { cache_write: spec.pricing.cache_write.usd }),
    };

    // Extended pricing maps to context_over_200k
    if (spec.pricing.extended) {
      merged.cost.context_over_200k = {
        input: spec.pricing.extended.input.usd,
        output: spec.pricing.extended.output.usd,
        ...(spec.pricing.extended.cache_input && { cache_read: spec.pricing.extended.cache_input.usd }),
        ...(spec.pricing.extended.cache_write && { cache_write: spec.pricing.extended.cache_write.usd }),
      };
    }
  }

  const inferred = inferFamily(apiModel.id, spec.name);
  merged.family = inferred ?? existing?.family;

  // Preserve manual fields from existing
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

  // Basic fields
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

  // Interleaved section (if present)
  if (model.interleaved !== undefined) {
    lines.push("");
    if (model.interleaved === true) {
      lines.push(`interleaved = true`);
    } else if (typeof model.interleaved === "object") {
      lines.push(`[interleaved]`);
      lines.push(`field = "${model.interleaved.field}"`);
    }
  }

  // Cost section
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

    if (model.cost.context_over_200k) {
      lines.push("");
      lines.push(`[cost.context_over_200k]`);
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

  // Limit section
  lines.push("");
  lines.push(`[limit]`);
  lines.push(`context = ${formatNumber(model.limit.context)}`);
  lines.push(`output = ${formatNumber(model.limit.output)}`);

  // Modalities section
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
    if (Array.isArray(val)) return `[${val.join(", ")}]`;
    if (val === undefined) return "(none)";
    return String(val);
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
  compare("cost.context_over_200k.input", existing.cost?.context_over_200k?.input, merged.cost?.context_over_200k?.input);
  compare("cost.context_over_200k.output", existing.cost?.context_over_200k?.output, merged.cost?.context_over_200k?.output);
  compare("cost.context_over_200k.cache_read", existing.cost?.context_over_200k?.cache_read, merged.cost?.context_over_200k?.cache_read);
  compare("cost.context_over_200k.cache_write", existing.cost?.context_over_200k?.cache_write, merged.cost?.context_over_200k?.cache_write);
  compare("limit.context", existing.limit?.context, merged.limit.context);
  compare("limit.output", existing.limit?.output, merged.limit.output);
  compare("modalities.input", existing.modalities?.input, merged.modalities.input);

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

  // Check for API key from CLI argument, environment, or prompt
  let apiKey: string | null = null;

  // Check CLI args for --api-key=xxx or --api-key xxx
  const apiKeyArgIndex = args.findIndex((arg) => arg.startsWith("--api-key"));
  if (apiKeyArgIndex !== -1) {
    const arg = args[apiKeyArgIndex];
    if (arg.includes("=")) {
      apiKey = arg.split("=")[1];
    } else if (args[apiKeyArgIndex + 1]) {
      apiKey = args[apiKeyArgIndex + 1];
    }
  }

  // Fall back to environment variable
  if (!apiKey) {
    apiKey = process.env.VENICE_API_KEY ?? null;
  }

  // Prompt if still no key
  if (!apiKey) {
    apiKey = await promptForApiKey();
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

  // Fetch API data
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

  // Get existing files
  const existingFiles = new Set<string>();
  try {
    const files = await readdir(modelsDir);
    for (const file of files) {
      if (file.endsWith(".toml")) {
        existingFiles.add(file);
      }
    }
  } catch {
    // Directory might not exist yet
  }

  console.log(`Found ${apiModels.length} models in API, ${existingFiles.size} existing files\n`);

  // Track API model IDs for orphan detection
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
      // New file
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
      // Check for changes
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

  // Check for orphaned files
  const orphaned: string[] = [];
  for (const file of existingFiles) {
    if (!apiModelIds.has(file)) {
      orphaned.push(file);
      console.log(`Warning: Orphaned file (not in API): ${file}`);
    }
  }

  // Summary
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
