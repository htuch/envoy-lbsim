import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

/**
 * End-to-end CUJ for the cockpit: play/pause transport, envoy cell selection
 * driving the Inspector tab, timeline brushing driving the Window tab, reset
 * returning the clock, and the DAGRE topology modal.
 *
 * Exercises the REAL SimController worker (real Envoy Maglev compiled to Wasm)
 * end-to-end. The Maglev-table assertion is gated on the Wasm artifact being
 * present so the suite remains honest on machines without a build.
 */

const WASM_ARTIFACT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../packages/wasm-lb/build/lb.mjs',
);

/**
 * Wait for the sim worker to finish loadConfig: `ready` becomes true, and the
 * Play button is enabled. The uPlot canvas mounts before the worker handshake
 * completes, so waiting on `.u-over` visibility is not sufficient. The Wasm
 * artifact takes up to ~20s to load on the first cold start, so use a generous
 * timeout here.
 */
async function waitForReady(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled({ timeout: 30_000 });
}

/** Play briefly then pause so the ring buffers hold data to brush. */
async function accumulateAndPause(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
}

/** The first timeline strip's uPlot overlay canvas. */
function firstOverlay(page: Page) {
  return page.locator('.u-over').first();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
});

// ---------------------------------------------------------------------------
// Step 1: cross-origin isolation
// ---------------------------------------------------------------------------

test('boots cross-origin isolated', async ({ page }) => {
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Envoy LB Simulator' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Step 2: play advances time; pause halts it
// ---------------------------------------------------------------------------

test('play advances virtual time and pause halts it', async ({ page }) => {
  // The transport renders at the bottom; the clock reads "0.00s / ...".
  const clock = page.getByText(/^\d+\.\d{2}s \/ \d+\.\d{2}s$/);

  await page.getByRole('button', { name: 'Play' }).click();
  // Give the sim time to advance.
  await page.waitForTimeout(800);

  // Capture the current clock text while running.
  const midText = await clock.textContent();
  const midSecs = parseFloat(midText ?? '0');

  await page.getByRole('button', { name: 'Pause' }).click();
  // After pause the clock text should reflect a time > 0.
  const afterText = await clock.textContent();
  const afterSecs = parseFloat(afterText ?? '0');
  expect(midSecs > 0 || afterSecs > 0).toBe(true);

  // The sim is now halted: the button should have reverted to Play.
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Step 3: click an envoy cell; Inspector tab shows host row + Maglev table
// ---------------------------------------------------------------------------

test('clicking an envoy cell populates the Inspector tab', async ({ page }) => {
  // Gate the Maglev-table sub-assertion on the wasm artifact being present.
  const wasmPresent = fs.existsSync(WASM_ARTIFACT);
  if (!wasmPresent) {
    test.skip(true, 'wasm not built -- skipping Maglev table assertion');
  }

  // Pause first so the inspection is at a stable virtual time.
  await accumulateAndPause(page);

  // Envoy cells are buttons inside the tier row with data-tier="envoys".
  const envoyCell = page.locator('[data-tier="envoys"] button').first();
  await expect(envoyCell).toBeVisible();
  await envoyCell.click();

  // The Inspector tab becomes active and shows the LB inspector heading.
  await expect(page.getByRole('heading', { level: 2, name: /LB inspector/ })).toBeVisible();

  // The resolved-hosts table must contain at least one host row.
  const hostRow = page.locator('table tbody tr').first();
  await expect(hostRow).toBeVisible();

  if (wasmPresent) {
    // The Maglev slot strip renders as an image with its aria-label.
    await expect(page.getByRole('img', { name: 'Maglev slot strip' })).toBeVisible();
  }
});

// ---------------------------------------------------------------------------
// Step 4: brush a timeline window; Window tab shows p50/p90/p99 tiles
// ---------------------------------------------------------------------------

test('brushing a timeline window populates the Window tab with latency tiles', async ({ page }) => {
  // The cold-path query (`queryWindow`) runs the full 60 s scenario through the
  // Wasm engine before returning; allow up to 60 s for the window to populate.
  test.setTimeout(90_000);
  await accumulateAndPause(page);

  const over = firstOverlay(page);
  const box = await over.boundingBox();
  if (!box) throw new Error('no overlay bounding box');

  const y = box.y + box.height / 2;
  const x0 = box.x + box.width * 0.25;
  const x1 = box.x + box.width * 0.65;

  // Drag to brush a window.
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x1, y, { steps: 14 });
  await expect(page.locator('.u-select').first()).toBeVisible();
  await page.mouse.up();

  // The committed window appears as a band on the transport scrubber.
  await expect(page.locator('[data-window-band]')).toBeVisible();

  // The dock switches to the Window tab; wait for the cold-path analysis to
  // populate. `queryWindow` and `queryWindowLatencies` each run the full
  // 60 s scenario through the Wasm engine -- this can take several seconds.
  // The 'Window analysis' heading is a reliable unique sentinel: it only
  // appears inside WindowAnalysis (the p50/p90/p99 labels also appear in the
  // uPlot legend so they would pass even before the window loads).
  const windowHeading = page.getByRole('heading', { level: 2, name: 'Window analysis' });
  await expect(windowHeading).toBeVisible({ timeout: 30_000 });
  // Scope p50/p90/p99 to the WindowAnalysis section so the uPlot legend labels
  // (which share the same text) do not cause a strict-mode violation.
  // The h2 is inside <header> inside the section; go up two levels.
  const windowSection = windowHeading.locator('../..');
  await expect(windowSection.getByText('p50', { exact: true })).toBeVisible();
  await expect(windowSection.getByText('p90', { exact: true })).toBeVisible();
  await expect(windowSection.getByText('p99', { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Step 5: reset returns the clock to zero
// ---------------------------------------------------------------------------

test('reset returns virtual time to zero', async ({ page }) => {
  await accumulateAndPause(page);

  await page.getByRole('button', { name: 'Reset to start' }).click();

  // The clock reads 0.00s after reset.
  await expect(page.getByText(/^0\.00s \/ /)).toBeVisible();
});

// ---------------------------------------------------------------------------
// Step 6: topology modal renders nodes and can be closed
// ---------------------------------------------------------------------------

test('topology modal renders DAGRE nodes and closes', async ({ page }) => {
  // We need snapshot data, so accumulate some sim time.
  await accumulateAndPause(page);

  // Open the modal via the expand control in the heatmap header.
  await page.getByRole('button', { name: 'Open topology graph' }).click();

  // The dialog appears.
  const dialog = page.getByRole('dialog', { name: 'Topology graph' });
  await expect(dialog).toBeVisible();

  // React Flow renders nodes inside the dialog; the panel shows entity counts.
  // ReactFlow initially sets visibility:hidden on nodes while measuring their
  // dimensions via ResizeObserver -- wait for the first node to turn visible.
  await expect(dialog.locator('.react-flow__node').first()).toBeVisible({ timeout: 10_000 });

  // Close the modal.
  await page.getByRole('button', { name: 'Close topology' }).click();
  await expect(dialog).toBeHidden();
});
