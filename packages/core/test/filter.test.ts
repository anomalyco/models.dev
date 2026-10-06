import { describe, expect, test } from "bun:test";

import {
  filterCatalogByModelType,
  generateCatalog,
  InvalidModelTypeError,
  parseModelTypes,
} from "../src/index.js";
import type { ModelMetadata, Provider } from "../src/index.js";
import path from "node:path";

describe("model type filtering", () => {
  test("defaults to untyped models and supports specific types and all", () => {
    expect(parseModelTypes(null)).toBe("default");
    expect(parseModelTypes("")).toBe("default");
    expect(parseModelTypes("decision")).toEqual(["decision"]);
    expect(parseModelTypes("all")).toBe("all");
  });

  test("rejects unknown types and combining all with a type", () => {
    expect(() => parseModelTypes("unknown")).toThrow(InvalidModelTypeError);
    expect(() => parseModelTypes("all,decision")).toThrow(
      InvalidModelTypeError,
    );
  });

  test("omits typed models by default", () => {
    const catalog = fixture();
    const filtered = filterCatalogByModelType(catalog, "default");

    expect(Object.keys(filtered.models)).toEqual(["standard"]);
    expect(Object.keys(filtered.providers.example!.models)).toEqual([
      "standard",
    ]);
    expect(filtered.providers.decisionOnly).toBeUndefined();
  });

  test("filters canonical and provider models by requested type", () => {
    const catalog = fixture();
    const filtered = filterCatalogByModelType(catalog, ["decision"]);

    expect(Object.keys(filtered.models)).toEqual(["decision"]);
    expect(Object.keys(filtered.providers.example!.models)).toEqual([
      "decision",
    ]);
    expect(Object.keys(filtered.providers.decisionOnly!.models)).toEqual([
      "decision",
    ]);
    expect(filterCatalogByModelType(catalog, "all")).toEqual(catalog);
  });

  test("Jev, Clef, and Liquid d1 are decision models omitted by default", async () => {
    const root = path.join(import.meta.dir, "..", "..", "..");
    const catalog = await generateCatalog(root);
    const jevModels = Object.values(catalog.providers).flatMap((provider) =>
      Object.values(provider.models).filter((model) =>
        model.id.toLowerCase().includes("jev"),
      ),
    );

    expect(jevModels.length).toBeGreaterThan(0);
    expect(jevModels.every((model) => model.type === "decision")).toBe(true);

    const defaults = filterCatalogByModelType(catalog, "default");
    expect(
      Object.values(defaults.providers).some((provider) =>
        Object.values(provider.models).some((model) => model.type !== undefined),
      ),
    ).toBe(false);
    expect(defaults.models["typesafe/jev-latest"]).toBeUndefined();
    expect(defaults.providers.vivgrid?.models.jev).toBeUndefined();

    const decisions = filterCatalogByModelType(catalog, ["decision"]);
    expect(decisions.models["typesafe/jev-latest"]?.type).toBe("decision");
    expect(decisions.models["liquid/d1"]?.type).toBe("decision");
    for (const id of ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"]) {
      expect(catalog.providers["cloudflare-workers-ai"]?.models[id]?.type).toBe("decision");
      expect(defaults.providers["cloudflare-workers-ai"]?.models[id]).toBeUndefined();
      expect(decisions.providers["cloudflare-workers-ai"]?.models[id]?.type).toBe("decision");
    }
    expect(defaults.providers.vercel?.models["liquid/d1"]).toBeUndefined();
    expect(decisions.providers.vercel?.models["liquid/d1"]?.type).toBe("decision");
    const typedModels = Object.values(catalog.providers).flatMap((provider) =>
      Object.values(provider.models).filter((model) => model.type === "decision"),
    );
    expect(Object.values(decisions.providers).flatMap((provider) =>
      Object.values(provider.models),
    ).length).toBe(typedModels.length);
  });
});

function fixture() {
  const standard = model("standard-model");
  const decision = model("decision-model", "decision");
  return {
    models: { standard, decision },
    providers: {
      example: {
        id: "example",
        models: { standard, decision },
      } as unknown as Provider,
      decisionOnly: {
        id: "decision-only",
        models: { decision },
      } as unknown as Provider,
    },
  };
}

function model(id: string, type?: "decision") {
  return { id, type } as unknown as ModelMetadata;
}
