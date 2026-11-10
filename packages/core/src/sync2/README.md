# sync2

A second model sync engine, built next to the old one in `../sync`. Three providers run on it so far: `meta`, `modular` and `nearai`. The old sync still runs everything in CI.

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

`units.ts` has the conversions modules keep rewriting: `perMillion`, `round`, `reasoningControls` (sorts effort, drops a toggle when effort has `none`) and `labCandidates`.

## Policy

- `owns` lists the fields the source is authoritative for. The engine only ever changes these. Everything else in a file, including its leading comment, stays as it is. `{ path, merge: "min" }` only lets the source lower a value.
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
- `update`: a patch would turn reasoning on for a file with no reasoning controls, or the patched file fails the schema. The file is left alone.
- `removal`: the source dropped a file and `removals` is `keep`.

The engine opens no issues. Whatever runs it decides what to do with gaps.

## Result and risk

```ts
{ provider, changes: [{ kind, model, path, fields: [{ path, before, after }], reasoning? }], gaps, notices, risk }
```

`risk.ts` decides if the result can merge without review, with the limits used today in `../sync/auto-merge.ts` and `.github/sync-models/publish.sh`: at most 10 creates, 10 deletes and 15 of both, at most half the provider's files deleted, at least one file left, no Cloudflare AI Gateway deletions, and no reasoning-control changes outside the reviewed providers. It also counts price changes and gaps.

## Parity with the old sync

`bun packages/core/script/sync2-parity.ts` runs both engines on the recorded sources in `test/fixtures/sync2/` against the current catalog, as recorded and with changed prices, a new model and a dropped model. `test/sync2-parity.test.ts` checks the files they write match. The one known difference is on case-insensitive filesystems, where the new engine matches `qwen/x` to `Qwen/x` and the old one deletes the file.

The three ports still import fetch and parsing code (zod schemas, Meta's docs parser) from the old modules. That code moves here when the old modules go away.
