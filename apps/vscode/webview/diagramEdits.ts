import type { DiagramEdit } from 'webgpu-flow';
import { useDiagramStore } from './store';
import { post } from './vscode';

/**
 * Turns a user's diagram edit into a message for the host: geometry goes to
 * the view file, structure becomes a request for a text edit. Anything that
 * can't be expressed in text yet is undone by redrawing from the model.
 */
export function handleEdit(edit: DiagramEdit): void {
    const s = useDiagramStore.getState();
    switch (edit.kind) {
        case 'node-moved': {
            const entry = { ...s.layout[edit.nodeId], ...edit.to };
            s.setLayout(l => ({ ...l, [edit.nodeId]: entry }));
            post({ type: 'layout', nodes: { [edit.nodeId]: entry } });
            break;
        }
        case 'node-resized': {
            const entry = { ...edit.to.position, ...edit.to.size };
            s.setLayout(l => ({ ...l, [edit.nodeId]: entry }));
            post({ type: 'layout', nodes: { [edit.nodeId]: entry } });
            break;
        }
        case 'edge-reshaped':
            s.setEdgeLayout(l => ({ ...l, [edit.edgeId]: edit.to }));
            post({ type: 'layout', edges: { [edit.edgeId]: edit.to } });
            break;
        case 'node-added': {
            const kind = edit.template.data?.kind;
            if (typeof kind !== 'string') return undo(`${edit.template.label} isn't a kind from a loaded profile.`);
            // The host plans the text edit, places the element where it was dropped and asks us to select it.
            post({ type: 'add-element', kind, position: { ...edit.node.data.position } });
            break;
        }
        case 'node-removed':
            if (typeof edit.node.data.kind !== 'string') return undo('');
            post({ type: 'remove-element', id: edit.node.id });
            break;
        case 'edge-added':
        case 'edge-removed':
            undo('Edges come from references and containment. Set references in the properties panel or the text.');
            break;
        case 'node-changed':
            s.setNotice('Label and colour changes are display-only; the next change redraws from the profile.');
            break;
    }
}

/** Redraw from the model, dropping the diagram-only change, and say why. */
function undo(notice: string) {
    const s = useDiagramStore.getState();
    s.setNotice(notice || null);
    s.resync();
}
