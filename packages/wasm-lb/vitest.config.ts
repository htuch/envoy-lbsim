import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['bindings/**/*.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
