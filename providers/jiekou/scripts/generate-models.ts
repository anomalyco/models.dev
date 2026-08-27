#!/usr/bin/env bun

import { z } from "zod";
import path from "node:path";
import { readdir, mkdir, unlink, rmdir } from "node:fs/promises";
import { ModelFamilyValues } from "../../../packages/core/src/family.js";

// Jiekou.AI API endpoint
const API_ENDPOINT = "https://api.jiekou.ai/openai/models";

const SKIP_MODELS = [
  "google/gemma-*",
  "meta-llama/*",
  "mistralai/*",
  "openai/gpt-oss-*",
  "qwen/qwen-2.5-*",
  "qwen/qwen2.5-*",
  "qwen/qwen-mt-plus",
  "sao10k/*",
  "Sao10K/*",
  "claude-3-*",
  "deepseek/deepseek-ocr-*",
  "doubao-*",
  "gemini-2.0*",
  "gpt-4*",
  "gpt-5.1-chat-latest",
  "gpt-5.2-chat-latest",
  "gpt-5",
  "grok-3-mini",
  "grok-3",
  "gryphe/*",
  "nova-2-Lite",
  "o1-mini",
  "o1",
  "zai-org/glm-ocr"
]

// Zod schemas for API response validation
const JiekouModel = z
  .object({
    id: z.string(),
    created: z.number(),
    object: z.string(),
    owned_by: z.string(),
    title: z.string().optional(),
    display_name: z.string().optional(),
    description: z.string().optional(),
    input_token_price_per_m: z.number(),
    output_token_price_per_m: z.number(),
    context_size: z.number(),
    max_output_tokens: z.number(),
    features: z.array(z.string()).optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
  })
  .passthrough();

const JiekouResponse = z
  .object({
    data: z.array(JiekouModel),
  })
  .passthrough();

// Check if model ID should be skipped based on SKIP_MODELS patterns
function shouldSkipModel(modelId: string): boolean {
  const lowerModelId = modelId.toLowerCase();
  for (const pattern of SKIP_MODELS) {
    const lowerPattern = pattern.toLowerCase();
    if (lowerPattern.endsWith("/*")) {
      // Prefix match: "gemma/*" matches "google/gemma-3-12b-it"
      const prefix = lowerPattern.slice(0, -2);
      if (lowerModelId.includes(prefix + "/") || lowerModelId.startsWith(prefix + "/")) {
        return true;
      }
    } else if (lowerPattern.endsWith("*")) {
      // Wildcard suffix: "gpt-4*" matches "gpt-4o", "gpt-4.1"
      const prefix = lowerPattern.slice(0, -1);
      if (lowerModelId.startsWith(prefix) || lowerModelId.includes("/" + prefix)) {
        return true;
      }
    } else {
      // Exact match
      if (lowerModelId === lowerPattern || lowerModelId.endsWith("/" + lowerPattern)) {
        return true;
      }
    }
  }
  return false;
}

// Open-source model patterns
const OPEN_WEIGHTS_PATTERNS = [
  "deepseek",
  "qwen",
  "llama",
  "gemma",
  "mistral",
  "phi",
  "yi",
  "baichuan",
  "glm",
  "ernie",
  "minimax",
];

function isOpenWeights(modelId: string): boolean {
  const lowerModelId = modelId.toLowerCase();
  return OPEN_WEIGHTS_PATTERNS.some((pattern) =>
    lowerModelId.includes(pattern)
  );
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

function inferFamily(modelId: string): string | undefined {
  const sortedFamilies = [...ModelFamilyValues].sort(
    (a, b) => b.length - a.length
  );

  // Remove prefix like "deepseek/", "qwen/", etc.
  const baseName = modelId.includes("/")
    ? modelId.split("/").pop()!
    : modelId;

  for (const family of sortedFamilies) {
    if (matchesFamily(baseName, family)) {
      return family;
    }
  }

  return undefined;
}

function formatNumber(n: number): string {
  if (n >= 1000) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return n.toString();
}

function getYearMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

interface ProcessedModel {
  name: string;
  family?: string;
  release_date: string;
  last_updated: string;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  structured_output: boolean;
  open_weights: boolean;
  cost: {
    input: number;
    output: number;
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

function processModel(apiModel: z.infer<typeof JiekouModel>): ProcessedModel {
  const features = apiModel.features ?? [];
  const inputModalities = apiModel.input_modalities ?? ["text"];
  const outputModalities = apiModel.output_modalities ?? ["text"];

  // Convert price: divide by 10000 (from 0.0001 USD to USD)
  const inputCost = apiModel.input_token_price_per_m / 10000;
  const outputCost = apiModel.output_token_price_per_m / 10000;

  // Features mapping (ignore "serverless")
  const hasToolCall = features.includes("function-calling");
  const hasStructuredOutput = features.includes("structured-outputs");
  const hasReasoning = features.includes("reasoning");

  // Attachment: true if image/video/audio in input modalities
  const hasAttachment =
    inputModalities.includes("image") ||
    inputModalities.includes("video") ||
    inputModalities.includes("audio");

  const yearMonth = getYearMonth();

  return {
    name: apiModel.id,
    family: inferFamily(apiModel.id),
    release_date: yearMonth,
    last_updated: yearMonth,
    attachment: hasAttachment,
    reasoning: hasReasoning,
    temperature: true,
    tool_call: hasToolCall,
    structured_output: hasStructuredOutput,
    open_weights: isOpenWeights(apiModel.id),
    cost: {
      input: inputCost,
      output: outputCost,
    },
    limit: {
      context: apiModel.context_size,
      output: apiModel.max_output_tokens,
    },
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
  };
}

function formatToml(model: ProcessedModel): string {
  const lines: string[] = [];

  // Basic fields
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
  lines.push(`structured_output = ${model.structured_output}`);
  lines.push(`open_weights = ${model.open_weights}`);

  // Cost section
  lines.push("");
  lines.push(`[cost]`);
  lines.push(`input = ${model.cost.input}`);
  lines.push(`output = ${model.cost.output}`);

  // Limit section
  lines.push("");
  lines.push(`[limit]`);
  lines.push(`context = ${formatNumber(model.limit.context)}`);
  lines.push(`output = ${formatNumber(model.limit.output)}`);

  // Modalities section
  lines.push("");
  lines.push(`[modalities]`);
  lines.push(
    `input = [${model.modalities.input.map((m) => `"${m}"`).join(", ")}]`
  );
  lines.push(
    `output = [${model.modalities.output.map((m) => `"${m}"`).join(", ")}]`
  );

  return lines.join("\n") + "\n";
}

function getFilePath(
  modelsDir: string,
  modelId: string
): { filePath: string; dirPath: string } {
  if (modelId.includes("/")) {
    // e.g., "deepseek/deepseek-r1-0528" -> models/deepseek/deepseek-r1-0528.toml
    const parts = modelId.split("/");
    const fileName = `${parts[parts.length - 1]}.toml`;
    const subDir = parts.slice(0, -1).join("/");
    const dirPath = path.join(modelsDir, subDir);
    const filePath = path.join(dirPath, fileName);
    return { filePath, dirPath };
  } else {
    // e.g., "claude-opus-4-6" -> models/claude-opus-4-6.toml
    return {
      filePath: path.join(modelsDir, `${modelId}.toml`),
      dirPath: modelsDir,
    };
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch {
    // Directory already exists
  }
}

async function getAllExistingFiles(
  modelsDir: string
): Promise<Set<string>> {
  const files = new Set<string>();

  async function scanDir(dir: string, prefix: string = ""): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await scanDir(
            path.join(dir, entry.name),
            prefix ? `${prefix}/${entry.name}` : entry.name
          );
        } else if (entry.name.endsWith(".toml")) {
          const relativePath = prefix
            ? `${prefix}/${entry.name}`
            : entry.name;
          files.add(relativePath);
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  await scanDir(modelsDir);
  return files;
}

// Extract model name from TOML file content
function extractModelName(content: string): string | null {
  const match = content.match(/^name\s*=\s*"([^"]+)"/m);
  return match ? match[1] ?? null : null;
}

// Delete existing TOML files that match SKIP_MODELS
async function cleanupSkippedModels(
  modelsDir: string,
  existingFiles: Set<string>,
  dryRun: boolean
): Promise<number> {
  let deleted = 0;

  for (const relativePath of existingFiles) {
    const filePath = path.join(modelsDir, relativePath);
    try {
      const file = Bun.file(filePath);
      const content = await file.text();
      const modelName = extractModelName(content);

      if (modelName && shouldSkipModel(modelName)) {
        deleted++;
        if (dryRun) {
          console.log(`[DRY RUN] Would delete (matches SKIP_MODELS): ${relativePath}`);
        } else {
          await unlink(filePath);
          console.log(`Deleted (matches SKIP_MODELS): ${relativePath}`);

          // Try to remove parent directory if empty
          const dirPath = path.dirname(filePath);
          if (dirPath !== modelsDir) {
            try {
              await rmdir(dirPath);
            } catch {
              // Directory not empty, ignore
            }
          }
        }
      }
    } catch {
      // File read error, skip
    }
  }

  return deleted;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const modelsDir = path.join(import.meta.dirname, "..", "models");

  if (dryRun) {
    console.log("[DRY RUN] Fetching Jiekou.AI models from API...");
  } else {
    console.log("Fetching Jiekou.AI models from API...");
  }

  // Fetch API data
  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  const parsed = JiekouResponse.safeParse(json);
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  const apiModels = parsed.data.data;

  // Get existing files
  const existingFiles = await getAllExistingFiles(modelsDir);

  console.log(
    `Found ${apiModels.length} models in API, ${existingFiles.size} existing files\n`
  );

  // First, clean up existing files that match SKIP_MODELS
  const deleted = await cleanupSkippedModels(modelsDir, existingFiles, dryRun);
  if (deleted > 0) {
    console.log("");
  }

  // Refresh existing files after cleanup
  const remainingFiles = await getAllExistingFiles(modelsDir);

  // Track API model IDs for orphan detection
  const apiModelPaths = new Set<string>();

  let created = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const apiModel of apiModels) {
    // Check if model should be skipped based on SKIP_MODELS patterns
    if (shouldSkipModel(apiModel.id)) {
      skipped++;
      if (dryRun) {
        console.log(`[DRY RUN] Skipped (matches SKIP_MODELS): ${apiModel.id}`);
      }
      continue;
    }

    const processed = processModel(apiModel);
    const { filePath, dirPath } = getFilePath(modelsDir, apiModel.id);

    // Build relative path for tracking
    const relativePath = apiModel.id.includes("/")
      ? `${apiModel.id.split("/").slice(0, -1).join("/")}/${apiModel.id.split("/").pop()}.toml`
      : `${apiModel.id}.toml`;

    apiModelPaths.add(relativePath);

    // Check if file exists - if so, skip it (don't overwrite)
    const fileExists = remainingFiles.has(relativePath);

    if (fileExists) {
      unchanged++;
      continue;
    }

    // Create new file
    const tomlContent = formatToml(processed);
    created++;
    if (dryRun) {
      console.log(`[DRY RUN] Would create: ${relativePath}`);
      console.log(`  name = "${processed.name}"`);
      if (processed.family) {
        console.log(`  family = "${processed.family}" (inferred)`);
      }
      console.log("");
    } else {
      await ensureDir(dirPath);
      await Bun.write(filePath, tomlContent);
      console.log(`Created: ${relativePath}`);
    }
  }

  // Check for orphaned files
  const orphaned: string[] = [];
  for (const file of remainingFiles) {
    if (!apiModelPaths.has(file)) {
      orphaned.push(file);
      console.log(`Warning: Orphaned file (not in API): ${file}`);
    }
  }

  // Summary
  console.log("");
  if (dryRun) {
    console.log(
      `Summary: ${deleted} would be deleted, ${created} would be created, ${unchanged} unchanged, ${skipped} skipped, ${orphaned.length} orphaned`
    );
  } else {
    console.log(
      `Summary: ${deleted} deleted, ${created} created, ${unchanged} unchanged, ${skipped} skipped, ${orphaned.length} orphaned`
    );
  }
}

await main();
