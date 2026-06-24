import { expect, type Page, test } from '@playwright/test';

/**
 * End-to-end coverage of the dashboard's user-facing behaviors that unit tests
 * (jsdom + a mocked uPlot) cannot prove: real canvas rendering, the live brush
 * highlight, lock-step zoom across strips, and the SharedArrayBuffer worker path.
 *
 * The brush-highlight test exists specifically because an earlier change hid the
 * uPlot select element to suppress a stray band and accidentally removed the
 * drag feedback entirely; a unit test could not have caught it.
 */

/** Play briefly then pause so the strips hold a window worth brushing. */
async function accumulateAndPause(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Pause' }).click();
}

/** The first timeline strip's uPlot overlay (Envoy in-flight). */
function firstOverlay(page: Page) {
  return page.locator('.u-over').first();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Wait for the worker to finish loadConfig (sets `ready`); the Play button
  // becomes enabled once `ready` is true. Waiting on the overlay alone is not
  // sufficient because the canvas mounts before the worker handshake completes.
  // The Wasm artifact can take up to ~20s to load on a cold start.
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled({ timeout: 30_000 });
});

test('boots cross-origin isolated with the default scenario', async ({ page }) => {
  // SharedArrayBuffer requires cross-origin isolation; prove the headers are live.
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Envoy LB Simulator' })).toBeVisible();
  await expect(page.getByRole('banner')).toContainText('maglev');
  // Ten gauge strips render (7 raw gauges + 3 derived timeline strips).
  // DerivedStrip canvases may mount a tick after the raw gauges; use toHaveCount
  // with a timeout so the assertion waits for all strips to appear.
  await expect(page.locator('.u-over')).toHaveCount(10);
});

test('play advances the virtual clock and pause halts it', async ({ page }) => {
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('banner')).toContainText('running');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('banner')).toContainText('paused');
});

test('brushing shows a live highlight, commits a window, and clears on release', async ({
  page,
}) => {
  await accumulateAndPause(page);

  const over = firstOverlay(page);
  const box = await over.boundingBox();
  if (!box) throw new Error('no overlay box');
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width * 0.3;
  const x1 = box.x + box.width * 0.6;

  // Drag without releasing: the brush highlight must be visible mid-gesture.
  // (This is the regression guard: hiding the uPlot select killed this feedback.)
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x1, y, { steps: 12 });
  await expect(page.locator('.u-select').first()).toBeVisible();

  // Release commits the window: the reset-zoom chip appears with a readout.
  await page.mouse.up();
  const reset = page.getByLabel('Reset zoom');
  await expect(reset).toBeVisible();
  await expect(reset).toContainText('s');

  // The transient highlight is cleared once the strips zoom to the window.
  await expect(page.locator('.u-select').first()).toBeHidden();

  // Reset returns to the live range and removes the chip.
  await reset.click();
  await expect(reset).toBeHidden();
});

test('a brush on one strip is the only one highlighted (no cross-strip band)', async ({ page }) => {
  await accumulateAndPause(page);

  const over = firstOverlay(page);
  const box = await over.boundingBox();
  if (!box) throw new Error('no overlay box');
  const y = box.y + box.height / 2;

  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 12 });

  // Source strip highlighted; siblings are not (lock-step zoom is store-driven,
  // not uPlot cursor-sync, so no mirrored select band appears on other strips).
  await expect(page.locator('.u-select').nth(0)).toBeVisible();
  await expect(page.locator('.u-select').nth(1)).toBeHidden();

  await page.mouse.up();
});
