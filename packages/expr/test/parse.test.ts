import { describe, expect, it } from 'vitest';
import { parseBlock, parseExpression, type Expr } from '../src/index.js';

/** The tree without spans, as a compact string. */
function show(e: Expr): string {
    switch (e.type) {
        case 'literal': return typeof e.value === 'string' ? `'${e.value}'` : String(e.value);
        case 'self': return 'self';
        case 'name': return e.name + (e.pre ? '@pre' : '');
        case 'enumLiteral': return `${e.enum}::${e.literal}`;
        case 'nav': return `${show(e.target)}.${e.name}${e.pre ? '@pre' : ''}`;
        case 'call': return `${e.target ? show(e.target) + (e.arrow ? '->' : '.') : ''}${e.name}(${e.args.map(show).join(', ')})`;
        case 'iterate': return `${show(e.target)}->${e.name}(${e.variable ? e.variable + ' | ' : ''}${show(e.body)})`;
        case 'unary': return `(${e.op} ${show(e.operand)})`;
        case 'binary': return `(${show(e.left)} ${e.op} ${show(e.right)})`;
        case 'if': return `if ${show(e.cond)} then ${show(e.then)} else ${show(e.else)} endif`;
        case 'let': return `let ${e.name} = ${show(e.value)} in ${show(e.body)}`;
        case 'collection': return `${e.kind}{${e.items.map(show).join(', ')}}`;
    }
}
const parsed = (text: string) => {
    const r = parseExpression(text);
    if (!r.value) throw new Error(r.diagnostics[0].message);
    return show(r.value);
};

describe('parsing expressions', () => {
    it('ranks operators as OCL does', () => {
        expect(parsed('a + b * c = d and not e or f implies g')).toBe('(((((a + (b * c)) = d) and (not e)) or f) implies g)');
        expect(parsed('a - b - c')).toBe('((a - b) - c)');
        expect(parsed('a implies b implies c')).toBe('(a implies (b implies c))');
        expect(parsed('-x.abs() div 2 mod 3')).toBe('(((- x.abs()) div 2) mod 3)');
        expect(parsed('(a or b) and c')).toBe('((a or b) and c)');
    });

    it('reads navigation, calls, collection operations and iterators', () => {
        expect(parsed("self.member.loans->select(l | l.fine > 0)->size() >= 1"))
            .toBe('(self.member.loans->select(l | (l.fine > 0))->size() >= 1)');
        expect(parsed('items->collect(price)->sum()')).toBe('items->collect(price)->sum()');
        expect(parsed('chargeFine(fine * 2)')).toBe('chargeFine((fine * 2))');
        expect(parsed("v.oclIsKindOf(uml::Pseudostate) and v.kind = PseudostateKind::choice"))
            .toBe('(v.oclIsKindOf(uml::Pseudostate) and (v.kind = PseudostateKind::choice))');
        expect(parsed('fine = fine@pre + self.fine@pre')).toBe('(fine = (fine@pre + self.fine@pre))');
    });

    it('reads literals, if, let and collection literals', () => {
        expect(parsed("Sequence{1, 2.5, 'a', \"b\", true, null}")).toBe("Sequence{1, 2.5, 'a', 'b', true, null}");
        expect(parsed('if a then 1 else 2 endif')).toBe('if a then 1 else 2 endif');
        expect(parsed('let x = 3 in x * x')).toBe('let x = 3 in (x * x)');
        expect(parsed("'it\\'s' -- a comment")).toBe("'it's'");
        expect(parseExpression('7').value).toMatchObject({ value: 7, integer: true });
        expect(parseExpression('7.0').value).not.toHaveProperty('integer');
    });

    it('reports the first syntax error, where it is', () => {
        const at = (text: string) => { const d = parseExpression(text).diagnostics[0]; return [d?.code, d?.message, text.slice(d!.start, d!.end)]; };
        expect(at('fine > ')).toEqual(['EXP001', 'Expected an expression, but the text ends here.', '']);
        expect(at('a ++ b')).toEqual(['EXP001', "Expected an expression, found '+'.", '+']);
        expect(at('if a then b endif')).toEqual(['EXP001', "Expected 'else' (an if expression has both branches), found 'endif'.", 'endif']);
        expect(at("name = 'open")).toEqual(['EXP001', 'This string is never closed.', "'open"]);
        expect(at('a b')).toEqual(['EXP001', "Expected the end, found 'b'.", 'b']);
        expect(at('items->size')).toEqual(['EXP001', "Expected '(' after '->size', but the text ends here.", '']);
    });
});

describe('parsing statements', () => {
    it('reads assignments, calls, if, let and return, separated by semicolons', () => {
        const r = parseBlock('let extra = 2; fine := fine + extra; if fine > 10 then notify(member); status := Status::overdue endif; return fine;');
        expect(r.diagnostics).toEqual([]);
        expect(r.value!.statements.map(s => s.type)).toEqual(['let', 'assign', 'if', 'return']);
        const branch = r.value!.statements[2];
        expect(branch.type === 'if' && branch.then.map(s => s.type)).toEqual(['expr', 'assign']);
        expect(parseBlock('').value!.statements).toEqual([]);
    });

    it('only assigns to a variable or a property, and not to @pre', () => {
        expect(parseBlock('f(x) := 1').diagnostics[0].message).toBe('Only a variable or a property can be assigned to.');
        expect(parseBlock('fine@pre := 1').diagnostics[0].message).toMatch(/@pre/);
        expect(parseBlock('a := 1 b := 2').diagnostics[0].message).toBe("Expected ';' between statements, found 'b'.");
    });
});
