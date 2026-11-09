import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildBoostRailModel } from "../src/sync/providers/boostrail.js";

const authored = {
  id: "glm-5.2",
  base_model: "zhipuai/glm-5.2",
  cost: { input: 1, output: 3, cache_read: 0.1, cache_write: 1 },
} as ExistingModel;

test("updates every price the list carries", () => {
  const synced = buildBoostRailModel(
    { id: "glm-5.2", pricing: { input: 2, output: 4, cache_read: 0.2, cache_write: 2 } },
    authored,
  ) as { cost: Record<string, number | undefined> };
  expect(synced.cost).toMatchObject({ input: 2, output: 4, cache_read: 0.2, cache_write: 2 });
});

test("keeps authored cache prices when the list omits them", () => {
  const synced = buildBoostRailModel({ id: "glm-5.2", pricing: { input: 2, output: 4 } }, authored) as {
    cost: Record<string, number | undefined>;
  };
  expect(synced.cost).toMatchObject({ input: 2, output: 4, cache_read: 0.1, cache_write: 1 });
});
