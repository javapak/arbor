/**
 * Emitter: IR -> nodes/edges for the WebGPU flow renderer.
 *
 * Knows only the IR, never Langium. Containment becomes node nesting (or
 * edges, if you prefer), references become edges, and the profile's `visual`
 * block becomes node visuals. Layout comes from a sidecar keyed by element ID,
 * so the text never stores coordinates.
 *
 * The output node shape ({ id, type, visual, data }) follows the renderer's
 * DiagramNode. Adjust `SHAPE_TYPE` and `FlowNode` to match the renderer exactly.
 */
import { IRIndex, type IRDocument, type IRElement } from '@arbor/ir';

/** Profile `shape` name -> renderer `shapeType` index. */
export const SHAPE_TYPE: Record<string, number> = {
    rectangle: 0,
    circle: 1,
    diamond: 2,
    hexagon: 3,
    package: 4
};

export interface LayoutEntry { x: number; y: number; width?: number; height?: number }
/** Sidecar file owned by the renderer: element ID -> position/size. */
export type Layout = Record<string, LayoutEntry>;

export interface FlowNode {
    id: string;
    type: string;               // kind name, e.g. "Entity"
    parentId: string | null;
    visual: {
        position: { x: number; y: number };
        size: { width: number; height: number };
        shape: string;
        shapeType: number;
        color: [number, number, number, number];   // RGBA 0..1, ready for a GPU buffer
        label: string;
        icon?: string;
        container: boolean;
    };
    data: {
        kind: string;           // kind ID, e.g. "software.Entity"
        name: string;
        properties: IRElement['properties'];
    };
}

export interface FlowEdge {
    id: string;
    source: string;
    target: string;
    type: 'reference' | 'containment';
    label: string;              // feature name
}

export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }

export interface FlowOptions {
    layout?: Layout;
    /** 'nest' sets parentId (renderer draws children inside). 'edges' draws lines. */
    containment?: 'nest' | 'edges';
    defaultSize?: { width: number; height: number };
}

export function toFlowGraph(doc: IRDocument, opts: FlowOptions = {}): FlowGraph {
    const index = new IRIndex(doc);
    const layout = opts.layout ?? {};
    const mode = opts.containment ?? 'nest';
    const size = opts.defaultSize ?? { width: 160, height: 80 };
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];

    let i = 0;
    for (const model of doc.models) {
        for (const el of model.elements) {
            const v = index.visual(el.kind);
            const kind = index.kinds.get(el.kind);
            const pos = layout[el.id] ?? autoPlace(i++, size);
            const shape = typeof v.shape === 'string' ? v.shape : 'rectangle';
            nodes.push({
                id: el.id,
                type: kind?.name ?? el.kind,
                parentId: mode === 'nest' ? el.parent : null,
                visual: {
                    position: { x: pos.x, y: pos.y },
                    size: {
                        width: pos.width ?? num(v.width) ?? size.width,
                        height: pos.height ?? num(v.height) ?? size.height
                    },
                    shape,
                    shapeType: SHAPE_TYPE[shape] ?? 0,
                    color: hexToRgba(typeof v.color === 'string' ? v.color : '#64748b'),
                    label: labelFor(el, v.label),
                    ...(typeof v.icon === 'string' ? { icon: v.icon } : {}),
                    container: v.container === true || el.children.length > 0
                },
                data: { kind: el.kind, name: el.name, properties: el.properties }
            });

            for (const [feature, targets] of Object.entries(el.references)) {
                for (const t of targets) {
                    edges.push({ id: `${el.id}--${feature}->${t}`, source: el.id, target: t, type: 'reference', label: feature });
                }
            }
            if (mode === 'edges' && el.parent) {
                edges.push({
                    id: `${el.parent}--${el.containedIn ?? 'contains'}->${el.id}`,
                    source: el.parent, target: el.id, type: 'containment', label: el.containedIn ?? ''
                });
            }
        }
    }
    return { nodes, edges };
}

/** `label` in the profile may use {name} and {kind}. Plain substitution; no evaluation. */
function labelFor(el: IRElement, template: unknown): string {
    if (typeof template !== 'string') return el.name;
    return template.replace(/\{(name|kind)\}/g, (_, k) => (k === 'name' ? el.name : el.kind.split('.').pop() ?? ''));
}

function autoPlace(i: number, size: { width: number; height: number }): LayoutEntry {
    const cols = 6;
    return { x: (i % cols) * (size.width + 40), y: Math.floor(i / cols) * (size.height + 40) };
}

function num(v: unknown): number | undefined {
    return typeof v === 'number' ? v : undefined;
}

export function hexToRgba(hex: string): [number, number, number, number] {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
    if (!m) return [0.4, 0.45, 0.55, 1];
    const n = parseInt(m[1], 16);
    const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}
