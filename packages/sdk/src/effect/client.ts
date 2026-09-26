import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import type { Catalog, ModelMetadataMap, ModelType, ProviderMap } from "../types.js"

/** The only error in the failure channel of client methods. Wraps the underlying `HttpClientError` as `cause`. */
export class ModelsDevError extends Schema.TaggedErrorClass<ModelsDevError>()("ModelsDevError", {
  cause: Schema.Defect(),
}) {}

export interface ClientOptions {
  /** Base URL of the models.dev deployment. Defaults to `https://models.dev`. */
  readonly baseUrl?: string
  /** Extra headers sent with every request. */
  readonly headers?: Record<string, string>
}

export interface RequestOptions {
  /** Specialized model types to include. Omit for standard models; use `"all"` for the complete catalog. */
  readonly modelTypes?: "all" | readonly ModelType[]
}

/**
 * Creates a stateless models.dev client on top of the `HttpClient` service
 * from the environment (`FetchHttpClient.layer`, `NodeHttpClient.layer`, or a
 * custom transport). Nothing is ever cached — compose `Effect.cached` /
 * `Effect.cachedWithTTL` around calls for caching.
 */
export const make = (options?: ClientOptions) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const baseUrl = options?.baseUrl ?? "https://models.dev"
    const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"

    const get = <A>(path: string, requestOptions?: RequestOptions): Effect.Effect<A, ModelsDevError> => {
      const url = new URL(path, base)
      const modelTypes = requestOptions?.modelTypes
      if (modelTypes === "all") {
        url.searchParams.set("type", "all")
      } else if (modelTypes && modelTypes.length > 0) {
        url.searchParams.set("type", modelTypes.join(","))
      }

      return http
        .get(url, {
          headers: options?.headers,
        })
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.map((data) => data as A),
          Effect.mapError((cause) => new ModelsDevError({ cause })),
        )
    }

    return {
      /** All providers with their models, pricing, and limits (`/api.json`). */
      providers: (options?: RequestOptions) => get<ProviderMap>("api.json", options),
      /** Provider-agnostic model metadata (`/models.json`). */
      models: (options?: RequestOptions) => get<ModelMetadataMap>("models.json", options),
      /** Providers and model metadata in a single request (`/catalog.json`). */
      catalog: (options?: RequestOptions) => get<Catalog>("catalog.json", options),
    }
  })

export type ModelsClient = Effect.Success<ReturnType<typeof make>>

/** Service key for dependency-injecting a shared client: `yield* Models.Service`. */
export class Service extends Context.Service<Service, ModelsClient>()("@opencode-ai/models/Models") {}

/** Layer providing `Models.Service`; requires an `HttpClient` in the environment. */
export const layer = (options?: ClientOptions) => Layer.effect(Service)(make(options))
