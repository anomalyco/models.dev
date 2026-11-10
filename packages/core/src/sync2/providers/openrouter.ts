// OpenRouter: https://openrouter.ai/api/v1/models (text and decision models),
// the same list for speech, transcription, embedding, rerank, image and video
// models, each image model's Images API endpoints and the video models list
// (OPENROUTER_API_KEY optional). Chat models are observed in OpenRouter's shape
// (openrouter-shape.ts) plus: reasoning controls from the catalog's reasoning
// object, every catalog price (the 1h cache write keyed by the file's TTLs,
// context and time-of-day overrides, image, audio and web search prices),
// tool_choice narrowed to the lab's, the Responses and Messages APIs for
// text-only models, the System One API for decision models and the /images
// router for chat models of an image lab. Media files are generated whole
// (rebuild) and keep their status, hand-written capabilities, experimental
// and metadata. Unavailable routes (negative prices, no parameters) keep their
// files. Dropped models are deleted.
//
// The media builders and the catalog price mapping are the old module's
// (../../sync/providers/openrouter.ts).

import { z } from "zod";

import {
  buildOpenRouterMediaModel,
  catalogCost,
  mediaType,
  OpenRouterModel,
  OpenRouterResponse,
  openrouter as old,
  resolveMediaBaseModel,
  withSystemOneMediaInput,
  withTextApis,
} from "../../sync/providers/openrouter.js";
import { Labs, REPO_ROOT } from "../catalog.js";
import { getPath } from "../fields.js";
import { namespaceHints } from "../labs.js";
import { OPENROUTER_SHAPED_OWNS, observeOpenRouterShaped } from "../openrouter-shape.js";
import type { Doc, Observation, Owned, SyncModule } from "../types.js";

type Model = z.infer<typeof OpenRouterModel>;

// Routes whose lab file has another name; they keep their own name.
const BASE_MODEL_OVERRIDES: Record<string, string> = {
  "bytedance/dola-seed-2.0-code": "bytedance-seed/seed-2.0-code",
  "openai/gpt-5.6-luna-pro": "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol-pro": "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra-pro": "openai/gpt-5.6-terra",
  "anthropic/claude-opus-4.7-fast": "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4.8-fast": "anthropic/claude-opus-4-8",
  "typesafe/jev-1.13": "typesafe/jev-1.13.0",
  "~typesafe/jev-latest": "typesafe/jev-latest",
};
const OUTPUT_LIMIT_OVERRIDES: Record<string, number> = { "minimax/minimax-01": 40_000 };
// Mistral Large 4: `none` returns 400 "supported values: high, low, medium" and
// `reasoning.enabled = false` is rejected the same way (live 2026-10-31).
const REASONING_OVERRIDES: Record<string, NonNullable<Model["reasoning"]>> = {
  "mistralai/mistral-large-4-0": { mandatory: true, supported_efforts: ["high", "medium", "low"] },
};
const DECISION_DESCRIPTION = "Decision model for typed evaluation of shared state";
// Decision models answer POST /api/v1/systemone.
// https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request
const DECISION_APIS = { systemone: { sdk: { aisdk: "@ai-sdk/typesafe-ai", opencodeai: "@opencode/ai/providers/openrouter/decisions" } } };
// Chat models whose lab is an image model are also served by the /images router.
const IMAGE_CHAT_APIS = { "chat-completions": {}, images: { sdk: { opencodeai: "@opencode/ai/providers/openrouter/images" } } };
const TOGGLE_HEADER = "# Toggle: reasoning.enabled = true|false\n# https://openrouter.ai/docs/guides/best-practices/reasoning-tokens";
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const MEDIA_HEADERS: Record<string, string> = {
  speech: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=speech",
    "# Output: response_format mp3 (audio/mpeg) or pcm (audio/pcm). Priced per input character, or",
    "# per second of output audio when only pricing.completion is set, or per token when both are.",
    "# https://openrouter.ai/docs/guides/overview/multimodal/tts",
  ].join("\n"),
  transcription: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=transcription",
    "# Input: wav, mp3, flac, m4a, ogg, webm, aac (\"varies by provider\"). Priced per second of input",
    "# audio, or per token when pricing.completion is set.",
    "# https://openrouter.ai/docs/guides/overview/multimodal/stt",
  ].join("\n"),
  embedding: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=embeddings (prices per token)",
    "# https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request",
  ].join("\n"),
  reranking: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=rerank",
    "# No [cost]: the models API reports \"0\" for priced rerank models (the model pages show per-search",
    "# and per-token prices), so only free routes get a price.",
    "# https://openrouter.ai/docs/api/api-reference/rerank/submit-a-rerank-request",
  ].join("\n"),
  image: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=image. Prices are the Images API",
    "# endpoint pricing lines (/api/v1/images/models/{id}/endpoints): per image, per megapixel or per token.",
    "# Resolution and quality tiers are overrides on the first line; a request that omits them is billed at",
    "# the provider's default tier. No [cost] when a price has no CostV2 form (per-request or font fees,",
    "# unlisted or per-job pricing).",
    "# https://openrouter.ai/docs/guides/overview/multimodal/image-generation",
  ].join("\n"),
  video: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=video. Prices are the pricing_skus of",
    "# https://openrouter.ai/api/v1/videos/models: per second of output (cents_per_* / 100, duration_seconds_* in USD)",
    "# or per video token (video_tokens_*). SKU qualifiers are overrides on the plain or first SKU: resolution,",
    "# generate_audio (true by default for models with audio), mode (text-to-video, image-to-video, reference-to-video)",
    "# and input_video. No [cost] when a SKU has no CostV2 form (minimum charge per generation, per megapixel-second).",
    "# https://openrouter.ai/docs/guides/overview/multimodal/video-generation",
  ].join("\n"),
};

const owns: Owned[] = [
  ...OPENROUTER_SHAPED_OWNS,
  "type",
  "capabilities.reasoning.toggle",
  "capabilities.reasoning.effort",
  "capabilities.reasoning.budget",
  "capabilities.tools.choice",
  // Time-of-day overrides are always the catalog's; context bands only when it lists some.
  { path: "cost.text.input.overrides", merge: "bands", replaces: ["utc_days", "utc_hours"], optional: true },
  { path: "cost.text.output.overrides", merge: "bands", replaces: ["utc_days", "utc_hours"], optional: true },
  "cost.image",
  "cost.audio",
  "cost.web_search",
  "api",
];

let labs: Labs | undefined;

export const openrouter: SyncModule<unknown> = {
  id: "openrouter",
  name: "OpenRouter",
  policy: { owns, creates: "auto", removals: "delete", omitLabInput: true },
  fetch: () => old.fetchModels(),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    // Batch routes (`*:batch`) aren't catalog targets.
    return OpenRouterResponse.parse(raw).data.filter((model) => !model.id.endsWith(":batch")).map((model) => observe(model, labs!));
  },
  refine(observation, file) {
    const model = models.get(observation.id);
    // An unavailable route's file stays as it is.
    if (model === undefined || observation.updateOnly) return observation;
    const type = mediaType(model);
    if (type !== undefined) {
      const { schema: _schema, base_model: _base, ...body } = buildOpenRouterMediaModel(model, type, file);
      return { ...observation, ...body } as Observation;
    }
    const base = typeof file?.base_model === "string" ? file.base_model : observation.base?.[0];
    const refined: Doc = { ...observation };
    // A name says more than the lab's only when the slug differs or the route is `:free`.
    if (base !== undefined) refined.name = keepName(model.id, base) ? model.name.replace(/^[^:]+:\s+/, "") : null;

    const decision = model.architecture.output_modalities.includes("decisions");
    const imageLab = base !== undefined && labs!.get(base)?.type === "image";
    const textOnly = model.architecture.output_modalities.join() === "text";
    const api = decision
      ? withSystemOneMediaInput(structuredClone(DECISION_APIS), model.architecture.input_modalities.includes("image"))
      : imageLab ? structuredClone(IMAGE_CHAT_APIS) : textOnly ? withTextApis(file?.api) : undefined;
    if (api !== undefined) refined.api = api;

    // tool_choice takes every documented value, narrowed to the lab's own choice; one equal to the lab's is inherited.
    const labChoice = getPath(base === undefined ? undefined : labs!.get(base), "capabilities.tools.choice") as string[] | undefined;
    const choice = ["auto", "none", "required", "tool"].filter((value) => labChoice?.includes(value) ?? true);
    const same = labChoice !== undefined && choice.length === labChoice.length && choice.every((value) => labChoice.includes(value));
    const listed = model.supported_parameters.includes("tool_choice") && getPath(file, "capabilities.tools.supported") !== false && !same;
    refined.capabilities = { ...(refined.capabilities as Doc), tools: { ...(getPath(refined, "capabilities.tools") as Doc), choice: listed ? choice : null } };

    const cost = refined.cost as Doc | undefined;
    if (cost !== undefined) {
      // The 1h write price is keyed by the TTLs the file's cache lists.
      const catalog = catalogCost(model, file);
      if (catalog.write !== undefined) (cost.text as { input: Doc }).input = { ...(getPath(cost, "text.input") as Doc), cache: { ...(getPath(cost, "text.input.cache") as Doc), write: catalog.write } };
    }
    return refined as Observation;
  },
};

// The catalog rows refine needs, by ID.
const models = new Map<string, Model>();

function observe(model: Model, labs: Labs): Observation {
  models.set(model.id, model);
  const type = mediaType(model);
  if (type !== undefined) {
    const { prompt, completion, image, audio } = model.pricing;
    // A negative price marks an unavailable route; its file stays as it is.
    if ([prompt, completion, image, audio].some((value) => value !== undefined && Number(value) < 0)) return { id: model.id, updateOnly: true };
    const base = resolveMediaBaseModel(model.id);
    return { id: model.id, base: base === undefined ? [] : [base], header: MEDIA_HEADERS[type], rebuild: {} };
  }
  const decision = model.architecture.output_modalities.includes("decisions");
  // Unavailable routes are degraded stubs (negative prices, no parameters); their files stay.
  if ((model.supported_parameters.length === 0 && !decision) || Number(model.pricing.prompt) < 0 || Number(model.pricing.completion) < 0) {
    return { id: model.id, updateOnly: true };
  }
  const shaped = observeOpenRouterShaped(model, { hints: namespaceHints(model.id), labs }) as Doc;
  const reasoning = model.supported_parameters.includes("reasoning") || model.supported_parameters.includes("include_reasoning");
  const controls = reasoning ? reasoningControls(REASONING_OVERRIDES[model.id] ?? model.reasoning) : undefined;
  const capabilities = { ...(shaped.capabilities as Doc) };
  if (controls !== undefined) capabilities.reasoning = { ...(capabilities.reasoning as Doc), ...controls };
  if (decision) {
    delete capabilities.temperature;
    delete capabilities.structured_output;
  }
  const limit = { ...(shaped.limit as Doc) };
  const outputLimit = OUTPUT_LIMIT_OVERRIDES[model.id];
  if (decision) limit.output = 0;
  else if (outputLimit !== undefined) limit.output = outputLimit;

  let cost = shaped.cost as Doc | undefined;
  if (cost !== undefined) {
    const catalog = catalogCost(model);
    const text = cost.text as { input: Doc; output: Doc };
    cost = {
      text: {
        input: { ...text.input, overrides: catalog.overrides.input },
        output: { ...text.output, reasoning: catalog.reasoning ?? null, overrides: catalog.overrides.output },
      },
      image: catalog.image ?? null,
      audio: catalog.audio ?? null,
      web_search: catalog.webSearch ?? null,
    };
  }
  return {
    ...shaped,
    ...(decision ? { type: "decision", description: (shaped.base as string[]).length > 0 ? null : DECISION_DESCRIPTION } : {}),
    capabilities,
    limit,
    ...(cost === undefined ? {} : { cost }),
    ...(controls?.toggle === true ? { header: TOGGLE_HEADER } : {}),
  } as Observation;
}

// OpenRouter's reasoning object as controls; undefined when the catalog has none.
function reasoningControls(reasoning: Model["reasoning"]) {
  if (reasoning === undefined) return undefined;
  const efforts = reasoning.supported_efforts === null ? ["max", "xhigh", "high", "medium", "low", "minimal", "none"] : reasoning.supported_efforts;
  const toggle = !reasoning.mandatory && !efforts?.includes("none");
  // Listed from max down; files keep them low to high.
  const effort = efforts === undefined
    ? undefined
    : (reasoning.mandatory ? efforts.filter((value) => value !== "none") : [...efforts]).sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  const budget = reasoning.supports_max_tokens === true;
  if (!toggle && effort === undefined && !budget) return undefined;
  return { toggle: toggle ? true : null, effort: effort ?? null, budget: budget ? {} : null };
}

// Whether a route's name says more than its lab's: the slugs differ, the route
// is `:free`, or the lab is a named override.
function keepName(id: string, base: string) {
  if (id.endsWith(":free") || BASE_MODEL_OVERRIDES[id] === base) return true;
  const slug = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return slug(id.split("/").slice(1).join("/").replace(/:free$/, "")) !== slug(base.split("/").slice(1).join("/"));
}
