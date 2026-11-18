/**
 * Connecting elements from a diagram: which reference slots of one element can
 * point at another, and the slot values that add or remove such a link. Values
 * are as `planSetSlot` takes them: element IDs, a list for many-valued slots.
 */
import { isMany } from './form.js';
import type { IRIndex } from './query.js';
import type { IRElement, IRReference } from './types.js';

/**
 * The reference slots of `source` whose type `target` is (or extends), in the kind's order.
 * Not derived or readonly ones: those aren't edited from a diagram.
 */
export function referenceSlotsFor(index: IRIndex, source: IRElement, target: IRElement): IRReference[] {
    return index.elementFeatures(source)
        .filter((f): f is IRReference => f.feature === 'ref' && index.isA(target.kind, f.target) && !f.derived && !f.readonly);
}

/**
 * The value of `slot` with `targetId` added: appended to a many-valued slot,
 * replacing a single-valued one. Undefined if it is already there.
 */
export function withTarget(source: IRElement, slot: IRReference, targetId: string): string | string[] | undefined {
    const current = source.references[slot.name] ?? [];
    if (current.includes(targetId)) return undefined;
    return isMany(slot.multiplicity) ? [...current, targetId] : targetId;
}

/** The value of `slot` with `targetId` removed: undefined when nothing is left (the slot is removed). */
export function withoutTarget(source: IRElement, slot: IRReference, targetId: string): string | string[] | undefined {
    const rest = (source.references[slot.name] ?? []).filter(id => id !== targetId);
    if (rest.length === 0) return undefined;
    return isMany(slot.multiplicity) ? rest : rest[0];
}
