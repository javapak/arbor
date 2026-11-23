# Simulating state machines

`@arbor/statemachine` runs a model's state machines, for trying a design out. It reads the IR; guards, effects, entry/exit/do activities and operation bodies run in the [expression language](EXPRESSIONS.md), against an instance of the class the machine belongs to.

```ts
import { loadWorkspace } from '@arbor/language';
import { Simulation, DAY } from '@arbor/statemachine';

const { ir } = await loadWorkspace(files);
const sim = new Simulation(ir, 'lending.Loan.Lifecycle').start();
sim.enabledEvents();          // ['renew', 'returned']: what would fire now
sim.send('renew');            // one run-to-completion step
sim.advance(14 * DAY);        // the virtual clock: after(14 days) fires
sim.active;                   // the active states, by element ID
sim.variables();              // the loan's attributes: { fine: '0.5', renewals: '1', … }
sim.trace;                    // everything that happened, in order, with times
```

In VS Code and the studio, the ▷ button in a state machine's diagram opens a panel that drives a `Simulation` (`@arbor/simulator-ui`): the active states glow in the diagram, the transitions just taken are marked (`highlight` in `@arbor/adapter-flow`), and the panel has the events, the clock, the attributes and the trace.

## What it does (UML's semantics)

- **Configuration**: the active states, a tree; a composite state's regions each have one active state, several regions run together.
- **Run to completion**: an event fires the transitions it triggers whose guards hold, one per region, a nested state's before the state around it. Firing exits states innermost first (their exit activities), runs the effect, enters states outermost first (entry, then do activity), then each region's initial state.
- **Choice and junction**: the first outgoing transition whose guard holds, after the effects on the way there.
- **Completion**: a final state completes its region; a state whose regions are all complete, or a simple state once entered, takes its transitions without a trigger, before any further event. The machine finishes when its own regions are complete, or at a terminate pseudostate.
- **Time**: `after(14 days)` (ms, s, min, h, days, weeks) fires once its state has been active that long, on a clock that moves only with `advance`. A timer belongs to the visit that set it.
- **The instance**: attributes start at their `defaultValue`; an operation runs its `body`, or, with none (an email sent, say), is just recorded in the trace.

## Not yet

Do activities run once, after entry, not alongside the state. History, fork, join, entry and exit points, deferred events and events with parameters aren't simulated: reaching one, a stuck choice, or an expression that fails (a division by zero) is reported in the trace, and a failing guard counts as false.

## Other profiles

Nothing is tied to samples/uml's names: what a profile's kinds and features [play](LANGUAGE.md#roles) (`plays machine`, `plays transition`, `plays guard`…) makes its state machines runnable, read from the IR as a `StateMachineBinding` (plain data; `stateMachineBindings(ir)`). A pseudostate's kind is matched by its literals' names: `initial`, `choice`, `junction`, `terminate`.
