import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import { fetchVultrModels, vultr, VultrResponse, type VultrModel } from "../src/sync/providers/vultr.js";

const REPO = path.join(import.meta.dirname, "../../..");

function model(overrides: Partial<VultrModel> = {}, prices = { prompt: "0.0000001", completion: "0.00000035" }): VultrModel {
  return {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash",
    input_modalities: [
      {
        type: "text",
        supported_inputs: { max_context_length: { value: 1_048_576, unit: "token" } },
        pricing: [{ type: "prompt", unit: "token", cost_usd: prices.prompt }],
      },
      { type: "image", supported_inputs: {} },
      { type: "file", supported_inputs: {} },
    ],
    output_modalities: [{
      type: "text",
      supported_parameters: {
        tools: { type: "boolean" },
        structured_outputs: { type: "boolean" },
        response_format: { type: "object", properties: { type: { type: "enum", values: ["text", "json_object", "json_schema"] } } },
      },
      pricing: [{ type: "completion", unit: "token", cost_usd: prices.completion }],
    }],
    reasoning: {
      mandatory: false,
      supported_efforts: ["ultra", "max", "xhigh", "high", "medium", "low", "minimal"],
    },
    ...overrides,
  };
}

const speech: VultrModel = {
  id: "qwen3-tts-12hz-1.7b",
  input_modalities: [{ type: "text", supported_inputs: {} }],
  output_modalities: [{ type: "speech", pricing: [{ type: "completion", unit: "second", cost_usd: "0.0002" }] }],
};

const FILE = [
  "# Image and video formats: GET https://api.vultrinference.com/v1/models input_modalities[].supported_inputs.formats (2026-10-21)",
  "schema = 2",
  'base_model = "zhipuai/glm-5.3-flash"',
  "",
  "[modalities]",
  'input = ["text", "image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"]',
  'output = ["text"]',
  "",
  "[capabilities]",
  'reasoning = { supported = true, effort = ["low", "high", "max"] }',
  "structured_output = true",
  "",
  "[limit]",
  "context = 1_048_576",
  "",
  "[cost.text.input]",
  "price = 0.1",
  "",
  "[cost.text.output]",
  "price = 0.35",
  "",
].join("\n");

async function fixture(text = FILE) {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-vultr-sync-"));
  const modelsDir = path.join(root, "providers/vultr/models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models/zhipuai"), { recursive: true });
  await copyFile(path.join(REPO, "models/zhipuai/glm-5.3-flash.toml"), path.join(root, "models/zhipuai/glm-5.3-flash.toml"));
  await copyFile(path.join(REPO, "providers/vultr/provider.toml"), path.join(root, "providers/vultr/provider.toml"));
  const file = Bun.file(path.join(modelsDir, "glm-5.3-flash.toml"));
  await Bun.write(file, text);
  return { root, modelsDir, file };
}

test("Vultr is registered for scheduled sync and fetches its public catalog without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === vultr.id)).toBe(true);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ data: [model()] });
  }) as unknown as typeof fetch;
  await fetchVultrModels(fetcher);
  expect(request!.url).toBe("https://api.vultrinference.com/v1/models");
  expect(request!.headers.get("authorization")).toBeNull();

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  expect(fetchVultrModels(unavailable)).rejects.toThrow("503");
});

test("empty, duplicate and malformed catalogs fail before any writes", () => {
  expect(() => VultrResponse.parse({ data: [] })).toThrow("empty catalog");
  expect(() => VultrResponse.parse({ data: [model(), model()] })).toThrow("duplicate model IDs");
  expect(() => VultrResponse.parse({ data: [model({}, { prompt: "", completion: "0.1" })] })).toThrow();
});

test("new models take the lab's reasoning controls, with an off switch as reasoning.enabled", async () => {
  const { root, modelsDir } = await fixture();
  // The repository's lab and provider entries are the sources:
  // xiaomi/mimo-v2.6-flash (toggle only) and OpenRouter's DeepSeek V4.1 Flash
  // 1017 (none, low, high, max).
  const data = [
    model({ id: "mimo-v2.6-flash" }, { prompt: "0.0000001", completion: "0.00000025" }),
    model({ id: "deepseek-v4.1-flash-1017" }, { prompt: "0.00000015", completion: "0.0000006" }),
    model({ id: "glm-5.3-flash" }),
  ];
  for (const lab of ["xiaomi/mimo-v2.6-flash", "deepseek/deepseek-v4.1-flash-1017"]) {
    await mkdir(path.join(root, "models", path.dirname(lab)), { recursive: true });
    await copyFile(path.join(REPO, "models", `${lab}.toml`), path.join(root, "models", `${lab}.toml`));
  }
  const provider = { ...vultr, modelsDir, fetchModels: async () => ({ data }) };
  try {
    expect(await syncProvider(provider, { openIssues: false })).toMatchObject({ created: 2, updated: 0, deleted: 0 });

    const mimoText = await Bun.file(path.join(modelsDir, "mimo-v2.6-flash.toml")).text();
    expect(mimoText).toStartWith("# Toggle: reasoning.enabled = true|false\n# Reasoning levels: providers/xiaomi/models/mimo-v2.6-flash.toml");
    const mimo = Bun.TOML.parse(mimoText) as Record<string, any>;
    expect(mimo.base_model).toBe("xiaomi/mimo-v2.6-flash");
    expect(mimo.release_date).toBeUndefined();
    expect(mimo.modalities).toBeUndefined();
    expect(mimo.capabilities).toEqual({ reasoning: { supported: true, toggle: true }, structured_output: true });
    expect(mimo.cost.text).toEqual({ input: { price: 0.1 }, output: { price: 0.25 } });

    const deepseekText = await Bun.file(path.join(modelsDir, "deepseek-v4.1-flash-1017.toml")).text();
    expect(deepseekText).toContain("# Effort: reasoning_effort = low|high|max\n");
    const deepseek = Bun.TOML.parse(deepseekText) as Record<string, any>;
    expect(deepseek.capabilities.reasoning).toEqual({ supported: true, toggle: true, effort: ["low", "high", "max"] });

    expect((await syncProvider(provider, { openIssues: false })).unchanged).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new models are not created when Vultr can't serve the lab's controls", async () => {
  const { root, modelsDir } = await fixture();
  const cases: Array<[VultrModel, string]> = [
    [model({ id: "minimax-m3.1-flash", reasoning: { mandatory: false, supported_efforts: ["low", "high"] } }), "doesn't accept"],
    [model({ id: "minimax-m3.1-flash", reasoning: null }), "no reasoning metadata"],
  ];
  try {
    for (const [source, reason] of cases) {
      const provider = { ...vultr, modelsDir, fetchModels: async () => ({ data: [source, model()] }) };
      const result = await syncProvider(provider, { openIssues: false });
      expect(result.created).toBe(0);
      expect(result.notices.find((notice) => notice.startsWith("minimax-m3.1-flash:"))).toContain(reason);
      expect(await Bun.file(path.join(modelsDir, "minimax-m3.1-flash.toml")).exists()).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prices and context update in place; controls, MIME lists and unknown models are left alone; retired models are removed", async () => {
  const { root, modelsDir, file } = await fixture();
  let data: VultrModel[] = [model(), speech];
  const provider = { ...vultr, modelsDir, fetchModels: async () => ({ data }) };
  try {
    expect(await syncProvider(provider, { openIssues: false })).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 1 });
    expect(await file.text()).toBe(FILE);

    data = [
      model({
        input_modalities: [{
          type: "text",
          supported_inputs: { max_context_length: { value: 524_288, unit: "token" } },
          pricing: [{ type: "prompt", unit: "token", cost_usd: "0.00000012" }],
        }],
      }, { prompt: "0.00000012", completion: "0.0000004" }),
      model({ id: "example-unknown-chat" }),
      speech,
    ];
    const result = await syncProvider(provider, { openIssues: false });
    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect(result.notices.join("\n")).toContain("example-unknown-chat: no lab model matches");
    expect(await Bun.file(path.join(modelsDir, "example-unknown-chat.toml")).exists()).toBe(false);
    expect(await Bun.file(path.join(modelsDir, "qwen3-tts-12hz-1.7b.toml")).exists()).toBe(false);

    const text = await file.text();
    expect(text.startsWith("# Image and video formats:")).toBe(true);
    const updated = Bun.TOML.parse(text) as Record<string, any>;
    expect(updated.base_model).toBe("zhipuai/glm-5.3-flash");
    expect(updated.cost.text).toEqual({ input: { price: 0.12 }, output: { price: 0.4 } });
    expect(updated.limit).toEqual({ context: 524_288 });
    expect(updated.modalities.input).toEqual(["text", "image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"]);
    expect(updated.capabilities).toEqual({
      reasoning: { supported: true, effort: ["low", "high", "max"] },
      structured_output: true,
    });

    // Vultr reroutes a retired ID to another model, so it is removed.
    data = [speech];
    expect((await syncProvider(provider, { openIssues: false })).deleted).toBe(1);
    expect(await file.exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reasoning metadata that contradicts the authored controls leaves the file unchanged", async () => {
  const toggle = FILE.replace(
    'reasoning = { supported = true, effort = ["low", "high", "max"] }',
    'reasoning = { supported = true, toggle = true, effort = ["low", "high", "max"] }',
  ).replace("schema = 2", "# Toggle: reasoning.enabled = true|false\nschema = 2");
  const { root, modelsDir, file } = await fixture(toggle);
  const cheaper = { prompt: "0.00000005", completion: "0.0000002" };
  const cases: VultrModel[] = [
    model({ reasoning: null }, cheaper),
    model({ reasoning: { mandatory: true, supported_efforts: ["low", "high", "max"] } }, cheaper),
    model({ reasoning: { mandatory: false, supported_efforts: ["low", "high"] } }, cheaper),
    model({}, { prompt: "0.00000005", completion: "0.0000002" }),
  ];
  cases[3]!.output_modalities[0]!.pricing = [{ type: "completion", unit: "second", cost_usd: "0.0002" }];
  try {
    for (const source of cases) {
      const provider = { ...vultr, modelsDir, fetchModels: async () => ({ data: [source] }) };
      const result = await syncProvider(provider, { openIssues: false });
      expect(result).toMatchObject({ updated: 0, deleted: 0 });
      expect(result.notices.some((notice) => notice.startsWith("glm-5.3-flash:"))).toBe(true);
      expect(await file.text()).toBe(toggle);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
