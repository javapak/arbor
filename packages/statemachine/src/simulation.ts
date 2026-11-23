/**
 * Runs a state machine, as UML defines it, over the IR:
 *
 * - The machine is in a *configuration*: the states active now, a tree (a
 *   composite state's regions each have one active state; several regions are
 *   orthogonal, active together).
 * - An event is handled in one *run-to-completion* step: the transitions it
 *   triggers whose guards hold fire, innermost states first (a transition from
 *   a nested state wins over one from the state around it), one per region.
 *   Firing exits states innermost first (their exit activities), runs the
 *   effect, and enters states outermost first (entry, then do activity), then
 *   regions' initial states.
 * - A choice or junction picks the first outgoing transition whose guard
 *   holds, after the effects leading to it. A final state completes its
 *   region; a state whose regions are all complete, or a simple state once
 *   entered, raises a *completion event*: its transitions with no trigger fire,
 *   before any further event.
 * - `after(14 days)` fires when its state has been active that long, on a
 *   virtual clock that only moves when told to.
 *
 * Do activities run once, after entry (not alongside, as in UML). History,
 * fork, join, entry and exit points and deferred events aren't supported yet:
 * reaching one is reported in the trace.
 *
 * Everything that happens is in the trace, in order, for a simulator to show.
 */
import { IRIndex, type IRDocument, type IRElement } from '@arbor/ir';
import { classWorld, describe as describeValue, type Value } from '@arbor/expr';
import { stateMachineBindingFor, stateMachineBindings, type StateMachineBinding } from './binding.js';
import { Instance, ObjectStore, type ExpressionFailure } from './objects.js';

/** What can happen in a simulation. */
export type Happening =
    | { kind: 'start'; machine: string }
    | { kind: 'event'; event: string }
    /** Nothing was enabled by it. */
    | { kind: 'ignored'; event: string }
    | { kind: 'enter' | 'exit'; state: string }
    | { kind: 'transition'; transition: string; source: string; target: string }
    | { kind: 'call'; operation: string; args: Value[]; implemented: boolean }
    | { kind: 'error'; failure: ExpressionFailure }
    | { kind: 'unsupported'; element: string; message: string }
    | { kind: 'finished' };

/** A happening, at the time on the virtual clock (milliseconds since start). */
export type TraceEntry = Happening & { time: number };

/** Milliseconds a unit of `after(…)` is. */
const UNITS: Record<string, number> = {
    ms: 1, millisecond: 1, milliseconds: 1,
    s: 1000, sec: 1000, second: 1000, seconds: 1000,
    min: 60_000, minute: 60_000, minutes: 60_000,
    h: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    day: 86_400_000, days: 86_400_000,
    week: 604_800_000, weeks: 604_800_000,
};
export const DAY = UNITS.day;

/** A trigger: an event's name, `after(14 days)` (a time), or nothing (a completion transition). */
export type Trigger = { event: string } | { after: number } | null;

export function parseTrigger(text: unknown): Trigger | { error: string } {
    if (typeof text !== 'string' || !text.trim()) return null;
    const after = /^\s*after\s*\(\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*\)\s*$/i.exec(text);
    if (after) {
        const unit = UNITS[after[2].toLowerCase() || 'ms'];
        return unit ? { after: Number(after[1]) * unit } : { error: `'${after[2]}' isn't a unit of time (ms, s, min, h, days, weeks).` };
    }
    if (/^\s*[A-Za-z_]\w*\s*$/.test(text)) return { event: text.trim() };
    return { error: `'${text}' isn't an event name or after(…).` };
}

interface Transition { el: IRElement; source: string; target: string; trigger: Trigger }
interface Timer { at: number; state: string; transition: Transition; entry: number }

/** The state machine an element is, or is in (a composite state's diagram is its machine's), if any. */
export function machineOf(doc: IRDocument, id: string): string | undefined {
    const index = new IRIndex(doc);
    const kinds = stateMachineBindings(doc).flatMap(b => b.machine.kinds);
    for (let el = index.elements.get(id); el; el = el.parent ? index.elements.get(el.parent) : undefined) {
        if (kinds.some(k => index.isA(el!.kind, k))) return el.id;
    }
    return undefined;
}

export class Simulation {
    readonly objects: ObjectStore;
    /** The instance the machine runs for: its class's (the machine's context). */
    readonly self: Instance;
    readonly trace: TraceEntry[] = [];
    /** Active states (element IDs). */
    readonly active = new Set<string>();
    /** The virtual clock, in milliseconds since start. */
    time = 0;
    finished = false;

    private readonly index: IRIndex;
    private readonly transitions: Transition[] = [];
    private timers: Timer[] = [];
    /** How often each state has been entered: a timer only fires for the visit that set it. */
    private readonly entries = new Map<string, number>();
    private readonly completions: string[] = [];

    private readonly binding: StateMachineBinding;

    /** Runs `machine`, by the roles its profile declares, or by `binding` if given. */
    constructor(doc: IRDocument, readonly machine: string, binding?: StateMachineBinding) {
        const found = binding ?? stateMachineBindingFor(doc, machine);
        if (!found) throw new Error(`${machine} isn't of a kind that plays 'machine'.`);
        this.binding = binding = found;
        const world = classWorld(doc, binding.expressions);
        this.index = world.index;
        const m = this.index.elements.get(machine);
        if (!m || !this.isA(m, binding.machine.kinds)) throw new Error(`${machine} isn't a state machine.`);
        // Its context: the class around it (a state machine is itself a class in UML; its owner's attributes are what it reads).
        const context = this.ancestors(m).find(a => world.classOf(a.id) && !this.isA(a, binding.machine.kinds));
        this.objects = new ObjectStore(world);
        this.objects.onCall = c => this.log({ kind: 'call', operation: c.operation, args: c.args, implemented: c.implemented });
        this.objects.onFailure = failure => this.log({ kind: 'error', failure });
        this.self = this.objects.create(context?.id ?? machine);
        for (const el of this.index.elements.values()) {
            if (!this.isA(el, binding.transition.kinds) || !this.within(el, machine)) continue;
            const t = binding.transition;
            const source = el.references[t.source]?.[0], target = el.references[t.target]?.[0];
            if (!source || !target) continue;
            const trigger = parseTrigger(t.trigger ? this.index.get(el, t.trigger) : undefined);
            if (trigger && 'error' in trigger) {
                this.log({ kind: 'unsupported', element: el.id, message: trigger.error });
                continue;
            }
            this.transitions.push({ el, source, target, trigger });
        }
    }

    // ------------------------------------------------------------ the model

    private isA(el: IRElement, kinds: string[]): boolean { return kinds.some(k => this.index.isA(el.kind, k)); }
    private el(id: string): IRElement { return this.index.elements.get(id)!; }
    private ancestors(el: IRElement): IRElement[] {
        const out: IRElement[] = [];
        for (let p = el.parent; p; p = this.index.elements.get(p)?.parent ?? null) out.push(this.el(p));
        return out;
    }
    private within(el: IRElement, id: string): boolean { return this.ancestors(el).some(a => a.id === id); }
    private children(el: IRElement, containment: string): IRElement[] {
        return el.children.map(id => this.el(id)).filter(c => c.containedIn === containment);
    }
    private regionsOf(el: IRElement): IRElement[] {
        const b = this.binding;
        return this.children(el, this.isA(el, b.machine.kinds) ? b.machine.regions : b.state.regions).filter(r => this.isA(r, b.region.kinds));
    }
    private isState(el: IRElement): boolean { return this.isA(el, this.binding.state.kinds); }
    private isFinal(el: IRElement): boolean { return this.isA(el, this.binding.final.kinds); }
    private pseudoKind(el: IRElement): string | undefined {
        const b = this.binding.pseudostate;
        if (!this.isA(el, b.kinds)) return undefined;
        const k = this.index.get(el, b.kind);
        return typeof k === 'string' ? k : 'initial';
    }
    /** The states around a vertex, innermost first. */
    private statesAround(el: IRElement): IRElement[] { return this.ancestors(el).filter(a => this.isState(a)); }
    private depth(el: IRElement): number { return this.ancestors(el).length; }
    private outgoing(vertex: string): Transition[] { return this.transitions.filter(t => t.source === vertex); }

    // ------------------------------------------------------------ running

    private log(entry: Happening): void {
        this.trace.push({ ...entry, time: this.time });
    }

    /** Enters the machine: each region's initial state, and whatever completes from there. */
    start(): this {
        if (this.trace.some(e => e.kind === 'start')) return this;
        this.log({ kind: 'start', machine: this.machine });
        for (const r of this.regionsOf(this.el(this.machine))) this.enterRegion(r);
        this.complete();
        return this;
    }

    /** Handles an event: one run-to-completion step. */
    send(event: string): this {
        if (this.finished) return this;
        this.log({ kind: 'event', event });
        const fired = this.step(t => t.trigger !== null && 'event' in t.trigger && t.trigger.event === event);
        if (!fired) this.log({ kind: 'ignored', event });
        this.complete();
        return this;
    }

    /** Moves the clock on, firing the time triggers that come due, in order. */
    advance(ms: number): this {
        const until = this.time + ms;
        for (;;) {
            const due = this.timers.filter(t => t.at <= until).sort((a, b) => a.at - b.at)[0];
            if (!due || this.finished) break;
            this.timers = this.timers.filter(t => t !== due);
            this.time = due.at;
            if (!this.active.has(due.state) || this.entries.get(due.state) !== due.entry) continue;
            if (this.guard(due.transition)) { this.fire(due.transition); this.complete(); }
        }
        this.time = until;
        return this;
    }

    /** When the next time trigger is due, if one is. */
    nextTimer(): number | undefined {
        const live = this.timers.filter(t => this.active.has(t.state) && this.entries.get(t.state) === t.entry);
        return live.length ? Math.min(...live.map(t => t.at)) : undefined;
    }

    /** The events that would fire a transition now: triggers of active states' transitions whose guards hold. */
    enabledEvents(): string[] {
        const out = new Set<string>();
        for (const t of this.transitions) {
            if (!this.active.has(t.source) || !t.trigger || !('event' in t.trigger)) continue;
            if (this.guard(t, true)) out.add(t.trigger.event);
        }
        return [...out];
    }

    /**
     * Fires the enabled transitions `matches` picks: for each active state, innermost first, the
     * first whose guard holds, unless a transition already fired in this step has exited it.
     */
    private step(matches: (t: Transition) => boolean): boolean {
        const states = [...this.active].map(id => this.el(id)).sort((a, b) => this.depth(b) - this.depth(a));
        let fired = false;
        const done = new Set<string>();
        for (const s of states) {
            if (!this.active.has(s.id) || done.has(s.id)) continue;
            // This state, and the ones around it, innermost first.
            for (const v of [s, ...this.statesAround(s)]) {
                if (done.has(v.id)) break;
                const t = this.outgoing(v.id).find(x => matches(x) && this.guard(x));
                if (!t) continue;
                for (const w of [s, ...this.statesAround(s)]) done.add(w.id);
                this.fire(t);
                fired = true;
                break;
            }
        }
        return fired;
    }

    /** Completion events, before any other: transitions without triggers from states that have completed. */
    private complete(): void {
        while (this.completions.length && !this.finished) {
            const id = this.completions.shift()!;
            if (!this.active.has(id)) continue;
            const t = this.outgoing(id).find(x => x.trigger === null && this.guard(x));
            if (t) this.fire(t);
        }
    }

    private guard(t: Transition, quiet = false): boolean {
        const f = this.binding.transition.guard;
        const text = f ? this.index.get(t.el, f) : undefined;
        if (typeof text !== 'string' || !text.trim()) return true;
        if (quiet) {
            // Asking what's enabled shouldn't record anything (calls, failures).
            const { onCall, onFailure } = this.objects;
            this.objects.onCall = () => {};
            this.objects.onFailure = () => {};
            try { return this.objects.evaluate(text, this.self, t.el.id, f!) === true; }
            finally { this.objects.onCall = onCall; this.objects.onFailure = onFailure; }
        }
        return this.objects.evaluate(text, this.self, t.el.id, f!) === true;
    }

    private action(el: IRElement, feature: string | undefined): void {
        const text = feature ? this.index.get(el, feature) : undefined;
        if (typeof text === 'string' && text.trim()) this.objects.run(text, this.self, el.id, feature!);
    }

    /** Fires a transition: exits up to the region holding both ends, runs the effect, enters the target. */
    private fire(t: Transition): void {
        const source = this.el(t.source), target = this.el(t.target);
        const region = this.commonRegion(source, target);
        // The state in that region holding the source (the source itself, or one around it).
        const leaving = [source, ...this.statesAround(source)].find(s => s.parent === region?.id);
        if (leaving && this.active.has(leaving.id)) this.exit(leaving);
        this.log({ kind: 'transition', transition: t.el.id, source: t.source, target: t.target });
        this.action(t.el, this.binding.transition.effect);
        // Into the target: the states around it below the common region, outermost first.
        const path = this.statesAround(target).filter(s => region && this.within(s, region.id)).reverse();
        this.enterPath(path, target);
    }

    /** The innermost region holding both (a self-transition's is the state's own region). */
    private commonRegion(a: IRElement, b: IRElement): IRElement | undefined {
        const regions = (el: IRElement) => this.ancestors(el).filter(x => this.isA(x, this.binding.region.kinds));
        const ofB = new Set(regions(b).map(r => r.id));
        return regions(a).find(r => ofB.has(r.id));
    }

    private enterPath(path: IRElement[], target: IRElement): void {
        for (let i = 0; i < path.length; i++) {
            const s = path[i];
            if (this.active.has(s.id)) continue;
            this.enterOne(s);
            // Its other regions start at their initial states; the one on the way is entered by the path.
            const next = path[i + 1] ?? target;
            for (const r of this.regionsOf(s)) if (!this.within(next, r.id)) this.enterRegion(r);
        }
        this.enterVertex(target);
    }

    private enterRegion(region: IRElement): void {
        const initial = this.children(region, this.binding.region.vertices).find(v => this.pseudoKind(v) === 'initial');
        if (!initial) { this.log({ kind: 'unsupported', element: region.id, message: 'This region has no initial pseudostate to start from.' }); return; }
        const [t, ...more] = this.outgoing(initial.id);
        if (!t || more.length) { this.log({ kind: 'unsupported', element: initial.id, message: 'An initial pseudostate needs exactly one outgoing transition.' }); return; }
        this.log({ kind: 'transition', transition: t.el.id, source: t.source, target: t.target });
        this.action(t.el, this.binding.transition.effect);
        this.enterVertex(this.el(t.target));
    }

    private enterVertex(v: IRElement): void {
        const pseudo = this.pseudoKind(v);
        if (pseudo === undefined) { this.enterState(v); return; }
        switch (pseudo) {
            case 'choice': case 'junction': {
                const t = this.outgoing(v.id).find(x => this.guard(x));
                if (!t) { this.log({ kind: 'unsupported', element: v.id, message: `No outgoing transition's guard holds here: the machine is stuck.` }); return; }
                this.log({ kind: 'transition', transition: t.el.id, source: t.source, target: t.target });
                this.action(t.el, this.binding.transition.effect);
                this.enterVertex(this.el(t.target));
                return;
            }
            case 'terminate':
                this.finish();
                return;
            default:
                this.log({ kind: 'unsupported', element: v.id, message: `${pseudo} pseudostates aren't simulated yet.` });
        }
    }

    /** Enters a state and, if it's composite, its regions' initial states. */
    private enterState(s: IRElement): void {
        this.enterOne(s);
        for (const r of this.regionsOf(s)) this.enterRegion(r);
        this.settle(s);
    }

    /** The state itself: active, its entry and do activities run, its time triggers set. */
    private enterOne(s: IRElement): void {
        this.active.add(s.id);
        const entry = (this.entries.get(s.id) ?? 0) + 1;
        this.entries.set(s.id, entry);
        this.log({ kind: 'enter', state: s.id });
        this.action(s, this.binding.state.entry);
        this.action(s, this.binding.state.doActivity);
        for (const t of this.outgoing(s.id)) {
            if (t.trigger && 'after' in t.trigger) this.timers.push({ at: this.time + t.trigger.after, state: s.id, transition: t, entry });
        }
    }

    /** What entering a state completes: a simple state, a final state's region, a composite whose regions are all done. */
    private settle(s: IRElement): void {
        if (this.isFinal(s)) {
            const region = this.el(s.parent!);
            const owner = this.el(region.parent!);
            const done = this.regionsOf(owner).every(r => this.children(r, this.binding.region.vertices).some(v => this.isFinal(v) && this.active.has(v.id)));
            if (!done) return;
            if (owner.id === this.machine) this.finish();
            else this.completions.push(owner.id);
            return;
        }
        if (!this.regionsOf(s).length) this.completions.push(s.id);
    }

    /** Exits a state: what's active inside it first, innermost first, then its own exit activity. */
    private exit(s: IRElement): void {
        for (const r of this.regionsOf(s)) {
            for (const v of this.children(r, this.binding.region.vertices)) if (this.active.has(v.id)) this.exit(v);
        }
        this.action(s, this.binding.state.exit);
        this.active.delete(s.id);
        this.log({ kind: 'exit', state: s.id });
    }

    private finish(): void {
        if (this.finished) return;
        this.finished = true;
        this.log({ kind: 'finished' });
    }

    /** The context instance's attributes, for showing. */
    variables(): Record<string, string> {
        return Object.fromEntries([...this.self.slots].map(([k, v]) => [k, describeValue(v)]));
    }
}
