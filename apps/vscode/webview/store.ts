import { create } from 'zustand';
import type { IRDocument } from '@arbor/ir';
import type { EdgeLayout, Layout } from '@arbor/adapter-flow';
import type { HostMessage } from '../src/protocol';
import type { Highlight } from '@arbor/simulator-ui';

/**
 * Webview state: a mirror of what the host owns. The model comes from the
 * language server and the layout from the view file; the webview changes
 * layout locally for responsiveness and reports each change to the host.
 */
export interface DiagramState {
    ir: IRDocument | null;
    kind: 'model' | 'profile' | 'unknown';
    errors: number;
    layout: Layout;
    edgeLayout: EdgeLayout;
    /** Bumped when the host replaces the layout, so the diagram is redrawn with it. */
    viewRevision: number;
    notice: string | null;
    /** Bumped to redraw without a model change, dropping a diagram-only edit. */
    resyncRequest: number;
    /** Element to select once the next redraw has it. */
    pendingSelect: string | null;
    dark: boolean;
    /** The layout worker is loaded (see main.tsx). */
    layoutReady: boolean;
    /** The element whose own diagram is open (a state machine, say), or null for the model's. */
    root: string | null;
    /** The simulator panel is open. */
    simulating: boolean;
    /** What the simulator marks in the diagram: active states, transitions just taken. */
    highlight: Highlight;

    setLayout: (update: (layout: Layout) => Layout) => void;
    setEdgeLayout: (update: (layout: EdgeLayout) => EdgeLayout) => void;
    setNotice: (notice: string | null) => void;
    resync: () => void;
    setPendingSelect: (id: string | null) => void;
    setRoot: (root: string | null) => void;
    setSimulating: (simulating: boolean) => void;
    setHighlight: (highlight: Highlight) => void;
    receive: (m: HostMessage) => void;
}

export const useDiagramStore = create<DiagramState>((set) => ({
    ir: null,
    kind: 'unknown',
    errors: 0,
    layout: {},
    edgeLayout: {},
    viewRevision: 0,
    notice: null,
    resyncRequest: 0,
    pendingSelect: null,
    dark: true,
    layoutReady: false,
    root: null,
    simulating: false,
    highlight: { nodes: [], edges: [] },

    setLayout: (update) => set(s => ({ layout: update(s.layout) })),
    setEdgeLayout: (update) => set(s => ({ edgeLayout: update(s.edgeLayout) })),
    setNotice: (notice) => set({ notice }),
    resync: () => set(s => ({ resyncRequest: s.resyncRequest + 1 })),
    setPendingSelect: (pendingSelect) => set({ pendingSelect }),
    setRoot: (root) => set({ root }),
    setSimulating: (simulating) => set({ simulating }),
    setHighlight: (highlight) => set({ highlight }),
    receive: (m) => {
        switch (m.type) {
            case 'model':
                set({ ir: m.ir, kind: m.kind, errors: m.errors });
                break;
            case 'view':
                set(s => ({
                    layout: m.view.nodes, edgeLayout: m.view.edges, viewRevision: s.viewRevision + 1,
                    ...(m.select ? { pendingSelect: m.select } : {}),
                }));
                break;
            case 'notice':
                set(s => ({ notice: m.text, ...(m.resync ? { resyncRequest: s.resyncRequest + 1 } : {}) }));
                break;
            case 'select':
                set({ pendingSelect: m.id });
                break;
            case 'theme':
                set({ dark: m.dark });
                break;
        }
    },
}));
