import { Text } from '@mantine/core';
import type { IRDocument } from '@arbor/ir';
import { diagramTitle } from '@arbor/adapter-flow';

/**
 * The name of the element whose own diagram is open (`«stateMachine» Lifecycle`),
 * centred above the canvas: the diagram draws what it contains, not the element.
 */
export default function DiagramTitle({ ir, root }: { ir: IRDocument | null; root: string | null }) {
  const title = ir && root ? diagramTitle(ir, root) : '';
  if (!title) return null;
  return (
    <Text fw={600} size="md" style={{
      position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', maxWidth: '40%',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none',
    }}>
      {title}
    </Text>
  );
}
