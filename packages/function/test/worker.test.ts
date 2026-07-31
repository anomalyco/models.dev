import { expect, test } from "bun:test";

import { isInferenceClient } from "../src/worker.js";

test("identifies inference clients without matching Ubuntu browsers", () => {
  expect(isInferenceClient("Bun/1.3.14")).toBe(true);
  expect(isInferenceClient("OpenCode/1.0")).toBe(true);
  expect(
    isInferenceClient(
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    ),
  ).toBe(false);
});
