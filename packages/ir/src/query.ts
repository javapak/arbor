import type { IRDocument, IRElement, IRFeature, IRKind } from './types.js';

/**
 * How to show an element: its name, or `:Kind` for an unnamed one (as UML
 * writes an anonymous instance).
 */
export function displayName(element: IRElement): string {
    return element.name || `:${element.kind.split('.').pop()}`;
}

/**
 * Read helpers for consumers. Interpreted against the profile data at runtime:
 * no generated types, no eval.
 */
export class IRIndex {
    readonly kinds = new Map<string, IRKind>();
    readonly elements = new Map<string, IRElement>();

    constructor(readonly doc: IRDocument) {
        for (const p of doc.profiles) for (const k of p.kinds) this.kinds.set(k.id, k);
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
        for (const f of this.features(element.kind)) {
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
        for (const k of profile.kinds) {
            for (const id of k.extends) used.add(owner(id));
            for (const f of k.features) {
                if (f.feature !== 'property') used.add(owner(f.target));
                else if (typeof f.type === 'object') used.add(owner(f.type.enum));
            }
        }
        used.delete(profileName);
        return [...used].sort();
    }

    /** Property value with the profile default applied. */
    get(element: IRElement, name: string): unknown {
        if (name in element.properties) return element.properties[name];
        const f = this.features(element.kind).find(x => x.name === name);
        return f && f.feature === 'property' ? f.default : undefined;
    }
}
