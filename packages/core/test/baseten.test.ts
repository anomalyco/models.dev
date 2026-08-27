import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { preserveReasoningOptions, syncProvider } from "../src/sync/index.js";
import {
  baseten,
  buildBasetenModel,
  type BasetenModel,
} from "../src/sync/providers/baseten.js";

for (const existing of [undefined, { reasoning_options: [] }]) {
  test(`tracks GLM 5.3 Flash effort when ${existing ? "repairing empty options" : "creating a model"}`, () => {
    const built = buildBasetenModel(
      basetenModel({ id: "zai-org/GLM-5.3-Flash", name: "GLM 5.3 Flash" }),
      existing,
      "zhipuai/glm-5.3-flash",
    );

    expect(preserveReasoningOptions(built, existing, true).reasoning_options).toEqual([
      { type: "effort", values: ["low", "high", "max"] },
    ]);
    expect(built.interleaved).toEqual({ field: "reasoning_content" });
  });
}

test("preserves authored reasoning controls for other Baseten models", () => {
  for (const reasoning_options of [[], [{ type: "effort" as const, values: ["high" as const, "max" as const] }]]) {
    const existing = { reasoning_options, interleaved: { field: "reasoning_content" as const } };
    const built = buildBasetenModel(basetenModel(), existing, "deepseek/deepseek-v4-flash-0731");

    expect(built.reasoning_options).toEqual(reasoning_options);
    expect(built.interleaved).toEqual(existing.interleaved);
  }
});

test("writes GLM 5.3 Flash controls and source, then syncs without changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-baseten-"));
  try {
    const modelsDir = path.join(root, "providers/baseten/models");
    await mkdir(modelsDir, { recursive: true });
    await mkdir(path.join(root, "models/zhipuai"), { recursive: true });
    await copyFile(
      path.join(import.meta.dirname, "../../../models/zhipuai/glm-5.3-flash.toml"),
      path.join(root, "models/zhipuai/glm-5.3-flash.toml"),
    );
    const provider = {
      ...baseten,
      modelsDir,
      async fetchModels() {
        return { data: [basetenModel({ id: "zai-org/GLM-5.3-Flash", name: "GLM 5.3 Flash" })] };
      },
    };

    expect(await syncProvider(provider)).toMatchObject({ created: 1, updated: 0 });
    const text = await Bun.file(path.join(modelsDir, "zai-org/GLM-5.3-Flash.toml")).text();
    expect(text).toStartWith("# Effort: reasoning_effort = low|high|max");
    expect(text).toContain("https://docs.baseten.co/inference/model-apis/reasoning");
    expect(Bun.TOML.parse(text)).toMatchObject({
      base_model: "zhipuai/glm-5.3-flash",
      reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      interleaved: { field: "reasoning_content" },
    });
    expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function basetenModel(overrides: Partial<BasetenModel> = {}): BasetenModel {
  return {
    id: "deepseek-ai/DeepSeek-V4-Flash-0731",
    name: "DeepSeek V4 Flash 0731",
    context_length: 1_048_576,
    max_completion_tokens: 1_048_576,
    input_modalities: ["text"],
    output_modalities: ["text"],
    pricing: { prompt: "0.00000013", completion: "0.00000026" },
    supported_features: ["reasoning", "tools", "structured_outputs"],
    supported_sampling_parameters: ["temperature"],
    ...overrides,
  };
}

test("preserves an explicitly authored Baseten output limit", () => {
  const built = buildBasetenModel(
    basetenModel(),
    undefined,
    "deepseek/deepseek-v4-flash-0731",
    { limit: { context: 1_048_576, output: 384_000 } },
  );

  expect(built).toMatchObject({
    base_model: "deepseek/deepseek-v4-flash-0731",
    limit: { context: 1_048_576, output: 384_000 },
  });
});

test("uses Baseten's catalog output limit without an authored override", () => {
  const built = buildBasetenModel(
    basetenModel({ max_completion_tokens: 262_144 }),
    undefined,
    "deepseek/deepseek-v4-pro-0813",
  );

  expect(built).toMatchObject({
    base_model: "deepseek/deepseek-v4-pro-0813",
    limit: { context: 1_048_576, output: 262_144 },
  });
});
