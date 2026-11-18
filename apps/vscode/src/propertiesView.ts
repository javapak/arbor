import * as vscode from 'vscode';
import type { DiagramEditorProvider } from './diagramEditor';
import type { PropertiesHostMessage, PropertiesMessage } from './protocol';
import { isDark, webviewPage } from './webviewPage';

export const PROPERTIES_VIEW = 'arbor.properties';

/**
 * The properties view: a side bar webview with the form for the element
 * selected in the active diagram. Being a view, not part of the diagram
 * editor, it can be moved, collapsed or closed, and one form serves every
 * open diagram. Its edits go to the active diagram, which plans and applies
 * them as it does its own.
 */
export class PropertiesViewProvider implements vscode.WebviewViewProvider {
    static register(context: vscode.ExtensionContext, diagrams: DiagramEditorProvider): void {
        context.subscriptions.push(vscode.window.registerWebviewViewProvider(PROPERTIES_VIEW, new PropertiesViewProvider(context, diagrams)));
    }

    private constructor(private readonly context: vscode.ExtensionContext, private readonly diagrams: DiagramEditorProvider) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        const webview = view.webview;
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        webview.options = { enableScripts: true, localResourceRoots: [media] };
        webview.html = webviewPage(webview, media, 'properties', 'Arbor Properties');

        const post = (m: PropertiesHostMessage) => void webview.postMessage(m);
        const update = () => {
            const active = this.diagrams.active;
            post({ type: 'properties', ir: active?.ir ?? null, id: active?.selected ?? null });
        };
        // Not retained when hidden: the page is rebuilt when shown again and asks for the state with 'ready'.
        const disposables = [
            this.diagrams.onDidChangeActive(update),
            vscode.window.onDidChangeActiveColorTheme(t => post({ type: 'theme', dark: isDark(t) })),
            webview.onDidReceiveMessage((m: PropertiesMessage) => {
                if (m.type !== 'ready') return this.diagrams.active?.send(m);
                post({ type: 'theme', dark: isDark(vscode.window.activeColorTheme) });
                update();
            }),
        ];
        view.onDidDispose(() => disposables.forEach(d => d.dispose()));
    }
}
