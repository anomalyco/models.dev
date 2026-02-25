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

// Generate search index and model shards
console.log("Generating search assets...");

// 1. Generate search index (lightweight)
const searchIndex: Array<{ p: string; m: string; n: string }> = [];
for (const [providerId, provider] of Object.entries(Providers)) {
  for (const [modelId, model] of Object.entries(provider.models)) {
    searchIndex.push({
      p: providerId,
      m: modelId,
      n: model.name,
    });
  }
}
await Bun.write("./dist/_search-index.json", JSON.stringify(searchIndex));
console.log(`  Generated _search-index.json (${searchIndex.length} models)`);

// 2. Generate providers metadata (without models)
const providersMeta: Record<
  string,
  { id: string; name: string; env: string[]; npm: string; api?: string; doc: string }
> = {};
for (const [providerId, provider] of Object.entries(Providers)) {
  providersMeta[providerId] = provider
}
await Bun.write("./dist/_providers.json", JSON.stringify(providersMeta));
console.log(`  Generated _providers.json (${Object.keys(providersMeta).length} providers)`);

// 3. Generate model shards (individual files per model)
await fs.mkdir("./dist/_models", { recursive: true });
let modelCount = 0;
for (const [providerId, provider] of Object.entries(Providers)) {
  await fs.mkdir(`./dist/_models/${providerId}`, { recursive: true });
  for (const [modelId, model] of Object.entries(provider.models)) {
    // Sanitize modelId for filesystem (replace / with __)
    const safeModelId = modelId.replace(/\//g, "__");
    await Bun.write(
      `./dist/_models/${providerId}/${safeModelId}.json`,
      JSON.stringify(model)
    );
    modelCount++;
  }
}
console.log(`  Generated _models/ (${modelCount} model files)`);
