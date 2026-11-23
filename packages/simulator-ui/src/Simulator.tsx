/**
 * A panel that runs the state machine of the open diagram: start it, send it
 * events (those enabled now, or any by name), move its clock on, and watch
 * its context object's attributes and what happened. The host draws the
 * active states and the transitions just taken from `onHighlight`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Group, Paper, ScrollArea, Stack, Table, Text, TextInput, Tooltip, CloseButton } from '@mantine/core';
import { IRIndex, displayName, type IRDocument } from '@arbor/ir';
import { describe } from '@arbor/expr';
import { DAY, Simulation, machineOf, type StateMachineBinding, type TraceEntry } from '@arbor/statemachine';

export interface Highlight { nodes: string[]; edges: string[] }

export interface SimulatorProps {
    ir: IRDocument;
    /** The open diagram's element: the panel runs the state machine it is, or is in. */
    root: string | null;
    /** How to read the machine; by default, from the roles its profile declares. */
    binding?: StateMachineBinding;
    /** The active states, and the transitions the last step took: for the host to draw. */
    onHighlight: (marks: Highlight) => void;
    onClose: () => void;
}

const HOUR = 3_600_000;

/** `day 14, 06:00` on the virtual clock. */
function clock(ms: number): string {
    const days = Math.floor(ms / DAY), rest = ms - days * DAY;
    const h = Math.floor(rest / HOUR), m = Math.floor((rest % HOUR) / 60_000);
    return `day ${days}, ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A span of time, roughly: `14 days`, `3 hours`. */
function span(ms: number): string {
    if (ms >= DAY) { const d = ms / DAY; return `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`; }
    if (ms >= HOUR) { const h = ms / HOUR; return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`; }
    return `${Math.round(ms / 1000)} s`;
}

export function Simulator({ ir, root, binding, onHighlight, onClose }: SimulatorProps) {
    const machine = useMemo(() => (root ? machineOf(ir, root) : undefined), [ir, root]);
    const sim = useRef<Simulation | null>(null);
    /** The model the simulation was started from: a later one means the text changed meanwhile. */
    const startedWith = useRef<IRDocument | null>(null);
    /** Where in the trace the last step began, to mark what it did. */
    const stepFrom = useRef(0);
    const [, setVersion] = useState(0);
    const [problem, setProblem] = useState<string | null>(null);
    const [eventName, setEventName] = useState('');
    const traceEnd = useRef<HTMLDivElement>(null);
    const index = useMemo(() => new IRIndex(ir), [ir]);
    const name = (id: string) => { const el = index.elements.get(id); return el ? displayName(el) : id.split('.').pop()!; };

    // The latest callback, so a host passing a new function each render doesn't matter.
    const highlight = useRef(onHighlight);
    highlight.current = onHighlight;
    const report = () => {
        const s = sim.current;
        if (!s) { highlight.current({ nodes: [], edges: [] }); setVersion(v => v + 1); return; }
        const edges = s.trace.slice(stepFrom.current).flatMap(e => (e.kind === 'transition' ? [e.transition] : []));
        highlight.current({ nodes: [...s.active], edges });
        setVersion(v => v + 1);
    };
    /** Runs one thing the user asked for, marking what it did. */
    const act = (f: (s: Simulation) => void) => {
        if (!sim.current) return;
        stepFrom.current = sim.current.trace.length;
        f(sim.current);
        report();
    };
    const start = () => {
        if (!machine) return;
        try {
            sim.current = new Simulation(ir, machine, binding);
            startedWith.current = ir;
            stepFrom.current = 0;
            sim.current.start();
            setProblem(null);
        } catch (e) {
            sim.current = null;
            setProblem(e instanceof Error ? e.message : String(e));
        }
        report();
    };

    // A different machine (another diagram opened): start over. Closing: nothing to draw.
    useEffect(() => {
        sim.current = null;
        report();
    }, [machine]);
    useEffect(() => () => highlight.current({ nodes: [], edges: [] }), []);
    // A block, not an expression: newer browsers return a Promise from scrollIntoView, which React would take for a cleanup.
    useEffect(() => { traceEnd.current?.scrollIntoView({ block: 'end' }); });

    const s = sim.current;
    const stale = !!s && startedWith.current !== ir;
    const next = s?.nextTimer();
    const enabled = s && !s.finished ? s.enabledEvents() : [];

    return (
        <Paper withBorder shadow="md" p="sm" style={{ width: 340, maxHeight: '60vh', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Group justify="space-between" wrap="nowrap">
                <Text fw={600} size="sm" truncate>Simulate {machine ? name(machine) : ''}</Text>
                <Group gap={4} wrap="nowrap">
                    <Button size="compact-xs" onClick={start} disabled={!machine}>{s ? 'Restart' : 'Start'}</Button>
                    <CloseButton size="sm" aria-label="Close the simulator" onClick={onClose} />
                </Group>
            </Group>
            {!machine && <Text size="xs" c="dimmed">Open a state machine's diagram to simulate it.</Text>}
            {problem && <Text size="xs" c="red">{problem}</Text>}
            {stale && <Text size="xs" c="orange">The model changed since this run started; restart to use it.</Text>}

            {s && (
                <>
                    <Group gap={6} wrap="nowrap">
                        <Badge variant="light" color={s.finished ? 'gray' : 'yellow'}>{s.finished ? 'finished' : clock(s.time)}</Badge>
                        <Button size="compact-xs" variant="default" disabled={s.finished} onClick={() => act(x => x.advance(HOUR))}>+1 h</Button>
                        <Button size="compact-xs" variant="default" disabled={s.finished} onClick={() => act(x => x.advance(DAY))}>+1 day</Button>
                        {next !== undefined && !s.finished && (
                            <Tooltip label={`Move the clock to the next time trigger, ${clock(next)}`}>
                                <Button size="compact-xs" variant="default" onClick={() => act(x => x.advance(next - x.time))}>+{span(next - s.time)}</Button>
                            </Tooltip>
                        )}
                    </Group>

                    <Group gap={4}>
                        {enabled.map(e => <Button key={e} size="compact-xs" variant="light" onClick={() => act(x => x.send(e))}>{e}</Button>)}
                        {!enabled.length && !s.finished && <Text size="xs" c="dimmed">No event would fire a transition now.</Text>}
                    </Group>
                    <form onSubmit={ev => { ev.preventDefault(); if (eventName.trim()) act(x => x.send(eventName.trim())); setEventName(''); }}>
                        <TextInput size="xs" placeholder="Send another event by name, then Enter" value={eventName}
                            onChange={ev => setEventName(ev.currentTarget.value)} disabled={s.finished} />
                    </form>

                    <Table withRowBorders={false} verticalSpacing={0} fz="xs">
                        <Table.Tbody>
                            {Object.entries(s.variables()).map(([k, v]) => (
                                <Table.Tr key={k}><Table.Td c="dimmed">{k}</Table.Td><Table.Td ff="monospace">{v}</Table.Td></Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>

                    <ScrollArea.Autosize mah={220} type="auto" offsetScrollbars>
                        <Stack gap={0}>
                            {s.trace.map((e, i) => <TraceLine key={i} entry={e} name={name} fresh={i >= stepFrom.current} />)}
                            <div ref={traceEnd} />
                        </Stack>
                    </ScrollArea.Autosize>
                </>
            )}
        </Paper>
    );
}

function TraceLine({ entry: e, name, fresh }: { entry: TraceEntry; name: (id: string) => string; fresh: boolean }) {
    const line = (text: string, color?: string, indent = 0) => (
        <Text size="xs" ff="monospace" c={color} fw={fresh ? 500 : 400} style={{ paddingLeft: indent * 10, opacity: fresh ? 1 : 0.7 }}>
            {text}
        </Text>
    );
    switch (e.kind) {
        case 'start': return line(`start ${name(e.machine)}`, 'yellow');
        case 'event': return line(`${clock(e.time)}  ${e.event}`, 'blue');
        case 'ignored': return line(`nothing takes '${e.event}' now`, 'dimmed', 1);
        case 'enter': return line(`→ ${name(e.state)}`, undefined, 1);
        case 'exit': return line(`← ${name(e.state)}`, 'dimmed', 1);
        case 'transition': return line(`${name(e.source)} ⇒ ${name(e.target)}`, 'dimmed', 1);
        case 'call': return line(`${e.operation}(${e.args.map(describe).join(', ')})${e.implemented ? '' : '  (no body)'}`, 'teal', 2);
        case 'error': return line(`${e.failure.feature} of ${name(e.failure.element)}: ${e.failure.message}`, 'red', 2);
        case 'unsupported': return line(`${name(e.element)}: ${e.message}`, 'orange', 1);
        case 'finished': return line('finished', 'yellow');
    }
}
