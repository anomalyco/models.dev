#!/usr/bin/env bun

import { Rendered, Providers } from "../src/render";
import fs from "fs/promises";
import path from "path";
import { $ } from "bun";

await fs.rm("./dist", { recursive: true, force: true });
await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "dist",
  target: "bun",
});

for await (const file of new Bun.Glob("./public/*").scan()) {
  await Bun.write(file.replace("./public/", "./dist/"), Bun.file(file));
}

// Copy provider logos to dist/logos/
await fs.mkdir("./dist/logos", { recursive: true });

// First, copy the default logo
const defaultLogoPath = "../../providers/logo.svg";
const defaultLogo = Bun.file(defaultLogoPath);
if (await defaultLogo.exists()) {
  await Bun.write("./dist/logos/default.svg", defaultLogo);
}

// Then copy provider-specific logos
const providersDir = "../../providers";
const entries = await fs.readdir(providersDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory()) {
    const provider = entry.name;
    const logoPath = path.join(providersDir, provider, "logo.svg");
    const logoFile = Bun.file(logoPath);

    if (await logoFile.exists()) {
      await Bun.write(`./dist/logos/${provider}.svg`, logoFile);
    }
  }
}

let html = await Bun.file("./dist/index.html").text();
html = html.replace("<!--static-->", Rendered);
await Bun.write("./dist/index.html", html);
await Bun.write("./dist/api.json", JSON.stringify(Providers));

await $`mv ./dist/index.html ./dist/_index.html`;
await $`mv ./dist/api.json ./dist/_api.json`;

// Build per-provider API files
await fs.mkdir("./dist/_api", { recursive: true });
const providerEntries = Object.entries(Providers);
for (const [providerId, provider] of providerEntries) {
  await Bun.write(
    `./dist/_api/${providerId}.json`,
    JSON.stringify({ [providerId]: provider }),
  );
}

// Build model index: model ID → { providers[], capabilities }
const modelIndex: Record<
  string,
  {
    name: string;
    providers: string[];
    tool_call: boolean;
    reasoning: boolean;
    modalities: { input: string[]; output: string[] };
    open_weights: boolean;
    structured_output?: boolean;
  }
> = {};
for (const [providerId, provider] of providerEntries) {
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (!modelIndex[modelId]) {
      modelIndex[modelId] = {
        name: model.name,
        providers: [],
        tool_call: model.tool_call,
        reasoning: model.reasoning,
        modalities: model.modalities,
        open_weights: model.open_weights,
        structured_output: model.structured_output,
      };
    }
    // sanity check: conflicting capabilities across providers
    const entry = modelIndex[modelId];
    if (entry.name !== model.name) {
      console.warn(
        `Model name mismatch for "${modelId}": "${entry.name}" vs "${model.name}" (${providerId})`,
      );
    }
    entry.providers.push(providerId);
  }
}
await Bun.write("./dist/_api/models.json", JSON.stringify(modelIndex));

// Build JSON Schema for the full API shape
const providerNames = providerEntries
  .sort(([, a], [, b]) => a.name.localeCompare(b.name))
  .map(([id]) => id);

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://models.dev/api/schema.json",
  title: "Models.dev",
  description: "Open-source database of AI model specifications and pricing",
  type: "object",
  additionalProperties: {
    $ref: "#/$defs/Provider",
  },
  $defs: {
    Provider: {
      type: "object",
      properties: {
        id: { type: "string", enum: providerNames },
        name: { type: "string" },
        env: { type: "array", items: { type: "string" } },
        npm: { type: "string" },
        api: { type: "string" },
        doc: { type: "string", format: "uri" },
        models: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/Model" },
        },
      },
      required: ["id", "name", "env", "npm", "doc", "models"],
    },
    Model: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        family: { type: "string" },
        attachment: { type: "boolean" },
        reasoning: { type: "boolean" },
        tool_call: { type: "boolean" },
        structured_output: { type: "boolean" },
        temperature: { type: "boolean" },
        open_weights: { type: "boolean" },
        release_date: { type: "string" },
        last_updated: { type: "string" },
        knowledge: { type: "string" },
        modalities: {
          type: "object",
          properties: {
            input: {
              type: "array",
              items: { type: "string", enum: ["text", "audio", "image", "video", "pdf"] },
            },
            output: {
              type: "array",
              items: { type: "string", enum: ["text", "audio", "image", "video", "pdf"] },
            },
          },
        },
        cost: { $ref: "#/$defs/Cost" },
        limit: { $ref: "#/$defs/Limit" },
        status: { type: "string", enum: ["alpha", "beta", "deprecated"] },
      },
      required: ["id", "name", "modalities", "limit"],
    },
    Cost: {
      type: "object",
      properties: {
        input: { type: "number" },
        output: { type: "number" },
        reasoning: { type: "number" },
        cache_read: { type: "number" },
        cache_write: { type: "number" },
        input_audio: { type: "number" },
        output_audio: { type: "number" },
        context_over_200k: { $ref: "#/$defs/Cost" },
      },
    },
    Limit: {
      type: "object",
      properties: {
        context: { type: "integer" },
        input: { type: "integer" },
        output: { type: "integer" },
      },
      required: ["context", "output"],
    },
  },
};
await Bun.write("./dist/_api/schema.json", JSON.stringify(schema, null, 2));

// Build provider list: lightweight index of all providers
const providerList = providerEntries
  .sort(([, a], [, b]) => a.name.localeCompare(b.name))
  .map(([id, provider]) => ({
    id,
    name: provider.name,
    doc: provider.doc,
    model_count: Object.keys(provider.models).length,
    npm: provider.npm,
    api: provider.api,
  }));
await Bun.write("./dist/_api/providers.json", JSON.stringify(providerList));
