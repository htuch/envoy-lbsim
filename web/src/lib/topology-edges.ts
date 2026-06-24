import { resolveBackend, type SimConfig } from '@elbsim/config';
import { Prng } from '@elbsim/sim-core';
import type { TopologyEdge } from '@/components/topology/types';

/**
 * Logical traffic edges: clients -> envoys per the client LB policy, and the
 * full envoy -> backend mesh weighted by backend weight. Shares are normalized
 * per source so an edge stroke encodes its slice of that source's traffic.
 */
export function makeEdges(config: SimConfig, rng: Prng): TopologyEdge[] {
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
    const w = resolveBackend(config.backends, b).weight;
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
export function clientEnvoyTargets(config: SimConfig, client: number, rng: Prng): number[] {
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
