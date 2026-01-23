import { sortTable } from "../../index.js";
import "./command-palette-element.js";

import type { CommandPaletteAction } from "./command-palette-element.js";

type CommandPaletteActionLocal = CommandPaletteAction;

interface ModelData {
  id: string;
  title: string;
  section: string;
  iconUrl: string;
  keywords: string;
  providerId: string;
}

let cachedModelData: ModelData[] | null = null;

function extractModelsFromTable(): ModelData[] {
  // Return cached if available
  if (cachedModelData) {
    return cachedModelData;
  }

  const modelData: ModelData[] = [];
  const rows = document.querySelectorAll("table tbody tr");

  rows.forEach((row) => {
    const cells = row.querySelectorAll("td");
    if (cells.length >= 5) {
      const provider = cells[0].textContent?.trim() || "";
      const name = cells[1].textContent?.trim() || "";
      const family = cells[2].textContent?.trim() || "";
      const providerId = cells[3].textContent?.trim() || "";
      const modelId =
        cells[4].querySelector(".model-id-text")?.textContent?.trim() || "";

      const providerSlug = encodeURIComponent(providerId);
      modelData.push({
        id: `model-${modelId}-${providerId}`,
        title: name,
        section: provider,
        iconUrl: `/logos/${providerSlug}.svg`,
        keywords:
          `${name} ${provider} ${family} ${providerId} ${modelId}`.toLowerCase(),
        providerId: providerId,
      });
    }
  });

  // Cache the results
  cachedModelData = modelData;
  return modelData;
}

function buildProviderActions(): CommandPaletteActionLocal[] {
  const modelData = extractModelsFromTable();

  // Group models by provider
  const providerMap = new Map<
    string,
    { name: string; iconUrl: string; models: ModelData[] }
  >();

  for (const model of modelData) {
    if (!providerMap.has(model.providerId)) {
      providerMap.set(model.providerId, {
        name: model.section,
        iconUrl: model.iconUrl,
        models: [],
      });
    }
    providerMap.get(model.providerId)!.models.push(model);
  }

  // Create provider actions with model children
  const providerActions: CommandPaletteActionLocal[] = [];

  for (const [providerId, providerInfo] of providerMap.entries()) {
    const providerAction: CommandPaletteActionLocal = {
      id: `provider-${providerId}`,
      title: providerInfo.name,
      iconUrl: providerInfo.iconUrl,
      parent: "browse-providers",
      keywords: `${providerInfo.name} ${providerId}`.toLowerCase(),
      children: providerInfo.models.map((model) => ({
        id: model.id,
        title: model.title,
        iconUrl: model.iconUrl,
        keywords: model.keywords,
        parent: `provider-${providerId}`,
        handler: () => {
          const searchInput = document.getElementById(
            "search",
          ) as HTMLInputElement;
          if (searchInput) {
            searchInput.value = model.title;
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
          }
        },
      })),
    };

    providerActions.push(providerAction);
  }

  return providerActions;
}

function buildAllModelsActions(): CommandPaletteActionLocal[] {
  const modelData = extractModelsFromTable();

  return modelData.map((model) => ({
    id: model.id,
    title: model.title,
    section: model.section,
    iconUrl: model.iconUrl,
    keywords: model.keywords,
    parent: "browse-models",
    handler: () => {
      const searchInput = document.getElementById("search") as HTMLInputElement;
      if (searchInput) {
        searchInput.value = model.title;
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
  }));
}

function buildSortActions(): CommandPaletteActionLocal[] {
  const sortActions: CommandPaletteActionLocal[] = [];
  const headers = document.querySelectorAll("th.sortable");

  if (headers.length === 0) {
    return sortActions;
  }

  const columnIds: string[] = [];

  headers.forEach((header, index) => {
    // Extract column title from header
    const headerText = header.textContent?.trim() || "";
    const columnTitle = headerText.replace(/↑|↓/g, "").trim();

    // Generate column ID from title
    const columnId = columnTitle
      .split(/\s+/)
      .slice(0, 2)
      .join("-")
      .toLowerCase();
    columnIds.push(columnId);

    // Create parent column action
    const columnAction: CommandPaletteActionLocal = {
      id: columnId,
      title: columnTitle,
      parent: "sort",
      icon: "sort",
      children: [`${columnId}-asc`, `${columnId}-desc`],
      handler: () => {
        const palette = document.querySelector("command-palette") as any;
        if (palette) {
          palette.open({ parent: columnId });
          return { keepOpen: true };
        }
      },
    };

    // Create ascending action
    const ascAction: CommandPaletteActionLocal = {
      id: `${columnId}-asc`,
      title: "Ascending",
      parent: columnId,
      icon:
        columnId.includes("date") || columnId.includes("updated")
          ? "sort_calendar_asc"
          : "sort_arrow_upward",
      handler: () => sortTable(index, "asc"),
    };

    // Create descending action
    const descAction: CommandPaletteActionLocal = {
      id: `${columnId}-desc`,
      title: "Descending",
      parent: columnId,
      icon:
        columnId.includes("date") || columnId.includes("updated")
          ? "sort_calendar_desc"
          : "sort_arrow_downward",
      handler: () => sortTable(index, "desc"),
    };

    sortActions.push(columnAction, ascAction, descAction);
  });

  // Create root "Sort" action
  const sortRootAction: CommandPaletteActionLocal = {
    id: "sort",
    title: "Sort by",
    section: "Actions",
    icon: "sort",
    children: columnIds,
    handler: () => {
      const palette = document.querySelector("command-palette") as any;
      if (palette) {
        palette.open({ parent: "sort" });
        return { keepOpen: true };
      }
    },
  };

  return [sortRootAction, ...sortActions];
}

export async function initCommandPalette() {
  const palette = document.querySelector("command-palette") as any;

  if (!palette) {
    console.warn("command-palette element not found in DOM");
    return;
  }

  // Build dynamic provider and model actions
  const providerActions = buildProviderActions();
  const allModelsActions = buildAllModelsActions();
  const sortActions = buildSortActions();

  // Add static utility actions
  const staticActions: CommandPaletteActionLocal[] = [
    {
      id: "browse-models",
      title: "Browse Models",
      section: "Browse",
      icon: "models_boxes",
      children: allModelsActions.map((m) => m.id),
    },
    {
      id: "browse-providers",
      title: "Browse Providers",
      section: "Browse",
      icon: "providers",
      children: providerActions.map((p) => p.id),
    },
    {
      id: "github",
      title: "View on GitHub",
      section: "Models.dev",
      icon: "github_logo",
      external: true,
      handler: () => {
        window.open("https://github.com/sst/models.dev", "_blank");
      },
    },
    {
      id: "how-to-use",
      title: "How to use",
      section: "Models.dev",
      icon: "help",
      handler: () => {
        const modal = document.getElementById("modal") as HTMLDialogElement;
        if (modal) {
          const y = window.scrollY;
          document.body.style.position = "fixed";
          document.body.style.top = `-${y}px`;
          modal.showModal();
        }
      },
    },
    {
      id: "clear-search",
      title: "Clear search",
      section: "Actions",
      icon: "search_clear",
      handler: () => {
        // Clear search input only (keeps sort/filters)
        const searchInput = document.getElementById(
          "search",
        ) as HTMLInputElement;
        if (searchInput) {
          searchInput.value = "";
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      },
    },
    {
      id: "clear-sort",
      title: "Clear sort",
      section: "Actions",
      icon: "sort_clear",
      handler: () => {
        // Reset table sort to provider ascending (column 0) while keeping search query
        sortTable(0, "asc");
      },
    },
    {
      id: "reset-search",
      title: "Reset search",
      section: "Actions",
      icon: "search_reset",
      handler: () => {
        // Clear search input
        const searchInput = document.getElementById(
          "search",
        ) as HTMLInputElement;
        if (searchInput) {
          searchInput.value = "";
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        }

        // Reset table sort to provider ascending (column 0)
        sortTable(0, "asc");
      },
    },
  ];

  // Combine all actions: static actions + sort actions + provider actions + all models actions
  palette.data = [
    ...staticActions,
    ...sortActions,
    ...providerActions,
    ...allModelsActions,
  ];

  // Customize placeholder
  palette.placeholder = "Search by model, provider, family, or action";
}

export async function updateCommandPaletteModels() {
  const palette = document.querySelector("command-palette") as any;
  if (palette) {
    // Clear cache and re-extract
    cachedModelData = null;
    const providerActions = buildProviderActions();
    const allModelsActions = buildAllModelsActions();

    // Re-initialize with updated data
    palette.data = [
      ...palette.data.filter(
        (a: CommandPaletteActionLocal) =>
          !a.id.startsWith("provider-") && !a.id.startsWith("model-"),
      ),
      ...providerActions,
      ...allModelsActions,
    ];
  }
}
