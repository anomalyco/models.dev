#!/usr/bin/env bun

import { join } from "path";
import { readdir, stat, writeFile, mkdir } from "fs/promises";
import { parse } from "@iarna/toml";
import { file } from "bun";

async function build() {
  const providersDir = join(import.meta.dir, "..", "providers");
  const distDir = join(import.meta.dir, "..", "dist");
  const outputPath = join(distDir, "api.json");
  const result = {} as Record<string, any>;

  try {
    const providers = await readdir(providersDir);

    for (const provider of providers) {
      const providerPath = join(providersDir, provider);
      const providerStat = await stat(providerPath);
      if (!providerStat.isDirectory()) continue;

      console.log(`Processing provider: ${provider}`);

      // Read provider.toml
      const providerTomlFile = file(join(providerPath, "provider.toml"));
      const providerContent = parse(await providerTomlFile.text());
      result[provider] = {
        ...providerContent,
        id: provider,
        models: {},
      };

      // Process models
      const modelsPath = join(providerPath, "models");
      const modelFiles = await readdir(modelsPath);
      const tomlFiles = modelFiles.filter((file) => file.endsWith(".toml"));

      for (const modelFile of tomlFiles) {
        const modelPath = join(modelsPath, modelFile);
        console.log(`  Processing model: ${modelFile}`);

        const modelTomlFile = file(modelPath);
        const modelContent = parse(await modelTomlFile.text());

        // Use filename without extension as the model ID
        const modelId = modelFile.replace(/\.toml$/, "").replace(/%2F/g, "/");
        result[provider].models[modelId] = {
          ...modelContent,
          id: modelId,
        };
      }
    }

    // Write the result to data.json
    await mkdir(distDir, { recursive: true });
    await writeFile(outputPath, JSON.stringify(result));
    console.log(
      `\n✅ Successfully built data.json with ${
        Object.keys(result).length
      } providers`,
    );
  } catch (err) {
    if (err instanceof Error) {
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  }
}

build();
