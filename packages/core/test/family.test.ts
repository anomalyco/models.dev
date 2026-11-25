import { expect, test } from "bun:test";

import { inferKimiFamily } from "../src/family.js";

test("Kimi family inference ignores versions", () => {
  expect(inferKimiFamily("moonshotai/kimi-k2.5")).toBe("kimi");
  expect(inferKimiFamily("moonshotai/kimi-k2.7-code")).toBe("kimi-code");
  expect(inferKimiFamily("Kimi K2.6")).toBe("kimi");
});

test("Kimi thinking variants share the base family", () => {
  expect(inferKimiFamily("moonshotai/kimi-k2-thinking")).toBe("kimi");
  expect(inferKimiFamily("Kimi K2.5 Thinking")).toBe("kimi");
  expect(inferKimiFamily("moonshotai/kimi-k2.6:thinking")).toBe("kimi");
});

test("Kimi K3 shares the family and Pro is its own tier", () => {
  expect(inferKimiFamily("moonshotai/kimi-k3")).toBe("kimi");
  expect(inferKimiFamily("Kimi K3")).toBe("kimi");
  expect(inferKimiFamily("moonshotai/kimi-k3.1-pro")).toBe("kimi-pro");
  expect(inferKimiFamily("Kimi K3.1 Pro Highspeed")).toBe("kimi-pro");
});
