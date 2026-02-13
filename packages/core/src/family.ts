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
  "gpt-oss",

  // OpenAI o-series (reasoning models)
  "o",
  "o-mini",
  "o-pro",

  // Anthropic style
  "claude",
  "claude-haiku",
  "claude-sonnet",
  "claude-opus",

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

  // Alibaba Qwen
  "qwen",

  // DeepSeek
  "deepseek",
  "deepseek-thinking",

  // Microsoft Phi
  "phi",

  // Moonshot Kimi
  "kimi",
  "kimi-free",
  "kimi-thinking",

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

  // AI21 Jamba
  "jamba",

  // NVIDIA Nemotron
  "nemotron",

  // AWS Titan
  "titan",
  "titan-embed",

  // MiniMax
  "minimax",
  "minimax-free",

  // Hunyuan
  "hunyuan",

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

  // Exaone
  "exaone",

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

  // Ling & Ring (InclusionAI)
  "ling",
  "ring",

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
] as const;

export const ModelFamily = z.enum(ModelFamilyValues);
export type ModelFamily = z.infer<typeof ModelFamily>;
