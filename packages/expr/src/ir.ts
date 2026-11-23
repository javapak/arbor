/**
 * The model itself as a world for expressions (M2): the profiles' kinds are
 * classes, their features properties, and the model's elements the objects.
 * `self` is an element; `self.regions->size()` counts what its `regions`
 * containment holds. This is what a profile's rules and derived features are
 * written against. The model can't be changed from here: nothing can be
 * assigned, and the only operations are a kind's queries (`query allParents()`)
 * and OCL's `oclContainer()`, the element holding this one.
 *
 * A derived feature with `derive "…"` is worked out when read, from its
 * expression, so derived values can build on each other (a qualified name on
 * its owner's); `deriveExpressions` fills them into the IR.
 *
 * Types are named by kind, as `State`, or qualified, as `uml::State`, where
 * several profiles define the name.
 */
import { IRIndex, displayName, type IRDocument, type IRElement, type IRFeature, type IRMultiplicity, type IRQuery, type IRTypeRef, type IRValue } from '@arbor/ir';
import { CollectionValue, EnumValue, EvalError, evaluate, type ObjectValue, type Value, type ValueSpace } from './eval.js';
import { parseExpression } from './parse.js';
import {
    ANY, BOOLEAN, INTEGER, REAL, STRING, collectionKind, collectionOf,
    type OperationInfo, type PropertyInfo, type Type, type TypeSpace,
} from './types.js';

/** How deep queries and derived features may call into each other before it's taken for a loop. */
const MAX_DEPTH = 200;

const many = (m: IRMultiplicity) => m.upper === null || m.upper > 1;

/** A kind's queries, its ancestors' too, nearest first. */
function queriesOf(index: IRIndex, kindId: string): IRQuery[] {
    return index.lineage(kindId).flatMap(k => k.operations ?? []);
}

/** `uml::State` or `State` to a kind, enum or datatype ID (`uml.State`); the first profile wins a bare name. */
function namer(index: IRIndex) {
    const ids = new Map<string, string>();
    const add = (id: string, name: string, profile: string) => {
        ids.set(`${profile}::${name}`, id);
        if (!ids.has(name)) ids.set(name, id);
    };
    for (const p of index.doc.profiles) {
        for (const k of p.kinds) add(k.id, k.name, p.name);
        for (const e of p.enums) add(e.id, e.name, p.name);
        for (const d of p.datatypes ?? []) add(d.id, d.name, p.name);
    }
    return (name: string) => ids.get(name);
}

export function irTypeSpace(doc: IRDocument): TypeSpace & { classOf(kindId: string): Type } {
    const index = new IRIndex(doc);
    const resolve = namer(index);
    const enums = new Map(doc.profiles.flatMap(p => p.enums.map(e => [e.id, e])));
    const typeOfId = (id: string): Type | undefined => {
        const named = index.kinds.get(id) ?? index.datatypes.get(id);
        if (named) return { kind: 'class', name: id, label: named.name };
        const e = enums.get(id);
        return e ? { kind: 'enum', name: e.name, literals: e.literals } : undefined;
    };
    const featuresOf = (owner: string): IRFeature[] =>
        index.kinds.has(owner) ? index.features(owner) : index.datatypes.get(owner)?.features ?? [];
    const typeOfRef = (t: IRTypeRef): Type =>
        t === 'string' || t === 'expr' || t === 'action' ? STRING : t === 'int' ? INTEGER : t === 'float' ? REAL : t === 'bool' ? BOOLEAN
            : typeOfId('enum' in t ? t.enum : 'datatype' in t ? t.datatype : t.kind) ?? ANY;
    // UML's defaults: a query's result and parameters are unordered (unless it says `ordered`) and unique.
    const typed = (t: IRTypeRef, m: IRMultiplicity, ordered = false): Type => (many(m) ? collectionOf(ordered ? 'OrderedSet' : 'Set', typeOfRef(t)) : typeOfRef(t));
    const property = (owner: string, name: string): PropertyInfo | undefined => {
        // Every element has a name (not a feature: the text writes it before the braces).
        if (name === 'name' && index.kinds.has(owner) && !featuresOf(owner).some(g => g.name === name)) return { type: STRING, readonly: true };
        const f = featuresOf(owner).find(g => g.name === name);
        if (!f) return undefined;
        let one: Type;
        if (f.feature === 'property') {
            const t = f.type;
            one = t === 'string' || t === 'expr' || t === 'action' ? STRING : t === 'int' ? INTEGER : t === 'float' ? REAL : t === 'bool' ? BOOLEAN
                : typeOfId('enum' in t ? t.enum : t.datatype) ?? { kind: 'any' };
        } else {
            one = typeOfId(f.target) ?? { kind: 'class', name: f.target };
        }
        const many = f.multiplicity.upper === null || f.multiplicity.upper > 1;
        // References and containments never repeat an element.
        const unique = f.feature !== 'property' || !!f.unique;
        return { type: many ? collectionOf(collectionKind(!!f.ordered, unique), one) : one, readonly: true };
    };
    return {
        type: name => {
            const id = resolve(name);
            return id ? typeOfId(id) : undefined;
        },
        property,
        operation: (owner, name): OperationInfo | undefined => {
            if (!index.kinds.has(owner)) return undefined;
            const q = queriesOf(index, owner).find(o => o.name === name);
            if (q) return { params: q.params.map(p => ({ name: p.name, type: typed(p.type, p.multiplicity) })), returns: typed(q.returns, q.multiplicity, !!q.ordered), query: true };
            // OCL's: the element holding this one, of whatever kind.
            if (name === 'oclContainer') return { params: [], returns: ANY, query: true };
            return undefined;
        },
        conforms: (sub, sup) => sub === sup || index.isA(sub, sup),
        members: owner => [...(index.kinds.has(owner) ? ['name', 'oclContainer', ...queriesOf(index, owner).map(q => q.name)] : []), ...featuresOf(owner).map(f => f.name)],
        classOf: kindId => typeOfId(kindId) ?? { kind: 'class', name: kindId },
    };
}

/** The model's elements as objects: reading slots (with defaults, derived values and subsets' values), and asking queries. */
export function irValueSpace(doc: IRDocument): ValueSpace & { element(id: string): IRElement | undefined } {
    const index = new IRIndex(doc);
    const parsed = new Map<string, ReturnType<typeof parseExpression>>();
    const parse = (text: string) => parsed.get(text) ?? parsed.set(text, parseExpression(text)).get(text)!;
    let depth = 0;
    /** Failures already labelled with the feature or query they're in, passed on as they are. */
    const labelled = new WeakSet<EvalError>();
    /** Runs a profile's expression about `self`; a failure in it names the feature or query it's in. */
    const run = (text: string, self: IRElement, what: string, variables: Record<string, Value> = {}): Value => {
        const p = parse(text);
        if (!p.value) throw new EvalError(`${what} doesn't parse: ${p.diagnostics[0].message}`, 0, 0);
        if (++depth > MAX_DEPTH) { depth = 0; throw new EvalError(`${what} calls itself without end.`, 0, 0); }
        try {
            return evaluate(p.value, { space, self, variables });
        } catch (e) {
            if (!(e instanceof EvalError) || labelled.has(e)) throw e;
            const outer = new EvalError(`${what}: ${e.message}`, e.start, e.end);
            labelled.add(outer);
            throw outer;
        } finally {
            depth = Math.max(0, depth - 1);
        }
    };
    const computed = new Map<IRElement, Map<string, Value>>();
    const computing = new Set<string>();
    const derived = (el: IRElement, f: IRFeature & { derive?: string }): Value => {
        const cache = computed.get(el) ?? computed.set(el, new Map()).get(el)!;
        if (cache.has(f.name)) return cache.get(f.name)!;
        const key = `${el.id}\u0000${f.name}`;
        if (computing.has(key)) throw new EvalError(`'${f.name}' of ${displayName(el)} depends on itself.`, 0, 0);
        computing.add(key);
        try {
            const v = run(f.derive!, el, `'${f.name}' of ${displayName(el)}`);
            cache.set(f.name, v);
            return v;
        } finally {
            computing.delete(key);
        }
    };
    const resolve = namer(index);
    const elements = new Set<object>(index.elements.values());
    const enums = new Map(doc.profiles.flatMap(p => p.enums.map(e => [e.id, e.name])));
    const isElement = (o: ObjectValue): o is IRElement => elements.has(o);

    /** A containment's elements, and those of the containments that subset it (a derived union's). */
    const contained = (el: IRElement, name: string): IRElement[] => {
        const features = index.elementFeatures(el);
        const names = new Set([name]);
        for (let grew = true; grew;) {
            grew = false;
            for (const f of features) {
                if (!names.has(f.name) && f.subsets?.some(s => names.has(s))) { names.add(f.name); grew = true; }
            }
        }
        return el.children.flatMap(id => {
            const c = index.elements.get(id);
            return c && c.containedIn && names.has(c.containedIn) ? [c] : [];
        });
    };

    const union = (el: IRElement, name: string): IRElement[] => {
        const out = new Set<IRElement>((el.references[name] ?? []).flatMap(id => index.elements.get(id) ?? []));
        for (const sub of index.elementFeatures(el)) {
            if (!sub.subsets?.includes(name)) continue;
            const v = read(el, sub.name);
            for (const x of v instanceof CollectionValue ? v.items : v === null ? [] : [v]) if (isElement(x as ObjectValue)) out.add(x as IRElement);
        }
        return [...out];
    };
    const read = (el: IRElement, name: string): Value => {
        const f = index.elementFeature(el, name);
        if (!f) return name === 'name' ? el.name || null : null;
        if (f.derive) return derived(el, f);
        const many = f.multiplicity.upper === null || f.multiplicity.upper > 1;
        const kind = collectionKind(!!f.ordered, f.feature !== 'property' || !!f.unique);
        if (f.feature === 'contains') {
            const items = contained(el, name);
            return many ? new CollectionValue(kind, items) : items[0] ?? null;
        }
        if (f.feature === 'ref') {
            // A derived union: what the features subsetting it hold, read here, so derived ones (`derive "…"`) count too.
            const items = f.derived && !f.opposite ? union(el, name) : index.values(el, name).flatMap(id => index.elements.get(id) ?? []);
            return many ? new CollectionValue(kind, items) : items[0] ?? null;
        }
        const raw = index.get(el, name) as unknown;
        const enumName = typeof f.type === 'object' && 'enum' in f.type ? enums.get(f.type.enum) : undefined;
        const one = (v: unknown): Value => (enumName && typeof v === 'string' ? new EnumValue(enumName, v) : v === undefined ? null : v as Value);
        if (many) return new CollectionValue(kind, Array.isArray(raw) ? raw.map(one) : raw === undefined ? [] : [one(raw)]);
        return one(raw);
    };

    const readOnly = (): never => { throw new EvalError(`The model can't be changed from an expression.`, 0, 0); };
    const space: ValueSpace & { element(id: string): IRElement | undefined } = {
        has: (o, name) => (isElement(o)
            ? name === 'name' || name === 'oclContainer' || !!index.elementFeature(o, name) || queriesOf(index, o.kind).some(q => q.name === name)
            : Object.hasOwn(o, name)),
        // A datatype's value is a plain record of its fields.
        get: (o, name) => (isElement(o) ? read(o, name) : ((o as Record<string, Value>)[name] ?? null)),
        set: readOnly,
        call: (o, name, args) => {
            if (!isElement(o)) throw new EvalError(`'${name}' isn't a query of this value.`, 0, 0);
            const q = queriesOf(index, o.kind).find(x => x.name === name);
            if (q) return run(q.body, o, `${name}() of ${displayName(o)}`, Object.fromEntries(q.params.map((p, i) => [p.name, args[i] ?? null])));
            if (name === 'oclContainer') return (o.parent && index.elements.get(o.parent)) || null;
            throw new EvalError(`${displayName(o)} has no query '${name}'.`, 0, 0);
        },
        isKindOf: (o, type) => { const id = resolve(type); return isElement(o) && !!id && index.isA(o.kind, id); },
        isTypeOf: (o, type) => { const id = resolve(type); return isElement(o) && o.kind === id; },
        element: id => index.elements.get(id),
    };
    return space;
}

/** A value as the IR holds it: element IDs for a reference, literals (an enum's by name) for a property. */
function toIR(v: Value, reference: boolean): IRValue | string[] | undefined {
    const one = (x: Value): IRValue | undefined => {
        if (x === null) return undefined;
        if (x instanceof EnumValue) return x.literal;
        if (typeof x === 'object' && !(x instanceof CollectionValue)) return reference ? (x as IRElement).id : x as IRValue;
        return x as IRValue;
    };
    if (v instanceof CollectionValue) return v.items.flatMap(x => { const y = one(x); return y === undefined ? [] : [y]; }) as IRValue;
    const y = one(v);
    return y === undefined ? undefined : reference ? [y as string] : y;
}

/** A derived feature whose expression failed, or doesn't give a value of its type. */
export interface DeriveFailure { element: string; feature: string; message: string; start: number; end: number }

/**
 * Works out the derived features with `derive "…"` of every element, and
 * writes their values into the IR (references as element IDs), with the
 * derived unions they're part of. Gives what failed: such a feature is then
 * left without a value.
 */
export function deriveExpressions(doc: IRDocument): DeriveFailure[] {
    const index = new IRIndex(doc);
    if (!doc.profiles.some(p => p.kinds.some(k => k.features.some(f => f.derive)))) return [];   // unions are as derive.ts left them
    const space = irValueSpace(doc);
    const failures: DeriveFailure[] = [];
    const results: Array<{ el: IRElement; f: IRFeature; value: Value }> = [];
    for (const el of index.elements.values()) {
        const features = index.elementFeatures(el);
        for (const f of features) {
            // Expressions, and the derived unions that may gather their values (a namespace's members, its imported ones too).
            const union = f.feature === 'ref' && f.derived && !f.opposite && !f.derive && features.some(g => g.subsets?.includes(f.name));
            if (!f.derive && !union) continue;
            try {
                results.push({ el, f, value: space.get(el, f.name) });
            } catch (e) {
                if (!(e instanceof EvalError)) throw e;
                failures.push({ element: el.id, feature: f.name, message: e.message, start: e.start, end: e.end });
            }
        }
    }
    // All at once, once every value is known: reading the IR mid-way would mix old and new.
    for (const { el, f, value } of results) {
        const ir = toIR(value, f.feature !== 'property');
        const slot = f.feature === 'property' ? el.properties : el.references;
        if (ir === undefined || (Array.isArray(ir) && ir.length === 0)) delete (slot as Record<string, unknown>)[f.name];
        else (slot as Record<string, unknown>)[f.name] = ir;
    }
    return failures;
}
