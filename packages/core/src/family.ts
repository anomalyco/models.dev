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
  "gpt-astra",
  "gpt-oss",
  "gpt-image",
  "gpt-live",
  "gpt-audio",
  "gpt-audio-mini",
  "gpt-image-mini",
  "gpt-realtime",
  "gpt-realtime-mini",
  "gpt-realtime-translate",
  "gpt-transcribe",
  "gpt-transcribe-mini",
  "gpt-tts",
  "gpt-tts-mini",
  "gpt-oss-safeguard",
  "omni-moderation",

  // OpenAI o-series (reasoning models)
  "o",
  "o-mini",
  "o-pro",
  "o-deep-research",
  "o-deep-research-mini",

  // Anthropic style
  "claude",
  "claude-haiku",
  "claude-sonnet",
  "claude-opus",
  "claude-fable",
  "claude-mythos",

  // Gemini style
  "gemini",
  "gemini-pro",
  "gemini-flash",
  "gemini-flash-lite",
  "gemini-embedding",
  "gemini-live",
  "gemini-live-translate",
  "gemini-tts-flash",
  "gemini-tts-flash-lite",
  "gemini-tts-pro",
  "gemini-transcribe",
  "gemini-omni-flash",
  "gemini-decision",
  "gemini-robotics-er",
  "gemini-robotics-er-live",
  "gemini-computer-use",
  "gemini-deep-research",
  "gemini-deep-research-max",
  "nano-banana-pro",
  "nano-banana-lite",
  "google-text-embedding",
  "chirp",
  "genie",

  // GLM (zai)
  "glm",
  "glmv",
  "glm-air",
  "glm-flash",
  "cogvideox",
  "glmv-flash",
  "autoglm",
  "glm-asr",
  "glmv-turbo",
  "glm-turbo",
  "glm-image",
  "glm-embedding",
  "glm-free",
  "glm-z",

  // Meta Llama
  "llama",

  // Meta Muse
  "muse",
  "muse-free",

  // Alibaba Qwen
  "qwen",
  "qwq",
  "wan",
  "qwen-coder",
  "qwen-tts-flash",
  "qwen-asr-flash",
  "qwen-embedding",
  "qwen-flash",
  "qwen-vl",
  "qwen-image",
  "qwen-max",
  "qwen-vl-plus",
  "qwen-vl-flash",
  "qwen-plus",
  "gte",
  "qwen-image-pro",
  "happyhorse",
  "qwen-omni",
  "qwen-embedding-flash",
  "qwen-coder-flash",
  "qwen-reranker",
  "qwen-omni-flash",
  "qwen-asr",
  "qwen-tts-plus",
  "qwen-image-turbo",
  "qwen-vl-max",
  "qwen-mt-plus",
  "qwen-turbo",
  "qwen-coder-plus",
  "qwen-math-turbo",
  "qwen-math-plus",
  "qwen-omni-realtime-flash",
  "qwen-mt-turbo",
  "tongyi",
  "qwen-omni-realtime",
  "qwen-livetranslate",
  "qwen-tts",
  "qwen-free",

  // DeepReinforce
  "ornith",

  // DeepSeek
  "deepseek",
  "deepseek-flash",
  "deepseek-ocr",
  "deepseek-pro",
  "deepseek-r",
  "deepseek-flash-free",
  "deepseek-flash-think",

  // Microsoft Phi
  "phi",

  // Moonshot Kimi
  "kimi",
  "kimi-code",
  "kimi-pro",
  "kimi-free",

  // Motif Technologies
  "motif",

  // Poolside Laguna
  "laguna",
  "laguna-s",

  // Reflection Beam
  "beam",

  // Recursive Flint
  "flint",

  // Mistral family
  "mistral",
  "mistral-large",
  "mistral-medium",
  "mistral-small",
  "mistral-nemo",
  "ministral",
  "codestral",
  "devstral",
  "leanstral",
  "pixtral",
  "mixtral",

  // xAI Grok
  "grok",
  "grok-build",
  "grok-vision",
  "grok-beta",
  "grok-code",
  "grok-imagine-image",
  "grok-imagine-video",
  "grok-imagine-video-lite",
  "grok-tts",
  "grok-voice",
  "grok-transcribe",

  // Google Gemma
  "gemma",
  "gemma-embedding",
  "gemma-diffusion",

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
  "minimax-m",
  "minimax-m-flash",
  "minimax-h",
  "minimax-h-lite",
  "minimax-h-max",
  "minimax-h-image",
  "minimax-image",
  "minimax-speech",
  "hailuo",

  // Hunyuan
  "hunyuan",

  // Hy
  "hy-mt",
  "kinfra-embedding",
  "hy-flash",
  "hy",
  "hy-image",

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
  "step-flash",
  "step-tts",
  "step-asr",

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
  "veo-lite",
  "runway",
  "dream-machine",

  // Audio/Speech
  "whisper",
  "elevenlabs",
  "lyria",
  "lyria-pro",
  "lyria-clip",
  "lyria-realtime",
  "melotts",

  // Baidu Ernie
  "ernie",
  "cobuddy",

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
  "mimo-asr",
  "mimo-tts",
  "mimo-flash",
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
  "seedance-pro",
  "seed-tts",
  "seedance",
  "seed-lite",
  "seed-mini",
  "seed-code",
  "seedream",
  "seedream-flash",
  "seed-flash",
  "seedream-pro",
  "seed-turbo",
  "seedream-lite",
  "seedance-mini",
  "seed-oss",
  "seed-pro",

  // Ray
  "ray",

  // T-Stars
  "tstars",

  // RNJ
  "rnj",

  // Tecent Hy
  "hy3-free",

  // Ling & Ring (InclusionAI)
  "ling-flash",
  "inkling",
  "inkling-small",
  "ling-tiny",
  "ming-image",
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

  // Sakana Namazu
  "sakana-namazu",

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

  // Kuaishou Kling
  "kling-flash",
  "kling-image",
  "kling",
  "kling-omni",
  "kling-image-omni",
  "kling-turbo",

  // Elephant
  "elephant",
] as const;

export const ModelFamily = z.enum(ModelFamilyValues);
export type ModelFamily = z.infer<typeof ModelFamily>;

export function inferKimiFamily(...values: string[]): ModelFamily | undefined {
  const target = values.join(" ").toLowerCase();
  if (!/kimi[\s_-]*k\d/.test(target)) return undefined;
  if (/code/.test(target)) return "kimi-code";
  if (/[^a-z0-9]pro(?:$|[^a-z0-9])/.test(target)) return "kimi-pro";
  return "kimi";
  return undefined;
}
