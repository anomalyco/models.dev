#!/usr/bin/env bun

/**
 * Smoke-tests all Databricks models against the AI Gateway.
 *
 * Usage:
 *   DATABRICKS_HOST=<host> DATABRICKS_TOKEN=<pat> bun run test-databricks.ts
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { readdir } from "node:fs/promises";
import path from "node:path";

const host = process.env.DATABRICKS_HOST;
const token = process.env.DATABRICKS_TOKEN;

if (!host || !token) {
  console.error("Usage: DATABRICKS_HOST=<host> DATABRICKS_TOKEN=<pat> bun run test-databricks.ts");
  process.exit(1);
}

const databricks = createOpenAICompatible({
  name: "databricks",
  baseURL: `https://${host.replace(/^https?:\/\//, "")}/ai-gateway/mlflow/v1`,
  apiKey: token,
});

const modelsDir = path.join(import.meta.dirname, "..", "models");
const models = (await readdir(modelsDir))
  .filter(f => f.endsWith(".toml"))
  .map(f => f.replace(/\.toml$/, ""));

console.log(`Testing ${models.length} models...\n`);

let passed = 0, failed = 0;
for (const modelId of models) {
  process.stdout.write(`  ${modelId}  →  `);
  try {
    const result = streamText({
      model: databricks(modelId),
      prompt: "Say hello in one word",
    });
    const text = await result.text;
    if (!text.trim()) throw new Error("empty response");
    console.log(`✓  "${text.trim()}"`);
    passed++;
  } catch (e: any) {
    console.log(`✗  ${e.message?.slice(0, 100) ?? e}`);
    if (e.cause) console.log(`     cause: ${JSON.stringify(e.cause)?.slice(0, 200)}`);
    if (e.responseBody) console.log(`     body: ${String(e.responseBody).slice(0, 200)}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
