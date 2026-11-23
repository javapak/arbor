import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkspace } from '../src/cli/load.js';

const dir = fileURLToPath(new URL('../../../samples/uml/', import.meta.url));
const uml = ['uml.arbor', 'primitives.arbor'].map(f => ({ uri: f, text: readFileSync(dir + f, 'utf8') }));

/** Each problem in the model text, with the characters it points at. */
async function problems(model: string, profiles = uml) {
    const r = await loadWorkspace([...profiles, { uri: 'm.arbor', text: model }]);
    const lines = model.split('\n');
    return r.diagnostics.filter(d => d.uri === 'm.arbor' && d.code?.startsWith('EXP'))
        .map(d => `${d.code} ${d.message} @ ${lines[d.line - 1].slice(d.column - 1, d.column + 9)}`);
}

describe('expression slots, in any profile', () => {
    const profile = [{ uri: 'p.arbor', text: 'profile p { kind Rule { prop when: expr [0..1]  prop then: action [0..1] } }' }];

    it('are parsed, with problems pointing into the string', async () => {
        expect(await problems(`model m {
            Rule a { when: "x > 1 and"  then: "y := 1 z := 2" }
            Rule b { when: "\\"quoted\\" = name +"  then: "f(1); g(2);" }
            Rule c { when: 3 }
        }`, profile)).toEqual([
            'EXP001 Expected an expression, but the text ends here. @ "  then: "',
            "EXP001 Expected ';' between statements, found 'z'. @ z := 2\" }",
            // Past the escaped quotes: the error is at the end, not shifted by them.
            'EXP001 Expected an expression, but the text ends here. @ "  then: "',
        ]);
        const r = await loadWorkspace([...profile, { uri: 'm.arbor', text: 'model m { Rule c { when: 3 } }' }]);
        expect(r.diagnostics.map(d => d.message)).toEqual(["'when': expected an expression in double quotes."]);
    });

    it('are strings in the IR', async () => {
        const r = await loadWorkspace([...profile, { uri: 'm.arbor', text: 'model m { Rule a { when: "x > 1" } }' }]);
        expect(r.ir.models[0].elements[0].properties).toEqual({ when: 'x > 1' });
        expect(r.ir.profiles[0].kinds[0].features[0]).toMatchObject({ type: 'expr' });
    });
});

describe('expression slots in UML, checked against their class', () => {
    const model = (body: string) => `model m {
        Class Account {
            Property balance { type: -> primitives.Real  defaultValue: "0.0" }
            Property owner   { type: -> Person }
            Property limit   { type: -> primitives.Real  isReadOnly: true }
            Operation deposit { Parameter amount { type: -> primitives.Real }  body: "balance := balance + amount" }
            Operation overdrawn { isQuery: true  returns: -> primitives.Boolean  body: "return balance < 0" }
            ${body}
        }
        Class Savings { Generalization { general: -> Account }
            Property rate { type: -> primitives.Real }
            Operation accrue { body: "deposit(balance * rate)" }
        }
        Class Person { Property name { type: -> primitives.String }  Property age { type: -> primitives.Integer  defaultValue: "'old'" } }
    }`;

    it('accepts expressions that fit', async () => {
        expect(await problems(model(''))).toEqual([
            "EXP004 This must be Integer, but this is String. @ 'old'\" } }",   // a default of the wrong type
        ]);
    });

    it("finds self past the state machine: a behavior's context is its class", async () => {
        expect(await problems(model(`
            ownedBehavior += StateMachine Life {
                Region r {
                    Pseudostate s {}
                    State Open { entry: "deposit(1); owner.name := 'x'"  exit: "limit := 1" }
                    Transition { source: -> s  target: -> Open  guard: "overdrawn() or balance > limt"  effect: "deposit('a')" }
                    Transition { source: -> Open  target: -> s  guard: "balance"  effect: "deposit(-balance)" }
                }
            }`))).toEqual([
            "EXP007 'limit' is read-only (or derived), so it can't be assigned to. @ limit := 1",
            "EXP002 Nothing called 'limt' here. Did you mean 'limit'? @ limt\"  eff",
            "EXP004 'amount' must be Real, but this is String. @ 'a')\" }",
            'EXP004 This must be Boolean, but this is Real. @ balance"  ',
            "EXP004 This must be Integer, but this is String. @ 'old'\" } }",
        ]);
    });

    it("checks bodies: parameters are variables, a query can't change anything, results are returned", async () => {
        expect(await problems(model(`
            Operation bad { isQuery: true  returns: -> primitives.Boolean  body: "deposit(1); balance := 0; return true" }
            Operation half { returns: -> primitives.Real  body: "if balance > 0 then return balance / 2 endif" }
            Operation give { Parameter to { type: -> Person }  body: "to.age := to.age + 1; to.nme := 'x'" }`))).toEqual([
            "EXP006 'deposit' changes things, so it can't be called here: only queries can. @ deposit(1)",
            "EXP006 A query can't assign; only an action can. @ balance :=",
            'EXP008 This must return Real in every case. @ if balance',
            "EXP003 Person has no property 'nme'. Did you mean 'name'? @ to.nme := ",
            "EXP004 This must be Integer, but this is String. @ 'old'\" } }",
        ]);
    });

    it('inherits attributes and operations through generalizations', async () => {
        // Savings' accrue uses Account's balance and deposit; Savings conforms to Account.
        expect(await problems(model(`
            Property backup { type: -> Savings }
            Operation move { body: "backup.deposit(balance); backup.rate := backup.balance" }`))).toEqual([
            "EXP004 This must be Integer, but this is String. @ 'old'\" } }",
        ]);
    });
});
