import type { RequestEvent } from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { computeStats } from './stats';

function lifecycle(
  req: number,
  key: number,
  envoy: number,
  backend: number,
  latencyMs: number,
): RequestEvent[] {
  return [
    { t: 0, req, phase: 'emitted', client: 0, key },
    { t: 1, req, phase: 'lb_pick', envoy, backend, attempts: 1 },
    { t: 2, req, phase: 'completed', backend, latencyMs },
  ];
}

describe('computeStats', () => {
  it('counts picks, completions, outcomes and goodput', () => {
    const events: RequestEvent[] = [
      ...lifecycle(0, 7, 0, 1, 10),
      ...lifecycle(1, 7, 0, 1, 20),
      ...lifecycle(2, 9, 1, 2, 30),
      { t: 0, req: 3, phase: 'emitted', client: 0, key: 5 },
      { t: 1, req: 3, phase: 'lb_pick', envoy: 0, backend: 1, attempts: 1 },
      { t: 2, req: 3, phase: 'timed_out', reason: 'timeout' },
      { t: 0, req: 4, phase: 'emitted', client: 0, key: 5 },
      { t: 1, req: 4, phase: 'rejected', reason: 'envoy_overflow', envoy: 0 },
      // intermediate phases are no-ops; verify they don't perturb stats
      { t: 0, req: 5, phase: 'client_routed', client: 0, envoy: 0 },
      { t: 0, req: 5, phase: 'envoy_queued', envoy: 0, queueDepth: 1 },
      { t: 0, req: 5, phase: 'backend_sent', envoy: 0, backend: 1 },
    ];
    const s = computeStats(events);
    expect(s.outcomes).toEqual({ completed: 3, timedOut: 1, rejected: 1, total: 5 });
    expect(s.goodput).toBeCloseTo(3 / 5, 10);
    expect(s.perBackend.get(1)).toEqual({ picks: 3, completed: 2 });
    expect(s.perBackend.get(2)).toEqual({ picks: 1, completed: 1 });
    expect(s.perEnvoy.get(0)).toBe(3);
    expect(s.perEnvoy.get(1)).toBe(1);
    expect(s.keyConsistency.get(7)).toEqual(new Set([1]));
    expect(s.keyConsistency.get(9)).toEqual(new Set([2]));
  });

  it('computes interpolated percentiles over completed latencies', () => {
    const events: RequestEvent[] = [
      ...lifecycle(0, 1, 0, 0, 10),
      ...lifecycle(1, 2, 0, 0, 20),
      ...lifecycle(2, 3, 0, 0, 30),
    ];
    const s = computeStats(events);
    expect(s.latencyP50).toBeCloseTo(20, 10);
  });

  it('interpolates percentiles at non-integer ranks', () => {
    // 4-element sorted set [10, 20, 30, 40]; n-1 = 3
    // P90: rank = 0.9*3 = 2.7 -> 0.3*30 + 0.7*40 = 37
    // P50: rank = 0.5*3 = 1.5 -> 0.5*20 + 0.5*30 = 25
    const events: RequestEvent[] = [
      ...lifecycle(0, 1, 0, 0, 10),
      ...lifecycle(1, 2, 0, 0, 20),
      ...lifecycle(2, 3, 0, 0, 30),
      ...lifecycle(3, 4, 0, 0, 40),
    ];
    const s = computeStats(events);
    expect(s.latencyP50).toBeCloseTo(25, 10);
    expect(s.latencyP90).toBeCloseTo(37, 10);
  });

  it('returns zeroed goodput and percentiles for an empty stream', () => {
    const s = computeStats([]);
    expect(s.goodput).toBe(0);
    expect(s.latencyP99).toBe(0);
    expect(s.outcomes.total).toBe(0);
  });

  it('handles lb_pick with no prior emitted event (key is undefined)', () => {
    // Simulate an lb_pick with no preceding emitted; key lookup returns undefined.
    // The backend should still be counted but keyConsistency remains empty.
    const events: RequestEvent[] = [
      { t: 1, req: 99, phase: 'lb_pick', envoy: 0, backend: 3, attempts: 1 },
    ];
    const s = computeStats(events);
    expect(s.perBackend.get(3)).toEqual({ picks: 1, completed: 0 });
    expect(s.keyConsistency.size).toBe(0);
  });
});
