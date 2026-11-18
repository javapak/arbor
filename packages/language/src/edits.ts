/**
 * Text edits for changes made outside the text, e.g. in a diagram.
 *
 * Text stays the source of truth: a diagram edit becomes a small edit of the
 * text, which is then parsed again like any other change. Planning works on
 * the syntax tree, so callers never deal with offsets or syntax themselves.
 */
import { AstUtils, GrammarUtils, type CstNode } from 'langium';
import type { Document, Element, Kind, Model, PropFeature, RefFeature } from './language/generated/ast.js';
import { isContainsFeature, isElement, isModel, isProfile, isRefFeature } from './language/generated/ast.js';
import { allFeatures, bounds, elementId, isA, kindId } from './language/semantics.js';
import { buildDocuments, type Source } from './cli/load.js';

/** Replace `length` characters at `offset` in the source named `uri` with `text`. */
export interface TextEdit { uri: string; offset: number; length: number; text: string }

export type Planned<T> = T | { error: string };

/** A parsed and linked source: what the planners work on. The language server passes its own documents. */
export interface Built { uri: string; text: string; root: Document }

async function build(sources: Source[]): Promise<Built[]> {
    const docs = await buildDocuments(sources);
    return docs.map((d, i) => ({ uri: sources[i].uri, text: sources[i].text, root: d.parseResult.value }));
}

export function applyEdit(text: string, edit: TextEdit): string {
    return text.slice(0, edit.offset) + edit.text + text.slice(edit.offset + edit.length);
}

/**
 * Adds an empty element of kind `kind` (a kind ID such as "persistence.Entity")
 * at the end of a model: the one named `model`, or else the first one found.
 * The name is the kind name plus the first free number (`Entity1`). Required
 * features are left for the validator to report, as with hand-written text.
 */
export async function planAddElement(
    sources: Source[], kind: string, opts: AddOptions = {}
): Promise<Planned<{ edit: TextEdit; elementId: string }>> {
    return planAddElementIn(await build(sources), kind, opts);
}

export interface AddOptions {
    /** Add to the model with this name. */
    model?: string;
    /** Add to the model in this source. */
    uri?: string;
}

export function planAddElementIn(
    built: Built[], kind: string, opts: AddOptions = {}
): Planned<{ edit: TextEdit; elementId: string }> {
    const roots = built.map(b => b.root);
    const kinds = roots.filter(isProfile).flatMap(p => p.kinds);
    const target = kinds.find(k => kindId(k) === kind);
    if (!target) return { error: `unknown kind ${kind}` };
    if (target.abstract) return { error: `${kind} is abstract` };

    const index = roots.findIndex((r, i) =>
        isModel(r) && (!opts.model || r.name === opts.model) && (!opts.uri || built[i].uri === opts.uri));
    if (index < 0) {
        return { error: opts.model ? `no model named ${opts.model}` : opts.uri ? `no model in ${opts.uri}` : 'no model to add to' };
    }
    const model = roots[index] as Model;
    const { uri, text } = built[index];
    const close = (model.$cstNode?.end ?? 0) - 1;
    if (text[close] !== '}') return { error: `model ${model.name} is not closed` };

    const taken = new Set(model.elements.map(e => e.name));
    let n = 1;
    while (taken.has(`${target.name}${n}`)) n++;
    const name = `${target.name}${n}`;

    const line = `${indentOf(model, text)}${kindRef(target, kinds)} ${name} {}\n`;
    const lineStart = text.lastIndexOf('\n', close - 1) + 1;
    const edit: TextEdit = text.slice(lineStart, close).trim() === ''
        ? { uri, offset: lineStart, length: 0, text: line }          // `}` on its own line
        : { uri, offset: close, length: 0, text: `\n${line}` };
    return { edit, elementId: `${model.name}.${name}` };
}

/** Removes the element with ID `id` (and everything nested in it), with the lines it occupied. */
export async function planRemoveElement(sources: Source[], id: string): Promise<Planned<TextEdit>> {
    return planRemoveElementIn(await build(sources), id);
}

export function planRemoveElementIn(built: Built[], id: string): Planned<TextEdit> {
    for (const { uri, text, root } of built) {
        if (!isModel(root)) continue;
        const el = AstUtils.streamAllContents(root).find((n): n is Element => isElement(n) && elementId(n) === id);
        if (!el?.$cstNode) continue;
        let start = el.$cstNode.offset;
        let end = el.$cstNode.end;
        // Take whole lines when the element has them to itself.
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        if (text.slice(lineStart, start).trim() === '') start = lineStart;
        const newline = text.indexOf('\n', end);
        const lineEnd = newline < 0 ? text.length : newline + 1;
        if (text.slice(end, lineEnd).trim() === '') end = lineEnd;
        return { uri, offset: start, length: end - start, text: '' };
    }
    return { error: `no element with ID ${id}` };
}

/**
 * A slot value as the IR holds it: a scalar or a list for properties (enum
 * literals as strings), element IDs for references. `undefined` or `[]`
 * removes the slot, so the profile default applies again.
 */
export type SlotValue = string | number | boolean | Array<string | number | boolean> | undefined;

/**
 * Sets slot `name` of the element with ID `id`: replaces the value if the slot
 * is written, adds the slot otherwise, and removes it for an empty value. The
 * value is checked against the feature's type, so the edit always parses.
 */
export async function planSetSlot(sources: Source[], id: string, name: string, value: SlotValue): Promise<Planned<TextEdit>> {
    return planSetSlotIn(await build(sources), id, name, value);
}

export function planSetSlotIn(built: Built[], id: string, name: string, value: SlotValue): Planned<TextEdit> {
    const found = findElement(built, id);
    if (!found) return { error: `no element with ID ${id}` };
    const { el, uri, text } = found;
    const kind = el.kind.ref;
    if (!kind) return { error: `${el.name} has an unknown kind` };
    const feature = allFeatures(kind).get(name);
    if (!feature || isContainsFeature(feature)) return { error: `${kind.name} has no property or reference ${name}` };

    const written = valueText(feature, value, el, built);
    if (typeof written === 'object') return written;
    const slot = el.slots.find(s => s.name === name);

    if (written === undefined) {
        if (!slot?.$cstNode) return { error: `${name} is not set` };
        return removeNode(uri, text, slot.$cstNode);
    }
    if (slot?.value.$cstNode) {
        const v = slot.value.$cstNode;
        return { uri, offset: v.offset, length: v.length, text: written };
    }
    return insertSlot(uri, text, el, `${name}: ${written}`);
}

/** Where the element with ID `id` is named in the text, for "show in text". */
export function locateElementIn(built: Built[], id: string): Planned<{ uri: string; offset: number; length: number }> {
    const found = findElement(built, id);
    if (!found) return { error: `no element with ID ${id}` };
    const name = GrammarUtils.findNodeForProperty(found.el.$cstNode, 'name') ?? found.el.$cstNode!;
    return { uri: found.uri, offset: name.offset, length: name.length };
}

function findElement(built: Built[], id: string): { el: Element; uri: string; text: string } | undefined {
    for (const { uri, text, root } of built) {
        if (!isModel(root)) continue;
        const el = AstUtils.streamAllContents(root).find((n): n is Element => isElement(n) && elementId(n) === id);
        if (el?.$cstNode) return { el, uri, text };
    }
    return undefined;
}

/** The value as arbor text, `undefined` for "unset", or why it doesn't fit the feature. */
function valueText(feature: PropFeature | RefFeature, value: SlotValue, from: Element, built: Built[]): string | undefined | { error: string } {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) return undefined;
    const many = bounds(feature.multiplicity, feature.$type).upper !== 1;
    const items = Array.isArray(value) ? value : [value];
    if (!many && items.length > 1) return { error: `${feature.name} takes one value` };

    const parts: string[] = [];
    for (const item of items) {
        const part = isRefFeature(feature) ? refText(feature, item, from, built) : literalText(feature, item);
        if (typeof part !== 'string') return part;
        parts.push(part);
    }
    return many ? `[${parts.join(', ')}]` : parts[0];
}

function literalText(prop: PropFeature, v: string | number | boolean): string | { error: string } {
    const t = prop.type;
    if (t.$type === 'EnumTypeRef') {
        const literals = t.enum.ref?.literals.map(l => l.name) ?? [];
        return typeof v === 'string' && literals.includes(v) ? v : { error: `${String(v)} is not a literal of ${t.enum.$refText}` };
    }
    switch (t.primitive) {
        case 'string': return typeof v === 'string' ? JSON.stringify(v) : { error: `${prop.name} takes a string` };
        case 'bool': return typeof v === 'boolean' ? String(v) : { error: `${prop.name} takes true or false` };
        case 'int': return typeof v === 'number' && Number.isInteger(v) ? String(v) : { error: `${prop.name} takes an integer` };
        case 'float': return typeof v === 'number' && Number.isFinite(v) ? String(v) : { error: `${prop.name} takes a number` };
    }
}

/** `-> Name` for a top-level element of the same model, else its path (`Checkout.OrderApi`), model-qualified across models. */
function refText(ref: RefFeature, target: string | number | boolean, from: Element, built: Built[]): string | { error: string } {
    const found = typeof target === 'string' ? findElement(built, target) : undefined;
    if (!found) return { error: `no element with ID ${String(target)}` };
    const wanted = ref.target.ref;
    const kind = found.el.kind.ref;
    if (wanted && kind && !isA(kind, wanted)) return { error: `${found.el.name} is not a ${wanted.name}` };
    const path: string[] = [];
    let node: Element | Model = found.el;
    while (isElement(node)) { path.unshift(node.name); node = node.$container; }
    const sameModel = AstUtils.getContainerOfType(from, isModel) === node;
    return `-> ${sameModel ? '' : `${node.name}.`}${path.join('.')}`;
}

/** Adds `slot` after the element's last slot, or first in its body, keeping its one-line or block layout. */
function insertSlot(uri: string, text: string, el: Element, slot: string): TextEdit {
    const cst = el.$cstNode!;
    const last = el.slots.at(-1)?.$cstNode;
    if (last) {
        const lineStart = text.lastIndexOf('\n', last.offset - 1) + 1;
        const before = text.slice(lineStart, last.offset);
        return before.trim() === ''
            ? { uri, offset: last.end, length: 0, text: `\n${before}${slot}` }
            : { uri, offset: last.end, length: 0, text: `  ${slot}` };
    }
    const open = GrammarUtils.findNodeForKeyword(cst, '{')!;
    const close = cst.end - 1;
    const body = text.slice(open.end, close);
    if (!body.includes('\n')) {
        // `X {}` or `X { Child {} }`: stay on one line.
        return body.trim() === ''
            ? { uri, offset: open.end, length: close - open.end, text: ` ${slot} ` }
            : { uri, offset: open.end, length: 0, text: ` ${slot} ` };
    }
    const lineStart = text.lastIndexOf('\n', cst.offset - 1) + 1;
    const indent = /^[ \t]*/.exec(text.slice(lineStart, cst.offset))![0];
    return { uri, offset: open.end, length: 0, text: `\n${indent}    ${slot}` };
}

/** Removes a node with its line when it has the line to itself, else with the spaces before it. */
function removeNode(uri: string, text: string, node: CstNode): TextEdit {
    let start = node.offset;
    let end = node.end;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const newline = text.indexOf('\n', end);
    const lineEnd = newline < 0 ? text.length : newline + 1;
    if (text.slice(lineStart, start).trim() === '' && text.slice(end, lineEnd).trim() === '') {
        start = lineStart;
        end = lineEnd;
    } else {
        while (start > lineStart && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
    }
    return { uri, offset: start, length: end - start, text: '' };
}

/** The kind's simple name, or its qualified ID when another loaded profile uses the same name. */
function kindRef(kind: Kind, all: Kind[]): string {
    return all.filter(k => k.name === kind.name).length > 1 ? kindId(kind) : kind.name;
}

/** Indentation of the model's existing elements, or four spaces. */
function indentOf(model: Model, text: string): string {
    const first = model.elements[0]?.$cstNode;
    if (!first) return '    ';
    const lineStart = text.lastIndexOf('\n', first.offset - 1) + 1;
    const indent = text.slice(lineStart, first.offset);
    return /^[ \t]*$/.test(indent) ? indent : '    ';
}
