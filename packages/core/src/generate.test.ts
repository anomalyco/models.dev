import path from "path";
import { expect, test } from "bun:test";

import { generate } from "./generate.js";

function compareStrings(a: string, b: string) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

test("generate returns providers and models in sorted key order", async () => {
  const providersDir = path.join(import.meta.dir, "..", "..", "..", "providers");
  const providers = await generate(providersDir);
  const providerIds = Object.keys(providers);
  expect(providerIds).toEqual([...providerIds].sort(compareStrings));

  for (const providerId of providerIds) {
    const modelIds = Object.keys(providers[providerId].models);
    expect(modelIds).toEqual([...modelIds].sort(compareStrings));
  }
});
