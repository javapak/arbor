import { Validator } from '@cfworker/json-schema';   // interprets schemas; no codegen
import { describe, expect, it } from 'vitest';
import { IRIndex } from '@arbor/ir';
import schema from '../../ir/schema/ir.schema.json' with { type: 'json' };
import { toFlowGraph } from '@arbor/adapter-flow';
import { EmptyFileSystem, URI } from 'langium';
import { loadWorkspace } from '../src/cli/load.js';
import { toIR } from '../src/ir/ast-to-ir.js';
import { createArborServices } from '../src/language/arbor-module.js';
import type { Document } from '../src/language/generated/ast.js';
import { PERSISTENCE, SHOP, SOFTWARE, withProfiles } from './helpers.js';

async function shopIR() {
    const r = await withProfiles(SHOP);
    expect(r.diagnostics).toEqual([]);
    return r.ir;
}

describe('AST -> IR', () => {
    it('conforms to the IR JSON Schema', async () => {
        const ir = await shopIR();
        const result = new Validator(schema as object, '2020-12').validate(ir);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
    });

    it('uses stable IDs, propagating them to children', async () => {
        const ir = await shopIR();
        const ids = ir.models[0].elements.map(e => e.id);
        expect(ids).toContain('user');
        expect(ids).toContain('user.email');
        expect(ids).toContain('shop.Checkout.OrderApi.placeOrder');
    });

    it('resolves references to element IDs and infers containment', async () => {
        const ir = await shopIR();
        const buyer = ir.models[0].elements.find(e => e.id === 'order.buyer')!;
        expect(buyer.references.type).toEqual(['user']);
        expect(buyer.parent).toBe('order');
        expect(buyer.containedIn).toBe('fields');
        expect(buyer.properties.onDelete).toBe('cascade');
    });

    it('is self-describing: profiles travel with the model', async () => {
        const { shared } = createArborServices(EmptyFileSystem);
        const f = shared.workspace.LangiumDocumentFactory;
        const docs = [['software', SOFTWARE], ['persistence', PERSISTENCE], ['shop', SHOP]].map(([n, t]) => {
            const d = f.fromString<Document>(t, URI.parse(`file:///${n}.arbor`));
            shared.workspace.LangiumDocuments.addDocument(d);
            return d;
        });
        await shared.workspace.DocumentBuilder.build(docs);
        const ir = toIR([docs[2].parseResult.value]);          // only the model
        expect(ir.profiles.map(p => p.name).sort()).toEqual(['persistence', 'software']);
    });

    it('IRIndex applies inherited features, defaults and visuals', async () => {
        const index = new IRIndex(await shopIR());
        expect(index.isA('persistence.Entity', 'software.Type')).toBe(true);
        const user = index.elements.get('user')!;
        expect(index.get(user, 'schema')).toBe('public');          // default
        expect(index.visual(user.kind).icon).toBe('database');      // own
        expect(index.features(user.kind).map(f => f.name)).toContain('fields'); // inherited
    });

    it('still produces an IR when the workspace has errors', async () => {
        const r = await loadWorkspace([{ uri: 'm.arbor', text: 'model m { Missing X {} }' }]);
        expect(r.ok).toBe(false);
        expect(r.ir.models[0].elements).toEqual([]);
    });
});

describe('IR -> flow graph', () => {
    it('maps containment to nesting and references to edges', async () => {
        const g = toFlowGraph(await shopIR(), { layout: { user: { x: 10, y: 20 } } });
        const user = g.nodes.find(n => n.id === 'user')!;
        expect(user.visual.position).toEqual({ x: 10, y: 20 });
        expect(user.visual.icon).toBe('database');
        expect(user.visual.container).toBe(true);
        expect(g.nodes.find(n => n.id === 'user.email')!.parentId).toBe('user');
        expect(g.edges).toContainEqual(expect.objectContaining({ source: 'order.buyer', target: 'user', label: 'type' }));
        expect(g.nodes.find(n => n.id === 'shop.Checkout')!.visual.shapeType).toBe(4); // package
    });

    it('can render containment as edges instead', async () => {
        const g = toFlowGraph(await shopIR(), { containment: 'edges' });
        expect(g.nodes.every(n => n.parentId === null)).toBe(true);
        expect(g.edges.some(e => e.type === 'containment' && e.target === 'user.email')).toBe(true);
    });
});
