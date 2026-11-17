import type { DiagramEdit } from 'webgpu-flow';
import { planAddElement, planRemoveElement } from '@arbor/language';
import { sources, useStudio } from './store';

/**
 * Turns a user's diagram edit into the studio's own update:
 * geometry goes to the layout sidecars, structure becomes a text edit.
 * Anything that can't be expressed in text yet is undone by redrawing from the text.
 */
export function handleEdit(edit: DiagramEdit): void {
  const s = useStudio.getState();
  switch (edit.kind) {
    case 'node-moved':
      s.setLayout(l => ({ ...l, [edit.nodeId]: { ...l[edit.nodeId], ...edit.to } }));
      break;
    case 'node-resized':
      s.setLayout(l => ({ ...l, [edit.nodeId]: { ...edit.to.position, ...edit.to.size } }));
      break;
    case 'edge-reshaped':
      s.setEdgeLayout(l => ({ ...l, [edit.edgeId]: edit.to }));
      break;
    case 'node-added':
      void addElement(edit);
      break;
    case 'node-removed':
      void removeElement(edit);
      break;
    case 'edge-added':
    case 'edge-removed':
      undo('Edges come from references and containment in the text. Edit the text to change them.');
      break;
    case 'node-changed':
      s.setNotice('Label and colour changes are display-only; the next text change redraws from the profile.');
      break;
  }
}

async function addElement(edit: Extract<DiagramEdit, { kind: 'node-added' }>) {
  const kind = edit.template.data?.kind;
  if (typeof kind !== 'string') return undo(`${edit.template.label} isn't a kind from a loaded profile.`);
  const s = useStudio.getState();
  const plan = await planAddElement(sources(s.files), kind);
  if ('error' in plan) return undo(`Couldn't add ${edit.template.label}: ${plan.error}.`);
  // Keep the node where it was dropped; the redraw replaces it with the new element.
  s.setLayout(l => ({ ...l, [plan.elementId]: { ...edit.node.data.position } }));
  s.setPendingSelect(plan.elementId);
  s.applyTextEdit(plan.edit);
  s.setActive(plan.edit.uri);
  s.setNotice(null);
}

async function removeElement(edit: Extract<DiagramEdit, { kind: 'node-removed' }>) {
  if (typeof edit.node.data.kind !== 'string') return undo('');
  const s = useStudio.getState();
  const plan = await planRemoveElement(sources(s.files), edit.node.id);
  if ('error' in plan) return undo(`Couldn't remove ${edit.node.data.label}: ${plan.error}.`);
  s.applyTextEdit(plan);
  s.setActive(plan.uri);
  s.setNotice(null);
}

/** Redraw from the text, dropping the diagram-only change, and say why. */
function undo(notice: string) {
  const s = useStudio.getState();
  s.setNotice(notice || null);
  s.resync();
}
