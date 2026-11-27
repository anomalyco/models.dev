export const MODEL_TYPES = [
  "chat",
  "image",
  "video",
  "embedding",
  "reranking",
  "decision",
  "transcription",
  "speech",
  "realtime",
] as const;

export type ModelTypeValue = (typeof MODEL_TYPES)[number];
export type ModelTypeFilter = "default" | "all" | ModelTypeValue[];

interface TypedModel {
  type?: string;
}

interface TypedProvider {
  models: Record<string, TypedModel>;
}

// The type combinations opencode clients ask the v2 API for. Each is built as its own file, so the Worker
// serves it directly instead of parsing and filtering the whole catalog on every request. A released client
// keeps asking for its combination, so only add to this list.
export const PREBUILT_TYPE_SETS: readonly (readonly ModelTypeValue[])[] = [
  ["chat", "decision", "image"],
  ["chat", "decision", "image", "video"],
  ["chat", "decision", "image", "video", "realtime"],
  ["chat", "decision", "image", "video", "realtime", "embedding", "transcription"],
];

// The file suffix for a set of types, whatever order a request names them in.
export function typeSetSuffix(types: readonly ModelTypeValue[]) {
  return `-${[...types].sort().join("-")}`;
}

// The suffix of the prebuilt v2 file for several types, when there is one.
export function prebuiltTypeSetSuffix(types: readonly ModelTypeValue[]) {
  const suffix = typeSetSuffix(types);
  return PREBUILT_TYPE_SETS.some((set) => typeSetSuffix(set) === suffix)
    ? suffix
    : undefined;
}

export class InvalidModelTypeError extends Error {
  constructor(value: string) {
    super(`Invalid type value: ${value}`);
    this.name = "InvalidModelTypeError";
  }
}

export function parseModelTypes(value: string | null): ModelTypeFilter {
  if (value === null || value === "") return "default";
  if (value === "all") return "all";

  const types = value.split(",");
  if (
    types.length === 0 ||
    types.includes("all") ||
    types.some((type) => !MODEL_TYPES.includes(type as ModelTypeValue))
  ) {
    throw new InvalidModelTypeError(value);
  }

  return [...new Set(types)] as ModelTypeValue[];
}

function includesModel(model: TypedModel, filter: ModelTypeFilter) {
  if (filter === "all") return true;
  const type = model.type ?? "chat";
  if (filter === "default") return type !== "decision";
  return filter.includes(type as ModelTypeValue);
}

export function filterProvidersByModelType<
  T extends Record<string, TypedProvider>,
>(providers: T, filter: ModelTypeFilter): T {
  if (filter === "all") return providers;

  return Object.fromEntries(
    Object.entries(providers).flatMap(([providerID, provider]) => {
      const models = Object.fromEntries(
        Object.entries(provider.models).filter(([, model]) =>
          includesModel(model, filter),
        ),
      );
      return Object.keys(models).length === 0
        ? []
        : [[providerID, { ...provider, models }]];
    }),
  ) as T;
}

export function filterModelsByModelType<T extends Record<string, TypedModel>>(
  models: T,
  filter: ModelTypeFilter,
): T {
  if (filter === "all") return models;
  return Object.fromEntries(
    Object.entries(models).filter(([, model]) => includesModel(model, filter)),
  ) as T;
}

export function filterCatalogByModelType<
  TProviders extends Record<string, TypedProvider>,
  TModels extends Record<string, TypedModel>,
>(
  catalog: { providers: TProviders; models: TModels },
  filter: ModelTypeFilter,
): { providers: TProviders; models: TModels } {
  return {
    providers: filterProvidersByModelType(catalog.providers, filter),
    models: filterModelsByModelType(catalog.models, filter),
  };
}
