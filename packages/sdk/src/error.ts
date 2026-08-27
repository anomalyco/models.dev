export type ModelsDevErrorReason = "Transport" | "UnexpectedStatus" | "MalformedResponse"

/**
 * The only error thrown by the models.dev client.
 *
 * - `Transport` — the fetch itself failed (network, DNS, abort). `cause` is the underlying error.
 * - `UnexpectedStatus` — non-2xx response. `cause` is `{ status: number }`.
 * - `MalformedResponse` — the body was empty or not valid JSON. `cause` is the parse error, if any.
 */
export class ModelsDevError extends Error {
  override readonly name = "ModelsDevError"
  constructor(
    readonly reason: ModelsDevErrorReason,
    options?: ErrorOptions,
  ) {
    super(reason, options)
  }
}
