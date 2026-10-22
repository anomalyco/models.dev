import { readFileSync } from "node:fs";

import {
  AuthoredModelV2,
  LabModelV2,
  type AuthoredApiEntryV2,
  type CostV2,
  type CostWhenV2,
  type ReasoningSupportV2,
} from "./schema-v2.js";

// Model files declare `schema = 2`; readers translate them back to v1.
export function isSchemaV2(toml: Record<string, unknown>) {
  return toml.schema === 2;
}

// Reads a lab model file (`models/<lab>/<model>.toml`) as v1 fields.
export function readLabModel(filePath: string, modelID: string) {
  const toml = Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  return labModelV2ToV1({ ...toml, id: modelID }, { modelPath: filePath });
}

// Reads a provider model file (`providers/<p>/models/<model>.toml`) as v1 fields.
export function readProviderModel(filePath: string) {
  const toml = Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const { id: _id, ...model } = modelV2ToV1({ ...toml, id: "" }, { modelPath: filePath });
  return model;
}

// Reads a provider.toml as v1 fields: `opencodeai` (the default API's OpenCode
// package) is v2-only.
export function providerTomlToV1(toml: Record<string, unknown>): Record<string, unknown> {
  const { opencodeai: _opencodeai, ...v1 } = toml;
  return v1;
}

export function labModelV2ToV1(
  toml: Record<string, unknown>,
  cause: Record<string, unknown> = {},
): Record<string, unknown> {
  const { schema: _schema, ...raw } = toml;
  const parsed = LabModelV2.safeParse(raw);
  if (!parsed.success) {
    parsed.error.cause = { ...cause, toml };
    throw parsed.error;
  }
  const lab = parsed.data;
  const input = toV1Modalities(lab.modalities.input);

  return withoutUndefined({
    id: lab.id,
    type: lab.type,
    name: lab.name,
    description: lab.description,
    family: lab.family,
    attachment: input.some((modality) => modality !== "text"),
    reasoning: lab.capabilities.reasoning.supported,
    tool_call: lab.capabilities.tools.supported,
    temperature: lab.capabilities.temperature,
    knowledge: lab.knowledge,
    release_date: lab.release_date,
    last_updated: lab.last_updated ?? lab.release_date,
    modalities: { input, output: toV1Modalities(lab.modalities.output) },
    open_weights: lab.open_weights,
    limit:
      lab.limit === undefined
        ? undefined
        : withoutUndefined({
            context: lab.limit.context,
            input: lab.limit.input,
            output: lab.limit.output,
          }),
    license: lab.license,
    links: lab.links,
    weights: lab.weights,
    benchmarks: lab.benchmarks,
  });
}

// Translates a v2 provider model file into the v1 authored fields it stands for.
// v2-only data (MIME modalities, cache TTLs, service tiers…) has no v1 field and
// is left out; the v2 output reads it from the file directly.
export function modelV2ToV1(
  toml: Record<string, unknown>,
  cause: Record<string, unknown> = {},
): Record<string, unknown> {
  const { schema: _schema, ...raw } = toml;
  const parsed = AuthoredModelV2.safeParse(raw);
  if (!parsed.success) {
    parsed.error.cause = { ...cause, toml };
    throw parsed.error;
  }
  const model = parsed.data;
  const capabilities = model.capabilities ?? {};
  const input = model.modalities && toV1Modalities(model.modalities.input);
  const cost = model.cost && costV2ToV1(model.cost);

  return withoutV1ReasoningCost(withoutUndefined({
    id: model.id,
    base_model: model.base_model,
    base_model_omit: model.base_model_omit,
    type: model.type,
    name: model.name,
    description: model.description,
    family: model.family,
    attachment: input?.some((modality) => modality !== "text"),
    reasoning: capabilities.reasoning?.supported,
    reasoning_options: capabilities.reasoning && toReasoningOptions(capabilities.reasoning),
    tool_call: capabilities.tools?.supported,
    structured_output: capabilities.structured_output,
    temperature: capabilities.temperature,
    knowledge: model.knowledge,
    release_date: model.release_date,
    last_updated: model.last_updated ?? model.release_date,
    modalities: model.modalities && {
      input,
      output: toV1Modalities(model.modalities.output),
    },
    open_weights: model.open_weights,
    limit:
      model.limit &&
      withoutUndefined({
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      }),
    status: model.status,
    cost,
    experimental: toV1Experimental(model, cost),
    ...toV1Api(model.api),
  }));
}

// v1 forbids a reasoning price on a model that doesn't reason, but a host can
// still bill reasoning tokens, so v2 keeps the price and v1 leaves it out.
// `reasoning` is the model's resolved value (its base model's when unset).
export function withoutV1ReasoningCost<T extends Record<string, unknown>>(model: T, reasoning = model.reasoning): T {
  if (reasoning !== false) return model;
  const next: Record<string, unknown> = { ...model };
  if (next.cost !== undefined) next.cost = withoutReasoningPrice(next.cost);
  const experimental = next.experimental as { modes?: Record<string, Record<string, unknown>> } | undefined;
  if (experimental?.modes !== undefined) {
    next.experimental = {
      ...experimental,
      modes: Object.fromEntries(
        Object.entries(experimental.modes).map(([name, mode]) => [
          name,
          mode.cost === undefined ? mode : { ...mode, cost: withoutReasoningPrice(mode.cost) },
        ]),
      ),
    };
  }
  return next as T;
}

function withoutReasoningPrice(cost: unknown): unknown {
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) return cost;
  const { reasoning: _reasoning, ...rest } = cost as Record<string, unknown>;
  if (Array.isArray(rest.tiers)) rest.tiers = rest.tiers.map(withoutReasoningPrice);
  return rest;
}

// v1 models have one API: `provider` holds its SDK, base URL and shape, and
// `interleaved` its reasoning requirement. With several `[api.<protocol>]`
// tables, the first one in the file is the default and becomes the v1 API.
// The protocol only becomes a v1 `shape` where it isn't the SDK's default
// (OpenAI and Azure default to Responses), unless `legacy_shape` keeps one.
function toV1Api(api: Record<string, AuthoredApiEntryV2> | undefined) {
  const first = Object.entries(api ?? {})[0];
  if (first === undefined) return {};
  const [protocol, { base_url, sdk, compatibility, legacy_shape }] = first;
  // `aisdk = "none"` (no AI SDK package) is v2-only; v1 keeps the provider's npm.
  const npm = sdk?.aisdk === "none" ? undefined : sdk?.aisdk;
  if (legacy_shape !== undefined && toProtocol(legacy_shape) !== protocol) {
    throw new Error(`legacy_shape = "${legacy_shape}" doesn't match [api.${protocol}]`);
  }
  const shape = legacy_shape ?? toV1Shape(protocol, npm);
  const provider = withoutUndefined({ npm, api: base_url, shape });
  const field = compatibility?.reasoning_field;
  return withoutUndefined({
    interleaved: field !== undefined ? { field } : compatibility?.replay_reasoning ? true : undefined,
    provider: Object.keys(provider).length > 0 ? provider : undefined,
  });
}

// The v1 `shape` a protocol gets on an SDK: none where it's the SDK's default.
export function toV1Shape(protocol: string, npm: string | undefined) {
  const responsesByDefault = npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure";
  if (protocol === "responses" && !responsesByDefault) return "responses";
  if (protocol === "chat-completions" && responsesByDefault) return "completions";
  return undefined;
}

function toProtocol(shape: "responses" | "completions") {
  return shape === "responses" ? "responses" : "chat-completions";
}

function toReasoningOptions(reasoning: ReasoningSupportV2) {
  if (!reasoning.supported) return undefined;
  const options: Record<string, unknown>[] = [];
  if (reasoning.toggle) options.push({ type: "toggle" });
  if (reasoning.effort !== undefined) {
    options.push({ type: "effort", values: reasoning.effort });
  }
  if (reasoning.budget !== undefined) {
    options.push(withoutUndefined({ type: "budget_tokens", ...reasoning.budget }));
  }
  return options;
}

function costV2ToV1(cost: CostV2) {
  const input = cost.text?.input;
  const output = cost.text?.output;
  // v1 prices are per text token, so media-only prices (per second, per image…) stay v2-only.
  if (input === undefined && output === undefined) return undefined;
  // Text input with media-only output (text-to-speech), or text priced per character,
  // has no per-token text pair either.
  const perToken = (unit: string | undefined) => unit === undefined || unit === "token";
  if (output === undefined || !perToken(input?.unit) || !perToken(output.unit)) return undefined;
  if (input === undefined || output === undefined) {
    throw new Error("v1 cost needs text input and output prices");
  }

  const contextTiers = new Map<number, Record<string, unknown>>();
  const tier = (when: CostWhenV2) => {
    const keys = Object.keys(when);
    // A v1 tier only has the size where its band starts, so `gt` and `gte` both map to it.
    const context = keys.length === 1 ? (when.context as { gt?: unknown; gte?: unknown } | undefined) : undefined;
    const size = context?.gt ?? context?.gte;
    if (typeof size !== "number") {
      throw new Error(`v1 cost tiers only support { context: { gt | gte } }, got ${JSON.stringify(when)}`);
    }
    let entry = contextTiers.get(size);
    if (entry === undefined) {
      entry = { tier: { type: "context", size }, input: input.price, output: output.price };
      contextTiers.set(size, entry);
    }
    return entry;
  };
  for (const override of (input.overrides ?? []).filter(isV1Tier)) {
    Object.assign(
      tier(override.when),
      withoutUndefined({
        input: override.price,
        cache_read: override.cache?.read,
        cache_write: override.cache && firstPrice(override.cache.write),
      }),
    );
  }
  for (const override of (output.overrides ?? []).filter(isV1Tier)) {
    Object.assign(
      tier(override.when),
      withoutUndefined({ output: override.price, reasoning: override.reasoning }),
    );
  }

  const tiers = [...contextTiers.values()];
  // v1 has no web search price, so `web_search` stays v2-only.
  return withoutUndefined({
    input: input.price,
    output: output.price,
    reasoning: output.reasoning,
    cache_read: input.cache?.read,
    cache_write: input.cache && firstPrice(input.cache.write),
    input_audio: cost.audio?.input?.price,
    output_audio: cost.audio?.output?.price,
    tiers: tiers.length > 0 ? tiers : undefined,
  });
}

// v1 prices only vary by context, so overrides on other conditions (service tier,
// region…) stay v2-only, like multipliers.
function isV1Tier(override: { when: CostWhenV2 }) {
  return Object.keys(override.when).every((key) => key === "context");
}

// v1 has one cache write price: the first TTL listed (the provider's default).
function firstPrice(write: number | Partial<Record<string, number>> | undefined) {
  return typeof write === "object" ? Object.values(write)[0] : write;
}

// v1 modes carry their own prices. A v2 mode without a cost takes the base prices
// scaled by the multiplier for its service tier (the mode name by default).
function toV1Experimental(
  model: AuthoredModelV2,
  cost: Record<string, unknown> | undefined,
) {
  const modes = model.experimental?.modes;
  if (modes === undefined) return undefined;
  return {
    modes: Object.fromEntries(
      Object.entries(modes).map(([name, mode]) => {
        const tier = mode.service_tier ?? name;
        const factor = model.cost?.multipliers?.find((multiplier) => {
          const when = multiplier.when as Record<string, unknown>;
          return (
            Object.keys(when).length === 1 &&
            (when.service_tier as { equals?: unknown } | undefined)?.equals === tier
          );
        })?.factor;
        const modeCost =
          mode.cost !== undefined
            ? costV2ToV1(mode.cost)
            : typeof factor === "number" && cost !== undefined
              ? scaleCost(cost, factor)
              : undefined;
        if (modeCost !== undefined) delete modeCost.tiers;
        const provider = withoutUndefined({ body: mode.body, headers: mode.headers });
        return [
          name,
          withoutUndefined({
            cost: modeCost,
            provider: Object.keys(provider).length > 0 ? provider : undefined,
          }),
        ];
      }),
    ),
  };
}

function scaleCost(cost: Record<string, unknown>, factor: number) {
  return Object.fromEntries(
    Object.entries(cost)
      .filter(([key]) => key !== "tiers")
      .map(([key, value]) => [key, roundPrice((value as number) * factor)]),
  );
}

export function toV1Modalities(modalities: string[]) {
  return [...new Set(modalities.map(toV1Modality))];
}

export function toV1Modality(modality: string) {
  if (modality === "application/pdf") return "pdf";
  if (["decision", "embedding", "reranking"].includes(modality)) return "text";
  const base = modality.split("/")[0]!;
  if (["text", "image", "audio", "video"].includes(base)) return base;
  throw new Error(`No v1 modality for "${modality}"`);
}

function withoutUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

// Drops float noise from scaled prices (0.025 * 1.8 = 0.045000000000000005).
export function roundPrice(price: number) {
  return Math.round(price * 1e10) / 1e10;
}
