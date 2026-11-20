/**
 * Validation for profiles (M2) and models (M1).
 *
 * Every diagnostic carries a stable `code` (see DiagnosticCode) and, where one
 * exists, a machine-applicable suggestion in `data.fix`. That is what makes a
 * generate -> validate -> repair loop with an LLM cheap: the model gets
 * structured, specific errors instead of prose.
 *
 * Checks are a fixed set of handlers selected by profile data. Profiles never
 * supply code.
 */
import { AstUtils, type AstNode, type IndexManager, type ValidationAcceptor, type ValidationChecks } from 'langium';
import type {
    ContainsFeature, DataTypeDecl, EdgeVisual, Element, Feature, RecordValue, StereotypeDecl, Kind, ArborAstType, Model, Multiplicity, Profile, PropFeature, Slot, Value, Visual, VisualEntry
} from './generated/ast.js';
import { isElement, isListValue, isRecordValue, isRefValue } from './generated/ast.js';
import { EDGE_VISUAL_KEYS, OWNER_END, STRUCTURAL_VISUALS, VISUAL_KEYS, checkVisualValue, type VisualKeySpec } from '@arbor/ir';
import type { ArborServices } from './arbor-module.js';
import type { ArborScopeProvider } from './arbor-scope.js';
import {
    allFeatures, bounds, checkLiteral, closest, containmentCandidates, datatypeOf, elementFeatures, stereotypeApplies,
    displayName, elementId, findInheritanceCycle, hasModifier, isA, isRequired, lineage, literalValue,
    oppositeOf, redefinesOf, subsetsOf
} from './semantics.js';

export const DiagnosticCode = {
    // profiles
    DuplicateName: 'ARB001',
    InheritanceCycle: 'ARB002',
    FeatureShadowed: 'ARB003',
    BadDefault: 'ARB004',
    BadMultiplicity: 'ARB005',
    UnknownVisualKey: 'ARB006',
    AmbiguousName: 'ARB007',
    BadVisualValue: 'ARB008',
    BadOpposite: 'ARB009',
    BadSubsets: 'ARB010',
    BadRedefines: 'ARB011',
    BadStereotype: 'ARB012',
    BadVisualCondition: 'ARB013',
    // models
    AbstractInstance: 'ARB101',
    UnknownSlot: 'ARB102',
    TypeMismatch: 'ARB103',
    RefTargetKind: 'ARB104',
    MissingRequired: 'ARB105',
    ChildNotAllowed: 'ARB106',
    TooMany: 'ARB107',
    DuplicateSlot: 'ARB108',
    DerivedSlot: 'ARB109',
    DuplicateId: 'ARB110',
    DuplicateValue: 'ARB111',
    OppositeMismatch: 'ARB112',
    StereotypeNotApplicable: 'ARB113'
} as const;

export function registerValidationChecks(services: ArborServices): void {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.ArborValidator;
    const checks: ValidationChecks<ArborAstType> = {
        Profile: validator.checkProfile,
        Kind: validator.checkKind,
        StereotypeDecl: validator.checkStereotype,
        PropFeature: validator.checkPropFeature,
        Multiplicity: validator.checkMultiplicity,
        Visual: validator.checkVisual,
        EdgeVisual: validator.checkEdgeVisual,
        Model: validator.checkModel,
        Element: validator.checkElement
    };
    registry.register(checks, validator);
}

export class ArborValidator {
    private readonly scopes: ArborScopeProvider;
    private readonly index: IndexManager;

    constructor(services: ArborServices) {
        this.scopes = services.references.ScopeProvider;
        this.index = services.shared.workspace.IndexManager;
    }

    /** Profile and model names qualify everything inside them, so they must be unique workspace-wide. */
    private checkUniqueRoot(root: Profile | Model, accept: ValidationAcceptor): void {
        const uri = AstUtils.getDocument(root).uri.toString();
        const other = this.index.allElements(root.$type)
            .find(d => d.name === root.name && d.type === root.$type && d.documentUri.toString() !== uri);
        if (other) {
            accept('error', `Another ${root.$type.toLowerCase()} named '${root.name}' is defined in ${other.documentUri.path.replace(/^\//, '')}.`,
                { node: root, property: 'name', code: DiagnosticCode.DuplicateName });
        }
    }

    /** A simple name that several profiles (or models) define must be qualified. */
    checkAmbiguousReferences(root: Profile | Model, accept: ValidationAcceptor): void {
        for (const node of AstUtils.streamAst(root)) {
            for (const ref of AstUtils.streamReferences(node as AstNode)) {
                const options = this.scopes.ambiguousTargets(ref, 'ref' in ref.reference ? ref.reference.ref : undefined);
                if (options.length) {
                    accept('error',
                        `'${ref.reference.$refText}' is ambiguous (${options.join(', ')}); write the qualified name.`,
                        { node: ref.container, property: ref.property, index: ref.index,
                          code: DiagnosticCode.AmbiguousName, data: { candidates: options } });
                }
            }
        }
    }

    // ================================================================ profiles

    checkProfile(profile: Profile, accept: ValidationAcceptor): void {
        this.checkUniqueRoot(profile, accept);
        this.checkAmbiguousReferences(profile, accept);
        const seen = new Set<string>();
        for (const decl of [...profile.kinds, ...profile.enums, ...profile.datatypes, ...profile.stereotypes]) {
            if (seen.has(decl.name)) {
                accept('error', `Duplicate name '${decl.name}' in profile ${profile.name}.`,
                    { node: decl, property: 'name', code: DiagnosticCode.DuplicateName });
            }
            seen.add(decl.name);
        }
    }

    checkKind(kind: Kind, accept: ValidationAcceptor): void {
        const cycle = findInheritanceCycle(kind);
        if (cycle) {
            accept('error', `Inheritance cycle: ${cycle.map(k => k.name).join(' -> ')}.`,
                { node: kind, property: 'supers', code: DiagnosticCode.InheritanceCycle });
            return;
        }
        const own = new Set<string>();
        for (const f of kind.features) {
            if (own.has(f.name)) {
                accept('error', `Duplicate feature '${f.name}' in kind ${kind.name}.`,
                    { node: f, property: 'name', code: DiagnosticCode.DuplicateName });
            }
            own.add(f.name);
        }
        for (const sup of kind.supers) {
            const inherited = sup.ref ? allFeatures(sup.ref) : new Map();
            for (const f of kind.features) {
                const prev = inherited.get(f.name);
                if (prev && prev.$type !== f.$type) {
                    accept('error',
                        `Feature '${f.name}' redefines an inherited ${prev.$type} as a ${f.$type}.`,
                        { node: f, property: 'name', code: DiagnosticCode.FeatureShadowed });
                }
            }
        }
        for (const f of kind.features) {
            this.checkOpposite(kind, f, accept);
            this.checkSubsets(kind, f, accept);
            this.checkRedefines(kind, f, accept);
        }
    }

    /**
     * A stereotype adds properties and references to the kinds it extends, so its feature names
     * must be new to them; containment stays with the kinds.
     */
    checkStereotype(stereotype: StereotypeDecl, accept: ValidationAcceptor): void {
        for (const f of stereotype.features) {
            if (f.$type === 'ContainsFeature') {
                accept('error', `Stereotypes add properties and references, not containments ('${f.name}').`,
                    { node: f, code: DiagnosticCode.BadStereotype });
                continue;
            }
            for (const m of stereotype.metaclasses) {
                if (m.ref && allFeatures(m.ref).has(f.name)) {
                    accept('error', `'${f.name}' is already a feature of ${m.ref.name}, which ${stereotype.name} extends.`,
                        { node: f, property: 'name', code: DiagnosticCode.BadStereotype });
                }
            }
        }
    }

    /**
     * An opposite is a feature of the target kind that points back at this kind: a reference
     * (naming this feature back, if it names one) or a containment (then this is the owner, one at most).
     */
    private checkOpposite(kind: Kind, f: Feature, accept: ValidationAcceptor): void {
        const name = oppositeOf(f);
        const clause = f.clauses.find(c => c.$type === 'OppositeClause');
        if (!name || !clause) return;
        const fail = (message: string, fix?: string) =>
            accept('error', message, { node: clause, code: DiagnosticCode.BadOpposite, data: { fix } });
        if (f.$type === 'PropFeature') return fail('Only references and containments have opposites.');
        const target = f.target.ref;
        if (!target) return;
        const others = allFeatures(target);
        const other = others.get(name);
        if (!other) {
            const fix = closest(name, [...others.values()].filter(o => o.$type !== 'PropFeature').map(o => o.name));
            return fail(`${target.name} has no feature '${name}'.${fix ? ` Did you mean '${fix}'?` : ''}`, fix);
        }
        if (other.$type === 'PropFeature') return fail(`'${name}' of ${target.name} is a property; an opposite is a reference or a containment.`);
        if (other.target.ref && !isA(kind, other.target.ref)) {
            return fail(`'${name}' of ${target.name} points at ${other.target.ref.name}, not ${kind.name}.`);
        }
        if (f.$type === 'ContainsFeature' && other.$type === 'ContainsFeature') return fail('Two containments cannot be opposites.');
        const back = oppositeOf(other);
        if (back && back !== f.name) return fail(`'${name}' of ${target.name} names '${back}' as its opposite, not '${f.name}'.`);
        if (other.$type === 'ContainsFeature' && bounds(f.multiplicity, f.$type).upper !== 1) {
            fail(`'${f.name}' is the owner through '${name}', so it holds one element at most: write [0..1] or [1].`);
        }
    }

    /** A feature subsets features of the same kind, of the same sort and type, that allow as many values. */
    private checkSubsets(kind: Kind, f: Feature, accept: ValidationAcceptor): void {
        const names = subsetsOf(f);
        const clause = f.clauses.find(c => c.$type === 'SubsetsClause');
        if (!names.length || !clause) return;
        const features = allFeatures(kind);
        for (const name of names) {
            const fail = (message: string, fix?: string) =>
                accept('error', message, { node: clause, code: DiagnosticCode.BadSubsets, data: { fix } });
            const sup = features.get(name);
            if (!sup) {
                const fix = closest(name, [...features.keys()].filter(n => n !== f.name));
                fail(`${kind.name} has no feature '${name}' to subset.${fix ? ` Did you mean '${fix}'?` : ''}`, fix);
                continue;
            }
            if (sup === f) { fail(`'${f.name}' cannot subset itself.`); continue; }
            const problem = this.featureMismatch(f, sup);
            if (problem) { fail(`'${f.name}' cannot subset '${name}': ${problem}.`); continue; }
            const mine = bounds(f.multiplicity, f.$type).upper, theirs = bounds(sup.multiplicity, sup.$type).upper;
            if (theirs !== null && (mine === null || mine > theirs)) {
                fail(`'${f.name}' allows more values than '${name}' (${theirs}), which holds them all.`);
            }
        }
    }

    /** A feature redefines inherited features of the same sort and type. */
    private checkRedefines(kind: Kind, f: Feature, accept: ValidationAcceptor): void {
        const names = redefinesOf(f);
        const clause = f.clauses.find(c => c.$type === 'RedefinesClause');
        if (!names.length || !clause) return;
        const inherited = new Map<string, Feature>();
        for (const sup of kind.supers) if (sup.ref) for (const [n, g] of allFeatures(sup.ref)) if (!inherited.has(n)) inherited.set(n, g);
        for (const name of names) {
            const fail = (message: string, fix?: string) =>
                accept('error', message, { node: clause, code: DiagnosticCode.BadRedefines, data: { fix } });
            const prev = inherited.get(name);
            if (!prev) {
                const fix = closest(name, inherited.keys());
                fail(`${kind.name} inherits no feature '${name}' to redefine.${fix ? ` Did you mean '${fix}'?` : ''}`, fix);
                continue;
            }
            const problem = this.featureMismatch(f, prev);
            if (problem) fail(`'${f.name}' cannot redefine '${name}': ${problem}.`);
        }
    }

    /** Why `f`'s values can't stand for `g`'s: a different sort of feature, or a type that isn't g's (or a kind of it). */
    private featureMismatch(f: Feature, g: Feature): string | undefined {
        if (f.$type !== g.$type) return `one is a ${sortOf(f)}, the other a ${sortOf(g)}`;
        if (f.$type === 'PropFeature' && g.$type === 'PropFeature') {
            const type = (p: PropFeature) => (p.type.$type === 'PrimitiveTypeRef' ? p.type.primitive : p.type.decl.ref);
            return type(f) === type(g) ? undefined : 'their types differ';
        }
        if (f.$type !== 'PropFeature' && g.$type !== 'PropFeature' && f.target.ref && g.target.ref && !isA(f.target.ref, g.target.ref)) {
            return `${f.target.ref.name} isn't ${g.target.ref.name} or a kind of it`;
        }
        return undefined;
    }

    checkPropFeature(prop: PropFeature, accept: ValidationAcceptor): void {
        if (!prop.default) return;
        const datatype = datatypeOf(prop);
        if (datatype) {
            accept('error', `'${prop.name}' takes ${datatype.name} values, which have no default.`,
                { node: prop, property: 'default', code: DiagnosticCode.BadDefault });
            return;
        }
        const problem = checkLiteral(prop, prop.default);
        if (problem) {
            accept('error', `Default for '${prop.name}': ${problem}.`,
                { node: prop, property: 'default', code: DiagnosticCode.BadDefault });
        }
    }

    checkMultiplicity(m: Multiplicity, accept: ValidationAcceptor): void {
        const nonNeg = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n >= 0);
        if (!nonNeg(m.lower) || !nonNeg(m.upper)) {
            accept('error', 'Multiplicity bounds must be non-negative integers.',
                { node: m, code: DiagnosticCode.BadMultiplicity });
        } else if (m.upper !== undefined && m.lower !== undefined && m.upper < m.lower) {
            accept('error', `Upper bound ${m.upper} is below lower bound ${m.lower}.`,
                { node: m, property: 'upper', code: DiagnosticCode.BadMultiplicity });
        }
    }

    /** Keys and values come from the IR's renderer-neutral visual vocabulary. Unknown ones are warnings. */
    checkVisual(visual: Visual, accept: ValidationAcceptor): void {
        this.checkVisualEntries(visual.entries, VISUAL_KEYS, accept);
        if (visual.when) this.checkVisualCondition(visual, accept);
        // An edge kind's ends are references of the kind (or its owner).
        const kind = visual.$container;
        if (kind.$type !== 'Kind') return;   // a stereotype's visuals restyle; they don't make edges
        const refs = [...allFeatures(kind).values()].filter(f => f.$type === 'RefFeature').map(f => f.name);
        for (const e of visual.entries) {
            if (e.key !== 'source' && e.key !== 'target') continue;
            const value = literalValue(e.value);
            if (typeof value !== 'string' || value === OWNER_END || refs.includes(value)) continue;
            const fix = closest(value, [OWNER_END, ...refs]);
            accept('warning',
                `Visual '${e.key}': ${kind.name} has no reference '${value}' (or use "${OWNER_END}").${fix ? ` Did you mean '${fix}'?` : ''}`,
                { node: e, property: 'value', code: DiagnosticCode.BadVisualValue, data: { fix } });
        }
        const keys = new Set(lineage(kind).flatMap(k => k.visuals.filter(v => !v.when).flatMap(v => v.entries.map(e => e.key))));
        if (visual === kind.visuals.at(-1) && keys.has('source') !== keys.has('target')) {
            accept('warning', `Visual: an edge kind needs both 'source' and 'target'.`,
                { node: visual, code: DiagnosticCode.BadVisualValue });
        }
    }

    /**
     * `visual when p = v { ... }`: `p` is a single-valued property of the kind, not a datatype,
     * `v` fits its type, and the block only restyles, as a stereotype's visuals do.
     */
    private checkVisualCondition(visual: Visual, accept: ValidationAcceptor): void {
        const when = visual.when!;
        const fail = (message: string, property: 'feature' | 'value', fix?: string) =>
            accept('error', message, { node: when, property, code: DiagnosticCode.BadVisualCondition, data: { fix } });
        const kind = visual.$container;
        if (kind.$type !== 'Kind') {
            return fail(`A stereotype's visuals apply to every element it's applied to; 'visual when' is for kinds.`, 'feature');
        }
        const features = allFeatures(kind);
        const f = features.get(when.feature);
        const props = [...features.values()].filter(g => g.$type === 'PropFeature').map(g => g.name);
        if (!f) {
            const fix = closest(when.feature, props);
            return fail(`${kind.name} has no property '${when.feature}'.${fix ? ` Did you mean '${fix}'?` : ''}`, 'feature', fix);
        }
        if (f.$type !== 'PropFeature') return fail(`'${when.feature}' is a ${f.$type === 'RefFeature' ? 'reference' : 'containment'}; 'visual when' tests a property's value.`, 'feature');
        if (bounds(f.multiplicity, f.$type).upper !== 1) return fail(`'${when.feature}' holds several values; 'visual when' tests a property with one.`, 'feature');
        if (datatypeOf(f)) return fail(`'${when.feature}' holds ${datatypeOf(f)!.name} values; 'visual when' tests a string, number, bool or enum.`, 'feature');
        const problem = checkLiteral(f, when.value);
        if (problem) return fail(`'${when.feature} = …': ${problem}.`, 'value');
        for (const e of visual.entries) {
            if (STRUCTURAL_VISUALS.has(e.key)) {
                accept('warning', `Visual '${e.key}' decides how every ${kind.name} is laid out, so 'visual when' can't change it; it's ignored here.`,
                    { node: e, property: 'key', code: DiagnosticCode.BadVisualCondition });
            }
        }
    }

    /** A feature's edge style: the edge keys only. */
    checkEdgeVisual(edge: EdgeVisual, accept: ValidationAcceptor): void {
        this.checkVisualEntries(edge.entries, EDGE_VISUAL_KEYS, accept);
    }

    private checkVisualEntries(entries: VisualEntry[], keys: Record<string, VisualKeySpec>, accept: ValidationAcceptor): void {
        for (const e of entries) {
            if (!Object.hasOwn(keys, e.key)) {
                const fix = closest(e.key, Object.keys(keys));
                accept('warning',
                    `Unknown visual key '${e.key}'.${fix ? ` Did you mean '${fix}'?` : ''}`,
                    { node: e, property: 'key', code: DiagnosticCode.UnknownVisualKey, data: { fix } });
                continue;
            }
            const value = literalValue(e.value);
            const problem = checkVisualValue(e.key, value, keys);
            if (problem) {
                const spec = keys[e.key];
                const fix = spec.values && typeof value === 'string' ? closest(value, spec.values) : undefined;
                accept('warning',
                    `Visual '${e.key}': ${problem}.${fix ? ` Did you mean '${fix}'?` : ''}`,
                    { node: e, property: 'value', code: DiagnosticCode.BadVisualValue, data: { fix } });
            }
        }
    }

    // ================================================================ models

    checkModel(model: Model, accept: ValidationAcceptor): void {
        this.checkUniqueRoot(model, accept);
        this.checkAmbiguousReferences(model, accept);
        const seen = new Map<string, Element>();
        const walk = (els: Element[]) => {
            for (const el of els) {
                const id = elementId(el);
                if (seen.has(id)) {
                    accept('error', `Duplicate element ID '${id}'.`,
                        { node: el, property: el.stableId ? 'stableId' : 'name', code: DiagnosticCode.DuplicateId });
                }
                seen.set(id, el);
                walk(el.children);
            }
        };
        walk(model.elements);
    }

    checkElement(el: Element, accept: ValidationAcceptor): void {
        const kind = el.kind.ref;
        if (!kind) return; // unresolved kind is already reported by the linker

        if (kind.abstract) {
            accept('error', `Kind ${kind.name} is abstract and cannot be instantiated.`,
                { node: el, property: 'kind', code: DiagnosticCode.AbstractInstance });
        }

        const features = elementFeatures(el);
        const given = new Set<string>();
        this.checkAppliedStereotypes(el, kind, accept);

        for (const slot of el.slots) {
            if (given.has(slot.name)) {
                accept('error', `Slot '${slot.name}' is set more than once.`,
                    { node: slot, property: 'name', code: DiagnosticCode.DuplicateSlot });
            }
            given.add(slot.name);
            this.checkSlot(kind, slot, features, accept);
        }

        // Nested children: each goes into the containment it names, or the only one its kind fits.
        const counts = new Map<string, number>();
        for (const child of el.children) {
            const childKind = child.kind.ref;
            if (!childKind) continue;
            const c = child.feature
                ? this.checkNamedContainment(kind, child, childKind, accept)
                : this.checkImpliedContainment(kind, child, childKind, accept);
            if (c) {
                counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
                given.add(c.name);
            }
        }
        for (const [name, n] of counts) {
            const f = features.get(name)!;
            const { upper } = bounds(f.multiplicity, f.$type);
            if (upper !== null && n > upper) {
                accept('error', `'${name}' allows at most ${upper}, found ${n}.`,
                    { node: el, property: 'children', code: DiagnosticCode.TooMany });
            }
        }

        for (const f of features.values()) {
            if (!given.has(f.name) && isRequired(f)) {
                accept('error', `${kind.name} ${el.name ?? '(unnamed)'} is missing required '${f.name}'.`,
                    { node: el, property: 'name', code: DiagnosticCode.MissingRequired, data: { fix: f.name } });
            }
        }

        if (el.feature && !isElement(el.$container)) {
            accept('error', `'${el.feature} +=' names a containment of the parent, but ${el.name ?? 'this element'} is at the top level.`,
                { node: el, property: 'feature', code: DiagnosticCode.ChildNotAllowed });
        }
    }

    /** A nested element without `feature +=` must fit exactly one containment of its parent. */
    private checkImpliedContainment(kind: Kind, child: Element, childKind: Kind, accept: ValidationAcceptor): ContainsFeature | undefined {
        const candidates = containmentCandidates(kind, childKind);
        if (candidates.length === 0) {
            accept('error', `${kind.name} cannot contain ${childKind.name} elements.`,
                { node: child, property: 'kind', code: DiagnosticCode.ChildNotAllowed });
            return undefined;
        }
        if (candidates.length > 1) {
            const names = candidates.map(c => c.name);
            accept('error',
                `${childKind.name} fits several containments of ${kind.name} (${names.join(', ')}); ` +
                `name the one that holds it, e.g. '${names[0]} += ${childKind.name} ...'.`,
                { node: child, property: 'kind', code: DiagnosticCode.ChildNotAllowed, data: { candidates: names } });
            return undefined;
        }
        return candidates[0];
    }

    /** A nested element written `feature += Kind ...` goes into that containment, which must be able to hold it. */
    private checkNamedContainment(kind: Kind, child: Element, childKind: Kind, accept: ValidationAcceptor): ContainsFeature | undefined {
        const name = child.feature!;
        const fail = (message: string, fix?: string) => {
            accept('error', message, { node: child, property: 'feature', code: DiagnosticCode.ChildNotAllowed, data: { fix } });
            return undefined;
        };
        const fitting = containmentCandidates(kind, childKind).map(c => c.name);
        const f = allFeatures(kind).get(name);
        if (!f) {
            const fix = closest(name, fitting) ?? closest(name, [...allFeatures(kind).values()].filter(g => g.$type === 'ContainsFeature').map(g => g.name));
            return fail(`${kind.name} has no containment '${name}'.${fix ? ` Did you mean '${fix}'?` : ''}`, fix);
        }
        if (f.$type !== 'ContainsFeature') {
            return fail(`'${name}' of ${kind.name} is a ${f.$type === 'RefFeature' ? 'reference' : 'property'}, not a containment; set it as a slot (${name}: ...).`);
        }
        if (hasModifier(f, 'derived')) {
            const fix = fitting.length === 1 ? fitting[0] : undefined;
            return fail(`'${name}' of ${kind.name} is derived and holds nothing directly; ` +
                (fitting.length ? `use a containment that subsets it (${fitting.join(', ')}).` : `no containment that subsets it holds ${childKind.name}.`), fix);
        }
        const target = f.target.ref;
        if (target && !isA(childKind, target)) {
            const fix = fitting.length === 1 ? fitting[0] : undefined;
            return fail(`'${name}' of ${kind.name} holds ${target.name} elements, not ${childKind.name}.${fix ? ` Did you mean '${fix}'?` : ''}`, fix);
        }
        return target ? f : undefined;
    }

    /**
     * Both ends of a pair of written opposite references must agree: an element this one
     * points at points back. Derived ends are worked out, so they always agree.
     */
    private checkOppositeValues(slot: Slot, f: import('./generated/ast.js').RefFeature, accept: ValidationAcceptor): void {
        const name = oppositeOf(f);
        const target = f.target.ref;
        if (!name || !target) return;
        const other = allFeatures(target).get(name);
        if (other?.$type !== 'RefFeature' || hasModifier(other, 'derived')) return;
        const el = AstUtils.getContainerOfType(slot, isElement);
        if (!el) return;
        const id = elementId(el);
        const items: Value[] = isListValue(slot.value) ? slot.value.items : [slot.value];
        for (const v of items) {
            const t = isRefValue(v) ? v.target.ref : undefined;
            if (!t || !isElement(t)) continue;
            const back = t.slots.find(s => s.name === name);
            const values = back ? (isListValue(back.value) ? back.value.items : [back.value]) : [];
            const points = values.some(b => isRefValue(b) && b.target.ref && isElement(b.target.ref) && elementId(b.target.ref) === id);
            if (!points) {
                accept('warning', `'${slot.name}' and '${name}' are opposites, but ${displayName(t)}'s '${name}' doesn't point back at ${displayName(el)}.`,
                    { node: v, code: DiagnosticCode.OppositeMismatch, data: { element: elementId(t), slot: name } });
            }
        }
    }

    /** Each applied stereotype extends the element's kind, is applied once, and adds names no other one does. */
    private checkAppliedStereotypes(el: Element, kind: Kind, accept: ValidationAcceptor): void {
        const seen = new Map<string, StereotypeDecl>();   // feature name -> the stereotype adding it
        const applied = new Set<StereotypeDecl>();
        el.stereotypes.forEach((ref, index) => {
            const s = ref.ref;
            if (!s) return;
            if (!stereotypeApplies(s, kind)) {
                const to = s.metaclasses.map(m => m.ref?.name ?? m.$refText).join(', ');
                accept('error', `${s.name} applies to ${to}, not ${kind.name}.`,
                    { node: el, property: 'stereotypes', index, code: DiagnosticCode.StereotypeNotApplicable });
                return;
            }
            if (applied.has(s)) {
                accept('error', `${s.name} is applied twice.`,
                    { node: el, property: 'stereotypes', index, code: DiagnosticCode.StereotypeNotApplicable });
                return;
            }
            for (const f of s.features) {
                const other = seen.get(f.name);
                if (other) {
                    accept('error', `${s.name} and ${other.name} both add '${f.name}', so it would be ambiguous here.`,
                        { node: el, property: 'stereotypes', index, code: DiagnosticCode.StereotypeNotApplicable });
                } else {
                    seen.set(f.name, s);
                }
            }
            applied.add(s);
        });
    }

    /** A datatype's value: known fields, each set once and fitting its type, and the required ones set. */
    private checkRecord(record: RecordValue, datatype: DataTypeDecl, accept: ValidationAcceptor): void {
        const features = new Map<string, Feature>(datatype.features.map(f => [f.name, f]));
        const given = new Set<string>();
        for (const slot of record.slots) {
            if (given.has(slot.name)) {
                accept('error', `Field '${slot.name}' is set more than once.`,
                    { node: slot, property: 'name', code: DiagnosticCode.DuplicateSlot });
            }
            given.add(slot.name);
            this.checkSlot(datatype, slot, features, accept);
        }
        for (const f of datatype.features) {
            if (!given.has(f.name) && isRequired(f)) {
                accept('error', `This ${datatype.name} is missing required '${f.name}'.`,
                    { node: record, code: DiagnosticCode.MissingRequired, data: { fix: f.name } });
            }
        }
    }

    private checkSlot(kind: Kind | DataTypeDecl, slot: Slot, features: Map<string, Feature>, accept: ValidationAcceptor): void {
        const f = features.get(slot.name);
        if (!f) {
            const fix = closest(slot.name, features.keys());
            accept('error',
                `${kind.name} has no feature '${slot.name}'.${fix ? ` Did you mean '${fix}'?` : ''}`,
                { node: slot, property: 'name', code: DiagnosticCode.UnknownSlot, data: { fix } });
            return;
        }
        if (f.$type === 'ContainsFeature') {
            accept('error', `'${slot.name}' is a containment; nest the elements inside instead of assigning them.`,
                { node: slot, property: 'name', code: DiagnosticCode.TypeMismatch });
            return;
        }
        if (hasModifier(f, 'derived')) {
            const from = oppositeOf(f) ? ` from the elements' '${oppositeOf(f)}'` : '';
            accept('error', `'${slot.name}' is derived: it is worked out${from}, not written.`,
                { node: slot, property: 'name', code: DiagnosticCode.DerivedSlot });
            return;
        }

        const items: Value[] = isListValue(slot.value) ? slot.value.items : [slot.value];
        const { upper } = bounds(f.multiplicity, f.$type);
        if (isListValue(slot.value) && upper === 1) {
            accept('error', `'${slot.name}' takes a single value, not a list.`,
                { node: slot, property: 'value', code: DiagnosticCode.TooMany });
        } else if (upper !== null && items.length > upper) {
            accept('error', `'${slot.name}' allows at most ${upper} values, found ${items.length}.`,
                { node: slot, property: 'value', code: DiagnosticCode.TooMany });
        }

        if (hasModifier(f, 'unique')) {
            const seen = new Set<string>();
            for (const v of items) {
                const key = isRefValue(v) ? `->${v.target.ref ? elementId(v.target.ref as Element) : v.target.$refText}`
                    : isListValue(v) ? '' : isRecordValue(v) ? `{${v.$cstNode?.text.replace(/\s+/g, ' ') ?? ''}` : JSON.stringify(literalValue(v));
                if (key && seen.has(key)) {
                    accept('error', `'${slot.name}' is unique; this value is already in it.`,
                        { node: v, code: DiagnosticCode.DuplicateValue });
                }
                seen.add(key);
            }
        }
        if (f.$type === 'RefFeature') this.checkOppositeValues(slot, f, accept);

        for (const v of items) {
            if (f.$type === 'RefFeature') {
                if (!isRefValue(v)) {
                    accept('error', `'${slot.name}' is a reference; write -> Name.`,
                        { node: v, code: DiagnosticCode.TypeMismatch });
                    continue;
                }
                const target = v.target.ref;
                const want = f.target.ref;
                if (target && want && isElement(target) && target.kind.ref && !isA(target.kind.ref, want)) {
                    accept('error', `'${slot.name}' must point to a ${want.name}, but ${displayName(target)} is a ${target.kind.ref.name}.`,
                        { node: v, property: 'target', code: DiagnosticCode.RefTargetKind });
                }
            } else {
                if (isRefValue(v) || isListValue(v)) {
                    accept('error', `'${slot.name}' expects a value, not a ${isRefValue(v) ? 'reference' : 'nested list'}.`,
                        { node: v, code: DiagnosticCode.TypeMismatch });
                    continue;
                }
                // A datatype's value is a record of its fields, checked like an element's slots.
                const datatype = datatypeOf(f);
                if (isRecordValue(v) || datatype) {
                    if (isRecordValue(v) && datatype) this.checkRecord(v, datatype, accept);
                    else accept('error', datatype
                        ? `'${slot.name}' takes ${datatype.name} values: write { field: value ... }.`
                        : `'${slot.name}' expects a value, not { ... }.`, { node: v, code: DiagnosticCode.TypeMismatch });
                    continue;
                }
                const problem = checkLiteral(f, v);
                if (problem) {
                    accept('error', `'${slot.name}': ${problem}.`,
                        { node: v, code: DiagnosticCode.TypeMismatch });
                }
            }
        }
    }
}

function sortOf(f: Feature): string {
    return f.$type === 'PropFeature' ? 'property' : f.$type === 'RefFeature' ? 'reference' : 'containment';
}
