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
  ProviderV2,
  type ApiEntryV2,
  type ApiProtocolV2,
  type ApiV2,
  type CompatibilityV2,
  type ExperimentalModeV2,
  type InputModalityV2,
  type ModelV2,
  type OutputModalityV2,
  type ReasoningSupportV2,
} from "./schema-v2.js";

// ---------------------------------------------------------------------------
// High-level catalog generation
// ---------------------------------------------------------------------------

export async function generateV2(
  providersDir: string,
): Promise<Record<string, ProviderV2>> {
  const modelsDir = path.join(path.dirname(providersDir), "models");
  const baseModels = await generateModels(modelsDir);

  const providers: Record<string, ProviderV2> = {};
  for await (const providerPath of scanTomls(providersDir, "*/provider.toml")) {
    const provider = await loadProviderV2(providerPath, baseModels);
    providers[provider.id] = provider;
  }

  return providers;
}

async function loadProviderV2(
  providerPath: string,
  baseModels: Record<string, ModelMetadata>,
): Promise<ProviderV2> {
  const providerDir = path.dirname(providerPath);
  const providerID = path.basename(providerDir);
  const rawProvider = { ...(await readToml(providerPath)), id: providerID, models: {} };
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
    const resolved = resolveV1Model(rawModel, baseModels, modelPath);
    models[modelID] = toModelV2(resolved, v1Provider);
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

// ---------------------------------------------------------------------------
// V1 -> V2 model transformation
// ---------------------------------------------------------------------------

export function toModelV2(model: Model, provider: Provider): ModelV2 {
  const type = model.type ?? "chat";
  const normalizeModality = (m: string) =>
    m === "pdf" ? "application/pdf" : m;
  const outputModalities: OutputModalityV2[] =
    type === "decision"
      ? ["decision"]
      : type === "embedding"
        ? ["embedding"]
        : type === "reranking"
          ? ["reranking"]
          : (model.modalities.output.map(normalizeModality) as OutputModalityV2[]);
  const stripLegacyCost = ({
    context_over_200k: _legacy,
    ...cost
  }: NonNullable<Model["cost"]>) => cost;

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
      tools: model.tool_call ? { supported: true } : { supported: false },
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
    ...(model.cost !== undefined ? { cost: stripLegacyCost(model.cost) } : {}),
    api: toApiV2(model, provider),
    ...(model.experimental?.modes
      ? {
          experimental: {
            modes: Object.fromEntries(
              Object.entries(model.experimental.modes).map(([name, mode]) => {
                const entry: ExperimentalModeV2 = {
                  ...(mode.cost !== undefined
                    ? { cost: stripLegacyCost(mode.cost) }
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
  "@ai-sdk/google": "https://generativelanguage.googleapis.com/v1beta",
  "@ai-sdk/google-vertex":
    "https://${GOOGLE_VERTEX_LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}/publishers/google",
  "@ai-sdk/google-vertex/anthropic":
    "https://${GOOGLE_VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}/publishers/anthropic",
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
  "@ai-sdk/gateway": "https://ai-gateway.vercel.sh/v1/ai",
  "@ai-sdk/vercel": "https://api.v0.dev/v1",
  "venice-ai-sdk-provider": "https://api.venice.ai/api/v1",
  "ai-gateway-provider":
    "https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}",
  "@aihubmix/ai-sdk-provider": "https://aihubmix.com/v1",
  "@saladtechnologies-oss/ai-sdk-provider":
    "https://api.salad.com/api/public",
  "watsonx-ai-provider": "https://${WATSONX_REGION}.ml.cloud.ibm.com",
  "@qvac/ai-sdk-provider": "http://localhost:8080/v1",
  "@jerome-benoit/sap-ai-provider-v2": "${AICORE_DEPLOYMENT_URL}",
  "gitlab-ai-provider": "https://gitlab.com/api/v4",
};

const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = {
  azure: "https://${AZURE_RESOURCE_NAME}.openai.azure.com/openai/v1",
  "azure-cognitive-services":
    "https://${AZURE_COGNITIVE_SERVICES_RESOURCE_NAME}.openai.azure.com/openai/v1",
};

const OPENCODE_PACKAGES: Record<string, string> = {
  "@ai-sdk/amazon-bedrock": "@opencode/ai/providers/amazon-bedrock",
  "@ai-sdk/alibaba": "@opencode/ai/providers/alibaba/chat",
  "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic",
  "@ai-sdk/azure": "@opencode/ai/providers/azure/responses",
  "@ai-sdk/cerebras": "@opencode/ai/providers/cerebras",
  "@ai-sdk/cohere": "@opencode/ai/providers/cohere/chat",
  "@ai-sdk/deepinfra": "@opencode/ai/providers/deepinfra",
  "@ai-sdk/google": "@opencode/ai/providers/google",
  "@ai-sdk/google-vertex": "@opencode/ai/providers/google-vertex/gemini",
  "@ai-sdk/google-vertex/anthropic":
    "@opencode/ai/providers/google-vertex/messages",
  "@ai-sdk/groq": "@opencode/ai/providers/groq",
  "@ai-sdk/mistral": "@opencode/ai/providers/mistral",
  "@ai-sdk/openai": "@opencode/ai/providers/openai/responses",
  "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
  "@ai-sdk/togetherai": "@opencode/ai/providers/togetherai",
  "@ai-sdk/xai": "@opencode/ai/providers/xai",
  "@ai-sdk/gateway": "@opencode/ai/providers/vercel-ai-gateway",
  "@openrouter/ai-sdk-provider": "@opencode/ai/providers/openrouter",
  "ai-gateway-provider": "@opencode/ai/providers/cloudflare-ai-gateway",
  "venice-ai-sdk-provider": "@opencode/ai/providers/venice",
};

const hostProtocols = (name: string) => ({
  "@ai-sdk/openai-compatible": `@opencode/ai/providers/${name}/chat`,
  "@ai-sdk/anthropic": `@opencode/ai/providers/${name}/messages`,
  "@ai-sdk/openai": `@opencode/ai/providers/${name}/responses`,
});

const OPENCODE_HOSTS: Record<string, Record<string, string>> = {
  alibaba: hostProtocols("alibaba"),
  "alibaba-cn": hostProtocols("alibaba"),
  "alibaba-coding-plan": hostProtocols("alibaba"),
  "alibaba-coding-plan-cn": hostProtocols("alibaba"),
  "alibaba-token-plan": hostProtocols("alibaba"),
  "alibaba-token-plan-cn": hostProtocols("alibaba"),
  baseten: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/baseten" },
  "cloudflare-ai-gateway": {
    "@ai-sdk/anthropic": "@opencode/ai/providers/cloudflare-ai-gateway",
    "@ai-sdk/openai": "@opencode/ai/providers/cloudflare-ai-gateway",
    "@ai-sdk/openai-compatible":
      "@opencode/ai/providers/cloudflare-ai-gateway",
    "ai-gateway-provider": "@opencode/ai/providers/cloudflare-ai-gateway",
  },
  cohere: {
    "@ai-sdk/openai-compatible": "@opencode/ai/providers/cohere/chat",
  },
  "cloudflare-workers-ai": {
    "@ai-sdk/openai-compatible":
      "@opencode/ai/providers/cloudflare-workers-ai",
  },
  deepseek: {
    "@ai-sdk/openai-compatible": "@opencode/ai/providers/deepseek",
  },
  digitalocean: {
    "@ai-sdk/openai-compatible": "@opencode/ai/providers/digitalocean",
  },
  "fireworks-ai": {
    "@ai-sdk/openai-compatible": "@opencode/ai/providers/fireworks",
  },
  "google-vertex": {
    "@ai-sdk/openai-compatible": "@opencode/ai/providers/google-vertex/chat",
  },
  "kimi-for-coding": hostProtocols("moonshot"),
  meta: hostProtocols("meta"),
  minimax: hostProtocols("minimax"),
  "minimax-cn": hostProtocols("minimax"),
  "minimax-coding-plan": hostProtocols("minimax"),
  "minimax-cn-coding-plan": hostProtocols("minimax"),
  moonshotai: hostProtocols("moonshot"),
  "moonshotai-cn": hostProtocols("moonshot"),
  zai: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/zai/chat" },
  "zai-coding-plan": hostProtocols("zai-coding-plan"),
  zhipuai: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/zai/chat" },
  "zhipuai-coding-plan": hostProtocols("zai-coding-plan"),
};

function toApiV2(model: Model, provider: Provider): ApiV2 {
  const npm = model.provider?.npm ?? provider.npm;
  const shape = model.provider?.shape;
  const rawBaseUrl =
    model.provider?.api ??
    provider.api ??
    DEFAULT_PROVIDER_BASE_URLS[provider.id] ??
    DEFAULT_NPM_BASE_URLS[npm] ??
    "";
  const base_url = rawBaseUrl.replace(/\/+$/, "");

  const { protocol, path } = resolveProtocolAndPath(model, provider, npm, shape);
  const opencodeai = resolveOpencodePackage(model, provider, npm, shape);
  const compatibility = toCompatibilityV2(model);

  const entry: ApiEntryV2 = {
    base_url,
    path,
    sdk: {
      ...(model.type === "decision" ? {} : { aisdk: npm }),
      ...(opencodeai !== undefined ? { opencodeai } : {}),
    },
    ...(compatibility !== undefined ? { compatibility } : {}),
  };

  return { [protocol]: entry } as ApiV2;
}

function resolveProtocolAndPath(
  model: Model,
  provider: Provider,
  npm: string,
  shape: "responses" | "completions" | undefined,
): { protocol: ApiProtocolV2; path: string } {
  if (model.type === "decision") {
    if (provider.id === "cloudflare-workers-ai") {
      return { protocol: "workers-ai-run", path: `/run/${model.id}` };
    }
    if (provider.id === "vercel") {
      return { protocol: "evaluate", path: "/evaluate" };
    }
    return { protocol: "system-one", path: "/systemone" };
  }

  if (npm === "@ai-sdk/anthropic") {
    return { protocol: "messages", path: "/messages" };
  }
  if (npm === "@ai-sdk/google-vertex/anthropic") {
    return { protocol: "messages", path: `/models/${model.id}:streamRawPredict` };
  }
  if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure") {
    return shape === "completions"
      ? { protocol: "chat-completions", path: "/chat/completions" }
      : { protocol: "responses", path: "/responses" };
  }
  if (npm === "@ai-sdk/amazon-bedrock") {
    return { protocol: "converse", path: `/model/${model.id}/converse` };
  }
  if (npm === "@ai-sdk/amazon-bedrock/mantle") {
    return model.id.includes("gpt-oss")
      ? { protocol: "chat-completions", path: "/chat/completions" }
      : { protocol: "responses", path: "/responses" };
  }
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") {
    return {
      protocol: "generate-content",
      path: `/models/${model.id}:generateContent`,
    };
  }
  if (npm === "@ai-sdk/cohere") {
    return { protocol: "cohere-chat", path: "/chat" };
  }

  return shape === "responses"
    ? { protocol: "responses", path: "/responses" }
    : { protocol: "chat-completions", path: "/chat/completions" };
}

function resolveOpencodePackage(
  model: Model,
  provider: Provider,
  npm: string,
  shape: "responses" | "completions" | undefined,
): string | undefined {
  if (model.type === "decision") {
    if (provider.id === "cloudflare-workers-ai")
      return "@opencode/ai/providers/cloudflare-workers-ai";
    if (provider.id === "vercel")
      return "@opencode/ai/providers/vercel-ai-gateway";
    return "@opencode/ai/providers/typesafe-ai";
  }

  const host = OPENCODE_HOSTS[provider.id]?.[npm];
  if (host) return host;
  if (npm === "@ai-sdk/amazon-bedrock/mantle") {
    return `@opencode/ai/providers/amazon-bedrock/mantle/${
      model.id.includes("gpt-oss") ? "chat" : "responses"
    }`;
  }
  if (npm === "@ai-sdk/openai" && shape === "completions") {
    return "@opencode/ai/providers/openai/chat";
  }
  if (npm === "@ai-sdk/azure" && shape === "completions") {
    return "@opencode/ai/providers/azure/chat";
  }
  if (npm === "@ai-sdk/openai-compatible" && shape === "responses") {
    return "@opencode/ai/providers/openai-compatible/responses";
  }
  return OPENCODE_PACKAGES[npm];
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

  const authored = parseWithCause(AuthoredModel, merged, {
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
