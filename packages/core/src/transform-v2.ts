import type { Model, Provider } from "./schema.js";
import type {
  ApiV2,
  CapabilitiesV2,
  CostV2,
  ExperimentalModeV2,
  ExperimentalV2,
  InputModalityV2,
  LimitV2,
  ModalitiesV2,
  ModelV2,
  OutputModalityV2,
  ProviderV2,
  ReasoningSupportV2,
  ToolsSupportV2,
} from "./schema-v2.js";

export function toProvidersV2(
  providers: Record<string, Provider>,
): Record<string, ProviderV2> {
  return Object.fromEntries(
    Object.entries(providers).map(([providerID, provider]) => [
      providerID,
      toProviderV2(provider),
    ]),
  );
}

export function toProviderV2(provider: Provider): ProviderV2 {
  return {
    id: provider.id,
    name: provider.name,
    doc: provider.doc,
    env: provider.env,
    models: Object.fromEntries(
      Object.entries(provider.models).map(([modelID, model]) => [
        modelID,
        toModelV2(model, provider),
      ]),
    ),
  };
}

export function toModelV2(model: Model, provider: Provider): ModelV2 {
  const cost = toCostV2(model.cost);
  const experimental = toExperimentalV2(model.experimental);

  return {
    id: model.id,
    ...(model.canonical_model_id !== undefined
      ? { canonical_id: model.canonical_model_id }
      : {}),
    type: model.type ?? "chat",
    name: model.name,
    description: model.description,
    ...(model.family !== undefined ? { family: model.family } : {}),
    open_weights: model.open_weights,
    ...(model.knowledge !== undefined ? { knowledge: model.knowledge } : {}),
    release_date: model.release_date,
    last_updated: model.last_updated,
    ...(model.status !== undefined ? { status: model.status } : {}),
    modalities: toModalitiesV2(model.modalities),
    capabilities: toCapabilitiesV2(model),
    limit: toLimitV2(model.limit),
    ...(cost !== undefined ? { cost } : {}),
    api: toApiV2(model, provider),
    ...(experimental !== undefined ? { experimental } : {}),
  };
}

function toModalitiesV2(modalities: Model["modalities"]): ModalitiesV2 {
  return {
    input: modalities.input.map(
      (modality): InputModalityV2 =>
        modality === "pdf" ? "application/pdf" : modality,
    ),
    output: modalities.output.map(
      (modality): OutputModalityV2 =>
        modality === "pdf" ? "application/pdf" : modality,
    ),
  };
}

function toCapabilitiesV2(model: Model): CapabilitiesV2 {
  const tools: ToolsSupportV2 = model.tool_call
    ? { supported: true }
    : { supported: false };

  return {
    tools,
    reasoning: toReasoningSupportV2(model),
    ...(model.structured_output !== undefined
      ? { structured_output: model.structured_output }
      : {}),
    ...(model.temperature !== undefined
      ? { temperature: model.temperature }
      : {}),
  };
}

function toReasoningSupportV2(model: Model): ReasoningSupportV2 {
  if (!model.reasoning) {
    return { supported: false };
  }

  const options = model.reasoning_options ?? [];
  const hasToggle = options.some((option) => option.type === "toggle");
  const effortOption = options.find((option) => option.type === "effort");
  const budgetOption = options.find(
    (option) => option.type === "budget_tokens",
  );

  return {
    supported: true,
    ...(hasToggle ? { toggle: true } : {}),
    ...(effortOption !== undefined
      ? {
          effort: effortOption.values.map((value) =>
            value === null ? "default" : value,
          ),
        }
      : {}),
    ...(budgetOption !== undefined
      ? {
          budget: {
            ...(budgetOption.min !== undefined ? { min: budgetOption.min } : {}),
            ...(budgetOption.max !== undefined ? { max: budgetOption.max } : {}),
          },
        }
      : {}),
  };
}

function toLimitV2(limit: Model["limit"]): LimitV2 {
  return {
    context: limit.context,
    ...(limit.input !== undefined ? { input: limit.input } : {}),
    output: limit.output,
  };
}

function toCostV2(cost: Model["cost"]): CostV2 | undefined {
  if (cost === undefined) return undefined;
  const { context_over_200k: _legacy, ...rest } = cost;
  return rest;
}

function toExperimentalV2(
  experimental: Model["experimental"],
): ExperimentalV2 | undefined {
  if (experimental === undefined) return undefined;
  const modes = experimental.modes
    ? Object.fromEntries(
        Object.entries(experimental.modes).map(([modeName, mode]) => {
          const entry: ExperimentalModeV2 = {
            ...(mode.cost !== undefined ? { cost: toCostV2(mode.cost) } : {}),
            ...(mode.provider?.body !== undefined
              ? { body: mode.provider.body }
              : {}),
            ...(mode.provider?.headers !== undefined
              ? { headers: mode.provider.headers }
              : {}),
          };
          return [modeName, entry];
        }),
      )
    : undefined;

  return {
    ...(modes !== undefined ? { modes } : {}),
  };
}

function toApiV2(_model: Model, _provider: Provider): ApiV2 {
  // Populated by API protocol mapping
  return {} as ApiV2;
}
