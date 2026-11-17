import { describe, expect, it } from 'vitest';
import { DiagnosticCode as C } from '../src/language/mdsl-validator.js';
import { codes, withProfiles } from './helpers.js';

// A second profile that reuses a core kind name.
const OTHER = `profile other {
    kind Field { prop label: string [0..1] }
    kind Form { contains fields: Field [0..*] }
}`;

const model = (body: string) => `model t {\n${body}\n}`;

describe('kind and enum qualification', () => {
    it('resolves profile-qualified kinds and enums', async () => {
        const r = await withProfiles(model(`
            software.Primitive P { builtin: uuid }
            persistence.Entity E { tableName: "e"  persistence.Column c { type: -> P } }`), { 'other.mdsl': OTHER });
        expect(r.diagnostics).toEqual([]);
        const els = r.ir.models.find(m => m.name === 't')!.elements;
        expect(els.find(e => e.name === 'c')?.kind).toBe('persistence.Column');
    });

    it('lets kind names repeat across profiles; inside a profile its own names win', async () => {
        const r = await withProfiles(model('Form f { other.Field x { label: "X" } }'), { 'other.mdsl': OTHER });
        expect(r.diagnostics).toEqual([]);
        const form = r.ir.profiles.find(p => p.name === 'other')!.kinds.find(k => k.name === 'Form')!;
        expect(form.features[0]).toMatchObject({ feature: 'contains', target: 'other.Field' });
        const x = r.ir.models.find(m => m.name === 't')!.elements.find(e => e.name === 'x');
        expect(x?.kind).toBe('other.Field');
    });

    it('reports a simple name defined by several profiles as ambiguous', async () => {
        const r = await withProfiles(model(`
            Primitive P { builtin: uuid }
            DataType D { Field f { type: -> P } }`), { 'other.mdsl': OTHER });
        const d = r.diagnostics.find(x => x.code === C.AmbiguousName);
        expect(d?.message).toContain('software.Field');
        expect(d?.message).toContain('other.Field');
    });

    it('qualifying the name removes the ambiguity', async () => {
        const r = await withProfiles(model(`
            Primitive P { builtin: uuid }
            DataType D { software.Field f { type: -> P } }`), { 'other.mdsl': OTHER });
        expect(r.diagnostics).toEqual([]);
    });

    it('accepts qualified names inside profiles', async () => {
        const r = await withProfiles(model(''), {
            'ext.mdsl': `profile ext {
                kind Table extends persistence.Entity { prop engine: string = "innodb" }
                kind Col { prop action: persistence.OnDeleteAction = cascade }
            }`
        });
        expect(r.diagnostics).toEqual([]);
    });

    it('rejects two profiles with the same name', async () => {
        const r = await withProfiles(model(''), { 'dup.mdsl': 'profile software {}' });
        expect(codes(r)).toContain(C.DuplicateName);
    });
});

describe('element paths', () => {
    const SHOPLIKE = model(`
        Primitive Money { builtin: decimal }
        Interface Payments { Operation charge { returns: -> Money } }
        Component Checkout {
            Interface OrderApi { Operation placeOrder {} }
        }`);

    it('resolves a dotted path into nested elements', async () => {
        const r = await withProfiles(SHOPLIKE, {
            'refs.mdsl': `model refs {
                Component Billing { requires: [-> t.Payments, -> Checkout.OrderApi] }
            }`
        });
        expect(r.diagnostics).toEqual([]);
        const billing = r.ir.models.find(m => m.name === 'refs')!.elements.find(e => e.name === 'Billing');
        expect(billing?.references.requires).toEqual(['t.Payments', 't.Checkout.OrderApi']);
    });

    it('resolves a model-qualified path and checks the target kind', async () => {
        const r = await withProfiles(SHOPLIKE, {
            'refs.mdsl': `model refs {
                Component Billing { requires: [-> t.Checkout.OrderApi.placeOrder] }
            }`
        });
        expect(codes(r)).toEqual([C.RefTargetKind]);
    });

    it('resolves a path relative to an enclosing element', async () => {
        const r = await withProfiles(model(`
            Interface Payments {
                Operation charge {}
                Operation refund { returns: -> Payments }
            }
            Component C { requires: [-> Payments] }`));
        expect(r.diagnostics).toEqual([]);
    });

    it('reports an unknown path segment', async () => {
        const r = await withProfiles(SHOPLIKE, {
            'refs.mdsl': 'model refs { Component Billing { requires: [-> Checkout.Nope] } }'
        });
        expect(codes(r)).toEqual(['linking']);
    });

    it('reports a top-level element name used by several models as ambiguous', async () => {
        const r = await withProfiles(SHOPLIKE, {
            'a.mdsl': 'model a { Interface Payments {} }',
            'refs.mdsl': 'model refs { Component Billing { requires: [-> Payments] } }'
        });
        expect(codes(r)).toEqual([C.AmbiguousName]);
    });
});
