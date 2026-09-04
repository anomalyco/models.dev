TODO: delete

# Model Sync Scripts

Model syncs are centralized in `packages/core/src/sync/index.ts`. The runner owns file IO, TOML formatting, validation, reporting, dry runs, and deletion behavior. `packages/core/script/sync-models.ts` is only the CLI wrapper for `bun models:sync`. Individual provider sync modules only fetch source data, parse it, and translate each source model into the catalog schema.

The grouped sync targets are available for local convenience, but CI syncs each provider separately so every provider gets its own reusable automation PR.

## Commands

- `bun models:sync aggregators` syncs every provider in the `aggregators` group.
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
- `bun models:sync openai` syncs only OpenAI catalog availability.
- `bun models:sync github-copilot` syncs only GitHub Copilot pricing.
- `bun models:sync tinfoil` syncs only Tinfoil.
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
- Formats TOML consistently for all synced providers.
- Compares authored TOML shapes before writing so existing factored TOMLs stay factored instead of being expanded.
- Replaces symlinked files safely by removing the symlink before writing.
- Removes existing files that are no longer present in the desired synced set.
- Writes `.sync/model-sync-report.md` for GitHub Actions.
- When `skipCreates` is set and issue opens are enabled, opens one deduped GitHub issue per remote model missing from the local catalog (via `gh`).

Because the runner removes files missing from the desired set, a provider module should only skip source models when deleting existing local files for those skipped IDs is intentional.

## Missing-model GitHub issues

Providers that cannot safely auto-create TOMLs set `skipCreates: true`. In GitHub Actions (or with `--open-issues`), each skipped remote ID may open a GitHub issue unless the provider sets `trackMissingModels: false`:

1. Title: `[missing-model] <provider>: <model-id>` (stable for dedupe)
2. Labels: `automation`, `model-sync`, `missing-model`, `provider:<id>`
3. Lists existing issues (open **and** closed) with those labels; skips create when the title already exists
4. Dispatches the Issue Fixer explicitly so issues created with `GITHUB_TOKEN` can still produce PRs
5. If listing fails, creates nothing (fail closed)

Requires `GH_TOKEN` on the sync workflow step. Local runs are notice-only unless `--open-issues`. Use `--no-issues` / `--dry-run` to skip creates. Each newly opened issue explicitly dispatches the issue-fixer workflow so an agent can research the missing metadata and open a model PR.

The first Actions run may open a batch of issues per provider, including remote IDs the catalog intentionally omits (e.g. OpenAI whisper/tts/moderation surfaces, dated snapshots). This one-time volume is accepted by design: close unwanted issues once and the closed-title dedupe suppresses them permanently. If the dedupe list window (1000 labeled issues per provider) ever fills, the sync fails closed and creates nothing rather than risk duplicates.

Pioneer and Ofox track remote-only chat models as missing-model issues. Their APIs are not authoritative enough to create complete TOMLs directly, so the issue-fixer agent researches the missing canonical and provider-specific metadata before opening a PR.

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
- Reasoning effort options are derived from the lab's provider entry or OpenRouter. A toggle-only or budget-only control is not an effort list; do not invent effort levels.
- When the effort mapper cannot resolve controls, preserve the existing route's authored `reasoning_options` while syncing other authoritative fields. Do not replace authored toggle, effort, or budget controls with `[]`.
- New reasoning models with neither a resolved mapping nor authored controls remain skipped for manual authoring. No empty placeholder is generated, so the normal auto-merge policy remains unchanged; legitimate always-on `[]` entries are not blanket-blocked.
- Intentional route deduplication and removal of IDs absent from the upstream catalog are unchanged.

## CrossModel Notes

CrossModel is implemented in `packages/core/src/sync/providers/crossmodel.ts`.

- Source endpoint: `https://www.crossmodel.ai/api/models`.
- Pricing, context/output limits, modalities, and reasoning controls come from CrossModel's public catalog.
- `structured_output` comes from `capabilities.json`; when that field is absent, the sync preserves an existing authored override.
- Other intrinsic model facts remain inherited from the canonical `base_model` metadata.

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
- The sync manages proxied third-party text-generation models only. Workers AI `@cf/...` models remain under `providers/cloudflare-workers-ai`.
- `providers/cloudflare-ai-gateway/curation.toml` supplies base-model mappings, live-tested reasoning controls, structured-output support, limit overrides, and intentional skips that the catalog cannot express authoritatively.
- New catalog entries without canonical lab metadata or required reasoning controls fail closed instead of generating incomplete TOMLs.

## Google Notes

Google is implemented in `packages/core/src/sync/providers/google.ts`.

- Source endpoint: `https://generativelanguage.googleapis.com/v1beta/models`.
- Required auth: `GOOGLE_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`.
- Model IDs are derived from the `models/{model}` resource names.
- The API is authoritative for display names, token limits, temperature metadata, and the `thinking` flag when present.
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

## DigitalOcean Notes

- DigitalOcean is implemented in `packages/core/src/sync/providers/digitalocean.ts`.
- Source endpoints: `https://api.digitalocean.com/v2/gen-ai/models` for lifecycle and reasoning metadata, and the public `https://api.digitalocean.com/v2/gen-ai/models/catalog` for availability, modalities, limits, and pricing.
- Required auth: `DIGITALOCEAN_API_TOKEN` or `DIGITALOCEAN_ACCESS_TOKEN` for the control-plane model endpoint; the model catalog is public.
- The sync manages serverless text-output models. Other model types, dedicated-only models, and local models absent from the API are retained for manual lifecycle review.
- Catalog pricing updates standard, cache-read, cache-write, and extended-context rates while preserving authored reasoning and audio prices.

## Vercel Status

Vercel is intentionally not wired into `bun models:sync` right now. Keep using the existing `vercel:generate` script until Vercel sync behavior is redesigned and reviewed separately.

Do not add Vercel model changes to OpenRouter sync PRs.

## Chutes Notes

Chutes is implemented in `packages/core/src/sync/providers/chutes.ts`.

- Run it with `bun models:sync chutes` or `bun chutes:sync`.
- Source endpoint: `https://llm.chutes.ai/v1/models`; no auth required (the model list is public).
- Model IDs map directly to TOML paths under `providers/chutes/models`.
- `reasoning`, `tool_call`, and `structured_output` come from `supported_features`; `temperature` comes from `supported_sampling_parameters`.
- `reasoning_options` is hand-authored, not derived: the API advertises a `reasoning` capability but no toggle or effort parameter, while the models accept a `chat_template_kwargs` thinking switch (`enable_thinking` for Qwen/Gemma, `thinking` for Kimi/GLM/DeepSeek). The sync leaves the field unset so authored options survive; new reasoners without an entry still default to an empty array.
- TEE model IDs emit `base_model` references to matching `models/` metadata; checkpoints without a canonical entry (e.g. `Qwen3-235B-A22B-Thinking-2507`, `DeepSeek-V3.2`) are written inline.
- `attachment` is derived from non-text `input_modalities`, and all models are `open_weights`.
- `release_date`/`last_updated` default to the API `created` timestamp but preserve existing hand-authored dates; `knowledge`, `family`, `status`, `interleaved`, and `limit.input` are preserved when present.

## Requesty Notes

Requesty is implemented in `packages/core/src/sync/providers/requesty.ts`.

- Run it with `bun models:sync requesty` or `bun requesty:sync`.
- Source endpoint: `https://router.requesty.ai/v1/models/managed`; no auth required (the managed catalog is public).
- The endpoint is the sole source of truth. `preserveBaseModels` and `preserveDescriptions` are both `false` so an upstream correction always wins over a previously committed value; local TOMLs are never read back into the translation.
- Managed IDs are bare (`claude-opus-4-7`) or region-pinned (`gpt-5.4@eu`) rather than OpenRouter-shaped, so they resolve through `resolveModelMetadataBaseModel` after the `@<region>` qualifier is stripped. Every model emits `base_model` plus provider-specific overrides only.
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

## Standalone Generators

Some provider scripts in `packages/core/script/generate-*.ts` are not wired into `bun models:sync`. When updating those scripts, preserve existing `base_model` and `base_model_omit` fields for generated TOMLs that already use model metadata inheritance. New inheritance-aware output should use `base_model`; do not reintroduce legacy `[extends]` syntax.
