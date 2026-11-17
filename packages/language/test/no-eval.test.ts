import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Runs the compiled CLI (parse -> link -> validate -> IR -> flow graph) under
 * --disallow-code-generation-from-strings, Node's equivalent of a CSP without
 * 'unsafe-eval'. Any eval / new Function on that path, ours or a dependency's,
 * throws EvalError and fails this test.
 *
 * (The flag can't wrap vitest itself: its worker pool uses new Function.)
 * Requires `npm run build` first; `npm test` does that.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = root + 'packages/language/out/cli/main.js';
const FLAG = '--disallow-code-generation-from-strings';

describe('no runtime code generation', () => {
    it('the guard flag actually blocks new Function', () => {
        const r = spawnSync(process.execPath, [FLAG, '-e', 'new Function("return 1")'], { encoding: 'utf8' });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('EvalError');
    });

    it.runIf(existsSync(cli))('full pipeline runs with code generation disabled', () => {
        const files = ['software', 'persistence', 'shop'].map(n => `${root}examples/${n}.mdsl`);
        const r = spawnSync(process.execPath, [FLAG, cli, 'flow', ...files], { encoding: 'utf8' });
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout).nodes.length).toBeGreaterThan(0);
    });
});
