// Golden + property test for the maglev lift: the REAL Envoy OriginalMaglevTable
// (source/extensions/load_balancing_policies/maglev/maglev_lb.cc) compiled to
// Wasm and driven across the Embind ABI.
//
// The golden case asserts the Wasm table matches, slot for slot, the table built
// by the independent lb_core extract-track oracle (test/maglev_golden.json) for
// identical {backendId, weight} inputs -- proving the lift is bit-faithful to the
// algorithm (same xxhash, same permutation math, same sort). The property cases
// cover the behaviors that matter for an LB: weight-proportional distribution,
// determinism, and maglev's defining minimal-disruption guarantee on membership
// change.
//
// Skips gracefully (exit 0) when the artifact is not built so `pnpm -r test`
// stays green without emsdk; CI's wasm job builds first and runs it for real.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const artifact = fileURLToPath(new URL('../build/lb.mjs', import.meta.url));
if (!existsSync(artifact)) {
  console.log(
    '[wasm-lb maglev] artifact not built; run `pnpm --filter @elbsim/wasm-lb build` (needs emsdk). skipping.',
  );
  process.exit(0);
}

const { default: createLbModule } = await import(artifact);
const mod = await createLbModule();

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

// Build a maglev table over {backends, weights} and return its per-slot backend
// table via the Embind ABI (inspect() reads every slot through chooseHost).
function buildTable(backends, weights, tableSize) {
  const lb = mod.createMaglevLb(tableSize, false);
  const bv = new mod.VectorInt();
  const wv = new mod.VectorDouble();
  for (let i = 0; i < backends.length; i++) {
    bv.push_back(backends[i]);
    wv.push_back(weights[i]);
  }
  lb.updateHosts(bv, wv);
  bv.delete();
  wv.delete();
  const structure = lb.inspect();
  const table = structure.table;
  lb.delete();
  return { structure, table };
}

console.log('[wasm-lb maglev] real Envoy OriginalMaglevTable -> Wasm -> Embind');

// 1. Golden: exact slot-for-slot match against the lb_core oracle fixture.
const golden = JSON.parse(readFileSync(new URL('./maglev_golden.json', import.meta.url)));
const { structure, table } = buildTable(golden.backends, golden.weights, golden.tableSize);
check('inspect kind is maglev', structure.kind === 'maglev', `got '${structure.kind}'`);
check('inspect tableSize', structure.tableSize === golden.tableSize, `got ${structure.tableSize}`);
check('table length', table.length === golden.table.length, `got ${table.length}`);
let firstMismatch = -1;
for (let i = 0; i < golden.table.length; i++) {
  if (table[i] !== golden.table[i]) {
    firstMismatch = i;
    break;
  }
}
check(
  'table matches oracle slot-for-slot',
  firstMismatch === -1,
  firstMismatch === -1
    ? `${table.length} slots`
    : `slot ${firstMismatch}: wasm=${table[firstMismatch]} oracle=${golden.table[firstMismatch]}`,
);

// 2. Distribution: on the default 65537 table, each host's slot share tracks its
// weight (maglev's near-perfect balancing).
{
  const backends = [1, 2, 3, 4];
  const weights = [1, 2, 3, 4];
  const sumW = 10;
  const { table: t } = buildTable(backends, weights, 65537);
  const counts = Object.fromEntries(backends.map((b) => [b, 0]));
  for (const b of t) counts[b]++;
  let worst = 0;
  for (let i = 0; i < backends.length; i++) {
    const observed = counts[backends[i]] / t.length;
    const expected = weights[i] / sumW;
    worst = Math.max(worst, Math.abs(observed - expected));
  }
  check('weighted distribution within 1%', worst < 0.01, `worst err ${(worst * 100).toFixed(3)}%`);
}

// 3. Determinism: identical inputs produce an identical table.
{
  const a = buildTable([10, 20, 30, 40, 50], [1, 1, 2, 3, 5], 1021).table;
  const b = buildTable([10, 20, 30, 40, 50], [1, 1, 2, 3, 5], 1021).table;
  check(
    'deterministic rebuild',
    a.every((v, i) => v === b[i]),
  );
}

// 4. Minimal disruption: removing one host should remap only a small fraction of
// slots (roughly its own share), not reshuffle the whole table -- the property
// maglev exists to provide.
{
  const tableSize = 65537;
  const full = buildTable([1, 2, 3, 4, 5], [1, 1, 1, 1, 1], tableSize).table;
  const minus = buildTable([1, 2, 3, 4], [1, 1, 1, 1], tableSize).table; // dropped host 5
  let movedAmongSurvivors = 0;
  let slotsNotOnDropped = 0;
  for (let i = 0; i < tableSize; i++) {
    if (full[i] !== 5) {
      slotsNotOnDropped++;
      if (full[i] !== minus[i]) movedAmongSurvivors++;
    }
  }
  // Slots that pointed at survivors should overwhelmingly stay put; only a small
  // residual churn is expected from maglev's reshuffle. Allow a generous 5% bound.
  const churn = movedAmongSurvivors / slotsNotOnDropped;
  check(
    'minimal disruption on host removal',
    churn < 0.05,
    `survivor churn ${(churn * 100).toFixed(2)}%`,
  );
}

if (failures > 0) {
  console.error(`[wasm-lb maglev] FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('[wasm-lb maglev] ok');
