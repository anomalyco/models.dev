import { expect, test } from "bun:test";

import { resolveEmpiriolabsBaseModel } from "../src/sync/providers/empiriolabs.js";

test("resolves existing lab metadata without a hardcoded map", () => {
  expect(resolveEmpiriolabsBaseModel("muse-glimmer-30b")).toBe("meta/muse-glimmer-30b");
  expect(resolveEmpiriolabsBaseModel("muse-spark-1-2")).toBe("meta/muse-spark-1.2");
  expect(resolveEmpiriolabsBaseModel("muse-spark-1-1")).toBe("meta/muse-spark-1.1");
  expect(resolveEmpiriolabsBaseModel("seed-2-1-turbo")).toBe("bytedance-seed/seed-2.1-turbo");
  expect(resolveEmpiriolabsBaseModel("seed-2-0-code")).toBe("bytedance-seed/seed-2.0-code");
  expect(resolveEmpiriolabsBaseModel("seed-2-0-lite")).toBe("bytedance-seed/seed-2.0-lite");
  expect(resolveEmpiriolabsBaseModel("seed-2-0-mini")).toBe("bytedance-seed/seed-2.0-mini");
  expect(resolveEmpiriolabsBaseModel("seed-2-0-pro")).toBe("bytedance-seed/seed-2.0-pro");
  expect(resolveEmpiriolabsBaseModel("qwen3-8-max")).toBe("alibaba/qwen3.8-max");
});

test("maps versioned slugs onto the undated canonical when needed", () => {
  expect(resolveEmpiriolabsBaseModel("fugu-ultra-v1-1")).toBe("sakana/fugu-ultra");
  expect(resolveEmpiriolabsBaseModel("fugu-ultra-v1-0")).toBe("sakana/fugu-ultra");
});

test("keeps true filename aliases", () => {
  expect(resolveEmpiriolabsBaseModel("mistral-medium-3")).toBe("mistral/mistral-medium-2505");
  expect(resolveEmpiriolabsBaseModel("mistral-small-4")).toBe("mistral/mistral-small-2603");
});

test("resolves a non-alias Mistral id through the mistralai prefix", () => {
  expect(resolveEmpiriolabsBaseModel("mistral-small-2603")).toBe("mistral/mistral-small-2603");
});

test("does not invent lab metadata when none exists", () => {
  expect(resolveEmpiriolabsBaseModel("deepreasoning")).toBeUndefined();
  expect(resolveEmpiriolabsBaseModel("nova-pro-1-0")).toBeUndefined();
});
