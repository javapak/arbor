import { describe, expect, it } from 'vitest';
import { IRIndex } from '@arbor/ir';
import { buildDocuments } from '../src/cli/load.js';
import { outline } from '../src/lsp/outline.js';
import { PERSISTENCE, SHOP, SOFTWARE } from './helpers.js';

async function workspace() {
    const sources = [
        { uri: 'software.arbor', text: SOFTWARE },
        { uri: 'persistence.arbor', text: PERSISTENCE },
        { uri: 'shop.arbor', text: SHOP },
    ];
    const docs = await buildDocuments(sources);
    return outline(docs.map((d, i) => ({ uri: sources[i].uri, root: d.parseResult.value })));
}

describe('workspace outline', () => {
    it('has every profile and model, and where each item is named', async () => {
        const { ir, locations } = await workspace();
        expect(ir.profiles.map(p => p.name)).toEqual(['software', 'persistence']);
        expect(ir.models.map(m => m.name)).toEqual(['shop']);

        const line = (key: string) => locations[key]?.range.start.line;
        const lineOf = (text: string, needle: string) => text.split('\n').findIndex(l => l.includes(needle));
        expect(locations['kind:persistence.Entity'].uri).toBe('persistence.arbor');
        expect(line('kind:persistence.Entity')).toBe(lineOf(PERSISTENCE, 'kind Entity'));
        expect(line('feature:persistence.Entity.tableName')).toBe(lineOf(PERSISTENCE, 'prop tableName'));
        expect(line('literal:persistence.OnDeleteAction.cascade')).toBe(lineOf(PERSISTENCE, 'enum OnDeleteAction'));
        expect(line('model:shop')).toBe(lineOf(SHOP, 'model shop'));
        // Stable IDs and nested paths both key elements, per model.
        expect(line('element:shop:user')).toBe(lineOf(SHOP, 'Entity User'));
        expect(line('element:shop:shop.Checkout.OrderApi.placeOrder')).toBe(lineOf(SHOP, 'Operation placeOrder'));
    });

    it('tells core profiles from domain profiles', async () => {
        const index = new IRIndex((await workspace()).ir);
        expect(index.dependsOn('software')).toEqual([]);
        expect(index.dependsOn('persistence')).toEqual(['software']);
    });
});
