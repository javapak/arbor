import { describe, expect, it } from 'vitest';
import { IRIndex } from '@arbor/ir';
import { loadWorkspace } from '../src/cli/load.js';
import { applyEdit, planSetSlot } from '../src/edits.js';
import { DiagnosticCode as C } from '../src/language/arbor-validator.js';

describe('subsets across references and containments', () => {
    // As in UML: a class's attributes are a derived union its owned attributes subset, and its
    // classifier behavior is one of its owned behaviors.
    const profile = { uri: 'p.arbor', text: `profile p {
        kind Classifier {
            derived ref attribute:        Attr [0..*]
            contains    ownedAttribute:   Attr [0..*] subsets attribute
            contains    ownedBehavior:    Behavior [0..*]
            ref         classifierBehavior: Behavior [0..1] subsets ownedBehavior
        }
        kind Attr {}
        kind Behavior {}
    }` };
    const load = (model: string) => loadWorkspace([profile, { uri: 'm.arbor', text: model }]);

    it('are allowed in profiles; a property and a containment still are not', async () => {
        const r = await load('model m {}');
        expect(r.diagnostics).toEqual([]);
        const bad = await loadWorkspace([{ uri: 'q.arbor', text: 'profile q { kind K { contains ks: K [0..*]  prop n: string [0..1] subsets ks } }' }]);
        expect(bad.diagnostics.map(d => d.message)).toEqual(["'n' cannot subset 'ks': one is a property, the other a containment."]);
    });

    it("work out a derived union from the containments that subset it", async () => {
        const r = await load('model m { Classifier C { Attr a {}  Attr b {}  Behavior run {}  classifierBehavior: -> run } }');
        expect(r.diagnostics).toEqual([]);
        expect(new IRIndex(r.ir).elements.get('m.C')!.references).toEqual({ attribute: ['m.C.a', 'm.C.b'], classifierBehavior: ['m.C.run'] });
    });

    it("name only what the containment they subset holds (ARB114)", async () => {
        const r = await load('model m { Classifier C { Behavior run {} }  Classifier D { Behavior other {}  classifierBehavior: -> C.run } }');
        const d = r.diagnostics.filter(x => x.code === C.NotContained);
        expect(d.map(x => x.message)).toEqual(["'classifierBehavior' subsets 'ownedBehavior', so it names one of the elements this Classifier holds there; run isn't."]);
    });
});

describe('quoted names', () => {
    const profile = { uri: 'p.arbor', text: 'profile p { kind Box { contains items: Box [0..*]  ref link: Box [0..*] } }' };
    const load = (model: string) => loadWorkspace([profile, { uri: 'm.arbor', text: model }]);

    it('can hold spaces, dots, operators, keywords and escaped quotes', async () => {
        const r = await load(`model m {
            Box "Order Line" { Box "unit price" {} Box "v1.2" {} }
            Box "operator+" {}  Box "model" {}  Box "say \\"hi\\"" {}
            Box plain { link: [-> "Order Line", -> m."operator+", -> "Order Line"."unit price", -> "Order Line"."v1.2", -> "model", -> "say \\"hi\\""] }
        }`);
        expect(r.diagnostics).toEqual([]);
        const names = r.ir.models[0].elements.map(e => e.name);
        expect(names).toEqual(['Order Line', 'unit price', 'v1.2', 'operator+', 'model', 'say "hi"', 'plain']);
        expect(new IRIndex(r.ir).elements.get('m.plain')!.references.link)
            .toEqual(['m.Order Line', 'm.operator+', 'm.Order Line.unit price', 'm.Order Line.v1.2', 'm.model', 'm.say "hi"']);
    });

    it('report a name nothing has', async () => {
        const r = await load('model m { Box "Order Line" {}  Box a { link: [-> "Order Lien"] } }');
        expect(r.diagnostics.map(d => d.message)).toEqual(["Could not resolve reference to Element named 'Order Lien'."]);
    });

    it('are written quoted when an edit names them', async () => {
        const text = 'model m {\n    Box "Order Line" {}\n    Box a {}\n}\n';
        const sources = [profile, { uri: 'm.arbor', text }];
        const plan = await planSetSlot(sources, 'm.a', 'link', ['m.Order Line']);
        if ('error' in plan) throw new Error(plan.error);
        expect(applyEdit(text, plan)).toContain('Box a { link: [-> "Order Line"] }');
    });
});
