import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
	ExistingModel,
	SyncProvider,
	SyncedFullModel,
	SyncedModel,
} from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const INTL_API_ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/models";
const API_PAGE_SIZE = 100;
const MODELS_DIR = path.join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"..",
	"models",
);
const modelMetadataByID = new Map<string, Record<string, unknown>>();
function baseModelMetadata(modelID: string): Record<string, unknown> {
	let metadata = modelMetadataByID.get(modelID);
	if (metadata === undefined) {
		metadata = Bun.TOML.parse(
			readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8"),
		) as Record<string, unknown>;
		modelMetadataByID.set(modelID, metadata);
	}
	return metadata;
}
function baseModelMetadataExists(modelID: string): boolean {
	return existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

const AlibabaPrice = z
	.object({
		type: z.string(),
		price: z.string(),
		price_unit: z.string(),
		price_name: z.string(),
	})
	.passthrough();

const AlibabaPriceRange = z
	.object({
		range_name: z.string(),
		prices: z.array(AlibabaPrice),
	})
	.passthrough();

const AlibabaModelInfo = z
	.object({
		context_window: z.number().int().nonnegative().nullable(),
		max_input_tokens: z.number().int().nonnegative().nullable(),
		max_output_tokens: z.number().int().nonnegative().nullable(),
		max_reasoning_tokens: z.number().int().nonnegative().nullable(),
		reasoning_max_input_tokens: z.number().int().nonnegative().nullable(),
		reasoning_max_output_tokens: z.number().int().nonnegative().nullable(),
	})
	.passthrough();

const AlibabaInferenceMetadata = z
	.object({
		request_modality: z.array(z.string()).optional(),
		response_modality: z.array(z.string()).optional(),
	})
	.passthrough();

const AlibabaModel = z
	.object({
		model: z.string(),
		name: z.string(),
		description: z.string(),
		features: z.array(z.string()),
		prices: z.array(AlibabaPriceRange),
		provider: z.string().nullable(),
		capabilities: z.array(z.string()),
		published_time: z.string(),
		inference_metadata: AlibabaInferenceMetadata,
		model_info: AlibabaModelInfo,
	})
	.passthrough();

const AlibabaCatalogResponse = z
	.object({
		code: z.string().nullable(),
		message: z.string().nullable(),
		success: z.boolean(),
		output: z
			.object({
				total: z.number().int().nonnegative(),
				page_no: z.number().int().positive(),
				page_size: z.number().int().positive(),
				models: z.array(AlibabaModel),
			})
			.passthrough(),
	})
	.passthrough();

export type AlibabaModel = z.infer<typeof AlibabaModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

type Cost = NonNullable<ExistingModel["cost"]>;
type CostTier = NonNullable<Cost["tiers"]>[number];

interface AlibabaProviderOptions {
	id: string;
	name: string;
	modelsDir: string;
	apiEndpoint: string;
	apiKeyEnv: string;
	deploymentName: string;
}

export const alibaba = createAlibabaProvider({
	id: "alibaba",
	name: "Alibaba",
	modelsDir: "providers/alibaba/models",
	apiEndpoint: INTL_API_ENDPOINT,
	apiKeyEnv: "DASHSCOPE_API_KEY",
	deploymentName: "international",
});

export function createAlibabaProvider(
	options: AlibabaProviderOptions,
): SyncProvider<AlibabaModel> {
	return {
		id: options.id,
		name: options.name,
		modelsDir: options.modelsDir,
		skipCreates: true,
		deleteMissing: false,
		sourceID(model) {
			return model.model;
		},
		skippedNotice(ids) {
			if (ids.length === 0) return [];
			return [
				`${ids.length} Alibaba models returned by the source were not created because the source does not provide enough curated catalog metadata for new entries. Existing models are still updated from source-authoritative fields.`,
				`Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
			];
		},
		missingNotice(paths) {
			if (paths.length === 0) return [];
			return [
				`${paths.length} local Alibaba model files were retained even though they were missing from the source. This is intentional because the current source snapshot is for the ${options.deploymentName} deployment and the provider directory still contains deprecated or region-specific entries.`,
				`Retained local files: ${paths.map((path) => `\`${path}\``).join(", ")}`,
			];
		},
		async fetchModels() {
			const apiKey = process.env[options.apiKeyEnv];
			if (apiKey === undefined || apiKey.length === 0) {
				throw new Error(
					`${options.apiKeyEnv} is required to sync ${options.name} models`,
				);
			}

			const first = await fetchModelsPage(options.apiEndpoint, apiKey, 1);
			const models = [...first.output.models];
			const totalPages = Math.ceil(first.output.total / first.output.page_size);

			for (
				let pageNo = first.output.page_no + 1;
				pageNo <= totalPages;
				pageNo++
			) {
				const page = await fetchModelsPage(options.apiEndpoint, apiKey, pageNo);
				models.push(...page.output.models);
			}

			return {
				...first,
				output: {
					...first.output,
					models,
				},
			};
		},
		parseModels(raw) {
			const models = AlibabaCatalogResponse.parse(raw).output.models;
			const seen = new Set<string>();
			const deduped: AlibabaModel[] = [];

			for (const model of models) {
				if (seen.has(model.model)) continue;
				seen.add(model.model);
				deduped.push(model);
			}

			return deduped;
		},
		translateModel(model, context) {
			const existing = context.existing(model.model);
			if (existing === undefined) {
				// Creation: no provider TOML but base-model metadata exists → mint a
				// thin provider TOML (base_model + API cost only). `options.id` is the
				// base metadata dir prefix (models/<id>/<model>.toml). Skip unless the
				// API exposes usable pricing — `cost` is required and not inherited.
				const baseModelID = `${options.id}/${model.model}`;
				if (!baseModelMetadataExists(baseModelID)) return undefined;
				const stub = { base_model: baseModelID };
				if (cost(model, stub) === undefined) return undefined;
				return { id: model.model, model: buildAlibabaModel(model, stub) };
			}
			return {
				id: model.model,
				model: buildAlibabaModel(model, existing),
			};
		},
	};
}

async function fetchModelsPage(
	apiEndpoint: string,
	apiKey: string,
	pageNo: number,
) {
	const url = new URL(apiEndpoint);
	url.searchParams.set("page_no", String(pageNo));
	url.searchParams.set("page_size", String(API_PAGE_SIZE));

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Alibaba model catalog request failed: ${response.status} ${response.statusText}: ${body}`,
		);
	}

	const page = AlibabaCatalogResponse.parse(await response.json());
	if (!page.success) {
		throw new Error(
			`Alibaba model catalog request failed: ${page.code ?? "unknown"}: ${page.message ?? "unknown error"}`,
		);
	}
	return page;
}

function price(prices: z.infer<typeof AlibabaPrice>[], ...types: string[]) {
	for (const type of types) {
		const value = prices.find((price) => price.type === type);
		if (value !== undefined) return Number(value.price);
	}
	return undefined;
}

function dateFromPublishedTime(value: string) {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	return match?.[1];
}

function normalizedModalities(values: string[] | undefined) {
	const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
	return [
		...new Set(
			(values ?? [])
				.map((value) => value.toLowerCase())
				.filter((value): value is Modality => allowed.has(value as Modality)),
		),
	];
}

function costFromPrices(
	prices: z.infer<typeof AlibabaPrice>[],
	existing: Cost | undefined,
): Cost | undefined {
	const input = price(
		prices,
		"input_token",
		"text_input_token",
		"vision_input_token",
		"translate_vision_input_token",
		"embedding_token",
		// DashScope renamed the text/image/video input bucket to `omni_no_audio_input_token`
		// in the qwen3.5 omni series (qwen3.5-omni-{flash,plus} + realtime). Old omni models
		// still report `text_input_token`, so this falls through cleanly for them.
		"omni_no_audio_input_token",
	);
	const output = price(
		prices,
		"output_token",
		"purein_text_output_token",
		"multiin_text_output_token",
		"translate_multi_text_output_token",
		// DashScope renamed the text-only output bucket to `omni_no_audio_output_token`
		// in the qwen3.5 omni series. The audio-only output bucket is `omni_audio_output_token`
		// (handled below in `output_audio`).
		"omni_no_audio_output_token",
	);
	const imageOutput = price(
		prices,
		"image_number",
		"image_standard",
		"image_thinking",
	);
	const duration = price(prices, "content_duration");
	const tts = price(prices, "cosy_tts_number");
	// Guard-only: imageOutput/duration/tts are never written — the Cost schema is
	// token-centric and has no field for per-image (`image_number`), per-second
	// (`content_duration`), or per-char TTS (`cosy_tts_number`) pricing. They exist
	// solely to suppress this early-return so the `?? existing` fallback below can
	// preserve the hand-curated token cost for non-token-priced models. Without
	// them, e.g. qwen3-asr-flash (API: `content_duration` only) returns undefined
	// → requireExisting("cost") throws → sync crashes.
	if (
		input === undefined &&
		output === undefined &&
		imageOutput === undefined &&
		duration === undefined &&
		tts === undefined
	) {
		return undefined;
	}

	return {
		input: input ?? existing?.input ?? 0,
		output: output ?? existing?.output ?? 0,
		reasoning: price(prices, "thinking_output_token") ?? existing?.reasoning,
		// API-only, no `?? existing` fallback: DashScope reliably exposes cache price types;
		// omission is intentional.
		cache_read: price(
			prices,
			"input_token_cache",
			"thinking_input_token_cache",
			"input_token_cache_read",
		),
		cache_write: price(
			prices,
			"input_token_cache_creation_5m",
			"thinking_input_token_cache_creation_5m",
		),
		// audio price-type names vary across omni generations.
		input_audio:
			price(
				prices,
				"audio_input_token",
				"omni_audio_input_token",
				"translate_audio_input_token",
				"thinking_audio_input_token",
			) ?? existing?.input_audio,
		output_audio:
			price(
				prices,
				"multi_output_token",
				"omni_audio_output_token",
				"translate_multi_output_token",
			) ?? existing?.output_audio,
	};
}

function tierLowerBound(rangeName: string) {
	if (/^(Default|Input\s*<=|输入\s*<=)/i.test(rangeName)) return 0;

	const match = /([0-9]+)\s*k\s*<\s*(?:Input|输入)/i.exec(rangeName);
	if (match !== null) return Number(match[1]) * 1000;

	return undefined;
}

function cost(model: AlibabaModel, existing: ExistingModel) {
	const ranges = model.prices
		.map((range) => ({
			lowerBound: tierLowerBound(range.range_name),
			cost: costFromPrices(range.prices, existing.cost),
		}))
		.filter((range): range is { lowerBound: number; cost: Cost } => {
			return range.lowerBound !== undefined && range.cost !== undefined;
		})
		.sort((left, right) => left.lowerBound - right.lowerBound);

	if (ranges.length === 0) return existing.cost;

	const base = ranges[0]!.cost;
	// Build the API-derived tiers. Each tier carries its `lowerBound` as `size` —
	// a tier with `size: N` covers `N < context <= (next tier's size, or model
	// context_window)`. The base rate (the smallest range) is intentionally NOT
	// included here; it lives at the top level of `cost` so consumers can read
	// the default rate without indexing into `tiers[0]`.
	const aboveBase = ranges.slice(1);
	const apiTiers = aboveBase.map(
		(range): CostTier => ({
			tier: { type: "context", size: range.lowerBound },
			...range.cost,
		}),
	);
	// API is the source of truth for tiers; hand-curated TOML tiers are never preserved.
	const tiers = apiTiers.length > 0 ? apiTiers : undefined;

	return {
		...base,
		tiers,
	};
}

function limit(model: AlibabaModel, existing: ExistingModel) {
	if (existing.limit === undefined) return undefined;

	return {
		input: existing.limit.input,
		context: model.model_info.context_window ?? existing.limit.context,
		output: model.model_info.max_output_tokens ?? existing.limit.output,
	};
}

function modalities(model: AlibabaModel, existing: ExistingModel) {
	if (existing.modalities === undefined) return undefined;

	const input = normalizedModalities(model.inference_metadata.request_modality);
	// DashScope does not surface `pdf` in `inference_metadata.request_modality`, but vision-understanding
	// models accept PDF inputs (the underlying VL stack parses document pages as images).
	// See: https://www.alibabacloud.com/help/en/model-studio/vision-model/?spm=a2c63.p38356.help-menu-2400256.d_0_3_1.46b16feaB6sCxE
	if (model.capabilities.includes("VU") && !input.includes("pdf")) {
		input.push("pdf");
	}

	const output = normalizedModalities(
		model.inference_metadata.response_modality,
	);

	return {
		input: input.length > 0 ? input : existing.modalities.input,
		output: output.length > 0 ? output : existing.modalities.output,
	};
}

function requireExisting<T>(
	model: AlibabaModel,
	field: string,
	value: T | undefined,
): T {
	if (value === undefined) {
		throw new Error(
			`Alibaba model ${model.model} has incomplete local TOML metadata required for sync: ${field}`,
		);
	}
	return value;
}

export function buildAlibabaModel(
	model: AlibabaModel,
	existing: ExistingModel,
): SyncedModel {
	const publishedDate = dateFromPublishedTime(model.published_time);
	const translatedModalities = modalities(model, existing);
	const translatedCost = cost(model, existing);
	const translatedLimit = limit(model, existing);

	if (existing.base_model !== undefined) {
		// Reasoning models must carry a `reasoning_options` block (≥ []); default to
		// [] when neither the provider TOML nor base metadata supply one. Inherited
		// reasoning_options (from base metadata) are left to factorBaseModel.
		const baseMetadata = baseModelMetadata(existing.base_model);
		const resolvedReasoning =
			existing.reasoning ?? baseMetadata.reasoning === true;
		const reasoningOptions =
			existing.reasoning_options ??
			(resolvedReasoning && baseMetadata.reasoning_options === undefined
				? []
				: undefined);
		// factorBaseModel's required 3rd arg feeds baseModelOmit(), which reads
		// limit.input/context and throws on undefined. Use the translated limit, or
		// the base limit when the TOML declares none (thin stub inherits verbatim,
		// no omit). Matches the other factorBaseModel callers — no requireExisting.
		const baseLimit = baseMetadata.limit as
			| SyncedFullModel["limit"]
			| undefined;
		const limitForOmit = (translatedLimit ??
			baseLimit ??
			{}) as SyncedFullModel["limit"];
		return factorBaseModel(
			existing.base_model,
			{
				name: existing.name,
				family: existing.family,
				release_date: existing.release_date,
				last_updated: existing.last_updated,
				attachment: existing.attachment,
				reasoning: existing.reasoning,
				reasoning_options: reasoningOptions,
				temperature: existing.temperature,
				tool_call: existing.tool_call,
				structured_output: existing.structured_output,
				knowledge: existing.knowledge,
				open_weights: existing.open_weights,
				status: existing.status,
				interleaved: existing.interleaved,
				cost: translatedCost,
				limit: translatedLimit,
				modalities: translatedModalities,
			},
			limitForOmit,
			existing.base_model_omit,
		);
	}

	return {
		name: existing.name ?? model.name,
		family: requireExisting(model, "family", existing.family),
		release_date:
			existing.release_date ??
			requireExisting(model, "published_time", publishedDate),
		last_updated:
			existing.last_updated ??
			requireExisting(model, "published_time", publishedDate),
		attachment:
			existing.attachment ??
			translatedModalities?.input.some((value) => value !== "text") ??
			false,
		reasoning: existing.reasoning ?? model.capabilities.includes("Reasoning"),
		// DashScope's catalog blob exposes `capabilities: ["Reasoning"]` but no per-model
		// reasoning controls (no enable_thinking toggle, no effort levels, no budget knob).
		// The team hand-curates real `reasoning_options` (e.g. qwen3.5-plus) when the inference
		// API documents the controls; otherwise default to `[]` so reasoning models still get
		// a non-undefined `reasoning_options` block.
		reasoning_options:
			existing.reasoning_options ??
			((existing.reasoning ?? model.capabilities.includes("Reasoning"))
				? []
				: undefined),
		temperature: requireExisting(model, "temperature", existing.temperature),
		tool_call:
			existing.tool_call ?? model.features.includes("function-calling"),
		structured_output:
			existing.structured_output ??
			model.features.includes("structured-outputs"),
		knowledge: existing.knowledge,
		open_weights: requireExisting(model, "open_weights", existing.open_weights),
		status: existing.status,
		interleaved: existing.interleaved,
		cost: requireExisting(model, "cost", translatedCost),
		limit: requireExisting(model, "limit", translatedLimit),
		modalities: requireExisting(model, "modalities", translatedModalities),
	};
}
