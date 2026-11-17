import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWorkspace, type LoadResult } from '../src/cli/load.js';

const examples = fileURLToPath(new URL('../../../examples/', import.meta.url));
export const SOFTWARE = readFileSync(examples + 'software.arbor', 'utf8');
export const PERSISTENCE = readFileSync(examples + 'persistence.arbor', 'utf8');
export const SHOP = readFileSync(examples + 'shop.arbor', 'utf8');

/** Load a model snippet against the example profiles. */
export function withProfiles(model: string, extra: Record<string, string> = {}): Promise<LoadResult> {
    return loadWorkspace([
        { uri: 'software.arbor', text: SOFTWARE },
        { uri: 'persistence.arbor', text: PERSISTENCE },
        ...Object.entries(extra).map(([uri, text]) => ({ uri, text })),
        { uri: 'test.arbor', text: model }
    ]);
}

export function codes(r: LoadResult): string[] {
    return r.diagnostics.filter(d => d.severity === 'error').map(d => d.code ?? 'linking');
}
