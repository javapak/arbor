import { describe, expect, it } from 'vitest';
import { IRIndex } from '@arbor/ir';
import { loadWorkspace } from '../src/cli/load.js';
import { DiagnosticCode as C } from '../src/language/arbor-validator.js';

describe('a profile in parts', () => {
    const core = { uri: 'core.arbor', text: 'profile shapes part "Core" version "1.0" { abstract kind Shape { prop label: string [0..1] }  kind Group { contains members: Shape [0..*] } }' };
    const more = { uri: 'more.arbor', text: 'profile shapes part "More" version "1.0" { kind Circle extends Shape { prop r: float [0..1] } }' };
    // Another profile with a kind of the same name: inside shapes, its own wins, whichever part it's in.
    const other = { uri: 'other.arbor', text: 'profile art { kind Shape { prop ink: string [0..1] } }' };

    it('is one profile: one namespace, names resolving across its parts, one profile in the IR', async () => {
        const r = await loadWorkspace([core, more, other, { uri: 'm.arbor', text: 'model m { Group g { Circle c { r: 2  label: "c" } } }' }]);
        expect(r.diagnostics).toEqual([]);
        const shapes = r.ir.profiles.filter(p => p.name === 'shapes');
        expect(shapes).toHaveLength(1);
        expect(shapes[0].kinds.map(k => k.id)).toEqual(['shapes.Shape', 'shapes.Group', 'shapes.Circle']);
        expect(shapes[0].version).toBe('1.0');
        expect(new IRIndex(r.ir).isA('shapes.Circle', 'shapes.Shape')).toBe(true);
        expect(r.ir.models[0].elements.map(e => e.kind)).toEqual(['shapes.Group', 'shapes.Circle']);
    });

    it('needs each part named, once, at one version, and each name defined once', async () => {
        const messages = async (...files: Array<{ uri: string; text: string }>) => (await loadWorkspace(files)).diagnostics.map(d => `${d.uri}: ${d.message}`);
        expect(await messages(core, { uri: 'x.arbor', text: 'profile shapes { kind X {} }' })).toContain(
            'x.arbor: Another profile named \'shapes\' is defined in core.arbor. To write one profile in several files, name each part: profile shapes part "…" { … }.');
        expect(await messages(core, { uri: 'x.arbor', text: 'profile shapes part "Core" { kind X {} }' })).toContain('x.arbor: Profile shapes has another part "Core", in core.arbor.');
        expect(await messages(core, { uri: 'x.arbor', text: 'profile shapes part "X" version "2.0" { kind X {} }' })).toContain('x.arbor: Part "Core" of shapes says version "1.0", this one "2.0".');
        expect(await messages(core, { uri: 'x.arbor', text: 'profile shapes part "X" { kind Group {} }' })).toContain('x.arbor: Group is also defined in another part of shapes, in core.arbor.');
    });
});

describe('roles', () => {
    // Nothing named as in UML: what makes it checkable and runnable is what each kind and feature plays.
    const profile = { uri: 'auto.arbor', text: `profile auto {
        kind Machine plays class {
            contains fields: Field [0..*] plays attributes
            contains acts:   Act [0..*] plays operations
            contains behaviours: Automaton [0..*]
        }
        kind Number plays primitive {}
        kind Field { ref of: Number [0..1] plays type  prop start: expr [0..1] plays default }
        kind Act { prop does: action [0..1] plays body }
        kind Automaton plays machine, behavior { contains lanes: Lane [1..*] plays regions }
        kind Lane plays region { contains nodes: Node [0..*] plays vertices  contains arrows: Arrow [0..*] plays transitions }
        enum NodeKind { initial, choice }
        kind Node plays state { prop onEnter: action [0..1] plays entry }
        kind Start plays pseudostate { prop sort: NodeKind = initial plays pseudostateKind }
        kind Node2 extends Node {}
        kind Arrow plays transition {
            ref from: Node [0..1] plays source  ref to: Node [0..1] plays target
            ref fromStart: Start [0..1]
            prop on: string [0..1] plays trigger  prop when: expr [0..1] plays guard  prop then: action [0..1] plays effect
        }
    }` };

    it('are checked: known, and played by the right sort of kind or feature', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: `profile p {
            kind K plays clas, attributes {
                prop n: int [0..1] plays guard
                ref k: K [0..1] plays attributes
                contains ks: K [0..*] plays vertices
            }
        }` }]);
        expect(r.diagnostics.filter(d => d.code === C.BadRole).map(d => d.message)).toEqual([
            "There's no role 'clas'. Did you mean 'class'?",
            "'attributes' is played by a containment, not a kind.",
            "'guard' is played by a property of type expr, not int.",
            "'attributes' is played by a containment, not a reference.",
        ]);
    });

    it("make a profile's guards and effects checked against its classes", async () => {
        const r = await loadWorkspace([profile, { uri: 'm.arbor', text: `model m {
            Number Integer {}
            Machine Counter {
                Field n { of: -> Integer  start: "0" }
                Act bump { does: "n := n + 1" }
                Act broken { does: "m := 1" }
                behaviours += Automaton life { Lane l { } }
            }
        }` }]);
        expect(r.diagnostics.map(d => d.message)).toEqual(["Counter has no property 'm'. Did you mean 'n'?"]);
    });
});
