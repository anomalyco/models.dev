import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { AuthoredModel } from "../src/index.js";

type AuthoredModelData = z.infer<typeof AuthoredModel>;

const dateFields = ["knowledge", "release_date", "last_updated"] as const;

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

  test("accepts calendar-valid model dates", () => {
    for (const field of dateFields) {
      for (const value of [
        "2026-02",
        "2024-02-29",
        "2000-02-29",
        "2026-12-31",
      ]) {
        expect(
          AuthoredModel.safeParse({
            ...baseModel({}),
            [field]: value,
          }).success,
        ).toBe(true);
      }
    }
  });

  test("rejects impossible model dates", () => {
    for (const field of dateFields) {
      for (const value of [
        "2026-00",
        "2026-13",
        "2025-02-29",
        "1900-02-29",
        "2026-02-30",
        "2026-04-31",
      ]) {
        expect(
          AuthoredModel.safeParse({
            ...baseModel({}),
            [field]: value,
          }).success,
        ).toBe(false);
      }
    }
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
