import { expect, test } from "bun:test";

import { openrouter, type OpenRouterModel } from "../src/sync/providers/openrouter.js";

const imageModel = (id: string): OpenRouterModel => ({
  id,
  name: id,
  created: 1_782_777_600,
  hugging_face_id: null,
  knowledge_cutoff: "2026-01-31",
  context_length: 0,
  architecture: { input_modalities: ["text"], output_modalities: ["image"] },
  pricing: { prompt: "0", completion: "0" },
  top_provider: { context_length: null, max_completion_tokens: null },
  supported_parameters: [],
} as unknown as OpenRouterModel);

async function fetchWith(images: string[], missing: Set<string>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.includes("/videos/models")) return json({ data: [] });
    if (url.includes("output_modalities=speech")) return json({ data: images.map(imageModel) });
    if (url.includes("/api/v1/models")) return json({ data: [] });
    const id = decodeURIComponent(url.split("/images/models/")[1]!.replace(/\/endpoints$/, ""));
    if (missing.has(id)) return new Response("not found", { status: 404 });
    return json({ endpoints: [] });
  }) as typeof fetch;
  try {
    return await openrouter.fetchModels();
  } finally {
    globalThis.fetch = original;
  }
}

test("an image model without an endpoints page is kept, flagged and reported", async () => {
  const raw = await fetchWith(["a/one", "a/two", "a/three"], new Set(["a/two"]));
  const models = openrouter.parseModels(raw);
  expect(models.find((model) => model.id === "a/two")?.image_endpoints_missing).toBe(true);
  expect(openrouter.sourceNotices(models)).toContain("a/two: no Images API endpoints page (404), so no image price");
});

test("most image models answering 404 fails the fetch", async () => {
  const ids = ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"];
  expect(fetchWith(ids, new Set(ids.slice(0, 5)))).rejects.toThrow("answered 404 for 5 of 6 image models");
});
