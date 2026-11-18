import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { DiagramNotifications } from '@arbor/language/protocol';
import { DiagramEditorProvider, VIEW_TYPE } from './diagramEditor';
import { registerWorkspaceTrees } from './workspaceTrees';

let client: LanguageClient | undefined;

/**
 * Starts the arbor language server (Langium, in Node) for `.arbor` files,
 * which gives the normal text editor diagnostics, completion, go to
 * definition and so on, and registers the diagram editor and the workspace
 * trees (core profiles, domain profiles, models) on top of it.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const module = context.asAbsolutePath('dist/server.cjs');
    // The project's no-eval rule, enforced at runtime as in the CLI.
    const execArgv = ['--disallow-code-generation-from-strings'];
    const serverOptions: ServerOptions = {
        run: { module, transport: TransportKind.ipc, options: { execArgv } },
        debug: { module, transport: TransportKind.ipc, options: { execArgv: [...execArgv, '--nolazy', '--inspect=6009'] } },
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'arbor' }, { scheme: 'untitled', language: 'arbor' }],
        synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher('**/*.arbor') },
    };
    client = new LanguageClient('arbor', 'Arbor', serverOptions, clientOptions);
    await client.start();

    // One handler per notification method (a second registration would replace the first), shared as an event.
    const documentsChanged = new vscode.EventEmitter<void>();
    context.subscriptions.push(documentsChanged, client.onNotification(DiagramNotifications.changed, () => documentsChanged.fire()));

    const diagrams = DiagramEditorProvider.register(context, client, documentsChanged.event);
    registerWorkspaceTrees(context, client, documentsChanged.event, (model, id) => diagrams.revealElement(model, id));

    context.subscriptions.push(
        vscode.commands.registerCommand('arbor.openDiagram', (uri?: vscode.Uri) => openWith(uri, VIEW_TYPE, vscode.ViewColumn.Active)),
        vscode.commands.registerCommand('arbor.openDiagramToSide', (uri?: vscode.Uri) => openWith(uri, VIEW_TYPE, vscode.ViewColumn.Beside)),
        vscode.commands.registerCommand('arbor.openText', (uri?: vscode.Uri) => openWith(uri, 'default', vscode.ViewColumn.Beside)),
    );
}

export function deactivate(): Promise<void> | undefined {
    return client?.stop();
}

/** Opens `uri`, or the active editor's file (a text or a diagram editor), with the given editor. */
async function openWith(uri: vscode.Uri | undefined, viewType: string, column: vscode.ViewColumn) {
    const target = uri ?? activeUri();
    if (!target) return void vscode.window.showInformationMessage('Open an .arbor file first.');
    await vscode.commands.executeCommand('vscode.openWith', target, viewType, column);
}

function activeUri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
    return vscode.window.activeTextEditor?.document.uri;
}
