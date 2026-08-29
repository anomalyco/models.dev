import { expect, test } from "bun:test"

test("snapshot exports providers, models, generatedAt, and a default catalog", async () => {
  const snapshot = await import("../src/snapshot.js")
  expect(Object.keys(snapshot.providers).length).toBeGreaterThan(100)
  expect(Object.keys(snapshot.models).length).toBeGreaterThan(100)
  expect(snapshot.default.providers).toBe(snapshot.providers)
  expect(snapshot.default.models).toBe(snapshot.models)
  expect(Number.isNaN(Date.parse(snapshot.generatedAt))).toBe(false)

  const anthropic = snapshot.providers["anthropic"]
  expect(anthropic?.env.length).toBeGreaterThan(0)
  const model = Object.values(anthropic!.models)[0]
  expect(typeof model?.name).toBe("string")
  expect(typeof model?.limit.context).toBe("number")
})
