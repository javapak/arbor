/**
 * Custom language server requests for diagram editors.
 *
 * The editor (e.g. the VS Code extension's diagram webview) asks the server for
 * a model's IR and for text edits that express diagram changes, so the server's
 * workspace, with every profile in it, is the one place text is parsed.
 * Positions are not handled here; they live in the editor's view file.
 */
import { DocumentState, URI, type LangiumDocument } from 'langium';
import type { LangiumSharedServices } from 'langium/lsp';
import type { Connection } from 'vscode-languageserver';
import { isModel, isProfile, type Document } from '../language/generated/ast.js';
import { toIR } from '../ir/ast-to-ir.js';
import {
    locateElementIn, planAddElementIn, planRemoveElementIn, planSetSlotIn, type Built, type Planned, type SlotValue, type TextEdit
} from '../edits.js';
import { DiagramNotifications, DiagramRequests, type ModelResult } from './protocol.js';

export function registerDiagramRequests(shared: LangiumSharedServices, connection: Connection): void {
    const documents = shared.workspace.LangiumDocuments;
    const builder = shared.workspace.DocumentBuilder;

    /** Every built document, with the one in `uri` once it has caught up with the latest edit. */
    async function workspace(uri: string): Promise<Built[]> {
        // The current build first (it may be relinking other files after a profile change), then this file.
        await builder.waitUntil(DocumentState.Validated);
        await builder.waitUntil(DocumentState.Validated, URI.parse(uri));
        return documents.all
            .filter(d => d.state >= DocumentState.Linked)
            .map(d => d as LangiumDocument<Document>)
            .map(d => ({ uri: d.uri.toString(), text: d.textDocument.getText(), root: d.parseResult.value }))
            .toArray();
    }

    const same = (a: string, b: string) => URI.parse(a).toString() === URI.parse(b).toString();
    /** Element IDs are unique per model, so look in the diagram's own source first. */
    const ownFirst = (built: Built[], uri: string) => [...built.filter(b => same(b.uri, uri)), ...built.filter(b => !same(b.uri, uri))];

    connection.onRequest(DiagramRequests.model, async ({ uri }: { uri: string }): Promise<ModelResult> => {
        const built = await workspace(uri);
        const own = built.find(b => same(b.uri, uri))?.root;
        const roots = built.filter(b => isProfile(b.root) || b.root === own).map(b => b.root);
        return {
            ir: toIR(roots),
            kind: isModel(own) ? 'model' : isProfile(own) ? 'profile' : 'unknown',
        };
    });

    connection.onRequest(DiagramRequests.addElement,
        async ({ uri, kind }: { uri: string; kind: string }): Promise<Planned<{ edit: TextEdit; elementId: string }>> => {
            const built = await workspace(uri);
            const own = built.find(b => same(b.uri, uri));
            return planAddElementIn(built, kind, { uri: own?.uri ?? uri });
        });

    connection.onRequest(DiagramRequests.removeElement,
        async ({ uri, id }: { uri: string; id: string }): Promise<Planned<TextEdit>> => {
            return planRemoveElementIn(ownFirst(await workspace(uri), uri), id);
        });

    connection.onRequest(DiagramRequests.setSlot,
        async ({ uri, id, name, value }: { uri: string; id: string; name: string; value: SlotValue }): Promise<Planned<TextEdit>> =>
            planSetSlotIn(ownFirst(await workspace(uri), uri), id, name, value));

    connection.onRequest(DiagramRequests.locate,
        async ({ uri, id }: { uri: string; id: string }) => locateElementIn(ownFirst(await workspace(uri), uri), id));

    builder.onBuildPhase(DocumentState.Validated, docs => {
        void connection.sendNotification(DiagramNotifications.changed, { uris: docs.map(d => d.uri.toString()) });
    });
}
