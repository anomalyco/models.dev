#!/usr/bin/env bun
// Generates providers/llmtr/models/**.toml for LLMTR's passthrough models.
//
// LLMTR is an OpenAI-compatible gateway that proxies other providers' models, so every
// generated entry uses `base_model` and only declares what is provider-specific: LLMTR's
// price, its served context window, and its reasoning surface.
//
// `reasoning_options` is derived from LLMTR's own per-model `capabilities` array rather
// than the base model's `reasoning` flag:
//   reasoning_effort_<level>  -> [[reasoning_options]] type = "effort"
//   *_toggle                  -> [[reasoning_options]] type = "toggle"
//   neither                   -> reasoning_options = []   (reasons, no verified control)
//
// Source: https://llmtr.com/api/models (public, no auth). Run with: bun llmtr:generate
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"

const ROOT = path.join(import.meta.dir, "..", "..", "..")
const MODELS = path.join(ROOT, "models")
const OUT = path.join(ROOT, "providers", "llmtr", "models")
const API = "https://llmtr.com/api/models"

// LLMTR `owned_by` -> models.dev base namespace
const NS: Record<string, string> = {
  anthropic: "anthropic", openai: "openai", google: "google", qwen: "alibaba",
  deepseek: "deepseek", zai: "zhipuai", moonshot: "moonshotai", minimax: "minimax",
  mistral: "mistral", perplexity: "perplexity", stepfun: "stepfun", mimo: "xiaomi",
  meta: "meta", nvidia: "nvidia", xai: "xai", cohere: "cohere", tencent: "tencent",
}

// schema order for reasoning effort levels
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

function findBase(ns: string, model: string): string | undefined {
  const dir = path.join(MODELS, ns)
  if (!existsSync(dir)) return undefined
  const ids = readdirSync(dir).filter((f) => f.endsWith(".toml")).map((f) => f.slice(0, -5))
  const want = [model.toLowerCase(), model.toLowerCase().replaceAll(".", "-")]
  return ids.find((id) => want.includes(id.toLowerCase()))
}

const reasons = (ns: string, id: string) =>
  /(^|\n)\s*reasoning\s*=\s*true/.test(readFileSync(path.join(MODELS, ns, `${id}.toml`), "utf8"))

// LLMTR's API is authoritative for cost, served context, and the reasoning surface, but not
// for how a model is factored. Per sync.md, keep an existing `base_model` pointer and any
// hand-authored `base_model_omit` / `status` instead of clobbering them on re-run.
type Authored = { base_model?: string; base_model_omit?: string[]; status?: string }
function loadAuthored(file: string): Authored {
  if (!existsSync(file)) return {}
  const t = Bun.TOML.parse(readFileSync(file, "utf8")) as Authored
  return { base_model: t.base_model, base_model_omit: t.base_model_omit, status: t.status }
}

type Options = { header: string[]; block: string }

// Controls `capabilities` does not advertise, measured against POST /v1/chat/completions on
// 2026-08-29. Prompts were nonce-prefixed (the gateway caches identical bodies) and the effect
// was read off choices[0].message.reasoning_content. DeepSeek and Alibaba are first-party labs
// behind these routes, so the gateway forwards their own thinking fields.
const MEASURED: Record<string, Options> = {
  deepseek: {
    header: [
      `# Toggle: $.thinking.type = "disabled" (DeepSeek's own field, forwarded by the gateway).`,
      `# Measured 2026-08-29: it drops reasoning_content to 0 on deepseek-v4-pro, deepseek-v4-flash`,
      `# and deepseek-reasoner. $.reasoning and $.enable_thinking are ignored, and reasoning_effort`,
      `# is rejected 400 "does not expose a thinking mode", so this host exposes no effort control.`,
    ],
    block: `\n[[reasoning_options]]\ntype = "toggle"\n`,
  },
  qwen: {
    header: [
      `# Toggle: $.enable_thinking = true|false (Alibaba's own field, forwarded by the gateway).`,
      `# Budget: $.thinking_budget (integer reasoning tokens).`,
      `# Measured 2026-08-29 on qwen3.5-27b, qwen3.7-max and qwen3.8-flash: enable_thinking=false`,
      `# drops reasoning_content to 0 and thinking_budget=64 caps it (~220 chars against a`,
      `# 2.8k-4.6k baseline); reasoning_effort is rejected 400. Same surface as the hand-authored`,
      `# qwen3.5-plus / qwen3.6-plus entries on this host.`,
    ],
    block: `\n[[reasoning_options]]\ntype = "toggle"\n\n[[reasoning_options]]\ntype = "budget_tokens"\n`,
  },
}

// Reasoners this host exposes no control for, each probed against POST /v1/chat/completions
// on 2026-08-29 with the same variant sweep (reasoning_effort, thinking.type, thinkingConfig,
// include_reasoning, reasoning, enable_thinking, thinking_budget). `[]` for these owners is an
// affirmative measurement -- AGENTS.md: "Empty means no caller control, not uncertainty" --
// rather than a gap in `capabilities`, and the note travels into the file so it stays checkable.
const NO_CONTROL: Record<string, { probed: string; extra?: string[] }> = {
  openai: { probed: "gpt-5.4, o3" },
  anthropic: { probed: "claude-opus-4.6" },
  google: { probed: "gemini-3.1-pro-preview" },
  moonshot: {
    probed: "kimi-k2.6, kimi-k2.7-code",
    extra: [`thinking.type = "disabled" answers 400 "Moonshot <id> does not support disabling thinking".`],
  },
  mistral: {
    probed: "mistral-medium-latest, mistral-small-latest, magistral-medium-latest",
    extra: [`Every non-effort field is rejected 422 by Mistral upstream.`],
  },
  perplexity: { probed: "sonar-reasoning-pro" },
  stepfun: {
    probed: "step-3.5-flash",
    extra: [
      `The sibling step-3.5-flash-2603 route does advertise reasoning_effort low|high and accepts it, so the empty surface here is this id's, not the family's.`,
    ],
  },
  minimax: { probed: "minimax-m2.5, minimax-m2.7" },
  mimo: { probed: "mimo-v2.5, mimo-v2.5-pro" },
  nvidia: { probed: "nemotron-3-super-120b-a12b, nemotron-3-ultra-550b-a55b" },
}

// Wrap prose into `#` comment lines so a long probe list does not run off the side of the file.
function comment(text: string, width = 98): string[] {
  const lines: string[] = []
  let line = "#"
  for (const word of text.split(/\s+/)) {
    if (line.length + 1 + word.length > width) {
      lines.push(line)
      line = "#"
    }
    line += ` ${word}`
  }
  if (line !== "#") lines.push(line)
  return lines
}

// Leading comment for a `reasoning_options = []` entry, when the owner was actually probed.
function noControlHeader(owner: string): string[] {
  const measured = NO_CONTROL[owner]
  if (!measured) return []
  return [
    ...comment(
      `Measured 2026-08-29 (probed ${measured.probed}): reasoning_effort is rejected 400 "does not` +
        ` expose a thinking mode", and thinking.type / enable_thinking / thinking_budget / reasoning` +
        ` leave reasoning_content unchanged. No caller-facing control on this route.`,
    ),
    ...(measured.extra ?? []).flatMap((line) => comment(line)),
  ]
}

// One route where LLMTR's capability list and the route's behaviour disagree, so the list
// cannot be trusted to author the entry. Measured 2026-08-29, two runs per variant.
const OVERRIDE: Record<string, Options> = {
  "zai/glm-5.2": {
    header: [
      `# Toggle: $.reasoning = true|false (aliases: the :think / :fast suffixes on the model id).`,
      `# Measured 2026-08-29: thinking is off by default here (baseline reasoning_content 0, twice),`,
      `# reasoning=true returns 602-1039 chars and reasoning=false returns 0. capabilities also lists`,
      `# reasoning_effort none..xhigh, and unlike every other route the gateway does not validate`,
      `# those per model (only junk values fail, against the global enum). They are not a scale:`,
      `# "none" -- the level that would mean off -- turns thinking ON (873/967/1132 chars against a 0`,
      `# baseline), and low 341-1082, medium 1149, high 380, xhigh 379-1340 do not order. Authoring`,
      `# effort here would promise callers a graded control, and an off switch, that the route does`,
      `# not have, so only the verified toggle is declared.`,
    ],
    block: `\n[[reasoning_options]]\ntype = "toggle"\n`,
  },
}

const TOGGLE_BLOCK = `\n[[reasoning_options]]\ntype = "toggle"\n`
const TOGGLE_HEADER = [
  `# Toggle: $.reasoning = true|false (aliases: the :think / :fast suffixes on the model id).`,
  `# The gateway names this wire path itself: reasoning_effort answers 400 "This model exposes`,
  `# thinking as an on/off mode: send "reasoning": true or use the :think suffix on the model id"`,
  `# (measured 2026-08-29 on zai/glm-4.6 and zai/glm-4.7; reasoning=true returns reasoning_content,`,
  `# reasoning=false and an omitted field return none).`,
]

const effortBlock = (levels: string[]) =>
  `\n[[reasoning_options]]\ntype = "effort"\nvalues = [${levels.map((v) => `"${v}"`).join(", ")}]\n`
const effortHeader = (levels: string[]) => [
  `# Effort: $.reasoning_effort = ${levels.join("|")} (model suffixes :${levels.join("|:")} are aliases).`,
]

// Build the reasoning_options block for a model, following the table in AGENTS.md
// ("Reasoning options" 3): effort carrying "none" alongside graded levels is the off switch and
// stands alone; a separate on/off control next to graded effort is authored as both; a control
// that is only on/off is a toggle. Wire paths go in a leading top-of-file comment because sync
// strips mid-file ones.
function reasoningOptions(owner: string, slug: string, caps: string[]): Options {
  const override = OVERRIDE[slug]
  if (override) return override
  const measured = MEASURED[owner]
  if (measured) return measured

  const toggle = caps.some((c) => c.endsWith("_toggle"))
  const efforts = EFFORT_ORDER.filter((l) => caps.includes(`reasoning_effort_${l}`))
  const graded = efforts.filter((l) => l !== "none")

  if (efforts.includes("none") && graded.length) return { header: effortHeader(efforts), block: effortBlock(efforts) }
  if (toggle && graded.length) {
    return {
      header: [...TOGGLE_HEADER, ...effortHeader(graded)],
      block: TOGGLE_BLOCK + effortBlock(graded),
    }
  }
  if (toggle) return { header: TOGGLE_HEADER, block: TOGGLE_BLOCK }
  // "none" on its own is not a graded scale, it is an off switch.
  if (efforts.length === 1 && efforts[0] === "none") {
    return {
      header: [
        `# Toggle: $.reasoning_effort = "none" turns thinking off; omit the field to leave it on`,
        `# (the route advertises reasoning_default_on). "none" is the only level it accepts -- any`,
        `# other answers 400 "does not support reasoning effort ... Supported: none" -- so this is a`,
        `# binary on/off control rather than a graded scale.`,
      ],
      block: TOGGLE_BLOCK,
    }
  }
  if (efforts.length) return { header: effortHeader(efforts), block: effortBlock(efforts) }
  return { header: noControlHeader(owner), block: "" } // caller writes `reasoning_options = []`
}

const GENERATED = "# Generated by `bun llmtr:generate`"
const accessed = new Date().toISOString().slice(0, 10)
const list = (await (await fetch(API)).json()).data.data as any[]
const chat = list.filter((m) => (m.supported_operations || []).includes("CHAT_COMPLETIONS"))

const kept = new Set<string>()
// Every slug LLMTR currently lists, generated or not. Entries this run skips (tiered
// pricing, no base match, an owner outside NS) are still served and may be authored by
// hand, so pruning must key off this set rather than off what the run happened to write.
const served = new Set(list.map((m) => `${m.id as string}.toml`))
const skipped = { noNs: [] as string[], noBase: [] as string[], noPrice: [] as string[], authored: [] as string[] }
let queue = chat.map((m) => m.id as string)

async function worker() {
  while (queue.length) {
    const slug = queue.shift()!
    const [owner, ...rest] = slug.split("/")
    const model = rest.join("/")
    const ns = NS[owner]
    if (!ns) { skipped.noNs.push(slug); continue }
    const base = findBase(ns, model)
    if (!base) { skipped.noBase.push(slug); continue }

    const d = (await (await fetch(`${API}/${slug}`)).json()).data.model
    // Only flat per-token text pricing can be expressed as a single cost.input/cost.output.
    // Tiered models price by context size, and a duplicated INPUT_TEXT/OUTPUT_TEXT row is
    // ambiguous — writing either would silently commit a wrong price, so skip both.
    //
    // primaryPricingRows lists one row per (operation, metric): a model served over both
    // /v1/chat/completions and /v1/responses repeats INPUT_TEXT/OUTPUT_TEXT once per
    // operation. This catalog only covers CHAT_COMPLETIONS, so scope the rows to that
    // operation before counting — otherwise the duplicate-row guard below misreads the
    // RESPONSES copy as ambiguity and drops a model LLMTR still serves.
    const rows = (d.primaryPricingRows || []) as { operation: string; metric: string; priceUsd: string }[]
    const chatRows = rows.filter((r) => r.operation === "CHAT_COMPLETIONS")
    const ins = chatRows.filter((r) => r.metric === "INPUT_TEXT")
    const outs = chatRows.filter((r) => r.metric === "OUTPUT_TEXT")
    if (d.pricingSummary?.pricingModel === "tiered" || ins.length > 1 || outs.length > 1) {
      skipped.noPrice.push(slug)
      continue
    }
    const input = ins.length ? Number(ins[0].priceUsd) : undefined
    const output = outs.length ? Number(outs[0].priceUsd) : undefined
    if (input === undefined || output === undefined) { skipped.noPrice.push(slug); continue }

    const caps: string[] = d.capabilities || []
    const options: Options = reasons(ns, base) ? reasoningOptions(owner, slug, caps) : { header: [], block: "" }
    const empty = reasons(ns, base) && !options.block

    const file = path.join(OUT, `${slug}.toml`)
    // A file this generator did not write is hand-authored: it carries measurements and
    // rationale (audio pricing units, a reasoning-token price, a deliberately inherited
    // context) that LLMTR's API cannot express. Regenerating it would silently drop that.
    if (existsSync(file) && !readFileSync(file, "utf8").startsWith(GENERATED)) {
      skipped.authored.push(slug)
      continue
    }
    const authored = loadAuthored(file)

    let t = `${GENERATED} from ${API} (accessed ${accessed}).\n`
    t += `# reasoning_options reflect LLMTR's own chat surface, not the base model's flag.\n`
    for (const line of options.header) t += `${line}\n`
    t += `base_model = "${authored.base_model ?? `${ns}/${base}`}"\n`
    if (authored.base_model_omit) t += `base_model_omit = [${authored.base_model_omit.map((v) => `"${v}"`).join(", ")}]\n`
    if (authored.status) t += `status = "${authored.status}"\n`
    if (empty) t += `reasoning_options = []\n`
    t += `\n[cost]\ninput = ${input}\noutput = ${output}\n`
    const ctx = Number(d.contextWindow)
    if (Number.isFinite(ctx) && ctx > 0) t += `\n[limit]\ncontext = ${ctx.toLocaleString("en-US").replaceAll(",", "_")}\n`
    t += options.block

    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, t)
    kept.add(`${slug}.toml`)
  }
}
await Promise.all(Array.from({ length: 8 }, worker))

// Prune passthrough entries LLMTR no longer serves (first-party llmtr/* models live at the
// top level of OUT and are hand-authored, so only nested <owner>/<model>.toml are managed).
// Skipped-but-served models keep their files: a tiered price or a missing base model is a
// gap in this generator, not a retirement.
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  )
}
const removed: string[] = []
for (const file of walk(OUT)) {
  const rel = path.relative(OUT, file).replaceAll("\\", "/")
  if (!rel.includes("/") || !rel.endsWith(".toml")) continue
  if (served.has(rel)) continue
  rmSync(file)
  removed.push(rel)
}

console.log("written:", kept.size)
console.log("removed (no longer served):", removed.length, removed.join(", "))
console.log("skipped (hand-authored):", skipped.authored.length, skipped.authored.join(", "))
console.log("skipped (no base namespace):", skipped.noNs.length)
console.log("skipped (no matching base):", skipped.noBase.length)
console.log("skipped (tiered/no flat price):", skipped.noPrice.length)
