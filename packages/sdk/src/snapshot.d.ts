import type { Catalog, ModelMetadataMap, ProviderMap } from "./index.js"

/** All providers with their models, pricing, and limits. Same shape as `client.providers()`. */
export declare const providers: ProviderMap

/** Provider-agnostic model metadata keyed by canonical model ID. Same shape as `client.models()`. */
export declare const models: ModelMetadataMap

/** ISO timestamp of when this snapshot was generated from the models.dev repository. */
export declare const generatedAt: string

/** The full catalog: `{ providers, models }`. Same shape as `client.catalog()`. */
declare const snapshot: Catalog
export default snapshot
