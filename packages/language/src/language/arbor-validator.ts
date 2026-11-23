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
import { AstUtils, GrammarUtils, type AstNode, type AstNodeDescription, type CstNode, type IndexManager, type LangiumDocuments, type ValidationAcceptor, type ValidationChecks } from 'langium';
import type { Range } from 'vscode-languageserver-types';
import {
    BOOLEAN, EvalError, checkBlock, checkExpression, classWorld, evaluate, expressionBindings, expressionContext, irTypeSpace, irValueSpace,
    parseBlock, parseExpression, type CheckContext, type ClassWorld, type DeriveFailure, type ExprDiagnostic, type ExpressionBinding,
} from '@arbor/expr';
import type { IRDocument } from '@arbor/ir';
import { toIRWithFailures } from '../ir/ast-to-ir.js';
import type {
    ContainsFeature, DataTypeDecl, EdgeVisual, Element, Feature, RecordValue, StereotypeDecl, Kind, ArborAstType, Model, Multiplicity, Profile, PropFeature, Slot, Value, Visual, VisualEntry
} from './generated/ast.js';
import { isElement, isEnumDecl, isKind, isListValue, isModel, isProfile, isRecordValue, isRefValue, isStringLit, type StringLit } from './generated/ast.js';
import { EDGE_VISUAL_KEYS, OWNER_END, ROLES, STRUCTURAL_VISUALS, VISUAL_KEYS, checkVisualValue, isRole, type RoleSpec, type VisualKeySpec } from '@arbor/ir';
import type { ArborServices } from './arbor-module.js';
import type { ArborScopeProvider } from './arbor-scope.js';
import {
    allFeatures, bounds, checkLiteral, closest, containmentCandidates, datatypeOf, elementFeatures, stereotypeApplies,
    displayName, elementId, findInheritanceCycle, hasModifier, isA, isRequired, lineage, literalValue,
    containmentOf, deriveOf, kindId, oppositeOf, redefinesOf, rolesOf, subsetsOf
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
    BadDerive: 'ARB014',
    BadRole: 'ARB015',
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
    StereotypeNotApplicable: 'ARB113',
    NotContained: 'ARB114',
    BrokenInvariant: 'ARB115',
    DeriveFailed: 'ARB116'
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
    private readonly documents: LangiumDocuments;
    /** The workspace as IR, and what's built from it, for the documents as they are now. */
    private cache: {
        key: string; ir: IRDocument; failures: DeriveFailure[];
        types: ReturnType<typeof irTypeSpace>; values: ReturnType<typeof irValueSpace>; worlds: Map<string, ClassWorld>;
        bindings: ExpressionBinding[];
    } | undefined;

    constructor(services: ArborServices) {
        this.scopes = services.references.ScopeProvider;
        this.index = services.shared.workspace.IndexManager;
        this.documents = services.shared.workspace.LangiumDocuments;
    }

    /** Profile and model names qualify everything inside them, so they must be unique workspace-wide. */
    private checkUniqueRoot(root: Profile | Model, accept: ValidationAcceptor): void {
        const uri = AstUtils.getDocument(root).uri.toString();
        const others = this.index.allElements(root.$type)
            .filter(d => d.name === root.name && d.type === root.$type && d.documentUri.toString() !== uri).toArray();
        const where = (d: AstNodeDescription) => d.documentUri.path.replace(/^\//, '');
        if (isProfile(root)) {
            // Parts of one profile: each names itself, differently, and they agree on the version.
            for (const d of others) {
                const other = this.nodeOf(d);
                if (!isProfile(other)) continue;
                if (!root.part || !other.part) {
                    accept('error', `Another profile named '${root.name}' is defined in ${where(d)}. To write one profile in several files, name each part: profile ${root.name} part "…" { … }.`,
                        { node: root, property: 'name', code: DiagnosticCode.DuplicateName });
                } else if (root.part === other.part) {
                    accept('error', `Profile ${root.name} has another part "${root.part}", in ${where(d)}.`,
                        { node: root, property: 'part', code: DiagnosticCode.DuplicateName });
                } else if (root.version && other.version && root.version !== other.version) {
                    accept('error', `Part "${other.part}" of ${root.name} says version "${other.version}", this one "${root.version}".`,
                        { node: root, property: 'version', code: DiagnosticCode.DuplicateName });
                }
            }
            // A name is defined once in the whole profile.
            for (const decl of [...root.kinds, ...root.enums, ...root.datatypes, ...root.stereotypes]) {
                const twin = this.index.allElements(decl.$type)
                    .find(d => d.name === `${root.name}.${decl.name}` && d.documentUri.toString() !== uri);
                if (twin) {
                    accept('error', `${decl.name} is also defined in another part of ${root.name}, in ${where(twin)}.`,
                        { node: decl, property: 'name', code: DiagnosticCode.DuplicateName });
                }
            }
            return;
        }
        if (others.length) {
            accept('error', `Another ${root.$type.toLowerCase()} named '${root.name}' is defined in ${where(others[0])}.`,
                { node: root, property: 'name', code: DiagnosticCode.DuplicateName });
        }
    }

    private nodeOf(d: AstNodeDescription): AstNode | undefined {
        if (d.node) return d.node;
        if (!this.documents.hasDocument(d.documentUri)) return undefined;
        return this.documents.getDocument(d.documentUri)!.parseResult.value;
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
        this.checkKindExpressions(kind, accept);
        this.checkRoles(kind, accept);
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
            // A reference may subset a containment (it picks among what that holds, like UML's classifierBehavior),
            // and a containment a reference (a derived union of members, like UML's Classifier::attribute).
            const problem = this.featureMismatch(f, sup, true);
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
    /** Why `f` can't subset or redefine `g`, if it can't. `across`: a reference and a containment may subset each other. */
    private featureMismatch(f: Feature, g: Feature, across = false): string | undefined {
        const elementsBoth = f.$type !== 'PropFeature' && g.$type !== 'PropFeature';
        if (f.$type !== g.$type && !(across && elementsBoth)) return `one is a ${sortOf(f)}, the other a ${sortOf(g)}`;
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
        this.checkInvariants(el, kind, accept);

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
     * A reference that subsets a containment names only elements that containment holds
     * (UML: a class's classifierBehavior is one of its ownedBehaviors).
     */
    private checkSubsetsContainment(slot: Slot, f: import('./generated/ast.js').RefFeature, features: Map<string, Feature>, accept: ValidationAcceptor): void {
        const el = slot.$container;
        if (!isElement(el)) return;
        for (const name of subsetsOf(f)) {
            const sup = features.get(name);
            if (sup?.$type !== 'ContainsFeature') continue;
            // What it holds: its children, and those of the containments that subset it.
            const reaches = (g: Feature | undefined, seen = new Set<string>()): boolean => {
                if (!g || seen.has(g.name)) return false;
                if (g.name === name) return true;
                seen.add(g.name);
                return subsetsOf(g).some(s => reaches(features.get(s), seen));
            };
            const held = el.children.filter(c => reaches(containmentOf(c)));
            for (const v of isListValue(slot.value) ? slot.value.items : [slot.value]) {
                const target = isRefValue(v) ? v.target.ref : undefined;
                if (!isElement(target) || held.includes(target)) continue;
                accept('error', `'${slot.name}' subsets '${name}', so it names one of the elements this ${el.kind.ref?.name ?? 'element'} holds there; ${displayName(target)} isn't.`,
                    { node: v, code: DiagnosticCode.NotContained, data: { candidates: held.map(c => c.name).filter(Boolean) } });
            }
        }
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
        if (f.$type === 'RefFeature') {
            this.checkOppositeValues(slot, f, accept);
            this.checkSubsetsContainment(slot, f, features, accept);
        }

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
                } else if (isStringLit(v) && f.type.$type === 'PrimitiveTypeRef' && (f.type.primitive === 'expr' || f.type.primitive === 'action')) {
                    this.checkExpressionSlot(slot, f, v, f.type.primitive === 'action', accept);
                }
            }
        }
    }

    /**
     * An `expr` or `action` slot: its text parses; and, where its profile's binding names the slot,
     * it type-checks against what `self` is there (see @arbor/expr's binding.ts). Problems point into the string.
     */
    private checkExpressionSlot(slot: Slot, f: PropFeature, lit: StringLit, action: boolean, accept: ValidationAcceptor): void {
        const report = (ds: ExprDiagnostic[]) => {
            for (const d of ds) accept(d.severity, d.message, { node: lit, range: rangeInString(lit, d.start, d.end), code: d.code });
        };
        const parsed = action ? parseBlock(lit.value) : parseExpression(lit.value);
        if (!parsed.value) return report(parsed.diagnostics);
        const owner = AstUtils.getContainerOfType(f, isKind);
        const profile = owner && AstUtils.getContainerOfType(owner, isProfile)?.name;
        const binding = this.workspace().bindings.find(b => b.profile === profile);
        const el = slot.$container;
        if (!binding || !isElement(el)) return;
        const world = this.worldOf(binding);
        const irElement = world.index.elements.get(elementId(el));
        const ctx = irElement && expressionContext(world, binding, irElement, slot.name);
        if (!ctx) return;
        const value = parsed.value;
        report('statements' in value ? checkBlock(value, ctx).diagnostics : checkExpression(value, ctx).diagnostics);
    }

    /** The classes the workspace's models describe, for a binding: rebuilt when a document changes. */
    private workspace() {
        const docs = this.documents.all.toArray();
        const key = docs.map(d => `${d.uri.toString()}@${d.textDocument.version}`).join('|');
        if (this.cache?.key !== key) {
            const roots = docs.map(d => d.parseResult.value).filter((r): r is Profile | Model => isProfile(r) || isModel(r));
            const { ir, failures } = toIRWithFailures(roots);
            this.cache = { key, ir, failures, types: irTypeSpace(ir), values: irValueSpace(ir), worlds: new Map(), bindings: expressionBindings(ir) };
        }
        return this.cache;
    }

    private worldOf(binding: ExpressionBinding): ClassWorld {
        const w = this.workspace();
        let world = w.worlds.get(binding.profile);
        if (!world) w.worlds.set(binding.profile, world = classWorld(w.ir, binding));
        return world;
    }

    /** Roles (`plays`) are ones the tools know (ROLES), played by the sort of kind or feature they're for. */
    private checkRoles(kind: Kind, accept: ValidationAcceptor): void {
        const known = Object.keys(ROLES);
        const fail = (node: AstNode, message: string, fix?: string) =>
            accept('error', message, { node, code: DiagnosticCode.BadRole, data: { fix } });
        const check = (role: string, node: AstNode, on: 'kind' | 'contains' | 'ref' | 'prop', type?: string): void => {
            if (!isRole(role)) {
                const fix = closest(role, known.filter(r => (ROLES as Record<string, RoleSpec>)[r].on === on));
                return fail(node, `There's no role '${role}'.${fix ? ` Did you mean '${fix}'?` : ''}`, fix);
            }
            const spec: RoleSpec = ROLES[role];
            const what = { kind: 'a kind', contains: 'a containment', ref: 'a reference', prop: 'a property' };
            if (spec.on !== on) return fail(node, `'${role}' is played by ${what[spec.on]}, not ${what[on]}.`);
            if (spec.type && type !== spec.type) fail(node, `'${role}' is played by a property of type ${spec.type}, not ${type ?? 'a datatype'}.`);
        };
        for (const role of kind.roles) check(role, kind, 'kind');
        for (const f of kind.features) {
            const clause = f.clauses.find(c => c.$type === 'PlaysClause');
            if (!clause) continue;
            const on = f.$type === 'PropFeature' ? 'prop' : f.$type === 'ContainsFeature' ? 'contains' : 'ref';
            const type = f.$type !== 'PropFeature' ? undefined
                : f.type.$type === 'PrimitiveTypeRef' ? f.type.primitive : isEnumDecl(f.type.decl.ref) ? 'enum' : undefined;
            for (const role of rolesOf(f)) check(role, clause, on, type);
        }
    }

    // ================================================================ rules in profiles

    /**
     * A kind's invariants, derived features' `derive` and queries' bodies: expressions about one of
     * its elements, checked against the profiles (kinds as classes); problems point into the string.
     */
    private checkKindExpressions(kind: Kind, accept: ValidationAcceptor): void {
        const { types } = this.workspace();
        const self = types.classOf(kindId(kind));
        const check = (node: AstNode, property: string, text: string, ctx: Omit<CheckContext, 'space' | 'self'>) => {
            const parsed = parseExpression(text);
            const ds = parsed.value ? checkExpression(parsed.value, { space: types, self, mode: 'query', ...ctx }).diagnostics : parsed.diagnostics;
            for (const d of ds) accept(d.severity, d.message, { node, range: rangeInProperty(node, property, d.start, d.end), code: d.code });
        };
        for (const inv of kind.invariants) check(inv, 'expr', inv.expr, { expected: BOOLEAN });
        for (const f of kind.features) {
            const clause = f.clauses.find(c => c.$type === 'DeriveClause');
            if (!clause || clause.$type !== 'DeriveClause') continue;
            if (!hasModifier(f, 'derived')) {
                accept('error', `'${f.name}' has an expression to work it out, so it's derived: write 'derived' before it.`,
                    { node: clause, code: DiagnosticCode.BadDerive });
                continue;
            }
            if (f.$type !== 'PropFeature' && oppositeOf(f)) {
                accept('error', `'${f.name}' is worked out from its opposite already; it can't also have an expression.`,
                    { node: clause, code: DiagnosticCode.BadDerive });
                continue;
            }
            const expected = types.property(kindId(kind), f.name)?.type;
            check(clause, 'expr', clause.expr, expected ? { expected } : {});
        }
        for (const op of kind.operations) {
            const info = types.operation(kindId(kind), op.name);
            const variables = Object.fromEntries((info?.params ?? []).map(p => [p.name, p.type]));
            check(op, 'body', op.body, { variables, ...(info ? { expected: info.returns } : {}) });
        }
    }

    /** The invariants of an element's kind (its ancestors' too) hold for it, and its derived features could be worked out. */
    private checkInvariants(el: Element, kind: Kind, accept: ValidationAcceptor): void {
        const rules = lineage(kind).flatMap(k => k.invariants.map(inv => ({ inv, k })));
        const derives = [...allFeatures(kind).values()].some(f => deriveOf(f));
        if (!rules.length && !derives) return;
        const { values, failures } = this.workspace();
        const id = elementId(el);
        const irElement = values.element(id);
        if (!irElement) return;
        const name = el.name ? `${kind.name} ${el.name}` : `This ${kind.name}`;
        for (const { inv, k } of rules) {
            const parsed = parseExpression(inv.expr);
            if (!parsed.value) continue;   // reported on the profile
            try {
                const kept = evaluate(parsed.value, { space: values, self: irElement });
                if (kept !== true) {
                    accept('error', `${name} breaks '${inv.name}'${k !== kind ? ` (of ${k.name})` : ''}: ${inv.message ?? inv.expr}`,
                        { node: el, property: el.name ? 'name' : 'kind', code: DiagnosticCode.BrokenInvariant, data: { invariant: inv.name } });
                }
            } catch (e) {
                if (!(e instanceof EvalError)) throw e;
                accept('warning', `'${inv.name}' couldn't be checked for ${name}: ${e.message}`,
                    { node: el, property: el.name ? 'name' : 'kind', code: DiagnosticCode.BrokenInvariant });
            }
        }
        for (const f of failures.filter(x => x.element === id)) {
            accept('warning', `'${f.feature}' of ${name} couldn't be worked out: ${f.message}`,
                { node: el, property: el.name ? 'name' : 'kind', code: DiagnosticCode.DeriveFailed });
        }
    }
}

function sortOf(f: Feature): string {
    return f.$type === 'PropFeature' ? 'property' : f.$type === 'RefFeature' ? 'reference' : 'containment';
}

/**
 * The range of characters `start` to `end` of a string literal's value, in its document: past the opening
 * quote, counting an escape (`\"`) as the one character it stands for.
 */
function rangeInString(lit: StringLit, start: number, end: number): Range {
    return rangeInText(lit.$cstNode!, start, end);
}

/** The same, for a string held by a node's property (an invariant's `expr`, a query's `body`). */
function rangeInProperty(node: AstNode, property: string, start: number, end: number): Range {
    const cst = GrammarUtils.findNodeForProperty(node.$cstNode, property) ?? node.$cstNode!;
    return rangeInText(cst, start, end);
}

function rangeInText(cst: CstNode, start: number, end: number): Range {
    const raw = cst.text;
    const at: number[] = [];   // value index -> offset in raw
    for (let i = 1; i < raw.length - 1; i += raw[i] === '\\' ? 2 : 1) at.push(i);
    at.push(raw.length - 1);
    const offset = (k: number) => cst.offset + (at[Math.min(k, at.length - 1)] ?? 1);
    const doc = AstUtils.getDocument(cst.astNode).textDocument;
    return { start: doc.positionAt(offset(start)), end: doc.positionAt(offset(Math.max(end, start))) };
}
