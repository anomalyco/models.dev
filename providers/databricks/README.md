# Databricks ([models.dev](http://models.dev))

Enterprise catalog metadata for **Databricks Foundation Model APIs** exposed through **Databricks AI Gateway**. Published data appears in `**api.json`** after site generation: integrators read `**npm**`, `**api**`, optional per-model `**provider**`, and capability fields to configure production clients—without embedding workspace secrets in source control.

---

## Scope


| Item                       | Definition                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What is catalogued**     | AI Gateway routes whose names begin `**databricks-`** and that reference Unity Catalog `**system.ai.***` pay-per-token foundation model destinations.                                  |
| **Default contract**       | OpenAI-compatible **chat** and **embeddings** on `**…/mlflow/v1`** via `**@databricks/ai-sdk-provider**` ([npm](https://www.npmjs.com/package/@databricks/ai-sdk-provider)) (`[provider.toml](./provider.toml)`). |
| **Native vendor surfaces** | Selected models override `**npm`** / `**api**` for **Anthropic Messages**, **Gemini `generateContent`**, and **OpenAI Responses**—all on the **same `ai_gateway_url` host** as MLflow. |


---

## Stakeholders


| Audience                  | Value                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Application teams**     | Stable model identifiers, modality and limit metadata, and SDK package hints from `**api.json`**.                        |
| **Platform engineering**  | Documented discovery flow, HTTP layout on AI Gateway, and alignment with Databricks access controls.                     |
| **Security & compliance** | Repository holds **templates and metadata only**; credentials and tokens remain in your vault and runtime configuration. |


---

## Databricks product references

- [AI Gateway](https://docs.databricks.com/en/generative-ai/ai-gateway/index.html)  
- [Foundation Model APIs](https://docs.databricks.com/en/machine-learning/foundation-models/index.html)  
- [Provider native APIs](https://docs.databricks.com/aws/en/machine-learning/model-serving/provider-native-apis) 

---

## Logical architecture

```text
  Client (SDK)                    Databricks AI Gateway (host = ai_gateway_url)
       │                         ┌──────────────────────────────────────────────┐
       │  Authorization: Bearer   │  /mlflow/v1/*   OpenAI-compatible           │
       └────────────────────────►│  /anthropic/v1/messages   Claude            │
                                 │  /gemini/v1beta/...       Gemini            │
                                 │  /openai/v1/responses     OpenAI Responses   │
                                 └──────────────────────────────────────────────┘
       │                                    ▲
       │   GET /api/ai-gateway/v2/endpoints │
       └────────────────────────────────────┘
                    Workspace REST API
```


| Concern        | Owner                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `**api.json**` | Declares `**npm**`, `**api**`, optional `**models[id].provider**`, capabilities, limits.                                 |
| **Runtime**    | Substitutes `**<workspace-numeric-id>`**, performs discovery, attaches **Bearer** tokens, applies optional name aliases. |
| **Databricks** | Publishes `**name`** on each gateway route; clients send that string as the vendor `**model**` unless remapped.          |


---

## Discovery and identifiers

**Discovery**

```http
GET https://<workspace-host>/api/ai-gateway/v2/endpoints
```

Each item includes `**ai_gateway_url**`. Combine that host with each model’s `**api**` path from `**api.json**` (default `**/mlflow/v1**`, or the model-level `**provider.api**` suffix).

**Identifiers**

- **Catalog model ID** — Relative path under `**models/`** without `**.toml**` (example: `databricks-claude-sonnet-4-6`).  
- **Wire name** — Ordinarily identical to the catalog ID and to the gateway `**name`** returned by discovery.

**Eligibility for inclusion in this folder**

1. Gateway `**name`** prefix `**databricks-**`.
2. At least one `**config.destinations[]**` with `**type**` = `**PAY_PER_TOKEN_FOUNDATION_MODEL**` and `**name**` starting `**system.ai.**`.

**Reference implementation:** [databricks-ai-bridge](https://github.com/databricks/databricks-ai-bridge) (gateway host resolution and OpenAI client patterns).

---

## HTTP layout on AI Gateway

Let `**G`** = `https://<workspace-numeric-id>.ai-gateway.cloud.databricks.com` (from `**ai_gateway_url**`). All calls use one **Bearer** access token.


| Traffic class                    | `npm` (from `api.json`)     | `api` base (template) | Primary HTTP operations                                                                           |
| -------------------------------- | --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| General chat & OSS / open models | `@databricks/ai-sdk-provider` | `**G/mlflow/v1`**     | `POST …/chat/completions`                                                                         |
| Embeddings                       | *(same default)*            | `**G/mlflow/v1**`     | `POST …/embeddings`                                                                               |
| Claude                           | `@ai-sdk/anthropic`         | `**G/anthropic**`     | `POST …/anthropic/v1/messages` (supply `**anthropic-version**` per Anthropic client requirements) |
| Gemini                           | `@ai-sdk/google`            | `**G/gemini**`        | `POST …/gemini/v1beta/models/<model_id>:generateContent`                                          |
| OpenAI Responses                 | `@databricks/ai-sdk-provider` | `**G/openai/v1**`     | `POST …/openai/v1/responses` (TOML includes `**shape = "responses"**`; use provider `**responses**` in code) |


Per-model overrides live under `**[provider]**` in the corresponding `**models/*.toml**` files; all other rows inherit `[provider.toml](./provider.toml)`.

---

## Authentication and environment

```text
Authorization: Bearer <access_token>
```


| Credential style        | Typical inputs                                     |
| ----------------------- | -------------------------------------------------- |
| Personal access token   | `DATABRICKS_TOKEN`, workspace URL                  |
| User or delegated OAuth | Access token from your approved OAuth flow         |
| Service principal       | `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET` |


Environment keys commonly used with Databricks tooling are listed in `[provider.toml](./provider.toml)`. Authoritative OAuth and unified-authentication guidance is maintained by Databricks: start from **[Authorize access to Databricks resources](https://docs.databricks.com/aws/en/dev-tools/auth/)** (select your cloud if not on AWS).

---

## Consuming `api.json`

1. For each `**databricks.models[modelId]`**, read `**npm**`, `**api**`, and optional `**provider**` (when present, `**provider**` overrides the provider root for that model).
2. Resolve `**G**` via discovery or by substituting `**<workspace-numeric-id>**`.
3. Instantiate the SDK that matches `**npm**` and point it at the resolved base URL per that SDK’s conventions.
4. Pass the gateway `**name**` (usually `**modelId**`) as the vendor `**model**` parameter unless your organization uses an alias table.

**Example — default MLflow chat (TypeScript)**

```typescript
import { createDatabricksProvider } from "@databricks/ai-sdk-provider";
import { generateText } from "ai";

const baseURL =
  `https://${workspaceNumericId}.ai-gateway.cloud.databricks.com/mlflow/v1`;

const databricks = createDatabricksProvider({
  baseURL,
  headers: { Authorization: `Bearer ${token}` },
});

const wireId = aliases[catalogModelId] ?? catalogModelId;

await generateText({
  model: databricks.chatCompletions(wireId),
  prompt: "Hello",
});
```

**Example — default MLflow chat (Python)**

```python
from openai import OpenAI

base_url = f"https://{workspace_numeric_id}.ai-gateway.cloud.databricks.com/mlflow/v1"
wire_id = aliases.get(catalog_model_id, catalog_model_id)

client = OpenAI(api_key=token, base_url=base_url)
resp = client.chat.completions.create(
    model=wire_id,
    messages=[{"role": "user", "content": "Hello"}],
)
```

Claude and Gemini rows use `**@ai-sdk/anthropic**` and `**@ai-sdk/google**` respectively. MLflow chat/embeddings and OpenAI Responses use `**@databricks/ai-sdk-provider**` with the `**api**` templates in `**api.json**` (Responses: set `**baseURL**` to the resolved `**/openai/v1**` host and call `**responses(modelId)**` on the provider instance).

---

## Model catalog

- **Count:** 36 models (catalog review date `**2026-04-11`**).  
- **Availability** depends on region, workspace entitlements, and `**system.ai.*`** registration—validate with discovery in each target workspace.  
- **Embeddings** are tagged `**family = "text-embedding"`**; product UIs that list only chat models should exclude that family.

---

## Catalog field policy

Maintain `**release_date**`, `**last_updated**`, `**[limit]**`, and capability flags in line with [Foundation Model APIs](https://docs.databricks.com/en/machine-learning/foundation-models/index.html) and your deployment. **Unit pricing is not represented** in these TOMLs: FMA economics are account- and contract-specific on Databricks; downstream systems should source commercial terms from your billing and procurement tools.

---

## Development and verification

**Repository checks (no workspace access required)**

```bash
bun install
bun validate
cd packages/web && bun run build
```

**Workspace-backed scripts** (Databricks authentication required, e.g. `**~/.databrickscfg`** profile or equivalent env for `**@databricks/sdk-experimental**`)


| npm script                                               | Purpose                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `bun run databricks:list-gateway -- --profile PROFILE`   | Lists or `**--json**` exports routes matching this catalog’s filter.                          |
| `bun run databricks:test-inference -- --profile PROFILE` | Exercises each catalog route against AI Gateway (`--only`, `--delay-ms`, `--json` supported). |


Scripts: `[list-databricks-ai-gateway.ts](./scripts/list-databricks-ai-gateway.ts)`, `[test-databricks.ts](./scripts/test-databricks.ts)`.

---

## Upstream contribution

Changes intended for **[anomalyco/models.dev](https://github.com/anomalyco/models.dev)** follow the [repository contributing guide](../../README.md#contributing). Preserve the `**api`** / `**[provider]**` layout described here, keep secrets out of the tree, and run `**bun validate**` before submitting.

---

## Additional references


| Resource                                                                                   | URL                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation Model API reference                                                             | [https://docs.databricks.com/en/machine-learning/foundation-models/api-reference.html](https://docs.databricks.com/en/machine-learning/foundation-models/api-reference.html) |
| Databricks authentication and OAuth (PAT, user OAuth, service principal M2M, unified auth) | [https://docs.databricks.com/aws/en/dev-tools/auth/](https://docs.databricks.com/aws/en/dev-tools/auth/)                                                                     |
| models.dev API                                                                             | [https://models.dev/api.json](https://models.dev/api.json)                                                                                                                   |
| Provider logo (after site build)                                                           | [https://models.dev/logos/databricks.svg](https://models.dev/logos/databricks.svg)                                                                                           |


