#!/usr/bin/env bun

import { generate } from "../src/generate";
import { generateV2 } from "../src/generate-v2";
import { explicitFalseFlags, isSchemaV2, readLabMetadata } from "../src/translate";
import { logoErrors } from "../src/logo";
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
  const falseFlags: string[] = [];
  for (const pattern of ["models/**/*.toml", "providers/*/models/**/*.toml", "labs/*/lab.toml"]) {
    for await (const file of new Bun.Glob(pattern).scan({
      cwd: rootDir,
      followSymlinks: true,
    })) {
      const toml = await import(path.join(rootDir, file), {
        with: { type: "toml" },
      }).then((mod) => mod.default);
      if (!isSchemaV2(toml)) notV2.push(file);
      for (const flag of explicitFalseFlags(toml)) falseFlags.push(`${file}: ${flag}`);
    }
  }
  if (notV2.length > 0) {
    console.error(
      "Model and lab files must be v2. Add `schema = 2` and write them in the v2 format (see AGENTS.md):\n" +
        notV2.map((file) => `  ${file}`).join("\n"),
    );
    process.exit(1);
  }
  if (falseFlags.length > 0) {
    console.error(
      "system_updates, effort_updates and tools.updates default to false. Leave them out instead of writing `= false` (see AGENTS.md):\n" +
        falseFlags.map((flag) => `  ${flag}`).join("\n"),
    );
    process.exit(1);
  }
  const unsafeLogos: string[] = [];
  const logos = await Array.fromAsync(new Bun.Glob("{providers,labs}/*/logo.svg").scan({ cwd: rootDir }));
  for (const file of ["providers/logo.svg", ...logos]) {
    for (const error of logoErrors(await Bun.file(path.join(rootDir, file)).text())) unsafeLogos.push(`${file}: ${error}`);
  }
  if (unsafeLogos.length > 0) {
    console.error(
      "Logos may only use plain SVG drawing markup (see AGENTS.md):\n" +
        unsafeLogos.map((error) => `  ${error}`).join("\n"),
    );
    process.exit(1);
  }
  for await (const file of new Bun.Glob("labs/*/lab.toml").scan({ cwd: rootDir })) {
    readLabMetadata(path.join(rootDir, file));
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
