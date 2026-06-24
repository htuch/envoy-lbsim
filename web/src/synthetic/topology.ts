import { resolveBackend, type SimConfig } from '@elbsim/config';
import { Prng } from '@elbsim/sim-core';
import type { TopologyNodeStatus, TopologySnapshot } from '@/components/topology/types';
import { makeEdges } from '@/lib/topology-edges';

export type {
  TopologyEdge,
  TopologyNodeStatus,
  TopologySnapshot,
} from '@/components/topology/types';

/**
 * Synthetic topology snapshots for the Track D harness.
 *
 * Track D mocks the other tracks: until the real kernel (Track B) streams live
 * gauges through the ring buffers, the topology graph is driven by these
 * deterministic, seed-derived snapshots. Field names mirror the gauge schemas in
 * `@elbsim/protocol` so the view code stays unchanged when real telemetry lands.
 */

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
    const spec = resolveBackend(config.backends, i);
    const capacity = spec.capacity;
    const queueSize = spec.queueSize;
    const loc = spec.locality;
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
