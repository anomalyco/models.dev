# @opencode-ai/models

Official typed client for the [Models.dev](https://models.dev) API.

```sh
npm install @opencode-ai/models
```

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

### Snapshot

A full copy of the database ships inside the package as a separate, tree-shakable entrypoint:

```ts
import snapshot, { providers, models, generatedAt } from "@opencode-ai/models/snapshot"

providers["anthropic"]?.models["claude-opus-4-6"]?.limit.context
```

Use it for no-network runtimes, tests, cold-start-sensitive paths, or as an explicit fallback:

```ts
const providers = await client.providers().catch(async () => (await import("@opencode-ai/models/snapshot")).providers)
```

The published snapshot is at most ~24h behind the live API (data releases are automated).

### Effect

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
