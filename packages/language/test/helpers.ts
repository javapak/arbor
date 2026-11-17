import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWorkspace, type LoadResult } from '../src/cli/load.js';

const examples = fileURLToPath(new URL('../../../examples/', import.meta.url));
export const SOFTWARE = readFileSync(examples + 'software.mdsl', 'utf8');
export const PERSISTENCE = readFileSync(examples + 'persistence.mdsl', 'utf8');
export const SHOP = readFileSync(examples + 'shop.mdsl', 'utf8');

/** Load a model snippet against the example profiles. */
export function withProfiles(model: string, extra: Record<string, string> = {}): Promise<LoadResult> {
    return loadWorkspace([
        { uri: 'software.mdsl', text: SOFTWARE },
        { uri: 'persistence.mdsl', text: PERSISTENCE },
        ...Object.entries(extra).map(([uri, text]) => ({ uri, text })),
        { uri: 'test.mdsl', text: model }
    ]);
}

export function codes(r: LoadResult): string[] {
    return r.diagnostics.filter(d => d.severity === 'error').map(d => d.code ?? 'linking');
}
