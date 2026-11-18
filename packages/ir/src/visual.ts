/**
 * The visual vocabulary: the render hints a profile's `visual` block may set.
 *
 * Renderer-neutral, like the rest of the IR. The language checks profiles
 * against it, and each renderer adapter translates it (adapter-flow for
 * webgpu-flow). A new renderer feature starts here, then gets mapped by the
 * adapters that can draw it.
 */
import type { IRScalar } from './types.js';

export const VISUAL_SHAPES = [
    'rectangle', 'roundedRectangle', 'circle', 'oval', 'diamond', 'hexagon', 'package',
    'actor', 'initialNode', 'finalNode',
    'none'      // no outline: the node is just its svg/image/icon
] as const;
export type VisualShape = typeof VISUAL_SHAPES[number];

export interface VisualKeySpec {
    type: 'string' | 'number' | 'bool';
    /** Allowed values, for enumerated strings. */
    values?: readonly string[];
    /** Format check for free strings. */
    format?: 'hex-color' | 'svg';
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
    label:      { type: 'string', description: 'label template: {name}, {kind}, or any slot ({type} gives a reference target\'s name)' },
    width:      { type: 'number', description: 'default width' },
    height:     { type: 'number', description: 'default height' },
    container:  { type: 'bool', description: 'the node draws the elements it contains inside itself' },
    member:     { type: 'bool', description: 'drawn inside whatever contains it, as a row (like a UML attribute)' }
} as const satisfies Record<string, VisualKeySpec>;
export type VisualKey = keyof typeof VISUAL_KEYS;

export function isVisualKey(key: string): key is VisualKey {
    return Object.hasOwn(VISUAL_KEYS, key);
}

/** Returns a problem description if `value` does not fit `key`, else undefined. */
export function checkVisualValue(key: VisualKey, value: IRScalar): string | undefined {
    const spec: VisualKeySpec = VISUAL_KEYS[key];
    const actual = typeof value === 'boolean' ? 'bool' : typeof value;
    if (actual !== spec.type) return `expected a ${spec.type === 'bool' ? 'true/false' : spec.type}`;
    if (typeof value !== 'string') return undefined;
    if (spec.values && !spec.values.includes(value)) return `expected one of ${spec.values.join(', ')}`;
    if (spec.format === 'hex-color' && !/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return 'expected a hex color like "#0ea5e9"';
    if (spec.format === 'svg' && !/^\s*<svg[\s>]/.test(value)) return 'expected SVG markup starting with <svg';
    return undefined;
}
