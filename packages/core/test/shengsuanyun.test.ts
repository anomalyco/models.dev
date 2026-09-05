import { expect, test } from "bun:test";

import { resolveShengSuanYunBaseModel } from "../src/sync/providers/shengsuanyun.js";

test("remaps org prefixes onto canonical metadata directories", () => {
  expect(resolveShengSuanYunBaseModel("ali/qwen3.7-max")).toBe("alibaba/qwen3.7-max");
  expect(resolveShengSuanYunBaseModel("bigmodel/glm-4.6")).toBe("zhipuai/glm-4.6");
  expect(resolveShengSuanYunBaseModel("bigmodel/glm-4.6:thinking")).toBe("zhipuai/glm-4.6");
  expect(resolveShengSuanYunBaseModel("longcat/longcat-2.0")).toBe("meituan/longcat-2.0");
});

test("translates ByteDance's doubao-seed dash numbering to the on-disk dot form", () => {
  expect(resolveShengSuanYunBaseModel("bytedance/doubao-seed-2-1-turbo")).toBe("bytedance-seed/seed-2.1-turbo");
  expect(resolveShengSuanYunBaseModel("bytedance/doubao-seed-2-0-pro")).toBe("bytedance-seed/seed-2.0-pro");
  expect(resolveShengSuanYunBaseModel("bytedance/doubao-seed-1.8")).toBe("bytedance-seed/seed-1-8");
});

test("resolves prefixes already known to the shared OpenRouter resolver", () => {
  expect(resolveShengSuanYunBaseModel("anthropic/claude-sonnet-4.5")).toBe("anthropic/claude-sonnet-4-5");
  expect(resolveShengSuanYunBaseModel("anthropic/claude-sonnet-4.5:thinking")).toBe("anthropic/claude-sonnet-4-5");
});

test("aliases bare version IDs onto the dated canonical file", () => {
  expect(resolveShengSuanYunBaseModel("anthropic/claude-opus-4")).toBe("anthropic/claude-opus-4-0");
  expect(resolveShengSuanYunBaseModel("anthropic/claude-sonnet-4")).toBe("anthropic/claude-sonnet-4-0");
  expect(resolveShengSuanYunBaseModel("anthropic/claude-sonnet-4:thinking")).toBe("anthropic/claude-sonnet-4-0");
});

test("strips -latest/-high suffixes when the bare id resolves", () => {
  expect(resolveShengSuanYunBaseModel("ali/qwen-plus-latest")).toBe("alibaba/qwen-plus");
  expect(resolveShengSuanYunBaseModel("openai/o3-mini-high")).toBe("openai/o3-mini");
});

test("does not invent canonical metadata for prefixes with no local mapping", () => {
  expect(resolveShengSuanYunBaseModel("baidu/ernie-4.0-turbo-128k")).toBeUndefined();
  expect(resolveShengSuanYunBaseModel("streamlake/kat-coder-pro-v1")).toBeUndefined();
  expect(resolveShengSuanYunBaseModel("intern/intern-s1")).toBeUndefined();
});
