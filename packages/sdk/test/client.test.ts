import { expect, test } from "bun:test"
import { Models, ModelsDevError } from "../src/index.js"

interface Call {
  url: URL
  init: RequestInit
}

function stub(data: unknown, init?: ResponseInit) {
  const calls: Call[] = []
  const fetch = (async (input: unknown, requestInit?: RequestInit) => {
    calls.push({ url: input as URL, init: requestInit ?? {} })
    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
      ...init,
    })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

function headers(call: Call) {
  return new Headers(call.init.headers)
}

test("providers() GETs /api.json with the default base URL", async () => {
  const providers = { anthropic: { id: "anthropic" } }
  const { calls, fetch } = stub(providers)
  const client = Models.make({ fetch })
  const result = await client.providers()
  expect(result).toEqual(providers as never)
  expect(calls[0]?.url.href).toBe("https://models.dev/api.json")
  expect(calls[0]?.init.method).toBe("GET")
})

test("models() and catalog() hit their endpoints", async () => {
  const { calls, fetch } = stub({})
  const client = Models.make({ fetch })
  await client.models()
  await client.catalog()
  expect(calls.map((call) => call.url.href)).toEqual(["https://models.dev/models.json", "https://models.dev/catalog.json"])
})

test("baseUrl with subpath is preserved, with or without trailing slash", async () => {
  const { calls, fetch } = stub({})
  await Models.make({ fetch, baseUrl: "https://example.com/mirror" }).providers()
  await Models.make({ fetch, baseUrl: "https://example.com/mirror/" }).providers()
  expect(calls.map((call) => call.url.href)).toEqual([
    "https://example.com/mirror/api.json",
    "https://example.com/mirror/api.json",
  ])
})

test("does not add headers by default", async () => {
  const { calls, fetch } = stub({})
  await Models.make({ fetch }).providers()
  expect([...headers(calls[0]!).entries()]).toEqual([])
})

test("request headers override client headers", async () => {
  const { calls, fetch } = stub({})
  const client = Models.make({ fetch, headers: { "user-agent": "custom", "x-one": "client", "x-two": "client" } })
  await client.providers({ headers: { "x-two": "request" } })
  const sent = headers(calls[0]!)
  expect(sent.get("user-agent")).toBe("custom")
  expect(sent.get("x-one")).toBe("client")
  expect(sent.get("x-two")).toBe("request")
})

test("abort signal is passed through", async () => {
  const { calls, fetch } = stub({})
  const controller = new AbortController()
  await Models.make({ fetch }).providers({ signal: controller.signal })
  expect(calls[0]?.init.signal).toBe(controller.signal)
})

test("stateless: every call fetches again", async () => {
  const { calls, fetch } = stub({})
  const client = Models.make({ fetch })
  await client.providers()
  await client.providers()
  expect(calls.length).toBe(2)
})

test("network failure throws Transport with cause", async () => {
  const failure = new Error("boom")
  const client = Models.make({
    fetch: (() => Promise.reject(failure)) as unknown as typeof globalThis.fetch,
  })
  const error = await client.providers().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(ModelsDevError)
  expect((error as ModelsDevError).reason).toBe("Transport")
  expect((error as ModelsDevError).cause).toBe(failure)
})

test("non-2xx throws UnexpectedStatus with the status in cause", async () => {
  const { fetch } = stub({ message: "not found" }, { status: 404 })
  const error = await Models.make({ fetch }).providers().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(ModelsDevError)
  expect((error as ModelsDevError).reason).toBe("UnexpectedStatus")
  expect((error as ModelsDevError).cause).toEqual({ status: 404 })
})

test("invalid JSON throws MalformedResponse", async () => {
  const fetch = (async () => new Response("not json")) as unknown as typeof globalThis.fetch
  const error = await Models.make({ fetch }).providers().catch((error: unknown) => error)
  expect((error as ModelsDevError).reason).toBe("MalformedResponse")
})

test("empty body throws MalformedResponse", async () => {
  const fetch = (async () => new Response("")) as unknown as typeof globalThis.fetch
  const error = await Models.make({ fetch }).providers().catch((error: unknown) => error)
  expect((error as ModelsDevError).reason).toBe("MalformedResponse")
})

test("global fetch is resolved lazily so late polyfills work", async () => {
  const original = globalThis.fetch
  const client = Models.make()
  try {
    const { calls, fetch } = stub({ late: true })
    globalThis.fetch = fetch
    const result = await client.providers()
    expect(result).toEqual({ late: true } as never)
    expect(calls.length).toBe(1)
  } finally {
    globalThis.fetch = original
  }
})
