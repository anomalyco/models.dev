import { formatModelV2 } from "../model-file-v2.js";

type Doc = Record<string, unknown>;
type Lab = Record<string, unknown>;

// Hand-set capabilities a catalog API rarely states. A model the sync creates starts with none of them, so it would
// publish less than its predecessor on the same host. Reasoning controls, limits and prices are model-specific and
// never copied.
const CAPABILITY_KEYS = ["system_updates", "effort_updates", "structured_output", "cache", "prompt_cache_key", "store", "stream_usage"];
const TOOL_KEYS = ["updates", "strict", "choice", "search", "freeform"];

const isRecord = (value: unknown): value is Doc => typeof value === "object" && value !== null && !Array.isArray(value);
const apiKeys = (doc: Doc) => Object.keys(isRecord(doc.api) ? doc.api : {}).sort().join("+");

/**
 * The same host's previous model in the family: an existing file whose lab model has the new model's family, an
 * earlier release date and the same API tables. The latest such release wins.
 */
export function findPredecessor(
  doc: Doc,
  existing: Iterable<[string, Doc]>,
  labs: Record<string, Lab>,
): { path: string; doc: Doc } | undefined {
  const base = typeof doc.base_model === "string" ? labs[doc.base_model] : undefined;
  const family = base?.family;
  const date = base?.release_date;
  if (typeof family !== "string" || typeof date !== "string") return undefined;
  let best: { path: string; doc: Doc; date: string } | undefined;
  for (const [path, candidate] of existing) {
    if (typeof candidate.base_model !== "string" || candidate.base_model === doc.base_model) continue;
    const lab = labs[candidate.base_model];
    const candidateDate = lab?.release_date;
    if (lab?.family !== family || typeof candidateDate !== "string" || candidateDate >= date) continue;
    if (apiKeys(candidate) !== apiKeys(doc)) continue;
    // On the same date, the shorter ID is the base model rather than a variant (`gpt-6.1-sol` over `gpt-6.1-sol-fast`).
    if (best === undefined || candidateDate > best.date || (candidateDate === best.date && path.length < best.path.length)) {
      best = { path, doc: candidate, date: candidateDate };
    }
  }
  return best === undefined ? undefined : { path: best.path, doc: best.doc };
}

/** Copies the predecessor's hand-set capabilities the new file doesn't state. Returns the keys it added. */
export function inheritCapabilities(doc: Doc, predecessor: Doc): string[] {
  const added: string[] = [];
  const from = isRecord(predecessor.capabilities) ? predecessor.capabilities : {};
  const to = (isRecord(doc.capabilities) ? doc.capabilities : (doc.capabilities = {})) as Doc;
  for (const key of CAPABILITY_KEYS) {
    if (from[key] !== undefined && to[key] === undefined) {
      to[key] = structuredClone(from[key]);
      added.push(`capabilities.${key}`);
    }
  }
  if (isRecord(from.tools)) {
    const tools = (isRecord(to.tools) ? to.tools : (to.tools = {})) as Doc;
    for (const key of TOOL_KEYS) {
      if (from.tools[key] !== undefined && tools[key] === undefined) {
        tools[key] = structuredClone(from.tools[key]);
        added.push(`capabilities.tools.${key}`);
      }
    }
    if (Object.keys(tools).length === 0) delete to.tools;
  }
  const fromApis = isRecord(predecessor.api) ? predecessor.api : {};
  const toApis = isRecord(doc.api) ? doc.api : {};
  for (const [name, table] of Object.entries(fromApis)) {
    const target = toApis[name];
    if (!isRecord(table) || !isRecord(table.capabilities) || !isRecord(target)) continue;
    const caps = (isRecord(target.capabilities) ? target.capabilities : (target.capabilities = {})) as Doc;
    for (const [key, value] of Object.entries(table.capabilities)) {
      if (key === "tools" && isRecord(value)) {
        const tools = (isRecord(caps.tools) ? caps.tools : (caps.tools = {})) as Doc;
        for (const [toolKey, toolValue] of Object.entries(value)) {
          if (tools[toolKey] === undefined) {
            tools[toolKey] = structuredClone(toolValue);
            added.push(`api.${name}.capabilities.tools.${toolKey}`);
          }
        }
      } else if (caps[key] === undefined) {
        caps[key] = structuredClone(value);
        added.push(`api.${name}.capabilities.${key}`);
      }
    }
  }
  return added;
}

/** A new file's content with its predecessor's capabilities, and a header line naming the source. */
export function withPredecessorCapabilities(
  content: string,
  existing: Iterable<[string, Doc]>,
  labs: Record<string, Lab>,
): string {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith("#")) i++;
  const header = lines.slice(0, i);
  const doc = Bun.TOML.parse(lines.slice(i).join("\n")) as Doc;
  const predecessor = findPredecessor(doc, existing, labs);
  if (predecessor === undefined) return content;
  const added = inheritCapabilities(doc, predecessor.doc);
  if (added.length === 0) return content;
  const source = predecessor.path.replace(/\.toml$/, "");
  header.push(`# Capabilities the catalog doesn't state (${added.join(", ")}) come from ${source}, this host's previous model in the family.`);
  return `${header.join("\n")}\n${formatModelV2(doc)}`;
}
