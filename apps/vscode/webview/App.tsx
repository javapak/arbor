import { Allotment } from 'allotment';
import { Badge, CloseButton, Group, Text } from '@mantine/core';
import { DiagramProvider, NodePalette } from 'webgpu-flow';
import { useDiagramStore } from './store';
import { handleEdit } from './diagramEdits';
import DiagramPane from './DiagramPane';
import Toolbar from './Toolbar';
import DiagramTrail from './DiagramTrail';
import DiagramTitle from './DiagramTitle';

export default function App() {
    const { kind, errors, notice, setNotice, ir, root, setRoot } = useDiagramStore();
    if (ir && kind !== 'model') {
        return (
            <Text p="md" c="dimmed">
                {kind === 'profile'
                    ? 'This file is a profile. Its kinds appear in the palette of every model diagram; open a model file to draw one.'
                    : 'This file does not parse as a model yet. Fix it in the text editor and the diagram will follow.'}
            </Text>
        );
    }
    return (
        <DiagramProvider onEdit={handleEdit}>
            <Allotment>
                <Allotment.Pane minSize={320}>
                    <div style={{ position: 'relative', height: '100%' }}>
                        <DiagramPane />
                        <DiagramTitle ir={ir} root={root} />
                        <Toolbar />
                        <Group gap={8} wrap="nowrap" style={{ position: 'absolute', top: 12, left: 12 }}>
                            <DiagramTrail ir={ir} root={root} open={setRoot} />
                            {errors > 0 && (
                                <Badge color="red" variant="light">
                                    {errors} error{errors > 1 ? 's' : ''} in the text
                                </Badge>
                            )}
                        </Group>
                        {notice && (
                            <Group gap={6} wrap="nowrap" style={{
                                position: 'absolute', left: 12, right: 12, bottom: 12, padding: '6px 10px', borderRadius: 8,
                                background: 'var(--mantine-color-body)', border: '1px solid var(--mantine-color-default-border)',
                            }}>
                                <Text size="sm" style={{ flex: 1 }}>{notice}</Text>
                                <CloseButton size="sm" aria-label="Dismiss" onClick={() => setNotice(null)} />
                            </Group>
                        )}
                    </div>
                </Allotment.Pane>
                {/* The palette stays here: dragging from it onto the canvas can't cross webviews. */}
                <Allotment.Pane minSize={180} preferredSize={240}>
                    <div style={{ height: '100%', overflowY: 'auto' }}>
                        <NodePalette />
                        <Text size="xs" c="dimmed" p="sm">
                            Adding or deleting a node edits the text. Moving and resizing go to the view file.
                        </Text>
                    </div>
                </Allotment.Pane>
            </Allotment>
        </DiagramProvider>
    );
}
