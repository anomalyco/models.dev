#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// Friendli API endpoint
const API_ENDPOINT = "https://api.friendli.ai/serverless/v1/models";

// Zod schemas for API response validation
const Functionality = z.object({
  tool_call: z.boolean(),
  parallel_tool_call: z.boolean(),
  structured_output: z.boolean(),
});

const Pricing = z.object({
  input: z.number(),
  output: z.number(),
  response_time: z.number(),
  unit_type: z.enum(["TOKEN", "SECOND"]),
});

const FriendliModel = z
  .object({
    id: z.string(),
    name: z.string(),
    max_completion_tokens: z.number(),
    context_length: z.number(),
    functionality: Functionality,
    pricing: Pricing,
    hugging_face_url: z.string().optional(),
    description: z.string().optional(),
    license: z.string().optional(),
    policy: z.string().optional().nullable(),
    created: z.number(), // Unix timestamp
  })
  .passthrough();

const FriendliResponse = z.object({
  data: z.array(FriendliModel),
});

// Family inference patterns
const familyPatterns: [RegExp, string][] = [
  [/llama-3\.3/i, "llama-3.3"],
  [/llama-3\.1/i, "llama-3.1"],
  [/llama-4/i, "llama-4"],
  [/qwen3/i, "qwen3"],
  [/deepseek-r1/i, "deepseek-r1"],
  [/exaone/i, "exaone"],
  [/glm-4/i, "glm-4"],
  [/glm-5/i, "glm"],
];

function inferFamily(modelId: string, modelName: string): string | undefined {
  for (const [pattern, family] of familyPatterns) {
    if (pattern.test(modelId) || pattern.test(modelName)) {
      return family;
    }
  }
  return undefined;
}

function extractModelName(fullName: string): string {
  // "meta-llama/Llama-3.3-70B-Instruct" -> "Llama 3.3 70B Instruct"
  const parts = fullName.split("/");
  const modelName = parts.at(-1) ?? fullName;
  return modelName
    .replace(/-/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

// TODO: Replace with functionality.parse_reasoning from API when available
function isReasoningModel(modelId: string): boolean {
  // Non-reasoning: Llama 3.x Instruct, Qwen3 Instruct
  const nonReasoningPatterns = [
    /llama-3\.\d.*instruct/i,
    /qwen3.*instruct/i,
  ];

  for (const pattern of nonReasoningPatterns) {
    if (pattern.test(modelId)) {
      return false;
    }
  }

  // Everything else is reasoning or hybrid reasoning
  return true;
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
  apiModel: z.infer<typeof FriendliModel>,
  existing: ExistingModel | null,
): MergedModel {
  const contextTokens = apiModel.context_length;
  const outputTokens = apiModel.max_completion_tokens;

  const openWeights = Boolean(apiModel.hugging_face_url);

  const merged: MergedModel = {
    // Always from API
    name: extractModelName(apiModel.name),
    attachment: false, // All Friendli models are text-only currently
    reasoning: isReasoningModel(apiModel.id),
    tool_call: apiModel.functionality.tool_call,
    temperature: true,
    release_date: timestampToDate(apiModel.created),
    last_updated: getTodayDate(),
    open_weights: openWeights,
    limit: {
      context: contextTokens,
      output: outputTokens,
    },
    modalities: {
      input: ["text"],
      output: ["text"],
    },
  };

  // structured_output only if true
  if (apiModel.functionality.structured_output === true) {
    merged.structured_output = true;
  }

  // Cost from API - ONLY include if unit_type is TOKEN
  if (apiModel.pricing.unit_type === "TOKEN") {
    merged.cost = {
      input: apiModel.pricing.input,
      output: apiModel.pricing.output,
    };
  } else {
    console.log(
      `  Note: ${apiModel.id} uses ${apiModel.pricing.unit_type} pricing - cost section omitted`,
    );
  }

  // Preserve from existing OR infer
  if (existing?.family) {
    merged.family = existing.family;
  } else {
    const inferred = inferFamily(apiModel.id, apiModel.name);
    if (inferred) {
      merged.family = inferred;
    }
  }

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

  // Cost section (only if present)
  if (model.cost) {
    lines.push("");
    lines.push(`[cost]`);
    lines.push(`input = ${model.cost.input}`);
    lines.push(`output = ${model.cost.output}`);
  }

  // Limit section
  lines.push("");
  lines.push(`[limit]`);
  lines.push(`context = ${formatNumber(model.limit.context)}`);
  lines.push(`output = ${formatNumber(model.limit.output)}`);

  // Modalities section
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
  compare(
    "structured_output",
    existing.structured_output,
    merged.structured_output,
  );
  compare("open_weights", existing.open_weights, merged.open_weights);
  compare("release_date", existing.release_date, merged.release_date);
  compare("cost.input", existing.cost?.input, merged.cost?.input);
  compare("cost.output", existing.cost?.output, merged.cost?.output);
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
    "friendli",
    "models",
  );

  if (dryRun) {
    console.log(`[DRY RUN] Fetching Friendli models from API...`);
  } else {
    console.log(`Fetching Friendli models from API...`);
  }

  // Fetch API data
  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  const parsed = FriendliResponse.safeParse(json);
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  const apiModels = parsed.data.data;

  // Get existing files (recursively)
  const existingFiles = new Set<string>();
  try {
    for await (const file of new Bun.Glob("**/*.toml").scan({
      cwd: modelsDir,
      absolute: false,
    })) {
      existingFiles.add(file);
    }
  } catch {
    // Directory might not exist yet
  }

  console.log(
    `Found ${apiModels.length} models in API, ${existingFiles.size} existing files\n`,
  );

  // Track API model IDs for orphan detection
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
      const changes = detectChanges(existing, merged);

      if (changes.length > 0) {
        updated++;
        if (dryRun) {
          console.log(`[DRY RUN] Would update: ${relativePath}`);
        } else {
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
