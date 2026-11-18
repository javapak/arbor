/**
 * Emitter: IR -> nodes/edges for the WebGPU flow renderer (webgpu-flow).
 *
 * Knows only the IR, never Langium. References become edges, except those a
 * node's label already shows (`label: "{name} : {type}"`). Containment is
 * drawn nested when the owner's kind is a `container` or the element's kind a
 * `member` (the child names its owner as `parentId`, and the renderer arranges
 * it inside: as a row, an icon and a label, unless it holds nested elements
 * itself), and as composition edges otherwise. A `ref` or `contains` feature
 * may style its edges (`{ targetMarker: "triangle" line: "dashed" }`), and a
 * kind with `source` and `target` visuals is drawn as an edge itself, between
 * the elements those references (or its owner) name, like a UML generalization:
 * it falls back to a node until both ends are set. Properties written in the text are listed under the node's
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
import {
    IRIndex, OWNER_END, VISUAL_SHAPES, displayName, valueText,
    type EdgeMarker, type IRDocument, type IRElement, type IRFeature, type IRMultiplicity, type IRScalar, type IRVisual, type VisualShape
} from '@arbor/ir';

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

/** IR edge marker -> renderer marker. Typed over every IR marker, so a new one fails to compile until mapped. */
export const MARKERS: Record<EdgeMarker, MarkerType> = {
    none: 'none', arrow: 'open-arrow', filledArrow: 'filled-arrow', triangle: 'inheritance',
    diamond: 'diamond', filledDiamond: 'filled-diamond', circle: 'circle', dot: 'dot', bar: 'bar',
    cross: 'cross', square: 'square', crowFoot: 'crow-foot'
};
/** Dash and gap lengths for the IR's `line` styles. */
const DASHES: Record<string, number[] | undefined> = { solid: undefined, dashed: [8, 6], dotted: [2, 4] };

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
        /** Text at the right end of a row: the kind's name as a UML stereotype, «Entity» (not for members). */
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
        dashPattern?: number[];
        sourceMarker?: MarkerType;
        targetMarker?: MarkerType;
    };
    data: {
        label: string;          // the feature's name, unless its visuals say otherwise
        /** Text at the ends, e.g. a role name and multiplicity. */
        sourceLabel?: string;
        targetLabel?: string;
        /** 'element': the edge is an element of an edge kind, whose ID it has. */
        relation: 'reference' | 'containment' | 'element';
        /** The reference or containment feature it draws (not for 'element'). */
        feature?: string;
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
    const edge = (id: string, source: string, target: string, relation: FlowEdge['data']['relation'],
        style: FlowEdge['style'], data: Omit<FlowEdge['data'], 'relation'>) =>
        edges.push({ id, sourceNodeId: source, targetNodeId: target, userVertices: edgeLayout[id] ?? [], style, data: { ...data, relation } });

    const asEdges = edgeElements(doc, index);
    const drawn = (id: string) => !asEdges.edges.has(id) && !asEdges.hidden.has(id);
    const nestedIn = containerOf(index);
    const compartments = new Map(doc.models.flatMap(m => m.elements).map(el => [el.id, propertyLines(el, index)]));
    const boxes = placeElements(doc, layout, index, defaultSize, nestedIn, compartments, drawn);
    for (const model of doc.models) {
        for (const el of model.elements) {
            const v = index.elementVisual(el);
            // Applied stereotypes go before the label, as in UML: «Entity» Customer.
            const stereotyped = (label: string) => [index.stereotypeLabel(el), label].filter(Boolean).join(' ');
            const ends = asEdges.edges.get(el.id);
            if (ends) {
                edge(el.id, ends.source, ends.target, 'element', edgeStyle(v, REFERENCE_STYLE), {
                    label: stereotyped(typeof v.label === 'string' ? labelFor(el, v.label, index) : el.name),
                    ...endLabels(v, t => labelFor(el, t, index))
                });
            }
            if (!drawn(el.id)) continue;
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
                    label: boxes.isRow(el) ? labelFor(el, v.label, index) : stereotyped(labelFor(el, v.label, index)),
                    kind: el.kind,
                    name: el.name,
                    parentId: el.parent,
                    properties: el.properties
                },
                visual: {
                    ...kindVisual(v, size, contentSize),
                    container: v.container === true,
                    // A member's kind is clear from where it is (every row in an Entity is a Column).
                    ...(boxes.isRow(el)
                        ? { presentation: 'row' as const, ...(el.stereotypes?.length ? { detail: index.stereotypeLabel(el) }
                            : v.member === true ? {} : { detail: `«${kind?.name ?? el.kind}»` }) }
                        : compartments.get(el.id)?.length ? { compartment: compartments.get(el.id) } : {})
                }
            });

            const shown = labelSlots(v.label);
            const features = new Map(index.elementFeatures(el).map(f => [f.name, f]));
            for (const [feature, targets] of Object.entries(el.references)) {
                if (shown.has(feature)) continue;   // written in the label, e.g. `id : UUID`
                const f = features.get(feature);
                // Derived references repeat what other edges show (an opposite, a union): drawn only if asked for.
                const hidden = edgeVisual(f)?.hidden;
                if (hidden === true || (f?.derived && hidden !== false)) continue;
                for (const t of targets) {
                    if (!drawn(t)) continue;   // an edge element: no node to point at
                    edge(`${el.id}--${feature}->${t}`, el.id, t, 'reference', edgeStyle(edgeVisual(f), REFERENCE_STYLE), featureLabels(feature, f));
                }
            }
            if (mode === 'edges' && el.parent && !owner) {
                const feature = el.containedIn ?? 'contains';
                const parent = index.elements.get(el.parent);
                const contains = parent && index.features(parent.kind).find(c => c.name === feature);
                if (edgeVisual(contains)?.hidden !== true) {
                    edge(`${el.parent}--${feature}->${el.id}`, el.parent, el.id, 'containment',
                        edgeStyle(edgeVisual(contains), CONTAINMENT_STYLE), featureLabels(feature, contains));
                }
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

/**
 * Elements drawn as edges: those of a kind with `source` and `target` visuals,
 * with both ends set to elements drawn as nodes. What they contain isn't drawn.
 */
function edgeElements(doc: IRDocument, index: IRIndex): { edges: Map<string, { source: string; target: string }>; hidden: Set<string> } {
    const elements = doc.models.flatMap(m => m.elements);
    const isEdgeKind = (el: IRElement) => {
        const v = index.visual(el.kind);
        return typeof v.source === 'string' && typeof v.target === 'string';
    };
    const candidates = new Set(elements.filter(isEdgeKind).map(el => el.id));
    const end = (el: IRElement, name: IRScalar | undefined) =>
        name === OWNER_END ? el.parent ?? undefined : el.references[String(name)]?.[0];
    const edges = new Map<string, { source: string; target: string }>();
    for (const el of elements) {
        if (!candidates.has(el.id)) continue;
        const v = index.visual(el.kind);
        const source = end(el, v.source), target = end(el, v.target);
        if (source && target && !candidates.has(source) && !candidates.has(target)) edges.set(el.id, { source, target });
    }
    const hidden = new Set<string>();
    const hide = (id: string) => {
        for (const c of index.elements.get(id)?.children ?? []) { hidden.add(c); hide(c); }
    };
    edges.forEach((_, id) => hide(id));
    for (const [id, { source, target }] of edges) if (hidden.has(source) || hidden.has(target)) edges.delete(id);
    return { edges, hidden };
}

/** An edge's style: the defaults, with the visuals' line, markers and color. */
function edgeStyle(v: IRVisual | undefined, base: FlowEdge['style']): FlowEdge['style'] {
    const style = { ...base };
    if (!v) return style;
    const marker = (m: IRScalar) => (typeof m === 'string' && Object.hasOwn(MARKERS, m) ? MARKERS[m as EdgeMarker] : 'none');
    if (v.sourceMarker !== undefined) style.sourceMarker = marker(v.sourceMarker);
    if (v.targetMarker !== undefined) style.targetMarker = marker(v.targetMarker);
    const dashes = typeof v.line === 'string' ? DASHES[v.line] : undefined;
    if (dashes) style.dashPattern = dashes;
    const color = typeof v.color === 'string' ? rgba(v.color) : undefined;
    if (color) style.color = color;
    return style;
}

/** `sourceLabel` and `targetLabel`, filled in by `fill`, when set and not empty. */
function endLabels(v: IRVisual | undefined, fill: (template: string) => string): Pick<FlowEdge['data'], 'sourceLabel' | 'targetLabel'> {
    const out: Pick<FlowEdge['data'], 'sourceLabel' | 'targetLabel'> = {};
    const source = typeof v?.sourceLabel === 'string' ? fill(v.sourceLabel) : '';
    const target = typeof v?.targetLabel === 'string' ? fill(v.targetLabel) : '';
    if (source) out.sourceLabel = source;
    if (target) out.targetLabel = target;
    return out;
}

/** A feature edge's labels: its visuals' templates over `{name}` and `{multiplicity}`, else the feature's name in the middle. */
function featureLabels(name: string, f: IRFeature | undefined): Omit<FlowEdge['data'], 'relation'> {
    const fill = (template: string) => template
        .replace(/\{name\}/g, name)
        .replace(/\{multiplicity\}/g, f ? multiplicityText(f.multiplicity) : '')
        .trim();
    const v = edgeVisual(f);
    return { label: typeof v?.label === 'string' ? fill(v.label) : name, feature: name, ...endLabels(v, fill) };
}

/** How a reference or containment feature's edges are drawn, if it says. */
function edgeVisual(f: IRFeature | undefined): IRVisual | undefined {
    return f && f.feature !== 'property' ? f.visual : undefined;
}

/** UML style: `1`, `0..1`, `0..*`, `1..*`. */
function multiplicityText(m: IRMultiplicity): string {
    const upper = m.upper === null ? '*' : String(m.upper);
    return m.lower === m.upper ? upper : `${m.lower}..${upper}`;
}

/** A hex color as RGBA 0..1, or undefined if it isn't one. */
function rgba(hex: string): [number, number, number, number] | undefined {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
    if (!m) return undefined;
    const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
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

/**
 * `label` in the profile may use {name}, {kind}, and any slot of the element:
 * a property's value, or the names of a reference's targets. A slot that isn't
 * set is left empty. Plain substitution; no evaluation.
 */
function labelFor(el: IRElement, template: unknown, index: IRIndex): string {
    if (typeof template !== 'string') return displayName(el);
    return template.replace(/\{(\w+)\}/g, (_, k: string) => {
        if (k === 'name') return el.name;
        if (k === 'kind') return el.kind.split('.').pop() ?? '';
        const targets = el.references[k];
        if (targets) return targets.map(t => index.elements.get(t)?.name ?? t).join(', ');
        const value = el.properties[k];
        return value === undefined ? '' : Array.isArray(value) ? value.join(', ') : String(value);
    }).trim();
}

/** The slots a label template shows (besides {name} and {kind}). */
function labelSlots(template: unknown): Set<string> {
    if (typeof template !== 'string') return new Set();
    return new Set([...template.matchAll(/\{(\w+)\}/g)].map(m => m[1]).filter(k => k !== 'name' && k !== 'kind'));
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

/** The owner an element is drawn inside: its owner, when the owner's kind is a container or the element's a member. */
function containerOf(index: IRIndex): (el: IRElement) => string | undefined {
    return el => {
        const owner = el.parent ? index.elements.get(el.parent) : undefined;
        if (!owner) return undefined;
        return index.visual(owner.kind).container === true || index.visual(el.kind).member === true ? owner.id : undefined;
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
    nestedIn: (el: IRElement) => string | undefined, compartments: Map<string, string[]>, drawn: (id: string) => boolean
): Map<string, Box> & { isRow(el: IRElement): boolean } {
    const elements = doc.models.flatMap(m => m.elements).filter(el => drawn(el.id));
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
 * them, as `name = value`, the value as the text writes it (see `valueText`).
 */
function propertyLines(el: IRElement, index: IRIndex): string[] {
    const lines: string[] = [];
    for (const f of index.elementFeatures(el)) {
        if (f.feature !== 'property' || !Object.hasOwn(el.properties, f.name)) continue;
        const line = `${f.name} = ${valueText(index, f.type, el.properties[f.name])}`;
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
