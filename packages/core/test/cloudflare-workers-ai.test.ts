import { expect, test } from "bun:test";

import {
  buildWorkersAiModel,
  cloudflareWorkersAi,
  schemaToolChoice,
  takesResponsesBody,
  toolsWith,
  workersAiApis,
} from "../src/sync/providers/cloudflare-workers-ai.js";
import { patchModelV2 } from "../src/model-file-v2.js";
import { modelV2ToV1 } from "../src/translate.js";

test("preserves OpenRouter pricing overrides as context tiers", () => {
  const [source] = cloudflareWorkersAi.parseModels({
    result: {
      data: [{
        id: "workers-ai/@cf/test/context-priced",
        name: "Context Priced",
        created: 1_782_777_600,
        hugging_face_id: null,
        knowledge_cutoff: null,
        context_length: 256_000,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        pricing: {
          prompt: "0.000001",
          completion: "0.000002",
          overrides: [{
            min_prompt_tokens: 128_000,
            prompt: "0.000003",
            completion: "0.000004",
          }],
        },
        top_provider: {
          context_length: 256_000,
          max_completion_tokens: 8_192,
        },
        supported_parameters: [],
      }],
    },
  });

  expect(source?.pricing.overrides).toEqual([{
    min_prompt_tokens: 128_000,
    prompt: "0.000003",
    completion: "0.000004",
  }]);

  const translated = cloudflareWorkersAi.translateModel(source!, {
    existing: () => undefined,
    authored: () => undefined,
  });
  expect(translated.model.cost).toEqual({
    input: 1,
    output: 2,
    tiers: [{
      tier: { type: "context", size: 128_000 },
      input: 3,
      output: 4,
    }],
  });
});

function searchRow(id: string, context: number) {
  return {
    id: `workers-ai/${id}`,
    name: "Served Window",
    created: 1_782_777_600,
    hugging_face_id: null,
    knowledge_cutoff: null,
    context_length: context,
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
    pricing: { prompt: "0.000001", completion: "0.000002" },
    top_provider: {
      context_length: context,
      max_completion_tokens: context,
    },
    supported_parameters: [],
  };
}

function translatedContext(id: string, context: number) {
  const [source] = cloudflareWorkersAi.parseModels({ result: { data: [searchRow(id, context)] } });
  return cloudflareWorkersAi.translateModel(source!, {
    existing: () => undefined,
    authored: () => undefined,
  }).model.limit?.context;
}

test("pins the served context window when search reports a larger one", () => {
  expect(translatedContext("@cf/zai-org/glm-5.3", 1_310_720)).toBe(1_048_576);
  expect(translatedContext("@cf/zai-org/glm-5.3-flash", 1_310_720)).toBe(1_048_576);
  expect(translatedContext("@cf/deepseek-ai/deepseek-v4-flash-0731", 1_310_720)).toBe(1_048_576);
});

test("never raises a context window or pins other models", () => {
  expect(translatedContext("@cf/zai-org/glm-5.3", 262_144)).toBe(262_144);
  expect(translatedContext("@cf/test/unpinned", 1_310_720)).toBe(1_310_720);
});

test("marks Clef routes as decisions even when Workers AI search labels them text generation", () => {
  for (const id of ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash", "@cf/cloudflare/clef-omni"]) {
    const [source] = cloudflareWorkersAi.parseModels({ result: { data: [searchRow(id, 65_536)] } });
    const translated = cloudflareWorkersAi.translateModel(source!, {
      existing: () => undefined,
      authored: () => undefined,
    });
    expect(translated?.model.type).toBe("decision");
  }
  const [other] = cloudflareWorkersAi.parseModels({ result: { data: [searchRow("@cf/test/chat", 65_536)] } });
  expect(cloudflareWorkersAi.translateModel(other!, {
    existing: () => undefined,
    authored: () => undefined,
  })?.model.type).toBeUndefined();
});

test("keeps Clairic's authored extraction type when search labels it text generation", () => {
  const doc = {
    schema: 2,
    v2_only: true,
    type: "extraction",
    name: "Clairic",
    description: "Extracts typed fields",
    open_weights: true,
    release_date: "2026-10-14",
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { tools: { supported: false }, reasoning: { supported: false }, temperature: true },
    limit: { context: 65_536, output: 65_536 },
    cost: { text: { input: { price: 0.1 }, output: { price: 0 } } },
  };
  const before = modelV2ToV1({ ...doc, id: "@cf/cloudflare/clairic" });
  const [source] = cloudflareWorkersAi.parseModels({ result: { data: [searchRow("@cf/cloudflare/clairic", 65_536)] } });
  const after: Record<string, unknown> = cloudflareWorkersAi.translateModel(source!, {
    existing: () => before as never,
    authored: () => undefined,
  })!.model;
  expect(after.type).toBeUndefined();
  expect(patchModelV2(doc, before, after).type).toBe("extraction");
});

test("lists search efforts weakest first so v2 files stay unchanged", () => {
  const [source] = cloudflareWorkersAi.parseModels({
    result: {
      data: [{
        ...searchRow("@cf/test/efforts", 65_536),
        supported_parameters: ["reasoning"],
        reasoning: { mandatory: false, supported_efforts: ["max", "high", "low", "none"] },
      }],
    },
  });
  expect(cloudflareWorkersAi.translateModel(source!, {
    existing: () => undefined,
    authored: () => undefined,
  })?.model.reasoning_options).toEqual([{ type: "effort", values: ["none", "low", "high", "max"] }]);
});

test("keeps the file's own API address, which search does not report", () => {
  const [source] = cloudflareWorkersAi.parseModels({ result: { data: [searchRow("@cf/test/run-api", 65_536)] } });
  const provider = { api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run" };
  expect(buildWorkersAiModel(source!, { provider }).provider).toEqual(provider);
  expect(buildWorkersAiModel(source!, undefined).provider).toBeUndefined();
});

test("detects Workers AI request schemas that take a Responses body", () => {
  const prompt = { title: "Prompt", properties: { prompt: {}, max_tokens: {} } };
  const messages = { title: "Messages", properties: { messages: {}, tools: {} } };
  // GPT-OSS: a Responses variant with top-level `input` next to the chat variants.
  expect(takesResponsesBody({ oneOf: [{ oneOf: [prompt, messages] }, { properties: { input: {}, reasoning: {} } }] })).toBe(true);
  expect(takesResponsesBody({ anyOf: [{ oneOf: [prompt, messages] }, { properties: { requests: {} } }] })).toBe(false);
});

test("lists the Responses API after a Workers AI model's first table only when its schema takes it", () => {
  const responses = { sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" } };
  expect(workersAiApis(undefined, true)).toEqual({ "chat-completions": {}, responses });
  const once = workersAiApis(undefined, true);
  expect(workersAiApis(once, true)).toEqual(once);
  // No Responses body: nothing is added, and a stale table is dropped.
  expect(workersAiApis(undefined, false)).toBeUndefined();
  expect(workersAiApis(once, false)).toEqual({ "chat-completions": {} });
  const run = { "workers-ai-run": { base_url: "https://example.com/ai/run" } };
  expect(workersAiApis(run, false)).toEqual(run);
});

test("reads tool_choice values from a request schema only when it names them", () => {
  const named = (type: string) => ({ type: "object", properties: { type: { type: "string", enum: [type] } } });
  // Workers AI chat schemas (GLM 5.3): string modes, a named function or custom tool, allowed_tools.
  const workersAi = {
    anyOf: [{
      oneOf: [{
        properties: {
          tool_choice: {
            anyOf: [{
              oneOf: [{ type: "string", enum: ["none", "auto", "required"] }, named("function"), named("custom"), named("allowed_tools")],
            }],
          },
        },
      }],
    }],
  };
  expect(schemaToolChoice(workersAi)).toEqual(["auto", "none", "required", "tool"]);
  // Anthropic-shaped objects keyed by `type`, where "any" means required.
  const anthropic = (types: string[]) => ({
    properties: { tool_choice: { oneOf: types.map((type) => ({ type: "object", properties: { type: { type: "string", const: type } } })) } },
  });
  expect(schemaToolChoice(anthropic(["auto", "none"]))).toEqual(["auto", "none"]);
  expect(schemaToolChoice(anthropic(["auto", "any", "tool", "none"]))).toEqual(["auto", "none", "required", "tool"]);
  expect(schemaToolChoice({ oneOf: [{ properties: { tool_choice: { type: "string", enum: ["none", "auto"] } } }] })).toEqual(["auto", "none"]);
  // An open string or an untyped field doesn't say which values work.
  expect(schemaToolChoice({ properties: { tool_choice: { anyOf: [{ type: "string" }, named("function")] } } })).toBeUndefined();
  expect(schemaToolChoice({ properties: { tool_choice: {} } })).toBeUndefined();
  expect(schemaToolChoice({ properties: { tools: {} } })).toBeUndefined();
});

test("sets stated tool fields and keeps the file's others", () => {
  expect(toolsWith(undefined, { choice: ["auto"] })).toEqual({ supported: true, choice: ["auto"] });
  expect(toolsWith({ supported: true, updates: true, choice: ["auto"] }, { choice: ["auto", "none"] }))
    .toEqual({ supported: true, updates: true, choice: ["auto", "none"] });
  expect(toolsWith({ supported: true, choice: ["auto"] }, { choice: undefined })).toEqual({ supported: true, choice: ["auto"] });
  expect(toolsWith({ supported: false }, { choice: ["auto"] })).toEqual({ supported: false });
});
