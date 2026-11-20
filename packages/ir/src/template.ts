/**
 * Label templates: text with `{slot}` placeholders, and optional parts
 * `{? … }` that are shown only when every placeholder directly in them has a
 * value. A UML transition is `"{trigger}{? [{guard}]}{? / {effect}}"`: just
 * `returned` when only the trigger is set, `returned [late] / chargeFine()`
 * when all three are.
 *
 * Plain substitution, interpreted here: nothing in a template is evaluated.
 * A `{` that doesn't start a placeholder or an optional part, and a `}` that
 * doesn't close one, are text.
 */

type Part = { text: string } | { slot: string } | { optional: Part[] };

/** Looks up a placeholder's text; undefined or "" means it has no value. */
export type TemplateValues = (slot: string) => string | undefined;

const SLOT = /^\{(\w+)\}/;

function parse(template: string): { parts: Part[]; unclosed: number } {
    const root: Part[] = [];
    const stack: Part[][] = [root];
    let text = '';
    const flush = () => { if (text) stack[stack.length - 1].push({ text }); text = ''; };
    for (let i = 0; i < template.length;) {
        const rest = template.slice(i);
        const slot = SLOT.exec(rest);
        if (slot) {
            flush();
            stack[stack.length - 1].push({ slot: slot[1] });
            i += slot[0].length;
        } else if (rest.startsWith('{?')) {
            flush();
            const optional: Part[] = [];
            stack[stack.length - 1].push({ optional });
            stack.push(optional);
            i += 2;
        } else if (rest[0] === '}' && stack.length > 1) {
            flush();
            stack.pop();
            i += 1;
        } else {
            text += rest[0];
            i += 1;
        }
    }
    flush();
    return { parts: root, unclosed: stack.length - 1 };
}

function render(parts: Part[], values: TemplateValues): { text: string; missing: boolean } {
    let text = '', missing = false;
    for (const p of parts) {
        if ('text' in p) text += p.text;
        else if ('slot' in p) {
            const v = values(p.slot);
            if (v) text += v; else missing = true;
        } else {
            const inner = render(p.optional, values);
            if (!inner.missing) text += inner.text;
        }
    }
    return { text, missing };
}

/** The template with its placeholders filled in, and its optional parts left out where a value is missing. */
export function fillTemplate(template: string, values: TemplateValues): string {
    return render(parse(template).parts, values).text;
}

/** Every placeholder the template names, optional parts included, in order, without repeats. */
export function templateSlots(template: string): string[] {
    const out = new Set<string>();
    const walk = (parts: Part[]) => {
        for (const p of parts) {
            if ('slot' in p) out.add(p.slot);
            else if ('optional' in p) walk(p.optional);
        }
    };
    walk(parse(template).parts);
    return [...out];
}

/** A problem with the template's shape, if it has one: an optional part that's never closed. */
export function checkTemplate(template: string): string | undefined {
    const { unclosed } = parse(template);
    return unclosed ? `an optional part '{?' is never closed with '}'` : undefined;
}
