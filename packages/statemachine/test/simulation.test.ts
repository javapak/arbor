import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkspace } from '@arbor/language';
import { DAY, Simulation, parseTrigger, type TraceEntry } from '../src/index.js';

const dir = fileURLToPath(new URL('../../../samples/uml/', import.meta.url));
const read = (f: string) => ({ uri: f, text: readFileSync(dir + f, 'utf8') });
const sample = () => loadWorkspace(['uml.arbor', 'orm.arbor', 'primitives.arbor', 'library.arbor', 'loan.arbor'].map(read));
/** A machine of a test class, `m.C.M`, with the sample profile and primitive types. */
const machine = async (body: string, attributes = '') => {
    const r = await loadWorkspace([read('uml.arbor'), read('primitives.arbor'), { uri: 'm.arbor', text: `model m {
        Class C {
            ${attributes}
            ownedBehavior += StateMachine M { ${body} }
        }
    }` }]);
    expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    return new Simulation(r.ir, 'm.C.M');
};

/** The trace in short: `+State`, `-State`, `a -> b`, `call op`, `!message`, the IDs without their machine. */
function story(trace: TraceEntry[], prefix: string): string[] {
    const s = (id: string) => id.slice(prefix.length);
    return trace.flatMap((e): string[] => {
        switch (e.kind) {
            case 'enter': return [`+${s(e.state)}`];
            case 'exit': return [`-${s(e.state)}`];
            case 'transition': return [`${s(e.source)} -> ${s(e.target)}`];
            case 'call': return [`call ${e.operation}(${e.args.join(', ')})`];
            case 'event': return [`${e.event}?`];
            case 'ignored': return [`(${e.event} ignored)`];
            case 'error': return [`!${e.failure.message}`];
            case 'unsupported': return [`!${e.message}`];
            case 'finished': return ['finished'];
            default: return [];
        }
    });
}

describe('the loan sample', () => {
    const prefix = 'lending.Loan.Lifecycle.main.';

    it('starts in its initial states, entering outermost first, with the context class instance at its defaults', async () => {
        const sim = new Simulation((await sample()).ir, 'lending.Loan.Lifecycle').start();
        expect(story(sim.trace, prefix)).toEqual([
            'start -> Active', '+Active', 'call notifyMember()', 'Active.terms.begin -> Active.terms.Lent', '+Active.terms.Lent',
        ]);
        expect([...sim.active]).toEqual([`${prefix}Active`, `${prefix}Active.terms.Lent`]);
        expect(sim.variables()).toEqual({ item: 'null', member: 'null', fine: '0', renewals: '0', dailyRate: '0.5', replacementCost: '25' });
        expect(sim.enabledEvents()).toEqual(['renew', 'returned']);
        expect(sim.nextTimer()).toBe(14 * DAY);
    });

    it('runs guards and effects against the loan, and goes overdue on time', async () => {
        const sim = new Simulation((await sample()).ir, 'lending.Loan.Lifecycle').start();
        sim.trace.length = 0;
        sim.send('renew').send('renew').advance(20 * DAY).send('returned');
        expect(story(sim.trace, prefix)).toEqual([
            'renew?', '-Active.terms.Lent', 'Active.terms.Lent -> Active.terms.Renewed', 'call renew()', '+Active.terms.Renewed', 'call extendDueDate()',
            'renew?', '(renew ignored)',                            // Renewed has no renew transition
            '-Active.terms.Renewed', '-Active', 'Active -> Overdue', // after(14 days): inner state exited first
            '+Overdue', 'call sendReminder()', 'call accrueFine()', 'call chargeFine(0.5)',
            'returned?', '-Overdue', 'Overdue -> assess', 'call owes()', 'call owes()', 'assess -> closed', 'call notifyMember()',
            '+closed', 'finished',
        ]);
        expect(sim.trace.find(e => e.kind === 'enter' && e.state.endsWith('Overdue'))!.time).toBe(14 * DAY);
        expect(sim.variables()).toMatchObject({ fine: '0.5', renewals: '1' });
        expect(sim.finished).toBe(true);
        expect(sim.send('renew').trace.at(-1)).toMatchObject({ kind: 'finished' });   // a finished machine takes no more events
    });

    it('fires time triggers in order within one advance, and runs the lost path', async () => {
        const sim = new Simulation((await sample()).ir, 'lending.Loan.Lifecycle').start();
        sim.advance(200 * DAY);
        expect([...sim.active]).toEqual([`${prefix}Lost`]);
        expect(sim.trace.filter(e => e.kind === 'enter').map(e => e.time / DAY)).toEqual([0, 0, 14, 104]);
        expect(sim.variables().fine).toBe('25.5');   // half a day's fine, then the replacement cost
        sim.send('paid');
        expect(sim.variables().fine).toBe('0');
        expect(sim.finished).toBe(true);
    });
});

describe('UML semantics', () => {
    it('gives inner transitions priority over outer ones for the same event', async () => {
        const sim = await machine(`Region r {
            Pseudostate i {}
            State Outer { Region q { Pseudostate j {}  State Inner {}  State Other {}
                Transition { source: -> j  target: -> Inner }
                Transition { source: -> Inner  target: -> Other  trigger: "go" } } }
            State Away {}
            Transition { source: -> i  target: -> Outer }
            Transition { source: -> Outer  target: -> Away  trigger: "go" }
            Transition { source: -> Outer  target: -> Away  trigger: "leave" }
        }`);
        sim.start().send('go');
        expect([...sim.active].map(id => id.split('.').pop())).toEqual(['Outer', 'Other']);
        sim.send('leave');
        expect([...sim.active].map(id => id.split('.').pop())).toEqual(['Away']);
    });

    it('runs orthogonal regions together, and completes a composite state when all of them are final', async () => {
        const sim = await machine(`Region r {
            Pseudostate i {}
            State Both {
                Region a { Pseudostate ai {}  State A1 {}  FinalState Adone {}
                    Transition { source: -> ai  target: -> A1 }  Transition { source: -> A1  target: -> Adone  trigger: "x" } }
                Region b { Pseudostate bi {}  State B1 {}  FinalState Bdone {}
                    Transition { source: -> bi  target: -> B1 }  Transition { source: -> B1  target: -> Bdone  trigger: "y" } }
            }
            FinalState end {}
            Transition { source: -> i  target: -> Both }
            Transition { source: -> Both  target: -> end }
        }`);
        sim.start();
        expect([...sim.active].map(id => id.split('.').pop())).toEqual(['Both', 'A1', 'B1']);
        sim.send('x');
        expect(sim.finished).toBe(false);
        sim.send('y');   // both regions final: Both completes, and its completion transition leaves it
        expect(story(sim.trace, 'm.C.M.r.').slice(-9)).toEqual([
            '-Both.b.B1', 'Both.b.B1 -> Both.b.Bdone', '+Both.b.Bdone',
            '-Both.a.Adone', '-Both.b.Bdone', '-Both', 'Both -> end', '+end', 'finished',
        ]);
        expect(sim.finished).toBe(true);
    });

    it('exits and re-enters on a self-transition, and a time trigger only counts the visit that set it', async () => {
        const sim = await machine(`Region r {
            Pseudostate i {}
            State S { entry: "n := n + 1"  exit: "out := out + 1" }
            State T {}
            Transition { source: -> i  target: -> S }
            Transition { source: -> S  target: -> S  trigger: "again" }
            Transition { source: -> S  target: -> T  trigger: "after(10 s)" }
        }`, `Property n { type: -> primitives.Integer  defaultValue: "0" }  Property out { type: -> primitives.Integer  defaultValue: "0" }`);
        sim.start().advance(6000).send('again').advance(6000);
        expect(sim.variables()).toMatchObject({ n: '2', out: '1' });
        expect([...sim.active].map(id => id.split('.').pop())).toEqual(['S']);   // the first visit's timer is void
        sim.advance(4000);
        expect([...sim.active].map(id => id.split('.').pop())).toEqual(['T']);
    });

    it("reports what it can't do in the trace, and treats a failing guard as false", async () => {
        const sim = await machine(`Region r {
            Pseudostate i {}  State A {}  Pseudostate pick { kind: choice }  State B {}  Pseudostate h { kind: deepHistory }
            Transition { source: -> i  target: -> A }
            Transition { source: -> A  target: -> pick  trigger: "go" }
            Transition { source: -> pick  target: -> B  guard: "n / 0 > 1" }
            Transition { source: -> A  target: -> h  trigger: "back" }
        }`, `Property n { type: -> primitives.Integer  defaultValue: "1" }`);
        sim.start().send('go');
        expect(story(sim.trace, 'm.C.M.r.').slice(-3)).toEqual(['A -> pick', '!Division by zero.', "!No outgoing transition's guard holds here: the machine is stuck."]);
        const failure = sim.trace.find(e => e.kind === 'error');
        expect(failure).toMatchObject({ failure: { feature: 'guard', start: 0, end: 5 } });
    });
});

describe('triggers', () => {
    it('are event names, after(…) with a unit, or none', () => {
        expect(parseTrigger('returned')).toEqual({ event: 'returned' });
        expect(parseTrigger('after(14 days)')).toEqual({ after: 14 * DAY });
        expect(parseTrigger(' after( 1.5 h ) ')).toEqual({ after: 5_400_000 });
        expect(parseTrigger('')).toBe(null);
        expect(parseTrigger(undefined)).toBe(null);
        expect(parseTrigger('after(3 fortnights)')).toEqual({ error: "'fortnights' isn't a unit of time (ms, s, min, h, days, weeks)." });
        expect(parseTrigger('when ready')).toEqual({ error: "'when ready' isn't an event name or after(…)." });
    });
});

describe('any profile that plays the roles', () => {
    it('runs, whatever its kinds and features are called', async () => {
        const r = await loadWorkspace([{ uri: 'auto.arbor', text: `profile auto {
            kind Machine plays class {
                contains fields: Field [0..*] plays attributes
                contains acts: Act [0..*] plays operations
                contains behaviours: Automaton [0..*]
            }
            kind Number plays primitive {}
            kind Field { ref of: Number [0..1] plays type  prop start: expr [0..1] plays default }
            kind Act { prop does: action [0..1] plays body }
            abstract kind Spot {}
            kind Automaton plays machine, behavior { contains lanes: Lane [1..*] plays regions }
            kind Lane plays region { contains spots: Spot [0..*] plays vertices  contains arrows: Arrow [0..*] plays transitions }
            enum SpotKind { initial, choice }
            kind Node extends Spot plays state { prop onEnter: action [0..1] plays entry }
            kind Start extends Spot plays pseudostate { prop sort: SpotKind = initial plays pseudostateKind }
            kind Arrow plays transition {
                ref from: Spot [1] plays source  ref to: Spot [1] plays target
                prop on: string [0..1] plays trigger  prop when: expr [0..1] plays guard  prop then: action [0..1] plays effect
            }
        }` }, { uri: 'm.arbor', text: `model m {
            Number Integer {}
            Machine Counter {
                Field n { of: -> Integer  start: "0" }
                Act bump { does: "n := n + 1" }
                behaviours += Automaton life { Lane l {
                    Start s {}  Node idle { onEnter: "bump()" }  Node busy {}
                    Arrow { from: -> s  to: -> idle }
                    Arrow { from: -> idle  to: -> busy  on: "go"  when: "n < 3"  then: "bump()" }
                    Arrow { from: -> busy  to: -> idle  on: "back" }
                } }
            }
        }` }]);
        expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        const sim = new Simulation(r.ir, 'm.Counter.life').start().send('go').send('back').send('go');
        // Entering idle bumps n, and so does going: 1, 2, then back to idle, 3. The second go's guard, n < 3, stops it.
        expect([...sim.active]).toEqual(['m.Counter.life.l.idle']);
        expect(sim.variables()).toEqual({ n: '3' });
        expect(sim.trace.at(-1)).toMatchObject({ kind: 'ignored', event: 'go' });
    });
});
