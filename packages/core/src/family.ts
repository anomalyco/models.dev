import { z } from "zod";

export const ModelFamilyValues = [
  // Arcee
  "trinity",
  "trinity-mini",

  // OpenAI/GPT style
  "gpt",
  "gpt-codex",
  "gpt-codex-spark",
  "gpt-codex-mini",
  "gpt-pro",
  "gpt-mini",
  "gpt-nano",
  "gpt-sol",
  "gpt-terra",
  "gpt-luna",
  "gpt-oss",
  "gpt-image",

  // OpenAI o-series (reasoning models)
  "o",
  "o-mini",
  "o-pro",

  // Anthropic style
  "claude",
  "claude-haiku",
  "claude-sonnet",
  "claude-opus",
  "claude-fable",

  // Gemini style
  "gemini",
  "gemini-pro",
  "gemini-flash",
  "gemini-flash-lite",
  "gemini-embedding",

  // GLM (zai)
  "glm",
  "glmv",
  "glm-air",
  "glm-flash",
  "glm-free",
  "glm-z",

  // Meta Llama
  "llama",

  // Meta Muse
  "muse",

  // Alibaba Qwen
  "qwen",
  "qwen3.5",
  "qwen3.6",
  "qwen3.7-plus",
  "qwen3.7-max",
  "qwen-free",

  // DeepReinforce
  "ornith",

  // DeepSeek
  "deepseek",
  "deepseek-thinking",
  "deepseek-flash",
  "deepseek-flash-free",
  "deepseek-flash-think",

  // Microsoft Phi
  "phi",

  // Moonshot Kimi
  "kimi",
  "kimi-k2",
  "kimi-k3",
  "kimi-free",
  "kimi-thinking",

  // Poolside Laguna
  "laguna",

  // Mistral family
  "mistral",
  "mistral-large",
  "mistral-medium",
  "mistral-small",
  "mistral-nemo",
  "ministral",
  "codestral",
  "devstral",
  "pixtral",
  "mixtral",

  // xAI Grok
  "grok",
  "grok-build",
  "grok-vision",
  "grok-beta",

  // Google Gemma
  "gemma",

  // AWS Nova
  "nova",
  "nova-pro",
  "nova-lite",
  "nova-micro",

  // Cohere Command
  "command",
  "command-r",
  "command-a",
  "command-light",
  "north",
  "north-free",

  // AI21 Jamba
  "jamba",

  // NVIDIA Nemotron
  "nemotron",
  "nemotron-free",

  // AWS Titan
  "titan",
  "titan-embed",

  // MiniMax
  "minimax",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
  "minimax-m3-free",
  "minimax-free",

  // Hunyuan
  "hunyuan",

  // Hy
  "Hy",

  // Yi
  "yi",

  // Granite
  "granite",

  // Reka
  "reka",

  // Sonar (Perplexity)
  "sonar",
  "sonar-pro",
  "sonar-reasoning",
  "sonar-deep-research",

  // Solar
  "solar",
  "solar-mini",
  "solar-pro",

  // Step (StepFun)
  "step",

  // Embedding models
  "text-embedding",
  "cohere-embed",
  "voyage",
  "mistral-embed",
  "bge",
  "plamo",
  "codestral-embed",

  // Image generation
  "dall-e",
  "flux",
  "imagen",
  "recraft",
  "stable-diffusion",
  "ideogram",
  "dreamshaper",

  // Video generation
  "sora",
  "veo",
  "runway",
  "dream-machine",

  // Audio/Speech
  "whisper",
  "elevenlabs",
  "lyria",
  "melotts",

  // Baidu Ernie
  "ernie",

  // Hermes
  "hermes",

  // Zephyr
  "zephyr",

  // OpenChat
  "openchat",

  // Starling
  "starling",

  // Qwen QVQ
  "qvq",

  // Sherlock
  "sherlock",

  // Pony
  "pony",

  // Mercury
  "mercury",

  // Cogito
  "cogito",

  // Mimo
  "mimo",
  "mimo-pro",
  "mimo-omni",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "mimo-v2.5-free",
  "mimo-pro-free",
  "mimo-omni-free",
  "mimo-flash-free",

  // Clarifai
  "mm-poly",

  // Longcat
  "longcat",

  // Magistral
  "magistral",
  "magistral-small",
  "magistral-medium",

  // Phoenix
  "phoenix",

  // Trinity
  "trinity",

  // Lucid
  "lucid",

  // LucidQuery
  "agi",

  // Intellect
  "intellect",

  // Aura (Stability AI)
  "aura",

  // JAIS
  "jais",

  // Sarvam
  "sarvam",

  // Falcon
  "falcon",

  // Baichuan
  "baichuan",

  // Skywork
  "skywork",

  // BART
  "bart",

  // DistilBERT
  "distilbert",

  // ResNet
  "resnet",

  // M2M100
  "m2m",

  // IndicTrans
  "indictrans",

  // LLaVA
  "llava",

  // Seed
  "seed",

  // Ray
  "ray",

  // T-Stars
  "tstars",

  // RNJ
  "rnj",

  // Tecent Hy
  "hy3",
  "hy3-free",

  // Ling & Ring (InclusionAI)
  "ling",
  "ling-flash-free",
  "ring",
  "ring-1t-free",

  // Kat Coder
  "kat-coder",

  // SQL Coder
  "sqlcoder",

  // DiscoLM
  "discolm",

  // Osmosis
  "osmosis",

  // Parakeet
  "parakeet",

  // NeMo
  "nemoretriever",

  // Nano Banana
  "nano-banana",

  // Una Cybertron
  "una-cybertron",

  // Morph
  "morph",

  // Voxtral
  "voxtral",

  // Venice
  "venice",

  // Auto router
  "auto",
  "model-router",

  // Conductor
  "fugu",

  // V0
  "v0",

  // Tako
  "tako",

  // MAI
  "mai",

  // RedNote
  "rednote",

  // Smart Turn
  "smart-turn",

  // Qwerky
  "qwerky",

  // Big Pickle
  "big-pickle",

  // Chutes AI
  "chutesai",

  // OpenGVLab
  "opengvlab",

  // TNG Tech
  "tngtech",

  // TopazLabs
  "topazlabs",

  // Unsloth
  "unsloth",

  // Nousresearch
  "nousresearch",

  // Alpha variants (experimental models)
  "alpha",

  // OSWE
  "oswe",

  // Neural Chat
  "neural-chat",

  // Pangu (Ascend Tribe)
  "pangu",

  // LiquidAI
  "liquid",

  // Sourceful
  "sourceful",

  // AllenAI
  "allenai",

  // Writer
  "palmyra",

  // ALLaM
  "allam",

  // Canopy Labs
  "canopylabs",

  // Groq
  "groq",

  // Elephant
  "elephant",
] as const;

export const ModelFamily = z.enum(ModelFamilyValues);
export type ModelFamily = z.infer<typeof ModelFamily>;

export function inferKimiFamily(...values: string[]): ModelFamily | undefined {
  const target = values.join(" ").toLowerCase();
  if (/kimi[^a-z0-9]*k2(?:[^a-z0-9]*\d+)?[^a-z0-9]*thinking/.test(target)) return "kimi-thinking";
  if (/kimi[\s_-]*k2/.test(target)) return "kimi-k2";
  if (/kimi[\s_-]*k3/.test(target)) return "kimi-k3";
  return undefined;
}

// Families named after image/video generators (e.g. "flux", "sora") are strictly
// output-modality families: a name/id substring match against one of these is only
// valid when the model's own declared output modalities agree. This stops a model
// that merely shares a name with an image or video generator (e.g. Deepgram's ASR
// model "flux", which outputs text) from being stamped with that generator's family.
const IMAGE_FAMILIES = new Set<ModelFamily>([
  "dall-e", "flux", "imagen", "recraft", "stable-diffusion", "ideogram", "dreamshaper", "gpt-image", "nano-banana",
]);

const VIDEO_FAMILIES = new Set<ModelFamily>(["sora", "veo", "runway", "dream-machine", "ray"]);

export function familyMatchesModalities(family: ModelFamily, outputModalities: string[]): boolean {
  if (IMAGE_FAMILIES.has(family)) return outputModalities.includes("image");
  if (VIDEO_FAMILIES.has(family)) return outputModalities.includes("video");
  return true;
}
