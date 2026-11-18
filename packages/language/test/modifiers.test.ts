import { describe, expect, it } from 'vitest';
import { IRIndex, referenceSlotsFor, slotSchema } from '@arbor/ir';
import { toFlowGraph } from '@arbor/adapter-flow';
import { DiagnosticCode as C } from '../src/language/arbor-validator.js';
import { loadWorkspace } from '../src/cli/load.js';

/** A slice of UML's metamodel: a derived union of members, attributes subsetting it, owners as derived opposites. */
const PROFILE = `profile p {
    abstract kind Named {}
    kind Classifier extends Named {
        derived contains ownedMembers: Named [0..*]
        ordered contains attributes: Property [0..*] subsets ownedMembers
        contains operations: Operation [0..*] subsets ownedMembers
        ref general: Classifier [0..*]
        derived ref specific: Classifier [0..*] opposite general
        derived ref related: Classifier [0..*]
        ref friends: Classifier [0..*] subsets related
        ref rivals: Classifier [0..*] subsets related
        ref partner: Classifier [0..1] opposite partner
        unique prop tags: string [0..*]
        readonly prop qualifiedName: string [0..1]
    }
    kind Property extends Named {
        derived ref owningClass: Classifier [0..1] opposite attributes
        ref type: Classifier [0..1]
    }
    kind Operation extends Named {
        derived ref owner: Classifier [0..1] opposite ownedMembers
        ref returns: Classifier [0..1]
    }
    kind Typed extends Property {
        ref classifier: Classifier [1] redefines type
    }
}`;

async function load(model: string, profile = PROFILE) {
    return loadWorkspace([{ uri: 'p.arbor', text: profile }, { uri: 'm.arbor', text: model }]);
}

describe('feature modifiers', () => {
    it('carries modifiers and relations into the IR', async () => {
        const r = await load('model m {}');
        expect(r.diagnostics).toEqual([]);
        const index = new IRIndex(r.ir);
        expect(index.feature('p.Classifier', 'attributes')).toMatchObject({ ordered: true, subsets: ['ownedMembers'] });
        expect(index.feature('p.Classifier', 'ownedMembers')).toMatchObject({ derived: true });
        expect(index.feature('p.Property', 'owningClass')).toMatchObject({ derived: true, opposite: 'attributes' });
        expect(index.feature('p.Classifier', 'tags')).toMatchObject({ unique: true });
        expect(index.feature('p.Typed', 'classifier')).toMatchObject({ redefines: ['type'] });
    });

    it('puts a nested element in the most specific containment, never a derived one', async () => {
        const r = await load('model m { Classifier A { Property x {} Operation op {} } }');
        expect(r.diagnostics).toEqual([]);
        const index = new IRIndex(r.ir);
        expect(index.elements.get('m.A.x')!.containedIn).toBe('attributes');
        expect(index.elements.get('m.A.op')!.containedIn).toBe('operations');
    });

    it('works out derived opposites and unions', async () => {
        const r = await load(`model m {
            Classifier A { Property x {} Operation op {} friends: [-> B]  rivals: [-> C, -> B] }
            Classifier B { general: [-> A] }
            Classifier C { general: [-> A] }
        }`);
        expect(r.diagnostics).toEqual([]);
        const el = (id: string) => new IRIndex(r.ir).elements.get(id)!;
        // From containment: the owner, also through a containment that subsets the opposite.
        expect(el('m.A.x').references.owningClass).toEqual(['m.A']);
        expect(el('m.A.op').references.owner).toEqual(['m.A']);
        // From references: whoever points back.
        expect(el('m.A').references.specific).toEqual(['m.B', 'm.C']);
        expect(el('m.B').references.specific).toBeUndefined();
        // A derived union: everything in the features that subset it.
        expect(el('m.A').references.related).toEqual(['m.B', 'm.C']);
        // A superset that is written includes its subsets' values when read through the index.
        expect(new IRIndex(r.ir).values(el('m.A'), 'related')).toEqual(['m.B', 'm.C']);
    });

    it('rejects writing a derived feature, and duplicates in a unique one', async () => {
        const r = await load(`model m {
            Classifier A { specific: [-> A]  tags: ["x", "y", "x"] }
        }`);
        expect(r.diagnostics.filter(d => d.severity === 'error').map(d => d.code)).toEqual([C.DerivedSlot, C.DuplicateValue]);
    });

    it('warns when written opposites disagree', async () => {
        const r = await load('model m { Classifier A { partner: -> B } Classifier B {} Classifier C { partner: -> D } Classifier D { partner: -> C } }');
        const w = r.diagnostics.filter(d => d.code === C.OppositeMismatch);
        expect(w).toHaveLength(1);
        expect(w[0]).toMatchObject({ severity: 'warning', line: 1 });
        expect(w[0].message).toMatch(/B's 'partner' doesn't point back at A/);
    });

    it('a redefined feature is replaced by the one redefining it', async () => {
        const r = await load('model m { Classifier K {} Typed t { classifier: -> K  type: -> K } }');
        expect(r.diagnostics.find(d => d.code === C.UnknownSlot)?.message).toMatch(/no feature 'type'/);
        const names = new IRIndex(r.ir).features('p.Typed').map(f => f.name);
        expect(names).toContain('classifier');
        expect(names).not.toContain('type');
    });

    it('checks opposites, subsets and redefinitions in profiles', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: `profile q {
            kind A {
                ref b: B [0..1] opposite owner
                ref c: B [0..1] opposite nope
                prop n: int [0..1] opposite b
                contains bs: B [0..*]
                ref few: B [0..1] subsets bs
                contains some: B [0..3]
                contains more: B [0..*] subsets some
                ref self: B [0..1] subsets self
            }
            kind B {
                ref owner: A [0..1] opposite c
                ref parent: A [0..*] opposite bs
                ref thing: A [0..1]
            }
            kind C extends B {
                ref thing2: B [0..1] redefines thing
                ref other: A [0..1] redefines nothing
            }
        }` }]);
        const by = (code: string) => r.diagnostics.filter(d => d.code === code).map(d => d.message);
        expect(by(C.BadOpposite)).toEqual([
            "'owner' of B names 'c' as its opposite, not 'b'.",
            "B has no feature 'nope'.",
            'Only references and containments have opposites.',
            "'c' of A names 'nope' as its opposite, not 'owner'.",
            "'parent' is the owner through 'bs', so it holds one element at most: write [0..1] or [1].",
        ]);
        expect(by(C.BadSubsets)).toEqual([
            "'few' cannot subset 'bs': one is a reference, the other a containment.",
            "'more' allows more values than 'some' (3), which holds them all.",
            "'self' cannot subset itself.",
        ]);
        expect(by(C.BadRedefines)).toEqual([
            "'thing2' cannot redefine 'thing': B isn't A or a kind of it.",
            "C inherits no feature 'nothing' to redefine. Did you mean 'thing'?",
        ]);
    });

    it('derived and readonly features are read-only in forms, not offered for connecting, and not drawn', async () => {
        const r = await load('model m { Classifier A {} Classifier B { general: [-> A] } }');
        const index = new IRIndex(r.ir);
        const schema = slotSchema(index, 'p.Classifier');
        expect(schema.properties.specific.readOnly).toBe(true);
        expect(schema.properties.qualifiedName.readOnly).toBe(true);
        expect(schema.properties.general.readOnly).toBeUndefined();
        expect(schema.properties.tags).toMatchObject({ uniqueItems: true });
        expect(referenceSlotsFor(index, index.elements.get('m.B')!, index.elements.get('m.A')!).map(f => f.name))
            .toEqual(['general', 'friends', 'rivals', 'partner']);
        const edges = toFlowGraph(r.ir).edges.map(e => e.data.feature);
        expect(edges).toEqual(['general']);   // not A's derived `specific`
    });
});
