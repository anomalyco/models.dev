import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, modelMetadata, resolveCanonicalBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.surplusintelligence.ai/v1/models";
const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "providers");
const OPENROUTER_MODELS_DIR = path.join(PROVIDERS_DIR, "openrouter", "models");

// Surplus's `provider` field names the lab that built the model. Mapped to
// OpenRouter-shaped prefixes so resolveCanonicalBaseModel's candidate rules
// (Anthropic dot releases, `-fast` aliases, Llama digits, …) can be reused.
const LAB_PREFIXES: Record<string, string> = {
  OpenAI: "openai",
  Alibaba: "qwen",
  "Alibaba Cloud": "qwen",
  Qwen: "qwen",
  Google: "google",
  "Zhipu AI": "zai",
  "Z.ai": "zai",
  Anthropic: "anthropic",
  "Mistral AI": "mistralai",
  DeepSeek: "deepseek",
  Moonshot: "moonshotai",
  MiniMax: "minimax",
  xAI: "x-ai",
  SpaceXAI: "x-ai",
  Meta: "meta-llama",
  NVIDIA: "nvidia",
  Tencent: "tencent",
};

// Surplus IDs that do not resolve mechanically against models/ metadata.
// Keys are normalized IDs (`:web` route suffix and `e2ee-`/`-p` wrappers
// stripped); every target must exist under models/. Kept in the module
// (rather than relying only on committed provider files) so a delist/relist
// cycle or from-scratch regeneration cannot silently lose the mapping.
const BASE_MODEL_OVERRIDES: Record<string, string> = {
  "qwen3-coder": "alibaba/qwen3-coder-480b-a35b-instruct",
  "qwen3-coder-turbo": "alibaba/qwen3-coder-480b-a35b-instruct",
  "qwen3-235b-a22b-2507": "alibaba/qwen3-235b-a22b-instruct-2507",
  "qwen-2-5-7b": "alibaba/qwen2.5-7b-instruct",
  "mistral-small-3.2-24b-instruct": "mistral/mistral-small-2506",
  "mistral-small-4": "mistral/mistral-small-2603",
  "mistral-large-3": "mistral/mistral-large-2512",
  "devstral-2-123b": "mistral/devstral-2512",
  "ministral-3-3b-instruct": "mistral/ministral-3b-2512",
  "ministral-3-8b-instruct": "mistral/ministral-8b-2512",
  "ministral-3-14b-instruct": "mistral/ministral-14b-2512",
  "nvidia-nemotron-3-super-120b": "nvidia/nemotron-3-super-120b-a12b",
  "nvidia-nemotron-nano-12b-v2": "nvidia/nemotron-nano-12b-v2-vl",
  "gemini-3-5-flash": "google/gemini-3.5-flash",
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
  "glm-4.7-thinking": "zhipuai/glm-4.7",
  "glm-5.1-non-thinking": "zhipuai/glm-5.1",
  "grok-4.20-beta": "xai/grok-4.20-0309-reasoning",
  "grok-4.20-multi-agent-beta": "xai/grok-4.20-multi-agent-0309",
  "grok-build-0-1": "xai/grok-build-0.1",
  "hy3-free": "tencent/hy3",
  // Moonshot has no undated K2 API ID (first-party routes are
  // kimi-k2-0711-preview / kimi-k2-0905-preview); the marketplace route's
  // 256K context matches the 0905 checkpoint.
  "kimi-k2": "moonshotai/kimi-k2-0905",
  "hermes-3-llama-3.1-405b": "nousresearch/hermes-3-llama-3.1-405b",
  "mercury-2": "inception/mercury-2",
  "aion-labs.aion-2-0": "aion-labs/aion-2.0",
};

// Marketplace routes with no shared lab identity (uncensored/"heretic"
// finetunes, Venice house models). Inline full definitions are a decision,
// not a fallback: only IDs listed here are written inline, and a new
// unresolved ID is skipped with a notice instead (see skippedNotice).
// Fields carry per-route judgment the API cannot provide: public weights,
// and real ship dates where documented elsewhere in this repo (Venice house
// models from providers/venice/models) — Surplus reports a placeholder
// `created` timestamp (2025-01-01) for these routes, which remains the
// fallback where no documented date exists.
const INLINE_ROUTES: Record<
  string,
  {
    open_weights?: boolean;
    release_date?: string;
    family?: string;
    description?: string;
    reasoning?: boolean;
  }
> = {
  "e2ee-gemma-4-26b-a4b-uncensored-p": {},
  // Live probe 2026-08-23: reasons on every request; both off-switches
  // ignored (see ROUTE_HEADERS).
  "e2ee-qwen3-6-35b-a3b-uncensored-p": { reasoning: true },
  "e2ee-venice-uncensored-24b-p": { open_weights: true },
  "gemma-4-uncensored": { open_weights: true, release_date: "2026-04-13" },
  "glm-4.7-flash-heretic": { open_weights: true },
  "mistral-large": {
    open_weights: true,
    family: "venice",
    description: "Venice-branded Mistral-family chat model for general assistant workloads",
  },
  "qwen3.6-plus-uncensored": {},
  "venice-uncensored": { open_weights: true },
  "venice-uncensored-1.2": { open_weights: true, release_date: "2026-04-01" },
  "venice-uncensored-role-play": { open_weights: true, release_date: "2026-02-20" },
};

// Live-probed control surfaces that override what the canonical model's lab
// and relay peers author. Surplus normally forwards reasoning parameters to
// the winning seller unchanged, so peers are the right default — but where a
// probe showed the sellers ignoring every documented control, the tested
// result wins for that route (see ROUTE_HEADERS for the evidence). Keyed by
// route ID so it applies to base_model and inline routes alike.
const ROUTE_REASONING_OPTIONS: Record<string, NonNullable<SyncedFullModel["reasoning_options"]>> = {
  "e2ee-qwen3-6-35b-a3b-uncensored-p": [],
  "grok-4.20-multi-agent-beta": [],
};

const E2EE_GLM_HEADER = [
  "# Catalog lists no reasoning params for this E2EE route and a live probe",
  "# found no active sellers (2026-08-23); controls mirror the OpenRouter",
  "# peer's [] until testable.",
  "",
].join("\n");

// Evidence headers from live probes against the marketplace (2026-08-23,
// one short prompt per request, both OpenRouter-style and lab-native wire
// formats). These document why specific routes diverge from what a peer or
// the route name would suggest.
const ROUTE_HEADERS: Record<string, string> = {
  "kimi-k2.6": [
    "# Live probes 2026-08-23: no reasoning side-channel and ~zero reasoning",
    "# tokens across pinned sellers (default route, InferHub,",
    "# OpenRouter/StreamLake), on easy and hard prompts alike, with",
    "# reasoning.enabled=true and enable_thinking=true both ignored (the model",
    "# deliberates in-band in content). OpenRouter peer likewise authors [].",
    "",
  ].join("\n"),
  "glm-4.7": [
    "# Live probes 2026-08-23: reasoning always returned; reasoning.enabled=false",
    "# and thinking.type=disabled both ignored, including on a provider-pinned",
    "# first-party Z.ai offer — no caller control, matching the OpenRouter",
    "# peer's [].",
    "",
  ].join("\n"),
  "glm-5.1-non-thinking": [
    "# Despite the route name, live probes 2026-08-23 returned reasoning",
    "# content on every request (thinking.type=disabled ignored); kept on the",
    "# glm-5.1 base with no caller control.",
    "",
  ].join("\n"),
  "glm-5.1-non-thinking:web": [
    "# Despite the route name, live probes 2026-08-23 of the bare route",
    "# returned reasoning content on every request; kept on the glm-5.1 base",
    "# with no caller control.",
    "",
  ].join("\n"),
  "grok-4.20-multi-agent-beta": [
    "# Live probes 2026-08-23: the default seller exposed ~7k chars of",
    "# reasoning identically at reasoning.effort=low, xhigh, and",
    "# reasoning_effort=low; an OpenRouter-pinned (xAI-served) seller exposed",
    "# none at any effort. Effort is not honored either way, so no caller",
    "# control is cataloged despite the OpenRouter peer's effort list.",
    "",
  ].join("\n"),
  "e2ee-qwen3-6-35b-a3b-uncensored-p": [
    "# Live probes 2026-08-23: reasoning content returned on every request",
    "# across two pinned providers (Venice AI, Mordiem);",
    "# reasoning.enabled=false and enable_thinking=false both ignored —",
    "# always-on with no caller control.",
    "",
  ].join("\n"),
  "e2ee-gemma-4-26b-a4b-uncensored-p": [
    "# Live probes 2026-08-23: no reasoning content on easy or hard prompts,",
    "# even with reasoning.enabled=true; the catalog also lists no reasoning",
    "# feature or params for this route, unlike its reasoning-capable e2ee",
    "# siblings.",
    "",
  ].join("\n"),
  "mistral-large": [
    "# Venice-branded route: the ID claims Mistral Large, Venice names it",
    "# Venice Medium, and a live identity probe (2026-08-23) self-reported",
    '# "Mistral-7B" — no confident lab checkpoint, so kept inline without',
    "# implying Mistral Large.",
    "",
  ].join("\n"),
  "e2ee-glm-4.7": E2EE_GLM_HEADER,
  "e2ee-glm-4.7-flash": E2EE_GLM_HEADER,
  "e2ee-glm-5": E2EE_GLM_HEADER,
  "e2ee-glm-5.1": E2EE_GLM_HEADER,
};

// Canonical models whose controls cannot be found mechanically: the peer
// entry lives under an alias/dated ID with no key back to the canonical, or
// no relay peer exists and the family control is documented on siblings.
const AUTHORED_REASONING_OPTIONS: Record<string, NonNullable<SyncedFullModel["reasoning_options"]>> = {
  // OpenRouter's deepseek-chat-v3.1 (same model, alias ID) authors a toggle.
  "deepseek/deepseek-v3.1": [{ type: "toggle" }],
  // No relay peer serves E2B; every other Gemma 4 entry (lab + relays)
  // exposes the same thinking toggle.
  "google/gemma-4-E2B-it": [{ type: "toggle" }],
  // Matches gpt-oss-safeguard-20b here and on OpenRouter, and
  // safeguard-120b on Cortecs/Tinfoil.
  "openai/gpt-oss-safeguard-120b": [{ type: "effort", values: ["low", "medium", "high"] }],
};

// Maps models/ metadata directories to the lab's own first-party provider
// directory, the most authoritative source for a lab model's controls when
// no OpenRouter peer file keys the canonical ID.
const FIRST_PARTY_PROVIDERS: Record<string, string> = {
  alibaba: "alibaba",
  anthropic: "anthropic",
  deepseek: "deepseek",
  google: "google",
  minimax: "minimax",
  mistral: "mistral",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  openai: "openai",
  tencent: "tencent",
  xai: "xai",
  zhipuai: "zai",
};

// Maps providers/openrouter/models subdirectories to models/ metadata
// directories so reasoning_options authored for the same canonical model on
// OpenRouter (the established same-surface relay peer) can be mirrored here.
const OPENROUTER_DIR_METADATA: Record<string, string> = {
  "aion-labs": "aion-labs",
  anthropic: "anthropic",
  deepseek: "deepseek",
  google: "google",
  inception: "inception",
  "meta-llama": "meta",
  minimax: "minimax",
  mistralai: "mistral",
  moonshotai: "moonshotai",
  nousresearch: "nousresearch",
  nvidia: "nvidia",
  openai: "openai",
  qwen: "alibaba",
  tencent: "tencent",
  "x-ai": "xai",
  "z-ai": "zhipuai",
  "zai-org": "zhipuai",
};

export const SurplusModel = z
  .object({
    id: z.string(),
    name: z.string(),
    created: z.number(),
    context_length: z.number(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).default(["text"]),
        output_modalities: z.array(z.string()).default(["text"]),
      })
      .passthrough(),
    top_provider: z
      .object({
        context_length: z.number().nullish(),
        max_completion_tokens: z.number().nullish(),
      })
      .passthrough()
      .nullish(),
    supported_parameters: z.array(z.string()).default([]),
    supported_features: z.array(z.string()).default([]),
    provider: z.string().optional(),
  })
  .passthrough();

export const SurplusResponse = z
  .object({
    data: z.array(SurplusModel),
  })
  .passthrough();

export type SurplusModel = z.infer<typeof SurplusModel>;

export const surplusIntelligence = {
  id: "surplus-intelligence",
  name: "Surplus Intelligence",
  modelsDir: "providers/surplus-intelligence/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Surplus Intelligence request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // The marketplace also lists image/video/music/TTS/STT services priced
    // per request or per media unit; those cannot be represented by the
    // token-cost schema and are intentionally out of catalog scope. Text
    // chat models all report a real context window.
    return SurplusResponse.parse(raw).data.filter(
      (model) => model.context_length > 0 && model.architecture.output_modalities.includes("text"),
    );
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const canonical = existing?.base_model ?? resolveSurplusBaseModel(model);
    // Inline creation is allowlist-only: an unknown ID that resolves to no
    // canonical metadata is skipped (and reported via skippedNotice) instead
    // of silently becoming a standalone inline model. A hand-authored local
    // file for such an ID is preserved untouched.
    if (canonical === undefined && !(model.id in INLINE_ROUTES)) {
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored as SyncedModel };
    }
    const translated = buildSurplusModel(model, existing);
    return {
      id: model.id,
      model: translated,
      header: ROUTE_HEADERS[model.id] ??
        (translated.reasoning_options?.some((option) => option.type === "toggle")
          ? TOGGLE_HEADER
          : undefined),
    };
  },
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} chat model(s) resolve to no canonical metadata and are not in the inline-route allowlist; add models/ metadata or an INLINE_ROUTES entry before cataloging: ${ids.join(", ")}`,
    ];
  },
} satisfies SyncProvider<SurplusModel>;

// Surplus forwards request parameters to the winning seller unchanged, so
// reasoning controls use the OpenRouter-style surface advertised in
// supported_parameters and mirror the canonical model's peer entry.
const TOGGLE_HEADER = [
  "# Toggle: reasoning.enabled true|false (OpenRouter-style `reasoning` object,",
  "# forwarded to the seller unchanged); effort: reasoning_effort.",
  "# Controls mirror the canonical model's lab + same-surface relay peers.",
  "",
].join("\n");

export function buildSurplusModel(model: SurplusModel, existing: ExistingModel | undefined): SyncedModel {
  const params = new Set(model.supported_parameters);
  const features = new Set(model.supported_features);
  const input = modalities(model.architecture.input_modalities, ["text"]);
  const output = modalities(model.architecture.output_modalities, ["text"]);
  const canonical = existing?.base_model ?? resolveSurplusBaseModel(model);
  const route = INLINE_ROUTES[model.id];
  // Surplus's catalog is unreliable about reasoning in both directions: it
  // omits the feature on some lab reasoners (gpt-oss routes advertise it on
  // the e2ee variants only) and blanket-lists reasoning params on lab
  // non-reasoners (the instruct-2507 checkpoint). A pass-through marketplace
  // can neither strip nor add reasoning, so lab identity is authoritative
  // for canonical models; Surplus's own signals (or live-probe overrides on
  // the allowlist entry) apply only to marketplace-only inline routes.
  const reasoning = canonical !== undefined
    ? labReasoning(canonical)
    : route?.reasoning ??
      (features.has("reasoning") ||
        params.has("reasoning") ||
        params.has("include_reasoning") ||
        params.has("reasoning_effort"));
  const toolCall = features.has("tools") || params.has("tools") || params.has("tool_choice");
  const structuredOutput = params.has("structured_outputs");
  const attachment = input.some((value) => value !== "text");
  const temperature = params.has("temperature");
  const contextLength = model.context_length;
  const limit = {
    context: contextLength,
    input: existing?.limit?.input,
    output: model.top_provider?.max_completion_tokens ?? existing?.limit?.output ?? contextLength,
  };
  // A non-empty hand-authored local value wins; an empty or missing one is
  // treated as unresolved so peer/lab mirroring can improve it on re-sync
  // (an authored `[]` must not permanently shadow later-found controls).
  const authoredOptions = existing?.reasoning_options?.length ? existing.reasoning_options : undefined;
  const reasoningOptions = reasoning
    ? ROUTE_REASONING_OPTIONS[model.id] ??
      authoredOptions ??
      (canonical !== undefined ? mirroredReasoningOptions(canonical) : inlineParentReasoningOptions(model))
    : undefined;

  if (canonical !== undefined) {
    return factorBaseModel(
      canonical,
      {
        name: model.name,
        attachment,
        reasoning,
        reasoning_options: reasoningOptions,
        temperature,
        tool_call: toolCall,
        structured_output: structuredOutput,
        status: existing?.status,
        interleaved: existing?.interleaved,
        limit,
        modalities: { input, output },
      },
      limit,
      existing?.base_model === canonical ? existing.base_model_omit : undefined,
    );
  }

  const releaseDate = dateFromTimestamp(model.created);
  const family = route?.family ?? inferFamily(model.id, model.name);
  return {
    name: model.name,
    description: route?.description ??
      existing?.description ??
      describeModel({
        id: model.id,
        name: model.name,
        family,
        reasoning,
        tool_call: toolCall,
        structured_output: structuredOutput,
        open_weights: existing?.open_weights ?? route?.open_weights ?? false,
        limit,
        modalities: { input, output },
      }),
    family,
    release_date: existing?.release_date ?? route?.release_date ?? releaseDate,
    last_updated: existing?.last_updated ?? route?.release_date ?? releaseDate,
    attachment,
    reasoning,
    reasoning_options: reasoningOptions,
    temperature,
    tool_call: toolCall,
    structured_output: structuredOutput,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? route?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

export function resolveSurplusBaseModel(model: SurplusModel) {
  const routeID = model.id.replace(/:web$/, "");
  const override = BASE_MODEL_OVERRIDES[routeID] ?? BASE_MODEL_OVERRIDES[unwrapE2EE(routeID)];
  if (override !== undefined) return override;

  const prefix = model.provider === undefined ? undefined : LAB_PREFIXES[model.provider];
  for (const candidate of candidateIDs(unwrapE2EE(routeID))) {
    const resolved =
      (prefix === undefined ? undefined : resolveCanonicalBaseModel(`${prefix}/${candidate}`)) ??
      resolveModelMetadataBaseModel(candidate);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function labReasoning(canonical: string) {
  try {
    return modelMetadata(canonical).reasoning === true;
  } catch {
    return false;
  }
}

function unwrapE2EE(id: string) {
  return id.startsWith("e2ee-") ? id.slice("e2ee-".length).replace(/-p$/, "") : id;
}

function candidateIDs(id: string) {
  const candidates = [id];
  // Some Surplus IDs repeat the lab name (`openai-gpt-oss-120b`,
  // `nvidia-nemotron-3-nano-30b-a3b`); canonical files drop it.
  candidates.push(id.replace(/^(?:openai|nvidia)-/, ""));
  for (const base of [...candidates]) {
    if (base.endsWith("-instruct")) candidates.push(base.slice(0, -"-instruct".length));
    if (base.endsWith("-it")) candidates.push(base.slice(0, -"-it".length));
    candidates.push(`${base}-it`);
    candidates.push(`${base}-instruct`);
    // Qwen point releases are dotted in models/ (`qwen3-5-9b` → `qwen3.5-9b`,
    // `qwen-3-7-plus` → `qwen3.7-plus`).
    candidates.push(base.replace(/^qwen-?(\d)[-.](\d)/, "qwen$1.$2"));
  }
  return [...new Set(candidates)];
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

function inferFamily(id: string, name: string) {
  const kimiFamily = inferKimiFamily(id, name);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

let reasoningOptionsByCanonical: Map<string, SyncedFullModel["reasoning_options"]> | undefined;
const firstPartyOptionsByProvider = new Map<string, Map<string, NonNullable<SyncedFullModel["reasoning_options"]>>>();

// Surplus is a pass-through relay ("the marketplace passes through all
// parameters to the provider unchanged"), so per policy the underlying
// model's controls are copied from the lab + same-surface peers, in order:
// vetted authored overrides for alias/orphan IDs, the same canonical
// model's OpenRouter entry (exact key, then with dated ID suffixes
// stripped), and the lab's own first-party provider file. A peer's authored
// `[]` is an affirmative "no caller control" and wins — live probes
// (2026-08-23) confirmed that routes whose catalog advertises reasoning
// params still ignore both OpenRouter-style and lab-native controls, so the
// host's advertised params are not evidence of a working control surface.
// Models with no source anywhere fall back to the runner's empty-array
// default.
export function mirroredReasoningOptions(canonical: string) {
  const authored = AUTHORED_REASONING_OPTIONS[canonical];
  if (authored !== undefined) return authored;
  if (reasoningOptionsByCanonical === undefined) {
    reasoningOptionsByCanonical = new Map();
    const relaxed = new Map<string, SyncedFullModel["reasoning_options"]>();
    for (const entry of walkTOMLFiles(OPENROUTER_MODELS_DIR).sort()) {
      let parsed: Record<string, unknown>;
      try {
        parsed = Bun.TOML.parse(readFileSync(entry, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const options = parsed.reasoning_options as SyncedFullModel["reasoning_options"] | undefined;
      if (options === undefined) continue;
      const key = canonicalKeyForOpenRouterFile(entry, parsed);
      if (key === undefined) continue;
      if (!reasoningOptionsByCanonical.has(key)) reasoningOptionsByCanonical.set(key, options);
      // Dated peer IDs (`alibaba/qwen3.5-plus-02-15`) also register their
      // undated canonical (`alibaba/qwen3.5-plus`); exact keys win.
      const undated = key.replace(/-(?:\d{2}-\d{2}|\d{4}|\d{8})$/, "");
      if (undated !== key && !relaxed.has(undated)) relaxed.set(undated, options);
    }
    for (const [key, options] of relaxed) {
      if (!reasoningOptionsByCanonical.has(key)) reasoningOptionsByCanonical.set(key, options);
    }
  }
  return reasoningOptionsByCanonical.get(canonical) ?? firstPartyReasoningOptions(canonical);
}

// Marketplace-only finetune routes (`-uncensored`, `-heretic`) forward the
// parent model's parameters like every other route, so their reasoning
// controls come from the parent canonical when it resolves.
function inlineParentReasoningOptions(model: SurplusModel) {
  const routeID = unwrapE2EE(model.id.replace(/:web$/, ""));
  const parentID = routeID.replace(/-(?:uncensored|heretic)(?=-|$)/g, "");
  if (parentID === routeID) return undefined;
  const parent = resolveSurplusBaseModel({ ...model, id: parentID });
  return parent === undefined ? undefined : mirroredReasoningOptions(parent);
}

// First-party layouts differ: most labs keep flat files under
// providers/<lab>/models, while NVIDIA nests per-org subdirectories
// (providers/nvidia/models/nvidia/…) and sometimes repeats the lab name in
// the filename. Index the lab's own subtree plus the flat root by basename,
// with the lab-name prefix stripped as an alternate key.
export function firstPartyReasoningOptions(canonical: string) {
  const [metadataDir, ...rest] = canonical.split("/");
  const providerDir = metadataDir === undefined ? undefined : FIRST_PARTY_PROVIDERS[metadataDir];
  if (providerDir === undefined || rest.length === 0) return undefined;

  let index = firstPartyOptionsByProvider.get(providerDir);
  if (index === undefined) {
    index = new Map();
    const root = path.join(PROVIDERS_DIR, providerDir, "models");
    const files = [...walkTOMLFiles(path.join(root, providerDir)), ...flatTOMLFiles(root)];
    for (const file of files.sort()) {
      const options = tomlReasoningOptions(file);
      if (options === undefined) continue;
      const basename = path.basename(file, ".toml").toLowerCase();
      for (const key of new Set([basename, basename.replace(new RegExp(`^${providerDir}-`), "")])) {
        if (!index.has(key)) index.set(key, options);
      }
    }
    firstPartyOptionsByProvider.set(providerDir, index);
  }

  return index.get(rest.join("/").toLowerCase());
}

function tomlReasoningOptions(file: string) {
  try {
    const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return parsed.reasoning_options as SyncedFullModel["reasoning_options"] | undefined;
  } catch {
    return undefined;
  }
}

function canonicalKeyForOpenRouterFile(file: string, parsed: Record<string, unknown>) {
  if (typeof parsed.base_model === "string") return parsed.base_model;
  const relative = path.relative(OPENROUTER_MODELS_DIR, file).slice(0, -".toml".length);
  const [dir, ...rest] = relative.split(path.sep);
  if (dir === undefined || rest.length === 0) return undefined;
  const metadataDir = OPENROUTER_DIR_METADATA[dir];
  if (metadataDir === undefined) return undefined;
  return `${metadataDir}/${rest.join("/").replace(/:free$/, "")}`;
}

function walkTOMLFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTOMLFiles(full);
    return entry.name.endsWith(".toml") ? [full] : [];
  });
}

function flatTOMLFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".toml"))
    .map((entry) => path.join(dir, entry.name));
}
