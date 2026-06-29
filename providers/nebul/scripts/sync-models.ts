#!/usr/bin/env bun

import path from "node:path";
import { readdir, mkdir, unlink, rmdir, readFile, writeFile } from "node:fs/promises";

const API_ENDPOINT = "https://api.inference.nebul.io/v1/models";

// The models endpoint requires authentication; an unauthenticated request errors.
const API_KEY = process.env.NEBUL_API_KEY;

const MAX_RETRIES = 3;

const PROVIDER_ID = "nebul";

const SKIP_MODELS: string[] = [];

// Nebul keeps reasoning always on for these models and does not expose an
// effort control, so they emit no configurable reasoning options.
const REASONING_ALWAYS_ON_MODELS = new Set([
  "Qwen/Qwen3.5-397B-A17B",
  "zai-org/GLM-5.2-FP8",
]);

const REASONING_TOGGLE_MODELS = new Set([
  "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16",
  "zai-org/GLM-5.1-FP8",
  "MiniMaxAI/MiniMax-M2.5",
  "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-FP8",
  "Qwen/Qwen3-VL-235B-A22B-Instruct-FP8",
]);

// Non-reasoning models.
const REASONING_DISABLED_MODELS = new Set([
  "mistralai/Mistral-Large-3-675B-Instruct-2512-NVFP4",
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct",
  "Qwen/Qwen3-30B-A3B-Instruct-2507",
]);

const INTERLEAVED_MODELS: Record<string, string> = {
  "zai-org/GLM-5.1-FP8": "reasoning_content",
  "zai-org/GLM-5.2-FP8": "reasoning_content",
};

const BASE_MODEL_MAP: Record<string, { base_model: string; overrides?: Record<string, unknown> }> = {
  "mistralai/Mistral-Large-3-675B-Instruct-2512-NVFP4": {
    base_model: "mistral/mistral-large-2512",
  },
  "Qwen/Qwen3-30B-A3B-Instruct-2507": {
    base_model: "alibaba/qwen3-coder-30b-a3b-instruct",
  },
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct": {
    base_model: "meta/llama-4-maverick-17b-instruct",
    overrides: {
      limit: { context: 300_000, output: 4_096 },
    },
  },
  "MiniMaxAI/MiniMax-M2.5": {
    base_model: "minimax/MiniMax-M2.5",
  },
  "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16": {
    base_model: "nvidia/nemotron-3-super-120b-a12b",
  },
  "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-FP8": {
    base_model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  },
  "Qwen/Qwen3-VL-235B-A22B-Instruct-FP8": {
    base_model: "alibaba/qwen3-235b-a22b",
    overrides: {
      attachment: true,
      reasoning: true,
      structured_output: true,
      limit: { context: 262_000 },
    },
  },
  "Qwen/Qwen3.5-397B-A17B": {
    base_model: "alibaba/qwen3.5-397b-a17b",
  },
  "zai-org/GLM-5.1-FP8": {
    base_model: "zhipuai/glm-5.1",
  },
  "zai-org/GLM-5.2-FP8": {
    base_model: "zhipuai/glm-5.2",
  },
};

interface NebulModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

interface NebulModelsResponse {
  object?: string;
  data: NebulModel[];
}

function formatNumber(n: number): string {
  if (n >= 1000) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return n.toString();
}

function getReasoningOptions(modelId: string): string | null {
  if (REASONING_TOGGLE_MODELS.has(modelId)) {
    return `reasoning_options = [{ type = "toggle" }]`;
  }
  if (REASONING_ALWAYS_ON_MODELS.has(modelId) || REASONING_DISABLED_MODELS.has(modelId)) {
    return `reasoning_options = []`;
  }
  return null;
}

function generateToml(modelId: string): string {
  const config = BASE_MODEL_MAP[modelId];
  if (!config) {
    throw new Error(`No base_model config for ${modelId}. Add it to BASE_MODEL_MAP.`);
  }

  const lines: string[] = [];

  lines.push(`base_model = "${config.base_model}"`);
  lines.push(`base_model_omit = ["cost"]`);

  const overrides = config.overrides ?? {};
  const hasLimitOverride = overrides.limit != null;
  const limitCtx = (overrides.limit as Record<string, number>)?.context;
  const limitOut = (overrides.limit as Record<string, number>)?.output;
  const hasReasoningOverride = overrides.reasoning != null;
  const hasAttachmentOverride = overrides.attachment != null;
  const hasStructuredOutputOverride = overrides.structured_output != null;

  if (hasReasoningOverride) {
    lines.push(`reasoning = ${overrides.reasoning}`);
  }

  if (hasAttachmentOverride) {
    lines.push(`attachment = ${overrides.attachment}`);
  }

  if (hasStructuredOutputOverride) {
    lines.push(`structured_output = ${overrides.structured_output ?? true}`);
  }

  const reasoningOptions = getReasoningOptions(modelId);
  if (reasoningOptions) {
    lines.push(reasoningOptions);
  }

  if (hasLimitOverride) {
    lines.push("");
    lines.push("[limit]");
    if (limitCtx) {
      lines.push(`context = ${formatNumber(limitCtx)}`);
    }
    if (limitOut) {
      lines.push(`output = ${formatNumber(limitOut)}`);
    }
  }

  const interleavedField = INTERLEAVED_MODELS[modelId];
  if (interleavedField) {
    lines.push("");
    lines.push("[interleaved]");
    lines.push(`field = "${interleavedField}"`);
  }

  lines.push("");
  return lines.join("\n");
}

function getFilePath(modelsDir: string, modelId: string): { filePath: string; dirPath: string } {
  if (modelId.includes("/")) {
    const parts = modelId.split("/");
    const fileName = `${parts[parts.length - 1]}.toml`;
    const subDir = parts.slice(0, -1).join("/");
    const dirPath = path.join(modelsDir, subDir);
    const filePath = path.join(dirPath, fileName);
    return { filePath, dirPath };
  }
  return {
    filePath: path.join(modelsDir, `${modelId}.toml`),
    dirPath: modelsDir,
  };
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch {
    // already exists
  }
}

async function getAllExistingFiles(modelsDir: string): Promise<Set<string>> {
  const files = new Set<string>();

  async function scanDir(dir: string, prefix: string = ""): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await scanDir(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        } else if (entry.name.endsWith(".toml")) {
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          files.add(relativePath);
        }
      }
    } catch {
      // directory might not exist
    }
  }

  await scanDir(modelsDir);
  return files;
}

function shouldSkipModel(modelId: string): boolean {
  for (const pattern of SKIP_MODELS) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (modelId.startsWith(prefix + "/")) return true;
    } else if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (modelId.startsWith(prefix)) return true;
    } else {
      if (modelId === pattern) return true;
    }
  }
  return false;
}

async function fetchModels(): Promise<NebulModel[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (API_KEY) {
    headers.Authorization = `Bearer ${API_KEY}`;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(API_ENDPOINT, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // Auth failures won't recover on retry, so surface them immediately.
        if (res.status === 401 || res.status === 403) {
          throw new Error(
            `Authentication failed (${res.status} ${res.statusText}). Set NEBUL_API_KEY to a valid key.${body ? ` Response: ${body}` : ""}`,
          );
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
      }
      const json = (await res.json()) as NebulModelsResponse;
      if (!Array.isArray(json.data)) {
        throw new Error(`Unexpected response shape: missing "data" array`);
      }
      return json.data;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Authentication failed")) break;
      if (attempt < MAX_RETRIES) {
        const delayMs = 500 * 2 ** (attempt - 1);
        console.warn(
          `Fetch attempt ${attempt}/${MAX_RETRIES} failed (${message}); retrying in ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(
    `Failed to fetch Nebul models from ${API_ENDPOINT} after ${MAX_RETRIES} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const modelsDir = path.join(import.meta.dirname, "..", "models");

  if (dryRun) {
    console.log("[DRY RUN] Fetching Nebul models from API...");
  } else {
    console.log("Fetching Nebul models from API...");
  }

  if (!API_KEY) {
    console.warn(
      "Warning: NEBUL_API_KEY is not set. The models endpoint requires authentication and the request will likely fail.",
    );
  }

  let apiModels: NebulModel[];
  try {
    apiModels = await fetchModels();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const existingFiles = await getAllExistingFiles(modelsDir);

  console.log(`Found ${apiModels.length} models in API, ${existingFiles.size} existing files\n`);

  const apiModelPaths = new Set<string>();

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const apiModel of apiModels) {
    if (shouldSkipModel(apiModel.id)) {
      skipped++;
      if (dryRun) {
        console.log(`[DRY RUN] Skipped: ${apiModel.id}`);
      }
      continue;
    }

    if (!BASE_MODEL_MAP[apiModel.id]) {
      console.log(`Skipping (no base_model config): ${apiModel.id}`);
      skipped++;
      continue;
    }

    const { filePath, dirPath } = getFilePath(modelsDir, apiModel.id);

    const relativePath = apiModel.id.includes("/")
      ? `${apiModel.id.split("/").slice(0, -1).join("/")}/${apiModel.id.split("/").pop()}.toml`
      : `${apiModel.id}.toml`;

    apiModelPaths.add(relativePath);

    const tomlContent = generateToml(apiModel.id);

    const fileExists = existingFiles.has(relativePath);

    if (fileExists) {
      const existing = await readFile(filePath, "utf-8");
      if (existing.trim() === tomlContent.trim()) {
        unchanged++;
        continue;
      }
      updated++;
      if (dryRun) {
        console.log(`[DRY RUN] Would update: ${relativePath}`);
      } else {
        await writeFile(filePath, tomlContent, "utf-8");
        console.log(`Updated: ${relativePath}`);
      }
    } else {
      created++;
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${relativePath}`);
      } else {
        await ensureDir(dirPath);
        await writeFile(filePath, tomlContent, "utf-8");
        console.log(`Created: ${relativePath}`);
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
  const action = dryRun ? "would be" : "";
  console.log(
    `Summary: ${created} ${action} created, ${updated} ${action} updated, ${unchanged} unchanged, ${skipped} skipped, ${orphaned.length} orphaned`
  );
}

await main();
