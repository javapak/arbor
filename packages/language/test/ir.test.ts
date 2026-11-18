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
        expect(user.visual).toMatchObject({ shape: 'rectangle', color: '#f59e0b', container: false });
        expect(user.visual.visualContent).toMatchObject({ type: 'svg', colorizable: true, size: { width: 256, height: 256 } });
        expect(user.visual.visualContent!.content).toMatch(/^<svg /);
        // The layout's width is the least a box gets; its properties may widen it. Height: header,
        // padding and two property lines.
        expect(user.visual.size.width).toBeGreaterThanOrEqual(200);
        expect(user.visual.size.height).toBe(28 + 2 * 8 + 2 * 18);
        expect(user.data.size).toEqual(user.visual.size);
        expect(g.nodes.find(n => n.id === 'shop.Checkout')!.visual.shape).toBe('package');
        expect(g.nodes.find(n => n.id === 'user.email')!.data.parentId).toBe('user');
    });

    it('maps references to arrow edges and containment to composition edges', async () => {
        const r = await loadWorkspace([
            { uri: 'p.arbor', text: `profile p {
                kind Box    { ref link: Box [0..1] }
                kind Holder { contains items: Free [0..*] }
                kind Free   {}
            }` },
            { uri: 'm.arbor', text: 'model m { Box a {} Box b { link: -> a } Holder h { Free f {} } }' }
        ]);
        expect(r.diagnostics).toEqual([]);
        const g = toFlowGraph(r.ir, { edgeLayout: { 'm.b--link->m.a': [{ x: 5, y: 5 }] } });
        const ref = g.edges.find(e => e.sourceNodeId === 'm.b' && e.targetNodeId === 'm.a')!;
        expect(ref.data).toEqual({ label: 'link', relation: 'reference' });
        expect(ref.style.targetMarker).toBe('open-arrow');
        expect(ref.userVertices).toEqual([{ x: 5, y: 5 }]);
        const own = g.edges.find(e => e.sourceNodeId === 'm.h' && e.targetNodeId === 'm.h.f')!;
        expect(own.data).toEqual({ label: 'items', relation: 'containment' });
        expect(own.style.sourceMarker).toBe('filled-diamond');
    });

    it('draws members in their owner as rows, labelled from their slots, without the edges the label shows', async () => {
        const r = await loadWorkspace([
            { uri: 'p.arbor', text: `profile p {
                kind Box  { contains parts: Part [0..*] }
                kind Part {
                    ref type:  Box [0..1]
                    ref other: Box [0..1]
                    visual { member: true  label: "{name} : {type}" }
                }
            }` },
            { uri: 'm.arbor', text: 'model m { Box a { Part x { type: -> b  other: -> b } } Box b {} }' }
        ]);
        expect(r.diagnostics).toEqual([]);
        const g = toFlowGraph(r.ir);
        const x = g.nodes.find(n => n.id === 'm.a.x')!;
        expect(x.parentId).toBe('m.a');
        expect(x.data.label).toBe('x : b');
        expect(x.visual.presentation).toBe('row');
        expect(x.visual.detail).toBeUndefined();   // no «Part» on every row of a Box
        expect(g.edges.map(e => e.id)).toEqual(['m.a.x--other->m.b']);
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
        // Same look as generated nodes, apart from what the node's own properties add.
        const { compartment, size, ...look } = user.visual;
        const { size: templateSize, ...templateLook } = entity.visual;
        expect(templateLook).toEqual(look);
        expect(templateSize).toEqual({ width: 160, height: 80 });
        expect(size.width).toBeGreaterThan(160);
        // Its properties as written, strings quoted, long lines cut.
        expect(compartment).toEqual(['tableName = "users"', 'description = "A registered cus…']);
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
        // Nodes inside a container are arranged by the renderer, so only top-level ones have places.
        const all = g.nodes.filter(n => !n.parentId).map(n => `${n.data.position.x},${n.data.position.y}`);
        expect(new Set(all).size).toBe(all.length);
    });

    it('can hide containment edges', async () => {
        const g = toFlowGraph(await shopIR(), { containment: 'hidden' });
        expect(g.edges.every(e => e.data.relation === 'reference')).toBe(true);
    });

    it('draws the contents of container kinds inside them, as rows, and other containment as edges', async () => {
        const r = await loadWorkspace([
            { uri: 'p.arbor', text: `profile p {
                kind Box  { contains items: Item [0..*]  visual { container: true } }
                kind Item { contains parts: Part [0..*] }
                kind Part {}
            }` },
            { uri: 'm.arbor', text: 'model m { Box b { Item i { Part x {} } Item j {} } Item k {} }' }
        ]);
        expect(r.diagnostics).toEqual([]);
        const g = toFlowGraph(r.ir);
        const node = (id: string) => g.nodes.find(n => n.id === id)!;
        expect(node('m.b.i').parentId).toBe('m.b');
        expect(node('m.b.j').parentId).toBe('m.b');
        expect(node('m.b.i.x').parentId).toBeUndefined();
        expect(node('m.b').visual.container).toBe(true);
        expect(g.edges.map(e => e.id)).toEqual(['m.b.i--parts->m.b.i.x']);
        // Elements without nested elements of their own are rows; the container is sized for them
        // as the renderer arranges them: header, padding, and two rows in one column.
        expect(node('m.b.i').visual).toMatchObject({ presentation: 'row', detail: '«Item»' });
        expect(node('m.b').data.size).toEqual({ width: 180 + 2 * 8, height: 28 + 2 * 8 + 26 + 4 + 26 });
        const box = (id: string) => {
            const n = node(id);
            return { l: n.data.position.x - n.data.size.width / 2, r: n.data.position.x + n.data.size.width / 2,
                t: n.data.position.y - n.data.size.height / 2, b: n.data.position.y + n.data.size.height / 2 };
        };
        const b = box('m.b');
        // Top-level elements don't overlap the grown container.
        const k = box('m.k');
        expect(k.l >= b.r || k.r <= b.l || k.t >= b.b || k.b <= b.t).toBe(true);
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
