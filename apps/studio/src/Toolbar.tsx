import { useState } from 'react';
import { ActionIcon, Group, Menu, Tooltip } from '@mantine/core';
import { ConnectorRegular, FlowchartRegular, ZoomFitRegular } from '@fluentui/react-icons';
import { InteractionMode, useDiagram, type LayoutOptions } from 'webgpu-flow';
import type { LayoutEntry } from '@arbor/adapter-flow';
import { useStudio } from './store';

const LAYOUTS: Array<{ label: string; options: Partial<LayoutOptions> }> = [
  { label: 'Layered, left to right', options: { algorithm: 'layered', direction: 'RIGHT' } },
  { label: 'Layered, top to bottom', options: { algorithm: 'layered', direction: 'DOWN' } },
  { label: 'Tree', options: { algorithm: 'tree', direction: 'DOWN' } },
  { label: 'Organic (stress)', options: { algorithm: 'stress' } },
  { label: 'Force-directed', options: { algorithm: 'force' } },
  { label: 'Packed boxes', options: { algorithm: 'box' } },
];

/** Fit the diagram to the view, and lay it out automatically; a layout is kept in the layout sidecars like a move. */
export default function Toolbar() {
  const { fitToContent, applyLayout, serializeDiagram, mode, toggleMode, exitDrawMode } = useDiagram();
  const connecting = mode === InteractionMode.DRAW_EDGE;
  const [running, setRunning] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const layout = async (options: Partial<LayoutOptions>) => {
    setRunning(true);
    try {
      await applyLayout(options, { animate: true });
      const { nodes, edges } = serializeDiagram();
      const s = useStudio.getState();
      // Positions only, and only of top-level nodes: containers arrange what's inside them.
      const moved: Record<string, LayoutEntry> = Object.fromEntries(
        nodes.filter(n => !n.parentId).map(n => [n.id, { ...s.layout[n.id], ...n.data.position }]));
      s.setLayout(l => ({ ...l, ...moved }));
      s.setEdgeLayout(l => {
        const next = { ...l };
        for (const e of edges) {
          if (e.userVertices.length) next[e.id] = e.userVertices; else delete next[e.id];
        }
        return next;
      });
    } catch (e) {
      useStudio.getState().setNotice(`Layout failed: ${String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Group gap={4} style={{ position: 'absolute', top: 12, right: 12 }}>
      <Tooltip label={connecting ? 'Click the source element, then the target (Esc cancels)' : 'Connect: draw a reference from one element to another'}>
        <ActionIcon variant={connecting ? 'filled' : 'default'} aria-label="Connect" aria-pressed={connecting}
          onClick={() => (connecting ? exitDrawMode() : toggleMode())}>
          <ConnectorRegular />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Fit to view">
        <ActionIcon variant="default" aria-label="Fit to view" onClick={() => fitToContent()}>
          <ZoomFitRegular />
        </ActionIcon>
      </Tooltip>
      <Menu position="bottom-end" withinPortal opened={menuOpen} onChange={setMenuOpen}>
        <Menu.Target>
          <Tooltip label="Lay out automatically" disabled={menuOpen}>
            <ActionIcon variant="default" aria-label="Lay out automatically" loading={running}>
              <FlowchartRegular />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>
          {LAYOUTS.map(l => <Menu.Item key={l.label} onClick={() => void layout(l.options)}>{l.label}</Menu.Item>)}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
