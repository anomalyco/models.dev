import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import { parity, SCENARIOS } from "../script/sync2-parity.js";
import { REPO_ROOT } from "../src/sync2/catalog.js";

// NEAR AI files live in both `Qwen/` and `qwen/`. On a case-insensitive
// filesystem (macOS) those are one folder, listed as `Qwen/`, so the old sync
// misses `qwen/qwen3.7-max`, fails to create it (reasoning without controls) and
// deletes the existing file. The new engine matches ignoring case and updates
// the file in place. On Linux both engines see the exact path and agree.
const caseInsensitive = existsSync(path.join(REPO_ROOT, "PACKAGE.JSON"));
const nearaiCase = caseInsensitive
  ? ["providers/nearai/models/Qwen/qwen3.5-397b-a17b.toml", "providers/nearai/models/Qwen/qwen3.7-max.toml"]
  : [];
const EXPECTED: Record<string, string[]> = {
  "nearai/recorded": nearaiCase,
  "nearai/perturbed": nearaiCase,
  // Google turns thinking on for a TTS model. The old sync wrote reasoning = { supported = true }
  // with no controls; the new engine reports a gap instead, as AGENTS.md asks.
  "google/perturbed": ["providers/google/models/gemini-2.5-flash-preview-tts.toml"],
  // A new Venice model with no lab file. The old sync wrote a standalone file with a generated
  // description and today's date; the new engine reports a gap (no create-only fields yet).
  "venice/perturbed": ["providers/venice/models/venice-brand-new.toml"],
};

for (const [provider, scenarios] of Object.entries(SCENARIOS)) {
  for (const scenario of Object.keys(scenarios)) {
    test(`old and new sync write the same files: ${provider} / ${scenario}`, async () => {
      const result = await parity(provider, scenario);
      expect(result.differences).toEqual(EXPECTED[`${provider}/${scenario}`] ?? []);
      // OpenAI owns no fields, so it never writes a file.
      if (scenario === "perturbed" && provider !== "openai") expect(Object.keys(result.new).length).toBeGreaterThan(0);
    }, 30_000);
  }
}
