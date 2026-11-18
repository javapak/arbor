/**
 * Messages between the diagram editor (extension host) and its webview.
 *
 * The host owns the text (through VS Code's TextDocument and the language
 * server) and the view file. The webview draws, and reports what the user did;
 * it never edits text itself.
 */
import type { IRDocument, IRScalar } from '@arbor/ir';
import type { EdgeLayout, Layout, LayoutEntry } from '@arbor/adapter-flow';

/** The contents of `<name>.arbor.view.json`. See schemas/view.schema.json. */
export interface ViewFile {
    format: 'arbor/view';
    version: 1;
    /** The model file, relative to the view file. Informational; the file name is the link. */
    model?: string;
    nodes: Layout;
    edges: EdgeLayout;
}

export type HostMessage =
    /** The model, rebuilt by the language server. `kind` says whether the file holds a model at all. */
    | { type: 'model'; ir: IRDocument; kind: 'model' | 'profile' | 'unknown'; errors: number }
    /** The whole view: on start, after the view file changed on disk, and after the host placed a new element. */
    | { type: 'view'; view: ViewFile; select?: string }
    /** Something the user did couldn't be written to the text; the webview redraws from the model. */
    | { type: 'notice'; text: string | null; resync?: boolean }
    /** Select an element (e.g. revealed from a tree view). */
    | { type: 'select'; id: string }
    /** VS Code's theme changed. */
    | { type: 'theme'; dark: boolean };

export type WebviewMessage =
    | { type: 'ready' }
    /** Layout changes to merge into the view file. `null` removes an entry. */
    | { type: 'layout'; nodes?: Record<string, LayoutEntry | null>; edges?: Record<string, Array<{ x: number; y: number }> | null> }
    | { type: 'add-element'; kind: string; position: { x: number; y: number } }
    | { type: 'remove-element'; id: string }
    | { type: 'set-slot'; id: string; name: string; value: IRScalar | IRScalar[] | undefined }
    /** Show the element in the text editor. */
    | { type: 'reveal'; id: string }
    /** The single selected element, or `null`; shown in the properties view. */
    | { type: 'selection'; id: string | null };

/**
 * Messages between the host and the properties view, a side bar view that
 * shows the form for the element selected in the active diagram.
 */
export type PropertiesHostMessage =
    | { type: 'properties'; ir: IRDocument | null; id: string | null }
    | { type: 'theme'; dark: boolean };

/** What the properties view sends. The host handles edits as if the active diagram had sent them. */
export type PropertiesMessage = Extract<WebviewMessage, { type: 'ready' | 'set-slot' | 'reveal' }>;
