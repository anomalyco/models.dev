import { expect, test } from "bun:test";

import { buildGoogleModel } from "../src/sync/providers/google.js";

test("Google sync keeps base models compact", () => {
  const synced = buildGoogleModel({
    name: "models/gemini-3-pro-image-preview",
    displayName: "Nano Banana Pro",
    inputTokenLimit: 131_072,
    outputTokenLimit: 32_768,
    temperature: 1,
    thinking: true,
  }, {
    base_model: "google/gemini-3-pro-image-preview",
    name: "Nano Banana Pro",
    family: "gemini-pro",
    release_date: "2025-11-20",
    last_updated: "2025-11-20",
    attachment: true,
    reasoning: true,
    temperature: true,
    tool_call: false,
    knowledge: "2025-01",
    open_weights: false,
    cost: { input: 2, output: 120 },
    limit: { context: 65_536, output: 32_768 },
    modalities: { input: ["text", "image"], output: ["text", "image"] },
  });

  expect(synced).toEqual({
    base_model: "google/gemini-3-pro-image-preview",
    cost: { input: 2, output: 120 },
    limit: { context: 131_072 },
  });
});
