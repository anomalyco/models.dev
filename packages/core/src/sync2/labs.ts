// Which lab model (`models/<lab>/<model>`) a relay's model ID is. Relays name
// models after the lab's namespace on OpenRouter or Hugging Face (`qwen/...`,
// `meta-llama/...`, `z-ai/...`); these turn such an ID into `base` hints for
// an observation, best first. The engine takes the first hint with a lab file.

// Host namespaces and the lab directory under models/ they name. `rules` picks
// the extra spellings tried for that lab (see `spellings`).
const NAMESPACES: Record<string, { lab: string; rules?: "anthropic" | "llama" | "mistral" | "minimax" }> = {
  alibaba: { lab: "alibaba" },
  anthropic: { lab: "anthropic", rules: "anthropic" },
  "bytedance-seed": { lab: "bytedance-seed" },
  cohere: { lab: "cohere" },
  deepseek: { lab: "deepseek" },
  google: { lab: "google" },
  liquid: { lab: "liquid" },
  meta: { lab: "meta", rules: "llama" },
  "meta-llama": { lab: "meta", rules: "llama" },
  minimax: { lab: "minimax", rules: "minimax" },
  mistralai: { lab: "mistral", rules: "mistral" },
  "nace-ai": { lab: "nace-ai" },
  moonshot: { lab: "moonshotai" },
  moonshotai: { lab: "moonshotai" },
  openai: { lab: "openai" },
  nvidia: { lab: "nvidia" },
  qwen: { lab: "alibaba" },
  sakana: { lab: "sakana" },
  stepfun: { lab: "stepfun" },
  "stepfun-ai": { lab: "stepfun" },
  tencent: { lab: "tencent" },
  thinkingmachines: { lab: "thinkingmachines" },
  "x-ai": { lab: "xai" },
  xai: { lab: "xai" },
  spacexai: { lab: "xai" },
  xiaomi: { lab: "xiaomi" },
  zai: { lab: "zhipuai" },
  "z-ai": { lab: "zhipuai" },
  "zai-org": { lab: "zhipuai" },
};

// Relay IDs whose lab file has another name.
const OVERRIDES: Record<string, string> = {
  "bytedance/dola-seed-2.0-code": "bytedance-seed/seed-2.0-code",
  "openai/gpt-5.6-luna-pro": "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol-pro": "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra-pro": "openai/gpt-5.6-terra",
  "anthropic/claude-opus-4.7-fast": "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4.8-fast": "anthropic/claude-opus-4-8",
  "typesafe/jev-1.13": "typesafe/jev-1.13.0",
  "~typesafe/jev-latest": "typesafe/jev-latest",
};

/**
 * Hints for an OpenRouter-style `namespace/model` ID: the override, else the
 * model under the lab its namespace names, in the lab's other spellings
 * (`claude-opus-4.6` → `claude-opus-4-6`), without `:free` or `-fast`. Empty
 * for an unknown namespace or a `~` router alias.
 */
export function namespaceHints(id: string): string[] {
  const override = OVERRIDES[id];
  if (override !== undefined) return [override];
  const [namespace, ...rest] = id.split("/");
  if (namespace === undefined || rest.length === 0 || namespace.startsWith("~")) return [];
  const entry = NAMESPACES[namespace.toLowerCase()];
  if (entry === undefined) return [];
  return spellings(entry.rules, rest.join("/").replace(/:free$/, "")).map((model) => `${entry.lab}/${model}`);
}

/**
 * Hints for any host ID: `namespaceHints`, then the ID as a lab path
 * (`deepseek/deepseek-v4`), then, for an ID with no namespace, the one lab
 * file of that name in any lab (a `*\/name` hint).
 */
export function labHints(id: string): string[] {
  const bare = id.replace(/:free$/, "");
  return [...new Set([...namespaceHints(id), bare, ...(bare.includes("/") ? [] : [`*/${bare}`])])];
}

function spellings(rules: (typeof NAMESPACES)[string]["rules"], model: string) {
  const result = [model];
  if (model.endsWith("-fast")) result.push(model.slice(0, -"-fast".length));
  if (rules === "anthropic") {
    for (const candidate of [...result]) {
      result.push(candidate.replace(/(claude-[a-z]+-\d+)\.(\d+)/, "$1-$2"));
      result.push(candidate.replace(/^claude-3\.5-/, "claude-3-5-"));
    }
  }
  if (rules === "llama") {
    result.push(model.replace(/^llama-(\d+)-(\d+)/, "llama-$1.$2"));
    result.push(model.replace(/^llama-(4)-(maverick|scout)$/, "llama-$1-$2-17b"));
  }
  if (rules === "mistral") result.push(model.replace(/-latest$/, ""));
  if (rules === "minimax") result.push(model.replace(/^minimax-m/, "MiniMax-M"));
  return [...new Set(result)];
}
