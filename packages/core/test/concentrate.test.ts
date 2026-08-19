import { describe, expect, test } from "bun:test";

import {
  buildConcentrateModel,
  concentrate,
  concentrateSurface,
  type ConcentrateModel,
  fetchConcentrateModels,
  resolveConcentrateBaseModel,
  selectConcentratePricingRoute,
} from "../src/sync/providers/concentrate.js";

describe("Concentrate sync", () => {
  test("preserves the deliberately partial catalog without opening missing-model issues", () => {
    expect(concentrate.skipCreates).toBe(true);
    expect(concentrate.trackMissingModels).toBe(false);
    expect(concentrate.deleteMissing).toBe(false);
  });

  test("fetches and joins the public list with model details", async () => {
    const model = concentrateModel();
    const urls: string[] = [];
    const result = await fetchConcentrateModels(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/gpt-5.6-terra")) return Response.json(model.detail);
      return Response.json({ data: [model.summary], has_more: false });
    });

    expect(urls).toEqual([
      "https://api.concentrate.ai/v1/models",
      "https://api.concentrate.ai/v1/models/gpt-5.6-terra",
    ]);
    expect(result.data).toEqual([model]);
  });

  test("uses stable Concentrate aliases for canonical model metadata", () => {
    expect(resolveConcentrateBaseModel(concentrateModel({ id: "claude-sonnet-4", owner: "anthropic" })))
      .toBe("anthropic/claude-sonnet-4-20250514");
    expect(resolveConcentrateBaseModel(concentrateModel({ id: "gpt-5.6-terra", owner: "openai" })))
      .toBe("openai/gpt-5.6-terra");
  });

  test("uses the cheapest route only for pricing and preserves curated reasoning controls", () => {
    const model = concentrateModel();
    const selected = selectConcentratePricingRoute(model);
    expect(selected?.id).toBe("openai");
    expect(selected?.route.context_window).toBe(1_050_000);

    const reasoningOptions = [{ type: "effort" as const, values: ["low" as const, "high" as const] }];
    const translated = buildConcentrateModel(model, { reasoning_options: reasoningOptions });
    expect(translated).toMatchObject({
      base_model: "openai/gpt-5.6-terra",
      reasoning_options: reasoningOptions,
      cost: {
        input: 2,
        output: 12,
        cache_read: 0.2,
        cache_write: 2.5,
        tiers: [{
          tier: { type: "context", size: 272_000 },
          input: 4,
          output: 18,
        }],
      },
    });
    expect(translated).not.toHaveProperty("reasoning");
    expect(translated).not.toHaveProperty("temperature");
  });

  test("uses aggregate limits and capabilities when the cheapest route is capability-thin", () => {
    const model = concentrateModel();
    model.detail.providers.free = {
      ...model.detail.providers.openai,
      provider_slug: "free",
      pricing: {
        tokens: {
          input: { price: { USD: 0 }, units: 1_000_000 },
          output: { price: { USD: 0 }, units: 1_000_000 },
        },
      },
      context_window: 16_384,
      max_output_tokens: 4_096,
      supports: {
        input: { text: true },
        tools: { function_calling: false },
      },
    };

    const translated = buildConcentrateModel(model, undefined);
    expect(selectConcentratePricingRoute(model)?.id).toBe("free");
    expect(translated).toMatchObject({ cost: { input: 0, output: 0 } });
    expect(concentrateSurface(model)).toEqual({
      input: ["text", "image", "pdf"],
      limit: { context: 1_050_000, output: 128_000 },
      tool_call: true,
      structured_output: true,
    });
  });

  test("does not invent reasoning controls from Concentrate's normalization enum", () => {
    const translated = buildConcentrateModel(concentrateModel(), undefined);
    expect(translated).not.toHaveProperty("reasoning_options");
  });
});

function concentrateModel(overrides: { id?: string; owner?: string } = {}): ConcentrateModel {
  const id = overrides.id ?? "gpt-5.6-terra";
  const owner = overrides.owner ?? "openai";
  const money = (price: number) => ({ price: { USD: price }, units: 1_000_000 });
  const route = (input: number, output: number) => ({
    provider_slug: "openai",
    pricing: {
      tokens: {
        input: money(input),
        output: money(output),
        cache: {
          read: money(0.2),
          write: { cache_write_tokens: money(2.5) },
        },
        tiers: [{
          above: 272_000,
          input: money(4),
          output: money(18),
        }],
      },
    },
    context_window: 1_050_000,
    max_output_tokens: 128_000,
    supports: {
      input: { text: true, image: { png: true }, file: { pdf: true } },
      reasoning: { effort: { none: true, low: true, high: true } },
      temperature: false,
      text: { format: { json_schema: true } },
      tools: { function_calling: true },
    },
  });

  return {
    summary: {
      id,
      display_name: "GPT 5.6 Terra",
      owned_by: owner,
      created_at: "2026-07-09T00:00:00.000Z",
      max_input_tokens: 1_050_000,
      max_tokens: 128_000,
      capabilities: {
        effort: {
          supported: true,
          none: { supported: true },
          low: { supported: true },
          high: { supported: true },
        },
        image_input: { supported: true },
        pdf_input: { supported: true },
        structured_outputs: { supported: true },
        thinking: {
          supported: true,
          types: { enabled: { supported: true } },
        },
      },
    },
    detail: {
      slug: id,
      name: "GPT 5.6 Terra",
      description: "Cost-optimized GPT model",
      release_date: 1_783_555_200_000,
      author: { slug: owner },
      providers: {
        azure: { ...route(3, 15), provider_slug: "azure" },
        openai: route(2, 12),
      },
    },
  };
}
