#!/usr/bin/env bun
// Runs the old sync (packages/core/src/sync) and the new engine (packages/core/src/sync2)
// on the same recorded source data and the current catalog, and compares the files each would write.
//
//   bun packages/core/script/sync2-parity.ts [provider...]

import path from "node:path";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { syncProvider, type SyncProvider } from "../src/sync/index.js";
import { anthropic as oldAnthropic } from "../src/sync/providers/anthropic.js";
import { google as oldGoogle } from "../src/sync/providers/google.js";
import { meta as oldMeta } from "../src/sync/providers/meta.js";
import { mistral as oldMistral } from "../src/sync/providers/mistral.js";
import { modular as oldModular } from "../src/sync/providers/modular.js";
import { nearai as oldNearai } from "../src/sync/providers/nearai.js";
import { openai as oldOpenai } from "../src/sync/providers/openai.js";
import { xai as oldXai } from "../src/sync/providers/xai.js";
import { REPO_ROOT } from "../src/sync2/catalog.js";
import { plan } from "../src/sync2/engine.js";
import { modules } from "../src/sync2/index.js";

const FIXTURES = path.join(import.meta.dirname, "..", "test", "fixtures", "sync2");

const OLD: Record<string, SyncProvider<any>> = { anthropic: oldAnthropic, google: oldGoogle, meta: oldMeta, mistral: oldMistral, modular: oldModular, nearai: oldNearai, openai: oldOpenai, xai: oldXai };

type Raw = any;

// Each provider runs on the recorded data as is, and on a perturbed copy that
// exercises price changes, a new model and a model leaving the source.
export const SCENARIOS: Record<string, Record<string, (raw: Raw) => Raw>> = {
  nearai: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "openai/gpt-4.1")
        .map((model: Raw, index: number) => {
          const next = structuredClone(model);
          if (index % 4 === 0) {
            next.pricing.input = model.pricing.input * 1.5;
            next.pricing.output = model.pricing.output + 1;
          }
          if (model.id === "Qwen/Qwen3.8-27B") next.context_length = 100_000;
          if (model.id === "black-forest-labs/FLUX.2-klein-4B") next.pricing.image = "0.02";
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "openai/gpt-4.1-mini");
      data.push({ ...structuredClone(template), id: "openai/gpt-4.1-nano", pricing: { ...template.pricing, input: 0.1, output: 0.4 } });
      return { ...raw, data };
    },
  },
  modular: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      let retired = false;
      const models = raw.models.map((model: Raw) => {
        const next = structuredClone(model);
        const priced = model.shared_endpoint && Number(model.pricing.input ?? 0) > 0;
        if (priced && !retired && model.gateway_model_id.startsWith("MiniMaxAI/")) {
          retired = true;
          next.shared_endpoint = false;
        } else if (priced) {
          next.pricing.input = double(model.pricing.input);
          next.pricing.output = double(model.pricing.output);
          if (model.gateway_model_id === "google/gemma-4-31b-it") next.pricing.cached_input = "0";
        }
        return next;
      });
      models.push({ gateway_model_id: "example/new-model", shared_endpoint: true, billing_type: "token", pricing: { input: "0.000001", output: "0.000002" } });
      return { ...raw, models };
    },
  },
  meta: {
    recorded: (raw) => raw,
    perturbed: (raw) => ({
      ...raw,
      pricing: raw.pricing.replaceAll("$1.25", "$1.30").replaceAll("$0.15", "$0.10").replaceAll("| $0.30", "| $0.35"),
      families: raw.families.map((page: string, index: number) => (index === 0 ? page.replaceAll("1,048,576", "524,288") : page)),
    }),
  },
  anthropic: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const models = raw.models
        .filter((model: Raw) => model.id !== "claude-sonnet-4-5-20250929")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const caps = next.capabilities;
          if (model.id === "claude-opus-5") next.max_tokens = 64_000;
          if (model.id === "claude-sonnet-4-6") caps.thinking.types.enabled.supported = false;
          if (model.id === "claude-opus-4-6") caps.effort.xhigh.supported = true;
          if (model.id === "claude-opus-4-5-20251101") caps.effort.supported = false;
          if (model.id === "claude-haiku-4-5-20251001") caps.pdf_input.supported = false;
          if (model.id === "claude-fable-5") caps.structured_outputs.supported = false;
          if (model.id === "claude-haiku-4-5") caps.thinking.supported = false;
          if (model.id === "claude-opus-4-7") next.display_name = "Claude Opus 4.7 Renamed";
          return next;
        });
      const template = raw.models.find((model: Raw) => model.id === "claude-opus-4-5-20251101");
      models.push({ ...structuredClone(template), id: "claude-opus-4-1-20250805", display_name: "Claude Opus 4.1", created_at: "2025-08-05T00:00:00Z" });
      models.push({ ...structuredClone(template), id: "claude-zeta-9", display_name: "Claude Zeta 9" });
      const lines = raw.pricing.split("\n");
      const row = (name: string) => lines.findIndex((line: string) => line.startsWith(`| ${name} `));
      const opus = row("Claude Opus 4.7");
      lines[opus] = lines[opus].replace("Claude Opus 4.7", "Claude Opus 4.7 Renamed").replace("$5 / MTok", "$6 / MTok")
        .replace("$6.25 / MTok", "$7.50 / MTok").replace("$10 / MTok", "$12 / MTok").replace("$0.50 / MTok", "$0.60 / MTok");
      lines[row("Claude Opus 4.6")] = lines[row("Claude Opus 4.6")].replace("Claude Opus 4.6", "Claude Opus 4.6 (deprecated)");
      return { ...raw, models, pricing: lines.join("\n") };
    },
  },
  google: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const models = raw.models
        .filter((model: Raw) => model.name !== "models/gemini-3.6-flash")
        .map((model: Raw) => {
          const next = structuredClone(model);
          if (model.name === "models/gemini-2.5-flash") next.inputTokenLimit = 524_288;
          if (model.name === "models/gemini-2.5-pro") next.displayName = "Gemini 2.5 Pro Renamed";
          if (model.name === "models/gemini-3.5-flash") next.thinking = false;
          if (model.name === "models/gemini-3-pro-image") next.outputTokenLimit = 1;
          if (model.name === "models/gemini-embedding-001") next.temperature = 1;
          if (model.name === "models/gemini-2.5-flash-preview-tts") next.thinking = true;
          return next;
        });
      const template = raw.models.find((model: Raw) => model.name === "models/gemini-3.8-flash");
      models.push({ ...structuredClone(template), name: "models/gemini-3.9-flash", displayName: "Gemini 3.9 Flash" });
      return { ...raw, models };
    },
  },
  mistral: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "pixtral-12b" && model.id !== "mistral-embed")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const caps = next.capabilities;
          if (model.id === "codestral-2508") next.max_context_length = 128_000;
          if (model.id === "ministral-3b-2512") caps.function_calling = false;
          if (model.id === "ministral-8b-2512") caps.vision = false;
          if (model.id === "ministral-14b-2512") caps.audio = true;
          if (model.id === "mistral-large-2512") caps.completion_fim = true;
          if (model.id === "mistral-large-latest") caps.reasoning = true;
          if (model.id === "mistral-small-2603") caps.reasoning = false;
          if (model.id === "zai-glm-5-3") next.deprecation = "2026-12-01";
          if (model.id === "mistral-ocr-2512") caps.moderation = true;
          if (model.id === "voxtral-small-2507") caps.audio = false;
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "mistral-large-4");
      data.push({ ...structuredClone(template), id: "mistral-large-5", name: "mistral-large-5" });
      data.push({ ...structuredClone(template), id: "mistral-large-5-latest", name: "mistral-large-5" });
      // mistral-large-4 accepts fewer efforts than its file lists; that model is reported, not written.
      const efforts = { ...raw.reasoning_efforts, "mistral-large-4": ["low", "high"], "mistral-large-5": ["low", "high"], "mistral-medium-latest": [] };
      return { ...raw, data, reasoning_efforts: efforts };
    },
  },
  openai: {
    recorded: (raw) => raw,
    perturbed: (raw) => ({
      ...raw,
      data: [
        ...raw.data.filter((model: Raw) => model.id !== "gpt-4-turbo"),
        { id: "gpt-9", object: "model", created: 1, owned_by: "system" },
        { id: "ft:gpt-4o:me", object: "model", created: 1, owned_by: "user" },
      ],
    }),
  },
  xai: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const models = raw.models
        .filter((model: Raw) => model.id !== "grok-4.6")
        .map((model: Raw) => {
          const next = structuredClone(model);
          if (model.id === "grok-4.3") {
            next.prompt_text_token_price = 15000;
            next.cached_prompt_text_token_price_long_context = 0;
          }
          if (model.id === "grok-4.5") next.completion_text_token_price_long_context = 0;
          if (model.id === "grok-4.7") next.long_context_threshold = 0;
          if (model.id === "grok-build-0.1") {
            next.input_modalities = ["text"];
            delete next.cached_prompt_text_token_price;
          }
          if (model.id === "grok-imagine-image") next.max_prompt_length = 8000;
          if (model.id === "grok-imagine-video") next.input_modalities = ["text", "image"];
          return next;
        });
      const template = raw.models.find((model: Raw) => model.id === "grok-4.7");
      models.push({ ...structuredClone(template), id: "grok-4.8", aliases: ["grok-4.8-latest"] });
      return { ...raw, models };
    },
  },
};

// Per-token price strings stay decimal ("0.0000003", not "3e-7"), as the source sends them.
function double(price: string) {
  return (Number(price) * 2).toFixed(12).replace(/0+$/, "");
}

export interface Parity {
  provider: string;
  scenario: string;
  old: Record<string, string | null>;
  new: Record<string, string | null>;
  /** Paths where the two disagree. */
  differences: string[];
}

export async function parity(provider: string, scenario: string): Promise<Parity> {
  const raw = SCENARIOS[provider]![scenario]!(await Bun.file(path.join(FIXTURES, `${provider}.json`)).json());
  const old = await runOld(OLD[provider]!, raw);
  const { writes } = await plan(modules[provider]!, { raw });
  const next = Object.fromEntries(writes);
  const differences = [...new Set([...Object.keys(old), ...Object.keys(next)])]
    .filter((file) => old[file] !== next[file])
    .sort();
  return { provider, scenario, old, new: next, differences };
}

// The old sync works on paths relative to the working directory, so it runs in
// a copy of models/ and the provider's folder.
async function runOld(provider: SyncProvider<any>, raw: Raw) {
  const dir = await mkdtemp(path.join(tmpdir(), "sync2-parity-"));
  const relative = path.join("providers", provider.id);
  const cwd = process.cwd();
  const quiet = { log: console.log, warn: console.warn };
  try {
    await cp(path.join(REPO_ROOT, "models"), path.join(dir, "models"), { recursive: true });
    await cp(path.join(REPO_ROOT, relative), path.join(dir, relative), { recursive: true });
    process.chdir(dir);
    console.log = () => {};
    console.warn = () => {};
    await syncProvider({ ...provider, fetchModels: async () => raw }, {});
  } finally {
    console.log = quiet.log;
    console.warn = quiet.warn;
    process.chdir(cwd);
  }
  try {
    const before = await snapshot(path.join(REPO_ROOT, relative, "models"));
    const after = await snapshot(path.join(dir, relative, "models"));
    const changed: Record<string, string | null> = {};
    for (const file of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(file) !== after.get(file)) changed[`${relative}/models/${file}`] = after.get(file) ?? null;
    }
    return changed;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function snapshot(dir: string) {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
    const file = path.join(entry.parentPath, entry.name);
    files.set(path.relative(dir, file).split(path.sep).join("/"), await Bun.file(file).text());
  }
  return files;
}

if (import.meta.main) {
  const providers = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  for (const provider of providers.length > 0 ? providers : Object.keys(SCENARIOS)) {
    for (const scenario of Object.keys(SCENARIOS[provider]!)) {
      const result = await parity(provider, scenario);
      const files = (writes: Record<string, string | null>) =>
        Object.entries(writes).map(([file, content]) => `${content === null ? "-" : "~"} ${file}`);
      console.log(`\n${provider} / ${scenario}: old ${Object.keys(result.old).length} files, new ${Object.keys(result.new).length} files, ${result.differences.length} differ`);
      for (const line of files(result.old)) console.log(`  old ${line}`);
      for (const line of files(result.new)) console.log(`  new ${line}`);
      for (const file of result.differences) {
        console.log(`  DIFF ${file}`);
        const show = (content: string | null | undefined) => JSON.stringify(content === null ? "(deleted)" : content ?? "(unchanged)");
        console.log(`    old: ${show(result.old[file])}`);
        console.log(`    new: ${show(result.new[file])}`);
      }
    }
  }
}
