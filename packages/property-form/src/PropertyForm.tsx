import { useEffect, useState, type ReactNode } from 'react';
import { ActionIcon, Group, MultiSelect, NumberInput, Select, Stack, Switch, TagsInput, Text, TextInput, Tooltip } from '@mantine/core';
import type { FieldSchema, IRScalar, IRValue, ListSchema, ScalarSchema, SlotSchema, SlotValues } from '@arbor/ir';

type Value = IRValue;

export interface PropertyFormProps {
    /** From `slotSchema(ir, element.kind)`. */
    schema: SlotSchema;
    /** From `slotValues(element, schema)`: only the slots written in the text. */
    values: SlotValues;
    /**
     * One slot changed. `undefined` means "remove the slot" (the profile default
     * applies again). Text and number fields report on blur or Enter, not per keystroke.
     */
    onChange: (name: string, value: Value | undefined) => void;
    readOnly?: boolean;
    /** A slot's value as the text writes it, for fields shown as text (`x-arbor-text`, a datatype's values): `slotText`. */
    textOf?: (name: string, value: Value) => string;
}

/**
 * A form for one element, drawn from its JSON Schema. It edits only what the
 * schema describes, so a host can use it next to the text: every change goes
 * back through `onChange`, and new `values` come back once the text is reparsed.
 */
export default function PropertyForm({ schema, values, onChange, readOnly, textOf }: PropertyFormProps) {
    const names = Object.keys(schema.properties);
    if (names.length === 0) return <Text size="sm" c="dimmed">{schema.title} has no properties or references.</Text>;
    return (
        <Stack gap="xs">
            {names.map(name => (
                <Field key={name} name={name} schema={schema.properties[name]} value={values[name]}
                    required={schema.required.includes(name)} readOnly={readOnly || schema.properties[name].readOnly} textOf={textOf}
                    onChange={v => onChange(name, v)} />
            ))}
        </Stack>
    );
}

interface FieldProps<S extends FieldSchema = FieldSchema> {
    name: string;
    schema: S;
    value: Value | undefined;
    required: boolean;
    readOnly?: boolean;
    textOf?: (name: string, value: Value) => string;
    onChange: (value: Value | undefined) => void;
}

function Field(props: FieldProps) {
    const { schema, value, required, readOnly, onChange } = props;
    const shownAsText = schema.type === 'array' ? schema.items['x-arbor-text'] : schema['x-arbor-text'];
    const control = shownAsText ? textControl(props)
        : schema.type === 'array' ? listControl(props as FieldProps<ListSchema>) : scalarControl(props as FieldProps<ScalarSchema>);
    const written = value !== undefined;
    return (
        <Group gap={4} wrap="nowrap" align="flex-end">
            <div style={{ flex: 1, minWidth: 0 }}>{control}</div>
            {written && !readOnly && (
                <Tooltip label={required ? 'Remove (required, so the text will show an error)' : 'Remove from the text'}>
                    <ActionIcon variant="subtle" color="gray" size="sm" mb={6} aria-label={`Remove ${props.name}`}
                        onClick={() => onChange(undefined)}>
                        ×
                    </ActionIcon>
                </Tooltip>
            )}
        </Group>
    );
}

function label({ name, required }: FieldProps): ReactNode {
    return <>{name}{required && <Text span c="red"> *</Text>}</>;
}

/** What the field holds, e.g. `OnDeleteAction` or `-> Type`; the kind/enum's short name. */
function description(schema: FieldSchema): string | undefined {
    const t = schema['x-arbor-type']?.split('.').at(-1);
    const many = schema.type === 'array' ? ' (list)' : '';
    if (schema['x-arbor-feature'] === 'ref') return `-> ${t ?? '?'}${many}`;
    return t ? `${t}${many}` : many ? `list of ${(schema as ListSchema).items.type}` : undefined;
}

const placeholder = (s: { default?: IRScalar }) => (s.default !== undefined ? `default: ${String(s.default)}` : undefined);

/** A value the form can't edit (a datatype's), as the text writes it. */
function textControl(props: FieldProps) {
    const { schema, value, textOf, name } = props;
    const text = value === undefined ? '' : textOf ? textOf(name, value) : JSON.stringify(value);
    return <TextInput label={label(props)} description={description(schema) ?? 'Edit in the text'} size="xs" readOnly value={text} />;
}

function scalarControl(props: FieldProps<ScalarSchema>) {
    const { schema, value, readOnly, onChange } = props;
    const common = { label: label(props), description: description(schema), size: 'xs' as const, disabled: readOnly };

    if (schema.oneOf || schema.enum) {
        const data = schema.oneOf?.map(o => ({ value: o.const, label: o.title })) ?? schema.enum!;
        return (
            <Select {...common} data={data} value={value === undefined ? null : String(value)} placeholder={placeholder(schema)}
                searchable nothingFoundMessage="Nothing fits"
                onChange={v => onChange(v ?? undefined)} />
        );
    }
    switch (schema.type) {
        case 'boolean':
            return (
                <Switch {...common} label={<>{label(props)}{value === undefined && <Text span size="xs" c="dimmed"> (default)</Text>}</>}
                    checked={value === undefined ? schema.default === true : value === true}
                    onChange={e => onChange(e.currentTarget.checked)} />
            );
        case 'integer':
        case 'number':
            return <NumberDraft {...common} integer={schema.type === 'integer'} value={value as number | undefined}
                placeholder={placeholder(schema)} onCommit={onChange} />;
        default:
            return <TextDraft {...common} value={value as string | undefined} placeholder={placeholder(schema)} onCommit={onChange} />;
    }
}

function listControl(props: FieldProps<ListSchema>) {
    const { schema, value, readOnly, onChange } = props;
    const items = Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)];
    const common = { label: label(props), description: description(schema), size: 'xs' as const, disabled: readOnly };
    const commit = (next: string[]) => {
        const typed = schema.items.type === 'integer' || schema.items.type === 'number' ? next.map(Number).filter(Number.isFinite)
            : schema.items.type === 'boolean' ? next.map(v => v === 'true') : next;
        onChange(typed.length ? typed : undefined);
    };
    if (schema.items.oneOf || schema.items.enum) {
        const data = schema.items.oneOf?.map(o => ({ value: o.const, label: o.title })) ?? schema.items.enum!;
        return <MultiSelect {...common} data={data} value={items} searchable maxValues={schema.maxItems} onChange={commit} />;
    }
    return <TagsInput {...common} value={items} maxTags={schema.maxItems} placeholder="Type, then Enter" onChange={commit} />;
}

interface DraftProps<T> {
    label: ReactNode;
    description?: string;
    size: 'xs';
    disabled?: boolean;
    placeholder?: string;
    value: T | undefined;
    onCommit: (value: T | undefined) => void;
}

/** Keeps typing local and reports on blur or Enter, so each keystroke isn't a text edit. Empty removes the slot. */
function TextDraft({ value, onCommit, ...rest }: DraftProps<string>) {
    const [draft, setDraft] = useState(value ?? '');
    useEffect(() => { setDraft(value ?? ''); }, [value]);
    const commit = () => { if (draft !== (value ?? '')) onCommit(draft === '' ? undefined : draft); };
    return (
        <TextInput {...rest} value={draft} onChange={e => setDraft(e.currentTarget.value)} onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(value ?? ''); }} />
    );
}

function NumberDraft({ value, onCommit, integer, ...rest }: DraftProps<number> & { integer: boolean }) {
    const [draft, setDraft] = useState<string | number>(value ?? '');
    useEffect(() => { setDraft(value ?? ''); }, [value]);
    const commit = () => {
        const next = draft === '' ? undefined : Number(draft);
        if (next !== value && (next === undefined || Number.isFinite(next))) onCommit(next);
    };
    return (
        <NumberInput {...rest} value={draft} allowDecimal={!integer} onChange={setDraft} onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(value ?? ''); }} />
    );
}
