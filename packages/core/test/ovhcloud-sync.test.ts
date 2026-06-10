import { expect, test } from "bun:test";

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
