import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Parses, checks and runs expressions with the compiled package under
 * --disallow-code-generation-from-strings (see language's no-eval test): the
 * interpreter walks the tree, it never turns model text into JavaScript.
 */
const out = fileURLToPath(new URL('../out/index.js', import.meta.url));
const script = `
    const x = await import(${JSON.stringify(out)});
    const space = { has: () => true, get: (o, n) => o[n] ?? null, set: (o, n, v) => { o[n] = v; }, call: () => null,
        isKindOf: () => true, isTypeOf: () => true };
    const self = { fine: 2, items: new x.CollectionValue('Set', [1, 2, 3]) };
    const q = x.parseExpression('items->select(i | i > 1)->collect(i | i * fine)->sum() + (if fine > 1 then 1 else 0 endif)');
    const b = x.parseBlock('fine := fine * 10; return fine');
    console.log(JSON.stringify([x.evaluate(q.value, { space, self }), x.execute(b.value, { space, self }).returned]));
`;

describe('no runtime code generation', () => {
    it.runIf(existsSync(out))('expressions run with code generation disabled', () => {
        const r = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '-e', script], { encoding: 'utf8' });
        expect(r.stderr).toBe('');
        expect(JSON.parse(r.stdout)).toEqual([11, 20]);
    });
});
