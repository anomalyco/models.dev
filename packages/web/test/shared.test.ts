import { describe, expect, test } from "bun:test";

import { costSummary, formatCost } from "../src/shared";

describe("formatCost", () => {
  test("keeps two decimals for whole-cent prices", () => {
    expect(formatCost(3)).toBe("$3.00");
    expect(formatCost(2.5)).toBe("$2.50");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(undefined)).toBe("-");
  });

  test("does not round sub-cent prices away", () => {
    expect(formatCost(0.075)).toBe("$0.075");
    expect(formatCost(0.0023)).toBe("$0.0023");
    expect(formatCost(0.001)).toBe("$0.001");
    expect(formatCost(0.00437)).toBe("$0.0044");
  });

  test("hides floating-point noise", () => {
    expect(formatCost(0.19999999999999998)).toBe("$0.20");
  });

  test("formats input and output together", () => {
    expect(costSummary(0.001, 0.002)).toBe("$0.001 / $0.002");
    expect(costSummary(undefined, undefined)).toBe("-");
  });
});
