import { describe, expect, it } from 'vitest';
import {
    BOOLEAN, INTEGER, REAL, VOID, checkBlock, checkExpression, parseBlock, parseExpression, typeName, type CheckContext,
} from '../src/index.js';
import { types } from './world.js';

const loan: CheckContext = { space: types, self: { kind: 'class', name: 'Loan' } };

function check(text: string, ctx: CheckContext = loan) {
    const r = parseExpression(text);
    if (!r.value) throw new Error(r.diagnostics[0].message);
    const { type, diagnostics } = checkExpression(r.value, ctx);
    return { type: typeName(type), errors: diagnostics.map(d => `${d.code} ${d.message} [${text.slice(d.start, d.end)}]`) };
}
function block(text: string, ctx: Partial<CheckContext> = {}) {
    const r = parseBlock(text);
    if (!r.value) throw new Error(r.diagnostics[0].message);
    return checkBlock(r.value, { ...loan, ...ctx }).diagnostics.map(d => `${d.code} ${d.message} [${text.slice(d.start, d.end)}]`);
}

describe('checking queries', () => {
    it('types navigation, arithmetic and comparisons, against self', () => {
        expect(check('fine > 0 and not member.blocked')).toEqual({ type: 'Boolean', errors: [] });
        expect(check('fine * 2 + renewals').type).toBe('Real');
        expect(check('renewals + 1').type).toBe('Integer');
        expect(check('renewals / 2').type).toBe('Real');
        expect(check('renewals div 2').type).toBe('Integer');
        expect(check("member.name + ' owes'").type).toBe('String');
        expect(check('status = Status::overdue').type).toBe('Boolean');
        expect(check('daysOverdue() * 0.5').type).toBe('Real');
        expect(check('if fine > 0 then fine else 0 endif').type).toBe('Real');
        expect(check('let late = daysOverdue() in late > 14').type).toBe('Boolean');
    });

    it('types collections the OCL way', () => {
        expect(check('items').type).toBe('Set(Item)');
        expect(check('items->select(i | i.price > 10)').type).toBe('Set(Item)');
        expect(check('items->collect(price)').type).toBe('Bag(Real)');
        expect(check('items.price->sum()').type).toBe('Real');              // implicit collect
        expect(check('member.loans->collect(l | l.items)').type).toBe('Sequence(Item)');   // flattened
        expect(check('items->sortedBy(price)').type).toBe('OrderedSet(Item)');
        expect(check('member.loans->first().fine').type).toBe('Real');
        expect(check('items->any(oclIsKindOf(Book))')).toEqual({ type: 'Item', errors: [] });   // the item's, not self's
        expect(check('member.loans->select(daysOverdue() > 14)')).toEqual({ type: 'OrderedSet(Loan)', errors: [] });
        expect(check('items->exists(i | i.oclIsKindOf(Book) and i.oclAsType(Book).isbn <> \'\')').type).toBe('Boolean');
        expect(check('Set{1, 2, 3}->includes(2)').type).toBe('Boolean');
        expect(check('Sequence{1, 2.5}').type).toBe('Sequence(Real)');
        expect(check('member->isEmpty()').type).toBe('Boolean');             // a single value as a set
    });

    it('reports unknown names and members, with the likely one', () => {
        expect(check('fien > 0').errors).toEqual(["EXP002 Nothing called 'fien' here. Did you mean 'fine'? [fien]"]);
        expect(check('member.nmae').errors).toEqual(["EXP003 Member has no property 'nmae'. Did you mean 'name'? [member.nmae]"]);
        expect(check('status = Status::lost').errors).toEqual(["EXP003 Status has no literal 'lost'. [Status::lost]"]);
        expect(check('items->first()').errors).toEqual(["EXP003 A Set has no order, so no 'first' (use ->asSequence()). [items->first()]"]);
        expect(check('items->sizee()').errors).toEqual(["EXP003 Collections have no operation 'sizee'. Did you mean 'size'? [items->sizee()]"]);
        expect(check('self', { space: types }).errors).toEqual(["EXP002 There's no 'self' here. [self]"]);
    });

    it('reports type mismatches at the part that is wrong, once', () => {
        expect(check('fine > 0 and member').errors).toEqual(["EXP004 'and' must be Boolean, but this is Member. [member]"]);
        expect(check("fine + 'x'").errors).toEqual(["EXP004 '+' joins two strings, not Real and String. [fine + 'x']"]);
        expect(check('status = 3').errors).toEqual(['EXP004 Status and Integer are never equal. [status = 3]']);
        expect(check('fine div 2').errors).toEqual(["EXP004 'div' takes integers, but this is Real. [fine]"]);
        expect(check('items->select(i | i.price)').errors).toEqual(["EXP004 'select''s condition must be Boolean, but this is Real. [i.price]"]);
        expect(check('fien + 1 > 2 and fien').errors).toHaveLength(2);   // each use; nothing follows from them
        expect(check('fine', { ...loan, expected: BOOLEAN }).errors).toEqual(['EXP004 This must be Boolean, but this is Real. [fine]']);
    });

    it('checks calls: arguments, and that a query changes nothing', () => {
        expect(check('chargeFine(5)').errors).toEqual(["EXP006 'chargeFine' changes things, so it can't be called here: only queries can. [chargeFine(5)]"]);
        expect(check('daysOverdue(1)').errors).toEqual(["EXP005 'daysOverdue' takes 0 arguments, not 1. [daysOverdue(1)]"]);
        expect(check("chargeFine('a')", { ...loan, mode: 'action' }).errors).toEqual(["EXP004 'amount' must be Real, but this is String. ['a']"]);
        expect(check('member.name.substring(1, 2)').type).toBe('String');
        expect(check('member.name.size(1)').errors).toEqual(["EXP005 'size' takes 0 arguments, not 1. [member.name.size(1)]"]);
    });

    it('allows @pre only in postconditions', () => {
        expect(check('fine = fine@pre + 5', { ...loan, pre: true }).errors).toEqual([]);
        expect(check('fine@pre > 0').errors).toEqual(["EXP002 '@pre' (the value before) is only for postconditions. [fine@pre]"]);
    });
});

describe('checking actions', () => {
    it('allows assignments to writable properties and variables, with fitting values', () => {
        expect(block('let extra = 2.5; fine := fine + extra; member.blocked := true; status := Status::overdue; chargeFine(1)')).toEqual([]);
        expect(block('fine := true')).toEqual(["EXP004 'fine' must be Real, but this is Boolean. [true]"]);
        expect(block("code := 'x'")).toEqual(["EXP007 'code' is read-only (or derived), so it can't be assigned to. [code]"]);
        expect(block('fien := 1')).toEqual(["EXP003 Loan has no property 'fien'. Did you mean 'fine'? [fien]"]);
        expect(block('items.price := 1')).toEqual(["EXP007 This is a collection; assign to one item's 'price' at a time. [items.price]"]);
        expect(block('renewals := renewals + 0.5')).toEqual(["EXP004 'renewals' must be Integer, but this is Real. [renewals + 0.5]"]);
    });

    it('checks if conditions and what is returned', () => {
        expect(block('if fine then chargeFine(1) endif')).toEqual(['EXP004 The condition must be Boolean, but this is Real. [fine]']);
        expect(block('if fine > 0 then return 1 else return 2 endif', { returns: INTEGER })).toEqual([]);
        expect(block('if fine > 0 then return 1 endif', { returns: INTEGER })).toEqual(['EXP008 This must return Integer in every case. [if fine > 0 then return 1 endif]']);
        expect(block('return 1', { returns: VOID })).toEqual(['EXP008 Nothing is returned here. [1]']);
        expect(block("return 'x'", { returns: REAL })).toEqual(["EXP004 What is returned must be Real, but this is String. ['x']"]);
        expect(block('fine := 1', { mode: 'query' })).toEqual(["EXP006 A query can't assign; only an action can. [fine := 1]"]);
    });
});

describe('closure', () => {
    it('gives a Set (an OrderedSet from an ordered collection) of the items, and wants the body to give the same type', () => {
        expect(check('member.loans->closure(l | l.member.loans)')).toEqual({ type: 'OrderedSet(Loan)', errors: [] });
        expect(check('items->closure(i | i)').type).toBe('Set(Item)');
        expect(check('items->closure(i | i.title)').errors).toEqual(["EXP004 'closure' follows from Item to Item, but its body gives String. [i.title]"]);
    });
});
