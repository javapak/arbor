import type { IRDataType, IRDocument, IRElement, IRFeature, IRKind, IRProperty, IRStereotype, IRValue } from './types.js';

/**
 * How to show an element: its name, or `:Kind` for an unnamed one (as UML
 * writes an anonymous instance).
 */
export function displayName(element: IRElement): string {
    return element.name || `:${element.kind.split('.').pop()}`;
}

/**
 * Visual keys that decide how an element is laid out rather than styled: stereotypes and
 * `visual when` blocks can't change them, since they'd make elements of one kind lay out differently.
 */
export const STRUCTURAL_VISUALS: ReadonlySet<string> = new Set(['container', 'diagram', 'hidden', 'hideWhenAlone', 'layout', 'member', 'source', 'target']);

/**
 * Read helpers for consumers. Interpreted against the profile data at runtime:
 * no generated types, no eval.
 */
export class IRIndex {
    readonly kinds = new Map<string, IRKind>();
    readonly datatypes = new Map<string, IRDataType>();
    readonly stereotypes = new Map<string, IRStereotype>();
    readonly elements = new Map<string, IRElement>();

    constructor(readonly doc: IRDocument) {
        for (const p of doc.profiles) for (const k of p.kinds) this.kinds.set(k.id, k);
        for (const p of doc.profiles) for (const d of p.datatypes ?? []) this.datatypes.set(d.id, d);
        for (const p of doc.profiles) for (const s of p.stereotypes ?? []) this.stereotypes.set(s.id, s);
        for (const m of doc.models) for (const e of m.elements) this.elements.set(e.id, e);
    }

    /** The kind and all its ancestors, nearest first. */
    lineage(kindId: string): IRKind[] {
        const out: IRKind[] = [];
        const seen = new Set<string>();
        const walk = (id: string) => {
            if (seen.has(id)) return;
            seen.add(id);
            const k = this.kinds.get(id);
            if (!k) return;
            out.push(k);
            k.extends.forEach(walk);
        };
        walk(kindId);
        return out;
    }

    /** True if `kindId` is `ancestorId` or extends it. */
    isA(kindId: string, ancestorId: string): boolean {
        return this.lineage(kindId).some(k => k.id === ancestorId);
    }

    /**
     * All features of a kind including inherited ones. Nearest definition wins,
     * and features a nearer one `redefines` are left out.
     */
    features(kindId: string): IRFeature[] {
        const byName = new Map<string, IRFeature>();
        const redefined = new Set<string>();
        for (const k of this.lineage(kindId)) {
            for (const f of k.features) {
                if (byName.has(f.name) || redefined.has(f.name)) continue;
                byName.set(f.name, f);
                f.redefines?.forEach(n => redefined.add(n));
            }
        }
        return [...byName.values()];
    }

    /** An element's features: its kind's, then those of the stereotypes applied to it, in order. */
    elementFeatures(element: IRElement): IRFeature[] {
        const own = this.features(element.kind);
        const added = (element.stereotypes ?? []).flatMap(id => this.stereotypes.get(id)?.features ?? []);
        return added.length ? [...own, ...added.filter(f => !own.some(o => o.name === f.name))] : own;
    }

    /** One feature of an element, by name (see `elementFeatures`). */
    elementFeature(element: IRElement, name: string): IRFeature | undefined {
        return this.elementFeatures(element).find(f => f.name === name);
    }

    /**
     * An element's visuals: its kind's, restyled by the kind's `visual when` blocks its
     * properties match (inherited ones first, then in profile order), then by its stereotypes',
     * the last applied winning. How it is drawn structurally (nested, as a row, as an edge)
     * stays its kind's.
     */
    elementVisual(element: IRElement): Record<string, string | number | boolean> {
        const merged = this.visual(element.kind);
        for (const k of [...this.lineage(element.kind)].reverse()) {
            for (const c of k.visualWhen ?? []) {
                if (this.get(element, c.feature) !== c.value) continue;
                for (const [key, value] of Object.entries(c.visual)) if (!STRUCTURAL_VISUALS.has(key)) merged[key] = value;
            }
        }
        for (const id of element.stereotypes ?? []) {
            for (const [key, value] of Object.entries(this.stereotypes.get(id)?.visual ?? {})) {
                if (!STRUCTURAL_VISUALS.has(key)) merged[key] = value;
            }
        }
        return merged;
    }

    /** The names of the stereotypes applied to an element, as UML shows them: `«Entity, Audited»`, or '' for none. */
    stereotypeLabel(element: IRElement): string {
        const names = (element.stereotypes ?? []).map(id => this.stereotypes.get(id)?.name ?? id.split('.').pop());
        return names.length ? `«${names.join(', ')}»` : '';
    }

    /** One feature of a kind, by name (see `features`). */
    feature(kindId: string, name: string): IRFeature | undefined {
        return this.features(kindId).find(f => f.name === name);
    }

    /**
     * A reference's targets including those of the references that subset it
     * (UML: a superset holds its subsets' values). Written values first.
     */
    values(element: IRElement, name: string, seen = new Set<string>()): string[] {
        const out = new Set(element.references[name] ?? []);
        seen.add(name);
        for (const f of this.elementFeatures(element)) {
            if (f.feature === 'ref' && f.subsets?.includes(name) && !seen.has(f.name)) {
                this.values(element, f.name, seen).forEach(v => out.add(v));
            }
        }
        return [...out];
    }

    /** Visual hints merged down the lineage. Nearest definition wins. */
    visual(kindId: string): Record<string, string | number | boolean> {
        const merged: Record<string, string | number | boolean> = {};
        for (const k of [...this.lineage(kindId)].reverse()) Object.assign(merged, k.visual);
        return merged;
    }

    /**
     * The other profiles a profile builds on: those whose kinds its kinds
     * extend, contain or reference, or whose enums its properties use. A
     * profile with none stands alone (a core profile); one with some is
     * layered on them (a domain profile).
     */
    dependsOn(profileName: string): string[] {
        const profile = this.doc.profiles.find(p => p.name === profileName);
        if (!profile) return [];
        const owner = (id: string) => id.slice(0, id.indexOf('.'));
        const used = new Set<string>();
        const typeOwner = (f: IRProperty) => (typeof f.type === 'object' ? owner('enum' in f.type ? f.type.enum : f.type.datatype) : undefined);
        for (const k of profile.kinds) {
            for (const id of k.extends) used.add(owner(id));
            for (const f of k.features) {
                const o = f.feature !== 'property' ? owner(f.target) : typeOwner(f);
                if (o) used.add(o);
            }
        }
        for (const d of profile.datatypes ?? []) for (const f of d.features) { const o = typeOwner(f); if (o) used.add(o); }
        for (const s of profile.stereotypes ?? []) {
            for (const id of s.extends) used.add(owner(id));
            for (const f of s.features) {
                const o = f.feature !== 'property' ? owner(f.target) : typeOwner(f);
                if (o) used.add(o);
            }
        }
        used.delete(profileName);
        return [...used].sort();
    }

    /** Property value with the profile default applied. */
    get(element: IRElement, name: string): unknown {
        if (name in element.properties) return element.properties[name];
        const f = this.elementFeature(element, name);
        return f && f.feature === 'property' ? f.default : undefined;
    }
}

/**
 * A property value as the text writes it: strings quoted, enum literals bare,
 * lists in brackets, a datatype's value as `{ field: value  ... }`.
 */
export function valueText(index: IRIndex, type: IRProperty['type'], value: IRValue): string {
    if (Array.isArray(value)) return `[${value.map(v => valueText(index, type, v)).join(', ')}]`;
    if (typeof value === 'object') {
        const fields = typeof type === 'object' && 'datatype' in type ? index.datatypes.get(type.datatype)?.features ?? [] : [];
        const parts = Object.entries(value).map(([name, v]) => {
            const f = fields.find(x => x.name === name);
            return `${name}: ${f ? valueText(index, f.type, v) : JSON.stringify(v)}`;
        });
        return `{ ${parts.join('  ')} }`;
    }
    const bare = typeof type === 'object' && 'enum' in type;
    return bare ? String(value) : JSON.stringify(value);
}
