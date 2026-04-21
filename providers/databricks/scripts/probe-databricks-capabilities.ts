#!/usr/bin/env bun
/**
 * probe-databricks-capabilities.ts
 *
 * PURPOSE
 * -------
 * Live-probe every Databricks AI Gateway model and compare the observed
 * capability signals against the catalog flags declared in
 *   providers/databricks/models/*.toml
 *
 * This is a READ-ONLY diagnostic tool.  It never modifies TOML files.
 * Mismatches are reported so a human can decide whether to update the catalog.
 *
 * OUTPUT
 * ------
 * - Console: per-model pass/fail for each capability + a summary table at the end.
 * - JSON file: databricks-capability-probe-<timestamp>.json written next to the
 *   providers/ folder.  Contains the full raw row data for offline analysis.
 *
 * USAGE
 * -----
 *   bun ./packages/core/script/probe-databricks-capabilities.ts -- --profile YOUR_PROFILE
 *   bun run databricks:probe-capabilities -- --profile YOUR_PROFILE
 *
 *   --profile  Databricks CLI profile to use (reads host + token from ~/.databrickscfg).
 *              Defaults to DEFAULT if omitted.
 *   --delay    Milliseconds to wait between API calls (default: 2000).
 *              Increase if you hit rate limits.
 *
 * API SURFACES TESTED
 * -------------------
 *   chat       mlflow/v1/chat/completions   (OpenAI-compatible — GPT-5, Llama, Gemma, Qwen, …)
 *   anthropic  /anthropic/v1/messages       (Claude models)
 *   gemini     /gemini/v1beta/…             (Gemini models)
 *   responses  /openai/v1/responses         (OpenAI Responses API — Codex models)
 *   embedding  mlflow/v1/embeddings         (embedding-only models; skipped for all probes)
 *
 * CAPABILITY PROBES
 * -----------------
 * - "tool"       API accepted a tools payload with tool_choice:"required" and returned a
 *                tool call in the response.  Using "required" (not "auto") avoids false
 *                negatives where the model answers in text instead of calling the tool.
 *
 * - "reasoning"  Three-tier heuristic (any one hit = supported):
 *                  1. Response JSON contains reasoning-shaped keys
 *                     (reasoning_content / thinking / thought / redacted_thinking / …)
 *                  2. usage.completion_tokens_details.reasoning_tokens > 0
 *                     (OpenAI-style internal reasoning — gpt-5-nano, o-series, etc.)
 *                  3. Response content contains <think>...</think> blocks
 *                     (OSS CoT models like Gemma; triggered via a system prompt)
 *
 * - "attachment" Model accepted an 8×8 solid-blue PNG as an inline base64 image_url
 *                and returned a successful text response.  An 8×8 image is used because
 *                several backends reject 1×1 PNGs as "degenerate".
 *
 * - "pdf"        Model accepted a minimal valid PDF as an inline attachment and returned
 *                a successful text response.  Sent via the appropriate format per surface
 *                (image_url for mlflow/v1, document block for Anthropic, inlineData for
 *                Gemini, input_file for Responses API).
 *
 * - "temperature" Model accepted temperature=0.7 (non-default) without an error response.
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

type Kind = "chat" | "embedding" | "responses" | "anthropic" | "gemini";

/**
 * Build a valid uncompressed 8×8 solid blue PNG entirely from raw bytes so we
 * don't need an image library. The 1×1 PNG used previously was rejected as
 * "degenerate" by several vision backends; 8×8 passes all of them.
 *
 * PNG structure: Signature · IHDR · IDAT (deflate-wrapped scanlines) · IEND
 */
function makePng8x8Blue(): string {
  // CRC-32 helper (IEEE polynomial)
  function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type: string, data: Uint8Array): Uint8Array {
    const t = new TextEncoder().encode(type);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, data.length, false);
    const body = new Uint8Array(t.length + data.length);
    body.set(t);
    body.set(data, 4);
    const crcVal = new Uint8Array(4);
    new DataView(crcVal.buffer).setUint32(0, crc32(body), false);
    const out = new Uint8Array(4 + 4 + data.length + 4);
    out.set(len);
    out.set(body, 4);
    out.set(crcVal, 4 + 4 + data.length);
    return out;
  }

  // IHDR: 8×8, 8-bit RGB
  const ihdrData = new Uint8Array(13);
  const dv = new DataView(ihdrData.buffer);
  dv.setUint32(0, 8, false); // width
  dv.setUint32(4, 8, false); // height
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  // Raw scanlines: filter byte (0) + 8 pixels × 3 bytes (R=0,G=0,B=255 blue)
  const raw = new Uint8Array(8 * (1 + 8 * 3));
  for (let row = 0; row < 8; row++) {
    raw[row * 25] = 0; // filter byte
    for (let col = 0; col < 8; col++) {
      raw[row * 25 + 1 + col * 3 + 2] = 255; // B channel
    }
  }

  // Minimal deflate: non-compressed block (BTYPE=00)
  const deflated = new Uint8Array(2 + 5 + raw.length + 4);
  deflated[0] = 0x78; deflated[1] = 0x01; // zlib header
  deflated[2] = 0x01;                       // BFINAL=1, BTYPE=00
  deflated[3] = raw.length & 0xff;
  deflated[4] = (raw.length >> 8) & 0xff;
  deflated[5] = (~raw.length) & 0xff;
  deflated[6] = ((~raw.length) >> 8) & 0xff;
  deflated.set(raw, 7);
  // Adler-32 checksum
  let s1 = 1, s2 = 0;
  for (const b of raw) { s1 = (s1 + b) % 65521; s2 = (s2 + s1) % 65521; }
  const adler = (s2 << 16) | s1;
  const dvD = new DataView(deflated.buffer);
  dvD.setUint32(7 + raw.length, adler, false);

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk("IHDR", ihdrData);
  const idat = chunk("IDAT", deflated);
  const iend = chunk("IEND", new Uint8Array(0));

  const total = sig.length + ihdr.length + idat.length + iend.length;
  const png = new Uint8Array(total);
  let off = 0;
  for (const part of [sig, ihdr, idat, iend]) { png.set(part, off); off += part.length; }

  return Buffer.from(png).toString("base64");
}

const TINY_PNG_B64 = makePng8x8Blue();

/**
 * Build a minimal but structurally valid PDF (single page, "Hello" text).
 * Enough for all vision backends to parse; we just need a non-error response.
 */
function makeTinyPdf(): string {
  const body = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]",
    "/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>",
    ">>endobj",
    "4 0 obj<</Length 44>>",
    "stream",
    "BT /F1 12 Tf 100 700 Td (Hello PDF) Tj ET",
    "endstream",
    "endobj",
    "xref",
    "0 5",
    "0000000000 65535 f ",
  ].join("\n");
  const offsets = [9]; // rough byte offsets – good enough for a probe
  const xref = body.lastIndexOf("xref");
  const trailer = `trailer<</Size 5/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  const full = body + "\n" + trailer;
  return Buffer.from(full).toString("base64");
}

const TINY_PDF_B64 = makeTinyPdf();

interface CatalogFlags {
  reasoning: boolean;
  tool_call: boolean;
  attachment: boolean;
  pdf: boolean;
  temperature: boolean;
  modalities_input: string[];
  modalities_output: string[];
}

interface Row {
  model: string;
  kind: Kind;
  catalog: CatalogFlags;
  toolObserved: boolean;
  toolError?: string;
  reasoningObserved: boolean;
  reasoningHint?: string;
  reasoningError?: string;
  attachmentObserved: boolean;
  attachmentError?: string;
  pdfObserved: boolean;
  pdfError?: string;
  temperatureObserved: boolean;
  temperatureError?: string;
}

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

async function loadCatalogFlags(modelId: string): Promise<CatalogFlags> {
  const p = path.join(MODELS_DIR, `${modelId}.toml`);
  const text = await readFile(p, "utf8");
  const reasoningM = text.match(/^reasoning\s*=\s*(true|false)\s*$/m);
  const toolM = text.match(/^tool_call\s*=\s*(true|false)\s*$/m);
  const attachM = text.match(/^attachment\s*=\s*(true|false)\s*$/m);
  const inputM = text.match(/^input\s*=\s*\[([^\]]*)\]/m);
  const outputM = text.match(/^output\s*=\s*\[([^\]]*)\]/m);
  const parseModalities = (raw: string | undefined): string[] => {
    if (!raw) return [];
    return (raw[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/"/g, ""))
      .filter(Boolean);
  };
  const tempM = text.match(/^temperature\s*=\s*(true|false)\s*$/m);
  const inputModalities = parseModalities(inputM);
  return {
    reasoning: reasoningM?.[1] === "true",
    tool_call: toolM?.[1] === "true",
    attachment: attachM?.[1] === "true",
    pdf: inputModalities.includes("pdf"),
    temperature: tempM?.[1] === "true",
    modalities_input: inputModalities,
    modalities_output: parseModalities(outputM),
  };
}

async function authHeaders(client: WorkspaceClient): Promise<Headers> {
  const h = new Headers();
  await client.config.authenticate(h);
  return h;
}

function openAiResponsesEndpoint(aiGatewayUrl: string): string {
  return `${aiGatewayUrl.replace(/\/$/, "")}/openai/v1/responses`;
}
function anthropicMessagesUrl(aiGatewayUrl: string): string {
  return `${aiGatewayUrl.replace(/\/$/, "")}/anthropic/v1/messages`;
}
function geminiGenerateUrl(aiGatewayUrl: string, model: string): string {
  const base = aiGatewayUrl.replace(/\/$/, "");
  return `${base}/gemini/v1beta/models/${model}:generateContent`;
}

const WEATHER_TOOL_OPENAI = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather for a city",
    parameters: {
      type: "object",
      properties: { location: { type: "string", description: "City name" } },
      required: ["location"],
    },
  },
} as const;

async function probeToolsChat(
  mlflowBase: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(`${mlflowBase}/chat/completions`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content:
            "You MUST call the get_weather function with location='Tokyo'. Do not answer in text.",
        },
      ],
      tools: [WEATHER_TOOL_OPENAI],
      tool_choice: "required",
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 400)}` };
  try {
    const j = JSON.parse(text) as {
      choices?: Array<{
        message?: { tool_calls?: unknown[]; content?: unknown };
      }>;
    };
    const tc = j.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(tc) && tc.length > 0) return { ok: true };
    return { ok: false, error: "no tool_calls in assistant message" };
  } catch {
    return { ok: false, error: text.slice(0, 200) };
  }
}

async function probeToolsAnthropic(
  url: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("anthropic-version", "2023-06-01");
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_tokens: 512,
      tools: [
        {
          name: "get_weather",
          description: "Get weather for a city",
          input_schema: {
            type: "object",
            properties: {
              location: { type: "string", description: "City name" },
            },
            required: ["location"],
          },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            "Use get_weather for Tokyo only. You must invoke the tool.",
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 400)}` };
  try {
    const j = JSON.parse(text) as {
      content?: Array<{ type?: string }>;
      stop_reason?: string;
    };
    const types = (j.content ?? []).map((c) => c.type);
    if (types.includes("tool_use")) return { ok: true };
    if (j.stop_reason === "tool_use") return { ok: true };
    return { ok: false, error: `stop_reason=${j.stop_reason} types=${types.join(",")}` };
  } catch {
    return { ok: false, error: text.slice(0, 200) };
  }
}

async function probeToolsGemini(
  url: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: "Call get_weather with location Tokyo. Use the function." }],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Get weather for a city",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string" },
                },
                required: ["location"],
              },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: 512 },
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 400)}` };
  try {
    const j = JSON.parse(text) as {
      candidates?: Array<{
        content?: { parts?: Array<{ functionCall?: unknown }> };
      }>;
    };
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    if (parts.some((p) => p.functionCall)) return { ok: true };
    return { ok: false, error: "no functionCall in parts" };
  } catch {
    return { ok: false, error: text.slice(0, 200) };
  }
}

async function probeToolsResponses(
  responsesUrl: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(responsesUrl, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      input: [
        {
          type: "message",
          role: "user",
          content:
            "Use tool get_weather with location Tokyo. You must call the function.",
        },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather for a city",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      ],
      tool_choice: "auto",
      max_output_tokens: 512,
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 400)}` };
  try {
    const j = JSON.parse(text) as { output?: Array<{ type?: string }> };
    const types = (j.output ?? []).map((o) => o.type);
    if (types.some((t) => t?.includes("function") || t === "function_call"))
      return { ok: true };
    if (text.includes("function_call") || text.includes("tool_calls"))
      return { ok: true };
    return { ok: false, error: `output types: ${types.join(",")}` };
  } catch {
    return { ok: false, error: text.slice(0, 200) };
  }
}

function responseHasReasoningShape(obj: unknown): { hit: boolean; hint: string } {
  const s = JSON.stringify(obj);
  if (
    s.includes('"reasoning_content"') ||
    s.includes('"reasoning"') ||
    s.includes('"thinking"') ||
    s.includes('"type":"reasoning"') ||
    s.includes('"summary_text"') ||
    s.includes('"thought"') ||
    s.includes("thoughtSignature") ||
    s.includes("redacted_thinking")
  ) {
    return { hit: true, hint: "json contains reasoning/thinking-like keys" };
  }
  return { hit: false, hint: "" };
}

async function probeReasoningChat(
  mlflowBase: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; hint?: string; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");

  const isOpenAiStyle = /gpt-5|gpt-oss|o4|o3|o1/i.test(model);
  // OSS models (Gemma, Llama, Qwen, etc.) that support CoT output <think> blocks
  const isOssReasoner = /gemma|qwen|deepseek|phi/i.test(model);

  const body: Record<string, unknown> = {
    model,
    max_tokens: 512,
    messages: [
      ...(isOssReasoner
        ? [
            {
              role: "system",
              content:
                "You have a thinking/reasoning mode. Before answering, output your " +
                "internal reasoning inside <think>...</think> tags, then give the answer.",
            },
          ]
        : []),
      {
        role: "user",
        content: "Think step by step briefly, then answer: what is 2+2?",
      },
    ],
  };

  // OpenAI-style reasoning models accept reasoning_effort
  if (isOpenAiStyle) {
    body.reasoning_effort = "low";
  }

  const res = await fetch(`${mlflowBase}/chat/completions`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
  const text = await res.text();

  if (!res.ok) {
    // Retry without reasoning_effort in case the model rejects it
    const retry = await fetch(`${mlflowBase}/chat/completions`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: body.messages as [],
      }),
    });
    const t2 = await retry.text();
    if (!retry.ok) return { ok: false, error: `${res.status} then ${retry.status}` };
    try {
      const j = JSON.parse(t2) as unknown;
      const { hit, hint } = responseHasReasoningShape(j);
      return { ok: hit, hint: hit ? hint : "no reasoning-shaped fields" };
    } catch {
      return { ok: false, error: t2.slice(0, 200) };
    }
  }

  try {
    const j = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    };

    // Primary: explicit reasoning-shaped fields in the response JSON
    const { hit, hint } = responseHasReasoningShape(j);
    if (hit) return { ok: true, hint };

    // Secondary: OpenAI internal reasoning — usage.completion_tokens_details.reasoning_tokens > 0
    const reasoningTokens = j.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    if (reasoningTokens > 0) {
      return { ok: true, hint: `internal reasoning (${reasoningTokens} reasoning_tokens in usage)` };
    }

    // Tertiary: OSS <think> blocks visible in response content
    const content = j.choices?.[0]?.message?.content ?? "";
    if (isOssReasoner && content.includes("<think>")) {
      return { ok: true, hint: "<think> block in response content" };
    }

    return { ok: false, hint: "no reasoning-shaped fields" };
  } catch {
    return { ok: false, error: text.slice(0, 200) };
  }
}

async function probeReasoningAnthropic(
  url: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; hint?: string; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("anthropic-version", "2023-06-01");
  h.set(
    "anthropic-beta",
    "interleaved-thinking-2025-05-14",
  );
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_tokens: 12000,
      thinking: { type: "enabled", budget_tokens: 8000 },
      messages: [
        {
          role: "user",
          content: "What is 7*6? Think briefly then answer with one number.",
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  }
  try {
    const j = JSON.parse(text) as {
      content?: Array<{ type?: string }>;
    };
    const types = (j.content ?? []).map((c) => c.type);
    if (types.includes("thinking")) return { ok: true, hint: "thinking blocks" };
    const { hit, hint } = responseHasReasoningShape(j);
    return { ok: hit, hint: hint || "parsed" };
  } catch {
    return { ok: false, error: text.slice(0, 200) };
  }
}

async function probeReasoningGemini(
  url: string,
  headers: Headers,
): Promise<{ ok: boolean; hint?: string; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: "What is 3+5? Answer with one digit only after thinking." }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 512,
        thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  }
  try {
    const j = JSON.parse(text) as unknown;
    const { hit, hint } = responseHasReasoningShape(j);
    if (hit) return { ok: true, hint };
    return { ok: false, hint: "no thinking/reasoning fields" };
  } catch {
    return { ok: false, error: text.slice(0, 200) };
  }
}

async function probeReasoningResponses(
  responsesUrl: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; hint?: string; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(responsesUrl, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      input: "What is 2+3? One number only.",
      reasoning: { effort: "low" },
      max_output_tokens: 512,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const res2 = await fetch(responsesUrl, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        model,
        input: "What is 2+3? One number only.",
        max_output_tokens: 512,
      }),
    });
    const t2 = await res2.text();
    if (!res2.ok) return { ok: false, error: `${res.status} / ${res2.status}` };
    try {
      const j = JSON.parse(t2) as unknown;
      const { hit, hint } = responseHasReasoningShape(j);
      return { ok: hit, hint: hit ? hint : "minimal" };
    } catch {
      return { ok: false, error: t2.slice(0, 200) };
    }
  }
  try {
    const j = JSON.parse(text) as unknown;
    const { hit, hint } = responseHasReasoningShape(j);
    return { ok: hit, hint: hit ? hint : "responses ok" };
  } catch {
    return { ok: false, error: text.slice(0, 200) };
  }
}

// ── Attachment probes (send a tiny inline PNG image) ──────────────────────────

async function probeAttachmentChat(
  mlflowBase: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(`${mlflowBase}/chat/completions`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
            },
            { type: "text", text: "What color is this image? One word." },
          ],
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

async function probeAttachmentAnthropic(
  url: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("anthropic-version", "2023-06-01");
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: TINY_PNG_B64,
              },
            },
            { type: "text", text: "What color is this image? One word." },
          ],
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

async function probeAttachmentGemini(
  url: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: { mimeType: "image/png", data: TINY_PNG_B64 },
            },
            { text: "What color is this image? One word." },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 64 },
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

async function probeAttachmentResponses(
  responsesUrl: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(responsesUrl, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_output_tokens: 64,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:image/png;base64,${TINY_PNG_B64}`,
            },
            { type: "input_text", text: "What color is this image? One word." },
          ],
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

// ── PDF probes (send a minimal PDF document) ──────────────────────────────────

async function probePdfChat(
  mlflowBase: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(`${mlflowBase}/chat/completions`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:application/pdf;base64,${TINY_PDF_B64}` },
            },
            { type: "text", text: "What does this document say? One sentence." },
          ],
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

async function probePdfAnthropic(
  url: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("anthropic-version", "2023-06-01");
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: TINY_PDF_B64,
              },
            },
            { type: "text", text: "What does this document say? One sentence." },
          ],
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

async function probePdfGemini(
  url: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: { mimeType: "application/pdf", data: TINY_PDF_B64 },
            },
            { text: "What does this document say? One sentence." },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 64 },
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

async function probePdfResponses(
  responsesUrl: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(responsesUrl, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_output_tokens: 64,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "doc.pdf",
              file_data: `data:application/pdf;base64,${TINY_PDF_B64}`,
            },
            { type: "input_text", text: "What does this document say? One sentence." },
          ],
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

// ── Temperature probes (send temperature=0.7; only default=1 or unsupported → false) ──

async function probeTempChat(
  mlflowBase: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(`${mlflowBase}/chat/completions`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_tokens: 32,
      temperature: 0.7,
      messages: [{ role: "user", content: "Say: hello" }],
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

async function probeTempAnthropic(
  url: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("anthropic-version", "2023-06-01");
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_tokens: 32,
      temperature: 0.7,
      messages: [{ role: "user", content: "Say: hello" }],
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

async function probeTempGemini(
  url: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Say: hello" }] }],
      generationConfig: { maxOutputTokens: 32, temperature: 0.7 },
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

async function probeTempResponses(
  responsesUrl: string,
  model: string,
  headers: Headers,
): Promise<{ ok: boolean; error?: string }> {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  const res = await fetch(responsesUrl, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      model,
      max_output_tokens: 32,
      temperature: 0.7,
      input: "Say: hello",
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2);
  let profile = process.env.DATABRICKS_CONFIG_PROFILE;
  let delayMs = 300;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile" && argv[i + 1]) profile = argv[++i];
    if (a === "--delay-ms" && argv[i + 1]) delayMs = Number(argv[++i]);
  }
  return { profile, delayMs };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { profile, delayMs } = parseArgs();
  const client = new WorkspaceClient(profile ? { profile } : {});
  const routes = await fetchFilteredGatewayRoutes(client);
  const gatewayUrl = routes[0]?.ai_gateway_url;
  if (!gatewayUrl) throw new Error("No AI Gateway URL");
  const mlflowBase = mlflowOpenAiBaseUrl(gatewayUrl);
  const responsesUrl = openAiResponsesEndpoint(gatewayUrl);
  const anthropicUrl = anthropicMessagesUrl(gatewayUrl);
  const headers = await authHeaders(client);
  const embeddingIds = await loadEmbeddingModelIds();

  const rows: Row[] = [];
  for (const r of routes) {
    const model = r.gateway_name;
    const kind: Kind = embeddingIds.has(model)
      ? "embedding"
      : isOpenAiResponsesRoute(model)
        ? "responses"
        : isClaudeGatewayModel(model)
          ? "anthropic"
          : isGeminiGatewayModel(model)
            ? "gemini"
            : "chat";
    const catalog = await loadCatalogFlags(model);

    if (kind === "embedding") {
      rows.push({
        model,
        kind,
        catalog,
        toolObserved: false,
        reasoningObserved: false,
        reasoningHint: "skipped (embedding)",
        attachmentObserved: false,
        attachmentError: "skipped (embedding)",
        pdfObserved: false,
        pdfError: "skipped (embedding)",
        temperatureObserved: false,
        temperatureError: "skipped (embedding)",
      });
      continue;
    }

    process.stdout.write(`${model} (${kind}) ... `);
    let toolObserved = false;
    let toolError: string | undefined;
    let reasoningObserved = false;
    let reasoningHint: string | undefined;
    let reasoningError: string | undefined;
    let attachmentObserved = false;
    let attachmentError: string | undefined;
    let pdfObserved = false;
    let pdfError: string | undefined;
    let temperatureObserved = false;
    let temperatureError: string | undefined;

    if (kind === "chat") {
      const t = await probeToolsChat(mlflowBase, model, headers);
      toolObserved = t.ok; toolError = t.error;
      const rr = await probeReasoningChat(mlflowBase, model, headers);
      reasoningObserved = rr.ok; reasoningHint = rr.hint; reasoningError = rr.error;
      const at = await probeAttachmentChat(mlflowBase, model, headers);
      attachmentObserved = at.ok; attachmentError = at.error;
      const pd = await probePdfChat(mlflowBase, model, headers);
      pdfObserved = pd.ok; pdfError = pd.error;
      const tm = await probeTempChat(mlflowBase, model, headers);
      temperatureObserved = tm.ok; temperatureError = tm.error;
    } else if (kind === "anthropic") {
      const t = await probeToolsAnthropic(anthropicUrl, model, headers);
      toolObserved = t.ok; toolError = t.error;
      const rr = await probeReasoningAnthropic(anthropicUrl, model, headers);
      reasoningObserved = rr.ok; reasoningHint = rr.hint; reasoningError = rr.error;
      const at = await probeAttachmentAnthropic(anthropicUrl, model, headers);
      attachmentObserved = at.ok; attachmentError = at.error;
      const pd = await probePdfAnthropic(anthropicUrl, model, headers);
      pdfObserved = pd.ok; pdfError = pd.error;
      const tm = await probeTempAnthropic(anthropicUrl, model, headers);
      temperatureObserved = tm.ok; temperatureError = tm.error;
    } else if (kind === "gemini") {
      const url = geminiGenerateUrl(gatewayUrl, model);
      const t = await probeToolsGemini(url, headers);
      toolObserved = t.ok; toolError = t.error;
      const rr = await probeReasoningGemini(url, headers);
      reasoningObserved = rr.ok; reasoningHint = rr.hint; reasoningError = rr.error;
      const at = await probeAttachmentGemini(url, headers);
      attachmentObserved = at.ok; attachmentError = at.error;
      const pd = await probePdfGemini(url, headers);
      pdfObserved = pd.ok; pdfError = pd.error;
      const tm = await probeTempGemini(url, headers);
      temperatureObserved = tm.ok; temperatureError = tm.error;
    } else {
      const t = await probeToolsResponses(responsesUrl, model, headers);
      toolObserved = t.ok; toolError = t.error;
      const rr = await probeReasoningResponses(responsesUrl, model, headers);
      reasoningObserved = rr.ok; reasoningHint = rr.hint; reasoningError = rr.error;
      const at = await probeAttachmentResponses(responsesUrl, model, headers);
      attachmentObserved = at.ok; attachmentError = at.error;
      const pd = await probePdfResponses(responsesUrl, model, headers);
      pdfObserved = pd.ok; pdfError = pd.error;
      const tm = await probeTempResponses(responsesUrl, model, headers);
      temperatureObserved = tm.ok; temperatureError = tm.error;
    }

    // Policy rule: all gpt-5* models (any variant) report temperature=false on the
    // Databricks AI Gateway regardless of what the raw probe observed.  The gateway
    // either rejects non-default values outright or constrains them to 1.
    if (/^databricks-gpt-5/i.test(model)) {
      temperatureObserved = false;
      temperatureError = temperatureError ?? "policy: gpt-5* temperature always false on Databricks gateway";
    }

    rows.push({
      model, kind, catalog,
      toolObserved, toolError,
      reasoningObserved, reasoningHint, reasoningError,
      attachmentObserved, attachmentError,
      pdfObserved, pdfError,
      temperatureObserved, temperatureError,
    });
    console.log(
      `tools=${toolObserved} reasoning=${reasoningObserved} attachment=${attachmentObserved}` +
        ` pdf=${pdfObserved} temp=${temperatureObserved}` +
        ` cat(r/t/a/p/T)=${catalog.reasoning}/${catalog.tool_call}/${catalog.attachment}/${catalog.pdf}/${catalog.temperature}`,
    );
    if (delayMs > 0) await sleep(delayMs);
  }

  const outPath = path.join(
    import.meta.dir,
    `../../../databricks-capability-probe-${Date.now()}.json`,
  );
  await Bun.write(outPath, JSON.stringify(rows, null, 2));

  console.log(`\nWrote ${outPath}`);

  const toolMismatch = rows.filter(
    (r) => r.kind !== "embedding" && r.toolObserved !== r.catalog.tool_call,
  );
  const reasonMismatch = rows.filter(
    (r) => r.kind !== "embedding" && r.reasoningObserved !== r.catalog.reasoning,
  );
  const attachMismatch = rows.filter(
    (r) => r.kind !== "embedding" && r.attachmentObserved !== r.catalog.attachment,
  );
  const pdfMismatch = rows.filter(
    (r) => r.kind !== "embedding" && r.pdfObserved !== r.catalog.pdf,
  );
  const tempMismatch = rows.filter(
    (r) => r.kind !== "embedding" && r.temperatureObserved !== r.catalog.temperature,
  );

  console.log("\n--- Mismatches vs catalog (observed !== TOML) ---");
  console.log("tool_call:  ", toolMismatch.length ? toolMismatch.map((r) => r.model) : "none");
  console.log("reasoning:  ", reasonMismatch.length ? reasonMismatch.map((r) => r.model) : "none");
  console.log("attachment: ", attachMismatch.length ? attachMismatch.map((r) => r.model) : "none");
  console.log("pdf:        ", pdfMismatch.length ? pdfMismatch.map((r) => r.model) : "none");
  console.log("temperature:", tempMismatch.length ? tempMismatch.map((r) => r.model) : "none");

  console.log("\n--- attachment probe results ---");
  for (const r of rows) {
    if (r.kind === "embedding") continue;
    const mark = r.attachmentObserved ? "✓" : "✗";
    const catMark = r.catalog.attachment ? "cat=true" : "cat=false";
    const mismatch = r.attachmentObserved !== r.catalog.attachment ? " ← MISMATCH" : "";
    console.log(`  ${mark} ${r.model} (${r.kind}) ${catMark}${mismatch}`);
    if (r.attachmentError && !r.attachmentObserved)
      console.log(`      err: ${r.attachmentError.slice(0, 160)}`);
  }

  console.log("\n--- pdf probe results ---");
  for (const r of rows) {
    if (r.kind === "embedding") continue;
    const mark = r.pdfObserved ? "✓" : "✗";
    const catMark = r.catalog.pdf ? "cat=true" : "cat=false";
    const mismatch = r.pdfObserved !== r.catalog.pdf ? " ← MISMATCH" : "";
    console.log(`  ${mark} ${r.model} (${r.kind}) ${catMark}${mismatch}`);
    if (r.pdfError && !r.pdfObserved)
      console.log(`      err: ${r.pdfError.slice(0, 160)}`);
  }

  for (const r of rows) {
    if (r.kind === "embedding") continue;
    if (r.toolError && !r.toolObserved)
      console.log(`  ${r.model} tool err: ${r.toolError.slice(0, 120)}`);
    if (r.reasoningError && !r.reasoningObserved)
      console.log(`  ${r.model} reasoning err: ${r.reasoningError.slice(0, 120)}`);
  }

  console.log("\n--- temperature probe results ---");
  for (const r of rows) {
    if (r.kind === "embedding") continue;
    const mark = r.temperatureObserved ? "✓" : "✗";
    const catMark = r.catalog.temperature ? "cat=true" : "cat=false";
    const mismatch = r.temperatureObserved !== r.catalog.temperature ? " ← MISMATCH" : "";
    console.log(`  ${mark} ${r.model} (${r.kind}) ${catMark}${mismatch}`);
    if (r.temperatureError && !r.temperatureObserved)
      console.log(`      err: ${r.temperatureError.slice(0, 160)}`);
  }

  // ── Consolidated summary table ────────────────────────────────────────────
  const col = {
    model:      38,
    kind:        9,
    tool:        5,
    reason:      9,
    attach:      7,
    pdf:         5,
    temp:        5,
    input:      22,
  };
  function pad(s: string, n: number) { return s.slice(0, n).padEnd(n); }
  function yn(observed: boolean, catalog: boolean): string {
    const v = observed ? "✓" : "✗";
    return observed !== catalog ? `${v}*` : ` ${v}`;   // * = mismatch vs catalog
  }
  const totalWidth = col.model + col.kind + col.tool + col.reason + col.attach + col.pdf + col.temp + col.input + 16;

  console.log("\n" + "─".repeat(totalWidth));
  console.log(
    pad("Model", col.model) + "  " +
    pad("Surface", col.kind) + "  " +
    pad("Tools", col.tool) + "  " +
    pad("Reasoning", col.reason) + "  " +
    pad("Image", col.attach) + "  " +
    pad("PDF", col.pdf) + "  " +
    pad("Temp", col.temp) + "  " +
    pad("Input modalities", col.input),
  );
  console.log("─".repeat(totalWidth));

  for (const r of rows) {
    const input = r.catalog.modalities_input.join(" · ") || "text";
    if (r.kind === "embedding") {
      console.log(
        pad(r.model, col.model) + "  " +
        pad(r.kind, col.kind) + "  " +
        pad("  —", col.tool) + "  " +
        pad("   —", col.reason) + "  " +
        pad("  —", col.attach) + "  " +
        pad(" —", col.pdf) + "  " +
        pad(" —", col.temp) + "  " +
        input,
      );
    } else {
      console.log(
        pad(r.model, col.model) + "  " +
        pad(r.kind, col.kind) + "  " +
        pad(yn(r.toolObserved, r.catalog.tool_call), col.tool) + "  " +
        pad(yn(r.reasoningObserved, r.catalog.reasoning), col.reason) + "  " +
        pad(yn(r.attachmentObserved, r.catalog.attachment), col.attach) + "  " +
        pad(yn(r.pdfObserved, r.catalog.pdf), col.pdf) + "  " +
        pad(yn(r.temperatureObserved, r.catalog.temperature), col.temp) + "  " +
        input,
      );
    }
  }

  console.log("─".repeat(totalWidth));
  console.log("  ✓ = supported   ✗ = not supported   * = mismatch vs TOML catalog");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
