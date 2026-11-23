/**
 * The interpreter: runs a checked expression or block against a value space.
 * It walks the syntax tree; nothing in it is turned into host code, so model
 * data never runs as JavaScript.
 *
 * Values are numbers (Integer and Real alike), strings, booleans, null, enum
 * literals, collections, and objects, which belong to the value space: it
 * reads, writes and calls on them.
 */
import type { Block, CollectionKind, Expr, Span, Stmt } from './ast.js';

/** Operations every value has (OCL's). */
const OCL_OPERATIONS = new Set(['oclIsKindOf', 'oclIsTypeOf', 'oclAsType', 'oclIsUndefined']);

export class EnumValue {
    constructor(readonly enumName: string, readonly literal: string) {}
    toString(): string { return `${this.enumName}::${this.literal}`; }
}

export class CollectionValue {
    readonly items: readonly Value[];
    /** Sets keep one of each value, in the order first seen. */
    constructor(readonly kind: CollectionKind, items: readonly Value[]) {
        this.items = kind === 'Set' || kind === 'OrderedSet' ? distinct(items) : items;
    }
}

/** An object of the value space: an element, a simulated instance… The interpreter only passes it back. */
export type ObjectValue = object;
export type Value = number | string | boolean | null | EnumValue | CollectionValue | ObjectValue;

/** What the interpreter runs against. */
export interface ValueSpace {
    /**
     * The object has a property or an operation `name`: in `->select(overdue)` or `->select(isLate())`,
     * a bare name is the item's if it has one, and otherwise self's.
     */
    has(object: ObjectValue, name: string): boolean;
    get(object: ObjectValue, name: string): Value;
    set(object: ObjectValue, name: string, value: Value): void;
    call(object: ObjectValue, name: string, args: Value[]): Value;
    /** The object's class is `type` or a kind of it. */
    isKindOf(object: ObjectValue, type: string): boolean;
    /** The object's class is `type` itself. */
    isTypeOf(object: ObjectValue, type: string): boolean;
}

export interface Env {
    space: ValueSpace;
    self?: Value;
    variables?: Record<string, Value>;
    /** Values before an operation, for `@pre` in a postcondition. */
    pre?: ValueSpace;
}

/** A failure while running: the expression has no value (OCL's invalid), at these characters. */
export class EvalError extends Error {
    constructor(message: string, readonly start: number, readonly end: number) { super(message); }
}

const fail = (message: string, span: Span): never => { throw new EvalError(message, span.start, span.end); };

const isObject = (v: Value): v is ObjectValue =>
    typeof v === 'object' && v !== null && !(v instanceof EnumValue) && !(v instanceof CollectionValue);

export function equals(a: Value, b: Value): boolean {
    if (a instanceof EnumValue && b instanceof EnumValue) return a.literal === b.literal && a.enumName === b.enumName;
    if (a instanceof CollectionValue && b instanceof CollectionValue) {
        if (a.kind !== b.kind || a.items.length !== b.items.length) return false;
        if (a.kind === 'Sequence' || a.kind === 'OrderedSet') return a.items.every((x, i) => equals(x, b.items[i]));
        return a.items.every(x => count(a.items, x) === count(b.items, x));
    }
    return a === b;
}

function distinct(items: readonly Value[]): Value[] {
    const out: Value[] = [];
    for (const x of items) if (!out.some(y => equals(x, y))) out.push(x);
    return out;
}

const count = (items: readonly Value[], x: Value) => items.filter(y => equals(x, y)).length;

/** A single value as a collection, for `->` (null is empty, as in OCL). */
function asCollection(v: Value): CollectionValue {
    if (v instanceof CollectionValue) return v;
    return new CollectionValue('Set', v === null ? [] : [v]);
}

/** What collect gives: a Bag from an unordered collection, a Sequence from an ordered one, flattened. */
function collected(from: CollectionKind, values: Value[]): CollectionValue {
    const flat = values.flatMap(v => (v instanceof CollectionValue ? v.items : [v]));
    return new CollectionValue(from === 'Set' || from === 'Bag' ? 'Bag' : 'Sequence', flat);
}

class Scope {
    private readonly vars = new Map<string, Value>();
    constructor(private readonly parent?: Scope, readonly implicit?: Value) {}
    lookup(name: string): { value: Value } | undefined {
        return this.vars.has(name) ? { value: this.vars.get(name)! } : this.parent?.lookup(name);
    }
    implicitItems(): Value[] { return [...(this.implicit !== undefined ? [this.implicit] : []), ...(this.parent?.implicitItems() ?? [])]; }
    define(name: string, value: Value): void { this.vars.set(name, value); }
    /** Sets the variable where it's defined; false if it isn't. */
    assign(name: string, value: Value): boolean {
        if (this.vars.has(name)) { this.vars.set(name, value); return true; }
        return this.parent?.assign(name, value) ?? false;
    }
}

class Interpreter {
    constructor(private readonly env: Env) {}

    expr(e: Expr, scope: Scope): Value {
        switch (e.type) {
            case 'literal': return e.value;
            case 'self':
                if (this.env.self === undefined) fail(`There's no 'self' here.`, e);
                return this.env.self!;
            case 'name': return this.name(e, scope);
            case 'enumLiteral': return new EnumValue(e.enum, e.literal);
            case 'nav': {
                const target = this.expr(e.target, scope);
                return this.read(target, e.name, e, e.pre);
            }
            case 'call': return this.call(e, scope);
            case 'iterate': return this.iterate(e, scope);
            case 'unary': {
                const v = this.expr(e.operand, scope);
                if (e.op === 'not') return !this.bool(v, e.operand);
                return -this.num(v, e.operand);
            }
            case 'binary': return this.binary(e, scope);
            case 'if': return this.bool(this.expr(e.cond, scope), e.cond) ? this.expr(e.then, scope) : this.expr(e.else, scope);
            case 'let': {
                const inner = new Scope(scope);
                inner.define(e.name, this.expr(e.value, scope));
                return this.expr(e.body, inner);
            }
            case 'collection': return new CollectionValue(e.kind, e.items.map(i => this.expr(i, scope)));
        }
    }

    private space(pre: boolean | undefined, span: Span): ValueSpace {
        if (!pre) return this.env.space;
        return this.env.pre ?? fail(`There are no values from before here for '@pre'.`, span);
    }

    private name(e: Extract<Expr, { type: 'name' }>, scope: Scope): Value {
        const v = scope.lookup(e.name);
        if (v) return v.value;
        for (const item of scope.implicitItems()) {
            if (isObject(item) && this.env.space.has(item, e.name)) return this.space(e.pre, e).get(item, e.name);
        }
        if (this.env.self !== undefined && isObject(this.env.self)) return this.space(e.pre, e).get(this.env.self, e.name);
        return fail(`Nothing called '${e.name}' here.`, e);
    }

    /** `target.name`; null gives null, a collection each item's (flattened). */
    private read(target: Value, name: string, span: Span, pre?: boolean): Value {
        if (target === null) return null;
        if (target instanceof CollectionValue) return collected(target.kind, target.items.map(i => this.read(i, name, span, pre)));
        if (!isObject(target)) return fail(`'${name}' can't be read from ${describe(target)}.`, span);
        return this.space(pre, span).get(target, name);
    }

    private call(e: Extract<Expr, { type: 'call' }>, scope: Scope): Value {
        let target: Value;
        if (e.target) {
            target = this.expr(e.target, scope);
        } else {
            const items = scope.implicitItems().filter(i => OCL_OPERATIONS.has(e.name) || (isObject(i) && this.env.space.has(i, e.name)));
            if (!items.length) {
                const self = this.env.self;
                if (self === undefined || !isObject(self)) return fail(`There's no operation '${e.name}' here.`, e);
                return this.env.space.call(self, e.name, e.args.map(a => this.expr(a, scope)));
            }
            target = items[0];
        }
        if (!e.arrow && (e.name === 'oclIsKindOf' || e.name === 'oclIsTypeOf' || e.name === 'oclAsType')) {
            const v = target;
            const arg = e.args[0];
            const type = arg?.type === 'name' ? arg.name : arg?.type === 'enumLiteral' ? `${arg.enum}::${arg.literal}` : '';
            const is = (t: string) => typeMatches(v, t, e.name === 'oclIsTypeOf', this.env.space);
            if (e.name === 'oclAsType') return v === null || is(type) ? v : fail(`${describe(v)} isn't a ${type}.`, e);
            return is(type);
        }
        const args = () => e.args.map(a => this.expr(a, scope));
        if (e.arrow) return this.collectionOperation(asCollection(target), e.name, args(), e);
        if (e.name === 'oclIsUndefined') return target === null;
        if (target instanceof CollectionValue) {
            const values = args();
            return collected(target.kind, target.items.map(i => this.objectOperation(i, e.name, values, e)));
        }
        return this.objectOperation(target, e.name, args(), e);
    }

    private objectOperation(target: Value, name: string, args: Value[], span: Span): Value {
        if (target === null) return fail(`'${name}' was called on null.`, span);
        if (typeof target === 'string') {
            const s = target;
            switch (name) {
                case 'size': return s.length;
                case 'concat': return s + this.str(args[0], span);
                // OCL counts from 1, and includes both ends.
                case 'substring': {
                    const [from, to] = [this.num(args[0], span), this.num(args[1], span)];
                    if (from < 1 || to > s.length || from > to + 1) fail(`substring(${from}, ${to}) is outside '${s}'.`, span);
                    return s.slice(from - 1, to);
                }
                case 'toUpper': return s.toUpperCase();
                case 'toLower': return s.toLowerCase();
                case 'indexOf': return s.indexOf(this.str(args[0], span)) + 1;
                case 'toInteger': case 'toReal': {
                    const n = Number(s);
                    if (s.trim() === '' || Number.isNaN(n) || (name === 'toInteger' && !Number.isInteger(n))) fail(`'${s}' isn't a number.`, span);
                    return n;
                }
            }
        } else if (typeof target === 'number') {
            switch (name) {
                case 'abs': return Math.abs(target);
                case 'floor': return Math.floor(target);
                case 'round': return Math.round(target);
                case 'max': return Math.max(target, this.num(args[0], span));
                case 'min': return Math.min(target, this.num(args[0], span));
            }
        } else if (isObject(target)) {
            return this.env.space.call(target, name, args);
        }
        return fail(`${describe(target)} has no operation '${name}'.`, span);
    }

    private collectionOperation(c: CollectionValue, name: string, args: Value[], span: Span): Value {
        const items = c.items;
        const ordered = c.kind === 'Sequence' || c.kind === 'OrderedSet';
        const other = () => asCollection(args[0]).items;
        switch (name) {
            case 'size': return items.length;
            case 'isEmpty': return items.length === 0;
            case 'notEmpty': return items.length > 0;
            case 'includes': return items.some(x => equals(x, args[0]));
            case 'excludes': return !items.some(x => equals(x, args[0]));
            case 'count': return count(items, args[0]);
            case 'includesAll': return other().every(x => items.some(y => equals(x, y)));
            case 'excludesAll': return other().every(x => !items.some(y => equals(x, y)));
            case 'sum': return items.reduce<number>((a, x) => a + this.num(x, span), 0);
            case 'min': case 'max': {
                if (!items.length) return fail(`'${name}' of an empty collection.`, span);
                const ns = items.map(x => this.num(x, span));
                return name === 'min' ? Math.min(...ns) : Math.max(...ns);
            }
            case 'first': return items[0] ?? null;
            case 'last': return items[items.length - 1] ?? null;
            case 'at': {
                const i = this.num(args[0], span);
                if (!Number.isInteger(i) || i < 1 || i > items.length) fail(`at(${i}) is outside a collection of ${items.length}.`, span);
                return items[i - 1];
            }
            case 'asSet': return new CollectionValue('Set', items);
            case 'asOrderedSet': return new CollectionValue('OrderedSet', items);
            case 'asBag': return new CollectionValue('Bag', items);
            case 'asSequence': return new CollectionValue('Sequence', items);
            case 'including': return new CollectionValue(c.kind, [...items, args[0]]);
            case 'excluding': return new CollectionValue(c.kind, items.filter(x => !equals(x, args[0])));
            case 'union': return new CollectionValue(c.kind, [...items, ...other()]);
            case 'reverse': return new CollectionValue(c.kind, ordered ? [...items].reverse() : items);
        }
        return fail(`Collections have no operation '${name}'.`, span);
    }

    private iterate(e: Extract<Expr, { type: 'iterate' }>, scope: Scope): Value {
        const c = asCollection(this.expr(e.target, scope));
        const each = (item: Value): Value => {
            const inner = e.variable ? new Scope(scope) : new Scope(scope, item);
            if (e.variable) inner.define(e.variable, item);
            return this.expr(e.body, inner);
        };
        const test = (item: Value) => this.bool(each(item), e.body);
        switch (e.name) {
            case 'select': return new CollectionValue(c.kind, c.items.filter(test));
            case 'reject': return new CollectionValue(c.kind, c.items.filter(x => !test(x)));
            case 'collect': return collected(c.kind, c.items.map(each));
            case 'forAll': return c.items.every(test);
            case 'exists': return c.items.some(test);
            case 'one': return c.items.filter(test).length === 1;
            case 'any': return c.items.find(test) ?? null;
            case 'isUnique': {
                const keys = c.items.map(each);
                return keys.every((k, i) => !keys.slice(0, i).some(j => equals(j, k)));
            }
            case 'closure': {
                // The source's items, then what the body gives for each, breadth first, each value once
                // (OCL 2.4): a cycle ends where it comes back.
                const out: Value[] = [];
                for (const v of c.items) if (!out.some(x => equals(x, v))) out.push(v);
                const queue = [...out];
                while (queue.length) {
                    const item = queue.shift()!;
                    const next = each(item);
                    for (const v of next instanceof CollectionValue ? next.items : next === null ? [] : [next]) {
                        if (!out.some(x => equals(x, v))) { out.push(v); queue.push(v); }
                    }
                }
                const ordered = c.kind === 'OrderedSet' || c.kind === 'Sequence';
                return new CollectionValue(ordered ? 'OrderedSet' : 'Set', out);
            }
            case 'sortedBy': {
                const keyed = c.items.map(item => ({ item, key: each(item) }));
                keyed.sort((a, b) => compare(a.key, b.key, e.body));
                const unique = c.kind === 'Set' || c.kind === 'OrderedSet';
                return new CollectionValue(unique ? 'OrderedSet' : 'Sequence', keyed.map(k => k.item));
            }
        }
        return fail(`'${e.name}' isn't an iterator.`, e);
    }

    private binary(e: Extract<Expr, { type: 'binary' }>, scope: Scope): Value {
        // `and`, `or` and `implies` don't look at the right when the left decides.
        switch (e.op) {
            case 'and': return this.bool(this.expr(e.left, scope), e.left) && this.bool(this.expr(e.right, scope), e.right);
            case 'or': return this.bool(this.expr(e.left, scope), e.left) || this.bool(this.expr(e.right, scope), e.right);
            case 'implies': return !this.bool(this.expr(e.left, scope), e.left) || this.bool(this.expr(e.right, scope), e.right);
        }
        const a = this.expr(e.left, scope), b = this.expr(e.right, scope);
        switch (e.op) {
            case 'xor': return this.bool(a, e.left) !== this.bool(b, e.right);
            case '=': return equals(a, b);
            case '<>': return !equals(a, b);
            case '<': return compare(a, b, e) < 0;
            case '<=': return compare(a, b, e) <= 0;
            case '>': return compare(a, b, e) > 0;
            case '>=': return compare(a, b, e) >= 0;
            case '+':
                if (typeof a === 'string' || typeof b === 'string') return this.str(a, e.left) + this.str(b, e.right);
                return this.num(a, e.left) + this.num(b, e.right);
            case '-': return this.num(a, e.left) - this.num(b, e.right);
            case '*': return this.num(a, e.left) * this.num(b, e.right);
            case '/': {
                const d = this.num(b, e.right);
                if (d === 0) fail('Division by zero.', e);
                return this.num(a, e.left) / d;
            }
            case 'div': case 'mod': {
                const n = this.num(a, e.left), d = this.num(b, e.right);
                if (d === 0) fail('Division by zero.', e);
                return e.op === 'div' ? Math.trunc(n / d) : n - Math.trunc(n / d) * d;
            }
        }
    }

    private num(v: Value, span: Span): number {
        return typeof v === 'number' ? v : fail(`Expected a number, but this is ${describe(v)}.`, span);
    }
    private str(v: Value, span: Span): string {
        return typeof v === 'string' ? v : fail(`Expected a string, but this is ${describe(v)}.`, span);
    }
    private bool(v: Value, span: Span): boolean {
        return typeof v === 'boolean' ? v : fail(`Expected true or false, but this is ${describe(v)}.`, span);
    }

    // ------------------------------------------------------------ statements

    /** Runs the statements; a `return` stops them, with its value. */
    statements(list: Stmt[], scope: Scope): { value: Value } | undefined {
        for (const s of list) {
            const r = this.statement(s, scope);
            if (r) return r;
        }
        return undefined;
    }

    private statement(s: Stmt, scope: Scope): { value: Value } | undefined {
        switch (s.type) {
            case 'expr': this.expr(s.expr, scope); return undefined;
            case 'let': scope.define(s.name, this.expr(s.value, scope)); return undefined;
            case 'if': return this.bool(this.expr(s.cond, scope), s.cond) ? this.statements(s.then, new Scope(scope)) : this.statements(s.else, new Scope(scope));
            case 'return': return { value: s.value ? this.expr(s.value, scope) : null };
            case 'assign': {
                const value = this.expr(s.value, scope);
                const t = s.target;
                if (t.type === 'name') {
                    if (scope.assign(t.name, value)) return undefined;
                    const self = this.env.self;
                    if (self === undefined || !isObject(self)) fail(`There's no '${t.name}' to assign to here.`, t);
                    this.env.space.set(self as ObjectValue, t.name, value);
                } else if (t.type === 'nav') {
                    const owner = this.expr(t.target, scope);
                    if (!isObject(owner)) fail(`'${t.name}' can't be set on ${describe(owner)}.`, t);
                    this.env.space.set(owner as ObjectValue, t.name, value);
                }
                return undefined;
            }
        }
    }
}

function compare(a: Value, b: Value, span: Span): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    return fail(`${describe(a)} and ${describe(b)} can't be compared.`, span);
}

function typeMatches(v: Value, type: string, exact: boolean, space: ValueSpace): boolean {
    switch (type) {
        case 'Integer': return typeof v === 'number' && Number.isInteger(v);
        case 'Real': return typeof v === 'number' && (!exact || !Number.isInteger(v));
        case 'String': return typeof v === 'string';
        case 'Boolean': return typeof v === 'boolean';
    }
    if (v instanceof EnumValue) return v.enumName === type;
    if (!isObject(v)) return false;
    return exact ? space.isTypeOf(v, type) : space.isKindOf(v, type);
}

/** A value, briefly, for messages. */
export function describe(v: Value): string {
    if (v === null) return 'null';
    if (typeof v === 'string') return `'${v}'`;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof EnumValue) return v.toString();
    if (v instanceof CollectionValue) return `a ${v.kind} of ${v.items.length}`;
    return 'an object';
}

function scopeOf(env: Env): Scope {
    const scope = new Scope();
    for (const [name, value] of Object.entries(env.variables ?? {})) scope.define(name, value);
    return scope;
}

/** The value of an expression. Throws EvalError where it has none (a null navigated past, a division by zero…). */
export function evaluate(expr: Expr, env: Env): Value {
    return new Interpreter(env).expr(expr, scopeOf(env));
}

/** Runs a block: its assignments and calls go to the value space. Gives what `return` gave, if it did. */
export function execute(block: Block, env: Env): { returned?: Value } {
    const r = new Interpreter(env).statements(block.statements, scopeOf(env));
    return r ? { returned: r.value } : {};
}
