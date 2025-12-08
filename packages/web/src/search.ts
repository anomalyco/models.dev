/**
 * Advanced Search Module
 * 
 * Contains the pure logic for filtering models with AND/OR conditions.
 * This module is separated from DOM manipulation for testability.
 */

// Field configuration for advanced filters
export interface FieldConfig {
    name: string;
    label: string;
    columnIndex: number;
    type: 'text' | 'boolean' | 'modalities' | 'date';
    operators: { value: string; label: string }[];
}

export interface FilterCondition {
    id: string;
    field: string;
    operator: string;
    value: string;
    connector: 'AND' | 'OR';
}

// New types for grouped filter clauses
export interface FilterGroup {
    id: string;
    conditions: FilterCondition[];  // Conditions within the group
    internalConnector: 'AND' | 'OR'; // How conditions connect within this group
}

export interface FilterExpression {
    groups: FilterGroup[];
    groupConnectors: ('AND' | 'OR')[]; // How groups connect to each other (length = groups.length - 1)
}

// Operator definitions for text fields
const TEXT_OPERATORS = [
    { value: 'equals', label: 'equals' },
    { value: 'contains', label: 'contains' },
    { value: 'startsWith', label: 'starts with' },
];

// Operator definitions for boolean fields
const BOOLEAN_OPERATORS = [{ value: 'is', label: 'is' }];

// Operator definitions for date fields
const DATE_OPERATORS = [
    { value: 'after', label: 'after' },
    { value: 'before', label: 'before' },
    { value: 'equals', label: 'equals' },
];

// Field configurations - maps field names to table column indices and operators
export const FIELD_CONFIGS: FieldConfig[] = [
    {
        name: 'provider',
        label: 'Provider',
        columnIndex: 0,
        type: 'text',
        operators: TEXT_OPERATORS,
    },
    {
        name: 'model',
        label: 'Model',
        columnIndex: 1,
        type: 'text',
        operators: TEXT_OPERATORS,
    },
    {
        name: 'providerId',
        label: 'Provider ID',
        columnIndex: 2,
        type: 'text',
        operators: TEXT_OPERATORS,
    },
    {
        name: 'modelId',
        label: 'Model ID',
        columnIndex: 3,
        type: 'text',
        operators: TEXT_OPERATORS,
    },
    {
        name: 'toolCall',
        label: 'Tool Call',
        columnIndex: 4,
        type: 'boolean',
        operators: BOOLEAN_OPERATORS,
    },
    {
        name: 'reasoning',
        label: 'Reasoning',
        columnIndex: 5,
        type: 'boolean',
        operators: BOOLEAN_OPERATORS,
    },
    {
        name: 'structuredOutput',
        label: 'Structured Output',
        columnIndex: 19,
        type: 'boolean',
        operators: BOOLEAN_OPERATORS,
    },
    {
        name: 'temperature',
        label: 'Temperature',
        columnIndex: 20,
        type: 'boolean',
        operators: BOOLEAN_OPERATORS,
    },
    {
        name: 'weights',
        label: 'Weights',
        columnIndex: 21,
        type: 'text',
        operators: [
            { value: 'equals', label: 'equals' },
            { value: 'contains', label: 'contains' },
        ],
    },
    {
        name: 'releaseDate',
        label: 'Release Date',
        columnIndex: 23,
        type: 'date',
        operators: DATE_OPERATORS,
    },
];

/**
 * Parse a date string into a Date object
 * Handles formats: "Jan 2025", "2025-01", "2025-01-15", "January 2025"
 */
function parseDate(dateStr: string): Date | null {
    const trimmed = dateStr.trim();
    if (!trimmed || trimmed === '-') return null;

    // Try ISO format first (2025-01-15 or 2025-01)
    const isoMatch = trimmed.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (isoMatch) {
        const year = parseInt(isoMatch[1]);
        const month = parseInt(isoMatch[2]) - 1;
        const day = isoMatch[3] ? parseInt(isoMatch[3]) : 1;
        return new Date(year, month, day);
    }

    // Try "Month Year" format (Jan 2025, January 2025)
    const monthYearMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (monthYearMatch) {
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const monthStr = monthYearMatch[1].toLowerCase().slice(0, 3);
        const monthIndex = monthNames.indexOf(monthStr);
        if (monthIndex !== -1) {
            const year = parseInt(monthYearMatch[2]);
            return new Date(year, monthIndex, 1);
        }
    }

    // Try native Date parsing as fallback
    const parsed = new Date(trimmed);
    return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Evaluate a single condition against a cell value
 */
export function evaluateOperator(
    cellValue: string,
    operator: string,
    searchValue: string
): boolean {
    const normalizedCell = cellValue.trim().toLowerCase();
    const normalizedSearch = searchValue.toLowerCase();

    switch (operator) {
        case 'equals':
            return normalizedCell === normalizedSearch;
        case 'contains':
            return normalizedCell.includes(normalizedSearch);
        case 'startsWith':
            return normalizedCell.startsWith(normalizedSearch);
        case 'is':
            return normalizedCell === normalizedSearch;
        case 'after': {
            const cellDate = parseDate(cellValue);
            const searchDate = parseDate(searchValue);
            if (!cellDate || !searchDate) return false;
            return cellDate > searchDate;
        }
        case 'before': {
            const cellDate = parseDate(cellValue);
            const searchDate = parseDate(searchValue);
            if (!cellDate || !searchDate) return false;
            return cellDate < searchDate;
        }
        default:
            return true;
    }
}

/**
 * Evaluate a single filter condition against a row's cell values
 */
export function evaluateCondition(
    getCellValue: (columnIndex: number) => string,
    condition: FilterCondition,
    fieldConfigs: FieldConfig[] = FIELD_CONFIGS
): boolean {
    const fieldConfig = fieldConfigs.find(f => f.name === condition.field);
    if (!fieldConfig) return true;

    const cellValue = getCellValue(fieldConfig.columnIndex);
    return evaluateOperator(cellValue, condition.operator, condition.value);
}

/**
 * Evaluate all filters with AND/OR logic
 * Returns true if the row matches all filter conditions
 */
export function evaluateFilters(
    getCellValue: (columnIndex: number) => string,
    filterList: FilterCondition[],
    fieldConfigs: FieldConfig[] = FIELD_CONFIGS
): boolean {
    if (filterList.length === 0) return true;

    // Evaluate first condition
    let result = evaluateCondition(getCellValue, filterList[0], fieldConfigs);

    // Apply subsequent conditions with their connectors
    for (let i = 1; i < filterList.length; i++) {
        const filter = filterList[i];
        const conditionResult = evaluateCondition(getCellValue, filter, fieldConfigs);

        if (filter.connector === 'OR') {
            result = result || conditionResult;
        } else {
            result = result && conditionResult;
        }
    }

    return result;
}

/**
 * Evaluate a single filter group
 * All conditions within a group are connected by the group's internalConnector
 */
export function evaluateFilterGroup(
    getCellValue: (columnIndex: number) => string,
    group: FilterGroup,
    fieldConfigs: FieldConfig[] = FIELD_CONFIGS
): boolean {
    const activeConditions = group.conditions.filter(c => c.value.trim() !== '');
    if (activeConditions.length === 0) return true;

    if (group.internalConnector === 'AND') {
        // All conditions must match
        return activeConditions.every(condition =>
            evaluateCondition(getCellValue, condition, fieldConfigs)
        );
    } else {
        // At least one condition must match
        return activeConditions.some(condition =>
            evaluateCondition(getCellValue, condition, fieldConfigs)
        );
    }
}

/**
 * Evaluate a complete filter expression with grouped clauses
 * Groups are connected by groupConnectors array
 */
export function evaluateFilterExpression(
    getCellValue: (columnIndex: number) => string,
    expression: FilterExpression,
    fieldConfigs: FieldConfig[] = FIELD_CONFIGS
): boolean {
    if (expression.groups.length === 0) return true;

    // Filter out empty groups (groups with no active conditions)
    const activeGroups = expression.groups.filter(g =>
        g.conditions.some(c => c.value.trim() !== '')
    );

    if (activeGroups.length === 0) return true;

    // Evaluate first group
    let result = evaluateFilterGroup(getCellValue, activeGroups[0], fieldConfigs);

    // Apply subsequent groups with their connectors
    for (let i = 1; i < activeGroups.length; i++) {
        const groupResult = evaluateFilterGroup(getCellValue, activeGroups[i], fieldConfigs);
        const connector = expression.groupConnectors[i - 1] || 'AND';

        if (connector === 'OR') {
            result = result || groupResult;
        } else {
            result = result && groupResult;
        }
    }

    return result;
}

/**
 * Get active filters (filters with non-empty values)
 */
export function getActiveFilters(filters: FilterCondition[]): FilterCondition[] {
    return filters.filter(f => f.value.trim() !== '');
}

/**
 * Simple search: split by comma and match any cell
 */
export function matchesSimpleSearch(
    cellTexts: string[],
    searchValue: string
): boolean {
    const lowerCaseValues = searchValue
        .toLowerCase()
        .split(',')
        .filter(str => str.trim() !== '');

    if (lowerCaseValues.length === 0) return true;

    const lowerCaseCells = cellTexts.map(text => text.toLowerCase());
    return lowerCaseValues.some(searchTerm =>
        lowerCaseCells.some(cell => cell.includes(searchTerm.trim()))
    );
}

/**
 * Serialize filters to URL-safe string format
 */
export function serializeFilters(filters: FilterCondition[]): string {
    const activeFilters = getActiveFilters(filters);
    if (activeFilters.length === 0) return '';

    return activeFilters
        .map(f => `${f.connector}:${f.field}:${f.operator}:${encodeURIComponent(f.value)}`)
        .join('|');
}

/**
 * Deserialize filters from URL string format
 */
export function deserializeFilters(
    param: string,
    generateId: () => string
): FilterCondition[] {
    if (!param) return [];

    return param.split('|').map(part => {
        const [connector, field, operator, value] = part.split(':');
        return {
            id: generateId(),
            connector: connector as 'AND' | 'OR',
            field,
            operator,
            value: decodeURIComponent(value || ''),
        };
    });
}

/**
 * Generate a filter summary HTML string for display
 */
export function generateFilterSummary(
    filters: FilterCondition[],
    fieldConfigs: FieldConfig[] = FIELD_CONFIGS
): string {
    const activeFilters = getActiveFilters(filters);
    if (activeFilters.length === 0) return '';

    return activeFilters
        .map((filter, index) => {
            const fieldConfig = fieldConfigs.find(f => f.name === filter.field);
            const connector = index === 0 ? '' : `<span class="filter-chip-connector">${filter.connector}</span>`;
            return `${connector}<span class="filter-chip">${fieldConfig?.label || filter.field} ${filter.operator} "${filter.value}"</span>`;
        })
        .join(' ');
}

/**
 * Get field configuration by name
 */
export function getFieldConfig(fieldName: string): FieldConfig | undefined {
    return FIELD_CONFIGS.find(f => f.name === fieldName);
}

/**
 * Serialize a filter expression to URL-safe string format
 * Format: GROUP(connector:field:op:value,...)~connector~GROUP(...)
 */
export function serializeFilterExpression(expression: FilterExpression): string {
    if (expression.groups.length === 0) return '';

    const groupStrings = expression.groups.map(group => {
        const conditionStrings = group.conditions
            .filter(c => c.value.trim() !== '')
            .map(c => `${c.field}:${c.operator}:${encodeURIComponent(c.value)}`)
            .join(',');
        return `${group.internalConnector}(${conditionStrings})`;
    }).filter(g => g !== 'AND()' && g !== 'OR()'); // Filter out empty groups

    if (groupStrings.length === 0) return '';

    // Join groups with their connectors
    let result = groupStrings[0];
    for (let i = 1; i < groupStrings.length; i++) {
        const connector = expression.groupConnectors[i - 1] || 'AND';
        result += `~${connector}~${groupStrings[i]}`;
    }
    return result;
}

/**
 * Deserialize a filter expression from URL string format
 */
export function deserializeFilterExpression(
    param: string,
    generateId: () => string
): FilterExpression {
    if (!param) return { groups: [], groupConnectors: [] };

    const groups: FilterGroup[] = [];
    const groupConnectors: ('AND' | 'OR')[] = [];

    // Split by group connectors (~AND~ or ~OR~)
    const parts = param.split(/~(AND|OR)~/);

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];

        // Even indices are groups, odd indices are connectors
        if (i % 2 === 0) {
            // Parse group: "AND(field:op:value,field:op:value)" or "OR(...)"
            const match = part.match(/^(AND|OR)\((.*)?\)$/);
            if (match) {
                const internalConnector = match[1] as 'AND' | 'OR';
                const conditionsStr = match[2] || '';

                const conditions: FilterCondition[] = conditionsStr
                    .split(',')
                    .filter(s => s.trim() !== '')
                    .map(s => {
                        const [field, operator, value] = s.split(':');
                        return {
                            id: generateId(),
                            field,
                            operator,
                            value: decodeURIComponent(value || ''),
                            connector: 'AND' as const, // Not used within groups
                        };
                    });

                groups.push({
                    id: generateId(),
                    conditions,
                    internalConnector,
                });
            }
        } else {
            // This is a connector between groups
            groupConnectors.push(part as 'AND' | 'OR');
        }
    }

    return { groups, groupConnectors };
}

/**
 * Generate a summary HTML string for a filter expression
 */
export function generateExpressionSummary(
    expression: FilterExpression,
    fieldConfigs: FieldConfig[] = FIELD_CONFIGS
): string {
    const activeGroups = expression.groups.filter(g =>
        g.conditions.some(c => c.value.trim() !== '')
    );

    if (activeGroups.length === 0) return '';

    return activeGroups
        .map((group, groupIndex) => {
            const activeConditions = group.conditions.filter(c => c.value.trim() !== '');

            const conditionHtml = activeConditions
                .map((condition, condIndex) => {
                    const fieldConfig = fieldConfigs.find(f => f.name === condition.field);
                    const connector = condIndex === 0 ? '' :
                        `<span class="filter-chip-connector-inline">${group.internalConnector}</span>`;
                    return `${connector}<span class="filter-chip">${fieldConfig?.label || condition.field} ${condition.operator} "${condition.value}"</span>`;
                })
                .join(' ');

            const groupConnector = groupIndex === 0 ? '' :
                `<span class="filter-chip-connector">${expression.groupConnectors[groupIndex - 1] || 'AND'}</span>`;

            return `${groupConnector}<span class="filter-group-chip">(${conditionHtml})</span>`;
        })
        .join(' ');
}

/**
 * Create an empty filter group
 */
export function createEmptyGroup(generateId: () => string): FilterGroup {
    return {
        id: generateId(),
        conditions: [],
        internalConnector: 'OR',
    };
}

/**
 * Create an empty filter condition
 */
export function createEmptyCondition(generateId: () => string): FilterCondition {
    return {
        id: generateId(),
        field: FIELD_CONFIGS[0]?.name || 'provider',
        operator: 'contains',
        value: '',
        connector: 'AND',
    };
}
