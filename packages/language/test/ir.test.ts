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
        expect(index.visual(user.kind).tint).toBe(true);           // own
        expect(index.features(user.kind).map(f => f.name)).toContain('fields'); // inherited
    });

    it('still produces an IR when the workspace has errors', async () => {
        const r = await loadWorkspace([{ uri: 'm.arbor', text: 'model m { Missing X {} }' }]);
        expect(r.ok).toBe(false);
        expect(r.ir.models[0].elements).toEqual([]);
    });
});

describe('IR -> flow graph', () => {
    it('produces renderer nodes: position, size and label in data, shape and hex color in visual', async () => {
        const g = toFlowGraph(await shopIR(), { layout: { user: { x: 10, y: 20, width: 200 } } });
        const user = g.nodes.find(n => n.id === 'user')!;
        expect(user.data.position).toEqual({ x: 10, y: 20 });
        expect(user.data.label).toBe('User');
        expect(user.visual).toMatchObject({ shape: 'rectangle', color: '#f59e0b', container: true });
        expect(user.visual.visualContent).toMatchObject({ type: 'svg', colorizable: true, size: { width: 64, height: 64 } });
        expect(user.visual.visualContent!.content).toMatch(/^<svg /);
        expect(user.visual.size).toEqual({ width: 200, height: 80 });
        expect(user.data.size).toEqual(user.visual.size);
        expect(g.nodes.find(n => n.id === 'shop.Checkout')!.visual.shape).toBe('package');
        expect(g.nodes.find(n => n.id === 'user.email')!.data.parentId).toBe('user');
    });

    it('maps references to arrow edges and containment to composition edges', async () => {
        const g = toFlowGraph(await shopIR(), { edgeLayout: { 'order.buyer--type->user': [{ x: 5, y: 5 }] } });
        const ref = g.edges.find(e => e.sourceNodeId === 'order.buyer' && e.targetNodeId === 'user')!;
        expect(ref.data).toEqual({ label: 'type', relation: 'reference' });
        expect(ref.style.targetMarker).toBe('open-arrow');
        expect(ref.userVertices).toEqual([{ x: 5, y: 5 }]);
        const own = g.edges.find(e => e.sourceNodeId === 'user' && e.targetNodeId === 'user.email')!;
        expect(own.data).toEqual({ label: 'fields', relation: 'containment' });
        expect(own.style.sourceMarker).toBe('filled-diamond');
    });

    it('is a complete webgpu-flow diagram file with a palette of instantiable kinds', async () => {
        const g = toFlowGraph(await shopIR());
        expect(g).toMatchObject({ format: 'webgpu-flow/diagram', version: 1 });
        const ids = g.palette!.map(t => t.id);
        expect(ids).toContain('persistence.Entity');
        expect(ids).not.toContain('software.NamedElement');   // abstract
        const entity = g.palette!.find(t => t.id === 'persistence.Entity')!;
        expect(entity).toMatchObject({ label: 'Entity', group: 'persistence', type: 'Entity', data: { kind: 'persistence.Entity' } });
        const user = g.nodes.find(n => n.id === 'user')!;
        expect(entity.visual).toEqual({ ...user.visual, container: false });   // same look as generated nodes
        expect(toFlowGraph(await shopIR(), { palette: false }).palette).toBeUndefined();
    });

    it('auto-places elements without a layout entry in free grid cells', async () => {
        const plain = toFlowGraph(await shopIR());
        const first = plain.nodes[0], second = plain.nodes[1];
        // Pin the second element where the first would go: the first moves on to a free cell.
        const g = toFlowGraph(await shopIR(), { layout: { [second.id]: { ...first.data.position } } });
        const a = g.nodes.find(n => n.id === first.id)!.data.position;
        const b = g.nodes.find(n => n.id === second.id)!.data.position;
        expect(b).toEqual(first.data.position);
        expect(a).not.toEqual(b);
        const all = g.nodes.map(n => `${n.data.position.x},${n.data.position.y}`);
        expect(new Set(all).size).toBe(all.length);
    });

    it('can hide containment edges', async () => {
        const g = toFlowGraph(await shopIR(), { containment: 'hidden' });
        expect(g.edges.every(e => e.data.relation === 'reference')).toBe(true);
    });

    it('draws an svg or image instead of a shape when no shape is given', async () => {
        const r = await loadWorkspace([
            { uri: 'p.arbor', text: `profile p {
                kind Actor { visual { svg: "<svg viewBox='0 0 1 1'/>" } }
                kind Logo  { visual { image: "https://example.com/logo.png" } }
                kind Badge { visual { icon: "⭐" } }
            }` },
            { uri: 'm.arbor', text: 'model m { Actor a {} Logo l {} Badge b {} }' }
        ]);
        expect(r.diagnostics).toEqual([]);
        const [a, l, b] = toFlowGraph(r.ir).nodes;
        expect(a.visual).toMatchObject({ shape: 'none', visualContent: { type: 'svg', content: "<svg viewBox='0 0 1 1'/>" } });
        expect(a.visual.visualContent!.colorizable).toBeUndefined();
        expect(l.visual).toMatchObject({ shape: 'none', visualContent: { type: 'image' } });
        expect(b.visual).toMatchObject({ shape: 'rectangle', icon: '⭐' });
        expect(b.visual.visualContent).toBeUndefined();
    });

    it('falls back to rectangle for shapes the renderer does not draw', async () => {
        const r = await loadWorkspace([
            { uri: 'p.arbor', text: 'profile p { kind K { visual { shape: "blob" } } }' },
            { uri: 'm.arbor', text: 'model m { K k {} }' }
        ]);
        expect(toFlowGraph(r.ir).nodes[0].visual.shape).toBe('rectangle');
    });
});
