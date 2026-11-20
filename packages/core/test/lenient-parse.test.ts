import { expect, test } from "bun:test";
import { z } from "zod";

import { parseLeniently } from "../src/sync/lenient-parse.js";

const Response = z.object({ data: z.array(z.object({ id: z.string(), sunset_at: z.string().nullable().optional() })) });
const parse = (raw: unknown) => Response.parse(raw).data;

test("a row with a field in an unexpected shape is skipped, the rest parse", () => {
  const raw = { data: [{ id: "a" }, { id: "b", sunset_at: 1795435200 }, { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" }] };
  const result = parseLeniently(parse, raw);
  expect(result.models.map((model) => model.id)).toEqual(["a", "c", "d", "e", "f"]);
  expect(result.dropped).toEqual(["b (sunset_at: Expected string, received number)"]);
  expect(raw.data).toHaveLength(6);
});

test("too many bad rows, or a problem outside the rows, still fails the sync", () => {
  expect(() => parseLeniently(parse, { data: [{ id: 1 }, { id: 2 }, { id: "c" }] })).toThrow();
  expect(() => parseLeniently(parse, { items: [] })).toThrow();
});
