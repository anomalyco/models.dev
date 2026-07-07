# @opencode-ai/models

Official typed client for the [models.dev](https://models.dev) API — an open-source database of AI model capabilities, pricing, and limits.

```sh
npm install @opencode-ai/models
```

- **Zero dependencies.** The root client is a small `fetch` wrapper; works on Node ≥ 18, Bun, Deno, browsers, and edge runtimes.
- **Fully typed.** Hand-written types, verified in CI to be exactly equivalent to the schemas that generate the data.
- **Three entrypoints.** Promise client, [Effect](https://effect.website) client, and a bundled offline snapshot.

## Usage

```ts
import { Models } from "@opencode-ai/models"

const client = Models.make()

const providers = await client.providers() // GET /api.json
providers["anthropic"]?.models["claude-opus-4-6"]?.cost?.input // USD per 1M tokens

const models = await client.models() // GET /models.json
models["anthropic/claude-opus-4-6"]?.knowledge // provider-agnostic metadata

const catalog = await client.catalog() // GET /catalog.json — both in one request
```

| Method | Endpoint | Contents |
| --- | --- | --- |
| `providers()` | `/api.json` | Providers with their models, pricing, and limits |
| `models()` | `/models.json` | Provider-agnostic model metadata, keyed by `<lab>/<model>` |
| `catalog()` | `/catalog.json` | `{ providers, models }` in a single payload |

The client is **stateless**: every call performs exactly one GET, nothing is cached, and lookups are plain object access on the returned data. Cache however you like:

```ts
let cached: Promise<ProviderMap> | undefined
const providers = () => (cached ??= client.providers())
```

Options:

```ts
const client = Models.make({
  baseUrl: "https://models.dev", // default
  fetch: myFetch,                // proxies, polyfills, test doubles
  headers: { "x-extra": "1" },   // sent with every request
})

await client.providers({ signal: AbortSignal.timeout(5000) })
```

Errors are a single `ModelsDevError` with `reason: "Transport" | "UnexpectedStatus" | "MalformedResponse"` and the underlying `cause`.

## Offline snapshot

A full copy of the database ships inside the package as a separate, tree-shakable entrypoint — nothing from it is loaded or bundled unless you import it:

```ts
import snapshot, { providers, models, generatedAt } from "@opencode-ai/models/snapshot"

providers["anthropic"]?.models["claude-opus-4-6"]?.limit.context
```

Use it for no-network runtimes, tests, cold-start-sensitive paths, or as an explicit fallback:

```ts
const providers = await client.providers().catch(async () => (await import("@opencode-ai/models/snapshot")).providers)
```

Freshness: the published snapshot is at most ~24h behind the live API (data releases are automated). The client is the freshness path; the snapshot is the availability path.

## Effect

An Effect-native client lives at `@opencode-ai/models/effect` (requires the optional peer dependency `effect`):

```ts
import { Models } from "@opencode-ai/models/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const client = yield* Models.make()
  return yield* client.providers() // Effect<ProviderMap, ModelsDevError>
})

await program.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise)
```

Transport comes from the environment's `HttpClient` service, so proxies, retries, tracing, and test transports compose the usual Effect way. For DI, `Models.Service` and `Models.layer(options?)` are provided:

```ts
const program = Effect.gen(function* () {
  const client = yield* Models.Service
  return yield* client.models()
})

program.pipe(Effect.provide(Models.layer().pipe(Layer.provide(FetchHttpClient.layer))))
```

## Types

All data types are exported from the root (and re-exported from `/effect`): `Provider`, `Model`, `ModelMetadata`, `Catalog`, `Cost`, `Limit`, `ReasoningOption`, and friends.

## Contributing

The data lives as TOML files in [anomalyco/models.dev](https://github.com/anomalyco/models.dev) — corrections and new models/providers are welcome there. This package is generated and published from that repository.
