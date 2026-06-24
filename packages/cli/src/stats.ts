import type { RequestEvent } from '@elbsim/protocol';

export interface BackendCount {
  picks: number;
  completed: number;
}

export interface Outcomes {
  completed: number;
  timedOut: number;
  rejected: number;
  total: number;
}

export interface Stats {
  perBackend: Map<number, BackendCount>;
  perEnvoy: Map<number, number>;
  outcomes: Outcomes;
  goodput: number;
  latencyP50: number;
  latencyP90: number;
  latencyP99: number;
  keyConsistency: Map<number, Set<number>>;
}

/** Linear-interpolated percentile over an ascending-sorted array; 0 if empty. */
function percentile(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = q * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

/**
 * Independent recomputation of run stats from the raw cold-path event stream.
 * Pure: the same events always yield the same Stats. Used both for reporting and
 * as the oracle the production `queryWindow` aggregation is checked against.
 */
export function computeStats(events: readonly RequestEvent[]): Stats {
  const perBackend = new Map<number, BackendCount>();
  const perEnvoy = new Map<number, number>();
  const reqKey = new Map<number, number>();
  const keyConsistency = new Map<number, Set<number>>();
  const latencies: number[] = [];
  let emitted = 0;
  let completed = 0;
  let timedOut = 0;
  let rejected = 0;

  const backend = (b: number): BackendCount => {
    let c = perBackend.get(b);
    if (!c) {
      c = { picks: 0, completed: 0 };
      perBackend.set(b, c);
    }
    return c;
  };

  for (const e of events) {
    switch (e.phase) {
      case 'emitted':
        emitted++;
        reqKey.set(e.req, e.key);
        break;
      case 'lb_pick': {
        backend(e.backend).picks++;
        perEnvoy.set(e.envoy, (perEnvoy.get(e.envoy) ?? 0) + 1);
        const key = reqKey.get(e.req);
        if (key !== undefined) {
          let set = keyConsistency.get(key);
          if (!set) {
            set = new Set<number>();
            keyConsistency.set(key, set);
          }
          set.add(e.backend);
        }
        break;
      }
      case 'completed':
        completed++;
        backend(e.backend).completed++;
        latencies.push(e.latencyMs);
        break;
      case 'timed_out':
        timedOut++;
        break;
      case 'rejected':
        rejected++;
        break;
    }
  }

  latencies.sort((a, b) => a - b);
  const total = emitted;
  return {
    perBackend,
    perEnvoy,
    outcomes: { completed, timedOut, rejected, total },
    goodput: total === 0 ? 0 : Math.max(0, Math.min(1, completed / total)),
    latencyP50: percentile(latencies, 0.5),
    latencyP90: percentile(latencies, 0.9),
    latencyP99: percentile(latencies, 0.99),
    keyConsistency,
  };
}
