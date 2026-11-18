import * as vscode from 'vscode';
import type { ViewFile } from './protocol';

const SAVE_DELAY_MS = 300;

/**
 * The diagram layout of one model, kept in `<name>.arbor.view.json` next to it.
 *
 * The file name is the link: renaming the model with the file explorer leaves
 * the view behind (elements are then placed again), as with any sidecar.
 * Writes are debounced and stable (sorted keys, whole-pixel coordinates), so
 * the file diffs cleanly in version control. Changes made on disk by anything
 * else (a checkout, a hand edit) are read back and reported through `onDidChange`.
 * Untitled models have no folder, so their view stays in memory.
 */
export class ViewStore implements vscode.Disposable {
    readonly uri: vscode.Uri | undefined;
    private data: ViewFile;
    private lastText: string | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    /** The file exists but isn't a view file: leave it alone until it is fixed or deleted. */
    private broken = false;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly changed = new vscode.EventEmitter<ViewFile>();
    /** The file changed on disk, not through this store. */
    readonly onDidChange = this.changed.event;

    static async open(model: vscode.Uri): Promise<ViewStore> {
        const store = new ViewStore(model);
        await store.read();
        return store;
    }

    private constructor(private readonly model: vscode.Uri) {
        const name = model.path.split('/').pop()!;
        this.uri = model.scheme === 'untitled' ? undefined : vscode.Uri.joinPath(model, '..', `${name}.view.json`);
        this.data = empty(name);
        if (this.uri) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.joinPath(this.uri, '..'), `${name}.view.json`));
            watcher.onDidChange(() => void this.reload());
            watcher.onDidCreate(() => void this.reload());
            watcher.onDidDelete(() => { this.broken = false; this.lastText = undefined; });
            this.disposables.push(watcher);
        }
        this.disposables.push(this.changed);
    }

    get view(): ViewFile { return this.data; }

    /** Merges layout changes (`null` removes an entry) and schedules a write. */
    patch(nodes: Record<string, ViewFile['nodes'][string] | null> = {}, edges: Record<string, ViewFile['edges'][string] | null> = {}): void {
        const next = { ...this.data, nodes: { ...this.data.nodes }, edges: { ...this.data.edges } };
        for (const [id, entry] of Object.entries(nodes)) {
            if (entry) next.nodes[id] = round(entry); else delete next.nodes[id];
        }
        for (const [id, points] of Object.entries(edges)) {
            if (points?.length) next.edges[id] = points.map(round); else delete next.edges[id];
        }
        this.data = next;
        this.schedule();
    }

    /** Writes now if a write is pending (e.g. when the editor closes). */
    async flush(): Promise<void> {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = undefined;
        await this.write();
    }

    dispose(): void {
        void this.flush();
        this.disposables.forEach(d => d.dispose());
    }

    private schedule() {
        if (!this.uri || this.broken) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = undefined; void this.write(); }, SAVE_DELAY_MS);
    }

    private async write() {
        if (!this.uri) return;
        const text = serialize(this.data);
        if (text === this.lastText) return;
        this.lastText = text;
        try {
            await vscode.workspace.fs.writeFile(this.uri, new TextEncoder().encode(text));
        } catch (e) {
            void vscode.window.showWarningMessage(`Couldn't save the diagram layout to ${this.uri.fsPath}: ${String(e)}`);
        }
    }

    private async read(): Promise<string | undefined> {
        if (!this.uri) return undefined;
        let text: string;
        try {
            text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri));
        } catch {
            return undefined;   // no view yet: elements are placed on first draw
        }
        const parsed = parse(text, this.model.path.split('/').pop()!);
        if (!parsed) {
            if (!this.broken) {
                void vscode.window.showWarningMessage(
                    `${this.uri.fsPath} isn't a valid arbor view file. Layout changes won't be saved until it is fixed or deleted.`);
            }
            this.broken = true;
            return undefined;
        }
        this.broken = false;
        this.data = parsed;
        this.lastText = text;
        return text;
    }

    private async reload() {
        if (this.timer) return;   // our own change is about to be written; it wins
        const before = this.lastText;
        const text = await this.read();
        if (text !== undefined && text !== before) this.changed.fire(this.data);
    }
}

function empty(model: string): ViewFile {
    return { format: 'arbor/view', version: 1, model, nodes: {}, edges: {} };
}

function parse(text: string, model: string): ViewFile | undefined {
    try {
        const v = JSON.parse(text) as Partial<ViewFile>;
        if (v.format !== 'arbor/view' || v.version !== 1) return undefined;
        return { ...empty(model), ...v, nodes: v.nodes ?? {}, edges: v.edges ?? {} };
    } catch {
        return undefined;
    }
}

function serialize(v: ViewFile): string {
    const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
    return JSON.stringify({ format: v.format, version: v.version, model: v.model, nodes: sorted(v.nodes), edges: sorted(v.edges) }, null, 2) + '\n';
}

function round<T extends { x: number; y: number; width?: number; height?: number }>(p: T): T {
    const out = { ...p, x: Math.round(p.x), y: Math.round(p.y) };
    if (p.width !== undefined) out.width = Math.round(p.width);
    if (p.height !== undefined) out.height = Math.round(p.height);
    return out;
}
