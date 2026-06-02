import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { z } from "zod";

import { AuthoredModel, AuthoredModelShape } from "../schema.js";
import { cloudflareWorkersAi } from "./providers/cloudflare-workers-ai.js";
import { google } from "./providers/google.js";
import { openrouter } from "./providers/openrouter.js";
import { ovhcloud } from "./providers/ovhcloud.js";
import { xai } from "./providers/xai.js";

const ExtendsConfig = z
  .object({
    from: z.string(),
    omit: z.array(z.string()).optional(),
  })
  .strict();

const ExistingExtendsConfig = z
  .object({
    from: z.string(),
    omit: z.array(z.string()).optional(),
  })
  .passthrough();

const ExistingModel = AuthoredModelShape.partial()
  .extend({
    extends: ExistingExtendsConfig.optional(),
  })
  .strict();

const SyncedExtendsModel = AuthoredModelShape.partial()
  .extend({
    id: z.string(),
    extends: ExtendsConfig,
  })
  .strict();

const SyncedAuthoredModel = z.union([AuthoredModel, SyncedExtendsModel]);

export type ExistingModel = z.infer<typeof ExistingModel>;
export type SyncedFullModel = Omit<z.infer<typeof AuthoredModelShape>, "id">;
export type SyncedExtendsModel = Omit<z.infer<typeof SyncedExtendsModel>, "id">;
export type SyncedModel = SyncedFullModel | SyncedExtendsModel;

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

    const parsed = SyncedAuthoredModel.safeParse({
      id: translated.id,
      ...translated.model,
    });
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

    if (!sameModel(relativePath, current.toml, file.model)) {
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
  const existing = new Map<string, { text: string; toml: ExistingModel; symlink: boolean }>();

  for (const { file, symlink } of await tomlFiles(modelsDir)) {
    const text = await Bun.file(path.join(modelsDir, file)).text();
    const parsed = ExistingModel.safeParse(Bun.TOML.parse(text));
    if (!parsed.success) {
      parsed.error.cause = { path: path.join(modelsDir, file) };
      throw parsed.error;
    }
    existing.set(file, { text, toml: parsed.data, symlink });
  }

  return existing;
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
  const extendsLines: string[] = [];

  if ("extends" in model) {
    extendsLines.push("[extends]");
    extendsLines.push(`from = ${quote(model.extends.from)}`);
    if (model.extends.omit !== undefined) {
      extendsLines.push(`omit = [${model.extends.omit.map(quote).join(", ")}]`);
    }
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

  if (extendsLines.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...extendsLines);
  }

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
      lines.push(`tier = { size = ${formatInteger(tier.tier.size)} }`);
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
