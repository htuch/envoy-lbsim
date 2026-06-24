// Node smoke test for the Wasm LB brick. Verifies the real Envoy EDF scheduler,
// compiled to Wasm and called across the Embind boundary, reproduces weighted
// round-robin proportions. Skips gracefully (exit 0) when the artifact has not
// been built, so `pnpm -r test` stays green in environments without emsdk; the
// CI wasm job builds first, so it runs for real there.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const artifact = fileURLToPath(new URL('../build/edf_smoke.mjs', import.meta.url));

if (!existsSync(artifact)) {
  console.log(
    '[wasm-lb smoke] artifact not built; run `pnpm --filter @elbsim/wasm-lb build` (needs emsdk). skipping.',
  );
  process.exit(0);
}

const { default: createLbModule } = await import(artifact);
const mod = await createLbModule();

// Weights 1..4; with many picks, each host's share approaches weight / sum.
const weights = new mod.VectorDouble();
for (const w of [1, 2, 3, 4]) weights.push_back(w);
const picks = 400_000;
const result = mod.edfPickCounts(weights, picks);

const counts = [];
for (let i = 0; i < result.size(); i++) counts.push(result.get(i));
const total = counts.reduce((a, b) => a + b, 0);
const sumW = 1 + 2 + 3 + 4;

let ok = total === picks;
const lines = [];
for (let i = 0; i < counts.length; i++) {
  const observed = counts[i] / total;
  const expected = (i + 1) / sumW;
  const err = Math.abs(observed - expected);
  if (err > 0.01) ok = false;
  lines.push(
    `  host ${i} w=${i + 1}  observed=${(observed * 100).toFixed(2)}%  expected=${(expected * 100).toFixed(2)}%`,
  );
}

console.log('[wasm-lb smoke] real Envoy EDF -> Wasm -> Embind');
console.log(lines.join('\n'));

if (!ok) {
  console.error('[wasm-lb smoke] FAILED: distribution off or pick count mismatch');
  process.exit(1);
}
console.log('[wasm-lb smoke] ok');
