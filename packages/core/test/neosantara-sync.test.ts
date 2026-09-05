import { expect, test } from "bun:test";

import {
  buildNeosantaraModel,
  deploymentModalities,
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
  expect(
    resolveNeosantaraBaseModel({ id: "claude-4.5-sonnet", base_model: "anthropic/claude-sonnet-4-5" } as never),
  ).toBe("anthropic/claude-sonnet-4-5");
  expect(
    resolveNeosantaraBaseModel({ id: "grok-code-fast", base_model: "xai/grok-4.3" } as never),
  ).toBe("xai/grok-4.3");
  expect(
    resolveNeosantaraBaseModel({ id: "gemini-3.7-flash", base_model: "google/nonexistent-model" } as never),
  ).toBe("google/gemini-3.7-flash");
  expect(
    resolveNeosantaraBaseModel({ id: "unknown-id", base_model: "nonexistent/fake-model" } as never),
  ).toBeUndefined();
  expect(resolveNeosantaraBaseModel("definitely-not-a-model")).toBeUndefined();
});

test("builds override-only models with per-million USD cost and host reasoning controls", () => {
  const [gemini] = NeosantaraCatalogResponse.parse(catalogResponse).data;
  const built = buildNeosantaraModel(gemini!, undefined);

  expect(built).toMatchObject({
    base_model: "google/gemini-3.7-flash",
    // The catalog's per-model reasoning_efforts are copied verbatim (host resolves them from the
    // model's lab entry), intersected with the host enum.
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

test("copies the catalog's per-model reasoning surface verbatim (llmgateway convention)", () => {
  const ctl = (efforts) =>
    neosantaraReasoningControls({ providers: [{ reasoning: true, reasoning_efforts: efforts }] } as never);

  // Exactly ["none"] -> on/off toggle.
  expect(ctl(["none"])).toEqual([{ type: "toggle" }]);
  // [] -> always-on (reasons, no caller control).
  expect(ctl([])).toEqual([]);
  // Graded levels are copied verbatim (the host resolved them from the model's lab entry),
  // intersected with the host enum; out-of-enum values are dropped.
  expect(ctl(["minimal", "low", "medium", "high"])).toEqual([
    { type: "effort", values: ["minimal", "low", "medium", "high"] },
  ]);
  expect(ctl(["none", "high", "max"])).toEqual([{ type: "effort", values: ["none", "high", "max"] }]);
  expect(ctl(["low", "high", "max", "bogus"])).toEqual([{ type: "effort", values: ["low", "high", "max"] }]);

  // Graded levels with "none" author only effort with "none" in values, without toggle.
  expect(
    neosantaraReasoningControls({
      providers: [{ reasoning: true, reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] }],
    } as never),
  ).toEqual([
    { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
  ]);

  expect(
    neosantaraReasoningControls({
      providers: [{ reasoning: true, reasoning_efforts: ["none", "low", "high", "max"] }],
    } as never),
  ).toEqual([
    { type: "effort", values: ["none", "low", "high", "max"] },
  ]);

  // Toggle is driven only by the catalog (has_toggle / ["none"]), not re-inferred from prior TOMLs.
  expect(
    neosantaraReasoningControls(
      {
        providers: [{ reasoning: true, reasoning_efforts: ["low", "high", "max"] }],
      } as never,
      { reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }] } as never,
    ),
  ).toEqual([{ type: "effort", values: ["low", "high", "max"] }]);
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

test("toggle models carry a wire-comment header; effort models carry effort docs; text-only deployments document limitations", () => {
  const models = NeosantaraCatalogResponse.parse(catalogResponse).data;
  const ctx = { existing: () => undefined, authored: () => undefined };

  // glm-4.7-flash advertises ["none"] -> toggle -> header names the wire field.
  const toggle = neosantara.translateModel(models.find((m) => m.id === "glm-4.7-flash")!, ctx);
  expect(toggle?.header).toContain("reasoning_effort");
  expect(toggle?.header).toContain("Toggle");
  expect(toggle?.header).toContain("https://docs.neosantara.xyz/en/capability/reasoning");

  // gemini-3.7-flash advertises graded effort -> effort header citing docs, no toggle.
  const effort = neosantara.translateModel(models[0]!, ctx);
  expect(effort?.header ?? "").not.toContain("Toggle");
  expect(effort?.header ?? "").toContain("https://docs.neosantara.xyz/en/capability/reasoning");

  // minimax-m2.7 documents always-on reasoning.
  expect(neosantaraReasoningHeader([], "minimax-m2.7")).toContain("Always-on thinking");
  // kimi-k2-thinking documents dedicated thinking variant.
  expect(neosantaraReasoningHeader([], "kimi-k2-thinking")).toContain("Dedicated thinking variant");
  // muse-glimmer-30b documents external baseline sources.
  expect(neosantaraReasoningHeader([{ type: "effort", values: ["low"] as never }], "muse-glimmer-30b")).toContain(
    "https://huggingface.co/meta-models/Muse-Glimmer-30B",
  );
  // gpt-5.6-luna / sol document text-only deployment limitation and effort surface.
  expect(neosantaraReasoningHeader([{ type: "effort", values: ["none", "low"] as never }], "gpt-5.6-luna")).toContain(
    "upstream Kiro backend ignores image/multimodal input",
  );
  expect(neosantaraReasoningHeader([{ type: "effort", values: ["none", "low"] as never }], "gpt-5.6-sol")).toContain(
    "upstream Kiro backend ignores image/multimodal input",
  );
  // mistral text-only deployments document limitation.
  expect(neosantaraReasoningHeader(undefined, "mistral-small-latest")).toContain("text-only deployment on this host");
  // Claude effort models cite reasoning_effort = none off control and docs.
  expect(
    neosantaraReasoningHeader(
      [{ type: "effort", values: ["none", "low", "medium", "high", "max"] as never }],
      "claude-opus-4-6",
    ),
  ).toContain('reasoning_effort = "none" turns thinking off');
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

test("deploymentModalities strips non-text inputs when vision is false and preserves otherwise", () => {
  const multimodal = {
    architecture: {
      input_modalities: ["text", "image", "video", "pdf"],
      output_modalities: ["text"],
    },
  } as never;

  expect(deploymentModalities(multimodal, false)).toEqual({
    input: ["text"],
    output: ["text"],
  });

  expect(deploymentModalities(multimodal, true)).toEqual({
    input: ["text", "image", "video", "pdf"],
    output: ["text"],
  });

  expect(deploymentModalities(multimodal, undefined)).toEqual({
    input: ["text", "image", "video", "pdf"],
    output: ["text"],
  });
});

test("enforces text-only input and attachment=false when vision is false on multimodal base model", () => {
  const model = {
    id: "kimi-k3",
    context_length: 1_048_576,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000003000000", completion: "0.000015000000" },
    providers: [{ providerId: "neosantara", vision: false, tools: true, reasoning: false }],
  } as never;

  const built = buildNeosantaraModel(model, undefined);
  // moonshotai/kimi-k3 base model has attachment=true and input=["text", "image", "video"].
  // Because vision is false on this host, attachment must be false AND input must be overridden to ["text"].
  expect(built).toMatchObject({
    base_model: "moonshotai/kimi-k3",
    attachment: false,
    modalities: { input: ["text"] },
  });
  // tool_call is true in both host and base model; factored out
  expect("tool_call" in built).toBe(false);
});

test("emits narrower modalities when host deployment does not support pdf/video", () => {
  const model = {
    id: "claude-4.5-opus",
    base_model: "anthropic/claude-opus-4-5",
    context_length: 200_000,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    pricing: { prompt: "0.000005000000", completion: "0.000025000000" },
    providers: [{ providerId: "neosantara", vision: true, tools: true, reasoning: false }],
  } as never;

  const built = buildNeosantaraModel(model, undefined);
  // anthropic/claude-opus-4-5 base model has attachment=true and input=["text", "image", "pdf"].
  // Because vision is true, attachment is true matching base and factored out.
  // Because host deployment only serves text+image (not pdf), narrower input modalities are authored.
  expect("attachment" in built).toBe(false);
  expect(built.modalities).toEqual({ input: ["text", "image"] });
});

test("omits modalities when host input modalities match base model", () => {
  const model = {
    id: "claude-4.5-opus",
    base_model: "anthropic/claude-opus-4-5",
    context_length: 200_000,
    architecture: { input_modalities: ["text", "image", "pdf"], output_modalities: ["text"] },
    pricing: { prompt: "0.000005000000", completion: "0.000025000000" },
    providers: [{ providerId: "neosantara", vision: true, tools: true, reasoning: false }],
  } as never;

  const built = buildNeosantaraModel(model, undefined);
  expect("attachment" in built).toBe(false);
  expect("modalities" in built).toBe(false);
});

