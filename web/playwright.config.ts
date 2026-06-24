import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end config for the dashboard. These tests drive a real browser against
 * the dev server, which is the only way to prove behaviors units cannot reach:
 * real uPlot canvas rendering, the live brush highlight, SharedArrayBuffer
 * cross-origin isolation, and the worker data path. The dev server (not a
 * static build) is used because it emits the COOP/COEP headers SharedArrayBuffer
 * requires (see vite.config.ts).
 */
const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
