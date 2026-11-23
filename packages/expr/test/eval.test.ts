import { describe, expect, it } from 'vitest';
import {
    CollectionValue, EnumValue, EvalError, evaluate, execute, parseBlock, parseExpression, type Env, type Value,
} from '../src/index.js';
import { obj, values, type Obj } from './world.js';

function world() {
    const space = values();
    const book = obj('Book', { title: 'Dune', price: 12, isbn: '978' });
    const cd = obj('Item', { title: 'Blue', price: 8 });
    const ann = obj('Member', { name: 'Ann', blocked: false });
    const loan = obj('Loan', { fine: 2.5, renewals: 1, status: new EnumValue('Status', 'active'), member: ann, items: new CollectionValue('Set', [book, cd]) });
    const other = obj('Loan', { fine: 0, renewals: 0, member: ann, items: new CollectionValue('Set', []) });
    ann.loans = new CollectionValue('OrderedSet', [loan, other]);
    return { space, loan, ann, book, cd, env: { space, self: loan } as Env };
}

function run(text: string, env: Env): Value {
    const r = parseExpression(text);
    if (!r.value) throw new Error(r.diagnostics[0].message);
    return evaluate(r.value, env);
}
const items = (v: Value) => (v as CollectionValue).items;

describe('evaluating queries', () => {
    it('computes with numbers, strings, booleans and enums', () => {
        const { env } = world();
        expect(run('fine * 2 + renewals', env)).toBe(6);
        expect(run('7 div 2', env)).toBe(3);
        expect(run('-7 mod 3', env)).toBe(-1);
        expect(run("member.name.concat('!') + '?'", env)).toBe('Ann!?');
        expect(run("'hello'.substring(2, 4).toUpper()", env)).toBe('ELL');
        expect(run("'hello'.indexOf('l')", env)).toBe(3);
        expect(run('status = Status::active and status <> Status::closed', env)).toBe(true);
        expect(run('if fine > 2 then 1 else 0 endif', env)).toBe(1);
        expect(run('let x = 4 in x * x', env)).toBe(16);
        expect(run('(-3.6).abs().round()', env)).toBe(4);
    });

    it('short-circuits and, or and implies', () => {
        const { env } = world();
        // The right side would fail (null.fine), but isn't needed.
        expect(run('false and (1 / 0 > 0)', env)).toBe(false);
        expect(run('true or (1 / 0 > 0)', env)).toBe(true);
        expect(run('false implies (1 / 0 > 0)', env)).toBe(true);
        expect(run('true xor false', env)).toBe(true);
    });

    it('works with collections the OCL way', () => {
        const { env, book, cd } = world();
        expect(items(run('items->select(i | i.price > 10)', env))).toEqual([book]);
        expect(run('items->collect(price)->sum()', env)).toBe(20);
        expect(run('items.price->max()', env)).toBe(12);
        expect(items(run('items->sortedBy(price)', env))).toEqual([cd, book]);
        expect(run('items->forAll(price > 5) and items->exists(oclIsKindOf(Book))', env)).toBe(true);
        expect(run('items->one(oclIsTypeOf(Item))', env)).toBe(true);
        expect(run('items->any(i | i.oclIsKindOf(Book)).oclAsType(Book).isbn', env)).toBe('978');
        expect(run('member.loans->first().fine + member.loans->last().fine', env)).toBe(2.5);
        expect(run('member.loans->collect(l | l.items)->size()', env)).toBe(2);   // flattened
        expect(items(run('Set{1, 2, 2, 3}', env))).toEqual([1, 2, 3]);
        expect(items(run('Bag{1, 2, 2}->including(2)', env))).toEqual([1, 2, 2, 2]);
        expect(run('Sequence{3, 1, 2}->at(2)', env)).toBe(1);
        expect(run('Set{1, 2} = Set{2, 1} and Sequence{1, 2} <> Sequence{2, 1}', env)).toBe(true);
        expect(run('Sequence{1, 2, 1}->isUnique(x | x)', env)).toBe(false);
        expect(run('member->notEmpty() and null->isEmpty()', env)).toBe(true);
    });

    it('treats null as OCL does: navigating it gives null, oclIsUndefined asks', () => {
        const { env, loan } = world();
        loan.member = null;
        expect(run('member.name', env)).toBe(null);
        expect(run('member.oclIsUndefined()', env)).toBe(true);
        expect(run('member->isEmpty()', env)).toBe(true);
    });

    it('fails where there is no value, at the part that has none', () => {
        const { env } = world();
        const failure = (text: string) => {
            try { run(text, env); } catch (e) {
                if (e instanceof EvalError) return [e.message, text.slice(e.start, e.end)];
                throw e;
            }
            return undefined;
        };
        expect(failure('fine / (renewals - 1)')).toEqual(['Division by zero.', 'fine / (renewals - 1)']);
        expect(failure('Sequence{1}->at(3)')).toEqual(['at(3) is outside a collection of 1.', 'Sequence{1}->at(3)']);
        expect(failure("'abc'.toInteger()")).toEqual(["'abc' isn't a number.", "'abc'.toInteger()"]);
        expect(failure('Sequence{}->max()')).toEqual(["'max' of an empty collection.", 'Sequence{}->max()']);
        expect(failure('member.name > 3')).toEqual(["'Ann' and 3 can't be compared.", 'member.name > 3']);
    });

    it('reads values from before for @pre', () => {
        const { env, loan } = world();
        const before = { ...loan };
        loan.fine = 7.5;
        const pre = { ...env.space, get: (o: object, name: string) => (o === loan ? before[name] : (o as Obj)[name]) ?? null };
        expect(run('fine = fine@pre + 5', { ...env, pre })).toBe(true);
    });
});

describe('running actions', () => {
    it('assigns and calls in order, and stops at return', () => {
        const { env, loan, ann, space } = world();
        const block = parseBlock(`
            let extra = 2;
            fine := fine + extra;
            if fine > 4 then member.blocked := true; status := Status::overdue else chargeFine(100) endif;
            chargeFine(0.5);
            return fine;
            fine := 0`).value!;
        expect(execute(block, env)).toEqual({ returned: 5 });
        expect(loan.fine).toBe(5);
        expect(ann.blocked).toBe(true);
        expect(loan.status).toEqual(new EnumValue('Status', 'overdue'));
        expect(space.calls).toEqual(['chargeFine(0.5)']);
    });

    it('assigns a variable where it was defined', () => {
        const { env } = world();
        expect(execute(parseBlock('let n = 1; if true then n := n + 1 endif; return n').value!, env)).toEqual({ returned: 2 });
        expect(execute(parseBlock('fine := 1').value!, env)).toEqual({});
    });
});

describe('closure', () => {
    it('follows a relation transitively, each value once, stopping where a cycle comes back', () => {
        const { env } = world();
        const a = obj('Item', { title: 'a' }), b = obj('Item', { title: 'b' }), c = obj('Item', { title: 'c' });
        a.next = new CollectionValue('Set', [b]); b.next = new CollectionValue('Set', [c]); c.next = new CollectionValue('Set', [a]);
        const e = { ...env, variables: { start: new CollectionValue('Set', [a]) } };
        const r = run("start->closure(x | x.next)->collect(title)->asSequence()", e);
        expect(items(r)).toEqual(['a', 'b', 'c']);   // the source too, and a again, as c's next, only once
        expect((run('Sequence{3}->closure(n | if n > 0 then n - 1 else null endif)', env) as CollectionValue).kind).toBe('OrderedSet');
        expect(items(run('Sequence{3}->closure(n | if n > 0 then n - 1 else null endif)', env))).toEqual([3, 2, 1, 0]);
    });
});
