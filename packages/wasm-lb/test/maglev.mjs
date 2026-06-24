// Golden + fidelity test for the maglev lift: the REAL Envoy MaglevLoadBalancer
// driven through the REAL LoadBalancerBase + thread-aware factory (the unmodified
// source/extensions/load_balancing_policies/{common,maglev}/*.cc), compiled to
// Wasm and exercised across the Embind ABI.
//
// The golden case asserts the Wasm table matches, slot for slot, the table built
// by the independent lb_core extract-track oracle (test/maglev_golden.json) for
// identical {backendId, weight} inputs -- proving the lift is bit-faithful to the
// algorithm (same xxhash, same permutation math, same sort). The remaining cases
// cover the behaviors an LB must get right: weight-proportional distribution,
// determinism, maglev's minimal-disruption guarantee, and -- exercising the real
// base specifically -- health filtering, panic mode, and priority failover.
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

const HEALTHY = 2;
const PANIC_THRESHOLD = 50;
const OVERPROVISIONING = 140;

// Build a maglev table over a host set and return its per-slot backend table via
// the Embind ABI (inspect() reads every slot through chooseHost). Drives the real
// Envoy base: by default a single priority of all-healthy hosts in one locality.
function buildTable(backends, weights, tableSize, opts = {}) {
  const { healths = backends.map(() => HEALTHY), priorities = backends.map(() => 0) } = opts;
  const lb = mod.createMaglevLb(tableSize, false, PANIC_THRESHOLD, OVERPROVISIONING, 0);
  const bv = new mod.VectorInt();
  const wv = new mod.VectorDouble();
  const hv = new mod.VectorInt();
  const pv = new mod.VectorInt();
  const regions = new mod.VectorString();
  const zones = new mod.VectorString();
  for (let i = 0; i < backends.length; i++) {
    bv.push_back(backends[i]);
    wv.push_back(weights[i]);
    hv.push_back(healths[i]);
    pv.push_back(priorities[i]);
    regions.push_back('');
    zones.push_back('');
  }
  lb.updateHosts(bv, wv, hv, pv, regions, zones);
  for (const v of [bv, wv, hv, pv, regions, zones]) v.delete();
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

// 5. Health filtering (real LoadBalancerBase): unhealthy hosts are partitioned
// out before the table is built, so they never receive traffic.
{
  const t = buildTable([1, 2, 3], [1, 1, 1], 1021, { healths: [HEALTHY, 0, HEALTHY] });
  const present = new Set(t.table.filter((b) => b >= 0));
  check(
    'unhealthy host excluded from table',
    !present.has(2) && present.has(1) && present.has(3),
    `present=${[...present].sort((a, b) => a - b)}`,
  );
}

// 6. Panic mode (real LoadBalancerBase): with healthy hosts below the panic
// threshold (here zero healthy), the cluster routes across ALL hosts rather than
// dropping traffic.
{
  const t = buildTable([1, 2, 3], [1, 1, 1], 1021, { healths: [0, 0, 0] });
  const present = new Set(t.table.filter((b) => b >= 0));
  check(
    'panic mode routes over all hosts',
    present.size === 3,
    `present=${[...present].sort((a, b) => a - b)}`,
  );
}

// 7. Priority failover (real LoadBalancerBase priority load): while P0 has healthy
// hosts it takes all traffic; when P0 is fully unhealthy, load shifts to P1.
{
  const healthyP0 = buildTable([1, 2, 3, 4], [1, 1, 1, 1], 1021, {
    priorities: [0, 0, 1, 1],
    healths: [HEALTHY, HEALTHY, HEALTHY, HEALTHY],
  });
  const p0 = new Set(healthyP0.table.filter((b) => b >= 0));
  check(
    'priority 0 serves while healthy',
    p0.has(1) && p0.has(2) && !p0.has(3) && !p0.has(4),
    `present=${[...p0].sort((a, b) => a - b)}`,
  );

  const failover = buildTable([1, 2, 3, 4], [1, 1, 1, 1], 1021, {
    priorities: [0, 0, 1, 1],
    healths: [0, 0, HEALTHY, HEALTHY],
  });
  const p1 = new Set(failover.table.filter((b) => b >= 0));
  check(
    'failover to priority 1 when P0 down',
    p1.has(3) && p1.has(4) && !p1.has(1) && !p1.has(2),
    `present=${[...p1].sort((a, b) => a - b)}`,
  );
}

if (failures > 0) {
  console.error(`[wasm-lb maglev] FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('[wasm-lb maglev] ok');
