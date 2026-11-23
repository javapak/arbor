/**
 * The visual vocabulary: the render hints a profile's `visual` block may set.
 *
 * Renderer-neutral, like the rest of the IR. The language checks profiles
 * against it, and each renderer adapter translates it (adapter-flow for
 * webgpu-flow). A new renderer feature starts here, then gets mapped by the
 * adapters that can draw it.
 */
import { checkTemplate } from './template.js';
import type { IRScalar } from './types.js';

export const VISUAL_SHAPES = [
    'rectangle', 'roundedRectangle', 'circle', 'oval', 'diamond', 'hexagon', 'package',
    'actor', 'initialNode', 'finalNode',
    'none'      // no outline: the node is just its svg/image/icon
] as const;
export type VisualShape = typeof VISUAL_SHAPES[number];

/** Markers at an edge's ends; see EDGE_MARKERS. */
const EDGE_MARKER_VALUES = [
    'none', 'arrow', 'filledArrow', 'triangle', 'diamond', 'filledDiamond',
    'circle', 'dot', 'bar', 'cross', 'square', 'crowFoot'
] as const;

export interface VisualKeySpec {
    type: 'string' | 'number' | 'bool';
    /** Allowed values, for enumerated strings. */
    values?: readonly string[];
    /** Format check for free strings. */
    format?: 'hex-color' | 'svg' | 'template';
    description: string;
}

export const VISUAL_KEYS = {
    shape:      { type: 'string', values: VISUAL_SHAPES, description: 'outline drawn for the node' },
    svg:        { type: 'string', format: 'svg', description: 'inline SVG drawn as the node (no shape) or on its shape' },
    image:      { type: 'string', description: 'image URL drawn as the node (no shape) or on its shape' },
    tint:       { type: 'bool', description: 'color the svg with the node color' },
    icon:       { type: 'string', description: 'emoji drawn on the node' },
    color:      { type: 'string', format: 'hex-color', description: 'fill color' },
    labelColor: { type: 'string', format: 'hex-color', description: 'label text color' },
    iconColor:  { type: 'string', format: 'hex-color', description: 'icon color' },
    label:      { type: 'string', format: 'template', description: 'label template: {name}, {kind}, or any slot ({type} gives a reference target\'s name); {? … } is shown only when its slots are set' },
    width:      { type: 'number', description: 'default width' },
    height:     { type: 'number', description: 'default height' },
    container:  { type: 'bool', description: 'the node draws the elements it contains inside itself' },
    layout:     { type: 'string', values: ['rows', 'free'], description: 'how a container places what it contains: in rows (default), or where they\'re dragged, growing to hold them' },
    member:     { type: 'bool', description: 'drawn inside whatever contains it, as a row (like a UML attribute)' },
    diagram:    { type: 'bool', description: 'an element of this kind that contains something has a diagram of its own (like a UML state machine): drawn as one node, opened to show what it contains' },
    hidden:     { type: 'bool', description: 'elements of this kind aren\'t drawn, nor what they contain (an operation\'s parameters: its label can show them)' },
    hideWhenAlone: { type: 'bool', description: 'an element of this kind that is the only one in its owner\'s containment isn\'t drawn: what it contains is drawn in its place (like a UML region)' },
    // A kind with both `source` and `target` is drawn as an edge between them, like a UML generalization.
    source:     { type: 'string', description: 'draw elements of this kind as edges: from this reference\'s target, or "owner" (the containing element)' },
    target:     { type: 'string', description: 'draw elements of this kind as edges: to this reference\'s target, or "owner"' },
    line:       { type: 'string', values: ['solid', 'dashed', 'dotted'], description: 'an edge kind\'s line' },
    sourceMarker: { type: 'string', values: EDGE_MARKER_VALUES, description: 'an edge kind\'s marker at its source' },
    targetMarker: { type: 'string', values: EDGE_MARKER_VALUES, description: 'an edge kind\'s marker at its target' },
    sourceLabel: { type: 'string', format: 'template', description: 'an edge kind\'s text at its source end: a label template' },
    targetLabel: { type: 'string', format: 'template', description: 'an edge kind\'s text at its target end: a label template' }
} as const satisfies Record<string, VisualKeySpec>;
export type VisualKey = keyof typeof VISUAL_KEYS;

/** Markers at an edge's ends. `arrow` is open (a UML navigable end), `triangle` hollow (generalization). */
export const EDGE_MARKERS = EDGE_MARKER_VALUES;
export type EdgeMarker = typeof EDGE_MARKERS[number];

/** `source` / `target` value meaning the element's owner rather than a reference. */
export const OWNER_END = 'owner';

/**
 * How a `ref` or `contains` feature's edges are drawn, in braces after it:
 * `ref general: Classifier [1] { targetMarker: "triangle" }`. Templates may
 * use `{name}` (the feature's name) and `{multiplicity}` (as `0..*`).
 */
export const EDGE_VISUAL_KEYS = {
    line:         VISUAL_KEYS.line,
    sourceMarker: { type: 'string', values: EDGE_MARKERS, description: 'marker at the owning element\'s end' },
    targetMarker: { type: 'string', values: EDGE_MARKERS, description: 'marker at the target\'s end' },
    color:        { type: 'string', format: 'hex-color', description: 'line color' },
    label:        { type: 'string', format: 'template', description: 'text at the middle: a template, "" for none (default {name})' },
    sourceLabel:  { type: 'string', format: 'template', description: 'text at the owning element\'s end: a template' },
    targetLabel:  { type: 'string', format: 'template', description: 'text at the target\'s end: a template, e.g. "{name} {multiplicity}"' },
    hidden:       { type: 'bool', description: 'don\'t draw the feature\'s edges (derived references default to true)' }
} as const satisfies Record<string, VisualKeySpec>;
export type EdgeVisualKey = keyof typeof EDGE_VISUAL_KEYS;

export function isVisualKey(key: string): key is VisualKey {
    return Object.hasOwn(VISUAL_KEYS, key);
}

export function isEdgeVisualKey(key: string): key is EdgeVisualKey {
    return Object.hasOwn(EDGE_VISUAL_KEYS, key);
}

/** Returns a problem description if `value` does not fit the key's spec, else undefined. */
export function checkVisualValue(key: string, value: IRScalar, keys: Record<string, VisualKeySpec> = VISUAL_KEYS): string | undefined {
    const spec: VisualKeySpec | undefined = keys[key];
    if (!spec) return 'unknown key';
    const actual = typeof value === 'boolean' ? 'bool' : typeof value;
    if (actual !== spec.type) return `expected a ${spec.type === 'bool' ? 'true/false' : spec.type}`;
    if (typeof value !== 'string') return undefined;
    if (spec.values && !spec.values.includes(value)) return `expected one of ${spec.values.join(', ')}`;
    if (spec.format === 'hex-color' && !/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return 'expected a hex color like "#0ea5e9"';
    if (spec.format === 'svg' && !/^\s*<svg[\s>]/.test(value)) return 'expected SVG markup starting with <svg';
    if (spec.format === 'template') return checkTemplate(value);
    return undefined;
}
