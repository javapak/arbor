import { diagramOf, diagramPath, diagramTitle, toFlowGraph } from '@arbor/adapter-flow';
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
        const r = await loadWorkspace(['uml.arbor', 'orm.arbor', 'library.arbor', 'loan.arbor'].map(f => ({ uri: f, text: readFileSync(dir + f, 'utf8') })));
        expect(r.diagnostics).toEqual([]);
        // In the model's diagram the state machine is one node, owned by Loan, that opens its own diagram.
        const sm = 'lending.Loan.Lifecycle', main = `${sm}.main`, terms = `${main}.Active.terms`;
        const outer = toFlowGraph(r.ir);
        const lifecycle = outer.nodes.find(n => n.id === sm)!;
        expect(lifecycle).toMatchObject({ data: { opens: true }, visual: { container: false } });
        expect(lifecycle.visual.layout).toBeUndefined();
        expect(outer.edges.find(e => e.targetNodeId === sm)?.data).toMatchObject({ relation: 'containment', label: 'ownedBehavior' });
        expect(outer.nodes.some(n => n.id.startsWith(`${sm}.`))).toBe(false);
        expect(outer.edges.some(e => e.id.startsWith(`${sm}.`))).toBe(false);
        const active = `${main}.Active`;
        expect([diagramOf(r.ir, `${terms}.Lent`), diagramOf(r.ir, `${main}.Overdue`), diagramOf(r.ir, sm)]).toEqual([active, sm, null]);
        expect(diagramPath(r.ir, active).map(e => e.id)).toEqual([sm, active]);

        // Its own diagram: what it holds, without it (its name is the title), and without its one region,
        // whose states take its place. The composite state Active is one node too, opening its own.
        const g = toFlowGraph(r.ir, { root: sm });
        const node = (id: string) => g.nodes.find(n => n.id === id)!;
        expect(diagramTitle(r.ir, sm)).toBe('«stateMachine» Lifecycle');
        expect(g.nodes.map(n => n.id.slice(main.length + 1))).toEqual(['start', 'Active', 'Overdue', 'Lost', 'closed', 'assess']);
        expect(g.nodes.every(n => n.parentId === undefined)).toBe(true);
        expect(g.edges.some(e => e.data.relation === 'containment')).toBe(false);
        expect(node(active)).toMatchObject({ data: { opens: true }, visual: { container: false, compartment: ['entry = "notifyMember()"'] } });
        expect(node(`${main}.Overdue`).data.opens).toBeUndefined();   // a simple state: nothing to open
        expect(node(`${main}.Overdue`).visual.presentation).toBeUndefined();
        expect(node(`${main}.Overdue`).data.size).toEqual({ width: 230.5, height: 86 });   // header, then its compartment, as the renderer sizes it
        const labels = (region: string, root = sm) => toFlowGraph(r.ir, { root }).edges.filter(e => e.id.startsWith(`${region}.Transition#`)).map(e => e.data.label);
        expect(labels(main)).toEqual(['', 'returned', 'after(14 days)', 'returned', '[fine == 0]', '[fine > 0] / chargeFine()',
            'after(90 days)', 'paid [amount >= replacementCost]']);
        // Pseudostates are drawn by their kind: the initial one by default, a choice as a diamond.
        expect(node(`${main}.start`).visual).toMatchObject({ shape: 'initialNode', size: { width: 24, height: 24 } });
        expect(node(`${main}.assess`).visual).toMatchObject({ shape: 'diamond', size: { width: 32, height: 32 } });

        // The composite state's diagram: its states, titled with its name.
        expect(toFlowGraph(r.ir, { root: active }).nodes.map(n => n.id.slice(terms.length + 1))).toEqual(['begin', 'Lent', 'Renewed']);
        expect(labels(terms, active)).toEqual(['', 'renew [renewals < 3]']);
        expect(diagramTitle(r.ir, active)).toBe('Active');
    });

    it('bad multiplicity', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: 'profile p { kind A { prop n: int [3..1] } }' }]);
        expect(codes(r)).toContain(C.BadMultiplicity);
    });
});
