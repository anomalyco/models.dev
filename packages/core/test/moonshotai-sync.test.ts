import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildMoonshotModel, parseMoonshotPricing } from "../src/sync/providers/moonshotai.js";

const html = 'x _jsx(DocTable,{columns:[{title:`Model`},{title:`Input`},{title:`Output`},{title:`Cached Input`},{title:`5m writes`},{title:`1h writes`}],rows:[[_jsx(_components.a,{href:`/k3`,children:`kimi-k3`}),`$3.00 / MTok`,`$15.00 / MTok`,`$0.30 / MTok`,`$3.00 / MTok`,`$6.00 / MTok`]]}) y';

test("Moonshot reads prices from the compiled DocTable calls", () => {
  expect(parseMoonshotPricing(html).get("kimi-k3")).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: { "5m": 3, "1h": 6 } });
  expect(() => parseMoonshotPricing("no tables")).toThrow();
});

test("Moonshot updates prices and the 5m write, and writes a context only when it differs from the lab", () => {
  const authored = { base_model: "moonshotai/kimi-k3", cost: { input: 1, output: 1, cache_read: 1, cache_write: 1 } } as unknown as ExistingModel;
  const built = buildMoonshotModel({ id: "kimi-k3", context: 123, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: { "5m": 3, "1h": 6 } } }, authored) as unknown as ExistingModel;
  expect(built.cost).toEqual({ input: 3, output: 15, cache_read: 0.3, cache_write: 3 });
  expect(built.limit?.context).toBe(123);
});
