#!/usr/bin/env bun

import { generate } from "../src/generate";
import { generateV2 } from "../src/generate-v2";
import path from "path";
import { ZodError } from "zod";

try {
  const providersDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
  );
  const result = await generate(providersDir);
  await generateV2(providersDir);
  // OpenCode inference serves each protocol under its own path, so the
  // provider-level `api` only works for OpenAI-format models.
  const missing = ["opencode", "opencode-go"].flatMap((providerID) =>
    Object.values(result[providerID]?.models ?? {})
      .filter((model) => !model.provider?.api)
      .map((model) => `${providerID}/${model.id}`),
  );
  if (missing.length > 0) {
    console.error("Missing [provider] api:", missing.join(", "));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (e: any) {
  if (e instanceof ZodError) {
    console.error("Validation error:", e.errors);
    console.error("When parsing:", e.cause);
    process.exit(1);
  }
  throw e;
}
