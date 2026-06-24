// Fidelity test for the EDF-base lift: the REAL Envoy RoundRobin / LeastRequest /
// Random load balancers (the unmodified
// source/extensions/load_balancing_policies/{round_robin,least_request,random}/*.cc)
// driven through the REAL EdfLoadBalancerBase / ZoneAwareLoadBalancerBase, compiled
// to Wasm and exercised across the Embind ABI.
//
// These policies are stateful pickers (not thread-aware tables), so rather than a
// byte-exact golden this asserts the behaviors each must get right: round_robin's
// weight-proportional rotation, least_request's active-request preference (the
// rq_active_ stat fed across the ABI), random's uniform spread, and -- exercising
// the real base -- health filtering and panic mode. It also checks the EdfInspection
// schedule view for the weighted path.
//
// Skips gracefully (exit 0) when the artifact is not built so `pnpm -r test` stays
// green without emsdk; CI's wasm job builds first and runs it for real.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const artifact = fileURLToPath(new URL('../build/lb.mjs', import.meta.url));
if (!existsSync(artifact)) {
  console.log(
    '[wasm-lb edf] artifact not built; run `pnpm --filter @elbsim/wasm-lb build` (needs emsdk). skipping.',
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
const N_CHOICES = 0;
const FULL_SCAN = 1;

// Hand a host set to a live LB handle. Defaults: all healthy, priority 0, weight 1,
// zero active requests.
function setHosts(lb, backends, opts = {}) {
  const {
    weights = backends.map(() => 1),
    healths = backends.map(() => HEALTHY),
    priorities = backends.map(() => 0),
    active = backends.map(() => 0),
  } = opts;
  const bv = new mod.VectorInt();
  const wv = new mod.VectorDouble();
  const hv = new mod.VectorInt();
  const pv = new mod.VectorInt();
  const regions = new mod.VectorString();
  const zones = new mod.VectorString();
  const av = new mod.VectorInt();
  for (let i = 0; i < backends.length; i++) {
    bv.push_back(backends[i]);
    wv.push_back(weights[i]);
    hv.push_back(healths[i]);
    pv.push_back(priorities[i]);
    regions.push_back('');
    zones.push_back('');
    av.push_back(active[i]);
  }
  lb.updateHosts(bv, wv, hv, pv, regions, zones, av);
  for (const v of [bv, wv, hv, pv, regions, zones, av]) v.delete();
  return lb;
}

// Tally chooseHost picks over n requests (hash varies but is ignored by these
// non-hashed policies; it still advances the schedule / reseeds random draws).
function distribution(lb, n) {
  const counts = {};
  for (let i = 0; i < n; i++) {
    const b = lb.chooseHost(i);
    counts[b] = (counts[b] ?? 0) + 1;
  }
  return counts;
}

console.log('[wasm-lb edf] real Envoy RoundRobin/LeastRequest/Random -> Wasm -> Embind');

// ---- round_robin ----------------------------------------------------------

// 1. Equal weights: a clean rotation gives every host an equal share.
{
  const lb = mod.createRoundRobinLb(PANIC_THRESHOLD, OVERPROVISIONING, 0);
  setHosts(lb, [1, 2, 3, 4]);
  const counts = distribution(lb, 40_000);
  const shares = [1, 2, 3, 4].map((b) => (counts[b] ?? 0) / 40_000);
  const worst = Math.max(...shares.map((s) => Math.abs(s - 0.25)));
  check(
    'round_robin equal-weight rotation even',
    worst < 0.01,
    `worst err ${(worst * 100).toFixed(2)}%`,
  );
  lb.delete();
}

// 2. Weighted: EDF scheduling yields weight-proportional picks.
{
  const lb = mod.createRoundRobinLb(PANIC_THRESHOLD, OVERPROVISIONING, 0);
  setHosts(lb, [1, 2, 3, 4], { weights: [1, 2, 3, 4] });
  const counts = distribution(lb, 50_000);
  let worst = 0;
  for (const [i, b] of [1, 2, 3, 4].entries()) {
    const observed = (counts[b] ?? 0) / 50_000;
    worst = Math.max(worst, Math.abs(observed - (i + 1) / 10));
  }
  check(
    'round_robin weighted distribution within 1%',
    worst < 0.01,
    `worst err ${(worst * 100).toFixed(2)}%`,
  );
  lb.delete();
}

// 3. Health filtering (real base): unhealthy hosts get no picks.
{
  const lb = mod.createRoundRobinLb(PANIC_THRESHOLD, OVERPROVISIONING, 0);
  setHosts(lb, [1, 2, 3], { healths: [HEALTHY, 0, HEALTHY] });
  const got = new Set(Object.keys(distribution(lb, 6000)).map(Number));
  check(
    'round_robin excludes unhealthy',
    !got.has(2) && got.has(1) && got.has(3),
    `picked=${[...got].sort()}`,
  );
  lb.delete();
}

// 4. EdfInspection: the weighted schedule view lists every serving host with its
// LB weight, ordered by EDF deadline (heaviest first), with a schedule origin.
{
  const lb = mod.createRoundRobinLb(PANIC_THRESHOLD, OVERPROVISIONING, 0);
  setHosts(lb, [1, 2, 3, 4], { weights: [1, 2, 3, 4] });
  const s = lb.inspect();
  check('inspect kind is edf', s.kind === 'edf', `got '${s.kind}'`);
  check('inspect has currentTime', typeof s.currentTime === 'number');
  check('inspect lists all serving hosts', s.entries.length === 4, `${s.entries.length} entries`);
  const heaviestFirst = s.entries[0].backend === 4 && s.entries.at(-1).backend === 1;
  check(
    'entries ordered heaviest-first by deadline',
    heaviestFirst,
    JSON.stringify(s.entries.map((e) => e.backend)),
  );
  let monotonic = true;
  for (let i = 1; i < s.entries.length; i++)
    if (s.entries[i].deadline < s.entries[i - 1].deadline) monotonic = false;
  check('deadlines ascending', monotonic);
  lb.delete();
}

// ---- least_request --------------------------------------------------------

// 5. FULL_SCAN with equal weights always routes to the least-loaded host (the
// rq_active_ stat is fed across the ABI and read by the real picker).
{
  const lb = mod.createLeastRequestLb(2, 1.0, FULL_SCAN, PANIC_THRESHOLD, OVERPROVISIONING, 0);
  setHosts(lb, [1, 2, 3], { active: [5, 1, 3] });
  const counts = distribution(lb, 3000);
  check(
    'least_request FULL_SCAN picks least-active',
    (counts[2] ?? 0) === 3000,
    `counts=${JSON.stringify(counts)}`,
  );
  lb.delete();
}

// 6. N_CHOICES (P2C) with equal weights and equal load spreads roughly evenly.
{
  const lb = mod.createLeastRequestLb(2, 1.0, N_CHOICES, PANIC_THRESHOLD, OVERPROVISIONING, 0);
  setHosts(lb, [1, 2, 3, 4]);
  const counts = distribution(lb, 40_000);
  const worst = Math.max(...[1, 2, 3, 4].map((b) => Math.abs((counts[b] ?? 0) / 40_000 - 0.25)));
  check(
    'least_request P2C even when unloaded',
    worst < 0.02,
    `worst err ${(worst * 100).toFixed(2)}%`,
  );
  lb.delete();
}

// 7. EdfInspection reflects active-request weighting: with unequal weights the heap
// weight folds in active requests (weight / (active+1)^bias), so a loaded host
// ranks below an idle one of the same base weight.
{
  const lb = mod.createLeastRequestLb(2, 1.0, N_CHOICES, PANIC_THRESHOLD, OVERPROVISIONING, 0);
  setHosts(lb, [1, 2], { weights: [2, 2], active: [0, 9] });
  const s = lb.inspect();
  const w1 = s.entries.find((e) => e.backend === 1).weight;
  const w2 = s.entries.find((e) => e.backend === 2).weight;
  // host 1: 2/(0+1)=2 ; host 2: 2/(9+1)=0.2
  check(
    'least_request heap folds in active requests',
    w1 > w2 && Math.abs(w2 - 0.2) < 1e-9,
    `w1=${w1} w2=${w2}`,
  );
  lb.delete();
}

// ---- random ---------------------------------------------------------------

// 8. Random spreads roughly uniformly across healthy hosts.
{
  const lb = mod.createRandomLb(PANIC_THRESHOLD, OVERPROVISIONING, 0);
  setHosts(lb, [1, 2, 3, 4]);
  const counts = distribution(lb, 40_000);
  const worst = Math.max(...[1, 2, 3, 4].map((b) => Math.abs((counts[b] ?? 0) / 40_000 - 0.25)));
  check('random spread roughly uniform', worst < 0.02, `worst err ${(worst * 100).toFixed(2)}%`);
  check(
    'random inspection is stateless',
    lb.inspect().kind === 'none',
    `got '${lb.inspect().kind}'`,
  );
  lb.delete();
}

// 9. Panic mode (real base): with no healthy hosts, traffic routes over all hosts.
{
  const lb = mod.createRoundRobinLb(PANIC_THRESHOLD, OVERPROVISIONING, 0);
  setHosts(lb, [1, 2, 3], { healths: [0, 0, 0] });
  const got = new Set(Object.keys(distribution(lb, 6000)).map(Number));
  check('panic mode routes over all hosts', got.size === 3, `picked=${[...got].sort()}`);
  lb.delete();
}

if (failures > 0) {
  console.error(`[wasm-lb edf] FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('[wasm-lb edf] ok');
