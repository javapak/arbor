/**
 * Which of a profile's kinds and features play the parts of a state machine,
 * so the runtime works for any profile that has them, not one set of names.
 * Plain data, read from the roles a profile declares (`stateMachineBindings`).
 */
import { IRIndex, type IRDocument } from '@arbor/ir';
import { expressionBindings, type ExpressionBinding } from '@arbor/expr';

export interface StateMachineBinding {
    /** The classes, attributes and operations guards and effects are about. */
    expressions: ExpressionBinding;
    /** Kind IDs, and the containments that hold the parts. */
    machine: { kinds: string[]; regions: string };
    region: { kinds: string[]; vertices: string; transitions: string };
    state: { kinds: string[]; regions: string; entry?: string; exit?: string; doActivity?: string };
    /** Entering one completes its region. */
    final: { kinds: string[] };
    /** `kind` holds the literal saying which: initial, choice, junction, terminate, … */
    pseudostate: { kinds: string[]; kind: string };
    transition: { kinds: string[]; source: string; target: string; trigger?: string; guard?: string; effect?: string };
}

/**
 * The bindings the profiles declare with roles (`plays machine`, `plays transition`, `plays guard`…;
 * ROLES in @arbor/ir): one for each profile with a kind playing `machine`, and the expression
 * binding of that profile for its guards and effects.
 */
export function stateMachineBindings(doc: IRDocument): StateMachineBinding[] {
    const index = new IRIndex(doc);
    const expressions = expressionBindings(doc);
    const out: StateMachineBinding[] = [];
    for (const p of doc.profiles) {
        const playing = (role: string) => p.kinds.filter(k => k.roles?.includes(role)).map(k => k.id);
        const machines = playing('machine');
        const forExpressions = expressions.find(b => b.profile === p.name);
        if (!machines.length || !forExpressions) continue;
        // The name of the feature playing a role on any of these kinds (own or inherited).
        const name = (kinds: string[], role: string) =>
            kinds.flatMap(k => index.features(k)).find(f => f.roles?.includes(role))?.name;
        const states = playing('state'), regions = playing('region'), transitions = playing('transition'), pseudostates = playing('pseudostate');
        out.push({
            expressions: forExpressions,
            machine: { kinds: machines, regions: name(machines, 'regions') ?? '' },
            region: { kinds: regions, vertices: name(regions, 'vertices') ?? '', transitions: name(regions, 'transitions') ?? '' },
            state: { kinds: states, regions: name(states, 'regions') ?? '', ...opt('entry', name(states, 'entry')), ...opt('exit', name(states, 'exit')), ...opt('doActivity', name(states, 'doActivity')) },
            final: { kinds: playing('final') },
            pseudostate: { kinds: pseudostates, kind: name(pseudostates, 'pseudostateKind') ?? '' },
            transition: {
                kinds: transitions, source: name(transitions, 'source') ?? '', target: name(transitions, 'target') ?? '',
                ...opt('trigger', name(transitions, 'trigger')), ...opt('guard', name(transitions, 'guard')), ...opt('effect', name(transitions, 'effect')),
            },
        });
    }
    return out;
}

/** The binding for a state machine element: the one whose machine kinds it's of. */
export function stateMachineBindingFor(doc: IRDocument, machine: string): StateMachineBinding | undefined {
    const index = new IRIndex(doc);
    const el = index.elements.get(machine);
    return el && stateMachineBindings(doc).find(b => b.machine.kinds.some(k => index.isA(el.kind, k)));
}

const opt = <K extends string>(key: K, value: string | undefined) => (value ? { [key]: value } as Record<K, string> : {});
