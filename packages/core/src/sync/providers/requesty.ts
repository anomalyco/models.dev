import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import {
    factorBaseModel,
    modelMetadata,
    resolveModelMetadataBaseModel,
} from "./openrouter.js";

// ========================================
// Constants
// ========================================

const API_ENDPOINT = "https://router.requesty.ai/v1/models/managed";
const MODELS_DIR = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "models",
);
const TOKENS_PER_MILLION = 1_000_000;
const PRICE_DECIMALS = 1_000_000;
// Documented shared values; xhigh is model-specific and not in the catalog API.
const REASONING_EFFORTS = ["none", "low", "medium", "high", "max"] as const;
const REGION_SUFFIX = /@[a-z0-9-]+$/i;
const ANTHROPIC_DOT_ZERO = /^claude-(?:opus|sonnet|haiku)-\d+$/;
const canonicalNameByID = new Map<string, string>();

// ========================================
// Schemas
// ========================================

const PricingBand = z
    .object({
        prompt_tokens_threshold: z.number(),
        input_price: z.number().nullish(),
        output_price: z.number().nullish(),
        cached_price: z.number().nullish(),
        caching_price: z.number().nullish(),
    })
    .passthrough();

export const RequestyModel = z
    .object({
        id: z.string().min(1),
        created: z.number(),
        description: z.string(),
        context_window: z.number(),
        max_output_tokens: z.number(),
        input_price: z.number().nullish(),
        output_price: z.number().nullish(),
        cached_price: z.number().nullish(),
        caching_price: z.number().nullish(),
        pricing: z.array(PricingBand).nullish(),
        supports_vision: z.boolean().default(false),
        supports_reasoning: z.boolean().default(false),
        supports_tool_calling: z.boolean().default(false),
        supports_output_json_schema: z.boolean().default(false),
    })
    .passthrough();

export const RequestyResponse = z
    .object({
        object: z.literal("list"),
        data: z.array(RequestyModel),
    })
    .passthrough();

export type RequestyModel = z.infer<typeof RequestyModel>;

// ========================================
// Util functions
// ========================================

// A file linked to its lab by hand keeps that base_model when the resolver has
// no match for the catalog ID. A curated status is kept: the catalog's
// `retires` date is not synced.
export function buildRequestyModel(
    model: RequestyModel,
    existing?: Pick<ExistingModel, "base_model" | "status" | "name">,
): SyncedModel {
    const toolCall = model.supports_tool_calling;
    const structuredOutput = model.supports_output_json_schema;
    const context = model.context_window;
    const limit = {
        context,
        output: model.max_output_tokens > 0 ? model.max_output_tokens : context,
    };
    const releaseDate = dateFromTimestamp(model.created);
    const cost = buildCost(model);
    const reasoning = model.supports_reasoning;

    const resolved = resolveRequestyBaseModel(model.id);
    const canonical = resolved ?? existing?.base_model;
    if (canonical !== undefined) {
        // A catalog output limit of 0 means unknown: inherit the lab's output
        // instead of the context-window fallback, unless the lab's exceeds the
        // context this route serves.
        const labOutput = (modelMetadata(canonical).limit as { output?: number } | undefined)?.output;
        const factoredLimit = model.max_output_tokens <= 0 && labOutput !== undefined && labOutput <= context
            ? { context }
            : limit;
        return factorBaseModel(
            canonical,
            {
                // A hand-linked route keeps its curated display name (e.g. a
                // context-limited variant); factorBaseModel drops it when it
                // equals the lab's.
                name: regionVariantName(model.id, canonical)
                    ?? (resolved === undefined ? existing?.name : undefined),
                reasoning,
                reasoning_options: reasoningOptions(reasoning),
                tool_call: toolCall,
                structured_output: structuredOutput,
                status: existing?.status,
                cost,
                limit: factoredLimit,
            },
            factoredLimit,
        );
    }

    const input: SyncedFullModel["modalities"]["input"] = model.supports_vision
        ? ["text", "image"]
        : ["text"];
    const output: SyncedFullModel["modalities"]["output"] = ["text"];

    return {
        name: model.id,
        description: model.description,
        family: inferFamily(model.id, model.id),
        release_date: releaseDate,
        last_updated: releaseDate,
        attachment: input.some((value) => value !== "text"),
        reasoning,
        reasoning_options: reasoningOptions(reasoning),
        tool_call: toolCall,
        structured_output: structuredOutput,
        open_weights: false,
        status: existing?.status,
        cost,
        limit,
        modalities: { input, output },
    } satisfies SyncedFullModel;
}

export function resolveRequestyBaseModel(id: string) {
    const bare = id.replace(REGION_SUFFIX, "");
    return (
        resolveModelMetadataBaseModel(bare) ??
        (bare.startsWith("claude-")
            ? resolveModelMetadataBaseModel(`anthropic/${bare}`)
            : undefined) ??
        (ANTHROPIC_DOT_ZERO.test(bare)
            ? resolveModelMetadataBaseModel(`${bare}-0`)
            : undefined)
    );
}

function regionVariantName(id: string, baseModel: string) {
    const region = REGION_SUFFIX.exec(id)?.[0].slice(1);
    if (region === undefined) return undefined;

    const canonicalName = canonicalModelName(baseModel);
    if (canonicalName === undefined) return id;
    return `${canonicalName} (${region.toUpperCase()})`;
}

function canonicalModelName(baseModel: string) {
    let cached = canonicalNameByID.get(baseModel);
    if (cached === undefined) {
        try {
            const toml = Bun.TOML.parse(
                readFileSync(
                    path.join(MODELS_DIR, `${baseModel}.toml`),
                    "utf8",
                ),
            ) as { name?: unknown };
            cached = typeof toml.name === "string" ? toml.name : "";
        } catch {
            cached = "";
        }
        canonicalNameByID.set(baseModel, cached);
    }
    return cached === "" ? undefined : cached;
}

function reasoningOptions(
    reasoning: boolean,
): SyncedFullModel["reasoning_options"] {
    if (!reasoning) {
        return;
    }

    // The synced OpenAI-compatible route exposes reasoning_effort, not a
    // separate budget_tokens control. Numeric efforts can be mapped to tiers.
    return [{ type: "effort", values: [...REASONING_EFFORTS] }];
}

function buildCost(model: RequestyModel): SyncedFullModel["cost"] {
    const base = model.pricing?.[0] ?? model;
    const input = base.input_price;
    const output = base.output_price;
    if (input == null || output == null) return undefined;

    const tiers = (model.pricing ?? []).slice(1).map((band) => ({
        tier: { type: "context" as const, size: band.prompt_tokens_threshold },
        input: pricePerMillion(band.input_price ?? input),
        output: pricePerMillion(band.output_price ?? output),
        cache_read: chargedPricePerMillion(band.cached_price),
        cache_write: chargedPricePerMillion(band.caching_price),
    }));
    return {
        input: pricePerMillion(input),
        output: pricePerMillion(output),
        cache_read: chargedPricePerMillion(base.cached_price),
        cache_write: chargedPricePerMillion(base.caching_price),
        tiers: tiers.length > 0 ? tiers : undefined,
    };
}

function chargedPricePerMillion(
    price: number | null | undefined,
): number | undefined {
    return price == null || price <= 0 ? undefined : pricePerMillion(price);
}

function pricePerMillion(price: number): number {
    return (
        Math.round(price * TOKENS_PER_MILLION * PRICE_DECIMALS) / PRICE_DECIMALS
    );
}

function dateFromTimestamp(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function inferFamily(id: string, name: string) {
    const kimiFamily = inferKimiFamily(id, name);
    if (kimiFamily !== undefined) return kimiFamily;

    const target = `${id} ${name}`.toLowerCase();
    return [...ModelFamilyValues]
        .sort((a, b) => b.length - a.length)
        .find((family) => {
            const value = family
                .toLowerCase()
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (family === "o") {
                return new RegExp(
                    `(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`,
                ).test(target);
            }
            return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(
                target,
            );
        });
}

// ========================================
// Requesty provider
// ========================================

export const requesty = {
    id: "requesty",
    name: "Requesty",
    modelsDir: "providers/requesty/models",
    preserveBaseModels: false,
    preserveDescriptions: false,
    async fetchModels() {
        const response = await fetch(API_ENDPOINT);
        if (!response.ok) {
            throw new Error(
                `Requesty request failed: ${response.status} ${response.statusText}`,
            );
        }
        return response.json();
    },
    parseModels(raw) {
        return RequestyResponse.parse(raw).data;
    },
    translateModel(model, context) {
        return {
            id: model.id,
            model: buildRequestyModel(model, context.existing(model.id)),
        };
    },
} satisfies SyncProvider<RequestyModel>;
