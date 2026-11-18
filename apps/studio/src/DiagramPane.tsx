import { useEffect, useRef, useState } from 'react';
import { DiagramCanvas, useDiagram, useRenderSettings } from 'webgpu-flow';
import { loadWorkspace } from '@arbor/language';
import { toFlowGraph } from '@arbor/adapter-flow';
import { sources, useStudio } from './store';

const SYNC_DELAY_MS = 200;
const noop = () => {};

/** The canvas, redrawn from the text whenever it changes. */
export default function DiagramPane() {
  const { loadDiagram, fitToContent, selectNode, nodes } = useDiagram();
  const files = useStudio(s => s.files);
  const resyncRequest = useStudio(s => s.resyncRequest);
  const resolution = useRenderSettings(s => s.resolution);
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const fitPending = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await loadWorkspace(sources(files));
      if (cancelled) return;
      const { layout, edgeLayout, setLayout, setDiagnostics } = useStudio.getState();
      const graph = toFlowGraph(result.ir, { layout, edgeLayout });
      // Pin auto-placed nodes, so adding an element doesn't reshuffle the others. Nodes inside a
      // container are arranged by it and have no place of their own.
      const placed = graph.nodes.filter(n => !layout[n.id] && !n.parentId);
      if (placed.length) {
        setLayout(l => ({ ...l, ...Object.fromEntries(placed.map(n => [n.id, { ...n.data.position }])) }));
      }
      loadDiagram(graph);
      setDiagnostics(result.diagnostics);
    }, SYNC_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [files, resyncRequest, loadDiagram]);

  // Fit the first diagram once it is committed (the provider syncs its state after this effect).
  useEffect(() => {
    if (!fitPending.current || nodes.length === 0) return;
    fitPending.current = false;
    requestAnimationFrame(() => fitToContent({ animate: false }));
  }, [nodes, fitToContent]);

  // Re-select an element added from the palette once the redraw has replaced the palette node with it.
  useEffect(() => {
    const id = useStudio.getState().pendingSelect;
    const node = id ? nodes.find(n => n.id === id) : undefined;
    if (!node) return;
    useStudio.getState().setPendingSelect(null);
    selectNode(node);
  }, [nodes, selectNode]);

  useEffect(() => {
    const el = container.current!;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    // Focusable, and focused on press, so keyboard shortcuts go to the diagram rather than the editor.
    <div ref={container} tabIndex={-1} onPointerDown={() => container.current?.focus({ preventScroll: true })}
      style={{ width: '100%', height: '100%', overflow: 'hidden', background: '#1f1f1f', outline: 'none' }}>
      {size.width > 0 && (
        <DiagramCanvas width={size.width} height={size.height} resolution={resolution} setSupportedSampleCount={noop} />
      )}
    </div>
  );
}
