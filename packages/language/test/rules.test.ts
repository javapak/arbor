import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import schema from '../../ir/schema/ir.schema.json' with { type: 'json' };
import { loadWorkspace } from '../src/cli/load.js';
import { DiagnosticCode as C } from '../src/language/arbor-validator.js';

const profile = `profile t {
    abstract kind Named {
        derived prop label: string [0..1] derive "name + '!'"
        invariant named: "not name.oclIsUndefined()"  message "Everything needs a name."
    }
    kind Team extends Named {
        contains members: Person [0..*]
        prop size: int [0..1]
        query headcount(): int = "members->size()"
        invariant fits: "size.oclIsUndefined() or headcount() <= size"  message "More members than the team's size."
    }
    kind Person extends Named {
        derived prop initial: string [0..1] derive "name.substring(1, 1)"
        derived prop shout: string [0..1] derive "nick.toUpper()"
        prop nick: string [0..1]
    }
}`;
const load = (model: string, p = profile) => loadWorkspace([{ uri: 't.arbor', text: p }, { uri: 'm.arbor', text: model }]);

describe('rules in profiles', () => {
    it('are type-checked against the kind, with problems in the string', async () => {
        const r = await loadWorkspace([{ uri: 'p.arbor', text: `profile p {
            kind K {
                prop n: int [0..1]
                ref  k: K [0..1]
                invariant bad: "n + 1"
                derived prop twice: int [0..1] derive "n * 2.5"
                query plus(by: int): int = "n + bi"
                derived ref other: K [0..1] opposite k derive "k"
                prop plain: string [0..1] derive "'x'"
            }
        }` }]);
        const lines = r.diagnostics.map(d => `${d.code} ${d.message}`);
        expect(lines).toEqual([
            'EXP004 This must be Boolean, but this is Integer.',          // the invariant
            'EXP004 This must be Integer, but this is Real.',             // twice's derive
            "ARB014 'other' is worked out from its opposite already; it can't also have an expression.",
            "ARB014 'plain' has an expression to work it out, so it's derived: write 'derived' before it.",
            "EXP002 Nothing called 'bi' here. Did you mean 'by'?",       // the query's body
        ]);
        // Each points at its characters: 'bi' inside the query's body.
        const bi = r.diagnostics.find(d => d.message.includes("'bi'"))!;
        expect(bi.column).toBe(`                query plus(by: int): int = "n + `.length + 1);
    });

    it('are kept by every element of the kind, its sub-kinds too, or reported on it with their message', async () => {
        const r = await load(`model m {
            Team core { size: 1  Person ann {}  Person bob {} }
            Team open { Person cy {} }
        }`);
        expect(r.diagnostics.filter(d => d.code === C.BrokenInvariant).map(d => [d.line, d.message])).toEqual([
            [2, "Team core breaks 'fits': More members than the team's size."],
        ]);
        const unnamed = await load('model m { Team { } }');
        expect(unnamed.diagnostics.find(d => d.code === C.BrokenInvariant)?.message).toBe("This Team breaks 'named' (of Named): Everything needs a name.");
    });

    it('work out derived features into the IR, and warn where one fails', async () => {
        const r = await load('model m { Team core { Person ann { nick: "a" }  Person bob {} } }');
        const el = (id: string) => r.ir.models[0].elements.find(e => e.id === id)!.properties;
        expect(el('m.core')).toEqual({ label: 'core!' });
        expect(el('m.core.ann')).toEqual({ nick: 'a', label: 'ann!', initial: 'a', shout: 'A' });
        expect(r.diagnostics.filter(d => d.code === C.DeriveFailed).map(d => d.message)).toEqual([
            "'shout' of Person bob couldn't be worked out: 'shout' of bob: 'toUpper' was called on null.",
        ]);
    });

    it('are in the IR, which the schema accepts', async () => {
        const r = await load('model m { Team core {} }');
        const team = r.ir.profiles[0].kinds.find(k => k.name === 'Team')!;
        expect(team.invariants).toEqual([{ name: 'fits', expr: 'size.oclIsUndefined() or headcount() <= size', message: "More members than the team's size." }]);
        expect(team.operations).toEqual([{ name: 'headcount', params: [], returns: 'int', multiplicity: { lower: 1, upper: 1 }, body: 'members->size()' }]);
        expect(r.ir.profiles[0].kinds.find(k => k.name === 'Named')!.features[0]).toMatchObject({ derived: true, derive: "name + '!'" });
        expect(new Validator(schema as object, '2020-12').validate(r.ir).valid).toBe(true);
    });
});
