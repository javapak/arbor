/**
 * The syntax tree of an expression or a block of statements. Every node
 * carries its span in the source text (offsets, end exclusive), so checker and
 * interpreter errors point at the exact characters, also inside a string slot.
 */

export interface Span { start: number; end: number }

export type CollectionKind = 'Set' | 'OrderedSet' | 'Bag' | 'Sequence';

export type BinaryOp =
    | 'implies' | 'or' | 'xor' | 'and'
    | '=' | '<>' | '<' | '<=' | '>' | '>='
    | '+' | '-' | '*' | '/' | 'div' | 'mod';

export type Expr = Span & (
    | { type: 'literal'; value: number | string | boolean | null; integer?: boolean }
    | { type: 'self' }
    /** A variable, a property of `self`, or a type (as in `oclIsKindOf(State)`). `@pre`: its value before an operation. */
    | { type: 'name'; name: string; pre?: boolean }
    /** `Kind::literal`. */
    | { type: 'enumLiteral'; enum: string; literal: string }
    /** `target.name`; over a collection, the names of its items (OCL's shorthand for collect). */
    | { type: 'nav'; target: Expr; name: string; pre?: boolean }
    /**
     * `target.op(args)`, `target->op(args)` (`arrow`: an operation of collections),
     * or `op(args)` with no target: an operation of `self`.
     */
    | { type: 'call'; target: Expr | null; name: string; args: Expr[]; arrow: boolean }
    /** `target->select(x | body)`, and the other iterators. Without a variable, `body` reads the item's properties as names. */
    | { type: 'iterate'; target: Expr; name: string; variable: string | null; body: Expr }
    | { type: 'unary'; op: 'not' | '-'; operand: Expr }
    | { type: 'binary'; op: BinaryOp; left: Expr; right: Expr }
    | { type: 'if'; cond: Expr; then: Expr; else: Expr }
    | { type: 'let'; name: string; value: Expr; body: Expr }
    | { type: 'collection'; kind: CollectionKind; items: Expr[] }
);

export type Stmt = Span & (
    /** `target := value`: a variable, a property of `self`, or `object.property`. */
    | { type: 'assign'; target: Expr; value: Expr }
    /** An expression run for its effect: an operation call. */
    | { type: 'expr'; expr: Expr }
    | { type: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] }
    /** `let x = value` for the statements after it. */
    | { type: 'let'; name: string; value: Expr }
    | { type: 'return'; value: Expr | null }
);

/** Statements separated by `;`. */
export interface Block extends Span { statements: Stmt[] }
