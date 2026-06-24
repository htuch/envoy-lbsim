import type { SimConfig } from '@elbsim/config';
import type { EntityKind } from '@elbsim/protocol';
import { Prng } from '@elbsim/sim-core';

/**
 * Synthetic topology snapshots for the Track D harness.
 *
 * Track D mocks the other tracks: until the real kernel (Track B) streams live
 * gauges through the ring buffers, the topology graph is driven by these
 * deterministic, seed-derived snapshots. Field names mirror the gauge schemas in
 * `@elbsim/protocol` so the view code stays unchanged when real telemetry lands.
 */

/** One entity's live status as the topology graph renders it. */
export interface TopologyNodeStatus {
  kind: EntityKind;
  index: number;
  label: string;
  /** Active in-flight requests at the node. */
  inFlight: number;
  /** Pending admission/queue depth. */
  queueDepth: number;
  /** Queue capacity (the denominator for the queue bar); 0 if not queued. */
  queueCapacity: number;
  /** Load in [0,1]: inFlight / capacity (backends) or / maxConcurrent (envoys). */
  utilization: number;
  /**
   * Health ordinal. Backends use the `BackendHealth` order (0 healthy .. 3
   * draining) to match the `backend.health` gauge; clients/envoys are always 0.
   */
  health: 0 | 1 | 2 | 3;
  /** Envoy priority-set panic mode (always false for clients/backends). */
  panic: boolean;
  region: string;
  zone: string;
}

/** A directed traffic edge with its relative share for stroke weighting. */
export interface TopologyEdge {
  fromKind: EntityKind;
  fromIndex: number;
  toKind: EntityKind;
  toIndex: number;
  /** Relative traffic share in [0,1], used to weight the edge stroke. */
  share: number;
}

/** A full topology snapshot at one virtual instant. */
export interface TopologySnapshot {
  t: number;
  clients: TopologyNodeStatus[];
  envoys: TopologyNodeStatus[];
  backends: TopologyNodeStatus[];
  edges: TopologyEdge[];
}

/** Resolve a backend's capacity, applying any sparse per-index override. */
function backendCapacity(config: SimConfig, index: number): number {
  return config.backends.overrides[String(index)]?.capacity ?? config.backends.defaults.capacity;
}

/** Resolve a backend's queue size, applying any sparse per-index override. */
function backendQueueSize(config: SimConfig, index: number): number {
  return config.backends.overrides[String(index)]?.queueSize ?? config.backends.defaults.queueSize;
}

function backendLocality(config: SimConfig, index: number): { region: string; zone: string } {
  return config.backends.overrides[String(index)]?.locality ?? config.backends.defaults.locality;
}

/** Draw an integer in [0, max] with a soft bias toward the low end. */
function loadDraw(rng: Prng, max: number): number {
  // Square the uniform so most nodes sit lightly loaded and a few run hot.
  return Math.round(rng.nextFloat() ** 2 * max);
}

/**
 * Build a deterministic topology snapshot for `config` at virtual time `t`.
 * The same `(config, t, seed)` always yields the same snapshot.
 */
export function makeTopologySnapshot(
  config: SimConfig,
  t: number,
  seed = config.seed,
): TopologySnapshot {
  const rng = new Prng(seed).fork(Math.floor(t));

  const clients: TopologyNodeStatus[] = [];
  for (let i = 0; i < config.clients.count; i++) {
    const inFlight = loadDraw(rng, 4);
    clients.push({
      kind: 'client',
      index: i,
      label: `c${i}`,
      inFlight,
      queueDepth: 0,
      queueCapacity: 0,
      utilization: Math.min(1, inFlight / 4),
      health: 0,
      panic: false,
      region: config.clients.locality.region,
      zone: config.clients.locality.zone,
    });
  }

  const envoys: TopologyNodeStatus[] = [];
  const maxConcurrent = config.envoys.queue.maxConcurrentRequests;
  const queueCapacity = config.envoys.queue.queueCapacity;
  for (let i = 0; i < config.envoys.count; i++) {
    const inFlight = loadDraw(rng, maxConcurrent);
    const saturated = inFlight >= maxConcurrent;
    envoys.push({
      kind: 'envoy',
      index: i,
      label: `e${i}`,
      inFlight,
      queueDepth: saturated ? loadDraw(rng, queueCapacity) : 0,
      queueCapacity,
      utilization: Math.min(1, inFlight / maxConcurrent),
      health: 0,
      // Panic when many backends look unhealthy; rare in synthetic data.
      panic: rng.nextFloat() < 0.05,
      region: config.envoys.locality.region,
      zone: config.envoys.locality.zone,
    });
  }

  const backends: TopologyNodeStatus[] = [];
  for (let i = 0; i < config.backends.count; i++) {
    const capacity = backendCapacity(config, i);
    const queueSize = backendQueueSize(config, i);
    const loc = backendLocality(config, i);
    const inFlight = loadDraw(rng, capacity);
    const saturated = inFlight >= capacity;
    // Mostly healthy; occasionally degraded; rarely unhealthy.
    const roll = rng.nextFloat();
    const health: 0 | 1 | 2 | 3 = roll < 0.85 ? 0 : roll < 0.95 ? 1 : 2;
    backends.push({
      kind: 'backend',
      index: i,
      label: `b${i}`,
      inFlight,
      queueDepth: saturated ? loadDraw(rng, queueSize) : 0,
      queueCapacity: queueSize,
      utilization: Math.min(1, inFlight / capacity),
      health,
      panic: false,
      region: loc.region,
      zone: loc.zone,
    });
  }

  return { t, clients, envoys, backends, edges: makeEdges(config, rng) };
}

/**
 * Logical traffic edges: clients -> envoys per the client LB policy, and the
 * full envoy -> backend mesh weighted by backend weight. Shares are normalized
 * per source so an edge stroke encodes its slice of that source's traffic.
 */
function makeEdges(config: SimConfig, rng: Prng): TopologyEdge[] {
  const edges: TopologyEdge[] = [];
  const envoyCount = config.envoys.count;
  const backendCount = config.backends.count;

  for (let c = 0; c < config.clients.count; c++) {
    // Every client routes to at least one Envoy (the schema requires a positive
    // Envoy count and positive subset/resolved-set sizes), so the share divisor
    // is always non-zero.
    const targets = clientEnvoyTargets(config, c, rng);
    const share = 1 / targets.length;
    for (const e of targets) {
      edges.push({ fromKind: 'client', fromIndex: c, toKind: 'envoy', toIndex: e, share });
    }
  }

  // Backend weights are positive integers over a positive backend count, so the
  // weight sum is always non-zero.
  const weights: number[] = [];
  let weightSum = 0;
  for (let b = 0; b < backendCount; b++) {
    const w = config.backends.overrides[String(b)]?.weight ?? config.backends.defaults.weight;
    weights.push(w);
    weightSum += w;
  }
  for (let e = 0; e < envoyCount; e++) {
    for (let b = 0; b < backendCount; b++) {
      edges.push({
        fromKind: 'envoy',
        fromIndex: e,
        toKind: 'backend',
        toIndex: b,
        share: weights[b]! / weightSum,
      });
    }
  }

  return edges;
}

/** Which Envoy replicas a client routes to, per its client-side LB policy. */
function clientEnvoyTargets(config: SimConfig, client: number, rng: Prng): number[] {
  const n = config.envoys.count;
  const all = Array.from({ length: n }, (_, i) => i);
  const lb = config.clients.lb;
  switch (lb.kind) {
    case 'hash':
      // Sticky: each client lands on one Envoy by key hash (modeled by index).
      return [client % n];
    case 'subset': {
      const size = Math.min(lb.subsetSize, n);
      // Deterministic random subset per client.
      const sub = new Prng(client + 1);
      const pool = [...all];
      const picked: number[] = [];
      for (let k = 0; k < size; k++) {
        picked.push(pool.splice(sub.nextInt(pool.length), 1)[0]!);
      }
      return picked.sort((a, b) => a - b);
    }
    case 'dns_approx': {
      const size = Math.min(lb.resolvedSetSize, n);
      const start = rng.nextInt(n);
      return Array.from({ length: size }, (_, k) => (start + k) % n).sort((a, b) => a - b);
    }
    default:
      // round_robin / random spread across the full set over time.
      return all;
  }
}
