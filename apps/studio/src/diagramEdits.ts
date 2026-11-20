import type { DiagramEdit } from 'webgpu-flow';
import { loadWorkspace, planAddElement, planRemoveElement, planSetSlot } from '@arbor/language';
import { IRIndex, displayName, referenceSlotsFor, withTarget, withoutTarget } from '@arbor/ir';
import { sources, useStudio } from './store';

/**
 * Turns a user's diagram edit into the studio's own update:
 * geometry goes to the layout sidecars, structure becomes a text edit.
 * Anything that can't be expressed in text yet is undone by redrawing from the text.
 */
export function handleEdit(edit: DiagramEdit): void {
  const s = useStudio.getState();
  // A diagram's frame goes where what it holds is; its place is its node's in the diagram around it.
  if ((edit.kind === 'node-moved' || edit.kind === 'node-resized') && edit.nodeId === s.root) return;
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
      void connect(edit.edge.sourceNodeId, edit.edge.targetNodeId);
      break;
    case 'edge-removed':
      void disconnect(edit.edge);
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
  await removeById(edit.node.id, edit.node.data.label ?? edit.node.id);
}

async function removeById(id: string, label: string) {
  const s = useStudio.getState();
  const plan = await planRemoveElement(sources(s.files), id);
  if ('error' in plan) return undo(`Couldn't remove ${label}: ${plan.error}.`);
  s.applyTextEdit(plan);
  s.setActive(plan.uri);
  s.setNotice(null);
}

/** A drawn edge sets a reference of its source to its target, asking which if several fit. */
async function connect(sourceId: string, targetId: string) {
  const s = useStudio.getState();
  const index = new IRIndex((await loadWorkspace(sources(s.files))).ir);
  const source = index.elements.get(sourceId), target = index.elements.get(targetId);
  if (!source || !target) return undo('Edges connect elements; draw from one element to another.');
  const fitting = referenceSlotsFor(index, source, target);
  if (fitting.length === 0) {
    return undo(`${displayName(source)} has no reference that can point at ${displayName(target)} (a ${target.kind.split('.').pop()}).`);
  }
  const open = fitting.filter(f => withTarget(source, f, targetId) !== undefined);
  if (open.length === 0) return undo(`${displayName(source)} already points at ${displayName(target)}.`);
  let slot = open[0];
  if (open.length > 1) {
    const answer = window.prompt(`Which reference of ${displayName(source)} should point at ${displayName(target)}? (${open.map(f => f.name).join(', ')})`, open[0].name);
    const chosen = open.find(f => f.name === answer?.trim());
    if (!chosen) return undo('');
    slot = chosen;
  }
  await setSlot(sourceId, slot.name, withTarget(source, slot, targetId));
}

/**
 * Deleting a reference edge removes that reference from the text, and deleting an edge that is an
 * element (of an edge kind) removes the element. Containment edges stay.
 */
async function disconnect(edge: Extract<DiagramEdit, { kind: 'edge-removed' }>['edge']) {
  if (edge.data?.relation === 'element') return removeById(edge.id, String(edge.data?.label || edge.id));
  if (edge.data?.relation !== 'reference') {
    return undo('Containment comes from nesting in the text: move or delete the element to change it.');
  }
  const s = useStudio.getState();
  const index = new IRIndex((await loadWorkspace(sources(s.files))).ir);
  const source = index.elements.get(edge.sourceNodeId);
  const slot = source && index.elementFeature(source, String(edge.data?.feature));
  if (!source || slot?.feature !== 'ref') return undo('');
  await setSlot(source.id, slot.name, withoutTarget(source, slot, edge.targetNodeId));
}

async function setSlot(id: string, name: string, value: string | string[] | undefined) {
  const s = useStudio.getState();
  const plan = await planSetSlot(sources(s.files), id, name, value);
  if ('error' in plan) return undo(`Couldn't change the text: ${plan.error}.`);
  s.applyTextEdit(plan);
  s.setNotice(null);
}

/** Redraw from the text, dropping the diagram-only change, and say why. */
function undo(notice: string) {
  const s = useStudio.getState();
  s.setNotice(notice || null);
  s.resync();
}
