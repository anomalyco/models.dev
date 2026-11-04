import path from "path";
import { existsSync } from "node:fs";
import { mergeDeep } from "remeda";
import { z } from "zod";

import { generateModels } from "./generate.js";
import {
  AuthoredModel,
  AuthoredModelShape,
  ModelMetadata,
  Provider,
  type Model,
} from "./schema.js";
import {
  AuthoredModelV2,
  LabModelV2,
  ProviderV2,
  OpencodePackageV2,
  type ApiEntryV2,
  type AuthoredApiEntryV2,
  type AuthoredToolsSupportV2,
  type ApiProtocolV2,
  type ApiV2,
  type CompatibilityV2,
  type CostV2,
  type ExperimentalModeV2,
  type InputCostV2,
  type InputModalityV2,
  type ModelV2,
  type OutputCostV2,
  type OutputModalityV2,
  type ReasoningSupportV2,
} from "./schema-v2.js";
import { modelV2ToV1, providerTomlToV1, v1ModelType, withoutV1ReasoningCost } from "./translate.js";

// ---------------------------------------------------------------------------
// High-level catalog generation
// ---------------------------------------------------------------------------

// Legacy v1 provider aliases superseded by canonical `azure` and `google-vertex` in v2.
const IGNORED_PROVIDERS = new Set([
  "azure-cognitive-services",
  "google-vertex-anthropic",
]);

export async function generateV2(
  providersDir: string,
): Promise<Record<string, ProviderV2>> {
  const modelsDir = path.join(path.dirname(providersDir), "models");
  const baseModels = await generateModels(modelsDir);
  const labsV2 = await loadLabsV2(modelsDir);

  const providers: Record<string, ProviderV2> = {};
  const nameToProviderID = new Map<string, string>();
  for await (const providerPath of scanTomls(providersDir, "*/provider.toml")) {
    const providerID = path.basename(path.dirname(providerPath));
    if (IGNORED_PROVIDERS.has(providerID)) continue;
    if ((await readToml(providerPath)).v1_alias !== undefined) continue;
    const provider = await loadProviderV2(providerPath, baseModels, labsV2);
    const nameKey = provider.name.toLowerCase();
    const existingID = nameToProviderID.get(nameKey);
    if (existingID !== undefined) {
      throw new Error(
        `Duplicate provider name "${provider.name}" used by both "${existingID}" and "${provider.id}". Provider names must be unique.`,
        { cause: { providerIDs: [existingID, provider.id], name: provider.name } },
      );
    }
    nameToProviderID.set(nameKey, provider.id);
    providers[provider.id] = provider;
  }

  return providers;
}

async function loadProviderV2(
  providerPath: string,
  baseModels: Record<string, ModelMetadata>,
  labsV2: Record<string, LabModelV2>,
): Promise<ProviderV2> {
  const providerDir = path.dirname(providerPath);
  const providerID = path.basename(providerDir);
  const toml = await readToml(providerPath);
  const opencodeai =
    toml.opencodeai === undefined
      ? undefined
      : parseWithCause(OpencodePackageV2, toml.opencodeai, { providerPath, toml });
  const rawProvider = { ...providerTomlToV1(toml), id: providerID, models: {} };
  const v1Provider = parseWithCause(Provider, rawProvider, {
    providerPath,
    toml: rawProvider,
  });

  const modelsDir = path.join(providerDir, "models");
  if (!existsSync(modelsDir)) {
    throw new Error(`Provider "${providerID}" has no models`, {
      cause: { providerPath },
    });
  }

  const models: Record<string, ModelV2> = {};
  for await (const modelPath of scanTomls(modelsDir, "**/*.toml")) {
    const modelID = path
      .relative(modelsDir, modelPath)
      .split(path.sep)
      .join("/")
      .slice(0, -5);
    const rawModel = { ...(await readToml(modelPath)), id: modelID };
    const v1Model = modelV2ToV1(rawModel, { modelPath }, v1Provider.npm);
    const resolved = resolveV1Model(v1Model, baseModels, modelPath);
    const tables = (rawModel as Record<string, unknown>).api as Record<string, AuthoredApiEntryV2> | undefined;
    const { model, tools } = withV2Fields(toModelV2(resolved, v1Provider), rawModel, labsV2, modelPath);
    if (tables !== undefined) model.api = toModelApis(tables, v1Provider, opencodeai);
    else if (opencodeai !== undefined && opencodeai !== "none") model.api = withOpencodePackage(model.api, opencodeai);
    model.api = withApiTools(model.api, tools, tables, { modelPath });
    models[modelID] = model;
  }

  if (Object.keys(models).length === 0) {
    throw new Error(`Provider "${providerID}" has no models`, {
      cause: { providerPath },
    });
  }

  return parseWithCause(
    ProviderV2,
    {
      id: v1Provider.id,
      name: v1Provider.name,
      doc: v1Provider.doc,
      env: v1Provider.env,
      models,
    },
    { providerPath, toml: rawProvider },
  );
}

async function loadLabsV2(modelsDir: string) {
  const labs: Record<string, LabModelV2> = {};
  if (!existsSync(modelsDir)) return labs;
  for await (const modelPath of scanTomls(modelsDir, "**/*.toml")) {
    const raw = await readToml(modelPath);
    const id = path.relative(modelsDir, modelPath).split(path.sep).join("/").slice(0, -5);
    labs[id] = parseWithCause(LabModelV2, { ...withoutSchema(raw), id }, { modelPath, toml: raw });
  }
  return labs;
}

// v1 can't carry some v2 data (MIME modalities, cache TTLs, service tiers…), so it
// is read straight from the v2 lab and provider files. The tool details come back
// separately: they are published on each API, not on the model.
function withV2Fields(
  model: ModelV2,
  rawModel: Record<string, unknown>,
  labsV2: Record<string, LabModelV2>,
  modelPath: string,
) {
  const lab =
    typeof rawModel.base_model === "string" ? labsV2[rawModel.base_model] : undefined;
  const authored = parseWithCause(AuthoredModelV2, withoutSchema(rawModel), { modelPath, toml: rawModel });
  const omit = Array.isArray(rawModel.base_model_omit) ? rawModel.base_model_omit : [];
  const inheritsModalities =
    rawModel.modalities === undefined &&
    !omit.some((item) => String(item).startsWith("modalities"));

  const capabilities = mergeDeep(
    mergeDeep(lab?.capabilities ?? {}, model.capabilities),
    authored.capabilities ?? {},
  ) as Omit<ModelV2["capabilities"], "tools"> & { tools: AuthoredToolsSupportV2 };
  const result: ModelV2 = {
    ...model,
    modalities:
      authored.modalities ??
      (lab !== undefined && inheritsModalities ? lab.modalities : model.modalities),
    capabilities: { ...capabilities, tools: { supported: capabilities.tools.supported } },
  };
  // v1 leaves v2-only types out, so they come from the files.
  const type = authored.type ?? (omit.includes("type") ? undefined : lab?.type);
  if (type !== undefined && v1ModelType(type, authored.v2_only, { modelPath, toml: rawModel }) === undefined) {
    result.type = type;
  }
  if (authored.cost !== undefined) result.cost = authored.cost;
  if (authored.experimental !== undefined) result.experimental = authored.experimental;
  if (authored.metadata !== undefined) result.metadata = authored.metadata;
  return { model: result, tools: capabilities.tools };
}

function withoutSchema(raw: Record<string, unknown>) {
  const { schema: _schema, ...rest } = raw;
  return rest;
}

// ---------------------------------------------------------------------------
// V1 -> V2 model transformation
// ---------------------------------------------------------------------------

export function toModelV2(model: Model, provider: Provider): ModelV2 {
  const type = model.type ?? "chat";
  const normalizeModality = (m: string) =>
    m === "pdf" ? "application/pdf" : m;
  const outputModalities = ((): OutputModalityV2[] => {
    if (type === "decision" || type === "embedding" || type === "reranking") {
      return [type];
    }
    return model.modalities.output.map(normalizeModality) as OutputModalityV2[];
  })();
  return {
    id: model.id,
    ...(model.canonical_model_id !== undefined
      ? { canonical_id: model.canonical_model_id }
      : {}),
    type,
    name: model.name,
    description: model.description,
    ...(model.family !== undefined ? { family: model.family } : {}),
    open_weights: model.open_weights,
    ...(model.knowledge !== undefined ? { knowledge: model.knowledge } : {}),
    release_date: model.release_date,
    last_updated: model.last_updated,
    ...(model.status !== undefined ? { status: model.status } : {}),
    modalities: {
      input: model.modalities.input.map(normalizeModality) as InputModalityV2[],
      output: outputModalities,
    },
    capabilities: {
      tools: { supported: model.tool_call },
      // An update flag that isn't authored means the host doesn't support it.
      system_updates: false,
      effort_updates: false,
      reasoning: toReasoningSupportV2(model),
      ...(model.structured_output !== undefined && type !== "decision"
        ? { structured_output: model.structured_output }
        : {}),
      ...(model.temperature !== undefined
        ? { temperature: model.temperature }
        : {}),
    },
    limit: {
      context: model.limit.context,
      ...(model.limit.input !== undefined ? { input: model.limit.input } : {}),
      ...(type === "decision" && model.limit.output === 0
        ? {}
        : { output: model.limit.output }),
    },
    ...(model.cost !== undefined ? { cost: toCostV2(model.cost) } : {}),
    api: toApiV2(model, provider),
    ...(model.experimental?.modes
      ? {
          experimental: {
            modes: Object.fromEntries(
              Object.entries(model.experimental.modes).map(([name, mode]) => {
                const entry: ExperimentalModeV2 = {
                  ...(mode.cost !== undefined
                    ? { cost: toCostV2(mode.cost) }
                    : {}),
                  ...(mode.provider?.body !== undefined
                    ? { body: mode.provider.body }
                    : {}),
                  ...(mode.provider?.headers !== undefined
                    ? { headers: mode.provider.headers }
                    : {}),
                };
                return [name, entry];
              }),
            ),
          },
        }
      : {}),
  };
}

type CostV1 = NonNullable<Model["cost"]>;
type CostTierV1 = NonNullable<CostV1["tiers"]>[number];

// v1 context tiers become `context > size` overrides on each price they set.
export function toCostV2(cost: CostV1): CostV2 {
  const tiers = [...(cost.tiers ?? [])].sort((a, b) => a.tier.size - b.tier.size);
  const when = (tier: CostTierV1) => ({ context: { gt: tier.tier.size } });
  const cache = (prices: { cache_read?: number; cache_write?: number }) =>
    prices.cache_read === undefined && prices.cache_write === undefined
      ? {}
      : {
          cache: {
            ...(prices.cache_read !== undefined ? { read: prices.cache_read } : {}),
            ...(prices.cache_write !== undefined
              ? { write: prices.cache_write }
              : {}),
          },
        };
  const withOverrides = <T extends { when: unknown }>(overrides: T[]) =>
    overrides.length > 0 ? { overrides } : {};

  const textInput: InputCostV2 = {
    price: cost.input,
    ...cache(cost),
    ...withOverrides(
      tiers.map((tier) => ({ when: when(tier), price: tier.input, ...cache(tier) })),
    ),
  };
  const textOutput: OutputCostV2 = {
    price: cost.output,
    ...(cost.reasoning !== undefined ? { reasoning: cost.reasoning } : {}),
    ...withOverrides(
      tiers.map((tier) => ({
        when: when(tier),
        price: tier.output,
        ...(tier.reasoning !== undefined ? { reasoning: tier.reasoning } : {}),
      })),
    ),
  };
  const audioInput: InputCostV2 | undefined =
    cost.input_audio === undefined
      ? undefined
      : {
          price: cost.input_audio,
          ...withOverrides(
            tiers.flatMap((tier) =>
              tier.input_audio === undefined
                ? []
                : [{ when: when(tier), price: tier.input_audio }],
            ),
          ),
        };
  const audioOutput: OutputCostV2 | undefined =
    cost.output_audio === undefined
      ? undefined
      : {
          price: cost.output_audio,
          ...withOverrides(
            tiers.flatMap((tier) =>
              tier.output_audio === undefined
                ? []
                : [{ when: when(tier), price: tier.output_audio }],
            ),
          ),
        };

  return {
    text: { input: textInput, output: textOutput },
    ...(audioInput !== undefined || audioOutput !== undefined
      ? {
          audio: {
            ...(audioInput !== undefined ? { input: audioInput } : {}),
            ...(audioOutput !== undefined ? { output: audioOutput } : {}),
          },
        }
      : {}),
  };
}

function toReasoningSupportV2(model: Model): ReasoningSupportV2 {
  if (!model.reasoning) return { supported: false };

  const options = model.reasoning_options ?? [];
  const hasToggle = options.some((option) => option.type === "toggle");
  const effort = options.find((option) => option.type === "effort");
  const budget = options.find((option) => option.type === "budget_tokens");

  return {
    supported: true,
    ...(hasToggle ? { toggle: true } : {}),
    ...(effort !== undefined
      ? {
          effort: effort.values.map((value) =>
            value === null ? "default" : value,
          ),
        }
      : {}),
    ...(budget !== undefined
      ? {
          budget: {
            ...(budget.min !== undefined ? { min: budget.min } : {}),
            ...(budget.max !== undefined ? { max: budget.max } : {}),
          },
        }
      : {}),
  };
}

const DEFAULT_NPM_BASE_URLS: Record<string, string> = {
  "@ai-sdk/openai": "https://api.openai.com/v1",
  "@ai-sdk/anthropic": "https://api.anthropic.com/v1",
  "@ai-sdk/azure": "https://${AZURE_RESOURCE_NAME}.openai.azure.com/openai/v1",
  "@ai-sdk/google": "https://generativelanguage.googleapis.com/v1beta",
  "@ai-sdk/google-vertex":
    "https://${GOOGLE_VERTEX_ENDPOINT}/v1beta1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}/publishers/google",
  "@ai-sdk/google-vertex/anthropic":
    "https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}/publishers/anthropic/models",
  "@ai-sdk/amazon-bedrock":
    "https://bedrock-runtime.${AWS_REGION}.amazonaws.com",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/deepinfra": "https://api.deepinfra.com/v1/openai",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/cohere": "https://api.cohere.com/v2",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
  // OpenAI-compatible base for chat-completions, responses and messages; `/v1/ai` is the AI SDK's own protocol.
  "@ai-sdk/gateway": "https://ai-gateway.vercel.sh/v1",
  "@ai-sdk/vercel": "https://api.v0.dev/v1",
  "venice-ai-sdk-provider": "https://api.venice.ai/api/v1",
  // The catalog-aware REST API (`/ai/v1/chat/completions`, `/responses`, `/messages`); provider
  // passthroughs such as `/openai` are authored on their models.
  "ai-gateway-provider":
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
  "@aihubmix/ai-sdk-provider": "https://aihubmix.com/v1",
  // The AI Gateway, not SaladCloud's management API. https://docs.salad.com/ai-gateway/tutorials/getting-started
  "@saladtechnologies-oss/ai-sdk-provider": "https://ai.salad.cloud/v1",
  "watsonx-ai-provider": "https://${WATSONX_REGION}.ml.cloud.ibm.com",
  // `qvac serve --openai` listens on port 11434 by default (@qvac/cli 0.16.0 README).
  "@qvac/ai-sdk-provider": "http://127.0.0.1:11434/v1",
  "@jerome-benoit/sap-ai-provider-v2": "${AICORE_DEPLOYMENT_URL}",
  "gitlab-ai-provider": "https://gitlab.com/api/v4",
};

function toApiV2(model: Model, provider: Provider): ApiV2 {
  const npm = model.provider?.npm ?? provider.npm;
  const shape = model.provider?.shape;
  const rawBaseUrl =
    model.provider?.api ??
    provider.api ??
    DEFAULT_NPM_BASE_URLS[npm] ??
    "";
  const base_url = rawBaseUrl.replace(/\/+$/, "");

  const protocol = resolveProtocol(model, provider, npm, shape);
  const compatibility = toCompatibilityV2(model);

  const entry: ApiEntryV2 = {
    base_url,
    sdk: { aisdk: npm },
    ...(compatibility !== undefined ? { compatibility } : {}),
    ...(model.tool_call ? { capabilities: { tools: { updates: false } } } : {}),
  };

  return { [protocol]: entry } as ApiV2;
}

export function resolveProtocol(
  model: Model,
  provider: Provider,
  npm: string,
  shape: "responses" | "completions" | undefined,
): ApiProtocolV2 {
  if (model.type === "decision") {
    if (provider.id === "cloudflare-workers-ai") return "workers-ai-run";
    if (provider.id === "vercel") return "decisions";
    return "systemone";
  }

  if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic") {
    return "messages";
  }
  if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure" || npm === "@ai-sdk/xai") {
    return shape === "completions" ? "chat-completions" : "responses";
  }
  if (npm === "@ai-sdk/amazon-bedrock") {
    return "converse";
  }
  if (npm === "@ai-sdk/amazon-bedrock/mantle") {
    return model.id.includes("gpt-oss") ? "chat-completions" : "responses";
  }
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") {
    return "generate-content";
  }
  if (npm === "@ai-sdk/cohere") {
    return "cohere-chat";
  }

  return shape === "responses" ? "responses" : "chat-completions";
}

// A model's own `[api.<protocol>]` tables, in order. Whatever a table leaves out
// comes from the provider's default API: `base_url` from its `api` (or the SDK's
// default URL), `sdk.aisdk` from its `npm`, and `sdk.opencodeai` from its
// `opencodeai` only when the table takes the provider's `npm` too: a table
// naming another `aisdk` names its own `opencodeai` or gets none. `"none"`
// stops a package from being filled in.
function toModelApis(
  tables: Record<string, AuthoredApiEntryV2>,
  provider: Provider,
  opencodeai: string | undefined,
): ApiV2 {
  return Object.fromEntries(
    Object.entries(tables).map(([protocol, table]) => {
      const aisdk = table.sdk?.aisdk ?? provider.npm;
      const npm = aisdk === "none" ? provider.npm : aisdk;
      const base_url = (table.base_url ?? provider.api ?? DEFAULT_NPM_BASE_URLS[npm] ?? "").replace(/\/+$/, "");
      const { tools: _tools, ...capabilities } = table.capabilities ?? {};
      const sdk = {
        aisdk,
        opencodeai: table.sdk?.opencodeai ?? (aisdk === provider.npm ? opencodeai : undefined),
      };
      const entry: ApiEntryV2 = {
        base_url,
        ...(table.path !== undefined ? { path: table.path } : {}),
        // `"none"`: no package supports this API, so the key is left out.
        sdk: Object.fromEntries(Object.entries(sdk).filter(([, value]) => value !== undefined && value !== "none")),
        ...(table.compatibility !== undefined ? { compatibility: table.compatibility } : {}),
        // Tool details are resolved for every API by `withApiTools`.
        ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
      };
      return [protocol, entry];
    }),
  ) as ApiV2;
}

const TOOL_DETAILS = ["strict", "choice", "search", "freeform"] as const;

// Each API of a model that supports tools gets its own tool details: the
// model's top-level values, replaced field by field by its table's.
function withApiTools(
  api: ApiV2,
  tools: AuthoredToolsSupportV2,
  tables: Record<string, AuthoredApiEntryV2> | undefined,
  cause: Record<string, unknown>,
): ApiV2 {
  return Object.fromEntries(
    Object.entries(api).map(([protocol, entry]) => {
      const override = tables?.[protocol]?.capabilities?.tools;
      if (!tools.supported) {
        if (override === undefined) return [protocol, entry];
        throw new Error(`[api.${protocol}] sets tool capabilities, but the model doesn't support tools`, { cause });
      }
      const merged = { ...tools, ...override };
      const details = Object.fromEntries(
        TOOL_DETAILS.filter((key) => merged[key] !== undefined).map((key) => [key, merged[key]]),
      );
      return [
        protocol,
        { ...entry, capabilities: { ...entry.capabilities, tools: { ...details, updates: merged.updates ?? false } } },
      ];
    }),
  ) as ApiV2;
}

// A model without its own tables uses the provider's default API, so it takes
// the provider's `opencodeai`.
function withOpencodePackage(api: ApiV2, opencodeai: string): ApiV2 {
  return Object.fromEntries(
    Object.entries(api).map(([protocol, entry]) => [protocol, { ...entry, sdk: { ...entry.sdk, opencodeai } }]),
  ) as ApiV2;
}

function toCompatibilityV2(model: Model): CompatibilityV2 | undefined {
  if (
    model.interleaved !== undefined &&
    typeof model.interleaved === "object" &&
    model.interleaved.field === "reasoning_content"
  ) {
    return { reasoning_field: "reasoning_content" };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Base model inheritance & file helpers
// ---------------------------------------------------------------------------

const BaseModel = AuthoredModelShape.deepPartial()
  .extend({
    id: z.string(),
    base_model: z.string().min(1, "Base model cannot be empty"),
    base_model_omit: z.array(z.string()).optional(),
  })
  .strict();

function resolveV1Model(
  rawModel: Record<string, unknown>,
  baseModels: Record<string, ModelMetadata>,
  modelPath: string,
): Model {
  if (rawModel.base_model === undefined) {
    return parseWithCause(AuthoredModel, rawModel, {
      modelPath,
      toml: rawModel,
    });
  }

  const baseModel = parseWithCause(BaseModel, rawModel, {
    modelPath,
    toml: rawModel,
  });
  const base = baseModels[baseModel.base_model];
  if (base === undefined) {
    throw new Error(`Unable to resolve base_model: ${baseModel.base_model}`, {
      cause: { modelPath, toml: baseModel },
    });
  }

  const {
    id: _id,
    benchmarks: _benchmarks,
    license: _license,
    links: _links,
    weights: _weights,
    ...inheritable
  } = base;
  const baseFields = Object.fromEntries(
    Object.entries(inheritable).filter(([, value]) => value !== undefined),
  );
  const {
    base_model: _baseModel,
    base_model_omit: omit,
    ...overrides
  } = baseModel;
  const merged: Record<string, unknown> = structuredClone(
    mergeDeep(baseFields, overrides),
  );
  omitPaths(merged, omit ?? []);

  const authored = parseWithCause(AuthoredModel, withoutV1ReasoningCost(merged), {
    modelPath,
    toml: merged,
  });

  return {
    ...authored,
    canonical_model_id: baseModel.base_model,
  };
}

function omitPaths(target: Record<string, unknown>, paths: string[]) {
  omitLoop: for (const rawPath of paths) {
    const parts = rawPath.split(".");
    const trail: Array<{ parent: Record<string, unknown>; key: string }> = [];
    let current: Record<string, unknown> = target;

    for (const part of parts.slice(0, -1)) {
      const next = current[part];
      if (!isPlainObject(next)) continue omitLoop;
      trail.push({ parent: current, key: part });
      current = next;
    }

    const leaf = parts.at(-1);
    if (leaf === undefined || !(leaf in current)) continue;
    delete current[leaf];

    for (const { parent, key } of trail.reverse()) {
      const child = parent[key];
      if (isPlainObject(child) && Object.keys(child).length === 0) {
        delete parent[key];
      } else {
        break;
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scanTomls(cwd: string, pattern: string) {
  return new Bun.Glob(pattern).scan({
    cwd,
    absolute: true,
    followSymlinks: true,
  });
}

async function readToml(filePath: string): Promise<Record<string, unknown>> {
  const mod = await import(filePath, { with: { type: "toml" } });
  return mod.default;
}

function parseWithCause<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  cause: Record<string, unknown>,
): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    parsed.error.cause = cause;
    throw parsed.error;
  }
  return parsed.data;
}
