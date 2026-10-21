#!/usr/bin/env bun

// Rewrites v1 TOML files into the v2 format, one lab or provider at a time.
//   bun packages/core/script/migrate-v2.ts lab <lab-id>
//   bun packages/core/script/migrate-v2.ts provider <provider-id>

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  formatModelV2,
  formatTomlValue,
  providerModelToV2,
  sameV1Model,
} from "../src/model-file-v2.js";
import { resolveProtocol } from "../src/generate-v2.js";
import { ModelMetadata, type Model, type Provider } from "../src/schema.js";
import { isSchemaV2, labModelV2ToV1, modelV2ToV1, readLabModel } from "../src/translate.js";

const root = path.join(import.meta.dirname, "..", "..", "..");
const RAW_TABLES = /^\[\[(benchmarks|links|weights)\]\]\s*$/;

const [kind, id] = process.argv.slice(2);
if ((kind !== "lab" && kind !== "provider") || id === undefined) {
  console.error("Usage: bun packages/core/script/migrate-v2.ts <lab|provider> <id>");
  process.exit(1);
}

const dir =
  kind === "lab" ? path.join(root, "models", id) : path.join(root, "providers", id, "models");
const providerToml =
  kind === "provider"
    ? ({
        ...(Bun.TOML.parse(
          await Bun.file(path.join(root, "providers", id, "provider.toml")).text(),
        ) as Record<string, unknown>),
        id,
      } as unknown as Provider)
    : undefined;
let migrated = 0;
for await (const file of new Bun.Glob("**/*.toml").scan({ cwd: dir, absolute: true })) {
  const text = await Bun.file(file).text();
  const toml = Bun.TOML.parse(text) as Record<string, unknown>;
  if (isSchemaV2(toml)) continue;

  const base = kind === "lab" ? path.join(root, "models") : dir;
  const modelID = path.relative(base, file).slice(0, -5);
  const next = kind === "lab" ? migrateLab(text, toml, modelID) : migrateProvider(text, toml, modelID);
  await Bun.write(file, next);
  migrated++;
}
console.log(`Migrated ${migrated} files in ${path.relative(root, dir)}`);

function migrateLab(text: string, toml: Record<string, unknown>, modelID: string) {
  const before = ModelMetadata.parse({ ...toml, id: modelID });
  const next = formatLabModel(text, before);
  const after = ModelMetadata.parse(
    labModelV2ToV1({ ...(Bun.TOML.parse(next) as Record<string, unknown>), id: modelID }),
  );
  if (!isDeepStrictEqual(before, after)) {
    console.error(JSON.stringify({ before, after }, null, 2));
    throw new Error(`Round trip changed ${modelID}`);
  }
  return next;
}

function migrateProvider(text: string, toml: Record<string, unknown>, modelID: string) {
  const { header, body, tail } = splitFile(text);
  if (body.some((line) => line.trim().startsWith("#")) || tail.length > 0) {
    throw new Error(`${modelID}: comments or raw tables outside the header would be lost`);
  }
  // v1 effort `null` (or "null") means "reasoning off"; v2 has no such effort value.
  const efforts = (toml.reasoning_options as { type: string; values?: unknown[] }[] | undefined) ?? [];
  if (efforts.some((option) => option.type === "effort" && option.values?.some((v) => v === null || v === "null"))) {
    throw new Error(`${modelID}: effort value null has no v2 form; write reasoning off as a toggle first`);
  }
  // v2 modalities replace the base's as a whole, so a v1 file that overrides only
  // `input` or `output` takes the other side from its base model.
  const modalities = toml.modalities as Record<string, unknown> | undefined;
  if (modalities !== undefined && (modalities.input === undefined || modalities.output === undefined)) {
    const base = readLabModel(path.join(root, "models", `${toml.base_model}.toml`), String(toml.base_model));
    toml.modalities = { ...(base.modalities as object), ...modalities };
    // Same as the base: inherit it, which keeps the lab's MIME types in v2.
    if (isDeepStrictEqual(toml.modalities, base.modalities)) delete toml.modalities;
  }
  // v2 derives `attachment` from modalities, so an override that disagrees with
  // the modalities (its own or inherited) can't be kept.
  if (toml.base_model !== undefined && (toml.attachment !== undefined || toml.modalities !== undefined)) {
    const base = readLabModel(path.join(root, "models", `${toml.base_model}.toml`), String(toml.base_model));
    const attachment = toml.attachment ?? base.attachment;
    const input =
      (toml.modalities as { input?: string[] } | undefined)?.input ??
      (base.modalities as { input?: string[] } | undefined)?.input ??
      [];
    if (attachment !== undefined && attachment !== input.some((modality) => modality !== "text")) {
      throw new Error(`${modelID}: attachment = ${attachment} disagrees with the modalities`);
    }
  }
  const provider = toml.provider as { npm?: string; shape?: "responses" | "completions" } | undefined;
  const protocol = resolveProtocol(
    { ...toml, id: modelID } as unknown as Model,
    providerToml!,
    provider?.npm ?? providerToml!.npm,
    provider?.shape,
  );
  const next = [...header, formatModelV2(providerModelToV2(toml, protocol))].join("\n");
  const after = modelV2ToV1({ ...(Bun.TOML.parse(next) as Record<string, unknown>), id: modelID });
  if (!sameV1Model(toml, after)) {
    console.error(JSON.stringify({ before: toml, after }, null, 2));
    throw new Error(`Round trip changed ${modelID}`);
  }
  return next;
}

function formatLabModel(text: string, model: ModelMetadata) {
  const { header, body, tail } = splitFile(text);
  if (body.some((line) => line.trim().startsWith("#"))) {
    throw new Error(`${model.id}: comments outside the header would be lost`);
  }
  for (const field of ["release_date", "open_weights", "modalities", "limit"] as const) {
    if (model[field] === undefined) throw new Error(`${model.id}: missing ${field}`);
  }
  if (model.tool_call === undefined || model.reasoning === undefined) {
    throw new Error(`${model.id}: missing tool_call or reasoning`);
  }
  if (model.temperature === undefined) {
    throw new Error(`${model.id}: missing temperature (v2 lab files require it)`);
  }

  const out: string[] = [...header, "schema = 2"];
  out.push(...identityLines(model));
  out.push(...modalityLines(model.modalities!));
  out.push(
    "",
    "[capabilities]",
    `tools = { supported = ${model.tool_call} }`,
    `reasoning = { supported = ${model.reasoning} }`,
  );
  if (model.structured_output !== undefined) {
    throw new Error(`${model.id}: move structured_output to the provider files first`);
  }
  // v2 lab files require top_p and top_k, which v1 doesn't have. They start out
  // matching temperature; check them against the lab's docs after migrating.
  out.push(
    `temperature = ${model.temperature}`,
    `top_p = ${model.temperature}`,
    `top_k = ${model.temperature}`,
  );
  out.push(...limitLines(model.limit!));
  if (tail.length > 0) out.push("", ...tail);
  return `${out.join("\n").trimEnd()}\n`;
}

function identityLines(model: Record<string, any>) {
  const out: string[] = [];
  if (model.type !== undefined) out.push(`type = ${quote(model.type)}`);
  if (model.name !== undefined) out.push(`name = ${quote(model.name)}`);
  if (model.description !== undefined) out.push(`description = ${quote(model.description)}`);
  if (model.family !== undefined) out.push(`family = ${quote(model.family)}`);
  if (model.open_weights !== undefined) out.push(`open_weights = ${model.open_weights}`);
  if (model.knowledge !== undefined) out.push(`knowledge = ${quote(model.knowledge)}`);
  if (model.release_date !== undefined) out.push(`release_date = ${quote(model.release_date)}`);
  if (model.last_updated !== undefined && model.last_updated !== model.release_date) {
    out.push(`last_updated = ${quote(model.last_updated)}`);
  }
  if (model.license !== undefined) out.push(`license = ${quote(model.license)}`);
  return out;
}

function modalityLines(modalities: { input: string[]; output: string[] }) {
  const modality = (value: string) => quote(value === "pdf" ? "application/pdf" : value);
  return [
    "",
    "[modalities]",
    `input = [${modalities.input.map(modality).join(", ")}]`,
    `output = [${modalities.output.map(modality).join(", ")}]`,
  ];
}

function limitLines(limit: { context?: number; input?: number; output?: number }) {
  const out = ["", "[limit]"];
  if (limit.context !== undefined) out.push(`context = ${formatNumber(limit.context)}`);
  if (limit.input !== undefined) out.push(`input = ${formatNumber(limit.input)}`);
  if (limit.output !== undefined) out.push(`output = ${formatNumber(limit.output)}`);
  return out;
}

function splitFile(text: string) {
  const lines = text.split("\n");
  const header: string[] = [];
  for (const line of lines) {
    if (line.trim() !== "" && !line.trim().startsWith("#")) break;
    header.push(line);
  }
  while (header.length > 0 && header.at(-1)?.trim() === "") header.pop();
  const tailStart = lines.findIndex((line) => RAW_TABLES.test(line));
  const body = lines.slice(header.length, tailStart === -1 ? undefined : tailStart);
  const tail = tailStart === -1 ? [] : lines.slice(tailStart);
  if (tail.some((line) => /^\[[^[]/.test(line))) {
    throw new Error("tables after [[benchmarks]], [[links]], or [[weights]]");
  }
  return { header, body, tail };
}

const inline = formatTomlValue;

function quote(value: string) {
  return JSON.stringify(value);
}

function formatNumber(n: number) {
  return formatTomlValue(n);
}
