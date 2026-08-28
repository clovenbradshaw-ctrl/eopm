import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/eopm/' : '/',
  plugins: [wasm(), topLevelAwait()],
  build: { target: 'esnext' },
  optimizeDeps: {
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
  // transcribe-worker.js is a real ES module (imports @huggingface/transformers,
  // which itself pulls in onnxruntime-web's wasm) — Vite's default worker
  // output is an IIFE, which can't contain an `import`, so the worker build
  // needs the same plugins as the main build plus the ES format.
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
});
