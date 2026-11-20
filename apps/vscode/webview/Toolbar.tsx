import { useState } from 'react';
import { ActionIcon, Group, Menu, Tooltip } from '@mantine/core';
import { ConnectorRegular, FlowchartRegular, SettingsRegular, ZoomFitRegular } from '@fluentui/react-icons';
import { InteractionMode, RenderSettingsModal, useDiagram, type LayoutOptions } from 'webgpu-flow';
import { placedNodes, type LayoutEntry } from '@arbor/adapter-flow';
import { useDiagramStore } from './store';
import { post } from './vscode';

const LAYOUTS: Array<{ label: string; options: Partial<LayoutOptions> }> = [
    { label: 'Layered, left to right', options: { algorithm: 'layered', direction: 'RIGHT' } },
    { label: 'Layered, top to bottom', options: { algorithm: 'layered', direction: 'DOWN' } },
    { label: 'Tree', options: { algorithm: 'tree', direction: 'DOWN' } },
    { label: 'Organic (stress)', options: { algorithm: 'stress' } },
    { label: 'Force-directed', options: { algorithm: 'force' } },
    { label: 'Packed boxes', options: { algorithm: 'box' } },
];

/** Fit the diagram to the view, and lay it out automatically; a layout is saved to the view file like a move. */
export default function Toolbar() {
    const { fitToContent, applyLayout, serializeDiagram, mode, toggleMode, exitDrawMode } = useDiagram();
    const connecting = mode === InteractionMode.DRAW_EDGE;
    const layoutReady = useDiagramStore(s => s.layoutReady);
    const [running, setRunning] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);

    const layout = async (options: Partial<LayoutOptions>) => {
        setRunning(true);
        try {
            await applyLayout(options, { animate: true });
            const { nodes, edges } = serializeDiagram();
            const s = useDiagramStore.getState();
            // Positions only (sizes stay as the user or the profile set them), and only of nodes that have
            // places of their own: containers arrange what's inside them, unless they're free.
            const moved: Record<string, LayoutEntry> = Object.fromEntries(
                placedNodes(nodes).map(n => [n.id, { ...s.layout[n.id], ...n.data.position }]));
            const routed = Object.fromEntries(edges.map(e => [e.id, e.userVertices.length ? e.userVertices : null]));
            s.setLayout(l => ({ ...l, ...moved }));
            s.setEdgeLayout(l => {
                const next = { ...l };
                for (const [id, vertices] of Object.entries(routed)) {
                    if (vertices) next[id] = vertices; else delete next[id];
                }
                return next;
            });
            post({ type: 'layout', nodes: moved, edges: routed });
        } catch (e) {
            useDiagramStore.getState().setNotice(`Layout failed: ${String(e)}`);
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
                    <Tooltip label={layoutReady ? 'Lay out automatically' : 'Loading the layout engine'} disabled={menuOpen}>
                        <ActionIcon variant="default" aria-label="Lay out automatically" loading={running} disabled={!layoutReady}>
                            <FlowchartRegular />
                        </ActionIcon>
                    </Tooltip>
                </Menu.Target>
                <Menu.Dropdown>
                    {LAYOUTS.map(l => <Menu.Item key={l.label} onClick={() => void layout(l.options)}>{l.label}</Menu.Item>)}
                </Menu.Dropdown>
            </Menu>
            <Tooltip label="Render settings: resolution and anti-aliasing">
                <ActionIcon variant="default" aria-label="Render settings" onClick={() => setSettingsOpen(true)}>
                    <SettingsRegular />
                </ActionIcon>
            </Tooltip>
            <RenderSettingsModal opened={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </Group>
    );
}
