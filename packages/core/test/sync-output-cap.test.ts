import { expect, test } from "bun:test";

import { capOutputAtContext } from "../src/sync/index";

const model = (limit?: { context?: number; input?: number; output?: number }) =>
  ({ id: "m", base_model: "lab/m", ...(limit ? { limit } : {}) }) as any;

test("caps a synced output that is larger than the host's context", () => {
  expect(capOutputAtContext(model({ context: 8_192, output: 16_384 }), { limit: { context: 1_000_000, output: 100_000 } }).limit).toEqual({
    context: 8_192,
    output: 8_192,
  });
});

test("caps an output inherited from a lab with a larger window", () => {
  expect(capOutputAtContext(model({ context: 40_000 }), { limit: { context: 131_072, output: 131_072 } }).limit).toEqual({
    context: 40_000,
    output: 40_000,
  });
});

test("drops the output when the capped value is the lab's own", () => {
  expect(capOutputAtContext(model({ context: 8_192, output: 16_384 }), { limit: { context: 8_192, output: 8_192 } }).limit).toEqual({
    context: 8_192,
  });
});

test("leaves a model alone when output fits or context is unknown", () => {
  const fits = model({ context: 128_000, output: 64_000 });
  expect(capOutputAtContext(fits, undefined)).toBe(fits);
  const unknown = model({ output: 64_000 });
  expect(capOutputAtContext(unknown, undefined)).toBe(unknown);
});

test("leaves models that don't output text alone", () => {
  const tts = { ...model({ context: 8_192, output: 16_384 }), modalities: { input: ["text"], output: ["audio"] } };
  expect(capOutputAtContext(tts, undefined)).toBe(tts);
  // Lab metadata reaches sync in v1 form, where an embedding's output is "text".
  const embed = model({ context: 512, output: 1_024 });
  expect(capOutputAtContext(embed, { modalities: { output: ["text"] } }, true)).toBe(embed);
});
