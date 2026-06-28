import { expect, test } from "bun:test";

import { inferKimiFamily } from "../src/family.js";

test("Kimi family inference ignores K2 versions", () => {
  expect(inferKimiFamily("moonshotai/kimi-k2.5")).toBe("kimi-k2");
  expect(inferKimiFamily("moonshotai/kimi-k2.7-code")).toBe("kimi-k2");
  expect(inferKimiFamily("Kimi K2.6")).toBe("kimi-k2");
});

test("Kimi family inference preserves thinking variants", () => {
  expect(inferKimiFamily("moonshotai/kimi-k2-thinking")).toBe("kimi-thinking");
  expect(inferKimiFamily("Kimi K2.5 Thinking")).toBe("kimi-thinking");
  expect(inferKimiFamily("moonshotai/kimi-k2.6:thinking")).toBe("kimi-thinking");
});
