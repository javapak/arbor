/**
 * Parsing: text to syntax tree. A hand-written lexer and a Pratt parser, so it
 * runs anywhere (Node, a browser, a web worker) with no generated code and no
 * eval.
 *
 * Queries are OCL: `self.loans->select(l | l.overdue)->size() > 0`. Actions
 * add statements separated by `;`: `fine := fine + 5; notify(member)`.
 * Strings take single quotes, as in OCL (handy inside an arbor "…" string), or
 * double quotes. `--` starts a comment to the end of the line.
 */
import type { BinaryOp, Block, CollectionKind, Expr, Span, Stmt } from './ast.js';
import { DiagnosticCode, type ExprDiagnostic } from './diagnostics.js';

type TokenKind = 'ident' | 'number' | 'string' | 'op' | 'eof';
interface Token extends Span { kind: TokenKind; value: string }

const OPERATORS = ['->', '::', ':=', '<>', '<=', '>=', '(', ')', '{', '}', '[', ']', ',', '.', '|', ';', ':', '=', '<', '>', '+', '-', '*', '/', '@'];
const KEYWORDS = new Set(['and', 'or', 'xor', 'not', 'implies', 'if', 'then', 'else', 'endif', 'let', 'in',
    'true', 'false', 'null', 'self', 'div', 'mod', 'return']);
const COLLECTIONS: readonly CollectionKind[] = ['Set', 'OrderedSet', 'Bag', 'Sequence'];
/** Collection operations that take an iterator variable and a body: `->select(x | …)`. */
export const ITERATORS = new Set(['select', 'reject', 'collect', 'forAll', 'exists', 'any', 'one', 'isUnique', 'sortedBy', 'closure']);

class SyntaxError extends Error {
    constructor(message: string, readonly span: Span) { super(message); }
}

function lex(text: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (/\s/.test(c)) { i++; continue; }
        if (text.startsWith('--', i)) {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        const start = i;
        if (/[A-Za-z_]/.test(c)) {
            while (i < text.length && /\w/.test(text[i])) i++;
            tokens.push({ kind: 'ident', value: text.slice(start, i), start, end: i });
        } else if (/\d/.test(c)) {
            while (/\d/.test(text[i] ?? '')) i++;
            // A fraction only if a digit follows the point: `1.abs()` is a call on 1.
            if (text[i] === '.' && /\d/.test(text[i + 1] ?? '')) { i++; while (/\d/.test(text[i] ?? '')) i++; }
            if (/[eE]/.test(text[i] ?? '') && /[\d+-]/.test(text[i + 1] ?? '')) {
                i += /[+-]/.test(text[i + 1]) ? 2 : 1;
                while (/\d/.test(text[i] ?? '')) i++;
            }
            tokens.push({ kind: 'number', value: text.slice(start, i), start, end: i });
        } else if (c === "'" || c === '"') {
            let value = '';
            i++;
            for (;;) {
                if (i >= text.length) throw new SyntaxError('This string is never closed.', { start, end: i });
                const d = text[i];
                if (d === c) { i++; break; }
                if (d === '\\' && i + 1 < text.length) {
                    const e = text[i + 1];
                    value += e === 'n' ? '\n' : e === 't' ? '\t' : e;
                    i += 2;
                } else { value += d; i++; }
            }
            tokens.push({ kind: 'string', value, start, end: i });
        } else {
            const op = OPERATORS.find(o => text.startsWith(o, i));
            if (!op) throw new SyntaxError(`Unexpected character '${c}'.`, { start, end: start + 1 });
            i += op.length;
            tokens.push({ kind: 'op', value: op, start, end: i });
        }
    }
    tokens.push({ kind: 'eof', value: '', start: text.length, end: text.length });
    return tokens;
}

/** Binding powers, loosest first, as OCL ranks them. */
const BINARY: Record<string, { power: number; right?: boolean }> = {
    implies: { power: 1, right: true },
    or: { power: 2 }, xor: { power: 2 },
    and: { power: 3 },
    '=': { power: 4 }, '<>': { power: 4 },
    '<': { power: 5 }, '<=': { power: 5 }, '>': { power: 5 }, '>=': { power: 5 },
    '+': { power: 6 }, '-': { power: 6 },
    '*': { power: 7 }, '/': { power: 7 }, div: { power: 7 }, mod: { power: 7 },
};
const UNARY_POWER = 8;

class Parser {
    private i = 0;
    constructor(private readonly tokens: Token[]) {}

    private get peek(): Token { return this.tokens[this.i]; }
    private at(offset: number): Token { return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)]; }
    private is(value: string, token = this.peek): boolean {
        return (token.kind === 'op' || token.kind === 'ident') && token.value === value;
    }
    private next(): Token {
        const t = this.peek;
        if (t.kind !== 'eof') this.i++;
        return t;
    }
    private last(): Token { return this.tokens[Math.max(0, this.i - 1)]; }
    private expect(value: string, what = `'${value}'`): Token {
        if (!this.is(value)) this.fail(`Expected ${what}${this.found()}.`);
        return this.next();
    }
    private ident(what: string): Token {
        if (this.peek.kind !== 'ident' || KEYWORDS.has(this.peek.value)) this.fail(`Expected ${what}${this.found()}.`);
        return this.next();
    }
    private found(): string {
        const t = this.peek;
        return t.kind === 'eof' ? ', but the text ends here' : `, found '${t.value}'`;
    }
    private fail(message: string, span: Span = this.peek): never {
        throw new SyntaxError(message, { start: span.start, end: Math.max(span.end, span.start + 1) });
    }
    private span(start: number): Span { return { start, end: this.last().end }; }

    end(): void {
        if (this.peek.kind !== 'eof') this.fail(`Expected the end${this.found()}.`);
    }

    /** Operators binding tighter than `min` (Pratt): left-associative ones stop at their own power, `implies` doesn't. */
    expression(min = 0): Expr {
        let left = this.unary();
        for (;;) {
            const t = this.peek;
            const op = t.kind === 'op' || (t.kind === 'ident' && KEYWORDS.has(t.value)) ? BINARY[t.value] : undefined;
            if (!op || op.power <= min) return left;
            this.next();
            const right = this.expression(op.right ? op.power - 1 : op.power);
            left = { type: 'binary', op: t.value as BinaryOp, left, right, start: left.start, end: right.end };
        }
    }

    private unary(): Expr {
        const t = this.peek;
        if (this.is('not') || this.is('-')) {
            this.next();
            const operand = this.expression(UNARY_POWER);
            return { type: 'unary', op: t.value as 'not' | '-', operand, start: t.start, end: operand.end };
        }
        return this.postfix(this.primary());
    }

    private primary(): Expr {
        const t = this.peek;
        const start = t.start;
        if (t.kind === 'number') {
            this.next();
            const integer = /^\d+$/.test(t.value);
            return { type: 'literal', value: Number(t.value), ...(integer ? { integer: true } : {}), start, end: t.end };
        }
        if (t.kind === 'string') { this.next(); return { type: 'literal', value: t.value, start, end: t.end }; }
        if (this.is('(')) {
            this.next();
            const inner = this.expression();
            this.expect(')');
            return { ...inner, start, end: this.last().end };
        }
        if (t.kind !== 'ident') this.fail(`Expected an expression${this.found()}.`);
        switch (t.value) {
            case 'true': case 'false': this.next(); return { type: 'literal', value: t.value === 'true', start, end: t.end };
            case 'null': this.next(); return { type: 'literal', value: null, start, end: t.end };
            case 'self': this.next(); return { type: 'self', start, end: t.end };
            case 'if': {
                this.next();
                const cond = this.expression();
                this.expect('then');
                const then = this.expression();
                this.expect('else', "'else' (an if expression has both branches)");
                const otherwise = this.expression();
                this.expect('endif');
                return { type: 'if', cond, then, else: otherwise, ...this.span(start) };
            }
            case 'let': {
                this.next();
                const name = this.ident('a variable name').value;
                this.expect('=');
                const value = this.expression();
                this.expect('in');
                const body = this.expression();
                return { type: 'let', name, value, body, ...this.span(start) };
            }
        }
        if (KEYWORDS.has(t.value)) this.fail(`Expected an expression${this.found()}.`);
        this.next();
        if ((COLLECTIONS as readonly string[]).includes(t.value) && this.is('{')) {
            this.next();
            const items = this.is('}') ? [] : this.list('}');
            this.expect('}');
            return { type: 'collection', kind: t.value as CollectionKind, items, ...this.span(start) };
        }
        if (this.is('::')) {
            this.next();
            // Any word: a literal may be named like a keyword (ParameterDirectionKind::in, ::return).
            if (this.peek.kind !== 'ident') this.fail(`Expected a literal name${this.found()}.`);
            const literal = this.next().value;
            return { type: 'enumLiteral', enum: t.value, literal, ...this.span(start) };
        }
        if (this.is('(')) {
            this.next();
            const args = this.is(')') ? [] : this.list(')');
            this.expect(')');
            return { type: 'call', target: null, name: t.value, args, arrow: false, ...this.span(start) };
        }
        return { type: 'name', name: t.value, ...(this.pre() ? { pre: true } : {}), ...this.span(start) };
    }

    /** `@pre` after a name. */
    private pre(): boolean {
        if (!this.is('@')) return false;
        this.next();
        const t = this.ident("'pre'");
        if (t.value !== 'pre') this.fail(`Expected 'pre' after '@', found '${t.value}'.`, t);
        return true;
    }

    private list(close: string): Expr[] {
        const items = [this.expression()];
        while (this.is(',')) { this.next(); items.push(this.expression()); }
        if (!this.is(close)) this.fail(`Expected ',' or '${close}'${this.found()}.`);
        return items;
    }

    private postfix(target: Expr): Expr {
        for (;;) {
            if (this.is('.')) {
                this.next();
                const name = this.ident('a property or operation name').value;
                if (this.is('(')) {
                    this.next();
                    const args = this.is(')') ? [] : this.list(')');
                    this.expect(')');
                    target = { type: 'call', target, name, args, arrow: false, start: target.start, end: this.last().end };
                } else {
                    target = { type: 'nav', target, name, ...(this.pre() ? { pre: true } : {}), start: target.start, end: this.last().end };
                }
            } else if (this.is('->')) {
                this.next();
                const name = this.ident('a collection operation').value;
                this.expect('(', `'(' after '->${name}'`);
                if (ITERATORS.has(name)) {
                    let variable: string | null = null;
                    if (this.peek.kind === 'ident' && !KEYWORDS.has(this.peek.value) && this.is('|', this.at(1))) {
                        variable = this.next().value;
                        this.next();
                    }
                    const body = this.expression();
                    this.expect(')');
                    target = { type: 'iterate', target, name, variable, body, start: target.start, end: this.last().end };
                } else {
                    const args = this.is(')') ? [] : this.list(')');
                    this.expect(')');
                    target = { type: 'call', target, name, args, arrow: true, start: target.start, end: this.last().end };
                }
            } else {
                return target;
            }
        }
    }

    // ------------------------------------------------------------ statements

    block(): Block {
        const statements = this.statements(t => t.kind === 'eof');
        return { statements, start: 0, end: this.peek.end };
    }

    /** Statements separated by `;` (a trailing one is fine) until `stop`. */
    private statements(stop: (t: Token) => boolean): Stmt[] {
        const out: Stmt[] = [];
        while (!stop(this.peek)) {
            out.push(this.statement());
            if (this.is(';')) { this.next(); continue; }
            if (!stop(this.peek)) this.fail(`Expected ';' between statements${this.found()}.`);
        }
        return out;
    }

    private statement(): Stmt {
        const start = this.peek.start;
        if (this.is('if')) {
            this.next();
            const cond = this.expression();
            this.expect('then');
            const then = this.statements(t => this.is('else', t) || this.is('endif', t) || t.kind === 'eof');
            let otherwise: Stmt[] = [];
            if (this.is('else')) {
                this.next();
                otherwise = this.statements(t => this.is('endif', t) || t.kind === 'eof');
            }
            this.expect('endif');
            return { type: 'if', cond, then, else: otherwise, ...this.span(start) };
        }
        if (this.is('let')) {
            this.next();
            const name = this.ident('a variable name').value;
            this.expect('=');
            const value = this.expression();
            if (this.is('in')) {
                // A let expression used as a statement.
                this.next();
                const body = this.expression();
                const expr: Expr = { type: 'let', name, value, body, ...this.span(start) };
                return { type: 'expr', expr, ...this.span(start) };
            }
            return { type: 'let', name, value, ...this.span(start) };
        }
        if (this.is('return')) {
            this.next();
            const value = this.is(';') || this.is('else') || this.is('endif') || this.peek.kind === 'eof' ? null : this.expression();
            return { type: 'return', value, ...this.span(start) };
        }
        const expr = this.expression();
        if (this.is(':=')) {
            const op = this.next();
            if (expr.type !== 'name' && expr.type !== 'nav') this.fail('Only a variable or a property can be assigned to.', expr);
            if (expr.pre) this.fail(`'@pre' is the value before; it can't be assigned to.`, op);
            const value = this.expression();
            return { type: 'assign', target: expr, value, ...this.span(start) };
        }
        return { type: 'expr', expr, ...this.span(start) };
    }
}

export type ParseResult<T> =
    | { value: T; diagnostics: [] }
    | { value: undefined; diagnostics: [ExprDiagnostic] };

function run<T>(text: string, f: (p: Parser) => T): ParseResult<T> {
    try {
        const p = new Parser(lex(text));
        const value = f(p);
        p.end();
        return { value, diagnostics: [] };
    } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        return { value: undefined, diagnostics: [{ code: DiagnosticCode.Syntax, severity: 'error', message: e.message, ...e.span }] };
    }
}

/** A single expression: a guard, an invariant, a derived value, a query's body. */
export function parseExpression(text: string): ParseResult<Expr> {
    return run(text, p => p.expression());
}

/** Statements separated by `;`: a transition's effect, an operation's body. */
export function parseBlock(text: string): ParseResult<Block> {
    return run(text, p => p.block());
}
