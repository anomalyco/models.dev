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
  // Fireworks drops Priority for GLM 5.3 Flash (and its alias). Both engines remove the mode;
  // the old sync left its price multiplier behind, the new one removes it too.
  "fireworks-ai/perturbed": [
    "providers/fireworks-ai/models/accounts/fireworks/models/glm-5p3-flash.toml",
    "providers/fireworks-ai/models/accounts/fireworks/routers/glm-flash-latest.toml",
  ],
  // Deep Infra: the old sync can't write a file with retention write prices
  // (cost.text.input.cache.explicit) at all ("does not reproduce the synced
  // fields"), so Kimi K3's changed retention never lands; the new one writes it.
  // An input kind a tag adds takes the lab's formats and keeps the file's; the
  // old sync wrote bare kinds (gemma-3-4b-it) or dropped the file's narrowed
  // image list for the lab's (Qwen3-VL-30B-A3B-Instruct).
  "deepinfra/perturbed": [
    "providers/deepinfra/models/Qwen/Qwen3-VL-30B-A3B-Instruct.toml",
    "providers/deepinfra/models/google/gemma-3-4b-it.toml",
    "providers/deepinfra/models/moonshotai/Kimi-K3.toml",
  ],
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
