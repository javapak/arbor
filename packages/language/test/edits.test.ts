import { describe, expect, it } from 'vitest';
import { applyEdit, planAddElement, planRemoveElement, type TextEdit } from '../src/edits.js';
import { loadWorkspace } from '../src/cli/load.js';
import { DiagnosticCode as C } from '../src/language/arbor-validator.js';
import { PERSISTENCE, SHOP, SOFTWARE } from './helpers.js';

const sources = (extra: Record<string, string> = {}) => [
    { uri: 'software.arbor', text: SOFTWARE },
    { uri: 'persistence.arbor', text: PERSISTENCE },
    ...Object.entries(extra).map(([uri, text]) => ({ uri, text })),
    { uri: 'shop.arbor', text: SHOP }
];
const apply = (src: ReturnType<typeof sources>, edit: TextEdit) =>
    src.map(s => (s.uri === edit.uri ? { ...s, text: applyEdit(s.text, edit) } : s));

describe('planAddElement', () => {
    it('adds an empty element at the end of the model, indented like its siblings', async () => {
        const src = sources();
        const r = await planAddElement(src, 'persistence.Entity');
        if ('error' in r) throw new Error(r.error);
        expect(r.elementId).toBe('shop.Entity1');
        const next = apply(src, r.edit);
        const shop = next.at(-1)!.text;
        expect(shop).toMatch(/\n {4}Entity Entity1 \{\}\n\}\s*$/);
        const loaded = await loadWorkspace(next);
        expect(loaded.ir.models[0].elements.some(e => e.id === 'shop.Entity1')).toBe(true);
        // Required features are left to the validator, as with hand-written text.
        expect(loaded.diagnostics.map(d => d.code)).toEqual([C.MissingRequired]);
    });

    it('picks the next free name', async () => {
        let src = sources();
        for (let i = 0; i < 2; i++) {
            const r = await planAddElement(src, 'software.Interface');
            if ('error' in r) throw new Error(r.error);
            src = apply(src, r.edit);
        }
        expect(src.at(-1)!.text).toContain('Interface Interface2 {}');
    });

    it('writes the qualified kind name when the simple name is ambiguous', async () => {
        const src = sources({ 'other.arbor': 'profile other { kind Field {} }' });
        const r = await planAddElement(src, 'software.Primitive');
        const q = await planAddElement(src, 'other.Field');
        if ('error' in r || 'error' in q) throw new Error('planning failed');
        expect(r.edit.text).toContain('Primitive Primitive1 {}');
        expect(q.edit.text).toContain('other.Field Field1 {}');
    });

    it('refuses abstract and unknown kinds', async () => {
        expect(await planAddElement(sources(), 'software.NamedElement')).toEqual({ error: 'software.NamedElement is abstract' });
        expect(await planAddElement(sources(), 'nope.Kind')).toEqual({ error: 'unknown kind nope.Kind' });
    });
});

describe('planRemoveElement', () => {
    it('removes an element with its nested elements and the lines it occupied', async () => {
        const src = sources();
        const r = await planRemoveElement(src, 'shop.Checkout');
        if ('error' in r) throw new Error(r.error);
        const shop = apply(src, r).at(-1)!.text;
        expect(shop).not.toContain('Checkout');
        expect(shop).not.toContain('placeOrder');
        expect(shop).toContain('    Interface Payments {');
        expect((await loadWorkspace(apply(src, r))).diagnostics).toEqual([]);
    });

    it('finds elements by stable ID, and leaves dangling references to the validator', async () => {
        const src = sources();
        const r = await planRemoveElement(src, 'user');
        if ('error' in r) throw new Error(r.error);
        const loaded = await loadWorkspace(apply(src, r));
        expect(loaded.diagnostics.some(d => d.message.includes("'User'"))).toBe(true);
    });

    it('reports an unknown ID', async () => {
        expect(await planRemoveElement(sources(), 'shop.Nope')).toEqual({ error: 'no element with ID shop.Nope' });
    });
});
