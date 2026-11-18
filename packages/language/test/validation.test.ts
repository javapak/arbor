import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

    it('checks visual values against the IR vocabulary', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: `profile p { kind A { visual {
            shape: "rectangel"  color: "blue"  tint: "yes"  svg: "<path/>"  width: 120
        } } }` }]);
        const bad = r.diagnostics.filter(x => x.code === C.BadVisualValue);
        expect(bad.map(d => d.severity)).toEqual(['warning', 'warning', 'warning', 'warning']);
        expect(bad[0].fix).toBe('rectangle');
        expect(bad.map(d => d.message.split(':')[0])).toEqual([
            "Visual 'shape'", "Visual 'color'", "Visual 'tint'", "Visual 'svg'"
        ]);
    });

    it('checks edge styles on features against the edge vocabulary', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: `profile p { kind A {
            ref a: A [0..1] { targetMarker: "triangel"  colour: "#fff"  line: "dashed" }
        } }` }]);
        expect(r.diagnostics.find(x => x.code === C.BadVisualValue)?.fix).toBe('triangle');
        expect(r.diagnostics.find(x => x.code === C.UnknownVisualKey)?.fix).toBe('color');
        expect(r.diagnostics).toHaveLength(2);
    });

    it('an edge kind\'s ends must be references of the kind, or its owner', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: `profile p {
            kind Link { ref general: Link [1]  visual { source: "owner"  target: "genral" } }
            kind Half { ref to: Half [1]  visual { target: "to" } }
        }` }]);
        const bad = r.diagnostics.filter(x => x.code === C.BadVisualValue);
        expect(bad[0].fix).toBe('general');
        expect(bad[1].message).toMatch(/both 'source' and 'target'/);
        expect(bad).toHaveLength(2);
    });

    it('the UML sample is clean', async () => {
        const dir = fileURLToPath(new URL('../../../samples/uml/', import.meta.url));
        const r = await loadWorkspace(['uml.arbor', 'library.arbor'].map(f => ({ uri: f, text: readFileSync(dir + f, 'utf8') })));
        expect(r.diagnostics).toEqual([]);
    });

    it('bad multiplicity', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: 'profile p { kind A { prop n: int [3..1] } }' }]);
        expect(codes(r)).toContain(C.BadMultiplicity);
    });
});
