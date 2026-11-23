import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkspace } from '@arbor/language';
import { CollectionValue, EnumValue, checkExpression, evaluate, irTypeSpace, irValueSpace, parseExpression, typeName, type Value } from '../src/index.js';

const dir = fileURLToPath(new URL('../../../samples/uml/', import.meta.url));
const load = () => loadWorkspace(['uml.arbor', 'orm.arbor', 'primitives.arbor', 'library.arbor', 'loan.arbor'].map(f => ({ uri: f, text: readFileSync(dir + f, 'utf8') })));

describe('expressions over the model (M2)', () => {
    it('type-check against the profiles: kinds are classes, features properties', async () => {
        const { ir } = await load();
        const space = irTypeSpace(ir);
        const self = space.classOf('uml.Region');
        const type = (text: string) => {
            const { type, diagnostics } = checkExpression(parseExpression(text).value!, { space, self });
            return diagnostics.length ? diagnostics.map(d => d.message) : typeName(type);
        };
        expect(type('subvertices')).toBe('Set(Vertex)');
        expect(type('subvertices->select(v | v.oclIsKindOf(Pseudostate))->collect(v | v.oclAsType(Pseudostate).kind)')).toBe('Bag(PseudostateKind)');
        expect(type("name.size() > 0 and transitions->forAll(t | t.trigger <> '')")).toBe('Boolean');
        expect(type('subvertices.outgoing')).toBe('Bag(Transition)');
        expect(type('subvertex')).toEqual(["Nothing called 'subvertex' here. Did you mean 'subvertices'?"]);
        expect(type('PseudostateKind::fork = PseudostateKind::join')).toBe('Boolean');
        expect(type('subvertices->exists(oclIsKindOf(uml::FinalState))')).toBe('Boolean');
    });

    it('evaluate against its elements: a well-formedness rule, and derived references', async () => {
        const { ir } = await load();
        const values = irValueSpace(ir);
        const run = (self: string, text: string): Value => evaluate(parseExpression(text).value!, { space: values, self: values.element(self)! });
        const main = 'lending.Loan.Lifecycle.main';
        // UML: a region has at most one initial pseudostate.
        const oneInitial = 'subvertices->select(v | v.oclIsKindOf(Pseudostate) and v.oclAsType(Pseudostate).kind = PseudostateKind::initial)->size() <= 1';
        expect(run(main, oneInitial)).toBe(true);
        expect(run(main, 'subvertices->size()')).toBe(6);
        expect(run(main, "subvertices->select(oclIsKindOf(State))->collect(name)->asSequence()")).toBeInstanceOf(CollectionValue);
        // Defaults count: a pseudostate's kind is initial unless it says otherwise.
        expect(run(`${main}.start`, 'kind')).toEqual(new EnumValue('PseudostateKind', 'initial'));
        expect(run(`${main}.assess`, 'kind = PseudostateKind::choice')).toBe(true);
        // Derived opposites: Overdue's outgoing transitions are those naming it as source.
        expect(run(`${main}.Overdue`, 'outgoing->size()')).toBe(2);
        expect(run(`${main}.Overdue`, "outgoing->collect(trigger)->includes('returned')")).toBe(true);
        // Through a reference to another model's element.
        expect(run('lending.Loan.item', 'type.name')).toBe('Item');
        // A derived union: what the containments subsetting it hold.
        expect(run('library.Item', 'ownedMembers->size()')).toBe(2);
    });
});

describe('rules in profiles (M2)', () => {
    const profile = `profile r {
        abstract kind Named {
            derived prop path: string [0..1] derive "if oclContainer().oclIsUndefined() then name else oclContainer().path + '/' + name endif"
            query depth(): int = "if oclContainer().oclIsUndefined() then 0 else oclContainer().depth() + 1 endif"
            query within(n: int): bool = "depth() <= n"
        }
        kind Folder extends Named {
            contains items: Named [0..*]
            ref      links: Folder [0..*]
            derived ref reachable: Folder [0..*] derive "links->closure(f | f.links)"
            derived prop loop: int [0..1] derive "loop + 1"
            query forever(): int = "forever()"
        }
    }`;
    // a links to b, b to c, c back to a.
    const model = 'model m { Folder a { Folder b { Folder c { links: [-> a] }  links: [-> a.b.c] }  links: [-> a.b] } }';

    it('type-check queries, with parameters, and the element holding one', async () => {
        const { ir } = await loadWorkspace([{ uri: 'r.arbor', text: profile }, { uri: 'm.arbor', text: model }]);
        const space = irTypeSpace(ir);
        const type = (text: string) => {
            const { type, diagnostics } = checkExpression(parseExpression(text).value!, { space, self: space.classOf('r.Folder') });
            return diagnostics.length ? diagnostics.map(d => d.message) : typeName(type);
        };
        expect(type('depth() + 1')).toBe('Integer');
        expect(type('within(2) and reachable->size() > 0')).toBe('Boolean');
        expect(type("within('x')")).toEqual(["'n' must be Integer, but this is String."]);
        expect(type('oclContainer().name')).toBe('any type');
    });

    it('work out derived features into the IR, and report the ones that fail', async () => {
        const { ir } = await loadWorkspace([{ uri: 'r.arbor', text: profile }, { uri: 'm.arbor', text: model }]);
        const el = (id: string) => ir.models[0].elements.find(e => e.id === id)!;
        expect(el('m.a.b.c').properties.path).toBe('a/b/c');
        expect(el('m.a').references.reachable).toEqual(['m.a.b', 'm.a.b.c', 'm.a']);   // around the cycle, once each
        expect(el('m.a').properties.loop).toBeUndefined();
        const values = irValueSpace(ir);
        const run = (self: string, text: string) => evaluate(parseExpression(text).value!, { space: values, self: values.element(self)! });
        expect(run('m.a.b.c', 'depth()')).toBe(2);
        expect(() => run('m.a', 'forever()')).toThrow(/calls itself without end/);
        expect(() => run('m.a', 'loop')).toThrow(/'loop' of a depends on itself/);
    });
});
