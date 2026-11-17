/**
 * Text edits for changes made outside the text, e.g. in a diagram.
 *
 * Text stays the source of truth: a diagram edit becomes a small edit of the
 * text, which is then parsed again like any other change. Planning works on
 * the syntax tree, so callers never deal with offsets or syntax themselves.
 */
import { AstUtils } from 'langium';
import type { Element, Kind, Model } from './language/generated/ast.js';
import { isElement, isModel, isProfile } from './language/generated/ast.js';
import { elementId, kindId } from './language/semantics.js';
import { buildDocuments, type Source } from './cli/load.js';

/** Replace `length` characters at `offset` in the source named `uri` with `text`. */
export interface TextEdit { uri: string; offset: number; length: number; text: string }

export type Planned<T> = T | { error: string };

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
    sources: Source[], kind: string, opts: { model?: string } = {}
): Promise<Planned<{ edit: TextEdit; elementId: string }>> {
    const docs = await buildDocuments(sources);
    const roots = docs.map(d => d.parseResult.value);
    const kinds = roots.filter(isProfile).flatMap(p => p.kinds);
    const target = kinds.find(k => kindId(k) === kind);
    if (!target) return { error: `unknown kind ${kind}` };
    if (target.abstract) return { error: `${kind} is abstract` };

    const index = roots.findIndex(r => isModel(r) && (!opts.model || r.name === opts.model));
    if (index < 0) return { error: opts.model ? `no model named ${opts.model}` : 'no model to add to' };
    const model = roots[index] as Model;
    const text = sources[index].text;
    const close = (model.$cstNode?.end ?? 0) - 1;
    if (text[close] !== '}') return { error: `model ${model.name} is not closed` };

    const taken = new Set(model.elements.map(e => e.name));
    let n = 1;
    while (taken.has(`${target.name}${n}`)) n++;
    const name = `${target.name}${n}`;

    const line = `${indentOf(model, text)}${kindRef(target, kinds)} ${name} {}\n`;
    const lineStart = text.lastIndexOf('\n', close - 1) + 1;
    const edit: TextEdit = text.slice(lineStart, close).trim() === ''
        ? { uri: sources[index].uri, offset: lineStart, length: 0, text: line }          // `}` on its own line
        : { uri: sources[index].uri, offset: close, length: 0, text: `\n${line}` };
    return { edit, elementId: `${model.name}.${name}` };
}

/** Removes the element with ID `id` (and everything nested in it), with the lines it occupied. */
export async function planRemoveElement(sources: Source[], id: string): Promise<Planned<TextEdit>> {
    const docs = await buildDocuments(sources);
    for (const [i, doc] of docs.entries()) {
        const root = doc.parseResult.value;
        if (!isModel(root)) continue;
        const el = AstUtils.streamAllContents(root).find((n): n is Element => isElement(n) && elementId(n) === id);
        if (!el?.$cstNode) continue;
        const text = sources[i].text;
        let start = el.$cstNode.offset;
        let end = el.$cstNode.end;
        // Take whole lines when the element has them to itself.
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        if (text.slice(lineStart, start).trim() === '') start = lineStart;
        const newline = text.indexOf('\n', end);
        const lineEnd = newline < 0 ? text.length : newline + 1;
        if (text.slice(end, lineEnd).trim() === '') end = lineEnd;
        return { uri: sources[i].uri, offset: start, length: end - start, text: '' };
    }
    return { error: `no element with ID ${id}` };
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
