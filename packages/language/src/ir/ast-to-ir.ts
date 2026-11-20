/**
 * Importer: Langium AST -> IR. The only place that knows both.
 *
 * Runs on already-validated documents. Unresolved references are dropped
 * rather than thrown on, so a partially broken workspace still produces a
 * renderable IR.
 */
import {
    IR_VERSION, deriveReferences,
    type IRFeatureModifiers,
    type IRDocument, type IRElement, type IRFeature, type IRKind, type IRModel, type IRProfile, type IRProperty, type IRRecord,
    type IRScalar, type IRValue
} from '@arbor/ir';
import type { Element, Feature, Kind, Model, Profile, Value, Visual } from '../language/generated/ast.js';
import { isDataTypeDecl, isListValue, isModel, isProfile, isRecordValue, isRefValue, type RecordValue } from '../language/generated/ast.js';
import {
    bounds, containmentOf, elementFeatures, elementId, enumId, hasModifier, kindId, literalValue,
    oppositeOf, redefinesOf, subsetsOf
} from '../language/semantics.js';

export function toIR(roots: Array<Profile | Model>): IRDocument {
    const profiles = roots.filter(isProfile).map(profileToIR);
    const models = roots.filter(isModel).map(modelToIR);

    // Self-describing: include every profile a model actually uses, even if
    // the caller only passed the model.
    const have = new Set(profiles.map(p => p.name));
    for (const m of roots.filter(isModel)) {
        for (const kind of kindsUsed(m)) {
            const p = kind.$container;
            if (!have.has(p.name)) { have.add(p.name); profiles.push(profileToIR(p)); }
        }
    }
    // Derived references are computed once every model and profile is in.
    return deriveReferences({ irVersion: IR_VERSION, profiles, models });
}

// ------------------------------------------------------------ profiles

function profileToIR(p: Profile): IRProfile {
    return {
        name: p.name,
        ...(p.version ? { version: p.version } : {}),
        kinds: p.kinds.map(kindToIR),
        enums: p.enums.map(e => ({ id: enumId(e), name: e.name, literals: e.literals.map(l => l.name) })),
        stereotypes: p.stereotypes.map(s => ({
            id: enumId(s), name: s.name,
            extends: s.metaclasses.flatMap(m => (m.ref ? [kindId(m.ref)] : [])),
            features: s.features.flatMap(featureToIR),
            visual: visualOf(s.visuals)
        })),
        datatypes: p.datatypes.map(d => ({
            id: enumId(d), name: d.name,
            features: d.features.flatMap(featureToIR).filter((f): f is IRProperty => f.feature === 'property')
        }))
    };
}

function visualOf(visuals: Visual[]): Record<string, IRScalar> {
    const visual: Record<string, IRScalar> = {};
    for (const v of visuals) for (const e of v.entries) visual[e.key] = literalValue(e.value);
    return visual;
}

function kindToIR(k: Kind): IRKind {
    const visual = visualOf(k.visuals);
    return {
        id: kindId(k),
        name: k.name,
        abstract: k.abstract,
        extends: k.supers.flatMap(s => (s.ref ? [kindId(s.ref)] : [])),
        features: k.features.flatMap(featureToIR),
        visual
    };
}

/** The modifiers a feature sets, as IR fields (absent when not set). */
function modifiersToIR(f: Feature): IRFeatureModifiers {
    const out: IRFeatureModifiers = {};
    for (const m of ['ordered', 'unique', 'readonly', 'derived'] as const) if (hasModifier(f, m)) out[m] = true;
    const opposite = f.$type === 'PropFeature' ? undefined : oppositeOf(f);
    if (opposite) out.opposite = opposite;
    if (subsetsOf(f).length) out.subsets = subsetsOf(f);
    if (redefinesOf(f).length) out.redefines = redefinesOf(f);
    return out;
}

function featureToIR(f: Feature): IRFeature[] {
    const multiplicity = bounds(f.multiplicity, f.$type);
    const modifiers = modifiersToIR(f);
    switch (f.$type) {
        case 'PropFeature': {
            const decl = f.type.$type === 'NamedTypeRef' ? f.type.decl.ref : undefined;
            const type = f.type.$type === 'PrimitiveTypeRef' ? f.type.primitive
                : isDataTypeDecl(decl) ? { datatype: enumId(decl) }
                : decl ? { enum: enumId(decl) } : undefined;
            if (!type) return [];
            return [{
                feature: 'property', name: f.name, type, multiplicity,
                ...(f.default ? { default: literalValue(f.default) } : {}),
                ...modifiers
            }];
        }
        case 'ContainsFeature':
        case 'RefFeature':
            if (!f.target.ref) return [];
            return [{
                feature: f.$type === 'ContainsFeature' ? 'contains' : 'ref',
                name: f.name, target: kindId(f.target.ref), multiplicity, ...modifiers,
                ...(f.edge ? { visual: Object.fromEntries(f.edge.entries.map(e => [e.key, literalValue(e.value)])) } : {})
            }];
    }
}

// ------------------------------------------------------------ models

function modelToIR(m: Model): IRModel {
    const elements: IRElement[] = [];
    const visit = (el: Element, parent: IRElement | null) => {
        const kind = el.kind.ref;
        if (!kind) return;
        const features = elementFeatures(el);
        const stereotypes = el.stereotypes.flatMap(s => (s.ref ? [enumId(s.ref)] : []));
        const ir: IRElement = {
            id: elementId(el),
            name: el.name ?? '',   // unnamed: see localName
            kind: kindId(kind),
            parent: parent?.id ?? null,
            containedIn: null,
            ...(stereotypes.length ? { stereotypes } : {}),
            children: [],
            properties: {},
            references: {}
        };
        if (parent) {
            ir.containedIn = containmentOf(el)?.name ?? null;
            parent.children.push(ir.id);
        }
        for (const slot of el.slots) {
            const f = features.get(slot.name);
            if (!f || f.$type === 'ContainsFeature' || hasModifier(f, 'derived')) continue;   // derived: computed later
            if (f.$type === 'RefFeature') {
                ir.references[slot.name] = refTargets(slot.value);
            } else {
                const v = scalarValue(slot.value);
                if (v !== undefined) ir.properties[slot.name] = v;
            }
        }
        elements.push(ir);
        for (const child of el.children) visit(child, ir);
    };
    for (const el of m.elements) visit(el, null);
    return { name: m.name, elements };
}

function refTargets(v: Value): string[] {
    const items = isListValue(v) ? v.items : [v];
    return items.flatMap(i => (isRefValue(i) && i.target.ref ? [elementId(i.target.ref)] : []));
}

function scalarValue(v: Value): IRValue | undefined {
    if (isRefValue(v)) return undefined;
    if (isRecordValue(v)) return recordValue(v);
    if (isListValue(v)) {
        return v.items.flatMap(i => (isRefValue(i) || isListValue(i) ? [] : [isRecordValue(i) ? recordValue(i) : literalValue(i)]));
    }
    return literalValue(v);
}

/** A datatype's value: the fields written, by name. */
function recordValue(r: RecordValue): IRRecord {
    const out: IRRecord = {};
    for (const slot of r.slots) {
        const v = scalarValue(slot.value);
        if (v !== undefined) out[slot.name] = v;
    }
    return out;
}

function kindsUsed(m: Model): Kind[] {
    const out = new Set<Kind>();
    const walk = (els: Element[]) => {
        for (const el of els) {
            const k = el.kind.ref;
            if (k) {
                out.add(k);
                // ancestors may live in other profiles
                const stack = [k];
                while (stack.length) {
                    const cur = stack.pop()!;
                    for (const s of cur.supers) if (s.ref && !out.has(s.ref)) { out.add(s.ref); stack.push(s.ref); }
                }
            }
            walk(el.children);
        }
    };
    walk(m.elements);
    return [...out];
}
