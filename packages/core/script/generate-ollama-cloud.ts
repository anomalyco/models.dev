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

import type { Model } from "../src/schema";
import type { ModelFamily } from "../src/family";

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

type OllamaModel = Omit<Model, "id"> & {
  limit: Model["limit"] & { output?: number };
};

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
  capabilities: z.array(z.enum(["thinking", "completion", "tools", "vision"])),
});

type OllamaModelDetails = z.infer<typeof OllamaModelDetails>;

function generateToml(modelName: string, model: OllamaModel): string {
  const lines: string[] = [];

  lines.push(`name = "${modelName}"`);
  lines.push(`family = "${model.family}"`);
  lines.push(`attachment = ${model.attachment}`);
  lines.push(`reasoning = ${model.reasoning}`);
  lines.push(`tool_call = ${model.tool_call}`);
  if (model.release_date) {
    lines.push(`release_date = "${model.release_date}"`);
  }
  if (model.knowledge) {
    lines.push(`knowledge = "${model.knowledge}"`);
  }
  lines.push(`last_updated = "${model.last_updated}"`);
  lines.push(`open_weights = ${model.open_weights}`);
  lines.push("");
  lines.push("[limit]");
  lines.push(`context = ${model.limit.context}`);
  if (model.limit.output !== undefined) {
    lines.push(`output = ${model.limit.output}`);
  }
  lines.push("");
  lines.push("[modalities]");
  lines.push(`input = ${JSON.stringify(model.modalities.input)}`);
  lines.push(`output = ${JSON.stringify(model.modalities.output)}`);
  return lines.join("\n") + "\n";
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

console.log(`Fetched all models. Writing new files...`);

let created = 0;
for (const { name, data } of modelsData) {
  const fileName = modelFileName(name);
  const filePath = path.join(modelsDir, fileName);

  let existingData: Omit<Model, "id"> | null;
  try {
    const existingToml = await Bun.file(filePath).text();
    existingData = Bun.TOML.parse(existingToml) as Omit<Model, "id">;
  } catch {
    // File doesn't exist
    existingData = null;
  }

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

  await Bun.write(filePath, generateToml(name, ollamaModel));
  console.log(`Created: ${fileName}`);
  created++;
}

console.log(`\nDone. Created ${created}`);
