import { describe, expect, it } from "bun:test";
import { ModelFamilyValues, ModelFamily } from "../src/family.js";

describe("ModelFamilyValues", () => {
  it("contains no duplicate entries", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const value of ModelFamilyValues) {
      if (seen.has(value)) {
        duplicates.push(value);
      }
      seen.add(value);
    }
    expect(duplicates).toEqual([]);
  });

  it("parses valid family values", () => {
    expect(ModelFamily.safeParse("trinity").success).toBe(true);
    expect(ModelFamily.safeParse("claude").success).toBe(true);
    expect(ModelFamily.safeParse("gpt").success).toBe(true);
    expect(ModelFamily.safeParse("gemini").success).toBe(true);
  });

  it("rejects invalid family values", () => {
    expect(ModelFamily.safeParse("not-a-real-family").success).toBe(false);
    expect(ModelFamily.safeParse("").success).toBe(false);
    expect(ModelFamily.safeParse(123).success).toBe(false);
  });

  it("trinity appears exactly once", () => {
    const count = ModelFamilyValues.filter((v) => v === "trinity").length;
    expect(count).toBe(1);
  });
});
