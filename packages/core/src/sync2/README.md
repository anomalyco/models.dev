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

`defaults` holds values a new file takes for owned fields the observation leaves out (`tools.supported = false`, an output limit of the context window). Existing files keep their own.

`rebuild: { keep: [...] }` makes the observation the whole file: the engine writes its body on the file's `base_model` (or the first `base` hint with a lab file) and the `keep` paths copied from the file, and nothing else of the file stays. Owns and merges don't apply, and `null` leaves a field out. It's for media files a source generates whole (OpenRouter's speech, embedding and image models).

`updateOnly: true` marks an observation that may only update a file that exists, such as an alias the source lists next to its canonical ID. It never creates a file or a gap.

`refine(observation, file, files)` is optional: it finishes an observation with what only the catalog knows, given the file it will update (undefined for a new model) and every file of the provider by ID. Pioneer uses it to keep a file's own cost and to read whether a standalone file reasons; it never writes.

`http.ts` has `fetchJSON`, `fetchText` and `requireEnv` for the fetch side.

`units.ts` has the conversions modules keep rewriting: `perMillion`, `round`, `reasoningControls` (sorts effort, drops a toggle when effort has `none`) and `labCandidates`.

`labs.ts` is the lab resolver relays share, moved from the old OpenRouter module (`resolveCanonicalBaseModel` and `resolveModelMetadataBaseModel`, which about 37 old modules import). It turns a host ID into `base` hints:

- `namespaceHints("z-ai/glm-5:free")` maps the namespace to its lab (`z-ai` → `zhipuai`, `meta-llama` → `meta`, `qwen` → `alibaba`) and tries the lab's other spellings (`claude-opus-4.6` → `claude-opus-4-6`, `llama-3-3` → `llama-3.3`, no `:free` or `-fast`). Known renames come first. Unknown namespaces and `~` routers give none.
- `labHints(id)` adds the ID itself as a lab path and, for an ID with no namespace, `*/<id>`: the one lab file with that name in any lab.

`openrouter-shape.ts` observes a model in OpenRouter's catalog shape the way the old `buildOpenRouterModel` did, for hosts that map their lists onto it (Ambient).

The engine takes the first hint with a lab file, ignoring case. A test checks that on every ID in the catalog these pick the same lab as the old functions.

## Policy

- `owns` lists the fields the source is authoritative for. The engine only ever changes these. Everything else in a file, including its leading comment, stays as it is. An owned list or table (an override list, say) is replaced whole, unless a merge rule says otherwise:
  - `{ path, merge: "min" }` only lets the source lower a number.
  - `{ path, merge: "kinds", only? }` is for modality lists. The source decides the kinds (text, image, pdf, ...) and the file keeps its own formats (`image/png`) for the kinds it already has; a kind it adds takes the lab's formats when the lab lists any. With `only: ["image", "audio"]` the source speaks for those kinds alone. A `[modalities]` table that ends up equal to the lab's is removed.
  - `{ path: "status", merge: "deprecated" }`: the source says `"deprecated"` or `null`, and `null` only clears a deprecated status, never `beta`.
  - `{ path, merge: "nonzero" }`: a 0 updates a price the file has but never adds one (Novita's placeholder cache prices).
  - `{ path: "api", merge: "tables" }`: each source table joins the file's (its values win key by key, at any depth, and the file's other keys stay), `null` removes one, and the file's other tables stay. The file's first table stays first, then the source's tables in its order, then the rest. A file with no `[api.*]` tables gets the provider's default API first, so it keeps being served on it; a lone empty default table isn't written.
  - `{ path, merge: "seed" }` is for a capability detail such as `capabilities.reasoning.toggle`. It's only written while the file doesn't state that capability itself (its own table is missing or says `supported = false`), so controls a person wrote are kept (Deep Infra's `can-disable-reasoning` tag).
  - `{ path, merge: "kinds", addOnly: true }`: the source only adds kinds, never removes one (Deep Infra's tags).
  - `{ path, merge: "refresh" }` only updates a value the file itself sets, or writes it into a new file; a file that inherits the field keeps inheriting it (Kilo's display names).
  - `{ path, merge: "bands" }` is for a cost override list. The source's context bands replace the file's; a band at the same threshold as a file band keeps the file's operator (`gt` or `gte`), its other keys and its cache write TTLs (one write price updates the first). Overrides with other conditions (time of day, service tier) stay after the bands, and `null` removes only the bands. This is what the old sync's v1 patch did. Two options: `replaces: ["service_tier"]` makes overrides using those conditions (at any depth of `all`/`any`/`not`) the source's too, and `optional: true` keeps the file's bands when the source lists none. With either, the file's overrides that stay come first, in their order, then the source's (DigitalOcean, OpenRouter).
  - `{ path, merge: "report" }` is never written. If the source disagrees with the file, the model becomes an update gap and its file is left alone (Mistral's probed reasoning efforts).
  - `standalone: true` (with any rule) only patches files without a `base_model`; with one, the lab's value stands (Anthropic's release dates).
  - `createOnly: true` (with any rule) only writes the field into a new file; an existing file keeps its own (Chutes' generated name and description).
- Turning `capabilities.tools.supported` or `capabilities.reasoning.supported` off drops that capability's details (`strict`, `choice`, effort, toggle, ...). A capability table the file sets always names `supported`, even when it matches the lab, and a `[modalities]` table it sets lists both sides. A `tables` merge that removes every table removes the field.
- `creates` decides what happens to a model the catalog doesn't have: create it, report it as a gap, or skip it with a notice.
- `removals` decides what happens to a file the source no longer lists: delete it, set `status = "deprecated"`, or keep it and report a gap.
- `headers: "replace"`: the observation's `header` becomes each updated file's leading comment, so a header change alone rewrites the file (Prime's generated headers). A `header` can be a function of the file as it will be written.
- `omitLabInput: true`: a new file whose context window differs from its lab's gets `base_model_omit = ["limit.input"]`, since the lab's input limit belongs to the lab's window. Existing files aren't changed (the old sync only did this when it created a file).

## What the engine does

For each observation it finds the file (exact ID, then ignoring case) and:

- Update: copies each owned field into the file. A value equal to what the lab file already gives is left to inheritance instead of written. One cache write price updates the first TTL of a file that prices several. If nothing changed, the file isn't touched.
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
| aiand | same | same | A new model with no lab file is a gap; the old sync skipped it and opened an issue. Kept from the old sync: an empty effort list in the feed removes a file's controls. | |
| aimlapi | same | same | None. The measured effort ladders, reasoning fields, aliases and blocklists are carried over as tables, and the docs schema is read at fetch time as before. New models are never created (`creates: never`), and a row sync can't state (a reasoning model with no stated effort, an unpriced row) keeps its file. |
| ambient | same | 1 file | A new model that reasons with no controls is a gap; the old sync wrote `reasoning = { supported = true }`. A model listed as not ready keeps its file and isn't reported as dropped. |
| anthropic | same | same | The 1h cache write price is read from the pricing page instead of scaled from the 5m price (same result while Anthropic keeps the 1.25x and 2x ratios). A new alias (an undated ID whose dated model has a file) is built from the source alone; the old sync copied its dated sibling's hand-written fields. Not in the data. |
| baseten | same | 1 file | A new model that reasons with no controls is a gap; the old sync wrote `reasoning = { supported = true }`. A file's output limit is createOnly; the old sync also filled it into an existing file without one (none exists). Without a listed cache price, a file's cache capability stays; the old sync removed it when the file had no cache price either. A decision model's file keeps fields the engine doesn't own; the old sync rebuilt it from scratch. |
| chutes | same | 3 files | A changed input kind is written in the lab's formats (`image/png`, ...); the old sync wrote bare kinds (`image`). A new model that reasons with no controls is a gap; the old sync wrote `reasoning = { supported = true }`. The old sync re-resolved every file's base_model on each run; the new engine keeps a file's base_model (no file's would change today). |
| cloudflare-ai-gateway | same | 5 files | A context window equal to the lab's is left to inheritance; the old sync wrote it into the file. A rewritten file keeps its tools table's key order; the old sync reordered it. A new 5m cache write price keeps the file's 1h price; the old sync scaled every TTL by the 5m change. The local Cloudflare token gets a 403, so the fixture is built from the catalog's own files as `{ catalog, schemaInput }` sources in the shape of `test/cloudflare-ai-gateway.test.ts` (flat or long-context `provider_details`, effort and tool_choice schemas, request formats; media prices by unit, without size or clip overrides). Old-sync bug: it can't write either Jev file ("does not reproduce the synced fields"); a hand-added header line on `typesafe/jev` moved into `curation.toml` so the generated header keeps it. Fetching and the catalog-to-model mapping are still the old module's. |
| cloudflare-workers-ai | same | same | None in the data. The local Cloudflare token gets a 403 on search, so the fixture is built from the catalog's own text-model files as search rows, in the shape of the samples in `test/cloudflare-workers-ai.test.ts` (efforts listed strongest first, `mandatory`, `responses_api`, `tool_choice`); the perturbed copy covers what the files don't. Embedding and image files (all `v2_only`) aren't the module's to report as dropped; the old sync kept them silently. |
| cortecs | 1 file | 4 files | A new model with no lab file is a gap; the old sync wrote a standalone file with the source's description and date. A new model, or a file without a base_model, that starts reasoning with no controls is a gap; the old sync wrote `reasoning = { supported = true }` (Kimi K3.1 Pro in the recorded data). On create the old sync took reasoning from the source even for a base_model file; the new engine leaves it to the lab. |
| crossmodel | 1 file | 1 file | A new model's lab ID is matched ignoring case and written as filed: `minimax/MiniMax-M3.1-Flash` for MiniMax M3.1 Flash (in the recorded data). The old sync wrote `MiniMax-M3.1-flash`, which only exists on a case-insensitive filesystem; on Linux it skipped the model. A new model whose vendor has no lab file is a gap; the old sync skipped it. | |
| deepinfra | same | 3 files | The old sync can't write any file with retention write prices (`cost.text.input.cache.explicit`): it reports "the v2 file does not reproduce the synced fields" and leaves Kimi K3, Kimi K2.7 Code, DeepSeek V4 Flash and GLM 5.2 as they are. The new engine updates them. An input kind a tag adds takes the lab's formats and the file keeps its own; the old sync wrote bare kinds (`audio`) or swapped a file's narrowed image list for the lab's. A new model with no lab file or no reasoning controls is a gap; the old sync skipped it or wrote `reasoning = { supported = true }`. |
| digitalocean | 2 files | 3 files | A kind a new file differs from its lab in is written in the lab's formats; the old sync wrote bare kinds (Claude Fable 5.2 in the recorded data). A new model that reasons with no listed efforts is a gap; the old sync wrote `reasoning = { supported = true }` (Kimi K3.1 Pro in the recorded data). A new model with no lab file is a gap; the old sync wrote a standalone file with a generated description. Price overrides use the bands merge with `replaces: ["service_tier"]` and `optional: true`: service-tier prices are the catalog's, a long-context band only when listed. Kept from the old sync: a band keeps the file's cache prices the catalog leaves out, and files the source drops are kept (reported as removal gaps). |
| edenai | same | 1 file | A kind a new file differs from its lab in is written in the lab's formats; the old sync wrote bare kinds. The module reads the lab's first-party provider file and OpenRouter's files for reasoning efforts, as the old one did. | |
| empiriolabs | same | 1 file | A model that starts reasoning with no controls is a gap; the old sync wrote `reasoning = { supported = true }`. A new model with no lab file is a gap; the old sync skipped it. Kept from the old sync: a reasoning model whose parameters list no controls loses the file's. | |
| engy | same | same | A changed context window is a `report` field: the model is a gap and its file is left alone, as the old sync did by raising a missing-model issue. Both hold because every file's context is its input plus output limit. |
| fireworks-ai | same | 2 files | When Priority goes away, the new engine removes its price multiplier along with the mode; the old sync left the multiplier behind. The multiplier list is owned whole, so a non-Priority multiplier would be dropped too (none exist). |
| friendli | same | same | A file keeps its base_model; the old sync switched it to the lab the source names when they differed (none do). | |
| github-copilot | same | same | None in the data. A public preview row updates both `<slug>` and `<slug>-preview` when both files exist; the old sync updated only `<slug>`. No such pair exists. |
| google | same | 1 file | Turning thinking on for a file with no reasoning controls is a gap; the old sync wrote `reasoning = { supported = true }` with no controls. The fetch sends the key in the `x-goog-api-key` header instead of the URL. |
| huggingface | same | 2 files | A new file doesn't restate `tools = { supported = true }` when its lab already says so; the old sync always wrote it. Existing files only get their API tables kept current. A Responses table's own keys stay (the old sync replaced the table whole); no file has any. |
| hyper | same | same | A standalone file whose ID later matches a lab file stays standalone; the old sync turned it into a base_model file (none would today). Old-sync behavior kept: a lab-based model that stops listing a reasoning object loses its efforts and keeps `reasoning = { supported = true }`. | |
| inceptron | same | same | A file keeps its base_model; the old sync switched it to the lab model the source names when they differed (none do). | |
| kilo | same | same | |
| llmgateway | same | 1 file | A new reasoning price on a model whose parameters don't list `reasoning` is written; the old sync could not write it ("does not reproduce the synced fields") and left the file (o3 in the perturbed copy). A new model with no controls or no lab file is a gap; the old sync wrote `reasoning = { supported = true }` or a standalone file. | |
| llmgateway-providers | same | same | The module reads the matching DevPass file for controls, the reasoning field and bands, as the old one did. | |
| merge-gateway | same | same | No key locally: the fixture is built from the catalog's own Merge Gateway files in the API's shape (per-second routes as `per_second`). A new model with no lab file is a gap; the old sync skipped it. | |
| meta | same | same | |
| mistral | same | same | None in the data. A non-chat model (OCR, moderation) whose file has no `[api.*]` tables would get the provider's default API before its own; the old sync gave it only its own. Every such file already lists its API. |
| modular | same | same | |
| morph | same | same | |
| nano-gpt | same | 1 file | A file that starts reasoning with no controls is a gap; the old sync wrote `reasoning = { supported = true }`. A `systemone` table's `media_input` isn't synced (no file has one). An existing file whose lab has no output limit keeps its own instead of taking the context window. |
| nearai | same | same | On case-insensitive filesystems the new engine matches `qwen/x` to `Qwen/x`; the old one deletes the file. |
| novita-ai | same | same | A route that drops Chat Completions loses that table even when it's the file's first; the old sync kept the first table. Every route lists Chat Completions today. A long-context band's cache price of 0 is left out instead of written as 0. |
| ofox | same | 1 file | When the catalog lists 5m and 1h cache write prices, both are written; the old sync ignored the 1h price and scaled the file's by the change to the 5m one. A context band keeps the file's cache write TTLs, updating the first; the old sync scaled every TTL. Non-chat models and new models are reported, not written. |
| ollama-cloud | same | same | Owns no fields. The old sync re-read and rewrote each listed file through v1; the new one leaves them alone. |
| openai | same | same | Owns no fields. The old sync re-read and rewrote each listed file through v1; the new one leaves them alone. |
| ovhcloud | same | 1 file | A model that starts reasoning with no controls is a gap; the old sync wrote `reasoning = { supported = true }`. |
| pioneer | same | same | | |
| prime | same | 1 file | A kind a new file differs from its lab in is written in the lab's formats (and the header says so); the old sync wrote bare kinds. A new model with no lab file is a gap; the old sync skipped it. Each file's header is generated, and the MIME line follows the file as written; the old sync looked at the file before the patch, so it caught up a run later. Effort `default` keeps the file as it is. | |
| requesty | same | 1 file | A new model with no lab file is a gap; the old sync wrote a standalone file. The old sync re-resolved every file's base_model on each run; the new engine keeps a file's base_model (no file's would change today). The module reads lab files to name regional routes after their lab. |
| tinfoil | same | same | A model that starts reasoning with no controls in its file is a gap; the old sync stopped with an error. |
| venice | same | 1 file | A new model with no lab file is a gap; the old sync wrote a standalone file with a generated description and today's date. Lab matching (ID or name, ignoring case and punctuation) is the old one, in the module. An API table the source sets keeps the file's other keys (the old sync kept only `capabilities`). |
| wandb | same | 2 files | A model whose only control was a toggle and now lists none is written as `reasoning = { supported = true }`; the old sync could not write that ("does not reproduce the synced fields") and left the file. A new model that reasons with no controls is a gap; the old sync wrote `reasoning = { supported = true }`. | |
| xai | same | same | A long-context band is written as `gte` (the docs bill prompts of at least the threshold). The old sync kept a file's operator but wrote `gt` for a band the file didn't have. |

`meta`, `modular`, `nearai` and `cloudflare-ai-gateway` still import fetch and parsing code (zod schemas, Meta's docs parser, the gateway's catalog mapping) from the old modules. Other ports carry their own.


Not ported yet (still on the old sync):

- `openrouter`, `vercel`: skipped. The rules they need, as the smallest additions to what's here:
  - Media models (speech, transcription, embedding, rerank, image, video) are rebuilt from the file each run: the old sync keeps `status`, hand-written capabilities, `experimental` and `metadata` (and `description`, `family`, `knowledge` without a lab) and drops the rest. That's an observation flag, `rebuild: { keep: [...] }`, where the engine starts the file from `schema`, `base_model` and the kept fields, then patches.
  - Chat price overrides merge by condition: time-of-day overrides are always the catalog's, context bands only when the catalog lists some, and others stay. The `bands` merge now has both options (`replaces: ["utc_days", "utc_hours"]`, `optional: true`).
  - The 1h cache write price is keyed by the TTLs the file's cache capability lists; Vercel copies a new chat model's reasoning controls from another file in the provider (its `-free` route's base, or the file named after its lab ID); OpenRouter's tool choice depends on the file's own tool support. All three fit `refine(observation, file, files)`, which now exists.
  - What's missing is the time to port 3,000 lines with parity on recorded and perturbed data.
