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
    Element, Kind, ArborAstType, Model, Multiplicity, Profile, PropFeature, Slot, Value, Visual
} from './generated/ast.js';
import { isElement, isListValue, isRefValue } from './generated/ast.js';
import type { ArborServices } from './arbor-module.js';
import type { ArborScopeProvider } from './arbor-scope.js';
import {
    allFeatures, bounds, checkLiteral, closest, containmentCandidates,
    elementId, findInheritanceCycle, isA, isRequired
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
    // models
    AbstractInstance: 'ARB101',
    UnknownSlot: 'ARB102',
    TypeMismatch: 'ARB103',
    RefTargetKind: 'ARB104',
    MissingRequired: 'ARB105',
    ChildNotAllowed: 'ARB106',
    TooMany: 'ARB107',
    DuplicateSlot: 'ARB108',
    DuplicateId: 'ARB110'
} as const;

/** Keys the flow adapter understands. Others are allowed but warned about. */
export const KNOWN_VISUAL_KEYS = ['shape', 'color', 'icon', 'label', 'width', 'height', 'container'];

export function registerValidationChecks(services: ArborServices): void {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.ArborValidator;
    const checks: ValidationChecks<ArborAstType> = {
        Profile: validator.checkProfile,
        Kind: validator.checkKind,
        PropFeature: validator.checkPropFeature,
        Multiplicity: validator.checkMultiplicity,
        Visual: validator.checkVisual,
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
        for (const decl of [...profile.kinds, ...profile.enums]) {
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
    }

    checkPropFeature(prop: PropFeature, accept: ValidationAcceptor): void {
        if (!prop.default) return;
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

    checkVisual(visual: Visual, accept: ValidationAcceptor): void {
        for (const e of visual.entries) {
            if (!KNOWN_VISUAL_KEYS.includes(e.key)) {
                const fix = closest(e.key, KNOWN_VISUAL_KEYS);
                accept('warning',
                    `Unknown visual key '${e.key}'.${fix ? ` Did you mean '${fix}'?` : ''}`,
                    { node: e, property: 'key', code: DiagnosticCode.UnknownVisualKey, data: { fix } });
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

        const features = allFeatures(kind);
        const given = new Set<string>();

        for (const slot of el.slots) {
            if (given.has(slot.name)) {
                accept('error', `Slot '${slot.name}' is set more than once.`,
                    { node: slot, property: 'name', code: DiagnosticCode.DuplicateSlot });
            }
            given.add(slot.name);
            this.checkSlot(kind, slot, features, accept);
        }

        // Nested children: each must fit exactly one containment feature.
        const counts = new Map<string, number>();
        for (const child of el.children) {
            const childKind = child.kind.ref;
            if (!childKind) continue;
            const candidates = containmentCandidates(kind, childKind);
            if (candidates.length === 0) {
                accept('error', `${kind.name} cannot contain ${childKind.name} elements.`,
                    { node: child, property: 'kind', code: DiagnosticCode.ChildNotAllowed });
            } else if (candidates.length > 1) {
                accept('error',
                    `${childKind.name} fits several containments of ${kind.name} (${candidates.map(c => c.name).join(', ')}); this is ambiguous.`,
                    { node: child, property: 'kind', code: DiagnosticCode.ChildNotAllowed });
            } else {
                const c = candidates[0];
                counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
                if (c.name) given.add(c.name);
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
                accept('error', `${kind.name} ${el.name} is missing required '${f.name}'.`,
                    { node: el, property: 'name', code: DiagnosticCode.MissingRequired, data: { fix: f.name } });
            }
        }
    }

    private checkSlot(kind: Kind, slot: Slot, features: Map<string, import('./generated/ast.js').Feature>, accept: ValidationAcceptor): void {
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

        const items: Value[] = isListValue(slot.value) ? slot.value.items : [slot.value];
        const { upper } = bounds(f.multiplicity, f.$type);
        if (isListValue(slot.value) && upper === 1) {
            accept('error', `'${slot.name}' takes a single value, not a list.`,
                { node: slot, property: 'value', code: DiagnosticCode.TooMany });
        } else if (upper !== null && items.length > upper) {
            accept('error', `'${slot.name}' allows at most ${upper} values, found ${items.length}.`,
                { node: slot, property: 'value', code: DiagnosticCode.TooMany });
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
                    accept('error', `'${slot.name}' must point to a ${want.name}, but ${target.name} is a ${target.kind.ref.name}.`,
                        { node: v, property: 'target', code: DiagnosticCode.RefTargetKind });
                }
            } else {
                if (isRefValue(v) || isListValue(v)) {
                    accept('error', `'${slot.name}' expects a value, not a ${isRefValue(v) ? 'reference' : 'nested list'}.`,
                        { node: v, code: DiagnosticCode.TypeMismatch });
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
