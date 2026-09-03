import { expect, test } from "bun:test";

import {
  buildNeosantaraModel,
  meetsNeosantaraPublicFilter,
  neosantara,
  neosantaraReasoningControls,
  neosantaraReasoningHeader,
  NeosantaraCatalogResponse,
  resolveNeosantaraBaseModel,
  shouldSyncNeosantaraModel,
} from "../src/sync/providers/neosantara.js";

// A /v1/catalog response in the models.dev / LLM Gateway shape the backend now emits.
const catalogResponse = {
  data: [
    {
      id: "gemini-3.7-flash",
      name: "gemini-3.7-flash",
      display_name: "Neosantara: Gemini 3.7 Flash",
      created: 1_700_000_000,
      description: "Fast reasoning model",
      family: "google",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      context_length: 1_000_000,
      pricing: {
        prompt: "0.000001500000",
        completion: "0.000006000000",
        internal_reasoning: "0",
        input_cache_read: "0.000000150000",
        input_cache_write: "0.000001500000",
      },
      supported_parameters: ["temperature", "tools", "tool_choice", "response_format", "reasoning"],
      structured_outputs: true,
      providers: [
        {
          providerId: "neosantara",
          vision: true,
          tools: true,
          reasoning: true,
          reasoning_efforts: ["none", "low", "medium", "high"],
        },
      ],
      deprecated: false,
    },
    {
      id: "gpt-oss-20b",
      name: "gpt-oss-20b",
      display_name: "Neosantara: Gpt Oss 20b",
      created: 1_700_000_000,
      description: "Open model, no reasoning on this host",
      family: "openai",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      context_length: 131_072,
      pricing: { prompt: "0.000000020000", completion: "0.000000080000" },
      supported_parameters: ["temperature", "tools", "tool_choice"],
      structured_outputs: true,
      providers: [{ providerId: "neosantara", vision: false, tools: true, reasoning: false }],
      deprecated: false,
    },
    {
      id: "glm-4.7-flash",
      name: "glm-4.7-flash",
      display_name: "Neosantara: Glm 4.7 Flash",
      created: 1_700_000_000,
      description: "Free reasoning model",
      family: "zhipuai",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      context_length: 1_000_000,
      pricing: { prompt: "0.000000000000", completion: "0.000000000000" },
      supported_parameters: ["temperature", "tools", "reasoning"],
      structured_outputs: false,
      providers: [{ providerId: "neosantara", vision: false, tools: true, reasoning: true, reasoning_efforts: ["none"] }],
      deprecated: false,
    },
    {
      id: "too-small",
      name: "too-small",
      display_name: "Neosantara: Too Small",
      created: 1_700_000_000,
      description: "Below the context floor",
      family: "openai",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      context_length: 32_000,
      pricing: { prompt: "0.000001000000", completion: "0.000002000000" },
      supported_parameters: ["tools"],
      structured_outputs: false,
      providers: [{ providerId: "neosantara", vision: false, tools: true, reasoning: false }],
      deprecated: false,
    },
    {
      id: "no-tools",
      name: "no-tools",
      display_name: "Neosantara: No Tools",
      created: 1_700_000_000,
      description: "No function calling",
      family: "openai",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      context_length: 128_000,
      pricing: { prompt: "0.000001000000", completion: "0.000002000000" },
      supported_parameters: [],
      structured_outputs: false,
      providers: [{ providerId: "neosantara", vision: false, tools: false, reasoning: false }],
      deprecated: false,
    },
  ],
};

test("parses the single /v1/catalog endpoint", () => {
  const parsed = NeosantaraCatalogResponse.parse(catalogResponse);
  expect(parsed.data).toHaveLength(5);
  expect(parsed.data[0]?.providers[0]?.reasoning_efforts).toEqual(["none", "low", "medium", "high"]);
});

test("filters to 100k+ context, function calling, image models, and known base models", () => {
  const [gemini, oss, glm, tooSmall, noTools] = NeosantaraCatalogResponse.parse(catalogResponse).data;

  expect(meetsNeosantaraPublicFilter(gemini!)).toBe(true);
  expect(meetsNeosantaraPublicFilter(oss!)).toBe(true);
  expect(meetsNeosantaraPublicFilter(glm!)).toBe(true);
  expect(meetsNeosantaraPublicFilter(tooSmall!)).toBe(false); // < 100k context
  expect(meetsNeosantaraPublicFilter(noTools!)).toBe(false); // no function calling

  expect(shouldSyncNeosantaraModel(gemini!)).toBe(true);
  expect(shouldSyncNeosantaraModel(tooSmall!)).toBe(false);
  expect(shouldSyncNeosantaraModel(noTools!)).toBe(false);

  expect(resolveNeosantaraBaseModel("gemini-3.7-flash")).toBe("google/gemini-3.7-flash");
  expect(resolveNeosantaraBaseModel("claude-4.5-sonnet")).toBe("anthropic/claude-sonnet-4-5");
  expect(resolveNeosantaraBaseModel("grok-code-fast")).toBe("xai/grok-4.3");
  expect(resolveNeosantaraBaseModel("definitely-not-a-model")).toBeUndefined();
});

test("builds override-only models with per-million USD cost and host reasoning controls", () => {
  const [gemini] = NeosantaraCatalogResponse.parse(catalogResponse).data;
  const built = buildNeosantaraModel(gemini!, undefined);

  expect(built).toMatchObject({
    base_model: "google/gemini-3.7-flash",
    // Efforts advertised by the catalog are honored (intersected with the host enum).
    reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high"] }],
    interleaved: { field: "reasoning_content" },
    limit: { context: 1_000_000 },
    cost: { input: 1.5, output: 6, cache_read: 0.15, cache_write: 1.5 },
  });
  // internal_reasoning "0" is unknown, not a published zero.
  expect((built as { cost?: { reasoning?: number } }).cost?.reasoning).toBeUndefined();
  // The gateway omits max_output; never author a model output limit from a runtime cap.
  expect((built as { limit?: { output?: number } }).limit?.output).toBeUndefined();
});

test("keeps a free model's zero token price instead of skipping it", () => {
  const glm = NeosantaraCatalogResponse.parse(catalogResponse).data.find((m) => m.id === "glm-4.7-flash")!;
  expect(shouldSyncNeosantaraModel(glm)).toBe(true);

  const built = buildNeosantaraModel(glm, undefined);
  expect(built.cost).toMatchObject({ input: 0, output: 0 });
  // reasoning matches the base (factored out), but its effort controls are still authored.
  expect(built.reasoning_options).toBeDefined();
});

test("a non-reasoning model carries no reasoning controls, interleaved, or note", () => {
  const oss = NeosantaraCatalogResponse.parse(catalogResponse).data.find((m) => m.id === "gpt-oss-20b")!;
  const built = buildNeosantaraModel(oss, undefined);

  expect(built.reasoning).toBe(false);
  expect(built.reasoning_options).toBeUndefined();
  expect(built.interleaved).toBeUndefined();

  const translated = neosantara.translateModel(oss, {
    existing: () => undefined,
    authored: () => undefined,
  });
  expect(translated?.header ?? "").not.toContain("reasoning_effort");
});

test("maps catalog efforts to toggle / effort / always-on (llmgateway convention)", () => {
  // Graded levels within the host enum (max included) -> effort, verbatim.
  expect(
    neosantaraReasoningControls({ providers: [{ reasoning: true, reasoning_efforts: ["low", "high", "max"] }] } as never),
  ).toEqual([{ type: "effort", values: ["low", "high", "max"] }]);

  // Exactly ["none"] -> on/off toggle.
  expect(
    neosantaraReasoningControls({ providers: [{ reasoning: true, reasoning_efforts: ["none"] }] } as never),
  ).toEqual([{ type: "toggle" }]);

  // [] -> always-on (reasons, no caller control).
  expect(
    neosantaraReasoningControls({ providers: [{ reasoning: true, reasoning_efforts: [] }] } as never),
  ).toEqual([]);

  // Values outside the host enum are dropped.
  expect(
    neosantaraReasoningControls({ providers: [{ reasoning: true, reasoning_efforts: ["low", "bogus"] }] } as never),
  ).toEqual([{ type: "effort", values: ["low"] }]);
});

test("skips a reasoning model whose effort surface is unknown (missing != always-on)", () => {
  const source = NeosantaraCatalogResponse.parse(catalogResponse).data[0]!;
  // Reasoning model with a real surface syncs.
  expect(shouldSyncNeosantaraModel(source)).toBe(true);

  // Same model but the catalog omits reasoning_efforts -> unknown -> skipped and reported,
  // never stamped as always-on `[]`.
  const unknown = { ...source, providers: [{ ...source.providers[0], reasoning_efforts: undefined }] };
  const parsed = NeosantaraCatalogResponse.parse({ data: [unknown] }).data[0]!;
  expect(shouldSyncNeosantaraModel(parsed)).toBe(false);
  expect(neosantara.sourceID(parsed)).toBe(parsed.id);

  // Explicit [] is different: it is an affirmative always-on set and still syncs.
  const alwaysOn = { ...source, providers: [{ ...source.providers[0], reasoning_efforts: [] }] };
  const parsedAlwaysOn = NeosantaraCatalogResponse.parse({ data: [alwaysOn] }).data[0]!;
  expect(shouldSyncNeosantaraModel(parsedAlwaysOn)).toBe(true);
  expect(buildNeosantaraModel(parsedAlwaysOn, undefined).reasoning_options).toEqual([]);
});

test("toggle models carry a wire-comment header; effort models carry none", () => {
  const models = NeosantaraCatalogResponse.parse(catalogResponse).data;
  const ctx = { existing: () => undefined, authored: () => undefined };

  // glm-4.7-flash advertises ["none"] -> toggle -> header names the wire field.
  const toggle = neosantara.translateModel(models.find((m) => m.id === "glm-4.7-flash")!, ctx);
  expect(toggle?.header).toContain("reasoning_effort");
  expect(toggle?.header).toContain("Toggle");

  // gemini-3.7-flash advertises graded effort -> no toggle header.
  const effort = neosantara.translateModel(models[0]!, ctx);
  expect(effort?.header ?? "").not.toContain("Toggle");
});

test("syncs image-generation models on per-image pricing without token cost", () => {
  const image = {
    id: "gpt-image-2",
    name: "gpt-image-2",
    display_name: "Neosantara: Gpt Image 2",
    created: 1_700_000_000,
    description: "Image generation",
    family: "openai",
    architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    context_length: 0,
    pricing: {},
    supported_parameters: [],
    structured_outputs: false,
    providers: [{ providerId: "neosantara", vision: false, tools: false, reasoning: false }],
    deprecated: false,
  };
  const parsed = NeosantaraCatalogResponse.parse({ data: [image] }).data[0]!;

  expect(shouldSyncNeosantaraModel(parsed)).toBe(true);
  const built = buildNeosantaraModel(parsed, undefined);
  expect("base_model" in built && built.base_model).toBe("openai/gpt-image-2");
  expect(built.cost).toBeUndefined();
  expect(built.reasoning_options).toBeUndefined();
  // No limit.context = 0 authored for a context-less image model.
  expect((built as { limit?: { context?: number } }).limit?.context).toBeUndefined();
});

test("filters deprecated models and reports unmapped ids as skipped", () => {
  const deprecated = { ...catalogResponse.data[0]!, deprecated: true };
  expect(shouldSyncNeosantaraModel(NeosantaraCatalogResponse.parse({ data: [deprecated] }).data[0]!)).toBe(false);

  const unmapped = { ...catalogResponse.data[0]!, id: "not-in-the-canonical-tree" };
  const parsed = NeosantaraCatalogResponse.parse({ data: [unmapped] }).data[0]!;
  expect(shouldSyncNeosantaraModel(parsed)).toBe(false);
  expect(neosantara.sourceID(parsed)).toBe("not-in-the-canonical-tree");

  const notice = neosantara.skippedNotice(["not-in-the-canonical-tree"]);
  expect(notice.join("\n")).toContain("not-in-the-canonical-tree");
  expect(neosantara.skippedNotice([])).toEqual([]);
});

test("an empty catalog is fatal rather than wiping every model", () => {
  expect(() => neosantara.parseModels({ data: [] })).toThrow();
});
