#!/usr/bin/env bun

/**
 * Generates model files from the data in Ollama Cloud's API.
 *
 * Ollama Cloud does not provide some data fields, such as release date or
 * knowledge cutoff. The `family` field provided by Ollama Cloud may not match
 * the values in family.ts. We expect that when TOML validaton fails, the
 * maintainer will manually source those data points (such as from other
 * provider TOML files, or from the internet at large). This script preserves
 * those fields when overwriting Ollama Cloud's TOML files.
 */

import { z } from "zod";
import path from "node:path";

import { formatModelV2, patchModelV2, providerModelToV2, resolvedFlags } from "../src/model-file-v2";
import { modelV2ToV1, readLabModel } from "../src/translate";
import { ReasoningOption, type Model } from "../src/schema";
import type { ModelFamily } from "../src/family";

const labsDir = path.join(import.meta.dirname, "..", "..", "..", "models");
const modelsDir = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "providers",
  "ollama-cloud",
  "models"
);

function modelFileName(modelName: string): string {
  return modelName + ".toml";
}

type OllamaModel = Omit<Model, "id" | "description" | "release_date" | "limit"> & {
  description?: Model["description"];
  release_date?: Model["release_date"];
  limit: Omit<Model["limit"], "output"> & { output?: number };
};

type ComparableModel = Pick<Model,
  | "attachment"
  | "reasoning"
  | "tool_call"
  | "knowledge"
  | "open_weights"
  | "modalities"
> & {
  limit: Pick<Model["limit"], "context">;
};

function normalizeForComparison(model: OllamaModel | Omit<Model, "id">): ComparableModel {
  return {
    attachment: model.attachment,
    reasoning: model.reasoning,
    tool_call: model.tool_call,
    knowledge: model.knowledge,
    open_weights: model.open_weights,
    limit: { context: model.limit.context },
    modalities: model.modalities,
  };
}

const OllamaTagsResponse = z.object({
  models: z.array(
    z.object({
      name: z.string(),
    })
  ),
});

type OllamaTagsResponse = z.infer<typeof OllamaTagsResponse>;

const OllamaModelDetails = z.object({
  modified_at: z.string(),
  details: z.object({
    parent_model: z.string(),
    format: z.string(),
    family: z.string(),
    families: z.array(z.string()).nullable(),
    parameter_size: z.string().transform(Number),
    quantization_level: z.string(),
  }),
  model_info: z.record(z.union([z.string(), z.number()])),
  capabilities: z.array(z.string()),
  thinking: z.object({ values: z.array(z.union([z.boolean(), z.string()])) }).nullish(),
});

type OllamaModelDetails = z.infer<typeof OllamaModelDetails>;

function leadingComments(text: string): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() !== "" && !line.trim().startsWith("#")) break;
    lines.push(line);
  }
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

const tagsResponse = await fetch("https://ollama.com/api/tags");
if (!tagsResponse.ok) {
  console.error(
    `Failed to fetch tags: ${tagsResponse.status} ${tagsResponse.statusText}`
  );
  process.exit(1);
}

const tagsJson = await tagsResponse.json();
const tagsParsed = OllamaTagsResponse.safeParse(tagsJson);
if (!tagsParsed.success) {
  console.error("Invalid tags response:", tagsParsed.error.errors);
  process.exit(1);
}
const tagsData: OllamaTagsResponse = tagsParsed.data;
const modelNames = tagsData.models.map((m) => m.name);

console.log(`Fetching details for ${modelNames.length} models...`);

const modelsData: Array<{ name: string; data: OllamaModelDetails }> = [];
for (const modelName of modelNames) {
  const showResponse = await fetch("https://ollama.com/api/show", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName }),
  });

  if (!showResponse.ok) {
    console.error(
      `Failed to fetch details for ${modelName}: ${showResponse.status} ${showResponse.statusText}`
    );
    process.exit(1);
  }

  const showJson = await showResponse.json();
  const showParsed = OllamaModelDetails.safeParse(showJson);
  if (!showParsed.success) {
    console.error(
      `Invalid response for ${modelName}:`,
      showParsed.error.errors
    );
    process.exit(1);
  }

  modelsData.push({ name: modelName, data: showParsed.data });
}

console.log(`Fetched all models. Syncing files...`);

const existingFiles = Array.from(new Bun.Glob("*.toml").scanSync(modelsDir));
const existingModelNames = new Set(existingFiles.map((f) => f.replace(/\.toml$/, "")));
const apiModelNames = new Set(modelNames);

let deleted = 0;
for (const existingName of existingModelNames) {
  if (!apiModelNames.has(existingName)) {
    const filePath = path.join(modelsDir, modelFileName(existingName));
    await Bun.file(filePath).delete();
    console.log(`Deleted: ${modelFileName(existingName)}`);
    deleted++;
  }
}

let created = 0;
let skipped = 0;
let needsControls = 0;
let needsManual = 0;
for (const { name, data } of modelsData) {
  const fileName = modelFileName(name);
  const filePath = path.join(modelsDir, fileName);

  let existingText: string | null = null;
  try {
    existingText = await Bun.file(filePath).text();
  } catch {
    // File doesn't exist
  }

  const doc = existingText === null ? null : (Bun.TOML.parse(existingText) as Record<string, any>);

  // Only chat and decision models are synced; anything else needs a person.
  if (!data.capabilities.includes("completion") && !data.capabilities.includes("decision")) {
    console.warn(`Needs manual authoring (not a chat or decision model: ${data.capabilities.join(", ")}): ${fileName}`);
    needsManual++;
    continue;
  }

  // Decision models are served on POST /v1/systemone, not chat completions, so
  // they're v2-only. The catalog gives no lab identity, so only an existing
  // hand-authored decision file is synced.
  if (data.capabilities.includes("decision")) {
    const type = doc?.type
      ?? (doc?.base_model === undefined ? undefined : readLabModel(path.join(labsDir, `${doc.base_model}.toml`), doc.base_model).type);
    if (doc === null || type !== "decision") {
      console.warn(`Needs manual authoring (decision model without a decision file): ${fileName}`);
      needsManual++;
      continue;
    }
    const content = leadingComments(existingText!) + formatModelV2({ ...doc, v2_only: true });
    if (content === existingText) {
      console.log(`Skipped (no changes): ${fileName}`);
      skipped++;
      continue;
    }
    await Bun.write(filePath, content);
    console.log(`Created: ${fileName}`);
    created++;
    continue;
  }
  const { id: _id, ...before }: Record<string, any> =
    doc === null ? {} : modelV2ToV1({ ...doc, id: name });
  const lab: Record<string, any> =
    doc?.base_model === undefined
      ? {}
      : readLabModel(path.join(labsDir, `${doc.base_model}.toml`), doc.base_model);
  const existingData = doc === null
    ? null
    : ({
        ...lab,
        ...before,
        limit: { ...lab.limit, ...before.limit },
      } as Omit<Model, "id">);

  const family = existingData?.family ?? (data.details.family as ModelFamily);
  const contextLength =
    (data.model_info[`${data.details.family}.context_length`] as number) ?? 0;

  const ollamaModel: OllamaModel = {
    name,
    family,
    attachment: data.capabilities.includes("vision"),
    reasoning: data.capabilities.includes("thinking"),
    tool_call: data.capabilities.includes("tools"),
    release_date: existingData?.release_date,
    knowledge: existingData?.knowledge,
    last_updated: new Date().toISOString().slice(0, 10),
    open_weights: true,
    modalities: {
      input: data.capabilities.includes("vision")
        ? ["text", "image"]
        : ["text"],
      output: ["text"],
    },
    limit: {
      context: contextLength,
      output: existingData?.limit.output,
    },
  };

  let content: string;
  if (doc === null) {
    if (ollamaModel.reasoning) {
      const values = data.thinking?.values;
      if (values === undefined) {
        console.warn(`Needs reasoning controls (no thinking values in /api/show), not written: ${fileName}`);
        needsControls++;
        continue;
      }
      const effort = values.filter((value): value is string => typeof value === "string");
      ollamaModel.reasoning_options = [
        ...(values.includes(false) ? [{ type: "toggle" as const }] : []),
        ...(effort.length > 0 ? [{ type: "effort" as const, values: effort }] : []),
      ].map((option) => ReasoningOption.parse(option));
    }
    content = formatModelV2(providerModelToV2(ollamaModel));
  } else {
    const after: Record<string, any> = { ...before };
    const existing = normalizeForComparison(existingData!);
    const incoming = normalizeForComparison(ollamaModel);
    for (const key of ["reasoning", "tool_call", "knowledge", "open_weights", "modalities"] as const) {
      if (!Bun.deepEquals(existing[key], incoming[key])) after[key] = incoming[key];
    }
    if (existing.limit.context !== incoming.limit.context) {
      after.limit = { ...after.limit, context: incoming.limit.context };
    }
    if (Bun.deepEquals(after, before)) {
      console.log(`Skipped (no changes): ${fileName}`);
      skipped++;
      continue;
    }
    if (after.last_updated !== undefined) after.last_updated = ollamaModel.last_updated;
    const next = patchModelV2(doc, before, after, {
      before: resolvedFlags(before, lab),
      after: resolvedFlags(after, lab),
    });
    content = leadingComments(existingText!) + formatModelV2(next);
  }
  await Bun.write(filePath, content);
  console.log(`Created: ${fileName}`);
  created++;
}

console.log(
  `\nDone. Created: ${created}, Skipped: ${skipped}, Deleted: ${deleted}, Needs reasoning controls: ${needsControls}, Needs manual authoring: ${needsManual}`
);
