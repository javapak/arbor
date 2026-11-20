import { useState } from 'react';
import { Allotment } from 'allotment';
import { Badge, Button, CloseButton, Group, Tabs, Text, Tooltip } from '@mantine/core';
import { DiagramProvider, NodePalette } from 'webgpu-flow';
import { useStudio } from './store';
import { handleEdit } from './diagramEdits';
import Editor from './Editor';
import DiagramPane from './DiagramPane';
import DiagramTrail from './DiagramTrail';
import Toolbar from './Toolbar';

export default function Studio() {
  const { files, active, diagnostics, notice, setFile, setActive, setNotice, reset, ir, root, setRoot } = useStudio();
  const [reveal, setReveal] = useState<{ line: number; column: number; n: number }>();
  const errors = diagnostics.filter(d => d.severity === 'error').length;

  const show = (uri: string, line: number, column: number) => {
    setActive(uri);
    setReveal(r => ({ line, column, n: (r?.n ?? 0) + 1 }));
  };

  return (
    <DiagramProvider onEdit={handleEdit}>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Group justify="space-between" px="sm" py={6} style={{ borderBottom: '1px solid #333' }}>
          <Group gap="xs">
            <Text fw={700}>arbor studio</Text>
            <Badge color={errors ? 'red' : 'green'} variant="light">
              {errors ? `${errors} error${errors > 1 ? 's' : ''}` : 'no errors'}
            </Badge>
          </Group>
          <Tooltip label="Discard your changes and reload the example files">
            <Button size="compact-xs" variant="subtle" color="gray"
              onClick={() => { if (window.confirm('Reset all files and layout to the examples?')) reset(); }}>
              Reset to examples
            </Button>
          </Tooltip>
        </Group>

        <div style={{ flex: 1, minHeight: 0 }}>
          <Allotment defaultSizes={[40, 45, 15]}>
            <Allotment.Pane minSize={280}>
              <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <Tabs value={active} onChange={v => v && setActive(v)}>
                  <Tabs.List>
                    {Object.keys(files).map(uri => {
                      const n = diagnostics.filter(d => d.uri === uri && d.severity === 'error').length;
                      return (
                        <Tabs.Tab key={uri} value={uri} rightSection={n ? <Badge size="xs" color="red" circle>{n}</Badge> : null}>
                          {uri}
                        </Tabs.Tab>
                      );
                    })}
                  </Tabs.List>
                </Tabs>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <Editor uri={active} text={files[active] ?? ''} diagnostics={diagnostics.filter(d => d.uri === active)}
                    onChange={text => setFile(active, text)} reveal={reveal} />
                </div>
                {diagnostics.length > 0 && (
                  <div style={{ maxHeight: '28%', overflowY: 'auto', borderTop: '1px solid #333', padding: '4px 0' }}>
                    {diagnostics.map((d, i) => (
                      <button key={i} onClick={() => show(d.uri, d.line, d.column)} style={{
                        display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer',
                        padding: '2px 10px', color: d.severity === 'error' ? '#ff8787' : '#ffd43b', font: '12px ui-monospace, monospace',
                      }}>
                        {d.uri}:{d.line}:{d.column} {d.code} {d.message}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Allotment.Pane>

            <Allotment.Pane minSize={320}>
              <div style={{ position: 'relative', height: '100%' }}>
                <DiagramPane />
                <Toolbar />
                <div style={{ position: 'absolute', top: 12, left: 12 }}>
                  <DiagramTrail ir={ir} root={root} open={setRoot} />
                </div>
                {notice && (
                  <Group gap={6} wrap="nowrap" style={{
                    position: 'absolute', left: 12, right: 12, bottom: 12, padding: '6px 10px', borderRadius: 8,
                    background: 'rgba(30,30,30,0.95)', border: '1px solid #555',
                  }}>
                    <Text size="sm" style={{ flex: 1 }}>{notice}</Text>
                    <CloseButton size="sm" aria-label="Dismiss" onClick={() => setNotice(null)} />
                  </Group>
                )}
              </div>
            </Allotment.Pane>

            <Allotment.Pane minSize={180} preferredSize={240}>
              <div style={{ height: '100%', overflowY: 'auto' }}>
                <NodePalette />
                <Text size="xs" c="dimmed" p="sm">
                  Adding or deleting a node edits the text. Moving and resizing only change the layout.
                </Text>
              </div>
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>
    </DiagramProvider>
  );
}

