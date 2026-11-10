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
  // Chutes: a kind the source changes is written in the lab's formats (the old
  // sync wrote bare kinds), and a new model that reasons with no controls is a gap.
  "chutes/perturbed": [
    "providers/chutes/models/Qwen/Qwen3.5-9B-TEE.toml",
    "providers/chutes/models/acme/Thinker-9B.toml",
    "providers/chutes/models/moonshotai/Kimi-K2.6-TEE.toml",
  ],
  // Hugging Face: a new file doesn't restate tools = { supported = true } when
  // the lab already says so; the old sync always wrote it.
  "huggingface/perturbed": [
    "providers/huggingface/models/meta-llama/Llama-3.2-11B-Vision-Instruct.toml",
    "providers/huggingface/models/meta-llama/Llama-3.2-3B-Instruct.toml",
  ],
  // Cortecs: a new model with no lab file is a gap (the old sync wrote a
  // standalone file), and so is a new or standalone model that starts reasoning
  // with no controls (the old sync wrote reasoning = { supported = true }).
  "cortecs/recorded": ["providers/cortecs/models/kimi-k3.1-pro.toml"],
  "cortecs/perturbed": [
    "providers/cortecs/models/brand-new-model.toml",
    "providers/cortecs/models/kimi-k3.1-pro.toml",
    "providers/cortecs/models/minicpm-v-4.5.toml",
    "providers/cortecs/models/qwen3-235b-a22b-instruct-2507-fp8.toml",
  ],
  // A new Venice model with no lab file. The old sync wrote a standalone file with a generated
  // description and today's date; the new engine reports a gap (no create-only fields yet).
  "venice/perturbed": ["providers/venice/models/venice-brand-new.toml"],
};

const OWNS_NOTHING = new Set(["ollama-cloud", "openai"]);

for (const [provider, scenarios] of Object.entries(SCENARIOS)) {
  for (const scenario of Object.keys(scenarios)) {
    test(`old and new sync write the same files: ${provider} / ${scenario}`, async () => {
      const result = await parity(provider, scenario);
      expect(result.differences).toEqual(EXPECTED[`${provider}/${scenario}`] ?? []);
      // OpenAI and Ollama Cloud own no fields, so they never write a file.
      if (scenario === "perturbed" && !OWNS_NOTHING.has(provider)) expect(Object.keys(result.new).length).toBeGreaterThan(0);
    }, 30_000);
  }
}
