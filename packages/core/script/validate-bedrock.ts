#!/usr/bin/env bun

import path from "node:path";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { generate } from "../src/generate.js";

const REGIONS = ["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"] as const;
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;

interface ModelResult {
  modelId: string;
  success: boolean;
  region?: string;
  error?: string;
  skipped?: boolean; // For geo-restricted models
}

// Check if error is a transient http2/network error
function isHttp2Error(error: any): boolean {
  const message = error?.message?.toLowerCase() ?? "";
  return (
    message.includes("http2") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
  );
}

// Create clients once per region with retry configuration
const clients = new Map<string, BedrockRuntimeClient>();
function getClient(region: string): BedrockRuntimeClient {
  let client = clients.get(region);
  if (!client) {
    client = new BedrockRuntimeClient({
      region,
      maxAttempts: MAX_ATTEMPTS,
    });
    // Add middleware to mark http2 errors as retryable
    client.middlewareStack.add(
      (next) => async (args) => {
        try {
          return await next(args);
        } catch (error: any) {
          if (isHttp2Error(error)) {
            error.$retryable = { throttling: false };
          }
          throw error;
        }
      },
      { step: "deserialize", name: "http2RetryMiddleware" },
    );
    clients.set(region, client);
  }
  return client;
}

async function testModelInRegion(
  modelId: string,
  region: string,
): Promise<{ success: boolean; error?: string; skipOtherRegions?: boolean; geoRestricted?: boolean }> {
  const client = getClient(region);

  try {
    await client.send(
      new ConverseCommand({
        modelId,
        messages: [
          {
            role: "user",
            content: [{ text: "Hi" }],
          },
        ],
        inferenceConfig: {
          maxTokens: 1, // Minimize token usage
        },
      }),
    );
    return { success: true };
  } catch (err: any) {
    // Model not found or not available in this region - try next region
    if (err.name === "ResourceNotFoundException") {
      return { success: false };
    }
    if (err.name === "ValidationException") {
      const msg = err.message?.toLowerCase() ?? "";
      // Geo-restriction error - model exists but not accessible from this location
      if (msg.includes("unsupported countries") || msg.includes("regions, or territories")) {
        return { success: false, geoRestricted: true, error: "Geo-restricted", skipOtherRegions: true };
      }
      if (
        msg.includes("not found") ||
        msg.includes("invalid") ||
        msg.includes("not supported")
      ) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err.message };
    }
    // Credential errors - stop everything
    if (
      err.name === "CredentialsProviderError" ||
      err.name === "ExpiredTokenException"
    ) {
      throw new Error(
        "AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.",
      );
    }
    // Unknown error - report it but don't try other regions
    return {
      success: false,
      error: `${err.name}: ${err.message}`,
      skipOtherRegions: true,
    };
  }
}

async function testModel(modelId: string): Promise<ModelResult> {
  for (const region of REGIONS) {
    const result = await testModelInRegion(modelId, region);
    if (result.success) {
      return { modelId, success: true, region };
    }
    if (result.geoRestricted) {
      return { modelId, success: false, error: result.error, skipped: true };
    }
    if (result.skipOtherRegions) {
      return { modelId, success: false, error: result.error };
    }
  }
  return { modelId, success: false, error: "Not found in any region" };
}

async function processInBatches<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}

async function main() {
  const providersDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
  );

  // Generate all providers and pick amazon-bedrock
  const providers = await generate(providersDir);
  const bedrock = providers["amazon-bedrock"];
  if (!bedrock) {
    console.error("Amazon Bedrock provider not found");
    process.exit(1);
  }

  const allModelIds = Object.keys(bedrock.models).sort();
  
  // Filter out gov cloud models (us-gov.*) as they require special access
  const govCloudModels = allModelIds.filter(id => id.startsWith("us-gov."));
  const modelIds = allModelIds.filter(id => !id.startsWith("us-gov."));

  console.log(`Found ${allModelIds.length} models total`);
  if (govCloudModels.length > 0) {
    console.log(`Skipping ${govCloudModels.length} gov cloud models: ${govCloudModels.join(", ")}`);
  }
  console.log(`Testing ${modelIds.length} models via inference`);
  console.log(`Testing against regions: ${REGIONS.join(", ")}`);
  console.log(`Concurrency: ${CONCURRENCY}, Max attempts: ${MAX_ATTEMPTS}`);
  console.log(`\n⚠️  This will make actual API calls (minimal token usage)\n`);

  const succeeded: ModelResult[] = [];
  const failed: ModelResult[] = [];
  const skipped: ModelResult[] = [];

  let processed = 0;

  const allResults = await processInBatches(
    modelIds,
    CONCURRENCY,
    async (modelId) => {
      const result = await testModel(modelId);
      processed++;

      const status = result.success
        ? `✓ (${result.region})`
        : result.skipped
          ? `⊘ ${result.error ?? "Skipped"}`
          : `✗ ${result.error ?? "Failed"}`;
      console.log(`[${processed}/${modelIds.length}] ${modelId}: ${status}`);

      return result;
    },
  );

  for (const result of allResults) {
    if (result.success) {
      succeeded.push(result);
    } else if (result.skipped) {
      skipped.push(result);
    } else {
      failed.push(result);
    }
  }

  // Summary
  console.log("=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  console.log(`Total models: ${allResults.length}`);
  console.log(`Succeeded: ${succeeded.length}`);
  console.log(`Skipped (geo-restricted): ${skipped.length}`);
  console.log(`Failed: ${failed.length}`);

  if (skipped.length > 0) {
    console.log("-".repeat(70));
    console.log("SKIPPED MODELS (geo-restricted, exist but not testable from this location):");
    console.log("-".repeat(70));
    for (const r of skipped.sort((a, b) => a.modelId.localeCompare(b.modelId))) {
      console.log(`  - ${r.modelId}`);
    }
  }

  if (failed.length > 0) {
    console.log("-".repeat(70));
    console.log("FAILED MODELS:");
    console.log("-".repeat(70));
    for (const r of failed.sort((a, b) => a.modelId.localeCompare(b.modelId))) {
      console.log(`  - ${r.modelId}`);
      if (r.error) console.log(`    Error: ${r.error}`);
    }
  }

  // Exit with error if any models failed (but not for skipped)
  process.exit(failed.length > 0 ? 1 : 0);
}

await main();
