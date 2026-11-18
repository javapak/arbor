import { describe, expect, it } from 'vitest';
import { applyEdit, planAddElement, planRemoveElement, planSetSlot, type SlotValue, type TextEdit } from '../src/edits.js';
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

describe('planSetSlot', () => {
    /** Applies the planned edit and checks the result still loads without errors. */
    async function set(id: string, name: string, value: SlotValue, src = sources()) {
        const r = await planSetSlot(src, id, name, value);
        if ('error' in r) throw new Error(r.error);
        const next = apply(src, r);
        const loaded = await loadWorkspace(next);
        expect(loaded.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        const element = loaded.ir.models[0].elements.find(e => e.id === id)!;
        return { shop: next.at(-1)!.text, element, next };
    }

    it('replaces a written value in place', async () => {
        const { shop, element } = await set('user.email', 'unique', false);
        expect(shop).toContain('Column email { type: -> Text  unique: false  index: true }');
        expect(element.properties.unique).toBe(false);
    });

    it('adds a slot on its own line after the last one in a block', async () => {
        const { shop, element } = await set('order', 'schema', 'crm "eu"');
        expect(shop).toContain('tableName: "orders"\n        schema: "crm \\"eu\\""\n');
        expect(element.properties.schema).toBe('crm "eu"');
    });

    it('adds a slot inline when the element is on one line', async () => {
        const { shop } = await set('user.id', 'index', true);
        expect(shop).toContain('Column id    { type: -> UUID  unique: true  index: true }');
    });

    it('fills an empty element', async () => {
        let src = sources();
        const added = await planAddElement(src, 'software.Interface');
        if ('error' in added) throw new Error(added.error);
        src = apply(src, added.edit);
        const { shop } = await set(added.elementId, 'description', 'new', src);
        expect(shop).toContain('Interface Interface1 { description: "new" }');
    });

    it('removes a slot with its line, or inline with the spaces before it', async () => {
        const a = await set('user', 'description', undefined);
        expect(a.shop).not.toContain('description');
        expect(a.shop).toContain('tableName: "users"\n\n        Column id');
        const b = await set('user.id', 'unique', undefined);
        expect(b.shop).toContain('Column id    { type: -> UUID }');
    });

    it('writes enum literals and references', async () => {
        const a = await set('order.buyer', 'onDelete', 'setNull');
        expect(a.shop).toContain('onDelete: setNull');
        const b = await set('order.total', 'type', 'shop.Text');
        expect(b.shop).toContain('Column total { type: -> Text }');
        expect(b.element.references.type).toEqual(['shop.Text']);
        const c = await set('shop.Checkout', 'requires', ['shop.Payments', 'shop.Checkout.OrderApi']);
        expect(c.shop).toContain('requires: [-> Payments, -> Checkout.OrderApi]');
        expect(c.element.references.requires).toEqual(['shop.Payments', 'shop.Checkout.OrderApi']);
    });

    it('refuses values that do not fit the feature', async () => {
        const src = sources();
        expect(await planSetSlot(src, 'user', 'readOnly', 'yes')).toEqual({ error: 'readOnly takes true or false' });
        expect(await planSetSlot(src, 'order.buyer', 'onDelete', 'explode')).toEqual({ error: 'explode is not a literal of OnDeleteAction' });
        expect(await planSetSlot(src, 'order.buyer', 'type', 'shop.Checkout')).toEqual({ error: 'Checkout is not a Type' });
        expect(await planSetSlot(src, 'order', 'fields', [])).toEqual({ error: 'Entity has no property or reference fields' });
        expect(await planSetSlot(src, 'nope', 'x', 1)).toEqual({ error: 'no element with ID nope' });
    });
});
