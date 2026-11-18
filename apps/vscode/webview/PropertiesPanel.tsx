import { useMemo } from 'react';
import { Anchor, Group, Stack, Text } from '@mantine/core';
import { IRIndex, slotSchema, slotValues, type IRDocument } from '@arbor/ir';
import { PropertyForm } from '@arbor/property-form';
import { post } from './vscode';

/**
 * The form for the element selected in the active diagram, generated from its
 * kind. Each change is sent to the host as a slot edit; the new values arrive
 * with the next model.
 */
export default function PropertiesPanel({ ir, id }: { ir: IRDocument | null; id: string | null }) {
    const index = useMemo(() => (ir ? new IRIndex(ir) : null), [ir]);
    const element = id ? index?.elements.get(id) : undefined;
    const schema = useMemo(() => (index && element ? slotSchema(index, element.kind) : null), [index, element]);

    if (!index || !element || !schema) {
        return <Text size="xs" c="dimmed" p="sm">Select one element in a diagram to edit its properties.</Text>;
    }
    return (
        <Stack gap="xs" p="sm">
            <Group justify="space-between" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                    <Text fw={600} truncate>{element.name}</Text>
                    <Text size="xs" c="dimmed" truncate>{element.kind} · {element.id}</Text>
                </div>
                <Anchor size="xs" component="button" onClick={() => post({ type: 'reveal', id: element.id })}>Show in text</Anchor>
            </Group>
            {/* Keyed by element, so a half-typed value never carries over to another element. */}
            <PropertyForm key={element.id} schema={schema} values={slotValues(element, schema)}
                onChange={(name, value) => post({ type: 'set-slot', id: element.id, name, value })} />
        </Stack>
    );
}
