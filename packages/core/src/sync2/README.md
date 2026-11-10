# sync2

A second model sync engine, built next to the old one in `../sync`. The providers in the parity table below run on it so far. The old sync still runs everything in CI.

```sh
bun models:sync2 <provider> [--dry-run] [--json] [--raw=<file>]
```

`--json` prints one result object to stdout. `--raw` reads the source data from a file instead of fetching it. The CLI writes nothing but model files.

## A provider module

A module fetches the source and says what it states. It never reads or writes catalog files.

```ts
export const example: SyncModule<Raw> = {
  id: "example",
  name: "Example",
  policy: {
    owns: ["cost.text.input.price", "cost.text.output.price", { path: "limit.context", merge: "min" }],
    creates: "auto",    // "auto" | "gap" | "never"
    removals: "delete", // "delete" | "deprecate" | "keep"
  },
  fetch: () => fetchJSON("https://example.com/models"),
  observe: (raw) => raw.data.map((model) => ({
    id: model.id,
    base: labCandidates(model.id),
    cost: { text: { input: { price: perMillion(model.input) }, output: { price: perMillion(model.output) } } },
    limit: { context: model.context },
  })),
  manages: (id, file) => true, // optional: files this source speaks for
};
```

An observation uses the same field names as a v2 provider file (`cost`, `limit`, `modalities`, `capabilities.reasoning`, `status`, `api`, ...). Leave out what the source doesn't say. Use `null` when the source says there is none, for example `overrides: null` for a flat price.

`updateOnly: true` marks an observation that may only update a file that exists, such as an alias the source lists next to its canonical ID. It never creates a file or a gap.

`http.ts` has `fetchJSON`, `fetchText` and `requireEnv` for the fetch side.

`units.ts` has the conversions modules keep rewriting: `perMillion`, `round`, `reasoningControls` (sorts effort, drops a toggle when effort has `none`) and `labCandidates`.

## Policy

- `owns` lists the fields the source is authoritative for. The engine only ever changes these. Everything else in a file, including its leading comment, stays as it is. An owned list or table (an override list, say) is replaced whole, unless a merge rule says otherwise:
  - `{ path, merge: "min" }` only lets the source lower a number.
  - `{ path, merge: "kinds", only? }` is for modality lists. The source decides the kinds (text, image, pdf, ...) and the file keeps its own formats (`image/png`) for the kinds it already has. With `only: ["image", "audio"]` the source speaks for those kinds alone.
  - `{ path: "status", merge: "deprecated" }`: the source says `"deprecated"` or `null`, and `null` only clears a deprecated status, never `beta`.
  - `{ path: "api", merge: "tables" }`: the source's API tables replace or join the file's and the rest stay. A file with no `[api.*]` tables gets the provider's default API first, so it keeps being served on it.
  - `{ path, merge: "report" }` is never written. If the source disagrees with the file, the model becomes an update gap and its file is left alone (Mistral's probed reasoning efforts).
  - `standalone: true` (with any rule) only patches files without a `base_model`; with one, the lab's value stands (Anthropic's release dates).
- Turning `capabilities.tools.supported` or `capabilities.reasoning.supported` off drops that capability's details (`strict`, `choice`, effort, toggle, ...). A capability table the file sets always names `supported`, even when it matches the lab.
- `creates` decides what happens to a model the catalog doesn't have: create it, report it as a gap, or skip it with a notice.
- `removals` decides what happens to a file the source no longer lists: delete it, set `status = "deprecated"`, or keep it and report a gap.

## What the engine does

For each observation it finds the file (exact ID, then ignoring case) and:

- Update: copies each owned field into the file. A value equal to what the lab file already gives is left to inheritance instead of written. If nothing changed, the file isn't touched.
- Create: picks the base model (the first `base` hint with a file under `models/`, ignoring case), writes `schema`, `base_model` and the owned fields that differ from the lab.
- Remove: applies the `removals` policy to files no observation matched, skipping files `manages` says no to.

Every written file is checked against the v2 schema and must read back to exactly what the engine meant to write. Writing reuses `formatModelV2` from `../model-file-v2.ts`.

The engine refuses to run when the source returns no models and removals aren't `keep`, or when it lists the same ID twice.

## Gaps

A gap is a model the engine can't finish on its own. It is returned instead of a file:

```ts
{ provider, model, kind: "new" | "update" | "removal", reason, missing: ["capabilities.reasoning"], known: observation }
```

- `new`: no lab model to base it on, required fields missing, a reasoning model without reasoning controls, or `creates: "gap"`.
- `update`: a patch would turn reasoning on for a file with no reasoning controls, a `report` field disagrees with the file, or the patched file fails the schema. The file is left alone.
- `removal`: the source dropped a file and `removals` is `keep`.

The engine opens no issues. Whatever runs it decides what to do with gaps.

## Result and risk

```ts
{ provider, changes: [{ kind, model, path, fields: [{ path, before, after }], reasoning? }], gaps, notices, risk }
```

`risk.ts` decides if the result can merge without review, with the limits used today in `../sync/auto-merge.ts` and `.github/sync-models/publish.sh`: at most 10 creates, 10 deletes and 15 of both, at most half the provider's files deleted, at least one file left, no Cloudflare AI Gateway deletions, and no reasoning-control changes outside the reviewed providers. It also counts price changes and gaps.

## Parity with the old sync

`bun packages/core/script/sync2-parity.ts` runs both engines on the recorded sources in `test/fixtures/sync2/` against the current catalog, as recorded and with changed prices, a new model and a dropped model. `test/sync2-parity.test.ts` checks the files they write match.

| Provider | Recorded | Perturbed | Differences |
| --- | --- | --- | --- |
| google | same | 1 file | Turning thinking on for a file with no reasoning controls is a gap; the old sync wrote `reasoning = { supported = true }` with no controls. The fetch sends the key in the `x-goog-api-key` header instead of the URL. |
| meta | same | same | |
| modular | same | same | |
| nearai | same | same | On case-insensitive filesystems the new engine matches `qwen/x` to `Qwen/x`; the old one deletes the file. |
| anthropic | same | same | The 1h cache write price is read from the pricing page instead of scaled from the 5m price (same result while Anthropic keeps the 1.25x and 2x ratios). A new alias (an undated ID whose dated model has a file) is built from the source alone; the old sync copied its dated sibling's hand-written fields. Not in the data. |
| mistral | same | same | None in the data. A non-chat model (OCR, moderation) whose file has no `[api.*]` tables would get the provider's default API before its own; the old sync gave it only its own. Every such file already lists its API. |
| openai | same | same | Owns no fields. The old sync re-read and rewrote each listed file through v1; the new one leaves them alone. |
| xai | same | same | A long-context band is written as `gte` (the docs bill prompts of at least the threshold). The old sync kept a file's operator but wrote `gt` for a band the file didn't have. |

`meta`, `modular` and `nearai` still import fetch and parsing code (zod schemas, Meta's docs parser) from the old modules. Ports after those carry their own.
