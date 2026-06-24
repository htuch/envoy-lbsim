import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import type { Stats } from '../stats';
import { distributionCases, shares } from './distribution';
import { leastRequestCases } from './least-request';
import { scenario } from './scenario';
import type { CaseContext } from './types';

// Minimal Stats with only the perBackend field populated; other fields are benign.
function makeStats(perBackend: Map<number, { picks: number; completed: number }>): Stats {
  return {
    perBackend,
    perEnvoy: new Map(),
    outcomes: { completed: 0, timedOut: 0, rejected: 0, total: 0 },
    goodput: 0,
    latencyP50: 0,
    latencyP90: 0,
    latencyP99: 0,
    keyConsistency: new Map(),
  };
}

function makeCtx(policy: 'maglev' | 'least_request' = 'maglev'): CaseContext {
  return {
    policy,
    config: scenario(policy),
    lbLabel: 'mock',
    lbModule: mockLbModule,
    events: [],
  };
}

describe('shares()', () => {
  it('returns an empty Map when the input is empty (total === 0 branch)', () => {
    const result = shares(new Map());
    expect(result.size).toBe(0);
  });

  it('computes fractional shares for non-empty input', () => {
    const result = shares(
      new Map([
        [0, { picks: 1, completed: 1 }],
        [1, { picks: 3, completed: 3 }],
      ]),
    );
    expect(result.get(0)).toBeCloseTo(0.25);
    expect(result.get(1)).toBeCloseTo(0.75);
  });
});

describe('weighted-distribution assert', () => {
  it('exercises the ?? 0 fallback when a backend is absent from perBackend', () => {
    const theCase = distributionCases.find((c) => c.id === 'weighted-distribution');
    if (!theCase) throw new Error('weighted-distribution case not found');

    // Only backends 0, 1, 2 present; backend 3 is absent, so sh.get(3) ?? 0 fires.
    const stats = makeStats(
      new Map([
        [0, { picks: 4, completed: 4 }],
        [1, { picks: 2, completed: 2 }],
        [2, { picks: 1, completed: 1 }],
        // backend 3 intentionally absent
      ]),
    );

    const checks = theCase.assert(stats, makeCtx('maglev'));
    expect(checks.length).toBe(1);
    // backend 3 has 0% share but expected 1/8 = 12.5%, so worst dev > 5% => fail
    expect(checks[0]?.pass).toBe(false);
  });
});

describe('favors-idle assert', () => {
  it('exercises sh.get(b) ?? 0 when others are absent', () => {
    const theCase = leastRequestCases.find((c) => c.id === 'favors-idle');
    if (!theCase) throw new Error('favors-idle case not found');

    // Only backend 0 present; backends 1, 2, 3 absent so sh.get(b) ?? 0 fires for them.
    const stats = makeStats(new Map([[0, { picks: 10, completed: 10 }]]));

    const checks = theCase.assert(stats, makeCtx('least_request'));
    expect(checks.length).toBe(1);
    // slow (b0) = 1.0, avgOther = 0 => slow NOT < avgOther => pass === false
    expect(checks[0]?.pass).toBe(false);
  });

  it('exercises sh.get(0) ?? 0 when backend 0 is absent', () => {
    const theCase = leastRequestCases.find((c) => c.id === 'favors-idle');
    if (!theCase) throw new Error('favors-idle case not found');

    // Backends 1, 2, 3 present; backend 0 absent so sh.get(0) ?? 0 fires.
    const stats = makeStats(
      new Map([
        [1, { picks: 4, completed: 4 }],
        [2, { picks: 3, completed: 3 }],
        [3, { picks: 3, completed: 3 }],
      ]),
    );

    const checks = theCase.assert(stats, makeCtx('least_request'));
    expect(checks.length).toBe(1);
    // slow (b0) = 0, avgOther > 0 => slow < avgOther => pass === true
    expect(checks[0]?.pass).toBe(true);
  });
});
