import type { WindowAggregate } from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { latencyCdf, outcomeBreakdown } from './stats';

describe('latencyCdf', () => {
  it('returns an empty series for no samples', () => {
    expect(latencyCdf([])).toEqual([]);
  });

  it('produces a monotonic CDF reaching 1 at the largest sample', () => {
    const cdf = latencyCdf([30, 10, 20, 40]);
    expect(cdf.map((d) => d.latency)).toEqual([10, 20, 30, 40]);
    expect(cdf.map((d) => d.p)).toEqual([0.25, 0.5, 0.75, 1]);
    for (let i = 1; i < cdf.length; i++) expect(cdf[i]!.p).toBeGreaterThan(cdf[i - 1]!.p);
  });
});

describe('outcomeBreakdown', () => {
  const agg: WindowAggregate = {
    fromMs: 0,
    toMs: 1000,
    totalRequests: 100,
    completed: 80,
    timedOut: 15,
    rejected: 5,
    goodput: 0.8,
    latencyP50: 20,
    latencyP90: 40,
    latencyP99: 60,
  };

  it('splits outcomes into proportions of the total', () => {
    const slices = outcomeBreakdown(agg);
    expect(slices.map((s) => s.outcome)).toEqual(['completed', 'timed out', 'rejected']);
    expect(slices.map((s) => s.count)).toEqual([80, 15, 5]);
    expect(slices.map((s) => s.fraction)).toEqual([0.8, 0.15, 0.05]);
  });

  it('reports zero fractions for an empty window', () => {
    const empty = { ...agg, totalRequests: 0, completed: 0, timedOut: 0, rejected: 0 };
    expect(outcomeBreakdown(empty).every((s) => s.fraction === 0)).toBe(true);
  });
});
