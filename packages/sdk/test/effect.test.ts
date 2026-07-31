import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Models, ModelsDevError } from "../src/effect.js"

function stubResponse(body: BodyInit | null, init?: ResponseInit) {
  const requests: Request[] = []
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], requestInit?: RequestInit) => {
    requests.push(new Request(input instanceof URL ? input.href : (input as string), requestInit))
    return new Response(body, {
      headers: { "content-type": "application/json" },
      ...init,
    })
  }) as typeof globalThis.fetch
  const layer = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetch)))
  return { requests, layer }
}

function stub(data: unknown, init?: ResponseInit) {
  return stubResponse(JSON.stringify(data), init)
}

test("providers() succeeds through an injected transport", async () => {
  const { requests, layer } = stub({ anthropic: { id: "anthropic" } })
  const program = Effect.gen(function* () {
    const client = yield* Models.make()
    return yield* client.providers()
  })
  const result = await program.pipe(Effect.provide(layer), Effect.runPromise)
  expect(result["anthropic"]?.id).toBe("anthropic")
  expect(requests[0]?.url).toBe("https://models.dev/api.json")
  expect(requests[0]?.headers.get("user-agent")).toBeNull()
})

test("models() and catalog() hit their endpoints, baseUrl subpath preserved", async () => {
  const { requests, layer } = stub({})
  const program = Effect.gen(function* () {
    const client = yield* Models.make({ baseUrl: "https://example.com/mirror" })
    yield* client.models()
    yield* client.catalog()
  })
  await program.pipe(Effect.provide(layer), Effect.runPromise)
  expect(requests.map((request) => request.url)).toEqual([
    "https://example.com/mirror/models.json",
    "https://example.com/mirror/catalog.json",
  ])
})

test("custom headers are sent", async () => {
  const { requests, layer } = stub({})
  const program = Effect.gen(function* () {
    const client = yield* Models.make({ headers: { "x-custom": "yes" } })
    yield* client.providers()
  })
  await program.pipe(Effect.provide(layer), Effect.runPromise)
  expect(requests[0]?.headers.get("x-custom")).toBe("yes")
})

test("non-2xx fails with ModelsDevError in the error channel", async () => {
  const { layer } = stub({ error: "down" }, { status: 503 })
  const program = Effect.gen(function* () {
    const client = yield* Models.make()
    return yield* client.providers()
  })
  const error = await program.pipe(Effect.flip, Effect.provide(layer), Effect.runPromise)
  expect(error).toBeInstanceOf(ModelsDevError)
  expect(error._tag).toBe("ModelsDevError")
})

test("empty body fails with ModelsDevError", async () => {
  const { layer } = stubResponse("")
  const program = Effect.gen(function* () {
    const client = yield* Models.make()
    return yield* client.providers()
  })
  const error = await program.pipe(Effect.flip, Effect.provide(layer), Effect.runPromise)
  expect(error).toBeInstanceOf(ModelsDevError)
  expect(error._tag).toBe("ModelsDevError")
})

test("Service and layer provide a shared client", async () => {
  const { requests, layer } = stub({ "openai/gpt-oss-120b": { id: "openai/gpt-oss-120b" } })
  const program = Effect.gen(function* () {
    const client = yield* Models.Service
    return yield* client.models()
  })
  const result = await program.pipe(
    Effect.provide(Models.layer().pipe(Layer.provide(layer))),
    Effect.runPromise,
  )
  expect(result["openai/gpt-oss-120b"]?.id).toBe("openai/gpt-oss-120b")
  expect(requests.length).toBe(1)
})
