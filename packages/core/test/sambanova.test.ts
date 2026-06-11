import { expect, test } from "bun:test";
import path from "node:path";

import { generate } from "../src/index.js";

test("SambaNova reasoning controls match provider evidence", async () => {
  const root = path.join(import.meta.dirname, "..", "..", "..");
  const providers = await generate(path.join(root, "providers"));
  const models = providers.sambanova?.models;

  expect(models?.["DeepSeek-V3.1"]).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
  });
  expect(models?.["DeepSeek-V3.2"]).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    status: "beta",
  });
  expect(models?.["gpt-oss-120b"]).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
  });

  for (const id of ["MiniMax-M2.7", "gemma-4-31B-it"]) {
    expect(models?.[id]?.reasoning, id).toBe(true);
    expect(models?.[id]?.reasoning_options, id).toBeUndefined();
  }
  expect(models?.["gemma-4-31B-it"]?.status).toBe("beta");

  expect(models?.["Meta-Llama-3.3-70B-Instruct"]?.reasoning).toBe(false);
  expect(models?.["Meta-Llama-3.3-70B-Instruct"]?.reasoning_options).toBeUndefined();
});
