#!/usr/bin/env bun
/**
 * models.dev — Databricks provider integration test (single script).
 *
 * Calls the live AI Gateway for every catalog-aligned route from discovery, using the
 * same HTTP surfaces as `providers/databricks` TOMLs + `api.json`:
 *   mlflow/v1 chat & embeddings | openai/v1/responses | anthropic/v1/messages | gemini/.../generateContent
 *
 * Prerequisites: Databricks auth (~/.databrickscfg profile or env for @databricks/sdk-experimental).
 *
 * Repo root:
 *   bun run databricks:test-inference -- --profile YOUR_PROFILE
 *
 * Options: --profile NAME | --delay-ms N | --only MODEL_ID | --json | -h
 */

import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import {
  fetchFilteredGatewayRoutes,
  mlflowOpenAiBaseUrl,
} from "./databricks-ai-gateway-shared.js";

const MODELS_DIR = path.join(
  import.meta.dir,
  "../../../providers/databricks/models",
);

interface TestResult {
  model: string;
  kind: "chat" | "embedding" | "responses" | "anthropic" | "gemini";
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
  detail?: string;
}

/** OpenAI Responses on the gateway host (not under …/mlflow/v1). */
function openAiResponsesEndpoint(aiGatewayUrl: string): string {
  return `${aiGatewayUrl.replace(/\/$/, "")}/openai/v1/responses`;
}

/** Routes that use OpenAI Responses; gateway `name` values currently include the `-codex` segment. */
function isOpenAiResponsesRoute(model: string): boolean {
  return model.includes("-codex");
}

function isClaudeGatewayModel(model: string): boolean {
  return model.includes("claude");
}

function isGeminiGatewayModel(model: string): boolean {
  return model.includes("gemini");
}

async function loadEmbeddingModelIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const files = await readdir(MODELS_DIR);
  for (const f of files) {
    if (!f.endsWith(".toml")) continue;
    const text = await readFile(path.join(MODELS_DIR, f), "utf8");
    if (/family\s*=\s*"text-embedding"/.test(text)) {
      ids.add(f.replace(/\.toml$/, ""));
    }
  }
  return ids;
}

async function authHeaders(client: WorkspaceClient): Promise<Headers> {
  const h = new Headers();
  await client.config.authenticate(h);
  return h;
}

async function testChat(
  base: string,
  headers: Headers,
  model: string,
): Promise<{ ok: boolean; status: number; error?: string; detail?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const t0 = performance.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 4096,
    }),
  });
  const latencyMs = Math.round(performance.now() - t0);
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: text.slice(0, 500),
      detail: `${latencyMs}ms`,
    };
  }
  let snippet = "";
  try {
    const j = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const c = j.choices?.[0]?.message?.content;
    snippet =
      typeof c === "string"
        ? c.slice(0, 80)
        : c != null
          ? JSON.stringify(c).slice(0, 80)
          : "";
  } catch {
    snippet = text.slice(0, 80);
  }
  return { ok: true, status: res.status, detail: `${latencyMs}ms ${snippet}` };
}

async function testResponses(
  responsesUrl: string,
  headers: Headers,
  model: string,
): Promise<{ ok: boolean; status: number; error?: string; detail?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const t0 = performance.now();
  const res = await fetch(responsesUrl, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      input: "Reply with exactly: OK",
    }),
  });
  const latencyMs = Math.round(performance.now() - t0);
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: text.slice(0, 500),
      detail: `${latencyMs}ms`,
    };
  }
  let snippet = "";
  try {
    const j = JSON.parse(text) as {
      output_text?: string;
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
    };
    if (typeof j.output_text === "string") snippet = j.output_text.slice(0, 80);
    else if (Array.isArray(j.output)) {
      for (const block of j.output) {
        if (block.type !== "message" || !block.content) continue;
        for (const part of block.content) {
          if (part.type === "output_text" && part.text) {
            snippet = part.text.slice(0, 80);
            break;
          }
        }
        if (snippet) break;
      }
    }
    if (!snippet) snippet = text.slice(0, 80);
  } catch {
    snippet = text.slice(0, 80);
  }
  return { ok: true, status: res.status, detail: `${latencyMs}ms ${snippet}` };
}

async function testEmbedding(
  base: string,
  headers: Headers,
  model: string,
): Promise<{ ok: boolean; status: number; error?: string; detail?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const t0 = performance.now();
  const res = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      input: "test",
    }),
  });
  const latencyMs = Math.round(performance.now() - t0);
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: text.slice(0, 500),
      detail: `${latencyMs}ms`,
    };
  }
  let dims = "";
  try {
    const j = JSON.parse(text) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const emb = j.data?.[0]?.embedding;
    dims = emb ? `dim=${emb.length}` : "?";
  } catch {
    dims = "?";
  }
  return { ok: true, status: res.status, detail: `${latencyMs}ms ${dims}` };
}

function anthropicMessagesUrl(aiGatewayUrl: string): string {
  return `${aiGatewayUrl.replace(/\/$/, "")}/anthropic/v1/messages`;
}

async function testAnthropicMessages(
  url: string,
  headers: Headers,
  model: string,
): Promise<{ ok: boolean; status: number; error?: string; detail?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("anthropic-version", "2023-06-01");
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    }),
  });
  const latencyMs = Math.round(performance.now() - t0);
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: text.slice(0, 500),
      detail: `${latencyMs}ms`,
    };
  }
  let snippet = "";
  try {
    const j = JSON.parse(text) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const block = j.content?.find((c) => c.type === "text" && c.text);
    snippet = block?.text?.slice(0, 80) ?? text.slice(0, 80);
  } catch {
    snippet = text.slice(0, 80);
  }
  return { ok: true, status: res.status, detail: `${latencyMs}ms ${snippet}` };
}

function geminiGenerateUrl(aiGatewayUrl: string, model: string): string {
  const base = aiGatewayUrl.replace(/\/$/, "");
  return `${base}/gemini/v1beta/models/${model}:generateContent`;
}

async function testGeminiGenerate(
  url: string,
  headers: Headers,
): Promise<{ ok: boolean; status: number; error?: string; detail?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: "Reply with exactly: OK" }],
        },
      ],
      generationConfig: { maxOutputTokens: 256 },
    }),
  });
  const latencyMs = Math.round(performance.now() - t0);
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: text.slice(0, 500),
      detail: `${latencyMs}ms`,
    };
  }
  let snippet = "";
  try {
    const j = JSON.parse(text) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const parts = j.candidates?.[0]?.content?.parts;
    const t = parts?.find((p) => p.text)?.text;
    snippet = t?.slice(0, 80) ?? text.slice(0, 80);
  } catch {
    snippet = text.slice(0, 80);
  }
  return { ok: true, status: res.status, detail: `${latencyMs}ms ${snippet}` };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let profile = process.env.DATABRICKS_CONFIG_PROFILE;
  let delayMs = 400;
  let only: string | undefined;
  let jsonOut = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile" && argv[i + 1]) {
      profile = argv[++i];
      continue;
    }
    if (a === "--delay-ms" && argv[i + 1]) {
      delayMs = Number(argv[++i]);
      continue;
    }
    if (a === "--only" && argv[i + 1]) {
      only = argv[++i];
      continue;
    }
    if (a === "--json") {
      jsonOut = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(`Usage: bun run databricks:test-inference -- [options]

  --profile NAME   Databricks profile (~/.databrickscfg)
  --delay-ms N     Delay between requests (default 400)
  --only MODEL_ID  Single gateway model id
  --json           JSON summary on stdout at end
`);
      process.exit(0);
    }
  }
  return { profile, delayMs, only, jsonOut };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { profile, delayMs, only, jsonOut } = parseArgs();

  const client = new WorkspaceClient(profile ? { profile } : {});
  const routes = await fetchFilteredGatewayRoutes(client);

  const gatewayUrl = routes[0]?.ai_gateway_url;
  if (!gatewayUrl) {
    throw new Error("No AI Gateway URL on endpoints; cannot build mlflow base.");
  }
  const mlflowBase = mlflowOpenAiBaseUrl(gatewayUrl);
  const responsesUrl = openAiResponsesEndpoint(gatewayUrl);
  const anthropicUrl = anthropicMessagesUrl(gatewayUrl);
  const headers = await authHeaders(client);

  const embeddingIds = await loadEmbeddingModelIds();
  let toRun = routes;
  if (only) {
    toRun = routes.filter((r) => r.gateway_name === only);
    if (toRun.length === 0) {
      throw new Error(`Model not in filtered routes: ${only}`);
    }
  }

  const results: TestResult[] = [];
  console.log(`Gateway mlflow base: ${mlflowBase}`);
  console.log(`Gateway responses:   ${responsesUrl}`);
  console.log(`Gateway anthropic:   ${anthropicUrl}`);
  console.log(`Models to test: ${toRun.length}\n`);

  for (const r of toRun) {
    const model = r.gateway_name;
    const kind: TestResult["kind"] = embeddingIds.has(model)
      ? "embedding"
      : isOpenAiResponsesRoute(model)
        ? "responses"
        : isClaudeGatewayModel(model)
          ? "anthropic"
          : isGeminiGatewayModel(model)
            ? "gemini"
            : "chat";
    process.stdout.write(`${kind.padEnd(10)} ${model} ... `);
    const out =
      kind === "embedding"
        ? await testEmbedding(mlflowBase, headers, model)
        : kind === "responses"
          ? await testResponses(responsesUrl, headers, model)
          : kind === "anthropic"
            ? await testAnthropicMessages(anthropicUrl, headers, model)
            : kind === "gemini"
              ? await testGeminiGenerate(
                  geminiGenerateUrl(gatewayUrl, model),
                  headers,
                )
              : await testChat(mlflowBase, headers, model);
    const lat = out.detail?.match(/^(\d+)ms/);
    const tr: TestResult = {
      model,
      kind,
      ok: out.ok,
      status: out.status,
      latencyMs: lat ? Number(lat[1]) : undefined,
      error: out.error,
      detail: out.detail,
    };
    results.push(tr);
    console.log(out.ok ? `OK ${out.detail}` : `FAIL ${out.status} ${out.error?.slice(0, 120)}`);
    if (delayMs > 0) await sleep(delayMs);
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n---\nPassed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) {
      console.log(`  ${f.model} (${f.kind}) ${f.status}: ${f.error?.slice(0, 200)}`);
    }
  }

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          base: mlflowBase,
          responsesUrl,
          anthropicUrl,
          results,
          passed: results.length - failed.length,
          total: results.length,
        },
        null,
        2,
      ),
    );
  }

  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
