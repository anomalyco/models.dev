import path from "node:path";

import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, modelMetadata, normalizeModelSlug } from "./openrouter.js";

const API_ENDPOINT = "https://aihubmix.com/api/v1/models?type=llm";

/** AIHubMix quotes USD per 1M tokens directly, matching the catalog unit. */
const Pricing = z
  .object({
    input: z.number().nullish(),
    output: z.number().nullish(),
    cache_read: z.number().nullish(),
    cache_write: z.number().nullish(),
    tiers: z
      .array(
        z
          .object({
            tier: z.object({
              type: z.string().nullish(),
              size: z.number(),
            }),
            input: z.number().nullish(),
            output: z.number().nullish(),
            cache_read: z.number().nullish(),
            cache_write: z.number().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

/**
 * AIHubMix ships `default` alongside `type`/`values`, which the catalog's strict
 * ReasoningOption rejects, so the extra key is dropped during translation.
 */
const ReasoningOption = z
  .object({
    type: z.string(),
    values: z.array(z.string()).nullish(),
    min: z.number().nullish(),
    max: z.number().nullish(),
  })
  .passthrough();

export const AihubmixModel = z
  .object({
    model_id: z.string().min(1),
    model_name: z.string().nullish(),
    // The upstream lab that built the model, and the AIHubMix ID this entry is a
    // routing variant of. Both are served by the catalog itself, so neither the
    // lab nor the variant relationship is inferred from the relay ID here.
    vendor: z.string().nullish(),
    variant_of: z.string().nullish(),
    desc: z.string().nullish(),
    pricing: Pricing.nullish(),
    features: z.string().nullish(),
    input_modalities: z.string().nullish(),
    output_modalities: z.string().nullish(),
    context_length: z.number().nullish(),
    max_output: z.number().nullish(),
    reasoning: z.boolean().nullish(),
    reasoning_options: z.array(ReasoningOption).nullish(),
    tool_call: z.boolean().nullish(),
    release_date: z.string().nullish(),
    last_updated: z.string().nullish(),
    // `knowledge` is not served yet; read opportunistically so it lands without a
    // code change once AIHubMix adds it.
    knowledge: z.string().nullish(),
    open_weights: z.boolean().nullish(),
    retire_stage: z.string().nullish(),
  })
  .passthrough();

export const AihubmixResponse = z
  .object({
    success: z.boolean().nullish(),
    data: z.array(AihubmixModel).min(1),
  })
  .passthrough();

export type AihubmixModel = z.infer<typeof AihubmixModel>;

/**
 * AIHubMix relays upstream models under its own IDs, so a relay is factored onto
 * the lab metadata it serves whenever that metadata exists — the relay then only
 * records what it actually changes (price, reasoning controls, limits).
 *
 * The catalog answers both halves of that lookup itself: `vendor` names the lab
 * that built the model, and `variant_of` names the AIHubMix ID this entry is a
 * routing variant of. Relay IDs carry prefixes (`coding-`, `alicloud-`) and
 * suffixes (`-free`, `-think`) that are AIHubMix routing modes rather than
 * distinct upstream models, and `variant_of` states that relationship instead of
 * it being guessed from the string — which also resolves the relays no amount of
 * string surgery reaches, such as `ox-alpha` onto `zhipuai/glm-5.3-flash`.
 */
const VENDOR_LABS: Record<string, string> = {
  // The two registries spell four labs differently. This maps namespaces, not
  // models: no entry here decides what any model is or which lab built it.
  zhipu: "zhipuai",
  moonshot: "moonshotai",
  bytedance: "bytedance-seed",
  "meituan-longcat": "meituan",
};

/** Catalog effort levels; AIHubMix spells two of them differently. */
const EFFORT_ALIASES: Record<string, string> = { no_think: "none", instant: "minimal" };
const EFFORT_VALUES = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
]);

type LabMetadataIDs = Map<string, string>;
/** Every listed relay by lowercased ID, so `variant_of` can be followed. */
type RelayCatalog = Map<string, AihubmixModel>;

let labMetadataIDs: LabMetadataIDs | undefined;
let relayCatalog: RelayCatalog | undefined;

/**
 * The catalog rejects a `base_model` that resolves to nothing, so relays are
 * only factored onto metadata that is actually present on disk.
 */
async function readLabMetadataIDs(modelsDir: string) {
  const metadataDir = path.join(path.dirname(path.dirname(path.dirname(modelsDir))), "models");
  const ids = new Map<string, string>();
  for await (const file of new Bun.Glob("**/*.toml").scan({ cwd: metadataDir, followSymlinks: true })) {
    const id = file.split(path.sep).join("/").slice(0, -5);
    // AIHubMix lowercases every relay ID while labs keep their own casing
    // (`minimax-m2` against `minimax/MiniMax-M2`), so lookups are case-folded.
    ids.set(id.toLowerCase(), id);
  }
  return ids;
}

// The same off state is reachable from whichever dialect the caller speaks, so
// an off switch has no single wire path. Name one per protocol.
const DIALECT_PATHS =
  '# $.enable_thinking = true|false on the OpenAI-compatible /v1/chat/completions path (verified live 2026-09-11);\n' +
  '# $.thinking.type = "enabled"|"disabled"|"adaptive" on /v1/messages; $.generationConfig.thinkingConfig on the Gemini path.\n';
// Cited on its own line, because a human wrote this exact line by hand in
// `gemini-3.7-flash.toml` — it is a source for the whole gateway, not a claim
// about one model's options, and so it is carried through as a note rather than
// being owned by the block. The two lines above are only ever this adapter's own.
const DIALECT_SOURCE = "# https://docs.aihubmix.com/cn/api/unified-inference\n";
const DIALECTS = DIALECT_PATHS + DIALECT_SOURCE;
const TOGGLE_HEADER = "# Toggle:\n" + DIALECTS;
// Where the catalog spells the off state as `effort = none`, the other dialects
// still reach it, and the folded toggle is the only place that was recorded.
const FOLDED_HEADER = "# Off is effort=none; graded levels — no toggle. The same off elsewhere:\n" + DIALECTS;

export const aihubmix = {
  id: "aihubmix",
  name: "AIHubMix",
  modelsDir: "providers/aihubmix/models",
  trackMissingModels: true,
  // A rewrite keeps whatever leading comment the file already had, so a stale
  // wire path would outlive the options it documents — and a model whose toggle
  // folds into `effort = none` would keep advertising a toggle. translateModel
  // re-derives the header from the response, so let it own the block.
  authoritativeHeaders: true,
  // The listing is AIHubMix's main model list, and a route rotates out of it for a
  // spell without being retired, so a local file absent from one response is
  // retained rather than deleted. It is not a licence to keep anything: a hidden
  // channel alias (`zai-glm-5.1`, which the gateway answers by routing to the
  // listed `glm-5.1`) is deliberately outside that list and does not belong here.
  deleteMissing: false,
  sourceID(model) {
    return model.retire_stage === "deprecated" ? undefined : model.model_id;
  },
  missingNotice(paths) {
    return paths.map(
      (file) =>
        `AIHubMix does not list ${file} in its main model list; confirm the route rotated out for a spell, or drop the file if it is a hidden channel alias of a model already in the catalog.`,
    );
  },
  skippedNotice(ids) {
    return ids.map(
      (id) =>
        `AIHubMix lists ${id} but it cannot be written yet. If it names a vendor, add the lab model under \`models/${"<lab>/<model>"}.toml\` and the relay factors onto it automatically; if it names none, the response is missing the release_date/open_weights/limits a standalone entry has to carry.`,
    );
  },
  async fetchModels() {
    labMetadataIDs = await readLabMetadataIDs(this.modelsDir);
    const response = await fetch(process.env.AIHUBMIX_MODELS_URL ?? API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`AIHubMix models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const data = AihubmixResponse.parse(raw).data;
    // `cc-minimax-m2` and `cc-MiniMax-M2` are the same route under two spellings
    // and would claim filenames that differ only in case. Keep the last entry
    // whole rather than mixing two records.
    relayCatalog = new Map(data.map((model) => [model.model_id.toLowerCase(), model]));
    return [...relayCatalog.values()];
  },
  translateModel(model, context) {
    const existing = context.existing(model.model_id);
    const built = buildAihubmixModel(model, existing, labMetadataIDs, relayCatalog);
    if (built === undefined) return undefined;
    return {
      id: model.model_id,
      model: built,
      // A rewrite drops whatever header the file carried, so re-author it here
      // or the wire path is lost on the first sync that touches the model.
      header: composeHeader(context.header?.(model.model_id), reasoningHeader(model, built)),
    };
  },
} satisfies SyncProvider<AihubmixModel>;

export function buildAihubmixModel(
  model: AihubmixModel,
  existing: ExistingModel | undefined,
  labIDs: LabMetadataIDs | undefined = labMetadataIDs,
  catalog: RelayCatalog | undefined = relayCatalog,
): SyncedModel | undefined {
  const base = existing?.base_model ?? resolveBaseModel(model, labIDs, catalog);
  // `dev` carries 77 aihubmix files, so most of the catalog arrives as a create
  // with no file to union against. The lab entry the relay factors onto is the
  // only baseline those have, and 14 creates in the current listing would
  // otherwise write a narrowing override onto it (`gpt-4o` losing pdf,
  // `qwen3.5-27b` losing audio).
  const lab = labMetadata(base);
  const baseModalities = lab?.modalities;
  const input = modalities(model.input_modalities, [
    ...(existing?.modalities?.input ?? []),
    ...(baseModalities?.input ?? []),
  ]);
  const output = modalities(model.output_modalities, [
    ...(existing?.modalities?.output ?? []),
    ...(baseModalities?.output ?? []),
  ]);
  const features = new Set((model.features ?? "").split(",").map((value) => value.trim()));
  // The endpoint never sends `false`. 107 of 408 routes omit `reasoning` and 100
  // omit `tool_call` rather than denying them, and no route sends `false` at
  // all, so a missing flag means unknown. Reading it as `false` would write an
  // override that turns off a reasoner or tool use the lab declares.
  const reasoning = model.reasoning ?? existing?.reasoning;
  const toolCall = model.tool_call ?? existing?.tool_call;
  const structuredOutput = features.has("structured_outputs") || existing?.structured_output;
  const name = model.model_name ?? existing?.name;
  const context = tokens(model.context_length);
  // Two ways AIHubMix signals an unknown output ceiling: backfilling it from
  // `context_length` (36 of 408 models quote the two as equal, which would leave
  // no room for the prompt) and quoting a value above the window. Both are read
  // as absent, the same as the 0 the endpoint also uses.
  const quoted = tokens(model.max_output);
  const maxOutput =
    context !== undefined && quoted !== undefined && quoted >= context ? undefined : quoted;
  // Same class of bug as the modalities: the endpoint restates windows in decimal
  // (8 glm routes quote 204800 as 200000) and quotes conservative output ceilings,
  // and treating those as owned fields writes a narrowing override onto a limit the
  // lab entry already states correctly. A restatement resolves to the accepted
  // value; a genuine cap the host imposes still lands.
  const limit = {
    context: resolveLimit(context, existing?.limit?.context, lab?.limit?.context),
    // The endpoint models no input cap, so an authored one is the only record of it.
    input: existing?.limit?.input,
    output: resolveLimit(maxOutput, existing?.limit?.output, lab?.limit?.output),
  };
  const shared = {
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions(model, existing) ?? existing?.reasoning_options,
    tool_call: toolCall,
    structured_output: structuredOutput,
    // AIHubMix serves no temperature, interleaved, fast-mode or request-shape
    // surface; all four exist on the file and nowhere else, so keep them.
    temperature: existing?.temperature,
    interleaved: existing?.interleaved,
    experimental: existing?.experimental,
    provider: existing?.provider,
    status: model.retire_stage === "deprecated" ? ("deprecated" as const) : existing?.status,
    modalities: { input, output },
    limit,
    cost: buildCost(model.pricing, existing?.cost),
  };

  if (base !== undefined) {
    return factorBaseModel(
      base,
      { name: factoredName(model, base, existing), description: existing?.description, ...shared },
      limit,
      existing?.base_model === base ? existing.base_model_omit : undefined,
    );
  }

  // `vendor` names the lab that built the model, so this relay hosts someone
  // else's model and belongs on `base_model` — AGENTS.md treats a full standalone
  // definition for a nameable lab model as a blocker. Reaching here means the lab
  // entry does not exist yet (81 of 407 routes, 38 of them complete enough that the
  // endpoint answer alone would have satisfied the standalone guard), so the relay is
  // reported for a human to add `models/<lab>/<id>.toml`, after which it factors
  // with no change here. A file already in the repo keeps being updated: what it
  // should have been is upstream's call, and freezing it would only stall its prices.
  if (existing === undefined && model.vendor != null) return undefined;

  // A standalone entry must carry every required catalog field itself, and the
  // endpoint still leaves gaps: 304 of 408 models are dated, 289 state
  // `open_weights`, and the rest quote 0 for a limit they do not know. A relay
  // with neither metadata to inherit nor those fields is reported rather than
  // written with invented values.
  const releaseDate = model.release_date ?? existing?.release_date;
  const openWeights = model.open_weights ?? existing?.open_weights;
  if (
    name === undefined ||
    releaseDate === undefined ||
    openWeights === undefined ||
    limit.context === undefined ||
    limit.output === undefined
  ) {
    return existing === undefined ? undefined : (existing as SyncedModel);
  }

  // A standalone entry has no lab entry to inherit from, so the two flags have
  // to resolve to a boolean here. Published reasoning options are the model's
  // own statement that it reasons; absent both, the route is recorded as not.
  const standaloneReasoning = reasoning ?? shared.reasoning_options !== undefined;
  const standaloneToolCall = toolCall ?? false;
  return {
    ...shared,
    reasoning: standaloneReasoning,
    tool_call: standaloneToolCall,
    name,
    description:
      existing?.description ??
      model.desc ??
      describeModel({
        id: model.model_id,
        providerId: "aihubmix",
        name,
        reasoning: standaloneReasoning,
        tool_call: standaloneToolCall,
        structured_output: structuredOutput,
        open_weights: openWeights,
        limit,
        modalities: { input, output },
      }),
    family: existing?.family,
    release_date: releaseDate,
    last_updated: model.last_updated ?? model.release_date ?? existing?.last_updated ?? releaseDate,
    knowledge: model.knowledge ?? existing?.knowledge,
    open_weights: openWeights,
  } as SyncedFullModel;
}

function resolveBaseModel(
  model: AihubmixModel,
  labIDs: LabMetadataIDs | undefined,
  catalog: RelayCatalog | undefined,
) {
  const vendor = model.vendor;
  if (vendor == null || labIDs === undefined) return undefined;
  const lab = VENDOR_LABS[vendor] ?? vendor;
  for (const candidate of relayChain(model, catalog)) {
    const id = labIDs.get(`${lab}/${candidate}`.toLowerCase());
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * The relay's own ID first, then one `variant_of` hop at a time toward the
 * canonical entry. Nearest first matters: `qwen3.8-max-preview` is a variant of
 * `qwen3.8-max` and both are published lab models, so the relay must factor onto
 * the preview it actually serves rather than onto the root of its chain.
 */
function relayChain(model: AihubmixModel, catalog: RelayCatalog | undefined) {
  const chain = [bareID(model.model_id)];
  const seen = new Set(chain);
  let current: AihubmixModel | undefined = model;
  while (current?.variant_of != null) {
    const parent = bareID(current.variant_of);
    if (seen.has(parent)) break;
    seen.add(parent);
    chain.push(parent);
    current = catalog?.get(current.variant_of.toLowerCase());
  }
  return chain;
}

function bareID(modelID: string) {
  return modelID.split("/").at(-1) ?? modelID;
}

function reasoningOptions(
  model: AihubmixModel,
  existing?: ExistingModel,
): SyncedFullModel["reasoning_options"] {
  if (model.reasoning_options == null) return undefined;
  const options = model.reasoning_options.flatMap((option) => {
    if (option.type === "toggle") return [{ type: option.type }];
    // The endpoint states that a budget exists but not its bounds, so the bounds a
    // file already carries are the only record of them and are carried through.
    // There is no second baseline to fall back on: `ModelMetadata` has no
    // `reasoning_options` field, so a bare budget written here cannot be shadowing
    // a range stated on the lab entry — that range can only live on a provider file,
    // and a budget range is a property of the host's API, not of the model.
    if (option.type === "budget_tokens") {
      const authored = existing?.reasoning_options?.find((entry) => entry.type === "budget_tokens");
      const min = option.min ?? (authored?.type === "budget_tokens" ? authored.min : undefined);
      const max = option.max ?? (authored?.type === "budget_tokens" ? authored.max : undefined);
      return [{ type: "budget_tokens" as const, min: min ?? undefined, max: max ?? undefined }];
    }
    if (option.type !== "effort") return [];
    const values = (option.values ?? [])
      .map((value) => EFFORT_ALIASES[value] ?? value)
      .filter((value) => EFFORT_VALUES.has(value));
    return values.length > 0 ? [{ type: "effort" as const, values }] : [];
  });
  // AIHubMix accepts whichever off switch the caller's SDK speaks and maps it,
  // so a model can publish both a toggle and `effort = none`. The catalog spells
  // that one way: graded effort carrying `none` stands alone, and the dialects
  // that reach the same off state are named in the file header instead.
  const folded = foldsToggle(options) ? options.filter((option) => option.type !== "toggle") : options;
  return folded.length > 0 ? (folded as SyncedFullModel["reasoning_options"]) : undefined;
}

function foldsToggle(options: { type: string; values?: string[] }[]) {
  return (
    options.some((option) => option.type === "toggle") &&
    options.some((option) => option.type === "effort" && (option.values ?? []).includes("none"))
  );
}

/**
 * The display name to record on a factored entry. `inheritedOverride` already
 * drops a name the lab entry states identically, but the two registries punctuate
 * the same name differently — the endpoint writes `GLM 5.3` where the lab writes
 * `GLM-5.3` — and taking the endpoint's spelling as an override on 78 entries
 * would fight the lab's own naming across the catalog for no gain.
 *
 * So the endpoint's label is recorded only where the relay is not simply that lab
 * model under another punctuation: its ID, normalised, differs from the base
 * model's slug. That is the same test `shouldPreserveFactoredName` applies for
 * OpenRouter, and it is what keeps `coding-glm-4.6-free` reading "Coding GLM 4.6
 * (free)" instead of inheriting a bare "GLM-4.6" it shares with two other routes.
 * A relay that *is* the lab model keeps deferring to the lab's spelling, including
 * where the lab renamed it (`gemini-3-pro-image` shows as "Nano Banana Pro"). And
 * the endpoint's label only ever fills a create: an update keeps the name the file
 * states, so this cannot rewrite a spelling a human chose.
 */
function factoredName(model: AihubmixModel, base: string, existing: ExistingModel | undefined) {
  // A name already on the file is a human's call and outranks the endpoint's label,
  // which is a storefront string: 4 files spell their model the way its lab does
  // (`MiMo-V2.5`, `MiniMax-M2.7`) where the endpoint sends `Mimo V2.5`. Handing it
  // straight through stays correct anyway — `inheritedOverride` drops a name the lab
  // states identically, which is what retires the 27 redundant ones `dev` carries.
  if (existing?.name !== undefined) return existing.name;
  // A blank label is not a name. `ModelBase.name` is `min(1)`, so writing one
  // through would abort the whole provider's sync at validation rather than skip
  // the field, and the standalone path never had to care because it only ever
  // passed a name that had already been validated.
  if (model.model_name == null || model.model_name.trim() === "") return undefined;
  // Compared on the bare ID, because that is what resolved the base model:
  // `relayChain` walks `bareID(model_id)`, so `Qwen/QwQ-32B` reaches
  // `qwen/qwq-32b`. Normalising the namespaced form instead would never match its
  // own slug, and each of the 10 namespaced routes would take a redundant
  // storefront override the moment its lab file lands.
  const slug = base.split("/").slice(1).join("/");
  return normalizeModelSlug(bareID(model.model_id)) === normalizeModelSlug(slug) ? undefined : model.model_name;
}

/**
 * A bare wire-path line, which the derived block restates in full. These four
 * openings introduce nothing but the field to send, so replacing one loses
 * nothing — `# Effort: reasoning_effort = low|high|max` says less than the block
 * that supersedes it.
 *
 * Matching an opening rather than a substring is the point. Keying on `$.` or on
 * the docs host would also delete lines that merely mention one: seven files on
 * `dev` carry a header, and `claude-opus-5` and `qwen3.8-max` each state a wire
 * path together with a dated live test the response cannot reproduce
 * ("verified live 2026-08-11"). Those are notes, and notes are carried through
 * even where they overlap the block — a second statement of the same wire path
 * costs nothing, a deleted verification date cannot be recovered.
 */
const AUTHORED_OPENING = /^#\s*(Toggle|Effort|Budget|Off is effort)\b/;

function composeHeader(existingHeader: string | undefined, derived: string | undefined) {
  // The two wire-path lines are this adapter's own restatement of the block, so
  // they go whether or not a block replaces them. Keeping them when nothing is
  // derived is what left a route advertising a toggle it no longer has: the block
  // vanished, its tail survived as a "note", and no later sync could tell the
  // difference — the file never self-corrected.
  //
  // The source line is kept unless a derived block restates it, which is only to
  // avoid stating it twice. It is a citation for the gateway rather than a claim
  // about this model, and a human wrote this exact line in `gemini-3.7-flash`.
  const authored = new Set(
    (derived === undefined ? DIALECT_PATHS : DIALECTS)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
  const notes = (existingHeader ?? "")
    .split("\n")
    .filter((line) =>
      line.trim() !== "" && !AUTHORED_OPENING.test(line.trim()) && !authored.has(line.trim()),
    );
  const header = (derived ?? "") + (notes.length > 0 ? `${notes.join("\n")}\n` : "");
  return header === "" ? undefined : header;
}

function reasoningHeader(model: AihubmixModel, built: SyncedModel) {
  const options = built.reasoning_options;
  if (options === undefined) return undefined;
  if (options.some((option) => option.type === "toggle")) return TOGGLE_HEADER;
  // Only say where the off state moved to on a file that actually spells it out.
  return options.some((option) => option.type === "effort" && option.values?.includes("none")) &&
    (model.reasoning_options ?? []).some((option) => option.type === "toggle")
    ? FOLDED_HEADER
    : undefined;
}

/**
 * The endpoint under-reports what a route accepts: it lists `text,image` for
 * `kimi-k2.5`, whose lab entry and this repo both record video, and `text` for
 * `qwen3.8-2.4t-a95b`, whose own file notes a live 200 on image input. Both are
 * reported upstream, but a sync must not delete an accepted modality in the
 * meantime, so the endpoint adds to what the file recorded rather than replacing
 * it. A modality the endpoint never listed can still be removed by editing the
 * file, which is where it came from.
 */
/**
 * The lab entry a relay factors onto, read for what the endpoint can under-report:
 * modalities it omits and windows it restates in decimal. Returns nothing when the
 * relay is standalone. Reasoning controls are not here to be read: `ModelMetadata`
 * has no `reasoning_options` field, so a lab entry cannot state them and only a
 * provider file ever does.
 */
function labMetadata(base: string | undefined) {
  if (base === undefined) return undefined;
  return modelMetadata(base) as {
    modalities?: { input?: string[]; output?: string[] };
    limit?: { context?: number; output?: number };
  };
}

/**
 * A decimal restatement of a binary window can only lose `1000/1024` per K unit,
 * so three nested unit swaps — 1024³ tokens quoted as 1000³ — is the floor of what
 * a restatement can explain. The endpoint quotes 204800 as 200000 (0.977), 1048576
 * as 1000000 (0.954) and 65536 as 65535; none of that is the host narrowing the
 * window, and writing it as an override invents a difference that is not there.
 * A real restriction sits far below: grok-code-fast-1 caps output at 10000 of
 * 256000 (0.039) and gpt-5-chat-latest serves 128000 of a 400000 window (0.320).
 */
const UNIT_RESTATEMENT_FLOOR = 1000 ** 3 / 1024 ** 3;

/**
 * The limit to record. The endpoint speaks first and the file stands in when it
 * says nothing — the authored value is not a worse version of the lab's but a
 * narrower one on purpose, the host's own cap (`kimi-k2.5` serves 32768 of a
 * 262144 window), so it is kept rather than widened away.
 *
 * Whichever of the two states the limit, it is only recorded if it is a limit: a
 * value that merely restates an accepted window in decimal resolves to that
 * window and no override is written. Applying the test to the stated value rather
 * than to the endpoint's quote also retires the restatements an earlier sync
 * already wrote onto three MiniMax files (128000 and 128100 of 131072).
 */
function resolveLimit(quoted?: number, authored?: number, lab?: number) {
  const stated = quoted ?? authored;
  if (stated === undefined) return undefined;
  // The restatement reads the same from either side, so the comparison is a ratio
  // rather than a direction: the endpoint quotes an accepted 204800 as 200000 and
  // an accepted 1000000 as 1048576, and neither is the host stating a different
  // window. Checking only the narrowing side left 20 routes writing an override
  // that states no difference at all (`glm-5.3` recording 1048576 against a lab
  // window of 1000000).
  //
  // The lab entry is tried first, because a restatement should resolve to the
  // spelling that makes the override disappear: matching the lab means
  // `inheritedOverride` drops the key entirely, while resolving to the value the
  // provider file happens to hold would pin that spelling forever — `991000` is
  // itself just an imprecise way of writing the lab's 1000000. The file's own
  // value still decides where the lab states no such key, and a genuine host
  // restriction falls below the floor and is written as the delta it is.
  let resolved = stated;
  for (const accepted of [lab, authored]) {
    if (accepted === undefined) continue;
    const ratio = Math.min(stated, accepted) / Math.max(stated, accepted);
    if (ratio < UNIT_RESTATEMENT_FLOOR) continue;
    resolved = accepted;
    break;
  }
  // A relay cannot serve a wider window than the model it relays: the window is the
  // model's property and a host can only restrict it. Applied to whatever the
  // restatement resolved, not in place of it — an endpoint quoting the same stale
  // ceiling the file already holds resolves to that number, and clamping only
  // afterwards is what catches it (`grok-4.5` quoting the file's own 1000000 output
  // against a lab window of 500000). Where the lab entry is the stale side,
  // `models/` is where that gets corrected.
  return lab !== undefined && resolved > lab ? lab : resolved;
}

function modalities(value: string | null | undefined, fallback: string[]) {
  const parsed = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => ["text", "audio", "image", "video", "pdf"].includes(entry));
  const known = fallback.length > 0 ? fallback : ["text"];
  if (parsed.length === 0) return known as SyncedFullModel["modalities"]["input"];
  // Endpoint order first, so a file only changes when its content changes.
  return [...new Set([...parsed, ...known])] as SyncedFullModel["modalities"]["input"];
}

/**
 * AIHubMix omits a price field when the model has no such rate, so an omitted
 * field means "not offered" and an authored value is only kept when the
 * endpoint quotes nothing at all for the model.
 */
function buildCost(
  pricing: AihubmixModel["pricing"],
  authored: ExistingModel["cost"],
): SyncedFullModel["cost"] {
  if (pricing == null) return authored;
  const input = price(pricing.input);
  const output = price(pricing.output);
  if (input === undefined || output === undefined) return authored;

  return {
    input,
    output,
    cache_read: cacheRead(pricing.cache_read, input),
    cache_write: price(pricing.cache_write),
    // AIHubMix quotes only text and cache rates, so an audio or reasoning price
    // exists on the file and nowhere else. A rewrite would drop it.
    input_audio: authored?.input_audio,
    output_audio: authored?.output_audio,
    reasoning: authored?.reasoning,
    tiers: costTiers(pricing, authored?.tiers) ?? authored?.tiers,
  };
}

function costTiers(
  pricing: NonNullable<AihubmixModel["pricing"]>,
  authored: NonNullable<ExistingModel["cost"]>["tiers"],
) {
  const tiers = (pricing.tiers ?? []).flatMap((tier) => {
    const input = price(tier.input);
    const output = price(tier.output);
    if (input === undefined || output === undefined) return [];
    // Audio rates are per tier too, and the endpoint quotes none of them.
    const priced = authored?.find((entry) => entry.tier.size === tier.tier.size);
    return [
      {
        tier: { type: tier.tier.type ?? "context", size: tier.tier.size },
        input,
        output,
        cache_read: cacheRead(tier.cache_read, input),
        cache_write: price(tier.cache_write),
        input_audio: priced?.input_audio,
        output_audio: priced?.output_audio,
        reasoning: priced?.reasoning,
      },
    ];
  });
  return tiers.length > 0 ? (tiers as NonNullable<SyncedFullModel["cost"]>["tiers"]) : undefined;
}

/**
 * AIHubMix sends 0 for a limit it does not know rather than omitting the field —
 * 104 of 408 models quote `max_output: 0` — so 0 is read as absent. A model that
 * truly emitted no tokens would not be servable.
 */
function tokens(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * Six models and four context tiers repeat the input price in `cache_read`,
 * which is how the endpoint spells "no cache discount" rather than a real rate.
 * Publishing it would understate a cached read by up to 10x. An omitted field
 * already means "no such rate" here, so an echoed one is read the same way.
 */
function cacheRead(value: number | null | undefined, input: number) {
  const parsed = price(value);
  return parsed !== undefined && parsed >= input ? undefined : parsed;
}

function price(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000) / 1_000_000;
}
