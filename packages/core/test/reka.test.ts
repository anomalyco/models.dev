import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generate } from "../src/generate.js";
import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import {
  fetchRekaModels,
  reka,
  rekaBaseModel,
  rekaReasoningControls,
  RekaResponse,
  type RekaModel,
} from "../src/sync/providers/reka.js";

const ROOT = path.join(import.meta.dirname, "../../..");
const FIXTURE = path.join(import.meta.dirname, "fixtures/reka-site-chat-models.json");
const ALL_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

async function fixture(): Promise<{ object: "list"; data: RekaModel[] }> {
  return Bun.file(FIXTURE).json();
}

function model(overrides: Partial<RekaModel> = {}): RekaModel {
  return {
    id: "glm5.3-flash",
    object: "model",
    created: 1787761875,
    owned_by: "reka",
    name: "GLM 5.3 Flash",
    description: "GLM 5.3 Flash, hosted by Reka.",
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    context_length: 1_048_576,
    max_output_length: 1_048_576,
    pricing: { prompt: "0.00000015", completion: "0.0000005", image: "0", request: "0", input_cache_read: "0.000000015" },
    supported_sampling_parameters: ["temperature", "top_p", "max_tokens"],
    supported_features: ["tools", "structured_outputs", "logprobs", "reasoning", "streaming"],
    reasoning_efforts: ALL_EFFORTS,
    hugging_face_id: "zai-org/GLM-5.3-Flash",
    is_ready: true,
    ...overrides,
  } as RekaModel;
}

const context = { existing: () => undefined, authored: () => undefined };

test("Reka is registered for scheduled sync and reads the keyless list without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === reka.id)).toBe(true);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ object: "list", data: [model()] });
  }) as unknown as typeof fetch;
  await fetchRekaModels(fetcher, "https://api.reka.ai/v1/site/chat-models");
  expect(request!.url).toBe("https://api.reka.ai/v1/site/chat-models");
  expect(request!.headers.get("authorization")).toBeNull();
  expect(request!.headers.get("x-api-key")).toBeNull();

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  expect(fetchRekaModels(unavailable)).rejects.toThrow("503");
});

test("the fixture is the body /v1/site/chat-models returns and parses whole", async () => {
  const body = await fixture();
  const parsed = RekaResponse.parse(body);
  expect(parsed.data.map((row) => row.id).sort()).toEqual([
    "deepseek4-flash", "deepseek41-flash", "glm5.3-flash", "qwen3.6-27b", "qwen3.8-27b", "reka-edge-2603", "reka-flash-3",
  ]);
  // Every row carries what the sync reads.
  for (const row of parsed.data) {
    expect(row.hugging_face_id).toBeDefined();
    expect(row.pricing).toBeDefined();
    expect(row.context_length).toBeGreaterThan(0);
  }
});

test("empty, duplicate and malformed lists fail before any catalog writes", () => {
  expect(() => RekaResponse.parse({ object: "list", data: [] })).toThrow("empty model list");
  expect(() => RekaResponse.parse({ object: "list", data: [model(), model()] })).toThrow("duplicate model IDs");
  expect(() => RekaResponse.parse({ object: "list", data: [model({ context_length: -1 })] })).toThrow();
  expect(() => RekaResponse.parse({ object: "list", data: [model({ pricing: { prompt: "1e-7", completion: "0" } as never })] }))
    .toThrow();
});

test("Hugging Face repos resolve to the lab entries", () => {
  expect(rekaBaseModel({ id: "glm5.3-flash", hugging_face_id: "zai-org/GLM-5.3-Flash" })).toBe("zhipuai/glm-5.3-flash");
  expect(rekaBaseModel({ id: "qwen3.6-27b", hugging_face_id: "Qwen/Qwen3.6-27B" })).toBe("alibaba/qwen3.6-27b");
  expect(rekaBaseModel({ id: "deepseek4-flash", hugging_face_id: "deepseek-ai/DeepSeek-V4-Flash-0731" }))
    .toBe("deepseek/deepseek-v4-flash-0731");
  expect(rekaBaseModel({ id: "deepseek41-flash", hugging_face_id: "deepseek-ai/DeepSeek-V4.1-Flash" }))
    .toBe("deepseek/deepseek-v4.1-flash");
  expect(rekaBaseModel({ id: "reka-flash-3", hugging_face_id: "RekaAI/reka-flash-3" })).toBe("rekaai/reka-flash-3");
  // The lab file carries the undated id.
  expect(rekaBaseModel({ id: "reka-edge-2603", hugging_face_id: "RekaAI/reka-edge-2603" })).toBe("rekaai/reka-edge");
  expect(rekaBaseModel({ id: "mystery", hugging_face_id: "example/unknown-chat" })).toBeUndefined();
  expect(rekaBaseModel({ id: "mystery" })).toBeUndefined();
});

test("reasoning controls follow the published efforts and are never invented", () => {
  // the whole OpenAI vocabulary, "none" = off: an effort option, no separate toggle
  const graded = rekaReasoningControls(model())!;
  expect(graded.reasoning).toBe(true);
  expect(graded.options).toEqual([{ type: "effort", values: [...ALL_EFFORTS] }]);
  expect(graded.header).toContain('"none" turns thinking off');
  // levels are written low to high whatever order the list arrives in
  expect(rekaReasoningControls(model({ reasoning_efforts: ["max", "low", "none"] }))!.options)
    .toEqual([{ type: "effort", values: ["none", "low", "max"] }]);
  // no "none": the levels alone, and the header says thinking cannot be switched off
  const alwaysOnGraded = rekaReasoningControls(model({ reasoning_efforts: ["low", "high", "max"] }))!;
  expect(alwaysOnGraded.options).toEqual([{ type: "effort", values: ["low", "high", "max"] }]);
  expect(alwaysOnGraded.header).toContain("cannot be switched off");
  // [] = always on, no caller control
  const alwaysOn = rekaReasoningControls(model({ reasoning_efforts: [] }))!;
  expect(alwaysOn.options).toEqual([]);
  expect(alwaysOn.header).toContain("Always on");
  // not a reasoner: reasoning false and no options
  expect(rekaReasoningControls(model({ supported_features: ["tools", "streaming"], reasoning_efforts: undefined })))
    .toEqual({ reasoning: false, options: undefined, header: "" });
  // a reasoner whose controls Reka has not published, or publishes with unknown values: unknown
  expect(rekaReasoningControls(model({ reasoning_efforts: undefined }))).toBeUndefined();
  expect(rekaReasoningControls(model({ reasoning_efforts: ["turbo"] }))).toBeUndefined();

  for (const source of [
    model({ id: "mystery", hugging_face_id: "example/unknown-chat" }),
    model({ reasoning_efforts: undefined }),
    model({ input_modalities: ["image"] }),
    // a lab reasoner Reka lists without reasoning is held for review, not written as a non-reasoner
    model({ supported_features: ["tools", "streaming"], reasoning_efforts: undefined }),
  ]) {
    expect(reka.translateModel(source, context)).toBeUndefined();
    expect(reka.missingModelID(source)).toBe(source.id);
  }
});

test("prices convert exactly, a zero cache read is no cache price, and both limits are the host's", () => {
  const translated = reka.translateModel(model(), context)!;
  expect(translated.model).toEqual({
    base_model: "zhipuai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    reasoning_options: [{ type: "effort", values: [...ALL_EFFORTS] }],
    interleaved: { field: "reasoning_content" },
    structured_output: true,
    cost: { input: 0.15, output: 0.5, cache_read: 0.015 },
    // The lab's 1,000,000 / 131,072 differ from the host's documented caps.
    limit: { context: 1_048_576, output: 1_048_576 },
    modalities: { input: ["text", "image"] },
  });
  expect(translated.v2Set).toEqual({
    "capabilities.cache": { implicit: true },
    "modalities.input": ["text", "image/jpeg", "image/png"],
  });
  expect(translated.header).toContain("takes no video or pdf");
  expect(translated.header).toContain("billed at cache.read");

  const unpriced = reka.translateModel(model({
    id: "reka-flash-3",
    name: "Reka Flash 3",
    hugging_face_id: "RekaAI/reka-flash-3",
    input_modalities: ["text"],
    context_length: 65_536,
    max_output_length: 65_536,
    pricing: { prompt: "0.0000001", completion: "0.0000002", image: "0", request: "0", input_cache_read: "0" },
    supported_features: ["structured_outputs", "reasoning", "streaming"],
    reasoning_efforts: [],
  }), context)!;
  expect(unpriced.model).toEqual({
    base_model: "rekaai/reka-flash-3",
    reasoning_options: [],
    interleaved: { field: "reasoning_content" },
    structured_output: true,
    cost: { input: 0.1, output: 0.2 },
    // The lab's 58,982 is OpenRouter's 90% figure; Reka documents the full window.
    limit: { output: 65_536 },
  });
  expect(unpriced.v2Set).toBeUndefined();
  expect(unpriced.header).not.toContain("Cache:");

  // An authored cache kind is kept rather than overwritten.
  const authored = reka.translateModel(model(), {
    ...context,
    v2: () => ({ capabilities: { cache: { implicit: { note: "authored" } } } }),
  })!;
  expect(authored.v2Set).not.toHaveProperty("capabilities.cache");

  // Hand-authored facts the list cannot carry ride along from the file's own values.
  const enriched = reka.translateModel(model(), {
    ...context,
    authored: () => ({
      base_model: "zhipuai/glm-5.3-flash",
      description: "Served by Reka with a 1M window.",
      knowledge: "2026-04",
      release_date: "2026-06-01",
      last_updated: "2026-07-01",
      status: "beta",
    }) as never,
  })!;
  expect(enriched.model).toMatchObject({
    description: "Served by Reka with a 1M window.",
    knowledge: "2026-04",
    release_date: "2026-06-01",
    last_updated: "2026-07-01",
    status: "beta",
  });
});

test("the published list generates the provider, prices follow the list, and a retired model's file goes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-reka-sync-"));
  const modelsDir = path.join(root, "providers/reka/models");
  await mkdir(modelsDir, { recursive: true });
  for (const lab of [
    "alibaba/qwen3.6-27b", "alibaba/qwen3.8-27b", "deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4.1-flash",
    "zhipuai/glm-5.3-flash", "rekaai/reka-flash-3", "rekaai/reka-edge",
  ]) {
    await mkdir(path.join(root, "models", path.dirname(lab)), { recursive: true });
    await copyFile(path.join(ROOT, `models/${lab}.toml`), path.join(root, `models/${lab}.toml`));
  }
  await copyFile(path.join(ROOT, "providers/reka/provider.toml"), path.join(root, "providers/reka/provider.toml"));

  let body = await fixture();
  const provider = { ...reka, modelsDir, fetchModels: async () => body };
  const first = await syncProvider(provider, { openIssues: false });
  expect(first.created).toBe(7);

  const generated = (await generate(path.join(root, "providers"))).reka!.models;
  expect(Object.keys(generated).sort()).toEqual(body.data.map((row) => row.id).sort());
  const glm = generated["glm5.3-flash"]!;
  expect(glm.cost).toEqual({ input: 0.15, output: 0.5, cache_read: 0.015 });
  expect(glm.limit).toEqual({ context: 1_048_576, output: 1_048_576 });
  expect(glm.reasoning_options).toEqual([{ type: "effort", values: [...ALL_EFFORTS] }]);
  expect(glm.modalities.input).toEqual(["text", "image"]);
  const flash3 = generated["reka-flash-3"]!;
  expect(flash3.reasoning_options).toEqual([]);
  expect(flash3.tool_call).toBe(false);
  expect(flash3.cost).toEqual({ input: 0.1, output: 0.2 });
  const edge = generated["reka-edge-2603"]!;
  expect(edge.reasoning).toBe(false);
  expect(edge.name).toBe("Reka Edge 2603");
  // Output is Reka's documented cap, not the lab's.
  expect(generated["deepseek4-flash"]!.limit).toEqual({ context: 262_144, output: 131_072 });
  expect(generated["qwen3.6-27b"]!.limit).toEqual({ context: 262_144, output: 32_768 });
  expect(generated["qwen3.6-27b"]!.modalities.input).toEqual(["text"]);

  const second = await syncProvider(provider, { openIssues: false });
  expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 7 });

  // A price change on the list lands in the file; everything else stays, including
  // hand-authored facts the list cannot carry (a knowledge cutoff, a description).
  const file = Bun.file(path.join(modelsDir, "glm5.3-flash.toml"));
  const authoredText = (await file.text()).replace(
    "\nschema = 2\n",
    "\nschema = 2\nknowledge = \"2026-04\"\ndescription = \"Served by Reka with a 1M window.\"\n",
  );
  await Bun.write(file, authoredText);
  body = {
    ...body,
    data: body.data.map((row) => row.id === "glm5.3-flash"
      ? { ...row, pricing: { ...row.pricing!, prompt: "0.0000002" } }
      : row),
  };
  expect((await syncProvider(provider, { openIssues: false })).updated).toBe(1);
  const updated = Bun.TOML.parse(await file.text()) as Record<string, any>;
  expect(updated.cost.text.input.price).toBe(0.2);
  expect(updated.capabilities.cache).toEqual({ implicit: true });
  expect(updated.knowledge).toBe("2026-04");
  expect(updated.description).toBe("Served by Reka with a 1M window.");

  // A model gone from the list is retired here too; an empty list never deletes.
  body = { ...body, data: body.data.filter((row) => row.id !== "qwen3.6-27b") };
  expect((await syncProvider(provider, { openIssues: false })).deleted).toBe(1);
  expect(await Bun.file(path.join(modelsDir, "qwen3.6-27b.toml")).exists()).toBe(false);
  body = { ...body, data: [] };
  expect(syncProvider(provider, { openIssues: false })).rejects.toThrow("empty model list");
  expect(await file.exists()).toBe(true);
});
