/** A small world of classes and objects for tests: loans, members and items, as a simulation would hold them. */
import {
    BOOLEAN, INTEGER, REAL, STRING, VOID, collectionOf, type OperationInfo, type PropertyInfo, type Type, type TypeSpace,
    type ObjectValue, type Value, type ValueSpace,
} from '../src/index.js';

const cls = (name: string): Type => ({ kind: 'class', name });
export const Status: Type = { kind: 'enum', name: 'Status', literals: ['active', 'overdue', 'closed'] };

const classes: Record<string, { extends?: string; props: Record<string, PropertyInfo>; ops: Record<string, OperationInfo> }> = {
    Loan: {
        props: {
            fine: { type: REAL }, renewals: { type: INTEGER }, status: { type: Status },
            member: { type: cls('Member') }, items: { type: collectionOf('Set', cls('Item')) },
            code: { type: STRING, readonly: true },
        },
        ops: {
            chargeFine: { params: [{ name: 'amount', type: REAL }], returns: VOID, query: false },
            daysOverdue: { params: [], returns: INTEGER, query: true },
        },
    },
    Member: { props: { name: { type: STRING }, blocked: { type: BOOLEAN }, loans: { type: collectionOf('OrderedSet', cls('Loan')) } }, ops: {} },
    Item: { props: { title: { type: STRING }, price: { type: REAL } }, ops: {} },
    Book: { extends: 'Item', props: { isbn: { type: STRING } }, ops: {} },
};
const lineage = (name: string): string[] => (classes[name] ? [name, ...(classes[name].extends ? lineage(classes[name].extends!) : [])] : []);

export const types: TypeSpace = {
    type: name => (name === 'Status' ? Status : classes[name] ? cls(name) : undefined),
    property: (owner, name) => lineage(owner).map(c => classes[c].props[name]).find(Boolean),
    operation: (owner, name) => lineage(owner).map(c => classes[c].ops[name]).find(Boolean),
    conforms: (sub, sup) => lineage(sub).includes(sup),
    members: owner => lineage(owner).flatMap(c => [...Object.keys(classes[c].props), ...Object.keys(classes[c].ops)]),
};

/** An object: its class and its slots. */
export interface Obj { $class: string; [slot: string]: Value }
export const obj = ($class: string, slots: Record<string, Value> = {}): Obj => ({ $class, ...slots });

/** Objects as plain records; operations are recorded calls, plus a couple that do something. */
export function values(): ValueSpace & { calls: string[] } {
    const calls: string[] = [];
    const o = (x: ObjectValue) => x as Obj;
    return {
        calls,
        has: (x, name) => name in o(x) || !!types.property(o(x).$class, name) || !!types.operation(o(x).$class, name),
        get: (x, name) => o(x)[name] ?? null,
        set: (x, name, v) => { o(x)[name] = v; },
        call: (x, name, args) => {
            calls.push(`${name}(${args.join(', ')})`);
            if (name === 'chargeFine') o(x).fine = (o(x).fine as number) + (args[0] as number);
            if (name === 'daysOverdue') return 3;
            return null;
        },
        isKindOf: (x, type) => lineage(o(x).$class).includes(type),
        isTypeOf: (x, type) => o(x).$class === type,
    };
}
