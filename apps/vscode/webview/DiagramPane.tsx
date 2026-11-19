import { useEffect, useRef, useState } from 'react';
import { DiagramCanvas, useDiagram, useRenderSettings } from 'webgpu-flow';
import { toFlowGraph } from '@arbor/adapter-flow';
import { useDiagramStore } from './store';
import { post } from './vscode';

const noop = () => {};

/** The canvas, redrawn whenever the model or the view file changes. */
export default function DiagramPane() {
    const { loadDiagram, fitToContent, selectNode, nodes, interaction, gridSnapping } = useDiagram();
    // Auto-placed elements go on the snap grid; read at redraw time, so toggling snapping doesn't redraw.
    const grid = useRef<number | undefined>(undefined);
    grid.current = gridSnapping.enabled ? gridSnapping.gridSize : undefined;
    const selected = useRef<string | null>(null);
    // A node, or an edge that is an element itself (of an edge kind, like a generalization).
    const edge = interaction.selectedEdges.length === 1 && interaction.selectedNodes.length === 0 ? interaction.selectedEdges[0] : undefined;
    selected.current = interaction.selectedNodes.length === 1 ? interaction.selectedNodes[0].id
        : edge?.data?.relation === 'element' ? edge.id : null;
    const ir = useDiagramStore(s => s.ir);
    const viewRevision = useDiagramStore(s => s.viewRevision);
    const resyncRequest = useDiagramStore(s => s.resyncRequest);
    const pendingSelect = useDiagramStore(s => s.pendingSelect);
    const resolution = useRenderSettings(s => s.resolution);
    const container = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const fitPending = useRef(true);
    // The properties view shows the selected element. A redraw clears the selection until the
    // element is reselected; report the pending one meanwhile, so the form isn't torn down mid-typing.
    const reported = selected.current ?? pendingSelect;
    useEffect(() => post({ type: 'selection', id: reported }), [reported]);

    useEffect(() => {
        if (!ir) return;
        const { layout, edgeLayout, setLayout, pendingSelect, setPendingSelect } = useDiagramStore.getState();
        const graph = toFlowGraph(ir, { layout, edgeLayout, grid: grid.current });
        // Redraws clear the selection; keep the selected element (and its properties panel) across them.
        const has = (id: string | null) => !!id && graph.nodes.some(n => n.id === id);
        // A pending element not drawn yet (just added, its text edit still on the way) stays pending.
        if (!has(pendingSelect) && has(selected.current)) setPendingSelect(selected.current);
        // Pin auto-placed nodes, so adding an element doesn't reshuffle the others. Nodes inside a
        // container are arranged by it and have no place of their own.
        const placed = graph.nodes.filter(n => !layout[n.id] && !n.parentId);
        if (placed.length) {
            const entries = Object.fromEntries(placed.map(n => [n.id, { ...n.data.position }]));
            setLayout(l => ({ ...l, ...entries }));
            post({ type: 'layout', nodes: entries });
        }
        loadDiagram(graph);
    }, [ir, viewRevision, resyncRequest, loadDiagram]);

    // Fit the first diagram once it is committed (the provider syncs its state after this effect).
    useEffect(() => {
        if (!fitPending.current || nodes.length === 0) return;
        fitPending.current = false;
        requestAnimationFrame(() => fitToContent({ animate: false }));
    }, [nodes, fitToContent]);

    // Select an element added from the palette, or reselect the one selected before a redraw, once the redraw has it.
    useEffect(() => {
        const node = pendingSelect ? nodes.find(n => n.id === pendingSelect) : undefined;
        if (!node) return;
        useDiagramStore.getState().setPendingSelect(null);
        selectNode(node);
    }, [nodes, selectNode, pendingSelect]);

    useEffect(() => {
        const el = container.current!;
        const observer = new ResizeObserver(([entry]) => {
            setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    return (
        // Focusable, and focused on press, so keyboard shortcuts go to the diagram.
        <div ref={container} tabIndex={-1} onPointerDown={() => container.current?.focus({ preventScroll: true })}
            style={{ width: '100%', height: '100%', overflow: 'hidden', background: 'var(--vscode-editor-background)', outline: 'none' }}>
            {size.width > 0 && (
                <DiagramCanvas width={size.width} height={size.height} resolution={resolution} setSupportedSampleCount={noop} />
            )}
        </div>
    );
}
