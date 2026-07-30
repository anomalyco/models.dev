---
name: audit-reasoning-options
description: Audit or write models.dev reasoning_options in provider TOML files and reasoning-option PRs. Use when verifying toggle, effort, budget_tokens, provider reasoning controls, or citations.
---

# Audit Reasoning Options

Use this workflow to add or review `reasoning_options` for a specific provider. Treat these fields as provider capabilities, not provider-agnostic model facts.

Provider capability means the inference service's accepted HTTP request surface. It does not mean the controls exposed by the repository's configured npm package, a preferred SDK, or a typed client wrapper.

## Available Options

The schema in `packages/core/src/schema.ts` supports:

```toml
[[reasoning_options]]
type = "toggle"

[[reasoning_options]]
type = "effort"
values = ["low", "medium", "high"]

[[reasoning_options]]
type = "budget_tokens"
min = 1_024
max = 32_000
```

- `toggle`: The provider offers an explicit way to switch reasoning on and off for the same model ID.
- `effort`: The provider accepts one or more discrete effort values. Schema values are `null`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `default`.
- `budget_tokens`: The provider accepts a numeric reasoning-token budget. `min` and `max` are optional and must only be included when verified.
- `reasoning_options = []`: The model reasons, but no user-selectable control was verified through this provider.
- Omitted `reasoning_options`: No provider-specific claim has been authored. Do not treat omission as equivalent to an audited empty list.

An option describes a control exposed to a caller. Do not add an option merely because a model reasons internally or another provider exposes that control.

## Evidence Standard

Use evidence in this order:

1. The provider's current API reference or model documentation.
2. The provider's raw OpenAPI schema, compatibility endpoint documentation, model endpoint metadata, or playground request payload.
3. A reproducible request against the provider API, including a negative control with an invalid value where practical.
4. The provider's official SDK source, but only as positive evidence for requests it emits.
5. The upstream model developer's documentation.
6. High-quality secondary sources only as supporting context.

Provider documentation proves what the provider accepts. Upstream documentation proves what the model can support, but cannot by itself prove that a gateway forwards or exposes the control.

An SDK can prove support when it emits a field. An SDK's omission, type restriction, or missing convenience option does not prove the inference API rejects that field. Before removing a control because an SDK cannot express it, inspect raw HTTP docs, compatibility base URLs, passthrough guarantees, migration guides, and direct API behavior.

Prefer versioned or model-specific documentation over generic examples. Record the access date when a page is mutable or unversioned.

## Audit Workflow

1. Read the provider configuration to identify the API base URL and protocol. Record the SDK only as one possible client.
2. Inspect the PR diff and list every changed model with its exact proposed options.
3. Group models by API family or request adapter, not only by model developer.
4. Locate provider documentation for reasoning request fields and model-specific restrictions.
5. Check every raw compatibility endpoint the inference provider advertises, such as OpenAI-, Anthropic-, or provider-compatible base URLs. Existing calls working unchanged is positive evidence that native reasoning fields are accepted.
6. Cross-check upstream model documentation for supported values and ranges after establishing provider passthrough or translation.
7. Test the provider API when credentials are already available and documentation is incomplete. Never print credentials.
8. Compare each TOML claim independently: toggle, each effort value, budget support, minimum, and maximum.
9. Remove any claim that lacks inference-provider evidence. Do not remove it merely because one SDK lacks a type or helper.
10. Run `bun validate` and `git diff --check`.
11. Update the PR body with citations, request-field details, audit conclusions, and validation commands.

## Toggle Verification

Only add `toggle` if all of these are true:

- The same provider model ID can run with reasoning enabled and disabled.
- The caller controls the state through a documented or reproduced request.
- The exact field and values are known.

Examples of possible controls include `thinking.type = "enabled" | "disabled"`, `enable_thinking = true | false`, a documented `reasoning` object, or a provider-defined prompt switch such as `/think` and `/no_think`.

The following do not prove a toggle:

- Separate thinking and non-thinking model IDs.
- Omitting a reasoning budget when omission selects an automatic budget.
- Setting effort to `low` unless the provider says it disables reasoning.
- A model card saying the model is hybrid without provider request documentation.
- A provider UI switch when its API payload cannot be identified.

For every proposed toggle, write this sentence before accepting it:

> `<provider model ID>` toggles reasoning with `<request path>` set to `<enabled value>` or `<disabled value>`.

If that sentence cannot be completed and cited or reproduced, do not claim `toggle`.

## Effort Verification

Verify every value separately. Do not copy the schema's full enum into a model.

- For an OpenAI-compatible API, `low`, `medium`, and `high` are a useful investigation baseline, not proof.
- Require explicit evidence for `null`, `none`, `minimal`, `xhigh`, `max`, and `default`.
- Check model-specific differences. A generic gateway enum may be rejected or ignored by some routed models.
- Distinguish accepted values from meaningful values. If the gateway silently ignores a field, it is not a supported control.
- Preserve JSON `null` as TOML `null`, not the string `"null"`, when evidence requires a null value.

When practical, send one valid request per claimed value and one invalid value. A structured `400` for the invalid value makes silent field dropping less likely.

## Budget Verification

`budget_tokens` is an abstract models.dev capability; providers may spell it `reasoning.max_tokens`, `thinking.budget_tokens`, `thinkingBudget`, or another field.

- Cite the provider's actual request path.
- Verify that the field controls reasoning tokens rather than total output tokens.
- Do not infer `max` from `limit.output`, context length, or an upstream provider's limit.
- Do not infer a provider minimum from an SDK default.
- Omit unverified bounds while retaining verified budget support.
- Check whether zero or a negative sentinel disables reasoning. If so, verify whether this also proves `toggle` for that model.
- Check constraints relating budget to `max_tokens` or total output.

## API Testing

Use existing credentials only when permitted and necessary. Keep secrets out of commands, logs, files, PR bodies, and chat output.

For each control, prefer this matrix:

| Request | Expected evidence |
| --- | --- |
| No reasoning field | Establishes default behavior |
| Each claimed valid value | Successful response or documented acceptance |
| Explicit disabled value | Proves toggle-off behavior |
| One invalid value | Structured rejection rather than silent dropping |
| Boundary and adjacent value | Supports a claimed minimum or maximum |

Acceptance alone is weak when an OpenAI-compatible gateway ignores unknown fields. Inspect returned metadata, reasoning content, usage fields, or error behavior where available.

## Citations

Put citations in the PR body, not TOML comments. TOML model files should remain data-only unless the repository establishes another convention.

Use direct links to the narrowest authoritative section. For each link, state exactly what it proves:

```markdown
## Evidence

- [Provider reasoning API](https://example.com/api/reasoning) documents
  `reasoning_effort` values `low`, `medium`, and `high`.
- [Provider model page](https://example.com/models/foo) documents that
  `thinking.type = "disabled"` turns reasoning off for `foo`.
- [Upstream model documentation](https://example.com/upstream/foo) confirms
  the model-native budget range; provider requests at both boundaries succeeded.
```

Do not cite a search-results page, an AI-generated summary, or a generic upstream page for a provider-specific claim. If evidence comes from authenticated endpoint metadata or testing, describe the endpoint, date, request field, result, and negative control without including credentials or sensitive response data.

## PR Audit Output

For each audited PR, report:

- Models and proposed options.
- Verdict for every option: verified, corrected, or removed.
- Exact toggle mechanism, when applicable.
- Provider-level citations and what each proves.
- Upstream citations used only for model-specific constraints.
- Tests performed and their limitations.
- Final validation result.

If documentation is ambiguous, state the ambiguity and use the least permissive metadata supported by evidence.
