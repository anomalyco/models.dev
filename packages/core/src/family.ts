import { z } from "zod";

export const ModelFamilyValues = [
  // Arcee
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
  "glm-flash-legal",
  "cogvideox",
  "cogview",
  "glmv-flash",
  "autoglm",
  "glm-asr",
  "glmv-turbo",
  "glm-turbo",
  "glm-image",
  "glm-embedding",
  "glm-z",

  // Meta Llama
  "llama",

  // Meta Muse

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

  // DeepReinforce
  "ornith",

  // DeepSeek
  "deepseek",
  "deepseek-flash",
  "deepseek-ocr",
  "deepseek-pro",
  "deepseek-r",
  "deepseek-flash-think",

  // Microsoft Phi
  "phi",

  // Moonshot Kimi
  "kimi",
  "kimi-code",
  "kimi-pro",

  // Motif Technologies
  "motif",

  // Poolside Laguna
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

  // AI21 Jamba

  // NVIDIA Nemotron
  "nemotron",

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
  "step-vision",
  "step-audio",
  "step-tts",
  "step-asr",

  // Embedding models
  "text-embedding",
  "cohere-embed",
  "voyage",
  "mistral-embed",
  "bge",
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

  // Clarifai
  "mm-poly",

  // Longcat
  "longcat",

  // Magistral
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
  "sarvam-prism",

  // Falcon
  "falcon",

  // Baichuan

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
  "seedance-flash",
  "seed-oss",
  "seed-pro",

  // Ray
  "ray",

  // T-Stars
  "tstars",

  // RNJ
  "rnj",

  // Elorian
  "glimpse",

  // Tecent Hy

  // Ling & Ring (InclusionAI)
  "ling-flash",
  "inkling",
  "inkling-small",
  "inkling-mini",
  "ling-tiny",
  "ming-image",
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

  // Alpha variants (experimental models)

  // OSWE
  "oswe",

  // Neural Chat
  "neural-chat",

  // Pangu (Ascend Tribe)

  // LiquidAI
  "liquid",

  // Sourceful

  // AllenAI
  "allenai",

  // Writer
  "palmyra",
  "palmyra-vision",

  // Paper Instruments
  "ultramarine",

  // ALLaM
  "allam",

  // Canopy Labs

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

  // Base Labs decision models
  "joey",
  "bison",
  "groundhog",

  // Free variants: the base family plus "-free"
  "beam-free",
  "deepseek-flash-free",
  "deepseek-pro-free",
  "ernie-free",
  "fish-s-pro-free",
  "flint-free",
  "gemma-free",
  "glm-flash-free",
  "glm-free",
  "glmv-flash-free",
  "gpt-free",
  "heygen-voice-turbo-free",
  "hy-flash-free",
  "hy-free",
  "inkling-small-free",
  "jev-free",
  "kimi-free",
  "laguna-s-free",
  "lfm-free",
  "ling-flash-free",
  "ling-tiny-free",
  "longcat-free",
  "mimo-flash-free",
  "mimo-free",
  "mimo-omni-free",
  "mimo-pro-free",
  "minimax-m-flash-free",
  "minimax-m-free",
  "muse-glimmer-free",
  "muse-spark-free",
  "nemotron-embed-free",
  "nemotron-lightning-free",
  "nemotron-nano-free",
  "nemotron-safety-free",
  "nemotron-super-free",
  "nemotron-ultra-free",
  "north-mini-free",
  "particle-free",
  "qwen-flash-free",
  "qwen-free",
  "qwen-max-free",
  "qwen-plus-free",
  "ring-free",
  "solar-mini-free",
  "step-flash-free",
  "step-free",
  "trinity-large-free",

  // Product lines (one per lab, type and size tier)
  "aion",
  "ampersand",
  "eva",
  "aion-mini",
  "aion-rp",
  "apertus",
  "apodex-mini",
  "arrow",
  "assemblyai-universal",
  "asure",
  "aya",
  "aya-tiny",
  "aya-vision",
  "baichuan-m",
  "bge-base",
  "bge-large",
  "bge-reranker",
  "bge-small",
  "blink",
  "chatterbox",
  "cicero",
  "clef",
  "clef-flash",
  "clip",
  "cohere-embed-fast",
  "cohere-embed-light",
  "cohere-embed-pro",
  "cohere-rerank",
  "cohere-rerank-fast",
  "cohere-rerank-pro",
  "cohere-transcribe",
  "command-a-plus",
  "command-r-plus",
  "csm",
  "cydonia",
  "d3",
  "d3-flash",
  "d3-mini",
  "decider",
  "deepgram-flux",
  "deepgram-nova",
  "devstral-medium",
  "devstral-small",
  "dolphin",
  "dracarys",
  "drex",
  "e5-base",
  "e5-large",
  "e5-multilingual",
  "elevenlabs-flash",
  "elevenlabs-multilingual",
  "elevenlabs-turbo",
  "ember",
  "euryale",
  "fibo",
  "fish-drama",
  "fish-s",
  "fish-s-pro",
  "fish-transcribe",
  "fish-transcribe-pro",
  "flux-dev",
  "flux-flex",
  "flux-klein",
  "flux-kontext-dev",
  "flux-kontext-max",
  "flux-kontext-pro",
  "flux-max",
  "flux-pro",
  "flux-schnell",
  "flux-video",
  "fugu-max",
  "fugu-ultra",
  "granite-micro",
  "granite-small",
  "heygen-avatar",
  "heygen-video",
  "heygen-voice",
  "heygen-voice-turbo",
  "inworld-tts",
  "inworld-tts-max",
  "inworld-tts-mini",
  "jamba-large",
  "jamba-mini",
  "jev",
  "kev",
  "kokoro",
  "kolibri",
  "krea",
  "krea-large",
  "krea-medium",
  "krea-medium-turbo",
  "laguna-m",
  "laguna-xs",
  "levanto-sage",
  "lfm",
  "lfm-embedding",
  "lightonocr",
  "liquid-decision",
  "llama-guard",
  "llama-prompt-guard",
  "lunaris",
  "macaron-tall",
  "macaron-venti",
  "magnum",
  "mai-code",
  "mai-code-flash",
  "mai-image",
  "mai-image-flash",
  "mai-image-pro",
  "mai-transcribe",
  "mai-voice",
  "mai-voice-flash",
  "mammoth",
  "mercury-coder",
  "mercury-decide",
  "mercury-edit",
  "microsoft-decision",
  "mineru",
  "minicpm",
  "minicpm-v",
  "minilm",
  "mistral-moderation",
  "mistral-ocr",
  "morph-fast",
  "morph-large",
  "morph-reflex",
  "mpnet",
  "muse-ember",
  "muse-glimmer",
  "muse-image",
  "muse-spark",
  "muse-transcribe",
  "muse-video",
  "muse-wonder",
  "mxbai-embed",
  "mythomax",
  "nemotron-asr",
  "nemotron-cascade",
  "nemotron-embed",
  "nemotron-lightning",
  "nemotron-mini",
  "nemotron-nano",
  "nemotron-rerank",
  "nemotron-safety",
  "nemotron-super",
  "nemotron-ultra",
  "nemotron-voice",
  "nex-n",
  "nex-n-mini",
  "nex-n-pro",
  "nomic-embed",
  "north-mini",
  "north-small",
  "nova-premier",
  "olmocr",
  "omnivoice",
  "orpheus",
  "paddleocr",
  "pangu-flash",
  "pangu-pro",
  "pareto",
  "particle",
  "perceptron-mk",
  "phi-mini",
  "phocinae-largha",
  "phonellm-mini",
  "pixtral-large",
  "plamo-embedding",
  "pplx-decider",
  "pplx-decider-flash",
  "pplx-embed",
  "pplx-embed-context",
  "recraft-flash",
  "recraft-pro",
  "relace-apply",
  "relace-search",
  "remm",
  "restyler",
  "riverflow-fast",
  "riverflow-pro",
  "rune",
  "runway-aleph",
  "runway-gen",
  "schematron-small",
  "schematron-turbo",
  "scribe",
  "sea-lion",
  "skyfall",
  "sonar-reasoning-pro",
  "span",
  "text2vec",
  "toast",
  "trinity-large",
  "trinity-nano",
  "turion-extract",
  "turion-jev",
  "uae",
  "unslopnemo",
  "vispark-vision-large",
  "vispark-vision-medium",
  "vispark-vision-small",
  "viv",
  "voxtral-mini",
  "voxtral-small",
  "voxtral-transcribe",
  "voxtral-tts",
  "voyage-code",
  "voyage-large",
  "voyage-lite",
  "voyage-multimodal",
  "voyage-rerank",
  "voyage-rerank-lite",
  "weaver",
  "wizardlm",
] as const;

export const ModelFamily = z.enum(ModelFamilyValues);
export type ModelFamily = z.infer<typeof ModelFamily>;

export function inferKimiFamily(...values: string[]): ModelFamily | undefined {
  const target = values.join(" ").toLowerCase();
  if (!/kimi[\s_-]*k\d/.test(target)) return undefined;
  if (/code/.test(target)) return "kimi-code";
  if (/[^a-z0-9]pro(?:$|[^a-z0-9])/.test(target)) return "kimi-pro";
  return "kimi";
}
