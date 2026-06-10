import { expect, test } from "bun:test";
import path from "node:path";

const expectedReasoningOptions = {
  "accounts/fireworks/models/deepseek-v4-flash": [
    { type: "toggle" },
    { type: "effort", values: ["high", "max"] },
  ],
  "accounts/fireworks/models/deepseek-v4-pro": [
    { type: "toggle" },
    { type: "effort", values: ["high", "max"] },
  ],
  "accounts/fireworks/models/glm-5p1": [{ type: "toggle" }],
  "accounts/fireworks/models/gpt-oss-120b": [{ type: "effort", values: ["low", "medium", "high"] }],
  "accounts/fireworks/models/gpt-oss-20b": [{ type: "effort", values: ["low", "medium", "high"] }],
  "accounts/fireworks/models/kimi-k2p5": [{ type: "toggle" }],
  "accounts/fireworks/models/kimi-k2p6": [{ type: "toggle" }],
  "accounts/fireworks/models/minimax-m2p5": [{ type: "effort", values: ["low", "medium", "high"] }],
  "accounts/fireworks/models/minimax-m2p7": [{ type: "effort", values: ["low", "medium", "high"] }],
  "accounts/fireworks/models/qwen3p6-plus": [
    { type: "toggle" },
    { type: "effort", values: ["low", "medium", "high"] },
  ],
  "accounts/fireworks/routers/glm-5p1-fast": [{ type: "toggle" }],
  "accounts/fireworks/routers/kimi-k2p6-fast": [{ type: "toggle" }],
  "accounts/fireworks/routers/kimi-k2p6-turbo": [{ type: "toggle" }],
} as const;

test("all Fireworks models declare exact reasoning controls", async () => {
  const root = path.join(import.meta.dirname, "..", "..", "..");
  const modelsDir = path.join(root, "providers", "fireworks-ai", "models");
  const actualIds: string[] = [];

  for await (const relativePath of new Bun.Glob("**/*.toml").scan(modelsDir)) {
    const id = relativePath.slice(0, -".toml".length);
    const model = Bun.TOML.parse(await Bun.file(path.join(modelsDir, relativePath)).text()) as {
      base_model?: string;
      reasoning?: boolean;
      reasoning_options?: unknown[];
    };
    const reasoning = model.reasoning ?? (model.base_model
      ? (Bun.TOML.parse(await Bun.file(path.join(root, "models", `${model.base_model}.toml`)).text()) as {
          reasoning: boolean;
        }).reasoning
      : false);

    actualIds.push(id);
    if (!reasoning) {
      expect(model.reasoning_options, id).toBeUndefined();
      continue;
    }

    expect(model.reasoning_options, id).toEqual(expectedReasoningOptions[id as keyof typeof expectedReasoningOptions]);
  }

  expect(actualIds.sort()).toEqual(Object.keys(expectedReasoningOptions).sort());
});
