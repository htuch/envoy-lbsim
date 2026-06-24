// Fidelity test for the ring_hash lift: the REAL Envoy RingHashLoadBalancer
// (the ketama ring built by the unmodified
// source/extensions/load_balancing_policies/ring_hash/ring_hash_lb.cc) driven
// through the REAL ThreadAwareLoadBalancerBase + LoadBalancerBase, compiled to
// Wasm and exercised across the Embind ABI.
//
// There is no independent ring oracle fixture (unlike maglev's lb_core dump), so
// rather than a byte-exact golden this asserts the behaviors a consistent-hash LB
// must get right: a sane ring structure, deterministic/consistent routing,
// weight-proportional ownership, the minimal-disruption guarantee on host removal,
// and -- exercising the real base -- health filtering and panic mode, plus that
// the hash-function selector is actually wired through.
//
// Skips gracefully (exit 0) when the artifact is not built so `pnpm -r test`
// stays green without emsdk; CI's wasm job builds first and runs it for real.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const artifact = fileURLToPath(new URL('../build/lb.mjs', import.meta.url));
if (!existsSync(artifact)) {
  console.log(
    '[wasm-lb ring_hash] artifact not built; run `pnpm --filter @elbsim/wasm-lb build` (needs emsdk). skipping.',
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
const XX_HASH = 1;
const MURMUR_HASH_2 = 2;

// Create a real ring LB over a host set. Returns the live Embind handle (caller
// deletes) so tests can both inspect the ring and route requests through it.
function makeRing(backends, weights, opts = {}) {
  const {
    healths = backends.map(() => HEALTHY),
    priorities = backends.map(() => 0),
    minRing = 1024,
    maxRing = 8_388_608,
    hashFunction = XX_HASH,
  } = opts;
  const lb = mod.createRingHashLb(
    minRing,
    maxRing,
    hashFunction,
    false,
    PANIC_THRESHOLD,
    OVERPROVISIONING,
    0,
  );
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
    av.push_back(0);
  }
  lb.updateHosts(bv, wv, hv, pv, regions, zones, av);
  for (const v of [bv, wv, hv, pv, regions, zones, av]) v.delete();
  return lb;
}

// Tally per-backend ownership share from the inspection structure (the serializer
// probes the real ring at an evenly-spaced grid across the full 64-bit space).
function ownershipFromInspect(structure) {
  const counts = {};
  for (const e of structure.entries) counts[e.backend] = (counts[e.backend] ?? 0) + 1;
  return counts;
}

// The ring spans the full 64-bit hash space, so routing probes must too (a hash
// of a few million only ever lands in the first tiny arc). Evenly spaced points
// across [0, 2^64) sample every host's arcs; doubles lose the low bits, which is
// just a coarser sampling resolution and fine for these behavioral checks.
function probeHash(i, n) {
  return Math.floor((i / n) * 2 ** 64);
}

console.log('[wasm-lb ring_hash] real Envoy RingHashLoadBalancer -> Wasm -> Embind');

// 1. Inspection structure: a 'ring' with sorted {hash, backend} entries and a
// size that matches the entry count (the inspector renders these as owned arcs).
{
  const lb = makeRing([1, 2, 3, 4], [1, 1, 1, 1]);
  const s = lb.inspect();
  check('inspect kind is ring', s.kind === 'ring', `got '${s.kind}'`);
  check('size matches entry count', s.size === s.entries.length, `size=${s.size}`);
  check('entries non-empty', s.entries.length > 0, `${s.entries.length} entries`);
  const e0 = s.entries[0];
  check(
    'entry shape {hash:16hex, backend}',
    typeof e0.hash === 'string' && e0.hash.length === 16 && Number.isInteger(e0.backend),
    JSON.stringify(e0),
  );
  let sorted = true;
  for (let i = 1; i < s.entries.length; i++) {
    if (s.entries[i].hash < s.entries[i - 1].hash) {
      sorted = false;
      break;
    }
  }
  check('entries sorted ascending by hash', sorted);
  const owners = new Set(s.entries.map((e) => e.backend));
  check(
    'all four hosts own arcs',
    [1, 2, 3, 4].every((b) => owners.has(b)),
    `owners=${[...owners]}`,
  );
  lb.delete();
}

// 2. Consistent routing: the same request hash always maps to the same backend,
// and the choice is deterministic across identical rebuilds.
{
  const a = makeRing([10, 20, 30, 40, 50], [1, 1, 1, 1, 1]);
  const b = makeRing([10, 20, 30, 40, 50], [1, 1, 1, 1, 1]);
  const N = 5000;
  let stable = true;
  const owners = new Set();
  for (let h = 0; h < N; h++) {
    const hash = probeHash(h, N);
    const pa = a.chooseHost(hash);
    owners.add(pa);
    if (pa !== b.chooseHost(hash) || pa < 0) {
      stable = false;
      break;
    }
  }
  // Stable across rebuilds AND actually exercising the whole ring (not one arc).
  check('deterministic, consistent routing', stable && owners.size === 5, `owners=${owners.size}`);
  a.delete();
  b.delete();
}

// 3. Weighted distribution: ownership tracks weight. The ring is less perfectly
// balanced than maglev, so allow a generous tolerance on a larger ring.
{
  const backends = [1, 2, 3, 4];
  const weights = [1, 2, 3, 4];
  const sumW = 10;
  const lb = makeRing(backends, weights, { minRing: 65_537 });
  const counts = ownershipFromInspect(lb.inspect());
  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  let worst = 0;
  for (let i = 0; i < backends.length; i++) {
    const observed = (counts[backends[i]] ?? 0) / total;
    worst = Math.max(worst, Math.abs(observed - weights[i] / sumW));
  }
  check('weighted ownership within 3%', worst < 0.03, `worst err ${(worst * 100).toFixed(2)}%`);
  lb.delete();
}

// 4. Minimal disruption: removing one host of five should leave the survivors'
// mappings largely intact -- the consistent-hashing guarantee. Envoy renormalizes
// ring points to the new minimum weight, so survivors gain points and some extra
// churn beyond the ideal is expected; it stays far below the ~3/4 of survivors a
// non-consistent (mod N) scheme would remap. Probe routing before/after removal.
{
  const full = makeRing([1, 2, 3, 4, 5], [1, 1, 1, 1, 1], { minRing: 65_537 });
  const minus = makeRing([1, 2, 3, 4], [1, 1, 1, 1], { minRing: 65_537 }); // dropped host 5
  let onSurvivor = 0;
  let movedAmongSurvivors = 0;
  const N = 20_000;
  for (let h = 0; h < N; h++) {
    const hash = probeHash(h, N);
    const before = full.chooseHost(hash);
    if (before !== 5) {
      onSurvivor++;
      if (before !== minus.chooseHost(hash)) movedAmongSurvivors++;
    }
  }
  const churn = movedAmongSurvivors / onSurvivor;
  check(
    'minimal disruption on host removal',
    churn < 0.2,
    `survivor churn ${(churn * 100).toFixed(2)}%`,
  );
  full.delete();
  minus.delete();
}

// 5. Health filtering (real LoadBalancerBase): unhealthy hosts are partitioned
// out before the ring is built, so they never own arcs.
{
  const lb = makeRing([1, 2, 3], [1, 1, 1], { healths: [HEALTHY, 0, HEALTHY] });
  const owners = new Set(lb.inspect().entries.map((e) => e.backend));
  check(
    'unhealthy host excluded from ring',
    !owners.has(2) && owners.has(1) && owners.has(3),
    `owners=${[...owners].sort((a, b) => a - b)}`,
  );
  lb.delete();
}

// 6. Panic mode (real LoadBalancerBase): with no healthy hosts, the cluster routes
// across ALL hosts rather than dropping traffic.
{
  const lb = makeRing([1, 2, 3], [1, 1, 1], { healths: [0, 0, 0] });
  const owners = new Set(lb.inspect().entries.map((e) => e.backend));
  check(
    'panic mode routes over all hosts',
    owners.size === 3,
    `owners=${[...owners].sort((a, b) => a - b)}`,
  );
  lb.delete();
}

// 7. Hash-function selector is wired: xx_hash and murmur_hash_2 build different
// rings (different point placements), so routing differs for at least some hashes.
{
  const xx = makeRing([1, 2, 3, 4], [1, 1, 1, 1], { hashFunction: XX_HASH });
  const murmur = makeRing([1, 2, 3, 4], [1, 1, 1, 1], { hashFunction: MURMUR_HASH_2 });
  let differ = false;
  const N = 5000;
  for (let h = 0; h < N; h++) {
    const hash = probeHash(h, N);
    if (xx.chooseHost(hash) !== murmur.chooseHost(hash)) {
      differ = true;
      break;
    }
  }
  check('hash function selector changes the ring', differ);
  xx.delete();
  murmur.delete();
}

if (failures > 0) {
  console.error(`[wasm-lb ring_hash] FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('[wasm-lb ring_hash] ok');
