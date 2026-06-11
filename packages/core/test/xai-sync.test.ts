import { expect, test } from "bun:test";

import { buildXAIModel, type XAIModel } from "../src/sync/providers/xai.js";

const model: XAIModel = {
  id: "grok-test",
  created: 1_700_000_000,
  input_modalities: ["text"],
  output_modalities: ["text"],
  prompt_text_token_price: 10_000,
  completion_text_token_price: 20_000,
};

test("xAI sync preserves reasoning options", () => {
  const synced = buildXAIModel(model, {
    name: "Grok Test",
    release_date: "2024-01-01",
    last_updated: "2024-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "high"] }],
    tool_call: true,
    open_weights: false,
    limit: { context: 2_000_000, output: 30_000 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(synced.reasoning_options).toEqual([{ type: "effort", values: ["none", "high"] }]);
  expect(synced.limit?.context).toBe(2_000_000);
});
