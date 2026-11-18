import type { DiagramEdit } from 'webgpu-flow';
import { IRIndex, referenceSlotsFor, withTarget, withoutTarget } from '@arbor/ir';
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
            connect(edit.edge.sourceNodeId, edit.edge.targetNodeId);
            break;
        case 'edge-removed':
            disconnect(edit.edge);
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

/** A drawn edge sets a reference of its source to its target; the host asks which, if several fit. */
function connect(sourceId: string, targetId: string) {
    const { ir } = useDiagramStore.getState();
    if (!ir) return undo('');
    const index = new IRIndex(ir);
    const source = index.elements.get(sourceId), target = index.elements.get(targetId);
    if (!source || !target) return undo('Edges connect elements; draw from one element to another.');
    const fitting = referenceSlotsFor(index, source, target);
    if (fitting.length === 0) {
        return undo(`${source.name} has no reference that can point at ${target.name} (a ${target.kind.split('.').pop()}).`);
    }
    const slots = fitting.flatMap(f => {
        const value = withTarget(source, f, targetId);
        return value === undefined ? [] : [{ name: f.name, value }];
    });
    if (slots.length === 0) return undo(`${source.name} already points at ${target.name}.`);
    // The new edge is drawn once the text has the reference; until then, the drawn one stays.
    post({ type: 'connect', id: sourceId, target: targetId, slots });
}

/**
 * Deleting a reference edge removes that reference from the text, and deleting an edge that is an
 * element (of an edge kind) removes the element. Containment edges stay.
 */
function disconnect(edge: Extract<DiagramEdit, { kind: 'edge-removed' }>['edge']) {
    const { ir } = useDiagramStore.getState();
    if (edge.data?.relation === 'element') {
        post({ type: 'remove-element', id: edge.id });
        return;
    }
    if (!ir || edge.data?.relation !== 'reference') {
        return undo('Containment comes from nesting in the text: move or delete the element to change it.');
    }
    const index = new IRIndex(ir);
    const source = index.elements.get(edge.sourceNodeId);
    const slot = source && index.features(source.kind).find(f => f.feature === 'ref' && f.name === edge.data?.feature);
    if (!source || slot?.feature !== 'ref') return undo('');
    post({ type: 'set-slot', id: source.id, name: slot.name, value: withoutTarget(source, slot, edge.targetNodeId) });
}
