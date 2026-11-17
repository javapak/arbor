import { create } from 'zustand';
import type { Layout, EdgeLayout } from '@arbor/adapter-flow';
import type { StructuredDiagnostic, TextEdit } from '@arbor/language';
import { applyEdit } from '@arbor/language';
import software from '../../../examples/software.arbor?raw';
import persistence from '../../../examples/persistence.arbor?raw';
import shop from '../../../examples/shop.arbor?raw';

/**
 * Studio state. The text is the source of truth; the diagram is rebuilt from
 * it on every change. Positions live in the layout sidecars, never in text.
 */
export interface StudioState {
  /** uri -> text, in load order. */
  files: Record<string, string>;
  active: string;
  layout: Layout;
  edgeLayout: EdgeLayout;
  diagnostics: StructuredDiagnostic[];
  /** Short message about the last diagram edit that couldn't be written to text. */
  notice: string | null;
  /** Bumped to rebuild the diagram without a text change (e.g. to drop an unsupported edit). */
  resyncRequest: number;
  /** Element to select once the next redraw has it (redraws clear the selection). */
  pendingSelect: string | null;

  setFile: (uri: string, text: string) => void;
  applyTextEdit: (edit: TextEdit) => void;
  setActive: (uri: string) => void;
  setLayout: (update: (layout: Layout) => Layout) => void;
  setEdgeLayout: (update: (layout: EdgeLayout) => EdgeLayout) => void;
  setDiagnostics: (diagnostics: StructuredDiagnostic[]) => void;
  setNotice: (notice: string | null) => void;
  resync: () => void;
  setPendingSelect: (id: string | null) => void;
  reset: () => void;
}

const EXAMPLES: Record<string, string> = {
  'software.arbor': software,
  'persistence.arbor': persistence,
  'shop.arbor': shop,
};

const STORAGE_KEY = 'arbor-studio/v1';
type Saved = Pick<StudioState, 'files' | 'active' | 'layout' | 'edgeLayout'>;

function restore(): Saved {
  const fresh: Saved = { files: EXAMPLES, active: 'shop.arbor', layout: {}, edgeLayout: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Saved | null;
    return saved?.files && Object.keys(saved.files).length ? { ...fresh, ...saved } : fresh;
  } catch {
    return fresh;
  }
}

export const useStudio = create<StudioState>((set) => ({
  ...restore(),
  diagnostics: [],
  notice: null,
  resyncRequest: 0,
  pendingSelect: null,

  setFile: (uri, text) => set(s => ({ files: { ...s.files, [uri]: text } })),
  applyTextEdit: (edit) => set(s => ({ files: { ...s.files, [edit.uri]: applyEdit(s.files[edit.uri] ?? '', edit) } })),
  setActive: (active) => set({ active }),
  setLayout: (update) => set(s => ({ layout: update(s.layout) })),
  setEdgeLayout: (update) => set(s => ({ edgeLayout: update(s.edgeLayout) })),
  setDiagnostics: (diagnostics) => set({ diagnostics }),
  setNotice: (notice) => set({ notice }),
  resync: () => set(s => ({ resyncRequest: s.resyncRequest + 1 })),
  setPendingSelect: (pendingSelect) => set({ pendingSelect }),
  reset: () => set({ files: EXAMPLES, active: 'shop.arbor', layout: {}, edgeLayout: {}, notice: null }),
}));

// Autosave. Browser storage is per-browser and may be unavailable; the studio works without it.
useStudio.subscribe((s, prev) => {
  if (s.files === prev.files && s.layout === prev.layout && s.edgeLayout === prev.edgeLayout && s.active === prev.active) return;
  try {
    const saved: Saved = { files: s.files, active: s.active, layout: s.layout, edgeLayout: s.edgeLayout };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch { /* storage full or blocked */ }
});

export const sources = (files: Record<string, string>) => Object.entries(files).map(([uri, text]) => ({ uri, text }));
