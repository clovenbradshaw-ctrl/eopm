import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// Sibling to vite.config.js rather than a second entry inside it — keeps
// eopm's own build pipeline untouched. client.js's login/session-restore
// paths unconditionally touch the crypto WASM stack (even though collab
// rooms themselves are unencrypted), so this needs the same plugins.
export default defineConfig({
  root: 'collab',
  base: '/',
  plugins: [wasm(), topLevelAwait()],
  esbuild: { jsx: 'automatic' },
  build: {
    target: 'esnext',
    outDir: '../dist-collab',
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
    esbuildOptions: { jsx: 'automatic' },
  },
});
