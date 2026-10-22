#!/usr/bin/env bun

import { generate } from "../src/generate";
import { generateV2 } from "../src/generate-v2";
import { isSchemaV2 } from "../src/translate";
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
  const rootDir = path.dirname(providersDir);
  const notV2: string[] = [];
  for (const pattern of ["models/**/*.toml", "providers/*/models/**/*.toml"]) {
    for await (const file of new Bun.Glob(pattern).scan({
      cwd: rootDir,
      followSymlinks: true,
    })) {
      const toml = await import(path.join(rootDir, file), {
        with: { type: "toml" },
      }).then((mod) => mod.default);
      if (!isSchemaV2(toml)) notV2.push(file);
    }
  }
  if (notV2.length > 0) {
    console.error(
      "Model files must be v2. Add `schema = 2` and write them in the v2 format (see AGENTS.md):\n" +
        notV2.map((file) => `  ${file}`).join("\n"),
    );
    process.exit(1);
  }
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
