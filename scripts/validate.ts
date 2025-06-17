#!/usr/bin/env bun

import { join } from "path";
import { readdir, stat } from "fs/promises";
import { parse } from "@iarna/toml";
import { file } from "bun";
import { ModelSchema, ProviderSchema } from "../app/schemas";
import { z } from "zod";

async function validate() {
  const providersDir = join(import.meta.dir, "..", "providers");

  try {
    const providers = await readdir(providersDir);

    for (const provider of providers) {
      const providerPath = join(providersDir, provider);
      const providerStat = await stat(providerPath);
      if (!providerStat.isDirectory()) continue;

      console.log(`Checking provider: ${provider}`);

      // Validate provider.toml
      const providerTomlPath = join(providerPath, "provider.toml");
      const providerTomlFile = file(providerTomlPath);
      const providerExists = await providerTomlFile.exists();
      if (!providerExists)
        throw new Error(`Missing provider.toml in ${provider}`);

      // Validate provider.toml against schema
      const providerContent = parse(await providerTomlFile.text());
      validateSchema(ProviderSchema, providerContent, providerTomlPath);

      // Check for models directory
      const modelsPath = join(providerPath, "models");
      const modelsStat = await stat(modelsPath);
      if (!modelsStat.isDirectory()) {
        throw new Error(`Missing "models" directory in ${provider}`);
      }

      // Validate model files
      const modelFiles = await readdir(modelsPath);
      const tomlFiles = modelFiles.filter((file) => file.endsWith(".toml"));
      if (tomlFiles.length === 0) {
        throw new Error(`No model files found in ${provider}/models`);
      }

      for (const modelFile of tomlFiles) {
        const modelPath = join(modelsPath, modelFile);
        console.log(`  Checking model: ${modelFile}`);

        const modelTomlFile = file(modelPath);
        const modelContent = parse(await modelTomlFile.text());
        validateSchema(ModelSchema, modelContent, modelPath);
      }
    }

    console.log("\n✅ All providers and models validated successfully!");
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
}

function validateSchema(schema, data, filePath) {
  try {
    schema.parse(data);
  } catch (validationError) {
    if (validationError instanceof z.ZodError) {
      const errors = validationError.errors
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join(", ");
      throw new Error(`Validation failed for ${filePath}: ${errors}`);
    }
    throw validationError;
  }
}

validate();
