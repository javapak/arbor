import { describe, expect, it } from 'vitest';
import { IRIndex, referenceSlotsFor, slotSchema, slotText } from '@arbor/ir';
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
                prop label: string [0..1] subsets bs
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
            "'label' cannot subset 'bs': one is a property, the other a containment.",
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

describe('unnamed elements', () => {
    const profile = `profile u {
        kind Class { contains generalizations: Generalization [0..*]  contains notes: Note [0..*] }
        kind Generalization {
            ref general: Class [1]
            visual { source: "owner"  target: "general"  targetMarker: "triangle" }
        }
        kind Note { ref about: Note [0..1] }
    }`;

    it('get IDs from their kind and place among unnamed siblings, unless they have a stable one', async () => {
        const r = await load(`model m {
            Class A {}
            Class B { Generalization { general: -> A }  Generalization @"b-is-c" { general: -> C }  Generalization { general: -> C } }
            Class C {}
            Note {}
        }`, profile);
        expect(r.diagnostics).toEqual([]);
        const ids = r.ir.models[0].elements.map(e => e.id);
        expect(ids).toEqual(['m.A', 'm.B', 'm.B.Generalization#1', 'b-is-c', 'm.B.Generalization#2', 'm.C', 'm.Note#1']);
        expect(r.ir.models[0].elements.find(e => e.id === 'm.Note#1')!.name).toBe('');
        // Drawn: the unnamed edge kind with no label, the unnamed node as `:Kind`.
        const g = toFlowGraph(r.ir);
        expect(g.edges.find(e => e.id === 'm.B.Generalization#1')!.data.label).toBe('');
        expect(g.nodes.find(n => n.id === 'm.Note#1')!.data.label).toBe(':Note');
    });

    it('cannot be referenced by name, and messages say which element they mean', async () => {
        const r = await load('model m { Class A {} Class B { Generalization {} } Note n { about: -> Note } }', profile);
        expect(r.diagnostics.find(d => d.code === C.MissingRequired)?.message).toBe("Generalization (unnamed) is missing required 'general'.");
        expect(r.diagnostics.some(d => d.message.includes("Could not resolve reference to Element named 'Note'"))).toBe(true);
    });
});

describe('named containments', () => {
    // As in UML: a StateMachine is both a Behavior and a Class, so in a Class it fits
    // ownedBehavior and nestedClassifier, neither of which subsets the other.
    const profile = `profile n {
        abstract kind Classifier {
            derived contains ownedMembers:  Classifier [0..*]
            contains nestedClassifier:      Classifier [0..*] subsets ownedMembers
            contains ownedBehavior:         Behavior [0..*] subsets ownedMembers
            contains classifierBehavior:    Behavior [0..1]
            contains notes:                 Note [0..*]
            ref      general:               Classifier [0..1]
            prop     isActive:              bool = false
        }
        kind Class extends Classifier {}
        abstract kind Behavior extends Class {}
        kind StateMachine extends Behavior {}
        kind Note {}
    }`;

    it('an ambiguous nested element says which containments fit and how to choose', async () => {
        const r = await load('model m { Class A { StateMachine sm {} } }', profile);
        const d = r.diagnostics.find(d => d.code === C.ChildNotAllowed)!;
        expect(d.message).toBe("StateMachine fits several containments of Class (nestedClassifier, ownedBehavior, classifierBehavior); " +
            "name the one that holds it, e.g. 'nestedClassifier += StateMachine ...'.");
    });

    it('goes into the containment it names, which counts toward its bounds', async () => {
        const r = await load(`model m { Class A {
            ownedBehavior += StateMachine sm {}
            nestedClassifier += StateMachine inner {}
            classifierBehavior += <<Tagged>> StateMachine main @"main" {}
            notes += Note {}
            Note {}
        } }`, profile.replace('kind Note {}', 'kind Note {}\n        stereotype Tagged extends Behavior {}'));
        expect(r.diagnostics).toEqual([]);
        const el = (id: string) => new IRIndex(r.ir).elements.get(id)!;
        expect(el('m.A.sm').containedIn).toBe('ownedBehavior');
        expect(el('m.A.inner').containedIn).toBe('nestedClassifier');
        expect(el('main')).toMatchObject({ containedIn: 'classifierBehavior', stereotypes: ['n.Tagged'] });
        expect(el('m.A.Note#1').containedIn).toBe('notes');
        expect(el('m.A.Note#2').containedIn).toBe('notes');

        const tooMany = await load('model m { Class A { classifierBehavior += StateMachine a {}  classifierBehavior += StateMachine b {} } }', profile);
        expect(tooMany.diagnostics.find(d => d.code === C.TooMany)?.message).toBe("'classifierBehavior' allows at most 1, found 2.");
    });

    it('rejects a containment that is unknown, not a containment, derived, of the wrong kind, or at the top level', async () => {
        const r = await load(`model m {
            Class A {
                ownedBehaviour += StateMachine a {}
                general += StateMachine b {}
                ownedMembers += StateMachine c {}
                ownedBehavior += Class d {}
            }
            notes += Note top {}
        }`, profile);
        const errors = r.diagnostics.filter(d => d.code === C.ChildNotAllowed);
        expect(errors.map(d => d.message)).toEqual([
            "Class has no containment 'ownedBehaviour'. Did you mean 'ownedBehavior'?",
            "'general' of Class is a reference, not a containment; set it as a slot (general: ...).",
            "'ownedMembers' of Class is derived and holds nothing directly; use a containment that subsets it (nestedClassifier, ownedBehavior, classifierBehavior).",
            "'ownedBehavior' of Class holds Behavior elements, not Class. Did you mean 'nestedClassifier'?",
            "'notes +=' names a containment of the parent, but top is at the top level.",
        ]);
        expect(errors[0].fix).toBe('ownedBehavior');
        expect(new IRIndex(r.ir).elements.get('m.A.a')!.containedIn).toBeNull();
    });

    it('keywords can name the containment', async () => {
        const r = await load('model m { K k { visual += K inner {} } }', 'profile k { kind K { contains visual: K [0..*] } }');
        expect(r.diagnostics).toEqual([]);
        expect(new IRIndex(r.ir).elements.get('m.k.inner')!.containedIn).toBe('visual');
    });
});

describe('datatypes', () => {
    const profile = `profile d {
        enum Country { no, se }
        datatype Address {
            prop street:  string [1]
            prop country: Country = no
        }
        datatype Contact {
            prop email:   string [0..1]
            prop address: Address [0..1]
        }
        kind Customer {
            prop home:     Address [0..1]
            prop contacts: Contact [0..*]
            prop name:     string [0..1]
        }
    }`;

    it('are structured values, written in place and carried into the IR as records', async () => {
        const r = await load(`model m {
            Customer ada {
                home: { street: "Main St"  country: se }
                contacts: [ { email: "a@x.org" }, { address: { street: "Side St" } } ]
            }
        }`, profile);
        expect(r.diagnostics).toEqual([]);
        const index = new IRIndex(r.ir);
        expect(index.datatypes.get('d.Address')!.features.map(f => f.name)).toEqual(['street', 'country']);
        expect(index.feature('d.Customer', 'home')).toMatchObject({ type: { datatype: 'd.Address' } });
        const ada = index.elements.get('m.ada')!;
        expect(ada.properties.home).toEqual({ street: 'Main St', country: 'se' });
        expect(ada.properties.contacts).toEqual([{ email: 'a@x.org' }, { address: { street: 'Side St' } }]);
        // Shown as the text writes them: strings quoted, enum literals bare.
        expect(slotText(index, ada, 'home', ada.properties.home)).toBe('{ street: "Main St"  country: se }');
        expect(toFlowGraph(r.ir).nodes[0].visual.compartment![0]).toBe('home = { street: "Main St"  cou…');
        // Forms show them as text, read-only.
        expect(slotSchema(index, 'd.Customer').properties.home).toMatchObject({ type: 'object', readOnly: true, 'x-arbor-text': true });
    });

    it('checks fields like slots', async () => {
        const r = await load(`model m {
            Customer a { home: { stret: "x" } }
            Customer b { home: { street: 3  country: dk } }
            Customer c { home: "Main St"  name: { street: "x" } }
        }`, profile);
        const errors = r.diagnostics.filter(d => d.severity === 'error');
        expect(errors.map(d => d.code)).toEqual([C.UnknownSlot, C.MissingRequired, C.TypeMismatch, C.TypeMismatch, C.TypeMismatch, C.TypeMismatch]);
        expect(errors[0].fix).toBe('street');
        expect(errors[1].message).toBe("This Address is missing required 'street'.");
        expect(errors[4].message).toBe("'home' takes Address values: write { field: value ... }.");
        expect(errors[5].message).toBe("'name' expects a value, not { ... }.");
    });

    it('take no default', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: 'profile q { datatype P { prop x: int } kind K { prop p: P = 3 } }' }]);
        expect(r.diagnostics.map(d => d.code)).toEqual([C.BadDefault]);
    });
});

describe('stereotypes', () => {
    const profile = `profile s {
        kind Class { prop isAbstract: bool = false  contains attributes: Attribute [0..*] }
        kind Attribute { prop type: string [0..1]  visual { member: true } }
        kind Note {}
        stereotype Entity extends Class {
            prop table: string [1]
            ref audit: Class [0..1]
            visual { color: "#f59e0b"  container: true }
        }
        stereotype Audited extends Class { prop retention: int = 30 }
        stereotype Key extends Attribute {}
        stereotype Clash extends Class { prop isAbstract: bool  contains things: Note [0..*] }
        stereotype Tabled extends Class { prop table: string [0..1] }
    }`;

    it('add tagged values and visuals to the elements they are applied to', async () => {
        const r = await load(`model m {
            <<Entity, Audited>> Class Customer { table: "customers"  retention: 90  audit: -> Log
                <<Key>> Attribute id { type: "uuid" }
            }
            «Entity» Class Log { table: "log" }
        }`, profile);
        expect(r.diagnostics.filter(d => d.code !== C.BadStereotype)).toEqual([]);
        const index = new IRIndex(r.ir);
        const customer = index.elements.get('m.Customer')!;
        expect(customer.stereotypes).toEqual(['s.Entity', 's.Audited']);
        expect(customer.properties).toEqual({ table: 'customers', retention: 90 });
        expect(customer.references).toEqual({ audit: ['m.Log'] });
        expect(index.elements.get('m.Log')!.stereotypes).toEqual(['s.Entity']);
        expect(index.stereotypes.get('s.Entity')).toMatchObject({ extends: ['s.Class'], visual: { color: '#f59e0b' } });
        // Their slots join the element's in forms; their visuals restyle it but don't change its structure.
        expect(Object.keys(slotSchema(index, customer).properties)).toEqual(['isAbstract', 'table', 'audit', 'retention']);
        expect(slotSchema(index, customer).required).toEqual(['table']);
        expect(index.elementVisual(customer)).toMatchObject({ color: '#f59e0b' });
        expect(index.elementVisual(customer).container).toBeUndefined();
        const g = toFlowGraph(r.ir);
        const node = g.nodes.find(n => n.id === 'm.Customer')!;
        expect(node.data.label).toBe('«Entity, Audited» Customer');
        expect(node.visual.color).toBe('#f59e0b');
        expect(node.visual.compartment).toEqual(['table = "customers"', 'retention = 90']);
        expect(g.nodes.find(n => n.id === 'm.Customer.id')!.visual.detail).toBe('«Key»');
        expect(g.edges.map(e => e.data.feature)).toEqual(['audit']);
    });

    it('apply only to the kinds they extend, once, without clashing', async () => {
        const r = await load(`model m {
            <<Key>> Class A {}
            <<Audited, Audited>> Class B {}
            <<Entity, Tabled>> Class C { table: "c" }
            <<Entity>> Class D {}
            Class E { retention: 3 }
        }`, profile);
        const errors = r.diagnostics.filter(d => d.severity === 'error' && d.code !== C.BadStereotype);
        expect(errors.map(d => d.message)).toEqual([
            'Key applies to Attribute, not Class.',
            'Audited is applied twice.',
            "Tabled and Entity both add 'table', so it would be ambiguous here.",
            "Class D is missing required 'table'.",
            "Class has no feature 'retention'.",
        ]);
    });

    it('add new names, and no containments', async () => {
        const r = await load('model m {}', profile);
        expect(r.diagnostics.filter(d => d.code === C.BadStereotype).map(d => d.message)).toEqual([
            "'isAbstract' is already a feature of Class, which Clash extends.",
            "Stereotypes add properties and references, not containments ('things').",
        ]);
    });
});

describe('visual when', () => {
    const profile = `profile v {
        enum Mode { plain, loud, quiet }
        kind Node {
            prop mode:  Mode = plain
            prop ready: bool [0..1]
            prop tags:  string [0..*]
            ref  other: Node [0..1]
            visual { shape: "rectangle"  color: "#111111"  width: 100 }
            visual when mode = loud   { color: "#ff0000"  width: 140 }
            visual when ready = true  { icon: "✓" }
        }
        kind Special extends Node {
            visual when mode = loud { shape: "diamond" }
            visual when mode = plain { color: "#00ff00" }
        }
        stereotype Muted extends Node { visual { color: "#999999" } }
    }`;

    it('restyles the elements whose property, written or by default, has the value', async () => {
        const r = await load(`model m {
            Node a {}
            Node b { mode: loud  ready: true }
            Special c { mode: loud }
            Special d {}
            <<Muted>> Node e { mode: loud }
        }`, profile);
        expect(r.diagnostics).toEqual([]);
        const index = new IRIndex(r.ir);
        const visual = (id: string) => index.elementVisual(index.elements.get(id)!);
        expect(visual('m.a')).toEqual({ shape: 'rectangle', color: '#111111', width: 100 });
        expect(visual('m.b')).toEqual({ shape: 'rectangle', color: '#ff0000', width: 140, icon: '✓' });
        // Inherited blocks first, then the kind's own; a stereotype still has the last word.
        expect(visual('m.c')).toEqual({ shape: 'diamond', color: '#ff0000', width: 140 });
        expect(visual('m.d')).toMatchObject({ color: '#00ff00' });   // the default, plain
        expect(visual('m.e')).toMatchObject({ color: '#999999', width: 140 });
        expect(index.kinds.get('v.Node')!.visualWhen).toEqual([
            { feature: 'mode', value: 'loud', visual: { color: '#ff0000', width: 140 } },
            { feature: 'ready', value: true, visual: { icon: '✓' } }
        ]);
        // Sizes follow, and the tested property isn't listed: the looks show it.
        const node = toFlowGraph(r.ir).nodes.find(n => n.id === 'm.b')!;
        expect(node.visual.size.width).toBe(140);
        expect(node.visual.compartment).toBeUndefined();
    });

    it('tests one value of a property of the kind, and only restyles', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: `profile w {
            enum Mode { plain, loud }
            datatype Point { prop x: int [1] }
            kind K {
                prop mode: Mode [0..1]
                prop tags: string [0..*]
                prop at:   Point [0..1]
                ref  other: K [0..1]
                visual when mood = loud  {}
                visual when other = loud {}
                visual when tags = "a"   {}
                visual when at = 1       {}
                visual when mode = shout {}
                visual when mode = loud  { container: true  color: "#ff0000" }
            }
            stereotype S extends K { visual when mode = loud { color: "#ff0000" } }
        }` }]);
        const by = (severity: string) => r.diagnostics.filter(d => d.code === C.BadVisualCondition && d.severity === severity).map(d => d.message);
        expect(by('error')).toEqual([
            "K has no property 'mood'. Did you mean 'mode'?",
            "'other' is a reference; 'visual when' tests a property's value.",
            "'tags' holds several values; 'visual when' tests a property with one.",
            "'at' holds Point values; 'visual when' tests a string, number, bool or enum.",
            expect.stringMatching(/^'mode = …': .*Mode/),
            "A stereotype's visuals apply to every element it's applied to; 'visual when' is for kinds.",
        ]);
        expect(by('warning')).toEqual(["Visual 'container' decides how every K is laid out, so 'visual when' can't change it; it's ignored here."]);
    });
});
