import { expect, test } from "bun:test";
import path from "node:path";

import { generate } from "../src/index.js";

test("Cerebras generated model matrix matches the current catalog", async () => {
  const root = path.join(import.meta.dirname, "..", "..", "..");
  const models = (await generate(path.join(root, "providers"))).cerebras?.models;

  expect(Object.keys(models ?? {}).sort()).toEqual(["gpt-oss-120b", "zai-glm-4.7"]);
  expect(
    Object.fromEntries(
      Object.entries(models ?? {}).map(([id, model]) => [
        id,
        { reasoning: model.reasoning, reasoning_options: model.reasoning_options },
      ]),
    ),
  ).toEqual({
    "gpt-oss-120b": {
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    },
    "zai-glm-4.7": {
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["none"] }],
    },
  });

  expect(
    Object.entries(models ?? {})
      .filter(([, model]) => !model.reasoning && model.reasoning_options !== undefined)
      .map(([id]) => id),
  ).toEqual([]);
  expect(models?.["llama3.1-8b"]).toBeUndefined();
});
