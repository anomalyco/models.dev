#!/usr/bin/env bun

// Rewrites v1 TOML files into the v2 format, one lab at a time.
//   bun packages/core/script/migrate-v2.ts lab <lab-id>

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ModelMetadata } from "../src/schema.js";
import { isSchemaV2, labModelV2ToV1 } from "../src/translate.js";

const root = path.join(import.meta.dirname, "..", "..", "..");
const RAW_TABLES = /^\[\[(benchmarks|links|weights)\]\]\s*$/;

const [kind, id] = process.argv.slice(2);
if (kind !== "lab" || id === undefined) {
  console.error("Usage: bun packages/core/script/migrate-v2.ts lab <lab-id>");
  process.exit(1);
}

const labDir = path.join(root, "models", id);
let migrated = 0;
for await (const file of new Bun.Glob("**/*.toml").scan({ cwd: labDir, absolute: true })) {
  const text = await Bun.file(file).text();
  const toml = Bun.TOML.parse(text) as Record<string, unknown>;
  if (isSchemaV2(toml)) continue;

  const modelID = path.relative(path.join(root, "models"), file).slice(0, -5);
  const before = ModelMetadata.parse({ ...toml, id: modelID });
  const next = formatLabModel(text, before);

  const after = ModelMetadata.parse(
    labModelV2ToV1({ ...(Bun.TOML.parse(next) as Record<string, unknown>), id: modelID }, { file }),
  );
  if (!isDeepStrictEqual(before, after)) {
    console.error(JSON.stringify({ before, after }, null, 2));
    throw new Error(`Round trip changed ${modelID}`);
  }

  await Bun.write(file, next);
  migrated++;
}
console.log(`Migrated ${migrated} files in models/${id}`);

function formatLabModel(text: string, model: ModelMetadata) {
  const lines = text.split("\n");
  const header = leadingComments(lines);
  const tailStart = lines.findIndex((line) => RAW_TABLES.test(line));
  const body = lines.slice(header.length, tailStart === -1 ? undefined : tailStart);
  const tail = tailStart === -1 ? [] : lines.slice(tailStart);

  if (body.some((line) => line.trim().startsWith("#"))) {
    throw new Error(`${model.id}: comments outside the header would be lost`);
  }
  if (tail.some((line) => /^\[[^[]/.test(line))) {
    throw new Error(`${model.id}: tables after [[benchmarks]], [[links]], or [[weights]]`);
  }
  for (const field of ["release_date", "open_weights", "modalities", "limit"] as const) {
    if (model[field] === undefined) throw new Error(`${model.id}: missing ${field}`);
  }
  if (model.tool_call === undefined || model.reasoning === undefined) {
    throw new Error(`${model.id}: missing tool_call or reasoning`);
  }

  const out: string[] = [...header, "schema = 2"];
  if (model.type !== undefined) out.push(`type = ${quote(model.type)}`);
  out.push(`name = ${quote(model.name)}`);
  out.push(`description = ${quote(model.description)}`);
  if (model.family !== undefined) out.push(`family = ${quote(model.family)}`);
  out.push(`open_weights = ${model.open_weights}`);
  if (model.knowledge !== undefined) out.push(`knowledge = ${quote(model.knowledge)}`);
  out.push(`release_date = ${quote(model.release_date!)}`);
  if (model.last_updated !== undefined && model.last_updated !== model.release_date) {
    out.push(`last_updated = ${quote(model.last_updated)}`);
  }
  if (model.license !== undefined) out.push(`license = ${quote(model.license)}`);

  const modality = (value: string) => quote(value === "pdf" ? "application/pdf" : value);
  out.push(
    "",
    "[modalities]",
    `input = [${model.modalities!.input.map(modality).join(", ")}]`,
    `output = [${model.modalities!.output.map(modality).join(", ")}]`,
  );

  out.push(
    "",
    "[capabilities]",
    `tools = { supported = ${model.tool_call} }`,
    `reasoning = { supported = ${model.reasoning} }`,
  );
  if (model.structured_output !== undefined) {
    out.push(`structured_output = ${model.structured_output}`);
  }
  if (model.temperature !== undefined) out.push(`temperature = ${model.temperature}`);

  out.push("", "[limit]", `context = ${formatInteger(model.limit!.context)}`);
  if (model.limit!.input !== undefined) out.push(`input = ${formatInteger(model.limit!.input)}`);
  if (model.limit!.output !== undefined) out.push(`output = ${formatInteger(model.limit!.output)}`);

  if (tail.length > 0) out.push("", ...tail);
  return `${out.join("\n").trimEnd()}\n`;
}

function leadingComments(lines: string[]) {
  const header: string[] = [];
  for (const line of lines) {
    if (line.trim() !== "" && !line.trim().startsWith("#")) break;
    header.push(line);
  }
  while (header.length > 0 && header.at(-1)?.trim() === "") header.pop();
  return header;
}

function quote(value: string) {
  return JSON.stringify(value);
}

function formatInteger(n: number) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}
