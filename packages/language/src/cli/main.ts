#!/usr/bin/env -S node --disallow-code-generation-from-strings
/**
 * arbor CLI
 *
 *   arbor check <files...>   diagnostics as JSON lines; exit 1 on errors
 *   arbor ir    <files...>   print the IR
 *   arbor flow  <files...>   print renderer nodes/edges (via the IR)
 *
 * Pass profile files and model files together; kinds resolve across files.
 */
import { readFile } from 'node:fs/promises';
import { toFlowGraph } from '@arbor/adapter-flow';
import { loadWorkspace } from './load.js';

async function main(argv: string[]): Promise<number> {
    const [cmd, ...files] = argv;
    if (!cmd || !['check', 'ir', 'flow'].includes(cmd) || files.length === 0) {
        process.stderr.write('usage: arbor <check|ir|flow> <files...>\n');
        return 2;
    }
    const sources = await Promise.all(files.map(async f => ({ uri: f, text: await readFile(f, 'utf8') })));
    const result = await loadWorkspace(sources);

    for (const d of result.diagnostics) process.stderr.write(JSON.stringify(d) + '\n');

    if (cmd === 'ir') process.stdout.write(JSON.stringify(result.ir, null, 2) + '\n');
    if (cmd === 'flow') process.stdout.write(JSON.stringify(toFlowGraph(result.ir), null, 2) + '\n');
    return result.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(code => process.exit(code), err => {
    process.stderr.write(String(err?.stack ?? err) + '\n');
    process.exit(2);
});
