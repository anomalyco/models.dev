import { expect, spyOn, test } from "bun:test";

import { fetchModelsWithRetry } from "../src/sync/index.js";

test("retries a transient fetch failure", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let calls = 0;
  try {
    const result = await fetchModelsWithRetry(
      {
        name: "Example",
        async fetchModels() {
          calls++;
          if (calls === 1) throw new TypeError("ECONNRESET");
          return ["ok"];
        },
      },
      { delayMs: 0 },
    );
    expect(result).toEqual(["ok"]);
    expect(calls).toBe(2);
  } finally {
    warn.mockRestore();
  }
});

test("rethrows after the last attempt", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let calls = 0;
  try {
    const result = fetchModelsWithRetry(
      {
        name: "Example",
        async fetchModels() {
          calls++;
          throw new Error(`failure ${calls}`);
        },
      },
      { attempts: 3, delayMs: 0 },
    );
    await expect(result).rejects.toThrow("failure 3");
    expect(calls).toBe(3);
  } finally {
    warn.mockRestore();
  }
});
