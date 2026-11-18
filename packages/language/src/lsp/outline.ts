/**
 * The workspace outline for tree views: the IR of every profile and model the
 * server knows, plus where each profile, kind, feature, enum, model and element
 * is named in the text, so a view can reveal it.
 */
import { AstUtils, DocumentState, GrammarUtils, type AstNode, type LangiumDocument } from 'langium';
import type { LangiumSharedServices } from 'langium/lsp';
import type { Connection } from 'vscode-languageserver';
import { isElement, isModel, isProfile, type Document } from '../language/generated/ast.js';
import { elementId, enumId, kindId } from '../language/semantics.js';
import { toIR } from '../ir/ast-to-ir.js';
import { WorkspaceRequests, type SourceLocation, type WorkspaceResult } from './protocol.js';

export function registerOutlineRequests(shared: LangiumSharedServices, connection: Connection): void {
    const documents = shared.workspace.LangiumDocuments;
    const builder = shared.workspace.DocumentBuilder;

    connection.onRequest(WorkspaceRequests.outline, async (): Promise<WorkspaceResult> => {
        await builder.waitUntil(DocumentState.Validated);
        const docs = documents.all
            .filter(d => d.state >= DocumentState.Linked)
            .map(d => d as LangiumDocument<Document>)
            .toArray();
        return outline(docs.map(d => ({ uri: d.uri.toString(), root: d.parseResult.value })));
    });
}

/** Builds the outline of parsed documents. Exported for tests. */
export function outline(docs: Array<{ uri: string; root: Document }>): WorkspaceResult {
    const locations: Record<string, SourceLocation> = {};
    const add = (key: string, uri: string, node: AstNode) => {
        const cst = GrammarUtils.findNodeForProperty(node.$cstNode, 'name') ?? node.$cstNode;
        if (cst && !(key in locations)) locations[key] = { uri, range: cst.range };
    };
    for (const { uri, root } of docs) {
        if (isProfile(root)) {
            add(`profile:${root.name}`, uri, root);
            for (const kind of root.kinds) {
                add(`kind:${kindId(kind)}`, uri, kind);
                for (const f of kind.features) add(`feature:${kindId(kind)}.${f.name}`, uri, f);
            }
            for (const st of root.stereotypes) {
                add(`stereotype:${enumId(st)}`, uri, st);
                for (const f of st.features) add(`feature:${enumId(st)}.${f.name}`, uri, f);
            }
            for (const d of root.datatypes) {
                add(`datatype:${enumId(d)}`, uri, d);
                for (const f of d.features) add(`feature:${enumId(d)}.${f.name}`, uri, f);
            }
            for (const e of root.enums) {
                add(`enum:${enumId(e)}`, uri, e);
                for (const l of e.literals) add(`literal:${enumId(e)}.${l.name}`, uri, l);
            }
        } else if (isModel(root)) {
            add(`model:${root.name}`, uri, root);
            for (const el of AstUtils.streamAllContents(root).filter(isElement)) add(`element:${root.name}:${elementId(el)}`, uri, el);
        }
    }
    return { ir: toIR(docs.map(d => d.root)), locations };
}
