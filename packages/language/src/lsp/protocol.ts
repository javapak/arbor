/**
 * Names and result shapes of the diagram requests (see diagram.ts). No
 * dependencies beyond the IR types, so a language client can import it
 * without pulling in Langium: `@arbor/language/protocol`.
 */
import type { IRDocument } from '@arbor/ir';

export const DiagramRequests = {
    /** `{ uri }` -> `{ ir, kind }`: the model in `uri` with every profile in the workspace. */
    model: 'arbor/model',
    /** `{ uri, kind }` -> `Planned<{ edit, elementId }>`: add an element of `kind` to the model in `uri`. */
    addElement: 'arbor/planAddElement',
    /** `{ uri, id }` -> `Planned<TextEdit>`: remove the element with ID `id`. */
    removeElement: 'arbor/planRemoveElement',
    /** `{ uri, id, name, value }` -> `Planned<TextEdit>`: set (or with no value, remove) a slot of element `id`. */
    setSlot: 'arbor/planSetSlot',
    /** `{ uri, id }` -> `Planned<{ uri, offset, length }>`: where element `id` is named. */
    locate: 'arbor/locateElement',
} as const;

/** Server -> client, after documents were rebuilt: `{ uris }`. A profile change affects every open diagram. */
export const DiagramNotifications = { changed: 'arbor/documentsChanged' } as const;

export interface ModelResult {
    ir: IRDocument;
    /** What the source holds; a profile has no diagram of its own. */
    kind: 'model' | 'profile' | 'unknown';
}

/** Requests for workspace views (the extension's tree views). */
export const WorkspaceRequests = {
    /** `{}` -> `WorkspaceResult`: every profile and model in the workspace, with where each item is written. */
    outline: 'arbor/workspace',
} as const;

/** A name in the text: its file and the range of the name (LSP positions, 0-based). */
export interface SourceLocation {
    uri: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface WorkspaceResult {
    ir: IRDocument;
    /**
     * Keys: `profile:<name>`, `kind:<kindId>`, `feature:<kindId>.<name>`,
     * `datatype:<datatypeId>` and `stereotype:<stereotypeId>` (their features are `feature:<id>.<name>`), `enum:<enumId>`, `literal:<enumId>.<name>`, `model:<name>`, and
     * `element:<model>:<elementId>` (element IDs are unique per model only).
     */
    locations: Record<string, SourceLocation>;
}
