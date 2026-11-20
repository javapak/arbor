import { Fragment } from 'react';
import { ActionIcon, Anchor, Group, Text, Tooltip } from '@mantine/core';
import { ArrowLeftRegular } from '@fluentui/react-icons';
import { displayName, type IRDocument } from '@arbor/ir';
import { diagramPath } from '@arbor/adapter-flow';

/**
 * Where the open diagram is: a back button, then the model's diagram and each
 * one opened from it down to this one, any of which can be clicked to go back
 * to. Shown only inside an element's own diagram (a state machine, say).
 */
export default function DiagramTrail({ ir, root, open }: { ir: IRDocument | null; root: string | null; open: (root: string | null) => void }) {
    if (!ir || !root) return null;
    const path = diagramPath(ir, root);
    if (!path.length) return null;
    const model = ir.models.find(m => m.elements.some(e => e.id === root))?.name ?? 'model';
    const up = path.length > 1 ? path[path.length - 2].id : null;
    return (
        <Group gap={6} wrap="nowrap" style={{
            padding: '2px 10px 2px 2px', borderRadius: 8,
            background: 'var(--mantine-color-body)', border: '1px solid var(--mantine-color-default-border)',
        }}>
            <Tooltip label={`Back to ${up ? displayName(path[path.length - 2]) : model}`}>
                <ActionIcon variant="subtle" aria-label="Back" onClick={() => open(up)}><ArrowLeftRegular /></ActionIcon>
            </Tooltip>
            <Anchor component="button" size="sm" onClick={() => open(null)}>{model}</Anchor>
            {path.map((el, i) => (
                <Fragment key={el.id}>
                    <Text size="sm" c="dimmed">›</Text>
                    {i === path.length - 1
                        ? <Text size="sm" fw={600}>{displayName(el)}</Text>
                        : <Anchor component="button" size="sm" onClick={() => open(el.id)}>{displayName(el)}</Anchor>}
                </Fragment>
            ))}
        </Group>
    );
}
