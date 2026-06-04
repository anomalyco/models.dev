import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { mergeDeep } from "remeda";
import { z } from "zod";

import { AuthoredModel, AuthoredModelShape } from "../schema.js";
import { cloudflareWorkersAi } from "./providers/cloudflare-workers-ai.js";
import { google } from "./providers/google.js";
import { openrouter } from "./providers/openrouter.js";
import { ovhcloud } from "./providers/ovhcloud.js";
import { xai } from "./providers/xai.js";

const ExistingModel = AuthoredModelShape.partial()
  .extend({
    base_model: z.string().optional(),
    base_model_omit: z.array(z.string()).optional(),
  })
  .strict();

const SyncedBaseModel = AuthoredModelShape.partial()
  .extend({
    id: z.string(),
    base_model: z.string(),
    base_model_omit: z.array(z.string()).optional(),
  })
  .strict();

const SyncedAuthoredModel = z.union([AuthoredModel, SyncedBaseModel]);

export type ExistingModel = z.infer<typeof ExistingModel>;
export type SyncedFullModel = Omit<z.infer<typeof AuthoredModelShape>, "id">;
export type SyncedBaseModel = Omit<z.infer<typeof SyncedBaseModel>, "id">;
export type SyncedModel = SyncedFullModel | SyncedBaseModel;

export interface SyncProvider<SourceModel> {
  id: string;
  name: string;
  modelsDir: string;
  skipCreates?: boolean;
  sourceID?(model: SourceModel): string;
  skippedNotice?(ids: string[]): string[];
  fetchModels(): Promise<unknown>;
  parseModels(raw: unknown): SourceModel[];
  translateModel(
    model: SourceModel,
    context: { existing(id: string): ExistingModel | undefined },
  ): { id: string; model: SyncedModel } | undefined;
}

export interface SyncResult {
  id: string;
  name: string;
  status: "changed" | "unchanged";
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  notices: string[];
  files: Array<{ status: "created" | "updated" | "deleted"; path: string }>;
}

export const providers: {
  "cloudflare-workers-ai": SyncProvider<any>;
  google: SyncProvider<any>;
  openrouter: SyncProvider<any>;
  ovhcloud: SyncProvider<any>;
  xai: SyncProvider<any>;
} = {
  "cloudflare-workers-ai": cloudflareWorkersAi,
  google,
  openrouter,
  ovhcloud,
  xai,
};

export const groups = {
  aggregators: ["openrouter"],
  cloudflare: ["cloudflare-workers-ai"],
  direct: ["google", "ovhcloud", "xai"],
} as const;

type ProviderID = keyof typeof providers;

interface SyncOptions {
  dryRun?: boolean;
  newOnly?: boolean;
}

export async function syncProviderByID(id: ProviderID, options: SyncOptions = {}) {
  return syncProvider(providers[id], options);
}

export async function syncProvider<SourceModel>(
  provider: SyncProvider<SourceModel>,
  options: SyncOptions = {},
): Promise<SyncResult> {
  console.log(`\nSyncing ${provider.name}...`);

  const existing = await readExisting(provider.modelsDir);
  const sourceModels = provider.parseModels(await provider.fetchModels());
  const desired = new Map<string, { model: z.infer<typeof SyncedAuthoredModel>; content: string }>();
  const skippedRemote: string[] = [];

  for (const sourceModel of sourceModels) {
    const translated = provider.translateModel(sourceModel, {
      existing(id) {
        return existing.get(`${id}.toml`)?.toml;
      },
    });
    if (translated === undefined) {
      if (provider.skipCreates) skippedRemote.push(provider.sourceID?.(sourceModel) ?? "unknown");
      continue;
    }

    const relativePath = `${translated.id}.toml`;
    if (provider.skipCreates && !existing.has(relativePath)) {
      skippedRemote.push(translated.id);
      continue;
    }

    if (desired.has(relativePath)) {
      throw new Error(`Duplicate synced model path: ${provider.id}/${relativePath}`);
    }

    const parsed = SyncedAuthoredModel.safeParse(stripUndefined({
      id: translated.id,
      ...translated.model,
    }));
    if (!parsed.success) {
      parsed.error.cause = { provider: provider.id, path: relativePath };
      throw parsed.error;
    }

    desired.set(relativePath, {
      model: parsed.data,
      content: formatToml(parsed.data),
    });
  }

  const files: SyncResult["files"] = [];
  let unchanged = 0;

  for (const [relativePath, file] of desired) {
    const filePath = path.join(provider.modelsDir, relativePath);
    const current = existing.get(relativePath);

    if (current === undefined) {
      files.push({ status: "created", path: filePath });
      if (options.dryRun) {
        console.log(`Would create ${relativePath}`);
      } else {
        await mkdir(path.dirname(filePath), { recursive: true });
        await Bun.write(filePath, file.content);
      }
      continue;
    }

    if (!sameModel(relativePath, current.authored, file.model)) {
      if (options.newOnly) {
        unchanged++;
        continue;
      }

      files.push({ status: "updated", path: filePath });
      if (options.dryRun) {
        console.log(`Would update ${relativePath}`);
      } else {
        if (current.symlink) await rm(filePath, { force: true });
        await Bun.write(filePath, file.content);
      }
    } else {
      unchanged++;
    }
  }

  for (const relativePath of existing.keys()) {
    if (desired.has(relativePath)) continue;
    if (options.newOnly) {
      console.log(`Skipping removal in new-only mode: ${relativePath}`);
      unchanged++;
      continue;
    }

    const filePath = path.join(provider.modelsDir, relativePath);
    files.push({ status: "deleted", path: filePath });
    if (options.dryRun) {
      console.log(`Would remove ${relativePath}`);
    } else {
      await rm(filePath, { force: true });
    }
  }

  const result = summarize(provider, files, unchanged, provider.skippedNotice?.(skippedRemote) ?? []);
  console.log(
    `${options.dryRun ? "Dry run: " : ""}${result.created} created, ${result.updated} updated, ${result.deleted} removed, ${result.unchanged} unchanged`,
  );
  return result;
}

export async function syncTargets(target: string, options: SyncOptions = {}) {
  const ids = target in groups
    ? groups[target as keyof typeof groups]
    : target in providers
      ? [target as ProviderID]
      : undefined;

  if (ids === undefined) {
    throw new Error(`Unknown sync target: ${target}`);
  }

  const results: SyncResult[] = [];
  for (const id of ids) {
    results.push(await syncProviderByID(id as ProviderID, options));
  }
  return results;
}

export function syncProviderMatrix() {
  return {
    include: Object.values(providers).map((provider) => ({
      provider: provider.id,
      name: provider.name,
    })),
  };
}

async function readExisting(modelsDir: string) {
  const existing = new Map<string, {
    authored: ExistingModel;
    toml: ExistingModel;
    symlink: boolean;
  }>();
  let modelMetadata: Record<string, Record<string, unknown>> | undefined;

  for (const { file, symlink } of await tomlFiles(modelsDir)) {
    const text = await Bun.file(path.join(modelsDir, file)).text();
    const parsed = ExistingModel.safeParse(Bun.TOML.parse(text));
    if (!parsed.success) {
      parsed.error.cause = { path: path.join(modelsDir, file) };
      throw parsed.error;
    }

    const authored = parsed.data;
    if (authored.base_model !== undefined && modelMetadata === undefined) {
      modelMetadata = await readModelMetadata(modelsDir);
    }
    const toml = authored.base_model === undefined
      ? authored
      : resolveBaseModel(authored, modelMetadata ?? {}, path.join(modelsDir, file));

    existing.set(file, { authored, toml, symlink });
  }

  return existing;
}

async function readModelMetadata(modelsDir: string) {
  const root = path.dirname(path.dirname(path.dirname(modelsDir)));
  const metadataDir = path.join(root, "models");
  const result: Record<string, Record<string, unknown>> = {};

  for await (const modelPath of new Bun.Glob("**/*.toml").scan({
    cwd: metadataDir,
    absolute: true,
    followSymlinks: true,
  })) {
    const modelID = path.relative(metadataDir, modelPath).slice(0, -5);
    const toml = Bun.TOML.parse(
      await Bun.file(modelPath).text(),
    ) as Record<string, unknown>;
    result[modelID] = inheritableModelMetadata(toml);
  }

  return result;
}

function resolveBaseModel(
  authored: ExistingModel,
  modelMetadata: Record<string, Record<string, unknown>>,
  modelPath: string,
) {
  const baseModelID = authored.base_model;
  if (baseModelID === undefined) return authored;

  const base = modelMetadata[baseModelID];
  if (base === undefined) {
    throw new Error(`Unable to resolve base_model: ${baseModelID}`, {
      cause: { modelPath, toml: authored },
    });
  }

  const merged = structuredClone(
    mergeDeep(
      base,
      Object.fromEntries(
        Object.entries(authored).filter(([, value]) => value !== undefined),
      ),
    ),
  ) as Record<string, unknown>;
  applyOmit(merged, authored.base_model_omit ?? []);

  const parsed = ExistingModel.safeParse(merged);
  if (!parsed.success) {
    parsed.error.cause = { modelPath, toml: merged };
    throw parsed.error;
  }
  return parsed.data;
}

function inheritableModelMetadata(model: Record<string, unknown>) {
  const {
    id: _id,
    benchmarks: _benchmarks,
    license: _license,
    links: _links,
    weights: _weights,
    ...metadata
  } = model;

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function applyOmit(target: Record<string, unknown>, paths: string[]) {
  omitLoop: for (const omit of paths) {
    const parts = omit.split(".");
    const parents: Array<{ value: Record<string, unknown>; key: string }> = [];
    let current = target;

    for (const part of parts.slice(0, -1)) {
      const next = current[part];
      if (
        next === undefined ||
        next === null ||
        typeof next !== "object" ||
        Array.isArray(next)
      ) {
        continue omitLoop;
      }
      parents.push({ value: current, key: part });
      current = next as Record<string, unknown>;
    }

    const lastPart = parts.at(-1);
    if (lastPart === undefined || !(lastPart in current)) continue;

    delete current[lastPart];

    for (let index = parents.length - 1; index >= 0; index--) {
      const parent = parents[index];
      if (parent === undefined) continue;
      const value = parent.value[parent.key];
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length > 0
      ) {
        break;
      }
      delete parent.value[parent.key];
    }
  }
}

async function tomlFiles(root: string, dir = "") {
  const result: Array<{ file: string; symlink: boolean }> = [];

  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...await tomlFiles(root, file));
    } else if (entry.name.endsWith(".toml") && (entry.isFile() || entry.isSymbolicLink())) {
      result.push({ file, symlink: entry.isSymbolicLink() });
    }
  }

  return result;
}

function summarize(
  provider: { id: string; name: string },
  files: SyncResult["files"],
  unchanged: number,
  notices: string[],
): SyncResult {
  return {
    id: provider.id,
    name: provider.name,
    status: files.length > 0 ? "changed" : "unchanged",
    created: files.filter((file) => file.status === "created").length,
    updated: files.filter((file) => file.status === "updated").length,
    deleted: files.filter((file) => file.status === "deleted").length,
    unchanged,
    notices,
    files,
  };
}

function sameModel(
  relativePath: string,
  current: ExistingModel,
  desired: z.infer<typeof SyncedAuthoredModel>,
) {
  const parsed = SyncedAuthoredModel.safeParse({
    id: relativePath.slice(0, -5),
    ...current,
  });
  return parsed.success && stable(parsed.data) === stable(desired);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map(stable);
    const ordered = value.every((item) => item === null || typeof item !== "object")
      ? items.sort()
      : items;
    return `[${ordered.join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stripUndefined) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)]),
    ) as T;
  }
  return value;
}

async function writeReport(target: string, results: SyncResult[]) {
  await mkdir(".sync", { recursive: true });

  const lines = [
    `Updates model TOMLs for the \`${target}\` sync target.`,
    "",
    "| Provider | Status | Created | Updated | Deleted |",
    "| --- | --- | ---: | ---: | ---: |",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.name} | ${result.status} | ${result.created} | ${result.updated} | ${result.deleted} |`,
    );
  }

  for (const result of results.filter((item) => item.files.length > 0)) {
    lines.push("", `<details><summary>${result.name} changed files</summary>`, "");
    for (const file of result.files) {
      lines.push(`- ${file.status}: \`${file.path}\``);
    }
    lines.push("", "</details>");
  }

  const noticeResults = results.filter((item) => item.notices.length > 0);
  if (noticeResults.length > 0) {
    lines.push("", "## Notices");
    for (const result of noticeResults) {
      lines.push("", `### ${result.name}`);
      for (const notice of result.notices) {
        lines.push(`- ${notice}`);
      }
    }
  }

  lines.push("", "This PR was created automatically by the daily model sync workflow.");
  await Bun.write(".sync/model-sync-report.md", `${lines.join("\n")}\n`);
}

function quote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function formatInteger(n: number) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

function formatNumber(n: number) {
  return Number.isInteger(n) ? formatInteger(n) : String(n);
}

function formatToml(model: z.infer<typeof SyncedAuthoredModel>) {
  const lines: string[] = [];

  if (model.base_model !== undefined) lines.push(`base_model = ${quote(model.base_model)}`);
  if (model.base_model_omit !== undefined) {
    lines.push(`base_model_omit = [${model.base_model_omit.map(quote).join(", ")}]`);
  }
  if (model.name !== undefined) lines.push(`name = ${quote(model.name)}`);
  if (model.family !== undefined) lines.push(`family = ${quote(model.family)}`);
  if (model.release_date !== undefined) lines.push(`release_date = ${quote(model.release_date)}`);
  if (model.last_updated !== undefined) lines.push(`last_updated = ${quote(model.last_updated)}`);
  if (model.attachment !== undefined) lines.push(`attachment = ${model.attachment}`);
  if (model.reasoning !== undefined) lines.push(`reasoning = ${model.reasoning}`);
  if (model.temperature !== undefined) lines.push(`temperature = ${model.temperature}`);
  if (model.tool_call !== undefined) lines.push(`tool_call = ${model.tool_call}`);
  if (model.structured_output !== undefined) {
    lines.push(`structured_output = ${model.structured_output}`);
  }
  if (model.knowledge !== undefined) lines.push(`knowledge = ${quote(model.knowledge)}`);
  if (model.open_weights !== undefined) lines.push(`open_weights = ${model.open_weights}`);
  if (model.status !== undefined) lines.push(`status = ${quote(model.status)}`);

  if (model.interleaved !== undefined) {
    lines.push("");
    if (model.interleaved === true) {
      lines.push("interleaved = true");
    } else {
      lines.push("[interleaved]");
      lines.push(`field = ${quote(model.interleaved.field)}`);
    }
  }

  if (model.cost !== undefined) {
    lines.push("", "[cost]");
    lines.push(`input = ${formatNumber(model.cost.input)}`);
    lines.push(`output = ${formatNumber(model.cost.output)}`);
    if (model.cost.reasoning !== undefined) {
      lines.push(`reasoning = ${formatNumber(model.cost.reasoning)}`);
    }
    if (model.cost.cache_read !== undefined) {
      lines.push(`cache_read = ${formatNumber(model.cost.cache_read)}`);
    }
    if (model.cost.cache_write !== undefined) {
      lines.push(`cache_write = ${formatNumber(model.cost.cache_write)}`);
    }
    if (model.cost.input_audio !== undefined) {
      lines.push(`input_audio = ${formatNumber(model.cost.input_audio)}`);
    }
    if (model.cost.output_audio !== undefined) {
      lines.push(`output_audio = ${formatNumber(model.cost.output_audio)}`);
    }

    for (const tier of model.cost.tiers ?? []) {
      lines.push("", "[[cost.tiers]]");
      lines.push(`tier = { type = ${quote(tier.tier.type)}, size = ${formatInteger(tier.tier.size)} }`);
      lines.push(`input = ${formatNumber(tier.input)}`);
      lines.push(`output = ${formatNumber(tier.output)}`);
      if (tier.reasoning !== undefined) lines.push(`reasoning = ${formatNumber(tier.reasoning)}`);
      if (tier.cache_read !== undefined) lines.push(`cache_read = ${formatNumber(tier.cache_read)}`);
      if (tier.cache_write !== undefined) lines.push(`cache_write = ${formatNumber(tier.cache_write)}`);
    }
  }

  if (model.limit !== undefined) {
    lines.push("", "[limit]");
    if (model.limit.context !== undefined) lines.push(`context = ${formatInteger(model.limit.context)}`);
    if (model.limit.input !== undefined) lines.push(`input = ${formatInteger(model.limit.input)}`);
    if (model.limit.output !== undefined) lines.push(`output = ${formatInteger(model.limit.output)}`);
  }

  if (model.modalities !== undefined) {
    lines.push("", "[modalities]");
    if (model.modalities.input !== undefined) {
      lines.push(`input = [${model.modalities.input.map(quote).join(", ")}]`);
    }
    if (model.modalities.output !== undefined) {
      lines.push(`output = [${model.modalities.output.map(quote).join(", ")}]`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--list-providers")) {
    console.log(JSON.stringify(syncProviderMatrix()));
    return;
  }

  const target = args.find((arg) => !arg.startsWith("-")) ?? "aggregators";
  const results = await syncTargets(target, {
    dryRun: args.includes("--dry-run"),
    newOnly: args.includes("--new-only"),
  });

  await writeReport(target, results);

  console.log("\nSync summary");
  for (const result of results) {
    console.log(
      `${result.name}: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`,
    );
  }
}

if (import.meta.main) await main();
