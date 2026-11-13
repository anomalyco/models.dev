import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel, modelMetadata } from "./openrouter.js";

const MODELS_ENDPOINT = "https://ark.volcengine.com/region:cn-beijing/docs/model-list.md";
const Docs = z.object({ models: z.string() });
type LimitName = "context" | "input" | "output";
export type VolcengineModel = {
  id: string;
  tools: boolean;
  structured: boolean;
  reasoning: boolean;
  retiring: boolean;
  limits: Partial<Record<LimitName, string>>;
};

function plain(value: string) {
  return value.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<br\s*\/?\s*>/gi, " ").replace(/[*`]/g, "").trim();
}

// Select the text-generation section and all its subsections, independently
// of the document's heading depth. Other model types are outside this sync.
function textModels(markdown: string) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    return heading !== null && plain(heading[2]!) === "文本生成能力";
  });
  if (start < 0) throw new Error("Volcengine docs are missing the text generation section");
  const level = lines[start]!.match(/^#+/)![0].length;
  let end = start + 1;
  for (; end < lines.length; end++) {
    const heading = lines[end]!.match(/^(#{1,6})\s/);
    if (heading !== null && heading[1]!.length <= level) break;
  }
  return lines.slice(start + 1, end).join("\n");
}

function cells(line: string) {
  return line.trim().replace(/\\\s*$/, "").split(/(?<!\\)\|/).slice(1, -1).map((value) => value.trim());
}

// Join the public Markdown's physical continuation rows before interpreting
// headers and model rows. A changed table shape fails before any file writes.
function tables(markdown: string) {
  const result: Array<{ header: string[]; rows: string[][] }> = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim().startsWith("|")) continue;
    const rows: string[][] = [];
    while (i < lines.length && lines[i]!.trim().startsWith("|")) {
      let line = lines[i++]!;
      const row = cells(line);
      while (/\\\s*$/.test(line)) {
        line = lines[i++] ?? "";
        const continuation = cells(line);
        if (!line.trim().startsWith("|") || continuation.length !== row.length) {
          throw new Error("Volcengine docs have an invalid table continuation");
        }
        for (let column = 0; column < row.length; column++) {
          row[column] = `${row[column]} ${continuation[column]}`.trim();
        }
      }
      rows.push(row);
    }
    i--;
    const [header, separator, ...body] = rows;
    if (header === undefined || separator === undefined
      || separator.length !== header.length
      || separator.some((value) => !/^:?-+:?$/.test(value))) {
      throw new Error("Volcengine docs have an invalid table separator");
    }
    if (body.some((row) => row.length !== header.length)) {
      throw new Error("Volcengine docs have an invalid table row");
    }
    result.push({ header, rows: body });
  }
  return result;
}

function limit(label: string, value: string) {
  // Capture the entire displayed token, including unknown units. Matching
  // only a numeric prefix would silently turn a future "1M" into one token.
  return value.match(new RegExp(`${label}[^:：]*[:：]\\s*([^\\s]+(?:\\s+[a-zA-Z][a-zA-Z0-9]*)?)`))?.[1]?.replace(/\s/g, "");
}

export function parseVolcengineModels(raw: unknown): VolcengineModel[] {
  const docs = Docs.parse(raw);
  const found = tables(textModels(docs.models));
  if (found.length === 0) throw new Error("Volcengine docs have no text generation model tables");
  const ids = new Set<string>();
  const models: VolcengineModel[] = [];
  for (const table of found) {
    if (table.header.length !== 4 || !plain(table.header[0]!).includes("模型 ID")
      || plain(table.header[1]!) !== "能力支持" || !plain(table.header[2]!).includes("长度限制")) {
      throw new Error("Volcengine docs have unsupported model table columns");
    }
    for (const row of table.rows) {
      const id = row[0]!.match(/^\[([a-z0-9][a-z0-9.-]*)\]\(https:\/\//)?.[1];
      if (id === undefined || ids.has(id)) throw new Error("Volcengine docs have an invalid or duplicate model ID");
      ids.add(id);
      if (/白名单|邀测|限量开放|申请开通/.test(row[0]!)) continue;
      const limits = plain(row[2]!);
      models.push({
        id,
        tools: /工具调用/.test(row[1]!),
        structured: /结构化输出/.test(row[1]!),
        reasoning: /深度思考/.test(row[1]!),
        retiring: /即将下线/.test(row[0]!),
        limits: {
          context: limit("上下文窗口", limits),
          input: limit("最大输入", limits),
          output: limit("最大回答", limits),
        },
      });
    }
  }
  if (models.length === 0) throw new Error("Volcengine docs have an empty public text generation inventory");
  return models;
}

export async function fetchVolcengineModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(MODELS_ENDPOINT);
  if (!response.ok) throw new Error(`Volcengine docs request failed: ${response.status} ${response.statusText}`);
  return { models: await response.text() };
}

// These are audited model identities and same-family host references, not a
// heuristic conversion of provider names into canonical lab IDs. Unknown new
// families go through the missing-model issue workflow instead of guessing.
const FAMILIES = [
  [/^doubao-seed-2-1-pro-\d{6}$/, "bytedance-seed/seed-2.1-pro", "doubao-seed-2-1-pro-260915"],
  [/^doubao-seed-2-1-lite-\d{6}$/, "bytedance-seed/seed-2.1-lite", "doubao-seed-2-1-lite-260915"],
  [/^glm-5-3-flash-\d{6}$/, "zhipuai/glm-5.3-flash", "glm-5-3-flash-260828"],
  [/^kimi-k3-1-pro-\d{6}$/, "moonshotai/kimi-k3.1-pro", "kimi-k3-1-pro-261024"],
] as const;

// The docs use k for both decimal and binary token counts across models. An
// exact integer is usable directly; a k display is usable only when it matches
// the already-curated precise value for this model or its same-family peer.
function tokens(display: string | undefined, known: number | undefined) {
  if (display === undefined) return undefined;
  const match = display.match(/^(\d[\d,_]*(?:\.\d+)?)([kK])?$/);
  if (match === null) return undefined;
  const number = Number(match[1]!.replace(/[,_]/g, ""));
  if (match[2] !== undefined) {
    return known !== undefined && (number * 1_000 === known || number * 1_024 === known) ? known : undefined;
  }
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function documentedLimits(model: VolcengineModel, known: ExistingModel | undefined) {
  const values = Object.fromEntries((["context", "input", "output"] as const).map((key) => [
    key, tokens(model.limits[key], known?.limit?.[key]),
  ]));
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<NonNullable<ExistingModel["limit"]>>;
}

export const volcengine = {
  id: "volcengine",
  name: "Volcengine Ark",
  modelsDir: "providers/volcengine/models",
  deleteMissing: false,
  sourceID(model) { return model.id; },
  missingModelID(model) { return model.retiring ? undefined : model.id; },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `Volcengine models requiring canonical metadata, precise limits or host reasoning controls: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    return paths.length === 0 ? [] : [`Volcengine retained local models absent from the public text generation tables: ${paths.join(", ")}`];
  },
  fetchModels: fetchVolcengineModels,
  parseModels: parseVolcengineModels,
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored !== undefined) {
      const existing = context.existing(model.id);
      const limits = documentedLimits(model, existing);
      const changes = Object.fromEntries(Object.entries(limits).filter(([key, value]) => existing?.limit?.[key as LimitName] !== value));
      const unresolved = Object.entries(model.limits).filter(([key, value]) => value !== undefined && limits[key as LimitName] === undefined);
      return {
        id: model.id,
        model: {
          ...authored,
          ...(model.tools && existing?.tool_call !== true ? { tool_call: true } : {}),
          ...(model.structured && existing?.structured_output !== true ? { structured_output: true } : {}),
          ...(model.retiring ? { status: "deprecated" } : {}),
          ...(Object.keys(changes).length > 0 ? { limit: { ...authored.limit, ...changes } } : {}),
        } as SyncedModel,
        notices: unresolved.length === 0 ? [] : [`Volcengine ${model.id}: retained precise limits for ambiguous documentation values (${unresolved.map(([key, value]) => `${key}=${value}`).join(", ")}).`],
      };
    }

    if (model.retiring) return undefined;
    const family = FAMILIES.find(([pattern]) => pattern.test(model.id));
    if (family === undefined) return undefined;
    const [, base, peerID] = family;
    const peer = context.authored(peerID);
    const resolvedPeer = context.existing(peerID);
    if (peer?.base_model !== base || resolvedPeer?.reasoning !== model.reasoning
      || (model.reasoning && peer.reasoning_options === undefined)) return undefined;
    const limits = documentedLimits(model, resolvedPeer);
    if (limits.context === undefined || limits.output === undefined
      || (model.limits.input !== undefined && limits.input === undefined)) return undefined;
    // The canonical file must already exist on dev; new labs and model
    // identities are authored separately by the missing-model issue workflow.
    let canonical: Record<string, unknown>;
    try { canonical = modelMetadata(base); } catch { return undefined; }
    const controls = peer.reasoning_options ?? [];
    if (controls.some((option) => option.type === "budget_tokens")) return undefined;
    const effort = controls.find((option) => option.type === "effort");
    const peerV2 = context.v2?.(peerID);
    const peerCapabilities = peerV2?.capabilities as Record<string, unknown> | undefined;
    // Preserve the host restrictions already curated for this family. These
    // are authored overrides only; cache, tiers and prices are not copied.
    const v2Set = Object.fromEntries([
      ["modalities", peerV2?.modalities],
      ["api", peerV2?.api],
      ...["temperature", "top_p", "top_k"].map((key) => [`capabilities.${key}`, peerCapabilities?.[key]]),
    ].filter(([, value]) => value !== undefined));
    const header = [
      `# Source: ${MODELS_ENDPOINT}`,
      `# Host reasoning controls and API compatibility: curated ${peerID}.`,
      ...(controls.some((option) => option.type === "toggle") ? ["# Toggle: thinking.type = enabled|disabled"] : []),
      ...(effort === undefined ? [] : [`# Effort: reasoning_effort = ${effort.values.join("|")}`]),
      "# Pricing is not provided by the model list and is intentionally omitted.",
    ].join("\n");
    return {
      id: model.id,
      model: {
        ...factorBaseModel(base, {
          name: `${canonical.name} (${model.id.slice(-6)})`,
          reasoning: model.reasoning,
          reasoning_options: peer.reasoning_options,
          tool_call: model.tools ? true : undefined,
          structured_output: model.structured ? true : undefined,
          temperature: peer.temperature,
          modalities: peer.modalities,
          limit: limits,
          provider: peer.provider,
          interleaved: peer.interleaved,
        }, limits),
        // v1 reduces MIME formats to generic modalities. Keep the authored
        // v1 side when v2Set restores the peer's actual MIME restrictions.
        ...(peerV2?.modalities === undefined ? {} : { modalities: peer.modalities ?? resolvedPeer.modalities }),
      } as SyncedModel,
      header,
      v2Set,
    };
  },
} satisfies SyncProvider<VolcengineModel>;
