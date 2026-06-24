import type { EnvoyLbPolicyKind, SimConfig } from '@elbsim/config';
import type {
  EdfInspection,
  InspectedHost,
  LbInspection,
  LbStructure,
  MaglevInspection,
  RingHashInspection,
} from '@elbsim/protocol';
import { Prng } from '@elbsim/sim-core';

/**
 * Synthetic `LbInspection` payloads for the Track D harness.
 *
 * The real payloads come from the Wasm LB serializing its live structures
 * (Track A) reached by deterministic replay (the worker's `requestInspection`).
 * Until that lands, this module fabricates structurally faithful stand-ins for
 * every `LbStructure` kind so the inspector renders against the real contract.
 * The structures are plausible shapes, NOT Envoy's actual algorithms; only the
 * Wasm path is authoritative.
 */

const HEALTH_HEALTHY = 2;
const HEALTH_DEGRADED = 1;
const HEALTH_UNHEALTHY = 0;

/** Resolve a backend's relative LB weight, applying any sparse override. */
function backendWeight(config: SimConfig, index: number): number {
  return config.backends.overrides[String(index)]?.weight ?? config.backends.defaults.weight;
}

function backendLocality(config: SimConfig, index: number): { region: string; zone: string } {
  return config.backends.overrides[String(index)]?.locality ?? config.backends.defaults.locality;
}

/** Build the resolved host view the LB currently sees (post health/weight). */
function makeHosts(config: SimConfig, rng: Prng): InspectedHost[] {
  const hosts: InspectedHost[] = [];
  for (let b = 0; b < config.backends.count; b++) {
    const loc = backendLocality(config, b);
    const roll = rng.nextFloat();
    const health = roll < 0.85 ? HEALTH_HEALTHY : roll < 0.95 ? HEALTH_DEGRADED : HEALTH_UNHEALTHY;
    hosts.push({
      backend: b,
      weight: backendWeight(config, b),
      health: health as 0 | 1 | 2,
      priority: 0,
      region: loc.region,
      zone: loc.zone,
      activeRequests: rng.nextInt(16),
    });
  }
  return hosts;
}

/**
 * EDF heap as the weighted path (round_robin with unequal weights, or
 * least_request) would hold it. Per-host weight folds in active requests the way
 * least_request does (weight / (activeRequests + 1)); deadlines are the EDF
 * `1 / weight` strides offset from the scheduler's current time.
 */
function makeEdf(hosts: InspectedHost[], rng: Prng): EdfInspection {
  const currentTime = rng.nextFloat() * 4;
  const entries = hosts
    .filter((h) => h.health !== HEALTH_UNHEALTHY)
    .map((h) => {
      const effectiveWeight = h.weight / (h.activeRequests + 1);
      // EDF inserts each host at current_time + 1/weight, with the historical
      // jitter that accrues as picks advance the clock.
      const deadline = currentTime + (1 / effectiveWeight) * (0.5 + rng.nextFloat());
      return { backend: h.backend, deadline, weight: effectiveWeight };
    })
    .sort((a, b) => a.deadline - b.deadline);
  return { kind: 'edf', currentTime, entries, prepick: [] };
}

/**
 * Fill a Maglev lookup table of `tableSize` slots over `backends` with the given
 * `weights` using weighted stride scheduling: the smallest-deadline backend wins
 * each slot, then advances by its `1 / weight` stride, yielding interleaved
 * weight-proportional slot shares. A stand-in for Envoy's real Maglev
 * permutation (Track A); exported for direct testing. With no backends it
 * returns an empty table.
 */
export function fillMaglevTable(
  backends: number[],
  weights: number[],
  tableSize: number,
): { table: Uint32Array; slotCounts: Record<number, number> } {
  const table = new Uint32Array(tableSize);
  const slotCounts: Record<number, number> = {};
  for (const b of backends) slotCounts[b] = 0;
  if (backends.length === 0) return { table, slotCounts };

  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const strides = weights.map((w) => totalWeight / w);
  const deadlines = [...strides];
  for (let s = 0; s < tableSize; s++) {
    let best = 0;
    for (let i = 1; i < backends.length; i++) {
      if (deadlines[i]! < deadlines[best]!) best = i;
    }
    const backend = backends[best]!;
    table[s] = backend;
    slotCounts[backend] = (slotCounts[backend] ?? 0) + 1;
    deadlines[best] = deadlines[best]! + strides[best]!;
  }
  return { table, slotCounts };
}

/**
 * Maglev lookup table as the LB would hold it; only currently-live hosts get
 * slots. The real table comes from Envoy's Maglev permutation in Wasm.
 */
function makeMaglev(config: SimConfig, hosts: InspectedHost[]): MaglevInspection {
  const tableSize = config.envoys.policy.kind === 'maglev' ? config.envoys.policy.tableSize : 65537;
  const live = hosts.filter((h) => h.health !== HEALTH_UNHEALTHY);
  const { table, slotCounts } = fillMaglevTable(
    live.map((h) => h.backend),
    live.map((h) => h.weight),
    tableSize,
  );
  return { kind: 'maglev', tableSize, table, slotCounts };
}

/**
 * Consistent-hash ring: each live host contributes points proportional to its
 * weight, hashed to 64-bit positions rendered as fixed-width hex so a lexical
 * sort matches the numeric ring order.
 */
function makeRing(config: SimConfig, hosts: InspectedHost[], rng: Prng): RingHashInspection {
  const minRing =
    config.envoys.policy.kind === 'ring_hash' ? config.envoys.policy.minimumRingSize : 1024;
  const live = hosts.filter((h) => h.health !== HEALTH_UNHEALTHY);
  const totalWeight = live.reduce((s, h) => s + h.weight, 0) || 1;
  const target = Math.max(minRing, live.length * 16);
  const entries: Array<{ hash: string; backend: number }> = [];
  for (const h of live) {
    const points = Math.max(1, Math.round((h.weight / totalWeight) * target));
    for (let p = 0; p < points; p++) {
      entries.push({ hash: rng.nextU64().toString(16).padStart(16, '0'), backend: h.backend });
    }
  }
  entries.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return { kind: 'ring', size: entries.length, entries };
}

function makeStructure(
  kind: EnvoyLbPolicyKind,
  config: SimConfig,
  hosts: InspectedHost[],
  rng: Prng,
): LbStructure {
  switch (kind) {
    case 'round_robin':
    case 'least_request':
      return makeEdf(hosts, rng);
    case 'maglev':
      return makeMaglev(config, hosts);
    case 'ring_hash':
      return makeRing(config, hosts, rng);
    case 'random':
      return { kind: 'none' };
  }
}

/**
 * Build a synthetic inspection for Envoy `envoy` at virtual time `t`. The
 * structure kind defaults to the configured Envoy policy; pass `policyKind` to
 * render a different structure (the harness uses this to exercise all four).
 */
export function makeInspection(
  config: SimConfig,
  envoy: number,
  t: number,
  policyKind: EnvoyLbPolicyKind = config.envoys.policy.kind,
  seed = config.seed,
): LbInspection {
  const rng = new Prng(seed).fork((envoy + 1) * 1000 + Math.floor(t));
  const hosts = makeHosts(config, rng);
  const healthy = hosts.filter((h) => h.health === HEALTH_HEALTHY).length;
  const threshold = config.envoys.common.healthyPanicThresholdPercent;
  const panic = (healthy / hosts.length) * 100 < threshold;
  return {
    envoy,
    t,
    policy: policyKind,
    panic,
    hosts,
    structure: makeStructure(policyKind, config, hosts, rng),
  };
}
