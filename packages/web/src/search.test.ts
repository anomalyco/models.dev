/**
 * Tests for the Advanced Search Module
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import {
    evaluateOperator,
    evaluateCondition,
    evaluateFilters,
    evaluateFilterGroup,
    evaluateFilterExpression,
    getActiveFilters,
    matchesSimpleSearch,
    serializeFilters,
    deserializeFilters,
    serializeFilterExpression,
    deserializeFilterExpression,
    generateFilterSummary,
    generateExpressionSummary,
    getFieldConfig,
    FIELD_CONFIGS,
    type FilterCondition,
    type FilterGroup,
    type FilterExpression,
} from './search';

describe('evaluateOperator', () => {
    describe('equals operator', () => {
        it('should return true for exact match', () => {
            expect(evaluateOperator('anthropic', 'equals', 'anthropic')).toBe(true);
        });

        it('should return true for case-insensitive match', () => {
            expect(evaluateOperator('Anthropic', 'equals', 'anthropic')).toBe(true);
        });

        it('should return false for partial match', () => {
            expect(evaluateOperator('anthropic-claude', 'equals', 'anthropic')).toBe(false);
        });

        it('should handle whitespace', () => {
            expect(evaluateOperator('  anthropic  ', 'equals', 'anthropic')).toBe(true);
        });
    });

    describe('contains operator', () => {
        it('should return true for substring match', () => {
            expect(evaluateOperator('anthropic-claude-3', 'contains', 'claude')).toBe(true);
        });

        it('should return true for exact match', () => {
            expect(evaluateOperator('claude', 'contains', 'claude')).toBe(true);
        });

        it('should return false for no match', () => {
            expect(evaluateOperator('openai-gpt', 'contains', 'claude')).toBe(false);
        });
    });

    describe('startsWith operator', () => {
        it('should return true when value starts with search term', () => {
            expect(evaluateOperator('claude-3-opus', 'startsWith', 'claude')).toBe(true);
        });

        it('should return false when value does not start with search term', () => {
            expect(evaluateOperator('gpt-4-claude', 'startsWith', 'claude')).toBe(false);
        });
    });

    describe('is operator (boolean)', () => {
        it('should return true for matching boolean text', () => {
            expect(evaluateOperator('Yes', 'is', 'yes')).toBe(true);
        });

        it('should return false for non-matching boolean text', () => {
            expect(evaluateOperator('No', 'is', 'yes')).toBe(false);
        });
    });

    describe('unknown operator', () => {
        it('should return true for unknown operator', () => {
            expect(evaluateOperator('anything', 'unknownOp', 'value')).toBe(true);
        });
    });

    describe('after operator (dates)', () => {
        it('should return true when cell date is after search date', () => {
            expect(evaluateOperator('Feb 2025', 'after', 'Jan 2025')).toBe(true);
        });

        it('should return false when cell date is before search date', () => {
            expect(evaluateOperator('Dec 2024', 'after', 'Jan 2025')).toBe(false);
        });

        it('should handle ISO date format', () => {
            expect(evaluateOperator('2025-02', 'after', '2025-01')).toBe(true);
        });

        it('should return false for equal dates', () => {
            expect(evaluateOperator('Jan 2025', 'after', 'Jan 2025')).toBe(false);
        });

        it('should return false for invalid dates', () => {
            expect(evaluateOperator('-', 'after', 'Jan 2025')).toBe(false);
        });
    });

    describe('before operator (dates)', () => {
        it('should return true when cell date is before search date', () => {
            expect(evaluateOperator('Dec 2024', 'before', 'Jan 2025')).toBe(true);
        });

        it('should return false when cell date is after search date', () => {
            expect(evaluateOperator('Feb 2025', 'before', 'Jan 2025')).toBe(false);
        });

        it('should return false for equal dates', () => {
            expect(evaluateOperator('Jan 2025', 'before', 'Jan 2025')).toBe(false);
        });
    });
});

describe('evaluateCondition', () => {
    const mockGetCellValue = (values: string[]) => (columnIndex: number) => values[columnIndex] || '';

    it('should evaluate a text condition correctly', () => {
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3', 'anthropic', 'claude-3-opus']);
        const condition: FilterCondition = {
            id: '1',
            field: 'provider',
            operator: 'equals',
            value: 'anthropic',
            connector: 'AND',
        };
        expect(evaluateCondition(getCellValue, condition)).toBe(true);
    });

    it('should return true for unknown field', () => {
        const getCellValue = mockGetCellValue(['Anthropic']);
        const condition: FilterCondition = {
            id: '1',
            field: 'unknownField',
            operator: 'equals',
            value: 'test',
            connector: 'AND',
        };
        expect(evaluateCondition(getCellValue, condition)).toBe(true);
    });
});

describe('evaluateFilters', () => {
    const mockGetCellValue = (values: string[]) => (columnIndex: number) => values[columnIndex] || '';

    it('should return true for empty filter list', () => {
        const getCellValue = mockGetCellValue(['Anthropic']);
        expect(evaluateFilters(getCellValue, [])).toBe(true);
    });

    it('should evaluate single filter correctly', () => {
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
        ];
        expect(evaluateFilters(getCellValue, filters)).toBe(true);
    });

    it('should evaluate AND logic correctly (both true)', () => {
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
            { id: '2', field: 'model', operator: 'contains', value: 'claude', connector: 'AND' },
        ];
        expect(evaluateFilters(getCellValue, filters)).toBe(true);
    });

    it('should evaluate AND logic correctly (one false)', () => {
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
            { id: '2', field: 'model', operator: 'contains', value: 'gpt', connector: 'AND' },
        ];
        expect(evaluateFilters(getCellValue, filters)).toBe(false);
    });

    it('should evaluate OR logic correctly (one true)', () => {
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'contains', value: 'openai', connector: 'AND' },
            { id: '2', field: 'provider', operator: 'contains', value: 'anthro', connector: 'OR' },
        ];
        expect(evaluateFilters(getCellValue, filters)).toBe(true);
    });

    it('should evaluate complex AND/OR combinations', () => {
        // Anthropic Claude model
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);

        // (provider=openai AND model=gpt) OR provider=anthropic
        // This should be: false AND false OR true = true
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'equals', value: 'openai', connector: 'AND' },
            { id: '2', field: 'model', operator: 'contains', value: 'gpt', connector: 'AND' },
            { id: '3', field: 'provider', operator: 'contains', value: 'anthropic', connector: 'OR' },
        ];
        expect(evaluateFilters(getCellValue, filters)).toBe(true);
    });
});

describe('getActiveFilters', () => {
    it('should filter out empty values', () => {
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'equals', value: '', connector: 'AND' },
            { id: '2', field: 'model', operator: 'equals', value: 'claude', connector: 'AND' },
            { id: '3', field: 'modelId', operator: 'equals', value: '   ', connector: 'AND' },
        ];
        const active = getActiveFilters(filters);
        expect(active).toHaveLength(1);
        expect(active[0].value).toBe('claude');
    });

    it('should return all filters if all have values', () => {
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'equals', value: 'anthropic', connector: 'AND' },
            { id: '2', field: 'model', operator: 'equals', value: 'claude', connector: 'AND' },
        ];
        expect(getActiveFilters(filters)).toHaveLength(2);
    });
});

describe('matchesSimpleSearch', () => {
    const cells = ['Anthropic', 'Claude 3 Opus', 'anthropic', 'claude-3-opus'];

    it('should return true for empty search', () => {
        expect(matchesSimpleSearch(cells, '')).toBe(true);
    });

    it('should return true when any cell matches', () => {
        expect(matchesSimpleSearch(cells, 'opus')).toBe(true);
    });

    it('should support comma-separated search terms', () => {
        expect(matchesSimpleSearch(cells, 'gpt,claude')).toBe(true);
    });

    it('should return false when no cell matches', () => {
        expect(matchesSimpleSearch(cells, 'openai')).toBe(false);
    });
});

describe('serializeFilters / deserializeFilters', () => {
    let idCounter = 0;
    const generateId = () => `test-${++idCounter}`;

    beforeEach(() => {
        idCounter = 0;
    });

    it('should serialize filters to URL format', () => {
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'contains', value: 'anthropic', connector: 'AND' },
        ];
        const serialized = serializeFilters(filters);
        expect(serialized).toBe('AND:provider:contains:anthropic');
    });

    it('should handle multiple filters', () => {
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
            { id: '2', field: 'model', operator: 'equals', value: 'claude', connector: 'OR' },
        ];
        const serialized = serializeFilters(filters);
        expect(serialized).toBe('AND:provider:contains:anthro|OR:model:equals:claude');
    });

    it('should deserialize filters from URL format', () => {
        const serialized = 'AND:provider:contains:anthropic|OR:model:equals:claude';
        const filters = deserializeFilters(serialized, generateId);

        expect(filters).toHaveLength(2);
        expect(filters[0].field).toBe('provider');
        expect(filters[0].operator).toBe('contains');
        expect(filters[0].value).toBe('anthropic');
        expect(filters[0].connector).toBe('AND');
        expect(filters[1].connector).toBe('OR');
    });

    it('should handle URL-encoded values', () => {
        const filters: FilterCondition[] = [
            { id: '1', field: 'model', operator: 'contains', value: 'claude 3', connector: 'AND' },
        ];
        const serialized = serializeFilters(filters);
        const deserialized = deserializeFilters(serialized, generateId);

        expect(deserialized[0].value).toBe('claude 3');
    });

    it('should return empty array for empty input', () => {
        expect(deserializeFilters('', generateId)).toEqual([]);
    });
});

describe('generateFilterSummary', () => {
    it('should return empty string for no filters', () => {
        expect(generateFilterSummary([])).toBe('');
    });

    it('should return empty string for filters with empty values', () => {
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'equals', value: '', connector: 'AND' },
        ];
        expect(generateFilterSummary(filters)).toBe('');
    });

    it('should generate HTML summary for single filter', () => {
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'contains', value: 'anthropic', connector: 'AND' },
        ];
        const summary = generateFilterSummary(filters);
        expect(summary).toContain('Provider');
        expect(summary).toContain('contains');
        expect(summary).toContain('anthropic');
        expect(summary).toContain('filter-chip');
    });

    it('should include connector for multiple filters', () => {
        const filters: FilterCondition[] = [
            { id: '1', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
            { id: '2', field: 'model', operator: 'equals', value: 'claude', connector: 'OR' },
        ];
        const summary = generateFilterSummary(filters);
        expect(summary).toContain('filter-chip-connector');
        expect(summary).toContain('OR');
    });
});

describe('getFieldConfig', () => {
    it('should return field config for valid field name', () => {
        const config = getFieldConfig('provider');
        expect(config).toBeDefined();
        expect(config?.label).toBe('Provider');
        expect(config?.columnIndex).toBe(0);
    });

    it('should return undefined for unknown field', () => {
        expect(getFieldConfig('unknownField')).toBeUndefined();
    });
});

describe('FIELD_CONFIGS', () => {
    it('should have all expected fields', () => {
        const fieldNames = FIELD_CONFIGS.map(f => f.name);
        expect(fieldNames).toContain('provider');
        expect(fieldNames).toContain('model');
        expect(fieldNames).toContain('providerId');
        expect(fieldNames).toContain('modelId');
        expect(fieldNames).toContain('toolCall');
        expect(fieldNames).toContain('reasoning');
    });

    it('should have correct types for boolean fields', () => {
        const booleanFields = FIELD_CONFIGS.filter(f => f.type === 'boolean');
        expect(booleanFields.length).toBeGreaterThan(0);
        booleanFields.forEach(field => {
            expect(field.operators).toHaveLength(1);
            expect(field.operators[0].value).toBe('is');
        });
    });
});

// Tests for Grouped Filter Clauses
describe('evaluateFilterGroup', () => {
    const mockGetCellValue = (values: string[]) => (columnIndex: number) => values[columnIndex] || '';

    it('should return true for empty group', () => {
        const getCellValue = mockGetCellValue(['Anthropic']);
        const group: FilterGroup = {
            id: '1',
            conditions: [],
            internalConnector: 'OR',
        };
        expect(evaluateFilterGroup(getCellValue, group)).toBe(true);
    });

    it('should evaluate OR group correctly (any match)', () => {
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const group: FilterGroup = {
            id: '1',
            conditions: [
                { id: 'c1', field: 'provider', operator: 'contains', value: 'openai', connector: 'AND' },
                { id: 'c2', field: 'provider', operator: 'contains', value: 'anthropic', connector: 'AND' },
            ],
            internalConnector: 'OR',
        };
        expect(evaluateFilterGroup(getCellValue, group)).toBe(true);
    });

    it('should evaluate OR group correctly (no match)', () => {
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const group: FilterGroup = {
            id: '1',
            conditions: [
                { id: 'c1', field: 'provider', operator: 'contains', value: 'openai', connector: 'AND' },
                { id: 'c2', field: 'provider', operator: 'contains', value: 'google', connector: 'AND' },
            ],
            internalConnector: 'OR',
        };
        expect(evaluateFilterGroup(getCellValue, group)).toBe(false);
    });

    it('should evaluate AND group correctly (all match)', () => {
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const group: FilterGroup = {
            id: '1',
            conditions: [
                { id: 'c1', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
                { id: 'c2', field: 'model', operator: 'contains', value: 'claude', connector: 'AND' },
            ],
            internalConnector: 'AND',
        };
        expect(evaluateFilterGroup(getCellValue, group)).toBe(true);
    });

    it('should evaluate AND group correctly (partial match fails)', () => {
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const group: FilterGroup = {
            id: '1',
            conditions: [
                { id: 'c1', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
                { id: 'c2', field: 'model', operator: 'contains', value: 'gpt', connector: 'AND' },
            ],
            internalConnector: 'AND',
        };
        expect(evaluateFilterGroup(getCellValue, group)).toBe(false);
    });
});

describe('evaluateFilterExpression', () => {
    const mockGetCellValue = (values: string[]) => (columnIndex: number) => values[columnIndex] || '';

    it('should return true for empty expression', () => {
        const getCellValue = mockGetCellValue(['Anthropic']);
        const expression: FilterExpression = { groups: [], groupConnectors: [] };
        expect(evaluateFilterExpression(getCellValue, expression)).toBe(true);
    });

    it('should evaluate single group expression', () => {
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const expression: FilterExpression = {
            groups: [{
                id: '1',
                conditions: [
                    { id: 'c1', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
                ],
                internalConnector: 'OR',
            }],
            groupConnectors: [],
        };
        expect(evaluateFilterExpression(getCellValue, expression)).toBe(true);
    });

    it('should evaluate two groups with AND connector', () => {
        // (Provider=Anthropic OR Provider=OpenAI) AND (Model contains Claude)
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3', '', '', '', 'Yes']);
        const expression: FilterExpression = {
            groups: [
                {
                    id: '1',
                    conditions: [
                        { id: 'c1', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
                        { id: 'c2', field: 'provider', operator: 'contains', value: 'openai', connector: 'AND' },
                    ],
                    internalConnector: 'OR', // Match ANY
                },
                {
                    id: '2',
                    conditions: [
                        { id: 'c3', field: 'model', operator: 'contains', value: 'claude', connector: 'AND' },
                    ],
                    internalConnector: 'AND',
                },
            ],
            groupConnectors: ['AND'],
        };
        // (anthropic OR openai) AND (claude) = true AND true = true
        expect(evaluateFilterExpression(getCellValue, expression)).toBe(true);
    });

    it('should evaluate two groups with AND connector (fails)', () => {
        // (Provider=OpenAI OR Provider=Google) AND (Model contains Claude)
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const expression: FilterExpression = {
            groups: [
                {
                    id: '1',
                    conditions: [
                        { id: 'c1', field: 'provider', operator: 'contains', value: 'openai', connector: 'AND' },
                        { id: 'c2', field: 'provider', operator: 'contains', value: 'google', connector: 'AND' },
                    ],
                    internalConnector: 'OR',
                },
                {
                    id: '2',
                    conditions: [
                        { id: 'c3', field: 'model', operator: 'contains', value: 'claude', connector: 'AND' },
                    ],
                    internalConnector: 'AND',
                },
            ],
            groupConnectors: ['AND'],
        };
        // (openai OR google) AND (claude) = false AND true = false
        expect(evaluateFilterExpression(getCellValue, expression)).toBe(false);
    });

    it('should evaluate two groups with OR connector', () => {
        // (Provider=OpenAI) OR (Provider=Anthropic)
        const getCellValue = mockGetCellValue(['Anthropic', 'Claude 3']);
        const expression: FilterExpression = {
            groups: [
                {
                    id: '1',
                    conditions: [
                        { id: 'c1', field: 'provider', operator: 'contains', value: 'openai', connector: 'AND' },
                    ],
                    internalConnector: 'OR',
                },
                {
                    id: '2',
                    conditions: [
                        { id: 'c3', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
                    ],
                    internalConnector: 'OR',
                },
            ],
            groupConnectors: ['OR'],
        };
        // (openai) OR (anthropic) = false OR true = true
        expect(evaluateFilterExpression(getCellValue, expression)).toBe(true);
    });
});

describe('serializeFilterExpression / deserializeFilterExpression', () => {
    let idCounter = 0;
    const generateId = () => `test-${++idCounter}`;

    beforeEach(() => {
        idCounter = 0;
    });

    it('should serialize single group expression', () => {
        const expression: FilterExpression = {
            groups: [{
                id: '1',
                conditions: [
                    { id: 'c1', field: 'provider', operator: 'contains', value: 'anthropic', connector: 'AND' },
                ],
                internalConnector: 'OR',
            }],
            groupConnectors: [],
        };
        const serialized = serializeFilterExpression(expression);
        expect(serialized).toBe('OR(provider:contains:anthropic)');
    });

    it('should serialize multiple groups with connectors', () => {
        const expression: FilterExpression = {
            groups: [
                {
                    id: '1',
                    conditions: [
                        { id: 'c1', field: 'provider', operator: 'contains', value: 'anthropic', connector: 'AND' },
                        { id: 'c2', field: 'provider', operator: 'contains', value: 'openai', connector: 'AND' },
                    ],
                    internalConnector: 'OR',
                },
                {
                    id: '2',
                    conditions: [
                        { id: 'c3', field: 'reasoning', operator: 'is', value: 'Yes', connector: 'AND' },
                    ],
                    internalConnector: 'AND',
                },
            ],
            groupConnectors: ['AND'],
        };
        const serialized = serializeFilterExpression(expression);
        expect(serialized).toBe('OR(provider:contains:anthropic,provider:contains:openai)~AND~AND(reasoning:is:Yes)');
    });

    it('should deserialize expression from URL format', () => {
        const serialized = 'OR(provider:contains:anthropic,provider:contains:openai)~AND~AND(reasoning:is:Yes)';
        const expression = deserializeFilterExpression(serialized, generateId);

        expect(expression.groups).toHaveLength(2);
        expect(expression.groupConnectors).toHaveLength(1);
        expect(expression.groupConnectors[0]).toBe('AND');

        expect(expression.groups[0].internalConnector).toBe('OR');
        expect(expression.groups[0].conditions).toHaveLength(2);
        expect(expression.groups[0].conditions[0].value).toBe('anthropic');

        expect(expression.groups[1].internalConnector).toBe('AND');
        expect(expression.groups[1].conditions[0].field).toBe('reasoning');
    });

    it('should handle empty expression', () => {
        expect(serializeFilterExpression({ groups: [], groupConnectors: [] })).toBe('');
        const deserialized = deserializeFilterExpression('', generateId);
        expect(deserialized.groups).toHaveLength(0);
    });
});

describe('generateExpressionSummary', () => {
    it('should return empty string for empty expression', () => {
        expect(generateExpressionSummary({ groups: [], groupConnectors: [] })).toBe('');
    });

    it('should generate summary for single group', () => {
        const expression: FilterExpression = {
            groups: [{
                id: '1',
                conditions: [
                    { id: 'c1', field: 'provider', operator: 'contains', value: 'anthropic', connector: 'AND' },
                ],
                internalConnector: 'OR',
            }],
            groupConnectors: [],
        };
        const summary = generateExpressionSummary(expression);
        expect(summary).toContain('Provider');
        expect(summary).toContain('anthropic');
        expect(summary).toContain('filter-group-chip');
    });

    it('should include group connector for multiple groups', () => {
        const expression: FilterExpression = {
            groups: [
                {
                    id: '1',
                    conditions: [
                        { id: 'c1', field: 'provider', operator: 'contains', value: 'anthro', connector: 'AND' },
                    ],
                    internalConnector: 'OR',
                },
                {
                    id: '2',
                    conditions: [
                        { id: 'c3', field: 'reasoning', operator: 'is', value: 'Yes', connector: 'AND' },
                    ],
                    internalConnector: 'AND',
                },
            ],
            groupConnectors: ['AND'],
        };
        const summary = generateExpressionSummary(expression);
        expect(summary).toContain('filter-chip-connector');
        expect(summary).toContain('AND');
    });
});
