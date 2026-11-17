/**
 * Profile semantics over the Langium AST, shared by the validator and the
 * AST -> IR converter so both agree on inheritance, containment and IDs.
 *
 * Everything here is interpretation of profile *data*. Nothing is compiled
 * or evaluated.
 */
import { AstUtils } from 'langium';
import {
    isElement, isModel, isProfile, isPropFeature,
    type Element, type EnumDecl, type Feature, type Kind, type Literal, type Multiplicity,
    type PropFeature, type ContainsFeature
} from './generated/ast.js';

// ------------------------------------------------------------ inheritance

/** The kind and all its ancestors, nearest first. Cycle-safe. */
export function lineage(kind: Kind): Kind[] {
    const out: Kind[] = [];
    const seen = new Set<Kind>();
    const walk = (k: Kind | undefined) => {
        if (!k || seen.has(k)) return;
        seen.add(k);
        out.push(k);
        for (const s of k.supers) walk(s.ref);
    };
    walk(kind);
    return out;
}

export function isA(kind: Kind, ancestor: Kind): boolean {
    return lineage(kind).includes(ancestor);
}

/** Returns the cycle path if `kind` is part of an inheritance cycle. */
export function findInheritanceCycle(kind: Kind): Kind[] | undefined {
    const path: Kind[] = [];
    const visit = (k: Kind): Kind[] | undefined => {
        if (path.includes(k)) return [...path.slice(path.indexOf(k)), k];
        path.push(k);
        for (const s of k.supers) {
            const ref = s.ref;
            if (ref) {
                const c = visit(ref);
                if (c) return c;
            }
        }
        path.pop();
        return undefined;
    };
    const c = visit(kind);
    return c && c[0] === kind ? c : undefined;
}

/** All features including inherited ones. Nearest definition wins. */
export function allFeatures(kind: Kind): Map<string, Feature> {
    const byName = new Map<string, Feature>();
    for (const k of lineage(kind)) {
        for (const f of k.features) if (!byName.has(f.name)) byName.set(f.name, f);
    }
    return byName;
}

// ------------------------------------------------------------ multiplicity

export interface Bounds { lower: number; upper: number | null }

/** Defaults: properties and refs are [0..1], containments are [0..*]. */
export function bounds(m: Multiplicity | undefined, feature: Feature['$type']): Bounds {
    if (!m) return feature === 'ContainsFeature' ? { lower: 0, upper: null } : { lower: 0, upper: 1 };
    if (m.lower === undefined) return { lower: 0, upper: null };          // [*]
    if (m.many) return { lower: m.lower, upper: null };                   // [n..*]
    return { lower: m.lower, upper: m.upper ?? m.lower };                 // [n] or [n..m]
}

export function isRequired(f: Feature): boolean {
    if (isPropFeature(f) && f.default) return false;
    return bounds(f.multiplicity, f.$type).lower >= 1;
}

// ------------------------------------------------------------ containment

/**
 * Which containment feature of `parent` holds a nested element of kind `child`.
 * Returns all candidates; exactly one means unambiguous.
 */
export function containmentCandidates(parent: Kind, child: Kind): ContainsFeature[] {
    const out: ContainsFeature[] = [];
    for (const f of allFeatures(parent).values()) {
        if (f.$type === 'ContainsFeature' && f.target.ref && isA(child, f.target.ref)) out.push(f);
    }
    return out;
}

// ------------------------------------------------------------ values

export type Scalar = string | number | boolean;

export function literalValue(l: Literal): Scalar {
    switch (l.$type) {
        case 'StringLit': return l.value; // quotes/escapes handled by Langium's STRING converter
        case 'NumberLit': return l.value;
        case 'BoolLit': return l.value === 'true';
        case 'IdLit': return l.value;
    }
}

/** Returns an error message if the literal does not fit the property type. */
export function checkLiteral(prop: PropFeature, l: Literal): string | undefined {
    const t = prop.type;
    if (t.$type === 'EnumTypeRef') {
        const e: EnumDecl | undefined = t.enum.ref;
        if (l.$type !== 'IdLit') return `expected a literal of enum ${t.enum.$refText}`;
        if (e && !e.literals.some(x => x.name === l.value)) {
            return `'${l.value}' is not a literal of ${e.name} (${e.literals.map(x => x.name).join(', ')})`;
        }
        return undefined;
    }
    switch (t.primitive) {
        case 'string': return l.$type === 'StringLit' ? undefined : 'expected a string in double quotes';
        case 'bool': return l.$type === 'BoolLit' ? undefined : 'expected true or false';
        case 'float': return l.$type === 'NumberLit' ? undefined : 'expected a number';
        case 'int':
            return l.$type === 'NumberLit' && Number.isInteger(l.value) ? undefined : 'expected an integer';
    }
}

// ------------------------------------------------------------ identity

export function kindId(kind: Kind): string {
    const profile = AstUtils.getContainerOfType(kind, isProfile);
    return `${profile?.name ?? '_'}.${kind.name}`;
}

export function enumId(e: EnumDecl): string {
    const profile = AstUtils.getContainerOfType(e, isProfile);
    return `${profile?.name ?? '_'}.${e.name}`;
}

/**
 * Explicit `@"id"` wins; otherwise `<parentId>.<name>`, rooted at the model
 * name. A stable ID on a parent therefore also stabilizes its children.
 */
export function elementId(el: Element): string {
    if (el.stableId) return el.stableId;
    const c = el.$container;
    if (isElement(c)) return `${elementId(c)}.${el.name}`;
    return `${isModel(c) ? c.name : '_'}.${el.name}`;
}

// ------------------------------------------------------------ suggestions

export function closest(name: string, candidates: Iterable<string>): string | undefined {
    let best: string | undefined;
    let bestD = Infinity;
    for (const c of candidates) {
        const d = levenshtein(name.toLowerCase(), c.toLowerCase());
        if (d < bestD) { bestD = d; best = c; }
    }
    return best !== undefined && bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

function levenshtein(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return row[b.length];
}
