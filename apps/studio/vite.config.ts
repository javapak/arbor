import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // webgpu-flow isn't a published package yet: use the clone at the repo root (git-ignored).
    alias: { 'webgpu-flow': `${repoRoot}webgpu-flow/src/index.ts` },
    // Its source files would otherwise pick up packages from webgpu-flow/node_modules,
    // giving the page two Reacts (broken hooks) and two Mantines (broken context).
    dedupe: ['react', 'react-dom', '@mantine/core', '@mantine/hooks', '@fluentui/react-icons', 'zustand', 'elkjs', 'allotment'],
  },
  server: { fs: { allow: [repoRoot] } },
  optimizeDeps: { exclude: ['elkjs/lib/elk.bundled.js'] },
  build: { commonjsOptions: { transformMixedEsModules: true } },
});
