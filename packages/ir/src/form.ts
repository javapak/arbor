import type { IRDocument, IRElement, IRFeature, IRMultiplicity, IRScalar } from './types.js';
import { IRIndex } from './query.js';

/**
 * Profile -> JSON Schema for one element's slots, for generated forms.
 *
 * The schema covers properties and references (containment is the element's
 * children, edited in the text or the diagram). It is plain JSON Schema
 * (2020-12), so any validator or form library can use it; the `x-arbor-*`
 * keywords only tell a form which control to draw.
 *
 * References become element IDs, offered as `oneOf` choices of the elements
 * whose kind fits the reference target, so a validator rejects a wrong target.
 */
export interface SlotSchema {
    $schema: 'https://json-schema.org/draft/2020-12/schema';
    title: string;
    'x-arbor-kind': string;
    type: 'object';
    properties: Record<string, FieldSchema>;
    required: string[];
    additionalProperties: false;
}

export type FieldSchema = ScalarSchema | ListSchema;

export interface ScalarSchema {
    title: string;
    type?: 'string' | 'integer' | 'number' | 'boolean';
    enum?: string[];
    oneOf?: Array<{ const: string; title: string }>;
    default?: IRScalar;
    /** `property` or `ref`. */
    'x-arbor-feature': 'property' | 'ref';
    /** Enum ID (properties) or target kind ID (references). */
    'x-arbor-type'?: string;
}

export interface ListSchema {
    title: string;
    type: 'array';
    items: Omit<ScalarSchema, 'title'>;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    'x-arbor-feature': 'property' | 'ref';
    'x-arbor-type'?: string;
}

/** A form's value: slot name -> scalar, element ID, or a list of them. */
export type SlotValues = Record<string, IRScalar | IRScalar[]>;

const TYPES = { string: 'string', int: 'integer', float: 'number', bool: 'boolean' } as const;

export function slotSchema(doc: IRDocument | IRIndex, kindId: string): SlotSchema {
    const index = doc instanceof IRIndex ? doc : new IRIndex(doc);
    const enums = new Map(index.doc.profiles.flatMap(p => p.enums.map(e => [e.id, e] as const)));
    const properties: Record<string, FieldSchema> = {};
    const required: string[] = [];

    for (const f of index.features(kindId)) {
        if (f.feature === 'contains') continue;
        const item = itemSchema(f, index, enums);
        properties[f.name] = isMany(f.multiplicity)
            ? {
                title: f.name, type: 'array', items: item,
                ...(f.multiplicity.lower > 0 ? { minItems: f.multiplicity.lower } : {}),
                ...(f.multiplicity.upper !== null ? { maxItems: f.multiplicity.upper } : {}),
                ...(f.feature === 'ref' ? { uniqueItems: true } : {}),
                'x-arbor-feature': item['x-arbor-feature'],
                ...(item['x-arbor-type'] ? { 'x-arbor-type': item['x-arbor-type'] } : {}),
            }
            : { title: f.name, ...item };
        const defaulted = f.feature === 'property' && f.default !== undefined;
        if (f.multiplicity.lower > 0 && !defaulted) required.push(f.name);
    }
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: index.kinds.get(kindId)?.name ?? kindId,
        'x-arbor-kind': kindId,
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    };
}

/** The element's written slots, in the shape `schema` describes. Defaults are not filled in. */
export function slotValues(element: IRElement, schema: SlotSchema): SlotValues {
    const out: SlotValues = {};
    for (const [name, value] of [...Object.entries(element.properties), ...Object.entries(element.references)]) {
        const list = schema.properties[name]?.type === 'array';
        out[name] = list || !Array.isArray(value) ? value : value[0];
    }
    return out;
}

/** A feature is many-valued unless its upper bound is 1, as in the text (`[0..1]` is the default). */
export function isMany(m: IRMultiplicity): boolean {
    return m.upper !== 1;
}

function itemSchema(
    f: Exclude<IRFeature, { feature: 'contains' }>, index: IRIndex, enums: Map<string, { literals: string[] }>
): Omit<ScalarSchema, 'title'> {
    if (f.feature === 'ref') {
        const targets = [...index.elements.values()].filter(e => index.isA(e.kind, f.target));
        return {
            type: 'string',
            oneOf: targets.map(e => ({ const: e.id, title: e.name })),
            'x-arbor-feature': 'ref',
            'x-arbor-type': f.target,
        };
    }
    const common = { 'x-arbor-feature': 'property' as const, ...(f.default !== undefined ? { default: f.default } : {}) };
    if (typeof f.type === 'object') {
        return { type: 'string', enum: enums.get(f.type.enum)?.literals ?? [], 'x-arbor-type': f.type.enum, ...common };
    }
    return { type: TYPES[f.type], ...common };
}
