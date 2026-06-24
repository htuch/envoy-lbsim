/// <reference types="vitest/config" />
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { comlink } from 'vite-plugin-comlink';
import { defineConfig } from 'vitest/config';

// The Emscripten-built lb.mjs locates lb.wasm via `new URL("lb.wasm",
// import.meta.url)`. Vite bundles lb.mjs into a hashed asset chunk but does
// not automatically follow and emit the runtime-loaded .wasm binary alongside
// it. This plugin copies lb.wasm into the build output's assetsDir so the
// browser can fetch it relative to the lb chunk.
function copyWasmPlugin(): Plugin {
  return {
    name: 'copy-lb-wasm',
    apply: 'build',
    closeBundle() {
      const src = fileURLToPath(new URL('../packages/wasm-lb/build/lb.wasm', import.meta.url));
      const outDir = fileURLToPath(new URL('./dist/assets', import.meta.url));
      try {
        mkdirSync(outDir, { recursive: true });
        copyFileSync(src, `${outDir}/lb.wasm`);
      } catch (_err) {
        this.warn(
          'lb.wasm not found in packages/wasm-lb/build; the production build will ship a non-functional worker. Run `pnpm run wasm:build` first.',
        );
      }
    },
  };
}

// SharedArrayBuffer (used for the telemetry ring buffers shared with the sim
// worker) requires cross-origin isolation. Emit COOP/COEP in dev and preview;
// production hosting must send the same headers.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react(), tailwindcss(), comlink(), copyWasmPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
    plugins: () => [comlink()],
  },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // Unit tests only; the Playwright E2E suite under e2e/ (*.spec.ts) is run
    // separately via `pnpm --filter web test:e2e`, not by Vitest.
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/test-setup.ts',
        // Worker bootstrap glue: real Worker + Comlink.expose, not runnable under
        // jsdom. The runner logic they wrap is unit-tested directly (runner.test
        // and controller.test). sim-worker.ts also requires the Wasm artifact.
        'src/worker/mock-sim-worker.ts',
        'src/worker/sim-worker.ts',
        'src/worker/client.ts',
        '**/*.test.{ts,tsx}',
      ],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
