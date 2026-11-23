/**
 * Types, and the two things the language is checked and run against: a type
 * space (what `self` has, and of which type) and a value space (reading,
 * writing and calling on objects). Each world implements both: the model's
 * own elements (see ir.ts), or a simulation's objects.
 */
import type { CollectionKind } from './ast.js';

export type PrimitiveName = 'Boolean' | 'Integer' | 'Real' | 'String';

export type Type =
    | { kind: 'primitive'; name: PrimitiveName }
    | { kind: 'enum'; name: string; literals: readonly string[] }
    /**
     * Anything with properties and operations: a class, a model element's kind, a datatype.
     * `name` identifies it (an element's ID, say); `label`, if given, is how messages show it.
     */
    | { kind: 'class'; name: string; label?: string }
    | { kind: 'collection'; collection: CollectionKind; element: Type }
    /** `null`'s type: fits any type. */
    | { kind: 'null' }
    /** What a statement or an operation returning nothing gives. */
    | { kind: 'void' }
    /** Not known: after an error (so one mistake isn't reported again), or where the space doesn't say. */
    | { kind: 'any' }
    /** A type used as a value, as in `oclIsKindOf(State)`. */
    | { kind: 'typeLiteral'; of: Type };

export const BOOLEAN: Type = { kind: 'primitive', name: 'Boolean' };
export const INTEGER: Type = { kind: 'primitive', name: 'Integer' };
export const REAL: Type = { kind: 'primitive', name: 'Real' };
export const STRING: Type = { kind: 'primitive', name: 'String' };
export const ANY: Type = { kind: 'any' };
export const VOID: Type = { kind: 'void' };
export const NULL: Type = { kind: 'null' };

export const collectionOf = (collection: CollectionKind, element: Type): Type => ({ kind: 'collection', collection, element });

/** The collection a multi-valued feature holds, from its `ordered` and `unique` (UML's four). */
export function collectionKind(ordered: boolean, unique: boolean): CollectionKind {
    return ordered ? (unique ? 'OrderedSet' : 'Sequence') : (unique ? 'Set' : 'Bag');
}

export function typeName(t: Type): string {
    switch (t.kind) {
        case 'class': return t.label ?? t.name;
        case 'primitive': case 'enum': return t.name;
        case 'collection': return `${t.collection}(${typeName(t.element)})`;
        case 'null': return 'null';
        case 'void': return 'nothing';
        case 'any': return 'any type';
        case 'typeLiteral': return `the type ${typeName(t.of)}`;
    }
}

export interface PropertyInfo {
    /** A collection type for a multi-valued property. */
    type: Type;
    /** Not written by actions: derived, or read-only. */
    readonly?: boolean;
}

export interface OperationInfo {
    params: Array<{ name: string; type: Type }>;
    /** VOID for none. */
    returns: Type;
    /** Changes nothing, so a query may call it. */
    query: boolean;
}

/** What the checker knows about the world an expression is about. */
export interface TypeSpace {
    /** A named type (class or enum) in scope, for `E::literal`, `oclIsKindOf(T)` and the like. */
    type(name: string): Type | undefined;
    property(owner: string, name: string): PropertyInfo | undefined;
    operation(owner: string, name: string): OperationInfo | undefined;
    /** Class `sub` is `sup` or a kind of it. */
    conforms(sub: string, sup: string): boolean;
    /** The names of a class's properties and operations, to suggest one for a typo. */
    members?(owner: string): string[];
}

/** Whether a value of type `from` can be used where `to` is expected. */
export function conforms(from: Type, to: Type, space: TypeSpace): boolean {
    if (from.kind === 'any' || to.kind === 'any' || from.kind === 'null') return true;
    switch (to.kind) {
        case 'primitive':
            return from.kind === 'primitive' && (from.name === to.name || (from.name === 'Integer' && to.name === 'Real'));
        case 'enum':
            return from.kind === 'enum' && from.name === to.name;
        case 'class':
            return from.kind === 'class' && space.conforms(from.name, to.name);
        case 'collection':
            // As in OCL, the same kind of collection (`->asSet()` and the like convert), with fitting elements.
            return from.kind === 'collection' && from.collection === to.collection && conforms(from.element, to.element, space);
        case 'void':
            return from.kind === 'void';
        case 'null':
            return false;
        case 'typeLiteral':
            return from.kind === 'typeLiteral';
    }
}

export const isNumeric = (t: Type) => t.kind === 'any' || (t.kind === 'primitive' && (t.name === 'Integer' || t.name === 'Real'));
export const isBoolean = (t: Type) => t.kind === 'any' || (t.kind === 'primitive' && t.name === 'Boolean');
export const isString = (t: Type) => t.kind === 'any' || (t.kind === 'primitive' && t.name === 'String');
