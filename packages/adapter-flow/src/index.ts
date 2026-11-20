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
    IRIndex, OWNER_END, VISUAL_SHAPES, displayName, fillTemplate, templateSlots, valueText,
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
        /** The element has a diagram of its own, opened by passing its ID as `root` (double-click). */
        opens?: true;
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
        /** 'free': a container whose contents keep their own places (stored in the layout), not rows. */
        layout?: 'free';
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
    /** The editor's snap grid: elements placed automatically get their top-left corner on it. */
    grid?: number;
    /**
     * Draw this element's own diagram (its kind sets `diagram: true`): what it contains, at the
     * top level, without the element itself (hosts show its name as the diagram's title, see
     * `diagramTitle`). Without it, the model's diagram, where such elements are one node each.
     * See `diagramOf` and `diagramPath`.
     */
    root?: string;
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
    const view = diagramView(index, opts.root);
    const alone = hiddenWhenAlone(index);
    const drawn = (id: string) => view.has(id) && !alone.has(id) && !asEdges.edges.has(id) && !asEdges.hidden.has(id);
    // The owner an element is drawn in: past any hidden when alone, whose contents take their place.
    const ownerOf = (el: IRElement): string | null => {
        let p = el.parent;
        while (p && alone.has(p)) p = index.elements.get(p)?.parent ?? null;
        return p;
    };
    // In an element's own diagram, what it holds directly is at the top level.
    const nestedIn = (el: IRElement) => (opts.root && ownerOf(el) === opts.root ? undefined : containerOf(index, ownerOf)(el));
    const compartments = new Map(doc.models.flatMap(m => m.elements).map(el => [el.id, propertyLines(el, index)]));
    const boxes = placeElements(doc, layout, index, defaultSize, nestedIn, compartments, drawn, view.collapsed, opts.grid);
    for (const model of doc.models) {
        for (const el of model.elements) {
            const v = index.elementVisual(el);
            // Applied stereotypes go before the label, as in UML: «Entity» Customer.
            const stereotyped = (label: string) => [index.stereotypeLabel(el), label].filter(Boolean).join(' ');
            const ends = asEdges.edges.get(el.id);
            if (ends && view.has(el.id) && drawn(ends.source) && drawn(ends.target)) {
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
                    properties: el.properties,
                    ...(view.collapsed(el) ? { opens: true as const } : {})
                },
                visual: {
                    ...kindVisual(v, size, contentSize),
                    container: v.container === true && !view.collapsed(el),
                    ...(isFreeVisual(v) && !view.collapsed(el) ? { layout: 'free' as const } : {}),
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
            if (mode === 'edges' && el.parent && !owner && drawn(el.parent)) {
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
            visual: { ...kindVisual(v, size, contentSize), container: v.container === true, ...(isFreeVisual(v) ? { layout: 'free' as const } : {}) },
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
    const fill = (template: string) => fillTemplate(template, k =>
        k === 'name' ? name : k === 'multiplicity' && f ? multiplicityText(f.multiplicity) : undefined).trim();
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
 * set is left empty, and so is an optional part `{? … }` that shows one.
 * Plain substitution (see @arbor/ir's fillTemplate); no evaluation.
 */
function labelFor(el: IRElement, template: unknown, index: IRIndex): string {
    if (typeof template !== 'string') return displayName(el);
    return fillTemplate(template, k => {
        if (k === 'name') return el.name;
        if (k === 'kind') return el.kind.split('.').pop() ?? '';
        const targets = el.references[k];
        if (targets) return targets.map(t => index.elements.get(t)?.name ?? t).join(', ');
        const value = el.properties[k];
        return value === undefined ? undefined : Array.isArray(value) ? value.join(', ') : String(value);
    }).trim();
}

/** The slots a label template shows (besides {name} and {kind}), optional parts included. */
function labelSlots(template: unknown): Set<string> {
    if (typeof template !== 'string') return new Set();
    return new Set(templateSlots(template).filter(k => k !== 'name' && k !== 'kind'));
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

// ------------------------------------------------------------ diagrams of their own

/** Whether the element has a diagram of its own: its kind says so (`diagram: true`), and it contains something. */
function opensDiagram(index: IRIndex, el: IRElement): boolean {
    return index.visual(el.kind).diagram === true && el.children.length > 0;
}

/**
 * The diagram an element is drawn in: the nearest element around it with a
 * diagram of its own, or null for the model's. An element with a diagram of
 * its own is drawn, as one node, in the one around it.
 */
export function diagramOf(doc: IRDocument, id: string): string | null {
    return diagramAround(new IRIndex(doc), id);
}

function diagramAround(index: IRIndex, id: string): string | null {
    for (let p = index.elements.get(id)?.parent; p; p = index.elements.get(p)?.parent ?? null) {
        const owner = index.elements.get(p);
        if (owner && opensDiagram(index, owner)) return owner.id;
    }
    return null;
}

/**
 * The diagrams from the model's to `root`'s, outermost first, for a breadcrumb:
 * `[]` for the model's, then each element whose diagram holds the next.
 */
export function diagramPath(doc: IRDocument, root: string | null | undefined): IRElement[] {
    const index = new IRIndex(doc);
    const out: IRElement[] = [];
    for (let id = root ?? null; id; id = diagramAround(index, id)) {
        const el = index.elements.get(id);
        if (!el) return [];
        out.unshift(el);
    }
    return out;
}

/** What one diagram draws: what's in `root`'s diagram (not `root` itself), or the model's. */
function diagramView(index: IRIndex, root: string | undefined): { has(id: string): boolean; collapsed(el: IRElement): boolean } {
    const ids = new Set<string>();
    for (const el of index.elements.values()) {
        if (diagramAround(index, el.id) === (root ?? null)) ids.add(el.id);
    }
    return {
        has: id => ids.has(id),
        collapsed: el => opensDiagram(index, el),
    };
}

/**
 * The elements not drawn because their kind sets `hideWhenAlone` and they're the
 * only one in their owner's containment (a state machine's one region): what they
 * contain is drawn in their place.
 */
function hiddenWhenAlone(index: IRIndex): Set<string> {
    const out = new Set<string>();
    for (const el of index.elements.values()) {
        if (index.visual(el.kind).hideWhenAlone !== true || !el.parent) continue;
        const owner = index.elements.get(el.parent);
        const siblings = (owner?.children ?? []).filter(c => index.elements.get(c)?.containedIn === el.containedIn);
        if (siblings.length === 1) out.add(el.id);
    }
    return out;
}

/**
 * The title of an element's own diagram: the element as its node in the
 * diagram around it is labelled, with its stereotypes (`«stateMachine» Lifecycle`).
 */
export function diagramTitle(doc: IRDocument, root: string): string {
    const index = new IRIndex(doc);
    const el = index.elements.get(root);
    if (!el) return '';
    const v = index.elementVisual(el);
    return [index.stereotypeLabel(el), labelFor(el, v.label, index)].filter(Boolean).join(' ');
}

/**
 * The nodes whose positions belong in the layout: top-level ones, and those in
 * a free container, which leaves them where they are. Other containers place
 * what's inside them. Takes the renderer's nodes, or this adapter's.
 */
export function placedNodes<N extends { id: string; parentId?: string; visual?: object }>(nodes: readonly N[]): N[] {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const free = (n: N | undefined) => (n?.visual as { layout?: unknown } | undefined)?.layout === 'free';
    return nodes.filter(n => !n.parentId || free(byId.get(n.parentId)));
}

/** A container whose contents keep their own places, like nodes on the canvas (see webgpu-flow's utils/Nesting). */
function isFreeVisual(v: Record<string, IRScalar>): boolean {
    return v.container === true && v.layout === 'free';
}

/** Space between the contents a free container places itself, when they have no places yet. */
const FREE_GAP = 40;

/**
 * Where a free container puts contents that have no places of their own: a
 * grid, about as wide as tall, as centres from the top-left of its content area.
 */
function freeGrid(sizes: Size[]): { offsets: Array<{ x: number; y: number }>; extent: Size } {
    const cols = Math.max(1, Math.ceil(Math.sqrt(sizes.length)));
    const offsets: Array<{ x: number; y: number }> = [];
    let top = 0, width = 0;
    for (let row = 0; row * cols < sizes.length; row++) {
        const items = sizes.slice(row * cols, (row + 1) * cols);
        const height = Math.max(...items.map(s => s.height));
        let left = 0;
        for (const s of items) {
            offsets.push({ x: left + s.width / 2, y: top + height / 2 });
            left += s.width + FREE_GAP;
        }
        width = Math.max(width, left - FREE_GAP);
        top += height + FREE_GAP;
    }
    return { offsets, extent: { width, height: Math.max(0, top - FREE_GAP) } };
}

/** The owner an element is drawn inside: its owner, when the owner's kind is a container or the element's a member. */
function containerOf(index: IRIndex, ownerOf: (el: IRElement) => string | null = el => el.parent): (el: IRElement) => string | undefined {
    return el => {
        const id = ownerOf(el);
        const owner = id ? index.elements.get(id) : undefined;
        if (!owner) return undefined;
        return index.visual(owner.kind).container === true || index.visual(el.kind).member === true ? owner.id : undefined;
    };
}

/**
 * Every element's box (centre and size). Top-level elements the layout
 * positions keep their place; the others go on a grid, in model order,
 * skipping cells taken by positioned ones. A container is as big as the
 * renderer will make it to hold its children, which it arranges itself: they
 * are placed at its centre here, and their layout entries don't count. A free
 * container's children are where the layout puts them, or on a grid inside it.
 */
function placeElements(
    doc: IRDocument, layout: Layout, index: IRIndex, size: Size,
    nestedIn: (el: IRElement) => string | undefined, compartments: Map<string, string[]>, drawn: (id: string) => boolean,
    collapsed: (el: IRElement) => boolean, grid?: number
): Map<string, Box> & { isRow(el: IRElement): boolean } {
    const elements = doc.models.flatMap(m => m.elements).filter(el => drawn(el.id));
    const children = new Map<string, IRElement[]>();
    for (const el of elements) {
        const owner = nestedIn(el);
        if (owner) children.set(owner, [...(children.get(owner) ?? []), el]);
    }

    // A diagram drawn as one node holds nothing here.
    const free = (el: IRElement) => isFreeVisual(index.visual(el.kind)) && !collapsed(el);
    const ownerOf = (el: IRElement) => {
        const owner = nestedIn(el);
        return owner ? index.elements.get(owner) : undefined;
    };
    // A nested element that doesn't hold nested elements itself is a row, unless it's in a free container.
    const isRow = (el: IRElement) => !!nestedIn(el) && !children.get(el.id)?.length && !free(ownerOf(el)!);
    const sizes = new Map<string, Size>();
    /** A free container's contents without places: their centres from the top-left of its box. */
    const unplaced = new Map<string, Map<string, { x: number; y: number }>>();
    const measure = (el: IRElement): Size => {
        const known = sizes.get(el.id);
        if (known) return known;
        const kids = children.get(el.id) ?? [];
        const lines = compartments.get(el.id) ?? [];
        let result: Size;
        if (free(el)) {
            // Its own size, and room for whatever it has to place itself (the renderer grows it to hold the rest).
            const entry = layout[el.id], base = kindSize(index.elementVisual(el), size);
            const above = NEST_HEADER + (lines.length ? NEST_PADDING + lines.length * LINE_HEIGHT + SECTION_GAP : 0);
            const textWidth = Math.max(0, ...lines.map(l => l.length * CHAR_WIDTH + 2 * ROW_INSET));
            const homeless = kids.filter(k => !layout[k.id]);
            const grid = freeGrid(homeless.map(measure));
            unplaced.set(el.id, new Map(homeless.map((k, i) => [k.id, {
                x: NEST_PADDING + grid.offsets[i].x, y: above + NEST_PADDING + grid.offsets[i].y
            }])));
            result = {
                width: Math.max(entry?.width ?? base.width, Math.max(textWidth, grid.extent.width) + 2 * NEST_PADDING),
                height: Math.max(entry?.height ?? base.height, above + (homeless.length ? grid.extent.height + 2 * NEST_PADDING : lines.length ? NEST_PADDING : 0))
            };
        } else if (!isRow(el) && (kids.length || lines.length || (index.visual(el.kind).container === true && !collapsed(el)))) {
            const extent = kids.length ? columnsExtent(kids.map(measure)) : { width: 0, height: 0 };
            const text = lines.length ? lines.length * LINE_HEIGHT + (kids.length ? SECTION_GAP : 0) : 0;
            const textWidth = Math.max(0, ...lines.map(l => l.length * CHAR_WIDTH + 2 * ROW_INSET));
            const entry = layout[el.id], own = nestedIn(el) ? 0 : entry?.width ?? kindSize(index.elementVisual(el), size).width;
            result = {
                width: Math.max(own, Math.max(kids.length ? ROW_WIDTH : 0, extent.width, textWidth) + 2 * NEST_PADDING),
                height: NEST_HEADER + text + extent.height + (text || extent.height ? 2 * NEST_PADDING : 0)
            };
        } else if (isRow(el)) {
            result = { width: ROW_WIDTH, height: ROW_HEIGHT };
        } else {
            const entry = layout[el.id], base = kindSize(index.elementVisual(el), size);
            result = { width: entry?.width ?? base.width, height: entry?.height ?? base.height };
        }
        sizes.set(el.id, result);
        return result;
    };
    elements.forEach(measure);

    const boxes = Object.assign(new Map<string, Box>(), { isRow });
    const put = (el: IRElement, at: { x: number; y: number }) => {
        const own = sizes.get(el.id)!;
        boxes.set(el.id, { x: at.x, y: at.y, ...own });
        const home = unplaced.get(el.id);
        for (const c of children.get(el.id) ?? []) {
            // In a free container, where it was left (an absolute position, like a top-level node's), or on its grid.
            const offset = home?.get(c.id), entry = layout[c.id];
            put(c, !home ? at : entry ? { x: entry.x, y: entry.y } : { x: at.x - own.width / 2 + offset!.x, y: at.y - own.height / 2 + offset!.y });
        }
    };
    const topLevel = elements.filter(el => !nestedIn(el));
    const place = gridPlacer(topLevel, layout, el => sizes.get(el.id)!, size, grid);
    for (const el of topLevel) put(el, layout[el.id] ?? place(el));
    return boxes;
}

/**
 * An element's compartment: each property written in its text (not the
 * profile's defaults; references are edges), in the order the kind declares
 * them, as `name = value`, the value as the text writes it (see `valueText`),
 * except those a `visual when` tests, which its looks already show.
 */
function propertyLines(el: IRElement, index: IRIndex): string[] {
    const lines: string[] = [];
    // A property a `visual when` tests is shown by how the element looks (a choice's diamond).
    const styling = new Set(index.lineage(el.kind).flatMap(k => (k.visualWhen ?? []).map(c => c.feature)));
    for (const f of index.elementFeatures(el)) {
        if (f.feature !== 'property' || !Object.hasOwn(el.properties, f.name) || styling.has(f.name)) continue;
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
 * order, skipping cells that overlap elements it does position. With a snap
 * grid, each one's top-left corner is on it, as a drag would leave it.
 */
function gridPlacer(
    elements: IRElement[], layout: Layout, sizeOf: (el: IRElement) => { width: number; height: number },
    size: { width: number; height: number }, grid?: number
) {
    const snap = (centre: number, extent: number) => (grid ? Math.round((centre - extent / 2) / grid) * grid + extent / 2 : centre);
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
            const x = snap((cell % cols) * (size.width + gap), width), y = snap(Math.floor(cell / cols) * (size.height + gap), height);
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
