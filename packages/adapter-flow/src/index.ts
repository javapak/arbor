/**
 * Emitter: IR -> nodes/edges for the WebGPU flow renderer (webgpu-flow).
 *
 * Knows only the IR, never Langium. References become edges, containment
 * becomes composition edges (the renderer has no nesting), and the profile's
 * `visual` block becomes node visuals: a built-in SDF `shape`, or an `svg` /
 * `image` drawn instead of (no `shape` given) or on top of the shape. Layout comes from a sidecar keyed by
 * element ID, so the text never stores coordinates.
 *
 * The input vocabulary is the IR's (`VISUAL_KEYS`, `VISUAL_SHAPES`); this file
 * is the only place that maps it to webgpu-flow. `FlowNode` and `FlowEdge`
 * mirror `DiagramNode` and `DiagramEdge` in webgpu-flow/src/types/index.ts,
 * and `Shape` / `MarkerType` mirror `SHAPE_TYPES` and `MarkerType` in its
 * renderers. Keep them in step.
 */
import { IRIndex, VISUAL_SHAPES, type IRDocument, type IRElement, type IRScalar, type VisualShape } from '@arbor/ir';

/** Shape names the renderer draws (keys of its `SHAPE_TYPES`). */
export type Shape =
    | 'rectangle' | 'circle' | 'diamond' | 'hexagon' | 'package' | 'roundedRectangle'
    | 'initialNode' | 'finalNode' | 'oval' | 'actor' | 'none';

/** IR visual shape -> renderer shape. Typed over every IR shape, so a new one fails to compile until mapped. */
export const SHAPES: Record<VisualShape, Shape> = {
    rectangle: 'rectangle', roundedRectangle: 'roundedRectangle', circle: 'circle', oval: 'oval',
    diamond: 'diamond', hexagon: 'hexagon', package: 'package',
    actor: 'actor', initialNode: 'initialNode', finalNode: 'finalNode', none: 'none'
};

export type MarkerType =
    | 'none' | 'arrow' | 'open-arrow' | 'filled-arrow' | 'diamond' | 'filled-diamond' | 'circle' | 'cross'
    | 'crow-foot' | 'crow-foot-optional' | 'crow-foot-mandatory' | 'one' | 'one-optional' | 'many-optional'
    | 'constraint' | 'inheritance' | 'realization'
    | 'double-arrow' | 'bar' | 'dot' | 'square';

export interface LayoutEntry { x: number; y: number; width?: number; height?: number }
/** Sidecar file owned by the renderer: element ID -> position/size. */
export type Layout = Record<string, LayoutEntry>;
/** Sidecar for edges: edge ID -> user-placed bend points. */
export type EdgeLayout = Record<string, Array<{ x: number; y: number }>>;

export interface FlowNode {
    id: string;
    type: string;               // kind name, e.g. "Entity"
    data: {
        position: { x: number; y: number };
        size: { width: number; height: number };
        label: string;
        kind: string;           // kind ID, e.g. "persistence.Entity"
        name: string;
        /** Owning element's ID; the renderer ignores it, containment is drawn as edges. */
        parentId: string | null;
        properties: IRElement['properties'];
    };
    visual: {
        shape: Shape;
        color: string;          // hex; the renderer converts it
        size: { width: number; height: number };
        labelColor?: string;
        iconColor?: string;
        icon?: string;          // emoji, drawn by the renderer
        visualContent?: VisualContent;
        container: boolean;
    };
}

/** SVG markup or an image URL, rasterised into the renderer's texture atlas. */
export interface VisualContent {
    type: 'svg' | 'image';
    content: string;
    size: { width: number; height: number };   // raster size in pixels
    colorizable?: boolean;                      // tint an SVG with the node color
}

export interface FlowEdge {
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    userVertices: Array<{ x: number; y: number }>;
    style: {
        color: [number, number, number, number];   // RGBA 0..1
        thickness: number;
        sourceMarker?: MarkerType;
        targetMarker?: MarkerType;
    };
    data: {
        label: string;          // feature name
        relation: 'reference' | 'containment';
    };
}

/** A palette entry: one per instantiable kind. Mirrors `NodeTemplate` in webgpu-flow/src/utils/NodeTemplates.ts. */
export interface FlowTemplate {
    id: string;                 // kind ID, e.g. "persistence.Entity"
    label: string;              // kind name
    group: string;              // profile name
    type: string;               // kind name, like FlowNode.type
    visual: FlowNode['visual'];
    data: { kind: string };
}

/** A complete webgpu-flow diagram file (its `DiagramDocument`, format version 1). */
export interface FlowGraph {
    format: 'webgpu-flow/diagram';
    version: 1;
    nodes: FlowNode[];
    edges: FlowEdge[];
    palette?: FlowTemplate[];
}

export interface FlowOptions {
    layout?: Layout;
    edgeLayout?: EdgeLayout;
    /** 'edges' draws owner -> child composition edges; 'hidden' only records `data.parentId`. */
    containment?: 'edges' | 'hidden';
    defaultSize?: { width: number; height: number };
    /** Raster size for `svg` / `image` visuals. */
    contentSize?: number;
    /** Offer every non-abstract kind of the document's profiles in the editor's palette (default true). */
    palette?: boolean;
}

const REFERENCE_STYLE: FlowEdge['style'] = { color: [0.39, 0.45, 0.55, 1], thickness: 2, targetMarker: 'open-arrow' };
const CONTAINMENT_STYLE: FlowEdge['style'] = { color: [0.58, 0.64, 0.72, 1], thickness: 2, sourceMarker: 'filled-diamond' };

export function toFlowGraph(doc: IRDocument, opts: FlowOptions = {}): FlowGraph {
    const index = new IRIndex(doc);
    const layout = opts.layout ?? {};
    const edgeLayout = opts.edgeLayout ?? {};
    const mode = opts.containment ?? 'edges';
    const defaultSize = opts.defaultSize ?? { width: 160, height: 80 };
    const contentSize = opts.contentSize ?? 64;
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    const edge = (id: string, source: string, target: string, label: string, relation: FlowEdge['data']['relation']) =>
        edges.push({
            id, sourceNodeId: source, targetNodeId: target,
            userVertices: edgeLayout[id] ?? [],
            style: { ...(relation === 'reference' ? REFERENCE_STYLE : CONTAINMENT_STYLE) },
            data: { label, relation }
        });

    let i = 0;
    for (const model of doc.models) {
        for (const el of model.elements) {
            const v = index.visual(el.kind);
            const kind = index.kinds.get(el.kind);
            const pos = layout[el.id] ?? autoPlace(i++, defaultSize);
            const size = {
                width: pos.width ?? num(v.width) ?? defaultSize.width,
                height: pos.height ?? num(v.height) ?? defaultSize.height
            };
            nodes.push({
                id: el.id,
                type: kind?.name ?? el.kind,
                data: {
                    position: { x: pos.x, y: pos.y },
                    size,
                    label: labelFor(el, v.label),
                    kind: el.kind,
                    name: el.name,
                    parentId: el.parent,
                    properties: el.properties
                },
                visual: { ...kindVisual(v, size, contentSize), container: v.container === true || el.children.length > 0 }
            });

            for (const [feature, targets] of Object.entries(el.references)) {
                for (const t of targets) edge(`${el.id}--${feature}->${t}`, el.id, t, feature, 'reference');
            }
            if (mode === 'edges' && el.parent) {
                const feature = el.containedIn ?? 'contains';
                edge(`${el.parent}--${feature}->${el.id}`, el.parent, el.id, feature, 'containment');
            }
        }
    }

    const palette = opts.palette === false ? undefined : doc.profiles.flatMap(p => p.kinds.filter(k => !k.abstract).map((k): FlowTemplate => {
        const v = index.visual(k.id);
        const size = { width: num(v.width) ?? defaultSize.width, height: num(v.height) ?? defaultSize.height };
        return {
            id: k.id, label: k.name, group: p.name, type: k.name,
            visual: { ...kindVisual(v, size, contentSize), container: v.container === true },
            data: { kind: k.id }
        };
    }));
    return { format: 'webgpu-flow/diagram', version: 1, nodes, edges, ...(palette ? { palette } : {}) };
}

/** A kind's resolved visuals as renderer visuals. Shared by nodes and palette entries so they look the same. */
function kindVisual(v: Record<string, IRScalar>, size: { width: number; height: number }, contentSize: number): Omit<FlowNode['visual'], 'container'> {
    const content = visualContentOf(v, contentSize);
    return {
        shape: content && v.shape === undefined ? 'none' : shapeOf(v.shape),
        color: str(v.color) ?? '#64748b',
        size: { ...size },
        ...(str(v.labelColor) ? { labelColor: str(v.labelColor) } : {}),
        ...(str(v.iconColor) ? { iconColor: str(v.iconColor) } : {}),
        ...(str(v.icon) ? { icon: str(v.icon) } : {}),
        ...(content ? { visualContent: content } : {})
    };
}

/** `label` in the profile may use {name} and {kind}. Plain substitution; no evaluation. */
function labelFor(el: IRElement, template: unknown): string {
    if (typeof template !== 'string') return el.name;
    return template.replace(/\{(name|kind)\}/g, (_, k) => (k === 'name' ? el.name : el.kind.split('.').pop() ?? ''));
}

function visualContentOf(v: Record<string, IRScalar>, px: number): VisualContent | undefined {
    const size = { width: px, height: px };
    const svg = str(v.svg);
    if (svg) return { type: 'svg', content: svg, size, ...(v.tint === true ? { colorizable: true } : {}) };
    const image = str(v.image);
    if (image) return { type: 'image', content: image, size };
    return undefined;
}

function shapeOf(v: IRScalar | undefined): Shape {
    return (VISUAL_SHAPES as readonly unknown[]).includes(v) ? SHAPES[v as VisualShape] : 'rectangle';
}

function autoPlace(i: number, size: { width: number; height: number }): LayoutEntry {
    const cols = 6;
    return { x: (i % cols) * (size.width + 40), y: Math.floor(i / cols) * (size.height + 40) };
}

function num(v: unknown): number | undefined {
    return typeof v === 'number' ? v : undefined;
}

function str(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}
