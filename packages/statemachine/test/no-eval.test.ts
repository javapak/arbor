import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Loads the sample and runs its state machine with the compiled packages under --disallow-code-generation-from-strings. */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = root + 'packages/statemachine/out/index.js', language = root + 'packages/language/out/index.js';
const script = `
    import { readFileSync } from 'node:fs';
    const { loadWorkspace } = await import(${JSON.stringify(language)});
    const { Simulation, DAY } = await import(${JSON.stringify(out)});
    const files = ['uml', 'orm', 'primitives', 'library', 'loan'].map(n => ({ uri: n + '.arbor', text: readFileSync(${JSON.stringify(root + 'samples/uml/')} + n + '.arbor', 'utf8') }));
    const { ir } = await loadWorkspace(files);
    const sim = new Simulation(ir, 'lending.Loan.Lifecycle').start().advance(200 * DAY).send('paid');
    console.log(JSON.stringify({ finished: sim.finished, fine: sim.variables().fine }));
`;

describe('no runtime code generation', () => {
    it.runIf(existsSync(out) && existsSync(language))('a simulation runs with code generation disabled', () => {
        const r = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '-e', script], { encoding: 'utf8' });
        expect(r.stderr).toBe('');
        expect(JSON.parse(r.stdout)).toEqual({ finished: true, fine: '0' });
    });
});
