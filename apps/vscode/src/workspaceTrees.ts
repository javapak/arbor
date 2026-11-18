import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { WorkspaceRequests, type SourceLocation, type WorkspaceResult } from '@arbor/language/protocol';
import { IRIndex, type IREnum, type IRElement, type IRFeature, type IRKind, type IRModel, type IRProfile, type IRValue } from '@arbor/ir';

const REFRESH_DELAY_MS = 150;

/**
 * The server's view of the workspace (every profile and model, from
 * `arbor/workspace`), refetched after each rebuild and shared by the trees.
 */
export class WorkspaceOutline implements vscode.Disposable {
    private result: WorkspaceResult | undefined;
    private index: IRIndex | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private readonly subscription: vscode.Disposable;

    constructor(private readonly client: LanguageClient, documentsChanged: vscode.Event<void>) {
        this.subscription = documentsChanged(() => this.refresh());
        this.refresh();
    }

    get ir() { return this.result?.ir; }
    get irIndex() { return this.index; }

    /** Where `key` (see `WorkspaceResult.locations`) is written, as a VS Code location. */
    location(key: string): vscode.Location | undefined {
        const at = this.result?.locations[key];
        return at ? toLocation(this.client, at) : undefined;
    }

    refresh(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(async () => {
            try {
                this.result = await this.client.sendRequest<WorkspaceResult>(WorkspaceRequests.outline, {});
                this.index = new IRIndex(this.result.ir);
                this.changed.fire();
            } catch {
                // The server is restarting or the build was cancelled; the next rebuild refreshes again.
            }
        }, REFRESH_DELAY_MS);
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.subscription.dispose();
        this.changed.dispose();
    }
}

function toLocation(client: LanguageClient, at: SourceLocation): vscode.Location {
    const { start, end } = at.range;
    return new vscode.Location(client.protocol2CodeConverter.asUri(at.uri),
        new vscode.Range(start.line, start.character, end.line, end.character));
}

// ---------------------------------------------------------------- nodes

export type Node =
    | { type: 'profile'; profile: IRProfile; layeredOn: string[] }
    | { type: 'kind'; kind: IRKind }
    | { type: 'feature'; kind: IRKind; feature: IRFeature }
    | { type: 'enum'; e: IREnum }
    | { type: 'literal'; e: IREnum; literal: string }
    | { type: 'model'; model: IRModel }
    | { type: 'element'; model: IRModel; element: IRElement }
    | { type: 'slot'; model: IRModel; element: IRElement; name: string; value: IRValue | string[]; ref: boolean };

/** The location key of a node; slots reveal their element. */
function key(n: Node): string {
    switch (n.type) {
        case 'profile': return `profile:${n.profile.name}`;
        case 'kind': return `kind:${n.kind.id}`;
        case 'feature': return `feature:${n.kind.id}.${n.feature.name}`;
        case 'enum': return `enum:${n.e.id}`;
        case 'literal': return `literal:${n.e.id}.${n.literal}`;
        case 'model': return `model:${n.model.name}`;
        case 'element':
        case 'slot': return `element:${n.model.name}:${n.element.id}`;
    }
}

/** Kind or enum ID as written from inside `profile`: the short name there, qualified elsewhere. */
const short = (id: string, profile?: string) => (profile && id.startsWith(`${profile}.`) ? id.slice(profile.length + 1) : id);
const owner = (id: string) => id.slice(0, id.indexOf('.'));

/** A value as the text writes it: strings quoted, enum literals bare. */
const literal = (v: string | number | boolean, isEnum: boolean) => (isEnum ? String(v) : JSON.stringify(v));

function multiplicity(f: IRFeature): string {
    const { lower, upper } = f.multiplicity;
    if (upper === null) return lower === 0 ? '[*]' : `[${lower}..*]`;
    return lower === upper ? `[${lower}]` : `[${lower}..${upper}]`;
}

// ---------------------------------------------------------------- trees

abstract class OutlineTree implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(protected readonly outline: WorkspaceOutline) {
        outline.onDidChange(() => this.changed.fire());
    }

    abstract getChildren(node?: Node): Node[];

    getTreeItem(n: Node): vscode.TreeItem {
        const item = this.item(n);
        item.contextValue = `arbor.${n.type}`;
        const at = this.outline.location(key(n));
        if (at) {
            item.command = { command: 'arbor.reveal', title: 'Show in Text', arguments: [at] };
            const file = vscode.workspace.asRelativePath(at.uri);
            item.tooltip ??= new vscode.MarkdownString(`${item.label as string}\n\n*${file}:${at.range.start.line + 1}*`);
        }
        return item;
    }

    protected item(n: Node): vscode.TreeItem {
        const collapsible = this.getChildren(n).length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
        const item = (label: string, icon: string, description?: string) => {
            const t = new vscode.TreeItem(label, collapsible);
            t.iconPath = new vscode.ThemeIcon(icon);
            t.description = description;
            return t;
        };
        switch (n.type) {
            case 'profile': {
                const version = n.profile.version ? `v${n.profile.version}` : undefined;
                const on = n.layeredOn.length ? `on ${n.layeredOn.join(', ')}` : undefined;
                return item(n.profile.name, 'package', [version, on].filter(Boolean).join(' · ') || undefined);
            }
            case 'kind': {
                const p = owner(n.kind.id);
                const ext = n.kind.extends.length ? `extends ${n.kind.extends.map(id => short(id, p)).join(', ')}` : undefined;
                return item(n.kind.name, n.kind.abstract ? 'symbol-interface' : 'symbol-class',
                    [n.kind.abstract ? 'abstract' : undefined, ext].filter(Boolean).join(' · ') || undefined);
            }
            case 'feature': {
                const f = n.feature;
                const p = owner(n.kind.id);
                if (f.feature === 'property') {
                    const type = typeof f.type === 'object' ? short(f.type.enum, p) : f.type;
                    const dflt = f.default !== undefined ? ` = ${literal(f.default, typeof f.type === 'object')}` : '';
                    return item(f.name, 'symbol-property', `${type} ${multiplicity(f)}${dflt}`);
                }
                return f.feature === 'contains'
                    ? item(f.name, 'symbol-structure', `contains ${short(f.target, p)} ${multiplicity(f)}`)
                    : item(f.name, 'references', `-> ${short(f.target, p)} ${multiplicity(f)}`);
            }
            case 'enum':
                return item(n.e.name, 'symbol-enum', `${n.e.literals.length} literals`);
            case 'literal':
                return item(n.literal, 'symbol-enum-member');
            case 'model': {
                const used = [...new Set(n.model.elements.map(e => owner(e.kind)))].sort();
                const count = `${n.model.elements.length} element${n.model.elements.length === 1 ? '' : 's'}`;
                return item(n.model.name, 'symbol-namespace', [count, used.length ? `uses ${used.join(', ')}` : ''].filter(Boolean).join(' · '));
            }
            case 'element': {
                // Only a stable ID written on this element; children of one get `<parentId>.<name>` like any other.
                const derived = `${n.element.parent ?? n.model.name}.${n.element.name}`;
                const id = n.element.id !== derived ? ` · @"${n.element.id}"` : '';
                return item(n.element.name, 'symbol-object', `${short(n.element.kind)}${id}`);
            }
            case 'slot': {
                const names = (ids: string[]) => ids.map(id => `-> ${n.model.elements.find(e => e.id === id)?.name ?? id}`);
                const feature = this.outline.irIndex?.features(n.element.kind).find(f => f.name === n.name);
                const isEnum = feature?.feature === 'property' && typeof feature.type === 'object';
                const text = n.ref
                    ? names(n.value as string[]).join(', ')
                    : Array.isArray(n.value) ? `[${n.value.map(v => literal(v, isEnum)).join(', ')}]` : literal(n.value, isEnum);
                return item(n.name, n.ref ? 'references' : 'symbol-property', text);
            }
        }
    }

    protected profileChildren(n: Node): Node[] {
        if (n.type === 'profile') {
            return [
                ...n.profile.kinds.map(kind => ({ type: 'kind' as const, kind })),
                ...n.profile.enums.map(e => ({ type: 'enum' as const, e })),
            ];
        }
        if (n.type === 'kind') return n.kind.features.map(feature => ({ type: 'feature' as const, kind: n.kind, feature }));
        if (n.type === 'enum') return n.e.literals.map(literal => ({ type: 'literal' as const, e: n.e, literal }));
        return [];
    }
}

/**
 * Profiles (M2), split the way the examples describe them: a core profile
 * stands alone; a domain profile is layered on others, extending or
 * pointing at their kinds (see `IRIndex.dependsOn`).
 */
export class ProfilesTree extends OutlineTree {
    constructor(outline: WorkspaceOutline, private readonly which: 'core' | 'domain') {
        super(outline);
    }

    getChildren(node?: Node): Node[] {
        if (node) return this.profileChildren(node);
        const { ir, irIndex } = this.outline;
        if (!ir || !irIndex) return [];
        return ir.profiles
            .map(profile => ({ type: 'profile' as const, profile, layeredOn: irIndex.dependsOn(profile.name) }))
            .filter(p => (p.layeredOn.length > 0) === (this.which === 'domain'));
    }
}

/** Models (M1): elements nested by containment, each with the slots written for it. */
export class ModelsTree extends OutlineTree {
    getChildren(node?: Node): Node[] {
        const ir = this.outline.ir;
        if (!ir) return [];
        if (!node) return ir.models.map(model => ({ type: 'model' as const, model }));
        if (node.type === 'model') {
            return node.model.elements.filter(e => e.parent === null).map(element => ({ type: 'element' as const, model: node.model, element }));
        }
        if (node.type !== 'element') return [];
        const { model, element } = node;
        const slots: Node[] = [
            ...Object.entries(element.properties).map(([n, value]) => ({ type: 'slot' as const, model, element, name: n, value, ref: false })),
            ...Object.entries(element.references).map(([n, value]) => ({ type: 'slot' as const, model, element, name: n, value, ref: true })),
        ];
        const children = element.children
            .map(id => model.elements.find(e => e.id === id))
            .filter((e): e is IRElement => !!e)
            .map(child => ({ type: 'element' as const, model, element: child }));
        return [...slots, ...children];
    }
}

/** The tree views, the commands their items run, and their refresh. */
export function registerWorkspaceTrees(
    context: vscode.ExtensionContext, client: LanguageClient, documentsChanged: vscode.Event<void>,
    revealInDiagram: (model: vscode.Uri, elementId: string) => Promise<void>,
): void {
    const outline = new WorkspaceOutline(client, documentsChanged);
    context.subscriptions.push(
        outline,
        vscode.window.createTreeView('arbor.coreProfiles', { treeDataProvider: new ProfilesTree(outline, 'core'), showCollapseAll: true }),
        vscode.window.createTreeView('arbor.domainProfiles', { treeDataProvider: new ProfilesTree(outline, 'domain'), showCollapseAll: true }),
        vscode.window.createTreeView('arbor.models', { treeDataProvider: new ModelsTree(outline), showCollapseAll: true }),
        vscode.commands.registerCommand('arbor.reveal', async (at: vscode.Location) => {
            // Always the text editor, even where .arbor files open as diagrams by default.
            const doc = await vscode.workspace.openTextDocument(at.uri);
            await vscode.window.showTextDocument(doc, { selection: at.range, preview: true });
        }),
        vscode.commands.registerCommand('arbor.revealInDiagram', async (n: Node) => {
            if (n.type !== 'element' && n.type !== 'slot') return;
            const at = outline.location(`model:${n.model.name}`);
            if (at) await revealInDiagram(at.uri, n.element.id);
        }),
        vscode.commands.registerCommand('arbor.openModelDiagram', async (n: Node) => {
            const at = n.type === 'model' ? outline.location(`model:${n.model.name}`) : undefined;
            if (at) await vscode.commands.executeCommand('vscode.openWith', at.uri, 'arbor.diagram');
        }),
        vscode.commands.registerCommand('arbor.refreshWorkspace', () => outline.refresh()),
    );
}
