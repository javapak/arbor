import { Validator } from '@cfworker/json-schema';   // interprets schemas; no codegen
import { describe, expect, it } from 'vitest';
import { IRIndex, referenceSlotsFor, withTarget, withoutTarget } from '@arbor/ir';
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
        // padding, two property lines, and its two columns as member rows.
        expect(user.visual.size.width).toBeGreaterThanOrEqual(200);
        expect(user.visual.size.height).toBe(28 + 2 * 8 + 2 * 18 + 6 + 26 + 4 + 26);
        expect(user.data.size).toEqual(user.visual.size);
        expect(g.nodes.find(n => n.id === 'shop.Checkout')!.visual.shape).toBe('package');
        expect(g.nodes.find(n => n.id === 'user.email')!.data.parentId).toBe('user');
    });

    it('places elements without a position with their top-left corner on the snap grid', async () => {
        const g = toFlowGraph(await shopIR(), { grid: 50, layout: { user: { x: 13, y: 7 } } });
        const top = g.nodes.filter(n => !n.parentId);
        expect(top.length).toBeGreaterThan(3);
        for (const n of top) {
            if (n.id === 'user') continue;   // positioned by the layout: left where it is
            const { x, y } = n.data.position, { width, height } = n.data.size;
            expect([(x - width / 2) % 50, (y - height / 2) % 50].map(v => Math.abs(v))).toEqual([0, 0]);
        }
        expect(g.nodes.find(n => n.id === 'user')!.data.position).toEqual({ x: 13, y: 7 });
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
        expect(ref.data).toEqual({ label: 'link', relation: 'reference', feature: 'link' });
        expect(ref.style.targetMarker).toBe('open-arrow');
        expect(ref.userVertices).toEqual([{ x: 5, y: 5 }]);
        const own = g.edges.find(e => e.sourceNodeId === 'm.h' && e.targetNodeId === 'm.h.f')!;
        expect(own.data).toEqual({ label: 'items', relation: 'containment', feature: 'items' });
        expect(own.style.sourceMarker).toBe('filled-diamond');
    });

    it('styles a feature\'s edges from its edge visuals', async () => {
        const r = await loadWorkspace([
            { uri: 'p.arbor', text: `profile p {
                kind Box {
                    ref uses:  Box [0..*] { line: "dashed"  targetMarker: "arrow"  label: "«use»"  targetLabel: "{name} {multiplicity}" }
                    ref quiet: Box [0..1] { hidden: true }
                    contains parts: Box [0..*] { sourceMarker: "diamond"  color: "#ff0000" }
                }
            }` },
            { uri: 'm.arbor', text: 'model m { Box a { Box b {} } Box c { uses: [-> a]  quiet: -> a } }' }
        ]);
        expect(r.diagnostics).toEqual([]);
        const g = toFlowGraph(r.ir);
        const uses = g.edges.find(e => e.data.feature === 'uses')!;
        expect(uses.style).toMatchObject({ dashPattern: [8, 6], targetMarker: 'open-arrow' });
        expect(uses.data).toMatchObject({ label: '«use»', targetLabel: 'uses 0..*' });
        expect(g.edges.some(e => e.data.feature === 'quiet')).toBe(false);
        const parts = g.edges.find(e => e.data.feature === 'parts')!;
        expect(parts.style).toMatchObject({ sourceMarker: 'diamond', color: [1, 0, 0, 1] });
    });

    it('draws elements of an edge kind as edges between their ends, and as nodes until both are set', async () => {
        const r = await loadWorkspace([
            { uri: 'p.arbor', text: `profile p {
                kind Class { contains generalizations: Generalization [0..*]  contains notes: Note [0..*] }
                kind Generalization {
                    ref general: Class [1]
                    contains notes: Note [0..*]
                    visual { source: "owner"  target: "general"  targetMarker: "triangle"  label: "" }
                }
                kind Link {
                    ref from: Class [1]  ref to: Class [1]  prop role: string [0..1]
                    visual { source: "from"  target: "to"  line: "dotted"  targetLabel: "{role}" }
                }
                kind Note { ref about: Generalization [0..1] }
            }` },
            { uri: 'm.arbor', text: `model m {
                Class A {}
                Class B { Generalization g { general: -> A  Note n {} } }
                Class C { Generalization g { general: -> B } Note watcher { about: -> B.g } }
                Link l { from: -> A  to: -> C  role: "owner" }
                Link dangling { from: -> A }
            }` }
        ]);
        expect(r.diagnostics.filter(d => d.severity === 'error').map(d => d.code)).toEqual(['ARB105']);
        const g = toFlowGraph(r.ir, { edgeLayout: { 'm.B.g': [{ x: 1, y: 2 }] } });
        const gen = g.edges.find(e => e.id === 'm.B.g')!;
        expect(gen).toMatchObject({ sourceNodeId: 'm.B', targetNodeId: 'm.A', userVertices: [{ x: 1, y: 2 }] });
        expect(gen.data).toEqual({ label: '', relation: 'element' });
        expect(gen.style.targetMarker).toBe('inheritance');
        const link = g.edges.find(e => e.id === 'm.l')!;
        expect(link).toMatchObject({ sourceNodeId: 'm.A', targetNodeId: 'm.C', style: { dashPattern: [2, 4] } });
        expect(link.data).toMatchObject({ label: 'l', targetLabel: 'owner' });
        const ids = g.nodes.map(n => n.id);
        // Not nodes: the edges, and what they contain. Nor the containment edges to them.
        expect(ids).not.toContain('m.B.g');
        expect(ids).not.toContain('m.B.g.n');
        expect(g.edges.some(e => e.targetNodeId === 'm.B.g' || e.sourceNodeId === 'm.B.g')).toBe(false);
        // Missing an end: a node, so it can be seen and connected.
        expect(ids).toContain('m.dangling');
        expect(ids).toContain('m.C.watcher');
    });

    it('finds the reference slots an edge drawn between two elements can set, and their new values', async () => {
        const r = await loadWorkspace([
            { uri: 'p.arbor', text: `profile p {
                kind Base {}
                kind Box extends Base {}
                kind Other {}
                kind Link {
                    ref one:  Box [0..1]
                    ref many: Base [0..*]
                    ref else: Other [0..1]
                }
            }` },
            { uri: 'm.arbor', text: 'model m { Box a {} Box b {} Other o {} Link l { many: [-> a] } }' }
        ]);
        expect(r.diagnostics).toEqual([]);
        const index = new IRIndex(r.ir);
        const el = (id: string) => index.elements.get(id)!;
        const slots = referenceSlotsFor(index, el('m.l'), el('m.b'));
        expect(slots.map(s => s.name)).toEqual(['one', 'many']);     // a Box is a Base; not an Other
        expect(withTarget(el('m.l'), slots[0], 'm.b')).toBe('m.b');
        expect(withTarget(el('m.l'), slots[1], 'm.b')).toEqual(['m.a', 'm.b']);
        expect(withTarget(el('m.l'), slots[1], 'm.a')).toBeUndefined();   // already there
        expect(withoutTarget(el('m.l'), slots[1], 'm.a')).toBeUndefined(); // nothing left: remove the slot
        expect(referenceSlotsFor(index, el('m.l'), el('m.o')).map(s => s.name)).toEqual(['else']);
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
