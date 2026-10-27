TODO: delete

# Model Sync Scripts

Model syncs are centralized in `packages/core/src/sync/index.ts`. The runner owns file IO, TOML formatting, validation, reporting, dry runs, and deletion behavior. `packages/core/script/sync-models.ts` is only the CLI wrapper for `bun models:sync`. Individual provider sync modules only fetch source data, parse it, and translate each source model into the catalog schema.

The grouped sync targets are available for local convenience, but CI syncs each provider separately so every provider gets its own reusable automation PR.

## Commands

- `bun models:sync aggregators` syncs every provider in the `aggregators` group.
- `bun models:sync aiand` syncs only ai&.
- `bun models:sync openrouter` syncs only OpenRouter.
- `bun models:sync cloudflare-workers-ai` syncs only Cloudflare Workers AI.
- `bun models:sync cloudflare-ai-gateway` syncs only Cloudflare AI Gateway's proxied catalog.
- `bun models:sync cloudflare` syncs the Cloudflare sync group.
- `bun models:sync direct` syncs every provider in the `direct` group.
- `bun models:sync google` syncs only Google.
- `bun models:sync digitalocean` syncs only DigitalOcean.
- `bun models:sync xai` syncs only xAI.
- `bun models:sync kilo` syncs only Kilo.
- `bun models:sync merge-gateway` syncs only Merge Gateway.
- `bun models:sync mistral` syncs only Mistral.
- `bun models:sync openai` syncs only OpenAI catalog availability.
- `bun models:sync ollama-cloud` syncs Ollama Cloud catalog availability.
- `bun models:sync github-copilot` syncs only GitHub Copilot pricing.
- `bun models:sync tinfoil` syncs only Tinfoil.
- `bun models:sync morph` syncs only Morph.
- `bun models:sync nearai` syncs only NEAR AI Cloud.
- `bun models:sync aggregators --dry-run` prints changes without writing model files.
- `bun models:sync aggregators --new-only` creates new model files but skips updates and removals.
- `bun models:sync <provider> --open-issues` opens GitHub issues for missing models (on by default only when `GITHUB_ACTIONS=true`).
- `bun models:sync <provider> --no-issues` skips opening GitHub issues in Actions.
- `bun validate` validates the generated catalog after a sync.

Sync runs also write `.sync/model-sync-report.md` for the automation workflow PR body. Do not commit that report from local runs.

## Runner Responsibilities

`packages/core/src/sync/index.ts` handles the shared behavior:

- Reads existing TOML files from the provider `modelsDir`.
- Parses existing files with `Bun.TOML.parse` and `AuthoredModelShape.partial()`.
- Resolves existing `base_model` / `base_model_omit` metadata before passing local metadata to provider modules.
- Calls the provider module to fetch, parse, and translate source models.
- Validates translated models with `AuthoredModel` before writing.
- Patches the result into the existing v2 file (new files are written in v2). Provider modules return the v1-shaped `AuthoredModel` (`reasoning_options`, `cost.input`, `tool_call`, `attachment`, `interleaved`, …), so the per-provider notes below use those names; the runner maps them to v2 fields (`capabilities.reasoning`, `cost.text.input.price`, `capabilities.tools`, modalities, `[api.*] compatibility`) and keeps v2 data it doesn't own (cache, overrides, multipliers). Hand-authored files always use v2 fields (see `AGENTS.md`).
- Formats TOML consistently for all synced providers.
- Compares authored TOML shapes before writing so existing factored TOMLs stay factored instead of being expanded.
- Replaces symlinked files safely by removing the symlink before writing.
- Removes existing files that are no longer present in the desired synced set.
- Writes `.sync/model-sync-report.md` for GitHub Actions.
- When `skipCreates` is set and issue opens are enabled, opens one deduped GitHub issue per remote model missing from the local catalog (via `gh`).
- When a provider selectively skips only some models, `missingModelID` can preserve existing metadata and mark those skips for the same deduped issue flow without disabling safe automatic creates.

Because the runner removes files missing from the desired set, a provider module should only skip source models when deleting existing local files for those skipped IDs is intentional.

## Missing-model GitHub issues

Providers that cannot safely auto-create TOMLs set `skipCreates: true`. In GitHub Actions (or with `--open-issues`), each skipped remote ID may open a GitHub issue unless the provider sets `trackMissingModels: false`:

1. Title: `[missing-model] <provider>: <model-id>` (stable for dedupe)
2. Labels: `automation`, `model-sync`, `missing-model`, `provider:<id>`
3. Lists existing issues (open **and** closed) with those labels; skips create when the title already exists
4. Dispatches the Issue Fixer explicitly so issues created with `GITHUB_TOKEN` can still produce PRs
5. If listing fails, creates nothing (fail closed)

Every six hours, a recovery workflow checks the oldest open issues with all three automation labels. It redispatches up to three issues that are at least one hour old and have no closing pull request, so a missed or failed Issue Fixer run does not leave them stranded. The one-hour delay keeps the recovery run from racing the initial dispatch.

Providers that can auto-create most models may instead return an ID from `missingModelID` only for `translateModel` skips that need manual metadata. The runner preserves an existing local entry for that ID while the issue is handled. Intentional skips return `undefined` and do not open issues.

Requires `GH_TOKEN` on the sync workflow step. Local runs are notice-only unless `--open-issues`. Use `--no-issues` / `--dry-run` to skip creates. Each newly opened issue explicitly dispatches the issue-fixer workflow so an agent can research the missing metadata and open a model PR.

The first Actions run may open a batch of issues per provider, including remote IDs the catalog intentionally omits (e.g. OpenAI whisper/tts/moderation surfaces, dated snapshots). This one-time volume is accepted by design: close unwanted issues once and the closed-title dedupe suppresses them permanently. If the dedupe list window (1000 labeled issues per provider) ever fills, the sync fails closed and creates nothing rather than risk duplicates.

Pioneer and Ofox track remote-only chat models as missing-model issues. Their APIs are not authoritative enough to create complete TOMLs directly, so the issue-fixer agent researches the missing canonical and provider-specific metadata before opening a PR.

Ollama Cloud tracks every remote-only ID from its public `/v1/models` endpoint as a missing-model issue. Existing provider TOMLs and entries absent from the endpoint are preserved because the inventory does not provide enough metadata to author complete entries or determine removals safely.

OpenAI also sets `trackMissingModels: false`: `/v1/models` is scoped to the automation account and mixes public models with legacy, internal experiment, dated snapshot, and non-catalog IDs without lifecycle metadata. Existing OpenAI TOMLs are still preserved by the availability sync.

Google sets `trackMissingModels: false`: `/v1beta/models` does not expose lifecycle metadata and can retain shut-down models, superseded snapshots, moving aliases, and EAP IDs. Existing Google TOMLs are still updated from API-authoritative fields.

## Provider Modules

Provider modules live in `packages/core/src/sync/providers/`. A provider exports an object satisfying `SyncProvider<SourceModel>`:

```ts
export const provider = {
  id: "provider-id",
  name: "Provider Name",
  modelsDir: "providers/provider-id/models",
  async fetchModels() {
    return fetch("https://example.com/models").then((response) => response.json());
  },
  parseModels(raw) {
    return ProviderResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<ProviderModel>;
```

Keep provider modules focused on provider-specific logic:

- Define Zod schemas for the provider API response.
- Fetch from the provider API, including auth headers when needed.
- Convert provider pricing units to per-1M-token catalog prices.
- Convert dates, modalities, limits, capabilities, and model IDs into catalog fields.
- Preserve existing hand-authored fields only when the provider API is not authoritative for that field.
- Preserve `base_model` and `base_model_omit` from existing TOMLs when updating a factored provider model.
- Return `undefined` from `translateModel` only when skipped source models should be treated as absent from the synced catalog.

Do not put TOML scanning, writing, deletion, reporting, or generic comparison logic in provider modules.

Provider sync code must use `base_model` and `base_model_omit`; do not write legacy `[extends]` tables. If a sync or generator updates a provider file that already uses `base_model`, it should keep that pointer and only write provider-specific overrides.

## Adding A Provider

1. Create `packages/core/src/sync/providers/<provider>.ts`.
2. Define strict-enough Zod schemas for the provider response.
3. Export a `SyncProvider` implementation with `fetchModels`, `parseModels`, and `translateModel`.
4. Add the provider to `providers` in `packages/core/src/sync/index.ts`.
5. Add the provider ID to an existing group or create a new group in `groups`.
6. Add any required API secrets to `.github/workflows/sync-models.yml` if the provider needs new credentials.
7. Run `bun models:sync <provider> --dry-run` to inspect the first diff.
8. Run `bun models:sync <provider>` to write files.
9. Run `bun models:sync <provider> --dry-run` again and expect a clean result.
10. Run `bun validate`.

Prefer small, provider-specific PRs when adding a provider. If the provider has ambiguous source data, keep it out of shared groups until the source-of-truth behavior is clear.

## Automation

`.github/workflows/sync-models.yml` runs on an hourly schedule and manually through `workflow_dispatch`.

The workflow:

- Checks out `dev`.
- Installs dependencies with Bun.
- Discovers sync providers with `bun models:sync --list-providers`.
- Runs one provider per matrix job with `bun models:sync ${{ matrix.provider }}`.
- Runs `bun validate`.
- Creates or updates a provider-specific sync PR only when `providers` changed.
- Uses `.sync/model-sync-report.md` as the PR body.

Each provider job checks out `dev` and writes to a fixed provider branch like `automation/sync-models-openrouter`. If that provider's sync PR is already open, later scheduled runs force-update the same branch and edit the existing PR instead of creating another one. Provider jobs do not share unmerged changes with each other; OpenRouter only uses `base_model` for model metadata entries already present on `dev`.

CI automatically picks up providers registered in `providers` in `packages/core/src/sync/index.ts`. Adding a new sync provider there is enough to get an hourly provider-specific sync job, branch, labels, title, and PR naming convention. The workflow only needs manual updates when a new provider requires new secrets or other environment variables.

Actions are pinned by commit SHA. Keep new workflow actions pinned the same way.

## Eden AI Notes

- Source endpoint: `https://api.edenai.run/v3/models`; no authentication required.
- Latest aliases (`alias_of` plus an ID ending in `-latest`) get a distinct display name such as `Claude Fable Latest (Claude Fable 5.1)` so they do not collide with the versioned target in UIs that key on `name`. Case-only `alias_of` duplicates are not treated as latest aliases.
- Extra labels (current target, host, region) share one parenthetical, e.g. `Gemini Flash Latest (Gemini 3.8 Flash, Vertex AI)` and `GPT OSS 120B (Deep Infra)`. The lab's own API keeps the unsuffixed canonical name; other hosts (Vertex AI, Deep Infra, Groq, Together AI, …) are named.
- Reasoning effort options are derived from the lab's provider entry or OpenRouter. A toggle-only or budget-only control is not an effort list; do not invent effort levels.
- When the effort mapper cannot resolve controls, preserve the existing route's authored reasoning controls (`capabilities.reasoning`) while syncing other authoritative fields. Do not replace authored toggle, effort, or budget controls with `[]`.
- New reasoning models with neither a resolved mapping nor authored controls remain skipped for manual authoring. No empty placeholder is generated, so the normal auto-merge policy remains unchanged; legitimate always-on `[]` entries are not blanket-blocked.
- Intentional route deduplication and removal of IDs absent from the upstream catalog are unchanged.

## CrossModel Notes

CrossModel is implemented in `packages/core/src/sync/providers/crossmodel.ts`.

- Source endpoint: `https://www.crossmodel.ai/api/models`.
- Pricing, context/output limits, modalities, and reasoning controls come from CrossModel's public catalog.
- `structured_output` comes from `capabilities.json` (documented `/v1/models` shape) or `capabilities.structured_output.json_schema` (the public catalog); when both are absent or null, the sync preserves an existing authored override.
- `identity.release_stage = "deprecated"` sets `status = "deprecated"`; otherwise an existing status is kept.
- `capabilities.context.caching = true` sets `capabilities.cache = { implicit = true }` in v2 files that have no cache kinds yet (CrossModel documents no mechanism or TTL). Authored `implicit` / `explicit` details are kept.
- Effort lists are sorted low to high, because v2 compares them in order.
- Intrinsic model facts (`knowledge`, dates, `family`, `open_weights`) are never synced; they stay inherited from the canonical `base_model` metadata. Display names are not synced either, so v1 names remain the lab's.

## Prime Inference Notes

- Run with `bun models:sync prime` or `bun prime:sync`. Registration enables the hourly provider-specific workflow; no API key or new workflow secret is required.
- Source: the public `https://api.pinference.ai/api/v1/models` endpoint. Pricing is already USD per million tokens. Context/output limits, supported parameters, modalities and published effort levels are API-authoritative.
- Public tool-capable text models use existing lab metadata through `base_model`; lab facts and release dates are inherited. Published route names override the base name when different, so variants remain distinguishable. Generated TOMLs remain the inputs to the published catalog. They can be rebuilt from the API without an existing Prime model list.
- Sparse metadata, unresolved lab identities and missing or unknown reasoning controls are reported for manual follow-up. Existing files for those still-listed IDs are retained; no placeholder controls or lab facts are invented, and the sync does not automatically open issues for sparse upstream rows.
- Models absent from the API or explicitly lacking tool/text support are removed. Empty, malformed and duplicate-ID inventories fail before writes. Internal/frontier namespaces, deployment-qualified IDs and uppercase namespaces are excluded; exact wire IDs are preserved on case-insensitive filesystems.
- Cache prices are omitted when unavailable, including removal of stale cache rates. Unpublished input-token limits are omitted; generic `file` input does not imply PDF support. Reasoning options use the published per-model `reasoning_effort` values, including `none` when advertised.

## EmpirioLabs Notes

EmpirioLabs is implemented in `packages/core/src/sync/providers/empiriolabs.ts`.

- Source endpoint: the public `https://api.empiriolabs.ai/v1/models`. Only `category = "text"` models without a `:` lane suffix are synced.
- Prices, limits, modalities, `supported_parameters` reasoning controls (`enable_thinking`, `reasoning_effort`, `thinking_budget`) and display names come from the catalog. Effort lists are sorted low to high.
- `structured_output` is `"json_schema"`, `"json_object"` or `"none"` (https://docs.empiriolabs.ai/compatibility.md); `"none"` syncs as false.
- `deprecated = true` sets `status = "deprecated"`; otherwise an existing status is kept.
- A `cache` or `prompt_cache` feature sets `capabilities.cache = { implicit = true }` in v2 files that have no cache kinds yet. Authored `implicit` / `explicit` details are kept.
- `base_model` files never carry model facts (dates, `family`, `knowledge`, `open_weights`); they come from the lab. Only standalone files keep them.

## OpenRouter Notes

OpenRouter is implemented in `packages/core/src/sync/providers/openrouter.ts`.

- Source endpoint: `https://openrouter.ai/api/v1/models`.
- Optional auth: `OPENROUTER_API_KEY`.
- Model IDs map directly to TOML paths under `providers/openrouter/models`.
- API prices are per-token strings and are converted to per-1M-token numbers.
- `structured_output` comes from `supported_parameters.includes("structured_outputs")` only.
- Existing `status`, `interleaved`, `knowledge`, `limit.input`, and `cost.tiers` may be preserved when OpenRouter is not authoritative enough for those fields.
- Canonical OpenRouter model IDs should emit `base_model` references to model metadata when a matching `models/` entry exists.

## Kilo Gateway Notes

Kilo Gateway is implemented in `packages/core/src/sync/providers/kilo.ts`.

- Source endpoint: `https://api.kilo.ai/api/gateway/models`.
- Optional auth: `KILO_API_KEY`.
- Model IDs map directly to TOML paths under `providers/kilo/models`.
- API prices are per-token strings and are converted to per-1M-token numbers.
- `structured_output` comes from `supported_parameters.includes("structured_outputs")` only.
- Existing `status`, `interleaved`, `knowledge`, `limit.input`, and `cost.tiers` may be preserved when Kilo is not authoritative enough for those fields.
- Canonical Kilo model IDs should emit `base_model` references to model metadata when a matching `models/` entry exists.
- `reasoning_options` is derived from `opencode.variants` when present.

## Merge Gateway Notes

Merge Gateway is implemented in `packages/core/src/sync/providers/merge-gateway.ts`.

- Source endpoint: `https://api-gateway.merge.dev/v1/models`.
- Required auth: `MERGE_GATEWAY_API_KEY`.
- The sync follows `next_cursor` until every page has been fetched.
- The canonical provider's available vendor route supplies pricing, limits, and capabilities. When it is unavailable, the sync matches Gateway's default resolver by selecting the active route with the lowest combined input and output price; the API's CMS-priority order breaks ties.
- Canonical model IDs emit `base_model` references to model metadata when a matching `models/` entry exists.
- Local models missing from the response are retained because API-key policy can affect catalog visibility.
- `pricing.long_context` becomes a context tier; a null long-context rate keeps the base rate.
- Routes whose `pricing.unit` isn't `per_token` (per second, image or character) report 0 per-token prices, so the sync writes no token price for them and the file's own unit price (e.g. `cost.audio.input` with `unit = "second"`) is kept by hand.
- Effort values are written low to high. New files with a reasoning toggle get the `thinking.type` wire-path header.
- `capabilities.cache` and the mid-conversation flags are hand-authored (see `providers/merge-gateway/provider.toml`); the catalog doesn't list a route's caching family.

## Cloudflare Workers AI Notes

Cloudflare Workers AI is implemented in `packages/core/src/sync/providers/cloudflare-workers-ai.ts`.

- Source endpoint: `https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID/ai/models/search?format=openrouter`.
- Required auth: `CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID` and `CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN`.
- Use a dedicated token scoped to Workers AI read access so sync automation does not share deploy credentials.
- The endpoint is parsed as Cloudflare's OpenRouter-like Workers AI metadata.
- Model IDs map directly to TOML paths under `providers/cloudflare-workers-ai/models`.
- This target only manages Workers AI; the separate Cloudflare AI Gateway target handles proxied third-party models.

## Cloudflare AI Gateway Notes

- Cloudflare AI Gateway is implemented in `packages/core/src/sync/providers/cloudflare-ai-gateway.ts`.
- Source endpoints: `GET /accounts/{id}/ai/catalog/models` for model availability, context limits, and pricing, plus `GET /accounts/{id}/ai/catalog/models/{model}/schema` for reasoning controls exposed by compatible schemas.
- Required auth: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or the production-token aliases documented in the provider README for local runs. The hourly workflow uses the canonical secret names.
- The sync manages proxied third-party models. Text-generation rows become normal model files. `Text-to-Speech`, `Automatic Speech Recognition`, image (`Text-to-Image`, `Image-to-Image`) and video (`Text-to-Video`, `Image-to-Video`, `video-to-video`) rows become v2-only files (`v2_only = true`) on the REST API's `POST /ai/run` route, with per-character, per-minute, per-image, per-megapixel, per-second or per-token costs. Music generation, image-to-document and `websocket` rows are left out on purpose, and image/video ids without a lab file stay in `skip`. Workers AI `@cf/...` models remain under `providers/cloudflare-workers-ai`.
- `providers/cloudflare-ai-gateway/curation.toml` supplies base-model mappings, live-tested reasoning controls, structured-output support, limit overrides, and intentional skips that the catalog cannot express authoritatively.
- New catalog entries without canonical lab metadata or required reasoning controls fail closed instead of generating incomplete TOMLs.

## Google Notes

Google is implemented in `packages/core/src/sync/providers/google.ts`.

- Source endpoint: `https://generativelanguage.googleapis.com/v1beta/models`.
- Required auth: `GOOGLE_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`.
- Model IDs are derived from the `models/{model}` resource names.
- The API is authoritative for display names, temperature metadata, and the `thinking` flag when present. Token limits normally come from the API, except Gemini 2.5 Computer Use, Gemini 3 Pro Image, and two Gemini 3.1 Flash Image variants whose model-specific cards document different limits.
- Local Google models missing from the API response are removed.
- New Google API models are not created automatically (`skipCreates`) and do not open missing-model issues because the endpoint is not lifecycle-authoritative.
- Missing-model tracking is limited to recognizable public model families; opaque API codenames such as `ajax`, `perseus`, and `thorin` are ignored.

## GitHub Copilot Notes

GitHub Copilot is implemented in `packages/core/src/sync/providers/github-copilot.ts`.

- Source: `https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml`
- The YML contains only token rates, so the sync only updates `[cost]`: `input`, `cached_input` (as `cache_read`), `cache_write`, `output`, and long-context rows as `cost.tiers`.
- Display names are converted to file IDs, with minimal special case logic to match existing model entries.
- Unmatched rows open missing-model issues, and local entries missing from the source are kept.
- When removing a fully retired Copilot model, add its pricing-table slug to `IGNORED_ROWS` so stale pricing rows cannot trigger translation or missing-model issues. Models still served to some subscribers (such as Sonnet 4.6 on annual plans) remain eligible.

## Novita AI Notes

- Source: `https://api.novita.ai/openai/v1/models`.
- CI key: `NOVITA_AI_API_KEY`; locally `NOVITA_AI_MODELS_DEV_KEY` takes precedence when set.
- Sync existing chat models' input/output/cache prices, context/output limits, and context pricing tiers only. Preserve curated capabilities, reasoning controls, dates, descriptions, optional pricing, and leading wire/source comments.
- Decimal `price_per_m_decimal` fields are USD/MTok; legacy integer fields are scaled by 10,000.
- New eligible models use the existing missing-model issue-fixer pipeline, which opens separate PRs without enabling auto-merge. The update-only sync PRs use the normal auto-merge policy; no provider-specific exception is needed.
- Never delete entries absent from the account-scoped inventory. In particular, the list omits working embedding/reranking routes. These remain hand-authored.
- Skip deferred Sao10K routes, known unadvertised/development aliases, non-chat rows, zero-limit placeholders, and unpriced rows.

## Mistral Notes

Mistral is implemented in `packages/core/src/sync/providers/mistral.ts`.

- Run it with `bun models:sync mistral` or `bun mistral:sync`.
- Source endpoint: `https://api.mistral.ai/v1/models`; required auth: `MISTRAL_API_KEY`.
- Every alias is listed as its own row, so existing alias TOMLs such as `mistral-small-latest` are updated from the model the alias currently resolves to.
- The API is authoritative for the served context window (`max_context_length`), tool calling, reasoning support, image and audio input, and deprecation. The served context can be smaller than the documented one; Mistral Large 4 serves 524,288 tokens although its model card advertises 1M.
- `deprecation` is incomplete: the API still serves some models Mistral's docs list as deprecated with `deprecation: null`. Those IDs are pinned in `DEPRECATED_IDS` in `mistral.ts` so the sync keeps them deprecated instead of clearing an authored `status`. Models absent from `/v1/models` are never touched, so mark them deprecated in their TOML.
- Pricing, output limits, reasoning controls, dates, and other metadata stay hand-authored because the endpoint does not expose them.
- Reasoning controls are checked, not written. For each reasoning model the sync sends one chat request with `reasoning_effort: "minimal"` and `max_tokens: 1`; Mistral's rejection lists the accepted values. If they differ from the authored `effort` values, the model's file is left unchanged and a missing-model issue is opened with the diagnostic. This catches aliases that move to a model with different controls. Accepted values can include aliases (Mistral silently accepts `minimal` on `zai-glm-5-2`), so a probe that succeeds or returns an unrecognized message is treated as unknown and skips the check rather than writing guessed values.
- A model that newly reports reasoning without authored `capabilities.reasoning` controls also fails closed with a missing-model issue.
- Ordinary auto-merge rules apply: context, tool-calling, and modality updates can auto-merge, while any change to reasoning metadata still requires manual review because Mistral is not a reviewed reasoning provider.
- Embedding, OCR, moderation, transcription, and TTS rows carry no chat metadata; their existing TOMLs are kept unchanged except for API tables.
- API tables follow the capabilities: `completion_fim` adds `[api.fim]` (`/v1/fim/completions`), `moderation` adds `[api.moderations]` and `ocr` adds `[api.ocr]`, each with `aisdk = "none"` and `opencodeai = "none"`. They come after the file's first table, which v1 reads and the sync leaves alone; a file with none starts with Chat Completions, or with the model's only API.
- New chat models are not created automatically (`skipCreates`). Each opens one deduped missing-model issue under its canonical ID (the row whose `id` equals its `name`), not once per alias.
- Local models absent from the response are retained (`deleteMissing: false`) because the listing is scoped to the key's workspace and drops retired models.

## xAI Notes

xAI is implemented in `packages/core/src/sync/providers/xai.ts`.

- Source endpoints: `https://api.x.ai/v1/language-models`, `https://api.x.ai/v1/image-generation-models`, and `https://api.x.ai/v1/video-generation-models`.
- Required auth: `XAI_API_KEY`.
- The richer typed endpoints provide model IDs, creation timestamps, modalities, pricing for language models, and prompt/input limits where available.
- Existing xAI models are updated from API-authoritative fields while local metadata is preserved for fields the API does not expose, especially output token limits and some feature/capability flags.
- New xAI API models are not created automatically (`skipCreates`); each missing ID opens a deduped GitHub issue. Alias IDs of models already cataloged under their canonical ID are skipped silently and never reported as missing.

## Tinfoil Notes

- Tinfoil is implemented in `packages/core/src/sync/providers/tinfoil.ts`.
- Source endpoint: `https://inference.tinfoil.sh/v1/models`.
- No authentication is required; the catalog is public.
- Existing Tinfoil models are updated from API-authoritative input, output, cached-input pricing, context windows, reasoning capability, and catalog availability.
- Provider-specific metadata that the endpoint does not expose, including exact modalities, output limits, reasoning controls, and lifecycle status, remains hand-authored.
- Reasoning controls are preserved for reasoners and removed when the API reports `reasoning: false`. A reasoner without authored controls fails sync for manual review rather than inventing an empty control set.
- New token-priced chat, safety, and embedding models are not created automatically (`skipCreates`); each missing ID opens a deduped GitHub issue for hand-authored metadata.
- Per-request tool, TTS, transcription, realtime, and document-processing services are ignored because their pricing cannot be represented by the token-cost schema.

## Morph Notes

- Morph is implemented in `packages/core/src/sync/providers/morph.ts`.
- Source endpoint: `https://www.morphllm.com/api/models/json?prices=list`, the direct API list rates. The bare URL is Morph's OpenRouter provider feed and carries OpenRouter channel prices, so the sync never reads it.
- No authentication is required; the catalog is public.
- Existing Morph models are updated from the feed's input, cached-input and output prices and its context and output limits.
- Reasoning controls, input MIME types, standby tiers, Messages API support and mid-conversation flags stay hand-authored from live probes.
- New models are not created automatically (`skipCreates`); each missing ID opens a deduped GitHub issue. OpenRouter alias IDs (`morph-dsv4flash-0731`) and entries with `is_ready: false` are skipped silently. Files absent from the feed, such as `auto`, are kept.

## NEAR AI Cloud Notes

- NEAR AI Cloud is implemented in `packages/core/src/sync/providers/nearai.ts`.
- Source endpoint: `https://cloud-api.near.ai/v1/models`.
- No authentication is required; the catalog is public, so the sync needs no repository secret.
- Existing models are updated from API-authoritative input, output and cached-input pricing, and context windows. Nothing else is taken from the endpoint.
- `pricing.input` and `pricing.output` are already dollars per million tokens, while `pricing.input_cache_read` is per token and is scaled. Every published price is rounded because the endpoint returns artifacts such as `1.4000000000000001`.
- `context` is synced only for models NEAR AI hosts itself (`owned_by = "nearai"`), where `context_length` is the serving `max_model_len`. On relayed routes the figure comes from the upstream aggregator and is often rounded below the lab entry, so syncing it would publish a cap the host does not impose. Where it is synced it is taken as the lower of the two values, so a smaller verified cap survives.
- `limit.output` is never synced. `max_output_length` is advisory rather than enforced: a request above it is accepted, and only exceeding the context window is rejected.
- No capability is taken from the endpoint, because its capability fields are wrong in both directions. `supported_features` lists `reasoning` for relayed routes that accept every documented reasoning parameter and still return no reasoning content, and omits it for others that plainly reason. `input_modalities` advertises image input for routes that reject it, and also reports an `embedding` modality the schema has no value for.
- `capabilities.tools`, `structured_output` and lifecycle `status` are hand-authored.
- New models are created as `base_model` overlays carrying only `cost`, keyed to the lab entry at `models/<lab>/<model>.toml` (NEAR AI namespaces such as `qwen`, `x-ai` and `z-ai` are mapped to `alibaba`, `xai` and `zhipuai`). Everything else, including limits, modalities, release date and knowledge cutoff, is inherited from the lab entry.
- A new model whose lab entry has `reasoning = true` is not created. The endpoint says nothing about how a route turns reasoning on, off or up, so the run opens a deduped GitHub issue asking for the route's controls to be researched and hand-authored in `capabilities.reasoning`. Once that file exists, the sync keeps it priced like any other. Reasoning is judged from the lab entry, never from `supported_features`.
- A live model with no lab entry is not created either, and opens a missing-model issue. `openai/privacy-filter` is skipped silently because the token-cost schema cannot describe it.
- Absence removes a model, so the fetch refuses a response carrying fewer than twenty models: a truncated list that still parses would otherwise be indistinguishable from a mass retirement. A local entry the catalog cannot price is republished unchanged rather than dropped, because dropping it would delete a route that is still served.

## OpenAI Notes

- OpenAI is implemented in `packages/core/src/sync/providers/openai.ts`.
- Source endpoint: `https://api.openai.com/v1/models`.
- Required auth: `OPENAI_API_KEY` from an automation account with access to the full first-party catalog.
- The endpoint is used only to monitor catalog availability. Existing TOMLs are preserved byte-for-byte, including models absent from the response, because model access can be scoped to the API project.
- Fine-tuned and customer-owned models are excluded. Unknown first-party models are ignored because the endpoint does not provide enough lifecycle or visibility metadata to distinguish public catalog additions.

## Meta Notes

- Run with `bun models:sync meta` or as part of the `direct` group. Registration also enables the hourly provider-specific workflow; no new secret is required.
- Sources: `https://dev.meta.ai/docs/models.md` and `https://dev.meta.ai/docs/pricing-rate-limits.md`.
- Meta's `/v1/models` endpoint is team-scoped and exposes IDs and registry timestamps, not pricing or limits. Use the public documentation instead of treating account-visible IDs as public catalog additions.
- Sync only the token-priced text models in the public model table. Update standard/contributor input, output, and cached-input USD/MTok prices and context windows. Keep output limits, modalities (including audio support caveats), reasoning controls, dates, inheritance, and other authored fields unchanged.
- New documented models open deduped missing-model issues for manual authoring (`skipCreates`); local models absent from the docs are retained (`deleteMissing: false`). Image generation, transcription, and self-hosted models are outside this sync's scope.
- Missing tables, unknown pricing tiers, invalid prices/limits, and duplicate model rows fail before writing. Documentation format changes require updating the parser, not guessing defaults.

## OVHcloud Notes

OVHcloud AI Endpoints is implemented in `packages/core/src/sync/providers/ovhcloud.ts`.

- Source endpoint: `https://catalog.endpoints.ai.ovh.net/rest/v2/openrouter`.
- No auth required: the catalog is public.
- Model IDs are lowercased from the catalog `id` to match the existing TOML paths under `providers/ovhcloud/models`.
- API prices are per-token strings and are converted to per-1M-token numbers; free models (price `0`) get no `[cost]` section.
- `reasoning`, `tool_call`, and `structured_output` come from `supported_features`; `temperature` comes from `supported_sampling_parameters`.
- Authored `reasoning_options` are preserved for reasoning models. `Qwen3-32B` supports toggling reasoning through OVHcloud's documented `/no_think` prompt control. Both gpt-oss models support `low`, `medium`, and `high` reasoning effort. The Qwen3.5 models support `none`, `low`, `medium`, and `high`; Qwen3.6-27B additionally supports `minimal`.
- `attachment` is derived from non-text `input_modalities`, and `open_weights` from the presence of `hugging_face_id`.
- `release_date`/`last_updated` default to the catalog `created` timestamp but preserve any existing hand-authored dates; `knowledge`, `family`, `status`, `interleaved`, and `limit.input` are preserved when present.

## Fireworks AI Notes

Fireworks AI is implemented in `packages/core/src/sync/providers/fireworks-ai.ts`.

- Run it with `bun models:sync fireworks-ai` or `bun fireworks:sync`.
- Source endpoint: `https://api.fireworks.ai/v1/serverless/models`; required auth: `FIREWORKS_API_KEY`.
- The serverless catalog exposes one row per serving mode with live per-million-token pricing, invocation identifiers, aliases, advertised context length, and input/output modalities.
- Standard rows update base-model IDs. Fast and other alternate-resource rows update the model or router named by `usage_identifier`; their aliases are tracked as additional invocation IDs. Standard-path aliases inherit the base model's flag modes. Flag-only modes such as Priority become priced `experimental.modes` with the required request-body `service_tier` instead of duplicate catalog IDs. A priority-only model remains discoverable with that service-tier recipe on its base ID.
- New text/vision invocation IDs are reported but not created automatically because the endpoint does not yet provide output limits, reasoning controls, tool support, or open-weight status. Embedding/reranking rows are ignored because the catalog provider entries describe generation models.
- Pricing and modalities come from the matching serverless serving mode; complete API pricing can seed an existing model whose authored TOML has no cost. Existing exact context caps smaller than the advertised API value are preserved, while a lower API ceiling is applied. Authored output limits, reasoning options, tool support, and other metadata not exposed by the endpoint are preserved.
- Models absent from the serverless response are retained for manual lifecycle review.

## DigitalOcean Notes

- DigitalOcean is implemented in `packages/core/src/sync/providers/digitalocean.ts`.
- Source endpoints: `https://api.digitalocean.com/v2/gen-ai/models` for lifecycle and reasoning metadata, and the public `https://api.digitalocean.com/v2/gen-ai/models/catalog` for availability, modalities, limits, and pricing.
- Required auth: `DIGITALOCEAN_API_TOKEN` or `DIGITALOCEAN_ACCESS_TOKEN` for the control-plane model endpoint; the model catalog is public.
- The sync manages serverless text-output models. Other model types, dedicated-only models, and local models absent from the API are retained for manual lifecycle review.
- Catalog pricing updates standard, cache-read, cache-write, and extended-context rates while preserving authored reasoning and audio prices.

## Vercel Status

Vercel is intentionally not wired into `bun models:sync` right now. Keep using the existing `vercel:generate` script until Vercel sync behavior is redesigned and reviewed separately.

`vercel:generate` reads `reasoning_options` from the public Vercel AI Gateway `/v1/models` catalog when present. It removes a redundant toggle if effort includes `none`, retains authored controls when catalog controls are absent or unrecognized, and treats an explicit empty list as no caller controls. This does not change the Vercel scheduling policy above.

Do not add Vercel model changes to OpenRouter sync PRs.

## Chutes Notes

Chutes is implemented in `packages/core/src/sync/providers/chutes.ts`.

- Run it with `bun models:sync chutes` or `bun chutes:sync`.
- Source endpoint: `https://llm.chutes.ai/v1/models`; no auth required (the model list is public).
- Model IDs map directly to TOML paths under `providers/chutes/models`.
- `reasoning`, `tool_call`, and `structured_output` come from `supported_features`; `temperature` comes from `supported_sampling_parameters`.
- Reasoning controls (`capabilities.reasoning`) are hand-authored, not derived: the API advertises a `reasoning` capability but no toggle or effort parameter, while the models accept a `chat_template_kwargs` thinking switch (`enable_thinking` for Qwen/Gemma, `thinking` for Kimi/GLM/DeepSeek). The sync leaves the field unset so authored options survive; new reasoners without an entry still default to an empty array.
- TEE model IDs emit `base_model` references to matching `models/` metadata; checkpoints without a canonical entry (e.g. `Qwen3-235B-A22B-Thinking-2507`, `DeepSeek-V3.2`) are written inline.
- `attachment` is derived from non-text `input_modalities`, and all models are `open_weights`.
- `release_date`/`last_updated` default to the API `created` timestamp but preserve existing hand-authored dates; `knowledge`, `family`, `status`, `interleaved`, and `limit.input` are preserved when present.

## Requesty Notes

Requesty is implemented in `packages/core/src/sync/providers/requesty.ts`.

- Run it with `bun models:sync requesty` or `bun requesty:sync`.
- Source endpoint: `https://router.requesty.ai/v1/models/managed`; no auth required (the managed catalog is public).
- The endpoint is the source of truth for prices, limits and capability flags. `preserveBaseModels` and `preserveDescriptions` are both `false`, so an upstream correction wins over a previously committed value. The translation reads two things back from the existing file:
  - `base_model`, but only when `resolveRequestyBaseModel` has no match for the ID. This keeps a route linked to its lab by hand (e.g. `seed-1.8` → `bytedance-seed/seed-1-8`). A hand-linked file also keeps a curated `name` (e.g. `inkling-256k` → "Inkling 256K"); it is dropped when it equals the lab's.
  - A curated `status`. The catalog's `retires` date is not synced, so `status = "deprecated"` is set by hand once a route retires.
- A catalog `max_output_tokens` of 0 means unknown. A linked file then inherits the lab's `limit.output` instead of the context-window fallback, unless the lab's output exceeds the context the route serves (then the context is the cap).
- Managed IDs are bare (`claude-opus-4-7`) or region-pinned (`gpt-5.4@eu`) rather than OpenRouter-shaped, so they resolve through `resolveModelMetadataBaseModel` after the `@<region>` qualifier is stripped. Resolved and hand-linked models emit `base_model` plus provider-specific overrides only; unmatched IDs are written as standalone files.
- Anthropic files `.0` releases with an explicit `-0` (`claude-sonnet-4-0.toml`) while later point releases drop it, so bare `claude-<tier>-<major>` IDs retry against the `-0` filename.
- Region variants are written as separate models: `gpt-5.4` and `gpt-5.4@eu` are distinct files that share a `base_model` and differ only in served pricing and limits.
- Prices are per-token USD and are converted to per-1M-token numbers. `pricing[]` bands become `cost.tiers`, with the first band as the flat `cost`. Price fields are nullable upstream, so a route quoting no prices gets no `[cost]` section rather than a fabricated zero.

## Venice Notes

Venice is implemented in `packages/core/src/sync/providers/venice.ts`.

- Run it with `bun models:sync venice` or `bun venice:sync`.
- `VENICE_API_KEY` is optional locally and includes models visible to that account when set.
- Models missing from the API response are removed from the Venice catalog.
- Every Venice model uses `base_model`; flattened IDs are matched to provider-agnostic metadata before provider-specific overrides are written.
- Every Venice model declares `reasoning_options`; models without API-provided effort levels use an empty array.

## engy Notes

engy is implemented in `packages/core/src/sync/providers/engy.ts`.

- Run it with `bun models:sync engy` or `bun engy:sync`.
- Source endpoint: `https://api.engy.ai/v1/models`; no auth required.
- The endpoint owns `cost.input`, `cost.output` and `cost.cache_read` while quoted, `limit.context` when positive, and `modalities` when it sends a recognised list (`file` maps to `pdf`).
- Every other authored field is preserved, including `limit.input`/`limit.output`, `reasoning_options`, `interleaved` and the other cost keys; no public endpoint reports them.
- `context_length` is `max_input + max_output`. When it no longer matches the authored split, the file is left alone and the model gets a `[missing-model]` issue to re-read the split from the authenticated `https://engy.ai/api/v1/models`.
- A price that is not a non-negative number fails the run; a row with an empty `id` is ignored.
- `skipCreates` and `trackMissingModels` are set: a created file would ship `limit.output = 0`. Unseen IDs open deduped `[missing-model]` issues.
- `deleteMissing` is `false`: the list is unauthenticated and `{"data":[]}` passes the schema, so a truncated 200 must not delete hand-measured files; they are retained and reported.
- An authored `base_model` wins over the resolver, so a miss never de-factors a committed file.
- Authoring a model from a `[missing-model]` issue:
  - Take `limit.input` and `limit.output` from `max_input_tokens` and `max_output_tokens` in the authenticated list. If the id is absent there, do not copy a sibling's split without saying so in the header; engy accepts an over-cap `max_tokens` (65,537 passes where the listed cap is 65,536), so a request cannot confirm the cap.
  - Point `base_model` at the lab entry for the exact id, adding it under `models/` if it is missing. Pointing at a sibling is not a substitute: because an authored `base_model` wins, the sync never corrects it later.
- Per-token USD string prices become per-1M, rounded to six decimals; two would carry float error otherwise.
- Modalities are sorted into catalogue order; wire order is arbitrary.

## Standalone Generators

Some provider scripts in `packages/core/script/generate-*.ts` are not wired into `bun models:sync`. When updating those scripts, preserve existing `base_model` and `base_model_omit` fields for generated TOMLs that already use model metadata inheritance. New inheritance-aware output should use `base_model`; do not reintroduce legacy `[extends]` syntax.

## ai& Notes

- Endpoint: `GET https://api.aiand.com/v1/api.json` (public, no auth). The module reads the `aiand` provider entry; `AIAND_API_URL` overrides the endpoint for staging dry runs.
- The feed publishes this repo's `api.json` shape, so translation is near-identity. The feed is authoritative for prices (including `cache_read`), limits, capability flags, modalities, gateway-enforced `reasoning_options`, and `deprecated` status; the `aiand` entry lists only models whose catalog metadata is complete.
- Curated values win for `name`, `description`, `knowledge`, `release_date`, and `last_updated` — the feed's `last_updated` tracks catalog-row edits, not model revisions, and release dates are lab metadata the gateway is not authoritative for. A curated alpha/beta `status` survives a feed that omits one; a curated `deprecated` does not, since the feed owns deprecation and absence means active.
- On base-factored files, lab-owned fields (`name`, `description`, `family`, `release_date`, `last_updated`, `knowledge`, `open_weights`) are never asserted from the feed: they appear only as deltas the authored TOML already carried on top of its `base_model` (read via `context.authored()`, never the base-resolved merge), so a full-inline file being factored for the first time — or a new file — inherits the lab entry outright. A new feed id resolves its `base_model` by normalized match against `models/` and is skipped with a report notice when nothing resolves — an unfactored full definition is never created. An empty feed fails the run rather than deleting the local catalog.
- `family` passes through `ModelFamily.safeParse` and is omitted when unknown.
- A skipped new id is returned from `missingModelID` (the only skip is "no lab base yet"), so the runner preserves any existing local entry and opens a deduped missing-model issue for the lab metadata.
- `preserveDescriptions` is off: the runner must not re-inject a pre-factor authored description when the translator leaves it unset, or a full-inline → factored transition would recreate a lab-identical override. Created files get a leading header from `translateModel` naming the single reasoning wire path (`reasoning_effort`, "none" = off). `toggle` and `budget_tokens` controls are parsed (so a feed that publishes one never aborts the run) but never written, from feed or authored file: ai& has no separate on/off or token-budget field, so they cannot be true of this host.
- `interleaved` comes from the feed when published, else the authored value, else `{ field = "reasoning_content" }` for reasoners — every ai& reasoner streams thinking in `message.reasoning_content`, so a new reasoner is never created without its side channel.
- A reasoner never gets an invented `[]`: an omitted feed list keeps the authored controls, and a non-empty list whose effort values the schema doesn't know yet does too; when neither yields a schema-valid set the model fails with `MissingReasoningOptionsError` — the runner preserves the local file and routes the id to the missing-model issue flow. Only an explicit `[]` published by the feed is written as "no caller control".
