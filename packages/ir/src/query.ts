import type { IRDocument, IRElement, IRFeature, IRKind } from './types.js';

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

    /** All features of a kind including inherited ones. Nearest definition wins. */
    features(kindId: string): IRFeature[] {
        const byName = new Map<string, IRFeature>();
        for (const k of this.lineage(kindId)) {
            for (const f of k.features) if (!byName.has(f.name)) byName.set(f.name, f);
        }
        return [...byName.values()];
    }

    /** Visual hints merged down the lineage. Nearest definition wins. */
    visual(kindId: string): Record<string, string | number | boolean> {
        const merged: Record<string, string | number | boolean> = {};
        for (const k of [...this.lineage(kindId)].reverse()) Object.assign(merged, k.visual);
        return merged;
    }

    /** Property value with the profile default applied. */
    get(element: IRElement, name: string): unknown {
        if (name in element.properties) return element.properties[name];
        const f = this.features(element.kind).find(x => x.name === name);
        return f && f.feature === 'property' ? f.default : undefined;
    }
}
