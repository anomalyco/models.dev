#!/usr/bin/env bun

/**
 * Generates Amazon Bedrock model TOML files by listing foundation models
 * via the AWS SDK and mapping them to upstream providers when possible.
 *
 * Based on https://github.com/OpeOginni/amazon-bedrock-models-script
 *
 * Usage:
 *   bun run bedrock:generate
 *
 * Flags:
 *   --dry-run         Preview changes without writing files
 *   --new-only        Only create new models, skip updating existing ones
 *   --refresh-regions Re-fetch AWS region-compatibility docs before generating
 */

import {
  BedrockClient,
  FoundationModelLifecycleStatus,
  ListFoundationModelsCommand,
  ModelModality,
  type FoundationModelSummary,
} from "@aws-sdk/client-bedrock";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const newOnly = args.includes("--new-only");
const refreshRegions = args.includes("--refresh-regions");

const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "..", "..", "providers");
const MODELS_DIR = path.join(PROVIDERS_DIR, "amazon-bedrock", "models");
const REGION_CACHE_PATH = path.join(
  import.meta.dirname,
  "scrape-bedrock-regions.json",
);

const AWS_REGION_DOCS_URL =
  "https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html#inference-options-glance";

const REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "af-south-1",
  "ap-east-1",
  "ap-south-2",
  "ap-southeast-3",
  "ap-southeast-5",
  "ap-southeast-4",
  "ap-south-1",
  "ap-southeast-6",
  "ap-northeast-3",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-east-2",
  "ap-southeast-7",
  "ap-northeast-1",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-south-1",
  "eu-west-3",
  "eu-south-2",
  "eu-north-1",
  "eu-central-2",
  "il-central-1",
  "mx-central-1",
  "me-south-1",
  "me-central-1",
  "sa-east-1",
];

const IMPORTANT_PROVIDERS = new Set([
  "Amazon",
  "Anthropic",
  "DeepSeek",
  "Google",
  "Meta",
  "MiniMax",
  "Mistral AI",
  "Moonshot AI",
  "NVIDIA",
  "OpenAI",
  "Qwen",
  "Writer",
  "Z.AI",
]);

const EXCLUDED_MODEL_NAME_PARTS = [
  "safeguard",
  "embedding",
  "rerank",
  "canvas",
  "image generator",
  "reel",
];

// Exclude context-window size variants (e.g. :24k, :128k, :1m, :10m)
const CONTEXT_VARIANT_RE = /:\d+[km]$/i;

const REGION_REQUEST_TIMEOUT_MS = 20_000;

type RegionSupport = {
  inRegion: string[];
  geo: string[];
  global: string[];
};

type ModelRecord = {
  summary: FoundationModelSummary;
  regionsFromApi: Set<string>;
};

type TomlModel = {
  id: string;
  baseId: string;
  name: string;
  inference: "in-region" | "geo" | "global";
  supportedRegions: string[];
};

const uniq = <T>(values: Iterable<T>) => [...new Set(values)];

const normalizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// Scrape AWS docs for region support
// ---------------------------------------------------------------------------

const parseAvailabilityCell = (value: string) =>
  /yes|legacy/i.test(value) && !/no/i.test(value);

const stripHtml = (value: string) =>
  value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const htmlCellText = (value: string) =>
  `${[...value.matchAll(/alt="([^"]+)"/g)].map((match) => match[1]).join(" ")} ${stripHtml(value)}`.trim();

const parseAwsRegionDocsHtml = (html: string) => {
  const supportByName: Record<string, RegionSupport> = {};
  const tables = html.matchAll(
    /<table[^>]*>.*?<caption>(.*?)<\/caption>(.*?)<\/table>/gis,
  );

  for (const table of tables) {
    const modelName = stripHtml(table[1]!);
    const tableHtml = table[2]!;
    if (
      !modelName ||
      !/In-Region/.test(tableHtml) ||
      !/Geo/.test(tableHtml) ||
      !/Global/.test(tableHtml)
    )
      continue;

    const support: RegionSupport = { inRegion: [], geo: [], global: [] };
    const rows = tableHtml.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis);

    for (const row of rows) {
      const cells = [...row[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/gis)].map(
        (cell) => cell[1]!,
      );
      if (cells.length !== 4) continue;

      const region = stripHtml(cells[0]!).match(
        /^(us-gov-[a-z]+-\d|[a-z]{2}(?:-[a-z]+)+-\d)/,
      )?.[1];
      if (!region) continue;

      if (parseAvailabilityCell(htmlCellText(cells[1]!)))
        support.inRegion.push(region);
      if (parseAvailabilityCell(htmlCellText(cells[2]!)))
        support.geo.push(region);
      if (parseAvailabilityCell(htmlCellText(cells[3]!)))
        support.global.push(region);
    }

    supportByName[normalizeName(modelName)] = {
      inRegion: support.inRegion.sort(),
      geo: support.geo.sort(),
      global: support.global.sort(),
    };
  }

  return supportByName;
};

async function scrapeRegionSupport(): Promise<Map<string, RegionSupport>> {
  console.log("Fetching AWS region-compatibility docs...");
  const response = await fetch(AWS_REGION_DOCS_URL);
  if (!response.ok)
    throw new Error(`AWS docs request failed: ${response.status}`);

  const html = await response.text();
  const regionSupport = parseAwsRegionDocsHtml(html);

  if (!dryRun) {
    await mkdir(path.dirname(REGION_CACHE_PATH), { recursive: true });
    await writeFile(
      REGION_CACHE_PATH,
      `${JSON.stringify(regionSupport, null, 2)}\n`,
    );
  }

  console.log(
    `${dryRun ? "Parsed" : "Wrote"} ${Object.keys(regionSupport).length} model region-support records${dryRun ? "" : ` to ${REGION_CACHE_PATH}`}`,
  );
  return new Map(Object.entries(regionSupport));
}

async function loadRegionSupport(): Promise<Map<string, RegionSupport>> {
  if (refreshRegions || !existsSync(REGION_CACHE_PATH)) {
    return scrapeRegionSupport();
  }

  const raw = JSON.parse(
    await readFile(REGION_CACHE_PATH, "utf8"),
  ) as Record<string, RegionSupport>;
  return new Map(Object.entries(raw));
}

// ---------------------------------------------------------------------------
// List Bedrock models across regions
// ---------------------------------------------------------------------------

const isImportantModel = (model: FoundationModelSummary) => {
  const name = model.modelName?.toLowerCase() ?? "";
  const modelId = model.modelId?.toLowerCase() ?? "";
  return (
    Boolean(model.modelId) &&
    Boolean(model.providerName && IMPORTANT_PROVIDERS.has(model.providerName)) &&
    model.modelLifecycle?.status === FoundationModelLifecycleStatus.ACTIVE &&
    !model.outputModalities?.includes(ModelModality.EMBEDDING) &&
    !EXCLUDED_MODEL_NAME_PARTS.some((part) => name.includes(part)) &&
    !CONTEXT_VARIANT_RE.test(modelId)
  );
};

const listModelsByRegion = async () => {
  // Use a single canonical region to decide which models are important,
  // because lifecycle status can differ across regions.
  const canonicalClient = new BedrockClient({ region: "us-east-1" });
  const canonicalResponse = await canonicalClient.send(
    new ListFoundationModelsCommand({}),
  );
  const canonicalModels =
    canonicalResponse.modelSummaries?.filter(isImportantModel) ?? [];
  const allowedModelIds = new Set(canonicalModels.map((m) => m.modelId!));
  console.log(
    `Canonical list from us-east-1 has ${allowedModelIds.size} important models`,
  );

  const records = new Map<string, ModelRecord>();
  const results = await Promise.all(
    REGIONS.map(async (region) => {
      const client = new BedrockClient({ region });
      const abortController = new AbortController();
      const timeout = setTimeout(
        () => abortController.abort(),
        REGION_REQUEST_TIMEOUT_MS,
      );

      try {
        const response = await client.send(
          new ListFoundationModelsCommand({}),
          {
            abortSignal: abortController.signal,
          },
        );
        // Only keep models that are in the canonical allowed set
        const models = (response.modelSummaries ?? []).filter(
          (m) => m.modelId && allowedModelIds.has(m.modelId),
        );
        console.log(`Found ${models.length} allowed models in ${region}`);
        return { region, models };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message.split("\n")[0]
            : String(error);
        console.error(`Could not list models in ${region}: ${message}`);
        return { region, models: [] };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );

  for (const { region, models } of results) {
    for (const summary of models) {
      const id = summary.modelId!;
      const current = records.get(id) ?? {
        summary,
        regionsFromApi: new Set<string>(),
      };
      current.regionsFromApi.add(region);
      records.set(id, current);
    }
  }

  return records;
};

const geoPrefixesForRegions = (regions: string[]) => {
  const prefixes = new Set<string>();
  for (const region of regions) {
    if (region.startsWith("us-")) prefixes.add("us");
    if (region.startsWith("eu-")) prefixes.add("eu");
    if (region.startsWith("ap-")) prefixes.add("apac");
    if (region.startsWith("ap-northeast-")) prefixes.add("jp");
    if (region === "ap-southeast-2" || region === "ap-southeast-4")
      prefixes.add("au");
  }
  return [...prefixes].sort();
};

const familyFromModelId = (modelId: string) => {
  const withoutProvider = modelId
    .replace(/^(global|us|eu|apac|jp|au)\./, "")
    .split(".")
    .slice(1)
    .join(".");
  return withoutProvider
    .replace(/-?\d{8}/g, "")
    .replace(/-?v\d(?::\d)?$/g, "")
    .replace(/:\d+$/g, "")
    .replace(/\.+/g, "-");
};

const toTomlArray = (values: string[]) =>
  `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;

const renderSupportedRegions = (regions: string[]) =>
  `supported_regions = ${toTomlArray(regions)}`;

const upsertSupportedRegions = (content: string, regions: string[]) => {
  const line = renderSupportedRegions(regions);
  const withoutExisting = content.replace(/^supported_regions\s*=.*\n?/m, "");
  if (/^name\s*=.*$/m.test(withoutExisting)) {
    return withoutExisting.replace(/^name\s*=.*$/m, (match) => `${match}\n${line}`);
  }
  return `${line}\n${withoutExisting}`;
};

// ---------------------------------------------------------------------------
// Upstream provider resolution
// ---------------------------------------------------------------------------

type Resolution =
  | { type: "extends"; from: string }
  | { type: "inline"; content: string }
  | null;

async function resolveUpstream(
  baseId: string,
  providerName: string | undefined,
): Promise<Resolution> {
  // Anthropic models extend directly from the anthropic provider
  if (providerName === "Anthropic" || baseId.startsWith("anthropic.")) {
    const bare = baseId.replace(/^anthropic\./, "");
    // Strip dated suffixes and version suffixes to find upstream match
    const upstreamId = bare
      .replace(/-\d{8}/g, "")
      .replace(/-v1(:0)?$/g, "");
    const exactPath = path.join(
      PROVIDERS_DIR,
      "anthropic",
      "models",
      `${upstreamId}.toml`,
    );
    if (existsSync(exactPath)) {
      return { type: "extends", from: `anthropic/${upstreamId}` };
    }
    // Fuzzy match in anthropic provider directory
    const files: string[] = [];
    try {
      for await (const f of new Bun.Glob("*.toml").scan({
        cwd: path.join(PROVIDERS_DIR, "anthropic", "models"),
      })) {
        files.push(f.replace(/\.toml$/, ""));
      }
    } catch {
      // directory may not exist
    }
    const match = files
      .filter(
        (id) =>
          upstreamId.startsWith(id) ||
          id.startsWith(upstreamId) ||
          bare.startsWith(id) ||
          id.startsWith(bare),
      )
      .sort((a, b) => b.length - a.length)[0];
    if (match) {
      return { type: "extends", from: `anthropic/${match}` };
    }
  }

  // Meta Llama models
  if (providerName === "Meta" || baseId.startsWith("meta.")) {
    const bare = baseId.replace(/^meta\./, "");
    // Try common llama ID conversions
    const llamaId = bare
      .replace(/^llama/, "llama")
      .replace(/^(llama\d+)-(\d+)-/, "$1.$2-");
    const exactPath = path.join(
      PROVIDERS_DIR,
      "llama",
      "models",
      `${llamaId}.toml`,
    );
    if (existsSync(exactPath)) {
      return { type: "extends", from: `llama/${llamaId}` };
    }
    // Fuzzy match in llama directory
    const files: string[] = [];
    try {
      for await (const f of new Bun.Glob("*.toml").scan({
        cwd: path.join(PROVIDERS_DIR, "llama", "models"),
      })) {
        files.push(f.replace(/\.toml$/, ""));
      }
    } catch {
      // directory may not exist
    }
    const match = files
      .filter(
        (id) =>
          llamaId.startsWith(id) ||
          id.startsWith(llamaId) ||
          bare.startsWith(id) ||
          id.startsWith(bare),
      )
      .sort((a, b) => b.length - a.length)[0];
    if (match) {
      return { type: "extends", from: `llama/${match}` };
    }
  }

  return null;
}

function renderToml(
  model: TomlModel,
  resolution: Resolution,
): string {
  if (model.id !== model.baseId) {
    // Regional variant
    const baseResolution =
      resolution?.type === "extends"
        ? resolution
        : { type: "extends" as const, from: `amazon-bedrock/${model.baseId}` };
    return `${[
      `name = ${JSON.stringify(model.name)}`,
      renderSupportedRegions(model.supportedRegions),
      "",
      "[extends]",
      `from = ${JSON.stringify(baseResolution.from)}`,
    ].join("\n")}\n`;
  }

  if (resolution?.type === "extends") {
    return `${[
      `name = ${JSON.stringify(model.name)}`,
      renderSupportedRegions(model.supportedRegions),
      "",
      "[extends]",
      `from = ${JSON.stringify(resolution.from)}`,
    ].join("\n")}\n`;
  }

  return `${[
    `name = ${JSON.stringify(model.name)}`,
    renderSupportedRegions(model.supportedRegions),
    `family = ${JSON.stringify(familyFromModelId(model.id))}`,
    `# TODO: fill in release_date, last_updated, cost, limit, modalities, etc.`,
  ].join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Build and write TOML models
// ---------------------------------------------------------------------------

const buildTomlModels = (
  records: Map<string, ModelRecord>,
  docs: Map<string, RegionSupport>,
): TomlModel[] => {
  const models: TomlModel[] = [];

  for (const [baseId, record] of records) {
    const summary = record.summary;
    const modelName = summary.modelName ?? baseId;
    const docSupport = docs.get(normalizeName(modelName));
    const inRegion = uniq(
      docSupport?.inRegion.length ? docSupport.inRegion : record.regionsFromApi,
    ).sort();
    const geo = uniq(docSupport?.geo ?? []).sort();
    const globalRegions = uniq(docSupport?.global ?? []).sort();

    const common = {
      baseId,
    };

    if (inRegion.length) {
      models.push({
        ...common,
        id: baseId,
        name: modelName,
        inference: "in-region",
        supportedRegions: inRegion,
      });
    }

    for (const prefix of geoPrefixesForRegions(geo)) {
      models.push({
        ...common,
        id: `${prefix}.${baseId}`,
        name: `${modelName} (${prefix.toUpperCase()})`,
        inference: "geo",
        supportedRegions: geo.filter((region) =>
          geoPrefixesForRegions([region]).includes(prefix),
        ),
      });
    }

    if (globalRegions.length) {
      models.push({
        ...common,
        id: `global.${baseId}`,
        name: `${modelName} (Global)`,
        inference: "global",
        supportedRegions: globalRegions,
      });
    }
  }

  return models.sort((a, b) => a.id.localeCompare(b.id));
};

async function writeTomlModels(
  models: TomlModel[],
  records: Map<string, ModelRecord>,
) {
  await mkdir(MODELS_DIR, { recursive: true });

  // Clean up orphaned TOML files that are no longer in the API
  const existingFiles = new Set<string>();
  try {
    for await (const f of new Bun.Glob("*.toml").scan({ cwd: MODELS_DIR })) {
      existingFiles.add(f);
    }
  } catch {
    // directory may not exist yet
  }

  const apiModelIds = new Set<string>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let orphaned = 0;

  for (const model of models) {
    const filename = `${model.id}.toml`;
    apiModelIds.add(filename);
    const filePath = path.join(MODELS_DIR, filename);
    const record = records.get(model.baseId);
    const resolution = await resolveUpstream(
      model.baseId,
      record?.summary.providerName,
    );
    const newContent = renderToml(model, resolution);
    const tag = resolution?.type === "extends" ? `extends ${resolution.from}` : "stub";

    if (!existsSync(filePath)) {
      created++;
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${filename}  →  ${tag}`);
      } else {
        await Bun.write(filePath, newContent);
        console.log(`Created: ${filename}  →  ${tag}`);
      }
      continue;
    }

    if (newOnly) {
      unchanged++;
      continue;
    }

    const existingContent = await readFile(filePath, "utf8");
    if (existingContent === newContent) {
      unchanged++;
      continue;
    }

    // Preserve existing files that contain manually-curated metadata
    // (cost, limit, modalities, release_date, etc.) or [extends] overrides
    const isSimpleExtends =
      /^name\s*=/.test(existingContent) &&
      /^\[extends\]$/m.test(existingContent) &&
      /^from\s*=/.test(existingContent) &&
      !/^omit\s*=/.test(existingContent) &&
      !/\[cost\]/i.test(existingContent) &&
      !/\[limit\]/i.test(existingContent) &&
      !/\[modalities\]/i.test(existingContent) &&
      !/\[provider\]/i.test(existingContent) &&
      !/\[experimental\]/i.test(existingContent) &&
      !/release_date\s*=/.test(existingContent) &&
      !/last_updated\s*=/.test(existingContent) &&
      !/knowledge\s*=/.test(existingContent);

    if (!isSimpleExtends) {
      const patchedContent = upsertSupportedRegions(
        existingContent,
        model.supportedRegions,
      );
      if (existingContent === patchedContent) {
        unchanged++;
        continue;
      }

      updated++;
      if (dryRun) {
        console.log(
          `[DRY RUN] Would update supported_regions: ${filename}`,
        );
      } else {
        await Bun.write(filePath, patchedContent);
        console.log(`Updated supported_regions: ${filename}`);
      }
      continue;
    }

    updated++;
    if (dryRun) {
      console.log(`[DRY RUN] Would update: ${filename}  →  ${tag}`);
    } else {
      await Bun.write(filePath, newContent);
      console.log(`Updated: ${filename}  →  ${tag}`);
    }
  }

  for (const file of existingFiles) {
    if (!apiModelIds.has(file)) {
      orphaned++;
      const filePath = path.join(MODELS_DIR, file);
      if (dryRun) {
        console.log(`[DRY RUN] Would remove orphaned: ${file}`);
      } else {
        await rm(filePath, { force: true });
        console.log(`Removed orphaned: ${file}`);
      }
    }
  }

  console.log("");
  if (dryRun) {
    console.log(
      `Summary: ${created} would be created, ${updated} would be updated, ${unchanged} unchanged, ${orphaned} orphaned`,
    );
  } else {
    console.log(
      `Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphaned} orphaned`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `${dryRun ? "[DRY RUN] " : ""}${newOnly ? "[NEW ONLY] " : ""}${refreshRegions ? "[REFRESH REGIONS] " : ""}Fetching Bedrock foundation models...`,
  );

  const docs = await loadRegionSupport();
  const records = await listModelsByRegion();
  const tomlModels = buildTomlModels(records, docs);
  await writeTomlModels(tomlModels, records);

  console.log(`\nDone. ${tomlModels.length} model(s) processed.`);
}

await main();
