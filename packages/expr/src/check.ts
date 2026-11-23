/**
 * Type checking: what each expression gives, against a type space, and what's
 * wrong with it, at its exact characters. A query (a guard, an invariant, a
 * derived value) may not change anything; an action (an effect, an operation
 * body) may assign and call operations that do.
 *
 * After an error the type is `any`, so one mistake is reported once.
 */
import type { Block, CollectionKind, Expr, Span, Stmt } from './ast.js';
import { DiagnosticCode, type ExprDiagnostic } from './diagnostics.js';
import {
    ANY, BOOLEAN, INTEGER, NULL, REAL, STRING, VOID, collectionOf, conforms, isNumeric, isString, typeName,
    type OperationInfo, type PrimitiveName, type Type, type TypeSpace,
} from './types.js';

export interface CheckContext {
    space: TypeSpace;
    /** What `self` is; usually a class. Without it, `self` and bare property names are errors. */
    self?: Type;
    /** Variables in scope, such as an operation's parameters. */
    variables?: Record<string, Type>;
    /** 'query' (the default) changes nothing; 'action' may assign and call any operation. */
    mode?: 'query' | 'action';
    /** What the expression must give, e.g. Boolean for a guard. */
    expected?: Type;
    /** What a block's `return` gives; VOID (the default) for none. */
    returns?: Type;
    /** `@pre` may be used: a postcondition. */
    pre?: boolean;
}

export interface CheckResult { type: Type; diagnostics: ExprDiagnostic[] }

const PRIMITIVES: readonly PrimitiveName[] = ['Boolean', 'Integer', 'Real', 'String'];

/** A scope: its variables, and the item whose properties bare names read (in `->select(overdue)`). */
class Scope {
    private readonly vars = new Map<string, Type>();
    constructor(private readonly parent?: Scope, readonly implicit?: Type) {}
    lookup(name: string): Type | undefined { return this.vars.get(name) ?? this.parent?.lookup(name); }
    implicitItems(): Type[] { return [...(this.implicit ? [this.implicit] : []), ...(this.parent?.implicitItems() ?? [])]; }
    names(): string[] { return [...this.vars.keys(), ...(this.parent?.names() ?? [])]; }
    define(name: string, type: Type): void { this.vars.set(name, type); }
    has(name: string): boolean { return this.vars.has(name) || !!this.parent?.has(name); }
}

class Checker {
    readonly diagnostics: ExprDiagnostic[] = [];
    constructor(private readonly ctx: CheckContext) {}

    private get space() { return this.ctx.space; }
    private get mode() { return this.ctx.mode ?? 'query'; }

    error(code: string, message: string, span: Span): Type {
        this.diagnostics.push({ code, severity: 'error', message, start: span.start, end: span.end });
        return ANY;
    }

    /** Checks `e` against what's expected of it. */
    expect(e: Expr, want: Type, scope: Scope, what: string): Type {
        const t = this.expr(e, scope);
        if (!conforms(t, want, this.space)) {
            this.error(DiagnosticCode.TypeMismatch, `${what} must be ${typeName(want)}, but this is ${typeName(t)}.`, e);
        }
        return t;
    }

    expr(e: Expr, scope: Scope): Type {
        switch (e.type) {
            case 'literal':
                return e.value === null ? NULL : typeof e.value === 'number' ? (e.integer ? INTEGER : REAL)
                    : typeof e.value === 'string' ? STRING : BOOLEAN;
            case 'self':
                return this.ctx.self ?? this.error(DiagnosticCode.UnknownName, `There's no 'self' here.`, e);
            case 'name':
                return this.name(e, scope);
            case 'enumLiteral': {
                const t = this.space.type(e.enum);
                if (t?.kind !== 'enum') return this.error(DiagnosticCode.UnknownName, `There's no enumeration '${e.enum}'.`, e);
                if (!t.literals.includes(e.literal)) {
                    const fix = closest(e.literal, t.literals);
                    return this.error(DiagnosticCode.UnknownMember, `${t.name} has no literal '${e.literal}'.${didYouMean(fix)}`, e);
                }
                return t;
            }
            case 'nav':
                if (e.pre) this.checkPre(e);
                return this.navigate(this.expr(e.target, scope), e.name, e, scope);
            case 'call':
                return this.call(e, scope);
            case 'iterate':
                return this.iterate(e, scope);
            case 'unary':
                if (e.op === 'not') { this.expect(e.operand, BOOLEAN, scope, `'not'`); return BOOLEAN; }
                return this.numeric(this.expr(e.operand, scope), e.operand, `'-'`);
            case 'binary':
                return this.binary(e, scope);
            case 'if': {
                this.expect(e.cond, BOOLEAN, scope, 'The condition');
                return this.common(this.expr(e.then, scope), this.expr(e.else, scope), e, 'The two branches');
            }
            case 'let': {
                const inner = new Scope(scope);
                inner.define(e.name, this.expr(e.value, scope));
                return this.expr(e.body, inner);
            }
            case 'collection': {
                let element: Type | undefined;
                for (const item of e.items) {
                    const t = this.expr(item, scope);
                    element = element ? this.common(element, t, item, 'A collection\'s items') : t;
                }
                return collectionOf(e.kind, element ?? ANY);
            }
        }
    }

    private checkPre(span: Span): void {
        if (!this.ctx.pre) this.error(DiagnosticCode.UnknownName, `'@pre' (the value before) is only for postconditions.`, span);
    }

    private name(e: Extract<Expr, { type: 'name' }>, scope: Scope): Type {
        if (e.pre) this.checkPre(e);
        const v = scope.lookup(e.name);
        if (v) return v;
        for (const item of scope.implicitItems()) {
            if (item.kind === 'class' && this.space.property(item.name, e.name)) return this.navigate(item, e.name, e, scope);
        }
        if (this.ctx.self?.kind === 'class') {
            const p = this.space.property(this.ctx.self.name, e.name);
            if (p) return p.type;
        }
        const type = this.typeNamed(e.name);
        if (type) return { kind: 'typeLiteral', of: type };
        const candidates = [...scope.names(), ...this.memberNames(this.ctx.self)];
        const fix = closest(e.name, candidates);
        return this.error(DiagnosticCode.UnknownName, `Nothing called '${e.name}' here.${didYouMean(fix)}`, e);
    }

    private typeNamed(name: string): Type | undefined {
        if ((PRIMITIVES as readonly string[]).includes(name)) return { kind: 'primitive', name: name as PrimitiveName };
        return this.space.type(name);
    }

    private memberNames(t: Type | undefined): string[] {
        if (t?.kind !== 'class') return [];
        return this.space.members?.(t.name) ?? [];
    }

    /** `t.name`: a property; over a collection, each item's, flattened (OCL's shorthand for collect). */
    private navigate(t: Type, name: string, span: Span, scope: Scope): Type {
        switch (t.kind) {
            case 'any': case 'null': return ANY;
            case 'collection': {
                const each = this.navigate(t.element, name, span, scope);
                return collected(t.collection, each);
            }
            case 'class': {
                const p = this.space.property(t.name, name);
                if (p) return p.type;
                const fix = closest(name, this.memberNames(t));
                return this.error(DiagnosticCode.UnknownMember, `${typeName(t)} has no property '${name}'.${didYouMean(fix)}`, span);
            }
            default:
                return this.error(DiagnosticCode.UnknownMember, `${typeName(t)} has no properties; '${name}' can't be read from it.`, span);
        }
    }

    private call(e: Extract<Expr, { type: 'call' }>, scope: Scope): Type {
        let target: Type;
        if (e.target) {
            target = Object.hasOwn(OCL_TYPE_TESTS, e.name) && !e.arrow ? ANY : this.expr(e.target, scope);
        } else {
            // `op(args)`: in `->select(isOverdue())`, the item's; otherwise an operation of self.
            const item = scope.implicitItems().find(i => OCL_OPERATIONS.has(e.name) || (i.kind === 'class' && !!this.space.operation(i.name, e.name)));
            if (!item) {
                if (this.ctx.self?.kind !== 'class') return this.error(DiagnosticCode.UnknownName, `There's no operation '${e.name}' here.`, e);
                return this.userOperation(this.ctx.self, e, scope);
            }
            target = item;
        }
        // Type arguments: `x.oclIsKindOf(State)`.
        if (!e.arrow && Object.hasOwn(OCL_TYPE_TESTS, e.name)) {
            if (e.target) this.expr(e.target, scope);
            const of = this.typeArgument(e);
            return e.name === 'oclAsType' ? of : BOOLEAN;
        }
        if (e.arrow) return this.collectionOperation(asCollection(target), e, scope);
        if (target.kind === 'collection') {
            // `items.op()`: each item's, as with properties.
            return collected(target.collection, this.objectOperation(target.element, e, scope));
        }
        return this.objectOperation(target, e, scope);
    }

    private typeArgument(e: Extract<Expr, { type: 'call' }>): Type {
        const arg = e.args[0];
        if (e.args.length !== 1 || !arg) return this.error(DiagnosticCode.BadArguments, `'${e.name}' takes one type.`, e);
        // `Kind` or `profile::Kind`.
        const name = arg.type === 'name' ? arg.name : arg.type === 'enumLiteral' ? `${arg.enum}::${arg.literal}` : undefined;
        const t = name ? this.typeNamed(name) : undefined;
        if (!t) return this.error(DiagnosticCode.UnknownName, `'${e.name}' takes a type${name ? `; there's no type '${name}'` : ''}.`, arg);
        return t;
    }

    private objectOperation(t: Type, e: Extract<Expr, { type: 'call' }>, scope: Scope): Type {
        if (e.name === 'oclIsUndefined') { this.args(e, [], scope); return BOOLEAN; }
        if (t.kind === 'any' || t.kind === 'null') { e.args.forEach(a => this.expr(a, scope)); return ANY; }
        if (t.kind === 'class') return this.userOperation(t, e, scope);
        const builtin = t.kind === 'primitive' ? primitiveOperation(t.name, e.name) : undefined;
        if (!builtin) return this.error(DiagnosticCode.UnknownMember, `${typeName(t)} has no operation '${e.name}'.`, e);
        this.args(e, builtin.params, scope);
        return builtin.returns;
    }

    private userOperation(t: Extract<Type, { kind: 'class' }>, e: Extract<Expr, { type: 'call' }>, scope: Scope): Type {
        const op = this.space.operation(t.name, e.name);
        if (!op) {
            const fix = closest(e.name, this.memberNames(t));
            e.args.forEach(a => this.expr(a, scope));
            return this.error(DiagnosticCode.UnknownMember, `${typeName(t)} has no operation '${e.name}'.${didYouMean(fix)}`, e);
        }
        if (!op.query && this.mode === 'query') {
            this.error(DiagnosticCode.SideEffect, `'${e.name}' changes things, so it can't be called here: only queries can.`, e);
        }
        this.args(e, op.params.map(p => p.type), scope, op);
        return op.returns;
    }

    private args(e: Extract<Expr, { type: 'call' }>, params: Type[], scope: Scope, op?: OperationInfo): void {
        if (e.args.length !== params.length) {
            e.args.forEach(a => this.expr(a, scope));
            const names = op?.params.length ? ` (${op.params.map(p => p.name).join(', ')})` : '';
            this.error(DiagnosticCode.BadArguments, `'${e.name}' takes ${params.length} argument${params.length === 1 ? '' : 's'}${names}, not ${e.args.length}.`, e);
            return;
        }
        e.args.forEach((a, i) => this.expect(a, params[i], scope, op ? `'${op.params[i].name}'` : `Argument ${i + 1} of '${e.name}'`));
    }

    private collectionOperation(t: Extract<Type, { kind: 'collection' }>, e: Extract<Expr, { type: 'call' }>, scope: Scope): Type {
        const el = t.element;
        const ordered = t.collection === 'OrderedSet' || t.collection === 'Sequence';
        const sig = (params: Type[], returns: Type): Type => { this.args(e, params, scope); return returns; };
        switch (e.name) {
            case 'size': return sig([], INTEGER);
            case 'isEmpty': case 'notEmpty': return sig([], BOOLEAN);
            // As in OCL, any object may be asked about; one that can never be an item is a mistake.
            case 'includes': case 'excludes': case 'count': {
                const [arg] = e.args;
                if (e.args.length !== 1) return sig([el], e.name === 'count' ? INTEGER : BOOLEAN);
                const t = this.expr(arg, scope);
                if (!conforms(t, el, this.space) && !conforms(el, t, this.space)) {
                    this.error(DiagnosticCode.TypeMismatch, `This collection holds ${typeName(el)}, so it never holds ${typeName(t)}.`, arg);
                }
                return e.name === 'count' ? INTEGER : BOOLEAN;
            }
            case 'includesAll': case 'excludesAll': return sig([ANY], BOOLEAN);
            case 'sum':
                if (!isNumeric(el)) this.error(DiagnosticCode.TypeMismatch, `'sum' adds numbers, but these are ${typeName(el)}.`, e);
                return sig([], el.kind === 'any' ? REAL : el);
            case 'min': case 'max':
                if (!isNumeric(el)) this.error(DiagnosticCode.TypeMismatch, `'${e.name}' compares numbers, but these are ${typeName(el)}.`, e);
                return sig([], el);
            case 'first': case 'last':
                if (!ordered) this.error(DiagnosticCode.UnknownMember, `A ${t.collection} has no order, so no '${e.name}' (use ->asSequence()).`, e);
                return sig([], el);
            case 'at':
                if (!ordered) this.error(DiagnosticCode.UnknownMember, `A ${t.collection} has no order, so no 'at' (use ->asSequence()).`, e);
                return sig([INTEGER], el);
            case 'asSet': return sig([], collectionOf('Set', el));
            case 'asOrderedSet': return sig([], collectionOf('OrderedSet', el));
            case 'asBag': return sig([], collectionOf('Bag', el));
            case 'asSequence': return sig([], collectionOf('Sequence', el));
            case 'including': case 'excluding': return sig([el], t);
            case 'union': {
                this.args(e, [ANY], scope);
                return t;
            }
            case 'reverse':
                if (!ordered) this.error(DiagnosticCode.UnknownMember, `A ${t.collection} has no order to reverse.`, e);
                return sig([], t);
            default: {
                e.args.forEach(a => this.expr(a, scope));
                const fix = closest(e.name, [...COLLECTION_OPERATIONS]);
                return this.error(DiagnosticCode.UnknownMember, `Collections have no operation '${e.name}'.${didYouMean(fix)}`, e);
            }
        }
    }

    private iterate(e: Extract<Expr, { type: 'iterate' }>, scope: Scope): Type {
        const t = asCollection(this.expr(e.target, scope));
        const inner = e.variable ? new Scope(scope) : new Scope(scope, t.element);
        if (e.variable) inner.define(e.variable, t.element);
        const body = () => this.expr(e.body, inner);
        const condition = () => this.expect(e.body, BOOLEAN, inner, `'${e.name}''s condition`);
        switch (e.name) {
            case 'select': case 'reject': condition(); return t;
            case 'collect': return collected(t.collection, body());
            case 'forAll': case 'exists': case 'one': condition(); return BOOLEAN;
            case 'isUnique': body(); return BOOLEAN;
            case 'any': condition(); return t.element;
            case 'closure': {
                // The items, what the body gives for each, what it gives for those, and so on (OCL 2.4): a Set, or
                // an OrderedSet from an ordered collection. The body gives items of the same type, or collections of them.
                const step = body();
                const each = step.kind === 'collection' ? step.element : step;
                if (!conforms(each, t.element, this.space)) {
                    this.error(DiagnosticCode.TypeMismatch, `'closure' follows from ${typeName(t.element)} to ${typeName(t.element)}, but its body gives ${typeName(step)}.`, e.body);
                }
                const ordered = t.collection === 'OrderedSet' || t.collection === 'Sequence';
                return collectionOf(ordered ? 'OrderedSet' : 'Set', t.element);
            }
            case 'sortedBy': {
                const key = body();
                if (!isNumeric(key) && !isString(key)) this.error(DiagnosticCode.TypeMismatch, `'sortedBy' sorts by numbers or strings, not ${typeName(key)}.`, e.body);
                const unique = t.collection === 'Set' || t.collection === 'OrderedSet';
                return collectionOf(unique ? 'OrderedSet' : 'Sequence', t.element);
            }
        }
        return this.error(DiagnosticCode.UnknownMember, `'${e.name}' isn't an iterator.`, e);
    }

    private binary(e: Extract<Expr, { type: 'binary' }>, scope: Scope): Type {
        const l = () => this.expr(e.left, scope), r = () => this.expr(e.right, scope);
        switch (e.op) {
            case 'and': case 'or': case 'xor': case 'implies':
                this.expect(e.left, BOOLEAN, scope, `'${e.op}'`);
                this.expect(e.right, BOOLEAN, scope, `'${e.op}'`);
                return BOOLEAN;
            case '=': case '<>': {
                const a = l(), b = r();
                if (!conforms(a, b, this.space) && !conforms(b, a, this.space) && !(isNumeric(a) && isNumeric(b))) {
                    this.error(DiagnosticCode.TypeMismatch, `${typeName(a)} and ${typeName(b)} are never equal.`, e);
                }
                return BOOLEAN;
            }
            case '<': case '<=': case '>': case '>=': {
                const a = l(), b = r();
                if (!(isNumeric(a) && isNumeric(b)) && !(isString(a) && isString(b))) {
                    this.error(DiagnosticCode.TypeMismatch, `'${e.op}' compares numbers or strings, not ${typeName(a)} and ${typeName(b)}.`, e);
                }
                return BOOLEAN;
            }
            case '+': {
                const a = l(), b = r();
                // Strings join, as with concat.
                if (a.kind === 'primitive' && a.name === 'String' || b.kind === 'primitive' && b.name === 'String') {
                    if (!isString(a) || !isString(b)) this.error(DiagnosticCode.TypeMismatch, `'+' joins two strings, not ${typeName(a)} and ${typeName(b)}.`, e);
                    return STRING;
                }
                return this.arithmetic(a, b, e);
            }
            case '-': case '*':
                return this.arithmetic(l(), r(), e);
            case '/':
                this.arithmetic(l(), r(), e);
                return REAL;
            case 'div': case 'mod': {
                const a = l(), b = r();
                for (const [t, side] of [[a, e.left], [b, e.right]] as const) {
                    if (!conforms(t, INTEGER, this.space)) this.error(DiagnosticCode.TypeMismatch, `'${e.op}' takes integers, but this is ${typeName(t)}.`, side);
                }
                return INTEGER;
            }
        }
    }

    private numeric(t: Type, span: Span, what: string): Type {
        if (!isNumeric(t)) return this.error(DiagnosticCode.TypeMismatch, `${what} takes a number, but this is ${typeName(t)}.`, span);
        return t;
    }

    private arithmetic(a: Type, b: Type, e: Extract<Expr, { type: 'binary' }>): Type {
        if (!isNumeric(a) || !isNumeric(b)) {
            return this.error(DiagnosticCode.TypeMismatch, `'${e.op}' takes numbers, not ${typeName(a)} and ${typeName(b)}.`, e);
        }
        if (a.kind === 'any' || b.kind === 'any') return ANY;
        return a.kind === 'primitive' && b.kind === 'primitive' && a.name === 'Integer' && b.name === 'Integer' ? INTEGER : REAL;
    }

    /** The type two alternatives share, or an error. */
    private common(a: Type, b: Type, span: Span, what: string): Type {
        if (conforms(a, b, this.space)) return a.kind === 'null' ? b : b.kind === 'any' ? a : b;
        if (conforms(b, a, this.space)) return a;
        if (isNumeric(a) && isNumeric(b)) return REAL;
        return this.error(DiagnosticCode.TypeMismatch, `${what} give different types: ${typeName(a)} and ${typeName(b)}.`, span);
    }

    // ------------------------------------------------------------ statements

    statements(list: Stmt[], scope: Scope): void {
        for (const s of list) this.statement(s, scope);
    }

    private statement(s: Stmt, scope: Scope): void {
        switch (s.type) {
            case 'expr': this.expr(s.expr, scope); return;
            case 'let': scope.define(s.name, this.expr(s.value, scope)); return;
            case 'if':
                this.expect(s.cond, BOOLEAN, scope, 'The condition');
                this.statements(s.then, new Scope(scope));
                this.statements(s.else, new Scope(scope));
                return;
            case 'return': {
                const want = this.ctx.returns ?? VOID;
                if (!s.value) {
                    if (want.kind !== 'void') this.error(DiagnosticCode.BadReturn, `This must return ${typeName(want)}.`, s);
                    return;
                }
                if (want.kind === 'void') { this.expr(s.value, scope); this.error(DiagnosticCode.BadReturn, `Nothing is returned here.`, s.value); return; }
                this.expect(s.value, want, scope, 'What is returned');
                return;
            }
            case 'assign': {
                const target = s.target;
                if (this.mode === 'query') this.error(DiagnosticCode.SideEffect, `A query can't assign; only an action can.`, s);
                let want: Type;
                if (target.type === 'name') {
                    const v = scope.lookup(target.name);
                    if (v) want = v;
                    else want = this.writableProperty(this.ctx.self, target.name, target);
                } else if (target.type === 'nav') {
                    const owner = this.expr(target.target, scope);
                    want = owner.kind === 'collection'
                        ? this.error(DiagnosticCode.NotAssignable, `This is a collection; assign to one item's '${target.name}' at a time.`, target)
                        : this.writableProperty(owner, target.name, target);
                } else {
                    want = this.error(DiagnosticCode.NotAssignable, 'Only a variable or a property can be assigned to.', target);
                }
                this.expect(s.value, want, scope, `'${target.type === 'name' || target.type === 'nav' ? target.name : 'This'}'`);
            }
        }
    }

    private writableProperty(owner: Type | undefined, name: string, span: Span): Type {
        if (owner?.kind === 'any' || owner?.kind === 'null') return ANY;
        if (owner?.kind !== 'class') return this.error(DiagnosticCode.NotAssignable, `There's no property '${name}' to assign to here.`, span);
        const p = this.space.property(owner.name, name);
        if (!p) {
            const fix = closest(name, this.memberNames(owner));
            return this.error(DiagnosticCode.UnknownMember, `${typeName(owner)} has no property '${name}'.${didYouMean(fix)}`, span);
        }
        if (p.readonly) return this.error(DiagnosticCode.NotAssignable, `'${name}' is read-only (or derived), so it can't be assigned to.`, span);
        return p.type;
    }
}

/** Operations every value has (OCL's). The first three take a type. */
const OCL_TYPE_TESTS: Record<string, true> = { oclIsKindOf: true, oclIsTypeOf: true, oclAsType: true };
export const OCL_OPERATIONS = new Set([...Object.keys(OCL_TYPE_TESTS), 'oclIsUndefined']);

export const COLLECTION_OPERATIONS = new Set(['size', 'isEmpty', 'notEmpty', 'includes', 'excludes', 'count', 'includesAll', 'excludesAll',
    'sum', 'min', 'max', 'first', 'last', 'at', 'asSet', 'asOrderedSet', 'asBag', 'asSequence', 'including', 'excluding', 'union', 'reverse']);

/** OCL wraps a single value as a set for `->`: `x->isEmpty()` asks whether x is null. */
function asCollection(t: Type): Extract<Type, { kind: 'collection' }> {
    if (t.kind === 'collection') return t;
    return { kind: 'collection', collection: 'Set', element: t.kind === 'null' ? ANY : t };
}

/** What collect gives: a Bag from an unordered collection, a Sequence from an ordered one, flattened. */
function collected(from: CollectionKind, each: Type): Type {
    const kind: CollectionKind = from === 'Set' || from === 'Bag' ? 'Bag' : 'Sequence';
    return collectionOf(kind, each.kind === 'collection' ? each.element : each);
}

/** Operations of strings and numbers. */
export function primitiveOperation(t: PrimitiveName, name: string): { params: Type[]; returns: Type } | undefined {
    if (t === 'String') {
        switch (name) {
            case 'size': return { params: [], returns: INTEGER };
            case 'concat': return { params: [STRING], returns: STRING };
            case 'substring': return { params: [INTEGER, INTEGER], returns: STRING };
            case 'toUpper': case 'toLower': return { params: [], returns: STRING };
            case 'indexOf': return { params: [STRING], returns: INTEGER };
            case 'toInteger': return { params: [], returns: INTEGER };
            case 'toReal': return { params: [], returns: REAL };
        }
    }
    if (t === 'Integer' || t === 'Real') {
        const self: Type = { kind: 'primitive', name: t };
        switch (name) {
            case 'abs': return { params: [], returns: self };
            case 'floor': case 'round': return { params: [], returns: INTEGER };
            case 'max': case 'min': return { params: [self], returns: self };
        }
    }
    return undefined;
}

/** The closest of `candidates` to `name`, if it's close enough to be a likely typo. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
    let best: string | undefined, bestDistance = Infinity;
    for (const c of candidates) {
        const d = distance(name.toLowerCase(), c.toLowerCase());
        if (d < bestDistance) { best = c; bestDistance = d; }
    }
    return best !== undefined && bestDistance <= Math.max(1, Math.floor(name.length / 3)) ? best : undefined;
}

/** Edits from one name to the other, a swap of two neighbours counting as one (typos often are). */
function distance(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}

const didYouMean = (fix: string | undefined) => (fix ? ` Did you mean '${fix}'?` : '');

function scopeOf(ctx: CheckContext): Scope {
    const scope = new Scope();
    for (const [name, type] of Object.entries(ctx.variables ?? {})) scope.define(name, type);
    return scope;
}

/** Checks one expression: its type, and what's wrong with it. */
export function checkExpression(expr: Expr, ctx: CheckContext): CheckResult {
    const c = new Checker(ctx);
    const type = ctx.expected ? c.expect(expr, ctx.expected, scopeOf(ctx), 'This') : c.expr(expr, scopeOf(ctx));
    return { type, diagnostics: c.diagnostics };
}

/** Checks a block of statements, as an action. */
export function checkBlock(block: Block, ctx: CheckContext): { diagnostics: ExprDiagnostic[] } {
    const c = new Checker({ ...ctx, mode: ctx.mode ?? 'action' });
    c.statements(block.statements, scopeOf(ctx));
    const returns = ctx.returns ?? VOID;
    if (returns.kind !== 'void' && !alwaysReturns(block.statements)) {
        c.error(DiagnosticCode.BadReturn, `This must return ${typeName(returns)} in every case.`, block.statements.at(-1) ?? block);
    }
    return { diagnostics: c.diagnostics };
}

function alwaysReturns(list: Stmt[]): boolean {
    return list.some(s => s.type === 'return' || (s.type === 'if' && alwaysReturns(s.then) && alwaysReturns(s.else)));
}
