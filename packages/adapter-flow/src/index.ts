/**
 * Emitter: IR -> nodes/edges for the WebGPU flow renderer (webgpu-flow).
 *
 * Knows only the IR, never Langium. References become edges. Containment is
 * drawn nested when the owner's kind is a `container` (the child names it as
 * `parentId`, and the renderer arranges it inside: as a row, an icon and a
 * label, unless it holds nested elements itself), and as composition edges
 * otherwise. Properties written in the text are listed under the node's
 * header, one `name = value` line each, like a UML class's attributes (rows
 * leave them out). The profile's
 * `visual` block becomes node visuals: a built-in SDF `shape`, or an `svg` /
 * `image` drawn instead of (no `shape` given, filling the node) or on top of the shape. Layout comes from a sidecar keyed by
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
    /** The node this one is drawn inside: its owner, when the owner's kind is a container. */
    parentId?: string;
    data: {
        position: { x: number; y: number };
        size: { width: number; height: number };
        label: string;
        kind: string;           // kind ID, e.g. "persistence.Entity"
        name: string;
        /** Owning element's ID, however containment is drawn. */
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
        /** The kind draws the elements it contains inside itself. */
        container: boolean;
        /** 'row': drawn in its container as an icon and a label on one line. */
        presentation?: 'row';
        /** Text at the right end of a row: the kind's name as a UML stereotype, «Entity». */
        detail?: string;
        /** Lines listed under the header: the properties written in the text, `name = value`. */
        compartment?: string[];
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
    /** 'edges' draws owner -> child composition edges (except inside containers); 'hidden' only records `data.parentId`. */
    containment?: 'edges' | 'hidden';
    defaultSize?: { width: number; height: number };
    /** Raster size in pixels for `svg` / `image` visuals (default 256); the renderer mipmaps it for smaller sizes. */
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
    const contentSize = opts.contentSize ?? 256;
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    const edge = (id: string, source: string, target: string, label: string, relation: FlowEdge['data']['relation']) =>
        edges.push({
            id, sourceNodeId: source, targetNodeId: target,
            userVertices: edgeLayout[id] ?? [],
            style: { ...(relation === 'reference' ? REFERENCE_STYLE : CONTAINMENT_STYLE) },
            data: { label, relation }
        });

    const nestedIn = containerOf(index);
    const compartments = new Map(doc.models.flatMap(m => m.elements).map(el => [el.id, propertyLines(el, index)]));
    const boxes = placeElements(doc, layout, index, defaultSize, nestedIn, compartments);
    for (const model of doc.models) {
        for (const el of model.elements) {
            const v = index.visual(el.kind);
            const kind = index.kinds.get(el.kind);
            const { x, y, ...size } = boxes.get(el.id)!;
            const pos = { x, y };
            const owner = nestedIn(el);
            nodes.push({
                id: el.id,
                type: kind?.name ?? el.kind,
                ...(owner ? { parentId: owner } : {}),
                data: {
                    position: { x: pos.x, y: pos.y },
                    size,
                    label: labelFor(el, v.label),
                    kind: el.kind,
                    name: el.name,
                    parentId: el.parent,
                    properties: el.properties
                },
                visual: {
                    ...kindVisual(v, size, contentSize),
                    container: v.container === true,
                    ...(boxes.isRow(el)
                        ? { presentation: 'row' as const, detail: `«${kind?.name ?? el.kind}»` }
                        : compartments.get(el.id)?.length ? { compartment: compartments.get(el.id) } : {})
                }
            });

            for (const [feature, targets] of Object.entries(el.references)) {
                for (const t of targets) edge(`${el.id}--${feature}->${t}`, el.id, t, feature, 'reference');
            }
            if (mode === 'edges' && el.parent && !owner) {
                const feature = el.containedIn ?? 'contains';
                edge(`${el.parent}--${feature}->${el.id}`, el.parent, el.id, feature, 'containment');
            }
        }
    }

    const palette = opts.palette === false ? undefined : doc.profiles.flatMap(p => p.kinds.filter(k => !k.abstract).map((k): FlowTemplate => {
        const v = index.visual(k.id);
        const size = kindSize(v, defaultSize);
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

/**
 * A kind's size before the layout overrides it: the profile's `width` and
 * `height`, else the default. Content drawn without a shape fills the node,
 * so it defaults to a square rather than being stretched.
 */
function kindSize(v: Record<string, IRScalar>, fallback: { width: number; height: number }): { width: number; height: number } {
    const side = Math.min(fallback.width, fallback.height);
    const contentOnly = (str(v.svg) || str(v.image)) && v.shape === undefined;
    return {
        width: num(v.width) ?? (contentOnly ? side : fallback.width),
        height: num(v.height) ?? (contentOnly ? side : fallback.height)
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

// How webgpu-flow arranges a container's children (its utils/Nesting); keep in step.
const NEST_PADDING = 8;
const NEST_HEADER = 28;
const ROW_HEIGHT = 26;
const ROW_WIDTH = 180;
const ROW_GAP = 4;
const ROWS_PER_COLUMN = 8;
const COLUMN_GAP = 12;
const LINE_HEIGHT = 18;
const CHAR_WIDTH = 7.5;
const SECTION_GAP = 6;
const ROW_INSET = 6;
/** Longer property lines are cut, ending in an ellipsis. */
const MAX_LINE = 32;

type Box = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

/** The owner an element is drawn inside: its owner, when the owner's kind is a container. */
function containerOf(index: IRIndex): (el: IRElement) => string | undefined {
    return el => {
        const owner = el.parent ? index.elements.get(el.parent) : undefined;
        return owner && index.visual(owner.kind).container === true ? owner.id : undefined;
    };
}

/**
 * Every element's box (centre and size). Top-level elements the layout
 * positions keep their place; the others go on a grid, in model order,
 * skipping cells taken by positioned ones. A container is as big as the
 * renderer will make it to hold its children, which it arranges itself: they
 * are placed at its centre here, and their layout entries don't count.
 */
function placeElements(
    doc: IRDocument, layout: Layout, index: IRIndex, size: Size,
    nestedIn: (el: IRElement) => string | undefined, compartments: Map<string, string[]>
): Map<string, Box> & { isRow(el: IRElement): boolean } {
    const elements = doc.models.flatMap(m => m.elements);
    const children = new Map<string, IRElement[]>();
    for (const el of elements) {
        const owner = nestedIn(el);
        if (owner) children.set(owner, [...(children.get(owner) ?? []), el]);
    }

    // A nested element that doesn't hold nested elements itself is a row.
    const isRow = (el: IRElement) => !!nestedIn(el) && !children.get(el.id)?.length;
    const sizes = new Map<string, Size>();
    const measure = (el: IRElement): Size => {
        const known = sizes.get(el.id);
        if (known) return known;
        const kids = children.get(el.id) ?? [];
        const lines = compartments.get(el.id) ?? [];
        let result: Size;
        if (!isRow(el) && (kids.length || lines.length || index.visual(el.kind).container === true)) {
            const extent = kids.length ? columnsExtent(kids.map(measure)) : { width: 0, height: 0 };
            const text = lines.length ? lines.length * LINE_HEIGHT + (kids.length ? SECTION_GAP : 0) : 0;
            const textWidth = Math.max(0, ...lines.map(l => l.length * CHAR_WIDTH + 2 * ROW_INSET));
            const entry = layout[el.id], own = nestedIn(el) ? 0 : entry?.width ?? kindSize(index.visual(el.kind), size).width;
            result = {
                width: Math.max(own, Math.max(kids.length ? ROW_WIDTH : 0, extent.width, textWidth) + 2 * NEST_PADDING),
                height: NEST_HEADER + text + extent.height + (text || extent.height ? 2 * NEST_PADDING : 0)
            };
        } else if (nestedIn(el)) {
            result = { width: ROW_WIDTH, height: ROW_HEIGHT };
        } else {
            const entry = layout[el.id], base = kindSize(index.visual(el.kind), size);
            result = { width: entry?.width ?? base.width, height: entry?.height ?? base.height };
        }
        sizes.set(el.id, result);
        return result;
    };
    elements.forEach(measure);

    const boxes = Object.assign(new Map<string, Box>(), { isRow });
    const put = (el: IRElement, at: { x: number; y: number }) => {
        boxes.set(el.id, { x: at.x, y: at.y, ...sizes.get(el.id)! });
        for (const c of children.get(el.id) ?? []) put(c, at);
    };
    const topLevel = elements.filter(el => !nestedIn(el));
    const place = gridPlacer(topLevel, layout, el => sizes.get(el.id)!, size);
    for (const el of topLevel) put(el, layout[el.id] ?? place(el));
    return boxes;
}

/**
 * An element's compartment: each property written in its text (not the
 * profile's defaults; references are edges), in the order the kind declares
 * them, as `name = value`. Strings are quoted, enum literals and other values
 * written as in the text, lists in brackets.
 */
function propertyLines(el: IRElement, index: IRIndex): string[] {
    const lines: string[] = [];
    for (const f of index.features(el.kind)) {
        if (f.feature !== 'property' || !Object.hasOwn(el.properties, f.name)) continue;
        const quoted = f.type === 'string';
        const one = (v: IRScalar) => (quoted && typeof v === 'string' ? JSON.stringify(v) : String(v));
        const value = el.properties[f.name];
        const line = `${f.name} = ${Array.isArray(value) ? `[${value.map(one).join(', ')}]` : one(value)}`;
        lines.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line);
    }
    return lines;
}

/** The extent of items stacked in columns ROWS_PER_COLUMN rows high (or as high as the tallest item). */
function columnsExtent(items: Size[]): Size {
    const limit = Math.max(ROWS_PER_COLUMN * ROW_HEIGHT + (ROWS_PER_COLUMN - 1) * ROW_GAP, ...items.map(i => i.height));
    const cols: Size[] = [];
    let col: Size | undefined;
    for (const item of items) {
        if (col && col.height + ROW_GAP + item.height <= limit) {
            col.height += ROW_GAP + item.height;
            col.width = Math.max(col.width, item.width);
        } else {
            col = { width: Math.max(ROW_WIDTH, item.width), height: item.height };
            cols.push(col);
        }
    }
    return {
        width: cols.reduce((w, c) => w + c.width, 0) + COLUMN_GAP * (cols.length - 1),
        height: Math.max(...cols.map(c => c.height)),
    };
}

/**
 * Places top-level elements the layout doesn't position on a grid, in model
 * order, skipping cells that overlap elements it does position.
 */
function gridPlacer(
    elements: IRElement[], layout: Layout, sizeOf: (el: IRElement) => { width: number; height: number },
    size: { width: number; height: number }
) {
    const cols = 6, gap = 40;
    // Nodes are positioned by their centre (as the renderer does), so keep rectangles centred too.
    const taken = elements.flatMap(el => {
        const entry = layout[el.id];
        return entry ? [{ x: entry.x, y: entry.y, ...sizeOf(el) }] : [];
    });
    const free = (x: number, y: number, w: number, h: number) =>
        !taken.some(r => Math.abs(r.x - x) * 2 < r.width + w && Math.abs(r.y - y) * 2 < r.height + h);
    let cell = 0;
    return (el: IRElement): { x: number; y: number } => {
        const { width, height } = sizeOf(el);
        for (;; cell++) {
            const x = (cell % cols) * (size.width + gap), y = Math.floor(cell / cols) * (size.height + gap);
            if (free(x, y, width, height)) {
                taken.push({ x, y, width, height });
                cell++;
                return { x, y };
            }
        }
    };
}

function num(v: unknown): number | undefined {
    return typeof v === 'number' ? v : undefined;
}

function str(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}
