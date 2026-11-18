// Bundles the extension host, the language server and the webview.
//   node build.mjs           one build
//   node build.mjs --watch   rebuild on change
// Run the root build first (`npm run build` at the repo root): the server and
// the webview use the packages' compiled `out/` directories.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const watch = process.argv.includes('--watch');
const require = createRequire(import.meta.url);

// webgpu-flow isn't a published package yet: use the clone at the repo root, as the studio does.
// Its source files would otherwise pick up packages from webgpu-flow/node_modules, giving the
// page two Reacts (broken hooks) and two Mantines (broken context). Resolve shared ones from here.
const SHARED = ['react', 'react-dom', '@mantine/core', '@mantine/hooks', '@fluentui/react-icons', 'zustand', 'elkjs', 'allotment'];
const dedupe = {
    name: 'dedupe',
    setup(build) {
        const filter = new RegExp(`^(${SHARED.map(s => s.replace('/', '\\/')).join('|')})(\\/.*)?$`);
        build.onResolve({ filter }, args => {
            if (args.pluginData === 'dedupe') return undefined;
            return build.resolve(args.path, { kind: args.kind, resolveDir: here, pluginData: 'dedupe' });
        });
    },
};

const node = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, logLevel: 'info' };

const builds = [
    { ...node, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', external: ['vscode'] },
    { ...node, entryPoints: [require.resolve('@arbor/language/server-node')], outfile: 'dist/server.cjs' },
    {
        entryPoints: ['webview/main.tsx'],
        outfile: 'media/webview.js',
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        jsx: 'automatic',
        sourcemap: true,
        minify: !watch,
        logLevel: 'info',
        alias: { 'webgpu-flow': `${repoRoot}webgpu-flow/src/index.ts` },
        define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'), 'import.meta.env.DEV': String(watch) },
        loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
        plugins: [dedupe],
    },
];

await mkdir(`${here}syntaxes`, { recursive: true });
await copyFile(`${repoRoot}packages/language/syntaxes/arbor.tmLanguage.json`, `${here}syntaxes/arbor.tmLanguage.json`);

if (watch) {
    for (const options of builds) await (await esbuild.context(options)).watch();
} else {
    await Promise.all(builds.map(options => esbuild.build(options)));
}
