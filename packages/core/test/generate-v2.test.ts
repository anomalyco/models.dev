import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  CacheSupportV2,
  DurationStringV2,
  generateV2,
  ProviderV2,
  toModelV2,
} from "../src/index.js";
import type { Model, Provider } from "../src/index.js";

describe("v2 catalog generation", () => {
  test("translates v1 model fields into v2 shape", () => {
    const provider: Provider = {
      id: "openai",
      name: "OpenAI",
      doc: "https://platform.openai.com/docs/models",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      models: {},
    };

    const model: Model = {
      id: "gpt-5.6-sol",
      canonical_model_id: "openai/gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      description: "Frontier GPT model",
      family: "gpt",
      attachment: true,
      reasoning: true,
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: [null, "low", "medium", "high"] },
        { type: "budget_tokens", min: 1024, max: 32000 },
      ],
      tool_call: true,
      structured_output: true,
      temperature: true,
      knowledge: "2025-12",
      release_date: "2026-06-01",
      last_updated: "2026-06-01",
      modalities: {
        input: ["text", "image", "pdf"],
        output: ["text"],
      },
      open_weights: false,
      limit: {
        context: 1050000,
        input: 922000,
        output: 128000,
      },
      cost: {
        input: 4,
        output: 20,
        cache_read: 0.4,
        cache_write: 5,
        context_over_200k: {
          input: 8,
          output: 30,
        },
        tiers: [
          {
            tier: { type: "context", size: 272000 },
            input: 8,
            output: 30,
          },
        ],
      },
      experimental: {
        modes: {
          fast: {
            cost: { input: 8, output: 40 },
            provider: {
              body: { service_tier: "priority" },
              headers: { "x-tier": "fast" },
            },
          },
        },
      },
    };

    const translated = toModelV2(model, provider);

    expect(translated.id).toBe("gpt-5.6-sol");
    expect(translated.canonical_id).toBe("openai/gpt-5.6-sol");
    expect(translated.type).toBe("chat");
    expect(translated.modalities).toEqual({
      input: ["text", "image", "application/pdf"],
      output: ["text"],
    });
    expect(translated.capabilities).toEqual({
      tools: { supported: true },
      reasoning: {
        supported: true,
        toggle: true,
        effort: ["default", "low", "medium", "high"],
        budget: { min: 1024, max: 32000 },
      },
      structured_output: true,
      temperature: true,
    });
    expect(translated.cost).toEqual({
      input: 4,
      output: 20,
      cache_read: 0.4,
      cache_write: 5,
      tiers: [
        {
          tier: { type: "context", size: 272000 },
          input: 8,
          output: 30,
        },
      ],
    });
    expect(translated.experimental).toEqual({
      modes: {
        fast: {
          cost: { input: 8, output: 40 },
          body: { service_tier: "priority" },
          headers: { "x-tier": "fast" },
        },
      },
    });
  });

  test("generates entire v2 catalog from TOMLs into valid ProviderV2 entries", async () => {
    const providersDir = path.join(import.meta.dir, "..", "..", "..", "providers");
    const providersV2 = await generateV2(providersDir);

    expect(Object.keys(providersV2).length).toBeGreaterThan(0);
    expect(providersV2["azure-cognitive-services"]).toBeUndefined();
    expect(providersV2["google-vertex-anthropic"]).toBeUndefined();
    expect(providersV2.opencode?.models["jev-1.13"]?.api).toEqual({
      systemone: {
        base_url: "https://opencode.ai/zen/v1",
        sdk: {
          opencodeai: "@opencode/ai/providers/typesafe-ai",
        },
      },
    });
    expect(
      providersV2["google-vertex"]?.models["gemini-2.5-pro"]?.api[
        "generate-content"
      ]?.base_url,
    ).toBe(
      "https://${GOOGLE_VERTEX_ENDPOINT}/v1beta1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}/publishers/google",
    );
    expect(
      providersV2["google-vertex"]?.models["claude-haiku-5-5@default"]?.api
        .messages?.base_url,
    ).toBe(
      "https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}/publishers/anthropic/models",
    );
  }, 15_000);

  test("validates cache capabilities and duration strings", () => {
    expect(DurationStringV2.safeParse("5m").success).toBe(true);
    expect(DurationStringV2.safeParse("30m").success).toBe(true);
    expect(DurationStringV2.safeParse("1h").success).toBe(true);
    expect(DurationStringV2.safeParse("24h").success).toBe(true);
    expect(DurationStringV2.safeParse("500ms").success).toBe(true);
    expect(DurationStringV2.safeParse("5min").success).toBe(false);

    expect(
      CacheSupportV2.safeParse({
        supported: true,
        implicit: { ttl: ["30m"], min_tokens: 1024 },
        explicit: {
          ttl: ["5m", "1h"],
          max_breakpoints: 4,
          targets: ["tools", "system", "messages"],
          min_tokens: 4096,
        },
      }).success,
    ).toBe(true);

    expect(
      CacheSupportV2.safeParse({
        supported: true,
        implicit: true,
        explicit: false,
      }).success,
    ).toBe(true);
  });
});
