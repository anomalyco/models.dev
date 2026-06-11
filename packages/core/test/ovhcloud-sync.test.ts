import { expect, test } from "bun:test";
import path from "node:path";

import { buildOvhcloudModel, type OvhcloudModel } from "../src/sync/providers/ovhcloud.js";

const model: OvhcloudModel = {
  id: "Qwen3-32B",
  name: "Qwen3-32B",
  created: 1_752_655_628,
  hugging_face_id: "Qwen/Qwen3-32B",
  context_length: 32_768,
  max_output_length: 32_768,
  supported_features: ["reasoning"],
};

test("OVHcloud sync preserves authored reasoning options", () => {
  const synced = buildOvhcloudModel(model, {
    release_date: "2025-07-16",
    last_updated: "2025-07-16",
    reasoning_options: [{ type: "toggle" }],
  });

  expect(synced.reasoning_options).toEqual([{ type: "toggle" }]);
});

test("OVHcloud sync omits reasoning options for non-reasoning models", () => {
  const synced = buildOvhcloudModel(
    { ...model, supported_features: [] },
    { reasoning_options: [{ type: "toggle" }] },
  );

  expect(synced.reasoning_options).toBeUndefined();
});

test("OVHcloud reasoning models declare the exact provider control matrix", async () => {
  const modelsDir = path.join(import.meta.dirname, "..", "..", "..", "providers", "ovhcloud", "models");
  const expected = {
    "gpt-oss-20b": [{ type: "effort", values: ["low", "medium", "high"] }],
    "gpt-oss-120b": [{ type: "effort", values: ["low", "medium", "high"] }],
    "qwen3-32b": [{ type: "toggle" }],
    "qwen3.5-9b": [{ type: "effort", values: ["none", "low", "medium", "high"] }],
    "qwen3.5-397b-a17b": [{ type: "effort", values: ["none", "low", "medium", "high"] }],
    "qwen3.6-27b": [{ type: "effort", values: ["none", "minimal", "low", "medium", "high"] }],
  };

  for (const [id, reasoningOptions] of Object.entries(expected)) {
    const authored = Bun.TOML.parse(await Bun.file(path.join(modelsDir, `${id}.toml`)).text()) as {
      reasoning?: boolean;
      reasoning_options?: unknown;
    };
    expect(authored.reasoning, id).toBe(true);
    expect(authored.reasoning_options, id).toEqual(reasoningOptions);
  }
});
