import { describe, expect, it } from 'vitest';
import { checkTemplate, checkVisualValue, fillTemplate, templateSlots } from '../src/index.js';

const values = (v: Record<string, string>) => (k: string) => v[k];

describe('label templates', () => {
    const transition = '{trigger}{? [{guard}]}{? / {effect}}';

    it('fills placeholders, leaving missing ones empty', () => {
        expect(fillTemplate('{name} : {type}', values({ name: 'id', type: 'UUID' }))).toBe('id : UUID');
        expect(fillTemplate('{name} : {type}', values({ name: 'id' }))).toBe('id : ');
    });

    it('shows an optional part only when its placeholders all have values', () => {
        expect(fillTemplate(transition, values({ trigger: 'returned' }))).toBe('returned');
        expect(fillTemplate(transition, values({ trigger: 'returned', effect: 'fine()' }))).toBe('returned / fine()');
        expect(fillTemplate(transition, values({ trigger: 'paid', guard: 'ok', effect: 'close()' }))).toBe('paid [ok] / close()');
        expect(fillTemplate('{name}(){? : {returns}}', values({ name: 'lend', returns: '' }))).toBe('lend()');   // "" is no value
        expect(fillTemplate('{? {a} and {b}}', values({ a: 'x' }))).toBe('');
        expect(fillTemplate('{?always}', values({}))).toBe('always');
    });

    it('nests: an inner part that drops out leaves the outer one shown', () => {
        const t = '{name}{? : {type}{? [{multiplicity}]}}';
        expect(fillTemplate(t, values({ name: 'tags', type: 'String', multiplicity: '0..*' }))).toBe('tags : String [0..*]');
        expect(fillTemplate(t, values({ name: 'tags', type: 'String' }))).toBe('tags : String');
        expect(fillTemplate(t, values({ name: 'tags', multiplicity: '0..*' }))).toBe('tags');
    });

    it('keeps other braces as text', () => {
        expect(fillTemplate('{ {name} } {not a slot}', values({ name: 'x' }))).toBe('{ x } {not a slot}');
    });

    it('lists its placeholders, optional parts included', () => {
        expect(templateSlots(transition)).toEqual(['trigger', 'guard', 'effect']);
        expect(templateSlots('{name} {name}')).toEqual(['name']);
    });

    it('reports an optional part that is never closed, also as a visual value', () => {
        expect(checkTemplate(transition)).toBeUndefined();
        expect(checkTemplate('{trigger}{? [{guard}]')).toMatch(/never closed/);
        expect(checkVisualValue('label', '{? {name}')).toMatch(/never closed/);
        expect(checkVisualValue('color', '{?')).toMatch(/hex color/);
    });
});
