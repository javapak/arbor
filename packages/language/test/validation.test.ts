import { describe, expect, it } from 'vitest';
import { DiagnosticCode as C } from '../src/language/arbor-validator.js';
import { loadWorkspace } from '../src/cli/load.js';
import { codes, withProfiles } from './helpers.js';

const model = (body: string) => `model t {\n${body}\n}`;

describe('examples', () => {
    it('example profiles and model are clean', async () => {
        const r = await withProfiles('model empty {}');
        expect(r.diagnostics).toEqual([]);
    });
});

describe('model validation', () => {
    it('unknown slot suggests the closest feature', async () => {
        const r = await withProfiles(model('Entity User { tabelName: "users" }'));
        const d = r.diagnostics.find(x => x.code === C.UnknownSlot);
        expect(d?.fix).toBe('tableName');
    });

    it('missing required property', async () => {
        const r = await withProfiles(model('Entity User {}'));
        expect(r.diagnostics.find(x => x.code === C.MissingRequired)?.fix).toBe('tableName');
    });

    it('type mismatch', async () => {
        const r = await withProfiles(model('Entity User { tableName: 42 }'));
        expect(codes(r)).toContain(C.TypeMismatch);
    });

    it('invalid enum literal', async () => {
        const r = await withProfiles(model(`
            Primitive P { builtin: uuid }
            Entity E { tableName: "e"  Column c { type: -> P  onDelete: explode } }`));
        expect(codes(r)).toContain(C.TypeMismatch);
    });

    it('abstract kinds cannot be instantiated', async () => {
        const r = await withProfiles(model('Type T {}'));
        expect(codes(r)).toContain(C.AbstractInstance);
    });

    it('nested child must fit a containment', async () => {
        const r = await withProfiles(model('Entity E { tableName: "e"  Operation op {} }'));
        expect(codes(r)).toContain(C.ChildNotAllowed);
    });

    it('reference target must be of the right kind', async () => {
        const r = await withProfiles(model(`
            Interface I {}
            Component C { requires: [-> I] }
            Entity E { tableName: "e"  Column c { type: -> C } }`));
        expect(codes(r)).toContain(C.RefTargetKind);
    });

    it('single-valued slot rejects a list', async () => {
        const r = await withProfiles(model('Entity E { tableName: ["a", "b"] }'));
        expect(codes(r)).toContain(C.TooMany);
    });

    it('duplicate stable IDs', async () => {
        const r = await withProfiles(model('Primitive A @"x" { builtin: uuid }  Primitive B @"x" { builtin: uuid }'));
        expect(codes(r)).toContain(C.DuplicateId);
    });
});

describe('profile validation', () => {
    it('inheritance cycle', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: 'profile p { kind A extends B {} kind B extends A {} }' }]);
        expect(codes(r)).toContain(C.InheritanceCycle);
    });

    it('bad default', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: 'profile p { kind A { prop n: int = "x" } }' }]);
        expect(codes(r)).toContain(C.BadDefault);
    });

    it('unknown visual key warns with a suggestion', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: 'profile p { kind A { visual { colour: "#fff" } } }' }]);
        const d = r.diagnostics.find(x => x.code === C.UnknownVisualKey);
        expect(d?.severity).toBe('warning');
        expect(d?.fix).toBe('color');
    });

    it('bad multiplicity', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: 'profile p { kind A { prop n: int [3..1] } }' }]);
        expect(codes(r)).toContain(C.BadMultiplicity);
    });
});
