/**
 * The parts a profile's kinds and features can play for the tools that give
 * models meaning: the expression language (which kinds are classes, which
 * slots hold guards…) and the state machine runtime. A profile says so with
 * `plays`:
 *
 *     abstract kind Classifier extends PackageableElement plays class {
 *         ordered contains attributes: Property [0..*] plays attributes
 *     }
 *
 * The language checks roles against this list, as it checks visual keys; the
 * tools read them from the IR (`roles` on kinds and features), so any profile
 * that plays them is checked and run like samples/uml's.
 */

export interface RoleSpec {
    /** What plays it: a kind, or a feature of this sort. */
    on: 'kind' | 'contains' | 'ref' | 'prop';
    /** For a property: its type. */
    type?: 'string' | 'bool' | 'expr' | 'action' | 'enum';
    description: string;
}

export const ROLES = {
    // ---- the classes a model describes (what expressions are about)
    class:           { on: 'kind', description: 'its elements are classes: the types expressions are about, and what `self` is in expressions inside them' },
    behavior:        { on: 'kind', description: "its elements are behaviors (a state machine): expressions inside one are about the class around it" },
    primitive:       { on: 'kind', description: 'its elements named Boolean, Integer, Real or String are those primitive types' },
    attributes:      { on: 'contains', description: "a class's attributes" },
    operations:      { on: 'contains', description: "a class's operations" },
    generalizations: { on: 'contains', description: "elements naming a class's generals, through the reference playing `general`" },
    general:         { on: 'ref', description: 'a generalization\'s general class: the class inherits its attributes and operations' },
    type:            { on: 'ref', description: "an attribute's or a parameter's type" },
    multiplicity:    { on: 'prop', type: 'string', description: 'how many values an attribute or parameter holds, as `0..*`' },
    ordered:         { on: 'prop', type: 'bool', description: "an attribute's values are in order" },
    unique:          { on: 'prop', type: 'bool', description: "an attribute's values don't repeat (true when not set)" },
    readOnly:        { on: 'prop', type: 'bool', description: "an attribute isn't assigned to by actions" },
    default:         { on: 'prop', type: 'expr', description: "an attribute's initial value" },
    parameters:      { on: 'contains', description: "an operation's parameters (their names are variables in its body)" },
    returns:         { on: 'ref', description: "an operation's result type" },
    query:           { on: 'prop', type: 'bool', description: 'an operation changes nothing, so queries may call it' },
    body:            { on: 'prop', type: 'action', description: "an operation's body" },

    // ---- state machines
    machine:         { on: 'kind', description: 'its elements are state machines' },
    region:          { on: 'kind', description: 'its elements are regions: each has one active state' },
    state:           { on: 'kind', description: 'its elements are states' },
    final:           { on: 'kind', description: 'its elements are final states: entering one completes its region' },
    pseudostate:     { on: 'kind', description: 'its elements are pseudostates: which, the property playing `pseudostateKind` says' },
    transition:      { on: 'kind', description: 'its elements are transitions' },
    regions:         { on: 'contains', description: "a state machine's or a composite state's regions" },
    vertices:        { on: 'contains', description: "a region's states and pseudostates" },
    transitions:     { on: 'contains', description: "a region's transitions" },
    entry:           { on: 'prop', type: 'action', description: "what a state does on entry" },
    exit:            { on: 'prop', type: 'action', description: "what a state does on exit" },
    doActivity:      { on: 'prop', type: 'action', description: "what a state does while active (run once, after entry)" },
    pseudostateKind: { on: 'prop', type: 'enum', description: 'which pseudostate: initial, choice, junction, terminate… (literals by those names)' },
    source:          { on: 'ref', description: "a transition's source" },
    target:          { on: 'ref', description: "a transition's target" },
    trigger:         { on: 'prop', type: 'string', description: "a transition's trigger: an event's name, or after(14 days)" },
    guard:           { on: 'prop', type: 'expr', description: "a transition's guard: a query giving a Boolean" },
    effect:          { on: 'prop', type: 'action', description: "a transition's effect" },
} as const satisfies Record<string, RoleSpec>;

export type Role = keyof typeof ROLES;

export function isRole(name: string): name is Role {
    return Object.hasOwn(ROLES, name);
}
