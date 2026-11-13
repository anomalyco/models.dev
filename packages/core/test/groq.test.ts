import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildGroqModel, fetchGroqModels, groq, type GroqModel } from "../src/sync/providers/groq.js";

function context(entries: Record<string, ExistingModel>) {
  return { existing: (id: string) => entries[id], authored: (id: string) => entries[id] };
}

function groqModel(overrides: Partial<GroqModel> = {}): GroqModel {
  return {
    id: "qwen/qwen3.8-27b",
    active: true,
    context_window: 131_072,
    max_completion_tokens: 16_384,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supported_features: ["tools", "json_mode", "reasoning"],
    pricing: { prompt: "0.0000008", completion: "0.000004", input_cache_read: "0.0000004" },
    ...overrides,
  };
}

function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    name: "Qwen3.8 27B",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "default", "low", "medium", "high"] }],
    tool_call: true,
    structured_output: true,
    open_weights: true,
    cost: { input: 0.1, output: 0.1 },
    limit: { context: 65_536, output: 8_192 },
    modalities: { input: ["text", "image"], output: ["text"] },
    ...overrides,
  } as ExistingModel;
}

test("takes exact prices, cache rate and limits from the list, keeping authored reasoning", () => {
  expect(buildGroqModel(groqModel(), authored({ cost: { input: 0.1, output: 0.1, cache_read: 0.05 } }))).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["none", "default", "low", "medium", "high"] }],
    cost: { input: 0.8, output: 4, cache_read: 0.4 },
    limit: { context: 131_072, output: 16_384 },
  });
});

test("doesn't add a cache price the file doesn't already have", () => {
  const built = buildGroqModel(groqModel(), authored());
  expect(built.cost).toMatchObject({ input: 0.8, output: 4, cache_read: undefined });
});

test("fails on a list entry without a text price", () => {
  expect(() => buildGroqModel(groqModel({ pricing: {} }), authored())).toThrow("missing a text price");
});

test("only syncs priced text models that already have a file", () => {
  const existing = context({ "qwen/qwen3.8-27b": authored() });
  expect(groq.translateModel(groqModel(), existing)?.id).toBe("qwen/qwen3.8-27b");
  expect(groq.translateModel(groqModel({ id: "new/model" }), existing)).toBeUndefined();
  expect(groq.translateModel(groqModel({ output_modalities: ["speech"] }), existing)).toBeUndefined();
  expect(groq.translateModel(groqModel({ pricing: undefined }), existing)).toBeUndefined();
});

test("tracks only priced text models as missing and never deletes files", () => {
  expect(groq.skipCreates).toBe(true);
  expect(groq.deleteMissing).toBe(false);
  expect(groq.sourceID(groqModel())).toBe("qwen/qwen3.8-27b");
  expect(groq.sourceID(groqModel({ output_modalities: ["transcription"] }))).toBeUndefined();
  expect(groq.sourceID(groqModel({ active: false }))).toBeUndefined();
});

test("fetches with the API key and requires one", async () => {
  const saved = process.env.GROQ_API_KEY;
  try {
    let headers: HeadersInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      headers = init?.headers;
      return Response.json({ object: "list", data: [groqModel()] });
    };
    process.env.GROQ_API_KEY = "test-key";
    await fetchGroqModels(fetcher);
    expect(headers).toEqual({ Authorization: "Bearer test-key" });
    delete process.env.GROQ_API_KEY;
    await expect(fetchGroqModels(fetcher)).rejects.toThrow("GROQ_API_KEY");
  } finally {
    if (saved === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = saved;
  }
});

test("keeps the file's exact input formats", () => {
  const modalities = { input: ["text", "image/jpeg", "image/bmp"], output: ["text"] };
  const translated = groq.translateModel(groqModel(), {
    ...context({ "qwen/qwen3.8-27b": authored() }),
    v2: () => ({ schema: 2, base_model: "alibaba/qwen3.8-27b", modalities }),
  } as never);
  expect(translated?.v2Set).toEqual({ modalities });
});
