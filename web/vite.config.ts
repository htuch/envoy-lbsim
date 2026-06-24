/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { comlink } from 'vite-plugin-comlink';
import { defineConfig } from 'vitest/config';

// SharedArrayBuffer (used for the telemetry ring buffers shared with the sim
// worker) requires cross-origin isolation. Emit COOP/COEP in dev and preview;
// production hosting must send the same headers.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react(), tailwindcss(), comlink()],
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
        // jsdom. The runner logic they wrap is unit-tested directly (runner.test).
        'src/worker/mock-sim-worker.ts',
        'src/worker/client.ts',
        '**/*.test.{ts,tsx}',
      ],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
