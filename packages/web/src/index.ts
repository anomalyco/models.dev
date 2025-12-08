const modal = document.getElementById("modal") as HTMLDialogElement;
const modalClose = document.getElementById("close")!;
const help = document.getElementById("help")!;
const search = document.getElementById("search")! as HTMLInputElement;

/////////////////////////
// URL State Management
/////////////////////////
function getQueryParams() {
  return new URLSearchParams(window.location.search);
}

function updateQueryParams(updates: Record<string, string | null>) {
  const params = getQueryParams();
  for (const [key, value] of Object.entries(updates)) {
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
  }
  const newPath = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;
  window.history.pushState({}, "", newPath);
}

function getColumnNameForURL(headerEl: Element): string {
  const text = headerEl.textContent?.trim().toLowerCase() || "";
  return text.replace(/↑|↓/g, "").trim().split(/\s+/).slice(0, 2).join("-");
}

function getColumnIndexByUrlName(name: string): number {
  const headers = document.querySelectorAll("th.sortable");
  return Array.from(headers).findIndex(
    (header) => getColumnNameForURL(header) === name
  );
}

/////////////////////////
// Handle "How to use"
/////////////////////////
let y = 0;

help.addEventListener("click", () => {
  y = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = `-${y}px`;
  modal.showModal();
});

function closeDialog() {
  modal.close();
  document.body.style.position = "";
  document.body.style.top = "";
  window.scrollTo(0, y);
}

modalClose.addEventListener("click", closeDialog);
modal.addEventListener("cancel", closeDialog);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeDialog();
});

////////////////////
// Handle Sorting
////////////////////
let currentSort = { column: -1, direction: "asc" };

function sortTable(column: number, direction: "asc" | "desc") {
  const header = document.querySelectorAll("th.sortable")[column];
  const columnType = header.getAttribute("data-type");
  if (!columnType) return;

  // update state
  currentSort = { column, direction };
  updateQueryParams({
    sort: getColumnNameForURL(header),
    order: direction,
  });

  // sort rows
  const tbody = document.querySelector("table tbody")!;
  const rows = Array.from(
    tbody.querySelectorAll("tr")
  ) as HTMLTableRowElement[];
  rows.sort((a, b) => {
    const aValue = getCellValue(a.cells[column], columnType);
    const bValue = getCellValue(b.cells[column], columnType);

    // Handle undefined values - always sort to bottom
    if (aValue === undefined && bValue === undefined) return 0;
    if (aValue === undefined) return 1;
    if (bValue === undefined) return -1;

    let comparison = 0;
    if (columnType === "number" || columnType === "modalities") {
      comparison = (aValue as number) - (bValue as number);
    } else if (columnType === "boolean") {
      comparison = (aValue as string).localeCompare(bValue as string);
    } else {
      comparison = (aValue as string).localeCompare(bValue as string);
    }

    return direction === "asc" ? comparison : -comparison;
  });
  rows.forEach((row) => tbody.appendChild(row));

  // update sort indicators
  const headers = document.querySelectorAll("th.sortable");
  headers.forEach((header, i) => {
    const indicator = header.querySelector(".sort-indicator")!;

    if (i === column) {
      indicator.textContent = direction === "asc" ? "↑" : "↓";
    } else {
      indicator.textContent = "";
    }
  });
}

function getCellValue(
  cell: HTMLTableCellElement,
  type: string
): string | number | undefined {
  if (type === "modalities")
    return cell.querySelectorAll(".modality-icon").length;

  const text = cell.textContent?.trim() || "";
  if (text === "-") return;
  if (type === "number") return parseFloat(text.replace(/[$,]/g, "")) || 0;
  return text;
}

document.querySelectorAll("th.sortable").forEach((header) => {
  header.addEventListener("click", () => {
    const column = Array.from(header.parentElement!.children).indexOf(header);
    const direction =
      currentSort.column === column && currentSort.direction === "asc"
        ? "desc"
        : "asc";
    sortTable(column, direction);
  });
});

///////////////////
// Handle Search
///////////////////

import {
  FIELD_CONFIGS,
  evaluateFilterExpression,
  serializeFilterExpression,
  deserializeFilterExpression,
  generateExpressionSummary,
  type FilterCondition,
  type FilterGroup,
  type FilterExpression,
} from './search';

let filterExpression: FilterExpression = { groups: [], groupConnectors: [] };
let idCounter = 0;

// DOM elements for advanced search
const toggleAdvanced = document.getElementById('toggle-advanced')!;
const searchBuilder = document.getElementById('search-builder')!;
const filterGroupsContainer = document.getElementById('filter-groups')!;
const addGroupBtn = document.getElementById('add-group')!;
const clearAllBtn = document.getElementById('clear-all-filters')!;
const activeFiltersSummary = document.getElementById('active-filters-summary')!;

// Simple search function (unchanged)
function filterTable(value: string) {
  const lowerCaseValues = value.toLowerCase().split(",").filter(str => str.trim() !== "");
  const rows = document.querySelectorAll(
    "table tbody tr"
  ) as NodeListOf<HTMLTableRowElement>;

  rows.forEach((row) => {
    const cellTexts = Array.from(row.cells).map((cell) =>
      cell.textContent!.toLowerCase()
    );
    const isVisible = lowerCaseValues.length === 0 ||
      lowerCaseValues.some((lowerCaseValue) => cellTexts.some((text) => text.includes(lowerCaseValue)));
    row.style.display = isVisible ? "" : "none";
  });

  updateQueryParams({ search: value || null });
}

// ID generator
function generateId(): string {
  return `id-${++idCounter}`;
}

// Create a condition row within a group
function createConditionRow(groupId: string, condition?: Partial<FilterCondition>): HTMLElement {
  const id = condition?.id || generateId();

  const row = document.createElement('div');
  row.className = 'filter-row';
  row.dataset.conditionId = id;

  // Field selector
  const fieldSelect = document.createElement('select');
  fieldSelect.className = 'field-select';
  fieldSelect.innerHTML = FIELD_CONFIGS.map(f =>
    `<option value="${f.name}">${f.label}</option>`
  ).join('');
  fieldSelect.value = condition?.field || FIELD_CONFIGS[0].name;
  fieldSelect.addEventListener('change', () => {
    updateOperatorsForField(row, fieldSelect.value);
    updateValueInputForField(row, fieldSelect.value);
    updateExpressionAndApply();
  });

  // Operator selector
  const operatorSelect = document.createElement('select');
  operatorSelect.className = 'operator-select';
  const fieldConfig = FIELD_CONFIGS.find(f => f.name === fieldSelect.value)!;
  operatorSelect.innerHTML = fieldConfig.operators.map(op =>
    `<option value="${op.value}">${op.label}</option>`
  ).join('');
  operatorSelect.value = condition?.operator || fieldConfig.operators[0].value;
  operatorSelect.addEventListener('change', () => updateExpressionAndApply());

  // Value input (text, select for boolean, or date input)
  let valueElement: HTMLInputElement | HTMLSelectElement;
  if (fieldConfig.type === 'boolean') {
    valueElement = document.createElement('select');
    valueElement.className = 'value-select';
    valueElement.innerHTML = `
      <option value="Yes">Yes</option>
      <option value="No">No</option>
    `;
  } else if (fieldConfig.type === 'date') {
    valueElement = document.createElement('input');
    valueElement.type = 'month';
    valueElement.className = 'value-input date-input';
  } else {
    valueElement = document.createElement('input');
    valueElement.type = 'text';
    valueElement.className = 'value-input';
    valueElement.placeholder = 'Enter value...';
  }
  valueElement.addEventListener('input', () => updateExpressionAndApply());
  valueElement.addEventListener('change', () => updateExpressionAndApply());
  if (condition?.value) {
    valueElement.value = condition.value;
  }

  // Remove button
  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-filter-btn';
  removeBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"></line>
      <line x1="6" y1="6" x2="18" y2="18"></line>
    </svg>
  `;
  removeBtn.addEventListener('click', () => removeCondition(groupId, id));

  row.appendChild(fieldSelect);
  row.appendChild(operatorSelect);
  row.appendChild(valueElement);
  row.appendChild(removeBtn);

  return row;
}

// Create a filter group element
function createFilterGroupElement(group?: Partial<FilterGroup>, groupIndex?: number): HTMLElement {
  const id = group?.id || generateId();
  const isFirstGroup = groupIndex === 0 || filterExpression.groups.length === 0;

  const groupElement = document.createElement('div');
  groupElement.className = 'filter-group';
  groupElement.dataset.groupId = id;

  // Group header
  const header = document.createElement('div');
  header.className = 'filter-group-header';

  const label = document.createElement('div');
  label.className = 'filter-group-label';
  label.innerHTML = `Match <select class="internal-connector">
    <option value="OR">ANY</option>
    <option value="AND">ALL</option>
  </select> conditions`;

  const internalConnectorSelect = label.querySelector('.internal-connector') as HTMLSelectElement;
  internalConnectorSelect.value = group?.internalConnector || 'OR';
  internalConnectorSelect.addEventListener('change', () => updateExpressionAndApply());

  const removeGroupBtn = document.createElement('button');
  removeGroupBtn.className = 'remove-group-btn';
  removeGroupBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"></line>
      <line x1="6" y1="6" x2="18" y2="18"></line>
    </svg>
  `;
  removeGroupBtn.addEventListener('click', () => removeGroup(id));

  header.appendChild(label);
  header.appendChild(removeGroupBtn);

  // Conditions container
  const conditionsContainer = document.createElement('div');
  conditionsContainer.className = 'filter-group-conditions';

  // Add existing conditions if restoring
  if (group?.conditions) {
    group.conditions.forEach(condition => {
      conditionsContainer.appendChild(createConditionRow(id, condition));
    });
  }

  // Add condition button
  const addConditionBtn = document.createElement('button');
  addConditionBtn.className = 'add-condition-btn';
  addConditionBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
    Add Condition
  `;
  addConditionBtn.addEventListener('click', () => {
    conditionsContainer.appendChild(createConditionRow(id));
    updateExpressionAndApply();
    updateSearchBuilderHeight();
  });

  groupElement.appendChild(header);
  groupElement.appendChild(conditionsContainer);
  groupElement.appendChild(addConditionBtn);

  return groupElement;
}

// Create a group connector element (AND/OR between groups)
function createGroupConnector(index: number): HTMLElement {
  const connector = document.createElement('div');
  connector.className = 'group-connector';
  connector.dataset.connectorIndex = String(index);
  connector.innerHTML = `
    <select>
      <option value="AND">AND</option>
      <option value="OR">OR</option>
    </select>
  `;
  const select = connector.querySelector('select')!;
  select.value = filterExpression.groupConnectors[index] || 'AND';
  select.addEventListener('change', () => updateExpressionAndApply());
  return connector;
}

function updateOperatorsForField(row: HTMLElement, fieldName: string) {
  const operatorSelect = row.querySelector('.operator-select') as HTMLSelectElement;
  const fieldConfig = FIELD_CONFIGS.find(f => f.name === fieldName)!;
  operatorSelect.innerHTML = fieldConfig.operators.map(op =>
    `<option value="${op.value}">${op.label}</option>`
  ).join('');
}

function updateValueInputForField(row: HTMLElement, fieldName: string) {
  const fieldConfig = FIELD_CONFIGS.find(f => f.name === fieldName)!;
  const oldValue = row.querySelector('.value-input, .value-select') as HTMLInputElement | HTMLSelectElement;

  let newValue: HTMLInputElement | HTMLSelectElement;
  if (fieldConfig.type === 'boolean') {
    newValue = document.createElement('select');
    newValue.className = 'value-select';
    newValue.innerHTML = `
      <option value="Yes">Yes</option>
      <option value="No">No</option>
    `;
  } else if (fieldConfig.type === 'date') {
    newValue = document.createElement('input');
    newValue.type = 'month';
    newValue.className = 'value-input date-input';
  } else {
    newValue = document.createElement('input');
    newValue.type = 'text';
    newValue.className = 'value-input';
    newValue.placeholder = 'Enter value...';
  }
  newValue.addEventListener('input', () => updateExpressionAndApply());
  newValue.addEventListener('change', () => updateExpressionAndApply());

  oldValue.replaceWith(newValue);
}

function addGroup(group?: Partial<FilterGroup>) {
  const groupIndex = filterExpression.groups.length;

  // Add group connector if not first group
  if (groupIndex > 0) {
    filterGroupsContainer.appendChild(createGroupConnector(groupIndex - 1));
  }

  const groupElement = createFilterGroupElement(group, groupIndex);
  filterGroupsContainer.appendChild(groupElement);

  // Add initial condition if new group
  if (!group?.conditions?.length) {
    const conditionsContainer = groupElement.querySelector('.filter-group-conditions')!;
    const groupId = groupElement.dataset.groupId!;
    conditionsContainer.appendChild(createConditionRow(groupId));
  }

  updateExpressionAndApply();
  updateSearchBuilderHeight();
}

function removeGroup(groupId: string) {
  const groupElement = filterGroupsContainer.querySelector(`[data-group-id="${groupId}"]`);
  if (groupElement) {
    // Remove preceding connector if exists
    const prevSibling = groupElement.previousElementSibling;
    if (prevSibling?.classList.contains('group-connector')) {
      prevSibling.remove();
    }
    // Or remove following connector if this was first group
    const nextSibling = groupElement.nextElementSibling;
    if (!prevSibling && nextSibling?.classList.contains('group-connector')) {
      nextSibling.remove();
    }

    groupElement.remove();
    updateExpressionAndApply();
    updateSearchBuilderHeight();
  }
}

function removeCondition(groupId: string, conditionId: string) {
  const groupElement = filterGroupsContainer.querySelector(`[data-group-id="${groupId}"]`);
  if (groupElement) {
    const conditionRow = groupElement.querySelector(`[data-condition-id="${conditionId}"]`);
    if (conditionRow) {
      conditionRow.remove();
      updateExpressionAndApply();
      updateSearchBuilderHeight();
    }
  }
}

function clearAllFilters() {
  filterGroupsContainer.innerHTML = '';
  filterExpression = { groups: [], groupConnectors: [] };
  applyAdvancedFilters();
  updateActiveFiltersSummary();
  updateQueryParams({ filters: null });
  updateSearchBuilderHeight();
}

function getExpressionFromDOM(): FilterExpression {
  const groups: FilterGroup[] = [];
  const groupConnectors: ('AND' | 'OR')[] = [];

  const groupElements = filterGroupsContainer.querySelectorAll('.filter-group');
  const connectorElements = filterGroupsContainer.querySelectorAll('.group-connector');

  groupElements.forEach((groupElement) => {
    const groupId = (groupElement as HTMLElement).dataset.groupId || generateId();
    const internalConnector = (groupElement.querySelector('.internal-connector') as HTMLSelectElement)?.value as 'AND' | 'OR' || 'OR';

    const conditions: FilterCondition[] = [];
    const conditionRows = groupElement.querySelectorAll('.filter-row');

    conditionRows.forEach((row) => {
      const id = (row as HTMLElement).dataset.conditionId || generateId();
      const field = (row.querySelector('.field-select') as HTMLSelectElement)?.value;
      const operator = (row.querySelector('.operator-select') as HTMLSelectElement)?.value;
      const value = (row.querySelector('.value-input, .value-select') as HTMLInputElement | HTMLSelectElement)?.value;

      conditions.push({ id, field, operator, value, connector: 'AND' });
    });

    groups.push({ id: groupId, conditions, internalConnector });
  });

  connectorElements.forEach((connectorElement) => {
    const select = connectorElement.querySelector('select') as HTMLSelectElement;
    groupConnectors.push((select?.value as 'AND' | 'OR') || 'AND');
  });

  return { groups, groupConnectors };
}

function updateExpressionAndApply() {
  filterExpression = getExpressionFromDOM();
  applyAdvancedFilters();
  updateActiveFiltersSummary();
  serializeExpressionToURL();
}

function applyAdvancedFilters() {
  const rows = document.querySelectorAll(
    "table tbody tr"
  ) as NodeListOf<HTMLTableRowElement>;

  // If no groups or all groups have empty conditions, show all
  const hasActiveFilters = filterExpression.groups.some(g =>
    g.conditions.some(c => c.value.trim() !== '')
  );

  if (!hasActiveFilters) {
    rows.forEach(row => row.style.display = '');
    return;
  }

  rows.forEach((row) => {
    const getCellValue = (columnIndex: number) =>
      row.cells[columnIndex]?.textContent?.trim() || '';

    const isVisible = evaluateFilterExpression(getCellValue, filterExpression);
    row.style.display = isVisible ? '' : 'none';
  });
}

function updateActiveFiltersSummary() {
  activeFiltersSummary.innerHTML = generateExpressionSummary(filterExpression);
}

function serializeExpressionToURL() {
  const serialized = serializeFilterExpression(filterExpression);
  updateQueryParams({ filters: serialized || null });
}

function updateSearchBuilderHeight() {
  if (!searchBuilder.classList.contains('collapsed')) {
    requestAnimationFrame(() => {
      const height = searchBuilder.offsetHeight;
      document.documentElement.style.setProperty('--search-builder-height', `${height}px`);
    });
  }
}

// Toggle advanced search panel
toggleAdvanced.addEventListener('click', () => {
  const isCollapsed = searchBuilder.classList.contains('collapsed');
  searchBuilder.classList.toggle('collapsed');
  toggleAdvanced.classList.toggle('active');
  document.body.classList.toggle('search-builder-open', isCollapsed);

  // Update table margin dynamically
  if (isCollapsed) {
    // If panel is being opened and there are no groups, add one as placeholder
    if (filterExpression.groups.length === 0) {
      addGroup();
    }
    updateSearchBuilderHeight();
  }
});

// Add group button
addGroupBtn.addEventListener('click', () => addGroup());

// Clear all button
clearAllBtn.addEventListener('click', clearAllFilters);

// Simple search
search.addEventListener("input", () => {
  filterTable(search.value);
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    search.focus();
  }
});

search.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    search.value = "";
    search.dispatchEvent(new Event("input"));
  }
});

///////////////////////////////////
// Handle Copy model ID function
///////////////////////////////////
(window as any).copyModelId = async (
  button: HTMLButtonElement,
  modelId: string
) => {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(modelId);

      // Switch to check icon
      const copyIcon = button.querySelector(".copy-icon") as HTMLElement;
      const checkIcon = button.querySelector(".check-icon") as HTMLElement;

      copyIcon.style.display = "none";
      checkIcon.style.display = "block";

      // Switch back after 1 second
      setTimeout(() => {
        copyIcon.style.display = "block";
        checkIcon.style.display = "none";
      }, 1000);
    }
  } catch (err) {
    console.error("Failed to copy text: ", err);
  }
};

///////////////////////////////////
// Initialize State from URL
///////////////////////////////////
function initializeFromURL() {
  const params = getQueryParams();

  (() => {
    const searchQuery = params.get("search");
    if (!searchQuery) return;
    search.value = searchQuery;
    filterTable(searchQuery);
  })();

  (() => {
    const columnName = params.get("sort");
    if (!columnName) return;

    const columnIndex = getColumnIndexByUrlName(columnName);
    if (columnIndex === -1) return;

    const direction = (params.get("order") as "asc" | "desc") || "asc";
    sortTable(columnIndex, direction);
  })();

  // Restore advanced filters from URL
  (() => {
    const filtersParam = params.get("filters");
    if (!filtersParam) return;

    const restoredExpression = deserializeFilterExpression(filtersParam, generateId);
    if (restoredExpression.groups.length > 0) {
      // Open the search builder panel
      searchBuilder.classList.remove('collapsed');
      toggleAdvanced.classList.add('active');
      document.body.classList.add('search-builder-open');

      // Create filter groups
      restoredExpression.groups.forEach((group, index) => {
        // Add group connector if not first group
        if (index > 0) {
          filterGroupsContainer.appendChild(createGroupConnector(index - 1));
          filterExpression.groupConnectors.push(restoredExpression.groupConnectors[index - 1] || 'AND');
        }

        const groupElement = createFilterGroupElement(group, index);
        filterGroupsContainer.appendChild(groupElement);
      });

      filterExpression = restoredExpression;
      updateSearchBuilderHeight();
    }
  })();
}

document.addEventListener("DOMContentLoaded", initializeFromURL);
window.addEventListener("popstate", initializeFromURL);
