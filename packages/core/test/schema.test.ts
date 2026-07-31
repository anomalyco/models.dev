import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { AuthoredModel } from "../src/index.js";

type AuthoredModelData = z.infer<typeof AuthoredModel>;

describe("model schema", () => {
  test("requires reasoning_options when reasoning is true", () => {
    const model = baseModel({ reasoning: true });

    expect(AuthoredModel.safeParse(model).success).toBe(false);
  });

  test("accepts empty reasoning_options when reasoning is true", () => {
    const model = baseModel({
      reasoning: true,
      reasoning_options: [],
    });

    expect(AuthoredModel.safeParse(model).success).toBe(true);
  });

  test("rejects reasoning_options when reasoning is false", () => {
    const model = baseModel({
      reasoning: false,
      reasoning_options: [],
    });

    expect(AuthoredModel.safeParse(model).success).toBe(false);
  });
  test("rejects unknown nested model configuration fields", () => {
    const result = AuthoredModel.safeParse({
      ...baseModel({}),
      cost: {
        input: 1,
        output: 2,
        cache_reed: 0.1,
      },
      provider: {
        npm: "example-sdk",
        typo: true,
      },
      experimental: {
        modes: {
          fast: {
            cost: {
              input: 2,
              output: 4,
              cache_writ: 5,
            },
            provider: {
              typo: true,
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining([
        "cost",
        "provider",
        "experimental.modes.fast.cost",
        "experimental.modes.fast.provider",
      ]),
    );
  });
});

function baseModel(overrides: Partial<AuthoredModelData>) {
  return {
    id: "example/model",
    name: "Example Model",
    description: "Example model for schema validation and regression tests",
    attachment: false,
    reasoning: false,
    tool_call: true,
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    open_weights: false,
    limit: {
      context: 1_000,
      output: 100,
    },
    cost: {
      input: 1,
      output: 2,
    },
    ...overrides,
  };
}
