/**
 * Values of derived references, which models never write: computed from the
 * rest of the model, so every reader of the IR sees them without knowing how.
 *
 *  - With an `opposite`: the elements whose opposite reference points at the
 *    element, or the element that contains it through the opposite containment.
 *  - Otherwise, when other references `subsets` it: the union of their values
 *    (a UML derived union), with the elements of containments that subset it
 *    (a class's attributes, when `ownedAttribute subsets attribute`).
 *
 * Plain data in, plain data out; nothing is evaluated.
 */
import { IRIndex } from './query.js';
import type { IRDocument, IRElement, IRReference } from './types.js';

/** Fills in each element's derived references, in place. Returns the document. */
export function deriveReferences(doc: IRDocument): IRDocument {
    const index = new IRIndex(doc);
    const elements = doc.models.flatMap(m => m.elements);

    // Who points at whom, by reference name, from the written values.
    const pointing = new Map<string, Map<string, string[]>>();
    for (const el of elements) {
        for (const [name, targets] of Object.entries(el.references)) {
            for (const t of targets) {
                const byName = pointing.get(t) ?? pointing.set(t, new Map()).get(t)!;
                byName.set(name, [...(byName.get(name) ?? []), el.id]);
            }
        }
    }
    // A containment and the ones that subset it, so an opposite of a union containment finds the owner too.
    const within = (kindId: string, containedIn: string | null, name: string): boolean => {
        if (!containedIn) return false;
        if (containedIn === name) return true;
        const f = index.feature(kindId, containedIn);
        return !!f?.subsets?.some(s => within(kindId, s, name));
    };

    const derived = (el: IRElement) => index.elementFeatures(el)
        .filter((f): f is IRReference => f.feature === 'ref' && f.derived === true);

    // Opposites first: they depend only on what is written.
    for (const el of elements) {
        for (const f of derived(el)) {
            if (!f.opposite) continue;
            const other = index.features(f.target).find(o => o.name === f.opposite);
            let values: string[] = [];
            if (other?.feature === 'contains') {
                const parent = el.parent ? index.elements.get(el.parent) : undefined;
                if (parent && within(parent.kind, el.containedIn, other.name)) values = [parent.id];
            } else if (other?.feature === 'ref') {
                values = (pointing.get(el.id)?.get(other.name) ?? [])
                    .filter(id => index.isA(index.elements.get(id)!.kind, f.target));
            }
            set(el, f.name, values);
        }
    }

    // Then unions, which may include derived opposites or other unions.
    const done = new Set<string>();
    const union = (el: IRElement, name: string, seen: Set<string>): string[] => {
        const key = `${el.id}\u0000${name}`;
        const f = index.elementFeature(el, name);
        if (done.has(key) || seen.has(key) || f?.feature !== 'ref' || !f.derived || f.opposite) return el.references[name] ?? [];
        seen.add(key);
        const out = new Set<string>();
        for (const sub of index.elementFeatures(el)) {
            if (sub.feature === 'ref' && sub.subsets?.includes(name)) union(el, sub.name, seen).forEach(v => out.add(v));
        }
        for (const id of el.children) {
            const child = index.elements.get(id);
            if (child && within(el.kind, child.containedIn, name)) out.add(id);
        }
        set(el, name, [...out]);
        done.add(key);
        return [...out];
    };
    for (const el of elements) for (const f of derived(el)) if (!f.opposite) union(el, f.name, new Set());
    return doc;
}

function set(el: IRElement, name: string, values: string[]) {
    if (values.length) el.references[name] = values;
    else delete el.references[name];
}
