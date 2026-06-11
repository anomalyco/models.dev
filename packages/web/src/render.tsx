/** @jsx jsx */
/** @jsxImportSource hono/jsx */

import { generateCatalog } from "models.dev";
import type { Model, ModelMetadata, Provider } from "models.dev";
import { Fragment } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  booleanText,
  capabilitySummary,
  costSummary,
  formatNumber,
  knowledgeText,
  renderModalityIcon,
  renderModalities,
  sortDate,
  sortNumber,
  weightsText,
} from "./shared.js";

const root = path.join(import.meta.dir, "..", "..", "..");
const Catalog = await generateCatalog(root);

export const Models = Catalog.models;
export const Providers = Catalog.providers;

const BaseModelRefs = await loadProviderBaseModelRefs(root);
const ProviderLogoSvgs = new Map<string, string>();
const LabLogoSvgs = new Map<string, string>();

type CatalogModel = ModelMetadata;
type CatalogProvider = Provider;
type CatalogProviderModel = Model;

interface ProviderModelEntry {
  providerId: string;
  provider: CatalogProvider;
  modelId: string;
  model: CatalogProviderModel;
  canonicalModelId?: string;
  canonical?: ModelEntry;
}

interface ModelEntry {
  id: string;
  metadata: CatalogModel;
  labId: string;
  labName: string;
  providers: ProviderModelEntry[];
  minInputCost?: number;
  minOutputCost?: number;
}

interface LabEntry {
  id: string;
  name: string;
  models: ModelEntry[];
  providerCount: number;
  families: string[];
  lastReleased?: string;
  lastUpdated?: string;
}

interface SearchIndexItem {
  type: "model" | "provider" | "lab";
  title: string;
  id: string;
  href: string;
  logo: string;
  tokens: string[];
  lab?: string;
  modelCount?: number;
  providerCount?: number;
  context?: number;
  releaseDate?: string;
  inputCost?: number;
  outputCost?: number;
  npm?: string;
  api?: string;
  updated?: string;
}

const LAB_NAME_OVERRIDES: Record<string, string> = {
  alibaba: "Alibaba",
  meta: "Meta",
  minimax: "MiniMax",
  moonshotai: "Moonshot AI",
  openai: "OpenAI",
  perplexity: "Perplexity",
  stepfun: "StepFun",
  xai: "xAI",
  zhipuai: "Zhipu AI",
};

const ModelEntries = buildModelEntries();
const ProviderModelEntries = buildProviderModelEntries(ModelEntries);
connectProviderEntries(ModelEntries, ProviderModelEntries);
const LabEntries = buildLabEntries(ModelEntries);
const SearchItems = buildSearchItems(
  sortModels([...ModelEntries.values()]),
  Object.entries(Providers).sort(([, a], [, b]) => a.name.localeCompare(b.name)),
  LabEntries,
);

export const RenderedPages = buildPages();
export const Rendered = RenderedPages.get("/")!;

export function normalizeRoute(pathname: string) {
  if (pathname !== "/" && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function getRenderedPage(pathname: string) {
  return RenderedPages.get(normalizeRoute(pathname));
}

async function loadProviderBaseModelRefs(root: string) {
  const refs = new Map<string, string>();
  const providersDirectory = path.join(root, "providers");
  if (!existsSync(providersDirectory)) return refs;

  for await (const modelPath of new Bun.Glob("*/models/**/*.toml").scan({
    cwd: providersDirectory,
    absolute: true,
    followSymlinks: true,
  })) {
    const parts = path.relative(providersDirectory, modelPath).split(path.sep);
    const [providerId, modelsSegment, ...modelParts] = parts;
    if (!providerId || modelsSegment !== "models" || modelParts.length === 0) {
      continue;
    }

    const modelId = modelParts.join("/").slice(0, -5);
    const toml = await import(modelPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default as { base_model?: unknown });

    if (typeof toml.base_model === "string") {
      refs.set(`${providerId}/${modelId}`, toml.base_model);
    }
  }

  return refs;
}

function buildModelEntries() {
  const entries = new Map<string, ModelEntry>();

  for (const [id, metadata] of Object.entries(Models)) {
    const labId = id.split("/")[0]!;
    entries.set(id, {
      id,
      metadata,
      labId,
      labName: labName(labId),
      providers: [],
    });
  }

  return entries;
}

function buildProviderModelEntries(models: Map<string, ModelEntry>) {
  const entries: ProviderModelEntry[] = [];

  for (const [providerId, provider] of Object.entries(Providers)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.status === "alpha") continue;

      const canonicalModelId = resolveCanonicalModelId(
        models,
        providerId,
        modelId,
      );

      entries.push({
        providerId,
        provider,
        modelId,
        model,
        canonicalModelId,
      });
    }
  }

  return entries.sort((a, b) =>
    a.provider.name.localeCompare(b.provider.name) ||
    displayModelName(a).localeCompare(displayModelName(b)),
  );
}

function connectProviderEntries(
  models: Map<string, ModelEntry>,
  providers: ProviderModelEntry[],
) {
  for (const entry of providers) {
    if (!entry.canonicalModelId) continue;

    const canonical = models.get(entry.canonicalModelId);
    if (!canonical) continue;

    entry.canonical = canonical;
    canonical.providers.push(entry);
  }

  for (const model of models.values()) {
    model.providers.sort((a, b) => a.provider.name.localeCompare(b.provider.name));
    model.minInputCost = minDefined(
      model.providers.map((provider) => provider.model.cost?.input),
    );
    model.minOutputCost = minDefined(
      model.providers.map((provider) => provider.model.cost?.output),
    );
  }
}

function buildLabEntries(models: Map<string, ModelEntry>) {
  const labs = new Map<string, ModelEntry[]>();

  for (const model of models.values()) {
    const existing = labs.get(model.labId) ?? [];
    existing.push(model);
    labs.set(model.labId, existing);
  }

  return [...labs.entries()]
    .map(([id, modelEntries]) => {
      const providers = new Set<string>();
      const families = new Set<string>();
      let lastReleased: string | undefined;
      let lastUpdated: string | undefined;

      for (const model of modelEntries) {
        for (const provider of model.providers) providers.add(provider.providerId);
        if (model.metadata.family) families.add(model.metadata.family);
        if (
          model.metadata.release_date &&
          (!lastReleased || model.metadata.release_date > lastReleased)
        ) {
          lastReleased = model.metadata.release_date;
        }
        if (
          model.metadata.last_updated &&
          (!lastUpdated || model.metadata.last_updated > lastUpdated)
        ) {
          lastUpdated = model.metadata.last_updated;
        }
      }

      return {
        id,
        name: labName(id),
        models: sortModels(modelEntries),
        providerCount: providers.size,
        families: [...families].sort(),
        lastReleased,
        lastUpdated,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildSearchItems(
  models: ModelEntry[],
  providers: Array<[string, CatalogProvider]>,
  labs: LabEntry[],
): SearchIndexItem[] {
  const items: SearchIndexItem[] = [];

  for (const model of models) {
    const metadata = model.metadata;
    items.push({
      type: "model",
      title: metadata.name,
      id: model.id,
      href: modelHref(model.id),
      logo: labLogoHref(model.labId),
      lab: model.labName,
      providerCount: model.providers.length,
      context: metadata.limit?.context,
      releaseDate: metadata.release_date,
      inputCost: model.minInputCost,
      outputCost: model.minOutputCost,
      updated: metadata.last_updated,
      tokens: [
        metadata.name,
        model.id,
        model.labName,
        model.labId,
        metadata.family,
        metadata.release_date,
        metadata.last_updated,
        ...model.providers.flatMap((provider) => [
          displayModelName(provider),
          provider.modelId,
          provider.provider.name,
          provider.providerId,
        ]),
        ...(metadata.modalities?.input ?? []),
        ...(metadata.modalities?.output ?? []),
      ].filter((token): token is string => Boolean(token)),
    });
  }

  for (const [providerId, provider] of providers) {
    const providerModels = ProviderModelEntries.filter(
      (entry) => entry.providerId === providerId,
    );
    const providerLastReleased = maxModelDate(providerModels, "release_date");
    const providerLastUpdated = maxModelDate(providerModels, "last_updated");

    items.push({
      type: "provider",
      title: provider.name,
      id: providerId,
      href: providerHref(providerId),
      logo: logoHref(providerId),
      modelCount: providerModels.length,
      npm: provider.npm,
      api: provider.api,
      releaseDate: providerLastReleased,
      updated: providerLastUpdated,
      tokens: [
        provider.name,
        providerId,
        provider.npm,
        provider.api,
        provider.doc,
      ].filter((token): token is string => Boolean(token)),
    });
  }

  for (const lab of labs) {
    items.push({
      type: "lab",
      title: lab.name,
      id: lab.id,
      href: labHref(lab.id),
      logo: labLogoHref(lab.id),
      modelCount: lab.models.length,
      providerCount: lab.providerCount,
      releaseDate: lab.lastReleased,
      updated: lab.lastUpdated,
      tokens: [
        lab.name,
        lab.id,
        lab.lastUpdated,
        ...lab.families,
        ...lab.models.slice(0, 20).map((model) => model.metadata.name),
      ].filter((token): token is string => Boolean(token)),
    });
  }

  return items;
}

function resolveCanonicalModelId(
  models: Map<string, ModelEntry>,
  providerId: string,
  modelId: string,
) {
  const baseModelId = BaseModelRefs.get(`${providerId}/${modelId}`);
  if (baseModelId && models.has(baseModelId)) return baseModelId;
  if (models.has(modelId)) return modelId;

  const providerScopedId = `${providerId}/${modelId}`;
  if (models.has(providerScopedId)) return providerScopedId;
}

function buildPages() {
  const pages = new Map<string, string>();
  const modelList = sortModels([...ModelEntries.values()]);
  const providerList = Object.entries(Providers).sort(([, a], [, b]) =>
    a.name.localeCompare(b.name),
  );

  const addPage = (route: string, body: string) => {
    pages.set(normalizeRoute(route), body);
  };

  const home = renderPage(
    "models",
    <HomePage models={modelList} providers={providerList} labs={LabEntries} />,
  );

  addPage("/", home);
  addPage("/models", home);
  addPage(
    "/providers",
    renderPage("providers", <ProvidersPage providers={providerList} />),
  );
  addPage("/labs", renderPage("labs", <LabsPage labs={LabEntries} />));

  for (const model of modelList) {
    addPage(modelHref(model.id), renderPage("models", <ModelPage model={model} />));
  }

  for (const [providerId, provider] of providerList) {
    const models = ProviderModelEntries.filter(
      (entry) => entry.providerId === providerId,
    );
    addPage(
      providerHref(providerId),
      renderPage(
        "providers",
        <ProviderPage providerId={providerId} provider={provider} models={models} />,
      ),
    );
  }

  for (const lab of LabEntries) {
    addPage(labHref(lab.id), renderPage("labs", <LabPage lab={lab} />));
  }

  return pages;
}

function renderPage(active: "models" | "providers" | "labs", content: unknown) {
  return renderToString(
    <Fragment>
      <Header active={active} />
      <main class="page-scroll">{content}</main>
      <MobileMenu active={active} />
      <SearchDialog items={SearchItems} />
      <HelpDialog />
    </Fragment>,
  );
}

function Header(props: { active: "models" | "providers" | "labs" }) {
  return (
    <header>
      <div class="left">
        <a class="brand" href="/">
          <h1>Models.dev</h1>
        </a>
        <span class="slash"></span>
        <p>An open-source database of AI models</p>
      </div>
      <div class="right">
        <nav class="top-nav" aria-label="Primary">
          <a class={props.active === "models" ? "active" : ""} href="/models">
            Models
          </a>
          <a
            class={props.active === "providers" ? "active" : ""}
            href="/providers"
          >
            Providers
          </a>
          <a class={props.active === "labs" ? "active" : ""} href="/labs">
            Labs
          </a>
        </nav>
        <a
          class="github"
          target="_blank"
          rel="noopener noreferrer"
          href="https://github.com/sst/models.dev"
          aria-label="GitHub"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
          >
            <path
              fill="currentColor"
              d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5c.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34c-.46-1.16-1.11-1.47-1.11-1.47c-.91-.62.07-.6.07-.6c1 .07 1.53 1.03 1.53 1.03c.87 1.52 2.34 1.07 2.91.83c.09-.65.35-1.09.63-1.34c-2.22-.25-4.55-1.11-4.55-4.92c0-1.11.38-2 1.03-2.71c-.1-.25-.45-1.29.1-2.64c0 0 .84-.27 2.75 1.02c.79-.22 1.65-.33 2.5-.33s1.71.11 2.5.33c1.91-1.29 2.75-1.02 2.75-1.02c.55 1.35.2 2.39.1 2.64c.65.71 1.03 1.6 1.03 2.71c0 3.82-2.34 4.66-4.57 4.91c.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2"
            ></path>
          </svg>
        </a>
        <div class="search-container">
          <button
            type="button"
            id="search-trigger"
            class="search-trigger"
            aria-label="Search"
            aria-keyshortcuts="Control+F Meta+F Control+K Meta+K"
            aria-haspopup="dialog"
            aria-controls="search-modal"
          >
            <span class="search-trigger-label">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="11" cy="11" r="8"></circle>
                <path d="m21 21-4.35-4.35"></path>
              </svg>
              <span>Search</span>
            </span>
            <span class="search-shortcut">Ctrl F</span>
          </button>
        </div>
        <button id="help">How to use</button>
        <button
          type="button"
          id="mobile-menu-trigger"
          class="mobile-menu-trigger"
          aria-label="Open menu"
          aria-haspopup="dialog"
          aria-controls="mobile-menu"
          aria-expanded="false"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <line x1="4" y1="6" x2="20" y2="6"></line>
            <line x1="4" y1="12" x2="20" y2="12"></line>
            <line x1="4" y1="18" x2="20" y2="18"></line>
          </svg>
        </button>
      </div>
    </header>
  );
}

function HomePage(props: {
  models: ModelEntry[];
  providers: Array<[string, CatalogProvider]>;
  labs: LabEntry[];
}) {
  return <ModelTable models={props.models} title="Canonical Models" hideHeading />;
}

function ProvidersPage(props: { providers: Array<[string, CatalogProvider]> }) {
  return (
      <TableSection
        title="Providers"
        count={props.providers.length}
        columns={5}
        hideHeading
      >
        <table data-enhanced-table>
          <thead>
            <tr>
              <SortableTh>Provider</SortableTh>
              <SortableTh type="number">Models</SortableTh>
              <SortableTh>Package</SortableTh>
              <SortableTh>API</SortableTh>
              <SortableTh>Docs</SortableTh>
            </tr>
          </thead>
          <tbody>
            {props.providers.map(([providerId, provider]) => {
              const models = ProviderModelEntries.filter(
                (entry) => entry.providerId === providerId,
              );

              return (
                <tr data-search={`${provider.name} ${providerId} ${provider.npm} ${provider.api ?? ""}`}>
                  <td data-sort={provider.name}>
                    <ProviderLink providerId={providerId} provider={provider} />
                  </td>
                  <td data-sort={String(models.length)}>{models.length}</td>
                  <td class="mono">{provider.npm}</td>
                  <td class="mono">
                    {provider.api ? (
                      <CopyValue value={provider.api} copyValue={provider.api} />
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    <a href={provider.doc} target="_blank" rel="noopener noreferrer">
                      Docs
                    </a>
                  </td>
                </tr>
              );
            })}
            <EmptyRow columns={5} />
          </tbody>
        </table>
      </TableSection>
  );
}

function LabsPage(props: { labs: LabEntry[] }) {
  return (
      <TableSection title="Labs" count={props.labs.length} columns={4} hideHeading>
        <table data-enhanced-table>
          <thead>
            <tr>
              <SortableTh>Lab</SortableTh>
              <SortableTh type="number">Models</SortableTh>
              <SortableTh type="number">Providers</SortableTh>
              <SortableTh>Last Updated</SortableTh>
            </tr>
          </thead>
          <tbody>
            {props.labs.map((lab) => (
              <tr data-search={`${lab.name} ${lab.id} ${lab.families.join(" ")}`}>
                <td data-sort={lab.name}>
                  <LabLink labId={lab.id} labName={lab.name} />
                  <span class="subtle mono">{lab.id}</span>
                </td>
                <td data-sort={String(lab.models.length)}>{lab.models.length}</td>
                <td data-sort={String(lab.providerCount)}>{lab.providerCount}</td>
                <td data-sort={sortDate(lab.lastUpdated)}>{lab.lastUpdated ?? "-"}</td>
              </tr>
            ))}
            <EmptyRow columns={4} />
          </tbody>
        </table>
      </TableSection>
  );
}

function ModelPage(props: { model: ModelEntry }) {
  const { model } = props;
  const metadata = model.metadata;

  return (
    <Fragment>
      <DetailHeader
        eyebrow={
          <Fragment>
            <a href="/models">Models</a>
            <span>/</span>
            <a href={labHref(model.labId)}>{model.labName}</a>
          </Fragment>
        }
        title={metadata.name}
        code={model.id}
        copyValue={model.id}
      />
      <Facts
        items={[
          ["Lab", <LabLink labId={model.labId} labName={model.labName} />],
          ["Family", metadata.family ?? "-"],
          ["Providers", model.providers.length],
          ["Context", formatNumber(metadata.limit?.context)],
          ["Output limit", formatNumber(metadata.limit?.output)],
          ["Knowledge", knowledgeText(metadata.knowledge)],
          ["Release", metadata.release_date ?? "-"],
          ["Updated", metadata.last_updated ?? "-"],
          ["Weights", <WeightsValue metadata={metadata} />],
          ["Input", <FactModalities modalities={metadata.modalities?.input} />],
          ["Output types", <FactModalities modalities={metadata.modalities?.output} />],
          [
            "Capabilities",
            capabilitySummary([
              ["tools", metadata.tool_call],
              ["reasoning", metadata.reasoning],
              ["structured", metadata.structured_output],
              ["temperature", metadata.temperature],
            ]),
          ],
        ]}
      />
      <TableSection
        id="providers"
        title="Providers"
        count={model.providers.length}
        columns={10}
      >
        <ProviderModelsTable models={model.providers} mode="model" />
      </TableSection>
    </Fragment>
  );
}

function ProviderPage(props: {
  providerId: string;
  provider: CatalogProvider;
  models: ProviderModelEntry[];
}) {
  return (
    <Fragment>
      <DetailHeader
        eyebrow={<a href="/providers">Providers</a>}
        title={props.provider.name}
        code={props.providerId}
        copyValue={props.providerId}
      />
      <Facts
        items={[
          ["Models", props.models.length],
          ["Package", <span class="mono">{props.provider.npm}</span>],
          ["API", <span class="mono">{props.provider.api ?? "-"}</span>],
          [
            "Docs",
            <a href={props.provider.doc} target="_blank" rel="noopener noreferrer">
              Provider docs
            </a>,
          ],
        ]}
      />
      <TableSection title="Models" count={props.models.length} columns={9}>
        <ProviderModelsTable models={props.models} mode="provider" showLab={false} />
      </TableSection>
    </Fragment>
  );
}

function LabPage(props: { lab: LabEntry }) {
  return (
    <Fragment>
      <DetailHeader
        eyebrow={<a href="/labs">Labs</a>}
        title={props.lab.name}
        code={props.lab.id}
        copyValue={props.lab.id}
      />
      <Facts
        items={[
          ["Models", props.lab.models.length],
          ["Providers", props.lab.providerCount],
          ["Updated", props.lab.lastUpdated ?? "-"],
        ]}
      />
      <ModelTable models={props.lab.models} title="Models" showLab={false} />
    </Fragment>
  );
}

function Overview(props: {
  title: string;
  subtitle: string;
  stats: Array<[string, string | number]>;
}) {
  return (
    <section class="overview">
      <div>
        <h2>{props.title}</h2>
        <p>{props.subtitle}</p>
      </div>
      <dl class="stats-strip">
        {props.stats.map(([label, value]) => (
          <div>
            <dt>{label}</dt>
            <dd>{typeof value === "number" ? formatNumber(value) : value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function DetailHeader(props: {
  eyebrow: unknown;
  title: string;
  code: string;
  copyValue: string;
}) {
  return (
    <section class="detail-header">
      <div class="breadcrumbs">{props.eyebrow}</div>
      <h2>{props.title}</h2>
      <div class="code-line">
        <code>{props.code}</code>
        <CopyButton value={props.copyValue} label={`Copy ${props.code}`} />
      </div>
    </section>
  );
}

function Facts(props: { items: Array<[string, unknown]> }) {
  return (
    <dl class="fact-grid">
      {props.items.map(([label, value]) => (
        <div>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function FactModalities(props: { modalities?: string[] }) {
  if (!props.modalities || props.modalities.length === 0) return <span>-</span>;

  return (
    <div
      class="modalities fact-modalities"
      dangerouslySetInnerHTML={{
        __html: props.modalities.map(renderModalityIcon).join(""),
      }}
    />
  );
}

function ModelTable(props: {
  models: ModelEntry[];
  title: string;
  hideHeading?: boolean;
  showLab?: boolean;
}) {
  const showLab = props.showLab ?? true;
  const columns = showLab ? 14 : 13;

  return (
    <TableSection
      title={props.title}
      count={props.models.length}
      columns={columns}
      hideHeading={props.hideHeading}
    >
      <table data-enhanced-table>
        <thead>
          <tr>
            <SortableTh>Model</SortableTh>
            {showLab && <SortableTh>Lab</SortableTh>}
            <SortableTh type="number">Providers</SortableTh>
            <SortableTh type="number">Context</SortableTh>
            <SortableTh type="number">Output</SortableTh>
            <SortableTh>Input</SortableTh>
            <SortableTh>Reasoning</SortableTh>
            <SortableTh>Tool Call</SortableTh>
            <SortableTh>Structured</SortableTh>
            <SortableTh>Temperature</SortableTh>
            <SortableTh>Weights</SortableTh>
            <SortableTh type="number">Price</SortableTh>
            <SortableTh>Release</SortableTh>
            <SortableTh>Updated</SortableTh>
          </tr>
        </thead>
        <tbody>
          {props.models.map((model) => {
            const metadata = model.metadata;

            return (
              <tr
                data-search={`${metadata.name} ${model.id} ${model.labName} ${metadata.family ?? ""} ${weightsText(metadata.open_weights)} ${booleanText(metadata.reasoning)} ${booleanText(metadata.tool_call)} ${booleanText(metadata.structured_output)} ${booleanText(metadata.temperature)}`}
              >
                <td data-sort={metadata.name}>
                  <a class="primary-link" href={modelHref(model.id)}>
                    {metadata.name}
                  </a>
                  <span class="subtle mono">{model.id}</span>
                </td>
                {showLab && (
                  <td data-sort={model.labName}>
                    <LabLink labId={model.labId} labName={model.labName} />
                  </td>
                )}
                <td data-sort={String(model.providers.length)}>
                  <a href={`${modelHref(model.id)}#providers`}>
                    {model.providers.length}
                  </a>
                </td>
                <td data-sort={sortNumber(metadata.limit?.context)}>
                  {formatNumber(metadata.limit?.context)}
                </td>
                <td data-sort={sortNumber(metadata.limit?.output)}>
                  {formatNumber(metadata.limit?.output)}
                </td>
                <td
                  data-sort={[
                    ...(metadata.modalities?.input ?? []),
                    ...(metadata.modalities?.output ?? []),
                  ].join(" ")}
                  dangerouslySetInnerHTML={{
                    __html: renderModalities(metadata.modalities?.input),
                  }}
                />
                <td data-sort={booleanText(metadata.reasoning)}>
                  {booleanText(metadata.reasoning)}
                </td>
                <td data-sort={booleanText(metadata.tool_call)}>
                  {booleanText(metadata.tool_call)}
                </td>
                <td data-sort={booleanText(metadata.structured_output)}>
                  {booleanText(metadata.structured_output)}
                </td>
                <td data-sort={booleanText(metadata.temperature)}>
                  {booleanText(metadata.temperature)}
                </td>
                <td data-sort={weightsText(metadata.open_weights)}>
                  <WeightsValue metadata={metadata} />
                </td>
                <td data-sort={sortNumber(model.minInputCost)}>
                  {costSummary(model.minInputCost, model.minOutputCost)}
                </td>
                <td data-sort={sortDate(metadata.release_date)}>
                  {metadata.release_date ?? "-"}
                </td>
                <td data-sort={sortDate(metadata.last_updated)}>
                  {metadata.last_updated ?? "-"}
                </td>
              </tr>
            );
          })}
          <EmptyRow columns={columns} />
        </tbody>
      </table>
    </TableSection>
  );
}

function ProviderModelsTable(props: {
  models: ProviderModelEntry[];
  mode: "model" | "provider";
  showLab?: boolean;
}) {
  const showLab = props.showLab ?? props.mode === "model";
  const columns = showLab ? 10 : 9;

  return (
    <table data-enhanced-table>
      <thead>
        <tr>
          {props.mode === "model" ? (
            <SortableTh>Provider</SortableTh>
          ) : (
            <SortableTh>Model</SortableTh>
          )}
          {showLab && <SortableTh>Lab</SortableTh>}
          <SortableTh>Model ID</SortableTh>
          <SortableTh type="number">Context</SortableTh>
          <SortableTh type="number">Output</SortableTh>
          <SortableTh type="number">Price</SortableTh>
          <SortableTh>Reasoning</SortableTh>
          <SortableTh>Tool Call</SortableTh>
          <SortableTh>Structured</SortableTh>
          <SortableTh>Temperature</SortableTh>
        </tr>
      </thead>
      <tbody>
        {props.models.map((entry) => {
          const canonical = entry.canonical;
          const displayName = displayModelName(entry);
          const lab = canonical
            ? { id: canonical.labId, name: canonical.labName }
            : undefined;

          return (
            <tr
              data-search={`${displayName} ${entry.modelId} ${entry.provider.name} ${entry.providerId} ${lab?.name ?? ""} ${entry.model.family ?? ""} ${booleanText(entry.model.reasoning)} ${booleanText(entry.model.tool_call)} ${booleanText(entry.model.structured_output)} ${booleanText(entry.model.temperature)}`}
            >
              {props.mode === "model" ? (
                <td data-sort={entry.provider.name}>
                  <ProviderLink providerId={entry.providerId} provider={entry.provider} />
                </td>
              ) : (
                <td data-sort={displayName}>
                  {canonical ? (
                    <a class="primary-link" href={modelHref(canonical.id)}>
                      {displayName}
                    </a>
                  ) : (
                    <span>{displayName}</span>
                  )}
                  {canonical ? (
                    <span class="subtle mono">{canonical.id}</span>
                  ) : (
                    <span class="subtle">Provider-specific</span>
                  )}
                </td>
              )}
              {showLab && (
                <td data-sort={lab?.name ?? ""}>
                  {lab ? <LabLink labId={lab.id} labName={lab.name} /> : "-"}
                </td>
              )}
              <td class="mono" data-sort={entry.modelId}>
                <CopyValue
                  value={entry.modelId}
                  copyValue={`${entry.providerId}/${entry.modelId}`}
                />
              </td>
              <td data-sort={sortNumber(entry.model.limit.context)}>
                {formatNumber(entry.model.limit.context)}
              </td>
              <td data-sort={sortNumber(entry.model.limit.output)}>
                {formatNumber(entry.model.limit.output)}
              </td>
              <td data-sort={sortNumber(entry.model.cost?.input)}>
                {costSummary(entry.model.cost?.input, entry.model.cost?.output)}
              </td>
              <td data-sort={booleanText(entry.model.reasoning)}>
                {booleanText(entry.model.reasoning)}
              </td>
              <td data-sort={booleanText(entry.model.tool_call)}>
                {booleanText(entry.model.tool_call)}
              </td>
              <td data-sort={booleanText(entry.model.structured_output)}>
                {booleanText(entry.model.structured_output)}
              </td>
              <td data-sort={booleanText(entry.model.temperature)}>
                {booleanText(entry.model.temperature)}
              </td>
            </tr>
          );
        })}
        <EmptyRow columns={columns} />
      </tbody>
    </table>
  );
}

function CopyValue(props: { value: string; copyValue: string }) {
  return (
    <span class="copy-cell">
      <span class="copy-source">{props.value}</span>
      <CopyButton value={props.copyValue} label={`Copy ${props.copyValue}`} />
    </span>
  );
}

function WeightsValue(props: { metadata: CatalogModel }) {
  const label = weightsText(props.metadata.open_weights);
  const href = weightHref(props.metadata);

  if (label === "Open" && href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }

  return <span>{label}</span>;
}

function weightHref(metadata: CatalogModel) {
  return (
    metadata.weights?.[0]?.url ??
    metadata.links?.find((link) => link.type === "weights")?.url
  );
}

function TableSection(props: {
  id?: string;
  title: string;
  count: number;
  columns: number;
  hideHeading?: boolean;
  children: unknown;
}) {
  return (
    <section class="table-section" id={props.id}>
      {!props.hideHeading && (
        <div class="section-heading">
          <h3>{props.title}</h3>
          <span>{formatNumber(props.count)}</span>
        </div>
      )}
      <div class="table-wrap">{props.children}</div>
      <p class="empty-message">No rows match the current search.</p>
    </section>
  );
}

function SortableTh(props: { type?: "text" | "number"; children: unknown }) {
  return (
    <th class="sortable" data-type={props.type ?? "text"} scope="col">
      {props.children} <span class="sort-indicator"></span>
    </th>
  );
}

function EmptyRow(props: { columns: number }) {
  return (
    <tr class="empty-row">
      <td colspan={props.columns}>No rows match the current search.</td>
    </tr>
  );
}

function ProviderLink(props: {
  providerId: string;
  provider: Pick<CatalogProvider, "name">;
}) {
  return (
    <a class="provider-link" href={providerHref(props.providerId)}>
      <span
        class="provider-logo"
        dangerouslySetInnerHTML={{ __html: providerLogoSvg(props.providerId) }}
      />
      <span>{props.provider.name}</span>
    </a>
  );
}

function LabLink(props: { labId: string; labName: string }) {
  return (
    <a class="lab-link" href={labHref(props.labId)}>
      <span
        class="lab-logo"
        dangerouslySetInnerHTML={{ __html: labLogoSvg(props.labId) }}
      />
      <span>{props.labName}</span>
    </a>
  );
}

function CopyButton(props: { value: string; label: string }) {
  return (
    <button
      type="button"
      class="copy-button"
      data-copy-value={props.value}
      aria-label={props.label}
      title={props.label}
    >
      <svg
        class="copy-icon"
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
        <path d="m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
      </svg>
      <svg
        class="check-icon"
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="display: none;"
      >
        <polyline points="20,6 9,17 4,12"></polyline>
      </svg>
    </button>
  );
}

function MobileMenu(props: { active: "models" | "providers" | "labs" }) {
  return (
    <dialog
      id="mobile-menu"
      class="mobile-menu"
      aria-labelledby="mobile-menu-title"
    >
      <div class="header">
        <h2 id="mobile-menu-title">Menu</h2>
        <button type="button" id="mobile-menu-close" aria-label="Close menu">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <line
              x1="18"
              y1="6"
              x2="6"
              y2="18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
            <line
              x1="6"
              y1="6"
              x2="18"
              y2="18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
      <nav class="mobile-menu-list" aria-label="Mobile">
        <a class={props.active === "models" ? "active" : ""} href="/models">
          Models
        </a>
        <a
          class={props.active === "providers" ? "active" : ""}
          href="/providers"
        >
          Providers
        </a>
        <a class={props.active === "labs" ? "active" : ""} href="/labs">
          Labs
        </a>
        <button type="button" id="mobile-search-trigger">
          Search
        </button>
        <a
          target="_blank"
          rel="noopener noreferrer"
          href="https://github.com/sst/models.dev"
        >
          GitHub
        </a>
        <button type="button" id="mobile-help-trigger">
          How to use
        </button>
      </nav>
    </dialog>
  );
}

function SearchDialog(props: { items: SearchIndexItem[] }) {
  const json = JSON.stringify(props.items).replace(/</g, "\\u003c");

  return (
    <dialog
      id="search-modal"
      class="search-modal"
      aria-labelledby="search-modal-title"
    >
      <div class="search-field">
        <svg
          class="search-field-icon"
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.35-4.35"></path>
        </svg>
        <input
          id="search-input"
          type="text"
          placeholder="Search models, providers, and labs"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-expanded="true"
          aria-controls="search-results"
          aria-autocomplete="list"
        />
        <span class="search-escape">Esc</span>
      </div>
      <h2 id="search-modal-title" class="sr-only">
        Search
      </h2>
      <div id="search-count" class="search-count"></div>
      <div id="search-results" class="search-results" role="listbox"></div>
      <p id="search-empty" class="search-empty">No matching results.</p>
      <script
        id="search-index"
        type="application/json"
        dangerouslySetInnerHTML={{ __html: json }}
      />
    </dialog>
  );
}

function HelpDialog() {
  return (
    <dialog id="modal">
      <div class="header">
        <h2>How to use</h2>
        <button id="close" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <line
              x1="18"
              y1="6"
              x2="6"
              y2="18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
            <line
              x1="6"
              y1="6"
              x2="18"
              y2="18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
      <div class="body">
        <p>
          <a href="/">Models.dev</a> is a comprehensive open-source database of
          AI model specifications, pricing, and features.
        </p>
        <p>
          The homepage starts with provider-agnostic model metadata. Model pages
          list the providers serving that model; provider pages list every model
          available from that provider; lab pages group canonical models by
          author.
        </p>
        <h2>API</h2>
        <p>
          You can access provider data, provider-agnostic model metadata, or the
          combined catalog through JSON endpoints.
        </p>
        <div class="code-block">
          <code>
            curl <a href="/api.json">https://models.dev/api.json</a>
          </code>
        </div>
        <div class="code-block">
          <code>
            curl <a href="/models.json">https://models.dev/models.json</a>
          </code>
        </div>
        <div class="code-block">
          <code>
            curl <a href="/catalog.json">https://models.dev/catalog.json</a>
          </code>
        </div>
        <h2>Logos</h2>
        <p>
          Provider logos are available at <code>/logos/{`{provider}`}.svg</code>{" "}
          where <code>{`{provider}`}</code> is the provider ID. Lab logos are
          available at <code>/logos/labs/{`{lab}`}.svg</code>. Model logos are
          available at <code>/logos/models/{`{model-id}`}.svg</code> and return
          the logo for the lab that created the model.
        </p>
        <div class="code-block">
          <code>
            curl{" "}
            <a href="/logos/anthropic.svg">
              https://models.dev/logos/anthropic.svg
            </a>
          </code>
        </div>
        <div class="code-block">
          <code>
            curl{" "}
            <a href="/logos/labs/anthropic.svg">
              https://models.dev/logos/labs/anthropic.svg
            </a>
          </code>
        </div>
        <div class="code-block">
          <code>
            curl{" "}
            <a href="/logos/models/gpt-5.svg">
              https://models.dev/logos/models/gpt-5.svg
            </a>
          </code>
        </div>
        <h2>Contribute</h2>
        <p>
          The data is stored in the{" "}
          <a
            href="https://github.com/sst/models.dev"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub repo
          </a>{" "}
          as TOML files organized by provider and canonical model.
        </p>
      </div>
      <div class="footer">
        <a
          href="https://github.com/sst/models.dev"
          target="_blank"
          rel="noopener noreferrer"
        >
          Edit on GitHub
        </a>
        <a href="https://opencode.ai" target="_blank" rel="noopener noreferrer">
          Created by OpenCode
        </a>
      </div>
    </dialog>
  );
}

function sortModels(models: ModelEntry[]) {
  return [...models].sort((a, b) => {
    const updated = (b.metadata.last_updated ?? "").localeCompare(
      a.metadata.last_updated ?? "",
    );
    if (updated !== 0) return updated;

    const released = (b.metadata.release_date ?? "").localeCompare(
      a.metadata.release_date ?? "",
    );
    if (released !== 0) return released;

    return a.metadata.name.localeCompare(b.metadata.name);
  });
}

function displayModelName(entry: ProviderModelEntry) {
  return entry.canonical?.metadata.name ?? entry.model.name;
}

function maxModelDate(
  entries: ProviderModelEntry[],
  field: "last_updated" | "release_date",
) {
  let result: string | undefined;
  for (const entry of entries) {
    const value = entry.canonical?.metadata[field];
    if (value && (result === undefined || value > result)) result = value;
  }
  return result;
}

function countLinkedProviderEntries() {
  return ProviderModelEntries.filter(
    (entry) => entry.canonicalModelId !== undefined,
  ).length;
}

function minDefined(values: Array<number | undefined>) {
  let result: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (result === undefined || value < result) result = value;
  }
  return result;
}

function labName(labId: string) {
  const override = LAB_NAME_OVERRIDES[labId];
  if (override) return override;

  const providerName = Providers[labId]?.name;
  if (providerName) return providerName;

  return labId
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function encodedPath(id: string) {
  return id.split("/").map(encodeURIComponent).join("/");
}

function modelHref(id: string) {
  return `/models/${encodedPath(id)}`;
}

function providerHref(id: string) {
  return `/providers/${encodeURIComponent(id)}`;
}

function labHref(id: string) {
  return `/labs/${encodeURIComponent(id)}`;
}

function logoHref(providerId: string) {
  return `/logos/${encodeURIComponent(providerId)}.svg`;
}

function labLogoHref(labId: string) {
  return `/logos/labs/${encodeURIComponent(labId)}.svg`;
}

function providerLogoSvg(providerId: string) {
  const cached = ProviderLogoSvgs.get(providerId);
  if (cached) return cached;

  const logoPath = path.join(root, "providers", providerId, "logo.svg");
  const defaultLogoPath = path.join(root, "providers", "logo.svg");
  const rawSvg = readFileSync(
    existsSync(logoPath) ? logoPath : defaultLogoPath,
    "utf8",
  );
  const svg = rawSvg
    .replace(/<svg\b([^>]*)>/i, (_, attributes: string) => {
      const cleaned = attributes.replace(/\s(width|height)="[^"]*"/gi, "");
      return `<svg${cleaned} aria-hidden="true" focusable="false">`;
    })
    .replace(/\sfill="(?!none|currentColor)[^"]*"/gi, ' fill="currentColor"')
    .replace(/\sstroke="(?!none|currentColor)[^"]*"/gi, ' stroke="currentColor"');

  ProviderLogoSvgs.set(providerId, svg);
  return svg;
}

function labLogoSvg(labId: string) {
  const cached = LabLogoSvgs.get(labId);
  if (cached) return cached;

  const logoPath = path.join(root, "labs", labId, "logo.svg");
  const defaultLogoPath = path.join(root, "providers", "logo.svg");
  const rawSvg = readFileSync(
    existsSync(logoPath) ? logoPath : defaultLogoPath,
    "utf8",
  );
  const svg = rawSvg
    .replace(/<svg\b([^>]*)>/i, (_, attributes: string) => {
      const cleaned = attributes.replace(/\s(width|height)="[^"]*"/gi, "");
      return `<svg${cleaned} aria-hidden="true" focusable="false">`;
    })
    .replace(/\sfill="(?!none)[^"]*"/gi, ' fill="currentColor"')
    .replace(/\sstroke="(?!none)[^"]*"/gi, ' stroke="currentColor"');

  LabLogoSvgs.set(labId, svg);
  return svg;
}
