import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { DiagramRequests, type ModelResult } from '@arbor/language/protocol';
import type { Planned, TextEdit } from '@arbor/language';
import type { IRDocument } from '@arbor/ir';
import type { HostMessage, WebviewMessage } from './protocol';
import { ViewStore } from './viewStore';
import { isDark, webviewPage } from './webviewPage';

export const VIEW_TYPE = 'arbor.diagram';
const REFRESH_DELAY_MS = 100;

/** An open diagram as the properties view sees it: its model and selected element. */
export interface DiagramSession {
    readonly ir: IRDocument | null;
    readonly selected: string | null;
    /** Handles a message from the properties view as if this diagram had sent it. */
    send(m: WebviewMessage): void;
}

/**
 * The diagram editor for `.arbor` files: a custom *text* editor, so VS Code
 * keeps the TextDocument (and its undo stack, dirty state and saving) and
 * the text editor and the diagram can be open on the same file at once.
 *
 * The language server parses; this class only moves messages: model updates
 * to the webview, the user's diagram and form edits to the server as
 * requests for text edits, and layout to the view file.
 */
export class DiagramEditorProvider implements vscode.CustomTextEditorProvider {
    /** `documentsChanged` fires after the server rebuilt documents (`arbor/documentsChanged`). */
    static register(context: vscode.ExtensionContext, client: LanguageClient, documentsChanged: vscode.Event<void>): DiagramEditorProvider {
        const provider = new DiagramEditorProvider(context, client);
        context.subscriptions.push(
            vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
                webviewOptions: { retainContextWhenHidden: true },   // the renderer's GPU state is costly to rebuild
            }),
            documentsChanged(() => provider.open.forEach(e => e.refresh())),
            provider.activeChanged,
        );
        return provider;
    }

    /** Open diagrams by document URI, so a rebuild (of a profile, say) refreshes each of them. */
    private readonly open = new Map<string, { refresh: () => void; select: (id: string) => void }>();
    /** Elements to select in diagrams that are opening, sent once their webview is ready. */
    private readonly queuedSelect = new Map<string, string>();

    /** The diagram last focused, while it is open. */
    active: DiagramSession | undefined;
    private readonly activeChanged = new vscode.EventEmitter<void>();
    /** Fires when another diagram becomes active, or the active one's model or selection changes. */
    readonly onDidChangeActive = this.activeChanged.event;

    private constructor(private readonly context: vscode.ExtensionContext, private readonly client: LanguageClient) {}

    /** Opens the model's diagram (or brings it forward) and selects element `id` in it. */
    async revealElement(model: vscode.Uri, id: string, column = vscode.ViewColumn.Active): Promise<void> {
        const open = this.open.get(model.toString());
        if (open) open.select(id); else this.queuedSelect.set(model.toString(), id);
        await vscode.commands.executeCommand('vscode.openWith', model, VIEW_TYPE, column);
    }

    async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
        const webview = panel.webview;
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        webview.options = { enableScripts: true, localResourceRoots: [media] };
        webview.html = webviewPage(webview, media, 'webview', 'Arbor Diagram');

        const view = await ViewStore.open(document.uri);
        const uri = this.client.code2ProtocolConverter.asUri(document.uri);
        const post = (m: HostMessage) => void webview.postMessage(m);
        let ready = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ctx = { document, uri, view, post, refresh: () => { ready = true; refresh(); } };
        const session = {
            ir: null as IRDocument | null,
            selected: null as string | null,
            send: (m: WebviewMessage) => void this.handle(m, ctx),
        };
        const changed = () => { if (this.active === session) this.activeChanged.fire(); };

        const refresh = () => {
            if (!ready) return;
            clearTimeout(timer);
            timer = setTimeout(async () => {
                try {
                    const result = await this.client.sendRequest<ModelResult>(DiagramRequests.model, { uri });
                    const errors = vscode.languages.getDiagnostics(document.uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
                    post({ type: 'model', ...result, errors });
                    session.ir = result.kind === 'model' ? result.ir : null;
                    changed();
                } catch (e) {
                    post({ type: 'notice', text: `The language server couldn't build ${document.fileName}: ${String(e)}` });
                }
            }, REFRESH_DELAY_MS);
        };
        const entry = { refresh, select: (id: string) => post({ type: 'select', id }) };
        this.open.set(document.uri.toString(), entry);
        const activate = () => {
            if (!panel.active || this.active === session) return;
            this.active = session;
            this.activeChanged.fire();
        };
        activate();

        const disposables: vscode.Disposable[] = [
            view,
            view.onDidChange(v => post({ type: 'view', view: v })),
            vscode.window.onDidChangeActiveColorTheme(t => post({ type: 'theme', dark: isDark(t) })),
            // Diagnostics arrive after the rebuild notification; refresh so the error count catches up.
            vscode.languages.onDidChangeDiagnostics(e => { if (e.uris.some(u => u.toString() === document.uri.toString())) refresh(); }),
            panel.onDidChangeViewState(activate),
            webview.onDidReceiveMessage((m: WebviewMessage) => {
                if (m.type !== 'selection') return void this.handle(m, ctx);
                session.selected = m.id;
                changed();
            }),
        ];
        panel.onDidDispose(() => {
            clearTimeout(timer);
            if (this.open.get(document.uri.toString()) === entry) this.open.delete(document.uri.toString());
            if (this.active === session) {
                this.active = undefined;
                this.activeChanged.fire();
            }
            disposables.forEach(d => d.dispose());
        });
    }

    private async handle(m: WebviewMessage, ctx: {
        document: vscode.TextDocument; uri: string; view: ViewStore; post: (m: HostMessage) => void; refresh: () => void;
    }): Promise<void> {
        const { document, uri, view, post } = ctx;
        switch (m.type) {
            case 'ready':
                post({ type: 'theme', dark: isDark(vscode.window.activeColorTheme) });
                post({ type: 'view', view: view.view, select: this.queuedSelect.get(document.uri.toString()) });
                this.queuedSelect.delete(document.uri.toString());
                ctx.refresh();
                break;
            case 'layout':
                view.patch(m.nodes, m.edges);
                break;
            case 'add-element': {
                const plan = await this.plan<{ edit: TextEdit; elementId: string }>(DiagramRequests.addElement, { uri, kind: m.kind }, post);
                if (!plan) return;
                // Place it where it was dropped, before the redraw that brings it in.
                view.patch({ [plan.elementId]: m.position });
                post({ type: 'view', view: view.view, select: plan.elementId });
                await this.apply(plan.edit, post);
                break;
            }
            case 'remove-element': {
                const edit = await this.plan<TextEdit>(DiagramRequests.removeElement, { uri, id: m.id }, post);
                // The layout entry stays, so undoing the removal puts the element back where it was.
                if (edit) await this.apply(edit, post);
                break;
            }
            case 'set-slot': {
                const edit = await this.plan<TextEdit>(DiagramRequests.setSlot, { uri, id: m.id, name: m.name, value: m.value }, post);
                if (edit) await this.apply(edit, post);
                break;
            }
            case 'reveal': {
                const at = await this.plan<{ uri: string; offset: number; length: number }>(DiagramRequests.locate, { uri, id: m.id }, post);
                if (!at) return;
                const target = await vscode.workspace.openTextDocument(this.client.protocol2CodeConverter.asUri(at.uri));
                const range = new vscode.Range(target.positionAt(at.offset), target.positionAt(at.offset + at.length));
                const beside = target.uri.toString() === document.uri.toString();
                await vscode.window.showTextDocument(target, { selection: range, viewColumn: beside ? vscode.ViewColumn.Beside : undefined });
                break;
            }
        }
    }

    /** Sends a planning request; on `{ error }` tells the webview, which redraws from the text. */
    private async plan<T>(method: string, params: object, post: (m: HostMessage) => void): Promise<T | undefined> {
        try {
            const result = await this.client.sendRequest<Planned<T>>(method, params);
            if (result && typeof result === 'object' && 'error' in result) {
                post({ type: 'notice', text: `Couldn't change the text: ${result.error}.`, resync: true });
                return undefined;
            }
            post({ type: 'notice', text: null });
            return result as T;
        } catch (e) {
            post({ type: 'notice', text: `The language server failed: ${String(e)}`, resync: true });
            return undefined;
        }
    }

    /** Applies a planned edit to the document it names (usually this one), as one undoable step. */
    private async apply(edit: TextEdit, post: (m: HostMessage) => void): Promise<void> {
        const target = await vscode.workspace.openTextDocument(this.client.protocol2CodeConverter.asUri(edit.uri));
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(target.uri, new vscode.Range(target.positionAt(edit.offset), target.positionAt(edit.offset + edit.length)), edit.text);
        if (!await vscode.workspace.applyEdit(workspaceEdit)) {
            post({ type: 'notice', text: `Couldn't edit ${target.fileName}; it may be read-only.`, resync: true });
        }
    }
}
