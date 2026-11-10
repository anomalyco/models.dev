#!/usr/bin/env bun
// Runs the old sync (packages/core/src/sync) and the new engine (packages/core/src/sync2)
// on the same recorded source data and the current catalog, and compares the files each would write.
//
//   bun packages/core/script/sync2-parity.ts [provider...]

import path from "node:path";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { providers, syncProvider, type SyncProvider } from "../src/sync/index.js";
import { REPO_ROOT } from "../src/sync2/catalog.js";
import { plan } from "../src/sync2/engine.js";
import { modules } from "../src/sync2/index.js";

const FIXTURES = path.join(import.meta.dirname, "..", "test", "fixtures", "sync2");

const OLD: Record<string, SyncProvider<any>> = providers;

type Raw = any;

// Each provider runs on the recorded data as is, and on a perturbed copy that
// exercises price changes, a new model and a model leaving the source.
export const SCENARIOS: Record<string, Record<string, (raw: Raw) => Raw>> = {
  "merge-gateway": {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.model !== "cohere/command-r-08-2024")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const vendor = next.vendors[next.provider];
          switch (model.model) {
            case "anthropic/claude-fable-5-1": vendor.pricing.input_per_million = 11; vendor.prompt_caching.cache_read_cost_per_million = 0.3; break;
            case "openai/gpt-6.1-sol": vendor.pricing.long_context = null; break;
            case "google/gemini-3.8-flash": vendor.prompt_caching = { mode: "none" }; vendor.max_output_tokens = 8_192; break;
            case "qwen/qwen3.8-max": vendor.capabilities.supports_reasoning = false; next.display_name = "qwen3.8-max"; break;
            case "deepseek/deepseek-v4-pro": next.availability_status = "deprecated"; break;
            case "xai/grok-4.7": vendor.capabilities.input = ["text"]; vendor.capabilities.supports_structured_outputs = false; break;
            case "mistral/devstral-medium-latest": next.availability_status = "available"; vendor.availability_status = "available"; break;
            case "meta/muse-spark-1.1": vendor.capabilities.output = ["image"]; break;
            case "zai/glm-5.3": vendor.pricing.long_context = { threshold_tokens: 200_000, input_per_million: vendor.pricing.input_per_million * 2 }; break;
          }
          return next;
        });
      const template = raw.data.find((model: Raw) => model.model === "zai/glm-5.3");
      data.push({ ...structuredClone(template), model: "zai/glm-4.6v-flash", display_name: "GLM-4.6V-Flash" });
      data.push({ ...structuredClone(template), model: "zai/glm-9-new", display_name: "GLM 9 New" });
      return { ...raw, data };
    },
  },
  aiand: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const models = structuredClone(raw.aiand.models);
      const entries = Object.entries(models) as Array<[string, Raw]>;
      const edit = (id: string, change: (model: Raw) => void) => change(entries.find(([, model]) => model.id === id)![1]);
      delete models[entries.find(([, model]) => model.id === "openai/gpt-oss-120b")![0]];
      edit("moonshotai/kimi-k3.1-pro", (model) => { model.cost.input = 2.5; model.reasoning_options = [{ type: "effort", values: ["max", "low"] }]; });
      edit("zai-org/glm-5.3", (model) => { delete model.reasoning_options; model.cost.tiers = [{ tier: { size: 200_000 }, input: 2, output: 8 }]; });
      edit("zai-org/glm-5.3-flash", (model) => { model.reasoning_options = []; model.status = "beta"; });
      edit("qwen/qwen3.8-27b", (model) => { model.reasoning_options = [{ type: "effort", values: ["turbo"] }]; model.limit.output = 16_384; });
      edit("google/gemma-4-31b-it", (model) => { model.reasoning = false; model.modalities.input = ["text"]; });
      edit("moonshotai/kimi-k3", (model) => { model.interleaved = { field: "reasoning_details" }; model.structured_output = false; });
      const template = entries.find(([, model]) => model.id === "zai-org/glm-5.3")![1];
      models["zai-org/glm-5.1"] = { ...structuredClone(template), id: "zai-org/glm-5.1", name: "GLM-5.1" };
      models["acme/brand-new"] = { ...structuredClone(template), id: "acme/brand-new", name: "Brand New" };
      return { ...raw, aiand: { ...raw.aiand, models } };
    },
  },
  empiriolabs: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "glm-5-1")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const first = Array.isArray(next.pricing) ? next.pricing[0] : next.pricing;
          switch (model.id) {
            case "glm-5-3": first.prompt = "0.0000015"; next.supported_parameters = next.supported_parameters.filter((p: Raw) => p.name !== "reasoning_effort"); break;
            case "kimi-k3": delete first.input_cache_read; next.features = [...next.features, "cache"]; break;
            case "qwen3-7-plus": next.pricing = next.pricing.slice(0, 1); break;
            case "qwen3-8-max": next.pricing = [first, { ...first, min_context: 128_000, prompt: String(Number(first.prompt) * 2) }]; break;
            case "gemma-3-27b": next.features = ["vision", "reasoning"]; break;
            case "minimax-m3": next.structured_output = "json_schema"; next.deprecated = true; break;
            case "step-3-5-flash": next.input_modalities = ["text", "image"]; next.context_length = 65_536; break;
            case "seed-2-0-pro": next.supported_parameters = next.supported_parameters.filter((p: Raw) => p.name !== "enable_thinking"); break;
            case "deepseek-v4-pro": next.features = []; next.max_output_tokens = 32_768; break;
          }
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "glm-5-1");
      data.push({ ...structuredClone(template), id: "glm-4-6" });
      data.push({ ...structuredClone(template), id: "acme-brand-new" });
      return { ...raw, data };
    },
  },
  wandb: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const models = structuredClone(raw.coreweave.models);
      delete models["meta-llama/Llama-3.1-8B-Instruct"];
      const edit = (id: string, change: (model: Raw) => void) => change(Object.values(models).find((model: Raw) => model.id === id));
      edit("openai/gpt-oss-120b", (model) => { model.cost.input = 0.2; model.reasoning_options = [{ type: "toggle" }]; });
      edit("google/gemma-4-31B-it", (model) => { model.reasoning_options = []; model.interleaved = { field: "reasoning_content" }; });
      edit("zai-org/GLM-5.3", (model) => { model.cost.cache_read = 0; model.limit.output = 32_768; });
      edit("MiniMaxAI/MiniMax-M3", (model) => { model.modalities.input = ["text"]; model.status = "beta"; });
      edit("moonshotai/Kimi-K2.6", (model) => { model.description = "Changed description"; model.structured_output = false; });
      edit("deepseek-ai/DeepSeek-V3.1", (model) => { model.reasoning = true; model.reasoning_options = [{ type: "toggle" }]; });
      edit("reflection/Beam-1.0-501B-A23B", (model) => { model.name = "Beam 1.0 Renamed"; model.knowledge = "2026-01"; });
      edit("Qwen/Qwen3.8-27B", (model) => { model.temperature = false; model.cost.input_audio = 1; });
      const template = Object.values(models).find((model: Raw) => model.id === "zai-org/GLM-5.3") as Raw;
      models["zai-org/GLM-5.1"] = { ...structuredClone(template), id: "zai-org/GLM-5.1", name: "GLM 5.1" };
      models["acme/brand-new"] = { ...structuredClone(template), id: "acme/brand-new", name: "Acme: Brand New", reasoning: false, reasoning_options: undefined };
      return { coreweave: { ...raw.coreweave, models } };
    },
  },
  pioneer: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "fastino/gliner2-base-v1")
        .map((model: Raw) => {
          const next = structuredClone(model);
          switch (model.id) {
            case "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": next.max_tokens = 8_192; next.input_price_per_million = 0.1; break;
            case "fastino/gliner2-large-v1": next.deprecated = true; next.capabilities.image_input = { supported: true }; break;
            case "fastino/gliner2-multi-v1": next.capabilities.structured_outputs = { supported: true }; next.max_input_tokens = 4_096; break;
          }
          return next;
        });
      const models = raw.models.map((model: Raw) => {
        const next = structuredClone(model);
        if (model.slug === "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16") next.supported_reasoning_levels = [{ effort: "high" }, { effort: "low" }];
        return next;
      });
      const template = raw.data.find((model: Raw) => model.id === "fastino/gliner2-large-v1");
      data.push({ ...structuredClone(template), id: "fastino/gliner3-large" });
      return { ...raw, data, models };
    },
  },
  crossmodel: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "z-ai/glm-5.1")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const tier = next.pricing?.tiers?.[0];
          switch (model.id) {
            case "openai/gpt-6.1-sol": next.pricing.tiers[1].input_micro_per_1m *= 2; break;
            case "x-ai/grok-4.7": next.pricing.tiers = next.pricing.tiers.slice(0, 1); break;
            case "z-ai/glm-5.3": next.pricing.tiers.push({ ...structuredClone(tier), threshold: 128_000, input_micro_per_1m: tier.input_micro_per_1m * 2 }); break;
            case "deepseek/deepseek-v4.1-flash": tier.cache_read_micro_per_1m = tier.input_micro_per_1m; break;
            case "moonshot/kimi-k3": next.capabilities.reasoning.effort = ["high", "low"]; break;
            case "moonshot/kimi-k2.6": next.capabilities.reasoning = { supported: true }; break;
            case "qwen/qwen3.7-max": delete next.capabilities.reasoning; break;
            case "gemini/gemini-3.8-flash": next.modalities.input = ["text"]; next.max_output_tokens = 8_192; break;
            case "anthropic/claude-opus-5": next.identity.release_stage = "deprecated"; break;
            case "tencent/hy3": next.capabilities.context = { caching: true }; next.capabilities.json = false; break;
            case "qwen/qwen3.8-flash": next.status = "hidden"; break;
          }
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "z-ai/glm-5.3");
      data.push({ ...structuredClone(template), id: "z-ai/glm-5.2-turbo" });
      data.push({ ...structuredClone(template), id: "z-ai/glm-4.6" });
      return { ...raw, data };
    },
  },
  inceptron: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "zai-org/GLM-5.2")
        .map((model: Raw) => {
          const next = structuredClone(model);
          switch (model.id) {
            case "zai-org/GLM-5.3": next.pricing.prompt = "0.0000012"; next.models_dev.reasoning_options[0].values = ["max", "high"]; break;
            case "moonshotai/Kimi-K2.6": delete next.pricing.input_cache_reads; next.models_dev.status = "deprecated"; break;
            case "moonshotai/Kimi-K2.7-Code": next.input_modalities = ["text"]; next.supported_sampling_parameters = []; break;
            case "deepseek-ai/DeepSeek-V4-Flash-0731": next.context_length = 65_536; delete next.models_dev.interleaved; break;
            case "zai-org/GLM-5.3-Flash": next.is_ready = false; break;
          }
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "zai-org/GLM-5.2");
      data.push({ ...structuredClone(template), id: "zai-org/GLM-5.1", name: "GLM-5.1", models_dev: { ...structuredClone(template.models_dev), base_model: "zhipuai/glm-5.1" } });
      return { ...raw, data };
    },
  },
  hyper: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "gemma-4-26b-a4b-it")
        .map((model: Raw) => {
          const next = structuredClone(model);
          switch (model.id) {
            case "prism": next.pricing.input = 3.5; next.capabilities.vision = false; break;
            case "kimi-k3": next.pricing.cache_hit = 0; break;
            case "glm-5.3": delete next.pricing.cache_hit; next.context_window = 524_288; break;
            case "minimax-m3": next.reasoning.effort_levels = [{ value: "high" }, { value: "low" }]; break;
            case "gpt-oss-120b": delete next.reasoning; break;
            case "qwen3.8-27b": next.reasoning.effort_levels = [{ value: "turbo" }]; break;
            case "inkling": next.capabilities.vision = false; next.max_output_tokens = 16_384; break;
            case "prism-core": next.reasoning = { effort_levels: [{ value: "low" }, { value: "high" }] }; break;
          }
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "glm-5.3");
      data.push({ ...structuredClone(template), id: "glm-5.2", display_name: "GLM 5.2" });
      const prism = raw.data.find((model: Raw) => model.id === "prism-flash");
      data.push({ ...structuredClone(prism), id: "prism-max", display_name: "Prism Max" });
      return { ...raw, data };
    },
  },
  prime: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "mistralai/mistral-nemo")
        .map((model: Raw) => {
          const next = structuredClone(model);
          switch (model.id) {
            case "anthropic/claude-fable-5": next.pricing.input_usd_per_mtok = 12; next.pricing.cache_read_usd_per_mtok = 1.2; break;
            case "deepseek/deepseek-v4.1-flash": next.reasoning.supported_efforts = ["low", "high"]; delete next.pricing.cache_read_usd_per_mtok; break;
            case "google/gemini-3.8-flash": next.specs.modalities.input = ["text", "image"]; break;
            case "google/gemma-3-27b-it": next.display_name = "Gemma 3 27B Renamed"; next.context_window = 65_536; break;
            case "meta-llama/llama-3.3-70b-instruct": next.supported_parameters = next.supported_parameters.filter((param: string) => param !== "temperature"); break;
            case "mistralai/mistral-small-2603": next.specs.supports_reasoning = false; break;
            case "moonshotai/kimi-k2-0905": next.pricing.output_usd_per_mtok = null; break;
            case "anthropic/claude-opus-4.6": next.reasoning.supported_efforts = ["low", "high", "default"]; break;
          }
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "anthropic/claude-sonnet-5");
      data.push({ ...structuredClone(template), id: "anthropic/claude-mythos-5.1", display_name: "Claude Mythos 5.1" });
      data.push({ ...structuredClone(template), id: "acme/brand-new", display_name: "Brand New" });
      return { ...raw, data };
    },
  },
  ovhcloud: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "Qwen3Guard-Gen-8B")
        .map((model: Raw) => {
          const next = structuredClone(model);
          switch (model.id) {
            case "Meta-Llama-3_3-70B-Instruct": next.pricing.prompt = "0.0000008"; next.pricing.input_cache_reads = "0.0000004"; break;
            case "gpt-oss-120b": next.supported_features = ["json_mode", "tools"]; next.max_output_length = 32_768; break;
            case "Qwen2.5-VL-72B-Instruct": next.supported_features = ["tools"]; next.supported_sampling_parameters = []; break;
            case "Qwen3.6-27B": next.input_modalities = ["text"]; next.context_length = 65_536; break;
            case "Qwen3.5-9B": next.name = "Qwen3.5 9B Renamed"; break;
            case "Qwen3Guard-Gen-0.6B": next.supported_features = ["reasoning"]; break;
            case "Mistral-Small-3.2-24B-Instruct-2506": delete next.pricing.completion; break;
          }
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "Meta-Llama-3_3-70B-Instruct");
      data.push({ ...structuredClone(template), id: "Brand-New-70B", name: "Brand-New-70B", hugging_face_id: "acme/brand-new" });
      return { ...raw, data };
    },
  },
  ofox: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const effective = (model: Raw) => (model.provider_price?.is_override ? model.provider_price.pricing : model.pricing);
      const data = raw.data
        .filter((model: Raw) => model.id !== "z-ai/glm-5.2")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const pricing = effective(next);
          switch (model.id) {
            case "openai/gpt-6.1-terra": pricing.input = "0.0000011"; pricing.context_price_tiers[0].output = 8e-6; break;
            case "openai/gpt-6.1-sol": delete pricing.context_price_tiers; break;
            case "moonshotai/kimi-k3": pricing.context_price_tiers = [{ threshold_tokens: 128_000, input: 6e-6, output: 3e-5 }]; break;
            case "deepseek/deepseek-v4.1-flash": delete pricing.input_cache_read; break;
            case "x-ai/grok-4.7": next.provider_price.is_override = false; break;
            case "qwen/qwen3.8-flash": pricing.input_cache_write = "0.0000002"; break;
            case "anthropic/claude-opus-5": pricing.input_cache_write_5m = "0.000007"; break;
            case "google/gemini-3.8-flash": pricing.audio = "0.000002"; break;
            case "z-ai/glm-5.3": next.is_deprecated = true; break;
            case "moonshotai/kimi-k3.1-pro": delete pricing.input; delete pricing.output; break;
          }
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "z-ai/glm-5.3");
      data.push({ ...structuredClone(template), id: "z-ai/glm-6" });
      return { ...raw, data };
    },
  },
  ambient: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "qwen/qwen3-30b-a3b-instruct-2507")
        .map((model: Raw) => {
          const next = structuredClone(model);
          if (model.id === "z-ai/glm-5.2") next.pricing.prompt = "0.0000007";
          if (model.id === "qwen/qwen3.6-27b") delete next.pricing.input_cache_read;
          if (model.id === "qwen/qwen3.6-35b-a3b") next.max_output_length = 65_536;
          if (model.id === "qwen/qwen3.8-27b") next.input_modalities = ["text"];
          if (model.id === "minimax/minimax-m3") next.supported_features = ["tools"];
          if (model.id === "ambient/small") next.supported_sampling_parameters = [];
          if (model.id === "unsloth/qwen3.8-27b-gguf") next.is_ready = false;
          if (model.id === "ambient/large") next.context_length = 131_072;
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "qwen/qwen3-30b-a3b-instruct-2507");
      data.push({ ...structuredClone(template), id: "qwen/qwen3-32b", name: "Qwen3 32B", openrouter: { slug: "qwen/qwen3-32b" } });
      data.push({ ...structuredClone(template), id: "qwen/qwen3-235b-a22b-thinking-2507", name: "Qwen3 235B Thinking", openrouter: { slug: "qwen/qwen3-235b-a22b-thinking-2507" }, supported_features: ["tools", "reasoning"] });
      data.push({ ...structuredClone(template), id: "acme/brand-new", name: "Brand New", openrouter: null });
      return { ...raw, data };
    },
  },
  "nano-gpt": {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "openai/gpt-4.1")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const caps = (extra: Raw) => (next.capabilities = { ...next.capabilities, ...extra });
          switch (model.id) {
            case "openai/gpt-5.6-luna": next.pricing.prompt = 0.25; next.pricing.cacheWriteInputPer1kTokens = 0.0003; break;
            case "anthropic/claude-opus-4.7": next.pricing.cacheWriteInputPer1kTokens = 0.007; break;
            case "deepseek/deepseek-v3.2": delete next.pricing.cacheReadInputPer1kTokens; next.pricing.completion = 0.4; break;
            case "z-ai/glm-5.3:thinking": next.reasoning_efforts = ["low", "high"]; break;
            case "z-ai/glm-4.6:thinking": next.reasoning_efforts = []; break;
            case "openai/gpt-5.1-codex": caps({ tool_calling: true, structured_output: true }); break;
            case "qwen/qwen3.8-max": caps({ reasoning: true }); break;
            case "minimax/minimax-m2.7": caps({ reasoning: false }); break;
            case "deepseek/deepseek-v4-pro-0813": Object.assign(next, { context_length: 524_288, max_output_tokens: 131_072 }); break;
            case "upstage/solar-pro-3": caps({ vision: true }); break;
            case "Sao10K/L3-8B-Stheno-v3.2": Object.assign(next, { created: 1_800_000_000, open_weights: false }); break;
            case "claw-high": next.pricing.note = "varies_by_modality"; next.pricing.prompt = 9; break;
            case "Gemma-4-31B-Queen": next.architecture = { ...next.architecture, input_modalities: ["text", "images", "videos"] }; break;
          }
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "Sao10K/L3-8B-Stheno-v3.2");
      data.push({ ...structuredClone(template), id: "meta-llama/llama-3.2-1b-instruct", name: "Llama 3.2 1B" });
      data.push({ ...structuredClone(template), id: "acme/brand-new-70b", name: "Brand New 70B", capabilities: { tool_calling: undefined } });
      data.push({ ...structuredClone(template), id: "nousresearch/hermes-new", name: null, description: null, max_output_tokens: null });
      return { ...raw, data };
    },
  },
  kilo: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "tencent/hy-mt2-7b")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const params = (add: string[], remove: string[] = []) => {
            next.supported_parameters = [...next.supported_parameters.filter((param: string) => !remove.includes(param)), ...add];
          };
          switch (model.id) {
            case "openai/gpt-6-luna": next.pricing.prompt = "0.0000003"; next.pricing.web_search = "0"; break;
            case "x-ai/grok-4.5": next.pricing.web_search = "0.01"; delete next.pricing.input_cache_read; break;
            case "google/gemini-omni-1.1-flash": next.name = "Gemini Omni 1.1 Flash Renamed"; break;
            case "openai/gpt-6-astra": next.name = "GPT-6 Astra Renamed"; break;
            case "moonshotai/kimi-k3": next.opencode = { variants: { thinking: { reasoning: { enabled: true, effort: "high" } } } }; break;
            case "tencent/hy3": delete next.opencode; break;
            case "z-ai/glm-5.1": params([], ["reasoning", "include_reasoning"]); break;
            case "mistralai/devstral-2512": params(["structured_outputs"], ["temperature"]); break;
            case "writer/palmyra-x5": next.architecture.input_modalities = ["text", "image"]; break;
            case "stepfun/step-3.7-flash": next.top_provider = { ...next.top_provider, context_length: 65_536, max_completion_tokens: 8_192 }; break;
            case "unbiased/pareto-26.10": Object.assign(next, { created: 1_800_000_000, knowledge_cutoff: "2026-01-01", hugging_face_id: "unbiased/pareto" }); break;
            case "tencent/hy4-preview": next.pricing.prompt = "-1"; break;
            case "qwen/qwen3.5-27b": next.supported_parameters = []; break;
          }
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "mistralai/devstral-2512");
      data.push({ ...structuredClone(template), id: "meta-llama/llama-3.2-11b-vision-instruct", name: "Llama 3.2 11B Vision", description: "  A   new\nmodel " });
      data.push({ ...structuredClone(template), id: "acme/brand-new", name: "Brand New" });
      return { ...raw, data };
    },
  },
  requesty: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "gpt-6-luna@eu")
        .map((model: Raw) => {
          const next = structuredClone(model);
          if (model.id === "gpt-6.1-terra") next.pricing[1].input_price *= 2;
          if (model.id === "gpt-6-sol") next.pricing = next.pricing.slice(0, 1);
          if (model.id === "claude-sonnet-5-5@eu") next.pricing.push({ ...next.pricing[0], prompt_tokens_threshold: 200_000, input_price: next.pricing[0].input_price * 2 });
          if (model.id === "glm-5.3@eu") next.pricing[0].cached_price = 0;
          if (model.id === "deepseek-v4.1-flash@eu") next.supports_reasoning = false;
          if (model.id === "gemini-3.8-flash@eu") next.max_output_tokens = 0;
          if (model.id === "mistral-large-4@eu") next.context_window = 32_768;
          if (model.id === "kimi-k3.1-pro@eu") Object.assign(next, { supports_vision: false, description: "Changed description" });
          if (model.id === "nemotron-lightning-3.5-30b-a3b") next.supports_tool_calling = !next.supports_tool_calling;
          if (model.id === "glm-5.3-flash@eu") next.supports_output_json_schema = !next.supports_output_json_schema;
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "glm-5.3@eu");
      data.push({ ...structuredClone(template), id: "glm-5.2@us", supports_reasoning: false });
      data.push({ ...structuredClone(template), id: "acme-brand-new" });
      return { ...raw, data };
    },
  },
  baseten: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "zai-org/GLM-5.3-Fast")
        .map((model: Raw) => {
          const next = structuredClone(model);
          if (model.id === "zai-org/GLM-5.2") next.pricing.prompt = "0.0000015";
          if (model.id === "moonshotai/Kimi-K3") delete next.pricing.input_cache_read;
          if (model.id === "openai/gpt-oss-120b") next.name = "GPT OSS 120B";
          if (model.id === "deepseek-ai/DeepSeek-V4.1-Flash-Fast") next.supported_features = ["tools", "reasoning", "structured_outputs"];
          if (model.id === "zai-org/GLM-5.3") Object.assign(next, { context_length: 524_288, max_completion_tokens: 65_536 });
          if (model.id === "deepseek-ai/DeepSeek-V4-Pro-0813") next.input_modalities = ["text", "image"];
          if (model.id === "deepseek-ai/DeepSeek-V4.1-Flash") next.supported_sampling_parameters = [];
          if (model.id === "decision-models/baseten-mammoth-27b-latest") Object.assign(next, { context_length: 32_768, pricing: { ...next.pricing, prompt: "0.0000002" } });
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "zai-org/GLM-5.2");
      data.push({ ...structuredClone(template), id: "meta-llama/Llama-3.3-70B-Instruct", name: "Llama 3.3 70B", supported_features: ["tools"], max_completion_tokens: 32_768 });
      data.push({ ...structuredClone(template), id: "zai-org/GLM-5.1", name: "GLM 5.1" });
      const decision = raw.data.find((model: Raw) => model.id === "decision-models/baseten-elephant-9b-latest");
      data.push({ ...structuredClone(decision), id: "decision-models/baseten-elephant-9b-v2" });
      return { ...raw, data };
    },
  },
  huggingface: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "google/gemma-3-27b-it")
        .map((model: Raw) => {
          const next = structuredClone(model);
          // Existing files keep their curated prices.
          if (model.id === "meta-llama/Llama-3.3-70B-Instruct") next.providers[0].pricing = { input: 9, output: 9 };
          if (model.id === "google/gemma-3-4b-it") next.providers = next.providers.map((provider: Raw) => ({ ...provider, status: "offline" }));
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "meta-llama/Llama-3.1-8B-Instruct");
      const add = (id: string, extra: Raw = {}) => data.push({ ...structuredClone(template), id, ...extra });
      add("meta-llama/Llama-3.2-3B-Instruct", { providers: template.providers.map((provider: Raw) => ({ ...provider, supports_structured_output: true })) });
      add("meta-llama/Llama-3.2-11B-Vision-Instruct", { architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } });
      add("meta-llama/Llama-3.2-1B-Instruct", { providers: template.providers.map(({ pricing: _pricing, ...provider }: Raw) => provider) });
      add("Qwen/Qwen3.5-4B");
      add("acme/Brand-New-9B");
      return { ...raw, data };
    },
  },
  chutes: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "zai-org/GLM-5.1-TEE")
        .map((model: Raw) => {
          const next = structuredClone(model);
          if (model.id === "zai-org/GLM-5.2-TEE") next.pricing.prompt = 1.3;
          if (model.id === "Qwen/Qwen3.6-27B-TEE") delete next.pricing.input_cache_read;
          if (model.id === "Qwen/Qwen3.5-27B-TEE") next.supported_features = ["json_mode", "reasoning"];
          if (model.id === "deepseek-ai/DeepSeek-V3.2-TEE") next.supported_sampling_parameters = ["top_p"];
          if (model.id === "moonshotai/Kimi-K2.6-TEE") next.input_modalities = ["text", "image"];
          if (model.id === "google/gemma-4-31B-turbo-TEE") next.context_length = 65_536;
          if (model.id === "tencent/Hy4") Object.assign(next, { context_length: 262_144, max_output_length: 32_768, supported_features: ["tools"] });
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "Qwen/Qwen3.6-27B-TEE");
      data.push({ ...structuredClone(template), id: "Qwen/Qwen3.5-9B-TEE", supported_features: ["tools"] });
      data.push({ ...structuredClone(template), id: "acme/Brand-New-9B", supported_features: ["tools", "structured_outputs"] });
      data.push({ ...structuredClone(template), id: "acme/Thinker-9B", supported_features: ["reasoning"] });
      return { ...raw, data };
    },
  },
  cortecs: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "glm-5.1")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const features = (list: string[]) => (next.supported_features = list);
          if (model.id === "glm-5.3") next.pricing.input_token = 0.95;
          if (model.id === "kimi-k3") delete next.pricing.cache_read_cost;
          if (model.id === "gpt-5.4") next.pricing.cache_write_cost = 3;
          if (model.id === "qwen3-32b") features(["tools"]);
          if (model.id === "codestral-2508") features(["json_mode"]);
          if (model.id === "minicpm-v-4.5") features(["json_mode", "tools", "reasoning"]);
          if (model.id === "mistral-large-2402") features(["json_mode", "tools"]);
          if (model.id === "qwen3.6-27b") next.input_modalities = ["text", "image", "video"];
          if (model.id === "ministral-8b-2512") next.input_modalities = ["text"];
          if (model.id === "deepseek-v3.2") next.context_size = 131_072;
          if (model.id === "minimax-m2") next.max_output_tokens = 32_768;
          return next;
        });
      const template = data.find((model: Raw) => model.id === "qwen3-32b");
      data.push({ ...structuredClone(template), id: "qwen3-235b-a22b-instruct-2507-fp8", supported_features: ["json_mode", "tools"] });
      data.push({ ...structuredClone(template), id: "brand-new-model" });
      return { ...raw, data };
    },
  },
  "github-copilot": {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const rows = raw
        .filter((row: Raw) => row.model !== "Kimi K3" && !(row.model === "Grok 4.5" && row.tier === "Long context"))
        .map((row: Raw) => {
          const next = structuredClone(row);
          if (row.model === "Claude Opus 5") next.input = "$6.00";
          if (row.model === "GPT-6 Sol" && row.tier === "Long context") next.threshold = "> 400K";
          if (row.model === "GPT-5.4 nano") next.cache_write = "$0.25";
          if (row.model === "Claude Sonnet 5") delete next.cache_write;
          if (row.model === "Grok 4.7" && row.tier === "Long context") next.cached_input = "$0.75";
          return next;
        });
      rows.push({ ...structuredClone(raw[0]), model: "MAI-Code-1.1-Flash", tier: "Long context", threshold: "> 128K", input: "$0.40" });
      const plain = raw.find((row: Raw) => row.model === "Kimi K3");
      rows.push({ ...structuredClone(plain), model: "Kimi K4" });
      return rows;
    },
  },
  engy: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "glm-5.2")
        .map((model: Raw) => {
          const next = structuredClone(model);
          if (model.id === "glm-5.3") next.pricing.prompt = "0.000001";
          if (model.id === "qwen3.6-35b-a3b") delete next.pricing.input_cache_read;
          if (model.id === "deepseek-v4.1-flash") next.pricing.input_cache_read = "0.000000005";
          if (model.id === "kimi-k3") next.context_length = 1_048_576;
          if (model.id === "deepseek-v4-flash-0731") next.input_modalities = ["text", "image"];
          if (model.id === "qwen3.8-27b") next.input_modalities = ["text"];
          if (model.id === "glm-5.3-flash") next.input_modalities = [];
          return next;
        });
      data.push({ ...structuredClone(raw.data[0]), id: "glm-6" }, { id: "" });
      return { ...raw, data };
    },
  },
  "ollama-cloud": {
    recorded: (raw) => raw,
    perturbed: (raw) => ({
      ...raw,
      data: [...raw.data.filter((model: Raw) => model.id !== "glm-5.2"), { id: "glm-6", object: "model", created: 1, owned_by: "ollama" }],
    }),
  },
  morph: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const price = (list: Raw[], type: string, cost: string | undefined) =>
        cost === undefined ? list.filter((item) => item.type !== type) : list.map((item) => (item.type === type ? { ...item, cost_usd: cost } : item));
      const data = raw.data
        .filter((model: Raw) => model.id !== "morph-glm52-744b")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const text = next.input_modalities.find((modality: Raw) => modality.type === "text");
          const output = next.output_modalities.find((modality: Raw) => modality.type === "text");
          if (model.id === "morph-kimik3") text.pricing = price(text.pricing, "prompt", "0.000001");
          if (model.id === "morph-glm53-744b") text.pricing = price(text.pricing, "cached_prompt", undefined);
          if (model.id === "morph-v3-fast") output.max_length.value = 8_192;
          if (model.id === "morph-dsv4flash") text.supported_inputs.max_context_length.value = 65_536;
          if (model.id === "reflex") text.pricing = price(text.pricing, "prompt", "0.0000002");
          if (model.id === "morph-dsv41flash-1017") next.is_ready = false;
          return next;
        });
      data.push({ ...structuredClone(raw.data.find((model: Raw) => model.id === "morph-kimik3")), id: "morph-kimik4" });
      return { ...raw, data };
    },
  },
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
  deepinfra: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const tags = (model: Raw, add: string[], remove: string[] = []) => {
        model.tags = [...(model.tags ?? []).filter((tag: string) => !remove.includes(tag)), ...add];
      };
      const models = raw
        .filter((model: Raw) => model.model_name !== "openai/gpt-oss-20b")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const pricing = next.pricing;
          switch (model.model_name) {
            case "Qwen/Qwen3.5-9B": tags(next, ["can-disable-reasoning"]); pricing.cents_per_input_token *= 2; break;
            case "Qwen/Qwen3-235B-A22B-Instruct-2507": tags(next, ["reasoning", "can-disable-reasoning"]); break;
            case "Qwen/Qwen3.8-Flash": tags(next, ["can-disable-reasoning"], ["non-reasoning"]); break;
            case "google/gemma-3-4b-it": tags(next, ["input-audio"]); break;
            case "Qwen/Qwen3-VL-30B-A3B-Instruct": tags(next, ["input-video"]); break;
            case "meta-llama/Llama-Guard-4-12B": tags(next, ["tools"]); break;
            case "google/gemma-4-31B-it": tags(next, [], ["input-video"]); break;
            case "ByteDance/Seed-2.0-code": pricing.full = "$0.60 in $3.5 out $0.12 cached <= 128K, $1.2 in $7 out cached"; break;
            case "Qwen/Qwen3-Max": next.max_tokens = 128_000; break;
            case "tencent/Hy3": pricing.cents_per_output_token = 0.00006; break;
            case "Qwen/Qwen3.6-27B": pricing.rate_per_input_token_cached = null; break;
            case "zai-org/GLM-5.3": pricing.rate_per_service_tier_priority = 1.5; break;
            case "moonshotai/Kimi-K3.1-Pro": pricing.rate_per_service_tier_flex = null; break;
            case "moonshotai/Kimi-K3": pricing.rate_per_explicit_cache_write_token = { "5m": 1.25 }; break;
            case "zai-org/GLM-4.6": next.deprecated = 1_700_000_000; break;
            case "MiniMaxAI/MiniMax-M2.5": next.deprecated = null; break;
            case "Qwen/Qwen3.5-4B": next.deprecated = null; tags(next, ["non-reasoning"], ["reasoning"]); break;
          }
          return next;
        });
      const template = raw.find((model: Raw) => model.model_name === "Qwen/Qwen3.5-27B");
      const add = (name: string, extra: Raw) => models.push({ ...structuredClone(template), model_name: name, ...extra });
      add("Qwen/Qwen3-8B", { tags: ["tools", "reasoning", "can-disable-reasoning"] });
      add("acme/brand-new", {});
      add("zai-org/GLM-4.5V", { pricing: { ...template.pricing, cents_per_input_token: null } });
      return models;
    },
  },
  "fireworks-ai": {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const sku = (model: Raw, name: string, amount: string) => {
        model.pricing = model.pricing.map((price: Raw) => (price.sku === name ? { ...price, amount } : price));
      };
      const data = raw.serverless.data
        .filter((model: Raw) => !(model.id === "accounts/fireworks/models/glm-5p3-flash" && model.serverless_mode === "priority"))
        .map((model: Raw) => {
          const next = structuredClone(model);
          if (model.id === "accounts/fireworks/models/minimax-m3" && model.serverless_mode === "priority") sku(next, "LLM input tokens (uncached)", "0.6");
          if (model.id === "accounts/fireworks/models/kimi-k3" && model.serverless_mode === "standard") next.context_length = 500_000;
          if (model.id === "accounts/fireworks/models/ember-1") {
            sku(next, "LLM output tokens", "9.99");
            next.input_modalities = ["text"];
          }
          return next;
        });
      const ember = data.find((model: Raw) => model.id === "accounts/fireworks/models/ember-1");
      const standard = (id: string) => data.find((model: Raw) => model.id === id && model.serverless_mode === "standard");
      data.push({ ...structuredClone(standard("accounts/fireworks/models/ember-1")), serverless_mode: "priority", service_tier: "priority", pricing: ember.pricing.map((price: Raw) => ({ ...price, amount: String(Number(price.amount) * 2) })) });
      data.push({ ...structuredClone(standard("accounts/fireworks/models/rune")), id: "accounts/fireworks/models/brand-new", usage_identifier: undefined });
      const inventory = raw.inventory
        .filter((model: Raw) => model.name !== "accounts/fireworks/models/qwen3p8-2p4t-a95b")
        .map((model: Raw) => (model.name === "accounts/fireworks/models/muse-spark-open" ? { ...model, deprecationDate: { year: 2099, month: 1, day: 1 } } : model));
      inventory.push({ name: "accounts/fireworks/models/brand-new", kind: "HF_BASE_MODEL", supportsServerless: true });
      return { serverless: { ...raw.serverless, data }, inventory };
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
  "novita-ai": {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const decimal = (value: string) => ({ price_per_m_decimal: value });
      const data = raw.data
        .filter((model: Raw) => model.id !== "tencent/hy4-preview")
        .map((model: Raw) => {
          const next = structuredClone(model);
          if (model.id === "tencent/hy4") next.pricing = { ...next.pricing, prompt: decimal("0.5") };
          if (model.id === "zai-org/glm-5.3") next.pricing = { ...next.pricing, input_cache_read: decimal("0") };
          if (model.id === "apodex/apodex-1.1-mini") next.pricing = { ...next.pricing, input_cache_read: decimal("0") };
          if (model.id === "nvidia/nemotron-3-nano-30b-a3b") next.pricing = { ...next.pricing, input_cache_read: decimal("0.01") };
          if (model.id === "qwen/qwen3.8-flash") next.pricing = { ...next.pricing, input_cache_write: decimal("0.3") };
          if (model.id === "zai-org/glm-5.2") next.endpoints = ["chat/completions", "responses", "anthropic"];
          if (model.id === "tencent/hy3") next.endpoints = ["chat/completions", "anthropic"];
          if (model.id === "deepseek/deepseek-v4.1-flash") next.endpoints = ["chat/completions"];
          if (model.id === "stepfun/step-3.7-flash") next.context_size = 65_536;
          if (model.id === "inclusionai/ling-3.0-flash") next.max_output_tokens = 4_096;
          if (model.id === "minimax/minimax-m3") next.tiered_billing_configs[1].pricing.prompt = decimal("0.7");
          if (model.id === "baidu/cobuddy") next.pricing.multimodal_input = [{ modals: ["image"], input_token_base_price: 5_000 }];
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "zai-org/glm-5.3");
      data.push({ ...structuredClone(template), id: "zai-org/glm-6" });
      return { ...raw, data };
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
  tinfoil: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "kimi-k3")
        .map((model: Raw) => {
          const next = structuredClone(model);
          if (model.id === "glm-5-3") next.pricing = { ...next.pricing, inputTokenPricePer1M: 2, cachedInputTokenPricePer1M: 0.5 };
          if (model.id === "deepseek-v4-1-flash") delete next.pricing.cachedInputTokenPricePer1M;
          if (model.id === "llama3-3-70b") next.context_window = 65_536;
          if (model.id === "gpt-oss-120b") next.supported_efforts = ["low", "high"];
          if (model.id === "gemma4-31b") next.reasoning = false;
          if (model.id === "kimi-k3-1-pro") next.supported_efforts = [];
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "glm-5-3");
      data.push({ ...structuredClone(template), id: "glm-6" });
      return { ...raw, data };
    },
  },
  venice: {
    recorded: (raw) => raw,
    perturbed: (raw) => {
      const data = raw.data
        .filter((model: Raw) => model.id !== "qwen3-next-80b")
        .map((model: Raw) => {
          const next = structuredClone(model);
          const spec = next.model_spec;
          const caps = spec.capabilities;
          if (model.id === "gemini-4-argon") spec.pricing.input.usd = 3;
          if (model.id === "grok-4-3") spec.pricing.extended.input.usd = 9;
          if (model.id === "qwen-3-7-plus") delete spec.pricing.cache_input;
          if (model.id === "zai-org-glm-4.6") spec.deprecation = { date: "2026-12-01" };
          if (model.id === "qwen3-vl-235b-a22b") caps.supportsVision = false;
          if (model.id === "zai-org-glm-5-1") caps.reasoningEffortOptions = ["high", "low"];
          if (model.id === "qwen3-235b-a22b-thinking-2507") caps.supportsReasoning = false;
          if (model.id === "grok-4-5") caps.supportsWebSearch = !caps.supportsWebSearch;
          if (model.id === "venice-uncensored-1-2") spec.name = "Venice Uncensored 1.2 Renamed";
          if (model.id === "mistral-small-3-2-24b-instruct") delete spec.maxCompletionTokens;
          if (model.id === "google-gemma-3-27b-it") caps.supportsFunctionCalling = !caps.supportsFunctionCalling;
          return next;
        });
      const template = raw.data.find((model: Raw) => model.id === "mistral-small-3-2-24b-instruct");
      data.push({ ...structuredClone(template), id: "mistral-large-2512", model_spec: { ...structuredClone(template.model_spec), name: "Mistral Large 3" } });
      data.push({ ...structuredClone(template), id: "venice-brand-new", model_spec: { ...structuredClone(template.model_spec), name: "Venice Brand New" } });
      return { ...raw, data };
    },
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
