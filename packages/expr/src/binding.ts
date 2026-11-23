/**
 * Expressions in models: what the text in an `expr` or `action` slot is
 * checked against, and the classes a model describes as a world to run them in.
 *
 * The language parses every such slot, whatever its profile. A profile with a
 * binding is checked further: the binding says which of its kinds are classes,
 * attributes, operations and parameters (so a model's classes become the types
 * expressions are about), which slots hold guards, effects, bodies and
 * defaults, and what `self` is for each. A profile declares it with roles
 * (`plays class`, `plays guard`: ROLES in @arbor/ir), read from the IR by
 * `expressionBindings`; the binding is plain data, interpreted here.
 */
import { IRIndex, type IRDocument, type IRElement } from '@arbor/ir';
import type { CheckContext } from './check.js';
import {
    ANY, BOOLEAN, VOID, collectionKind, collectionOf, type OperationInfo, type PrimitiveName,
    type PropertyInfo, type Type, type TypeSpace,
} from './types.js';

/** Kind IDs are qualified (`uml.Class`); feature names aren't. */
export interface ExpressionBinding {
    /** The profile whose kinds it names. */
    profile: string;
    /** Kinds whose elements are classes, their attributes and operations, and how they're related. */
    classes: {
        kinds: string[];
        attributes: string;
        operations: string;
        /** Elements in this containment name a general class through this reference. */
        generalizations?: { contains: string; general: string };
    };
    attribute: { type: string; multiplicity?: string; ordered?: string; unique?: string; readOnly?: string };
    operation: { returns?: string; parameters?: string; query?: string };
    parameter: { type: string; multiplicity?: string };
    /** Elements of these kinds named as here are the primitive types (UML's PrimitiveTypes). */
    primitives: { kinds: string[]; names: Record<string, PrimitiveName> };
    /** `self` is the nearest element around an expression of these kinds, but not of these (a behavior's context is its class). */
    context: { kinds: string[]; except?: string[] };
    /** The slots holding expressions: a guard gives a Boolean, an effect changes things, a body is an operation's, a default an attribute's. */
    slots: Array<{ kind: string; feature: string; role: 'guard' | 'effect' | 'body' | 'default' }>;
}

/** Each feature role naming an expression slot, and what it holds. */
const SLOT_ROLES: Record<string, ExpressionBinding['slots'][number]['role']> = {
    guard: 'guard', effect: 'effect', entry: 'effect', exit: 'effect', doActivity: 'effect', body: 'body', default: 'default',
};

/** The primitive types, by the names elements of a `primitive` kind have. */
const PRIMITIVE_NAMES: Record<string, PrimitiveName> = { Boolean: 'Boolean', Integer: 'Integer', Real: 'Real', String: 'String' };

/**
 * The bindings the profiles declare with roles (`plays class`, `plays attributes`… see ROLES in
 * @arbor/ir): one for each profile with a kind playing `class`.
 */
export function expressionBindings(doc: IRDocument): ExpressionBinding[] {
    const index = new IRIndex(doc);
    const out: ExpressionBinding[] = [];
    for (const p of doc.profiles) {
        const playing = (role: string) => p.kinds.filter(k => k.roles?.includes(role)).map(k => k.id);
        const classes = playing('class');
        if (!classes.length) continue;
        // The feature of a kind (its own or inherited) playing a role.
        const feature = (kindId: string | undefined, role: string) => (kindId ? index.features(kindId).find(f => f.roles?.includes(role)) : undefined);
        const name = (kindId: string | undefined, role: string) => feature(kindId, role)?.name;
        const targetOf = (kindId: string | undefined, role: string) => { const f = feature(kindId, role); return f && f.feature !== 'property' ? f.target : undefined; };
        const cls = classes[0];
        const attribute = targetOf(cls, 'attributes'), operation = targetOf(cls, 'operations');
        const generalization = targetOf(cls, 'generalizations'), parameter = targetOf(operation, 'parameters');
        const generals = name(cls, 'generalizations'), general = name(generalization, 'general');
        out.push({
            profile: p.name,
            classes: {
                kinds: classes,
                attributes: name(cls, 'attributes') ?? '',
                operations: name(cls, 'operations') ?? '',
                ...(generals && general ? { generalizations: { contains: generals, general } } : {}),
            },
            attribute: {
                type: name(attribute, 'type') ?? '',
                ...opt('multiplicity', name(attribute, 'multiplicity')), ...opt('ordered', name(attribute, 'ordered')),
                ...opt('unique', name(attribute, 'unique')), ...opt('readOnly', name(attribute, 'readOnly')),
            },
            operation: { ...opt('returns', name(operation, 'returns')), ...opt('parameters', name(operation, 'parameters')), ...opt('query', name(operation, 'query')) },
            parameter: { type: name(parameter, 'type') ?? '', ...opt('multiplicity', name(parameter, 'multiplicity')) },
            primitives: { kinds: playing('primitive'), names: PRIMITIVE_NAMES },
            context: { kinds: classes, except: playing('behavior') },
            slots: p.kinds.flatMap(k => k.features.flatMap(f => (f.roles ?? []).flatMap(r =>
                SLOT_ROLES[r] ? [{ kind: k.id, feature: f.name, role: SLOT_ROLES[r] }] : []))),
        });
    }
    return out;
}

const opt = <K extends string>(key: K, value: string | undefined) => (value ? { [key]: value } as Record<K, string> : {});

/** `0..*`, `1`, `*`, `2..5` to an upper bound (null: unbounded). One value when not written. */
function upperOf(multiplicity: unknown): number | null {
    if (typeof multiplicity !== 'string' || !multiplicity.trim()) return 1;
    const upper = multiplicity.split('..').pop()!.trim();
    return upper === '*' ? null : Number.isFinite(Number(upper)) ? Number(upper) : 1;
}

/**
 * The classes a model describes, as a type space: a class's attributes and
 * operations (and its generals'), typed by the model's classes and primitive
 * types. Types are named by element ID (`lending.Loan`); `type(name)` also
 * finds a class by its name.
 */
export interface ClassWorld extends TypeSpace {
    /** The class type of an element, if it's a class (not a primitive type). */
    classOf(elementId: string): Type | undefined;
    /** The type a typed element (an attribute, a parameter, an operation's result) gives. */
    typeOf(element: IRElement, feature: string, multiplicity?: string): Type;
    /** A class's attribute elements, its generals' too (nearest first, each name once). */
    attributes(owner: string): IRElement[];
    /** The element of a class's operation (or a general's), for its body and parameters. */
    operationElement(owner: string, name: string): IRElement | undefined;
    index: IRIndex;
    binding: ExpressionBinding;
}

export function classWorld(doc: IRDocument, binding: ExpressionBinding): ClassWorld {
    const index = new IRIndex(doc);
    const isA = (el: IRElement, kinds: string[]) => kinds.some(k => index.isA(el.kind, k));
    const primitive = (el: IRElement): PrimitiveName | undefined =>
        isA(el, binding.primitives.kinds) ? binding.primitives.names[el.name] : undefined;
    const isClass = (el: IRElement) => isA(el, binding.classes.kinds) && !primitive(el);
    const byName = new Map<string, string>();
    for (const el of index.elements.values()) if (isClass(el) && el.name && !byName.has(el.name)) byName.set(el.name, el.id);

    const children = (el: IRElement, containment: string) =>
        el.children.flatMap(id => { const c = index.elements.get(id); return c && c.containedIn === containment ? [c] : []; });
    const generals = (el: IRElement): IRElement[] => {
        const g = binding.classes.generalizations;
        if (!g) return [];
        return children(el, g.contains).flatMap(x => (x.references[g.general] ?? []).flatMap(id => index.elements.get(id) ?? []));
    };
    /** The class and its generals, nearest first. */
    const lineage = (id: string): IRElement[] => {
        const out: IRElement[] = [];
        const walk = (el: IRElement | undefined) => {
            if (!el || out.includes(el)) return;
            out.push(el);
            generals(el).forEach(walk);
        };
        walk(index.elements.get(id));
        return out;
    };
    const member = (owner: string, containment: string, name: string) =>
        lineage(owner).flatMap(c => children(c, containment)).find(m => m.name === name);

    const classType = (el: IRElement): Type => ({ kind: 'class', name: el.id, label: el.name || el.id });
    const typeOf = (el: IRElement, feature: string, multiplicityFeature?: string): Type => {
        const target = index.elements.get(el.references[feature]?.[0] ?? '');
        const one: Type = !target ? ANY : primitive(target) ? { kind: 'primitive', name: primitive(target)! }
            : isClass(target) ? classType(target) : ANY;
        const upper = multiplicityFeature ? upperOf(index.get(el, multiplicityFeature)) : 1;
        if (upper !== null && upper <= 1) return one;
        const a = binding.attribute;
        const ordered = a.ordered ? index.get(el, a.ordered) === true : false;
        const unique = a.unique ? index.get(el, a.unique) !== false : true;
        return collectionOf(collectionKind(ordered, unique), one);
    };

    return {
        index,
        binding,
        typeOf,
        attributes: owner => {
            const seen = new Set<string>();
            return lineage(owner).flatMap(c => children(c, binding.classes.attributes)).filter(a => !seen.has(a.name) && !!seen.add(a.name));
        },
        operationElement: (owner, name) => member(owner, binding.classes.operations, name),
        type: name => {
            const el = index.elements.get(byName.get(name) ?? name);
            return el && isClass(el) ? classType(el) : undefined;
        },
        classOf: id => { const el = index.elements.get(id); return el && isClass(el) ? classType(el) : undefined; },
        property: (owner, name): PropertyInfo | undefined => {
            const p = member(owner, binding.classes.attributes, name);
            if (!p) return undefined;
            const readonly = binding.attribute.readOnly ? index.get(p, binding.attribute.readOnly) === true : false;
            return { type: typeOf(p, binding.attribute.type, binding.attribute.multiplicity), readonly };
        },
        operation: (owner, name): OperationInfo | undefined => {
            const op = member(owner, binding.classes.operations, name);
            if (!op) return undefined;
            const o = binding.operation;
            const params = o.parameters ? children(op, o.parameters).map(p => ({ name: p.name, type: typeOf(p, binding.parameter.type, binding.parameter.multiplicity) })) : [];
            const returns = o.returns && op.references[o.returns]?.length ? typeOf(op, o.returns) : VOID;
            return { params, returns, query: o.query ? index.get(op, o.query) === true : false };
        },
        conforms: (sub, sup) => lineage(sub).some(c => c.id === sup),
        members: owner => lineage(owner).flatMap(c => [...children(c, binding.classes.attributes), ...children(c, binding.classes.operations)]).map(m => m.name),
    };
}

/** What an expression in this slot of this element is checked against, if its profile has a binding that names the slot. */
export function expressionContext(world: ClassWorld, binding: ExpressionBinding, el: IRElement, feature: string): CheckContext | undefined {
    const index = world.index;
    const slot = binding.slots.find(s => s.feature === feature && index.isA(el.kind, s.kind));
    if (!slot) return undefined;
    // `self`: the nearest class around it, past behaviors (a state machine's context is the class owning it).
    let self: Type | undefined;
    for (let p = el.parent ? index.elements.get(el.parent) : undefined; p; p = p.parent ? index.elements.get(p.parent) : undefined) {
        const fits = binding.context.kinds.some(k => index.isA(p!.kind, k)) && !(binding.context.except ?? []).some(k => index.isA(p!.kind, k));
        if (fits) { self = world.classOf(p.id); break; }
    }
    const base: CheckContext = { space: world, ...(self ? { self } : {}) };
    switch (slot.role) {
        case 'guard': return { ...base, mode: 'query', expected: BOOLEAN };
        case 'effect': return { ...base, mode: 'action' };
        case 'default': return { ...base, mode: 'query', expected: world.typeOf(el, binding.attribute.type, binding.attribute.multiplicity) };
        case 'body': {
            const o = binding.operation;
            const op = self?.kind === 'class' ? world.operation(self.name, el.name) : undefined;
            const query = o.query ? index.get(el, o.query) === true : false;
            const variables = Object.fromEntries((op?.params ?? []).map(p => [p.name, p.type]));
            return { ...base, mode: query ? 'query' : 'action', returns: op?.returns ?? VOID, variables };
        }
    }
}
