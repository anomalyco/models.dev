type Modality = "text" | "audio" | "image" | "video" | "pdf";

export interface DescriptionInput {
  id?: string;
  providerId?: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  open_weights?: boolean;
  status?: "alpha" | "beta" | "deprecated";
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  modalities?: {
    input?: Modality[];
    output?: Modality[];
  };
}

export function describeModel(model: DescriptionInput) {
  const id = model.id ?? "";
  const name = model.name ?? humanizeID(id);
  const lab = labID(id, model.providerId);
  const target = `${id} ${name} ${model.family ?? ""}`.toLowerCase();
  const input = model.modalities?.input ?? [];
  const output = model.modalities?.output ?? [];
  const multimodal = input.some((value) => value !== "text");
  const fast = has(target, /\b(flash|lite|mini|nano|small|fast|highspeed|ultraspeed|instant|turbo|micro)\b/);
  const frontier = has(target, /\b(pro|opus|max|ultra|premier|large|frontier|maverick|behemoth|5\.5|5\.4|5\.3|4\.8|4\.7|4\.6|m3)\b/);
  const free = has(target, /(^|[^a-z])free([^a-z]|$)|:free\b/);
  const preview = model.status === "beta" || has(target, /\b(preview|beta|experimental)\b/);

  if (model.status === "deprecated") {
    return "Legacy model retained for compatibility with older integrations";
  }

  const special = specialDescription({
    id,
    lab,
    name,
    target,
    input,
    output,
    multimodal,
    fast,
    frontier,
    free,
    preview,
    model,
  });
  if (special !== undefined) return special;

  if (free) {
    return "Free provider route for experiments, demos, and cost-sensitive chat workloads";
  }

  if (preview) {
    return "Preview model for early access evaluation, prototyping, and compatibility testing";
  }

  if (model.reasoning === true) {
    if (fast) {
      return "Efficient reasoning model for fast analysis, coding help, and agent workflows";
    }
    if (frontier) {
      return "Flagship reasoning model for complex planning, coding, math, and tool use";
    }
    return "Reasoning model for deliberate analysis, multi-step problem solving, and tool use";
  }

  if (multimodal) {
    return "Multimodal model for analyzing text, images, documents, and rich media";
  }

  if (model.open_weights === true) {
    return "Open-weight instruction model for adaptable chat and self-hosted production workloads";
  }

  if (fast) {
    return "Fast chat model for everyday assistance, extraction, and high-volume workloads";
  }

  if (frontier) {
    return "Flagship chat model for high-quality writing, analysis, coding, and tools";
  }

  if (model.tool_call === true) {
    return "Tool-capable chat model for instruction following and agentic application workflows";
  }

  return "General-purpose chat model for instruction following, writing, and analysis";
}

interface SpecialDescriptionContext {
  id: string;
  lab: string | undefined;
  name: string;
  target: string;
  input: Modality[];
  output: Modality[];
  multimodal: boolean;
  fast: boolean;
  frontier: boolean;
  free: boolean;
  preview: boolean;
  model: DescriptionInput;
}

function specialDescription(context: SpecialDescriptionContext) {
  const { lab, target, input, output, multimodal, fast, frontier, model } = context;

  if (has(target, /\b(auto|router|route)\b/) && lab !== "openrouter") {
    return "Automatic model router for matching prompts to suitable backends and budgets";
  }

  if (has(target, /\b(embed|embedding|e5)\b/)) {
    return "Embedding model for semantic search, retrieval, clustering, and ranking pipelines";
  }
  if (has(target, /\b(rerank|reranker)\b/)) {
    return "Reranking model for improving retrieval quality in search and recommendation systems";
  }
  if (has(target, /\b(safety|guard|moderation|safeguard)\b/)) {
    return "Safety model for policy screening, moderation, and risk-aware routing workflows";
  }
  if (has(target, /\b(ocr|document-ocr)\b/)) {
    return "OCR model for extracting structured text from documents and screenshots";
  }
  if (has(target, /\b(translate|translation|mt)\b/)) {
    return "Translation model for multilingual conversion, localization, and cross-language workflows";
  }
  if (has(target, /\b(asr|stt|transcribe|transcription|whisper)\b/)) {
    return "Speech transcription model for accurate audio-to-text and captioning workflows";
  }
  if (has(target, /\bomni\b/)) {
    if (has(target, /\bqwen\b/)) return qwenDescription(context);
    if (has(target, /\bmimo\b/)) return mimoDescription(context);
    return "Omni-modal model for text, vision, audio, and multimodal agent tasks";
  }
  if (has(target, /\b(tts|speech|voice|voiceclone|voicedesign)\b/) || (input.includes("text") && output.includes("audio"))) {
    return "Speech generation model for controllable voice, narration, and audio delivery";
  }
  if (has(target, /\b(image|imagine|imagen|flux|sdxl|stable-diffusion)\b/) || output.includes("image")) {
    return "Image model for prompt-driven generation, editing, and visual design workflows";
  }
  if (has(target, /\b(video|veo|sora|ray|hailuo|kling)\b/) || output.includes("video")) {
    return "Video model for prompt-guided generation, editing, and motion workflows";
  }

  if (lab === "openai" || has(target, /\b(gpt|openai|whisper)\b|(^|[^a-z])o\d/)) {
    return openAIDescription(context);
  }
  if (lab === "anthropic" || has(target, /\bclaude\b/)) return anthropicDescription(context);
  if (lab === "google" || has(target, /\b(gemini|gemma)\b/)) return googleDescription(context);
  if (lab === "mistral" || has(target, /\b(mistral|codestral|devstral|magistral|pixtral|ministral)\b/)) {
    return mistralDescription(context);
  }
  if (lab === "alibaba" || has(target, /\b(qwen|qwq)\b/)) return qwenDescription(context);
  if (lab === "deepseek" || has(target, /\bdeepseek\b/)) return deepSeekDescription(context);
  if (lab === "xai" || has(target, /\bgrok\b/)) return xaiDescription(context);
  if (lab === "minimax" || has(target, /\bminimax\b/)) return miniMaxDescription(context);
  if (lab === "nvidia" || has(target, /\bnemotron\b/)) return nvidiaDescription(context);
  if (lab === "meta" || has(target, /\bllama\b/)) return metaDescription(context);
  if (lab === "zhipuai" || lab === "zai" || has(target, /\bglm\b/)) return glmDescription(context);
  if (lab === "moonshotai" || has(target, /\bkimi\b/)) return kimiDescription(context);
  if (lab === "xiaomi" || has(target, /\bmimo\b/)) return mimoDescription(context);
  if (lab === "stepfun" || has(target, /\bstep[-\s]?\d/)) return stepDescription(context);
  if (lab === "cohere" || has(target, /\b(command|north)\b/)) return cohereDescription(context);
  if (lab === "perplexity" || has(target, /\bsonar\b/)) return perplexityDescription(context);
  if (lab === "sarvam" || has(target, /\bsarvam\b/)) return sarvamDescription(context);
  if (lab === "tencent" || has(target, /\bhy3|hunyuan\b/)) return tencentDescription(context);
  if (lab === "sakana" || has(target, /\bfugu\b/)) return sakanaDescription(context);
  if (lab === "deepreinforce" || has(target, /\bornith\b/)) return ornithDescription(context);

  if (has(target, /\b(coder|coding|code|software|dev)\b/)) {
    return "Coding model for repository understanding, refactors, and agentic engineering tasks";
  }
  if (multimodal && model.reasoning === true) {
    return "Multimodal reasoning model for visual analysis, planning, and tool use";
  }
  if (frontier) {
    return "Flagship model for demanding analysis, coding, and production agent workflows";
  }
  if (fast) {
    return "Efficient model for low-latency assistance, extraction, and routine automation";
  }
}

function openAIDescription({ id, name, target, fast, frontier }: SpecialDescriptionContext) {
  const modelName = `${id} ${name}`.toLowerCase();

  if (has(modelName, /\bcodex\b/)) {
    return "Coding-optimized GPT model for repository edits, reviews, and agentic software work";
  }
  if (has(target, /\bdeep[-\s]?research\b/)) {
    return "Research model for long-horizon investigation, synthesis, and analytical reports";
  }
  if (has(target, /(^|[^a-z])o\d|reasoning/)) {
    return "O-series reasoning model for hard analysis, math, coding, and planning";
  }
  if (has(target, /\bgpt-oss\b/)) {
    return "Open-weight GPT model for self-hosted reasoning and instruction-following workloads";
  }
  if (has(target, /\bchat\b/)) {
    return "Chat-tuned GPT model for conversational assistance, writing, and tool workflows";
  }
  if (fast) {
    return "Compact GPT model for low-latency assistance and high-volume workloads";
  }
  if (frontier) {
    return "Frontier GPT model for professional reasoning, coding, and multimodal work";
  }
  return "GPT model for general reasoning, writing, coding, and tool-assisted tasks";
}

function anthropicDescription({ target, fast }: SpecialDescriptionContext) {
  if (has(target, /\bopus\b/)) {
    return "Flagship Claude model for deep reasoning, coding, and long-horizon agents";
  }
  if (has(target, /\bsonnet\b/)) {
    return "Balanced Claude model for coding, analysis, agent workflows, and cost control";
  }
  if (has(target, /\bhaiku\b/)) {
    return "Fast Claude model for responsive assistance, classification, and lightweight agents";
  }
  if (has(target, /\bfable\b/)) {
    return "Claude model for creative writing, analysis, and controlled agent workflows";
  }
  return fast
    ? "Efficient Claude model for quick analysis, writing, and tool use"
    : "Claude model for careful reasoning, writing, coding, and tool use";
}

function googleDescription({ target, fast, frontier, multimodal }: SpecialDescriptionContext) {
  if (has(target, /\bgemma\b/)) {
    return "Open Gemma instruction model for efficient chat and self-hosted deployments";
  }
  if (has(target, /\bflash[-\s]?lite\b/)) {
    return "Low-latency Gemini model for high-volume multimodal and agent workloads";
  }
  if (has(target, /\bflash\b/)) {
    return "Fast Gemini model balancing multimodal reasoning, tool use, and cost";
  }
  if (has(target, /\bpro\b/) || frontier) {
    return "Advanced Gemini model for complex reasoning, coding, and multimodal analysis";
  }
  if (multimodal) {
    return "Gemini multimodal model for text, image, audio, video, and document tasks";
  }
  return fast
    ? "Efficient Gemini model for quick assistance and high-volume automation"
    : "Gemini model for general assistance, reasoning, and multimodal workflows";
}

function mistralDescription({ target, fast, frontier }: SpecialDescriptionContext) {
  if (has(target, /\bcodestral\b/)) {
    return "Mistral coding model for code completion, generation, and developer workflows";
  }
  if (has(target, /\bdevstral\b/)) {
    return "Mistral coding agent model for repository tasks and software engineering workflows";
  }
  if (has(target, /\bmagistral\b/)) {
    return "Mistral reasoning model for transparent analysis, math, and complex decisions";
  }
  if (has(target, /\bpixtral\b/)) {
    return "Mistral vision-language model for image understanding and multimodal chat";
  }
  if (has(target, /\bministral\b/)) {
    return "Compact Mistral model for edge, latency-sensitive, and cost-efficient workloads";
  }
  if (frontier || has(target, /\blarge\b/)) {
    return "Flagship Mistral model for advanced reasoning, coding, and multilingual work";
  }
  if (fast || has(target, /\bsmall\b/)) {
    return "Efficient Mistral model for fast chat, extraction, and production assistants";
  }
  return "Mistral model for multilingual chat, reasoning, and tool-assisted workflows";
}

function qwenDescription({ target, fast, frontier, multimodal }: SpecialDescriptionContext) {
  if (has(target, /\bcoder\b/)) {
    return "Qwen coding model for software agents, repository edits, and code reasoning";
  }
  if (has(target, /\bomni\b/)) {
    return "Qwen omni model for text, vision, audio, and multimodal agent tasks";
  }
  if (has(target, /\bvl\b/) || multimodal) {
    return "Qwen vision-language model for visual reasoning, documents, and agent tasks";
  }
  if (has(target, /\bqwq|thinking\b/)) {
    return "Qwen reasoning model for deliberate problem solving, math, and coding";
  }
  if (frontier || has(target, /\bmax\b/)) {
    return "Flagship Qwen model for complex reasoning, coding, and agentic workflows";
  }
  if (fast || has(target, /\bflash|turbo\b/)) {
    return "Efficient Qwen model for fast chat, extraction, and high-volume workloads";
  }
  return "Qwen instruction model for multilingual chat, reasoning, and tool use";
}

function deepSeekDescription({ target, fast, frontier }: SpecialDescriptionContext) {
  if (has(target, /\breasoner|r1\b/)) {
    return "DeepSeek reasoning model for multi-step analysis, math, coding, and tools";
  }
  if (fast || has(target, /\bflash\b/)) {
    return "Fast DeepSeek model for efficient chat, coding help, and agent loops";
  }
  if (frontier || has(target, /\bpro|v4\b/)) {
    return "Flagship DeepSeek model for coding, reasoning, and agentic work";
  }
  return "DeepSeek chat model for instruction following, coding, and analysis";
}

function xaiDescription({ target, fast }: SpecialDescriptionContext) {
  if (has(target, /\bbuild\b/)) {
    return "Grok coding model for agentic engineering, edits, and codebase workflows";
  }
  if (fast) {
    return "Fast Grok model for responsive chat, reasoning, and tool-assisted work";
  }
  return "Grok model for agentic tool use, reasoning, coding, and live assistance";
}

function miniMaxDescription({ target, fast, frontier, multimodal }: SpecialDescriptionContext) {
  if (has(target, /\bhighspeed|lightning\b/)) {
    return "High-speed MiniMax model for low-latency coding and agent workflows";
  }
  if (multimodal || has(target, /\bm3\b/)) {
    return "MiniMax multimodal coding model for long-context reasoning and agent tasks";
  }
  if (frontier) {
    return "Frontier MiniMax model for engineering, office tasks, and agentic reasoning";
  }
  if (fast) {
    return "Efficient MiniMax model for quick assistance, coding, and routine automation";
  }
  return "MiniMax model for chat, coding, office work, and agentic tasks";
}

function nvidiaDescription({ target, fast, frontier, multimodal }: SpecialDescriptionContext) {
  if (has(target, /\bvoice\b/)) {
    return "Nemotron voice model for conversational audio and speech-enabled assistants";
  }
  if (has(target, /\bembed\b/)) {
    return "Nemotron embedding model for multimodal retrieval and semantic search";
  }
  if (has(target, /\brerank\b/)) {
    return "Nemotron reranker for improving retrieval quality across text and vision search";
  }
  if (has(target, /\bsafety|guard\b/)) {
    return "Nemotron safety model for moderation, policy checks, and safe routing";
  }
  if (multimodal) {
    return "Nemotron multimodal model for visual reasoning and agentic AI workflows";
  }
  if (frontier || has(target, /\bultra\b/)) {
    return "Flagship Nemotron model for high-throughput reasoning and complex agents";
  }
  if (fast || has(target, /\bnano\b/)) {
    return "Compact Nemotron model for efficient reasoning and deployable AI agents";
  }
  return "Nemotron model for efficient reasoning, coding, and specialized AI agents";
}

function metaDescription({ target, fast, multimodal }: SpecialDescriptionContext) {
  if (has(target, /\bscout\b/)) {
    return "Open multimodal Llama model for long-context analysis and efficient agents";
  }
  if (has(target, /\bmaverick\b/)) {
    return "Open multimodal Llama model for strong reasoning and fast responses";
  }
  if (multimodal) {
    return "Open Llama multimodal model for image understanding and text reasoning";
  }
  if (fast) {
    return "Compact Llama instruction model for fast chat and local deployment";
  }
  return "Open Llama instruction model for multilingual chat, reasoning, and coding";
}

function glmDescription({ target, fast, multimodal }: SpecialDescriptionContext) {
  if (multimodal || has(target, /\bv\b/)) {
    return "GLM vision model for visual reasoning, documents, and multimodal agents";
  }
  if (fast || has(target, /\bflash|turbo|air\b/)) {
    return "Efficient GLM model for fast reasoning, coding, and agent workflows";
  }
  return "Flagship GLM model for hybrid reasoning, coding, and agentic engineering";
}

function kimiDescription({ target, fast, multimodal }: SpecialDescriptionContext) {
  if (has(target, /\bcode\b/)) {
    return "Kimi coding model for software agents, refactors, and repository reasoning";
  }
  if (has(target, /\bthinking\b/)) {
    return "Kimi reasoning model for long-horizon research, planning, and tool use";
  }
  if (multimodal) {
    return "Kimi multimodal agent model for visual understanding, coding, and planning";
  }
  if (fast) {
    return "Fast Kimi model for responsive chat, coding help, and agent loops";
  }
  return "Kimi model for long-context chat, coding, and agentic reasoning";
}

function mimoDescription({ target, fast, multimodal }: SpecialDescriptionContext) {
  if (has(target, /\bpro\b/)) {
    return "MiMo pro model for strong multimodal reasoning and agent execution";
  }
  if (fast || has(target, /\bflash\b/)) {
    return "MiMo flash model for fast multimodal assistance and agent workflows";
  }
  if (multimodal || has(target, /\bomni\b/)) {
    return "MiMo omni model for text, image, video, audio, and agents";
  }
  return "MiMo model for long-context reasoning, perception, and agentic tasks";
}

function stepDescription(_: SpecialDescriptionContext) {
  return "StepFun flash model for efficient multimodal reasoning, coding, and tool use";
}

function cohereDescription({ target }: SpecialDescriptionContext) {
  if (has(target, /\bnorth.*code|code\b/)) {
    return "Cohere coding model for practical software engineering and agentic edits";
  }
  if (has(target, /\bcommand[-\s]?r\b/)) {
    return "Cohere retrieval model for long-context chat and enterprise RAG workflows";
  }
  return "Cohere command model for multilingual enterprise agents, tools, and chat";
}

function perplexityDescription({ target }: SpecialDescriptionContext) {
  if (has(target, /\breasoning\b/)) {
    return "Web-grounded reasoning model for multi-step research and cited answers";
  }
  if (has(target, /\bpro\b/)) {
    return "Advanced Sonar search model for deeper research and cited synthesis";
  }
  return "Sonar search model for current answers, retrieval, and citation-backed chat";
}

function sarvamDescription({ target }: SpecialDescriptionContext) {
  if (has(target, /\b105b\b/)) {
    return "Flagship Indian-language reasoning model for enterprise multilingual applications";
  }
  return "Efficient Indian-language reasoning model for chat, coding, and multilingual work";
}

function tencentDescription(_: SpecialDescriptionContext) {
  return "Tencent Hy reasoning model for coding, instruction following, and agent tasks";
}

function sakanaDescription({ target }: SpecialDescriptionContext) {
  if (has(target, /\bultra\b/)) {
    return "Quality-first multi-agent model for hard research, analysis, and competitions";
  }
  return "Multi-agent model for routing expert agents across complex analytical tasks";
}

function ornithDescription({ target }: SpecialDescriptionContext) {
  if (has(target, /\b397b|35b\b/)) {
    return "Large coding-reasoning model for agentic software tasks and RL search";
  }
  return "Open coding-reasoning model for repository tasks and self-improving agents";
}

function has(value: string, pattern: RegExp) {
  return pattern.test(value);
}

function labID(id: string, providerId?: string) {
  const [first] = id.split("/");
  if (first !== undefined && first.length > 0) return normalizeLab(first);
  if (providerId !== undefined && providerId.length > 0) return normalizeLab(providerId);
}

function normalizeLab(value: string) {
  const normalized = value.toLowerCase();
  return {
    "x-ai": "xai",
    "z-ai": "zai",
    "zai-org": "zhipuai",
    qwen: "alibaba",
    mistralai: "mistral",
    "meta-llama": "meta",
    llama: "meta",
    "moonshot-ai": "moonshotai",
    minimaxai: "minimax",
    "deepseek-ai": "deepseek",
    xiaomimimo: "xiaomi",
    "stepfun-ai": "stepfun",
  }[normalized] ?? normalized;
}

function humanizeID(id: string) {
  const last = id.split("/").at(-1) ?? id;
  return last
    .replace(/[:._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
