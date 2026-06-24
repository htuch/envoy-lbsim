import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

/**
 * End-to-end tests for config changes being reflected in the LB inspector.
 * Covers three cases:
 *  1. Changing Maglev table size is reflected in the inspector.
 *  2. Non-prime Maglev table size surfaces an error modal (run is NOT reset).
 *  3. Changing ring_hash min/max ring sizes is reflected in the inspector.
 *
 * All tests exercise the real SimController worker (real Envoy Wasm) and are
 * gated on the Wasm artifact being present.
 */

const WASM_ARTIFACT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../packages/wasm-lb/build/lb.mjs',
);

async function waitForReady(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  test.skip(!fs.existsSync(WASM_ARTIFACT), 'wasm not built -- skipping config-inspector tests');
  await page.goto('/');
  await waitForReady(page);
});

// ---------------------------------------------------------------------------
// Case 1: maglev table size change is reflected in the inspector
// ---------------------------------------------------------------------------

test('maglev table size change is reflected in the inspector', async ({ page }) => {
  // The default policy is maglev. Fill in a new prime table size.
  await page.locator('#cfg-maglev').fill('4099');
  await page.getByRole('button', { name: 'Apply & reload' }).click();

  // The clock resets to 0.00s after reload.
  await expect(page.getByText(/^0\.00s \/ /)).toBeVisible({ timeout: 30_000 });

  // The inspector dock is the last aside; it must show the envoy heading.
  // e0 is selected by default, so click e1 to deselect e0 and inspect e1.
  await page.getByRole('button', { name: 'e1', exact: true }).click();
  const dock = page.locator('aside').last();
  await expect(dock).toContainText('LB inspector', { timeout: 10_000 });
  await expect(dock).toContainText('table_size');
  await expect(dock).toContainText('4099');
});

// ---------------------------------------------------------------------------
// Case 2: non-prime maglev table size shows an error modal, run is intact
// ---------------------------------------------------------------------------

test('non-prime maglev table size shows an error modal and does not reset', async ({ page }) => {
  // Advance the clock a little so it is > 0 before the rejected apply.
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();

  // Capture the current clock readout (should be > 0).
  const clockLocator = page.getByText(/\d+\.\d{2}s \/ \d+\.\d{2}s/);
  const clockBefore = await clockLocator.textContent();
  const secsBefore = parseFloat(clockBefore ?? '0');
  expect(secsBefore).toBeGreaterThan(0);

  // Fill in a non-prime table size and apply.
  await page.locator('#cfg-maglev').fill('4096');
  await page.getByRole('button', { name: 'Apply & reload' }).click();

  // An error dialog must appear containing the word "prime".
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText(/prime/i);

  // The clock must NOT have reset: the run is intact.
  const clockAfter = await clockLocator.textContent();
  const secsAfter = parseFloat(clockAfter ?? '0');
  expect(secsAfter).toBeGreaterThan(0);

  // Dismiss the dialog and confirm it closes.
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(dialog).toBeHidden();
});

// ---------------------------------------------------------------------------
// Case 3: ring_hash min/max ring sizes are reflected in the inspector
// ---------------------------------------------------------------------------

test('ring_hash min and max ring sizes are reflected in the inspector', async ({ page }) => {
  // Switch to ring_hash policy and configure sizes.
  await page.locator('select[aria-label="LB policy"]').selectOption('ring_hash');
  await page.locator('#cfg-ring').fill('2048');
  await page.locator('#cfg-ring-max').fill('8192');
  await page.getByRole('button', { name: 'Apply & reload' }).click();

  // Wait for the reload to complete (clock resets then Play becomes enabled).
  await expect(page.getByText(/^0\.00s \/ /)).toBeVisible({ timeout: 30_000 });
  await waitForReady(page);

  // Step once so there is a sim snapshot to inspect.
  await page.getByRole('button', { name: 'Step one sample interval' }).click();

  // Click e1 (not e0, which is the default selection) to inspect it.
  await page.getByRole('button', { name: 'e1', exact: true }).click();

  const dock = page.locator('aside').last();
  await expect(dock).toContainText('LB inspector', { timeout: 10_000 });
  await expect(dock).toContainText('sampled at 2048 points');
  await expect(dock).toContainText('configured min');
  await expect(dock).toContainText('2048');
  await expect(dock).toContainText('8192');
});
