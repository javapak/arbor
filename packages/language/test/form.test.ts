import { describe, expect, it } from 'vitest';
import { Validator } from '@cfworker/json-schema';
import { slotSchema, slotValues } from '@arbor/ir';
import { SHOP, withProfiles } from './helpers.js';

describe('slotSchema', () => {
    it('describes properties, enums and references, inherited ones included', async () => {
        const { ir } = await withProfiles(SHOP);
        const schema = slotSchema(ir, 'persistence.Column');
        expect(Object.keys(schema.properties)).toEqual(
            expect.arrayContaining(['columnName', 'unique', 'onDelete', 'type', 'optional', 'description']));
        expect(schema.properties.unique).toMatchObject({ type: 'boolean', default: false });
        expect(schema.properties.onDelete).toMatchObject({ enum: ['cascade', 'setNull', 'restrict', 'noAction'], default: 'restrict' });
        // Interfaces are Types, Components are not.
        const targets = (schema.properties.type as { oneOf: Array<{ const: string }> }).oneOf.map(o => o.const);
        expect(targets).toEqual(expect.arrayContaining(['shop.UUID', 'user', 'shop.Payments']));
        expect(targets).not.toContain('shop.Checkout');
        expect(schema.required).toEqual(['type']);
        expect(schema.properties).not.toHaveProperty('fields');
    });

    it('validates the values of every element in the example', async () => {
        const { ir } = await withProfiles(SHOP);
        for (const element of ir.models[0].elements) {
            const schema = slotSchema(ir, element.kind);
            const values = slotValues(element, schema);
            const result = new Validator(schema as object, '2020-12').validate(values);
            expect(result.errors, element.id).toEqual([]);
        }
        const checkout = ir.models[0].elements.find(e => e.id === 'shop.Checkout')!;
        expect(slotValues(checkout, slotSchema(ir, checkout.kind)).requires).toEqual(['shop.Payments']);
    });
});
