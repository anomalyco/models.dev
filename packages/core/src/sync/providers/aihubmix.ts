import path from "node:path";

import { z } from "zod";

import { describeModel } from "../../describe.js";
import { REASONING_EFFORT_VALUES } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata, normalizeModelSlug } from "./openrouter.js";

const API_ENDPOINT = "https://aihubmix.com/api/v1/models?type=llm";
/**
 * The gateway's second published interface: the canon projection, which is the
 * set of models AIHubMix has actually verified rather than merely routes. The
 * model list answers "can you reach it here", canon answers "is what we say
 * about it checked", and a catalog entry needs the second.
 */
const CANON_ENDPOINT = "https://aihubmix.com/model-data/index.json";

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

// The two levels AIHubMix spells its own way, mapped onto the catalog's. This is
// the one piece of the gateway's own vocabulary left here, and it covers 4 values
// in the whole 409-route list (`no_think` 3, `instant` 1); both are reported
// upstream, and the table goes when the endpoint spells them the catalog's way.
/**
 * Route variants the catalog does not carry. Every one of these affixes names a
 * way into a model that is already listed under its own ID, not a model of its
 * own: `-free` is the free-tier route (53 of them; 40 carry `variant_of` pointing
 * at the paid route), `-reasoning`/`-non-reasoning` are the pre-split Grok routes
 * that reach one model with thinking forced on or off — a steering choice the
 * catalog states as `reasoning_options`, not as two entries — and `coding-` is
 * the discounted coding-agent route (32 of them; 19 once the `-free` overlap is
 * removed, of which 11 say so through `variant_of` and 8 are the same shape with
 * the pointer not yet backfilled). Filtering here rather than at translate keeps
 * them out of the missing-model issues too.
 *
 * A route variant reprices the model, which is exactly what `-free` does too, so
 * repricing is not what makes an entry its own model. Every `coding-` route's
 * plain sibling is listed and syncs a file of its own, bar `minimax-m2.7-highspeed`
 * — reached through `cc-`/`mm-` routes instead — and the two `mimo-v2-*` entries
 * the endpoint under-describes today, so nothing loses its only card here.
 *
 * `-reasoning` is the one affix the gateway does not own outright: a lab can end
 * a model's real name with it, and `AiHubmix-Phi-4-mini-reasoning` is Microsoft's
 * — cataloged here as `providers/azure/models/phi-4-mini-reasoning.toml`. What
 * makes the Grok routes a steering pair is that they come as a pair, so
 * `isRouteVariant` asks the catalog for the `-non-reasoning` half rather than
 * trusting the word. That reads the same list every other rule here reads, so it
 * needs no allowlist to keep current.
 */
const ROUTE_VARIANT_ID = /^coding-|-(?:free|non-reasoning)$/i;
const STEERING_ON = /-reasoning$/i;

function isRouteVariant(id: string, catalog: RelayCatalog) {
  if (ROUTE_VARIANT_ID.test(id)) return true;
  return STEERING_ON.test(id) && catalog.has(id.toLowerCase().replace(STEERING_ON, "-non-reasoning"));
}

const EFFORT_ALIASES: Record<string, string> = { no_think: "none", instant: "minimal" };
// Taken from the schema rather than restated, so a level added to the catalog is
// accepted here without a second edit. `null` is deliberately not accepted: the
// schema allows it for an authored file that states "no level applies", but a
// relay reaching that through the endpoint's list would be the endpoint sending
// nothing where it means nothing, which the filter below already drops.
const EFFORT_VALUES = new Set<string>(REASONING_EFFORT_VALUES);

/**
 * The full `ReasoningEffort` enum of the OpenAI chat protocol, which the host
 * echoes verbatim for a route it holds no per-model levels for. It is the
 * protocol's accepted set, not the model's own ladder, and the routes that
 * receive it say so themselves: `grok-4-fast-non-reasoning` — a route whose name
 * states it does not reason — carries all seven with `default = none`, as do the
 * pinned `gpt-5.2-high` / `gpt-5.2-low` variants and the image route
 * `gemini-3-pro-image`. 18 of 409 routes are served it, among them every Qwen
 * 3.5/3.6/3.7 entry while Qwen 3.8 carries a real `low|medium|xhigh`; live
 * probing of `qwen3.7-flash` and `deepseek-v4-pro-0813` finds the six non-`none`
 * levels reproducibly non-monotonic (`minimal` above `high`, `xhigh` lowest),
 * so nothing but the off state is observable across them.
 *
 * `default` stays route-specific throughout, so the host does know the route's
 * setting and is stating the protocol in `values` rather than the model. A file
 * that copied it would publish a ladder no caller can steer with.
 */
const PROTOCOL_EFFORT_SET = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function statesProtocolNotModel(values: string[]) {
  return (
    values.length === PROTOCOL_EFFORT_SET.size && values.every((value) => PROTOCOL_EFFORT_SET.has(value))
  );
}

/**
 * Only the IDs are read. The projection carries the resolved parameter domains
 * too, but reading those here would make the adapter answer to two sources for
 * the same field; the model list stays the one voice on what a route is, and
 * canon is asked one question — is this model covered.
 */
const CanonIndex = z
  .object({ models: z.array(z.object({ id: z.string() }).passthrough()) })
  .passthrough();

type LabMetadataIDs = Map<string, string>;
/** Every listed relay by lowercased ID, so `variant_of` can be followed. */
type RelayCatalog = Map<string, AihubmixModel>;

let labMetadataIDs: LabMetadataIDs | undefined;
let relayCatalog: RelayCatalog | undefined;
let canonIDs: Set<string> | undefined;

/**
 * Routes canon covers. IDs are compared exactly: both registries are generated
 * from the same gateway catalog, and all 292 of today's overlaps match without
 * case folding, so folding would only invent matches the gateway does not make.
 */
export function canonCoveredModels<T extends { model_id: string }>(
  models: T[],
  covered: Set<string> | undefined,
) {
  // Left unset only when `parseModels` is driven directly, as the tests do:
  // `fetchModels` throws rather than returning with canon unfetched, so a real
  // sync never reaches the filter without it.
  if (covered === undefined) return models;
  return models.filter((model) => covered.has(model.model_id));
}

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

// A control on this gateway has no single wire path: the same off state, the
// same effort, the same budget are each reachable from whichever SDK dialect the
// caller speaks, and the gateway maps whatever it receives onto the vendor's real
// field. So a control names one path per protocol rather than picking a winner,
// following what `providers/aihubmix/provider.toml` records for each surface.
const TOGGLE_PATHS =
  "# $.enable_thinking = true|false on the OpenAI-compatible /v1/chat/completions path (verified live 2026-09-11);\n" +
  '# $.thinking.type = "enabled"|"disabled"|"adaptive" on /v1/messages; $.generationConfig.thinkingConfig on the Gemini path.\n';
const EFFORT_PATHS =
  "# $.reasoning_effort on /v1/chat/completions (alias $.reasoning.effort, which is also the Responses field);\n" +
  "# $.output_config.effort on /v1/messages, subject to model support.\n";
const BUDGET_PATHS =
  "# integer $.reasoning.max_tokens on /v1/chat/completions; $.thinking.budget_tokens >= 1024 on /v1/messages;\n" +
  "# integer $.generationConfig.thinkingConfig.thinkingBudget on the Gemini path (-1 dynamic, 0 off where supported);\n" +
  "# the Responses path carries effort but has no reasoning-token budget field.\n";
// Every path line above is this adapter's own restatement of the block, so a
// hand-written copy of one is dropped rather than kept beside it.
const ADAPTER_PATHS = TOGGLE_PATHS + EFFORT_PATHS + BUDGET_PATHS;
// Cited on its own line, because a human wrote this exact line by hand in
// `gemini-3.7-flash.toml` — it is a source for the whole gateway, not a claim
// about one model's options, and so it is carried through as a note rather than
// being owned by the block. The path lines above are only ever this adapter's own.
const DIALECT_SOURCE = "# https://docs.aihubmix.com/cn/api/unified-inference\n";
// Where the catalog spells the off state as `effort = none`, the other dialects
// still reach it, and the folded toggle is the only place that was recorded.
const FOLDED_OPENING = "# Off is effort=none; graded levels — no toggle. The same off elsewhere:\n";

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
    // Thrown rather than skipped, because a canon request that fails is not a
    // catalog with nothing in it — carrying on without the gate would publish
    // exactly the unverified routes it exists to hold back, and the sync writes
    // nothing on a throw, so a bad fetch costs a rerun instead of a bad write.
    const canon = await fetch(process.env.AIHUBMIX_CANON_URL ?? CANON_ENDPOINT);
    if (!canon.ok) {
      throw new Error(`AIHubMix canon request failed: ${canon.status} ${canon.statusText}`);
    }
    canonIDs = new Set(CanonIndex.parse(await canon.json()).models.map((model) => model.id));
    return response.json();
  },
  parseModels(raw) {
    const data = AihubmixResponse.parse(raw).data;
    // `cc-minimax-m2` and `cc-MiniMax-M2` are the same route under two spellings
    // and would claim filenames that differ only in case. Keep the last entry
    // whole rather than mixing two records.
    relayCatalog = new Map(data.map((model) => [model.model_id.toLowerCase(), model]));
    // Dropped here rather than in translateModel, so a route variant is absent
    // from the sync altogether: no file, and no skip notice or missing-model
    // issue asking a human to supply metadata the catalog does not want. The
    // relay catalog above keeps every entry, because a variant is still a valid
    // `variant_of` target for a route that does belong in the catalog.
    // Bound locally because the pairing rule reads the catalog from inside a
    // closure, where the module-level binding is no longer narrowed.
    const catalog = relayCatalog;
    const listed = [...catalog.values()].filter(
      (model) => !isRouteVariant(model.model_id, catalog),
    );
    // Dropped silently for the same reason: an uncovered route is not a gap in
    // this repo that a contributor here can close — the work is to verify the
    // model in canon — so it raises nothing for a maintainer to act on. Of the
    // 117 routes canon does not cover, the ones that would otherwise reach a
    // file are the long tail the endpoint describes worst: `Qwen/QwQ-32B`,
    // `codex-mini-latest` and the `qwen3-*` family all report no `reasoning`
    // flag despite having no non-thinking mode.
    return canonCoveredModels(listed, canonIDs);
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
    status: resolveStatus(model.retire_stage, existing?.status),
    modalities: { input, output },
    limit,
    cost: buildCost(model.pricing, existing?.cost),
  };

  if (base !== undefined) {
    assertReasoningOptions(model.model_id, reasoning ?? lab?.reasoning, shared.reasoning_options);
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
  assertReasoningOptions(model.model_id, standaloneReasoning, shared.reasoning_options);
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
    // A level list is only worth recording where it is the model's; the protocol's
    // own enum tells a caller nothing, so it is dropped and the toggle and budget
    // the same route publishes are left to carry the reasoning surface.
    if (statesProtocolNotModel(values)) return [];
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
  // The wire-path lines are this adapter's own restatement of the block, so they
  // go whether or not a block replaces them. Keeping them when nothing is
  // derived is what left a route advertising a toggle it no longer has: the block
  // vanished, its tail survived as a "note", and no later sync could tell the
  // difference — the file never self-corrected.
  //
  // The source line is kept unless a derived block restates it, which is only to
  // avoid stating it twice. It is a citation for the gateway rather than a claim
  // about this model, and a human wrote this exact line in `gemini-3.7-flash`.
  const authored = new Set(
    (derived === undefined ? ADAPTER_PATHS : ADAPTER_PATHS + DIALECT_SOURCE)
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

/**
 * One block per control the file actually authors, so a wire path is documented
 * exactly while its option row is on the file and disappears with it. Deriving
 * every type — rather than the toggle alone — is what makes `AUTHORED_OPENING`
 * honest: an opening is only disposable because the block restates it, and an
 * effort or budget opening used to be stripped with nothing put back, leaving the
 * option row on the file and its field name nowhere.
 */
function reasoningHeader(model: AihubmixModel, built: SyncedModel) {
  const options = built.reasoning_options;
  if (options === undefined) return undefined;
  const effort = options.find((option) => option.type === "effort");
  const blocks: string[] = [];
  if (options.some((option) => option.type === "toggle")) {
    blocks.push("# Toggle:\n" + TOGGLE_PATHS);
  } else if (
    // Only say where the off state moved to on a file that actually spells it out.
    effort?.values.includes("none") &&
    (model.reasoning_options ?? []).some((option) => option.type === "toggle")
  ) {
    blocks.push(FOLDED_OPENING + TOGGLE_PATHS);
  }
  if (effort !== undefined) {
    // The levels come from the row they document, so a file never states a set
    // the row does not carry — the drift the hand-written openings had.
    const levels = effort.values.length > 0 ? ` ${effort.values.join("|")}` : "";
    blocks.push(`# Effort:${levels}\n` + EFFORT_PATHS);
  }
  if (options.some((option) => option.type === "budget_tokens")) {
    blocks.push("# Budget:\n" + BUDGET_PATHS);
  }
  return blocks.length === 0 ? undefined : blocks.join("") + DIALECT_SOURCE;
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
 * A model that reasons but states no controls is a gap in the source, not a model
 * without controls. Left alone, the runner reads a missing `reasoning_options` on
 * a reasoner as "no caller control" and stamps `[]` — which AGENTS.md forbids
 * using for uncertainty — and `ModelMetadata` has no `reasoning_options` field, so
 * the lab entry cannot supply them either. Skip the route and let it surface as a
 * missing model, the same as the Cloudflare adapter does. Called only on the two
 * paths that actually write, so a route skipped for some other gap still reports
 * that gap.
 */
function assertReasoningOptions(
  id: string,
  reasoning: boolean | undefined,
  options: SyncedFullModel["reasoning_options"],
) {
  if (reasoning !== true || options !== undefined) return;
  throw new MissingReasoningOptionsError(
    id,
    "AIHubMix reports the model as reasoning but publishes no reasoning_options, and neither the file nor the lab entry states them",
  );
}

/**
 * `retire_stage` rides on every route (407 active, 2 deprecated in the current
 * listing), so it is authoritative about retirement — and only about retirement.
 * A route that comes back has to lose the mark or the file carries `deprecated`
 * forever; `alpha` and `beta` survive untouched because the endpoint says nothing
 * about either.
 */
function resolveStatus(
  stage: string | null | undefined,
  existing: ExistingModel["status"],
): ExistingModel["status"] {
  if (stage === "deprecated") return "deprecated";
  if (stage == null || stage.trim().length === 0) return existing;
  return existing === "deprecated" ? undefined : existing;
}

/**
 * The lab entry a relay factors onto, read for what the endpoint can under-report:
 * modalities it omits and windows it restates in decimal. Returns nothing when the
 * relay is standalone. `reasoning` is read as a flag only: `ModelMetadata` has no
 * `reasoning_options` field, so a lab entry can say that a model reasons but never
 * how it is steered — only a provider file ever states that.
 */
function labMetadata(base: string | undefined) {
  if (base === undefined) return undefined;
  return modelMetadata(base) as {
    reasoning?: boolean;
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
