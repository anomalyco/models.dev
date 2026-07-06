import { ModelsDevError } from "./error.js"
import type { Catalog, ModelMetadataMap, ProviderMap } from "./types.js"

/** Accepted anywhere headers can be passed. Same shapes as the standard `HeadersInit`. */
export type HeadersInput = Headers | Record<string, string> | Array<[string, string]>

export interface ClientOptions {
  /** Base URL of the models.dev deployment. Defaults to `https://models.dev`. */
  readonly baseUrl?: string
  /**
   * Custom `fetch` implementation (proxies, polyfills, test doubles).
   * Resolved lazily at request time, so late-installed polyfills work.
   * Defaults to `globalThis.fetch`.
   */
  readonly fetch?: typeof globalThis.fetch
  /** Extra headers sent with every request. */
  readonly headers?: HeadersInput
}

export interface RequestOptions {
  readonly signal?: AbortSignal
  /** Extra headers for this request. Overrides client-level headers. */
  readonly headers?: HeadersInput
}

/**
 * Creates a stateless models.dev client. Every method performs exactly one
 * `GET` and nothing is ever cached — callers who want caching should wrap
 * calls with their own policy. For a no-network alternative, see the
 * `@opencode-ai/models/snapshot` entrypoint.
 */
export function make(options: ClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "https://models.dev"
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"

  const request = async <A>(path: string, requestOptions?: RequestOptions): Promise<A> => {
    const fetch = options.fetch ?? globalThis.fetch
    const headers = new Headers()
    for (const [key, value] of new Headers(options.headers)) headers.set(key, value)
    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)

    let response: Response
    try {
      response = await fetch(new URL(path, base), {
        method: "GET",
        headers,
        signal: requestOptions?.signal,
      })
    } catch (cause) {
      throw new ModelsDevError("Transport", { cause })
    }
    if (!response.ok) {
      try {
        await response.body?.cancel()
      } catch {}
      throw new ModelsDevError("UnexpectedStatus", { cause: { status: response.status } })
    }
    let text: string
    try {
      text = await response.text()
    } catch (cause) {
      throw new ModelsDevError("Transport", { cause })
    }
    if (text === "") throw new ModelsDevError("MalformedResponse")
    try {
      return JSON.parse(text) as A
    } catch (cause) {
      throw new ModelsDevError("MalformedResponse", { cause })
    }
  }

  return {
    /** All providers with their models, pricing, and limits (`/api.json`). */
    providers: (requestOptions?: RequestOptions) => request<ProviderMap>("api.json", requestOptions),
    /** Provider-agnostic model metadata (`/models.json`). */
    models: (requestOptions?: RequestOptions) => request<ModelMetadataMap>("models.json", requestOptions),
    /** Providers and model metadata in a single request (`/catalog.json`). */
    catalog: (requestOptions?: RequestOptions) => request<Catalog>("catalog.json", requestOptions),
  }
}

export type ModelsClient = ReturnType<typeof make>
