#!/usr/bin/env bun

/**
 * Generates DigitalOcean model TOML files from two public APIs:
 *
 *   - https://api.digitalocean.com/v2/gen-ai/models   (model metadata, lifecycle, modalities, limits)
 *   - https://www.digitalocean.com/api/static-content/v1/products  (pricing, including >200k tiers)
 *
 * The v2 models API requires a DigitalOcean personal access token or model access key,
 * read from the DIGITALOCEAN_API_TOKEN environment variable (or --api-key flag).
 * The static-content pricing API is public and requires no auth.
 *
 * Cache pricing (cache_read, cache_write) is NOT available from any DO API and is
 * preserved from existing TOML files when present.
 *
 * Fields the APIs cannot provide (preserved from existing TOMLs, never overwritten):
 *   family, knowledge, open_weights, interleaved, attachment, release_date,
 *   cache_read, cache_write
 *
 * Flags:
 *   --dry-run   Preview changes without writing files
 *   --new-only  Only create new models, skip updating existing ones
 *   --api-key=<key>  DigitalOcean API key (overrides DIGITALOCEAN_API_TOKEN env var)
 */

import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { ModelFamilyValues } from "../src/family.js";

const MODELS_API = "https://api.digitalocean.com/v2/gen-ai/models";
const PRICING_API = "https://www.digitalocean.com/api/static-content/v1/products";

// ---------------------------------------------------------------------------
// v2 models API schema
// ---------------------------------------------------------------------------

const DoModel = z
  .object({
    id: z.string(),
    name: z.string(),
    lifecycle_status: z.string(),
    type: z.string().optional(),
    thinking: z.boolean().optional(),
    context_window: z.union([z.number(), z.string()]).optional(),
    modalities: z
      .object({
        input: z.array(z.string()).optional(),
        output: z.array(z.string()).optional(),
      })
      .optional(),
    settings: z
      .array(
        z.object({
          name: z.string(),
          max: z.number().optional(),
          default_value: z.number().optional(),
        }),
      )
      .optional(),
    created_at: z.string().optional(),
  })
  .passthrough();

const DoModelsResponse = z
  .object({
    models: z.array(DoModel),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// static-content pricing API schema
// ---------------------------------------------------------------------------

const PricingEntry = z
  .object({
    name: z.string(),
    slug: z.string(),
    model: z.string(),
    prompt_tokens: z.string().optional(), // "≤200k" | ">200k" | undefined
    price: z.object({ rate: z.number() }),
  })
  .passthrough();

const StaticContentResponse = z
  .object({
    gradient: z.object({
      models: z.array(PricingEntry),
    }),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Derived pricing map
// ---------------------------------------------------------------------------

interface ModelPricing {
  input: number;
  output: number;
  inputOver200k?: number;
  outputOver200k?: number;
}

// Map marketing names from /v1/products to API model IDs from /v2/gen-ai/models.
// The pricing API uses display names, not the machine IDs, so this table is the
// join key. Add entries here when DO adds new models with tiered pricing.
const PRICING_NAME_MAP: Record<string, string> = {
  // Anthropic
  "claude sonnet 4.6": "anthropic-claude-4.6-sonnet",
  "claude sonnet 4.5": "anthropic-claude-4.5-sonnet",
  "claude sonnet 4": "anthropic-claude-sonnet-4",
  "claude haiku 4.5": "anthropic-claude-haiku-4.5",
  "claude opus 4.6": "anthropic-claude-opus-4.6",
  "claude opus 4.5": "anthropic-claude-opus-4.5",
  "claude opus 4.1": "anthropic-claude-4.1-opus",
  "claude opus 4": "anthropic-claude-opus-4",
  // OpenAI
  "gpt-5.4": "openai-gpt-5.4",
  "gpt-5.4 mini": "openai-gpt-5.4-mini",
  "gpt-5.4 nano": "openai-gpt-5.4-nano",
  "gpt-5.4 pro": "openai-gpt-5.4-pro",
  "gpt-5.3-codex": "openai-gpt-5.3-codex",
  "gpt-5.2": "openai-gpt-5.2",
  "gpt-5.2 pro": "openai-gpt-5.2-pro",
  "gpt-5.1-codex-max": "openai-gpt-5.1-codex-max",
  "gpt-5": "openai-gpt-5",
  "gpt-5 mini": "openai-gpt-5-mini",
  "gpt-5 nano": "openai-gpt-5-nano",
  "gpt-4.1": "openai-gpt-4.1",
  "gpt image 1": "openai-gpt-image-1",
  "gpt image 1.5": "openai-gpt-image-1.5",
  "gpt-oss-120b": "openai-gpt-oss-120b",
  "gpt-oss-20b": "openai-gpt-oss-20b",
  "gpt-4o": "openai-gpt-4o",
  "gpt-4o mini": "openai-gpt-4o-mini",
  "o1": "openai-o1",
  "o3-mini": "openai-o3-mini",
  // DeepSeek
  "deepseek r1 distill llama 70b": "deepseek-r1-distill-llama-70b",
  // Llama
  "llama 3.3 70b": "llama3.3-70b-instruct",
  // DO-hosted
  "qwen3-32b": "alibaba-qwen3-32b",
  "minimax m2.5 (public preview)": "minimax-m2.5",
  "kimi k2.5": "kimi-k2.5",
  "nvidia nemotron 3 super 120b (public preview)": "nvidia-nemotron-3-super-120b",
  "glm 5": "glm-5",
};

function normalizeDisplayName(raw: string): string {
  // Strip " Input Tokens" / " Output Tokens" suffix and lowercase
  return raw
    .replace(/\s+(input|output)\s+tokens$/i, "")
    .trim()
    .toLowerCase();
}

function buildPricingMap(entries: z.infer<typeof PricingEntry>[]): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();

  for (const entry of entries) {
    const displayName = normalizeDisplayName(entry.name);
    const modelId = PRICING_NAME_MAP[displayName];
    if (!modelId) continue;

    const isInput = entry.name.toLowerCase().includes("input tokens");
    const isOver200k = entry.prompt_tokens === ">200k";
    // Round to avoid float noise (e.g. 0.9900000000000001)
    const rate = Math.round(entry.price.rate * 10000) / 10000;

    const existing = map.get(modelId) ?? ({} as ModelPricing);

    if (isInput && isOver200k) existing.inputOver200k = rate;
    else if (!isInput && isOver200k) existing.outputOver200k = rate;
    else if (isInput) existing.input = rate;
    else existing.output = rate;

    map.set(modelId, existing);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Existing TOML shape (fields we read and may preserve)
// ---------------------------------------------------------------------------

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
}

async function loadExisting(filePath: string): Promise<ExistingModel | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  try {
    const mod = await import(filePath, { with: { type: "toml" } });
    return mod.default as ExistingModel;
  } catch (e) {
    console.warn(`Warning: failed to parse ${filePath}:`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Merged model shape (what we write)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_INPUT_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);
const VALID_OUTPUT_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);

function filterInputModalities(raw: string[]): string[] {
  return raw.filter((m) => VALID_INPUT_MODALITIES.has(m));
}

function filterOutputModalities(raw: string[]): string[] {
  // "code" is not a valid modality in the schema — map to "text"
  return [...new Set(raw.map((m) => (m === "code" ? "text" : m)).filter((m) => VALID_OUTPUT_MODALITIES.has(m)))];
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatNumber(n: number): string {
  return n >= 1000 ? n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_") : n.toString();
}

function inferFamily(modelId: string, modelName: string): string | undefined {
  const sorted = [...ModelFamilyValues].sort((a, b) => b.length - a.length);
  const targets = [modelId.toLowerCase(), modelName.toLowerCase()];
  for (const family of sorted) {
    const f = family.toLowerCase();
    for (const t of targets) {
      if (t.includes(f)) return family;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Merge API data with existing TOML
// ---------------------------------------------------------------------------

function mergeModel(
  apiModel: z.infer<typeof DoModel>,
  pricing: ModelPricing | undefined,
  existing: ExistingModel | null,
): MergedModel {
  const rawInput = apiModel.modalities?.input ?? [];
  const rawOutput = apiModel.modalities?.output ?? [];
  const inputMods = filterInputModalities(rawInput.length > 0 ? rawInput : existing?.modalities?.input ?? ["text"]);
  const outputMods = filterOutputModalities(rawOutput.length > 0 ? rawOutput : existing?.modalities?.output ?? ["text"]);

  const maxTokensSetting = apiModel.settings?.find((s) => s.name === "max_tokens");
  const maxTokens = maxTokensSetting?.max ?? existing?.limit?.output ?? 0;

  const rawContext = apiModel.context_window;
  const contextWindow =
    rawContext !== undefined
      ? typeof rawContext === "string"
        ? parseInt(rawContext, 10)
        : rawContext
      : (existing?.limit?.context ?? 0);

  const isDeprecated = apiModel.lifecycle_status === "end_of_life";

  // Fields preserved from existing TOML (APIs don't provide these)
  const family = existing?.family ?? inferFamily(apiModel.id, apiModel.name);
  const knowledge = existing?.knowledge;
  const openWeights = existing?.open_weights ?? false;
  const interleaved = existing?.interleaved;
  const attachment = existing?.attachment ?? inputMods.some((m) => m !== "text");

  // reasoning: trust existing if set, else use API thinking flag as a hint
  // (thinking flag is unreliable for non-LLM models so gate on output modality)
  const isTextOutput = outputMods.includes("text") && !outputMods.includes("image") && !outputMods.includes("video");
  const reasoning = existing?.reasoning ?? (isTextOutput && (apiModel.thinking ?? false));

  // tool_call: no API signal, preserve existing or default true for text models
  const toolCall = existing?.tool_call ?? isTextOutput;

  // temperature: no API signal, preserve or default true
  const temperature = existing?.temperature ?? true;

  // structured_output: no API signal, preserve only
  const structuredOutput = existing?.structured_output;

  const releaseDate = existing?.release_date ?? apiModel.created_at?.slice(0, 10) ?? getTodayDate();

  const merged: MergedModel = {
    name: apiModel.name,
    family,
    attachment,
    reasoning,
    tool_call: toolCall,
    temperature,
    release_date: releaseDate,
    last_updated: getTodayDate(),
    open_weights: openWeights,
    ...(structuredOutput !== undefined && { structured_output: structuredOutput }),
    ...(knowledge && { knowledge }),
    ...(interleaved !== undefined && { interleaved }),
    ...(isDeprecated && { status: "deprecated" }),
    limit: { context: contextWindow, output: maxTokens },
    modalities: { input: inputMods, output: outputMods },
  };

  // Pricing: static-content API is the sole source of truth for prices.
  // The v2 models API pricing is intentionally ignored. If a model has no
  // entry in the static-content API, preserve existing TOML prices.
  const inputPrice = pricing?.input ?? existing?.cost?.input;
  const outputPrice = pricing?.output ?? existing?.cost?.output;

  if (inputPrice !== undefined && outputPrice !== undefined) {
    merged.cost = {
      input: inputPrice,
      output: outputPrice,
      // Always preserve cache pricing — not available from any DO API
      ...(existing?.cost?.cache_read !== undefined && { cache_read: existing.cost.cache_read }),
      ...(existing?.cost?.cache_write !== undefined && { cache_write: existing.cost.cache_write }),
    };

    // Context-tiered pricing (>200k) from the static-content API
    if (pricing?.inputOver200k !== undefined && pricing?.outputOver200k !== undefined) {
      merged.cost.context_over_200k = {
        input: pricing.inputOver200k,
        output: pricing.outputOver200k,
        ...(existing?.cost?.context_over_200k?.cache_read !== undefined && {
          cache_read: existing.cost.context_over_200k.cache_read,
        }),
        ...(existing?.cost?.context_over_200k?.cache_write !== undefined && {
          cache_write: existing.cost.context_over_200k.cache_write,
        }),
      };
    } else if (existing?.cost?.context_over_200k) {
      // Preserve manually-entered context_over_200k if API has no data
      merged.cost.context_over_200k = {
        input: existing.cost.context_over_200k.input ?? inputPrice,
        output: existing.cost.context_over_200k.output ?? outputPrice,
        ...(existing.cost.context_over_200k.cache_read !== undefined && {
          cache_read: existing.cost.context_over_200k.cache_read,
        }),
        ...(existing.cost.context_over_200k.cache_write !== undefined && {
          cache_write: existing.cost.context_over_200k.cache_write,
        }),
      };
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// TOML serialiser
// ---------------------------------------------------------------------------

function formatToml(model: MergedModel): string {
  const lines: string[] = [];

  lines.push(`name = "${model.name.replace(/"/g, '\\"')}"`);
  if (model.family) lines.push(`family = "${model.family}"`);
  lines.push(`release_date = "${model.release_date}"`);
  lines.push(`last_updated = "${model.last_updated}"`);
  lines.push(`attachment = ${model.attachment}`);
  lines.push(`reasoning = ${model.reasoning}`);
  lines.push(`temperature = ${model.temperature}`);
  lines.push(`tool_call = ${model.tool_call}`);
  if (model.structured_output !== undefined) lines.push(`structured_output = ${model.structured_output}`);
  if (model.knowledge) lines.push(`knowledge = "${model.knowledge}"`);
  lines.push(`open_weights = ${model.open_weights}`);
  if (model.status) lines.push(`status = "${model.status}"`);

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
    if (model.cost.cache_read !== undefined) lines.push(`cache_read = ${model.cost.cache_read}`);
    if (model.cost.cache_write !== undefined) lines.push(`cache_write = ${model.cost.cache_write}`);

    if (model.cost.context_over_200k) {
      lines.push("");
      lines.push(`[cost.context_over_200k]`);
      lines.push(`input = ${model.cost.context_over_200k.input}`);
      lines.push(`output = ${model.cost.context_over_200k.output}`);
      if (model.cost.context_over_200k.cache_read !== undefined)
        lines.push(`cache_read = ${model.cost.context_over_200k.cache_read}`);
      if (model.cost.context_over_200k.cache_write !== undefined)
        lines.push(`cache_write = ${model.cost.context_over_200k.cache_write}`);
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

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

interface Change {
  field: string;
  oldValue: string;
  newValue: string;
}

function formatValue(val: unknown): string {
  if (val === undefined) return "(none)";
  if (Array.isArray(val)) return `[${val.join(", ")}]`;
  if (typeof val === "number") return formatNumber(val);
  return String(val);
}

function detectChanges(existing: ExistingModel | null, merged: MergedModel): Change[] {
  if (!existing) return [];

  const changes: Change[] = [];
  const EPSILON = 0.001;

  const compare = (field: string, oldVal: unknown, newVal: unknown) => {
    if (oldVal === undefined && newVal === undefined) return;
    const isDiff = field.startsWith("cost.")
      ? Math.abs((oldVal as number ?? 0) - (newVal as number ?? 0)) > EPSILON
      : JSON.stringify(oldVal) !== JSON.stringify(newVal);
    if (isDiff) changes.push({ field, oldValue: formatValue(oldVal), newValue: formatValue(newVal) });
  };

  compare("name", existing.name, merged.name);
  compare("reasoning", existing.reasoning, merged.reasoning);
  compare("tool_call", existing.tool_call, merged.tool_call);
  compare("attachment", existing.attachment, merged.attachment);
  compare("status", existing.status, merged.status);
  compare("cost.input", existing.cost?.input, merged.cost?.input);
  compare("cost.output", existing.cost?.output, merged.cost?.output);
  compare("cost.context_over_200k.input", existing.cost?.context_over_200k?.input, merged.cost?.context_over_200k?.input);
  compare("cost.context_over_200k.output", existing.cost?.context_over_200k?.output, merged.cost?.context_over_200k?.output);
  compare("limit.context", existing.limit?.context, merged.limit.context);
  compare("limit.output", existing.limit?.output, merged.limit.output);
  compare("modalities.input", existing.modalities?.input, merged.modalities.input);
  compare("modalities.output", existing.modalities?.output, merged.modalities.output);

  return changes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const newOnly = args.includes("--new-only");

  // Resolve API key
  const apiKeyArg = args.find((a) => a.startsWith("--api-key"));
  const apiKey =
    (apiKeyArg?.includes("=") ? apiKeyArg.split("=")[1] : args[args.indexOf(apiKeyArg!) + 1]) ??
    process.env.DIGITALOCEAN_API_TOKEN;

  if (!apiKey) {
    console.error("Error: DIGITALOCEAN_API_TOKEN is required (or pass --api-key=<key>)");
    console.error("Get one from: https://cloud.digitalocean.com/account/api/tokens");
    process.exit(1);
  }

  const modelsDir = path.join(import.meta.dirname, "..", "..", "..", "providers", "digitalocean", "models");

  const prefix = dryRun ? "[DRY RUN] " : "";
  console.log(`${prefix}Fetching DigitalOcean models from API...`);

  // Fetch both APIs in parallel
  const [modelsRes, pricingRes] = await Promise.all([
    fetch(MODELS_API, { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }),
    fetch(PRICING_API, { headers: { "User-Agent": "models.dev/digitalocean-sync" } }),
  ]);

  if (!modelsRes.ok) {
    console.error(`Failed to fetch models API: ${modelsRes.status} ${modelsRes.statusText}`);
    if (modelsRes.status === 401 || modelsRes.status === 403)
      console.error("Check your DIGITALOCEAN_API_TOKEN has read access.");
    process.exit(1);
  }

  if (!pricingRes.ok) {
    console.error(`Failed to fetch pricing API: ${pricingRes.status} ${pricingRes.statusText}`);
    process.exit(1);
  }

  const modelsParsed = DoModelsResponse.safeParse(await modelsRes.json());
  if (!modelsParsed.success) {
    console.error("Unexpected models API response:", modelsParsed.error.errors);
    process.exit(1);
  }

  const pricingParsed = StaticContentResponse.safeParse(await pricingRes.json());
  if (!pricingParsed.success) {
    console.error("Unexpected pricing API response:", pricingParsed.error.errors);
    process.exit(1);
  }

  const apiModels = modelsParsed.data.models;
  const pricingMap = buildPricingMap(pricingParsed.data.gradient.models);

  // Collect existing TOML filenames for orphan detection
  const existingFiles = new Set<string>();
  for await (const file of new Bun.Glob("**/*.toml").scan({ cwd: modelsDir, absolute: false })) {
    existingFiles.add(file);
  }

  console.log(`Found ${apiModels.length} models in API, ${existingFiles.size} existing TOML files\n`);

  const apiModelFiles = new Set<string>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const apiModel of apiModels) {
    // Skip non-text models that opencode can't use: image, video, audio, embedding, reranking
    const outputMods = filterOutputModalities(apiModel.modalities?.output ?? []);
    const isTextModel = outputMods.includes("text");
    const isEmbedding = apiModel.type === "embedding";
    const isReranking = apiModel.type === "reranking";
    if (!isTextModel || isEmbedding || isReranking) continue;

    // Model IDs may contain slashes (e.g. fal-ai/flux/schnell) — use as subpath
    const relativePath = `${apiModel.id}.toml`;
    const filePath = path.join(modelsDir, relativePath);
    const dirPath = path.dirname(filePath);

    apiModelFiles.add(relativePath);

    const existing = await loadExisting(filePath);
    const pricing = pricingMap.get(apiModel.id);
    const merged = mergeModel(apiModel, pricing, existing);
    const toml = formatToml(merged);

    if (existing === null) {
      created++;
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${relativePath}`);
        console.log(`  name = "${merged.name}"`);
        if (pricing) console.log(`  pricing: $${merged.cost?.input}/$${merged.cost?.output} per M tokens`);
        if (merged.family) console.log(`  family = "${merged.family}" (inferred)`);
        console.log("");
      } else {
        await mkdir(dirPath, { recursive: true });
        await Bun.write(filePath, toml);
        console.log(`Created: ${relativePath}`);
      }
      continue;
    }

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
        await Bun.write(filePath, toml);
        console.log(`Updated: ${relativePath}`);
      }
      for (const c of changes) console.log(`  ${c.field}: ${c.oldValue} → ${c.newValue}`);
      console.log("");
    } else {
      unchanged++;
    }
  }

  // Orphan detection: files in the TOML directory but not in the API
  const orphaned: string[] = [];
  for (const file of existingFiles) {
    if (!apiModelFiles.has(file)) {
      orphaned.push(file);
      console.log(`Warning: orphaned file (not in API): ${file}`);
    }
  }

  console.log("");
  if (dryRun) {
    console.log(
      `Summary: ${created} would be created, ${updated} would be updated, ${unchanged} unchanged, ${orphaned.length} orphaned`,
    );
  } else {
    console.log(`Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphaned.length} orphaned`);
  }
}

await main();
