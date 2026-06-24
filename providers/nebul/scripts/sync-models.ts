#!/usr/bin/env bun

import path from "node:path";
import { readdir, mkdir, readFile, writeFile } from "node/fs/promises";

const API_ENDPOINT = "https://api.inference.nebul.io/v1/models";

const SKIP_MODELS: string[] = [];

const REASONING_EFFORT_MODELS: Record<string, { type: "effort"; values: string[] }> = {
  "openai/gpt-oss-120b": { type: "effort", values: ["low", "medium", "high"] },
  "Qwen/Qwen3.5-397B-A17B": { type: "effort", values: ["none", "low", "medium", "high"] },
  "zai-org/GLM-5.2-FP8": { type: "effort", values: ["high", "max"] },
};

const REASONING_TOGGLE_MODELS = new Set([
  "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16",
  "zai-org/GLM-5.1-FP8",
  "MiniMaxAI/MiniMax-M2.5",
  "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-FP8",
  "Qwen/Qwen3-VL-235B-A22B-Instruct-FP8",
]);

const REASONING_DISABLED_MODELS = new Set([
  "mistralai/Mistral-Large-3-675B-Instruct-2512-NVFP4",
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct",
  "Qwen/Qwen3-30B-A3B-Instruct-2507",
]);

const INTERLEAVED_MODELS: Record<string, string> = {
  "openai/gpt-oss-120b": "reasoning_content",
  "zai-org/GLM-5.1-FP8": "reasoning_content",
  "zai-org/GLM-5.2-FP8": "reasoning_content",
};

const EXTENDS_MAP: Record<string, { from: string; omit?: string[]; overrides?: Record<string, unknown> }> = {
  "mistralai/Mistral-Large-3-675B-Instruct-2512-NVFP4": {
    from: "mistral/mistral-large-2512",
    omit: ["cost"],
  },
  "Qwen/Qwen3-30B-A3B-Instruct-2507": {
    from: "alibaba/qwen3-coder-30b-a3b-instruct",
    omit: ["cost"],
  },
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct": {
    from: "llama/llama-4-maverick-17b-128e-instruct-fp8",
    omit: ["cost"],
    overrides: {
      limit: { context: 300_000, output: 4_096 },
    },
  },
  "MiniMaxAI/MiniMax-M2.5": {
    from: "minimax/MiniMax-M2.5",
    omit: ["cost"],
  },
  "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16": {
    from: "nvidia/nemotron-3-super-120b-a12b",
    omit: ["cost"],
  },
  "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-FP8": {
    from: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    omit: ["cost"],
  },
  "openai/gpt-oss-120b": {
    from: "amazon-bedrock/openai.gpt-oss-120b-1:0",
    omit: ["cost"],
    overrides: {
      reasoning: true,
    },
  },
  "Qwen/Qwen3-VL-235B-A22B-Instruct-FP8": {
    from: "alibaba/qwen3-235b-a22b",
    omit: ["cost"],
    overrides: {
      attachment: true,
      reasoning: true,
      structured_output: true,
      limit: { context: 262_000 },
    },
  },
  "Qwen/Qwen3.5-397B-A17B": {
    from: "alibaba/qwen3.5-397b-a17b",
    omit: ["cost"],
  },
  "zai-org/GLM-5.1-FP8": {
    from: "zhipuai/glm-5.1",
    omit: ["cost"],
  },
};

const FULLY_AUTHORED_MODELS = new Set([
  "zai-org/GLM-5.2-FP8",
]);

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

function getReasoningOptionsToml(modelId: string): string[] {
  if (REASONING_EFFORT_MODELS[modelId]) {
    const opts = REASONING_EFFORT_MODELS[modelId];
    const values = opts.values.map((v) => `"${v}"`).join(", ");
    return [
      "[[reasoning_options]]",
      `type = "effort"`,
      `values = [${values}]`,
    ];
  }
  if (REASONING_TOGGLE_MODELS.has(modelId)) {
    return [
      "[[reasoning_options]]",
      `type = "toggle"`,
    ];
  }
  if (REASONING_DISABLED_MODELS.has(modelId)) {
    return ["reasoning_options = []"];
  }
  return [];
}

function generateExtendsToml(modelId: string): string {
  const config = EXTENDS_MAP[modelId];
  if (!config) {
    throw new Error(`No extends config for ${modelId}. Add it to EXTENDS_MAP.`);
  }

  const lines: string[] = [];
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
    lines.push(`structured_output = ${overrides.structured_output}`);
  }

  lines.push("");
  lines.push("[extends]");
  lines.push(`from = "${config.from}"`);
  if (config.omit && config.omit.length > 0) {
    lines.push(`omit = [${config.omit.map((o) => `"${o}"`).join(", ")}]`);
  }

  const reasoningOptions = getReasoningOptionsToml(modelId);
  if (reasoningOptions.length > 0) {
    lines.push("");
    lines.push(...reasoningOptions);
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

function generateAuthoredToml(modelId: string): string {
  if (modelId === "zai-org/GLM-5.2-FP8") {
    return [
      `name = "GLM-5.2"`,
      `family = "glm"`,
      `release_date = "2026-05-15"`,
      `last_updated = "2026-05-15"`,
      `attachment = false`,
      `reasoning = true`,
      `temperature = true`,
      `tool_call = true`,
      `structured_output = true`,
      `open_weights = false`,
      ``,
      `[[reasoning_options]]`,
      `type = "effort"`,
      `values = ["high", "max"]`,
      ``,
      `[interleaved]`,
      `field = "reasoning_content"`,
      ``,
      `[limit]`,
      `context = 200_000`,
      `output = 131_072`,
      ``,
      `[modalities]`,
      `input = ["text"]`,
      `output = ["text"]`,
      ``,
    ].join("\n");
  }
  throw new Error(`No authored template for ${modelId}`);
}

function generateToml(modelId: string): string {
  if (FULLY_AUTHORED_MODELS.has(modelId)) {
    return generateAuthoredToml(modelId);
  }
  return generateExtendsToml(modelId);
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

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const modelsDir = path.join(import.meta.dirname, "..", "models");

  if (dryRun) {
    console.log("[DRY RUN] Fetching Nebul models from API...");
  } else {
    console.log("Fetching Nebul models from API...");
  }

  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = (await res.json()) as NebulModelsResponse;
  const apiModels = json.data ?? [];

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

    if (!EXTENDS_MAP[apiModel.id] && !FULLY_AUTHORED_MODELS.has(apiModel.id)) {
      console.log(`Skipping (no config): ${apiModel.id}`);
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
  console.log(
    `Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${skipped} skipped, ${orphaned.length} orphaned`
  );
}

await main();
